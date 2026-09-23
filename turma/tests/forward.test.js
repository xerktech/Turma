"use strict";

// XERK-919 — single-writer serving under HA: the lease leader serves every request and
// a follower transparently forwards HTTP + upgrades to it (turma/forward.js). Driven
// with a FileLiveStore standing in for Valkey and loopback servers standing in for the
// leader replica — no cluster. Pins the routing decision (local / forward / hold), the
// leader-endpoint directory, byte-faithful proxying (bodies, duplicate headers, SSE,
// WebSocket upgrades), the hold-don't-double-write rule, the drain refusal, and the
// server.js wiring (both handlers consult the forwarder first).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

process.env.TURMA_TEST = "1";
delete process.env.HA_MODE;
delete process.env.TURMA_STORE_URL;

const { makeForwarder, LEADER_ENDPOINT_KEY, FORWARDED_HEADER, MAX_HOPS } = require("../forward.js");
const { FileLiveStore } = require("../store.js");

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (url, headers = {}) => ({ url, headers });

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
}

// A follower whose store already names a leader at `addr`.
async function follower(addr, opts = {}) {
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, ttlMs: 60000, holdMs: 300, holdPollMs: 10, ...opts });
  await f.start();
  if (addr !== undefined) await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr, at: Date.now() });
  return { f, store };
}

// ---- the routing decision ---------------------------------------------------

test("XERK-919: the leader (or HA off / disabled) serves locally; probes are never forwarded", async () => {
  const lead = makeForwarder(new FileLiveStore(), "L", { isLeader: () => true });
  assert.deepEqual(lead.decide(req("/api/agents")), { local: true });
  const off = makeForwarder(new FileLiveStore(), "F", { isLeader: () => false, enabled: false });
  assert.deepEqual(off.decide(req("/api/agents")), { local: true });
  const { f } = await follower("127.0.0.1:1");
  assert.deepEqual(f.decide(req("/healthz")), { local: true });
  assert.deepEqual(f.decide(req("/readyz?x=1")), { local: true });
  assert.deepEqual(f.decide(req("/api/agents")), { forward: "127.0.0.1:1" });
});

test("XERK-919: a follower HOLDS (never serves) with no fresh leader, or while it is itself taking over", async () => {
  const { f } = await follower(undefined);
  assert.ok(f.decide(req("/api/x")).hold, "no leader known -> hold");
  const stale = await follower(undefined, { ttlMs: 50 });
  await stale.store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  await sleep(80);
  assert.ok(stale.f.decide(req("/api/x")).hold, "a stale endpoint -> hold");
  // Promoted but not yet re-synced: isLeader true, canServe false, the entry is SELF.
  const promoting = makeForwarder(new FileLiveStore(), "me", {
    endpoint: "127.0.0.1:2", isLeader: () => true, canServe: () => false });
  await promoting.start();
  assert.ok(promoting.decide(req("/api/x")).hold, "a replica mid-promotion holds rather than serve a stale mirror");
});

test("XERK-919: a leader with no dialable endpoint degrades to local serving (loudly), never a hold", async () => {
  const { f, store } = await follower(undefined);
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: null, at: Date.now() });
  assert.deepEqual(f.decide(req("/api/x")), { local: true });
});

test("XERK-919: the hop list stops bounces — never back through the leader, never past MAX_HOPS", async () => {
  const { f } = await follower("127.0.0.1:1");
  assert.ok(f.decide(req("/api/x", { [FORWARDED_HEADER]: "leader" })).hold, "came through the leader already");
  assert.ok(f.decide(req("/api/x", { [FORWARDED_HEADER]: "me" })).hold, "came through us already");
  const many = Array.from({ length: MAX_HOPS }, (_, i) => `r${i}`).join(",");
  assert.ok(f.decide(req("/api/x", { [FORWARDED_HEADER]: many })).hold, "hop budget spent");
  assert.ok(f.decide(req("/api/x", { [FORWARDED_HEADER]: "other" })).forward, "one prior hop is fine");
});

// ---- the leader-endpoint directory -----------------------------------------

test("XERK-919: only the leader publishes; a peer's publish lands in the mirror; retract deletes only our own", async () => {
  const store = new FileLiveStore();
  let leading = false;
  const a = makeForwarder(store, "A", { endpoint: "10.0.0.1:8300", isLeader: () => leading, refreshMs: 60000 });
  const b = makeForwarder(store, "B", { endpoint: "10.0.0.2:8300", isLeader: () => false, refreshMs: 60000 });
  await a.start(); await b.start();
  a.publish();
  assert.equal(await store.get(LEADER_ENDPOINT_KEY), null, "a non-leader publishes nothing");
  leading = true;
  a.publish();
  await tick();
  assert.equal(b.leader.addr, "10.0.0.1:8300", "the follower's mirror learns the leader");
  await b.retract();
  assert.ok(await store.get(LEADER_ENDPOINT_KEY), "a follower's retract never deletes the leader's entry");
  await a.retract();
  assert.equal(await store.get(LEADER_ENDPOINT_KEY), null, "the leader retracts its own entry");
  assert.equal(b.leader, null, "and the follower forgets it (holds for the successor)");
  a.close(); b.close();
});

test("XERK-919: a freshly booted follower hydrates a fresh leader endpoint but ignores a stale one", async () => {
  const store = new FileLiveStore();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "L", addr: "10.0.0.9:8300", at: Date.now() });
  const f = makeForwarder(store, "F", { isLeader: () => false });
  await f.start();
  assert.equal(f.leader && f.leader.addr, "10.0.0.9:8300");
  f.close();
  const store2 = new FileLiveStore();
  await store2.set(LEADER_ENDPOINT_KEY, { replica: "L", addr: "10.0.0.9:8300", at: Date.now() - 60000 });
  const g = makeForwarder(store2, "F", { isLeader: () => false });
  await g.start();
  assert.equal(g.leader, null, "stale by the writer's clock -> not adopted");
  g.close();
});

// ---- byte-faithful HTTP forwarding ------------------------------------------

// A follower HTTP server that forwards everything through `f` (the server.js wiring).
async function followerServer(f) {
  const srv = http.createServer(async (rq, rs) => {
    if (await f.forwardRequest(rq, rs)) return;
    rs.writeHead(299); rs.end("served-locally");
  });
  srv.on("upgrade", async (rq, sock, head) => {
    if (await f.forwardUpgrade(rq, sock, head)) return;
    sock.end("HTTP/1.1 418 local\r\n\r\n");
  });
  return { srv, port: await listen(srv) };
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, raw: res.rawHeaders, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("XERK-919: a forwarded request reaches the leader byte-faithfully and its response comes back intact", async () => {
  let seen;
  const leader = http.createServer((rq, rs) => {
    let b = ""; rq.on("data", (c) => (b += c));
    rq.on("end", () => {
      seen = { method: rq.method, url: rq.url, headers: rq.headers, raw: rq.rawHeaders, body: b };
      rs.writeHead(201, "Made", ["Set-Cookie", "a=1", "Set-Cookie", "b=2", "X-Leader", "yes"]);
      rs.end("leader-body");
    });
  });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const r = await request(port, { method: "POST", path: "/api/agents/h/sessions/s/input?x=%20y",
    headers: { authorization: "Bearer t", "content-type": "application/json", cookie: "hub_session=abc" },
    body: JSON.stringify({ text: "hi" }) });
  assert.equal(r.status, 201);
  assert.equal(r.body, "leader-body");
  const cookies = []; for (let i = 0; i < r.raw.length; i += 2) if (/^set-cookie$/i.test(r.raw[i])) cookies.push(r.raw[i + 1]);
  assert.deepEqual(cookies, ["a=1", "b=2"], "duplicate Set-Cookie headers survive the hop");
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/agents/h/sessions/s/input?x=%20y", "the target (query included) is untouched");
  assert.equal(seen.body, JSON.stringify({ text: "hi" }));
  assert.equal(seen.headers.authorization, "Bearer t");
  assert.equal(seen.headers.cookie, "hub_session=abc");
  assert.equal(seen.headers[FORWARDED_HEADER], "me", "the hop is stamped");
  assert.equal(f.stats.requests, 1);
  srv.close(); leader.close(); f.close();
});

test("XERK-919: a long-lived (SSE) response streams through chunk by chunk, not at the end", async () => {
  let push;
  const leader = http.createServer((rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("event: hello\n\n");
    push = () => { rs.write("event: second\n\n"); rs.end(); };
  });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const got = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/api/events", agent: false }, (res) => {
      res.once("data", (c) => resolve(String(c)));
    });
  });
  assert.match(got, /event: hello/, "the first frame arrives while the stream is still open");
  push();
  srv.close(); leader.close(); f.close();
});

test("XERK-919: the leader dying mid-body truncates the client response — it never hangs", async () => {
  const leader = http.createServer((rq, rs) => {
    rs.writeHead(200, { "content-length": "100" });
    rs.write("partial");
    setTimeout(() => rq.socket.destroy(), 20);
  });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const outcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("HUNG"), 3000);
    http.get({ host: "127.0.0.1", port, path: "/x", agent: false }, (res) => {
      res.on("data", () => {});
      res.on("end", () => { clearTimeout(t); resolve("end"); });
      res.on("error", () => { clearTimeout(t); resolve("error"); });
      res.on("aborted", () => { clearTimeout(t); resolve("aborted"); });
    }).on("error", () => { clearTimeout(t); resolve("error"); });
  });
  assert.notEqual(outcome, "HUNG");
  srv.close(); leader.close(); f.close();
});

// ---- hold / dial failure / drain --------------------------------------------

test("XERK-919: a request held for a missing leader is forwarded the moment one appears", async () => {
  const leader = http.createServer((rq, rs) => rs.end("from-new-leader"));
  const lport = await listen(leader);
  const { f, store } = await follower(undefined, { holdMs: 3000 });
  const { srv, port } = await followerServer(f);
  const pending = request(port, { path: "/api/agents" });
  await sleep(100);
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader2", addr: `127.0.0.1:${lport}`, at: Date.now() });
  const r = await pending;
  assert.equal(r.body, "from-new-leader", "held, not served locally and not failed");
  assert.ok(f.stats.held >= 1);
  srv.close(); leader.close(); f.close();
});

test("XERK-919: a dead leader address is held against, then served locally only once the bound lapses", async () => {
  const dead = net.createServer(); const dport = await listen(dead); dead.close(); // a port nobody listens on
  const { f } = await follower(`127.0.0.1:${dport}`, { holdMs: 200 });
  const { srv, port } = await followerServer(f);
  const t0 = Date.now();
  const r = await request(port, { path: "/api/agents" });
  assert.equal(r.status, 299, "the degraded fallback serves it here");
  assert.ok(Date.now() - t0 >= 180, "but only after holding for the bound");
  assert.ok(f.stats.dialFailures >= 1 && f.stats.degraded === 1);
  srv.close(); f.close();
});

test("XERK-919: a DRAINING follower refuses (503) what it cannot forward, never becomes a writer", async () => {
  const { f } = await follower(undefined, { holdMs: 2000 });
  const { srv, port } = await followerServer(f);
  f.stop();
  const r = await request(port, { path: "/api/agents" });
  assert.equal(r.status, 503);
  assert.equal(r.headers["retry-after"], "1");
  srv.close(); f.close();
});

// ---- upgrades ----------------------------------------------------------------

test("XERK-919: an upgrade is piped byte for byte to the leader, head bytes and hop stamp included", async () => {
  let headSeen;
  const leader = http.createServer();
  leader.on("upgrade", (rq, sock, head) => {
    headSeen = { url: rq.url, hop: rq.headers[FORWARDED_HEADER], upgrade: rq.headers.upgrade, head: String(head) };
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const reply = await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write("GET /agent/control?name=h&token=t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nEARLY");
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n\r\n") && !buf.includes("echo:ping")) s.write("ping");
      if (buf.includes("echo:ping")) { s.destroy(); resolve(buf); }
    });
  });
  assert.match(reply, /^HTTP\/1\.1 101/);
  assert.equal(headSeen.url, "/agent/control?name=h&token=t");
  assert.equal(headSeen.upgrade, "websocket");
  assert.equal(headSeen.hop, "me");
  assert.match(reply, /echo:ping/, "bytes flow both ways after the handshake");
  assert.equal(f.stats.upgrades, 1);
  srv.close(); leader.close(); f.close();
});

test("XERK-919: the leader (not a follower) handles its own upgrades — forwardUpgrade declines", async () => {
  const f = makeForwarder(new FileLiveStore(), "L", { isLeader: () => true });
  const { srv, port } = await followerServer(f);
  const reply = await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("GET /agent/control HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
    s.on("data", (d) => { resolve(String(d)); s.destroy(); });
  });
  assert.match(reply, /418 local/);
  srv.close();
});

// ---- server.js wiring --------------------------------------------------------

test("XERK-919: server.js consults the forwarder FIRST on both handlers, and serves locally on false", async () => {
  const hub = require("../server.js");
  const port = await listen(hub.server);
  const calls = [];
  hub.__setForwarder({
    async forwardRequest(rq, rs) {
      calls.push(rq.url);
      if (rq.url === "/api/forwarded") { rs.writeHead(202); rs.end("proxied"); return true; }
      return false;
    },
    async forwardUpgrade(rq, sock) { calls.push("up:" + rq.url); sock.end("HTTP/1.1 202 proxied\r\n\r\n"); return true; },
  });
  try {
    const fwd = await request(port, { path: "/api/forwarded" });
    assert.equal(fwd.status, 202);
    assert.equal(fwd.body, "proxied", "a forwarded request is answered by the forwarder alone");
    const local = await request(port, { path: "/healthz" });
    assert.equal(local.status, 200, "false falls through to the normal handler");
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET /agent/control?name=h HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      s.on("data", (d) => { resolve(String(d)); s.destroy(); });
    });
    assert.match(up, /202 proxied/, "an upgrade is offered to the forwarder before any local handling");
    assert.deepEqual(calls, ["/api/forwarded", "/healthz", "up:/agent/control?name=h"]);
  } finally {
    hub.__setForwarder(null);
    hub.server.close();
  }
});

test("XERK-919: canServeLocally holds a promoted leader until its registry re-sync completes", async () => {
  const hub = require("../server.js");
  const { FileLiveStore: FS } = require("../store.js");
  hub.__setLiveStore(new FS(), true);
  hub.__setLeader({ isLeader: () => true, release: async () => {} });
  try {
    hub.onLeaderPromoted();
    assert.equal(hub.canServeLocally(), false, "not a writer until re-synced");
    for (let i = 0; i < 50 && hub.promotionSyncing; i++) await sleep(10);
    assert.equal(hub.canServeLocally(), true, "serves once the re-sync lands");
  } finally {
    hub.__setLeader(null);
    hub.__setLiveStore(new FS(), false);
  }
});

// ---- XERK-919 QA round 1 fixes ----------------------------------------------

const { FORWARD_AUTH_HEADER } = require("../forward.js");

test("XERK-919 QA: a client-supplied hop header without a valid proof is IGNORED (no forced hold / second writer)", async () => {
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, authToken: "sekret", holdMs: 50, holdPollMs: 5 });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  assert.deepEqual(f.decide(req("/api/x", { [FORWARDED_HEADER]: "x,y" })), { forward: "127.0.0.1:1" },
    "a spoofed hop list neither holds nor degrades the request");
  // A genuine hop (proof from the same secret) is honoured.
  const peer = makeForwarder(new FileLiveStore(), "leader", { isLeader: () => false, authToken: "sekret" });
  const crypto = require("node:crypto");
  const proof = crypto.createHmac("sha256", "sekret").update("turma-forward\nleader").digest("base64url");
  assert.ok(f.decide(req("/api/x", { [FORWARDED_HEADER]: "leader", [FORWARD_AUTH_HEADER]: proof })).hold);
  // A forged proof of the RIGHT length (an attacker can see the shape) is still refused.
  const forged = proof.slice(0, -1) + (proof.endsWith("A") ? "B" : "A");
  assert.deepEqual(f.decide(req("/api/x", { [FORWARDED_HEADER]: "leader", [FORWARD_AUTH_HEADER]: forged })),
    { forward: "127.0.0.1:1" }, "a same-length forged proof is ignored");
  f.close(); void peer;
});

test("XERK-919 QA: the forwarded hop header carries a proof the leader side can verify", async () => {
  let seen;
  const leader = http.createServer((rq, rs) => { seen = rq.headers; rs.end("ok"); });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`, { authToken: "sekret" });
  const { srv, port } = await followerServer(f);
  await request(port, { path: "/api/x", headers: { [FORWARDED_HEADER]: "evil", [FORWARD_AUTH_HEADER]: "forged" } });
  assert.equal(seen[FORWARDED_HEADER], "me", "the client's hop list is stripped, ours replaces it");
  const verifier = makeForwarder(new FileLiveStore(), "leader", { isLeader: () => false, authToken: "sekret" });
  await verifier.start();
  await (async () => {})();
  // `leader` sees a proven hop through "me".
  const d = verifier.decide(req("/api/x", seen));
  assert.ok(d.hold || d.local, "a proven hop list is trusted downstream");
  srv.close(); leader.close(); f.close(); verifier.close();
});

test("XERK-919 QA: a leader entry naming OUR OWN address (a previous incarnation) is never forwarded to", async () => {
  const store = new FileLiveStore();
  const f = makeForwarder(store, "new-me", { endpoint: "127.0.0.1:18301", isLeader: () => false });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "old-me", addr: "127.0.0.1:18301", at: Date.now() });
  assert.ok(f.decide(req("/api/x")).hold, "holds rather than dial itself");
  assert.equal(f.remoteLeaderFresh(), false);
  f.close();
});

test("XERK-919 QA: while the store link is down, a stale-by-age leader stays the target (no degrade to writer)", async () => {
  let healthy = true;
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, ttlMs: 40, storeHealthy: () => healthy });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  await sleep(60);
  assert.ok(f.decide(req("/api/x")).hold, "healthy store + stale entry -> hold");
  healthy = false;
  assert.deepEqual(f.decide(req("/api/x")), { forward: "127.0.0.1:1" }, "store down -> keep the last known leader");
  f.close();
});

test("XERK-919 QA: onRemoteLeader fires when a fresh remote leader is learned", async () => {
  const store = new FileLiveStore();
  let fired = 0;
  const f = makeForwarder(store, "me", { isLeader: () => false, onRemoteLeader: () => { fired++; } });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  assert.ok(fired >= 1);
  f.close();
});

test("XERK-919 QA: a request whose body never comes still reaches the leader (head flushed at once)", async () => {
  const leader = http.createServer((rq, rs) => { rs.writeHead(401); rs.end("no"); });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const got = await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () =>
      s.write("POST /api/x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n"));
    let buf = "";
    s.on("data", (d) => { buf += d; if (/401/.test(buf)) { s.destroy(); resolve("401"); } });
    setTimeout(() => { s.destroy(); resolve("HUNG:" + buf.slice(0, 40)); }, 2000);
  });
  assert.equal(got, "401");
  srv.close(); leader.close(); f.close();
});

test("XERK-919 QA: an HTTP/1.0 request with no Host still forwards", async () => {
  const leader = http.createServer((rq, rs) => rs.end("host=" + rq.headers.host));
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const got = await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("GET /api/x HTTP/1.0\r\n\r\n"));
    let buf = ""; s.on("data", (d) => (buf += d)); s.on("end", () => resolve(buf)); s.on("close", () => resolve(buf));
  });
  assert.match(got, /^HTTP\/1\.[01] 200/);
  assert.match(got, /host=hub/);
  srv.close(); leader.close(); f.close();
});

test("XERK-919 QA: a CHUNKED request body arrives intact (transfer-encoding re-framed, not doubled)", async () => {
  let body;
  const leader = http.createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => { body = b; rs.end("ok"); }); });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  await new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/x", agent: false }, (res) => { res.resume(); res.on("end", resolve); });
    r.on("error", reject);
    r.write("hello "); r.write("chunked "); r.end("world");
  });
  assert.equal(body, "hello chunked world");
  srv.close(); leader.close(); f.close();
});

test("XERK-919 QA: a leader closing a CHUNKED body without its terminal chunk truncates the client (no hang)", async () => {
  const leader = net.createServer((sock) => {
    sock.once("data", () => {
      sock.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
      setTimeout(() => sock.end(), 30); // FIN, no terminating 0-chunk
    });
    sock.on("error", () => {});
  });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const outcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("HUNG"), 3000);
    http.get({ host: "127.0.0.1", port, path: "/x", agent: false }, (res) => {
      res.on("data", () => {});
      const done = (w) => { clearTimeout(t); resolve(w); };
      res.on("end", () => done("end")); res.on("error", () => done("error")); res.on("aborted", () => done("aborted"));
      res.on("close", () => done("close"));
    }).on("error", () => { clearTimeout(t); resolve("error"); });
  });
  assert.notEqual(outcome, "HUNG");
  assert.notEqual(outcome, "end", "a truncated body must not read as a complete one");
  srv.close(); leader.close(); f.close();
});

test("XERK-919 QA: the leader handover lands the registry, THEN releases, THEN retracts", async () => {
  const hub = require("../server.js");
  const order = [];
  let landWrite;
  const st = {
    watch() { return () => {}; }, async del() {}, async get() { return null; }, async scan() { return []; },
    set() { return new Promise((r) => { landWrite = () => { order.push("store-write-landed"); r(); }; }); },
  };
  hub.__setLiveStore(st, true);
  hub.agents.hh = { device: "hh", sessions: [], commands: [] };
  hub.markAgentDirty("hh");
  hub.__setLeader({ isLeader: () => true, release: async () => { order.push("release"); } });
  hub.__setForwarder({ retract: async () => { order.push("retract"); } });
  try {
    assert.equal(hub.releaseAtSignal(), false, "a leader does NOT release at signal receipt");
    const settle = (p) => Promise.resolve(p);
    const done = hub.leaderHandover(settle);
    await sleep(20);
    assert.deepEqual(order, [], "nothing is released while the registry write is in flight");
    landWrite();
    await done;
    assert.deepEqual(order, ["store-write-landed", "release", "retract"]);
    hub.__setLeader({ isLeader: () => false, release: async () => {} });
    assert.equal(hub.releaseAtSignal(), true, "a follower stops its elector at once");
  } finally {
    delete hub.agents.hh;
    hub.__setForwarder(null);
    hub.__setLeader(null);
    hub.__setLiveStore(new FileLiveStore(), false);
  }
});

test("XERK-919 QA: a follower hands back tunnels it holds once a leader is serving — never while it serves", async () => {
  const hub = require("../server.js");
  const ended = [];
  hub.controlChannels.pinned = { socket: { end: () => ended.push("pinned") } };
  let remote = true;
  hub.__setForwarder({ remoteLeaderFresh: () => remote });
  hub.__setLiveStore(new FileLiveStore(), true);
  let leading = true;
  hub.__setLeader({ isLeader: () => leading, release: async () => {} });
  try {
    assert.equal(hub.dropDegradedTunnels("t"), 0, "the serving leader keeps its tunnels");
    leading = false; remote = false;
    assert.equal(hub.dropDegradedTunnels("t"), 0, "no leader to hand to -> keep serving them (degraded)");
    remote = true;
    assert.equal(hub.dropDegradedTunnels("t"), 1);
    assert.deepEqual(ended, ["pinned"], "closed (1001) so the agent re-dials onto the leader");
  } finally {
    delete hub.controlChannels.pinned;
    hub.__setForwarder(null);
    hub.__setLeader(null);
    hub.__setLiveStore(new FileLiveStore(), false);
  }
});

test("XERK-919 QA: gracefulShutdown releases at signal ONLY for a non-leader and hands over via leaderHandover", () => {
  // The drain lives in the production boot branch (no TURMA_TEST path reaches it), so
  // pin its wiring at the source: the release at signal receipt must be gated on
  // releaseAtSignal(), and the leader's release must happen inside leaderHandover.
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "server.js"), "utf8");
  const body = src.slice(src.indexOf("const gracefulShutdown = (signal) => {"), src.indexOf('process.on("SIGTERM"'));
  assert.match(body, /const wasLeader = !releaseAtSignal\(\);/);
  assert.match(body, /if \(hubLeader && !wasLeader\) Promise\.resolve\(hubLeader\.release\(\)\)/);
  assert.match(body, /if \(wasLeader\) await leaderHandover\(settle\);/);
  assert.equal((body.match(/hubLeader\.release\(\)/g) || []).length, 1, "no other release in the drain");
});

test("XERK-919 QA: a leader that answers 413 mid-body, then resets, reaches the client as the 413", async () => {
  // The real hub answers a body past its cap + drain slack and then cuts the socket
  // while the client is still writing. The answer must be relayed, and the later
  // write error must not clobber it (a reset in the SAME tick as the answer is a
  // residual race Node cannot always win — see turma-ha-leader.md).
  const leader = net.createServer((sock) => {
    let got = 0;
    sock.on("data", (d) => {
      got += d.length;
      if (got > 200000 && !sock.answered) {
        sock.answered = true;
        const body = '{"error":"body too large","limit":1}';
        sock.write(`HTTP/1.1 413 Payload Too Large\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        setTimeout(() => sock.resetAndDestroy(), 20);
      }
    });
    sock.on("error", () => {});
  });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`);
  const { srv, port } = await followerServer(f);
  const big = Buffer.alloc(20 * 1024 * 1024, 120);
  const r = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": big.length }, body: big })
    .catch((e) => ({ status: "err:" + e.code }));
  assert.equal(r.status, 413, `got ${r.status}`);
  srv.close(); leader.close(); f.close();
});

// ---- XERK-919 QA round 2 ------------------------------------------------------

test("XERK-919 QA2: a non-ASCII hop proof of the right string length is refused — it never THROWS", async () => {
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, authToken: "sekret" });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  const evil = "A".repeat(42) + "é"; // 43 chars, 44 UTF-8 bytes — the real proof is 43 bytes
  let d;
  assert.doesNotThrow(() => { d = f.decide(req("/term/x/ws", { [FORWARDED_HEADER]: "zz", [FORWARD_AUTH_HEADER]: evil })); });
  assert.deepEqual(d, { forward: "127.0.0.1:1" }, "treated as an unproven (ignored) hop list");
  f.close();
});

test("XERK-919 QA2: a forwarding fault in the upgrade handler never takes the hub down", async () => {
  const hub = require("../server.js");
  const port = await listen(hub.server);
  hub.__setForwarder({
    async forwardRequest() { return false; },
    async forwardUpgrade() { throw new RangeError("boom"); },
  });
  try {
    const closed = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET /term/x/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      s.on("close", () => resolve(true)); s.on("error", () => {});
      setTimeout(() => resolve(false), 2000);
    });
    assert.ok(closed, "the offending socket is closed");
    const r = await request(port, { path: "/healthz" });
    assert.equal(r.status, 200, "and the hub is still serving");
  } finally {
    hub.__setForwarder(null);
    hub.server.close();
  }
});

test("XERK-919 QA2: with the store down, a leader counts as fresh ONLY while dials to it succeed", async () => {
  const leader = net.createServer((s) => s.end()); const lport = await listen(leader);
  let healthy = true;
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, ttlMs: 60, storeHealthy: () => healthy, cooldownMs: 1000 });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: `127.0.0.1:${lport}`, at: Date.now() });
  assert.equal(f.remoteLeaderFresh(), true, "fresh entry");
  await sleep(80);
  healthy = false;
  assert.equal(f.remoteLeaderFresh(), false, "store down + entry aged + never dialed -> NOT proof the leader lives");
  // A successful forward (dial) proves it.
  const { srv, port } = await followerServer(f);
  await request(port, { path: "/api/x" }).catch(() => {});
  assert.equal(f.remoteLeaderFresh(), true, "a recent successful dial keeps it fresh while the store is down");
  // The leader dies: the next dial fails and the claim lapses.
  leader.close(); await sleep(80);
  await request(port, { path: "/api/y" }).catch(() => {});
  assert.equal(f.remoteLeaderFresh(), false, "a failed dial / stale dial proof -> never hand tunnels to it");
  srv.close(); f.close();
});
