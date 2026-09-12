// Cross-replica byte-stream relay transport (XERK-777, epic XERK-751/775).
//
// The #1 active-active blocker's TRANSPORT half. Each agent holds exactly ONE
// reverse-tunnel control channel to ONE replica (`controlChannels[host]` on that
// replica; server.js `/agent/control`). XERK-764 landed the shared
// `hostReplica:<host>` DIRECTORY + the control BUS (cross-replica `terminalOnline`
// truth + an addressed command poke) but DEFERRED the duplex BYTE-STREAM relay for
// `/term`, the `/live` deltas and `openChannel`'s data channel — so those bytes
// still serve only from the tunnel owner's replica (the recommended Option-2
// leader-only-serving topology). This module is that deferred transport, the
// primitive only; the `/term` / `/live` / `openChannel` CONSUMERS are a follow-up.
//
// HARD CONSTRAINT (`.claude/rules/turma-ha-tunnel.md`): the relay MUST NOT ride the
// single shared store subscriber connection the SSE bus (XERK-762) and the registry
// watch (XERK-756) depend on. Bulk interactive terminal traffic through
// `store.publish`/`subscribe` would head-of-line-block the fleet's LIVENESS channel
// (one Valkey `SUBSCRIBE` socket, `store.js`). So this is a DEDICATED transport: a
// DIRECT pod-to-pod duplex byte channel. The store is used ONLY for the byte-free
// endpoint DIRECTORY (which replica listens where) and never carries a payload byte.
//
// Shape (settled per the ticket; rationale in `docs/turma-ha-store-adr.md`): an
// in-hub pod-to-pod reverse-proxy. The replica a client landed on (the ORIGIN)
// looks up the host's tunnel owner in the `hostTunnelOwners` mirror (XERK-764),
// resolves that replica's dial address from this module's endpoint directory, and
// opens a DIRECT duplex byte channel to it. The OWNER replica accepts that channel,
// verifies it still holds the tunnel, bridges it to its local `controlChannels[host]`
// (via the injected `openLocal`, i.e. server.js `openChannel`), and pipes both ways.
// Rejected alternative — route-by-host at the ingress — cannot work: a stock L4/L7
// load balancer cannot key on app-level host identity, and the manifests are out of
// this repo (see the ADR).
//
// `makeRelay(store, replicaId, deps)` is STANDALONE + store/directory-injected,
// exactly like `makeControlBus`/`makeSseBus` in server.js, so the whole routing +
// bridging + lifecycle is unit-testable with a `FileLiveStore` and an in-process
// loopback duplex pair — NO live Valkey and NO cluster (the same no-live-backend
// discipline as store.js's RESP codec and leader.js's election). stdlib only.
//
// NON-HA is byte-identical: server.js constructs a relay ONLY under HA (like
// `controlBus`/`sseBus`); with HA off the binding stays null and no code here runs.

"use strict";

const { Duplex } = require("stream");

// The endpoint directory: replica id -> {addr, at} in the shared store, so the
// ORIGIN can turn "owner is replica B" (from `hostTunnelOwners`) into a dialable
// address. Byte-FREE — it holds a short address record, never a stream byte. TTL'd
// like `hostReplica:` so a crashed replica's endpoint expires even if `stop()`
// never ran; refreshed on an interval under a live listener.
const RELAY_ENDPOINT_PREFIX = "relayEndpoint:";

// Frame types on the pod-to-pod connection. A tiny length-prefixed framing (NOT
// the store, NOT WS) rides the raw duplex the injected `dial`/listener hands us:
//   [ 1 byte type ][ 4 bytes big-endian length ][ length bytes payload ]
// DATA carries raw client<->agent bytes; CTRL carries a small JSON control object
// (the handshake, a reconnect hint, ping/pong); CLOSE is a clean half-close marker.
const F_DATA = 0x0;
const F_CTRL = 0x1;
const F_CLOSE = 0x2;

// Bound the deframe accumulator's DECLARED length, the same memory discipline
// server.js's `wsParser` applies (XERK-357): one oversize declared frame must not
// grow an unbounded `Buffer.concat`. A payload over this kills the connection.
const DEFAULT_FRAME_MAX = 16 * 1024 * 1024;

// Liveness on the pod-to-pod hop: a half-open TCP connection (peer pod OOM-killed,
// a network partition with no FIN) must not hang a terminal forever. Mirrors the
// control channel's own ping/idle model (server.js `/agent/control`).
const DEFAULT_PING_MS = 30 * 1000;
const DEFAULT_DEAD_MS = 90 * 1000;

// A handshake that never arrives (a dial that connected to something that is not a
// relay listener, or an owner wedged mid-accept) must fail fast, never hang.
const DEFAULT_HANDSHAKE_MS = 10 * 1000;

function encodeFrame(type, payload) {
  const body = payload || Buffer.alloc(0);
  const head = Buffer.allocUnsafe(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return body.length ? Buffer.concat([head, body]) : head;
}

// A streaming deframer over the raw connection. `onFrame(type, payload)` per frame;
// `onOverflow(len)` when a declared length exceeds `max` (the parser then goes DEAD,
// like `wsParser` — a stream with no next frame boundary is unrecoverable). Returns
// the `(chunk) => void` to feed `conn`'s "data".
function makeDeframer(onFrame, { max, onOverflow }) {
  let buf = Buffer.alloc(0);
  let dead = false;
  return (chunk) => {
    if (dead) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 5) return;
      const type = buf[0];
      const len = buf.readUInt32BE(1);
      if (len > max) {
        dead = true;
        buf = Buffer.alloc(0);
        onOverflow(len);
        return;
      }
      if (buf.length < 5 + len) return;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      onFrame(type, payload);
    }
  };
}

// Wrap a raw byte duplex `conn` (from `dial`, or a listener's inbound socket) as a
// framed relay endpoint: a Duplex `d` of raw DATA bytes, plus `d.sendCtrl(obj)` for
// a JSON control frame and a `hint` event for a control frame received. Backpressure
// is honoured in BOTH directions: `_write` waits on `conn.write`'s drain, and inbound
// DATA respects `d.push()`'s return by pausing `conn`. A clean close (a CLOSE frame,
// or the underlying conn ending) pushes EOF and never leaves a hung socket.
function frameConn(conn, { max, onCtrl, label }) {
  let paused = false;
  let closedRead = false;

  const d = new Duplex({
    write(chunk, _enc, cb) {
      // A write once the underlying conn is gone/half-closed (a torn-down peer, or
      // our own writable FIN) is dropped, not thrown — a bridged reverse flow can
      // still be piping in when the far side ends (write-after-end otherwise ESRCH/
      // ECONNRESETs and, unhandled, crashes the process).
      if (conn.destroyed || conn.writableEnded) return cb();
      const frame = encodeFrame(F_DATA, chunk);
      // Respect the underlying connection's backpressure: if its buffer is full,
      // wait for "drain" before acking this write, so a slow peer pod cannot make
      // the origin buffer the whole terminal stream in the hub's heap.
      if (conn.write(frame)) return cb();
      conn.once("drain", cb);
    },
    read() {
      if (paused) { paused = false; try { conn.resume(); } catch { /* gone */ } }
    },
    final(cb) {
      // Writable half done: send a CLOSE frame, then FIN the underlying socket so
      // the peer's conn eventually closes and BOTH ends tear down (no half-open
      // hang). `conn.end` flushes anything already buffered (a hint frame written
      // just before) before the FIN.
      try { conn.write(encodeFrame(F_CLOSE)); } catch { /* peer gone */ }
      try { conn.end(); } catch { /* already gone */ }
      cb();
    },
    destroy(err, cb) {
      try { conn.destroy(); } catch { /* already gone */ }
      cb(err);
    },
  });

  // Surface a control frame (a reconnect hint) so the CONSUMER can reconnect the
  // browser rather than treat the close as fatal; the returned duplex ALSO ends
  // cleanly (never a hung socket) whichever the consumer does with the hint.
  d.sendCtrl = (obj) => {
    try { conn.write(encodeFrame(F_CTRL, Buffer.from(JSON.stringify(obj), "utf8"))); }
    catch { /* peer gone */ }
  };

  const endRead = () => { if (!closedRead) { closedRead = true; d.push(null); } };

  const deframe = makeDeframer((type, payload) => {
    // A CLOSE frame is the peer's writable FIN: EOF our readable side ONLY (a
    // half-close). The reverse direction may still be streaming (an echo, a
    // terminal that keeps painting after the client stops typing), so we must NOT
    // end our own writable here — that write-after-ends the bridged flow.
    if (type === F_CLOSE) { endRead(); return; }
    if (type === F_CTRL) {
      let obj = null;
      try { obj = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (onCtrl) onCtrl(obj);
      d.emit("hint", obj);
      // A teardown HINT (owner handoff / tunnel drop / peer silent) means the
      // whole channel is done: the consumer has now seen the hint, so tear the
      // duplex fully down (full close, never a lingering half-open) on the next
      // tick. Liveness frames (ping/pong) are not hints and never reach here.
      if (obj && obj.t === "hint") { endRead(); process.nextTick(() => { if (!d.destroyed) d.destroy(); }); }
      return;
    }
    // DATA: push to the readable side; if the consumer is slow, pause the
    // underlying connection until `_read` resumes it (backpressure inbound).
    if (payload.length && !d.push(Buffer.from(payload))) {
      paused = true;
      try { conn.pause(); } catch { /* gone */ }
    }
  }, {
    max,
    onOverflow: (len) => {
      // Unrecoverable: the deframer has no next boundary. Drop the whole
      // connection; the consumer reconnects (bounded, never hung).
      try { conn.destroy(new Error(`relay frame over ceiling (${len} > ${max})${label ? " on " + label : ""}`)); }
      catch { /* already gone */ }
    },
  });

  conn.on("data", deframe);
  // The underlying connection ended/broke: EOF the readable side and tear down the
  // duplex, so a dropped pod-to-pod hop can never leave a terminal hung. Destroy
  // WITHOUT the error (like channelDuplex) — a bare `d.destroy(err)` with no
  // consumer "error" listener would re-throw as an uncaught exception; the consumer
  // learns of the break through "close" (and a hint frame where one was sendable).
  conn.on("end", endRead);
  conn.on("close", () => { endRead(); if (!d.destroyed) d.destroy(); });
  conn.on("error", () => { if (!d.destroyed) d.destroy(); });

  d._relayConn = conn;
  return d;
}

// Pipe two framed relay-DATA duplexes together (the OWNER side: the inbound relay
// duplex <-> the local agent-tunnel duplex from `openLocal`). `.pipe` carries the
// backpressure both frameConn and channelDuplex already honour; a break on EITHER
// side tears down BOTH, so neither half is ever left hung.
function bridge(a, b) {
  // Destroy WITHOUT the error (a re-thrown "error" with no listener would crash the
  // process); a break on either side is surfaced to the consumer via "close".
  const kill = () => {
    if (!a.destroyed) a.destroy();
    if (!b.destroyed) b.destroy();
  };
  a.on("error", kill);
  b.on("error", kill);
  a.on("close", () => { if (!b.destroyed) b.destroy(); });
  b.on("close", () => { if (!a.destroyed) a.destroy(); });
  a.pipe(b);
  b.pipe(a);
}

// Attach a ping/idle liveness loop to a framed duplex `d` over `conn` so a half-open
// pod-to-pod hop is detected and torn down (with a hint) rather than reporting live
// forever. Best-effort; returns a stop() the caller runs on close.
function attachLiveness(d, { pingMs, deadMs, now }) {
  let lastSeen = now();
  const onAny = () => { lastSeen = now(); };
  d._relayConn.on("data", onAny);
  const timer = setInterval(() => {
    if (now() - lastSeen > deadMs) {
      // Half-open pod-to-pod hop: tear down cleanly (no error arg — see bridge).
      if (!d.destroyed) d.destroy();
      return;
    }
    d.sendCtrl({ t: "ping" });
  }, pingMs);
  if (timer.unref) timer.unref();
  const stop = () => clearInterval(timer);
  d.once("close", stop);
  return stop;
}

// Build the relay transport. `store` + `replicaId` are injected exactly as
// `makeControlBus(store, replicaId)` takes them; `deps` injects the seams that are
// deployment-coupled (the pod-to-pod socket) or live in server.js (the tunnel
// directory + `openChannel`), so this module is exercisable with a FileLiveStore
// and a loopback pair alone:
//   owners       host -> {replica, at} mirror (server.js `hostTunnelOwners`, XERK-764)
//   ttlMs        freshness bound for an owner/endpoint entry (HOST_REPLICA_TTL_MS)
//   localTunnel  (host) => truthy iff THIS replica holds host's control channel
//                (server.js `!!controlChannels[host]`) — the ownership check
//   openLocal    (host, port) => Promise<Duplex> bridged to the local agent tunnel
//                (server.js `openChannel`); ONLY used on the accept/owner side
//   dial         (replica, addr) => Promise<Duplex> raw pod-to-pod byte channel
//                (prod: connect to the peer's relay listener; tests: a loopback pair)
//   endpoint     this replica's own dialable address, published to the directory so
//                a peer's `dial` can resolve it (optional; the listener is boot scope)
//   frameMax/pingMs/deadMs/handshakeMs/now  tunables (tests wind them down)
function makeRelay(store, replicaId, deps = {}) {
  const {
    owners = Object.create(null),
    ttlMs = DEFAULT_DEAD_MS,
    localTunnel = () => false,
    openLocal,
    dial,
    endpoint = null,
    frameMax = DEFAULT_FRAME_MAX,
    pingMs = DEFAULT_PING_MS,
    deadMs = DEFAULT_DEAD_MS,
    handshakeMs = DEFAULT_HANDSHAKE_MS,
    now = Date.now,
  } = deps;

  // Hot mirror of the endpoint directory (replica -> {addr, at}), populated by a
  // watch + boot scan, the same pattern `hostTunnelOwners` uses — kept off the
  // request path so address resolution is synchronous. This replica's OWN entry is
  // set synchronously too, so `connect` resolves a self-dial (a test edge) without
  // waiting on the self-echo watch.
  const endpoints = Object.create(null);
  let refreshTimer = null;
  let unwatch = null;

  function storeFailed(e) {
    // Best-effort like every other store write here (XERK-235): an uncaught throw
    // in a callback/timer would exit the hub. A dropped endpoint write self-heals
    // on the next refresh; a dropped read just falls back to no-remote-owner.
    console.error(`relay endpoint write failed: ${(e && e.message) || e}`);
  }

  // Is `host` owned by a FRESH REMOTE replica per the directory mirror? Mirrors
  // server.js `pokeHost`'s decision exactly: a LOCAL, SELF, ABSENT or STALE owner
  // is not a relay target (local => serve here; stale => presumed dead).
  function remoteOwner(host) {
    if (localTunnel(host)) return null;         // we hold it — no relay needed
    const o = owners[host];
    if (!o || o.replica === replicaId) return null;
    if (now() - o.at >= ttlMs) return null;     // stale — treat as gone
    return o.replica;
  }

  function endpointAddr(replica) {
    const e = endpoints[replica];
    if (!e || now() - e.at >= ttlMs) return null;
    return e.addr;
  }

  // ORIGIN. Open a duplex bridged to `host`'s tunnel on its owning replica, or
  // null when there is no fresh REMOTE owner (the caller then uses its own local
  // path — `openChannel` when it holds the tunnel, or reports offline). Rejects on
  // a dial/handshake failure so the caller can surface it, never hangs.
  async function connect(host, port) {
    const target = remoteOwner(host);
    if (!target) return null;
    const addr = endpointAddr(target); // may be null; a DNS-based `dial` ignores it
    let conn;
    try {
      conn = await dial(target, addr);
    } catch (e) {
      // Replica loss / unreachable pod: fail cleanly, the caller reconnects.
      throw new Error(`relay dial to ${target} failed: ${(e && e.message) || e}`);
    }
    const d = frameConn(conn, { max: frameMax, label: `relay->${host}` });
    // The handshake NAMES the host (and its ttyd port) so the owner bridges the
    // right tunnel and can refuse if it no longer holds it.
    d.sendCtrl({ t: "open", host, port });
    attachLiveness(d, { pingMs, deadMs, now });
    return d;
  }

  // OWNER / SERVE. The relay LISTENER (boot/consumer scope) hands each inbound raw
  // duplex here. Read the handshake, verify THIS replica still owns the host, bridge
  // to the local agent tunnel, and pipe both ways. Every refusal/failure closes with
  // a reconnect HINT so the origin's consumer reconnects to the (possibly new) owner
  // rather than seeing a fatal error — and never leaves a hung socket.
  function accept(conn) {
    let handshook = false;
    const d = frameConn(conn, {
      max: frameMax,
      label: "relay-inbound",
      onCtrl: async (obj) => {
        if (obj && obj.t === "ping") { d.sendCtrl({ t: "pong" }); return; }
        if (obj && obj.t === "pong") return;
        if (handshook || !obj || obj.t !== "open" || typeof obj.host !== "string") return;
        handshook = true;
        clearTimeout(hsTimer);
        const host = obj.host;
        const port = obj.port;
        // Owner handoff: the host reconnected to another replica between the
        // origin's owner lookup and this dial. We are not it — tell the origin to
        // reconnect (it re-resolves the new owner) and close.
        if (!localTunnel(host)) { d.sendCtrl({ t: "hint", reason: "not-owner" }); d.end(); return; }
        let agent;
        try {
          agent = await openLocal(host, port);
        } catch (e) {
          // Tunnel drop (the control channel went away as we bridged): hint +
          // close; the origin reconnects and finds the tunnel down or moved.
          d.sendCtrl({ t: "hint", reason: "tunnel-down", detail: (e && e.message) || String(e) });
          d.end();
          return;
        }
        attachLiveness(d, { pingMs, deadMs, now });
        bridge(d, agent);
      },
    });
    // A dial that connected but never sent a handshake (not a real relay origin, or
    // a wedged peer) must not hold the socket open forever.
    const hsTimer = setTimeout(() => {
      if (!handshook && !d.destroyed) d.destroy(); // clean close, no error re-throw
    }, handshakeMs);
    if (hsTimer.unref) hsTimer.unref();
    d.once("close", () => clearTimeout(hsTimer));
  }

  // Publish/refresh THIS replica's endpoint in the directory so peers can dial it.
  // Byte-free. No-op without an `endpoint` (a test that dials by replica id alone,
  // or a not-yet-listening process). The mirror is written synchronously too.
  function publishEndpoint() {
    if (!endpoint || !store) return;
    const rec = { addr: endpoint, at: now() };
    endpoints[replicaId] = rec;
    Promise.resolve(store.set(RELAY_ENDPOINT_PREFIX + replicaId, rec, { ttlMs })).catch(storeFailed);
  }

  // Watch the directory so peer endpoints (and updates) land in the local mirror,
  // and hydrate what the store already holds at start — the `hostTunnelOwners`
  // pattern. Best-effort; a store without watch/scan (or HA off) simply leaves the
  // mirror to fill from live sets, and address-less `dial` still works.
  async function start() {
    publishEndpoint();
    if (store && typeof store.watch === "function") {
      unwatch = store.watch(RELAY_ENDPOINT_PREFIX, (ev) => {
        if (!ev || typeof ev.key !== "string") return;
        const replica = ev.key.slice(RELAY_ENDPOINT_PREFIX.length);
        if (!replica) return;
        if (ev.type === "del") { delete endpoints[replica]; return; }
        const v = ev.value;
        if (!v || typeof v !== "object" || typeof v.addr !== "string" || typeof v.at !== "number") return;
        endpoints[replica] = { addr: v.addr, at: v.at };
      });
    }
    if (store && typeof store.scan === "function") {
      try {
        if (store.ready) await store.ready();
        for (const { key, value } of await store.scan(RELAY_ENDPOINT_PREFIX)) {
          const replica = key.slice(RELAY_ENDPOINT_PREFIX.length);
          if (!replica || Object.prototype.hasOwnProperty.call(endpoints, replica)) continue; // watch won
          if (!value || typeof value !== "object" || typeof value.addr !== "string" || typeof value.at !== "number") continue;
          endpoints[replica] = { addr: value.addr, at: value.at };
        }
      } catch (e) { storeFailed(e); }
    }
    if (endpoint && store) {
      refreshTimer = setInterval(publishEndpoint, Math.max(1000, Math.floor(ttlMs / 3)));
      if (refreshTimer.unref) refreshTimer.unref();
    }
  }

  function stop() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (unwatch) { try { unwatch(); } catch { /* best effort */ } unwatch = null; }
    if (endpoint && store) {
      delete endpoints[replicaId];
      Promise.resolve(store.del(RELAY_ENDPOINT_PREFIX + replicaId)).catch(storeFailed);
    }
  }

  return {
    connect,
    accept,
    start,
    stop,
    // Test/introspection seams (never on the request path).
    _endpoints: endpoints,
    _remoteOwner: remoteOwner,
    _endpointAddr: endpointAddr,
  };
}

module.exports = {
  makeRelay,
  frameConn,
  encodeFrame,
  makeDeframer,
  RELAY_ENDPOINT_PREFIX,
  F_DATA,
  F_CTRL,
  F_CLOSE,
  DEFAULT_FRAME_MAX,
};
