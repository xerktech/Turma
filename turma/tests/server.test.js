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
const crypto = require("crypto");
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
// Same trick for the create single-flight's expiry (XERK-241): the fleet gives
// an unresolved create 60s to rejoin a retry, which is only testable wound down.
process.env.CREATE_INFLIGHT_TTL_MS = "300";
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
process.env.TICKET_MODELS_FILE = path.join(
  os.tmpdir(),
  `turma-test-ticket-models-${process.pid}.json`
);
process.env.ORG_COLORS_FILE = path.join(
  os.tmpdir(),
  `turma-test-org-colors-${process.pid}.json`
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
// Real alerts carry a title; retractions (XERK-154) are title-less data-only
// messages, so titles() naturally excludes them and dismisses() reads their key.
const titles = () => notifications.filter((n) => n.title != null).map((n) => n.title);
const dismisses = () => notifications.filter((n) => n.data?.action === "dismiss").map((n) => n.data.notifKey);

const hub = require("../server.js");
// notify() no-ops when no device is registered; register one so the alert tests
// see the fan-out. Real fan-out/pruning is exercised separately below.
hub.registerDevice("capture-device", "android", ["dismiss"]);
const {
  server, agents, queueCommand, findSession,
  wsAccept, wsEncode, wsParser, channelDuplex,
  heartbeatAlerts, prAlertDecision, readyForReview, sessionWorking, sanitizeLiveAgents,
  invalidateAgentsCache, sanitizeHeartbeat, agentRecordSize, safeAgentsCache,
  serializeAgentsForSave,
  HEARTBEAT_UNKNOWN_MAX, AGENT_RECORD_MAX,
  userAuthorized, agentAuthorized, agentWsAuthorized, triggerAuthorized, fmtDur,
  credentialsMatch, issueSessionToken, sessionTokenValid,
  pcmToWav, transcribePcm, issueWsToken, wsTokenValid,
  TERM_OSC52_JS,
  autoStartSweep, autoStopSweep, startedTicketKeys, orgsWithAutoStart, autoStarted,
  autoStopped, autoStartOrgs, setAutoStartOrg,
  orgColors, setOrgColor,
  migrations, advanceMigrations,
  safeUploadName, uploadCapFor, uploads, UPLOAD_MAX_PER_MESSAGE,
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

// XERK-245: a session that delegated work and ended its own turn paints no
// interrupt hint, so paneBusy says false while a background agent is plainly
// still running. `agents` is the signal that says so.
test("sessionWorking: live background agents work even with paneBusy false", () => {
  const now = Date.now();
  const bg = { paneBusy: false, transcriptAgeSec: 999, agents: [{ type: "qa", label: "QA it" }] };
  assert.equal(sessionWorking({ session: bg }, now, now), true);
  // An empty list is "no agents", not "can't tell" — paneBusy still decides.
  assert.equal(
    sessionWorking({ session: { paneBusy: false, transcriptAgeSec: 999, agents: [] } }, now, now),
    false);
  // An agent predating the field sends none: behaviour is exactly as it was.
  assert.equal(
    sessionWorking({ session: { paneBusy: false, transcriptAgeSec: 999 } }, now, now), false);
  // It stays BEHIND the offline and no-transcript rules, like paneBusy: a host
  // that died mid-run must not leave its sessions reading working forever.
  assert.equal(sessionWorking({ session: bg }, now - 120000, now), false);
  assert.equal(sessionWorking({ session: { agents: bg.agents } }, now, now), false);
});

// XERK-245. The `turn` frame's agent rows cross the agent->hub->browser boundary
// and are the ONLY input to the chat's persistent bar, so the hub re-shapes them
// rather than forwarding raw: one `null` element threw in agentsHtml and cost a
// repaint, and nothing else bounds the list.
test("sanitizeLiveAgents: coerces rows, drops junk, bounds the list", () => {
  assert.deepEqual(
    sanitizeLiveAgents([{ sel: 1, type: "qa", label: "QA it" }]),
    [{ sel: true, type: "qa", label: "QA it" }]);
  // Non-objects and empty types are dropped, not rendered.
  assert.deepEqual(sanitizeLiveAgents([null, 7, "x", {}, { type: "" }, { type: "ok" }]),
    [{ sel: false, type: "ok", label: "" }]);
  // Absent (older agent) stays null — "can't report", not "none running".
  assert.equal(sanitizeLiveAgents(undefined), null);
  assert.equal(sanitizeLiveAgents("nope"), null);
  // Bounded in count and per-field length.
  assert.equal(sanitizeLiveAgents(Array.from({ length: 500 }, () => ({ type: "a" }))).length, 32);
  assert.equal(sanitizeLiveAgents([{ type: "a".repeat(9999) }])[0].type.length, 400);
});

test("heartbeat: a session's agent rows are sanitized on the way in", async () => {
  const host = "agents-host";
  const r = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: {
      device: host,
      sessions: [{ id: "s1", status: "running", session: {
        paneBusy: false, transcriptAgeSec: 5,
        agents: [null, { type: "qa", label: "QA it" }, { type: "" }],
      } }],
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(agents[host].sessions[0].session.agents,
    [{ sel: false, type: "qa", label: "QA it" }]);
});

// The whole agent -> hub -> browser path for the frame's agent rows, over real
// sockets. A QA mutation pass deleted this forwarding and every suite stayed
// green, because nothing in CI crossed the two upgrade handlers (XERK-245).
test("live: a turn frame's agent rows reach the browser socket", async () => {
  const host = "wire-host";
  const sid = "wire-sid";
  await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, sessions: [{ id: sid, status: "running", repo: "r",
      worktreePath: "/w", transcriptId: "t1", session: { transcriptAgeSec: 1 } }] },
  });
  const tok = (await request("GET", "/api/ws-token", { headers: userHeaders })).body.token;

  const upgrade = (pathName) => new Promise((resolve, reject) => {
    const sock = net.connect(server.address().port, "127.0.0.1", () => {
      sock.write(
        `GET ${pathName} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`);
    });
    let seen = "";
    const onData = (b) => {
      seen += b.toString("latin1");
      if (!seen.includes("\r\n\r\n")) return;
      sock.removeListener("data", onData);
      if (!/ 101 /.test(seen)) return reject(new Error("no upgrade: " + seen.slice(0, 60)));
      resolve(sock);
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });

  const browser = await upgrade(`/live/${host}/${sid}?auth=${encodeURIComponent(tok)}`);
  const frames = [];
  browser.on("data", (buf) => {
    // Server->client frames here are small, unmasked, single JSON payloads.
    for (let off = 0; off + 2 <= buf.length;) {
      const op = buf[off] & 0x0f;
      let len = buf[off + 1] & 0x7f, p = off + 2;
      if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
      if (p + len > buf.length) break;
      const payload = buf.slice(p, p + len).toString("utf8");
      off = p + len;
      if (op !== 0x1) continue;
      try { frames.push(JSON.parse(payload)); } catch {}
    }
  });
  const agentSock = await upgrade(`/agent/control?name=${host}&token=agenttok`);
  const maskedText = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
  };

  // The sockets MUST be closed even when an assertion throws: an open one keeps
  // `test.after`'s server.close() pending, which hangs the whole run instead of
  // failing it.
  try {
    // The turn is OVER (status null) with a background agent still running, plus
    // a junk element the hub must drop rather than pass to the browser.
    agentSock.write(maskedText({ turn: sid, text: "", status: null,
      agents: [null, { sel: false, type: "qa", label: "QA it" }] }));
    for (let i = 0; i < 60 && !frames.some((f) => f.type === "turn"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const turn = frames.find((f) => f.type === "turn");
    assert.ok(turn, "the browser socket received the turn frame");
    assert.equal(turn.status, null, "no running turn is faked");
    assert.deepEqual(turn.agents, [{ sel: false, type: "qa", label: "QA it" }]);
  } finally {
    agentSock.destroy();
    browser.destroy();
  }
});

test("readyForReview: a session waiting on background agents is not ready", () => {
  // The regression this closes: the turn ends the moment the agent is launched,
  // leaving lastRole=assistant with no tool call — which qualified the session
  // as Ready for review and buzzed the operator's phone mid-run.
  const now = Date.now();
  const session = {
    status: "running",
    session: { paneBusy: false, transcriptAgeSec: 5, lastRole: "assistant", lastHasToolUse: false,
      agents: [{ type: "qa", label: "QA the parity change" }] },
  };
  assert.equal(sessionWorking(session, now, now), true);
  assert.equal(readyForReview(session, sessionWorking(session, now, now)), false);
  // Once the agent finishes the list empties and it qualifies as it always did.
  session.session.agents = [];
  assert.equal(readyForReview(session, sessionWorking(session, now, now)), true);
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

test("alerts: claude login-required fires once, restores once (XERK-98)", () => {
  const beat = makeHost();
  const now = Date.now();
  notifications.length = 0;
  // Lapsed login: the urgent edge fires once, high priority, routed to host.
  beat({ device: "truenas", claudeAuth: { needsLogin: true } }, now);
  assert.deepEqual(titles(), ["Claude login required on truenas"]);
  assert.equal(notifications[0].data.priority, "high");
  assert.equal(notifications[0].data.host, "host1"); // routed by agent key, like every host alert
  notifications.length = 0;
  beat({ device: "truenas", claudeAuth: { needsLogin: true } }, now + 20000); // still lapsed: quiet
  assert.deepEqual(titles(), []);
  // Operator logs in: the restore fires once and re-arms the edge.
  beat({ device: "truenas", claudeAuth: { needsLogin: false } }, now + 40000);
  assert.deepEqual(titles(), ["Claude login restored on truenas"]);
  notifications.length = 0;
  beat({ device: "truenas", claudeAuth: { needsLogin: false } }, now + 60000);
  assert.deepEqual(titles(), []);
  beat({ device: "truenas", claudeAuth: { needsLogin: true } }, now + 80000); // lapses again: fires again
  assert.deepEqual(titles(), ["Claude login required on truenas"]);
});

test("alerts: claude login-expiring warns once, superseded by needsLogin (XERK-98)", () => {
  const beat = makeHost();
  const now = Date.now();
  notifications.length = 0;
  const soon = { needsLogin: false, expiringSoon: true, refreshExpiresAt: now + 2 * 24 * 3600 * 1000 };
  beat({ device: "truenas", claudeAuth: soon }, now);
  assert.deepEqual(titles(), ["Claude login expiring on truenas"]);
  assert.equal(notifications[0].data.priority, "default");
  notifications.length = 0;
  beat({ device: "truenas", claudeAuth: soon }, now + 20000); // still expiring: quiet
  assert.deepEqual(titles(), []);
  // It fully lapses — the hard edge fires, and recovering from THAT must not
  // re-fire a stale "expiring" warning.
  beat({ device: "truenas", claudeAuth: { needsLogin: true } }, now + 40000);
  assert.deepEqual(titles(), ["Claude login required on truenas"]);
  notifications.length = 0;
  beat({ device: "truenas", claudeAuth: { needsLogin: false, expiringSoon: false } }, now + 60000);
  assert.deepEqual(titles(), ["Claude login restored on truenas"]); // restore only, no expiring re-fire
});

test("alerts: no claude-login alert when the agent reports no block (older agent)", () => {
  const beat = makeHost();
  notifications.length = 0;
  beat({ device: "truenas" }); // no claudeAuth key at all
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

test("alerts: a retraction is withheld from a build that lacks dismiss support (XERK-154)", () => {
  // An older app registered before it understood dismisses — it must still get
  // the alert, but a dismiss would show as a blank notification on it.
  hub.registerDevice("legacy-nofeat", "android"); // no features declared
  const beat = makeHost();
  const withQ = (q) => ({ sessions: [{ id: "sL", rcName: "r", session: q ? { question: q } : {} }] });
  notifications.length = 0;
  beat(withQ("Ship it?"));
  assert.ok(notifications[0].tokens.includes("legacy-nofeat"), "the alert itself reaches every device");
  notifications.length = 0;
  beat(withQ(null)); // answered -> dismiss
  const d = notifications.find((n) => n.data?.action === "dismiss");
  assert.ok(d, "a dismiss was sent");
  assert.ok(d.tokens.includes("capture-device"), "to the dismiss-capable device");
  assert.ok(!d.tokens.includes("legacy-nofeat"), "but withheld from the legacy one");
  hub.unregisterDevice("legacy-nofeat"); // keep the shared registry clean for other tests
});

test("alerts: answering a question retracts its notification (XERK-154)", () => {
  const beat = makeHost();
  const withQ = (q) => ({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", session: q ? { question: q } : {} }],
  });
  notifications.length = 0;
  beat(withQ("Deploy to prod?"));
  assert.deepEqual(titles(), ["nas-repo-s1 has a question"]);
  assert.equal(notifications[0].data.notifKey, "question:host1:s1"); // posted under a stable key
  notifications.length = 0;
  beat(withQ(null)); // answered from the desktop: retract, no new alert
  assert.deepEqual(titles(), []);
  assert.deepEqual(dismisses(), ["question:host1:s1"]);
  notifications.length = 0;
  beat(withQ(null)); // still no question: the retract fired once, on the edge
  assert.deepEqual(dismisses(), []);
});

// ---- The ready-for-review alert, held until CI is green --------------------
// XERK-153 (hold a PR alert until its CI settles) collapsed into XERK-224's one
// per-session alert: a session that finished a turn AND opened a PR is ONE
// piece of work, so it gets one notification, worded for the PR when there is
// one. The hold, its verdicts and its backstop are unchanged.

const PR_URL = "https://github.com/xerktech/Turma/pull/34";
const MIN = 60 * 1000;
const READY = "nas-repo-s1 is ready for review";

// One beat's worth of a session that has opened `urls` and whose PR statuses
// currently read `prs`. `newPrUrls` is the per-beat scrape; `prs` is the
// slower-cadence status the agent attaches to the session record.
const prBeat = (urls, prs) => ({
  sessions: [{
    id: "s1", rcName: "nas-repo-s1", status: "running",
    prs: prs || null,
    session: { newPrUrls: urls },
  }],
});

test("alerts: the ready-for-review alert waits for the CI rollup to come back green", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  // Scraped out of the transcript, but the agent hasn't fetched its status yet:
  // the URL alone says nothing about CI, so nothing fires.
  beat(prBeat([PR_URL]), t0);
  assert.deepEqual(titles(), []);
  // First status refresh lands, checks still queued.
  beat(prBeat([], [{ url: PR_URL, checks: "pending" }]), t0 + MIN);
  assert.deepEqual(titles(), []);
  // Green.
  beat(prBeat([], [{ url: PR_URL, checks: "passing" }]), t0 + 2 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.equal(notifications[0].data.click, PR_URL);
  assert.match(notifications[0].body, /All checks passed/);
  assert.match(notifications[0].body, new RegExp(PR_URL.replace(/[/.]/g, "\\$&")));
  // Still green on later beats: fires once, like every other alert.
  notifications.length = 0;
  beat(prBeat([], [{ url: PR_URL, checks: "passing" }]), t0 + 3 * MIN);
  assert.deepEqual(titles(), []);
});

test("alerts: a PR with no CI fires on its own, once the empty rollup holds", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  beat(prBeat([PR_URL]), t0);
  // `checks: null` on a fetched status means "no checks at all" — but a
  // brand-new PR reads that way too while its workflows register, so the
  // verdict has to hold before it counts.
  beat(prBeat([], [{ url: PR_URL, checks: null }]), t0 + MIN);
  assert.deepEqual(titles(), []);
  beat(prBeat([], [{ url: PR_URL, checks: null }]), t0 + 3 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.match(notifications[0].body, /No CI configured/);
});

test("alerts: a conflicting PR stays quiet until the conflict is resolved (XERK-223)", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  beat(prBeat([PR_URL]), t0);
  // Green CI, but the branch conflicts with its base: it merges nowhere, so
  // announcing it as ready with "all checks passed" would be a lie.
  const conflicted = { url: PR_URL, state: "OPEN", checks: "passing", mergeable: "CONFLICTING",
    ready: "blocked" };
  beat(prBeat([], [conflicted]), t0 + MIN);
  assert.deepEqual(titles(), []);
  // Not even past the age-out backstop — this state is known-bad, not unknown.
  beat(prBeat([], [conflicted]), t0 + 40 * MIN);
  assert.deepEqual(titles(), []);
  // The session resolves it (the agent nudges itself to, _poll_pr_conflicts);
  // GitHub recomputes, and the alert lands.
  beat(prBeat([], [{ url: PR_URL, state: "OPEN", checks: "passing", mergeable: "MERGEABLE",
    ready: "ready" }]), t0 + 41 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.match(notifications[0].body, /All checks passed/);
});

test("alerts: an empty rollup that turns into real checks isn't 'no CI'", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  beat(prBeat([PR_URL]), t0);
  beat(prBeat([], [{ url: PR_URL, checks: null }]), t0 + MIN);      // workflows not registered yet
  beat(prBeat([], [{ url: PR_URL, checks: "pending" }]), t0 + 2 * MIN); // they register
  beat(prBeat([], [{ url: PR_URL, checks: "pending" }]), t0 + 4 * MIN); // past the no-CI grace
  assert.deepEqual(titles(), []);
  beat(prBeat([], [{ url: PR_URL, checks: "passing" }]), t0 + 5 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.match(notifications[0].body, /All checks passed/);
});

test("alerts: failing CI stays quiet, then fires when the fix goes green", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  beat(prBeat([PR_URL]), t0);
  beat(prBeat([], [{ url: PR_URL, checks: "failing" }]), t0 + MIN);
  assert.deepEqual(titles(), []);
  // Red for well past the age-out backstop: still silent, because the session
  // is expected to push a fix rather than the operator to be pinged.
  beat(prBeat([], [{ url: PR_URL, checks: "failing" }]), t0 + 60 * MIN);
  assert.deepEqual(titles(), []);
  beat(prBeat([], [{ url: PR_URL, checks: "pending" }]), t0 + 61 * MIN); // re-run after a push
  assert.deepEqual(titles(), []);
  beat(prBeat([], [{ url: PR_URL, checks: "passing" }]), t0 + 62 * MIN);
  assert.deepEqual(titles(), [READY]);
});

test("alerts: a PR whose CI verdict never arrives fires on the backstop", () => {
  const beat = makeHost();
  const t0 = Date.now();
  notifications.length = 0;
  // A host with no `gh` login never fills the status in, so the wait would
  // otherwise hold forever and the alert be lost outright.
  beat(prBeat([PR_URL]), t0);
  beat(prBeat([], [{ url: PR_URL }]), t0 + 10 * MIN); // bare link, no `checks` key
  assert.deepEqual(titles(), []);
  beat(prBeat([], [{ url: PR_URL }]), t0 + 31 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.match(notifications[0].body, /CI state unknown/);
});

test("alerts: a session with two PRs still buzzes once, when the last one settles", () => {
  const beat = makeHost();
  const other = "https://github.com/xerktech/Turma/pull/35";
  const t0 = Date.now();
  notifications.length = 0;
  beat(prBeat([PR_URL]), t0);
  // One green, one still running: the session isn't settled, so the alert holds
  // rather than firing now and again later — the whole point of collapsing
  // these into one per-session notice (XERK-224).
  beat(prBeat([PR_URL, other], [{ url: PR_URL, checks: "passing" },
                                { url: other, checks: "pending" }]), t0 + MIN);
  assert.deepEqual(titles(), []);
  // The second settles: one alert, naming both verdicts.
  beat(prBeat([], [{ url: PR_URL, checks: "passing" },
                   { url: other, checks: "passing" }]), t0 + 2 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.match(notifications[0].body, new RegExp(PR_URL.replace(/[/.]/g, "\\$&")));
  assert.match(notifications[0].body, new RegExp(other.replace(/[/.]/g, "\\$&")));
  notifications.length = 0;
  // The agent re-delivers already-alerted URLs: the session is still ready, but
  // it has already been announced.
  beat(prBeat([PR_URL, other], [{ url: PR_URL, checks: "passing" },
                                { url: other, checks: "passing" }]), t0 + 3 * MIN);
  assert.deepEqual(titles(), []);
});

for (const finalState of ["MERGED", "CLOSED"]) {
  test(`alerts: a ${finalState} PR retracts its notification (XERK-154)`, () => {
    const beat = makeHost();
    const t0 = Date.now();
    notifications.length = 0;
    beat(prBeat([PR_URL]), t0);
    beat(prBeat([], [{ url: PR_URL, checks: "passing" }]), t0 + MIN); // the alert fires
    assert.deepEqual(titles(), [READY]);
    assert.equal(notifications.at(-1).data.notifKey, "review:host1:s1");
    notifications.length = 0;
    // Operator resolves it on their computer; the agent reports the new state.
    // The session has left the Ready-for-review section, so the notice goes too.
    beat(prBeat([], [{ url: PR_URL, checks: "passing", state: finalState }]), t0 + 2 * MIN);
    assert.deepEqual(titles(), []); // no new alert
    assert.deepEqual(dismisses(), ["review:host1:s1"]);
    notifications.length = 0;
    beat(prBeat([], [{ url: PR_URL, checks: "passing", state: finalState }]), t0 + 3 * MIN);
    assert.deepEqual(dismisses(), []); // retracted once, on the edge
  });
}

// --- heartbeat / record bounds (XERK-235) ------------------------------------
// A QA pass removed each of these guards in turn and the suite stayed green
// every time. They are the difference between one buggy agent and a fleet-wide
// outage, so each is pinned by name here.

test("sanitizeHeartbeat drops an oversized UNKNOWN key and keeps known ones", () => {
  const big = "A".repeat(HEARTBEAT_UNKNOWN_MAX + 1);
  const p = sanitizeHeartbeat(
    { device: "h", junk: big, sessions: [{ id: "s1" }], smallExtra: "ok" },
    "h",
  );
  assert.equal(p.junk, undefined, "an oversized unknown key must be dropped");
  assert.equal(p.smallExtra, "ok", "a SMALL unknown key must pass through — agents are often newer than the hub");
  assert.deepEqual(p.sessions, [{ id: "s1" }]);
});

test("agentRecordSize bounds known keys too, and ignores the stripped caches", () => {
  const big = "A".repeat(9 << 20);
  // A known key is just as good an amplifier as an unknown one.
  assert.ok(agentRecordSize({ device: "h", sessions: big }) > AGENT_RECORD_MAX);
  // ...but the on-demand caches are excluded: serializeAgent strips them, and a
  // legitimate ~5 MiB /history delivery lands there and must not cost the host
  // its heartbeat.
  assert.ok(agentRecordSize({ device: "h", history: { s1: { entries: big } } }) < AGENT_RECORD_MAX);
  // Many small unknown keys must not sum past the ceiling unnoticed: the
  // per-key bound had no aggregate, and 400 of them added 25 MiB.
  const many = { device: "h" };
  for (let i = 0; i < 400; i++) many[`k${i}`] = "B".repeat(HEARTBEAT_UNKNOWN_MAX - 100);
  assert.ok(agentRecordSize(many) > AGENT_RECORD_MAX);
});

test("safeAgentsCache serves something rather than failing the fleet payload", () => {
  // Unguarded, a serialization failure here reached the route's generic catch
  // as a 400 — to every dashboard, Android and glasses client, and permanently,
  // because the records causing it live for PRUNE_AFTER_MS.
  // A host must actually be present, or "last good == degraded" is vacuously
  // true and the assertion below proves nothing.
  agents["cache-witness"] = { key: "cache-witness", device: "cache-witness", lastSeen: Date.now() };
  invalidateAgentsCache();
  const good = safeAgentsCache();
  assert.ok(good && typeof good.body === "string" && good.etag);
  assert.doesNotThrow(() => JSON.parse(good.body));
  assert.ok(JSON.parse(good.body).agents.length > 0, "the fixture must put a host in the payload");

  // Now make it actually throw. A circular record is the cheap stand-in for the
  // RangeError a >512 MiB fleet produces — same catch, same degraded path.
  const boom = { key: "boom-host", device: "boom-host", lastSeen: Date.now() };
  boom.self = boom;
  agents["boom-host"] = boom;
  try {
    assert.throws(() => JSON.stringify(agents), "the fixture must really be unserializable");
    const degraded = safeAgentsCache();
    assert.ok(degraded && typeof degraded.body === "string" && degraded.etag,
      "a serialization failure must still produce a payload");
    assert.doesNotThrow(() => JSON.parse(degraded.body),
      "the degraded payload must be valid JSON, not a 400");
    // It must be the LAST GOOD payload, not an empty fleet: deleting the
    // last-good branch still yields valid JSON, so asserting only that would
    // let every host silently vanish from the dashboard.
    assert.deepEqual(
      JSON.parse(degraded.body).agents, JSON.parse(good.body).agents,
      "the degraded payload must be the last good fleet, not an empty one",
    );

    // The SAVE path has the same failure and a worse consequence: this runs
    // inside a timer, so an unguarded throw exits the whole hub.
    assert.equal(serializeAgentsForSave(), null,
      "an unserializable fleet must skip the save, not throw out of the timer");
  } finally {
    delete agents["boom-host"];
    delete agents["cache-witness"];
    invalidateAgentsCache();
  }
  // ...and it recovers once the offending record is gone.
  assert.doesNotThrow(() => JSON.parse(safeAgentsCache().body));
  assert.equal(typeof serializeAgentsForSave(), "string", "a healthy fleet still saves");
});

test("sessionWorking: a dead host's session is not still working (XERK-235)", () => {
  // paneBusy is a value on the record the host LAST PUSHED, so a host that dies
  // mid-turn leaves paneBusy:true behind. Without the online gate its session
  // read working forever — which made readyForReview short-circuit, so the
  // operator's phone never buzzed for exactly the stranded work that needs it.
  const now = 1_000_000;
  const sess = { id: "s1", status: "running",
                 session: { paneBusy: true, transcriptAgeSec: 5 } };
  assert.equal(sessionWorking(sess, now - 10_000, now), true);   // host alive
  assert.equal(sessionWorking(sess, now - 600_000, now), false); // host gone
  // And no transcript yet is idle BEFORE paneBusy is consulted, the web's order.
  assert.equal(
    sessionWorking({ id: "s2", status: "running", session: { paneBusy: true } }, now, now),
    false,
  );
  // A dead host's finished work therefore reaches Ready for review.
  const done = { paneBusy: true, transcriptAgeSec: 5,
                 lastRole: "assistant", lastHasToolUse: false };
  const stranded = { id: "s3", status: "running", session: done };
  assert.equal(
    readyForReview(stranded, sessionWorking(stranded, now - 600_000, now)),
    true,
  );
});

// The bounds above are asserted through the ROUTE, not just their helpers.
// A QA pass deleted each guard at its point of use and the suite stayed green
// for three of five — including the whole-record bound, whose removal
// reinstated the original 30 MiB amplification with 830/0 reported (XERK-235).

test("http: /api/agents degrades instead of 400ing when the fleet cannot serialize", async () => {
  // The failure this replaces was permanent: buildAgentsCache threw past V8's
  // string ceiling, the route's generic catch answered 400 to every dashboard,
  // Android and glasses client, and the records causing it live for a week.
  const boom = { key: "boom-route", device: "boom-route", lastSeen: Date.now() };
  boom.self = boom; // circular: the cheap stand-in for the RangeError
  agents["boom-route"] = boom;
  invalidateAgentsCache();
  try {
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    assert.equal(res.status, 200, "a serialization failure must not 400 the whole fleet");
    assert.doesNotThrow(() => JSON.parse(res.raw));
  } finally {
    delete agents["boom-route"];
    invalidateAgentsCache();
  }
  // ...and it recovers once the offending record is gone.
  const after = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(after.status, 200);
});

test("http: an oversized record is refused and leaves the prior beat intact", async () => {
  const host = "bound-host";
  const good = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, repos: [{ name: "r1" }], sessions: [{ id: "s1", status: "running" }] },
  });
  assert.equal(good.status, 200);

  // A KNOWN key is just as good an amplifier as an unknown one.
  const fat = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, sessions: "A".repeat(AGENT_RECORD_MAX + 1024) },
  });
  assert.equal(fat.status, 413);
  assert.equal(fat.body.limit, AGENT_RECORD_MAX);

  // ...and the good record is still the one being served.
  const a = agents[host];
  assert.deepEqual(a.repos, [{ name: "r1" }]);
  assert.equal(typeof a.sessions === "string", false, "the refused beat must not have landed");

  // Many small unknown keys must not sum past the ceiling either: the per-key
  // bound had no aggregate, and 400 of them added 25 MiB.
  const many = { device: host };
  for (let i = 0; i < 400; i++) many[`k${i}`] = "B".repeat(HEARTBEAT_UNKNOWN_MAX - 100);
  assert.equal((await request("POST", "/api/heartbeat", { headers: agentHeaders, body: many })).status, 413);
  assert.deepEqual(agents[host].repos, [{ name: "r1" }]);
});

test("http: a refused beat does not leak into the on-demand caches", async () => {
  // The caches are aliased from the previous record, and the ingests used to
  // run BEFORE the size check — so a 413 on the wire still served the refused
  // beat's content back out of /history.
  const host = "leak-host";
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: { device: host, sessions: [{ id: "leaked", status: "running" }] },
  })).status, 200);

  const refused = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: {
      device: host,
      sessions: "A".repeat(AGENT_RECORD_MAX + 1024),
      historyResults: [{ sessionId: "leaked", cmdId: "c1",
                         entries: [{ uuid: "u", role: "user", text: "LEAKED-THROUGH-A-413" }] }],
    },
  });
  assert.equal(refused.status, 413);
  const hist = await request("GET", `/api/agents/${host}/sessions/leaked/history`, { headers: userHeaders });
  assert.equal(hist.raw.includes("LEAKED-THROUGH-A-413"), false,
    "a refused beat's history must not be served");
});

test("http: the on-demand deliveries are ingested but never persisted", async () => {
  const host = "transient-host";
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: {
      device: host, sessions: [{ id: "s9", status: "running" }],
      historyResults: [{ sessionId: "s9", cmdId: "c9",
                         entries: [{ uuid: "u9", role: "user", text: "HISTORY-BODY" }] }],
    },
  })).status, 200);

  // Served by its own route...
  const hist = await request("GET", `/api/agents/${host}/sessions/s9/history`, { headers: userHeaders });
  assert.equal(hist.raw.includes("HISTORY-BODY"), true);
  // ...but not a second, unbounded copy on the record or in the fleet payload.
  for (const k of ["historyResults", "subagentHistoryResults", "jiraIssueResults",
                   "ticketStatusResults", "createMetaResults", "createTicketResults"]) {
    assert.equal(agents[host][k], undefined, `${k} must not persist on the record`);
  }
  const fleet = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(fleet.raw.includes("HISTORY-BODY"), false,
    "the fleet payload must not carry a history delivery");
});

test("readyForReview: the qualifiers, and the one thing that un-qualifies", () => {
  const sess = (session, extra = {}) => ({ id: "s1", status: "running", session, ...extra });
  const done = { lastRole: "assistant", lastHasToolUse: false };
  // Blocked on a human — either shape of dialog, and whatever the busy read says.
  assert.equal(readyForReview(sess({ question: "Ship it?" }), true), true);
  assert.equal(readyForReview(sess({ panePrompt: { prompt: "Allow?" } }), true), true);
  // Still its own turn.
  assert.equal(readyForReview(sess(done), true), false);
  // Stopped with plain assistant output and nothing pending: the no-PR
  // research task, which is the case a PR-only rule would miss entirely.
  assert.equal(readyForReview(sess(done), false), true);
  // Mid-turn output (a tool call still pending) is not a finished turn.
  assert.equal(readyForReview(sess({ lastRole: "assistant", lastHasToolUse: true }), false), false);
  assert.equal(readyForReview(sess({ lastRole: "user" }), false), false);
  assert.equal(readyForReview(sess({}), false), false); // nothing written yet
  // A PR is judged on its own state, not on the transcript behind it.
  const withPr = (...states) => sess({}, { prs: states.map((state) => ({ url: "u" + state, state })) });
  assert.equal(readyForReview(withPr("OPEN"), false), true);
  assert.equal(readyForReview(withPr("DRAFT"), false), true);
  assert.equal(readyForReview(withPr(""), false), true, "an unfetched state never drops the work");
  assert.equal(readyForReview(withPr("MERGED"), false), false, "merging IS the review");
  assert.equal(readyForReview(withPr("CLOSED"), false), false);
  assert.equal(readyForReview(withPr("MERGED", "OPEN"), false), true, "one still open is enough");
  // A landed PR outranks the finished turn that opened it — otherwise merging
  // could never move a session out of the section.
  assert.equal(readyForReview(sess(done, { prs: [{ url: "u", state: "MERGED" }] }), false), false);
  // But only until the conversation moves past the landing: the same session
  // can be given a new task, and the PR it already shipped must not bury it.
  assert.equal(
    readyForReview(sess(done, { prs: [{ url: "u", state: "MERGED" }], newWorkSincePrs: true }), false),
    true, "new work after the merge is still work awaiting review");
  // The expiry only lifts the demotion; it is not itself a qualifier.
  assert.equal(
    readyForReview(sess({ lastRole: "user" }, { prs: [{ url: "u", state: "MERGED" }], newWorkSincePrs: true }), false),
    false, "the turn signal still has to hold");
  // Only live sessions; an ended one has its own list.
  assert.equal(readyForReview({ id: "s1", status: "stopped", session: done }, false), false);
});

test("prAlertDecision: the verdict table, and its sticky markers", () => {
  const now = Date.now();
  // No status fetched yet is never "no CI" — hold.
  assert.equal(prAlertDecision({ at: now }, undefined, now), null);
  assert.equal(prAlertDecision({ at: now }, { url: PR_URL }, now), null);
  assert.equal(prAlertDecision({ at: now }, { url: PR_URL, checks: "pending" }, now), null);
  assert.equal(prAlertDecision({ at: now }, { url: PR_URL, checks: "passing" }, now),
    "All checks passed");
  // `checks: null` arms the no-CI timer rather than firing immediately.
  const noCi = { at: now };
  assert.equal(prAlertDecision(noCi, { url: PR_URL, checks: null }, now), null);
  assert.equal(noCi.noCiAt, now);
  assert.equal(prAlertDecision(noCi, { url: PR_URL, checks: null }, now + 3 * MIN),
    "No CI configured");
  // Failing is sticky, and immunizes the wait against the age-out backstop.
  const red = { at: now };
  assert.equal(prAlertDecision(red, { url: PR_URL, checks: "failing" }, now), null);
  assert.equal(red.red, true);
  assert.equal(prAlertDecision(red, { url: PR_URL, checks: "pending" }, now + 60 * MIN), null);
  // An unresolved wait ages out instead of being lost.
  assert.equal(prAlertDecision({ at: now }, undefined, now + 31 * MIN), "CI state unknown");
});

test("prAlertDecision: an open PR with merge conflicts never reads as ready (XERK-223)", () => {
  const now = Date.now();
  const open = (extra) => ({ url: PR_URL, state: "OPEN", ...extra });
  const conflict = { mergeable: "CONFLICTING" };
  // Green CI on a conflicting PR is exactly the alert the ticket forbids.
  assert.equal(prAlertDecision({ at: now }, open({ checks: "passing", ...conflict }), now), null);
  assert.equal(prAlertDecision({ at: now }, open({ checks: null, ...conflict }), now), null);
  assert.equal(prAlertDecision(
    { at: now }, { url: PR_URL, state: "DRAFT", checks: "passing", ...conflict }, now), null);
  // And it outranks the age-out backstop: the state is known-bad, not unknown.
  assert.equal(prAlertDecision({ at: now }, open({ checks: "passing", ...conflict }), now + 60 * MIN),
    null);
  // The hold is not sticky — resolving the conflict lets the alert through.
  const w = { at: now };
  assert.equal(prAlertDecision(w, open({ checks: "passing", ...conflict }), now), null);
  assert.equal(prAlertDecision(w, open({ checks: "passing", mergeable: "MERGEABLE" }), now),
    "All checks passed");
  // A conflict on a PR that already landed says nothing about mergeability.
  assert.equal(prAlertDecision(
    { at: now }, { url: PR_URL, state: "MERGED", checks: "passing", ...conflict }, now),
    "All checks passed");
  // A failing PR that also conflicts still records the sticky red marker.
  const red = { at: now };
  assert.equal(prAlertDecision(red, open({ checks: "failing", ...conflict }), now), null);
  assert.equal(red.red, true);
  // An agent too old to report mergeability is unaffected.
  assert.equal(prAlertDecision({ at: now }, { url: PR_URL, checks: "passing" }, now),
    "All checks passed");
});

// A conflicted PR holds prAlertDecision open indefinitely (above), so it holds
// the one ready-for-review alert too — XERK-223 decided a conflicting PR must
// not buzz, and XERK-224 routed every PR verdict through that same gate. The
// session still LISTS under Ready for review; only the notification waits, and
// XERK-223's own nudge is what gets the session working again to clear it.
test("alerts: a conflicting PR holds the ready-for-review alert until it is resolved", () => {
  const beat = makeHost();
  const t0 = Date.now();
  const pr = (extra) => [{ url: PR_URL, state: "OPEN", checks: "passing", ...extra }];
  const s = (session, prs) => ({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", status: "running", prs: prs || null, session }],
  });
  const busy = { paneBusy: true, transcriptAgeSec: 1, lastRole: "assistant", lastHasToolUse: true };
  const done = { paneBusy: false, transcriptAgeSec: 600, lastRole: "assistant", lastHasToolUse: false };

  notifications.length = 0;
  beat(s({ ...busy, newPrUrls: [PR_URL] }), t0);
  // Turn over, CI green — but the branch conflicts, so nothing fires.
  beat(s(done, pr({ mergeable: "CONFLICTING" })), t0 + MIN);
  assert.deepEqual(titles(), []);
  beat(s(done, pr({ mergeable: "CONFLICTING" })), t0 + 60 * MIN); // well past the backstop
  assert.deepEqual(titles(), []);
  // The session merges the base and finishes again; now it is genuinely ready.
  beat(s(busy, pr({ mergeable: "CONFLICTING" })), t0 + 61 * MIN);
  beat(s(done, pr({ mergeable: "MERGEABLE" })), t0 + 62 * MIN);
  assert.deepEqual(titles(), [READY]);
  assert.match(notifications[0].body, /All checks passed/);
});

// The hold is read off session.prs, not off the CI wait list, because a URL only
// enters that list through the per-beat `newPrUrls` scrape. These two cases have
// an EMPTY wait list and a live PR, which is what a hub that booted after the
// scrape — or a session alerted once and then worked again — actually looks like.
test("alerts: a conflicting PR that never hit the wait list still holds the alert", () => {
  const beat = makeHost();
  const t0 = Date.now();
  const s = (session, prs) => ({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", status: "running", prs: prs || null, session }],
  });
  const busy = { paneBusy: true, transcriptAgeSec: 1, lastRole: "assistant", lastHasToolUse: true };
  const done = { paneBusy: false, transcriptAgeSec: 600, lastRole: "assistant", lastHasToolUse: false };
  const conflicted = [{ url: PR_URL, state: "OPEN", checks: "passing", mergeable: "CONFLICTING" }];

  notifications.length = 0;
  beat(s(busy), t0);                                   // no newPrUrls this beat
  beat(s(done, conflicted), t0 + MIN);
  assert.deepEqual(titles(), [], "a PR that merges nowhere must not be announced");
  beat(s(done, conflicted), t0 + 60 * MIN);            // past the age-out backstop
  assert.deepEqual(titles(), []);
  // The session merges the base (XERK-223 nudged it) and finishes again.
  beat(s(busy, conflicted), t0 + 61 * MIN);
  beat(s(done, [{ url: PR_URL, state: "OPEN", checks: "passing", mergeable: "MERGEABLE" }]), t0 + 62 * MIN);
  assert.deepEqual(titles(), [READY]);
});

test("alerts: a session with a live PR never claims it has nothing to merge", () => {
  const beat = makeHost();
  const t0 = Date.now();
  const s = (session, prs) => ({
    sessions: [{
      id: "s1", rcName: "nas-repo-s1", status: "running", prs: prs || null,
      git: { repoName: "turma", branch: "XERK-224" }, session,
    }],
  });
  const busy = { paneBusy: true, transcriptAgeSec: 1, lastRole: "assistant", lastHasToolUse: true };
  const done = { paneBusy: false, transcriptAgeSec: 600, lastRole: "assistant", lastHasToolUse: false };
  const open = [{ url: PR_URL, state: "OPEN", checks: "passing", mergeable: "MERGEABLE" }];

  notifications.length = 0;
  beat(s(busy), t0);
  beat(s(done, open), t0 + MIN);
  assert.deepEqual(titles(), [READY]);
  // No banked CI verdict (nothing was ever queued on the wait list), but the PR
  // is real — name it rather than reporting the session opened nothing.
  assert.match(notifications[0].body, new RegExp(PR_URL.replace(/[/.]/g, "\\$&")));
  assert.doesNotMatch(notifications[0].body, /nothing to merge/);
  assert.equal(notifications[0].data.click, PR_URL);
});

test("alerts: a new task on a merged-PR session alerts again, without naming that PR", () => {
  // The lifecycle the Sessions page's expiry exists for, end to end: PR merged
  // and announced, alert retracted, then the SAME session is given new work.
  const beat = makeHost();
  const t0 = Date.now();
  const s = (session, prs, extra = {}) => ({
    sessions: [{
      id: "s1", rcName: "nas-repo-s1", status: "running", prs: prs || null,
      git: { repoName: "turma", branch: "XERK-224" }, session, ...extra,
    }],
  });
  const busy = { paneBusy: true, transcriptAgeSec: 1, lastRole: "assistant", lastHasToolUse: true };
  const done = { paneBusy: false, transcriptAgeSec: 600, lastRole: "assistant", lastHasToolUse: false };
  const open = [{ url: PR_URL, state: "OPEN", checks: "passing", mergeable: "MERGEABLE" }];
  const merged = [{ url: PR_URL, state: "MERGED", checks: "passing" }];

  notifications.length = 0;
  beat(s(busy), t0);
  beat(s(done, open), t0 + MIN);                       // ready: the PR
  assert.deepEqual(titles(), [READY]);
  notifications.length = 0;
  beat(s(done, merged), t0 + 2 * MIN);                 // operator merges it
  assert.deepEqual(titles(), []);
  assert.deepEqual(dismisses(), ["review:host1:s1"], "the PR is no longer a reason to look");

  notifications.length = 0;
  beat(s(busy, merged), t0 + 3 * MIN);                 // a NEW task on the same session
  beat(s(done, merged, { newWorkSincePrs: true }), t0 + 4 * MIN);
  assert.deepEqual(titles(), [READY], "the finished follow-up is announced");
  // It opened nothing new, and the old merged PR is not what awaits review.
  assert.match(notifications[0].body, /nothing to merge/);
  assert.doesNotMatch(notifications[0].body, new RegExp(PR_URL.replace(/[/.]/g, "\\$&")));
});

test("alerts: a finished turn with no PR fires on the working->idle edge only", () => {
  const beat = makeHost();
  const sess = (ageSec, extra = {}) => ({
    sessions: [{
      id: "s1", rcName: "nas-repo-s1", status: "running",
      session: { transcriptAgeSec: ageSec, lastRole: "assistant", lastHasToolUse: false, ...extra },
    }],
  });
  const now = Date.now();
  notifications.length = 0;
  beat(sess(0), now); // working
  assert.deepEqual(titles(), []);
  beat(sess(600), now + 20000); // went idle, plain assistant output
  assert.deepEqual(titles(), [READY]);
  // A research task that opened nothing says so, rather than naming a PR.
  assert.match(notifications[0].body, /Finished — nothing to merge/);
  notifications.length = 0;
  beat(sess(620), now + 40000); // stays idle: edge already fired
  assert.deepEqual(titles(), []);
});

test("alerts: a pending question suppresses the ready-for-review alert", () => {
  // The question alert is already that session's one buzz, and it says more —
  // so the two must not both fire for the same stop (XERK-224).
  const beat = makeHost();
  const sess = (ageSec, question) => ({
    sessions: [{
      id: "s1", rcName: "nas-repo-s1", status: "running",
      session: {
        transcriptAgeSec: ageSec, lastRole: "assistant", lastHasToolUse: false,
        ...(question ? { question } : {}),
      },
    }],
  });
  const now = Date.now();
  notifications.length = 0;
  beat(sess(0), now);                       // working
  beat(sess(600, "Ship it?"), now + 20000); // stopped, asking
  assert.deepEqual(titles(), ["nas-repo-s1 has a question"]);
  notifications.length = 0;
  // Answered from the desktop, and the session is still quiet: the ready alert
  // it was holding fires now that nothing louder covers it.
  beat(sess(620), now + 40000);
  assert.deepEqual(titles(), [READY]);
  assert.deepEqual(dismisses(), ["question:host1:s1"]);
});

test("alerts: replying to a finished turn retracts its notification (XERK-154)", () => {
  const beat = makeHost();
  const sess = (ageSec, busy) => ({
    sessions: [{
      id: "s1", rcName: "nas-repo-s1", status: "running",
      session: { paneBusy: busy, transcriptAgeSec: ageSec, lastRole: "assistant", lastHasToolUse: false },
    }],
  });
  const now = Date.now();
  notifications.length = 0;
  beat(sess(0, true), now);            // working
  beat(sess(600, false), now + 20000); // went idle: turn finished
  assert.deepEqual(titles(), [READY]);
  assert.equal(notifications.at(-1).data.notifKey, "review:host1:s1");
  notifications.length = 0;
  beat(sess(0, true), now + 40000);    // operator replied: working again
  assert.deepEqual(titles(), []);
  assert.deepEqual(dismisses(), ["review:host1:s1"]);
  notifications.length = 0;
  beat(sess(10, true), now + 60000);   // stays working: retracted once, on the edge
  assert.deepEqual(dismisses(), []);
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

// ---- XERK-235: defects a full QA pass found ---------------------------------

test("http: a fat heartbeat gets a 413 it can act on, not a dropped socket", async () => {
  // A /history result at the documented FULL block caps reaches ~5 MiB, and the
  // hub used to req.destroy() past 1 MiB — so the agent saw ECONNRESET with no
  // status to branch on, kept the staged results, and re-sent the same body
  // every beat. The host stayed offline forever with nothing logged.
  const fat = {
    device: "fat-host",
    historyResults: [{ sessionId: "s1", entries: [{ text: "x".repeat(3 << 20) }] }],
  };
  const res = await request("POST", "/api/heartbeat", { body: fat, headers: agentHeaders });
  assert.equal(res.status, 200, "a multi-MiB heartbeat is legitimate and must be accepted");

  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.ok(
    list.body.agents.some((a) => a.key === "fat-host"),
    "the host must actually register, not silently vanish"
  );
});

test("http: past the heartbeat cap the hub still ANSWERS (413), never a bare reset", async () => {
  const huge = { device: "huge-host", pad: "y".repeat(33 << 20) };
  // `connection: close`: past cap + drain slack the hub destroys the socket, and
  // node's default agent keep-alives, so a pooled-and-doomed socket would fail
  // the NEXT test with a bogus "socket hang up".
  const res = await request("POST", "/api/heartbeat", {
    body: huge, headers: { ...agentHeaders, connection: "close" },
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, "body too large");
  assert.ok(res.body.limit > 0, "the agent needs the limit to resize against");
});

test("http: a heartbeat whose device is not a plain host name is refused, not silently dropped", async () => {
  // `__proto__` 200'd while the beat was discarded AND the registry's prototype
  // was replaced; an object key landed as "[object Object]".
  for (const device of ["__proto__", "constructor", "prototype"]) {
    const res = await request("POST", "/api/heartbeat", { body: { device }, headers: agentHeaders });
    assert.equal(res.status, 400, `${device} must be refused`);
  }
  for (const device of [{ a: 1 }, ["x"], 12]) {
    const res = await request("POST", "/api/heartbeat", { body: { device }, headers: agentHeaders });
    assert.equal(res.status, 400, `${JSON.stringify(device)} must be refused`);
  }
  // The prototype must be intact: a route reading agents[x].commands would
  // otherwise find one on every unknown host.
  const probe = await request("POST", "/api/agents/never-seen/sessions/x/kill", { headers: userHeaders });
  assert.equal(probe.status, 404);
});

test("http: spawn validates repo and bounds its queued fields", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "spawn-val", repos: [{ name: "r1" }] }, headers: agentHeaders });
  for (const repo of [{ a: 1 }, ["x"], 12]) {
    const res = await request("POST", "/api/agents/spawn-val/sessions", {
      body: { repo }, headers: userHeaders,
    });
    assert.equal(res.status, 400, `repo ${JSON.stringify(repo)} must be refused`);
  }
  const big = await request("POST", "/api/agents/spawn-val/sessions", {
    body: { repo: "r1", prompt: "P".repeat(100001) }, headers: userHeaders,
  });
  assert.equal(big.status, 413, "an unbounded prompt rides every /api/agents response and SSE frame");
  const ok = await request("POST", "/api/agents/spawn-val/sessions", {
    body: { repo: "r1", prompt: "do the thing" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
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

test("http: /api/agents carries pushEnabled reflecting FCM config (XERK-152)", async () => {
  // The dashboard's "mobile push is off" banner keys off this one flag, so the
  // hub must report its true push health. Default in tests: no FCM service
  // account → fcmEnabled() false → the operator sees push is disabled.
  const off = await request("GET", "/api/agents", { headers: userHeaders });
  assert.strictEqual(off.body.pushEnabled, false, "push reported disabled when FCM unconfigured");

  // Configure a (fake but well-shaped) service account and force a cache rebuild
  // via a heartbeat (publishAgent invalidates the memoized payload); the flag
  // flips to true — exactly the difference between XERK-152's broken and fixed
  // deployments.
  push._setServiceAccount({ private_key: "k", client_email: "a@b", project_id: "p", token_uri: "https://t" });
  await request("POST", "/api/heartbeat", { body: { device: "push-host" }, headers: agentHeaders });
  const on = await request("GET", "/api/agents", { headers: userHeaders });
  assert.strictEqual(on.body.pushEnabled, true, "push reported enabled when FCM configured");

  // Restore the unconfigured state so later tests see push off, and reset the
  // stubbed sendFcm the suite installed at load (untouched here, but be explicit).
  push._setServiceAccount(null);
  await request("POST", "/api/heartbeat", { body: { device: "push-host" }, headers: agentHeaders });
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

test("http: an old agent's bare-string usage models are coerced on ingest", async () => {
  // Agents predating the token-only usage rewrite report `usage.models` as a
  // list of model-name STRINGS, not [{model, totals, …}]. Every client walks
  // that list, and one such host used to take the whole fleet down with it —
  // the dashboard's shortModels() read `m.model` off a string, threw mid-render,
  // and left NO host cards at all (so "All orgs" showed nothing while filtering
  // to any single org still worked, since that excluded the old host). The
  // coercion happens once, here at the hub's ingest boundary, so web, Android
  // and glasses all see the current shape.
  const legacy = { totals: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 },
                   models: ["claude-opus-5", "<synthetic>", ""] };
  assert.equal(
    (await request("POST", "/api/heartbeat", {
      body: {
        device: "legacy-usage-host",
        usage: legacy,
        repoUsage: [{ repo: "Turma", usage: { models: ["claude-fable-5"] } }],
        sessions: [{ id: "s1", repo: "Turma", status: "running",
                     usage: { models: ["claude-haiku-4-5-20251001"] } }],
      },
      headers: agentHeaders,
    })).status,
    200
  );
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = res.body.agents.find((a) => a.key === "legacy-usage-host");
  assert.deepEqual(rec.usage.models, [{ model: "claude-opus-5" }, { model: "<synthetic>" }]);
  assert.deepEqual(rec.repoUsage[0].usage.models, [{ model: "claude-fable-5" }]);
  assert.deepEqual(rec.sessions[0].usage.models, [{ model: "claude-haiku-4-5-20251001" }]);
  // The rest of the block rides through untouched.
  assert.deepEqual(rec.usage.totals, legacy.totals);
});

test("http: a current agent's per-model usage is left exactly as reported", async () => {
  const models = [{ model: "claude-opus-5", totals: { input: 3, output: 4, cacheWrite: 5, cacheRead: 6 },
                    today: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 },
                    week: { input: 2, output: 0, cacheWrite: 0, cacheRead: 0 } }];
  await request("POST", "/api/heartbeat", {
    body: { device: "modern-usage-host", usage: { models } },
    headers: agentHeaders,
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = res.body.agents.find((a) => a.key === "modern-usage-host");
  assert.deepEqual(rec.usage.models, models);
});

test("http: an agent's subscription limits reach the clients, and clear again", async () => {
  // XERK-247: the 5h/7d windows are a snapshot the agent captures out of Claude
  // Code itself, so the hub is pure carriage — but it has to be carriage that
  // FORGETS. A host that stops reporting them (its snapshot aged out, or it was
  // downgraded to an agent that can't) must not leave last week's percentages
  // on the Usage page forever.
  const limits = {
    fiveHour: { usedPct: 23.5, resetsAt: 1_786_405_200 },
    sevenDay: { usedPct: 41.2, resetsAt: 1_786_950_000 },
    capturedAt: 1_786_400_000,
    source: "statusline",
  };
  const beat = (body) =>
    request("POST", "/api/heartbeat", { body, headers: agentHeaders });
  const read = async () =>
    (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === "limits-host");

  assert.equal((await beat({ device: "limits-host", limits })).status, 200);
  assert.deepEqual((await read()).limits, limits);

  assert.equal((await beat({ device: "limits-host", limits: null })).status, 200);
  assert.equal((await read()).limits, null);

  // An agent too old to know the field reports nothing at all — which reads as
  // "this host can't tell you", never as a stale number or as 0% used.
  assert.equal((await beat({ device: "limits-host" })).status, 200);
  assert.equal((await read()).limits, undefined);
});

test("http: a malformed limits block is coerced at ingest, not fanned out", async () => {
  // Same reason the per-model usage lists are coerced here: this block reaches
  // web, Android and glasses, and Android decodes it into TYPED fields — a
  // `usedPct` of "lots" from one buggy host would fail the decode of the WHOLE
  // fleet payload, not just its own card.
  const beat = (body) =>
    request("POST", "/api/heartbeat", { body, headers: agentHeaders });
  const read = async (key) =>
    (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === key);

  await beat({
    device: "junk-limits-host",
    limits: {
      fiveHour: { usedPct: "lots", resetsAt: 1 },        // dropped: not a number
      sevenDay: { usedPct: 250, resetsAt: "soon" },      // clamped; reset dropped
      capturedAt: 1_786_400_000,
      source: "x".repeat(200),
    },
  });
  assert.deepEqual((await read("junk-limits-host")).limits, {
    sevenDay: { usedPct: 100 },
    capturedAt: 1_786_400_000,
    source: "x".repeat(32),
  });

  // Nothing usable left, and shapes that aren't a block at all, all read as null
  // rather than reaching a client as a half-formed card.
  for (const limits of [{ capturedAt: 1 }, { fiveHour: { usedPct: 5 } }, [], "nope", 7]) {
    await beat({ device: "junk-limits-host", limits });
    assert.equal((await read("junk-limits-host")).limits, null, JSON.stringify(limits));
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

test("http: clone route carries a valid source through and refuses an unknown one (XERK-155)", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "hclsrc" });

  // A picked gitlab repo rides as {type:"clone", repo, source}.
  const ok = await request("POST", "/api/agents/hclsrc/clone", {
    body: { repo: "grp/sub/app", source: "gitlab" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
  const res = await beat({ device: "hclsrc" });
  assert.deepEqual(res.body.commands, [
    { type: "clone", repo: "grp/sub/app", source: "gitlab", cmdId: ok.body.cmdId },
  ]);

  // A source outside the known set is refused before anything is queued.
  const bad = await request("POST", "/api/agents/hclsrc/clone", {
    body: { repo: "a/b", source: "sourceforge" }, headers: userHeaders,
  });
  assert.equal(bad.status, 400);
  const res2 = await beat({ device: "hclsrc", ackedCommands: [ok.body.cmdId] });
  assert.deepEqual(res2.body.commands, []);
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

test("http: restart route queues one restartAgent; collapses a mashed button", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  await beat({ device: "hra" });

  // A valid restart rides the next reply as a bare {type:"restartAgent"}.
  const ok = await request("POST", "/api/agents/hra/restart", { body: {}, headers: userHeaders });
  assert.equal(ok.status, 200);

  // A second press while the first is still unacked reuses the same cmdId — one
  // restart, not a queue of them.
  const again = await request("POST", "/api/agents/hra/restart", { body: {}, headers: userHeaders });
  assert.equal(again.status, 200);
  assert.equal(again.body.cmdId, ok.body.cmdId);

  const res = await beat({ device: "hra" });
  assert.deepEqual(res.body.commands, [
    { type: "restartAgent", cmdId: ok.body.cmdId },
  ]);

  // Unknown host -> 404; and the browser login is required (no agent token, no
  // anonymous access).
  const ghost = await request("POST", "/api/agents/ghost/restart", { body: {}, headers: userHeaders });
  assert.equal(ghost.status, 404);
  const noauth = await request("POST", "/api/agents/hra/restart", { body: {} });
  assert.equal(noauth.status, 401);
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

  // An agent that doesn't report `inputMaxChars` predates the paste delivery and
  // would CLIP the message to 4k without telling anyone, so the hub refuses past
  // that with a 413 carrying the limit (XERK-227). hi2's heartbeat has no
  // inputMaxChars, so this is the legacy cap.
  const long = await request("POST", "/api/agents/hi2/sessions/sess1/input", {
    body: { text: "a".repeat(4001) }, headers: userHeaders,
  });
  assert.equal(long.status, 413);
  assert.equal(long.body.limit, 4000);
  assert.match(long.body.error, /message too long — 4,001 characters, the limit is 4,000/);
});

test("http: the input cap follows the receiving agent's own limit (XERK-227)", async () => {
  // The hub is the only side that can see a hub/agent version mismatch. An agent
  // that says what it can deliver whole gets that cap; one that says nothing gets
  // the legacy 4k; a wild claim is still clamped to the hub's own ceiling — the
  // operator must never believe a message went whole when its end was cut.
  await request("POST", "/api/heartbeat", {
    body: { device: "new-agent", inputMaxChars: 100000 }, headers: agentHeaders,
  });
  await request("POST", "/api/heartbeat", { body: { device: "old-agent" }, headers: agentHeaders });
  await request("POST", "/api/heartbeat", {
    body: { device: "greedy-agent", inputMaxChars: 5000000 }, headers: agentHeaders,
  });

  const big = "b".repeat(50000);
  const onNew = await request("POST", "/api/agents/new-agent/sessions/s1/input", {
    body: { text: big }, headers: userHeaders,
  });
  assert.equal(onNew.status, 200, "a paste-capable agent takes the whole message");

  const onOld = await request("POST", "/api/agents/old-agent/sessions/s1/input", {
    body: { text: big }, headers: userHeaders,
  });
  assert.equal(onOld.status, 413, "an agent that would clip it is refused instead");
  assert.equal(onOld.body.limit, 4000);

  const onGreedy = await request("POST", "/api/agents/greedy-agent/sessions/s1/input", {
    body: { text: "c".repeat(100001) }, headers: userHeaders,
  });
  assert.equal(onGreedy.status, 413, "the hub's own ceiling still applies");
  assert.equal(onGreedy.body.limit, 100000);

  // The same cap governs a pasted ANSWER, which the composer routes to whenever
  // a question is pending.
  const answerOnOld = await request("POST", "/api/agents/old-agent/sessions/s1/answer", {
    body: { custom: big }, headers: userHeaders,
  });
  assert.equal(answerOnOld.status, 413);
  assert.equal(answerOnOld.body.limit, 4000);
  const answerOnNew = await request("POST", "/api/agents/new-agent/sessions/s1/answer", {
    body: { custom: big }, headers: userHeaders,
  });
  assert.equal(answerOnNew.status, 200);
});

test("http: input endpoint carries a pasted message far past the old 4k cap (XERK-227)", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "hi-paste", inputMaxChars: 100000 }, headers: agentHeaders,
  });
  // A pasted log is the case the old cap broke: the raw terminal always took
  // one, so the chat composer must too. Newlines ride through untouched — the
  // agent pastes the text into the pane rather than typing it key by key.
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i}: some log output`).join("\n");
  assert.ok(text.length > 4000);
  const res = await request("POST", "/api/agents/hi-paste/sessions/sess1/input", {
    body: { text }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "hi-paste" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "input", sessionId: "sess1", text, cmdId: res.body.cmdId },
  ]);
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

test("http: pane-prompt endpoint queues answerPanePrompt with the displayed number", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "pp1" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/pp1/sessions/sess1/pane-prompt", {
    body: { optionNumber: 2 }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const beat = await request("POST", "/api/heartbeat", { body: { device: "pp1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "answerPanePrompt", sessionId: "sess1", optionNumber: 2, cmdId: res.body.cmdId },
  ]);
});

test("http: pane-prompt endpoint rejects a number no dialog key could carry", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "pp2" }, headers: agentHeaders });
  // The answer is delivered by typing the digit, so 0, 10+ and non-integers
  // are not answerable and are refused before they reach the queue.
  for (const optionNumber of [0, 10, -1, 1.5, "2", null]) {
    const res = await request("POST", "/api/agents/pp2/sessions/sess1/pane-prompt", {
      body: { optionNumber }, headers: userHeaders,
    });
    assert.equal(res.status, 400);
  }
  const beat = await request("POST", "/api/heartbeat", { body: { device: "pp2" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, []);
});

test("http: answer endpoint rejects an empty answer and over-long custom", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "ha3" }, headers: agentHeaders });

  const empty = await request("POST", "/api/agents/ha3/sessions/sess1/answer", {
    body: {}, headers: userHeaders,
  });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: "optionIndex, optionIndices or custom required" });

  // A pasted answer meets the same per-host cap a typed message does — the
  // composer routes here whenever a question is pending (XERK-227). ha3 reports
  // no inputMaxChars, so the legacy 4k applies.
  const long = await request("POST", "/api/agents/ha3/sessions/sess1/answer", {
    body: { custom: "a".repeat(4001) }, headers: userHeaders,
  });
  assert.equal(long.status, 413);
  assert.equal(long.body.limit, 4000);
  assert.match(long.body.error, /answer too long — 4,001 characters, the limit is 4,000/);
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

// POST/GET /api/jira/<siteKey>/<issueKey>/status — the board's one write path
// (XERK-138): queue a status change on an online host, poll its outcome by cmdId.

test("http: a status change queues setTicketStatus on the org's online host", async () => {
  await jiraBeat("js1", "s1.atlassian.net");
  const res = await request("POST", "/api/jira/s1.atlassian.net/ENG-5/status",
    { body: { value: "31" }, headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.host, "js1");

  const beat = await jiraBeat("js1", "s1.atlassian.net");
  assert.deepEqual(beat.body.commands, [
    { type: "setTicketStatus", issueKey: "ENG-5", value: "31", category: "", cmdId: res.body.cmdId },
  ]);
});

test("http: a drag drops a target column, queued for the agent to resolve", async () => {
  await jiraBeat("jsd", "sd.atlassian.net");
  const res = await request("POST", "/api/jira/sd.atlassian.net/ENG-5/status",
    { body: { category: "done" }, headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  const beat = await jiraBeat("jsd", "sd.atlassian.net");
  // The column rides the command; the agent resolves it to a real transition.
  assert.deepEqual(beat.body.commands, [
    { type: "setTicketStatus", issueKey: "ENG-5", value: "", category: "done", cmdId: res.body.cmdId },
  ]);
});

test("http: a status change is single-flight per ticket", async () => {
  await jiraBeat("js2", "s2.atlassian.net");
  const first = await request("POST", "/api/jira/s2.atlassian.net/ENG-5/status",
    { body: { value: "31" }, headers: userHeaders });
  const second = await request("POST", "/api/jira/s2.atlassian.net/ENG-5/status",
    { body: { value: "41" }, headers: userHeaders });
  assert.equal(second.body.cmdId, first.body.cmdId);
  const beat = await jiraBeat("js2", "s2.atlassian.net");
  assert.equal(beat.body.commands.length, 1);   // no duplicate queued
});

test("http: a status change needs an online host and a value", async () => {
  await jiraBeat("js3", "s3.atlassian.net");
  const noVal = await request("POST", "/api/jira/s3.atlassian.net/ENG-5/status",
    { body: {}, headers: userHeaders });
  assert.equal(noVal.status, 400);
  const badKey = await request("POST", "/api/jira/s3.atlassian.net/12ab/status",
    { body: { value: "31" }, headers: userHeaders });
  assert.equal(badKey.status, 400);
  const noOrg = await request("POST", "/api/jira/nobody.atlassian.net/ENG-5/status",
    { body: { value: "31" }, headers: userHeaders });
  assert.equal(noOrg.status, 404);
});

test("http: an offline-only org refuses a status change with 503", async () => {
  await jiraBeat("js4", "s4.atlassian.net");
  agents.js4.lastSeen = Date.now() - 10 * 60 * 1000;   // fudge offline
  const res = await request("POST", "/api/jira/s4.atlassian.net/ENG-5/status",
    { body: { value: "31" }, headers: userHeaders });
  assert.equal(res.status, 503);
  assert.equal((agents.js4.commands || []).length, 0);
});

test("http: GET status polls the outcome by cmdId", async () => {
  await jiraBeat("js5", "s5.atlassian.net");
  const post = await request("POST", "/api/jira/s5.atlassian.net/ENG-5/status",
    { body: { value: "31" }, headers: userHeaders });
  const cmdId = post.body.cmdId;

  // Before the agent reports back, the poll is pending.
  const pending = await request("GET",
    `/api/jira/s5.atlassian.net/ENG-5/status?cmdId=${cmdId}`, { headers: userHeaders });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.pending, true);

  // The agent's heartbeat carries the outcome keyed by cmdId.
  await jiraBeat("js5", "s5.atlassian.net", {
    ticketStatusResults: [{ cmdId, key: "ENG-5", ok: true, error: null,
      status: "Done", statusCategory: "done" }],
  });
  const done = await request("GET",
    `/api/jira/s5.atlassian.net/ENG-5/status?cmdId=${cmdId}`, { headers: userHeaders });
  assert.equal(done.body.ok, true);
  assert.equal(done.body.status, "Done");
  assert.equal(done.body.statusCategory, "done");
});

test("http: a failed status change surfaces its error to the poll", async () => {
  await jiraBeat("js6", "s6.atlassian.net");
  await jiraBeat("js6", "s6.atlassian.net", {
    ticketStatusResults: [{ cmdId: "cx", key: "ENG-5", ok: false,
      error: "403 forbidden", status: null, statusCategory: null }],
  });
  const res = await request("GET",
    "/api/jira/s6.atlassian.net/ENG-5/status?cmdId=cx", { headers: userHeaders });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "403 forbidden");
});

test("http: status results never leak into the /api/agents payload", async () => {
  await jiraBeat("js7", "s7.atlassian.net", {
    ticketStatusResults: [{ cmdId: "cy", key: "ENG-5", ok: true, status: "Done" }],
  });
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  for (const a of list.body.agents) {
    assert.ok(!("statusResults" in a), `agent ${a.key} leaked its statusResults cache`);
  }
});

// New-ticket create flow (XERK-137): create-meta (projects/labels + per-project
// types), the create POST, and the create-outcome poll. The hub routes to the
// org's online host and rides the same heartbeat command/result path as detail.

test("http: create-meta returns 202 then serves projects/labels once the host reports", async () => {
  await jiraBeat("cm1", "cm1.atlassian.net");
  const first = await request("GET", "/api/jira/cm1.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(first.status, 202);
  assert.ok(first.body.cmdId);
  // Single-flight: a second form open reuses the queued command.
  const again = await request("GET", "/api/jira/cm1.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(again.body.cmdId, first.body.cmdId);

  const beat = await jiraBeat("cm1", "cm1.atlassian.net", {
    createMetaResults: [{ project: null, projects: [{ key: "ENG", name: "Eng" }],
                          labels: ["turma"], source: "jira", error: null }],
  });
  assert.deepEqual(beat.body.commands, [{ type: "boardCreateMeta", cmdId: first.body.cmdId }]);

  const res = await request("GET", "/api/jira/cm1.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects, [{ key: "ENG", name: "Eng" }]);
  assert.deepEqual(res.body.labels, ["turma"]);
  assert.equal(res.body.source, "jira");
});

test("http: create-meta ?project= fetches that project's issue types", async () => {
  await jiraBeat("cm2", "cm2.atlassian.net");
  const q = await request("GET", "/api/jira/cm2.atlassian.net/create-meta?project=ENG", { headers: userHeaders });
  assert.equal(q.status, 202);
  const beat = await jiraBeat("cm2", "cm2.atlassian.net", {
    createMetaResults: [{ project: "ENG", types: [{ id: "1", name: "Task" }], error: null }],
  });
  assert.deepEqual(beat.body.commands, [{ type: "boardCreateMeta", project: "ENG", cmdId: q.body.cmdId }]);
  const res = await request("GET", "/api/jira/cm2.atlassian.net/create-meta?project=ENG", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.types, [{ id: "1", name: "Task" }]);
});

test("http: create-meta 404s an org nobody reports and 503s when its host is offline", async () => {
  const none = await request("GET", "/api/jira/nobody-cm.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(none.status, 404);
  await jiraBeat("cm3", "cm3.atlassian.net");
  agents.cm3.lastSeen = Date.now() - 90 * 1000; // go offline
  const off = await request("GET", "/api/jira/cm3.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(off.status, 503);
});

test("http: creating a ticket validates, queues createTicket, and polls the outcome", async () => {
  await jiraBeat("ct1", "ct1.atlassian.net");
  const post = (body) => request("POST", "/api/jira/ct1.atlassian.net/tickets", { body, headers: userHeaders });
  // Each required field is enforced.
  assert.equal((await post({ project: "ENG", issueType: "1" })).status, 400);
  assert.equal((await post({ summary: "Hi", issueType: "1" })).status, 400);
  assert.equal((await post({ summary: "Hi", project: "ENG" })).status, 400);

  const res = await post({ project: "ENG", issueType: "1", summary: "New thing",
                           description: "do it", labels: ["a", "b"] });
  assert.equal(res.status, 200);
  assert.ok(res.body.cmdId);
  assert.equal(res.body.host, "ct1");

  const beat = await jiraBeat("ct1", "ct1.atlassian.net");
  assert.deepEqual(beat.body.commands, [{
    type: "createTicket", project: "ENG", issueType: "1", summary: "New thing",
    description: "do it", labels: ["a", "b"], cmdId: res.body.cmdId,
  }]);

  // Pending until the agent reports the outcome.
  const pending = await request("GET", `/api/jira/ct1.atlassian.net/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(pending.status, 202);

  await jiraBeat("ct1", "ct1.atlassian.net", {
    createTicketResults: [{ cmdId: res.body.cmdId, key: "ENG-100",
                            url: "https://ct1.atlassian.net/browse/ENG-100", error: null }],
  });
  const done = await request("GET", `/api/jira/ct1.atlassian.net/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(done.status, 200);
  assert.equal(done.body.key, "ENG-100");
  assert.match(done.body.url, /ENG-100/);
});

test("http: an unassigned create rides back as a warning beside the key (XERK-151)", async () => {
  // A ticket the tracker wouldn't assign is created and then invisible on the
  // board (which filters on the tracker user), so the success has to say so.
  await jiraBeat("ct5", "ct5.atlassian.net");
  const res = await request("POST", "/api/jira/ct5.atlassian.net/tickets", {
    body: { project: "ENG", issueType: "1", summary: "Orphan" }, headers: userHeaders,
  });
  await jiraBeat("ct5", "ct5.atlassian.net", {
    createTicketResults: [{ cmdId: res.body.cmdId, key: "ENG-7", url: "u",
                            error: null, warning: "created, but it couldn't be assigned to you" }],
  });
  const done = await request("GET", `/api/jira/ct5.atlassian.net/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(done.status, 200);
  assert.equal(done.body.key, "ENG-7");
  assert.match(done.body.warning, /couldn't be assigned/);
  assert.equal(done.body.error, undefined);
});

test("http: an assigned create reports no warning", async () => {
  await jiraBeat("ct6", "ct6.atlassian.net");
  const res = await request("POST", "/api/jira/ct6.atlassian.net/tickets", {
    body: { project: "ENG", issueType: "1", summary: "Fine" }, headers: userHeaders,
  });
  await jiraBeat("ct6", "ct6.atlassian.net", {
    createTicketResults: [{ cmdId: res.body.cmdId, key: "ENG-8", url: "u", error: null }],
  });
  const done = await request("GET", `/api/jira/ct6.atlassian.net/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(done.body.key, "ENG-8");
  assert.equal(done.body.warning, null);
});

test("http: a create failure is reported to the poller as an error", async () => {
  await jiraBeat("ct2", "ct2.atlassian.net");
  const res = await request("POST", "/api/jira/ct2.atlassian.net/tickets", {
    body: { project: "ENG", issueType: "1", summary: "Boom" }, headers: userHeaders,
  });
  await jiraBeat("ct2", "ct2.atlassian.net", {
    createTicketResults: [{ cmdId: res.body.cmdId, key: null, url: null, error: "Jira 400: bad field" }],
  });
  const done = await request("GET", `/api/jira/ct2.atlassian.net/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(done.status, 200);
  assert.equal(done.body.error, "Jira 400: bad field");
});

test("http: creating a ticket 404s an org nobody reports", async () => {
  const res = await request("POST", "/api/jira/nobody-ct.atlassian.net/tickets", {
    body: { project: "E", issueType: "1", summary: "x" }, headers: userHeaders,
  });
  assert.equal(res.status, 404);
});

// ---- multi-agent orgs: create routing and polling (XERK-241) ----------------
// An org polled by several hosts must not let a SIBLING host's state decide the
// answer for a create that ran somewhere else.

test("XERK-241: an offline sibling host doesn't fail a create that ran on the online one", async () => {
  // The reported bug: the poll picked the FIRST host reporting the org for its
  // offline check, so an offline sibling 503'd every create the online host was
  // busy running — and each retry made another real ticket.
  const site = "mx1.atlassian.net";
  await jiraBeat("mx1-down", site);
  await jiraBeat("mx1-up", site);
  agents["mx1-down"].lastSeen = Date.now() - 90 * 1000; // the host that's down

  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "New thing" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, "mx1-up");

  // While the online host works, the poll must read as pending — not as a
  // failure borrowed from the host that never ran it.
  const pending = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(pending.status, 202);

  await jiraBeat("mx1-up", site, {
    createTicketResults: [{ cmdId: res.body.cmdId, key: "ENG-1", url: "u", error: null }],
  });
  const done = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(done.status, 200);
  assert.equal(done.body.key, "ENG-1");
});

test("XERK-241: the create's OWN host going offline is still reported", async () => {
  const site = "mx2.atlassian.net";
  await jiraBeat("mx2-a", site);
  await jiraBeat("mx2-b", site);
  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Doomed" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  agents[res.body.host].lastSeen = Date.now() - 90 * 1000; // the host that took it dies
  const out = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /went offline/);
});

test("XERK-241: a repeated identical create is single-flighted, not duplicated", async () => {
  const site = "mx3.atlassian.net";
  await jiraBeat("mx3", site);
  const body = { project: "ENG", issueType: "1", summary: "Same thing", description: "d" };
  const one = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  const two = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  assert.equal(two.status, 200);
  assert.equal(two.body.cmdId, one.body.cmdId, "a retry while the first is in flight must reuse it");

  // Exactly one create command reaches the agent.
  const beat = await jiraBeat("mx3", site);
  assert.equal(beat.body.commands.filter((c) => c.type === "createTicket").length, 1);

  // A DIFFERENT title is its own create.
  const other = await request("POST", `/api/jira/${site}/tickets`, {
    body: { ...body, summary: "Other thing" }, headers: userHeaders,
  });
  assert.notEqual(other.body.cmdId, one.body.cmdId);

  // And once the first has an outcome, an identical create is allowed again.
  await jiraBeat("mx3", site, {
    createTicketResults: [{ cmdId: one.body.cmdId, key: "ENG-2", url: "u", error: null }],
  });
  const again = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  assert.notEqual(again.body.cmdId, one.body.cmdId);
});

test("XERK-241: board work routes to a host whose tracker poll actually works", async () => {
  // "One of the hosts was down" — a host can heartbeat while its Jira polling
  // fails (available:false). Map order must not pin every read and write to it.
  const site = "mx4.atlassian.net";
  await request("POST", "/api/heartbeat", {
    body: { device: "mx4-sick", jira: { available: false, configured: true, siteKey: site, user: "u", tickets: [] } },
    headers: agentHeaders,
  });
  await jiraBeat("mx4-ok", site);

  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Route me" }, headers: userHeaders,
  });
  assert.equal(res.body.host, "mx4-ok");

  const meta = await request("GET", `/api/jira/${site}/create-meta`, { headers: userHeaders });
  assert.equal(meta.status, 202);
  assert.ok((agents["mx4-ok"].commands || []).some((c) => c.type === "boardCreateMeta"));
});

test("XERK-241: a create abandoned on a dead host is withdrawn, not left to fire later", async () => {
  // The 503 sends the operator back to remake the ticket, so the undelivered
  // create must not still be waiting in the dead host's queue.
  const site = "mx6.atlassian.net";
  await jiraBeat("mx6", site);
  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Stranded" }, headers: userHeaders,
  });
  assert.equal((agents.mx6.commands || []).filter((c) => c.type === "createTicket").length, 1);

  agents.mx6.lastSeen = Date.now() - 90 * 1000;
  const out = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 503);
  assert.equal((agents.mx6.commands || []).filter((c) => c.type === "createTicket").length, 0);

  // And the retry is a fresh create, not a rejoin of the stranded one.
  agents.mx6.lastSeen = Date.now();
  const again = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Stranded" }, headers: userHeaders,
  });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.cmdId, res.body.cmdId);
});

test("XERK-241: a status change is polled off the host that ran it", async () => {
  const site = "mx7.atlassian.net";
  await jiraBeat("mx7-a", site);
  const post = await request("POST", `/api/jira/${site}/ENG-1/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(post.status, 202);
  await jiraBeat("mx7-a", site, {
    ticketStatusResults: [{ cmdId: post.body.cmdId, ok: true, status: "Done", statusCategory: "done" }],
  });
  // A second host of the org joins and out-ranks the first (whose tracker poll
  // has since started failing). The outcome still comes from the host that ran it.
  await jiraBeat("mx7-b", site);
  agents["mx7-a"].jira.available = false;
  const out = await request("GET", `/api/jira/${site}/ENG-1/status?cmdId=${post.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.status, "Done");
});

test("XERK-241: the OWNER is remembered even once the command has left every queue", async () => {
  // The recorded owner is the whole point: after the agent acks, the command is
  // gone from its queue and its resultWait with it, so scanning the fleet finds
  // nothing. Only cmdHosts can still say who was asked — and without it this
  // poll reads as pending forever while a sibling keeps the org "up".
  const site = "mx8.atlassian.net";
  await jiraBeat("mx8-a", site);
  await jiraBeat("mx8-b", site);
  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Owned" }, headers: userHeaders,
  });
  const owner = res.body.host;
  // Acked with NO staged result: the command leaves the queue carrying nothing.
  await ackBeat(owner, site, [res.body.cmdId]);
  for (const h of ["mx8-a", "mx8-b"]) {
    assert.equal((agents[h].commands || []).some((c) => c.cmdId === res.body.cmdId), false);
    assert.equal(!!(agents[h].resultWaits || {})[res.body.cmdId], false);
  }
  agents[owner].lastSeen = Date.now() - 90 * 1000;
  const out = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 503, "the poll must still know whose create this was");
});

test("XERK-241: a create the agent may already have run is not called dead", async () => {
  // The hub can prove nothing was created ONLY when it withdrew a command the
  // agent was never handed. Once delivered, the agent may have created the
  // ticket and died before acking — saying otherwise is what makes duplicates.
  const site = "mx9.atlassian.net";
  await jiraBeat("mx9", site);
  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Maybe" }, headers: userHeaders,
  });
  await jiraBeat("mx9", site);                 // the beat that HANDS IT OVER
  agents.mx9.lastSeen = Date.now() - 90 * 1000;

  const out = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /may have been created/);
  assert.doesNotMatch(out.body.error, /before the ticket was created/);
});

test("XERK-241: an agent that reports no `available` ranks with the healthy", async () => {
  // Absent is "this agent is older", never "this agent is broken".
  // The sick host is registered FIRST, so map order alone would hand it every
  // request: only the ranking can move the older agent ahead of it.
  const site = "mxa.atlassian.net";
  await request("POST", "/api/heartbeat", {   // reports a FAILING tracker poll
    body: { device: "mxa-sick", jira: { available: false, configured: true, siteKey: site, user: "u", tickets: [] } },
    headers: agentHeaders,
  });
  await request("POST", "/api/heartbeat", {   // no `available` key at all
    body: { device: "mxa-old", jira: { configured: true, siteKey: site, user: "u", tickets: [] } },
    headers: agentHeaders,
  });
  // Reads rank the same way — create-meta must not queue onto the sick host.
  const meta = await request("GET", `/api/jira/${site}/create-meta`, { headers: userHeaders });
  assert.equal(meta.status, 202);
  assert.equal((agents["mxa-old"].commands || []).some((c) => c.type === "boardCreateMeta"), true);
  assert.equal((agents["mxa-sick"].commands || []).some((c) => c.type === "boardCreateMeta"), false);

  const hosts = [];
  for (let i = 0; i < 3; i++) {
    const r = await request("POST", `/api/jira/${site}/tickets`, {
      body: { project: "ENG", issueType: "1", summary: `Old${i}` }, headers: userHeaders,
    });
    hosts.push(r.body.host);
  }
  assert.deepEqual([...new Set(hosts)], ["mxa-old"], "the older agent must outrank the sick one");
});

test("XERK-241: a host that has proven a createTicket gap is skipped, not rotated onto", async () => {
  const site = "mxb.atlassian.net";
  await jiraBeat("mxb-old", site, { agentVersion: "0.5.38" });
  await jiraBeat("mxb-new", site);
  const first = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Prove it" }, headers: userHeaders,
  });
  // Whichever host took it acks without staging a result → gap proven there.
  await ackBeat(first.body.host, site, [first.body.cmdId],
    first.body.host === "mxb-old" ? { agentVersion: "0.5.38" } : {});

  const hosts = [];
  for (let i = 0; i < 4; i++) {
    const r = await request("POST", `/api/jira/${site}/tickets`, {
      body: { project: "ENG", issueType: "1", summary: `After${i}` }, headers: userHeaders,
    });
    hosts.push(r.status === 200 ? r.body.host : `HTTP${r.status}`);
  }
  assert.equal(hosts.some((h) => h.startsWith("HTTP")), false,
    `a gapped host kept winning turns: ${hosts.join(",")}`);
  assert.equal(hosts.includes(first.body.host), false);
});

test("XERK-241: same title, different body is a different ticket", async () => {
  // The single-flight must suppress a RETRY, never fold two different tickets
  // into one and report the second created under the first's key.
  const site = "mxc.atlassian.net";
  await jiraBeat("mxc", site);
  const post = (description, labels) => request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Login is broken", description, labels },
    headers: userHeaders,
  });
  const a = await post("repro A", ["one"]);
  const b = await post("repro B", ["one"]);
  const c = await post("repro A", ["two"]);
  const same = await post("repro A", ["one"]);
  assert.notEqual(b.body.cmdId, a.body.cmdId, "a different description is a different ticket");
  assert.notEqual(c.body.cmdId, a.body.cmdId, "different labels are a different ticket");
  assert.equal(same.body.cmdId, a.body.cmdId, "an identical retry still rejoins");

  const beat = await jiraBeat("mxc", site);
  const sent = beat.body.commands.filter((x) => x.type === "createTicket");
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((x) => x.description).sort(), ["repro A", "repro A", "repro B"]);
});

test("XERK-241: an unresolved create stops holding retries once it expires", async () => {
  // CREATE_INFLIGHT_TTL_MS is wound down to 300ms for this file; on the fleet it
  // matches the client's own 60s give-up, so a click after that is a new intent.
  const site = "mxd.atlassian.net";
  await jiraBeat("mxd", site);
  const body = { project: "ENG", issueType: "1", summary: "Waited too long" };
  const first = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  const quick = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  assert.equal(quick.body.cmdId, first.body.cmdId);
  await new Promise((r) => setTimeout(r, 400));
  const late = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  assert.notEqual(late.body.cmdId, first.body.cmdId);
});

test("XERK-241: the status single-flight spans the org, not one host", async () => {
  // Which host answers for an org moves on a health flip; a per-host search
  // would miss the change already queued on a sibling and fire a second one.
  const site = "mxe.atlassian.net";
  await jiraBeat("mxe-a", site);
  await jiraBeat("mxe-b", site);
  const first = await request("POST", `/api/jira/${site}/ENG-1/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(first.status, 202);
  // The chosen host's tracker poll starts failing, so the ranking moves on.
  await jiraBeat(first.body.host, site, {
    jira: { available: false, configured: true, siteKey: site, user: "u", tickets: [] },
  });
  const second = await request("POST", `/api/jira/${site}/ENG-1/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(second.body.cmdId, first.body.cmdId, "a double-click must not fire two transitions");
  const queued = ["mxe-a", "mxe-b"].flatMap(
    (h) => (agents[h].commands || []).filter((c) => c.type === "setTicketStatus"));
  assert.equal(queued.length, 1, `two transitions queued across the org: ${queued.length}`);
});

test("XERK-241: the create single-flight outlives the client's own give-up", async () => {
  // The suite runs with the TTL wound down, so assert the PRODUCTION default.
  // newticket.js polls for 60s; the hub's timer starts a round trip EARLIER, so
  // matching that number would expire the entry moments before the operator is
  // told it timed out — handing their retry a fresh write every time.
  const clientDeadlineMs = 60000; // newticket.js pollCreate
  assert.ok(hub.CREATE_INFLIGHT_TTL_DEFAULT_MS > clientDeadlineMs * 2,
    `single-flight backstop ${hub.CREATE_INFLIGHT_TTL_DEFAULT_MS}ms must comfortably `
    + `outlast the client's ${clientDeadlineMs}ms give-up`);
});

test("XERK-241: a change stranded on a dead host never answers a later one", async () => {
  // The org-wide search must look only at hosts that can still RUN the command:
  // a record keeps its queue for days, so reusing a dead host's cmdId would
  // answer every later change for this ticket with one nothing will ever run.
  const site = "mxf.atlassian.net";
  await jiraBeat("mxf-dead", site);
  const first = await request("POST", `/api/jira/${site}/ENG-7/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(first.body.host, "mxf-dead");
  agents["mxf-dead"].lastSeen = Date.now() - 90 * 1000;   // dies holding it
  await jiraBeat("mxf-live", site);

  const second = await request("POST", `/api/jira/${site}/ENG-7/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(second.status, 202);
  assert.equal(second.body.host, "mxf-live");
  assert.notEqual(second.body.cmdId, first.body.cmdId,
    "the dead host's stranded change must not answer this one");
});

test("XERK-241: a status change skips a host that has proven it can't run one", async () => {
  const site = "mxg.atlassian.net";
  await jiraBeat("mxg-old", site, { agentVersion: "0.5.38" });
  const first = await request("POST", `/api/jira/${site}/ENG-3/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  await ackBeat("mxg-old", site, [first.body.cmdId], { agentVersion: "0.5.38" });
  await jiraBeat("mxg-new", site);
  const second = await request("POST", `/api/jira/${site}/ENG-4/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(second.status, 202);
  assert.equal(second.body.host, "mxg-new");
});

test("XERK-241: reads go to an ONLINE host even when an offline one is listed first", async () => {
  // Online-first is the ranking's primary term; without it a board read serves
  // (and queues against) a dead host's stale cache.
  const site = "mxh.atlassian.net";
  await jiraBeat("mxh-down", site);
  agents["mxh-down"].lastSeen = Date.now() - 90 * 1000;
  await jiraBeat("mxh-up", site);
  const res = await request("GET", `/api/jira/${site}/ENG-2`, { headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal((agents["mxh-up"].commands || []).some((c) => c.type === "jiraIssue"), true);
  assert.equal((agents["mxh-down"].commands || []).some((c) => c.type === "jiraIssue"), false);

  // …and with every host offline it still answers from the best cache rather
  // than refusing — the fallback the single ranked lookup has to keep.
  agents["mxh-up"].lastSeen = Date.now() - 90 * 1000;
  const off = await request("GET", `/api/jira/${site}/ENG-5`, { headers: userHeaders });
  assert.notEqual(off.status, 404);
});

test("XERK-241: a create stranded by a host going quiet stops holding its title", async () => {
  // Nothing polled this one — the operator closed the modal — so the 503 path
  // never ran. The in-flight guard is what stops the next attempt rejoining a
  // cmdId whose host is gone, well inside the backstop window.
  const site = "mxk.atlassian.net";
  await jiraBeat("mxk", site);
  const body = { project: "ENG", issueType: "1", summary: "Orphaned" };
  const first = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  agents.mxk.lastSeen = Date.now() - 90 * 1000;
  await jiraBeat("mxk-2", site);            // a live sibling keeps the org up

  const again = await request("POST", `/api/jira/${site}/tickets`, { body, headers: userHeaders });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.cmdId, first.body.cmdId);
  assert.equal(again.body.host, "mxk-2");
});

test("XERK-241: the delivery stamp is hub-internal — it rides no payload", async () => {
  const site = "mxi.atlassian.net";
  await jiraBeat("mxi", site);
  await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Internal" }, headers: userHeaders,
  });
  const beat = await jiraBeat("mxi", site);          // the beat that delivers
  assert.ok(beat.body.commands.length);
  for (const c of beat.body.commands) {
    assert.equal("deliveredAt" in c, false, "the agent must not see the delivery stamp");
  }
  assert.ok((agents.mxi.commands || []).every((c) => c.deliveredAt), "but the hub records it");

  const fleet = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = fleet.body.agents.find((a) => a.key === "mxi");
  for (const c of rec.commands || []) {
    assert.equal("deliveredAt" in c, false, "the fleet payload must not carry it either");
  }
});

test("XERK-241: a create abandoned on a dead host is withdrawn even once delivered", async () => {
  // Delivery is at-least-once and the agent's de-dup of an executed cmdId does
  // not survive its restart, so a create left in a dead host's queue would run
  // a SECOND time on its return — landing after the operator remade the ticket.
  const site = "mxj.atlassian.net";
  await jiraBeat("mxj", site);
  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Handed over" }, headers: userHeaders,
  });
  await jiraBeat("mxj", site);                       // hands it to the agent
  agents.mxj.lastSeen = Date.now() - 90 * 1000;

  const out = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /may have been created/);
  assert.equal((agents.mxj.commands || []).some((c) => c.cmdId === res.body.cmdId), false,
    "a written-off create must not be re-delivered when the host comes back");
});

test("XERK-241: a create poll can't adopt — or delete — someone else's command", async () => {
  // The poll is a GET handed a bare cmdId, and it withdraws what it gives up
  // on. Both halves must be scoped to createTicket, or polling a repo pin's id
  // deletes the operator's pin and reports a create verdict about it.
  const site = "mxl.atlassian.net";
  await jiraBeat("mxl", site);
  const pin = await request("POST", `/api/jira/${site}/ENG-9/repo`, {
    body: { repo: "myrepo" }, headers: userHeaders,
  });
  const pinCmd = (agents.mxl.commands || []).find((c) => c.type === "setJiraRepo");
  assert.ok(pinCmd, "the pin should be queued");
  assert.equal(pin.status < 400, true);
  agents.mxl.lastSeen = Date.now() - 90 * 1000;

  const out = await request("GET", `/api/jira/${site}/tickets/${pinCmd.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 202, "a foreign cmdId is not this route's to answer for");
  assert.equal((agents.mxl.commands || []).some((c) => c.cmdId === pinCmd.cmdId), true,
    "the repo pin must survive a create poll that named its id");
});

test("XERK-241: withdrawal refuses a cmdId that names a different command", () => {
  // The routes are type-scoped before they reach this, so nothing on the HTTP
  // surface can drive it — but it deletes state on a bare id, so the guard is
  // held here rather than left to the callers staying careful forever.
  agents.mxdrop = { jira: { siteKey: "mxdrop.atlassian.net" }, lastSeen: Date.now(),
    commands: [{ type: "setJiraRepo", issueKey: "ENG-1", cmdId: "shared-id" }] };
  assert.equal(hub.dropQueuedCommand("mxdrop", "shared-id", "createTicket"), false);
  assert.equal(agents.mxdrop.commands.length, 1, "a foreign command must survive");
  assert.equal(hub.dropQueuedCommand("mxdrop", "shared-id", "setJiraRepo"), true);
  assert.equal(agents.mxdrop.commands.length, 0);
  delete agents.mxdrop;
});

test("XERK-241: an awaited command of another kind isn't adopted by the create poll", () => {
  // `resultWaits` is keyed by cmdId across every awaited command kind, so the
  // claim has to check what kind it was waiting for.
  const site = "mxo.atlassian.net";
  return (async () => {
    await jiraBeat("mxo", site);
    const meta = await request("GET", `/api/jira/${site}/create-meta`, { headers: userHeaders });
    assert.equal(meta.status, 202);
    assert.equal(((agents.mxo.resultWaits || {})[meta.body.cmdId] || {}).kind, "boardCreateMeta");
    agents.mxo.lastSeen = Date.now() - 90 * 1000;
    const out = await request("GET", `/api/jira/${site}/tickets/${meta.body.cmdId}`, { headers: userHeaders });
    assert.equal(out.status, 202, "a create-meta fetch is not a create");
  })();
});

test("XERK-241: a RECORDED owner of another kind isn't adopted either", async () => {
  // The other kind-scoped claims run in the fleet scan; this one is the owner
  // fast-path, and only a cmdId that cmdHosts actually records reaches it —
  // so it takes a status change's id, polled at the create route.
  const site = "mxp.atlassian.net";
  await jiraBeat("mxp", site);
  const st = await request("POST", `/api/jira/${site}/ENG-8/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  assert.equal(st.status, 202);
  agents.mxp.lastSeen = Date.now() - 90 * 1000;
  const out = await request("GET", `/api/jira/${site}/tickets/${st.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 202, "a status change's id is not a create's");
});

test("XERK-241: ownership survives a hub restart via the fleet scan", async () => {
  // cmdHosts is in-memory, so a restart forgets who ran what and the scan is
  // the only thing left that can answer. Losing it silently turns a COMPLETED
  // change into one that polls pending forever.
  const site = "mxq.atlassian.net";
  await jiraBeat("mxq-a", site);
  await jiraBeat("mxq-b", site);
  const st = await request("POST", `/api/jira/${site}/ENG-6/status`, {
    body: { value: "31" }, headers: userHeaders,
  });
  const owner = st.body.host, other = owner === "mxq-a" ? "mxq-b" : "mxq-a";
  await jiraBeat(owner, site, {
    ticketStatusResults: [{ cmdId: st.body.cmdId, ok: true, status: "Done", statusCategory: "done" }],
  });
  hub.cmdHosts.clear();                       // the restart
  // …and the ranking now prefers the sibling, so nothing but the scan can find
  // the host that actually holds the outcome.
  await jiraBeat(owner, site, {
    jira: { available: false, configured: true, siteKey: site, user: "u", tickets: [] },
  });
  await jiraBeat(other, site);

  const out = await request("GET", `/api/jira/${site}/ENG-6/status?cmdId=${st.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true, "a completed change must not read as pending after a restart");
  assert.equal(out.body.status, "Done");
});

test("XERK-241: a recorded owner that has left the org no longer answers for it", async () => {
  const site = "mxm.atlassian.net", other = "mxm-other.atlassian.net";
  await jiraBeat("mxm-mover", site);
  const res = await request("POST", `/api/jira/${site}/tickets`, {
    body: { project: "ENG", issueType: "1", summary: "Moved" }, headers: userHeaders,
  });
  assert.equal(res.body.host, "mxm-mover");
  await jiraBeat("mxm-mover", other);          // re-homed to a different org
  agents["mxm-mover"].lastSeen = Date.now() - 90 * 1000;
  await jiraBeat("mxm-stay", site);            // the org still has a host

  const out = await request("GET", `/api/jira/${site}/tickets/${res.body.cmdId}`, { headers: userHeaders });
  assert.equal(out.status, 202, "a host of another org must not decide this org's create");
});

test("XERK-241: an offline-only org still serves the host that HAS the copy", async () => {
  // Health ranks hosts that can still be asked; it says nothing about which
  // dead host kept the answer. Ranking alone would drop a cached ticket.
  const site = "mxn.atlassian.net";
  await request("POST", "/api/heartbeat", {   // holds the cache, but poll failing
    body: { device: "mxn-sick", jira: { available: false, configured: true, siteKey: site, user: "u", tickets: [] } },
    headers: agentHeaders,
  });
  await request("GET", `/api/jira/${site}/ENG-5`, { headers: userHeaders });  // queue it
  const issue = { key: "ENG-5", summary: "Cached", description: "d", comments: [] };
  await request("POST", "/api/heartbeat", {
    body: {
      device: "mxn-sick",
      jira: { available: false, configured: true, siteKey: site, user: "u", tickets: [] },
      jiraIssueResults: [{ key: "ENG-5", issue, error: null }],
    },
    headers: agentHeaders,
  });
  await jiraBeat("mxn-well", site);           // healthier, but has no copy
  agents["mxn-sick"].lastSeen = Date.now() - 90 * 1000;
  agents["mxn-well"].lastSeen = Date.now() - 90 * 1000;

  const out = await request("GET", `/api/jira/${site}/ENG-5`, { headers: userHeaders });
  assert.equal(out.status, 200, "an offline-only org serves its last copy");
  assert.equal(out.body.issue.summary, "Cached");
});

test("XERK-241: consecutive creates spread across an org's healthy hosts", async () => {
  const site = "mx5.atlassian.net";
  await jiraBeat("mx5-a", site);
  await jiraBeat("mx5-b", site);
  const hosts = [];
  for (let i = 0; i < 4; i++) {
    const r = await request("POST", `/api/jira/${site}/tickets`, {
      body: { project: "ENG", issueType: "1", summary: `T${i}` }, headers: userHeaders,
    });
    hosts.push(r.body.host);
  }
  assert.ok(hosts.includes("mx5-a") && hosts.includes("mx5-b"),
    `creates stacked on one host: ${hosts.join(",")}`);
});

test("http: the create caches are stripped from the /api/agents payload", async () => {
  await jiraBeat("cm4", "cm4.atlassian.net", {
    createMetaResults: [{ project: null, projects: [{ key: "E", name: "E" }], labels: [], source: "jira", error: null }],
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = res.body.agents.find((a) => a.key === "cm4");
  assert.ok(rec);
  assert.equal(rec.createMeta, undefined);
  assert.equal(rec.createTypes, undefined);
  assert.equal(rec.createResults, undefined);
});

// ---- proven capability gaps (XERK-151) --------------------------------------
// An agent that predates a board write feature ACKS its command and stages
// nothing, so the routes waiting on a staged result used to 202 until the client
// timed out ("the host didn't answer in time"). The ack with no result is the
// evidence; these cover asserting the gap, refusing on it, and clearing it.

// Ack `cmdIds` on a beat, optionally carrying the results that would prove the
// agent handled them.
const ackBeat = (device, siteKey, cmdIds, extra = {}) =>
  jiraBeat(device, siteKey, { ackedCommands: cmdIds, ...extra });

test("http: an acked boardCreateMeta that staged nothing proves the agent is too old", async () => {
  await jiraBeat("gap1", "gap1.atlassian.net", { agentVersion: "0.5.38" });
  const first = await request("GET", "/api/jira/gap1.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(first.status, 202);

  // The beat that DELIVERS the command concludes nothing — it hasn't been taken.
  await jiraBeat("gap1", "gap1.atlassian.net", { agentVersion: "0.5.38" });
  const still = await request("GET", "/api/jira/gap1.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(still.status, 202, "an undelivered command must not read as a gap");

  // Acked, with no createMetaResults: the agent doesn't implement it.
  await ackBeat("gap1", "gap1.atlassian.net", [first.body.cmdId], { agentVersion: "0.5.38" });
  const res = await request("GET", "/api/jira/gap1.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.match(res.body.error, /too old to offer the New-ticket options/);
  assert.match(res.body.error, /v0\.5\.38/);
  // ...and it stops queueing commands the host will only swallow.
  const beat = await jiraBeat("gap1", "gap1.atlassian.net", { agentVersion: "0.5.38" });
  assert.deepEqual(beat.body.commands, []);
});

test("http: a boardCreateMeta that DID stage its result asserts no gap", async () => {
  await jiraBeat("gap2", "gap2.atlassian.net", { agentVersion: "0.6.1" });
  const first = await request("GET", "/api/jira/gap2.atlassian.net/create-meta", { headers: userHeaders });
  await ackBeat("gap2", "gap2.atlassian.net", [first.body.cmdId], {
    agentVersion: "0.6.1",
    createMetaResults: [{ project: null, projects: [{ key: "ENG", name: "Eng" }],
                          labels: [], source: "azure", error: null }],
  });
  const res = await request("GET", "/api/jira/gap2.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
  assert.deepEqual(res.body.projects, [{ key: "ENG", name: "Eng" }]);
});

test("http: the per-project type fetch proves its gap on its own project", async () => {
  await jiraBeat("gap3", "gap3.atlassian.net", { agentVersion: "0.5.38" });
  const q = await request("GET", "/api/jira/gap3.atlassian.net/create-meta?project=ENG", { headers: userHeaders });
  await ackBeat("gap3", "gap3.atlassian.net", [q.body.cmdId], { agentVersion: "0.5.38" });
  const res = await request("GET", "/api/jira/gap3.atlassian.net/create-meta?project=ENG", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.match(res.body.error, /too old/);
});

test("http: an updated agent earns the feature back on its version change", async () => {
  await jiraBeat("gap4", "gap4.atlassian.net", { agentVersion: "0.5.38" });
  const first = await request("GET", "/api/jira/gap4.atlassian.net/create-meta", { headers: userHeaders });
  await ackBeat("gap4", "gap4.atlassian.net", [first.body.cmdId], { agentVersion: "0.5.38" });
  assert.match(
    (await request("GET", "/api/jira/gap4.atlassian.net/create-meta", { headers: userHeaders })).body.error,
    /too old/);

  await jiraBeat("gap4", "gap4.atlassian.net", { agentVersion: "0.6.1" });
  const res = await request("GET", "/api/jira/gap4.atlassian.net/create-meta", { headers: userHeaders });
  assert.equal(res.status, 202, "a version change re-probes rather than refusing on old evidence");
});

test("http: creating a ticket is refused on a proven createTicket gap", async () => {
  await jiraBeat("gap5", "gap5.atlassian.net", { agentVersion: "0.5.38" });
  const body = { project: "ENG", issueType: "1", summary: "New thing" };
  const post = await request("POST", "/api/jira/gap5.atlassian.net/tickets", { body, headers: userHeaders });
  assert.equal(post.status, 200);
  await ackBeat("gap5", "gap5.atlassian.net", [post.body.cmdId], { agentVersion: "0.5.38" });

  const again = await request("POST", "/api/jira/gap5.atlassian.net/tickets", { body, headers: userHeaders });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /too old to create tickets/);
});

test("http: a status change is refused on a proven setTicketStatus gap", async () => {
  await jiraBeat("gap6", "gap6.atlassian.net", { agentVersion: "0.5.38" });
  const body = { value: "31" };
  const post = await request("POST", "/api/jira/gap6.atlassian.net/ENG-1/status", { body, headers: userHeaders });
  assert.equal(post.status, 202);
  await ackBeat("gap6", "gap6.atlassian.net", [post.body.cmdId], { agentVersion: "0.5.38" });

  const again = await request("POST", "/api/jira/gap6.atlassian.net/ENG-1/status", { body, headers: userHeaders });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /too old to change a ticket's status/);
});

test("http: the gap bookkeeping is stripped from /api/agents but the gaps are not", async () => {
  await jiraBeat("gap7", "gap7.atlassian.net", { agentVersion: "0.5.38" });
  const first = await request("GET", "/api/jira/gap7.atlassian.net/create-meta", { headers: userHeaders });
  await ackBeat("gap7", "gap7.atlassian.net", [first.body.cmdId], { agentVersion: "0.5.38" });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = res.body.agents.find((a) => a.key === "gap7");
  assert.equal(rec.resultWaits, undefined);
  assert.ok(rec.unsupported.boardCreateMeta, "the proven gap is worth reading off the fleet payload");
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

// POST /api/jira/<siteKey>/<issueKey>/model — the operator's per-ticket model
// pin (XERK-123). Hub-owned durable state like the /agent pin; the model rides
// the spawnTicket command the hub already routes.

const setModel = (site, key, body) =>
  request("POST", `/api/jira/${site}/${key}/model`, { body, headers: userHeaders });

// A jira host that ALSO probed a model list, so orgModelAliases has more than the
// static family aliases to offer.
const modelBeat = (device, siteKey, available) =>
  request("POST", "/api/heartbeat", {
    body: { device, jira: { available: true, siteKey, user: `${device}@x.com`, tickets: [] },
      models: { available, defaultLabel: "Sonnet 5", at: "2026-07-14T12:00:00Z" } },
    headers: agentHeaders,
  });

test("http: pinning a ticket's model stores it; {auto:true} releases it", async () => {
  await jiraBeat("tmA", "tmSite.atlassian.net");
  const res = await setModel("tmSite.atlassian.net", "ENG-1", { model: "opus" });
  assert.equal(res.status, 200);
  assert.equal(res.body.model, "opus");
  assert.equal(hub.ticketModels["tmSite.atlassian.net/ENG-1"].model, "opus");

  const rel = await setModel("tmSite.atlassian.net", "ENG-1", { auto: true });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.model, null);
  assert.ok(!("tmSite.atlassian.net/ENG-1" in hub.ticketModels));
});

test("http: {model:\"default\"} releases the pin, same as {auto:true}", async () => {
  await jiraBeat("tmDef", "tmDef.atlassian.net");
  await setModel("tmDef.atlassian.net", "ENG-1", { model: "opus" });
  const rel = await setModel("tmDef.atlassian.net", "ENG-1", { model: "default" });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.model, null);
  assert.ok(!("tmDef.atlassian.net/ENG-1" in hub.ticketModels));
});

test("http: the model pin rides the /api/agents payload for the board to render", async () => {
  await jiraBeat("tmPay", "tmPay.atlassian.net");
  await setModel("tmPay.atlassian.net", "ENG-3", { model: "haiku" });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(res.body.ticketModels["tmPay.atlassian.net/ENG-3"].model, "haiku");
});

test("http: a model pin only accepts an alias the org offers", async () => {
  await jiraBeat("tmV", "tmV.atlassian.net");
  // A static family alias is always offerable.
  assert.equal((await setModel("tmV.atlassian.net", "ENG-1", { model: "sonnet" })).status, 200);
  // A model no host probed (and not a static alias) is refused.
  assert.equal((await setModel("tmV.atlassian.net", "ENG-1", { model: "gpt-4" })).status, 400);
  // A bracketed live-switch alias is never a spawn model, even if probed.
  await modelBeat("tmVProbe", "tmVProbe.atlassian.net", ["opus[1m]"]);
  assert.equal((await setModel("tmVProbe.atlassian.net", "ENG-1", { model: "opus[1m]" })).status, 400);
  // A malformed body, and an org nobody reports.
  assert.equal((await setModel("tmV.atlassian.net", "12ab", { model: "opus" })).status, 400);
  assert.equal((await setModel("nobody.atlassian.net", "ENG-1", { model: "opus" })).status, 404);
});

test("http: a probed non-static alias becomes offerable once a host reports it", async () => {
  await modelBeat("tmProbe", "tmProbe.atlassian.net", ["fable", "opus", "default"]);
  const res = await setModel("tmProbe.atlassian.net", "ENG-1", { model: "fable" });
  assert.equal(res.status, 200);
  assert.equal(hub.ticketModels["tmProbe.atlassian.net/ENG-1"].model, "fable");
});

test("http: pinning a ticket's model requires the user login", async () => {
  await jiraBeat("tmAuth", "tmAuth.atlassian.net");
  const res = await request("POST", "/api/jira/tmAuth.atlassian.net/ENG-1/model",
    { body: { model: "opus" } });
  assert.equal(res.status, 401);
  assert.ok(!("tmAuth.atlassian.net/ENG-1" in hub.ticketModels));
});

test("http: a model-pinned ticket carries the model on its spawnTicket command", async () => {
  await ticketBeat("tmSpawn", "tmSpawn.atlassian.net");
  await setModel("tmSpawn.atlassian.net", "ENG-5", { model: "opus" });
  const res = await request("POST", "/api/jira/tmSpawn.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(agents.tmSpawn.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", model: "opus", cmdId: res.body.cmdId },
  ]);
});

test("http: an unpinned ticket spawns with no model on the command (unchanged)", async () => {
  await ticketBeat("tmNone", "tmNone.atlassian.net");
  const res = await request("POST", "/api/jira/tmNone.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.deepEqual(agents.tmNone.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", cmdId: res.body.cmdId },
  ]);
});

test("ticket-model pins survive a hub restart (read back from their own file)", () => {
  const file = path.join(os.tmpdir(), `turma-test-tm-persist-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({
    "o.atlassian.net/ENG-1": { model: "opus", at: 123 } }));
  try {
    const mod = freshServerModule((env) => { env.TICKET_MODELS_FILE = file; });
    assert.equal(mod.ticketModels["o.atlassian.net/ENG-1"].model, "opus");
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

// XERK-61: a spawnTicket the agent acked but that produced no session is a
// FAILED attempt, not a completed one — the agent acks a refusal and a mid-spawn
// exception exactly like a success. So the sweep retries it, bounded and backed
// off, instead of dropping the ticket for the hub's lifetime.
test("auto-start: an acked spawn that left no session is retried, not dropped", async () => {
  resetAutoStart();
  await asBeat("asRetry", "as7.atlassian.net");
  autoStartSweep();
  assert.equal((agents.asRetry.commands || []).length, 1);

  // The agent took the command and produced nothing (a refusal, or a Jira fetch
  // that blew up). Immediately after, the backoff holds the retry off.
  agents.asRetry.commands = [];
  autoStartSweep();
  assert.equal((agents.asRetry.commands || []).length, 0,
    "the retry waits out its backoff rather than re-queuing every 15s");

  // Once the backoff has elapsed, the ticket is tried again.
  autoStarted.get("as7.atlassian.net\x00ENG-5").nextAt = 0;
  autoStartSweep();
  assert.deepEqual((agents.asRetry.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(autoStarted.get("as7.atlassian.net\x00ENG-5").attempts, 2);
});

test("auto-start: retries never give up — a ticket keeps being tried, backing off to a steady ceiling", async () => {
  // XERK-109: the earlier bounded-budget behaviour blacklisted a ticket for the
  // hub's lifetime once it had flaked a handful of times, so a transiently-blocked
  // ticket never started even after its condition cleared and every visible
  // condition was met. The cap is gone; retries only slow down, they never stop.
  resetAutoStart();
  await asBeat("asBudget", "as7b.atlassian.net");
  const k = "as7b.atlassian.net\x00ENG-5";
  // Every attempt is acked and leaves no session. Far more rounds than the old
  // budget would have allowed — the attempt counter settles at the backoff
  // ceiling instead of climbing without bound.
  for (let i = 0; i < 20; i++) {
    agents.asBudget.commands = [];
    const e = autoStarted.get(k);
    if (e) e.nextAt = 0;      // pretend the backoff has elapsed
    autoStartSweep();
    assert.deepEqual((agents.asBudget.commands || []).map((c) => c.issueKey),
      ["ENG-5"], "the ticket is retried on every eligible sweep, never abandoned");
  }
  assert.equal(autoStarted.get(k).attempts, 5,
    "the counter settles at the backoff ceiling (AUTO_START_BACKOFF_STEPS)");
  // The steady-state retry is spaced by the max backoff, so a still-stuck ticket
  // re-queues at most once per ceiling interval rather than every sweep.
  agents.asBudget.commands = [];
  autoStartSweep();  // nextAt is now ~10min out, so this sweep must NOT re-queue
  assert.equal((agents.asBudget.commands || []).length, 0,
    "within the ceiling backoff the retry holds off");
});

test("auto-start: a session appearing ends the retries and forgets the attempts", async () => {
  resetAutoStart();
  await asBeat("asWon", "as7c.atlassian.net");
  autoStartSweep();
  const k = "as7c.atlassian.net\x00ENG-5";
  assert.equal(autoStarted.get(k).attempts, 1);
  // The spawn worked: the session (queued or running) reports its ticket back.
  agents.asWon.commands = [];
  agents.asWon.sessions = [{ id: "s1", status: "queued", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "as7c.atlassian.net" } }];
  autoStartSweep();
  assert.equal((agents.asWon.commands || []).length, 0);
  assert.ok(!autoStarted.has(k), "the attempt record is dropped, not left to grow");
});

test("auto-start: a ticket that flaked past the old budget still self-heals once the block clears (XERK-109)", async () => {
  resetAutoStart();
  await asBeat("asHeal", "as7e.atlassian.net");
  const k = "as7e.atlassian.net\x00ENG-5";
  // Flake far more times than the old 4-attempt budget would have tolerated —
  // the hub used to have permanently given up by now.
  for (let i = 0; i < 8; i++) {
    agents.asHeal.commands = [];
    const e = autoStarted.get(k);
    if (e) e.nextAt = 0;
    autoStartSweep();
  }
  assert.ok((agents.asHeal.commands || []).some((c) => c.issueKey === "ENG-5"),
    "still retrying after the old budget would have blacklisted it");
  // Now the transient condition clears and the spawn finally takes: the session
  // reports its ticket, and auto-start settles for good.
  agents.asHeal.commands = [];
  agents.asHeal.sessions = [{ id: "s1", status: "running", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "as7e.atlassian.net" } }];
  autoStartSweep();
  assert.equal((agents.asHeal.commands || []).length, 0);
  assert.ok(!autoStarted.has(k), "the attempt record is dropped once it starts");
});

test("auto-start: an offline org spends no attempt (the failure isn't the ticket's)", async () => {
  resetAutoStart();
  await asBeat("asDown", "as7d.atlassian.net");
  agents.asDown.lastSeen = Date.now() - 10 * 60 * 1000;  // offline
  autoStartSweep();
  assert.equal((agents.asDown.commands || []).length, 0);
  assert.ok(!autoStarted.has("as7d.atlassian.net\x00ENG-5"));
  // The host returns: the ticket starts on the very next sweep, with its full
  // budget intact rather than sitting out a backoff it never earned.
  agents.asDown.lastSeen = Date.now();
  autoStartSweep();
  assert.deepEqual((agents.asDown.commands || []).map((c) => c.issueKey), ["ENG-5"]);
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

// ---- manual org colors (XERK-145) -------------------------------------------

test("POST /api/jira/<site>/color pins the slot, rides the payload, releases on auto", async () => {
  await asBeat("ocApi", "ocapi.atlassian.net", { autoStart: false });

  // Pin slot 3.
  let r = await request("POST", "/api/jira/ocapi.atlassian.net/color",
    { body: { slot: 3 }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, slot: 3 });
  assert.equal(orgColors["ocapi.atlassian.net"], 3);

  // It rides the fleet payload as a top-level siteKey -> slot map.
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.orgColors["ocapi.atlassian.net"], 3);

  // Release back to auto — the key is removed (presence = pinned).
  r = await request("POST", "/api/jira/ocapi.atlassian.net/color",
    { body: { auto: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, slot: null });
  assert.equal("ocapi.atlassian.net" in orgColors, false);
});

test("POST /api/jira/<site>/color rejects a bad slot and an unknown org", async () => {
  await asBeat("ocApi2", "ocapi2.atlassian.net", { autoStart: false });
  // Out-of-range, non-integer, or missing slot without auto.
  for (const body of [{}, { slot: 0 }, { slot: 9 }, { slot: 2.5 }, { slot: "3" }, { auto: false }]) {
    const r = await request("POST", "/api/jira/ocapi2.atlassian.net/color",
      { body, headers: userHeaders });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // An org no host reports can't be pinned (no phantom entries).
  const r = await request("POST", "/api/jira/nobody.atlassian.net/color",
    { body: { slot: 3 }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody.atlassian.net" in orgColors, false);
});

test("POST /api/jira/<site>/color needs the user login", async () => {
  await asBeat("ocApi3", "ocapi3.atlassian.net", { autoStart: false });
  const r = await request("POST", "/api/jira/ocapi3.atlassian.net/color",
    { body: { slot: 3 } });
  assert.equal(r.status, 401);
  assert.equal("ocapi3.atlassian.net" in orgColors, false);
});

test("POST /api/jira/<site>/autostart needs the user login", async () => {
  await asBeat("asApi3", "asapi3.atlassian.net", { autoStart: false });
  const r = await request("POST", "/api/jira/asapi3.atlassian.net/autostart",
    { body: { enabled: true } });
  assert.equal(r.status, 401);
  assert.equal("asapi3.atlassian.net" in autoStartOrgs, false);
});

// ---- auto-stop a session when its ticket moves to Done (XERK-45, XERK-161) ----
// The lifecycle counterpart to auto-start. A human moving a ticket to Done is the
// "work finished" signal; the kill ends the session cleanly (resumable,
// worktree/PRs kept) and frees its MAX_SESSIONS slot. UNLIKE auto-start this is
// UNCONDITIONAL — NOT gated on the per-org "auto" opt-in (which governs only
// auto-STARTING work), so a Done ticket retires its session in every org.

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

test("auto-stop: a Done ticket's live session is killed", async () => {
  autoStopped.clear();
  await doneBeat("apHost", "ap1.atlassian.net");
  autoStopSweep();
  assert.deepEqual((agents.apHost.commands || []).map((c) => [c.type, c.sessionId]),
    [["kill", "sd1"]]);
});

test("auto-stop: kills a Done ticket's session even when 'auto' is OFF (XERK-161)", async () => {
  // The per-org "auto" opt-in governs only auto-STARTING work; a human moving a
  // ticket to Done must always retire its session, whatever the toggle says.
  autoStopped.clear();
  await asBeat("apOff", "ap2.atlassian.net", {
    autoStart: false,
    tickets: [{ key: "ENG-9", statusCategory: "done",
                repoGuess: { repo: "Turma", cloned: true } }],
    sessions: [{ id: "sd1", status: "running",
                 ticket: { key: "ENG-9", siteKey: "ap2.atlassian.net" } }],
  });
  assert.equal(orgsWithAutoStart().has("ap2.atlassian.net"), false, "org must be opted OUT");
  autoStopSweep();
  assert.deepEqual((agents.apOff.commands || []).map((c) => [c.type, c.sessionId]),
    [["kill", "sd1"]]);
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

test("transcribePcm: WHISPER_LANGUAGE default sends the language hint", async () => {
  let form;
  globalThis.fetch = async (_url, opts) => {
    form = opts.body;
    return { ok: true, json: async () => ({ text: "hi" }) };
  };
  await transcribePcm(Buffer.from([1]));
  assert.equal(form.get("language"), "en");
  restoreFetch();
});

test("transcribePcm: empty WHISPER_LANGUAGE omits the hint (auto-detect)", async () => {
  // A multilingual model (Parakeet) auto-detects when no language is pinned. An
  // explicit empty WHISPER_LANGUAGE must OMIT the field — `??` lets "" through,
  // where `||` would fall back to the "en" default and force English.
  let form;
  globalThis.fetch = async (_url, opts) => {
    form = opts.body;
    return { ok: true, json: async () => ({ text: "hola", language: "es" }) };
  };
  const auto = freshServerModule((env) => { env.WHISPER_LANGUAGE = ""; });
  const result = await auto.transcribePcm(Buffer.from([1]));
  assert.equal(form.has("language"), false);
  assert.deepEqual(result, { text: "hola", language: "es" });
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

// ---- session migration across hosts (XERK-101) --------------------------------
// Move a running session from one agent to another in the same org. The hub
// orchestrates: exportSession on the source, a raw-transcript relay through the
// hub, importSession on the target, then a kill of the source once it's up.

// Seed a host reporting a running, worktree-backed session `s1` on `repo`, in
// org `site`. Fields are exactly what the /migrate endpoint validates.
const migHost = (device, site, {
  session = "s1", repo = "Turma", repos = ["Turma"], status = "running",
  root = false, transcriptId = "trans-" + device, extraSessions = [],
  modelSource = "local",
} = {}) =>
  request("POST", "/api/heartbeat", {
    body: {
      device,
      repos: repos.map((name) => ({ name, path: `/git/${name}` })),
      jira: { available: true, configured: true, siteKey: site, user: `${device}@x.com`, tickets: [] },
      sessions: [
        {
          id: session, status, root, repo, transcriptId,
          worktreePath: `/git/.turma/worktrees/${repo}/${session}`,
          model: "opus", permissionMode: "auto", summary: "Fix the logs",
          modelSource,
          ticket: { key: "ENG-9", siteKey: site, url: "u", summary: "Fix the logs", branch: "ENG-9" },
        },
        ...extraSessions,
      ],
    },
    headers: agentHeaders,
  });

// A raw-body request (the JSON `request` helper can't carry an octet-stream).
function requestRaw(method, pathName, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathName, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, body: parsed, buf, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const migrate = (host, session, body) =>
  request("POST", `/api/agents/${host}/sessions/${session}/migrate`,
    { body, headers: userHeaders });

test("migrate: rejects a bad source, target, or org mismatch", async () => {
  await migHost("mSrc", "m1.atlassian.net");
  await migHost("mTgt", "m1.atlassian.net");
  await migHost("mOther", "m2.atlassian.net"); // a different org

  // unknown session
  assert.equal((await migrate("mSrc", "nope", { host: "mTgt" })).status, 404);
  // no target / same host
  assert.equal((await migrate("mSrc", "s1", { host: "" })).status, 400);
  assert.equal((await migrate("mSrc", "s1", { host: "mSrc" })).status, 400);
  // unknown target
  assert.equal((await migrate("mSrc", "s1", { host: "ghost" })).status, 404);
  // different org
  assert.equal((await migrate("mSrc", "s1", { host: "mOther" })).status, 409);
});

test("migrate: rejects a root session and one with no conversation yet", async () => {
  await migHost("mRoot", "mr.atlassian.net", { root: true });
  await migHost("mRootTgt", "mr.atlassian.net");
  assert.equal((await migrate("mRoot", "s1", { host: "mRootTgt" })).status, 409);

  await migHost("mFresh", "mf.atlassian.net", { transcriptId: null });
  await migHost("mFreshTgt", "mf.atlassian.net");
  assert.equal((await migrate("mFresh", "s1", { host: "mFreshTgt" })).status, 409);
});

test("migrate: rejects a target that lacks the repo cloned", async () => {
  await migHost("mHas", "mrepo.atlassian.net", { repos: ["Turma"] });
  await migHost("mLacks", "mrepo.atlassian.net", { repos: ["Other"] });
  const r = await migrate("mHas", "s1", { host: "mLacks" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /clone it there first/);
});

test("migrate: full move — export, relay, import, then kill the source", async () => {
  await migHost("mgA", "mg.atlassian.net");
  await migHost("mgB", "mg.atlassian.net");

  // 1. Start the move: exportSession queued on the source, migration exporting.
  const r = await migrate("mgA", "s1", { host: "mgB" });
  assert.equal(r.status, 200);
  const mid = r.body.migrationId;
  assert.ok(mid);
  assert.deepEqual(agents.mgA.commands, [
    { type: "exportSession", sessionId: "s1", migrationId: mid, cmdId: agents.mgA.commands[0].cmdId },
  ]);
  assert.equal(migrations.get(mid).phase, "exporting");

  // 2. The source uploads the raw transcript bundle -> importSession on target.
  const blob = Buffer.from("PRETEND-GZIP-TAR-BYTES");
  const up = await requestRaw("POST", `/api/agents/mgA/migrations/${mid}/blob`,
    { body: blob, headers: { authorization: "Bearer agenttok", "content-type": "application/octet-stream" } });
  assert.equal(up.status, 200);
  const m = migrations.get(mid);
  assert.equal(m.phase, "importing");
  const imp = agents.mgB.commands.find((c) => c.type === "importSession");
  assert.ok(imp);
  assert.equal(imp.migrationId, mid);
  assert.equal(imp.transcriptId, "trans-mgA");
  assert.equal(imp.cwd, "/git/.turma/worktrees/Turma/s1");
  assert.equal(imp.repo, "Turma");
  assert.equal(imp.model, "opus");
  // The moved session must arrive still failed over (XERK-246); without this
  // the whole chain — session payload, migration meta, importSession command —
  // could drop it and every suite would stay green.
  assert.equal(imp.modelSource, "local");
  assert.equal(imp.ticket.key, "ENG-9");
  assert.equal(imp.migratedFrom.host, "mgA");
  assert.equal(m.importCmdId, imp.cmdId);

  // 3. The target agent pulls the bundle back (byte-identical).
  const dl = await requestRaw("GET", `/api/agents/mgB/migrations/${mid}/blob`,
    { headers: { authorization: "Bearer agenttok" } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers["content-type"], "application/octet-stream");
  assert.ok(blob.equals(dl.buf));

  // 4. The target session comes up (spawnCmdId === importCmdId) -> the hub kills
  //    the source and finishes the migration on that heartbeat.
  await migHost("mgB", "mg.atlassian.net", {
    extraSessions: [{ id: "new1", status: "running", root: false, repo: "Turma",
      transcriptId: "trans-mgA", worktreePath: "/git/.turma/worktrees/Turma/s1",
      spawnCmdId: m.importCmdId }],
  });
  const after = migrations.get(mid);
  assert.equal(after.phase, "done");
  assert.equal(after.targetSessionId, "new1");
  assert.ok(agents.mgA.commands.some((c) => c.type === "kill" && c.sessionId === "s1"),
    "source session should be killed once the target is up");
  // The blob is freed on handoff.
  assert.equal(after.blob, null);
});

test("migrate: a second move of the same session is single-flighted", async () => {
  await migHost("sfA", "sf.atlassian.net");
  await migHost("sfB", "sf.atlassian.net");
  const first = await migrate("sfA", "s1", { host: "sfB" });
  assert.equal(first.status, 200);
  const second = await migrate("sfA", "s1", { host: "sfB" });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already being moved/);
});

test("migrate: a stalled move times out and frees its blob", async () => {
  await migHost("toA", "to.atlassian.net");
  await migHost("toB", "to.atlassian.net");
  const r = await migrate("toA", "s1", { host: "toB" });
  const m = migrations.get(r.body.migrationId);
  m.startedAt = Date.now() - 10 * 60 * 1000; // well past MIGRATE_TIMEOUT_MS
  advanceMigrations();
  assert.equal(m.phase, "failed");
  assert.match(m.error, /timed out/);
  assert.equal(m.blob, null);
});

test("migrate: the blob relay rejects an unauthenticated caller", async () => {
  await migHost("auA", "au.atlassian.net");
  await migHost("auB", "au.atlassian.net");
  const r = await migrate("auA", "s1", { host: "auB" });
  const mid = r.body.migrationId;
  // No credentials, and a bad bearer token, are both refused (like the
  // heartbeat, the user login also works — but nothing unauthenticated does).
  const anon = await requestRaw("POST", `/api/agents/auA/migrations/${mid}/blob`,
    { body: Buffer.from("x") });
  assert.equal(anon.status, 401);
  const badTok = await requestRaw("POST", `/api/agents/auA/migrations/${mid}/blob`,
    { body: Buffer.from("x"), headers: { authorization: "Bearer nope" } });
  assert.equal(badTok.status, 401);
});

// ---- file attachments (XERK-234) -------------------------------------------
// The hub is the RELAY, not the store: a client POSTs the bytes, they sit in
// memory under an id, and the agent GETs them when it picks up the input command
// naming that id.

const upHost = (device, extra = {}) =>
  request("POST", "/api/heartbeat", {
    body: { device, uploadMaxBytes: 1 << 25, ...extra }, headers: agentHeaders,
  });

const stage = (host, session, name, body, headers = userHeaders) =>
  requestRaw("POST",
    `/api/agents/${host}/sessions/${session}/uploads?name=${encodeURIComponent(name)}`,
    { body, headers });

test("uploads: safeUploadName can never escape the uploads directory", () => {
  // Mirrored by the agent's safe_upload_name and android's sanitizeUploadName.
  assert.equal(safeUploadName("../../etc/passwd"), "passwd");
  assert.equal(safeUploadName("/abs/x.tar.gz"), "x.tar.gz");
  assert.equal(safeUploadName("C:\\win\\a.png"), "a.png");
  // Never a dotfile (it would hide the file just attached), never nameless.
  assert.equal(safeUploadName("  ..hidden.png"), "hidden.png");
  assert.equal(safeUploadName(""), "upload");
  assert.equal(safeUploadName("."), "upload");
  // Anything outside the safe set becomes an underscore, and an over-long name
  // keeps its extension — that is what says what kind of file it is.
  assert.equal(safeUploadName("déjà vu (1).PNG"), "d_j_ vu (1).PNG");
  const long = safeUploadName("a".repeat(130) + ".png");
  assert.equal(long.length, 100);
  assert.ok(long.endsWith(".png"));
});

test("uploads: uploadCapFor is the capability flag as well as the cap", () => {
  // An agent predating attachments reports nothing and would DROP the uploads on
  // an input command without a word — 0 is what hides the composer's clip.
  assert.equal(uploadCapFor({}), 0);
  assert.equal(uploadCapFor({ uploadMaxBytes: 0 }), 0);
  assert.equal(uploadCapFor({ uploadMaxBytes: "nonsense" }), 0);
  assert.equal(uploadCapFor({ uploadMaxBytes: 1 << 20 }), 1 << 20);
  // A wild claim is still clamped to the hub's own ceiling.
  assert.equal(uploadCapFor({ uploadMaxBytes: 1e12 }), 1 << 25);
});

test("uploads: a staged file comes back with a sanitized name and an id", async () => {
  await upHost("upA");
  const res = await stage("upA", "s1", "../shot.png", Buffer.from("PNGDATA"));
  assert.equal(res.status, 200);
  assert.equal(res.body.name, "shot.png");
  assert.equal(res.body.size, 7);
  assert.ok(res.body.uploadId);
  // Nothing is queued yet — the file reaches the session only when a message is.
  const beat = await request("POST", "/api/heartbeat", { body: { device: "upA" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, []);
});

test("uploads: a host whose agent predates attachments refuses the upload", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "upOld" }, headers: agentHeaders });
  const res = await stage("upOld", "s1", "a.png", Buffer.from("x"));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /too old/);
});

test("uploads: an empty file and one past the cap are refused", async () => {
  await upHost("upCap", { uploadMaxBytes: 16 });
  const empty = await stage("upCap", "s1", "a.png", null);
  assert.equal(empty.status, 400);
  const big = await stage("upCap", "s1", "a.png", Buffer.alloc(17, 1));
  assert.equal(big.status, 413);
  assert.equal(big.body.limit, 16);
});

test("uploads: staging needs the user login, collecting needs the agent token", async () => {
  await upHost("upAuth");
  const anon = await stage("upAuth", "s1", "a.png", Buffer.from("x"), {});
  assert.equal(anon.status, 401);
  // The agent token is NOT a way in on the operator's side of the relay.
  const asAgent = await stage("upAuth", "s1", "a.png", Buffer.from("x"), agentHeaders);
  assert.equal(asAgent.status, 401);

  const ok = await stage("upAuth", "s1", "a.png", Buffer.from("bytes"));
  const id = ok.body.uploadId;
  const blobAnon = await requestRaw("GET", `/api/agents/upAuth/uploads/${id}/blob`);
  assert.equal(blobAnon.status, 401);
  const blob = await requestRaw("GET", `/api/agents/upAuth/uploads/${id}/blob`,
    { headers: agentHeaders });
  assert.equal(blob.status, 200);
  assert.equal(blob.buf.toString(), "bytes");
});

test("uploads: one host's agent can't collect another host's staged file", async () => {
  await upHost("upMine");
  await upHost("upTheirs");
  const ok = await stage("upMine", "s1", "a.png", Buffer.from("secret"));
  const res = await requestRaw("GET", `/api/agents/upTheirs/uploads/${ok.body.uploadId}/blob`,
    { headers: agentHeaders });
  assert.equal(res.status, 404);
});

test("uploads: collecting does NOT drop the blob (commands are at-least-once)", async () => {
  await upHost("upTwice");
  const ok = await stage("upTwice", "s1", "a.png", Buffer.from("keepme"));
  const url = `/api/agents/upTwice/uploads/${ok.body.uploadId}/blob`;
  assert.equal((await requestRaw("GET", url, { headers: agentHeaders })).status, 200);
  const again = await requestRaw("GET", url, { headers: agentHeaders });
  assert.equal(again.status, 200);
  assert.equal(again.buf.toString(), "keepme");
});

test("uploads: the input command carries the staged files' ids, names and sizes", async () => {
  await upHost("upSend");
  const a = await stage("upSend", "s1", "shot.png", Buffer.from("one"));
  const b = await stage("upSend", "s1", "spec.pdf", Buffer.from("twotwo"));
  const res = await request("POST", "/api/agents/upSend/sessions/s1/input", {
    body: { text: "what is this?", uploadIds: [a.body.uploadId, b.body.uploadId] },
    headers: userHeaders,
  });
  assert.equal(res.status, 200);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "upSend" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [{
    type: "input", sessionId: "s1", text: "what is this?", cmdId: res.body.cmdId,
    uploads: [
      { id: a.body.uploadId, name: "shot.png", size: 3 },
      { id: b.body.uploadId, name: "spec.pdf", size: 6 },
    ],
  }]);
});

test("uploads: a message may be attachments alone, but not empty of both", async () => {
  await upHost("upBare");
  const a = await stage("upBare", "s1", "a.png", Buffer.from("x"));
  const withFile = await request("POST", "/api/agents/upBare/sessions/s1/input", {
    body: { text: "", uploadIds: [a.body.uploadId] }, headers: userHeaders,
  });
  assert.equal(withFile.status, 200);
  const neither = await request("POST", "/api/agents/upBare/sessions/s1/input", {
    body: { text: "  ", uploadIds: [] }, headers: userHeaders,
  });
  assert.equal(neither.status, 400);
  assert.deepEqual(neither.body, { error: "text required" });
});

test("uploads: an ordinary message still queues exactly what it always did", async () => {
  await upHost("upPlain");
  const res = await request("POST", "/api/agents/upPlain/sessions/s1/input", {
    body: { text: "just talking" }, headers: userHeaders,
  });
  const beat = await request("POST", "/api/heartbeat", { body: { device: "upPlain" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "input", sessionId: "s1", text: "just talking", cmdId: res.body.cmdId },
  ]);
});

test("uploads: a stale, foreign or over-many id refuses the send outright", async () => {
  await upHost("upStale");
  await upHost("upElse");
  // Refusing beats sending the text with the file silently missing.
  const gone = await request("POST", "/api/agents/upStale/sessions/s1/input", {
    body: { text: "hi", uploadIds: ["deadbeef"] }, headers: userHeaders,
  });
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /expired/);

  // Staged for THIS host but a different session, and for another host.
  const other = await stage("upStale", "s2", "a.png", Buffer.from("x"));
  const wrongSession = await request("POST", "/api/agents/upStale/sessions/s1/input", {
    body: { text: "hi", uploadIds: [other.body.uploadId] }, headers: userHeaders,
  });
  assert.equal(wrongSession.status, 404);
  const elsewhere = await stage("upElse", "s1", "a.png", Buffer.from("x"));
  const wrongHost = await request("POST", "/api/agents/upStale/sessions/s1/input", {
    body: { text: "hi", uploadIds: [elsewhere.body.uploadId] }, headers: userHeaders,
  });
  assert.equal(wrongHost.status, 404);

  const many = await request("POST", "/api/agents/upStale/sessions/s1/input", {
    body: { text: "hi", uploadIds: Array.from({ length: UPLOAD_MAX_PER_MESSAGE + 1 }, (_, i) => "x" + i) },
    headers: userHeaders,
  });
  assert.equal(many.status, 400);
  assert.match(many.body.error, /at most/);
});

test("uploads: the relay is memory-only — nothing rides the fleet payload", async () => {
  await upHost("upLeak");
  await stage("upLeak", "s1", "secret.png", Buffer.from("SECRETBYTES"));
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  assert.ok(!JSON.stringify(res.body).includes("SECRETBYTES"));
  // It IS held, though — the agent has to be able to come and get it.
  assert.ok([...uploads.values()].some((u) => u.host === "upLeak"));
});

// --- local-model failover (XERK-246) -----------------------------------------
// Moving a session onto the host's self-hosted model when Claude usage runs out.
// The route is gated on the host REPORTING the capability, because an agent that
// cannot do it would ack the command and drop it silently.

test("http: model-source endpoint queues a setModelSource command", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "lm1", localModel: { available: true, model: "gpt-oss:120b" } },
    headers: agentHeaders,
  });
  const res = await request("POST", "/api/agents/lm1/sessions/sess1/model-source", {
    body: { modelSource: "local" }, headers: userHeaders,
  });
  assert.equal(res.status, 200);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "lm1" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "setModelSource", sessionId: "sess1", modelSource: "local", cmdId: res.body.cmdId },
  ]);
});

test("http: model-source refuses local on a host that reports no local model", async () => {
  // No localModel block at all — an agent predating the failover.
  await request("POST", "/api/heartbeat", { body: { device: "lm2" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/lm2/sessions/sess1/model-source", {
    body: { modelSource: "local" }, headers: userHeaders,
  });
  assert.equal(res.status, 409);
  // Going BACK to the subscription is always allowed — that path needs nothing
  // from the host, and refusing it could strand a session on a local model
  // whose configuration was removed.
  const back = await request("POST", "/api/agents/lm2/sessions/sess1/model-source", {
    body: { modelSource: "subscription" }, headers: userHeaders,
  });
  assert.equal(back.status, 200);
});

test("http: model-source rejects anything outside the enum", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "lm3", localModel: { available: true } }, headers: agentHeaders,
  });
  for (const modelSource of ["", "bedrock", "LOCAL", 7]) {
    const res = await request("POST", "/api/agents/lm3/sessions/sess1/model-source", {
      body: { modelSource }, headers: userHeaders,
    });
    assert.equal(res.status, 400, String(modelSource));
  }
});

test("heartbeat: localModel survives into the fleet payload", async () => {
  await request("POST", "/api/heartbeat", {
    body: {
      device: "lm4",
      localModel: { available: true, model: "gpt-oss:120b", contextTokens: 65536 },
      sessions: [{ id: "s1", repo: "Turma", status: "running", modelSource: "local" }],
    },
    headers: agentHeaders,
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const host = res.body.agents.find((a) => a.device === "lm4");
  assert.equal(host.localModel.available, true);
  assert.equal(host.localModel.model, "gpt-oss:120b");
  // The per-session field the UI chips off must reach clients too.
  assert.equal(host.sessions[0].modelSource, "local");
});

test("http: spawn validates modelSource like the switch route does", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "lm5", localModel: { available: true, model: "gpt-oss:120b" } },
    headers: agentHeaders,
  });
  // Junk must 400 here rather than land as an errored session card on the host.
  const bad = await request("POST", "/api/agents/lm5/sessions", {
    body: { repo: "Turma", modelSource: "bedrock; rm -rf /" }, headers: userHeaders,
  });
  assert.equal(bad.status, 400);
  const ok = await request("POST", "/api/agents/lm5/sessions", {
    body: { repo: "Turma", modelSource: "local" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
});

test("http: spawning onto local is refused on a host without one", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "lm6" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/lm6/sessions", {
    body: { repo: "Turma", modelSource: "local" }, headers: userHeaders,
  });
  assert.equal(res.status, 409);
});

test("http: /model refuses a session running on the self-hosted model", async () => {
  // Mirror of /model-source's 409: every alias the picker could offer is one
  // the gateway rejects, so a silent 200 would let an out-of-parity client
  // break the session with nothing to show for it.
  await request("POST", "/api/heartbeat", {
    body: {
      device: "lm7",
      localModel: { available: true, model: "gpt-oss:120b" },
      sessions: [
        { id: "loc", repo: "R", status: "running", modelSource: "local" },
        { id: "sub", repo: "R", status: "running", modelSource: "subscription" },
      ],
    },
    headers: agentHeaders,
  });
  const refused = await request("POST", "/api/agents/lm7/sessions/loc/model", {
    body: { model: "opus" }, headers: userHeaders,
  });
  assert.equal(refused.status, 409);
  const ok = await request("POST", "/api/agents/lm7/sessions/sub/model", {
    body: { model: "opus" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
});

test("heartbeat: localModel is a known key, not an unknown-field remnant", async () => {
  // It is the capability flag the hub and every composer gate on. Dropping it
  // from HEARTBEAT_KNOWN_KEYS would make the control vanish fleet-wide.
  assert.ok(hub.HEARTBEAT_KNOWN_KEYS.has("localModel"));
});

test("normalizeLocalModel coerces the block so one host cannot hide the fleet", () => {
  // Android decodes /api/agents ATOMICALLY into typed fields, so a wrong-typed
  // localModel from ONE host throws for the whole array and every other host
  // silently disappears from that phone. Same contract, and same reason, as
  // normalizeLimits beside it.
  const norm = (localModel) => {
    const p = { device: "h", localModel };
    hub.normalizeLocalModel(p);
    return p.localModel;
  };

  // A good block passes through unchanged.
  assert.deepEqual(
    norm({ available: true, model: "gpt-oss:120b", contextTokens: 81920 }),
    { available: true, model: "gpt-oss:120b", contextTokens: 81920 },
  );

  // `available` is STRICTLY boolean: a truthy string would offer the switch on
  // a host that cannot do it, and the command would be acked and dropped.
  assert.deepEqual(norm({ available: "yes", model: "x" }),
    { available: false, model: null, contextTokens: null });
  assert.deepEqual(norm({ available: 1 }),
    { available: false, model: null, contextTokens: null });

  // A non-string model and an out-of-Int contextTokens degrade to null rather
  // than failing the decode. contextTokens is unused by the UI, so this is free.
  assert.deepEqual(norm({ available: true, model: 12345, contextTokens: 9999999999 }),
    { available: true, model: null, contextTokens: null });
  assert.deepEqual(norm({ available: true, model: "m", contextTokens: 1.5 }),
    { available: true, model: "m", contextTokens: null });

  // Not an object at all -> null, which every client reads as "cannot fail over".
  assert.equal(norm("yes"), null);
  assert.equal(norm([1, 2]), null);
  assert.equal(norm(null), null);

  // An agent predating the failover sends nothing; the key must stay absent
  // rather than become an explicit null, so the payload is byte-identical.
  const old = { device: "h" };
  hub.normalizeLocalModel(old);
  assert.ok(!("localModel" in old));
});

test("heartbeat: a rogue localModel is coerced at ingest, not served raw", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "lm6", localModel: { available: "yes", contextTokens: 9999999999 } },
    headers: agentHeaders,
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const host = res.body.agents.find((a) => a.device === "lm6");
  assert.equal(host.localModel.available, false);
  assert.equal(host.localModel.contextTokens, null);
  // And the whole fleet is still served — the point of coercing at ingest.
  assert.ok(res.body.agents.length > 1);
});

