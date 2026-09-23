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
const crypto = require("crypto");
const { Transform } = require("stream");

// The leader's dialable HTTP address, byte-free, TTL'd and refreshed while it leads.
const LEADER_ENDPOINT_KEY = "hubLeader:endpoint";
// Stamped on every forwarded request/upgrade. A replica NEVER forwards a request
// that already carries it — two replicas that briefly disagree about who leads
// then serve it rather than bouncing it between them.
const FORWARDED_HEADER = "x-turma-forwarded-by";
// Proves a hop list came from a replica, not a client (XERK-919 QA): `<at>.<nonce>.<mac>`,
// the mac an HMAC under the replica-shared secret of the hop list AND the request it rode
// (method + target) AND the stamp (XERK-936). A client-supplied FORWARDED_HEADER without
// a valid, fresh, first-seen proof is IGNORED (and stripped), so it can neither force a
// follower to hold nor to serve as a second writer. Binding only the list (the XERK-919
// shape) let one captured header pair be replayed forever, onto any request.
const FORWARD_AUTH_HEADER = "x-turma-forward-auth";
// A proof older (or further in the future) than this is refused. It is minted as the hop
// is sent and checked on arrival, pod to pod, so this only has to cover node clock skew.
// Too tight for a badly skewed cluster = every proof refused = the bounce guard off (the
// pre-XERK-919-QA behaviour) — logged, never a stuck request.
const PROOF_MAX_AGE_MS = 30000;
// Proofs accepted within that window, so one captured pair buys at most ONE hold per
// replica. Only a replica that is NOT serving ever verifies a proof (decide() returns
// local first), and filling it takes the key, so this stays tiny. Full of FRESH
// entries it fails CLOSED (the proof is refused), never evicting a live nonce.
const SEEN_PROOFS_MAX = 10000;
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
  holdMs: 5000,
  holdPollMs: 100,
};
// A request is forwarded at most this many times (the hop list rides
// FORWARDED_HEADER), so a replica that is mid-handover can pass a request on to
// the new leader once, but two replicas can never bounce one between them.
const MAX_HOPS = 2;

// The mac half of a hop proof. Exported for tests; the one place the bound fields and
// their order are defined, so the minting and the checking side cannot drift.
function hopProof(key, list, method, target, at, nonce) {
  return crypto.createHmac("sha256", key)
    .update(["turma-forward", list, method, target, at, nonce].join("\n"))
    .digest("base64url");
}

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
    if (HOP_BY_HOP.has(lk) || lk === FORWARDED_HEADER || lk === FORWARD_AUTH_HEADER) continue;
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
    authToken = null, // replica-shared secret; null (tests) => hop lists are trusted
    // () => boolean: is THIS replica's store link up? While it is down, a leader entry
    // cannot be refreshed, so its age proves nothing — keep forwarding to the last
    // known leader (a dial failure still ends it) instead of degrading to a writer.
    storeHealthy = () => true,
    // (leader) => void: a FRESH REMOTE leader was learned (appeared or changed). The
    // caller drops sockets it served while degraded (its local agent tunnels).
    onRemoteLeader = () => {},
    // (req) => bytes: the largest body the LEADER could accept on this request's route,
    // or 0 = unknown / not one to refuse here (XERK-936, server.js `forwardBodyCap`).
    // A follower refuses a body DECLARED past that plus `drainSlack` itself — the band
    // the leader answers 413 and then resets in, where the reset raced the relayed 413
    // into a 502. Must never be BELOW the leader's real cap (that refuses a body the
    // leader would take); an over-estimate only leaves a body to the old path.
    bodyCap = () => 0,
    drainSlack = 4 << 20, // server.js RAW_BODY_DRAIN_SLACK: where the leader cuts
    drainMax = 8, // concurrent local refusals (DRAIN_CONCURRENCY_MAX); past it, forward
    // A refusal whose client sends NOTHING for this long is cut and frees its slot, so
    // a slow-loris cannot hold every slot and switch the local refusal off.
    drainIdleMs = 10000,
    // ...where "sends nothing" means less than this much progress in the window, so a
    // 1-byte trickle is idle too (readBody's BODY_MIN_PROGRESS_BYTES rule).
    drainMinProgress = 64 << 10,
  } = deps;
  const canServe = deps.canServe || isLeader;

  // Hot mirror of the leader endpoint: {replica, addr, seenAt}. `seenAt` is THIS
  // replica's clock at receipt (a watch event), so freshness never depends on two
  // pods' clocks agreeing — except the one boot-time hydrate, which can only use
  // the writer's `at`. `addr` null = a leader with no dialable address.
  let leader = null;
  const unreachableUntil = new Map(); // addr -> time before which we do not dial it
  const lastDialOk = new Map(); // addr -> when a dial to it last SUCCEEDED
  const live = new Set(); // every forwarded socket (client + upstream), for drain
  const stats = {
    requests: 0, upgrades: 0, dialFailures: 0, held: 0, degraded: 0,
    refusedOversize: 0, staleProofs: 0, replayedProofs: 0,
  };
  let refreshTimer = null;
  let unwatch = null;
  let unhealth = null;
  let lastMode = null; // for the edge-only mode log
  let draining = false; // set by stop(): this replica is shutting down
  let refusing = 0; // oversize bodies being drained by refuseOversize() right now
  const seenProofs = new Map(); // nonce -> expiry: proofs already accepted (replay guard)
  const ownDials = new Set(); // "addr|port" of every upstream socket we have open (see isSelfLoop)
  const hopCache = new WeakMap(); // req -> its verified hop list (decide() re-runs per poll)
  let staleLoggedAt = 0;

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
  // comma list, oldest first). Verified ONCE per request and remembered: decide()
  // re-runs on every hold poll, and a second look must not read as a replay.
  function hopsOf(req) {
    if (!req || typeof req !== "object") return [];
    let hops = hopCache.get(req);
    if (!hops) { hops = verifyHops(req); hopCache.set(req, hops); }
    return hops;
  }
  function verifyHops(req) {
    const v = req.headers && req.headers[FORWARDED_HEADER];
    if (typeof v !== "string" || !v) return [];
    if (authToken) {
      const got = req.headers[FORWARD_AUTH_HEADER];
      if (typeof got !== "string") return [];
      const [at, nonce, mac, extra] = got.split(".");
      if (extra !== undefined || !/^\d{1,15}$/.test(at || "") || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce || "")) return [];
      // Compare BYTES, not string length: a non-ASCII value of the right string
      // length has a longer UTF-8 encoding, and timingSafeEqual THROWS on unequal
      // buffer lengths — which on the upgrade path was an unauthenticated crash.
      const a = Buffer.from(mac || "");
      const b = Buffer.from(hopProof(authToken, v, String(req.method || ""), String(req.url || ""), at, nonce));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return []; // a client's claim: ignored
      const t = now();
      if (Math.abs(t - Number(at)) > PROOF_MAX_AGE_MS) {
        stats.staleProofs += 1;
        if (t - staleLoggedAt > 60000) {
          staleLoggedAt = t;
          log(`forward: refused a hop proof ${t - Number(at)}ms off this replica's clock — ` +
            `check node clock sync (hop lists are ignored while it is off by >${PROOF_MAX_AGE_MS}ms)`);
        }
        return [];
      }
      const hops = v.split(",").map((x) => x.trim()).filter(Boolean);
      // Our OWN proof coming back — the one replica a replay bites (our id is in the
      // list, so it would hold, then serve DEGRADED). The only genuine way here is a
      // SELF-DIAL (the leader entry names an alias of our address — `localhost` for
      // 127.0.0.1): that request arrives on a socket WE opened, which no client can
      // forge, and it must keep its list so the hop guard holds it (ignored, it
      // re-forwarded to itself until MAX_CONNECTIONS — QA). Anything else is a replay.
      // Stateless on purpose: a minted-nonce cache was evictable by a request flood.
      if (hops[hops.length - 1] === replicaId) {
        if (isSelfLoop(req)) return hops;
        stats.replayedProofs += 1;
        return [];
      }
      if (seenProofs.has(nonce)) { stats.replayedProofs += 1; return []; } // a replay: ignored
      for (const [n, exp] of seenProofs) { if (exp > t) break; seenProofs.delete(n); }
      // The sweep above stops at the first live entry, and expiries follow each SENDER's
      // clock, so a skewed one can shelter expired entries behind it: rescan before
      // refusing, so fail-closed means "full of LIVE nonces", nothing earlier.
      if (seenProofs.size >= SEEN_PROOFS_MAX) {
        for (const [n, exp] of seenProofs) if (exp <= t) seenProofs.delete(n);
      }
      if (seenProofs.size >= SEEN_PROOFS_MAX) { stats.replayedProofs += 1; return []; } // fail closed
      seenProofs.set(nonce, Number(at) + PROOF_MAX_AGE_MS);
      return hops;
    }
    return v.split(",").map((x) => x.trim()).filter(Boolean);
  }
  // The header pair to put on a forwarded request: our id appended, plus its proof,
  // bound to THIS request's method + target and stamped now with a fresh nonce.
  function hopHeaders(hops, req) {
    const list = hops.concat(replicaId).join(",");
    if (!authToken) return [FORWARDED_HEADER, list];
    const at = String(now());
    const nonce = crypto.randomBytes(12).toString("base64url");
    const mac = hopProof(authToken, list, String(req.method || ""), String(req.url || ""), at, nonce);
    return [FORWARDED_HEADER, list, FORWARD_AUTH_HEADER, `${at}.${nonce}.${mac}`];
  }
  // Did this request arrive on a connection one of OUR upstream dials opened? (the
  // TCP 4-tuple: its peer is our own socket's local end). `::ffff:` is stripped, since
  // a dual-stack listener sees an IPv4 dialer in mapped form.
  const bareAddr = (a) => String(a || "").replace(/^::ffff:/, "");
  function isSelfLoop(req) {
    const s = req && req.socket;
    return !!s && ownDials.has(`${bareAddr(s.remoteAddress)}|${s.remotePort}`);
  }

  // A leader entry naming OUR OWN address under another replica id is a previous
  // incarnation of this pod (a container restart keeps the POD_IP) — never a target.
  function isOwnAddr(addr) {
    return !!endpoint && addr === endpoint;
  }
  // Is there a fresh leader that is not us? (the caller's "drop degraded sockets" test)
  function remoteLeaderFresh() {
    const e = leader;
    if (!e || e.replica === replicaId || !e.addr || isOwnAddr(e.addr)) return false;
    if (now() - e.seenAt < ttlMs) return true;
    // With the store link down the entry cannot be refreshed, so its age proves
    // nothing — but neither does it prove the leader is ALIVE. Only a dial that
    // recently succeeded does; otherwise a follower would hand its tunnels to a
    // leader that has died too (the only replica left able to serve them).
    if (storeHealthy()) return false;
    const ok = lastDialOk.get(e.addr);
    return !!ok && now() - ok < ttlMs && !(unreachableUntil.get(e.addr) > now());
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
    const fresh = e && (now() - e.seenAt < ttlMs || !storeHealthy());
    if (!fresh || e.replica === replicaId || (e.addr && isOwnAddr(e.addr))) {
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
        const self = `${bareAddr(s.localAddress)}|${s.localPort}`;
        ownDials.add(self);
        s.once("close", () => ownDials.delete(self));
        lastDialOk.set(addr, now());
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

  // The cap to refuse this request against HERE, or 0 to forward it as usual. Only a
  // body DECLARED past the leader's cap + drain slack (the leader would cut it) on a
  // request this replica would not serve itself — the leader / HA-off path is untouched.
  function oversizeCap(req) {
    if (!enabled) return 0;
    const declared = Number(req.headers && req.headers["content-length"]);
    if (!Number.isFinite(declared)) return 0; // chunked: nothing to judge up front
    let cap = 0;
    try { cap = Number(bodyCap(req)) || 0; } catch { return 0; }
    if (!(cap > 0) || !(declared > cap + drainSlack)) return 0;
    if (decide(req).local || refusing >= drainMax) return 0;
    return cap;
  }

  // Refuse a declared-oversize body on THIS replica, exactly as the leader would
  // (readBody's no-drain path): read and DISCARD it up to cap + slack, answer 413, cut.
  // Draining first is the XERK-235 rule — a client that writes its whole body before
  // reading (python urllib: the agent) must be nearly done writing when the status
  // goes out, or it sees only the reset. Stateless, so safe on a follower; it never
  // dials the leader, so the leader's reset can no longer turn the 413 into a 502.
  function refuseOversize(req, res, cap) {
    stats.refusedOversize += 1;
    refusing += 1;
    let len = 0;
    let settled = false;
    let idle = null;
    let mark = 0; // `len` when the idle window last re-armed
    const release = () => {
      if (idle) { clearTimeout(idle); idle = null; }
      if (!settled) { settled = true; refusing -= 1; }
    };
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { release(); try { req.socket.destroy(); } catch { /* gone */ } }, drainIdleMs);
      if (idle.unref) idle.unref();
    };
    const answer = (cut) => {
      if (settled) return;
      release();
      req.removeListener("data", onData);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "body too large", limit: cap }));
      }
      if (!cut) return;
      // Nothing will read the rest of this body: close once the 413 is on the wire,
      // rather than let Node dump a body we already said no to (endRefusedConnection).
      try { req.pause(); } catch { /* gone */ }
      const kill = () => { try { req.socket.destroy(); } catch { /* gone */ } };
      if (res.writableFinished) kill(); else res.once("finish", kill);
    };
    const onData = (c) => {
      len += c.length;
      if (len > cap + drainSlack) answer(true);
      else if (len - mark >= drainMinProgress) { mark = len; armIdle(); }
    };
    armIdle();
    req.on("data", onData);
    req.once("end", () => answer(false));
    // A client that gives up mid-body frees its slot (a stalled one: drainIdleMs).
    req.once("close", release);
    req.on("error", release);
  }

  // Forward one HTTP request. Resolves true once it is handled here (proxied,
  // refused as oversize, or the client left while held), false when the caller
  // should serve it locally. Never throws, never rejects.
  async function forwardRequest(req, res) {
    const cap = oversizeCap(req);
    if (cap) { refuseOversize(req, res, cap); return true; }
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
    headers.push(...hopHeaders(r.hops, req), "Connection", "close");
    // An HTTP/1.0 client may send no Host; the leader's parser requires one.
    if (!req.headers.host) headers.push("Host", "hub");
    let up;
    try {
      up = http.request({ method: req.method, path: req.url, headers, createConnection: () => sock });
      // Send the head NOW, not on the first body write: a request whose body never
      // comes (an `Expect: 100-continue` client that gives up) must still reach the
      // leader, which may answer it (401, 413) without the body.
      up.flushHeaders();

    } catch (e) {
      sock.destroy();
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: `hub leader forward failed: ${e.message}` }));
      }
      return true;
    }
    let answered = false;
    up.on("response", (upRes) => {
      answered = true;
      // The leader has answered: stop sending it the body (a refusal is about to cut
      // the connection, and every further write only races that cut).
      req.unpipe(feed);
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
      // A write error AFTER the leader answered (it refused the body and cut the
      // connection) is not a failure of the answer: let the response relay finish.
      if (answered && res.headersSent) return; // upRes' own close/error handling settles it
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
    // Feed the body through a stage that YIELDS to the event loop between chunks, so a
    // response the leader sends mid-body (a size/budget refusal — 413 past its drain
    // slack, then a reset) is READ before our next write can fail on the reset. With a
    // tight write loop Node reports only the write error and drops the queued answer,
    // turning a 413 (which tells the agent to SHRINK the body) into a 502 it retries.
    const feed = new Transform({
      transform(chunk, _enc, cb) { setImmediate(() => cb(null, chunk)); },
    });
    feed.on("error", () => {});
    req.pipe(feed).pipe(up);
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
      const lk = String(raw[i]).toLowerCase();
      if (lk === FORWARDED_HEADER || lk === FORWARD_AUTH_HEADER) continue;
      lines.push(`${raw[i]}: ${raw[i + 1]}`);
    }
    const hh = hopHeaders(r.hops, req);
    for (let i = 0; i < hh.length; i += 2) lines.push(`${hh[i]}: ${hh[i + 1]}`);
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
      log(`forward: leader endpoint is ${v.addr || "UNDIALABLE"} (replica ${v.replica})` +
        (v.addr && isOwnAddr(v.addr) ? " — OUR OWN address (a previous incarnation), ignored" : ""));
    }
    if (remoteLeaderFresh()) {
      try { onRemoteLeader(leader); } catch { /* the caller's; never let it break the watch */ }
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
    remoteLeaderFresh,
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
  FORWARD_AUTH_HEADER,
  LOCAL_PATHS,
  DEFAULTS,
  MAX_HOPS,
  hopProof,
  PROOF_MAX_AGE_MS,
};
