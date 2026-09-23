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
const req = (url, headers = {}, method = "GET") => ({ url, headers, method });

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

const { FORWARD_AUTH_HEADER, hopProof, PROOF_MAX_AGE_MS } = require("../forward.js");

test("XERK-919 QA: a client-supplied hop header without a valid proof is IGNORED (no forced hold / second writer)", async () => {
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, authToken: "sekret", holdMs: 50, holdPollMs: 5 });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  assert.deepEqual(f.decide(req("/api/x", { [FORWARDED_HEADER]: "x,y" })), { forward: "127.0.0.1:1" },
    "a spoofed hop list neither holds nor degrades the request");
  // A genuine hop (proof from the same secret) is honoured.
  const at = String(Date.now());
  const proof = `${at}.n1.${hopProof("sekret", "leader", "GET", "/api/x", at, "n1")}`;
  assert.ok(f.decide(req("/api/x", { [FORWARDED_HEADER]: "leader", [FORWARD_AUTH_HEADER]: proof })).hold);
  // A forged proof of the RIGHT length (an attacker can see the shape) is still refused.
  const forged = proof.slice(0, -1) + (proof.endsWith("A") ? "B" : "A");
  assert.deepEqual(f.decide(req("/api/x", { [FORWARDED_HEADER]: "leader", [FORWARD_AUTH_HEADER]: forged })),
    { forward: "127.0.0.1:1" }, "a same-length forged proof is ignored");
  f.close();
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

// ---- XERK-936: follower-side oversize refusal + request-bound hop proof ---------

// A leader that records every connection it gets (a follower must not dial it for a
// body it refuses itself) and answers 200 once it has the whole body.
async function countingLeader() {
  const seen = [];
  const leader = http.createServer((rq, rs) => {
    let n = 0;
    rq.on("data", (c) => { n += c.length; });
    rq.on("end", () => { seen.push({ url: rq.url, bytes: n }); rs.end("leader"); });
  });
  return { leader, seen, port: await listen(leader) };
}

// Post `size` bytes the way urllib does — the WHOLE body written before any read —
// over a raw socket, and report the status line it gets (or the socket error).
function postLikeUrllib(port, path, size) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    s.on("connect", () => {
      s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${size}\r\n\r\n`);
      s.end(Buffer.alloc(size, 120));
    });
    s.on("data", (d) => { got += d; });
    s.on("error", (e) => resolve(got ? got.split("\r\n")[0] : "err:" + e.code));
    s.on("close", () => resolve(got.split("\r\n")[0] || "closed"));
  });
}

test("XERK-936: a follower refuses a body DECLARED past cap + slack itself — 413, the leader never dialed", async () => {
  const { leader, seen, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, {
    bodyCap: (rq) => (rq.url === "/api/heartbeat" ? 1000 : 0), drainSlack: 64 << 10,
  });
  const { srv, port } = await followerServer(f);
  // Far past the cut, like QA's 37 MiB beat: urllib-style, never reads before writing.
  const line = await postLikeUrllib(port, "/api/heartbeat", 20 * 1024 * 1024);
  assert.match(line, / 413 /, `got ${line}`);
  // Inside the slack: still the LEADER's to answer (it drains to end and answers cleanly).
  const inside = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 5000 }, body: Buffer.alloc(5000) });
  assert.equal(inside.body, "leader");
  // A route with no cap (0) is forwarded however big.
  const other = await request(port, { method: "POST", path: "/api/other", headers: { "content-length": 200000 }, body: Buffer.alloc(200000) });
  assert.equal(other.body, "leader");
  assert.deepEqual(seen.map((x) => x.url), ["/api/heartbeat", "/api/other"], "the oversize beat never reached the leader");
  assert.equal(f.stats.refusedOversize, 1);
  srv.close(); leader.close(); f.close();
});

test("XERK-936: the 413 body matches the leader's generic refusal and the connection closes", async () => {
  const { leader, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, { bodyCap: () => 1000, drainSlack: 4000 });
  const { srv, port } = await followerServer(f);
  const r = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 6000 }, body: Buffer.alloc(6000) })
    .catch((e) => ({ status: "err:" + e.code }));
  assert.equal(r.status, 413, `got ${r.status}`);
  assert.deepEqual(JSON.parse(r.body), { error: "body too large", limit: 1000 });
  assert.equal(r.headers.connection, "close");
  srv.close(); leader.close(); f.close();
});

test("XERK-936: the leader (and HA off) never refuses in the forwarder — its own handler answers", async () => {
  for (const opts of [{ isLeader: () => true }, { enabled: false }]) {
    const f = makeForwarder(new FileLiveStore(), "me", { bodyCap: () => 10, drainSlack: 10, ...opts });
    await f.start();
    const { srv, port } = await followerServer(f);
    const r = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 5000 }, body: Buffer.alloc(5000) });
    assert.equal(r.status, 299, "served locally, untouched");
    assert.equal(f.stats.refusedOversize, 0);
    srv.close(); f.close();
  }
});

test("XERK-936: past drainMax concurrent refusals a follower forwards as before; a slot frees on close", async () => {
  const { leader, seen, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, { bodyCap: () => 100, drainSlack: 100, drainMax: 1 });
  const { srv, port } = await followerServer(f);
  // Hold one refusal open: declared huge, only a trickle sent.
  const hog = net.connect(port, "127.0.0.1");
  await new Promise((r) => hog.on("connect", r));
  hog.write("POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nContent-Length: 999999\r\n\r\nabc");
  hog.on("error", () => {});
  await sleep(50);
  assert.equal(f.stats.refusedOversize, 1);
  const r = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 500 }, body: Buffer.alloc(500) });
  assert.equal(r.body, "leader", "the slot is taken: forwarded, the leader decides");
  hog.destroy();
  await sleep(50);
  const again = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 500 }, body: Buffer.alloc(500) })
    .catch((e) => ({ status: "err:" + e.code }));
  assert.equal(again.status, 413, "the slot freed when the hog left");
  assert.equal(seen.length, 1);
  srv.close(); leader.close(); f.close();
});

test("XERK-936: server.js forwardBodyCap names each stateless-413 route's OWN cap, and 0 elsewhere", () => {
  const hub = require("../server.js");
  const cap = (method, url) => hub.forwardBodyCap({ method, url });
  assert.equal(cap("POST", "/api/heartbeat"), hub.HEARTBEAT_MAX);
  assert.equal(cap("POST", "/api/heartbeat?x=1"), hub.HEARTBEAT_MAX);
  assert.equal(cap("POST", "/api/agents/h/uploads?name=a"), hub.UPLOAD_MAX_BYTES);
  assert.equal(cap("POST", "/api/agents/h/sessions/s/uploads"), hub.UPLOAD_MAX_BYTES);
  assert.equal(cap("POST", "/api/agents/h/archive/t/raw/f"), hub.ARCHIVE_RAW_BODY_MAX);
  // The leader RECORDS these refusals, so a follower must not answer them alone.
  assert.equal(cap("POST", "/api/agents/h/archive/t"), 0);
  assert.equal(cap("POST", "/api/agents/h/migrations/m/blob"), 0);
  assert.equal(cap("GET", "/api/heartbeat"), 0);
  assert.equal(cap("POST", "/api/agents/h/sessions/s/input"), 0);
  assert.equal(cap("POST", "//["), 0, "an unparseable target never throws");
  // Drift pin: the routes still read with exactly those caps (and the upload cap is
  // still bounded by UPLOAD_MAX_BYTES), so the follower's number is the leader's.
  const src = require("node:fs").readFileSync(require.resolve("../server.js"), "utf8");
  assert.match(src, /readBody\(req, HEARTBEAT_MAX, /);
  assert.match(src, /readRawBody\(req, ARCHIVE_RAW_BODY_MAX\)/);
  assert.match(src, /return Math\.min\(reported, UPLOAD_MAX_BYTES\)/);
  assert.match(src, /bodyCap: forwardBodyCap,\s+drainSlack: RAW_BODY_DRAIN_SLACK,/);
  // ...and only past the auth gate the leader runs BEFORE reading the body (QA L1).
  assert.match(src, /agentPresentedRefusal\(req\) \? 0 : HEARTBEAT_MAX/);
  assert.match(src, /userAuthorized\(req\) \? UPLOAD_MAX_BYTES : 0/);
  assert.match(src, /agentHostRefusal\(req, claimed\) \? 0 : ARCHIVE_RAW_BODY_MAX/);
});

test("XERK-936: a hop proof is bound to its request — another method or target, a stale stamp, or a replay is ignored", async () => {
  const store = new FileLiveStore();
  const f = makeForwarder(store, "me", { isLeader: () => false, authToken: "sekret" });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: Date.now() });
  const FWD = { forward: "127.0.0.1:1" };
  const mint = (method, url, at = Date.now(), nonce = "n" + Math.random().toString(36).slice(2)) =>
    `${at}.${nonce}.${hopProof("sekret", "leader", method, url, String(at), nonce)}`;
  const hop = (auth) => ({ [FORWARDED_HEADER]: "leader", [FORWARD_AUTH_HEADER]: auth });
  // Minted for GET /api/a: honoured there, and only there.
  const p = mint("GET", "/api/a");
  assert.deepEqual(f.decide(req("/api/a", hop(mint("GET", "/api/a")), "GET")).hold !== undefined, true);
  assert.deepEqual(f.decide(req("/api/b", hop(p), "GET")), FWD, "another target");
  assert.deepEqual(f.decide(req("/api/a", hop(p), "POST")), FWD, "another method");
  // Stale (or far-future) stamps.
  assert.deepEqual(f.decide(req("/api/a", hop(mint("GET", "/api/a", Date.now() - PROOF_MAX_AGE_MS - 1000)))), FWD);
  assert.deepEqual(f.decide(req("/api/a", hop(mint("GET", "/api/a", Date.now() + PROOF_MAX_AGE_MS + 1000)))), FWD);
  assert.equal(f.stats.staleProofs, 2);
  // A tampered stamp breaks the mac.
  const fresh = mint("GET", "/api/a");
  assert.deepEqual(f.decide(req("/api/a", hop(String(Date.now() + 1) + fresh.slice(fresh.indexOf("."))))), FWD);
  // One-shot: the same header on a SECOND request is a replay, ignored.
  const once = mint("GET", "/api/a");
  const first = req("/api/a", hop(once));
  assert.ok(f.decide(first).hold, "first sighting honoured");
  assert.ok(f.decide(first).hold, "re-deciding the SAME request (a hold poll) is not a replay");
  assert.deepEqual(f.decide(req("/api/a", hop(once))), FWD, "a replayed pair is ignored");
  assert.equal(f.stats.replayedProofs, 1);
  // Malformed shapes (the XERK-919 bare-mac form included) are ignored, never thrown on.
  for (const bad of [hopProof("sekret", "leader", "GET", "/api/a", "", ""), "1.2", "x.y.z", "1.n.m.extra", "1.é.m"]) {
    assert.deepEqual(f.decide(req("/api/a", hop(bad))), FWD, bad);
  }
  f.close();
});

test("XERK-936: a proof minted by a forwarding follower verifies on the next replica for that request only", async () => {
  let seen;
  const next = http.createServer((rq, rs) => { seen = { headers: rq.headers, url: rq.url, method: rq.method }; rs.end("ok"); });
  const nport = await listen(next);
  const { f } = await follower(`127.0.0.1:${nport}`, { authToken: "sekret" });
  const { srv, port } = await followerServer(f);
  await request(port, { method: "POST", path: "/api/x?q=1", headers: { "content-length": 2 }, body: "{}" });
  // The next replica believes "me" leads: a PROVEN hop through "me" must hold there
  // (never bounce back), an unproven one is just forwarded.
  const vstore = new FileLiveStore();
  const verifier = makeForwarder(vstore, "leader", { isLeader: () => false, authToken: "sekret" });
  await verifier.start();
  await vstore.set(LEADER_ENDPOINT_KEY, { replica: "me", addr: "127.0.0.1:1", at: Date.now() });
  assert.match(seen.headers[FORWARD_AUTH_HEADER], /^\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(seen.url, "/api/x?q=1");
  assert.deepEqual(verifier.decide({ ...seen, url: "/api/y" }), { forward: "127.0.0.1:1" },
    "the same headers on another target are not a proven hop");
  assert.deepEqual(verifier.decide({ ...seen }), { hold: "the request already passed through the leader" },
    "the minted proof verifies for its own request");
  srv.close(); next.close(); f.close(); verifier.close();
});

// ---- XERK-936 QA round 1 ------------------------------------------------------

test("XERK-936 QA: a pair a follower MINTED is never honoured back on that follower (the one place a replay bites)", async () => {
  let seen;
  const leader = http.createServer((rq, rs) => { seen = { headers: rq.headers, url: rq.url, method: rq.method }; rs.end("ok"); });
  const lport = await listen(leader);
  const { f } = await follower(`127.0.0.1:${lport}`, { authToken: "sekret" });
  const { srv, port } = await followerServer(f);
  await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 2 }, body: "{}" });
  // Replayed onto the minter: its own id is in the list, so honoured it would HOLD
  // and then serve DEGRADED. It must read as a replay — forwarded like any request.
  assert.deepEqual(f.decide({ ...seen }), { forward: `127.0.0.1:${lport}` });
  assert.equal(f.stats.replayedProofs, 1);
  // Stateless: a flood of forwards (each minting a proof) cannot age it out of any cache.
  for (let i = 0; i < 30; i++) await request(port, { path: "/api/y" + i });
  assert.deepEqual(f.decide({ ...seen }), { forward: `127.0.0.1:${lport}` }, "still ignored after a flood");
  srv.close(); leader.close(); f.close();
});

test("XERK-936 QA2: the seen-proof set fails CLOSED when full of fresh nonces — it never evicts a live one", async () => {
  const store = new FileLiveStore();
  let t = Date.now();
  const f = makeForwarder(store, "me", { isLeader: () => false, authToken: "sekret", now: () => t });
  await f.start();
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: t });
  const mint = (nonce) => `${t}.${nonce}.${hopProof("sekret", "leader", "GET", "/a", String(t), nonce)}`;
  const hop = (nonce) => req("/a", { [FORWARDED_HEADER]: "leader", [FORWARD_AUTH_HEADER]: mint(nonce) });
  assert.ok(f.decide(hop("first")).hold, "honoured once");
  for (let i = 0; i < 10000; i++) f.decide(hop("n" + i)); // fill (only possible with the key)
  assert.deepEqual(f.decide(hop("first")), { forward: "127.0.0.1:1" }, "the first nonce was NOT evicted");
  assert.equal(f.decide(hop("fresh")).hold, undefined, "full of fresh entries: a new proof is refused");
  t += PROOF_MAX_AGE_MS + 1;
  await store.set(LEADER_ENDPOINT_KEY, { replica: "leader", addr: "127.0.0.1:1", at: t });
  assert.ok(f.decide(hop("later")).hold, "once they expire, room again");
  f.close();
});

test("XERK-936 QA: the follower cuts a refused body at cap + slack exactly — never drains without bound", async () => {
  const { leader, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, { bodyCap: () => 1000, drainSlack: 4000 });
  const { srv, port } = await followerServer(f);
  let read = 0;
  srv.on("request", (rq) => rq.on("data", (c) => { read += c.length; }));
  // Declared huge, sent in small paced writes: the answer must come after ~5000 bytes.
  const s = net.connect(port, "127.0.0.1");
  let got = "";
  let sent = 0;
  s.on("data", (d) => { got += d; });
  s.on("error", () => {});
  await new Promise((r) => s.on("connect", r));
  s.write("POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nContent-Length: 10000000\r\n\r\n");
  while (!got && sent < 100000) { s.write(Buffer.alloc(500)); sent += 500; await sleep(2); }
  assert.match(got, /^HTTP\/1\.1 413 /);
  assert.ok(sent > 5000 && sent <= 8000, `answered after ${sent} bytes sent`);
  await sleep(50);
  assert.ok(s.destroyed || s.readyState !== "open", "the connection is cut");
  s.destroy(); srv.close(); leader.close(); f.close();
});

test("XERK-936 QA: exactly cap + slack declared is still the leader's; one byte more is refused here", async () => {
  const { leader, seen, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, { bodyCap: () => 1000, drainSlack: 4000 });
  const { srv, port } = await followerServer(f);
  const at = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 5000 }, body: Buffer.alloc(5000) });
  assert.equal(at.body, "leader");
  const over = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 5001 }, body: Buffer.alloc(5001) })
    .catch((e) => ({ status: "err:" + e.code }));
  assert.equal(over.status, 413);
  assert.equal(seen.length, 1);
  srv.close(); leader.close(); f.close();
});

test("XERK-936 QA: a refusal whose client goes silent is cut after drainIdleMs and frees its slot", async () => {
  const { leader, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, { bodyCap: () => 100, drainSlack: 100, drainMax: 1, drainIdleMs: 80 });
  const { srv, port } = await followerServer(f);
  const hog = net.connect(port, "127.0.0.1");
  hog.on("error", () => {});
  const closed = new Promise((r) => hog.on("close", r));
  await new Promise((r) => hog.on("connect", r));
  // Headers only — not one body byte, so the idle timer must be armed up front.
  hog.write("POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nContent-Length: 999999\r\n\r\n");
  assert.equal(await Promise.race([closed.then(() => "cut"), sleep(3000).then(() => "open")]), "cut",
    "the follower cut it for going silent");
  const r = await request(port, { method: "POST", path: "/api/heartbeat", headers: { "content-length": 500 }, body: Buffer.alloc(500) })
    .catch((e) => ({ status: "err:" + e.code }));
  assert.equal(r.status, 413, "the slot is free again");
  srv.close(); leader.close(); f.close();
});

test("XERK-936 QA2: a refusal that keeps making progress is never cut idle; a 1-byte trickle is", async () => {
  const { leader, port: lport } = await countingLeader();
  const { f } = await follower(`127.0.0.1:${lport}`, {
    bodyCap: () => 100, drainSlack: 1 << 20, drainIdleMs: 150, drainMinProgress: 1000,
  });
  const { srv, port } = await followerServer(f);
  const open = (chunk, every) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("error", () => {});
    s.closed2 = new Promise((r) => s.on("close", r));
    s.on("connect", () => {
      s.write("POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nContent-Length: 9999999\r\n\r\n");
      s.timer = setInterval(() => { if (!s.destroyed) s.write(Buffer.alloc(chunk)); }, every);
    });
    return s;
  };
  const steady = open(2000, 40); // well past drainMinProgress per window
  const trickle = open(1, 40); // ~4 bytes per window: idle
  const race = (s) => Promise.race([s.closed2.then(() => "cut"), sleep(600).then(() => "open")]);
  assert.equal(await race(trickle), "cut", "a trickle is cut idle");
  assert.equal(await race(steady), "open", "steady progress keeps the refusal alive past drainIdleMs");
  for (const s of [steady, trickle]) { clearInterval(s.timer); s.destroy(); }
  srv.close(); leader.close(); f.close();
});
