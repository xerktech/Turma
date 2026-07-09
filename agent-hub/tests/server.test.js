// Unit tests for agent-hub/server.js using node:test (built-in — keeps the
// repo's zero-npm-dependency stance). CI runs them in a throwaway
// node:24-alpine container: `node --test agent-hub/tests/`.
//
// AGENTHUB_TEST makes server.js export its internals instead of binding the
// production port; the HTTP tests listen on an ephemeral port themselves.
// notify()'s outbound ntfy POST is captured by stubbing globalThis.fetch, so
// the alert tests observe exactly which notifications each beat fires.

"use strict";

const os = require("os");
const path = require("path");
const http = require("http");
const { EventEmitter } = require("events");
const test = require("node:test");
const assert = require("node:assert/strict");

// Environment must be pinned BEFORE the module under test loads.
process.env.AGENTHUB_TEST = "1";
process.env.HUB_USER = "hubuser";
process.env.HUB_PASSWORD = "hubpass";
process.env.HUB_AGENT_TOKEN = "agenttok";
process.env.NTFY_URL = "http://ntfy.test"; // enables notify(); fetch is stubbed
process.env.COST_ALERT_USD = "50";
process.env.STATE_FILE = path.join(
  os.tmpdir(),
  `agenthub-test-state-${process.pid}.json`
);

// Capture ntfy pushes synchronously (notify() calls global fetch).
const notifications = [];
globalThis.fetch = (url, opts) => {
  notifications.push({ url, title: opts.headers.Title, body: opts.body, headers: opts.headers });
  return Promise.resolve({ ok: true });
};
const titles = () => notifications.map((n) => n.title);

const hub = require("../server.js");
const {
  server, agents, queueCommand, findSession,
  wsAccept, wsEncode, wsParser, channelDuplex,
  heartbeatAlerts, sessionWorking,
  userAuthorized, agentAuthorized, agentWsAuthorized, fmtDur,
  credentialsMatch, issueSessionToken, sessionTokenValid,
} = hub;

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

// ---- RFC 6455 framing --------------------------------------------------------

function parseAll(chunks) {
  const frames = [];
  const parse = wsParser((op, payload) => frames.push({ op, payload }));
  for (const c of chunks) parse(c);
  return frames;
}

// Build a client-style MASKED frame (what the agent, a WS client, sends us).
function maskedFrame(opcode, payload, mask = Buffer.from([0x12, 0x34, 0x56, 0x78])) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

test("wsEncode/wsParser round-trip across the three length encodings", () => {
  // 0/125 -> 7-bit, 126/65535 -> 16-bit, 65536+ -> 64-bit length field.
  for (const size of [0, 1, 125, 126, 300, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, 0xab);
    const frames = parseAll([wsEncode(0x2, payload)]);
    assert.equal(frames.length, 1, `size ${size}`);
    assert.equal(frames[0].op, 0x2);
    assert.ok(frames[0].payload.equals(payload), `payload mismatch at ${size}`);
  }
});

test("wsEncode picks the correct header size per length", () => {
  assert.equal(wsEncode(0x2, Buffer.alloc(125)).length, 2 + 125);
  assert.equal(wsEncode(0x2, Buffer.alloc(126)).length, 4 + 126);
  assert.equal(wsEncode(0x2, Buffer.alloc(65536)).length, 10 + 65536);
});

test("wsParser unmasks client frames (7/16/64-bit lengths)", () => {
  for (const size of [5, 200, 70000]) {
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = i & 0xff;
    const frames = parseAll([maskedFrame(0x2, payload)]);
    assert.equal(frames.length, 1);
    assert.ok(frames[0].payload.equals(payload), `unmask failed at ${size}`);
  }
});

test("wsParser handles byte-by-byte chunked delivery", () => {
  const payload = Buffer.from("hello, split frame");
  const wire = maskedFrame(0x1, payload);
  const chunks = [];
  for (let i = 0; i < wire.length; i++) chunks.push(wire.subarray(i, i + 1));
  const frames = parseAll(chunks);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].op, 0x1);
  assert.ok(frames[0].payload.equals(payload));
});

test("wsParser handles multiple frames coalesced into one chunk", () => {
  const wire = Buffer.concat([
    wsEncode(0x1, "first"),
    maskedFrame(0x2, Buffer.from("second")),
    wsEncode(0x9, Buffer.alloc(0)), // ping
  ]);
  const frames = parseAll([wire]);
  assert.deepEqual(
    frames.map((f) => [f.op, f.payload.toString()]),
    [[0x1, "first"], [0x2, "second"], [0x9, ""]]
  );
});

test("wsParser waits for a frame split across the header boundary", () => {
  const wire = wsEncode(0x2, Buffer.alloc(300, 7)); // 16-bit length header
  const frames = [];
  const parse = wsParser((op, payload) => frames.push({ op, payload }));
  parse(wire.subarray(0, 3)); // header incomplete
  assert.equal(frames.length, 0);
  parse(wire.subarray(3));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 300);
});

test("wsAccept derives the RFC 6455 handshake key", () => {
  // Example straight from RFC 6455 section 1.3.
  assert.equal(wsAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

// ---- channelDuplex -----------------------------------------------------------

function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.ended = false;
  s.destroyed = false;
  s.write = (buf) => { s.written.push(Buffer.from(buf)); return true; };
  s.end = () => { s.ended = true; };
  s.destroy = () => { s.destroyed = true; };
  return s;
}

test("channelDuplex: writes become binary frames; agent frames become reads", async () => {
  const socket = fakeSocket();
  const d = channelDuplex(socket);
  const reads = [];
  d.on("data", (c) => reads.push(c));

  d.write(Buffer.from("to-agent"));
  assert.equal(socket.written.length, 1);
  assert.ok(socket.written[0].equals(wsEncode(0x2, Buffer.from("to-agent"))));

  socket.emit("data", maskedFrame(0x2, Buffer.from("from-agent")));
  await new Promise((r) => setImmediate(r));
  assert.equal(Buffer.concat(reads).toString(), "from-agent");
});

test("channelDuplex: ping answered with pong, close ends the stream", async () => {
  const socket = fakeSocket();
  const d = channelDuplex(socket);
  d.resume();
  const ended = new Promise((r) => d.on("end", r));

  socket.emit("data", maskedFrame(0x9, Buffer.from("beat")));
  const pong = socket.written.find((b) => (b[0] & 0x0f) === 0xa);
  assert.ok(pong, "no pong written");
  assert.ok(pong.equals(wsEncode(0xa, Buffer.from("beat"))));

  socket.emit("data", maskedFrame(0x8, Buffer.alloc(0)));
  await ended;
  assert.equal(socket.ended, true);
});

test("channelDuplex: ending the hub side sends a close frame", async () => {
  const socket = fakeSocket();
  const d = channelDuplex(socket);
  await new Promise((r) => d.end(r));
  const close = socket.written.find((b) => (b[0] & 0x0f) === 0x8);
  assert.ok(close, "no close frame written");
});

// ---- auth matrix --------------------------------------------------------------

test("userAuthorized: basic-auth matrix", () => {
  const req = (h) => ({ headers: h });
  assert.equal(userAuthorized(req({ authorization: basic("hubuser", "hubpass") })), true);
  assert.equal(userAuthorized(req({ authorization: basic("hubuser", "WRONG") })), false);
  assert.equal(userAuthorized(req({ authorization: basic("WRONG", "hubpass") })), false);
  assert.equal(userAuthorized(req({})), false);
  assert.equal(userAuthorized(req({ authorization: "Bearer agenttok" })), false);
  // Malformed base64 payload without a colon.
  assert.equal(
    userAuthorized(req({ authorization: "Basic " + Buffer.from("nocolon").toString("base64") })),
    false
  );
});

test("credentialsMatch: constant-time single-user check", () => {
  assert.equal(credentialsMatch("hubuser", "hubpass"), true);
  assert.equal(credentialsMatch("hubuser", "nope"), false);
  assert.equal(credentialsMatch("nope", "hubpass"), false);
  assert.equal(credentialsMatch(undefined, undefined), false);
});

test("session tokens: issue -> valid; tampered/expired/garbage -> invalid", () => {
  const tok = issueSessionToken();
  assert.equal(sessionTokenValid(tok), true);
  assert.equal(sessionTokenValid(""), false);
  assert.equal(sessionTokenValid("nodot"), false);
  assert.equal(sessionTokenValid("123.deadbeef"), false); // bad HMAC
  // Forged far-future expiry keeps the original signature -> rejected.
  const forged = `${Date.now() + 1e12}.${tok.slice(tok.indexOf(".") + 1)}`;
  assert.equal(sessionTokenValid(forged), false);
  // A correctly-signed but already-expired token is rejected.
  const past = "1.".concat(
    require("crypto").createHmac("sha256",
      process.env.HUB_SESSION_SECRET ||
        require("crypto").createHash("sha256").update("hubuser\nhubpass").digest("hex"))
      .update("1").digest("base64url")
  );
  assert.equal(sessionTokenValid(past), false);
});

test("userAuthorized: accepts a valid session cookie", () => {
  const tok = issueSessionToken();
  assert.equal(userAuthorized({ headers: { cookie: `hub_session=${tok}` } }), true);
  assert.equal(userAuthorized({ headers: { cookie: `hub_session=${tok}x` } }), false);
  assert.equal(userAuthorized({ headers: { cookie: "other=1; hub_session=" + tok } }), true);
});

test("agentAuthorized: bearer token, with user-credential fallback", () => {
  const req = (h) => ({ headers: h });
  assert.equal(agentAuthorized(req({ authorization: "Bearer agenttok" })), true);
  assert.equal(agentAuthorized(req({ authorization: "Bearer nope" })), false);
  assert.equal(agentAuthorized(req({})), false);
  // The single-user basic login may also exercise the heartbeat endpoint.
  assert.equal(agentAuthorized(req({ authorization: basic("hubuser", "hubpass") })), true);
  assert.equal(agentAuthorized(req({ authorization: basic("hubuser", "WRONG") })), false);
});

test("agentWsAuthorized: query token first, header fallback", () => {
  const req = (h) => ({ headers: h });
  assert.equal(agentWsAuthorized(new URL("http://x/agent/control?token=agenttok"), req({})), true);
  assert.equal(agentWsAuthorized(new URL("http://x/agent/control?token=bad"), req({})), false);
  assert.equal(
    agentWsAuthorized(new URL("http://x/agent/control"), req({ authorization: "Bearer agenttok" })),
    true
  );
  assert.equal(agentWsAuthorized(new URL("http://x/agent/control"), req({})), false);
});

// ---- small helpers -------------------------------------------------------------

test("fmtDur buckets", () => {
  assert.equal(fmtDur(30 * 1000), "30s");
  assert.equal(fmtDur(120 * 1000), "2m");
  assert.equal(fmtDur(2 * 3600 * 1000), "2h");
});

test("sessionWorking: transcript freshness plus heartbeat staleness", () => {
  const now = Date.now();
  assert.equal(sessionWorking({ session: null }, now, now), false);
  assert.equal(sessionWorking({ session: {} }, now, now), false); // age null
  assert.equal(sessionWorking({ session: { transcriptAgeSec: 0 } }, now, now), true);
  assert.equal(sessionWorking({ session: { transcriptAgeSec: 300 } }, now, now), false);
  // Fresh at beat time, but the beat itself is stale -> not working.
  assert.equal(sessionWorking({ session: { transcriptAgeSec: 0 } }, now - 120000, now), false);
});

// ---- heartbeatAlerts (edge-triggered) ------------------------------------------

// Drives a beat sequence the way the heartbeat handler does: alerts
// bookkeeping is carried (and would be persisted) across beats.
function makeHost() {
  const alerts = {};
  let prev = {};
  return (payload, at = Date.now()) => {
    const next = { ...payload, lastSeen: at, alerts };
    heartbeatAlerts("host1", prev, next);
    prev = next;
    return next;
  };
}

test("alerts: offline recovery fires once and clears the marker", () => {
  const beat = makeHost();
  const now = Date.now();
  const first = beat({ device: "truenas" }, now); // establish state
  first.alerts.offlineAt = now - 5 * 60 * 1000;   // sweep marked it offline
  notifications.length = 0;
  beat({ device: "truenas" }, now + 1000);
  assert.deepEqual(titles(), ["host1 back online"]);
  notifications.length = 0;
  beat({ device: "truenas" }, now + 2000); // no re-fire
  assert.deepEqual(titles(), []);
});

test("alerts: restart loop needs 3 boots in 10m, then holds off 30m", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  beat({ startedAt: "boot-1" }, t0);
  beat({ startedAt: "boot-2" }, t0 + 60 * 1000);
  assert.deepEqual(titles(), []); // two boots: still quiet
  beat({ startedAt: "boot-3" }, t0 + 120 * 1000);
  assert.deepEqual(titles(), ["host1 restart loop"]);
  assert.equal(notifications[0].headers.Priority, "urgent");
  notifications.length = 0;
  beat({ startedAt: "boot-4" }, t0 + 180 * 1000); // inside the 30m holdoff
  assert.deepEqual(titles(), []);
});

test("alerts: daily cost threshold sums sessions, fires once per day", () => {
  const beat = makeHost();
  const sessions = [
    { id: "s1", usage: { today: { cost: 30 } } },
    { id: "s2", usage: { today: { cost: 25 } } }, // 55 >= threshold 50
  ];
  notifications.length = 0;
  beat({ sessions });
  assert.deepEqual(titles(), ["host1 cost alert"]);
  assert.match(notifications[0].body, /\$55\.00/);
  notifications.length = 0;
  beat({ sessions }); // same UTC day: no re-fire
  assert.deepEqual(titles(), []);
});

test("alerts: question fires on new text only, re-arms when cleared", () => {
  const beat = makeHost();
  const withQ = (q) => ({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", session: q ? { question: q } : {} }],
  });
  notifications.length = 0;
  beat(withQ("Deploy to prod?"));
  assert.deepEqual(titles(), ["nas-repo-s1 has a question"]);
  notifications.length = 0;
  beat(withQ("Deploy to prod?")); // same question still pending: quiet
  assert.deepEqual(titles(), []);
  beat(withQ("Which branch?")); // different question: fires
  assert.deepEqual(titles(), ["nas-repo-s1 has a question"]);
  notifications.length = 0;
  beat(withQ(null)); // answered
  beat(withQ("Deploy to prod?")); // same text as before, but re-armed
  assert.deepEqual(titles(), ["nas-repo-s1 has a question"]);
});

test("alerts: PR created fires once per URL (persisted prSeen)", () => {
  const beat = makeHost();
  const url = "https://github.com/xerktech/AgentHub/pull/34";
  const withPrs = (urls) => ({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", session: { newPrUrls: urls } }],
  });
  notifications.length = 0;
  beat(withPrs([url]));
  assert.deepEqual(titles(), ["nas-repo-s1 created a PR"]);
  assert.equal(notifications[0].headers.Click, url);
  notifications.length = 0;
  beat(withPrs([url])); // agent re-delivered it: still only once
  assert.deepEqual(titles(), []);
  beat(withPrs(["https://github.com/xerktech/AgentHub/pull/35"]));
  assert.deepEqual(titles(), ["nas-repo-s1 created a PR"]);
});

test("alerts: turn finished fires on the working->idle edge only", () => {
  const beat = makeHost();
  const sess = (ageSec, extra = {}) => ({
    sessions: [{
      id: "s1", rcName: "nas-repo-s1",
      session: { transcriptAgeSec: ageSec, lastRole: "assistant", lastHasToolUse: false, ...extra },
    }],
  });
  const now = Date.now();
  notifications.length = 0;
  beat(sess(0), now); // working
  assert.deepEqual(titles(), []);
  beat(sess(600), now + 20000); // went idle, plain assistant output
  assert.deepEqual(titles(), ["nas-repo-s1 finished its turn"]);
  notifications.length = 0;
  beat(sess(620), now + 40000); // stays idle: edge already fired
  assert.deepEqual(titles(), []);
});

test("alerts: no turn-finished when idle entry is a pending tool call", () => {
  const beat = makeHost();
  const now = Date.now();
  notifications.length = 0;
  beat({ sessions: [{ id: "s1", session: { transcriptAgeSec: 0 } }] }, now);
  beat({
    sessions: [{
      id: "s1",
      session: { transcriptAgeSec: 600, lastRole: "assistant", lastHasToolUse: true },
    }],
  }, now + 20000);
  assert.deepEqual(titles(), []);
});

test("alerts: recovery beat suppresses the stale turn-finished edge", () => {
  const beat = makeHost();
  const now = Date.now();
  notifications.length = 0;
  const st = beat({ sessions: [{ id: "s1", session: { transcriptAgeSec: 0 } }] }, now);
  st.alerts.offlineAt = now; // host went offline mid-turn
  beat({
    sessions: [{
      id: "s1",
      session: { transcriptAgeSec: 600, lastRole: "assistant", lastHasToolUse: false },
    }],
  }, now + 20000);
  assert.deepEqual(titles(), ["host1 back online"]); // only the recovery
});

test("alerts: bookkeeping for vanished sessions is dropped", () => {
  const beat = makeHost();
  const st1 = beat({ sessions: [{ id: "s1", session: { question: "Q?" } }] });
  assert.ok(st1.alerts.sessions.s1);
  const st2 = beat({ sessions: [] }); // session deleted host-side
  assert.equal(st2.alerts.sessions.s1, undefined);
});

// ---- HTTP: heartbeat handler, command-queue ack filtering, route auth ----------

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function request(method, pathName, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathName, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const agentHeaders = { authorization: "Bearer agenttok", "content-type": "application/json" };
const userHeaders = { authorization: basic("hubuser", "hubpass") };

test("http: /healthz is unauthenticated; everything else is gated", async () => {
  assert.equal((await request("GET", "/healthz")).status, 200);
  assert.equal((await request("GET", "/api/agents")).status, 401);
  assert.equal(
    (await request("GET", "/api/agents", { headers: { authorization: basic("hubuser", "bad") } })).status,
    401
  );
  assert.equal((await request("GET", "/api/agents", { headers: userHeaders })).status, 200);
  // Agent bearer token does NOT unlock the browser API.
  assert.equal((await request("GET", "/api/agents", { headers: agentHeaders })).status, 401);
});

test("http: heartbeat auth (bearer or user basic, nothing else)", async () => {
  const beat = { device: "auth-host" };
  assert.equal((await request("POST", "/api/heartbeat", { body: beat })).status, 401);
  assert.equal(
    (await request("POST", "/api/heartbeat", { body: beat, headers: { authorization: "Bearer bad" } })).status,
    401
  );
  assert.equal((await request("POST", "/api/heartbeat", { body: beat, headers: agentHeaders })).status, 200);
  assert.equal((await request("POST", "/api/heartbeat", { body: beat, headers: userHeaders })).status, 200);
  assert.equal(
    (await request("POST", "/api/heartbeat", { body: {}, headers: agentHeaders })).status,
    400 // device/agentId required
  );
});

test("http: login page is public; /api/login sets a working session cookie", async () => {
  // The login form itself needs no auth.
  const page = await request("GET", "/login");
  assert.equal(page.status, 200);
  assert.match(page.raw, /Sign in/);

  // Wrong credentials are rejected without a cookie.
  const bad = await request("POST", "/api/login", { body: { username: "hubuser", password: "nope" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);

  // Correct credentials mint an HttpOnly session cookie...
  const ok = await request("POST", "/api/login", { body: { username: "hubuser", password: "hubpass" } });
  assert.equal(ok.status, 200);
  const setCookie = (ok.headers["set-cookie"] || [])[0] || "";
  assert.match(setCookie, /^hub_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  // ...that unlocks the browser API on its own (no Basic header).
  const cookie = setCookie.split(";")[0];
  assert.equal((await request("GET", "/api/agents", { headers: { cookie } })).status, 200);

  // Logout clears the cookie (Max-Age=0) and revokes access.
  const out = await request("POST", "/api/logout", { headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match((out.headers["set-cookie"] || [])[0] || "", /Max-Age=0/);
});

test("http: unauthenticated HTML navigation redirects to /login (no Basic popup)", async () => {
  const res = await request("GET", "/", { headers: { accept: "text/html" } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login");
  // No WWW-Authenticate header -> the browser never raises its native prompt.
  assert.equal(res.headers["www-authenticate"], undefined);
  // A deep link carries a next= so login can bounce back to it.
  const deep = await request("GET", "/sessions", { headers: { accept: "text/html" } });
  assert.equal(deep.headers.location, "/login?next=%2Fsessions");
});

test("http: command queue rides the reply until acked", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });

  // Register the host; queue is empty at first.
  let res = await beat({ device: "h1" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { commands: [] });

  // The UI queues two session commands (as the /api/agents/... routes do).
  const spawnRes = await request("POST", "/api/agents/h1/sessions", {
    body: { repo: "AgentHub" }, headers: userHeaders,
  });
  assert.equal(spawnRes.status, 200);
  const killRes = await request("POST", "/api/agents/h1/sessions/ab123/kill", {
    body: {}, headers: userHeaders,
  });
  assert.equal(killRes.status, 200);
  const [spawnId, killId] = [spawnRes.body.cmdId, killRes.body.cmdId];

  // Both ride the next reply...
  res = await beat({ device: "h1" });
  assert.deepEqual(
    res.body.commands,
    [
      { type: "spawn", repo: "AgentHub", cmdId: spawnId },
      { type: "kill", sessionId: "ab123", cmdId: killId },
    ]
  );

  // ...and keep riding it (at-least-once) until the agent acks. Acking one
  // drops only that one.
  res = await beat({ device: "h1", ackedCommands: [spawnId] });
  assert.deepEqual(res.body.commands, [{ type: "kill", sessionId: "ab123", cmdId: killId }]);
  res = await beat({ device: "h1", ackedCommands: [killId] });
  assert.deepEqual(res.body.commands, []);
  assert.deepEqual(agents.h1.commands, []);
  // The transient ack list is not persisted onto the agent record.
  assert.equal(agents.h1.ackedCommands, undefined);
});

test("http: spawn route forwards composer options; bare spawn stays minimal", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "hc" });

  // Full composer payload -> every provided field rides the queued command.
  const full = await request("POST", "/api/agents/hc/sessions", {
    body: {
      repo: "AgentHub", prompt: "fix the bug", label: "Fix login",
      baseRef: "main", branchName: "agent/fix-login", model: "opus",
      permissionMode: "plan",
    },
    headers: userHeaders,
  });
  assert.equal(full.status, 200);
  // Blank/omitted fields are dropped; only the ones set are forwarded, so a
  // one-click spawn stays exactly {type,repo,cmdId}.
  const bare = await request("POST", "/api/agents/hc/sessions", {
    body: { repo: "AgentHub", prompt: "", label: "", model: "sonnet" },
    headers: userHeaders,
  });
  assert.equal(bare.status, 200);

  const res = await beat({ device: "hc" });
  assert.deepEqual(res.body.commands, [
    {
      type: "spawn", repo: "AgentHub", prompt: "fix the bug", label: "Fix login",
      baseRef: "main", branchName: "agent/fix-login", model: "opus",
      permissionMode: "plan", cmdId: full.body.cmdId,
    },
    { type: "spawn", repo: "AgentHub", model: "sonnet", cmdId: bare.body.cmdId },
  ]);
});

test("http: session commands 404 for unknown hosts", async () => {
  const res = await request("POST", "/api/agents/ghost/sessions", {
    body: { repo: "X" }, headers: userHeaders,
  });
  assert.equal(res.status, 404);
});

test("findSession routes a sessionId to its host and ttyd port", async () => {
  await request("POST", "/api/heartbeat", {
    body: {
      device: "h3",
      sessions: [{ id: "zz111", ttydPort: 7705 }, { id: "zz222", ttydPort: 7706 }],
    },
    headers: agentHeaders,
  });
  assert.deepEqual(findSession("zz222"), { host: "h3", port: 7706 });
  assert.equal(findSession("nope"), null);
});

// ---- CORS on /api and /term (glasses WebView client) --------------------------

test("CORS: OPTIONS preflight on /api/* answers 204 with the CORS headers, no auth required", async () => {
  const res = await request("OPTIONS", "/api/agents", { headers: { origin: "http://glasses.local" } });
  assert.equal(res.status, 204);
  assert.equal(res.raw, "");
  assert.equal(res.headers["access-control-allow-origin"], "http://glasses.local");
  assert.equal(res.headers["vary"], "Origin");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.equal(res.headers["access-control-allow-headers"], "Authorization, Content-Type");
  assert.equal(res.headers["access-control-allow-methods"], "GET, POST, DELETE, OPTIONS");
});

test("CORS: OPTIONS preflight on /term/* also answers 204 without auth", async () => {
  const res = await request("OPTIONS", "/term/whatever", { headers: { origin: "http://glasses.local" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://glasses.local");
});

test("CORS: authenticated GET on /api reflects Origin + Vary", async () => {
  const res = await request("GET", "/api/agents", {
    headers: { ...userHeaders, origin: "http://glasses.local" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], "http://glasses.local");
  assert.equal(res.headers["vary"], "Origin");
});

test("CORS: request without Origin gets no CORS headers", async () => {
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(res.headers["vary"], undefined);
});

test("CORS: non-/api /term path gets no CORS headers even with Origin", async () => {
  const res = await request("GET", "/login", { headers: { origin: "http://glasses.local" } });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

// ---- session input endpoint -----------------------------------------------------

test("http: input endpoint queues an input command that rides the next heartbeat", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hi1" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/hi1/sessions/sess1/input", {
    body: { text: "hello agent" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.cmdId);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "hi1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "input", sessionId: "sess1", text: "hello agent", cmdId: res.body.cmdId },
  ]);
});

test("http: input endpoint rejects missing/empty/whitespace-only and over-long text", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hi2" }, headers: agentHeaders });

  const missing = await request("POST", "/api/agents/hi2/sessions/sess1/input", {
    body: {}, headers: userHeaders,
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: "text required" });

  const whitespace = await request("POST", "/api/agents/hi2/sessions/sess1/input", {
    body: { text: "   " }, headers: userHeaders,
  });
  assert.equal(whitespace.status, 400);
  assert.deepEqual(whitespace.body, { error: "text required" });

  const long = await request("POST", "/api/agents/hi2/sessions/sess1/input", {
    body: { text: "a".repeat(4001) }, headers: userHeaders,
  });
  assert.equal(long.status, 400);
  assert.deepEqual(long.body, { error: "text too long" });
});

test("http: input endpoint 404s unknown host and requires user auth", async () => {
  const unknownHost = await request("POST", "/api/agents/ghost/sessions/sess1/input", {
    body: { text: "hi" }, headers: userHeaders,
  });
  assert.equal(unknownHost.status, 404);

  const noAuth = await request("POST", "/api/agents/hi2/sessions/sess1/input", {
    body: { text: "hi" },
  });
  assert.equal(noAuth.status, 401);
});

// ---- session history endpoint ----------------------------------------------------

test("http: history endpoint returns 202 pending on cache miss, single-flight on repeat GET", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hh1" }, headers: agentHeaders });

  const first = await request("GET", "/api/agents/hh1/sessions/s1/history", { headers: userHeaders });
  assert.equal(first.status, 202);
  assert.equal(first.body.pending, true);
  assert.ok(first.body.cmdId);

  // A second GET while the first is still outstanding must not queue a
  // duplicate command; it returns the same cmdId.
  const second = await request("GET", "/api/agents/hh1/sessions/s1/history", { headers: userHeaders });
  assert.equal(second.status, 202);
  assert.equal(second.body.cmdId, first.body.cmdId);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "hh1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "history", sessionId: "s1", cmdId: first.body.cmdId },
  ]);
});

test("http: history endpoint 404s unknown host", async () => {
  const res = await request("GET", "/api/agents/ghost/sessions/s1/history", { headers: userHeaders });
  assert.equal(res.status, 404);
});

test("http: heartbeat historyResults populate the cache; GET returns 200 while fresh", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hh2" }, headers: agentHeaders });
  await request("GET", "/api/agents/hh2/sessions/s1/history", { headers: userHeaders }); // queue it

  await request("POST", "/api/heartbeat", {
    body: {
      device: "hh2",
      historyResults: [
        { sessionId: "s1", entries: [{ id: "1", role: "user", text: "hi" }], truncated: false },
      ],
    },
    headers: agentHeaders,
  });

  const res = await request("GET", "/api/agents/hh2/sessions/s1/history", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, [{ id: "1", role: "user", text: "hi" }]);
  assert.equal(res.body.truncated, false);
  assert.ok(res.body.fetchedAt);
});

test("http: stale cached history (>5 minutes) is re-queued instead of served", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hh3" }, headers: agentHeaders });
  await request("POST", "/api/heartbeat", {
    body: { device: "hh3", historyResults: [{ sessionId: "s1", entries: [], truncated: false }] },
    headers: agentHeaders,
  });
  assert.ok(agents.hh3.history.s1);
  agents.hh3.history.s1.fetchedAt = Date.now() - 6 * 60 * 1000; // fudge stale

  const res = await request("GET", "/api/agents/hh3/sessions/s1/history", { headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal(res.body.pending, true);
});

test("http: history cache eviction — entries older than 10 minutes dropped on ingest", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hh4" }, headers: agentHeaders });
  await request("POST", "/api/heartbeat", {
    body: { device: "hh4", historyResults: [{ sessionId: "old", entries: [], truncated: false }] },
    headers: agentHeaders,
  });
  assert.ok(agents.hh4.history.old);
  agents.hh4.history.old.fetchedAt = Date.now() - 11 * 60 * 1000;

  // Any subsequent heartbeat ingest re-sweeps the cache, even with no new results.
  await request("POST", "/api/heartbeat", { body: { device: "hh4" }, headers: agentHeaders });
  assert.equal(agents.hh4.history.old, undefined);
});

test("http: /api/agents does not serialize the history cache (served only by .../history)", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hh6" }, headers: agentHeaders });
  await request("POST", "/api/heartbeat", {
    body: {
      device: "hh6",
      historyResults: [
        { sessionId: "s1", entries: [{ id: "1", role: "user", text: "hi" }], truncated: false },
      ],
    },
    headers: agentHeaders,
  });

  // The dashboard poll must not carry the (potentially large) history cache...
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.status, 200);
  for (const a of list.body.agents) {
    assert.ok(!("history" in a), `agent ${a.key} leaked its history cache into /api/agents`);
  }

  // ...while the dedicated endpoint still serves the cached entries.
  const hist = await request("GET", "/api/agents/hh6/sessions/s1/history", { headers: userHeaders });
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.entries, [{ id: "1", role: "user", text: "hi" }]);
});

test("http: history cache eviction — capped at 8 sessions, oldest fetchedAt evicted first", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hh5" }, headers: agentHeaders });
  for (let i = 1; i <= 9; i++) {
    await request("POST", "/api/heartbeat", {
      body: { device: "hh5", historyResults: [{ sessionId: `s${i}`, entries: [], truncated: false }] },
      headers: agentHeaders,
    });
  }
  const keys = Object.keys(agents.hh5.history);
  assert.equal(keys.length, 8, "cache should be capped at 8 sessions");
  assert.ok(!keys.includes("s1"), "oldest session (s1) should have been evicted");
  assert.ok(keys.includes("s9"), "newest session (s9) should remain");
});
