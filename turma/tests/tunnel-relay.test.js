"use strict";

// XERK-777 — the cross-replica byte-stream RELAY transport primitive: the duplex
// relay XERK-764 deferred for `/term`, the `/live` deltas and `openChannel`. Each
// agent holds ONE reverse-tunnel control channel to ONE replica; under active-active
// a client's terminal/`/live` bytes can land on a replica that does NOT own the
// tunnel. This module opens a DIRECT pod-to-pod duplex to the OWNING replica (never
// through the store's pub/sub, which would head-of-line-block the liveness channel),
// which bridges to its local agent tunnel.
//
// These drive `makeRelay` with a `FileLiveStore` standing in for the shared store
// (no live Valkey in CI, same constraint as store.test.js / tunnel-directory.test.js)
// and an in-process net LOOPBACK PAIR standing in for the pod-to-pod connection (no
// cluster), and pin:
//   - ROUTING: `remoteOwner`/`connect` resolve local/self/absent/stale as no-relay
//     (null), a fresh REMOTE owner as a dial target — mirroring `pokeHost`;
//   - the DUPLEX BRIDGE end-to-end: origin bytes reach the agent tunnel on the owner
//     and the agent's bytes come back, through the loopback + `openLocal`;
//   - the three CLEAN-CLOSE failure modes, each with a reconnect HINT and no hung
//     socket: owner HANDOFF (not-owner at accept), TUNNEL DROP (openLocal rejects),
//     REPLICA LOSS (dial rejects);
//   - backpressure integrity across a large payload; the framing codec (split
//     chunks, overflow → dead); handshake timeout; the endpoint DIRECTORY (publish/
//     watch-mirror/hydrate/retire) that lets the origin resolve a peer's dial addr.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { Duplex } = require("node:stream");

const {
  makeRelay,
  encodeFrame,
  makeDeframer,
  frameConn,
  RELAY_ENDPOINT_PREFIX,
  F_DATA,
  F_CTRL,
} = require("../relay.js");
const { FileLiveStore } = require("../store.js");

// Every socket a test opens is tracked and torn down after it, so the file exits
// cleanly with no leaked handle (CI runs `node --test` with no --test-force-exit).
const tracked = new Set();
function track(sock) {
  tracked.add(sock);
  // Reset/half-close on a torn-down peer is EXPECTED here (we destroy ends out from
  // under active flows on purpose); swallow it so an async socket error can't crash
  // the run — production consumers attach their own handlers.
  sock.on("error", () => {});
  sock.on("close", () => tracked.delete(sock));
  return sock;
}
afterEach(() => {
  for (const s of tracked) { try { s.destroy(); } catch { /* already gone */ } }
  tracked.clear();
});

// An in-process loopback pair: two connected net sockets over 127.0.0.1 — real
// byte semantics (backpressure, end/close/error), no cluster. Resolves [a, b].
function loopback() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((server) => {
      srv.close();
      resolve([client, track(server)]);
    });
    let client;
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      client = track(net.connect(srv.address().port, "127.0.0.1"));
    });
  });
}

// Drain a duplex to a single Buffer once it ends.
function readAll(d) {
  return new Promise((resolve) => {
    const chunks = [];
    d.on("data", (c) => chunks.push(c));
    d.on("end", () => resolve(Buffer.concat(chunks)));
    d.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

function ownerRelay(deps) {
  // A relay standing in for the OWNER replica "R-owner": it holds the tunnel.
  return makeRelay(null, "R-owner", { localTunnel: () => true, ...deps });
}

test("XERK-777: remoteOwner routes exactly like pokeHost — local/self/absent/stale are no-relay", () => {
  const owners = Object.create(null);
  let clock = 1_000_000;
  const relay = makeRelay(null, "R-A", {
    owners,
    ttlMs: 1000,
    localTunnel: (h) => h === "held-here",
    now: () => clock,
  });

  // We hold the tunnel -> serve locally, never relay.
  owners["held-here"] = { replica: "R-B", at: clock };
  assert.equal(relay._remoteOwner("held-here"), null);

  // No owner known -> no relay (report offline / fall back).
  assert.equal(relay._remoteOwner("nobody"), null);

  // Owner is US -> torn-down local tunnel, not a relay target.
  owners["mine"] = { replica: "R-A", at: clock };
  assert.equal(relay._remoteOwner("mine"), null);

  // Fresh REMOTE owner -> the relay target.
  owners["remote"] = { replica: "R-B", at: clock };
  assert.equal(relay._remoteOwner("remote"), "R-B");

  // Stale REMOTE owner -> presumed dead, no relay.
  clock += 5000;
  assert.equal(relay._remoteOwner("remote"), null);
});

test("XERK-777: connect returns null (no dial) when there is no fresh remote owner", async () => {
  let dialed = 0;
  const relay = makeRelay(null, "R-A", {
    owners: Object.create(null),
    ttlMs: 1000,
    localTunnel: () => false,
    dial: async () => { dialed++; return (await loopback())[0]; },
  });
  assert.equal(await relay.connect("nobody", 7681), null);
  assert.equal(dialed, 0, "no owner => no dial");
});

test("XERK-777: end-to-end — origin bytes reach the owner's agent tunnel and back", async () => {
  const [originConn, ownerConn] = await loopback();
  // Owner side: an echo "agent tunnel" the owner's openLocal hands back.
  const [ownerAgentEnd, ttyd] = await loopback();
  ttyd.pipe(ttyd); // echo everything the terminal writes

  let openedHost = null;
  let openedPort = null;
  const owner = ownerRelay({
    openLocal: async (host, port) => { openedHost = host; openedPort = port; return ownerAgentEnd; },
  });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });

  const d = await origin.connect("h1", 7681);
  assert.ok(d, "a fresh remote owner yields a relay duplex");

  const got = new Promise((resolve) => d.once("data", (c) => resolve(c.toString())));
  d.write(Buffer.from("hello-terminal"));
  assert.equal(await got, "hello-terminal", "bytes round-trip origin->owner->agent->back");

  // The handshake named the host + ttyd port so the owner bridged the right tunnel.
  assert.equal(openedHost, "h1");
  assert.equal(openedPort, 7681);

  d.destroy();
});

test("XERK-777: owner HANDOFF — accept refuses a host it no longer owns, hints reconnect, closes clean", async () => {
  const [originConn, ownerConn] = await loopback();
  let openLocalCalls = 0;
  const owner = makeRelay(null, "R-owner", {
    localTunnel: () => false, // the host moved away between the origin's lookup and this dial
    openLocal: async () => { openLocalCalls++; return (await loopback())[0]; },
  });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 7681);

  // Register the close listener UP FRONT (as a real consumer does when it receives
  // the duplex) — the teardown-close fires a tick after the hint.
  const closed = new Promise((resolve) => d.on("close", resolve));
  const hint = await new Promise((resolve) => d.once("hint", resolve));
  assert.equal(hint.reason, "not-owner", "the origin is told to reconnect to the new owner");
  assert.equal(openLocalCalls, 0, "a non-owner never bridges a tunnel it lacks");
  await closed; // ends cleanly — never left hung
});

test("XERK-777: TUNNEL DROP — openLocal rejection hints tunnel-down and closes clean", async () => {
  const [originConn, ownerConn] = await loopback();
  const owner = ownerRelay({
    openLocal: async () => { throw new Error("agent tunnel offline"); },
  });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 7681);

  const closed = new Promise((resolve) => d.on("close", resolve));
  const hint = await new Promise((resolve) => d.once("hint", resolve));
  assert.equal(hint.reason, "tunnel-down");
  await closed;
});

test("XERK-777: REPLICA LOSS — a failed dial rejects connect cleanly, never hangs", async () => {
  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-gone", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(() => origin.connect("h1", 7681), /relay dial to R-gone failed/);
});

test("XERK-777: a broken pod-to-pod hop mid-stream EOFs the origin duplex (no hung socket)", async () => {
  const [originConn, ownerConn] = await loopback();
  const [ownerAgentEnd, ttyd] = await loopback();
  ttyd.pipe(ttyd);
  const owner = ownerRelay({ openLocal: async () => ownerAgentEnd });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 7681);
  const ended = new Promise((resolve) => d.on("close", resolve));
  // The peer pod vanishes with no FIN handshake.
  ownerConn.destroy();
  await ended; // resolves => the origin duplex tore down rather than hanging
});

test("XERK-777: a resolved non-stream from openLocal hints + closes, never an unhandled crash", async () => {
  const [originConn, ownerConn] = await loopback();
  // A mis-wired consumer: openLocal RESOLVES (doesn't reject) with a non-duplex, so
  // the internal bridge() would throw synchronously inside the async onCtrl handler.
  const owner = ownerRelay({ openLocal: async () => ({ notAStream: true }) });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 7681);
  const closed = new Promise((resolve) => d.on("close", resolve));
  const hint = await new Promise((resolve) => d.once("hint", resolve));
  assert.equal(hint.reason, "relay-error", "a bridge throw is turned into a clean hint + close");
  await closed; // process did not crash; the socket tore down
});

test("XERK-777: a large payload survives framing + backpressure intact", async () => {
  const [originConn, ownerConn] = await loopback();
  const [ownerAgentEnd, ttyd] = await loopback();
  ttyd.pipe(ttyd);
  const owner = ownerRelay({ openLocal: async () => ownerAgentEnd });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 7681);

  const payload = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const back = new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    d.on("data", (c) => { chunks.push(c); n += c.length; if (n >= payload.length) resolve(Buffer.concat(chunks)); });
  });
  // write (not end) — the reverse echo is still streaming, so keep the duplex open;
  // afterEach tears the sockets down.
  d.write(payload);
  const echoed = await back;
  assert.equal(echoed.length, payload.length);
  assert.ok(echoed.equals(payload), "every byte survived the frame/deframe + bridge");
});

test("XERK-777: framing codec — round-trip, split chunks, and overflow goes dead", () => {
  // Round-trip across an arbitrary chunk boundary.
  const frames = [];
  const feed = makeDeframer((t, p) => frames.push([t, p.toString()]), { max: 1 << 20, onOverflow: () => {} });
  const wire = Buffer.concat([
    encodeFrame(F_CTRL, Buffer.from(JSON.stringify({ t: "open", host: "h1" }))),
    encodeFrame(F_DATA, Buffer.from("abc")),
  ]);
  // Deliver one byte at a time to prove the deframer holds partial frames.
  for (const b of wire) feed(Buffer.from([b]));
  assert.deepEqual(frames, [[F_CTRL, JSON.stringify({ t: "open", host: "h1" })], [F_DATA, "abc"]]);

  // Overflow: a declared length past max fires onOverflow ONCE and the parser dies.
  let over = null;
  let after = 0;
  const feed2 = makeDeframer(() => { after++; }, { max: 8, onOverflow: (len) => { over = len; } });
  const big = Buffer.allocUnsafe(5);
  big[0] = F_DATA;
  big.writeUInt32BE(1000, 1);
  feed2(big);
  assert.equal(over, 1000);
  feed2(encodeFrame(F_DATA, Buffer.from("x"))); // ignored — parser is dead
  assert.equal(after, 0);
});

test("XERK-777: accept destroys a connection that never sends a handshake", async () => {
  const [originConn, ownerConn] = await loopback();
  const owner = ownerRelay({ openLocal: async () => (await loopback())[0], handshakeMs: 40 });
  owner.accept(ownerConn);
  const closed = new Promise((resolve) => originConn.on("close", resolve));
  // Never send anything; the handshake timer must tear the socket down.
  await closed;
});

test("XERK-777: endpoint directory — publish, watch-mirror a peer, hydrate at start, retire on stop", async () => {
  const store = new FileLiveStore();
  // A peer already advertised its endpoint before we boot (hydrate must pick it up).
  await store.set(RELAY_ENDPOINT_PREFIX + "R-peer", { addr: "10.0.0.9:9999", at: Date.now() }, { ttlMs: 60000 });

  const relay = makeRelay(store, "R-me", {
    endpoint: "10.0.0.1:9000",
    ttlMs: 60000,
    owners: { h1: { replica: "R-peer", at: Date.now() } },
    localTunnel: () => false,
    dial: async () => (await loopback())[0],
  });
  await relay.start();

  // Our own endpoint was published to the store AND the local mirror.
  assert.equal((await store.get(RELAY_ENDPOINT_PREFIX + "R-me")).addr, "10.0.0.1:9000");
  assert.equal(relay._endpointAddr("R-me"), "10.0.0.1:9000");
  // The pre-existing peer endpoint was hydrated.
  assert.equal(relay._endpointAddr("R-peer"), "10.0.0.9:9999");

  // A peer set arriving on the watch lands in the mirror; a del clears it.
  await store.set(RELAY_ENDPOINT_PREFIX + "R-new", { addr: "10.0.0.5:9001", at: Date.now() }, { ttlMs: 60000 });
  assert.equal(relay._endpointAddr("R-new"), "10.0.0.5:9001");
  await store.del(RELAY_ENDPOINT_PREFIX + "R-new");
  assert.equal(relay._endpointAddr("R-new"), null);

  // connect resolves the owner's addr from the mirror and hands it to dial.
  let dialAddr = null;
  const relay2 = makeRelay(store, "R-me", {
    endpoint: "10.0.0.1:9000",
    ttlMs: 60000,
    owners: { h1: { replica: "R-peer", at: Date.now() } },
    localTunnel: () => false,
    dial: async (replica, addr) => { dialAddr = addr; return (await loopback())[0]; },
  });
  await relay2.start();
  const d = await relay2.connect("h1", 7681);
  assert.equal(dialAddr, "10.0.0.9:9999", "the resolved peer address is dialed");
  d.destroy();

  relay.stop();
  relay2.stop();
  assert.equal(await store.get(RELAY_ENDPOINT_PREFIX + "R-me"), null, "stop retires the endpoint");
});

test("XERK-781: a LIVE channel bridges the owner's delta stream to the origin", async () => {
  const [originConn, ownerConn] = await loopback();
  let liveHost = null;
  let liveSession = null;
  let sink = null;
  let resolveOpen;
  const opened = new Promise((r) => { resolveOpen = r; });
  const owner = ownerRelay({
    // `openLive` returns a duplex whose READABLE side carries the session's deltas.
    openLive: async (host, session) => {
      liveHost = host;
      liveSession = session;
      sink = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
      resolveOpen();
      return sink;
    },
  });
  owner.accept(ownerConn);

  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 0, { kind: "live", session: "sess-9" });
  assert.ok(d, "a live channel to a fresh remote owner yields a duplex");
  await opened;
  assert.equal(liveHost, "h1", "the handshake named the host");
  assert.equal(liveSession, "sess-9", "the handshake named the session (not a ttyd port)");

  // The owner pushes one newline-delimited JSON delta; it reaches the origin intact.
  let buf = "";
  const gotDelta = new Promise((resolve) => {
    d.on("data", (c) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
  sink.push(Buffer.from(JSON.stringify({ type: "tail", entries: ["x"] }) + "\n"));
  assert.deepEqual(await gotDelta, { type: "tail", entries: ["x"] });
  d.destroy();
});

test("XERK-781: a live channel to an owner with no live bridge hints relay-error", async () => {
  const [originConn, ownerConn] = await loopback();
  const owner = ownerRelay({ openLocal: async () => (await loopback())[0] }); // no openLive
  owner.accept(ownerConn);
  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
  });
  const d = await origin.connect("h1", 0, { kind: "live", session: "s" });
  const closed = new Promise((resolve) => d.on("close", resolve));
  const hint = await new Promise((resolve) => d.once("hint", resolve));
  assert.equal(hint.reason, "relay-error");
  await closed;
});

test("XERK-781: a mismatched auth token is refused (unauthorized hint), never bridged", async () => {
  const [originConn, ownerConn] = await loopback();
  let bridged = 0;
  const owner = ownerRelay({
    authToken: "correct-secret",
    openLocal: async () => { bridged++; return (await loopback())[0]; },
  });
  owner.accept(ownerConn);
  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
    authToken: "WRONG-secret",
  });
  const d = await origin.connect("h1", 7681);
  const closed = new Promise((resolve) => d.on("close", resolve));
  const hint = await new Promise((resolve) => d.once("hint", resolve));
  assert.equal(hint.reason, "unauthorized");
  assert.equal(bridged, 0, "a bad token never reaches the tunnel bridge");
  await closed;
});

test("XERK-781: a MATCHING auth token bridges normally", async () => {
  const [originConn, ownerConn] = await loopback();
  const [ownerAgentEnd, ttyd] = await loopback();
  ttyd.pipe(ttyd);
  const owner = ownerRelay({ authToken: "shared", openLocal: async () => ownerAgentEnd });
  owner.accept(ownerConn);
  const origin = makeRelay(null, "R-A", {
    owners: { h1: { replica: "R-owner", at: Date.now() } },
    ttlMs: 60000,
    localTunnel: () => false,
    dial: async () => originConn,
    authToken: "shared",
  });
  const d = await origin.connect("h1", 7681);
  const got = new Promise((resolve) => d.once("data", (c) => resolve(c.toString())));
  d.write(Buffer.from("hi"));
  assert.equal(await got, "hi", "a matching token lets the bytes through");
  d.destroy();
});

test("XERK-777: frameConn honours a clean CLOSE frame as readable EOF", async () => {
  const [a, b] = await loopback();
  const da = frameConn(a, { max: 1 << 20 });
  const db = frameConn(b, { max: 1 << 20 });
  const drained = readAll(db);
  da.write(Buffer.from("one"));
  da.end(); // -> a CLOSE frame -> db reads EOF
  assert.equal((await drained).toString(), "one");
  da.destroy();
  db.destroy();
});
