// Unit tests for turma/server.js using node:test (built-in — keeps the
// repo's zero-npm-dependency stance). CI runs them in a throwaway
// node:24-alpine container: `node --test turma/tests/`.
//
// TURMA_TEST makes server.js export its internals instead of binding the
// production port; the HTTP tests listen on an ephemeral port themselves.
// notify()'s outbound ntfy POST is captured by stubbing globalThis.fetch, so
// the alert tests observe exactly which notifications each beat fires.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { EventEmitter } = require("events");
const test = require("node:test");
const assert = require("node:assert/strict");

// Environment must be pinned BEFORE the module under test loads.
process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.NTFY_URL = "http://ntfy.test"; // enables notify(); fetch is stubbed
process.env.COST_ALERT_USD = "50";
process.env.STATE_FILE = path.join(
  os.tmpdir(),
  `turma-test-state-${process.pid}.json`
);
// Archive (durable, searchable ended-session store) writes under a throwaway dir.
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-test-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");
// LiteLLM backend (Whisper STT derives its endpoint from this): configured so
// the "enabled" code paths are exercised. The "unset" branch is tested via a
// separately required module (freshServerModule).
process.env.LITELLM_URL = "http://litellm.test/v1";
process.env.LITELLM_API_KEY = "litellmkey";
// Whisper STT: configured so the "enabled" code paths (transcribePcm request
// building, the /audio WS end-to-end tests) are exercised against the real
// module instance. The "WHISPER_URL unset" case is tested via a separately
// required module instance (see freshServerModule below).
process.env.WHISPER_URL = "http://whisper.test/v1/audio/transcriptions";
process.env.WHISPER_MODEL = "whisper-1";
process.env.WHISPER_API_KEY = "whisperkey";
process.env.WHISPER_LANGUAGE = "en";
process.env.WHISPER_TIMEOUT_MS = "30000";

// Capture ntfy pushes synchronously (notify() calls global fetch). Individual
// tests below stub globalThis.fetch to exercise transcribePcm/the audio WS,
// then must call restoreFetch() to put this capturing stub back.
const notifications = [];
function ntfyFetchStub(url, opts) {
  notifications.push({ url, title: opts.headers.Title, body: opts.body, headers: opts.headers });
  return Promise.resolve({ ok: true });
}
globalThis.fetch = ntfyFetchStub;
function restoreFetch() {
  globalThis.fetch = ntfyFetchStub;
}
const titles = () => notifications.map((n) => n.title);

const hub = require("../server.js");
const {
  server, agents, queueCommand, findSession,
  wsAccept, wsEncode, wsParser, channelDuplex,
  heartbeatAlerts, sessionWorking,
  userAuthorized, agentAuthorized, agentWsAuthorized, fmtDur,
  credentialsMatch, issueSessionToken, sessionTokenValid,
  pcmToWav, transcribePcm, issueWsToken, wsTokenValid,
} = hub;

// Requires a fresh instance of server.js with mutated env vars (e.g. to test
// the WHISPER_URL-unset code path while the primary suite keeps it
// configured). Module-level consts are frozen at require time, so this is
// the only way to exercise both branches from one test file.
function freshServerModule(mutateEnv) {
  const modPath = require.resolve("../server.js");
  const saved = { ...process.env };
  mutateEnv(process.env);
  delete require.cache[modPath];
  try {
    return require(modPath);
  } finally {
    process.env = { ...saved };
  }
}

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
      process.env.TURMA_SESSION_SECRET ||
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

test("sessionWorking: paneBusy is authoritative over transcript freshness", () => {
  const now = Date.now();
  // paneBusy true wins even over a stale transcript...
  assert.equal(sessionWorking({ session: { paneBusy: true, transcriptAgeSec: 999 } }, now, now), true);
  // ...and paneBusy false wins even over a fresh one.
  assert.equal(sessionWorking({ session: { paneBusy: false, transcriptAgeSec: 0 } }, now, now), false);
  // null paneBusy (older agent / capture failed) -> transcript-mtime fallback.
  assert.equal(sessionWorking({ session: { paneBusy: null, transcriptAgeSec: 0 } }, now, now), true);
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

test("alerts: daily cost prefers host-level usage (counts killed sessions)", () => {
  const beat = makeHost();
  // The host-level `usage` block is aggregated from ALL transcripts, so it
  // exceeds the threshold even though the live sessions list is empty (their
  // work was killed). The alert must use it rather than summing live sessions.
  notifications.length = 0;
  beat({ sessions: [], usage: { today: { cost: 72.5 } } });
  assert.deepEqual(titles(), ["host1 cost alert"]);
  assert.match(notifications[0].body, /\$72\.50/);
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
  const url = "https://github.com/xerktech/Turma/pull/34";
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
  beat(withPrs(["https://github.com/xerktech/Turma/pull/35"]));
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

// ---- archive: agent-push ingest + heartbeat cursors + search/browse/view -------

test("http: archive ingest is agent-authed; search/browse/view are user-authed", async () => {
  const meta = {
    remoteKey: "github.com/xerk/turma", repo: "turma", worktree: "/w/ab",
    slug: "-w-ab", createdAt: "2026-07-11T00:00:00Z", endedTs: "2026-07-11T02:00:00Z",
    summary: "Durable Search Feature",
  };
  const body = {
    startOffset: 0, endOffset: 120, size: 120, meta,
    entries: [
      { uuid: "e1", role: "user", ts: "2026-07-11T00:00:00Z", text: "make history durable and searchable" },
      { uuid: "e2", role: "assistant", ts: "2026-07-11T00:01:00Z", text: "added a sqlite fts index on the hub" },
    ],
  };
  // Ingest is agent-authed: rejected with no creds, accepted with the agent
  // bearer token (and, like the heartbeat, with the user basic login too).
  assert.equal((await request("POST", "/api/agents/nas/archive/tr1", { body })).status, 401);
  const ok = await request("POST", "/api/agents/nas/archive/tr1", { body, headers: agentHeaders });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bytesStored, 120);

  // A hostile transcriptId is rejected before touching disk.
  assert.equal(
    (await request("POST", "/api/agents/nas/archive/..%2f..%2fetc", { body, headers: agentHeaders })).status, 400
  );

  // Search is user-authed and finds the ingested content, highlighted.
  assert.equal((await request("GET", "/api/search?q=searchable")).status, 401);
  const s = await request("GET", "/api/search?q=searchable", { headers: userHeaders });
  assert.equal(s.status, 200);
  const matches = s.body.groups.flatMap((g) => g.matches);
  assert.ok(matches.some((m) => m.transcriptId === "tr1" && /<mark>/.test(m.snippet)));
  // Too-short queries are rejected.
  assert.equal((await request("GET", "/api/search?q=a", { headers: userHeaders })).status, 400);

  // Browse lists the ended session; view returns its full transcript.
  const list = await request("GET", "/api/archive", { headers: userHeaders });
  assert.equal(list.status, 200);
  assert.ok(list.body.sessions.some((x) => x.transcriptId === "tr1"));
  const view = await request("GET", "/api/archive/tr1", { headers: userHeaders });
  assert.equal(view.status, 200);
  assert.equal(view.body.entries.length, 2);
  assert.equal((await request("GET", "/api/archive/nope", { headers: userHeaders })).status, 404);
});

test("http: heartbeat carries archiveHave cursors back for a manifest", async () => {
  // A manifest for a not-yet-synced transcript reports have=0.
  const beat1 = {
    device: "nas", archiveManifest: [{ transcriptId: "tr-new", slug: "s", repo: "turma", remoteKey: "github.com/xerk/turma", size: 999 }],
  };
  const r1 = await request("POST", "/api/heartbeat", { body: beat1, headers: agentHeaders });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.archiveHave["tr-new"], 0);
  // For an already-ingested transcript (tr1 above) it reports the stored bytes.
  const beat2 = { device: "nas", archiveManifest: [{ transcriptId: "tr1", slug: "-w-ab", repo: "turma" }] };
  const r2 = await request("POST", "/api/heartbeat", { body: beat2, headers: agentHeaders });
  assert.equal(r2.body.archiveHave.tr1, 120);
  // The bulky manifest is not persisted onto the agent record.
  assert.equal(agents.nas.archiveManifest, undefined);
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

test("http: over HTTPS the session cookie is SameSite=None; Secure; Partitioned (cross-site iframe embed)", async () => {
  // Simulate the Cloudflare-tunnel HTTPS hop so the cookie takes its
  // production form, which the embedded-dashboard iframe on the phone needs.
  const ok = await request("POST", "/api/login", {
    body: { username: "hubuser", password: "hubpass" },
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(ok.status, 200);
  const setCookie = (ok.headers["set-cookie"] || [])[0] || "";
  assert.match(setCookie, /^hub_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Partitioned/);
  // Lax must NOT appear — it would shadow None and break the iframe embed.
  assert.doesNotMatch(setCookie, /SameSite=Lax/);
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
    body: { repo: "Turma" }, headers: userHeaders,
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
      { type: "spawn", repo: "Turma", cmdId: spawnId },
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
  // (The app no longer names branches, so there is no branchName field.)
  const full = await request("POST", "/api/agents/hc/sessions", {
    body: {
      repo: "Turma", prompt: "fix the bug", label: "Fix login",
      baseRef: "main", model: "opus",
      permissionMode: "plan",
    },
    headers: userHeaders,
  });
  assert.equal(full.status, 200);
  // Blank/omitted fields are dropped; only the ones set are forwarded, so a
  // one-click spawn stays exactly {type,repo,cmdId}.
  const bare = await request("POST", "/api/agents/hc/sessions", {
    body: { repo: "Turma", prompt: "", label: "", model: "sonnet" },
    headers: userHeaders,
  });
  assert.equal(bare.status, 200);

  const res = await beat({ device: "hc" });
  assert.deepEqual(res.body.commands, [
    {
      type: "spawn", repo: "Turma", prompt: "fix the bug", label: "Fix login",
      baseRef: "main", model: "opus",
      permissionMode: "plan", cmdId: full.body.cmdId,
    },
    { type: "spawn", repo: "Turma", model: "sonnet", cmdId: bare.body.cmdId },
  ]);
});

test("http: clone route queues a clone command; validates repo and host", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "hcl" });

  // Missing repo -> 400, nothing queued.
  const bad = await request("POST", "/api/agents/hcl/clone", { body: {}, headers: userHeaders });
  assert.equal(bad.status, 400);

  // A valid clone rides the next reply as a {type:"clone", repo} command.
  const ok = await request("POST", "/api/agents/hcl/clone", {
    body: { repo: "xerktech/Turma" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
  const res = await beat({ device: "hcl" });
  assert.deepEqual(res.body.commands, [
    { type: "clone", repo: "xerktech/Turma", cmdId: ok.body.cmdId },
  ]);

  // Unknown host -> 404.
  const ghost = await request("POST", "/api/agents/ghost/clone", {
    body: { repo: "x/y" }, headers: userHeaders,
  });
  assert.equal(ghost.status, 404);
});

test("http: prune route queues a prune command per repo; validates host", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "hpr" });

  // A valid prune rides the next reply as a {type:"prune", repo} command.
  const ok = await request("POST", "/api/agents/hpr/repos/Turma/prune", {
    body: {}, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
  const res = await beat({ device: "hpr" });
  assert.deepEqual(res.body.commands, [
    { type: "prune", repo: "Turma", cmdId: ok.body.cmdId },
  ]);

  // Unknown host -> 404.
  const ghost = await request("POST", "/api/agents/ghost/repos/Turma/prune", {
    body: {}, headers: userHeaders,
  });
  assert.equal(ghost.status, 404);
});

test("http: transcript-resume route queues a resumeTranscript command with the cwd hint", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "htr" });

  const tid = "1fe17602-2537-4900-b6b9-9475d40c1ab8";
  const cwd = "/mnt/data/git/.turma/worktrees/Turma/ab123";
  const ok = await request(
    "POST", `/api/agents/htr/transcripts/${tid}/resume`,
    { body: { cwd }, headers: userHeaders });
  assert.equal(ok.status, 200);
  const res = await beat({ device: "htr" });
  assert.deepEqual(res.body.commands, [
    { type: "resumeTranscript", transcriptId: tid, cwd, cmdId: ok.body.cmdId },
  ]);

  // A missing cwd body degrades to an empty hint (the agent re-derives it).
  // Ack the first command so only the new one rides this reply.
  const noCwd = await request(
    "POST", `/api/agents/htr/transcripts/${tid}/resume`,
    { body: {}, headers: userHeaders });
  assert.equal(noCwd.status, 200);
  const res2 = await beat({ device: "htr", ackedCommands: [ok.body.cmdId] });
  assert.deepEqual(res2.body.commands, [
    { type: "resumeTranscript", transcriptId: tid, cwd: "", cmdId: noCwd.body.cmdId },
  ]);

  // Unknown host -> 404.
  const ghost = await request(
    "POST", `/api/agents/ghost/transcripts/${tid}/resume`,
    { body: { cwd }, headers: userHeaders });
  assert.equal(ghost.status, 404);
});

test("http: heartbeat passes github + clones + prunes through to /api/agents", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({
    device: "hgh",
    github: { available: true, login: "octocat", repos: [{ nameWithOwner: "octocat/hello", name: "hello" }] },
    clones: [{ name: "hello", repo: "octocat/hello", status: "cloning" }],
    prunes: [{ repo: "hello", status: "done", summary: "removed 1 worktree · 0 merged branches", at: "2026-07-10T00:00:00Z" }],
  });
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  const host = list.body.agents.find((a) => a.key === "hgh");
  assert.equal(host.github.available, true);
  assert.equal(host.github.login, "octocat");
  assert.deepEqual(host.clones, [{ name: "hello", repo: "octocat/hello", status: "cloning" }]);
  assert.equal(host.prunes[0].repo, "hello");
  assert.equal(host.prunes[0].status, "done");
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

// ---- session answer endpoint -----------------------------------------------------

test("http: answer endpoint queues an answerQuestion command with the option pick", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "ha1" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/ha1/sessions/sess1/answer", {
    body: { optionIndex: 2 }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "ha1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "answerQuestion", sessionId: "sess1", optionIndex: 2, cmdId: res.body.cmdId },
  ]);
});

test("http: answer endpoint carries free-text custom and defaults optionIndex to -1", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "ha2" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/ha2/sessions/sess1/answer", {
    body: { custom: "do the other thing" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "ha2" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "answerQuestion", sessionId: "sess1", optionIndex: -1,
      custom: "do the other thing", cmdId: res.body.cmdId },
  ]);
});

test("http: answer endpoint rejects an empty answer and over-long custom", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "ha3" }, headers: agentHeaders });

  const empty = await request("POST", "/api/agents/ha3/sessions/sess1/answer", {
    body: {}, headers: userHeaders,
  });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: "optionIndex or custom required" });

  const long = await request("POST", "/api/agents/ha3/sessions/sess1/answer", {
    body: { custom: "a".repeat(4001) }, headers: userHeaders,
  });
  assert.equal(long.status, 400);
  assert.deepEqual(long.body, { error: "custom too long" });
});

test("http: answer endpoint 404s unknown host and requires user auth", async () => {
  const unknownHost = await request("POST", "/api/agents/ghost/sessions/sess1/answer", {
    body: { optionIndex: 0 }, headers: userHeaders,
  });
  assert.equal(unknownHost.status, 404);

  const noAuth = await request("POST", "/api/agents/ha3/sessions/sess1/answer", {
    body: { optionIndex: 0 },
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

// ---- pcmToWav ------------------------------------------------------------------

test("pcmToWav: RIFF/WAVE header fields for 16kHz s16le mono", () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length); // RIFF size
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM format
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000); // sample rate
  assert.equal(wav.readUInt32LE(28), 32000); // byte rate
  assert.equal(wav.readUInt16LE(32), 2); // block align
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length); // data chunk size
  assert.ok(wav.subarray(44).equals(pcm));
});

test("pcmToWav: header math holds for an empty and an odd-length payload", () => {
  const empty = pcmToWav(Buffer.alloc(0));
  assert.equal(empty.length, 44);
  assert.equal(empty.readUInt32LE(4), 36);
  assert.equal(empty.readUInt32LE(40), 0);

  const odd = pcmToWav(Buffer.alloc(7, 9));
  assert.equal(odd.readUInt32LE(4), 43);
  assert.equal(odd.readUInt32LE(40), 7);
});

// ---- transcribePcm ---------------------------------------------------------------

test("transcribePcm: WHISPER_URL/LITELLM_URL unset -> unavailable, fetch never called", async () => {
  let called = false;
  globalThis.fetch = () => { called = true; return Promise.resolve({ ok: true, json: async () => ({}) }); };
  // WHISPER_URL derives from LITELLM_URL, so both must be unset to disable STT.
  const disabled = freshServerModule((env) => { delete env.WHISPER_URL; delete env.LITELLM_URL; });
  const result = await disabled.transcribePcm(Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(result, { text: "", unavailable: true, reason: "whisper not configured" });
  assert.equal(called, false);
  restoreFetch();
});

test("transcribePcm: WHISPER_URL derives from LITELLM_URL when unset", async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ text: "hi" }) };
  };
  // Only LITELLM_URL configured (LITELLM_API_KEY too): STT should hit the same
  // instance's /audio/transcriptions with the shared credential.
  const derived = freshServerModule((env) => {
    delete env.WHISPER_URL;
    delete env.WHISPER_API_KEY;
    env.LITELLM_URL = "http://litellm.test/v1";
    env.LITELLM_API_KEY = "litellmkey";
  });
  const result = await derived.transcribePcm(Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(result, { text: "hi" });
  assert.equal(captured.url, "http://litellm.test/v1/audio/transcriptions");
  assert.equal(captured.opts.headers.Authorization, "Bearer litellmkey");
  restoreFetch();
});

test("transcribePcm: {text} body, trimmed", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "  hello world  " }) });
  const result = await transcribePcm(Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(result, { text: "hello world" });
  restoreFetch();
});

test("transcribePcm: {transcription} string fallback", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ transcription: "  raw text  " }) });
  const result = await transcribePcm(Buffer.from([1]));
  assert.deepEqual(result, { text: "raw text" });
  restoreFetch();
});

test("transcribePcm: {transcription} array-of-segments fallback joins .text", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ transcription: [{ text: "Hello " }, { text: "world" }] }),
  });
  const result = await transcribePcm(Buffer.from([1]));
  assert.deepEqual(result, { text: "Hello world" });
  restoreFetch();
});

test("transcribePcm: language is passed through when present", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "hi", language: "en" }) });
  const result = await transcribePcm(Buffer.from([1]));
  assert.deepEqual(result, { text: "hi", language: "en" });
  restoreFetch();
});

test("transcribePcm: non-OK response -> unavailable, status in reason", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const result = await transcribePcm(Buffer.from([1]));
  assert.deepEqual(result, { text: "", unavailable: true, reason: "whisper returned 503" });
  restoreFetch();
});

test("transcribePcm: fetch rejection -> unavailable with the error message", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  const result = await transcribePcm(Buffer.from([1]));
  assert.deepEqual(result, { text: "", unavailable: true, reason: "network down" });
  restoreFetch();
});

test("transcribePcm: request assertions — URL, Bearer header, FormData fields", async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ text: "hi" }) };
  };
  await transcribePcm(Buffer.from([9, 9, 9, 9]));
  assert.equal(captured.url, process.env.WHISPER_URL);
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers.Authorization, `Bearer ${process.env.WHISPER_API_KEY}`);
  const form = captured.opts.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), process.env.WHISPER_MODEL);
  assert.equal(form.get("language"), process.env.WHISPER_LANGUAGE);
  assert.equal(form.get("response_format"), "json");
  const file = form.get("file");
  assert.equal(file.name, "audio.wav");
  restoreFetch();
});

test("transcribePcm: no Authorization header when WHISPER_API_KEY unset", async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = opts;
    return { ok: true, json: async () => ({ text: "hi" }) };
  };
  // WHISPER_API_KEY falls back to LITELLM_API_KEY, so clear both to test no-auth.
  const noKey = freshServerModule((env) => { delete env.WHISPER_API_KEY; delete env.LITELLM_API_KEY; });
  await noKey.transcribePcm(Buffer.from([1]));
  assert.equal(captured.headers.Authorization, undefined);
  restoreFetch();
});

// ---- ws-token --------------------------------------------------------------------

test("ws-token: issued token validates; garbage/expired/tampered are rejected", () => {
  const tok = issueWsToken();
  assert.match(tok, /^ws\./);
  assert.equal(wsTokenValid(tok), true);
  assert.equal(wsTokenValid(""), false);
  assert.equal(wsTokenValid("nodot"), false);
  assert.equal(wsTokenValid("ws.notanumber.abc"), false);
  assert.equal(wsTokenValid(tok + "x"), false); // tampered MAC

  // Correctly-signed but already-expired token (forged expiry, real HMAC key).
  const pastExpiry = Date.now() - 1000;
  const key =
    process.env.TURMA_SESSION_SECRET ||
    require("crypto").createHash("sha256").update("hubuser\nhubpass").digest("hex");
  const mac = require("crypto")
    .createHmac("sha256", key)
    .update(`ws.${pastExpiry}`)
    .digest("base64url");
  assert.equal(wsTokenValid(`ws.${pastExpiry}.${mac}`), false);
});

test("ws-token: scope isolation — a session cookie fails wsTokenValid and vice versa", () => {
  const sessionTok = issueSessionToken();
  const wsTok = issueWsToken();
  assert.equal(wsTokenValid(sessionTok), false);
  assert.equal(sessionTokenValid(wsTok), false);
});

test("http: GET /api/ws-token is user-auth gated; returns {token, expiresInSec}", async () => {
  const noAuth = await request("GET", "/api/ws-token");
  assert.equal(noAuth.status, 401);

  const res = await request("GET", "/api/ws-token", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.match(res.body.token, /^ws\./);
  assert.equal(res.body.expiresInSec, 300);
  assert.equal(wsTokenValid(res.body.token), true);
});

// ---- audio WebSocket (raw net socket, per the RFC 6455 helpers above) --------------

// Performs a raw HTTP Upgrade handshake against the live test server and
// resolves once the status line + headers are in; `leftover` is any bytes
// already read past the header terminator (the server may coalesce the 101
// response with the first WS frames it emits).
function wsConnect(pathAndQuery, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = Buffer.from("test-key-0123456789").toString("base64");
      socket.write(
        `GET ${pathAndQuery} HTTP/1.1\r\n` +
          "Host: x\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
      fn(val);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      finish(resolve, {
        socket,
        statusLine: buf.subarray(0, headerEnd).toString("utf8").split("\r\n")[0],
        leftover: buf.subarray(headerEnd + 4),
      });
    };
    // A rejected upgrade may just write bytes and destroy the socket (no
    // "error"), so a close without ever seeing the header terminator, or a
    // flat timeout, must also settle the promise instead of hanging forever.
    const onClose = () => finish(reject, new Error(`socket closed before headers arrived (${buf.length}B)`));
    const onError = (e) => finish(reject, e);
    const timer = setTimeout(() => finish(reject, new Error("wsConnect timed out")), timeoutMs);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

// Collects parsed server->client frames (never masked) off a socket, seeded
// with any handshake leftover bytes.
function collectFrames(socket, leftover) {
  const frames = [];
  const parse = wsParser((op, payload) => frames.push({ op, payload }));
  if (leftover && leftover.length) parse(leftover);
  socket.on("data", parse);
  return frames;
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("timed out waiting for condition"));
      }
    }, 10);
  });
}

async function issueToken() {
  const res = await request("GET", "/api/ws-token", { headers: userHeaders });
  return res.body.token;
}

test("audio WS: bad/missing token -> 401, no 101 upgrade", async () => {
  const bad = await wsConnect("/audio?auth=not-a-token");
  assert.match(bad.statusLine, /^HTTP\/1\.1 401/);
  bad.socket.destroy();

  const missing = await wsConnect("/audio");
  assert.match(missing.statusLine, /^HTTP\/1\.1 401/);
  missing.socket.destroy();
});

test("audio WS: stream PCM, finalize -> audio_result with correct bytes; WAV data length matches", async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ text: "hello from whisper", language: "en" }) };
  };

  const token = await issueToken();
  const { socket, statusLine, leftover } = await wsConnect(`/audio?auth=${token}`);
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(socket, leftover);

  const pcm1 = Buffer.alloc(3200, 0x11);
  const pcm2 = Buffer.alloc(1600, 0x22);
  socket.write(maskedFrame(0x2, pcm1));
  socket.write(maskedFrame(0x2, pcm2));
  socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ type: "finalize" }))));

  await waitFor(() => frames.some((f) => f.op === 0x1));
  const msg = JSON.parse(frames.find((f) => f.op === 0x1).payload.toString("utf8"));
  assert.equal(msg.type, "audio_result");
  assert.equal(msg.bytes, pcm1.length + pcm2.length);
  assert.equal(msg.capped, undefined);
  assert.deepEqual(msg.transcript, { text: "hello from whisper", language: "en" });
  assert.equal(typeof msg.durationMs, "number");

  await waitFor(() => frames.some((f) => f.op === 0x8));

  const file = captured.opts.body.get("file");
  const wavBuf = Buffer.from(await file.arrayBuffer());
  assert.equal(wavBuf.readUInt32LE(40), pcm1.length + pcm2.length); // data chunk size
  assert.equal(wavBuf.length - 44, pcm1.length + pcm2.length);

  socket.destroy();
  restoreFetch();
});

test("audio WS: close before finalize discards buffered audio, never calls Whisper", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ text: "" }) }; };

  const token = await issueToken();
  const { socket, statusLine, leftover } = await wsConnect(`/audio?auth=${token}`);
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(socket, leftover);

  socket.write(maskedFrame(0x2, Buffer.alloc(100, 0x33)));
  socket.write(maskedFrame(0x8, Buffer.alloc(0)));

  await waitFor(() => frames.some((f) => f.op === 0x8));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, false);

  socket.destroy();
  restoreFetch();
});

test("audio WS: bytes past the 1920000-byte cap are dropped; capped:true reported", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "" }) });

  const token = await issueToken();
  const { socket, statusLine, leftover } = await wsConnect(`/audio?auth=${token}`);
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(socket, leftover);

  const CAP = 1920000;
  const chunk = Buffer.alloc(640000, 0x44); // 3 * 640000 == cap exactly
  for (let i = 0; i < 3; i++) socket.write(maskedFrame(0x2, chunk));
  socket.write(maskedFrame(0x2, Buffer.alloc(640000, 0x55))); // entirely beyond the cap
  socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ type: "finalize" }))));

  await waitFor(() => frames.some((f) => f.op === 0x1), 10000);
  const msg = JSON.parse(frames.find((f) => f.op === 0x1).payload.toString("utf8"));
  assert.equal(msg.bytes, CAP);
  assert.equal(msg.capped, true);

  socket.destroy();
  restoreFetch();
});

test("audio WS: double finalize is ignored (second is a no-op)", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ text: "ok" }) }; };

  const token = await issueToken();
  const { socket, statusLine, leftover } = await wsConnect(`/audio?auth=${token}`);
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(socket, leftover);

  socket.write(maskedFrame(0x2, Buffer.alloc(10)));
  const finalizeFrame = maskedFrame(0x1, Buffer.from(JSON.stringify({ type: "finalize" })));
  socket.write(finalizeFrame);
  socket.write(finalizeFrame);

  await waitFor(() => frames.some((f) => f.op === 0x8));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal(frames.filter((f) => f.op === 0x1).length, 1);

  socket.destroy();
  restoreFetch();
});

test("audio WS: ping is answered with a pong carrying the same payload", async () => {
  const token = await issueToken();
  const { socket, statusLine, leftover } = await wsConnect(`/audio?auth=${token}`);
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(socket, leftover);

  socket.write(maskedFrame(0x9, Buffer.from("beat")));
  await waitFor(() => frames.some((f) => f.op === 0xa));
  const pong = frames.find((f) => f.op === 0xa);
  assert.equal(pong.payload.toString(), "beat");

  socket.destroy();
});

test("audio WS: unparseable/other text frames before finalize are ignored", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ text: "" }) }; };

  const token = await issueToken();
  const { socket, statusLine, leftover } = await wsConnect(`/audio?auth=${token}`);
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(socket, leftover);

  socket.write(maskedFrame(0x1, Buffer.from("not json")));
  socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ type: "ping" }))));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(called, false);
  assert.equal(frames.filter((f) => f.op === 0x1).length, 0);

  socket.destroy();
  restoreFetch();
});

// ---- live transcript relay (/live) ------------------------------------------

// Reads one text frame's JSON off a live socket's frame list, waiting for it.
async function nextTextJson(frames, fromIndex = 0) {
  await waitFor(() => frames.filter((f) => f.op === 0x1).length > fromIndex);
  const text = frames.filter((f) => f.op === 0x1)[fromIndex];
  return JSON.parse(text.payload.toString("utf8"));
}

test("live WS: bad/missing token -> 401, no upgrade", async () => {
  const bad = await wsConnect("/live/h/s?auth=not-a-token");
  assert.match(bad.statusLine, /^HTTP\/1\.1 401/);
  bad.socket.destroy();
  const missing = await wsConnect("/live/h/s");
  assert.match(missing.statusLine, /^HTTP\/1\.1 401/);
  missing.socket.destroy();
});

test("live WS: unknown host -> 404, no upgrade", async () => {
  const token = await issueToken();
  const res = await wsConnect(`/live/nosuchhost/s1?auth=${token}`);
  assert.match(res.statusLine, /^HTTP\/1\.1 404/);
  res.socket.destroy();
});

test("live WS: unknown session on a known host -> 404; a real session still upgrades", async () => {
  agents.knownhost = {
    device: "knownhost",
    lastSeen: Date.now(),
    commands: [],
    history: {},
    sessions: [{ id: "real1", worktreePath: "/wt/real1", session: { tail: [] } }],
  };
  const token = await issueToken();

  // A bogus/stale sessionId is rejected up front rather than left as an idle
  // do-nothing socket.
  const bogus = await wsConnect(`/live/knownhost/nosuchsession?auth=${token}`);
  assert.match(bogus.statusLine, /^HTTP\/1\.1 404/);
  bogus.socket.destroy();

  // The real session on the same host still upgrades (no over-rejection).
  const ok = await wsConnect(`/live/knownhost/real1?auth=${token}`);
  assert.match(ok.statusLine, /^HTTP\/1\.1 101/);
  ok.socket.destroy();
});

test("queueCommand pokes a connected control channel so the agent beats immediately", async () => {
  agents.pokehost = { device: "pokehost", lastSeen: Date.now(), commands: [], history: {}, sessions: [] };
  const ctrl = await wsConnect(`/agent/control?name=pokehost&token=agenttok`);
  assert.match(ctrl.statusLine, /^HTTP\/1\.1 101/);
  const frames = collectFrames(ctrl.socket, ctrl.leftover);

  const cmdId = queueCommand("pokehost", { type: "kill", sessionId: "s1" });

  // The hub nudges the agent to heartbeat now...
  const poke = await nextTextJson(frames, 0);
  assert.deepEqual(poke, { poke: true });
  // ...and the command is still queued for delivery in that (imminent) beat.
  assert.equal(agents.pokehost.commands.length, 1);
  assert.equal(agents.pokehost.commands[0].cmdId, cmdId);
  ctrl.socket.destroy();
});

test("queueCommand without a control channel still queues (no poke, no throw)", () => {
  agents.nolink = { device: "nolink", lastSeen: Date.now(), commands: [], history: {}, sessions: [] };
  const cmdId = queueCommand("nolink", { type: "kill", sessionId: "s1" });
  assert.ok(cmdId);
  assert.equal(agents.nolink.commands.length, 1);
});

test("live WS: seeds cached tail, watches via the control channel, fans out deltas, unwatches on close", async () => {
  // A host with one running session, its worktree path + a cached tail.
  agents.livehost = {
    device: "livehost",
    lastSeen: Date.now(),
    commands: [],
    history: {},
    sessions: [
      {
        id: "ls1",
        worktreePath: "/wt/ls1",
        session: { tail: [{ id: "c1", role: "assistant", text: "cached" }] },
      },
    ],
  };

  // Stand in for the host's tunnel-agent: a control channel the hub can send
  // watch/unwatch on and that we push tail deltas back over.
  const ctrl = await wsConnect(`/agent/control?name=livehost&token=agenttok`);
  assert.match(ctrl.statusLine, /^HTTP\/1\.1 101/);
  const ctrlFrames = collectFrames(ctrl.socket, ctrl.leftover);

  // The glasses live socket.
  const token = await issueToken();
  const live = await wsConnect(`/live/livehost/ls1?auth=${token}`);
  assert.match(live.statusLine, /^HTTP\/1\.1 101/);
  const liveFrames = collectFrames(live.socket, live.leftover);

  // 1. Immediately seeded with the cached tail.
  const seed = await nextTextJson(liveFrames, 0);
  assert.equal(seed.type, "tail");
  assert.deepEqual(seed.entries, [{ id: "c1", role: "assistant", text: "cached" }]);

  // 2. The agent was told to start tailing, with the worktree path.
  const watch = await nextTextJson(ctrlFrames, 0);
  assert.equal(watch.watch, "ls1");
  assert.equal(watch.worktreePath, "/wt/ls1");

  // 3. A tail delta the agent pushes on the control channel reaches the live
  //    client — including the rich `blocks` the native chat UI renders. The hub
  //    relays entry objects verbatim, so blocks pass through untouched.
  const delta = { tail: "ls1", entries: [{
    id: "c1", role: "assistant", text: "cached and more",
    blocks: [
      { t: "text", text: "cached and more" },
      { t: "tool_use", name: "Bash", input: "ls -la", id: "tu1" },
    ],
  }] };
  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify(delta))));
  const relayed = await nextTextJson(liveFrames, 1);
  assert.equal(relayed.type, "tail");
  assert.deepEqual(relayed.entries, delta.entries);

  // 3b. A live `turn` delta (in-progress assistant text from the TUI) is fanned
  //     out too, including the empty-string clear on completion.
  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ turn: "ls1", text: "streaming…" }))));
  const turn = await nextTextJson(liveFrames, 2);
  assert.equal(turn.type, "turn");
  assert.equal(turn.text, "streaming…");
  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ turn: "ls1", text: "" }))));
  const cleared = await nextTextJson(liveFrames, 3);
  assert.equal(cleared.type, "turn");
  assert.equal(cleared.text, "");

  // 4. Closing the last watcher unwatches on the control channel.
  live.socket.destroy();
  await waitFor(() => ctrlFrames.filter((f) => f.op === 0x1).some((f) => {
    try { return JSON.parse(f.payload.toString("utf8")).unwatch === "ls1"; } catch { return false; }
  }));

  ctrl.socket.destroy();
  delete agents.livehost;
});

test("live WS: a control channel connecting after watchers exist re-arms their watches", async () => {
  agents.rehost = {
    device: "rehost",
    lastSeen: Date.now(),
    commands: [],
    history: {},
    sessions: [{ id: "rs1", worktreePath: "/wt/rs1", session: { tail: [] } }],
  };

  // Watcher attaches while the tunnel is offline (no control channel yet).
  const token = await issueToken();
  const live = await wsConnect(`/live/rehost/rs1?auth=${token}`);
  assert.match(live.statusLine, /^HTTP\/1\.1 101/);

  // Now the tunnel connects — it must be told to watch the already-attached session.
  const ctrl = await wsConnect(`/agent/control?name=rehost&token=agenttok`);
  const ctrlFrames = collectFrames(ctrl.socket, ctrl.leftover);
  const watch = await nextTextJson(ctrlFrames, 0);
  assert.equal(watch.watch, "rs1");
  assert.equal(watch.worktreePath, "/wt/rs1");

  live.socket.destroy();
  ctrl.socket.destroy();
  delete agents.rehost;
});

// ---- /api/agents ETag + 304 (FIX 3/#9) --------------------------------------

test("/api/agents: emits an ETag; unchanged If-None-Match -> 304; state change re-etags", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "etag-host" }, headers: agentHeaders });

  const first = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, "no ETag on /api/agents");
  // no-cache (not no-store) so the browser keeps the body + revalidates.
  assert.match(first.headers["cache-control"], /no-cache/);

  // Same ETag echoed back -> cheap 304, empty body.
  const notMod = await request("GET", "/api/agents", {
    headers: { ...userHeaders, "if-none-match": etag },
  });
  assert.equal(notMod.status, 304);
  assert.equal(notMod.raw, "");
  assert.equal(notMod.headers.etag, etag);

  // A fresh heartbeat mutates state -> cache invalidated -> new ETag, full 200.
  await request("POST", "/api/heartbeat", { body: { device: "etag-host2" }, headers: agentHeaders });
  const after = await request("GET", "/api/agents", {
    headers: { ...userHeaders, "if-none-match": etag },
  });
  assert.equal(after.status, 200);
  assert.ok(after.headers.etag && after.headers.etag !== etag, "ETag should change on state change");
});

test("/api/agents: queuing a command invalidates the cached ETag", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "etag-q" }, headers: agentHeaders });
  const before = (await request("GET", "/api/agents", { headers: userHeaders })).headers.etag;
  await request("POST", "/api/agents/etag-q/sessions", { body: { repo: "R" }, headers: userHeaders });
  const after = (await request("GET", "/api/agents", { headers: userHeaders })).headers.etag;
  assert.ok(after && after !== before, "queuing a command should change the ETag");
});

// ---- /api/events SSE stream (FIX 1/#1) --------------------------------------

// Opens the SSE stream without buffering to end (the request helper waits for
// 'end', which never comes for a stream). Resolves with the live response.
function sseConnect(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + "/api/events", { method: "GET", headers }, (res) => {
      res.setEncoding("utf8");
      resolve({ req, res, status: res.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
}

// Accumulates parsed SSE records ({event, data}) off a streaming response.
function collectSse(res) {
  const events = [];
  let buf = "";
  res.on("data", (c) => {
    buf += c;
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) ev.event = line.slice(6).trim();
        else if (line.startsWith("data:")) ev.data = (ev.data || "") + line.slice(5).trim();
      }
      if (ev.event) events.push(ev);
    }
  });
  return events;
}

test("SSE /api/events: unauthenticated -> 401, no stream", async () => {
  const { res } = await sseConnect({});
  assert.equal(res.statusCode, 401);
  res.destroy();
});

test("SSE /api/events: authenticated stream pushes an `agent` event on heartbeat", async () => {
  const { req, res } = await sseConnect(userHeaders);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  const events = collectSse(res);

  // A heartbeat for a fresh host must fan out as an `agent` event carrying that
  // host's serialized record (same shape as /api/agents, history stripped).
  await request("POST", "/api/heartbeat", {
    body: { device: "sse-host", sessions: [{ id: "z1", ttydPort: 7799 }] },
    headers: agentHeaders,
  });
  await waitFor(() => events.some((e) => e.event === "agent" && JSON.parse(e.data).key === "sse-host"));
  const rec = JSON.parse(events.find((e) => e.event === "agent" && JSON.parse(e.data).key === "sse-host").data);
  assert.equal(rec.key, "sse-host");
  assert.equal(rec.online, true);
  assert.equal(rec.sessions[0].id, "z1");
  assert.ok(!("history" in rec), "history cache must not leak into the SSE record");

  req.destroy();
  res.destroy();
});

test("SSE /api/events: pushes a `removed` event when a host is deleted", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "sse-del" }, headers: agentHeaders });
  const { req, res } = await sseConnect(userHeaders);
  assert.equal(res.statusCode, 200);
  const events = collectSse(res);

  await request("DELETE", "/api/agents/sse-del", { headers: userHeaders });
  await waitFor(() => events.some((e) => e.event === "removed" && JSON.parse(e.data).key === "sse-del"));

  req.destroy();
  res.destroy();
});
