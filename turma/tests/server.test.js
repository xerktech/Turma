// Unit tests for turma/server.js using node:test (built-in — keeps the
// repo's zero-npm-dependency stance). CI runs them in a throwaway
// node:24-alpine container: `node --test turma/tests/`.
//
// TURMA_TEST makes server.js export its internals instead of binding the
// production port; the HTTP tests listen on an ephemeral port themselves.
// notify() fans every alert out to registered devices via push.sendFcm; the
// alert tests stub push.sendFcm to record exactly which notifications each beat
// fires (server.js calls it as `push.sendFcm`, so replacing the property on the
// shared module object intercepts every fan-out).

"use strict";

const os = require("os");
const vm = require("vm");
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
process.env.TURMA_TRIGGER_TOKEN = "triggertok"; // programmatic /api/trigger bearer
// Control-channel liveness, wound right down so the beat/drop is testable in ms
// rather than the 30s/90s the fleet runs. No other test opens a real
// /agent/control socket, so nothing else feels these.
process.env.CONTROL_PING_EVERY_MS = "50";
process.env.CONTROL_DEAD_AFTER_MS = "400";
process.env.STATE_FILE = path.join(
  os.tmpdir(),
  `turma-test-state-${process.pid}.json`
);
process.env.DEVICES_FILE = path.join(
  os.tmpdir(),
  `turma-test-devices-${process.pid}.json`
);
process.env.TICKET_AGENTS_FILE = path.join(
  os.tmpdir(),
  `turma-test-ticket-agents-${process.pid}.json`
);
process.env.AUTOSTART_ORGS_FILE = path.join(
  os.tmpdir(),
  `turma-test-autostart-orgs-${process.pid}.json`
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

// A benign default global fetch. notify() no longer touches it (it fans out via
// push.sendFcm, stubbed below); only transcribePcm/the audio WS use it, and
// those tests install their own stub, then call restoreFetch() to put this back.
function defaultFetchStub() {
  return Promise.resolve({ ok: true });
}
globalThis.fetch = defaultFetchStub;
function restoreFetch() {
  globalThis.fetch = defaultFetchStub;
}

// Capture notifications at the FCM fan-out boundary. server.js calls
// `push.sendFcm(...)`, so replacing that property on the shared module object
// records every alert synchronously (the recorder runs before the returned
// promise resolves). Its {title, body, data} mirror what a real device would
// receive.
const push = require("../push.js");
const notifications = [];
push.sendFcm = (tokens, { title, body, data = {} } = {}) => {
  notifications.push({ tokens, title, body, data });
  return Promise.resolve({ sent: tokens.length, dead: [] });
};
const titles = () => notifications.map((n) => n.title);

const hub = require("../server.js");
// notify() no-ops when no device is registered; register one so the alert tests
// see the fan-out. Real fan-out/pruning is exercised separately below.
hub.registerDevice("capture-device", "android");
const {
  server, agents, queueCommand, findSession,
  wsAccept, wsEncode, wsParser, channelDuplex,
  heartbeatAlerts, sessionWorking,
  userAuthorized, agentAuthorized, agentWsAuthorized, triggerAuthorized, fmtDur,
  credentialsMatch, issueSessionToken, sessionTokenValid,
  pcmToWav, transcribePcm, issueWsToken, wsTokenValid,
  TERM_OSC52_JS,
  autoStartSweep, autoStopSweep, startedTicketKeys, orgsWithAutoStart, autoStarted,
  autoStopped, autoStartOrgs, setAutoStartOrg,
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

// ---- OSC 52 clipboard bridge ---------------------------------------------------
// TERM_OSC52_JS is a string injected into ttyd's page, so exercise it the way the
// browser does: run it against a fake window.term and read what it hands the
// clipboard. See the constant in server.js for why the bridge exists at all.

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

function runOsc52({ withTerm = true, reject = false } = {}) {
  const writes = [];
  const timers = [];
  let handler = null;
  const term = {
    parser: { registerOscHandler: (id, fn) => { if (id === 52) handler = fn; } },
  };
  const sandbox = {
    window: { term: withTerm ? term : undefined },
    navigator: {
      clipboard: {
        writeText: (t) => {
          writes.push(t);
          return reject ? Promise.reject(new Error("denied")) : Promise.resolve();
        },
      },
    },
    // Node's own atob, not a Buffer stand-in: both implement the same spec —
    // one char per decoded BYTE, and a throw on invalid input, which
    // Buffer.from(s, "base64") silently swallows instead.
    atob,
    TextDecoder,
    setTimeout: (fn) => { timers.push(fn); return 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(TERM_OSC52_JS, sandbox);
  return {
    writes,
    sandbox,
    term,
    fire: (data) => handler(data),
    handled: () => !!handler,
    tick: () => timers.splice(0).forEach((f) => f()),
  };
}

test("OSC 52 bridge copies both tmux's and an app's payload shape", () => {
  const t = runOsc52();
  // An app addresses the clipboard by name; tmux sends an EMPTY selection.
  assert.equal(t.fire("c;" + b64("from-the-app")), true);
  assert.equal(t.fire(";" + b64("from-tmux")), true);
  assert.deepEqual(t.writes, ["from-the-app", "from-tmux"]);
});

test("OSC 52 bridge decodes UTF-8 rather than pasting mojibake", () => {
  const t = runOsc52();
  t.fire("c;" + b64("héllo → wörld ✓"));
  assert.deepEqual(t.writes, ["héllo → wörld ✓"]);
});

test("OSC 52 bridge is write-only: a read request is never answered", () => {
  const t = runOsc52();
  // "?" asks the terminal to REPLY with the clipboard — answering would hand
  // any program in the pane whatever the operator last copied.
  assert.equal(t.fire("c;?"), true);
  assert.deepEqual(t.writes, []);
});

test("OSC 52 bridge ignores an empty payload instead of wiping the clipboard", () => {
  const t = runOsc52();
  // tmux emits this when copy-mode copies an empty selection.
  assert.equal(t.fire(";"), true);
  assert.deepEqual(t.writes, []);
});

test("OSC 52 bridge waits for ttyd's terminal to exist", () => {
  // Injected into <head>, so window.term won't exist for another beat or two.
  const t = runOsc52({ withTerm: false });
  assert.equal(t.handled(), false, "nothing to register on yet");
  t.sandbox.window.term = t.term;   // ttyd's bundle boots
  t.tick();
  assert.equal(t.handled(), true);
  t.fire("c;" + b64("late"));
  assert.deepEqual(t.writes, ["late"]);
});

test("OSC 52 bridge swallows a refused clipboard write", async () => {
  // Rejects when the document isn't focused or permission is denied; an
  // unhandled rejection here would surface inside xterm.js's parser.
  const t = runOsc52({ reject: true });
  assert.equal(t.fire("c;" + b64("nope")), true);
  await new Promise((r) => setImmediate(r));   // let the rejection settle
});

test("OSC 52 bridge survives a malformed payload", () => {
  const t = runOsc52();
  assert.equal(t.fire("c;!!!not-base64!!!"), true);
  assert.deepEqual(t.writes, []);
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
  assert.equal(notifications[0].data.priority, "urgent");
  notifications.length = 0;
  beat({ startedAt: "boot-4" }, t0 + 180 * 1000); // inside the 30m holdoff
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
  const url = "https://github.com/xerktech/Turma/pull/34";
  const withPrs = (urls) => ({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", session: { newPrUrls: urls } }],
  });
  notifications.length = 0;
  beat(withPrs([url]));
  assert.deepEqual(titles(), ["nas-repo-s1 created a PR"]);
  assert.equal(notifications[0].data.click, url);
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

// ---- Jira board page + heartbeat block ----------------------------------------

test("http: /board page and /board.js are user-gated like the rest of the UI", async () => {
  assert.equal((await request("GET", "/board")).status, 401);
  assert.equal((await request("GET", "/board", { headers: agentHeaders })).status, 401);
  const page = await request("GET", "/board", { headers: userHeaders });
  assert.equal(page.status, 200);
  assert.match(page.raw, /kanban|TurmaBoard/i);
  // board.js rides the static-asset allowlist (same treatment as chat.js).
  const js = await request("GET", "/board.js", { headers: userHeaders });
  assert.equal(js.status, 200);
  assert.match(js.raw, /mergeSites/);
});

test("http: a heartbeat's jira block round-trips verbatim to /api/agents", async () => {
  const jira = {
    available: true,
    site: "myorg.atlassian.net",
    siteKey: "myorg.atlassian.net",
    user: "me@x.com",
    fetchedAt: "2026-07-14T12:00:00Z",
    error: null,
    truncated: false,
    tickets: [{ key: "PROJ-1", url: "https://myorg.atlassian.net/browse/PROJ-1",
                summary: "Test", status: "In Review", statusCategory: "inprogress",
                priority: "High", type: "Bug", project: "PROJ", labels: [],
                updated: "2026-07-14T11:00:00Z" }],
  };
  assert.equal(
    (await request("POST", "/api/heartbeat", { body: { device: "jira-host", jira }, headers: agentHeaders })).status,
    200
  );
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = res.body.agents.find((a) => a.key === "jira-host");
  assert.ok(rec, "heartbeated host is served");
  assert.deepEqual(rec.jira, jira);
});

// ---- mobile push device registry ----------------------------------------------

test("http: /api/devices register + unregister is user-authed", async () => {
  // Unauthed is rejected like the rest of the browser API.
  assert.equal(
    (await request("POST", "/api/devices", { body: { token: "fcmtok1" } })).status,
    401
  );
  // Missing token → 400.
  assert.equal(
    (await request("POST", "/api/devices", { body: {}, headers: userHeaders })).status,
    400
  );
  // Register, then it shows in the registry (deduped on re-register).
  assert.equal(
    (await request("POST", "/api/devices", { body: { token: "fcmtok1" }, headers: userHeaders })).status,
    200
  );
  await request("POST", "/api/devices", { body: { token: "fcmtok1", platform: "android" }, headers: userHeaders });
  assert.equal(hub.listDevices().filter((d) => d.token === "fcmtok1").length, 1, "deduped");
  // Unregister via query param (FCM tokens can contain `/`, so not a path seg).
  assert.equal(
    (await request("DELETE", "/api/devices?token=fcmtok1", { headers: userHeaders })).status,
    200
  );
  assert.equal(hub.listDevices().some((d) => d.token === "fcmtok1"), false);
});

test("notify(): FCM fan-out prunes dead tokens, keeps live ones", () => {
  // pruneDevices is the registry side of the fan-out: sendFcm reports dead
  // tokens (404 UNREGISTERED) and notify() prunes them. Exercised directly here
  // for the dead-token contract, independent of any send.
  hub.registerDevice("live", "android");
  hub.registerDevice("stale", "android");
  hub.pruneDevices(["stale"]);
  const tokens = hub.listDevices().map((d) => d.token);
  assert.ok(tokens.includes("live"));
  assert.ok(!tokens.includes("stale"));
  hub.unregisterDevice("live");
});

// ---- updating status (XERK-29) -----------------------------------------------

test("http: /updating shows an expected restart as `updating`, not `offline`", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "upd-host" }, headers: agentHeaders });

  // Agent-authed like the heartbeat: no creds is rejected.
  assert.equal(
    (await request("POST", "/api/agents/upd-host/updating", { body: { reason: "update" } })).status,
    401,
  );
  // A host the hub has never seen has no record to hang the status on.
  assert.equal(
    (await request("POST", "/api/agents/ghost/updating", { body: {}, headers: agentHeaders })).status,
    404,
  );
  // The announce lands.
  const ok = await request("POST", "/api/agents/upd-host/updating",
    { body: { reason: "update", version: "9.9.9" }, headers: agentHeaders });
  assert.equal(ok.status, 200);

  // /api/agents is memoized; the endpoints invalidate it, but a direct mutation
  // of the record below does not, so drop the cache before each read.
  const recOf = async () => {
    hub.invalidateAgentsCache();
    return (await request("GET", "/api/agents", { headers: userHeaders })).body.agents
      .find((a) => a.key === "upd-host");
  };

  // While the host is still heartbeating it's plainly `online` — the status is
  // only meaningful once it goes silent, so it's suppressed here.
  let rec = await recOf();
  assert.equal(rec.online, true);
  assert.equal(rec.updating, null);

  // Simulate the heartbeat gap the restart causes: silent, but within the grace
  // window it surfaces as `updating` (carrying the reason/version), not offline.
  agents["upd-host"].lastSeen = Date.now() - 2 * 60 * 1000;
  rec = await recOf();
  assert.equal(rec.online, false);
  assert.ok(rec.updating, "updating surfaces while silent within grace");
  assert.equal(rec.updating.reason, "update");
  assert.equal(rec.updating.version, "9.9.9");

  // Past the grace window a stuck update correctly falls through to offline.
  agents["upd-host"].updating.until = Date.now() - 1;
  rec = await recOf();
  assert.equal(rec.online, false);
  assert.equal(rec.updating, null);

  // A heartbeat from the far side clears the flag outright (the record rebuild
  // drops it), so a recovered host is never stuck showing `updating`.
  await request("POST", "/api/heartbeat", { body: { device: "upd-host" }, headers: agentHeaders });
  assert.equal(agents["upd-host"].updating, undefined);
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

test("http: /usage serves the page and /history redirects to it", async () => {
  for (const p of ["/usage", "/usage.html"]) {
    const res = await request("GET", p, { headers: userHeaders });
    assert.equal(res.status, 200, p);
    assert.match(res.headers["content-type"], /text\/html/);
  }
  // The page was /history before it went token-only; old bookmarks must land.
  for (const p of ["/history", "/history.html"]) {
    const res = await request("GET", p, { headers: userHeaders });
    assert.equal(res.status, 301, p);
    assert.equal(res.headers.location, "/usage");
  }
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

test("triggerAuthorized: trigger token OR user login, nothing else", () => {
  const req = (h) => ({ headers: h });
  // The dedicated trigger token passes.
  assert.equal(triggerAuthorized(req({ authorization: "Bearer triggertok" })), true);
  // The user login (Basic) passes too.
  assert.equal(triggerAuthorized(req({ authorization: basic("hubuser", "hubpass") })), true);
  // A wrong trigger token / the agent token / no header all fail (they fall
  // through to userAuthorized, which rejects them).
  assert.equal(triggerAuthorized(req({ authorization: "Bearer nope" })), false);
  assert.equal(triggerAuthorized(req({ authorization: "Bearer agenttok" })), false);
  assert.equal(triggerAuthorized(req({})), false);
});

test("http: /api/trigger auth (trigger token or user login only)", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "ht", repos: [{ name: "Turma" }] }, headers: agentHeaders,
  });
  const body = { hostname: "ht", repo: "Turma", prompt: "do the thing" };
  const triggerHeaders = { authorization: "Bearer triggertok", "content-type": "application/json" };

  // No auth -> 401.
  assert.equal((await request("POST", "/api/trigger", { body })).status, 401);
  // A bad bearer -> 401.
  assert.equal(
    (await request("POST", "/api/trigger", { body, headers: { authorization: "Bearer bad" } })).status,
    401,
  );
  // The agent token does NOT unlock it (it's not a trigger token or a user login).
  assert.equal(
    (await request("POST", "/api/trigger", { body, headers: agentHeaders })).status,
    401,
  );
  // The dedicated trigger token works.
  assert.equal((await request("POST", "/api/trigger", { body, headers: triggerHeaders })).status, 200);
  // The user login works too.
  assert.equal((await request("POST", "/api/trigger", { body, headers: userHeaders })).status, 200);
});

test("http: /api/trigger validates required fields and host/repo", async () => {
  const triggerHeaders = { authorization: "Bearer triggertok", "content-type": "application/json" };
  await request("POST", "/api/heartbeat", {
    body: { device: "htv", repos: [{ name: "Turma" }, { name: "(root)" }] }, headers: agentHeaders,
  });

  const post = (body) => request("POST", "/api/trigger", { body, headers: triggerHeaders });

  // Each required field, missing -> 400.
  assert.equal((await post({ repo: "Turma", prompt: "x" })).status, 400); // no hostname
  assert.equal((await post({ hostname: "htv", prompt: "x" })).status, 400); // no repo
  assert.equal((await post({ hostname: "htv", repo: "Turma" })).status, 400); // no prompt
  // Whitespace-only counts as missing.
  assert.equal((await post({ hostname: "htv", repo: "Turma", prompt: "   " })).status, 400);
  // Over-long prompt -> 400.
  assert.equal((await post({ hostname: "htv", repo: "Turma", prompt: "x".repeat(10001) })).status, 400);
  // Unknown host -> 404.
  assert.equal((await post({ hostname: "ghost", repo: "Turma", prompt: "x" })).status, 404);
  // Unknown repo on a known host -> 404.
  assert.equal((await post({ hostname: "htv", repo: "Nope", prompt: "x" })).status, 404);
  // The "(root)" pseudo-repo is a valid target (it's in the reported repos[]).
  assert.equal((await post({ hostname: "htv", repo: "(root)", prompt: "x" })).status, 200);
});

test("http: /api/trigger queues a spawn command with the prompt and options", async () => {
  const triggerHeaders = { authorization: "Bearer triggertok", "content-type": "application/json" };
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "htq", repos: [{ name: "Turma" }] });

  // Required-only trigger -> {type:"spawn", repo, prompt}.
  const bare = await request("POST", "/api/trigger", {
    body: { hostname: "htq", repo: "Turma", prompt: "fix the login bug" },
    headers: triggerHeaders,
  });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.ok, true);
  // Full trigger -> the optional composer fields ride along too.
  const full = await request("POST", "/api/trigger", {
    body: {
      hostname: "htq", repo: "Turma", prompt: "ship the feature",
      label: "Ship it", baseRef: "main", model: "opus", permissionMode: "plan",
    },
    headers: triggerHeaders,
  });
  assert.equal(full.status, 200);

  const res = await beat({ device: "htq" });
  assert.deepEqual(res.body.commands, [
    { type: "spawn", repo: "Turma", prompt: "fix the login bug", cmdId: bare.body.cmdId },
    {
      type: "spawn", repo: "Turma", prompt: "ship the feature", label: "Ship it",
      baseRef: "main", model: "opus", permissionMode: "plan", cmdId: full.body.cmdId,
    },
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

test("http: jira refresh fans out to configured hosts only, and dedupes", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });

  // Three shapes the fan-out has to tell apart: a healthy configured host, a
  // configured host whose polls fail (available=false, siteKey=null — the one a
  // manual retry is FOR), and a host with no Jira at all.
  await beat({ device: "jok", jira: { configured: true, available: true, siteKey: "a.atlassian.net" } });
  await beat({ device: "jerr", jira: { configured: true, available: false, siteKey: null, error: "HTTP Error 503" } });
  await beat({ device: "joff", jira: { configured: false, available: false, siteKey: null } });

  const ok = await request("POST", "/api/jira/refresh", { body: {}, headers: userHeaders });
  assert.equal(ok.status, 200);
  // Membership, not equality: the suite's agents map is shared, so other tests'
  // hosts legitimately show up in a fleet-wide fan-out.
  assert.ok(ok.body.hosts.includes("jok"), "healthy configured host targeted");
  assert.ok(ok.body.hosts.includes("jerr"), "failing configured host targeted");
  assert.ok(!ok.body.hosts.includes("joff"), "unconfigured host NOT targeted");
  assert.ok(ok.body.queued.includes("jok") && ok.body.queued.includes("jerr"));

  for (const host of ["jok", "jerr"]) {
    const res = await beat({ device: host });
    assert.deepEqual(
      res.body.commands.map((c) => c.type), ["refreshJira"],
      `${host} should hold exactly one refreshJira`);
  }
  // The unconfigured host is left alone entirely.
  const off = await beat({ device: "joff" });
  assert.deepEqual(off.body.commands, []);
});

test("http: jira refresh collapses a mashed button into one poll per host", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "jmash", jira: { configured: true, available: true, siteKey: "a.atlassian.net" } });

  const first = await request("POST", "/api/jira/refresh", { body: {}, headers: userHeaders });
  assert.ok(first.body.queued.includes("jmash"));
  // Second click while the first is still unacked: still reported as targeted,
  // but nothing new queued — else each click costs a full re-poll.
  const second = await request("POST", "/api/jira/refresh", { body: {}, headers: userHeaders });
  assert.ok(second.body.hosts.includes("jmash"), "still targeted (a refresh is in flight)");
  assert.ok(!second.body.queued.includes("jmash"), "but not re-queued");

  const res = await beat({ device: "jmash" });
  assert.equal(res.body.commands.filter((c) => c.type === "refreshJira").length, 1);
});

test("http: jira refresh targets pre-`configured` agents on siteKey alone", async () => {
  // An agent predating the `configured` field reports only a siteKey; it must
  // stay refreshable rather than silently dropping out of the fan-out.
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "jold", jira: { available: true, siteKey: "old.atlassian.net" } });

  const ok = await request("POST", "/api/jira/refresh", { body: {}, headers: userHeaders });
  assert.ok(ok.body.hosts.includes("jold"));
  const res = await beat({ device: "jold" });
  assert.deepEqual(res.body.commands.map((c) => c.type), ["refreshJira"]);
});

test("http: jira refresh requires the user login", async () => {
  const r = await request("POST", "/api/jira/refresh", { body: {} });
  assert.equal(r.status, 401);
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

// ---- session interrupt endpoint --------------------------------------------------

test("http: interrupt endpoint queues an interrupt command that rides the next heartbeat", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hx1" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/hx1/sessions/sess1/interrupt", {
    headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.cmdId);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "hx1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "interrupt", sessionId: "sess1", cmdId: res.body.cmdId },
  ]);
});

test("http: interrupt endpoint 404s unknown host and requires user auth", async () => {
  const unknownHost = await request("POST", "/api/agents/ghost/sessions/sess1/interrupt", {
    headers: userHeaders,
  });
  assert.equal(unknownHost.status, 404);

  await request("POST", "/api/heartbeat", { body: { device: "hx2" }, headers: agentHeaders });
  const noAuth = await request("POST", "/api/agents/hx2/sessions/sess1/interrupt", {});
  assert.equal(noAuth.status, 401);
});

// ---- session live model / mode endpoints ----------------------------------------

test("http: model endpoint queues a setModel command that rides the next heartbeat", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hm1" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/hm1/sessions/sess1/model", {
    body: { model: "sonnet" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "hm1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "setModel", sessionId: "sess1", model: "sonnet", cmdId: res.body.cmdId },
  ]);
});

test("http: model endpoint rejects a malformed model before it can queue", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hm1b" }, headers: agentHeaders });
  for (const model of ["so nnet", "x;rm -rf", "a".repeat(61)]) {
    const res = await request("POST", "/api/agents/hm1b/sessions/sess1/model", {
      body: { model }, headers: userHeaders,
    });
    assert.equal(res.status, 400, model);
  }
  // The bracketed probe aliases are shaped fine — the agent decides if they're real.
  const ok = await request("POST", "/api/agents/hm1b/sessions/sess1/model", {
    body: { model: "sonnet[1m]" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
});

test("http: mode endpoint queues a setMode command that rides the next heartbeat", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hm2" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/hm2/sessions/sess1/mode", {
    body: { permissionMode: "plan" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "hm2" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "setMode", sessionId: "sess1", permissionMode: "plan", cmdId: res.body.cmdId },
  ]);
});

test("http: model/mode endpoints reject missing value, 404 unknown host, require auth", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hm3" }, headers: agentHeaders });

  const noModel = await request("POST", "/api/agents/hm3/sessions/sess1/model", {
    body: {}, headers: userHeaders,
  });
  assert.equal(noModel.status, 400);
  assert.deepEqual(noModel.body, { error: "model required" });

  const noMode = await request("POST", "/api/agents/hm3/sessions/sess1/mode", {
    body: {}, headers: userHeaders,
  });
  assert.equal(noMode.status, 400);
  assert.deepEqual(noMode.body, { error: "permissionMode required" });

  const ghost = await request("POST", "/api/agents/ghost/sessions/sess1/model", {
    body: { model: "opus" }, headers: userHeaders,
  });
  assert.equal(ghost.status, 404);

  const noAuth = await request("POST", "/api/agents/hm3/sessions/sess1/mode", {
    body: { permissionMode: "plan" },
  });
  assert.equal(noAuth.status, 401);
});

// ---- session rename endpoint -----------------------------------------------------

test("http: summary endpoint queues a setSummary command that rides the next heartbeat", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hs1" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/hs1/sessions/sess1/summary", {
    body: { summary: "Named By Hand" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "hs1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "setSummary", sessionId: "sess1", summary: "Named By Hand", cmdId: res.body.cmdId },
  ]);
});

test("http: summary endpoint forwards a blank rename (clears the name), caps length, needs auth", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "hs2" }, headers: agentHeaders });

  // Blank is a real instruction here — it clears the name — so it queues rather
  // than 400ing the way the input endpoint's empty text does.
  const clear = await request("POST", "/api/agents/hs2/sessions/sess1/summary", {
    body: { summary: "" }, headers: userHeaders,
  });
  assert.equal(clear.status, 200);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "hs2" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "setSummary", sessionId: "sess1", summary: "", cmdId: clear.body.cmdId },
  ]);

  const tooLong = await request("POST", "/api/agents/hs2/sessions/sess1/summary", {
    body: { summary: "x".repeat(201) }, headers: userHeaders,
  });
  assert.equal(tooLong.status, 400);
  assert.deepEqual(tooLong.body, { error: "summary too long" });

  const ghost = await request("POST", "/api/agents/ghost/sessions/sess1/summary", {
    body: { summary: "hi" }, headers: userHeaders,
  });
  assert.equal(ghost.status, 404);

  const noAuth = await request("POST", "/api/agents/hs2/sessions/sess1/summary", {
    body: { summary: "hi" },
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

test("http: answer endpoint carries a multiSelect optionIndices list", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "ha1b" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/ha1b/sessions/sess1/answer", {
    body: { optionIndex: -1, optionIndices: [0, 2, "bad", -1] }, headers: userHeaders,
  });
  assert.equal(res.status, 200);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "ha1b" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "answerQuestion", sessionId: "sess1", optionIndex: -1,
      optionIndices: [0, 2], cmdId: res.body.cmdId },  // non-int / negative filtered out
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
  assert.deepEqual(empty.body, { error: "optionIndex, optionIndices or custom required" });

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
        { sessionId: "s1", entries: [{ id: "1", role: "user", text: "hi" }], truncated: false,
          queued: ["still waiting"] },
      ],
    },
    headers: agentHeaders,
  });

  const res = await request("GET", "/api/agents/hh2/sessions/s1/history", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, [{ id: "1", role: "user", text: "hi" }]);
  assert.equal(res.body.truncated, false);
  // Still-queued prompts ride the cache; an agent predating the field (the
  // other historyResults cases above/below) normalises to [].
  assert.deepEqual(res.body.queued, ["still waiting"]);
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

// ---- subagent (background-agent) transcript endpoint ------------------------

test("http: subagent-history 202s on cache miss, single-flight per (session,type,label)", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "sh1" }, headers: agentHeaders });

  const q = "/api/agents/sh1/sessions/s1/subagents/history?type=Explore&label=Map%20the%20code";
  const first = await request("GET", q, { headers: userHeaders });
  assert.equal(first.status, 202);
  assert.ok(first.body.cmdId);

  // Same row again -> reuse the outstanding command (no duplicate).
  const second = await request("GET", q, { headers: userHeaders });
  assert.equal(second.body.cmdId, first.body.cmdId);

  // A different label is a distinct row -> a distinct command.
  const other = await request(
    "GET", "/api/agents/sh1/sessions/s1/subagents/history?type=Explore&label=Other", { headers: userHeaders });
  assert.notEqual(other.body.cmdId, first.body.cmdId);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "sh1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "subagentHistory", sessionId: "s1", agentType: "Explore", label: "Map the code", cmdId: first.body.cmdId },
    { type: "subagentHistory", sessionId: "s1", agentType: "Explore", label: "Other", cmdId: other.body.cmdId },
  ]);
});

test("http: subagent-history requires a type", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "sh2" }, headers: agentHeaders });
  const res = await request(
    "GET", "/api/agents/sh2/sessions/s1/subagents/history?label=x", { headers: userHeaders });
  assert.equal(res.status, 400);
});

test("http: heartbeat subagentHistoryResults populate the cache; GET returns 200 while fresh", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "sh3" }, headers: agentHeaders });
  await request("POST", "/api/heartbeat", {
    body: {
      device: "sh3",
      subagentHistoryResults: [
        { sessionId: "s1", type: "Explore", label: "Map the code",
          entries: [{ id: "1", role: "assistant", text: "done" }], truncated: false },
      ],
    },
    headers: agentHeaders,
  });

  const res = await request(
    "GET", "/api/agents/sh3/sessions/s1/subagents/history?type=Explore&label=Map%20the%20code",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, [{ id: "1", role: "assistant", text: "done" }]);
});

test("http: /api/agents does not serialize the subagentHistory cache", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "sh4" }, headers: agentHeaders });
  await request("POST", "/api/heartbeat", {
    body: {
      device: "sh4",
      subagentHistoryResults: [
        { sessionId: "s1", type: "Explore", label: "x", entries: [], truncated: false },
      ],
    },
    headers: agentHeaders,
  });
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  for (const a of list.body.agents) {
    assert.ok(!("subagentHistory" in a), `agent ${a.key} leaked its subagentHistory cache`);
  }
});

// ---- board ticket detail endpoint -------------------------------------------
// GET /api/jira/<siteKey>/<issueKey>: the board's expanded ticket view. The hub
// holds no Jira creds, so it routes to a host reporting that org and rides the
// heartbeat command path (same shape as session history).

const jiraBeat = (device, siteKey, extra = {}) =>
  request("POST", "/api/heartbeat", {
    body: { device, jira: { available: true, siteKey, user: `${device}@x.com`, tickets: [] }, ...extra },
    headers: agentHeaders,
  });

test("http: ticket detail returns 202 pending on cache miss, single-flight on repeat GET", async () => {
  await jiraBeat("jd1", "org1.atlassian.net");

  const first = await request("GET", "/api/jira/org1.atlassian.net/ENG-42", { headers: userHeaders });
  assert.equal(first.status, 202);
  assert.equal(first.body.pending, true);
  assert.ok(first.body.cmdId);

  // A second viewer (or a re-open) must not queue a duplicate fetch.
  const second = await request("GET", "/api/jira/org1.atlassian.net/ENG-42", { headers: userHeaders });
  assert.equal(second.status, 202);
  assert.equal(second.body.cmdId, first.body.cmdId);

  // A DIFFERENT issue is its own command, though.
  const other = await request("GET", "/api/jira/org1.atlassian.net/ENG-43", { headers: userHeaders });
  assert.notEqual(other.body.cmdId, first.body.cmdId);

  const beat = await jiraBeat("jd1", "org1.atlassian.net");
  assert.deepEqual(beat.body.commands, [
    { type: "jiraIssue", issueKey: "ENG-42", cmdId: first.body.cmdId },
    { type: "jiraIssue", issueKey: "ENG-43", cmdId: other.body.cmdId },
  ]);
});

test("http: heartbeat jiraIssueResults populate the cache; GET returns 200 while fresh", async () => {
  await jiraBeat("jd2", "org2.atlassian.net");
  await request("GET", "/api/jira/org2.atlassian.net/ENG-1", { headers: userHeaders }); // queue it

  const issue = { key: "ENG-1", summary: "Fix it", description: "why", comments: [] };
  await jiraBeat("jd2", "org2.atlassian.net", {
    jiraIssueResults: [{ key: "ENG-1", issue, error: null }],
  });

  const res = await request("GET", "/api/jira/org2.atlassian.net/ENG-1", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.issue, issue);
  assert.ok(res.body.fetchedAt);
});

test("http: a ticket the host couldn't fetch caches its error rather than re-queueing forever", async () => {
  await jiraBeat("jd3", "org3.atlassian.net");
  await jiraBeat("jd3", "org3.atlassian.net", {
    jiraIssueResults: [{ key: "ENG-9", issue: null, error: "HTTP Error 404: Not Found" }],
  });

  const res = await request("GET", "/api/jira/org3.atlassian.net/ENG-9", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.error, "HTTP Error 404: Not Found");
  assert.equal(res.body.issue, undefined);
  // The board polls while a ticket is open; a doomed fetch must not re-queue.
  assert.equal((agents.jd3.commands || []).length, 0);
});

test("http: stale cached ticket detail (>1 minute) is re-queued instead of served", async () => {
  await jiraBeat("jd4", "org4.atlassian.net");
  await jiraBeat("jd4", "org4.atlassian.net", {
    jiraIssueResults: [{ key: "ENG-2", issue: { key: "ENG-2" }, error: null }],
  });
  assert.ok(agents.jd4.jiraIssues["ENG-2"]);
  agents.jd4.jiraIssues["ENG-2"].fetchedAt = Date.now() - 2 * 60 * 1000; // fudge stale

  const res = await request("GET", "/api/jira/org4.atlassian.net/ENG-2", { headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal(res.body.pending, true);
});

test("http: ticket detail 404s an org no host reports", async () => {
  const res = await request("GET", "/api/jira/nobody.atlassian.net/ENG-1", { headers: userHeaders });
  assert.equal(res.status, 404);
});

// POST /api/jira/<siteKey>/<issueKey>/repo — the operator's manual repo override.
// Writes to the AGENT's triage ledger via the heartbeat command path; nothing
// here writes to Jira, which stays pull-only.

const setRepo = (site, key, body) =>
  request("POST", `/api/jira/${site}/${key}/repo`, { body, headers: userHeaders });

test("http: setting a ticket's repo queues setJiraRepo on the org's host", async () => {
  await jiraBeat("jr1", "r1.atlassian.net");
  const res = await setRepo("r1.atlassian.net", "ENG-7", { repo: "Turma" });
  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.hosts, ["jr1"]);

  const beat = await jiraBeat("jr1", "r1.atlassian.net");
  assert.deepEqual(beat.body.commands, [{
    type: "setJiraRepo", siteKey: "r1.atlassian.net", issueKey: "ENG-7",
    repo: "Turma", auto: false, cmdId: res.body.cmdId,
  }]);
});

test("http: {repo:null} and {auto:true} are carried as the distinct answers they are", async () => {
  await jiraBeat("jr2", "r2.atlassian.net");
  await setRepo("r2.atlassian.net", "ENG-1", { repo: null });
  await setRepo("r2.atlassian.net", "ENG-2", { auto: true });
  const beat = await jiraBeat("jr2", "r2.atlassian.net");
  const [none, auto] = beat.body.commands;
  assert.equal(none.repo, null);
  assert.equal(none.auto, false);   // an explicit "nothing fits" IS a decision
  assert.equal(auto.auto, true);    // "let the model decide" releases the pin
});

test("http: a body with neither repo nor auto is a 400, not a silent decline", async () => {
  // A lost field must never paint a confident "no repo fits" chip.
  await jiraBeat("jr3", "r3.atlassian.net");
  const res = await setRepo("r3.atlassian.net", "ENG-1", {});
  assert.equal(res.status, 400);
  assert.equal((agents.jr3.commands || []).length, 0);
});

test("http: setting a repo rejects a bad issue key or repo name before routing", async () => {
  await jiraBeat("jr4", "r4.atlassian.net");
  for (const bad of ["..%2F..%2Fsecret", "12ab", "ENG-"]) {
    const res = await setRepo("r4.atlassian.net", bad, { repo: "Turma" });
    assert.equal(res.status, 400, `${bad} should be rejected`);
  }
  for (const bad of ["../etc", "a b", "x;y", 42, {}]) {
    const res = await setRepo("r4.atlassian.net", "ENG-1", { repo: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} should be rejected`);
  }
  assert.equal((agents.jr4.commands || []).length, 0);
});

test("http: setting a repo fans out to every host reporting the org", async () => {
  // The ledger is per-host but the board merges hosts by siteKey, so pinning on
  // only one would flicker as the merge picked a different host's block.
  await jiraBeat("jr5a", "r5.atlassian.net");
  await jiraBeat("jr5b", "r5.atlassian.net");
  const res = await setRepo("r5.atlassian.net", "ENG-1", { repo: "Turma" });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.hosts.sort(), ["jr5a", "jr5b"]);
  assert.equal((agents.jr5a.commands || []).length, 1);
  assert.equal((agents.jr5b.commands || []).length, 1);
});

test("http: an offline host of the org is still queued the pin", async () => {
  // Commands are queued and at-least-once, so it takes the pin when it returns.
  // Skipping it would let it come back reporting the model's old guess and — with
  // the freshest block winning the merge — silently revert the override.
  await jiraBeat("jr6a", "r6.atlassian.net");
  await jiraBeat("jr6b", "r6.atlassian.net");
  agents.jr6b.lastSeen = Date.now() - 10 * 60 * 1000;
  const res = await setRepo("r6.atlassian.net", "ENG-1", { repo: "Turma" });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.hosts.sort(), ["jr6a", "jr6b"]);
  assert.deepEqual(res.body.online, ["jr6a"]);
  assert.equal((agents.jr6b.commands || []).length, 1, "the offline host is queued too");
});

test("http: setting a repo 404s only when NO host reports the org", async () => {
  const res = await setRepo("nobody.atlassian.net", "ENG-1", { repo: "Turma" });
  assert.equal(res.status, 404);
});

test("http: setting a ticket's repo requires the user login", async () => {
  await jiraBeat("jr7", "r7.atlassian.net");
  const res = await request("POST", "/api/jira/r7.atlassian.net/ENG-1/repo", {
    body: { repo: "Turma" },
  });
  assert.equal(res.status, 401);
  assert.equal((agents.jr7.commands || []).length, 0);
});

test("http: ticket detail rejects a non-issue-key path segment before routing", async () => {
  await jiraBeat("jd5", "org5.atlassian.net");
  for (const bad of ["..%2F..%2Fsecret", "ENG-42%3Fx%3D1", "12ab", "ENG-", "ENG%2042"]) {
    const res = await request("GET", `/api/jira/org5.atlassian.net/${bad}`, { headers: userHeaders });
    assert.equal(res.status, 400, `${bad} should be rejected`);
  }
  assert.equal((agents.jd5.commands || []).length, 0);
});

test("http: an Azure work-item id (numeric key, slash siteKey) routes like a Jira key (XERK-43)", async () => {
  // Azure DevOps siteKeys carry an org path ("dev.azure.com/org7") and work-item
  // ids are bare integers — both must route, not 400, through the same endpoints.
  const site = "dev.azure.com/org7";
  await jiraBeat("azd", site, { jira: { available: true, source: "azure", siteKey: site, user: "u", tickets: [] } });
  const res = await request("GET", `/api/jira/${encodeURIComponent(site)}/1234`, { headers: userHeaders });
  assert.equal(res.status, 202, "a numeric key is a valid Azure id, not a bad key");
  assert.equal((agents.azd.commands || []).length, 1);
  assert.equal(agents.azd.commands[0].issueKey, "1234");
});

test("http: ticket detail prefers an ONLINE host of the org; offline-only serves its cache", async () => {
  await jiraBeat("jdOff", "org6.atlassian.net", {
    jiraIssueResults: [{ key: "ENG-7", issue: { key: "ENG-7", summary: "stale copy" }, error: null }],
  });
  await jiraBeat("jdOn", "org6.atlassian.net");
  agents.jdOff.lastSeen = Date.now() - 10 * 60 * 1000; // offline
  agents.jdOff.jiraIssues["ENG-7"].fetchedAt = Date.now() - 10 * 60 * 1000;

  // The online host is asked, even though only the offline one has a copy.
  const res = await request("GET", "/api/jira/org6.atlassian.net/ENG-7", { headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal((agents.jdOn.commands || []).length, 1);
  assert.equal((agents.jdOff.commands || []).length, 0, "an offline host must not be queued");

  // With the org's only host offline, its last copy beats leaving the panel
  // spinning on a command that will never be delivered.
  delete agents.jdOn;
  const stale = await request("GET", "/api/jira/org6.atlassian.net/ENG-7", { headers: userHeaders });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.issue.summary, "stale copy");
  assert.equal(stale.body.stale, true);
});

test("http: an offline host with nothing cached says so rather than queueing", async () => {
  await jiraBeat("jd7", "org7.atlassian.net");
  agents.jd7.lastSeen = Date.now() - 10 * 60 * 1000;
  const res = await request("GET", "/api/jira/org7.atlassian.net/ENG-1", { headers: userHeaders });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /offline/);
  assert.equal((agents.jd7.commands || []).length, 0);
});

test("http: ticket detail requires the user login", async () => {
  await jiraBeat("jd8", "org8.atlassian.net");
  const res = await request("GET", "/api/jira/org8.atlassian.net/ENG-1");
  assert.equal(res.status, 401);
});

// POST /api/jira/<siteKey>/<issueKey>/session: the board card's start button.
// The hub's whole job is ROUTING — finding the one host that has both the org's
// Jira creds and the ticket's repo — since it's the only party that sees the
// whole fleet. It sends only the issue key; the agent re-derives the rest.

// A host reporting `site`, with `repos` cloned, and `key` triaged to `repo`.
const ticketBeat = (device, site, { repo = "Turma", repos = ["Turma"], key = "ENG-5",
                                    cloned = true, fetchedAt = "2026-07-14T12:00:00Z" } = {}) =>
  request("POST", "/api/heartbeat", {
    body: {
      device,
      repos: repos.map((name) => ({ name, path: `/git/${name}` })),
      jira: {
        available: true, configured: true, siteKey: site, user: `${device}@x.com`,
        fetchedAt,
        tickets: [{ key, summary: "Fix it", repoGuess: repo ? { repo, cloned } : null }],
      },
    },
    headers: agentHeaders,
  });

test("http: starting a ticket session queues spawnTicket on the org's host", async () => {
  await ticketBeat("ts1", "t1.atlassian.net");
  const res = await request("POST", "/api/jira/t1.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.host, "ts1");
  assert.equal(res.body.repo, "Turma");
  assert.ok(res.body.cmdId);
  // Only the key travels: the agent re-derives repo, ticket text and branch from
  // its own state, so a stale board can't aim a spawn at the wrong repo.
  assert.deepEqual(agents.ts1.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", cmdId: res.body.cmdId },
  ]);
});

test("http: the ticket spawn rides the heartbeat like any other command", async () => {
  await ticketBeat("ts2", "t2.atlassian.net");
  const res = await request("POST", "/api/jira/t2.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  const beat = await ticketBeat("ts2", "t2.atlassian.net");
  assert.deepEqual(beat.body.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", cmdId: res.body.cmdId },
  ]);
});

test("http: a mashed start button is single-flighted into one spawn", async () => {
  // Two sessions on one ticket is a real feature, but a double-click isn't how
  // you ask for it.
  await ticketBeat("ts3", "t3.atlassian.net");
  const first = await request("POST", "/api/jira/t3.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  const second = await request("POST", "/api/jira/t3.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(second.body.cmdId, first.body.cmdId);
  assert.equal(agents.ts3.commands.length, 1);
});

test("http: the host must have the ticket's repo, not just the org's creds", async () => {
  // Two hosts share the org; only one has the repo. Routing on siteKey alone
  // would spawn on a host that would just log a refusal nobody sees.
  await ticketBeat("tsCreds", "t4.atlassian.net", { repos: ["Other"] });
  await ticketBeat("tsRepo", "t4.atlassian.net", { repos: ["Turma"] });
  const res = await request("POST", "/api/jira/t4.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "tsRepo");
  assert.equal((agents.tsCreds.commands || []).length, 0);
});

test("http: no online host has the repo -> routes anyway and clones on demand", async () => {
  // The old refusal is gone: the ticket routes to the most-available org host,
  // which clones the repo and queues the session behind it (see spawn_ticket).
  await ticketBeat("ts5", "t5.atlassian.net", { repos: ["Other"] });
  const res = await request("POST", "/api/jira/t5.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "ts5");
  assert.equal(res.body.needsClone, true);
  assert.deepEqual(agents.ts5.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", cmdId: res.body.cmdId },
  ]);
});

test("http: among org hosts with the repo, the most available one wins", async () => {
  // The splitting rule: N sessions on one org spread across its hosts instead of
  // stacking on whichever registered first.
  await ticketBeat("tsBusy", "tSplit.atlassian.net");
  await ticketBeat("tsFree", "tSplit.atlassian.net");
  agents.tsBusy.capacity = { maxSessions: 6, running: 5, queued: 0, free: 1 };
  agents.tsFree.capacity = { maxSessions: 6, running: 1, queued: 0, free: 5 };
  const res = await request("POST", "/api/jira/tSplit.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.body.host, "tsFree");
  assert.equal((agents.tsBusy.commands || []).length, 0);
});

test("http: a spawn already queued to a host lowers its availability", async () => {
  // Availability subtracts in-flight spawn commands, so two tickets clicked
  // between beats split instead of both landing on the same host.
  await ticketBeat("tsA", "tSplit2.atlassian.net", { key: "ENG-5" });
  await ticketBeat("tsB", "tSplit2.atlassian.net", { key: "ENG-6" });
  agents.tsA.capacity = { maxSessions: 6, running: 0, queued: 0, free: 6 };
  agents.tsB.capacity = { maxSessions: 6, running: 0, queued: 0, free: 6 };
  // First ticket: a tie, insertion order gives tsA.
  const one = await request("POST", "/api/jira/tSplit2.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(one.body.host, "tsA");
  // Second ticket before any beat reflects the first: tsA now has a pending
  // spawn, so the second goes to tsB.
  const two = await request("POST", "/api/jira/tSplit2.atlassian.net/ENG-6/session",
    { headers: userHeaders });
  assert.equal(two.body.host, "tsB");
});

test("http: an offline host is never queued a spawn — it 503s instead", async () => {
  // Unlike the read-only GET, which happily serves an offline host's cache: a
  // spawn landing whenever the host next wakes is a surprise, not a feature.
  await ticketBeat("ts6", "t6.atlassian.net");
  agents.ts6.lastSeen = Date.now() - 10 * 60 * 1000;
  const res = await request("POST", "/api/jira/t6.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /offline/);
  assert.equal((agents.ts6.commands || []).length, 0);
});

test("http: an untriaged ticket 409s rather than guessing a repo", async () => {
  await ticketBeat("ts7", "t7.atlassian.net", { repo: null });
  const res = await request("POST", "/api/jira/t7.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /triaged/);
  assert.equal((agents.ts7.commands || []).length, 0);
});

test("http: an unknown org 404s", async () => {
  const res = await request("POST", "/api/jira/nobody.atlassian.net/ENG-1/session",
    { headers: userHeaders });
  assert.equal(res.status, 404);
});

// POST /api/jira/<siteKey>/<issueKey>/agent — the operator's manual agent pin
// (XERK-38): which HOST a ticket's sessions spawn on. Hub-owned (routing is the
// hub's job) and durable (its own /data file), unlike the /repo override's
// agent-ledger fan-out — so the save is an authoritative 200, not a 202.

const setAgent = (site, key, body) =>
  request("POST", `/api/jira/${site}/${key}/agent`, { body, headers: userHeaders });

test("http: pinning a ticket's agent stores it; {auto:true} releases it", async () => {
  await jiraBeat("taA", "taSite.atlassian.net");
  await jiraBeat("taB", "taSite.atlassian.net");
  const res = await setAgent("taSite.atlassian.net", "ENG-1", { host: "taB" });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "taB");
  assert.equal(hub.ticketAgents["taSite.atlassian.net/ENG-1"].host, "taB");

  const rel = await setAgent("taSite.atlassian.net", "ENG-1", { auto: true });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.host, null);
  assert.ok(!("taSite.atlassian.net/ENG-1" in hub.ticketAgents));
});

test("http: the pin rides the /api/agents payload for the board to render", async () => {
  await jiraBeat("taPay", "taPay.atlassian.net");
  await setAgent("taPay.atlassian.net", "ENG-3", { host: "taPay" });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(res.body.ticketAgents["taPay.atlassian.net/ENG-3"].host, "taPay");
});

test("http: pinning validates the key, body, and host before storing", async () => {
  await jiraBeat("taV", "taV.atlassian.net");
  await jiraBeat("taOther", "taOtherOrg.atlassian.net");
  assert.equal((await setAgent("taV.atlassian.net", "12ab", { host: "taV" })).status, 400);
  assert.equal((await setAgent("taV.atlassian.net", "ENG-1", {})).status, 400);
  assert.equal((await setAgent("taV.atlassian.net", "ENG-1", { host: 42 })).status, 400);
  // A host of a DIFFERENT org is not on this org's picker; nor is a stranger.
  assert.equal((await setAgent("taV.atlassian.net", "ENG-1", { host: "taOther" })).status, 400);
  assert.equal((await setAgent("taV.atlassian.net", "ENG-1", { host: "ghost" })).status, 400);
  // An org nobody reports at all.
  assert.equal((await setAgent("nobody.atlassian.net", "ENG-1", { host: "taV" })).status, 404);
  assert.ok(!("taV.atlassian.net/ENG-1" in hub.ticketAgents));
});

test("http: an offline org host can still be pinned — the pin is about future spawns", async () => {
  await jiraBeat("taOffline", "taOff.atlassian.net");
  agents.taOffline.lastSeen = Date.now() - 10 * 60 * 1000;
  const res = await setAgent("taOff.atlassian.net", "ENG-1", { host: "taOffline" });
  assert.equal(res.status, 200);
  assert.equal(hub.ticketAgents["taOff.atlassian.net/ENG-1"].host, "taOffline");
});

test("http: pinning a ticket's agent requires the user login", async () => {
  await jiraBeat("taAuth", "taAuth.atlassian.net");
  const res = await request("POST", "/api/jira/taAuth.atlassian.net/ENG-1/agent",
    { body: { host: "taAuth" } });
  assert.equal(res.status, 401);
  assert.ok(!("taAuth.atlassian.net/ENG-1" in hub.ticketAgents));
});

test("http: a pinned ticket spawns on its pinned agent, not the most available", async () => {
  await ticketBeat("tpBusy", "tPin.atlassian.net");
  await ticketBeat("tpFree", "tPin.atlassian.net");
  agents.tpBusy.capacity = { maxSessions: 6, running: 5, queued: 0, free: 1 };
  agents.tpFree.capacity = { maxSessions: 6, running: 1, queued: 0, free: 5 };
  await setAgent("tPin.atlassian.net", "ENG-5", { host: "tpBusy" });
  const res = await request("POST", "/api/jira/tPin.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "tpBusy");
  assert.equal((agents.tpFree.commands || []).length, 0);
});

test("http: a spawn refuses — never reroutes — when the pinned agent is offline", async () => {
  // Routing elsewhere would contradict the one thing the pin asserts; the board
  // renders the reason beside a live retry button, and the panel shows the pin.
  await ticketBeat("tpOffA", "tPinOff.atlassian.net");
  await ticketBeat("tpOffB", "tPinOff.atlassian.net");
  await setAgent("tPinOff.atlassian.net", "ENG-5", { host: "tpOffB" });
  agents.tpOffB.lastSeen = Date.now() - 10 * 60 * 1000;
  const res = await request("POST", "/api/jira/tPinOff.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /pinned/);
  assert.equal((agents.tpOffA.commands || []).length, 0);
  assert.equal((agents.tpOffB.commands || []).length, 0);
});

test("http: a pin to a host that left the fleet is a clear 409", async () => {
  await ticketBeat("tpGoneA", "tPinGone.atlassian.net");
  await ticketBeat("tpGoneB", "tPinGone.atlassian.net");
  await setAgent("tPinGone.atlassian.net", "ENG-5", { host: "tpGoneB" });
  delete agents.tpGoneB;   // pruned after a week offline, or renamed
  const res = await request("POST", "/api/jira/tPinGone.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /pinned/);
  assert.equal((agents.tpGoneA.commands || []).length, 0);
});

test("http: a pinned agent without the repo clones on demand, like any routed host", async () => {
  await ticketBeat("tpHasRepo", "tPinClone.atlassian.net", { repos: ["Turma"] });
  await ticketBeat("tpNoRepo", "tPinClone.atlassian.net", { repos: ["Other"] });
  await setAgent("tPinClone.atlassian.net", "ENG-5", { host: "tpNoRepo" });
  const res = await request("POST", "/api/jira/tPinClone.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "tpNoRepo");
  assert.equal(res.body.needsClone, true);
});

test("ticket-agent pins survive a hub restart (read back from their own file)", () => {
  // "Persistent" is the point of the feature: the pin has its own durable file
  // on /data rather than riding the best-effort state.json.
  const file = path.join(os.tmpdir(), `turma-test-ta-persist-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({
    "o.atlassian.net/ENG-1": { host: "h1", at: 123 } }));
  try {
    const mod = freshServerModule((env) => { env.TICKET_AGENTS_FILE = file; });
    assert.equal(mod.ticketAgents["o.atlassian.net/ENG-1"].host, "h1");
  } finally {
    fs.unlinkSync(file);
  }
});

test("http: the freshest reporting block decides the repo", async () => {
  // board.js merges on freshest-block-wins, so the hub must resolve against the
  // same copy the operator actually clicked.
  await ticketBeat("tsOld", "t8.atlassian.net",
    { repo: "Stale", repos: ["Stale", "Fresh"], fetchedAt: "2026-07-14T10:00:00Z" });
  await ticketBeat("tsNew", "t8.atlassian.net",
    { repo: "Fresh", repos: ["Stale", "Fresh"], fetchedAt: "2026-07-14T12:00:00Z" });
  const res = await request("POST", "/api/jira/t8.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.body.repo, "Fresh");
});

test("http: a start rejects a non-issue-key path segment before routing", async () => {
  await ticketBeat("ts9", "t9.atlassian.net");
  for (const bad of ["..%2F..%2Fsecret", "ENG-42%3Fx%3D1", "12ab", "ENG-", "ENG%2042"]) {
    const res = await request("POST", `/api/jira/t9.atlassian.net/${bad}/session`,
      { headers: userHeaders });
    assert.equal(res.status, 400, `${bad} should be rejected`);
  }
  assert.equal((agents.ts9.commands || []).length, 0);
});

test("http: starting a ticket session requires the user login", async () => {
  await ticketBeat("ts10", "t10.atlassian.net");
  const res = await request("POST", "/api/jira/t10.atlassian.net/ENG-5/session");
  assert.equal(res.status, 401);
  assert.equal((agents.ts10.commands || []).length, 0);
});

// ---- auto-start To Do tickets (XERK-32) ---------------------------------------
// An org opts in via the HUB's per-org auto-start toggle (XERK-41 made this
// hub-only — no agent flag). The hub then starts a session for every To Do ticket
// with a repo assigned that has no session yet, routing each via the same
// splitting the manual Start button uses — so an org's work spreads across ALL its
// agents.

// A host reporting `site`, `repos` cloned, and a ticket list. The default ticket
// is a To Do ticket already triaged to Turma. `autoStart:true` (the default)
// also flips the org's HUB toggle on, since the opt-in is hub-only now.
const asBeat = async (device, site, {
  autoStart = true, repos = ["Turma"], capacity,
  sessions = [], closedSessions = [],
  tickets = [{ key: "ENG-5", summary: "Fix it", statusCategory: "todo",
               repoGuess: { repo: "Turma", cloned: true } }],
  fetchedAt = "2026-07-14T12:00:00Z",
} = {}) => {
  const r = await request("POST", "/api/heartbeat", {
    body: {
      device,
      repos: repos.map((name) => ({ name, path: `/git/${name}` })),
      sessions, closedSessions,
      ...(capacity ? { capacity } : {}),
      jira: { available: true, configured: true, siteKey: site,
              user: `${device}@x.com`, fetchedAt, tickets },
    },
    headers: agentHeaders,
  });
  if (autoStart) setAutoStartOrg(site, true);
  return r;
};

// Clear both the per-sweep once-guard and the hub opt-in map so each sweep test
// starts from a clean slate (no org left opted in by a prior test).
const resetAutoStart = () => {
  autoStarted.clear();
  for (const k of Object.keys(autoStartOrgs)) delete autoStartOrgs[k];
};

test("auto-start: a To Do ticket with a repo is queued once the org opts in", async () => {
  resetAutoStart();
  await asBeat("asHost", "as1.atlassian.net");
  autoStartSweep();
  assert.deepEqual((agents.asHost.commands || []).map((c) => [c.type, c.issueKey]),
    [["spawnTicket", "ENG-5"]]);
});

test("auto-start: does nothing until the org is opted in (off by default)", async () => {
  resetAutoStart();
  await asBeat("asOff", "as2.atlassian.net", { autoStart: false });
  autoStartSweep();
  assert.equal((agents.asOff.commands || []).length, 0);
});

test("auto-start: only To Do tickets, and only ones with a repo assigned", async () => {
  resetAutoStart();
  await asBeat("asFilter", "as3.atlassian.net", {
    tickets: [
      { key: "ENG-1", statusCategory: "inprogress",
        repoGuess: { repo: "Turma", cloned: true } },        // not To Do
      { key: "ENG-2", statusCategory: "todo", repoGuess: null }, // untriaged
      { key: "ENG-3", statusCategory: "todo",
        repoGuess: { repo: null, cloned: false } },           // "no repo fits"
      { key: "ENG-4", statusCategory: "todo",
        repoGuess: { repo: "Turma", cloned: true } },         // eligible
    ],
  });
  autoStartSweep();
  assert.deepEqual((agents.asFilter.commands || []).map((c) => c.issueKey), ["ENG-4"]);
});

test("auto-start: skips a ticket that already has a session (started manually or before)", async () => {
  resetAutoStart();
  // The ticket already carries a live session and a killed one — either alone is
  // enough to say "already started", so the hub must not open a second.
  await asBeat("asDup", "as4.atlassian.net", {
    sessions: [{ id: "s1", transcriptId: "t-live",
                 ticket: { key: "ENG-5", siteKey: "as4.atlassian.net" } }],
  });
  autoStartSweep();
  assert.equal((agents.asDup.commands || []).length, 0);

  // Same for a ticket whose only session was killed (in closedSessions): a
  // deliberate kill must not be resurrected by auto-start.
  autoStarted.clear();
  await asBeat("asDup2", "as5.atlassian.net", {
    closedSessions: [{ id: "s2", transcriptId: "t-killed",
                       ticket: { key: "ENG-5", siteKey: "as5.atlassian.net" } }],
  });
  autoStartSweep();
  assert.equal((agents.asDup2.commands || []).length, 0);
});

test("auto-start: a resumable-only session (durable, survives restart) still counts as started", async () => {
  resetAutoStart();
  await asBeat("asResume", "as6.atlassian.net", {
    repos: ["Turma"],
  });
  // The durable channel: a transcript the resumable scan re-derived, with no
  // registry record behind it. startedTicketKeys must read it too.
  agents.asResume.repos[0].resumable = [
    { transcriptId: "t-old", ticket: { key: "ENG-5", siteKey: "as6.atlassian.net" } },
  ];
  autoStartSweep();
  assert.equal((agents.asResume.commands || []).length, 0);
});

test("auto-start: fires each ticket at most once, even if the spawn left no session", async () => {
  resetAutoStart();
  await asBeat("asOnce", "as7.atlassian.net");
  autoStartSweep();
  assert.equal((agents.asOnce.commands || []).length, 1);
  // Simulate the agent acking the command and NOT producing a session (a refused
  // spawn): the in-flight and session guards both come up empty, so only the
  // once-set stops a re-queue every sweep.
  agents.asOnce.commands = [];
  autoStartSweep();
  assert.equal((agents.asOnce.commands || []).length, 0);
});

test("auto-start: an in-flight spawnTicket (e.g. a manual click) is not doubled", async () => {
  resetAutoStart();
  await asBeat("asInflight", "as8.atlassian.net");
  // A spawnTicket already queued by the /session route sits on the host.
  queueCommand("asInflight", { type: "spawnTicket", issueKey: "ENG-5" });
  autoStartSweep();
  assert.equal((agents.asInflight.commands || []).filter(
    (c) => c.type === "spawnTicket").length, 1);
});

test("auto-start: work spreads across ALL the org's agents (routes by availability)", async () => {
  // The two-agents case: the ORG is opted in (hub-only), and the session routes
  // by availability across BOTH its hosts — landing on the more-available one.
  resetAutoStart();
  await asBeat("asBusy", "as9.atlassian.net", {
    capacity: { maxSessions: 6, running: 5, queued: 0, free: 1 } });   // opts as9 in
  await asBeat("asFree", "as9.atlassian.net", {
    autoStart: false, capacity: { maxSessions: 6, running: 1, queued: 0, free: 5 } });
  autoStartSweep();
  // Routed to the most-available host, proving auto-start uses the same
  // fleet-wide splitting as the manual button.
  assert.deepEqual((agents.asFree.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal((agents.asBusy.commands || []).length, 0);
});

test("auto-start: honors a ticket's pinned agent over availability", async () => {
  resetAutoStart();
  await asBeat("asPinBusy", "asPin.atlassian.net",
    { capacity: { maxSessions: 6, running: 5, queued: 0, free: 1 } });
  await asBeat("asPinFree", "asPin.atlassian.net",
    { capacity: { maxSessions: 6, running: 1, queued: 0, free: 5 } });
  await setAgent("asPin.atlassian.net", "ENG-5", { host: "asPinBusy" });
  autoStartSweep();
  assert.deepEqual((agents.asPinBusy.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal((agents.asPinFree.commands || []).length, 0);
});

test("auto-start: a pinned agent that's offline retries later, never reroutes", async () => {
  resetAutoStart();
  await asBeat("asPinOffA", "asPinOff.atlassian.net");
  await asBeat("asPinOffB", "asPinOff.atlassian.net");
  await setAgent("asPinOff.atlassian.net", "ENG-5", { host: "asPinOffB" });
  agents.asPinOffB.lastSeen = Date.now() - 10 * 60 * 1000;
  autoStartSweep();
  // Not rerouted around the pin, and left UNrecorded so a later sweep retries.
  assert.equal((agents.asPinOffA.commands || []).length, 0);
  assert.equal((agents.asPinOffB.commands || []).length, 0);
  assert.ok(!autoStarted.has("asPinOff.atlassian.net\x00ENG-5"));
  // The pinned host comes back — the next sweep spawns there.
  agents.asPinOffB.lastSeen = Date.now();
  autoStartSweep();
  assert.deepEqual((agents.asPinOffB.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("auto-start: an org with every host offline queues nothing until one returns", async () => {
  resetAutoStart();
  await asBeat("asStale", "as10.atlassian.net");        // opts the org in
  agents.asStale.lastSeen = Date.now() - 10 * 60 * 1000; // offline
  // The opt-in is durable hub state, so the org stays "on"...
  assert.equal(orgsWithAutoStart().has("as10.atlassian.net"), true);
  // ...but with no online host to route to, the sweep queues nothing.
  autoStartSweep();
  assert.equal((agents.asStale.commands || []).length, 0);
  // The host returns — the next sweep spawns there.
  agents.asStale.lastSeen = Date.now();
  autoStartSweep();
  assert.deepEqual((agents.asStale.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

// ---- per-org auto-start opt-in from the hub (XERK-41) -------------------------

test("auto-start: the hub-side org toggle is the ONLY opt-in", async () => {
  resetAutoStart();
  // A reporting host is not enough — the org is off until the hub toggle is set.
  await asBeat("asHub", "ashub.atlassian.net", { autoStart: false });
  assert.equal(orgsWithAutoStart().has("ashub.atlassian.net"), false);
  autoStartSweep();
  assert.equal((agents.asHub.commands || []).length, 0);
  // The toggle drives the sweep.
  setAutoStartOrg("ashub.atlassian.net", true);
  assert.equal(orgsWithAutoStart().has("ashub.atlassian.net"), true);
  autoStartSweep();
  assert.deepEqual((agents.asHub.commands || []).map((c) => [c.type, c.issueKey]),
    [["spawnTicket", "ENG-5"]]);
  setAutoStartOrg("ashub.atlassian.net", false); // leave global state clean
});

test("POST /api/jira/<site>/autostart flips the opt-in and rides the payload", async () => {
  await asBeat("asApi", "asapi.atlassian.net", { autoStart: false });

  // Enable it.
  let r = await request("POST", "/api/jira/asapi.atlassian.net/autostart",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, enabled: true });
  assert.equal(autoStartOrgs["asapi.atlassian.net"], true);

  // It rides the fleet payload as a top-level bool map.
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.autoStartOrgs["asapi.atlassian.net"], true);

  // Disable it — the key is removed (presence = enabled).
  r = await request("POST", "/api/jira/asapi.atlassian.net/autostart",
    { body: { enabled: false }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal("asapi.atlassian.net" in autoStartOrgs, false);
});

test("POST /api/jira/<site>/autostart rejects a bad body and an unknown org", async () => {
  await asBeat("asApi2", "asapi2.atlassian.net", { autoStart: false });
  // Missing/!boolean enabled.
  let r = await request("POST", "/api/jira/asapi2.atlassian.net/autostart",
    { body: {}, headers: userHeaders });
  assert.equal(r.status, 400);
  r = await request("POST", "/api/jira/asapi2.atlassian.net/autostart",
    { body: { enabled: "yes" }, headers: userHeaders });
  assert.equal(r.status, 400);
  // An org no host reports can't be toggled (no phantom entries).
  r = await request("POST", "/api/jira/nobody.atlassian.net/autostart",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody.atlassian.net" in autoStartOrgs, false);
});

test("POST /api/jira/<site>/autostart needs the user login", async () => {
  await asBeat("asApi3", "asapi3.atlassian.net", { autoStart: false });
  const r = await request("POST", "/api/jira/asapi3.atlassian.net/autostart",
    { body: { enabled: true } });
  assert.equal(r.status, 401);
  assert.equal("asapi3.atlassian.net" in autoStartOrgs, false);
});

// ---- auto-stop a session when its ticket moves to Done (XERK-45) --------------
// The lifecycle counterpart to auto-start: the SAME per-org "auto" opt-in that
// starts a To Do ticket's session KILLS a session once its ticket reaches Done. A
// human moving a ticket to Done is the "work finished" signal; the kill ends the
// session cleanly (resumable, worktree/PRs kept) and frees its MAX_SESSIONS slot.

// A Done ticket already being worked by a live session on the reporting host.
const doneBeat = (device, site, {
  status = "running", key = "ENG-9", ticketSite = site,
  statusCategory = "done", extraSessions = [],
} = {}) =>
  asBeat(device, site, {
    tickets: [{ key, summary: "Shipped", statusCategory,
                repoGuess: { repo: "Turma", cloned: true } }],
    sessions: [{ id: "sd1", status, ticket: { key, siteKey: ticketSite } },
               ...extraSessions],
  });

test("auto-stop: a Done ticket's live session is killed once the org opts in", async () => {
  autoStopped.clear();
  await doneBeat("apHost", "ap1.atlassian.net");
  autoStopSweep();
  assert.deepEqual((agents.apHost.commands || []).map((c) => [c.type, c.sessionId]),
    [["kill", "sd1"]]);
});

test("auto-stop: does nothing while the flag is off (the default)", async () => {
  autoStopped.clear();
  await asBeat("apOff", "ap2.atlassian.net", {
    autoStart: false,
    tickets: [{ key: "ENG-9", statusCategory: "done",
                repoGuess: { repo: "Turma", cloned: true } }],
    sessions: [{ id: "sd1", status: "running",
                 ticket: { key: "ENG-9", siteKey: "ap2.atlassian.net" } }],
  });
  autoStopSweep();
  assert.equal((agents.apOff.commands || []).length, 0);
});

test("auto-stop: only Done tickets — an active ticket's session keeps running", async () => {
  autoStopped.clear();
  await doneBeat("apActive", "ap3.atlassian.net", { statusCategory: "inprogress" });
  autoStopSweep();
  assert.equal((agents.apActive.commands || []).length, 0);
});

test("auto-stop: only LIVE sessions — a stopped/error one is not killed", async () => {
  autoStopped.clear();
  await doneBeat("apStop", "ap4.atlassian.net", {
    status: "stopped",
    extraSessions: [{ id: "sd-err", status: "error",
                      ticket: { key: "ENG-9", siteKey: "ap4.atlassian.net" } }],
  });
  autoStopSweep();
  assert.equal((agents.apStop.commands || []).length, 0);
});

test("auto-stop: a queued session for an already-Done ticket is cancelled", async () => {
  autoStopped.clear();
  await doneBeat("apQ", "ap5.atlassian.net", { status: "queued" });
  autoStopSweep();
  assert.deepEqual((agents.apQ.commands || []).map((c) => [c.type, c.sessionId]),
    [["kill", "sd1"]]);
});

test("auto-stop: kills EVERY live session on the Done ticket (two branches / restart)", async () => {
  autoStopped.clear();
  await doneBeat("apMany", "ap6.atlassian.net", {
    extraSessions: [{ id: "sd2", status: "running",
                      ticket: { key: "ENG-9", siteKey: "ap6.atlassian.net" } }],
  });
  autoStopSweep();
  assert.deepEqual((agents.apMany.commands || []).map((c) => c.sessionId).sort(),
    ["sd1", "sd2"]);
});

test("auto-stop: fires each session at most once, across repeated sweeps", async () => {
  autoStopped.clear();
  await doneBeat("apOnce", "ap7.atlassian.net");
  autoStopSweep();
  autoStopSweep();
  assert.equal((agents.apOnce.commands || []).filter((c) => c.type === "kill").length, 1);
});

test("http: /api/agents does not serialize the jiraIssues cache (served only by /api/jira)", async () => {
  await jiraBeat("jd9", "org9.atlassian.net", {
    jiraIssueResults: [{ key: "ENG-1", issue: { key: "ENG-1", description: "x".repeat(500) }, error: null }],
  });
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  for (const a of list.body.agents) {
    assert.ok(!("jiraIssues" in a), `agent ${a.key} leaked its ticket cache into /api/agents`);
  }
  // The `jira` block itself (the board's tickets) still ships, though.
  const rec = list.body.agents.find((a) => a.key === "jd9");
  assert.equal(rec.jira.siteKey, "org9.atlassian.net");
});

test("http: ticket cache eviction — older than 10 minutes dropped, capped at 40 issues", async () => {
  await jiraBeat("jdA", "orgA.atlassian.net", {
    jiraIssueResults: [{ key: "OLD-1", issue: { key: "OLD-1" }, error: null }],
  });
  agents.jdA.jiraIssues["OLD-1"].fetchedAt = Date.now() - 11 * 60 * 1000;
  await jiraBeat("jdA", "orgA.atlassian.net"); // any ingest re-sweeps
  assert.equal(agents.jdA.jiraIssues["OLD-1"], undefined);

  for (let i = 1; i <= 41; i++) {
    await jiraBeat("jdA", "orgA.atlassian.net", {
      jiraIssueResults: [{ key: `E-${i}`, issue: { key: `E-${i}` }, error: null }],
    });
  }
  const keys = Object.keys(agents.jdA.jiraIssues);
  assert.equal(keys.length, 40, "cache should be capped at 40 issues");
  assert.ok(!keys.includes("E-1"), "oldest issue should have been evicted");
  assert.ok(keys.includes("E-41"), "newest issue should remain");
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
        transcriptId: "conv-ls1",
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

  // 2. The agent was told to start tailing, with everything it needs to find
  //    the transcript: the worktree path (-> the project dir) and the id naming
  //    this session's own conversation inside it. Root sessions share one
  //    project dir, so without the id the agent tails the newest transcript
  //    there — the previous root session's (XERK-6).
  const watch = await nextTextJson(ctrlFrames, 0);
  assert.equal(watch.watch, "ls1");
  assert.equal(watch.worktreePath, "/wt/ls1");
  assert.equal(watch.transcriptId, "conv-ls1");

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
  // An agent predating the queued field: the hub normalises to [].
  assert.deepEqual(relayed.queued, []);

  // 3a. Still-queued prompts (typed mid-turn; foldQueueOp in tunnel-agent.js)
  //     ride beside the entries and reach the live client.
  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify(
    { tail: "ls1", entries: delta.entries, queued: ["also do X"] }))));
  const queuedFrame = await nextTextJson(liveFrames, 2);
  assert.equal(queuedFrame.type, "tail");
  assert.deepEqual(queuedFrame.queued, ["also do X"]);

  // 3b. A live `turn` delta (in-progress assistant text from the TUI) is fanned
  //     out too, including the empty-string clear on completion.
  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ turn: "ls1", text: "streaming…" }))));
  const turn = await nextTextJson(liveFrames, 3);
  assert.equal(turn.type, "turn");
  assert.equal(turn.text, "streaming…");
  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({ turn: "ls1", text: "" }))));
  const cleared = await nextTextJson(liveFrames, 4);
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
    sessions: [{ id: "rs1", worktreePath: "/wt/rs1", transcriptId: "conv-rs1",
      session: { tail: [] } }],
  };

  // Watcher attaches while the tunnel is offline (no control channel yet).
  const token = await issueToken();
  const live = await wsConnect(`/live/rehost/rs1?auth=${token}`);
  assert.match(live.statusLine, /^HTTP\/1\.1 101/);

  // Now the tunnel connects — it must be told to watch the already-attached
  // session, and re-armed with the same target a first watch would carry.
  const ctrl = await wsConnect(`/agent/control?name=rehost&token=agenttok`);
  const ctrlFrames = collectFrames(ctrl.socket, ctrl.leftover);
  const watch = await nextTextJson(ctrlFrames, 0);
  assert.equal(watch.watch, "rs1");
  assert.equal(watch.worktreePath, "/wt/rs1");
  assert.equal(watch.transcriptId, "conv-rs1");

  live.socket.destroy();
  ctrl.socket.destroy();
  delete agents.rehost;
});

test("live WS: a watched session whose transcript MOVES is re-armed onto the new one", async () => {
  // "Restart (clear context)" relaunches claude on a fresh transcript. A watch
  // is otherwise sent once and held for its lifetime, so without a re-arm the
  // agent keeps tailing a file the session will never write to again and the
  // chat freezes on the pre-restart conversation.
  const beat = (transcriptId) => request("POST", "/api/heartbeat", {
    body: {
      device: "movehost",
      sessions: [{ id: "ms1", worktreePath: "/wt/ms1", transcriptId, session: { tail: [] } }],
    },
    headers: agentHeaders,
  });
  await beat("conv-one");

  const ctrl = await wsConnect(`/agent/control?name=movehost&token=agenttok`);
  const ctrlFrames = collectFrames(ctrl.socket, ctrl.leftover);
  const token = await issueToken();
  const live = await wsConnect(`/live/movehost/ms1?auth=${token}`);
  assert.match(live.statusLine, /^HTTP\/1\.1 101/);

  // finally, not a tail of straight-line destroys: an open socket keeps the
  // run's event loop alive, so a failing assertion here would hang the suite
  // instead of reporting itself.
  try {
    const first = await nextTextJson(ctrlFrames, 0);
    assert.equal(first.transcriptId, "conv-one");

    // A beat reporting the same transcript is not a move — nothing is re-sent.
    await beat("conv-one");
    // The restart lands: a new conversation, so the watch follows it.
    await beat("conv-two");
    // Frame 1 is the SECOND control frame ever sent. Asserting the move landed
    // there is also what proves the unchanged beat above sent nothing: had it
    // re-armed, this would read conv-one.
    const rearm = await nextTextJson(ctrlFrames, 1);
    assert.equal(rearm.watch, "ms1");
    assert.equal(rearm.worktreePath, "/wt/ms1");
    assert.equal(rearm.transcriptId, "conv-two");
  } finally {
    live.socket.destroy();
    ctrl.socket.destroy();
    delete agents.movehost;
  }
});

// ---- /api/agents ETag + 304 (FIX 3/#9) --------------------------------------

test("/api/agents: emits an ETag; unchanged If-None-Match -> 304; state change re-etags", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "etag-host" }, headers: agentHeaders });

  // Earlier tests' torn-down control sockets surface as ASYNC close events
  // ("tunnel gone: …" → publishAgent → invalidateAgentsCache) that can land
  // between this test's two GETs; the rebuilt body embeds a fresh `now`, so a
  // stray invalidation re-etags with no real state change and the 304 reads
  // 200. Retry until two consecutive GETs agree — the world has settled — then
  // assert the invariant: absent state changes, revalidation 304s.
  let first, notMod;
  for (let i = 0; i < 10; i++) {
    first = await request("GET", "/api/agents", { headers: userHeaders });
    assert.equal(first.status, 200);
    notMod = await request("GET", "/api/agents", {
      headers: { ...userHeaders, "if-none-match": first.headers.etag },
    });
    if (notMod.status === 304) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const etag = first.headers.etag;
  assert.ok(etag, "no ETag on /api/agents");
  // no-cache (not no-store) so the browser keeps the body + revalidates.
  assert.match(first.headers["cache-control"], /no-cache/);

  // Same ETag echoed back -> cheap 304, empty body.
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

// ---- agent control channel: liveness ---------------------------------------
// The hub half of the wedged-tunnel fix. The agent cannot see a protocol ping
// (Node's built-in WebSocket handles 0x9 internally and exposes no ping event),
// so the hub must also beat an app-level {ping} it CAN see — that frame is the
// whole reason a restarted hub no longer strands every terminal. The 0x9 stays
// for Cloudflare's idle timeout and for the pong that proves the agent is live.

const CONTROL_PATH = "/agent/control?name=livehost&token=agenttok";

// Wait for a frame matching `pred`, or resolve null. Frames arrive on a beat,
// so this polls the array collectFrames fills rather than racing a single read.
const waitFrame = (frames, pred, ms = 2000) =>
  new Promise((resolve) => {
    const t = setInterval(() => {
      const hit = frames.find(pred);
      if (hit) {
        clearInterval(t);
        clearTimeout(k);
        resolve(hit);
      }
    }, 10);
    const k = setTimeout(() => {
      clearInterval(t);
      resolve(null);
    }, ms);
  });

const jsonFrame = (f) => {
  if (f.op !== 0x1) return null;
  try { return JSON.parse(f.payload.toString("utf8")); } catch { return null; }
};

test("control WS: hub beats an app-level {ping} the agent can actually see", async () => {
  const { socket, statusLine, leftover } = await wsConnect(CONTROL_PATH);
  try {
    assert.match(statusLine, /101/);
    const frames = collectFrames(socket, leftover);
    // The app-level ping: a text frame, because the protocol ping below is
    // invisible to the agent's WebSocket client.
    const ping = await waitFrame(frames, (f) => jsonFrame(f) && jsonFrame(f).ping);
    assert.ok(ping, "hub never sent an app-level {ping} — agents cannot detect a dead hub without it");
    // And the protocol ping is still there (Cloudflare idle timeout + pong).
    assert.ok(await waitFrame(frames, (f) => f.op === 0x9), "hub stopped sending the protocol ping");
  } finally {
    socket.destroy();
  }
});

test("control WS: a channel that never pongs is dropped, so terminalOnline stops lying", async () => {
  const { socket, leftover } = await wsConnect(CONTROL_PATH);
  try {
    collectFrames(socket, leftover);
    // This raw socket answers nothing — a half-open channel to a host that died
    // without a FIN. The hub must reap it rather than keep reporting the host's
    // terminal as online while every Attach hangs.
    const closed = await new Promise((resolve) => {
      socket.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    assert.ok(closed, "hub kept a silent (half-open) control channel forever");
  } finally {
    socket.destroy();
  }
});

test("control WS: a channel that pongs is kept past the dead-after window", async () => {
  const { socket, leftover } = await wsConnect(CONTROL_PATH);
  try {
    // Mirror what a real agent's WebSocket does for free: auto-pong every ping.
    // Client->server frames must be masked, so encode by hand.
    const parse = wsParser((op) => {
      if (op !== 0x9) return;
      const mask = Buffer.from([1, 2, 3, 4]);
      socket.write(Buffer.concat([Buffer.from([0x80 | 0xa, 0x80]), mask]));
    });
    if (leftover && leftover.length) parse(leftover);
    socket.on("data", parse);
    const closed = await new Promise((resolve) => {
      socket.on("close", () => resolve(true));
      // Well past CONTROL_DEAD_AFTER_MS: a ponging peer must survive.
      setTimeout(() => resolve(false), 1500);
    });
    assert.ok(!closed, "hub dropped a live channel that was answering its pings");
  } finally {
    socket.destroy();
  }
});
