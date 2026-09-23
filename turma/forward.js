"use strict";
// Single-writer serving under HA (XERK-919): the lease LEADER serves every request,
// and every other replica stays Ready and transparently FORWARDS its HTTP requests
// and WebSocket upgrades to the leader.
//
// Why: active-active (XERK-782) let a request and its follow-up land on different
// replicas, and the hub's request path is built on per-process state — the agent's
// data-channel dial-back pairs against `pendingChannels` on the replica that sent
// `{open}`, a queued command lives in one replica's copy of a record the other
// replica's beat overwrites, the on-demand result caches land wherever the beat did,
// and a re-dialed tunnel leaves a stale channel on the old replica. Forwarding every
// request to ONE process restores the single-process semantics every one of those
// paths was written against, by construction, while keeping what HA is for: every
// replica Ready (zero-gap rolling deploys) and a warm standby that promotes through
// the existing `onLeaderPromoted` hydration. `.claude/rules/turma-ha-forward.md`.
//
// Standalone + store-injected like `relay.js`'s `makeRelay`, so the routing
// decision, the leader-endpoint directory and the byte-level proxying are unit-
// testable with a `FileLiveStore` and loopback servers — no Valkey, no cluster.
//
// stdlib only (the hub ships no node_modules).

const net = require("net");
const http = require("http");

// The leader's dialable HTTP address, byte-free, TTL'd and refreshed while it leads.
const LEADER_ENDPOINT_KEY = "hubLeader:endpoint";
// Stamped on every forwarded request/upgrade. A replica NEVER forwards a request
// that already carries it — two replicas that briefly disagree about who leads
// then serve it rather than bouncing it between them.
const FORWARDED_HEADER = "x-turma-forwarded-by";
// Answered by THIS replica, never forwarded: the kubelet probes are per-pod facts
// (a follower's liveness/drain is its own, not the leader's).
const LOCAL_PATHS = new Set(["/healthz", "/readyz"]);
// Connection-scoped headers a proxy must not pass on (RFC 9110 §7.6.1) plus
// `expect` (this replica's server already answered any 100-continue itself).
// Framing is re-derived by each hop: Node chunks a body with no Content-Length.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "expect",
]);

const DEFAULTS = {
  ttlMs: 7000, // a leader endpoint older than this is presumed dead
  refreshMs: 2000, // the leader re-publishes this often (well inside ttlMs)
  connectTimeoutMs: 3000, // a dead pod IP drops SYNs; do not hang a request on it
  cooldownMs: 3000, // after a failed dial, do not re-dial that address this long
  // With no leader to forward to (a handover in flight, or the leader just died),
  // HOLD the request rather than serve it as a second writer. A graceful handover
  // resolves within one election retry (~2s); only past this bound does a replica
  // serve locally — the degraded mode, safe when it is the sole survivor.
  holdMs: 8000,
  holdPollMs: 100,
};
// A request is forwarded at most this many times (the hop list rides
// FORWARDED_HEADER), so a replica that is mid-handover can pass a request on to
// the new leader once, but two replicas can never bounce one between them.
const MAX_HOPS = 2;

function splitAddr(addr) {
  const s = String(addr || "");
  const i = s.lastIndexOf(":");
  if (i <= 0) return null;
  let host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return { host, port };
}

// Filter a flat rawHeaders list ([k, v, k, v, ...], duplicates and casing kept —
// e.g. several Set-Cookie) down to the end-to-end headers.
function endToEnd(raw) {
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i];
    const lk = String(k).toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === FORWARDED_HEADER) continue;
    out.push(k, raw[i + 1]);
  }
  return out;
}

// @param store     a LiveStore (the shared Valkey store in HA; FileLiveStore in tests)
// @param replicaId this replica's id (server.js SSE_REPLICA_ID)
// @param deps
//   endpoint   this replica's dialable HTTP address "host:port", published while it
//              is the leader; null => followers cannot reach it and serve locally
//   isLeader   () => boolean: holds the lease (gates PUBLISHING the endpoint)
//   canServe   () => boolean: may serve locally as the single writer — the leader
//              once its promotion re-sync is done (defaults to isLeader)
//   enabled    false => never forward (the TURMA_HA_FORWARD=0 escape hatch)
//   log        (line) => void
//   ttlMs/refreshMs/connectTimeoutMs/cooldownMs/holdMs/holdPollMs/now  tunables
function makeForwarder(store, replicaId, deps = {}) {
  const {
    endpoint = null,
    isLeader = () => true,
    enabled = true,
    log = () => {},
    ttlMs = DEFAULTS.ttlMs,
    refreshMs = DEFAULTS.refreshMs,
    connectTimeoutMs = DEFAULTS.connectTimeoutMs,
    cooldownMs = DEFAULTS.cooldownMs,
    holdMs = DEFAULTS.holdMs,
    holdPollMs = DEFAULTS.holdPollMs,
    now = Date.now,
  } = deps;
  const canServe = deps.canServe || isLeader;

  // Hot mirror of the leader endpoint: {replica, addr, seenAt}. `seenAt` is THIS
  // replica's clock at receipt (a watch event), so freshness never depends on two
  // pods' clocks agreeing — except the one boot-time hydrate, which can only use
  // the writer's `at`. `addr` null = a leader with no dialable address.
  let leader = null;
  const unreachableUntil = new Map(); // addr -> time before which we do not dial it
  const live = new Set(); // every forwarded socket (client + upstream), for drain
  const stats = { requests: 0, upgrades: 0, dialFailures: 0, held: 0, degraded: 0 };
  let refreshTimer = null;
  let unwatch = null;
  let unhealth = null;
  let lastMode = null; // for the edge-only mode log
  let draining = false; // set by stop(): this replica is shutting down

  function storeFailed(e) {
    // Never throw from a timer/callback (XERK-235): a dropped endpoint write
    // self-heals on the next refresh; followers meanwhile hold, then serve.
    log(`forward: leader endpoint write failed: ${(e && e.message) || e}`);
  }

  function track(sock) {
    live.add(sock);
    sock.once("close", () => live.delete(sock));
  }

  function noteMode(mode) {
    if (mode === lastMode) return;
    lastMode = mode;
    log(`forward: ${mode}`);
  }

  // The replicas a request has already passed through (FORWARDED_HEADER is a
  // comma list, oldest first).
  function hopsOf(req) {
    const v = req && req.headers && req.headers[FORWARDED_HEADER];
    return typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];
  }

  const LOCAL = { local: true };
  // Where should THIS request go right now? {local} = serve it here, {forward:addr}
  // = proxy it to the leader, {hold:reason} = neither is safe yet — wait. Sync.
  function decide(req) {
    if (!enabled) return LOCAL;
    const path = String((req && req.url) || "").split("?")[0];
    if (LOCAL_PATHS.has(path)) return LOCAL;
    if (canServe()) { noteMode("serving locally (this replica is the leader)"); return LOCAL; }
    const e = leader;
    const fresh = e && now() - e.seenAt < ttlMs;
    if (!fresh || e.replica === replicaId) {
      // No live leader but us-not-yet-ready (promotion re-sync), or a handover in
      // flight, or the leader just died: never become a second writer — hold.
      return { hold: !fresh ? "no fresh leader endpoint" : "this replica is taking over" };
    }
    // A leader that published no dialable address cannot be forwarded to: serve
    // locally (the degraded, pre-XERK-919 active-active behaviour), loudly.
    if (!e.addr) { noteMode("serving locally (the leader published no dialable endpoint — DEGRADED)"); return LOCAL; }
    const hops = hopsOf(req);
    // Never bounce a request back to a replica it came through, and never forward
    // one past MAX_HOPS: it waits here until this replica can serve it.
    if (hops.includes(e.replica) || hops.includes(replicaId) || hops.length >= MAX_HOPS) {
      return { hold: "the request already passed through the leader" };
    }
    const until = unreachableUntil.get(e.addr);
    if (until && now() < until) return { hold: `the leader at ${e.addr} is unreachable` };
    if (until) unreachableUntil.delete(e.addr);
    noteMode(`forwarding to the leader at ${e.addr}`);
    return { forward: e.addr };
  }

  function markUnreachable(addr, err) {
    stats.dialFailures += 1;
    unreachableUntil.set(addr, now() + cooldownMs);
    log(`forward: leader at ${addr} unreachable (${(err && err.message) || err}); holding requests`);
    lastMode = null; // re-log the mode on recovery
  }

  // Dial the leader BEFORE touching the request, so a failed dial leaves the request
  // unread and it can still be held / served locally.
  function dial(addr) {
    return new Promise((resolve, reject) => {
      const a = splitAddr(addr);
      if (!a) return reject(new Error(`bad leader address ${addr}`));
      const s = net.connect({ host: a.host, port: a.port });
      const timer = setTimeout(() => { s.destroy(); reject(new Error("connect timeout")); }, connectTimeoutMs);
      if (timer.unref) timer.unref();
      const onErr = (e) => { clearTimeout(timer); s.destroy(); reject(e); };
      s.once("error", onErr);
      s.once("connect", () => {
        clearTimeout(timer);
        s.removeListener("error", onErr);
        // Terminal keystrokes are tiny packets; Nagle would batch them (the same
        // reason tunnel-agent.js disables it on the ttyd side).
        s.setNoDelay(true);
        resolve(s);
      });
    });
  }

  const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

  // Resolve a connected upstream socket to forward over, or null to serve locally.
  // Holds (polling) while neither is safe, up to `holdMs`; past that the request is
  // served locally — the degraded mode, correct when this replica is the only one
  // left. `gone()` reports the client went away (stop holding for nobody).
  async function route(req, gone) {
    let deadline = 0;
    for (;;) {
      if (gone()) return { gone: true };
      const d = decide(req);
      if (d.local) return null;
      if (d.forward) {
        try {
          return { sock: await dial(d.forward), hops: hopsOf(req) };
        } catch (e) {
          markUnreachable(d.forward, e);
          continue; // re-decide: now held for the cooldown, or a new leader appeared
        }
      }
      if (!deadline) { deadline = now() + holdMs; stats.held += 1; }
      if (now() >= deadline || draining) {
        // A DRAINING replica never becomes a writer: refuse, the client retries
        // through the LB onto a replica that is not shutting down.
        if (draining) return { refuse: true };
        stats.degraded += 1;
        log(`forward: held ${holdMs}ms with no leader to forward to (${d.hold}) — serving locally (DEGRADED)`);
        return null;
      }
      await pause(holdPollMs);
    }
  }

  // Forward one HTTP request. Resolves true once it is handled here (proxied, or
  // the client left while held), false when the caller should serve it locally.
  // Never throws, never rejects.
  async function forwardRequest(req, res) {
    const r = await route(req, () => res.destroyed || res.writableEnded);
    if (!r) return false;
    if (r.gone) return true;
    if (r.refuse) {
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "1", connection: "close" });
        res.end(JSON.stringify({ error: "this hub replica is shutting down — retry" }));
      }
      return true;
    }
    const sock = r.sock;
    if (res.destroyed || res.writableEnded) { sock.destroy(); return true; } // client left meanwhile
    stats.requests += 1;
    track(sock);
    const headers = endToEnd(req.rawHeaders || []);
    // One upstream socket per forwarded request (dialed above), so ask the leader
    // to close it after the response rather than idling it in keep-alive.
    headers.push(FORWARDED_HEADER, r.hops.concat(replicaId).join(","), "Connection", "close");
    let up;
    try {
      up = http.request({ method: req.method, path: req.url, headers, createConnection: () => sock });
    } catch (e) {
      sock.destroy();
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: `hub leader forward failed: ${e.message}` }));
      }
      return true;
    }
    up.on("response", (upRes) => {
      // A client that went away mid-request: nothing to relay to.
      if (res.destroyed) { upRes.resume(); up.destroy(); return; }
      try {
        res.writeHead(upRes.statusCode, upRes.statusMessage, endToEnd(upRes.rawHeaders || []));
      } catch {
        up.destroy();
        res.destroy();
        return;
      }
      // Long-lived bodies (SSE) must reach the client chunk by chunk, not batched.
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      upRes.pipe(res);
      // The leader dying MID-body must truncate the client response, never hang it
      // (the XERK-865 lesson): destroy on an incomplete close or an error.
      upRes.on("error", () => res.destroy());
      upRes.on("close", () => { if (!upRes.complete) res.destroy(); });
    });
    up.on("error", (e) => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(502, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: `hub leader unreachable — retry (${e.message})` }));
      } else {
        res.destroy();
      }
    });
    // The client going away tears the upstream down (SSE especially — else the
    // leader keeps writing to a socket nobody reads).
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
    return true;
  }

  // Forward one upgrade (WebSocket) as a raw byte pipe. The leader performs the
  // handshake and everything after it, so every WS surface (/agent/control,
  // /agent/data, /term, /live, /audio) behaves exactly as if dialed directly.
  // Same true/false contract as forwardRequest.
  async function forwardUpgrade(req, socket, head) {
    if (decide(req).local) return false; // the common leader/HA-off path: no listener churn
    // A client that resets while we dial/hold must not become an unhandled 'error'
    // on an upgrade socket nothing else is listening on yet.
    const early = () => {};
    socket.on("error", early);
    const r = await route(req, () => socket.destroyed);
    if (!r) { socket.removeListener("error", early); return false; } // serve locally, untouched
    if (r.gone) return true;
    if (r.refuse) { socket.destroy(); return true; } // draining: the client re-dials elsewhere
    const up = r.sock;
    if (socket.destroyed) { up.destroy(); return true; }
    stats.upgrades += 1;
    track(up);
    track(socket);
    const kill = () => { socket.destroy(); up.destroy(); };
    socket.on("error", kill);
    up.on("error", kill);
    socket.on("close", kill);
    up.on("close", kill);
    // Rebuild the request head from the RAW headers (casing, order, duplicates and
    // the upgrade/connection pair all kept — they are what make this an upgrade).
    // Node's parser has already rejected any header containing CR/LF.
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion || "1.1"}`];
    const raw = req.rawHeaders || [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (String(raw[i]).toLowerCase() === FORWARDED_HEADER) continue;
      lines.push(`${raw[i]}: ${raw[i + 1]}`);
    }
    lines.push(`${FORWARDED_HEADER}: ${r.hops.concat(replicaId).join(",")}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
    socket.pipe(up);
    up.pipe(socket);
    return true;
  }

  // Leader side: publish (or refresh) this replica's endpoint. No-op unless this
  // replica currently leads and has a dialable address. The local mirror is set
  // synchronously so a demoted leader recognizes its own stale entry as SELF.
  function publish() {
    if (!enabled || !store || !isLeader()) return;
    const at = now();
    leader = { replica: replicaId, addr: endpoint, seenAt: at };
    Promise.resolve(store.set(LEADER_ENDPOINT_KEY, { replica: replicaId, addr: endpoint, at }, { ttlMs }))
      .catch(storeFailed);
  }

  // A leader handing over (graceful drain, AFTER it released the lease): delete
  // its endpoint so followers stop dialing a listener that is closing and hold for
  // the successor instead. Only ever deletes OUR entry; resolves when done.
  async function retract() {
    if (!enabled || !store || !leader || leader.replica !== replicaId) return;
    leader = null;
    try {
      const v = await store.get(LEADER_ENDPOINT_KEY);
      if (v && v.replica === replicaId) await store.del(LEADER_ENDPOINT_KEY);
    } catch (e) {
      storeFailed(e);
    }
  }

  function apply(v, seenAt) {
    if (!v || typeof v !== "object" || typeof v.replica !== "string" || typeof v.at !== "number") return;
    if (v.addr !== null && (typeof v.addr !== "string" || !splitAddr(v.addr))) return;
    const changed = !leader || leader.replica !== v.replica || leader.addr !== v.addr;
    leader = { replica: v.replica, addr: v.addr, seenAt };
    if (changed && v.replica !== replicaId) {
      unreachableUntil.delete(v.addr); // a NEW leader gets a fresh chance at once
      log(`forward: leader endpoint is ${v.addr || "UNDIALABLE"} (replica ${v.replica})`);
    }
  }

  // Watch the directory FIRST (no change missed during the scan), then hydrate,
  // then refresh on a timer + on every store health->ready edge (the relay's
  // XERK-781 pattern: the boot publish races a not-yet-connected socket).
  async function start() {
    if (!enabled || !store) return;
    if (typeof store.watch === "function") {
      unwatch = store.watch(LEADER_ENDPOINT_KEY, (ev) => {
        if (!ev || ev.key !== LEADER_ENDPOINT_KEY) return;
        if (ev.type === "del") { if (leader && leader.replica !== replicaId) leader = null; return; }
        apply(ev.value, now());
      });
    }
    if (typeof store.onHealth === "function") {
      unhealth = store.onHealth((h) => { if (h === "ready") publish(); });
    }
    refreshTimer = setInterval(publish, refreshMs);
    if (refreshTimer.unref) refreshTimer.unref();
    try {
      if (store.ready) await store.ready();
      publish();
      if (!leader && typeof store.get === "function") {
        const v = await store.get(LEADER_ENDPOINT_KEY);
        // The only place the WRITER's clock is trusted, and only to reject an
        // entry that is already stale by it.
        if (v && typeof v.at === "number" && now() - v.at < ttlMs && !leader) apply(v, v.at);
      }
    } catch (e) {
      storeFailed(e);
    }
  }

  // Drain: stop refreshing, cut every forwarded connection so its client re-dials
  // (through the LB) to a replica that is not shutting down — the same moment the
  // hub cuts its own SSE/WS sockets — and from now on refuse (503) what can be
  // neither forwarded nor served, instead of the degraded local fallback. The watch
  // stays up, so a request held here still learns the successor and forwards to it.
  function stop() {
    draining = true;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (unhealth) { try { unhealth(); } catch { /* best effort */ } unhealth = null; }
    for (const s of live) { try { s.destroy(); } catch { /* gone */ } }
    live.clear();
  }

  // Tests: tear everything down (the watch included).
  function close() {
    stop();
    if (unwatch) { try { unwatch(); } catch { /* best effort */ } unwatch = null; }
  }

  return {
    decide,
    forwardRequest,
    forwardUpgrade,
    publish,
    retract,
    start,
    stop,
    close,
    // Introspection (tests, and the boot log) — never on the request path.
    get leader() { return leader; },
    get liveCount() { return live.size; },
    stats,
  };
}

module.exports = {
  makeForwarder,
  splitAddr,
  endToEnd,
  LEADER_ENDPOINT_KEY,
  FORWARDED_HEADER,
  LOCAL_PATHS,
  DEFAULTS,
  MAX_HOPS,
};
