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
const zlib = require("zlib");
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
// Same trick for the stalled-body reclaim (XERK-258): the fleet gives a body
// holding budget 20s of silence, which is only testable wound down.
process.env.BODY_IDLE_TIMEOUT_MS = "400";
// And the exclusive-lane occupancy ceiling, which the fleet gives 10 minutes.
process.env.BIG_LANE_MAX_HOLD_MS = "3000";
// The registry cap (XERK-272) is sized for a FLEET — the deployed one is a
// handful of hosts. This suite is not a fleet: it invents ~100 synthetic host
// names in one process and never removes them, so it is lifted here rather than
// having every later test refused. The cap itself, its eviction rule and the
// restore trim get their own process in registry-cap.test.js, which pins tiny
// values and drives them over the wire.
process.env.AGENTS_MAX = "1000";
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
process.env.TRIAGE_POLICIES_FILE = path.join(
  os.tmpdir(),
  `turma-test-triage-policies-${process.pid}.json`
);
process.env.TRIAGE_ACTIONS_FILE = path.join(
  os.tmpdir(),
  `turma-test-triage-actions-${process.pid}.json`
);
process.env.PRIORITY_WRITEBACK_ORGS_FILE = path.join(
  os.tmpdir(),
  `turma-test-priority-writeback-orgs-${process.pid}.json`
);
process.env.TICKET_MODELS_FILE = path.join(
  os.tmpdir(),
  `turma-test-ticket-models-${process.pid}.json`
);
process.env.TICKET_RUNTIMES_FILE = path.join(
  os.tmpdir(),
  `turma-test-ticket-runtimes-${process.pid}.json`
);
process.env.ORG_COLORS_FILE = path.join(
  os.tmpdir(),
  `turma-test-org-colors-${process.pid}.json`
);
// Durable token-usage history (XERK-338) is a /data file of its own, read at
// require time like the stores above, so it gets a throwaway one too.
process.env.USAGE_LEDGER_FILE = path.join(
  os.tmpdir(),
  `turma-test-usage-ledger-${process.pid}.json`
);
// The migration relay spools transcript bundles to disk (XERK-263) and sweeps
// its whole directory at boot, so it gets a throwaway one of its own — sharing
// /data/migrations, or one dir across test files, would have each sweep delete
// the others' spools.
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-test-migrations-"));
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
// dsh ships behind an OFF-by-default in-code kill switch (server.js DSH_ENABLED).
// The dsh tests below flip it ON to exercise the retained machinery; this resets
// it after EVERY test (runs even on a thrown assertion) so that ON state can
// never leak into the non-dsh tests that surround them.
test.afterEach(() => {
  hub.__setDshEnabled(false);
  hub.__setQwenEnabled(false);
  // Release the XERK-550 auto-merge opt-in so server.js's LIVE 15s sweep
  // interval (which runs autoMergeSweep/autoCloseSweep) idles outside the exact
  // test that set it up — otherwise a populated map keeps those sweeps churning
  // the global `agents` map during unrelated timing-sensitive tests later in the
  // run (the control-WS liveness cases).
  for (const k of Object.keys(autoMergeOrgs)) delete autoMergeOrgs[k];
  autoMergeState.clear();
  autoClosed.clear();
});
// notify() no-ops when no device is registered; register one so the alert tests
// see the fan-out. Real fan-out/pruning is exercised separately below.
hub.registerDevice("capture-device", "android", ["dismiss"]);
const {
  server, agents, queueCommand, findSession, orgPeers, boundOrgOf, orgDrifted,
  orgDriftWarned, warnOrgDrift, siteKeyOf, normalizeJira, normalizeClones,
  normalizeTriage,
  CLONE_PROGRESS_MAX,
  wsAccept, wsEncode, wsParser, WS_FRAME_MAX, channelDuplex,
  heartbeatAlerts, prAlertDecision, readyForReview, sessionWorking, sanitizeLiveAgents,
  invalidateAgentsCache, sanitizeHeartbeat, agentRecordSize, safeAgentsCache,
  serializeAgentsForSave,
  HEARTBEAT_UNKNOWN_MAX, AGENT_RECORD_MAX, REFUSED_DETAIL_MAX,
  userAuthorized, agentPresented, agentWsAuthorized, triggerAuthorized, fmtDur,
  agentBearerKind, agentHostRefusal, agentPresentedRefusal, hostAgentToken, tokenHost, ttydAuth,
  controlChannels, pendingChannels,
  credentialsMatch, issueSessionToken, sessionTokenValid,
  pcmToWav, transcribePcm, issueWsToken, wsTokenValid,
  TERM_OSC52_JS,
  TERM_SCROLL_BOTTOM_JS,
  autoStartSweep, autoStopSweep, startedTicketKeys, orgsWithAutoStart, autoStarted,
  autoStopped, autoStartOrgs, setAutoStartOrg,
  autoMergeSweep, autoCloseSweep, autoStartContentGate, orgsWithAutoMerge,
  autoMergeOrgs, setAutoMergeOrg, autoMergeState, autoClosed, ingestMergeResults,
  priorityWriteBackOrgs, setPriorityWriteBackOrg, orgsWithPriorityWriteBack,
  priorityWriteBackSweep, priorityWriteBackSkips,
  dedupeLinkOrgs, setDedupeLinkOrg, orgsWithDedupeLink,
  dedupeLinkSweep, dedupeLinkSkips,
  ticketQueue, ticketQueuePayload, enqueueTicketStart, dropQueuedTicket,
  dropAutoQueuedTickets, drainTicketQueue, queuedTicket, hostHasFreeSlot, holdQueued,
  liveQueueCount,
  reclaimStrandedTicketSpawns,
  TICKET_QUEUE_PER_ORG_MAX, TICKET_QUEUE_PER_ORG_AUTO_MAX, TICKET_QUEUE_MAX_WAIT_MS,
  TICKET_QUEUE_EXPIRED_TTL_MS, logQueueState, TICKET_QUEUE_NOTES_MAX,
  ticketQueueAdmission, TICKET_QUEUE_MAX, TICKET_QUEUE_ERROR_MAX, TICKET_QUEUE_STALE_MS,
  TICKET_QUEUE_BLOCKED_MAX_MS,
  // XERK-485 [E]: triage gate, priority key, drain order, and the org rate limit.
  triageGateReason, triageSortKey, ticketQueueOrder,
  TRIAGE_PRIORITY_RANK, TRIAGE_TYPE_WEIGHT, NO_PRIORITY_RANK, NO_TYPE_WEIGHT,
  TICKET_QUEUE_RATE_MAX, TICKET_QUEUE_RATE_WINDOW_MS, autoStartRate,
  recordAutoStartRate, refundAutoStartRate,
  // XERK-486 [F]: per-org triage policy and per-ticket triage verdicts.
  triagePolicies, setTriagePolicy, triagePolicyReason, autoStartRateMax,
  ticketTriageActions, ticketTriageAction, setTicketTriageAction,
  TRIAGE_ACTIONS_MAX,
  orgColors, setOrgColor,
  repoTiers, repoTier, repoTierRank, isRepoIgnored, setRepoTier,
  DEFAULT_REPO_TIER, REPO_TIERS,
  migrations, advanceMigrations, MIGRATE_SPOOL_DIR, sweepMigrationSpool,
  dropMigrationBlob, migrationSpoolPath,
  safeUploadName, uploadCapFor, uploads, UPLOAD_MAX_PER_MESSAGE,
  usageLedger, normalizeRetired,
  ARCHIVE_CHUNK_BODY_MAX, ARCHIVE_PARSE_COST, archiveChunkLabel,
  archiveRefusals, archiveRefusalFor,
  noteArchiveRefusal, ARCHIVE_REFUSALS_MAX, ARCHIVE_REFUSALS_PER_HOST,
  chargeBody, releaseBody, BODY_PARSE_COST, BODY_INFLIGHT_TOTAL_MAX,
  HEARTBEAT_MAX, HEARTBEAT_PARSE_COST,
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

// XERK-357: the frame ceiling. A 10-byte 64-bit length header declaring `len`,
// with NO payload appended — the whole point is that an oversize frame is
// refused on its header, before the parser buffers the declared bytes.
function frameHeader(len, { masked = true, opcode = 0x2 } = {}) {
  const h = Buffer.alloc(masked ? 14 : 10);
  h[0] = 0x80 | opcode;
  h[1] = (masked ? 0x80 : 0) | 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h; // mask key bytes (if any) left zero — never reached on an oversize frame
}

test("wsParser refuses a frame declaring more than the default ceiling (XERK-357)", () => {
  // The ticket's exact evidence: one 300 MiB masked frame on a control socket.
  const frames = [];
  const overs = [];
  const parse = wsParser(
    (op, payload) => frames.push({ op, payload }),
    { onOverflow: (len) => overs.push(len) }
  );
  const declared = 300 * 1024 * 1024;
  parse(frameHeader(declared)); // header only — payload never sent
  assert.equal(frames.length, 0, "no frame delivered");
  assert.deepEqual(overs, [declared], "onOverflow got the declared length");
  assert.ok(declared > WS_FRAME_MAX);
});

test("wsParser overflow is decided on the header, before the payload is buffered", () => {
  // With a small ceiling, feed ONLY the header declaring over it; the parser must
  // fire onOverflow without waiting for (or allocating) the declared bytes.
  let held = null;
  const frames = [];
  const parse = wsParser(
    (op, payload) => frames.push({ op, payload }),
    { max: 100, onOverflow: (len) => { held = len; } }
  );
  parse(frameHeader(1_000_000)); // 1 MB declared, ceiling 100
  assert.equal(held, 1_000_000);
  assert.equal(frames.length, 0);
});

test("wsParser goes dead after an overflow and ignores every later chunk", () => {
  let overs = 0;
  const frames = [];
  const parse = wsParser(
    (op, payload) => frames.push({ op, payload }),
    { max: 100, onOverflow: () => overs++ }
  );
  parse(frameHeader(1_000_000));
  assert.equal(overs, 1);
  // A perfectly valid small frame after the overflow is NOT processed — the
  // stream is unrecoverable (we can't find the next frame boundary), so the
  // socket is closed by the caller and the parser must not resurrect.
  parse(wsEncode(0x1, "after"));
  assert.equal(frames.length, 0, "post-overflow frame ignored");
  assert.equal(overs, 1, "onOverflow fires once, not per chunk");
});

test("wsParser admits a frame at exactly the ceiling, refuses one past it", () => {
  for (const [len, refused] of [[100, false], [101, true]]) {
    const frames = [];
    let over = false;
    const parse = wsParser(
      (op, payload) => frames.push({ op, payload }),
      { max: 100, onOverflow: () => { over = true; } }
    );
    // A real, complete masked frame of `len` bytes (needs the payload for the
    // allowed case to actually deliver).
    parse(maskedFrame(0x2, Buffer.alloc(len, 1)));
    assert.equal(over, refused, `len ${len}`);
    assert.equal(frames.length, refused ? 0 : 1, `len ${len} delivery`);
  }
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

test("agentPresented: a valid agent credential, whatever host it is for", () => {
  const req = (h) => ({ headers: h });
  assert.equal(agentPresented(req({ authorization: "Bearer agenttok" })), true);
  assert.equal(agentPresented(req({ authorization: "Bearer nope" })), false);
  assert.equal(agentPresented(req({})), false);
  // The single-user basic login may also exercise the heartbeat endpoint.
  assert.equal(agentPresented(req({ authorization: basic("hubuser", "hubpass") })), true);
  assert.equal(agentPresented(req({ authorization: basic("hubuser", "WRONG") })), false);
  // Any host's own token passes — this gate cannot say WHICH host, only that the
  // credential is one the hub issued. It is what keeps an unknown bearer off the
  // heartbeat's 32 MiB body read, so it must refuse a made-up one (XERK-268).
  assert.equal(agentPresented(req({ authorization: `Bearer ${hostAgentToken("anyhost")}` })), true);
  const [name, mac] = hostAgentToken("anyhost").split(".");
  // Neither half alone, and not a name swapped onto someone else's HMAC.
  assert.equal(agentPresented(req({ authorization: `Bearer ${mac}` })), false);
  assert.equal(agentPresented(req({ authorization: `Bearer ${name}.` })), false);
  assert.equal(
    agentPresented(req({ authorization: `Bearer ${Buffer.from("otherhost").toString("base64url")}.${mac}` })),
    false
  );
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
  // With the host the socket claims (XERK-268), that host's own derived token
  // authorizes it and another host's does not — on the query and header paths
  // alike. The master still passes here; TURMA_AGENT_STRICT is what retires it.
  const claim = (t) => new URL(`http://x/agent/control?name=hA&token=${t}`);
  assert.equal(agentWsAuthorized(claim(hostAgentToken("hA")), req({}), "hA"), true);
  assert.equal(agentWsAuthorized(claim(hostAgentToken("hB")), req({}), "hA"), false);
  assert.equal(
    agentWsAuthorized(new URL("http://x/agent/control?name=hA"),
      req({ authorization: `Bearer ${hostAgentToken("hB")}` }), "hA"),
    false
  );
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

// TERM_SCROLL_BOTTOM_JS is injected into a qwen session's ttyd page; exercise it
// the way the browser does — a fake xterm whose on-screen rows redraw as it
// scrolls, and a queued setTimeout the test drains by hand. scrollPos models
// qwen's OWN scroll (viewportY stays 0, the drawn rows change), clamped at
// maxScroll so an over-scroll is a no-op, exactly as the real TUI clamps.
// `footer` places a text line 6 rows above the bottom (INSIDE the compare
// region), modelling a real TUI footer as QA captured in docs/qwen-g0/pane/. With
// `animate` it also carries a per-frame token that changes every wheel event, so
// the settle test never trips — the case that forces the streaming cap. Set a
// runtime's busy marker there to exercise active(); a non-busy string (a
// permission dialog) must NOT read as busy.
// `stallAtCall` models a late repaint (QA's ~1/10 stop-short): on that Nth full
// screen read, the fake returns the PREVIOUS frame's content — as if the scroll's
// redraw hadn't landed by the poll — so that one `after` read equals its `before`
// even though the pane is still mid-scroll. Reads are counted per screen scan
// (each starts at row 0): a pass does before/after/active, so callers target the
// read they want to stall.
function runScrollBottom({ maxScroll = 5, rows = 24, startAt = 0, withTerm = true, animate = false, footer = null, stallAtCall = 0 } = {}) {
  let scrollPos = startAt, frame = 0;
  let cycle = 0, useScroll = startAt, lastCycleScroll = startAt;
  const wheelDeltas = [];
  const timers = [];
  let clickHandler = null, globalWheel = null, appended = null;
  function beginCycle() {
    cycle++;
    if (stallAtCall && cycle === stallAtCall) {
      useScroll = lastCycleScroll; // stale: repeat the previous frame's content
    } else {
      useScroll = scrollPos;
      lastCycleScroll = scrollPos;
    }
  }
  const term = {
    rows,
    buffer: { active: {
      viewportY: 0,
      getLine: (i) => ({ translateToString: () => {
        if (i === 0) beginCycle();
        if (i === rows - 6 && footer !== null) return footer + (animate ? " " + frame : "");
        return "row" + (useScroll + i);
      } }),
    } },
  };
  const xterm = {
    dispatchEvent: (ev) => {
      wheelDeltas.push(ev.deltaY);
      frame++; // a streaming turn redraws every frame regardless of scroll
      if (ev.deltaY > 0) scrollPos = Math.min(maxScroll, scrollPos + 1);
      else if (ev.deltaY < 0) scrollPos = Math.max(0, scrollPos - 1);
      return true;
    },
  };
  const button = { style: {}, addEventListener: (t, fn) => { if (t === "click") clickHandler = fn; } };
  const sandbox = {
    window: { term: withTerm ? term : undefined },
    document: {
      body: { appendChild: (el) => { appended = el; } },
      querySelector: (sel) => (sel === ".xterm" ? xterm : null),
      createElement: () => button,
    },
    addEventListener: (t, fn) => { if (t === "wheel") globalWheel = fn; },
    WheelEvent: class { constructor(type, opts) { Object.assign(this, opts || {}); this.type = type; } },
    setTimeout: (fn) => { timers.push(fn); return 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(TERM_SCROLL_BOTTOM_JS, sandbox);
  return {
    button, appended, wheelDeltas,
    scrollPos: () => scrollPos,
    click: () => clickHandler && clickHandler(),
    wheel: (deltaY) => globalWheel && globalWheel({ deltaY }),
    drain: (max = 1000) => { let n = 0; while (timers.length && n++ < max) timers.shift()(); },
  };
}

test("scroll-to-bottom: wires a hidden Bottom button into the page", () => {
  const t = runScrollBottom();
  assert.equal(t.appended, t.button, "the button is appended to the body");
  assert.equal(t.button.id, "turmaToBottom");
  assert.equal(t.button.type, "button");
  assert.match(t.button.textContent, /Bottom/);
  // Initially hidden by the injected CSS (#turmaToBottom{display:none}), not an
  // inline style, so nothing is set on the element until show()/hide() runs.
  assert.notEqual(t.button.style.display, "flex", "not shown until the user scrolls up");
});

test("scroll-to-bottom: clicking drives qwen's scroll to the tail with wheel-DOWN only", () => {
  // maxScroll (20) exceeds one BURST (8), so reaching the tail genuinely needs
  // several passes — the test exercises the multi-pass settle loop, not a single
  // burst that happens to clamp.
  const t = runScrollBottom({ maxScroll: 20, startAt: 0 });
  t.click();
  t.drain();
  assert.equal(t.scrollPos(), 20, "reaches the bottom (clamped at maxScroll)");
  assert.ok(t.wheelDeltas.length >= 24, "took multiple bursts to get there");
  assert.ok(t.wheelDeltas.every((d) => d > 0), "every dispatched wheel is DOWN — never up");
  // Settles a few passes after clamping (STABLE consecutive unchanged reads), well
  // short of the MAX safety cap on an ordinary idle scroll.
  assert.ok(t.wheelDeltas.length <= 64, "settles once clamped rather than spinning to the cap");
  assert.equal(t.button.style.display, "none", "hides itself once it clamps at the bottom");
});

test("scroll-to-bottom: a single late-landing repaint frame does not stop it short", () => {
  // QA's ~1/10 stop-short: a burst's redraw lands after the poll, so one `after`
  // read equals its `before` though the pane is still mid-scroll. Requiring STABLE
  // consecutive unchanged reads absorbs it — the loop must still reach the tail.
  // (With the old single-read stop condition this would quit at scroll ~8.)
  const t = runScrollBottom({ maxScroll: 40, startAt: 0, stallAtCall: 2 });
  t.click();
  t.drain();
  assert.equal(t.scrollPos(), 40, "reaches the tail despite one stale repaint frame");
});

// One code path for both runtimes: active() unions Claude's and qwen's busy
// footers, and must NOT misread Claude's permission dialog as busy.
for (const marker of ["esc to interrupt", "enter to steer", "esc to cancel)"]) {
  test(`scroll-to-bottom: a streaming turn (${marker}) stops at the tight cap, not the runaway MAX`, () => {
    // An animating busy footer changes the snapshot every pass regardless of
    // scroll, so the settle test never trips. With an unbounded scroll and a live
    // turn, the loop must stop at ACTIVE_MAX (64), NOT MAX (800).
    const t = runScrollBottom({ maxScroll: 100000, startAt: 0, animate: true, footer: marker });
    t.click();
    t.drain();
    assert.ok(t.wheelDeltas.length <= 64, "capped at ACTIVE_MAX during a streaming turn");
    assert.ok(t.wheelDeltas.length < 100, "nowhere near the 800-event runaway");
    assert.ok(t.wheelDeltas.every((d) => d > 0), "still only wheel-DOWN");
  });
}

test("scroll-to-bottom: Claude's permission dialog is NOT read as a streaming turn", () => {
  // "Esc to cancel · Tab to amend" (no closing paren) must not match the busy
  // regex — otherwise the pill would cap at ACTIVE_MAX when it shouldn't. With an
  // animating (non-settling) screen carrying only that text, active() must stay
  // false so the loop uses the idle MAX, running well past ACTIVE_MAX.
  const t = runScrollBottom({ maxScroll: 100000, startAt: 0, animate: true,
    footer: "Esc to cancel · Tab to amend" });
  t.click();
  t.drain();
  assert.ok(t.wheelDeltas.length > 64, "not capped — the dialog is not a busy turn");
});

test("scroll-to-bottom: already at the tail is a harmless no-op", () => {
  const t = runScrollBottom({ maxScroll: 0, startAt: 0 });
  t.click();
  t.drain();
  assert.equal(t.scrollPos(), 0);
});

test("scroll-to-bottom: the pill reveals itself when the user scrolls UP", () => {
  const t = runScrollBottom();
  assert.notEqual(t.button.style.display, "flex");
  t.wheel(-3); // scroll up off the tail
  assert.equal(t.button.style.display, "flex", "revealed on scroll-up");
});

test("scroll-to-bottom: a missing xterm instance stops rather than spinning", () => {
  const t = runScrollBottom({ withTerm: false });
  t.click();
  t.drain();
  // snap() returns null with no window.term, so the routine bails after one pass.
  assert.ok(t.wheelDeltas.length <= 8, "no runaway loop when the terminal isn't ready");
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

test("alerts: notification titles use the session's title, not its rcName", () => {
  const beat = makeHost();
  notifications.length = 0;
  beat({
    sessions: [{ id: "s1", rcName: "nas-repo-s1", summary: "Fix terminal font", session: { question: "Deploy to prod?" } }],
  });
  assert.deepEqual(titles(), ["Fix terminal font has a question"]);
  notifications.length = 0;
  // A session without a summary yet falls back to the structural rcName.
  beat({
    sessions: [{ id: "s2", rcName: "nas-repo-s2", session: { question: "Ship it?" } }],
  });
  assert.deepEqual(titles(), ["nas-repo-s2 has a question"]);
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

test("a live host reporting an overhead repo raw is still folded (XERK-338 seam)", () => {
  // The fold's ledger paths cover augmented/retired hosts, but a LIVE host whose
  // OWN heartbeat names an overhead repo has no ledger augment (fold -> null), so
  // its raw repoUsage is served. serializeAgent folds that path too.
  const u = (n) => ({
    totals: { input: n, output: 0, cacheWrite: 0, cacheRead: 0 },
    today: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    week: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    days: {}, models: [], sessions: 1,
  });
  agents["seam-host"] = {
    key: "seam-host", device: "seam-host", lastSeen: Date.now(),
    repoUsage: [
      { repo: "Turma", remoteKey: "rk-turma", remote: "", usage: u(100) },
      { repo: "hub-agent-mgr-abc", remoteKey: "hub-agent-mgr-abc", remote: "", usage: u(5) },
      { repo: ".turma", remoteKey: ".turma", remote: "", usage: u(3) },
    ],
  };
  invalidateAgentsCache();
  try {
    const served = JSON.parse(safeAgentsCache().body).agents.find((x) => x.key === "seam-host");
    const keys = served.repoUsage.map((r) => r.remoteKey).sort();
    assert.deepEqual(keys, ["Turma-System-Usage", "rk-turma"]);
    const sys = served.repoUsage.find((r) => r.remoteKey === "Turma-System-Usage");
    assert.equal(sys.usage.totals.input, 8); // 5 + 3, additive
  } finally {
    delete agents["seam-host"];
    invalidateAgentsCache();
  }
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

// ---- XERK-298: a hub-refused heartbeat is VISIBLE to the operator ----------

// Fetch one host's SERVED record (via /api/agents, not the in-memory store) so
// the assertions prove the marker actually rides the wire the client reads.
async function servedAgent(host) {
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  return res.body.agents.find((a) => a.key === host);
}

test("http: a 413-refused KNOWN host is stamped `refused` on the served record (XERK-298)", async () => {
  const host = "refused-413-host";
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: { device: host, repos: [{ name: "r1" }] },
  })).status, 200);
  // No chip while the host is healthy.
  assert.equal((await servedAgent(host)).refused, undefined);

  const fat = await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: { device: host, sessions: "A".repeat(AGENT_RECORD_MAX + 1024) },
  });
  assert.equal(fat.status, 413);

  // The refusal is now an operator-visible marker on the record the hub keeps —
  // NOT just a log line and a host that silently ages to offline.
  const a = await servedAgent(host);
  assert.ok(a, "the known host is still served");
  assert.ok(a.refused, "a refused known host carries a `refused` marker");
  assert.equal(a.refused.reason, "record-too-large");
  assert.equal(typeof a.refused.at, "number");
  assert.ok(a.refused.detail && a.refused.detail.length <= REFUSED_DETAIL_MAX);
  // The prior good record is still what's served underneath the marker.
  assert.deepEqual(a.repos, [{ name: "r1" }]);
});

test("http: the next ACCEPTED beat clears `refused` (XERK-298)", async () => {
  const host = "refused-clears-host";
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: { device: host } });
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: { device: host, sessions: "A".repeat(AGENT_RECORD_MAX + 1024) },
  })).status, 413);
  assert.ok((await servedAgent(host)).refused, "stamped by the refusal");

  // A beat that fits rebuilds the record from the payload, which carries no
  // `refused` — so recovery clears the chip with no explicit un-stamp.
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: { device: host, repos: [{ name: "back" }] },
  })).status, 200);
  const a = await servedAgent(host);
  assert.equal(a.refused, undefined, "an accepted beat clears the marker");
  assert.deepEqual(a.repos, [{ name: "back" }]);
});

test("http: a host cannot FORGE its own `refused` chip (XERK-298)", async () => {
  const host = "refused-forge-host";
  const res = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, refused: { at: 1, reason: "record-too-large", detail: "fake" } },
  });
  assert.equal(res.status, 200);
  // `refused` is hub-owned: stripped on ingest like `key`, so an accepted beat
  // asserting one is served without it.
  assert.equal((await servedAgent(host)).refused, undefined);
  assert.equal(agents[host].refused, undefined);
});

test("normalizeRefused coerces the restored/hand-edited shape (XERK-298)", () => {
  // A well-formed marker survives, detail re-capped.
  const ok = { refused: { at: 5, reason: "registry-full", detail: "x".repeat(500) } };
  hub.normalizeRefused(ok);
  assert.equal(ok.refused.at, 5);
  assert.equal(ok.refused.detail.length, REFUSED_DETAIL_MAX);

  // A missing/bad `at` (the required anchor Android types) drops the whole block
  // — reading as "not refused", never a fabricated value.
  for (const bad of [{ reason: "x" }, { at: "5" }, { at: null }]) {
    const r = { refused: bad };
    hub.normalizeRefused(r);
    assert.equal(r.refused, undefined);
  }
  // A non-object block is dropped; a wrong-typed sub-field is dropped, not
  // stringified (so the client default applies).
  const arr = { refused: [] };
  hub.normalizeRefused(arr);
  assert.equal(arr.refused, undefined);
  const sub = { refused: { at: 1, reason: 7, detail: {} } };
  hub.normalizeRefused(sub);
  assert.equal(sub.refused.reason, undefined);
  assert.equal(sub.refused.detail, undefined);
  assert.equal(sub.refused.at, 1);
});

test("http: a non-array ingest field degrades to 200, not a 400 offline loop (XERK-529)", async () => {
  // Every ingest*Results loop iterates a payload field with `for (const r of
  // ...)`, and the ack path does `new Set(payload.ackedCommands || [])`. A
  // truthy-but-non-iterable value (a plain object, a number) makes `field ||
  // []` that value, so the for-of / Set() throws `TypeError: ... is not
  // iterable`. That throw is SYNCHRONOUS inside the request handler's outer
  // try/catch, so it does NOT crash the hub — it returns 400. But a 400 on
  // every beat is a self-inflicted per-host offline loop (the XERK-235 shape;
  // see the ackedCommands filter comment). The Array.isArray guard turns each
  // malformed field into "no results this beat" so the beat lands 200 and the
  // host stays online. (The ticket framed this as a hub crash / fleet-wide
  // DoS; the outer catch means it is neither — this test pins the 400->200
  // behavior change, not crash-resistance.)
  const host = "isarray-host";
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: { device: host, sessions: [{ id: "sa", status: "running" }] },
  })).status, 200);

  // Each field arrives straight off the wire with only a `delete` to strip it,
  // so exercise every one of the ten iterations at once with the object/number
  // shapes the ticket calls out (plus ackedCommands, the same class).
  const malformed = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: {
      device: host,
      historyResults: {},
      subagentHistoryResults: 7,
      jiraIssueResults: {},
      ticketStatusResults: "nope",
      ticketPriorityResults: 42,
      ticketLinkResults: {},
      createMetaResults: true,
      createTicketResults: {},
      spawnFailures: {},
      ackedCommands: {},
    },
  });
  assert.equal(malformed.status, 200,
    "a malformed-field beat must degrade to 200, not 400 the host into an offline loop");

  // The hub is still up and serving.
  const after = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(after.status, 200);
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
  // A URL dot segment is collapsed by the parser resolving /api/agents/<host>/...,
  // so such a host showed online while every route against it 404'd -- including
  // the DELETE that would remove it, leaving a card stuck for PRUNE_AFTER_MS
  // (XERK-269). Agents no longer send these, but an un-upgraded one still can.
  for (const device of [".", ".."]) {
    const res = await request("POST", "/api/heartbeat", { body: { device }, headers: agentHeaders });
    assert.equal(res.status, 400, `${device} must be refused`);
  }
  // Names that merely CONTAIN dots are ordinary host names and must still beat.
  for (const device of ["...", ".hidden", "a.b", "HOST.local."]) {
    const res = await request("POST", "/api/heartbeat", { body: { device }, headers: agentHeaders });
    assert.equal(res.status, 200, `${device} must be accepted`);
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

  // XERK-422: a transcript whose lines all render to zero entries (mode/system/
  // last-prompt records, no user/assistant turn) advances the cursor to size but
  // writes no `.jsonl`. It used to get a listable row that 404'd on read-back
  // forever. It now reads back 200 with an empty entry list — an honest "recorded
  // no conversation", distinct from a transcript the hub never heard of (still
  // 404). The raw layer may still hold real material for it.
  const empty = await request("POST", "/api/agents/nas/archive/tr-empty",
    { body: { startOffset: 0, endOffset: 1025, size: 1025,
      meta: { remoteKey: "github.com/xerk/turma", repo: "turma", slug: "-w-ab" }, entries: [] },
      headers: agentHeaders });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.bytesStored, 1025);
  const emptyView = await request("GET", "/api/archive/tr-empty", { headers: userHeaders });
  assert.equal(emptyView.status, 200, "a zero-entry transcript reads back, it does not 404");
  assert.deepEqual(emptyView.body.entries, []);
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
  // Nothing here is near either archive ceiling, so the budget fields stay off
  // the wire entirely — an agent reads their absence as "no limit reached", and
  // a hub too old to send them is the same case (XERK-267).
  assert.equal("archiveShed" in r2.body, false);
  assert.equal("archiveFull" in r2.body, false);
});

// XERK-356. The rendered archive route read with `readBody`'s DEFAULT 1 MiB
// while the agent builds each delta out of an 8 MiB window — and archival
// excludes RUNNING sessions, so an ended session's FIRST delta is its whole
// transcript. Every real one was refused, and the durable archive held nothing
// but trivially small conversations.
test("http: the archive route takes a multi-MB delta, and states its ceiling", async () => {
  const filler = "x".repeat(200_000);
  const entries = Array.from({ length: 8 }, (_, i) => ({
    uuid: `big${i}`, role: "assistant", ts: "2026-07-11T00:00:00Z", text: filler,
  }));
  const meta = { remoteKey: "github.com/xerk/turma", repo: "turma", slug: "-w-big",
    summary: "A Real Sized Session" };
  const body = { startOffset: 0, endOffset: 1_600_000, size: 1_600_000, meta, entries };
  const wire = JSON.stringify(body).length;
  assert.ok(wire > (1 << 20), "the delta clears the old 1 MiB default");
  assert.ok(wire <= ARCHIVE_CHUNK_BODY_MAX, "and is one the ceiling actually admits");
  const r = await request("POST", "/api/agents/nas/archive/trbig", { body, headers: agentHeaders });
  assert.equal(r.status, 200);
  assert.equal(r.body.bytesStored, 1_600_000);
  assert.equal((await request("GET", "/api/archive/trbig", { headers: userHeaders })).status, 200);

  // And the agent is TOLD the ceiling on the beat it pushes off, because the
  // number is a fraction of THIS container's limit: an agent guessing it guesses
  // wrong on any hub sized differently, and past the ceiling it may get no
  // status at all to learn from (the same reasoning as `bodyMax`, XERK-347).
  const beat = { device: "nas", archiveManifest: [{ transcriptId: "trbig", slug: "-w-big", repo: "turma" }] };
  const hb = await request("POST", "/api/heartbeat", { body: beat, headers: agentHeaders });
  assert.equal(hb.body.archiveChunkMax, ARCHIVE_CHUNK_BODY_MAX);
  assert.ok(ARCHIVE_CHUNK_BODY_MAX > (1 << 20), "the ceiling clears a real first delta");
});

// XERK-356 QA D1. The in-flight budget is only a bound on memory while its units
// MEAN memory. This route holds the accumulated body, the parsed entries,
// ingestChunk's re-serialized lines and the append buffer at once — measured at
// ~20x the wire size at peak RSS — so charged at BODY_PARSE_COST's 3x the budget
// admitted about seven times what a 256 MiB container could hold, and three
// hosts backfilling (or one backfilling beside a large heartbeat) OOM-killed it.
test("http: the archive route is charged what it costs, not BODY_PARSE_COST", async () => {
  const filler = "q".repeat(100_000);
  const room = 1_000_000;   // budget units left free: affordable at 3x, not at 20x
  chargeBody(BODY_INFLIGHT_TOTAL_MAX - room, "shared");
  chargeBody(1, "big");     // and the exclusive lane is occupied, so nothing escapes there
  try {
    const beat = await request("POST", "/api/heartbeat",
      { body: { device: "nas", label: filler }, headers: agentHeaders });
    assert.equal(beat.status, 200, "an ordinary body of this size still fits the room left");
    const push = await request("POST", "/api/agents/nas/archive/trcost", {
      body: { startOffset: 0, endOffset: 1, size: 1, meta: {},
        entries: [{ uuid: "e", role: "user", ts: null, text: filler }] },
      headers: agentHeaders,
    });
    // 503 "come back", never 413 "shrink": the body is well inside the ceiling,
    // it is the hub that is momentarily too full to parse it.
    assert.equal(push.status, 503, "the same size on the archive route is not affordable");
  } finally {
    releaseBody(BODY_INFLIGHT_TOTAL_MAX - room, "shared");
    releaseBody(1, "big");
  }
});

test("the archive ceiling leaves concurrent pushes room inside the budget", () => {
  assert.ok(ARCHIVE_PARSE_COST > BODY_PARSE_COST, "this route costs more than an ordinary body");
  // Held at the DEPLOYED size, which is the only size the numbers mean anything
  // at — this box's own memory makes every derived ceiling trivially generous.
  const deployed = freshServerModule((env) => {
    env.MEMORY_LIMIT_BYTES = String(256 << 20);
    delete env.ARCHIVE_CHUNK_BODY_MAX;
    delete env.BODY_INFLIGHT_MAX;
    delete env.BODY_INFLIGHT_TOTAL_MAX;
  });
  assert.ok(
    deployed.ARCHIVE_CHUNK_BODY_MAX * deployed.ARCHIVE_PARSE_COST * 3 <= deployed.BODY_INFLIGHT_TOTAL_MAX,
    `three concurrent max-size deltas (${deployed.ARCHIVE_CHUNK_BODY_MAX} x ${deployed.ARCHIVE_PARSE_COST} x 3) ` +
      `must fit the in-flight total (${deployed.BODY_INFLIGHT_TOTAL_MAX})`
  );
  // ...and it TIGHTENS with the container rather than being a flat number a
  // smaller hub could not honour (XERK-258).
  const small = freshServerModule((env) => {
    env.MEMORY_LIMIT_BYTES = String(32 << 20);
    delete env.ARCHIVE_CHUNK_BODY_MAX;
    delete env.BODY_INFLIGHT_MAX;
    delete env.BODY_INFLIGHT_TOTAL_MAX;
  });
  assert.ok(small.ARCHIVE_CHUNK_BODY_MAX < deployed.ARCHIVE_CHUNK_BODY_MAX);
});

// XERK-376: /api/heartbeat was charged BODY_PARSE_COST's 3x while a beat really
// costs ~5.5x its wire size at peak RSS (measured in a real 256 MiB cgroup: a
// lone 30 MiB beat peaks ~185 MiB over a ~20 MiB baseline). So the in-flight
// budget admitted about twice what the container could hold, and a couple of
// concurrent large-but-legal beats (32 MiB is inside HEARTBEAT_MAX) OOM-killed
// the hub on the ONE route every host beats. Charged honestly, the exclusive
// big lane serializes large beats and a second one is refused 503, not OOM'd.
test("http: the heartbeat route is charged what it costs, not BODY_PARSE_COST", async () => {
  // A wire body whose charge lands between 3x and 6x of the room left, so it
  // WOULD have fit at the old 3x and does NOT at the honest cost — the only way
  // to tell the two charges apart from the outside.
  const filler = "q".repeat(100_000);
  const room = 500_000;      // 100k x 3 = 300k fits; 100k x 6 = 600k does not
  chargeBody(BODY_INFLIGHT_TOTAL_MAX - room, "shared");
  chargeBody(1, "big");      // and the exclusive lane is occupied, so nothing escapes there
  try {
    const beat = await request("POST", "/api/heartbeat",
      { body: { device: "nas", label: filler }, headers: agentHeaders });
    // 503 "come back", never 413 "shrink": the beat is well inside HEARTBEAT_MAX,
    // it is the hub that is momentarily too full to parse it. At the old 3x this
    // same body fit the room left and co-resided beside the big-lane holder —
    // the concurrent buffering the honest charge now refuses.
    assert.equal(beat.status, 503, "a beat charged only 3x would have fit the room left");
  } finally {
    releaseBody(BODY_INFLIGHT_TOTAL_MAX - room, "shared");
    releaseBody(1, "big");
  }
});

test("one honest max heartbeat is serialized by the big lane and fits the container", () => {
  assert.ok(HEARTBEAT_PARSE_COST > BODY_PARSE_COST, "a beat costs more than an ordinary body");
  // Held at the DEPLOYED size — this box's own memory makes every derived ceiling
  // trivially generous, so the arithmetic only means anything at 256 MiB.
  const deployed = freshServerModule((env) => {
    env.MEMORY_LIMIT_BYTES = String(256 << 20);
    delete env.BODY_INFLIGHT_MAX;
    delete env.BODY_INFLIGHT_TOTAL_MAX;
  });
  const worst = deployed.HEARTBEAT_MAX * deployed.HEARTBEAT_PARSE_COST;
  // Because a max beat's honest charge EXCEEDS the whole shared budget, NOTHING
  // else can buffer beside it while it holds the big lane (the lane's occupancy
  // counts against shared admission). At the old 3x charge the same beat left
  // ~38 units of shared room, so other bodies co-resided and their buffers stacked
  // onto its peak — the co-residence that OOM'd the hub. This inequality is the fix.
  assert.ok(
    worst > deployed.BODY_INFLIGHT_TOTAL_MAX,
    `an honest max beat (${worst}) must exceed the shared budget ` +
      `(${deployed.BODY_INFLIGHT_TOTAL_MAX}) so nothing co-resides beside it`
  );
  // ...yet the one beat the big lane DOES admit still fits the container it is
  // sized against — HEARTBEAT_MAX stays 32 MiB (XERK-235's shape must not
  // re-open), so this is the thin-but-accepted headroom the sizing decision took.
  assert.ok(
    worst < deployed.MEMORY_LIMIT,
    `one max beat (${worst}) must fit the container (${deployed.MEMORY_LIMIT})`
  );
});

test("the boot line states a sub-MiB archive ceiling as KiB, not as 0 MiB", () => {
  // The boot line is the stated reason this derived ceiling is discoverable at
  // all, and a MiB formatter floors — on a small container it printed "0 MiB".
  assert.equal(archiveChunkLabel(2 << 20), "2 MiB");
  assert.equal(archiveChunkLabel(400000), "391 KiB");
  assert.match(archiveChunkLabel(64 << 10), /KiB$/);
});

test("a refusal record is the NEWEST, and is cleared by a chunk that lands", async () => {
  // Newest, because a transcript legitimately carries one per host after a
  // migration and the last failure is the one that explains why it is missing.
  noteArchiveRefusal("shared-tid", "hostOld", "the older reason");
  await new Promise((r) => setTimeout(r, 2));
  noteArchiveRefusal("shared-tid", "hostNew", "the newer reason");
  assert.equal(archiveRefusalFor("shared-tid").error, "the newer reason");

  // A chunk that LANDS clears that host's record — the record answers "why is
  // this missing", so it must not outlive the missing.
  const ok = await request("POST", "/api/agents/nas/archive/trclear", {
    body: { startOffset: 0, endOffset: 4, size: 4, meta: { repo: "turma", slug: "s" },
      entries: [{ uuid: "c1", role: "user", ts: null, text: "hi" }] },
    headers: agentHeaders,
  });
  assert.equal(ok.status, 200);
  noteArchiveRefusal("trclear", "nas", "stale reason");
  assert.ok(archiveRefusalFor("trclear"));
  const again = await request("POST", "/api/agents/nas/archive/trclear", {
    body: { startOffset: 4, endOffset: 8, size: 8, meta: { repo: "turma", slug: "s" },
      entries: [{ uuid: "c2", role: "user", ts: null, text: "ho" }] },
    headers: agentHeaders,
  });
  assert.equal(again.status, 200);
  assert.equal(archiveRefusalFor("trclear"), null, "a landed chunk clears it");

  // A non-scalar `meta` field is coerced away rather than thrown on. This is NOT
  // a test of the 500 branch's wording — normalizeMeta makes this a 200, which is
  // the point; the store-failure test above is the one that reaches the 500.
  const bad = await request("POST", "/api/agents/nas/archive/trbadmeta", {
    body: { startOffset: 0, endOffset: 4, size: 4, meta: { summary: { not: "text" } },
      entries: [{ uuid: "b1", role: "user", ts: null, text: "hi" }] },
    headers: agentHeaders,
  });
  // A non-scalar `meta` field is coerced away rather than thrown on: bound
  // straight into sqlite it 500s, and one poisoned transcript then answers 500
  // on every beat forever (XERK-356 QA pass 2).
  assert.equal(bad.status, 200, "a non-scalar meta field is not a 500");
  const view = await request("GET", "/api/archive/trbadmeta", { headers: userHeaders });
  assert.equal(view.status, 200);
  for (const [k, r] of [...archiveRefusals]) if (r.host.startsWith("host")) archiveRefusals.delete(k);
});

// Walk ARCHIVE_DIR for the organized file a transcript landed in. The name is
// `<repo>/<date>__<summary>__<host>__<shortId>.jsonl`, and only the shortId (the
// first 8 alnum characters of the id) is ours to predict.
function findArchiveJsonl(transcriptId) {
  const short = String(transcriptId).replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (e.name.endsWith(`__${short}.jsonl`)) return full;
    }
    return null;
  };
  return walk(process.env.ARCHIVE_DIR);
}

test("a store failure answers and RECORDS the hub's own words, never the driver's", async () => {
  // This branch had no test at all: the only body the suite pushed at it was a
  // non-scalar `meta`, which normalizeMeta now turns into a 200, so replacing
  // the hub-authored string with `e.message` left both suites green while the
  // hub served node:sqlite's and fs's words — built out of agent-supplied fields
  // and carrying absolute /data paths — to a browser AND into every agent's log
  // (XERK-356 QA pass 3, D1).
  //
  // So drive the failure the way it actually happens: land one chunk, then put a
  // DIRECTORY where the archive file was, and let the next append EISDIR.
  const tid = "trstorefail";
  const meta = { repo: "turma", slug: "-w-sf", summary: "store fail" };
  const first = await request("POST", `/api/agents/nas/archive/${tid}`, {
    body: { startOffset: 0, endOffset: 4, size: 8, meta,
      entries: [{ uuid: "s1", role: "user", ts: null, text: "hi" }] },
    headers: agentHeaders,
  });
  assert.equal(first.status, 200);

  const written = findArchiveJsonl(tid);
  assert.ok(written, "the first chunk has to land somewhere before it can be broken");
  fs.rmSync(written);
  fs.mkdirSync(written);
  try {
    const boom = await request("POST", `/api/agents/nas/archive/${tid}`, {
      body: { startOffset: 4, endOffset: 8, size: 8, meta,
        entries: [{ uuid: "s2", role: "user", ts: null, text: "ho" }] },
      headers: agentHeaders,
    });
    assert.equal(boom.status, 500);
    // Spelled out, deliberately NOT imported from server.js: bound to the same
    // constant the route reads, a mutation would move both and this would pass.
    assert.equal(boom.body.error, "the hub could not store this chunk — see the hub log");
    // The assertion the old test only claimed to make: nothing of the driver's,
    // and no filesystem path, reaches either surface.
    assert.doesNotMatch(boom.body.error, /EISDIR|SQLITE|sqlite|[/\\]/);
    assert.equal(archiveRefusalFor(tid)?.error,
      "the hub could not store this chunk — see the hub log",
      "the record the operator reads says it too, not the driver's words");
  } finally {
    fs.rmSync(written, { recursive: true, force: true });
    for (const [k, r] of [...archiveRefusals]) if (k.includes(tid)) archiveRefusals.delete(k);
  }
});

test("one host's archive refusals cannot evict another host's", () => {
  // The record is keyed on an AGENT-CHOSEN transcriptId, so keyed on that alone
  // any one host could push the cap's worth of its own refusals and drop every
  // other host's real diagnostic — the one thing this record exists to provide.
  noteArchiveRefusal("keep-me", "hostA", "hostA's reason");
  for (let i = 0; i < ARCHIVE_REFUSALS_MAX + 10; i++) noteArchiveRefusal(`flood${i}`, "hostB", "x");
  assert.equal(archiveRefusalFor("keep-me")?.error, "hostA's reason");
  assert.ok(archiveRefusals.size <= ARCHIVE_REFUSALS_MAX);
  const bs = [...archiveRefusals.values()].filter((r) => r.host === "hostB");
  assert.equal(bs.length, ARCHIVE_REFUSALS_PER_HOST, "a host keeps only its own share");
  for (const [k, r] of [...archiveRefusals]) if (r.host === "hostA" || r.host === "hostB") archiveRefusals.delete(k);
});

test("http: a refused archive chunk is 413 AND recorded for the operator", async () => {
  const body = {
    startOffset: 0, endOffset: 10, size: 10, meta: { repo: "turma", slug: "-w-ov" },
    entries: [{ uuid: "e1", role: "user", ts: null,
      text: "y".repeat(ARCHIVE_CHUNK_BODY_MAX + (1 << 16)) }],
  };
  const r = await request("POST", "/api/agents/nas/archive/trover", { body, headers: agentHeaders });
  // 413, not the 503 a full hub answers: the agent must SHRINK this, never
  // re-send it (the two are opposite instructions — see readRawBody's callers).
  assert.equal(r.status, 413);
  assert.equal(r.body.limit, ARCHIVE_CHUNK_BODY_MAX);

  // ...and the operator who goes looking for that conversation is told why it is
  // not there, instead of "it syncs within a few minutes of ending" — which is a
  // promise nothing will keep once a push has been refused.
  const view = await request("GET", "/api/archive/trover", { headers: userHeaders });
  assert.equal(view.status, 404);
  assert.equal(view.body.error, "unknown transcript");   // unchanged for older readers
  assert.equal(view.body.refused.host, "nas");
  assert.match(view.body.refused.error, /larger than this hub takes/);

  // A chunk that lands clears it: the record answers "why is this missing", so
  // it must not outlive the missing.
  const ok = await request("POST", "/api/agents/nas/archive/trover", {
    body: { startOffset: 0, endOffset: 5, size: 5, meta: { repo: "turma", slug: "-w-ov" },
      entries: [{ uuid: "e1", role: "user", ts: null, text: "hi" }] },
    headers: agentHeaders,
  });
  assert.equal(ok.status, 200);
  assert.equal(archiveRefusals.has("trover"), false);
  assert.equal((await request("GET", "/api/archive/trover", { headers: userHeaders })).status, 200);
});

// ---- the archive's raw layer (XERK-338) -------------------------------------
//
// Beside the rendered entries above, agents push a byte-for-byte copy of the
// session's OWN files. These hold the wire contract: who may push, what a path
// may name, and that a body which could only be hostile is refused rather than
// decompressed.

// One raw push. The body is bytes, not JSON, so it can't go through request().
function rawPush(host, tid, rel, start, buf, headers) {
  const p = `/api/agents/${host}/archive/${encodeURIComponent(tid)}` +
            `/raw/${encodeURIComponent(rel)}?start=${start}`;
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + p, {
      method: "POST",
      headers: { "content-type": "application/gzip", ...(headers || {}) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", reject);
    req.end(buf);
  });
}
const gz = (s) => zlib.gzipSync(Buffer.from(s));

test("http: an agent cannot put `retired` on its own record (XERK-338)", async () => {
  // `retired` marks a hub-BUILT `retiredUsage` entry. Android types it as a
  // Boolean and a full /api/agents decode is ATOMIC there, so one host serving
  // `retired:"yes"` threw for the WHOLE array — every OTHER host vanished from
  // every phone's fleet list, and it persisted into state.json so a restart did
  // not clear it. Typing a field and coercing it hub-side are one change.
  for (const bad of ["yes", 1, 0, {}, [], null, true]) {
    const r = await request("POST", "/api/heartbeat", {
      body: { device: "retired-forger", retired: bad }, headers: agentHeaders,
    });
    assert.equal(r.status, 200);
    const rec = (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === "retired-forger");
    assert.equal("retired" in rec, false, `served retired for ${JSON.stringify(bad)}`);
  }
  // The restore runs the same coercion, since state.json is served before any
  // host re-beats and a restart is exactly when a coercion ships.
  const restored = { device: "retired-forger", retired: "yes" };
  normalizeRetired(restored);
  assert.equal("retired" in restored, false);
  delete agents["retired-forger"];
});

test("XERK-455: typed /api/agents fields are coerced at ingest, not served raw", async () => {
  // A field is decode-fatal on Android the moment a client TYPES it: /api/agents
  // decodes atomically, so one host beating a wrong-typed value throws the whole
  // array and every OTHER host vanishes from the phone while the tile still reads
  // "N / N online". These blocks were typed on AgentInfo/SessionInfo but never
  // coerced. Beat every confirmed-fatal shape at once and assert the served
  // record carries the "can't tell" value, never the raw junk.
  const bad = {
    device: "xerk455-forger",
    codingAgent: "not-an-object",
    claudeAuth: { present: "yes", needsLogin: 1, expiringSoon: {}, refreshExpiresAt: "soon" },
    capacity: { maxSessions: "lots", running: [], queued: {}, free: "0", rootRunning: "no" },
    github: { available: "yes", repos: "nope" },
    gitSources: "not-an-array",
    repos: ["bare-string", { name: "Turma", root: "yes", resumable: "nope" }],
    closedSessions: [5, { id: "c1", root: "yes", summaryManual: 1, ticket: "x", prs: "nope" }],
    uploadMaxBytes: "unlimited",
    jira: "not-an-object",
    sessions: [{
      id: "s1", git: "x", ticket: [], work: 5, prs: "nope",
      root: "yes", newWorkSincePrs: 1, ttydPort: "80", restartCount: {},
    }],
  };
  const r = await request("POST", "/api/heartbeat", { body: bad, headers: agentHeaders });
  assert.equal(r.status, 200);
  const rec = (await request("GET", "/api/agents", { headers: userHeaders }))
    .body.agents.find((a) => a.key === "xerk455-forger");

  // A non-object block is DROPPED (→ null default); a wrong-typed sub-field gone.
  assert.equal("codingAgent" in rec, false);
  assert.equal("jira" in rec, false);
  assert.equal("uploadMaxBytes" in rec, false);
  assert.deepEqual(rec.claudeAuth, {});
  assert.deepEqual(rec.capacity, {});
  assert.deepEqual(rec.github, { repos: [] });
  // A non-array list becomes [], a non-object element is filtered out.
  assert.deepEqual(rec.gitSources, []);
  assert.deepEqual(rec.repos, [{ name: "Turma", resumable: [] }]);
  assert.deepEqual(rec.closedSessions, [{ id: "c1", prs: [] }]);
  // SessionInfo: nullable objects → null, non-array prs → [], bad bool/int gone.
  const s = rec.sessions[0];
  assert.equal(s.git, null);
  assert.equal(s.ticket, null);
  assert.equal(s.work, null);
  assert.deepEqual(s.prs, []);
  assert.equal("root" in s, false);
  assert.equal("newWorkSincePrs" in s, false);
  assert.equal("ttydPort" in s, false);
  assert.equal("restartCount" in s, false);

  // A legitimate record rides through untouched — the coercion validates, it
  // does not repair.
  const good = {
    device: "xerk455-honest",
    codingAgent: { name: "claude", version: "1.2" },
    claudeAuth: { present: true, needsLogin: false, expiringSoon: false, refreshExpiresAt: 1786400000000 },
    capacity: { maxSessions: 4, running: 1, queued: 0, free: 3, rootRunning: false },
    github: { available: true, login: "octo", repos: [{ nameWithOwner: "x/y", name: "y", isPrivate: true }] },
    gitSources: [{ source: "azure", label: "AZ", available: true, user: "u", repos: [] }],
    repos: [{ name: "Turma", root: false, lastActivity: "2026-08-01", resumable: [] }],
    closedSessions: [{ id: "c2", root: false, summaryManual: false, prs: [] }],
    uploadMaxBytes: 5000000,
    jira: { available: true, configured: true, siteKey: "acme.atlassian.net", tickets: [] },
    sessions: [{
      id: "s2", git: { repoName: "Turma", branch: "main", dirtyFiles: 0 },
      root: false, newWorkSincePrs: false, ttydPort: 8080, restartCount: 2, prs: [],
    }],
  };
  assert.equal((await request("POST", "/api/heartbeat", { body: good, headers: agentHeaders })).status, 200);
  const kept = (await request("GET", "/api/agents", { headers: userHeaders }))
    .body.agents.find((a) => a.key === "xerk455-honest");
  assert.deepEqual(kept.codingAgent, { name: "claude", version: "1.2" });
  assert.deepEqual(kept.capacity, { maxSessions: 4, running: 1, queued: 0, free: 3, rootRunning: false });
  assert.equal(kept.uploadMaxBytes, 5000000);
  assert.equal(kept.jira.available, true);
  assert.equal(kept.sessions[0].ttydPort, 8080);
  assert.equal(kept.sessions[0].restartCount, 2);
  assert.deepEqual(kept.sessions[0].git, { repoName: "Turma", branch: "main", dirtyFiles: 0 });

  // The restore path runs the SAME coercion (normalizeRecord, ingest AND
  // state.json restore). Prove every guard directly, INCLUDING the nested typed
  // leaves a container-only coercion walks past — the holes QA found: PrInfo
  // `number`, LiveSignals booleans/int/double/lists, WorkInfo ints/pushed, and
  // the jira ticket internals (labels object element, repoGuess bools,
  // repoOptions.cloned). registry-restore.test.js pins the boot-time TDZ half.
  const restored = {
    device: "xerk455-restore",
    codingAgent: [], claudeAuth: 7, capacity: "x", github: [], gitSources: 5,
    repos: "x", closedSessions: 9, uploadMaxBytes: {},
    // updating is NOT a known heartbeat key — it rides the unknown-key spread and
    // is served raw for an offline host (found by the second QA pass).
    updating: { version: {}, until: "soon" },
    jira: { available: "yes", tickets: [
      { key: "K", labels: [{}, "keep", 3], repoGuess: { repo: "R", cloned: {}, manual: "no" } },
      "bad-ticket",
    ], repoOptions: [{ name: "r", cloned: {} }, 5] },
    sessions: [{
      id: "s", prs: [{ url: "u", number: {} }, 9],
      work: { aheadOfBase: {}, aheadOfRemote: 3, pushed: "x", baseRef: "main" },
      session: { lastHasToolUse: 5, bridgeAttached: "x", questionMulti: {},
        paneBusy: {}, questionIndex: {}, transcriptAgeSec: {},
        questionOptions: "no", questionOptionsRich: [7], newPrUrls: "no",
        tail: [{ id: "t", blocks: [{ t: "text", text: "hi", truncated: 5 }, 9] }] },
    }],
  };
  hub.normalizeRecord(restored);
  for (const k of ["codingAgent", "claudeAuth", "capacity", "github", "uploadMaxBytes"]) {
    assert.equal(k in restored, false, `restore left raw ${k}`);
  }
  // updating: object shape kept, but the bad version (object) and until dropped.
  assert.deepEqual(restored.updating, {});
  assert.deepEqual(restored.gitSources, []);
  assert.deepEqual(restored.repos, []);
  assert.deepEqual(restored.closedSessions, []);
  // jira internals: a bad ticket element filtered, a labels object element
  // dropped (string + number kept), repoGuess bools dropped, repoOptions.cloned
  // dropped, and a non-bool `available` gone.
  assert.deepEqual(restored.jira.tickets, [
    { key: "K", labels: ["keep", 3], repoGuess: { repo: "R" } },
  ]);
  assert.deepEqual(restored.jira.repoOptions, [{ name: "r" }]);
  assert.equal("available" in restored.jira, false);
  // session leaves: PrInfo.number dropped + non-object element filtered; WorkInfo
  // ints/pushed; every LiveSignals bad leaf, down to a tail block's `truncated`.
  const rs = restored.sessions[0];
  assert.deepEqual(rs.prs, [{ url: "u" }]);
  assert.deepEqual(rs.work, { aheadOfRemote: 3, baseRef: "main" });
  const live = rs.session;
  for (const k of ["lastHasToolUse", "bridgeAttached", "questionMulti", "paneBusy",
    "questionIndex", "transcriptAgeSec"]) {
    assert.equal(k in live, false, `live left raw ${k}`);
  }
  assert.deepEqual(live.questionOptions, []);
  assert.deepEqual(live.questionOptionsRich, []);
  assert.deepEqual(live.newPrUrls, []);
  assert.deepEqual(live.tail, [{ id: "t", blocks: [{ t: "text", text: "hi" }] }]);

  // A legitimate record with all those leaves populated is unchanged — validate,
  // never repair.
  const goodDeep = {
    device: "xerk455-gooddeep",
    updating: { version: "1.2.3", until: 1786400000000 },
    jira: { available: true, tickets: [{ key: "K", labels: ["a", "b"],
      repoGuess: { repo: "R", cloned: true, manual: false } }],
      repoOptions: [{ name: "r", cloned: true }] },
    sessions: [{ id: "s", prs: [{ url: "u", number: 42, state: "OPEN" }],
      work: { baseRef: "main", aheadOfBase: 3, pushed: true, aheadOfRemote: 0 },
      session: { paneBusy: true, lastHasToolUse: false, transcriptAgeSec: 4.5,
        questionOptions: ["a"], questionIndex: 1, questionTotal: 2,
        tail: [{ id: "t", blocks: [{ t: "text", text: "hi", truncated: true }] }] } }],
  };
  const snapshot = JSON.parse(JSON.stringify(goodDeep));
  hub.normalizeRecord(goodDeep);
  assert.deepEqual(goodDeep, snapshot, "a legitimate record must ride through unchanged");

  delete agents["xerk455-forger"];
  delete agents["xerk455-honest"];
});

test("http: a raw push is agent-authed and lands byte for byte", async () => {
  // tr1 was ingested by the rendered-layer test above, so its row (and the
  // canonical file the raw directory hangs off) already exists.
  const line = '{"type":"user","message":{"role":"user"},"costUSD":0.01}\n';
  assert.equal((await rawPush("nas", "tr1", "tr1.jsonl", 0, gz(line))).status, 401);

  const ok = await rawPush("nas", "tr1", "tr1.jsonl", 0, gz(line), agentHeaders);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stored, Buffer.byteLength(line));

  // Nested files keep their own layout — including the ones that are not
  // .jsonl, which is precisely the half of a session nothing else carries.
  const sub = '{"agentId":"a1"}\n';
  const r2 = await rawPush("nas", "tr1", "tr1/subagents/agent-1.jsonl", 0, gz(sub), agentHeaders);
  assert.equal(r2.body.stored, Buffer.byteLength(sub));
  const r3 = await rawPush("nas", "tr1", "tr1/tool-results/b1.txt", 0, gz("overflow"), agentHeaders);
  assert.equal(r3.body.stored, 8);

  // A resume appends; a re-send of a stored range writes nothing and hands back
  // the real cursor, which is what keeps a resumed session from duplicating.
  const more = '{"type":"assistant"}\n';
  const r4 = await rawPush("nas", "tr1", "tr1.jsonl", Buffer.byteLength(line), gz(more), agentHeaders);
  assert.equal(r4.body.stored, Buffer.byteLength(line + more));
  const r5 = await rawPush("nas", "tr1", "tr1.jsonl", 0, gz(line), agentHeaders);
  assert.equal(r5.body.stored, Buffer.byteLength(line + more));

  // Read it back: the list, then the file itself, byte for byte.
  const listed = await request("GET", "/api/archive/tr1/raw", { headers: userHeaders });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.files.map((f) => f.path).sort(),
    ["tr1.jsonl", "tr1/subagents/agent-1.jsonl", "tr1/tool-results/b1.txt"]);
  const got = await request("GET", `/api/archive/tr1/raw/${encodeURIComponent("tr1.jsonl")}`,
    { headers: userHeaders });
  assert.equal(got.status, 200);
  assert.equal(got.raw, line + more);
  // Served as a download with nosniff: a transcript holds whatever was pasted
  // into it, and rendering that inline behind the hub's login is stored XSS.
  assert.equal(got.headers["x-content-type-options"], "nosniff");
  assert.ok(/^attachment;/.test(got.headers["content-disposition"] || ""));
  // Both read paths are user-authed and both refuse an unknown file.
  assert.equal((await request("GET", "/api/archive/tr1/raw")).status, 401);
  assert.equal((await request("GET", "/api/archive/nope/raw", { headers: userHeaders })).status, 404);
  assert.equal((await request("GET", "/api/archive/tr1/raw/nope.jsonl", { headers: userHeaders })).status, 404);
});

test("http: GET /api/dsh/<id>/trajectory parses the native log (XERK-498)", async () => {
  // tr1's row/canonical file exist from the raw-push test above; add its dsh
  // native event log and read the Trajectory back through the route.
  const events = [
    '{"type":"session/title","seq":1,"time":1000,"data":{"title":"trajectory session"}}',
    '{"type":"turn/start","seq":2,"time":1000,"data":{"turn":1}}',
    '{"type":"step/start","seq":3,"time":1000,"data":{"turn":1,"step":1}}',
    '{"type":"assistant/chunk","seq":4,"time":1100,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":50,"outputTokens":5}}}}',
    '{"type":"tool/call","seq":5,"time":1100,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":{"command":"ls"}}}',
    '{"type":"tool/result","seq":6,"time":1140,"data":{"turn":1,"step":1,"message":{"source":{"callId":"c1"},"content":[{"type":"tool-result","toolCallId":"c1","isError":false}]}}}',
    '{"type":"turn/end","seq":7,"time":1200,"data":{"turn":1,"reason":{"kind":"completed"}}}',
  ].join("\n") + "\n";
  const push = await rawPush("nas", "tr1", "tr1/dsh/events.jsonl", 0, gz(events), agentHeaders);
  assert.equal(push.status, 200);
  // User-authed like the archive reads; anonymous is refused.
  assert.equal((await request("GET", "/api/dsh/tr1/trajectory")).status, 401);
  const r = await request("GET", "/api/dsh/tr1/trajectory", { headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, "trajectory session");
  assert.equal(r.body.totals.turns, 1);
  assert.equal(r.body.totals.toolCalls, 1);
  assert.equal(r.body.totals.tokens.input, 50);
  assert.equal(r.body.turns[0].calls[0].name, "bash");
  assert.equal(r.body.turns[0].calls[0].ok, true);
  // A session with no dsh native log answers 404 — the client shows "no trajectory".
  assert.equal((await request("GET", "/api/dsh/nope/trajectory", { headers: userHeaders })).status, 404);
});

test("http: a full chunk of INCOMPRESSIBLE bytes still fits the wire cap", async () => {
  // gzip EXPANDS incompressible input, so a wire cap equal to the chunk size made
  // any session file holding a full chunk of already-compressed bytes impossible
  // to push — permanently, and it took every other transcript on that host down
  // with it (QA D2). The cap has to CLEAR the worst case, not equal it.
  const chunk = crypto.randomBytes(1 << 22);          // 4 MiB, incompressible
  const gzipped = zlib.gzipSync(chunk);
  assert.ok(gzipped.length > chunk.length, "the fixture compressed; it must not");
  const r = await rawPush("nas", "tr1", "tr1/tool-results/blob.bin", 0, gzipped, agentHeaders);
  assert.equal(r.status, 200, `a full incompressible chunk was refused: ${r.raw}`);
  assert.equal(r.body.stored, chunk.length);
});

test("http: an over-long transcriptId is refused at the route", async () => {
  // The id is a DIRECTORY COMPONENT of the raw layer's path, so one past the
  // filesystem's 255-byte name limit made every push for that session fail at
  // the syscall and report `skip` with no diagnostic at all (XERK-338 QA F6).
  // Nothing turned red if the length bound were dropped back to `+` (QA G5).
  const long = "a".repeat(300);
  const r = await rawPush("nas", long, "x.jsonl", 0, gz("x"), agentHeaders);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /transcriptId/);
  // 255 is still fine — the bound must not have been tightened past the limit.
  const ok = await rawPush("nas", "b".repeat(255), "x.jsonl", 0, gz("x"), agentHeaders);
  assert.equal(ok.status, 200);
});

test("http: a raw push cannot name anything outside its own session", async () => {
  for (const bad of ["../../etc/passwd", "/etc/passwd", "..", "tr1/../../x", "a b.jsonl"]) {
    const r = await rawPush("nas", "tr1", bad, 0, gz("x"), agentHeaders);
    assert.equal(r.status, 400, `accepted: ${bad}`);
  }
  // ...and a hostile transcriptId is refused before any path is built.
  assert.equal((await rawPush("nas", "..%2f..%2fetc", "x.jsonl", 0, gz("x"), agentHeaders)).status, 400);
  // The same read-path allowlist, which is a separate call site.
  assert.equal((await request("GET",
    `/api/archive/tr1/raw/${encodeURIComponent("../../etc/passwd")}`,
    { headers: userHeaders })).status, 404);
});

test("http: a raw body that is not gzip, or is a bomb, is refused not decompressed", async () => {
  // Plain bytes where gzip was promised: a 400, not a stored chunk. It is NOT
  // the cursor protocol's "no progress" — the agent has nothing to realign to.
  const plain = await rawPush("nas", "tr1", "tr1.jsonl", 0, Buffer.from("not gzip"), agentHeaders);
  assert.equal(plain.status, 400);

  // A zip bomb is the shape that turns a small body into an OOM on a 256 MiB
  // hub, so the decompression is BOUNDED rather than the body cap being trusted
  // to imply a bound. 64 MiB of zeros gzips to ~64 KiB.
  const bomb = zlib.gzipSync(Buffer.alloc(64 << 20));
  assert.ok(bomb.length < (1 << 20), `bomb was ${bomb.length} bytes on the wire`);
  const r = await rawPush("nas", "tr1", "tr1.jsonl", 0, bomb, agentHeaders);
  assert.equal(r.status, 400);
  // And nothing landed: the stored cursor is untouched.
  const listed = await request("GET", "/api/archive/tr1/raw", { headers: userHeaders });
  const f = listed.body.files.find((x) => x.path === "tr1.jsonl");
  assert.ok(f.bytes < 1000, `a refused body still grew the file to ${f.bytes}`);
});

test("http: heartbeat carries the raw layer's per-file cursors back", async () => {
  const beat = {
    device: "nas",
    archiveManifest: [{
      transcriptId: "tr1", slug: "-w-ab", repo: "turma",
      rawFiles: [["tr1.jsonl", 999], ["tr1/subagents/agent-1.jsonl", 999],
                 ["tr1/never-pushed.jsonl", 5]],
    }],
  };
  const r = await request("POST", "/api/heartbeat", { body: beat, headers: agentHeaders });
  assert.equal(r.status, 200);
  const have = r.body.archiveRawHave.tr1;
  assert.ok(have["tr1.jsonl"] > 0);
  assert.ok(have["tr1/subagents/agent-1.jsonl"] > 0);
  // A file this hub holds nothing of is simply absent — the agent reads that as
  // zero and ships from the start, which is the same case as an older hub that
  // sends no cursors at all.
  assert.equal("tr1/never-pushed.jsonl" in have, false);
  // Nothing is near the raw ceiling, so the skip list stays off the wire.
  assert.equal("archiveRawSkip" in r.body, false);
  // Still not persisted onto the record.
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

test("http: a NON-ARRAY usage.models cannot blank the dashboard for everyone", async () => {
  // The coercion above only ran when `models` was ALREADY an array, so an object
  // rode through raw. The dashboard walks it with `for (const m of list || [])`,
  // which throws on an object, and it builds tiles + host list in one pass — so
  // one agent-authed beat left EVERY operator with nothing but the nav. Android
  // types `models` (defaulted to empty, so absent is safe) and decodes the whole
  // /api/agents array atomically, so the same beat empties every other host from
  // every phone. Absent, not `[]`: absent is "can't tell you", `[]` asserts the
  // host spent on no models.
  // 0, false and "" matter: an all-truthy fixture let a `if (usage.models)`
  // guard on the delete pass the whole suite, and all three are decode-fatal
  // on Android (only an explicit null is survivable, via coerceInputValues).
  for (const bad of [{ evil: { totals: { input: 5 } } }, "opus", 7, true, 0, false, ""]) {
    assert.equal(
      (await request("POST", "/api/heartbeat", {
        body: {
          device: "bad-models-host",
          usage: { totals: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 }, models: bad },
          repoUsage: [{ repo: "Turma", usage: { models: bad } }],
          sessions: [{ id: "s1", repo: "Turma", status: "running", usage: { models: bad } }],
        },
        headers: agentHeaders,
      })).status,
      200
    );
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    const rec = res.body.agents.find((a) => a.key === "bad-models-host");
    assert.equal("models" in rec.usage, false, `usage.models survived ${JSON.stringify(bad)}`);
    assert.equal("models" in rec.repoUsage[0].usage, false);
    assert.equal("models" in rec.sessions[0].usage, false);
    // Everything else in the block still rides through.
    assert.equal(rec.usage.totals.input, 1);
  }
});

test("a dropped models block is TALLIED, not silently deleted", async () => {
  // Before the coercion the failure was loud — the dashboard went blank. Silent
  // deletion turns it into invisible data loss with nothing to alert on, while
  // every sibling coercion in this file names what it dropped.
  const warnings = [];
  const realWarn = console.warn;
  hub.resetUsageCoercionLog();
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const rec = { device: "silent-host", usage: { models: { evil: 1 } } };
    hub.normalizeRecord(rec);
    assert.ok(!("models" in rec.usage), "dropped");
    assert.equal(warnings.length, 1, "and said so");
    assert.match(warnings[0], /silent-host/);
    assert.match(warnings[0], /models/);
  } finally {
    console.warn = realWarn;
  }
});

test("XERK-289: a second host beating under an existing host's name is warned about", async () => {
  // Two DIFFERENT physical hosts reporting the SAME device name silently share
  // one registry record; the device name is the only wire identity so the hub
  // can't key them apart, but `agentId` differs — that mismatch is the signal.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    // First host claims the name — no incumbent, so no warning.
    assert.equal((await request("POST", "/api/heartbeat", {
      body: { device: "shared-name", agentId: "host-A" }, headers: agentHeaders,
    })).status, 200);
    assert.equal(warnings.length, 0, "first beat is not a collision");
    // Same host beats again — same agentId, no warning.
    assert.equal((await request("POST", "/api/heartbeat", {
      body: { device: "shared-name", agentId: "host-A" }, headers: agentHeaders,
    })).status, 200);
    assert.equal(warnings.length, 0, "an incumbent re-beat is not a collision");
    // A DIFFERENT host beats under the same name — warned, and named.
    assert.equal((await request("POST", "/api/heartbeat", {
      body: { device: "shared-name", agentId: "host-B" }, headers: agentHeaders,
    })).status, 200);
    assert.equal(warnings.length, 1, "the collision is surfaced");
    assert.match(warnings[0], /collision/);
    assert.match(warnings[0], /shared-name/);
    assert.match(warnings[0], /host-A/);
    assert.match(warnings[0], /host-B/);
    // Throttled: an immediate repeat of the collision does not re-warn.
    assert.equal((await request("POST", "/api/heartbeat", {
      body: { device: "shared-name", agentId: "host-A" }, headers: agentHeaders,
    })).status, 200);
    assert.equal(warnings.length, 1, "the warning is time-throttled");
  } finally {
    console.warn = realWarn;
  }
});

test("XERK-282: a heartbeat cannot publish a record under another host's key", async () => {
  // `key` is hub-owned — the registry identity every client keys hosts by and
  // every control routes on. A heartbeat that echoes a `key` field must not
  // override it, or one agent's payload is served under another host's key and
  // silently displaces the victim on the dashboard/Android/glasses.
  assert.equal((await request("POST", "/api/heartbeat", {
    body: { device: "victim-282", repos: [{ name: "Turma" }] }, headers: agentHeaders,
  })).status, 200);
  assert.equal((await request("POST", "/api/heartbeat", {
    body: { device: "attacker-282", key: "victim-282", repos: [{ name: "EVIL" }] },
    headers: agentHeaders,
  })).status, 200);

  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const victims = res.body.agents.filter((a) => a.key === "victim-282");
  const attackers = res.body.agents.filter((a) => a.key === "attacker-282");
  // Exactly one record under each key — the attacker's `key:"victim-282"` was
  // stripped on ingest and could not override the authoritative registry key.
  assert.equal(victims.length, 1, "only the real victim is served under its key");
  assert.equal(attackers.length, 1, "the impersonating beat keeps its OWN key");
  assert.equal(victims[0].device, "victim-282");
  assert.deepEqual(victims[0].repos, [{ name: "Turma" }]);
  assert.equal(attackers[0].device, "attacker-282");
  assert.deepEqual(attackers[0].repos, [{ name: "EVIL" }]);
});

test("http: a malformed top-level models block cannot empty every phone's fleet", async () => {
  // The same failure class as usage.models, one field up and a different shape.
  // Android types `models` as `ModelsInfo?` and decodes /api/agents atomically,
  // so one host beating a string here throws for the WHOLE array — every OTHER
  // host vanishes from the fleet list while the tile still says "N / N online".
  // The web guards this one, so it fails on the client that fails silently.
  for (const bad of ["x", 5, [1, 2], true, 0, "", { available: "x" }, { available: [1, 2] }]) {
    assert.equal(
      (await request("POST", "/api/heartbeat", {
        body: { device: "bad-topmodels-host", models: bad },
        headers: agentHeaders,
      })).status,
      200
    );
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    const rec = res.body.agents.find((a) => a.key === "bad-topmodels-host");
    const m = rec.models;
    if (m === undefined) continue;            // dropped outright — fine
    assert.equal(typeof m, "object", `models stayed ${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(m.available), `available stayed ${JSON.stringify(bad)}`);
    assert.ok(m.available.every((x) => typeof x === "string"));
    assert.equal(typeof m.defaultLabel, "string");
    assert.equal(typeof m.at, "string");
  }
});

test("a models block that is ABSENT, or has nothing usable, stays absent", async () => {
  // Absent is the property the coercion sells: it is what the ticket model picker
  // reads as "this agent can't tell you" and falls back to the static aliases for.
  // A REBUILT empty block is worse than nothing — it passes board.js's
  // `Array.isArray(mb.available)` gate, joins the freshest-probe compare, and can
  // take the default label off a host that probed properly. `Board.kt` compares
  // the same way.
  const absent = { device: "no-models-host" };
  hub.normalizeRecord(absent);
  assert.equal("models" in absent, false, "a host that sent none must not be given one");

  for (const junk of [{}, { available: [] }, { available: [1, 2, null] },
                      { available: "nope", defaultLabel: 5, at: [] }, [1, 2], "x", 0, false, "",
                      // The survivors of an all-fields guard: a block whose only
                      // usable value is `at` or `defaultLabel` is still empty
                      // where it counts, and a fresh `at` is exactly what wins
                      // the freshest-probe compare and clears a real host's
                      // default label.
                      { available: "nope", at: "2099-01-01" },
                      { available: [], defaultLabel: "Opus 5" },
                      { at: "2099-01-01", defaultLabel: "Opus 5" }]) {
    const rec = { device: "junk-models-host", models: junk };
    hub.normalizeRecord(rec);
    assert.equal("models" in rec, false, `rebuilt an empty block from ${JSON.stringify(junk)}`);
  }
});

test("a models block's entries are DROPPED when unusable, never stringified", async () => {
  // A coerced `5` becomes the model name "5", which names a model that does not
  // exist — the picker would offer it and the spawn would fail. And each name is
  // length-bounded, not just the list: 100 entries of 70 KiB is a 7 MiB block on
  // /api/agents and on every SSE frame, which a count cap alone waves through.
  const rec = { device: "mixed-models-host",
                models: { available: ["opus", 5, null, "", { m: 1 }, "z".repeat(500)] } };
  hub.normalizeRecord(rec);
  assert.deepEqual(rec.models.available, ["opus", "z".repeat(120)]);
});

test("a models block that was absent does not warn about lost tokens", async () => {
  // `models` carries no tokens, so it must never reach the usage tally — a line
  // saying this host's "token figures understate what it really spent" would be
  // a lie, and at one per beat it buries the hosts genuinely sending bad shapes.
  const warnings = [];
  const realWarn = console.warn;
  hub.resetUsageCoercionLog();
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    hub.normalizeRecord({ device: "quiet-models-host" });
    hub.normalizeRecord({ device: "quiet-models-host2", models: { available: ["opus"] } });
    hub.normalizeRecord({ device: "quiet-models-host3", models: "junk" });
    // And a usage.models of explicit null is the agent's deliberate "nothing to
    // report", exactly as a null usage block is.
    hub.normalizeRecord({ device: "quiet-models-host4", usage: { models: null } });
    assert.deepEqual(warnings, [], `nothing here spends tokens: ${warnings[0] || ""}`);
  } finally {
    console.warn = realWarn;
  }
});

test("http: a good top-level models block rides through, bounded", async () => {
  await request("POST", "/api/heartbeat", {
    body: { device: "good-topmodels-host",
            models: { available: ["opus", "sonnet"], defaultLabel: "Opus", at: "2026-08-01" } },
    headers: agentHeaders,
  });
  let res = await request("GET", "/api/agents", { headers: userHeaders });
  let rec = res.body.agents.find((a) => a.key === "good-topmodels-host");
  assert.deepEqual(rec.models, { available: ["opus", "sonnet"], defaultLabel: "Opus", at: "2026-08-01" });

  // It rides /api/agents and every SSE frame, and every field of it is
  // agent-asserted, so none of them may be unbounded.
  await request("POST", "/api/heartbeat", {
    body: { device: "good-topmodels-host",
            models: { available: Array.from({ length: 500 }, (_, i) => `m${i}`),
                      defaultLabel: "z".repeat(5000), at: "z".repeat(5000) } },
    headers: agentHeaders,
  });
  res = await request("GET", "/api/agents", { headers: userHeaders });
  rec = res.body.agents.find((a) => a.key === "good-topmodels-host");
  assert.equal(rec.models.available.length, 100);
  assert.equal(rec.models.defaultLabel.length, 120);
  assert.equal(rec.models.at.length, 120);
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

test("http: the sub-agent split is carried on every usage block, and coerced", async () => {
  // XERK-302: `subagent` is the share of a usage block spent by the background
  // agents its sessions delegated to. Android TYPES it, so one host's garbage
  // would fail the decode of the WHOLE /api/agents array — hence the coercion
  // here rather than in each of the three clients.
  const split = {
    totals: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
    today: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
    week: { input: 5, output: 6, cacheWrite: 7, cacheRead: 8 },
  };
  const read = async (key) =>
    (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === key);

  assert.equal((await request("POST", "/api/heartbeat", {
    body: {
      device: "split-host",
      usage: { totals: { input: 100 }, subagent: split },
      repoUsage: [{ repo: "Turma", usage: { subagent: split } }],
      sessions: [{ id: "s1", repo: "Turma", status: "running", usage: { subagent: split } }],
    },
    headers: agentHeaders,
  })).status, 200);
  const rec = await read("split-host");
  assert.deepEqual(rec.usage.subagent, split);
  assert.deepEqual(rec.repoUsage[0].usage.subagent, split);
  assert.deepEqual(rec.sessions[0].usage.subagent, split);
});

test("http: a malformed sub-agent split is DROPPED, never repaired into zeros", async () => {
  // The coercion VALIDATES; it must not repair. A repaired block is a
  // well-formed all-zero one, which is indistinguishable from a host that
  // genuinely delegated nothing — so the host stays in the Usage page's
  // denominator with a fabricated 0 on top, understating the fleet's delegated
  // share. Absent is what every client already reads as "can't tell you".
  const read = async (key) =>
    (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === key);
  const beat = async (subagent) => {
    // Cleared per case because the durable usage ledger (XERK-338) is a
    // HIGH-WATER mark: once a valid split has been recorded for this host, a
    // later zero one is served the recorded figure, which is the ledger working
    // and would hide what this test is about — the coercion, on a fresh host.
    usageLedger.forget("junk-split-host");
    await request("POST", "/api/heartbeat", {
      body: { device: "junk-split-host", usage: { totals: { input: 1 }, subagent } },
      headers: agentHeaders,
    });
    return (await read("junk-split-host")).usage.subagent;
  };
  const win = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  for (const junk of [
    "lots", 7, true, [], null,                        // not a block at all
    {},                                               // no windows: not a report
    { totals: { input: 5 } },                         // a partial shape is not a report
    { totals: "x", today: 7, week: [] },              // windows that aren't buckets
    { totals: { input: "9" }, today: {}, week: {} },  // a figure that isn't a number
    { totals: { input: -5 }, today: {}, week: {} },   // a negative token count
    { totals: { input: 1.5 }, today: {}, week: {} },  // a FLOAT is decode-fatal on Android
    { totals: { input: 1e308 }, today: {}, week: {} },      // …and so is a huge one
    { totals: { input: Number.MAX_SAFE_INTEGER + 2 }, today: {}, week: {} },
  ]) {
    assert.equal(await beat(junk), undefined, `not dropped: ${JSON.stringify(junk)}`);
  }

  // A genuine all-zero report IS an answer — that host delegated nothing — and
  // must survive, or a non-delegating host is wrongly excluded and the share
  // over-states. A missing KEY inside a real window is 0, not a lie.
  assert.deepEqual(
    await beat({ totals: { ...win, input: 4 }, today: { ...win }, week: { ...win } }),
    { totals: { ...win, input: 4 }, today: win, week: win });
  assert.deepEqual(await beat({ totals: {}, today: {}, week: {} }),
                   { totals: win, today: win, week: win });
});

test("http: an unusable token figure is coerced to 0 on every usage block", async () => {
  // XERK-306: a bucket's four counts are Kotlin `Long`s on Android and a full
  // /api/agents decode is ATOMIC there, so ONE host's `1.5` threw for the WHOLE
  // array — every OTHER host silently vanished from that phone's fleet list
  // while the tile still read "N / N online". XERK-302 fixed `subagent` alone;
  // these are its siblings, on every block a beat carries.
  const bad = { input: 1.5, output: 1e308, cacheWrite: "9", cacheRead: -5 };
  const good = { input: 7, output: 0, cacheWrite: Number.MAX_SAFE_INTEGER, cacheRead: 3 };
  const zeros = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const usage = () => ({
    totals: { ...bad },
    today: { ...good },
    week: { input: 2 },  // a partial bucket: the keys it HAS are all it gets
    days: { "2026-08-01": { ...bad }, "2026-08-02": { ...good } },
    models: [{ model: "opus", totals: { ...bad }, today: { ...good } }],
  });

  assert.equal((await request("POST", "/api/heartbeat", {
    body: {
      device: "figure-host",
      usage: usage(),
      repoUsage: [{ repo: "Turma", usage: usage() }],
      sessions: [{ id: "s1", repo: "Turma", status: "running", usage: usage() }],
    },
    headers: agentHeaders,
  })).status, 200);
  const rec = (await request("GET", "/api/agents", { headers: userHeaders }))
    .body.agents.find((a) => a.key === "figure-host");

  for (const [where, u] of [["host", rec.usage], ["repo", rec.repoUsage[0].usage],
                            ["session", rec.sessions[0].usage]]) {
    assert.deepEqual(u.totals, zeros, `${where}: bad figures not zeroed`);
    assert.deepEqual(u.today, good, `${where}: good figures not left alone`);
    // A MISSING key stays missing. Filling it in would GROW the record, and
    // this walk runs before the second AGENT_RECORD_MAX measurement.
    assert.deepEqual(u.week, { input: 2 }, `${where}: absent figures filled in`);
    assert.deepEqual(u.days["2026-08-01"], zeros, `${where}: day bucket not zeroed`);
    assert.deepEqual(u.days["2026-08-02"], good, `${where}: good day bucket changed`);
    assert.deepEqual(u.models[0].totals, zeros, `${where}: model bucket not zeroed`);
    assert.deepEqual(u.models[0].today, good, `${where}: good model bucket changed`);
  }

  // The property the Android decoder actually needs, asserted over the whole
  // served record rather than the fields this test happened to name.
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (["input", "output", "cacheWrite", "cacheRead"].includes(k)) {
        assert.ok(Number.isSafeInteger(x) && x >= 0, `${at}.${k} is not a Long: ${x}`);
      } else walk(x, `${at}.${k}`);
    }
  };
  walk(rec, "agent");
});

test("http: usage shapes that are not buckets are dropped, and no coercion grows the record", async () => {
  // The other half of XERK-306: a window, a `days` map or a whole `usage` that
  // is not an object at all is decode-fatal before any figure inside it counts.
  // Each is DELETED rather than rebuilt — a rebuilt bucket would be four keys
  // of invented zeros, and this walk runs between the raw and the coerced
  // AGENT_RECORD_MAX measurements, so it must never expand what it is given.
  const junk = {
    usage: {
      totals: "lots", today: 7, week: [], days: [1, 2], lastActivity: 5,
      models: [{ model: "opus", totals: null }],
    },
    repoUsage: [null, "x", { repo: 5, remoteKey: {}, usage: 9 },
                { repo: "Turma", usage: { totals: { input: 4 } } }],
    sessions: [{ id: "s1", repo: "Turma", status: "running", usage: 3 }],
  };
  const sent = JSON.stringify({ usage: junk.usage, repoUsage: junk.repoUsage });

  assert.equal((await request("POST", "/api/heartbeat", {
    body: { device: "junk-usage-host", ...junk },
    headers: agentHeaders,
  })).status, 200);
  const rec = (await request("GET", "/api/agents", { headers: userHeaders }))
    .body.agents.find((a) => a.key === "junk-usage-host");

  assert.deepEqual(rec.usage, { models: [{ model: "opus" }] });
  // A non-object element of a typed LIST is as fatal as a bad field inside one.
  assert.deepEqual(rec.repoUsage, [{}, { repo: "Turma", usage: { totals: { input: 4 } } }]);
  assert.ok(!("usage" in rec.sessions[0]), "a session's non-object usage survived");

  const kept = JSON.stringify({ usage: rec.usage, repoUsage: rec.repoUsage });
  assert.ok(kept.length <= sent.length,
            `coercion grew the record: ${sent.length} -> ${kept.length}`);
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

test("http: the 7-day day markers are coerced as a whitelist of seven strings", async () => {
  // XERK-536: the even-pace markers ride the sevenDay window as `dayLabels`.
  // Android TYPES it as List<String>, so one bad element would fail the WHOLE
  // /api/agents decode — the field passes only as exactly seven short strings,
  // is length-capped per label, and is never carried on the 5-hour window.
  const beat = (body) =>
    request("POST", "/api/heartbeat", { body, headers: agentHeaders });
  const read = async () =>
    (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === "labels-host");
  const days = ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"];
  const capturedAt = 1_786_400_000;

  // A well-formed set survives, length-capped, and only on the 7-day window.
  await beat({
    device: "labels-host",
    limits: {
      fiveHour: { usedPct: 20, resetsAt: 1, dayLabels: days },  // stripped: 5h has none
      sevenDay: { usedPct: 40, resetsAt: 2, dayLabels: [...days.slice(0, 6), "x".repeat(20)] },
      capturedAt,
    },
  });
  let got = (await read()).limits;
  assert.equal(got.fiveHour.dayLabels, undefined);
  assert.deepEqual(got.sevenDay.dayLabels, [...days.slice(0, 6), "x".repeat(8)]);

  // Any malformed shape drops the field but keeps the window itself.
  for (const dayLabels of [days.slice(0, 6), [...days, "extra"], [1, 2, 3, 4, 5, 6, 7], "nope", {}]) {
    await beat({
      device: "labels-host",
      limits: { sevenDay: { usedPct: 40, resetsAt: 2, dayLabels }, capturedAt },
    });
    got = (await read()).limits;
    assert.deepEqual(got.sevenDay, { usedPct: 40, resetsAt: 2 }, JSON.stringify(dayLabels));
  }
});

test("http: the subscription key reaches the clients, coerced and bounded", async () => {
  // XERK-301: the usage page groups limit cards on this key, so it is pure
  // carriage — but it is also a MAP KEY on every client and Android TYPES it,
  // so an unusable shape must become the "can't tell you" null rather than a
  // plausible default that would fold two subscriptions into one set of bars.
  const beat = (body) =>
    request("POST", "/api/heartbeat", { body, headers: agentHeaders });
  const read = async () =>
    (await request("GET", "/api/agents", { headers: userHeaders }))
      .body.agents.find((a) => a.key === "sub-host");

  await beat({ device: "sub-host", subscription: { key: "abc123", source: "login" } });
  assert.deepEqual((await read()).subscription, { key: "abc123", source: "login" });

  await beat({ device: "sub-host", subscription: { key: "x".repeat(500), source: "y".repeat(90) } });
  assert.deepEqual((await read()).subscription,
    { key: "x".repeat(128), source: "y".repeat(32) });

  // XERK-541: the human-readable card name rides beside the key, trimmed and
  // bounded like it; an unusable one is simply absent (the card names its hosts).
  await beat({ device: "sub-host",
    subscription: { key: "abc123", source: "login", label: "  XerkTech  " } });
  assert.deepEqual((await read()).subscription,
    { key: "abc123", source: "login", label: "XerkTech" });
  await beat({ device: "sub-host",
    subscription: { key: "abc123", label: "z".repeat(500) } });
  assert.equal((await read()).subscription.label, "z".repeat(256));
  for (const label of ["", "   ", 7, {}, null]) {
    await beat({ device: "sub-host", subscription: { key: "abc123", label } });
    assert.equal("label" in (await read()).subscription, false, JSON.stringify(label));
  }

  for (const subscription of [{ key: "" }, { key: 7 }, {}, [], "nope", 7, null]) {
    await beat({ device: "sub-host", subscription });
    assert.equal((await read()).subscription, null, JSON.stringify(subscription));
  }

  // An agent too old to know the field says nothing, and stays saying nothing.
  await beat({ device: "sub-host" });
  assert.equal((await read()).subscription, undefined);
});

test("http: command queue rides the reply until acked", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });

  // Register the host; queue is empty at first.
  let res = await beat({ device: "h1" });
  assert.equal(res.status, 200);
  // `peers` rides every reply (XERK-348) — it is how a host learns which
  // sessions its own may address, so an absent key means "no roster", which the
  // agent reads as a boundary it cannot widen past its own host.
  // `bodyMax` rides it too (XERK-347): the hub's body ceiling is a fraction of
  // its container limit, so only the hub knows it — and an agent that guesses a
  // fixed number posts into the band where an oversize body gets no status at
  // all, which is XERK-235's permanent offline loop.
  assert.deepEqual(Object.keys(res.body).sort(), ["bodyMax", "commands", "peers"]);
  assert.deepEqual(res.body.commands, []);
  assert.deepEqual(res.body.peers, []);
  assert.ok(res.body.bodyMax > 0, "the hub states a positive body ceiling");

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

test("http: XERK-309 bypassPermissions refused for a repos-root session", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  const repos = [{ name: "Turma" }, { name: "(root)" }];
  await beat({ device: "hroot", repos });

  // Root repo + bypass -> 409 in the hub's own words (XERK-264), never queued.
  const refused = await request("POST", "/api/agents/hroot/sessions", {
    body: { repo: "(root)", permissionMode: "bypassPermissions" },
    headers: userHeaders,
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /repos-root/);

  // Root repo + any other mode is fine…
  const okRoot = await request("POST", "/api/agents/hroot/sessions", {
    body: { repo: "(root)", permissionMode: "plan" }, headers: userHeaders,
  });
  assert.equal(okRoot.status, 200);
  // …and a WORKTREE repo + bypass is still allowed (the capability the mode
  // exists for — the gate is scoped to root, XERK-309).
  const okWorktree = await request("POST", "/api/agents/hroot/sessions", {
    body: { repo: "Turma", permissionMode: "bypassPermissions" }, headers: userHeaders,
  });
  assert.equal(okWorktree.status, 200);

  // A whitespace-padded value is normalized like the agent's own strip, so a
  // padded " bypassPermissions " on root still 409s (XERK-264) rather than 200ing
  // and landing as an errored card. The sessions route forwards the field raw.
  const padded = await request("POST", "/api/agents/hroot/sessions", {
    body: { repo: "(root)", permissionMode: " bypassPermissions " }, headers: userHeaders,
  });
  assert.equal(padded.status, 409);

  // Only the two 200s queued a spawn; the refused one queued nothing.
  const q = await beat({ device: "hroot", repos });
  const spawns = q.body.commands.filter((c) => c.type === "spawn");
  assert.equal(spawns.length, 2);
  assert.ok(spawns.every((c) =>
    !(c.repo === "(root)" && c.permissionMode === "bypassPermissions")));

  // The /api/trigger route shares the same gate.
  const trig = await request("POST", "/api/trigger", {
    body: { hostname: "hroot", repo: "(root)", prompt: "x",
            permissionMode: "bypassPermissions" },
    headers: { authorization: "Bearer triggertok", "content-type": "application/json" },
  });
  assert.equal(trig.status, 409);

  // The live /mode route refuses a switch INTO bypass for a running root
  // session, but allows it for a worktree session.
  await beat({ device: "hroot", repos, sessions: [
    { id: "rs1", repo: "(root)", root: true, status: "running" },
    { id: "ws1", repo: "Turma", root: false, status: "running" },
  ] });
  const modeRefused = await request("POST", "/api/agents/hroot/sessions/rs1/mode", {
    body: { permissionMode: "bypassPermissions" }, headers: userHeaders,
  });
  assert.equal(modeRefused.status, 409);
  assert.match(modeRefused.body.error, /repos-root/);
  // Padded value on the live route is normalized the same way.
  const modePadded = await request("POST", "/api/agents/hroot/sessions/rs1/mode", {
    body: { permissionMode: " bypassPermissions " }, headers: userHeaders,
  });
  assert.equal(modePadded.status, 409);
  const modeOk = await request("POST", "/api/agents/hroot/sessions/ws1/mode", {
    body: { permissionMode: "bypassPermissions" }, headers: userHeaders,
  });
  assert.equal(modeOk.status, 200);
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
  // XERK-314: credentialed CORS is NOT offered on ordinary reads — only the
  // cookie-planting login/logout endpoints get Allow-Credentials.
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  assert.equal(res.headers["access-control-allow-headers"], "Authorization, Content-Type");
  assert.equal(res.headers["access-control-allow-methods"], "GET, POST, DELETE, OPTIONS");
});

test("CORS: OPTIONS preflight on /term/* also answers 204 without auth", async () => {
  const res = await request("OPTIONS", "/term/whatever", { headers: { origin: "http://glasses.local" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://glasses.local");
});

// XERK-314: /term/<id>/token hands the browser the host's agent credential, and
// the CORS reflection + Allow-Credentials on the whole /api|/term surface let an
// attacker page read it cross-origin off a logged-in victim's cookie. The fix
// confines Allow-Credentials to the cookie-planting login/logout endpoints, so a
// cross-origin credentialed read of any other route is blocked by the browser.
test("XERK-314: /api and /term reads do NOT get Allow-Credentials", async () => {
  for (const path of ["/api/agents", "/term/whatever", "/term/sl7/token"]) {
    const res = await request("GET", path, {
      headers: { ...userHeaders, origin: "http://evil.example" },
    });
    assert.equal(
      res.headers["access-control-allow-credentials"], undefined,
      `${path} must not offer credentialed CORS`,
    );
    // Reflection stays (glasses' Authorization-header reads rely on it), but a
    // browser cannot turn it into a credentialed read without Allow-Credentials.
    assert.equal(res.headers["access-control-allow-origin"], "http://evil.example");
  }
});

test("XERK-314: login and logout keep Allow-Credentials for the glasses cookie plant", async () => {
  for (const path of ["/api/login", "/api/logout"]) {
    const res = await request("OPTIONS", path, { headers: { origin: "http://glasses.local" } });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "http://glasses.local");
    assert.equal(
      res.headers["access-control-allow-credentials"], "true",
      `${path} must keep credentialed CORS`,
    );
  }
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

test("http: model endpoint accepts a discovered dsh model for a dsh session (XERK-504)", async () => {
  hub.__setDshEnabled(true);
  // A dsh session's model is a DISCOVERED endpoint id, not a Claude alias, so the
  // route takes the endpoint charset (`/`, `:`) and validates against the host's
  // discovered dsh set — mirroring the local branch. The agent relaunches the dsh
  // process on the new model rather than driving the (non-existent) /model picker.
  await request("POST", "/api/heartbeat", { body: {
    device: "hmdsh",
    dsh: { available: true, defaultModel: "deepseek-chat",
           models: [{ id: "deepseek-chat", contextTokens: 128000 },
                    { id: "qwen3-coder", contextTokens: 32768 }] },
    sessions: [{ id: "sd1", repo: "r", agentType: "dsh", model: "deepseek-chat" }],
  }, headers: agentHeaders });
  // A discovered id is accepted and queues setModel.
  const ok = await request("POST", "/api/agents/hmdsh/sessions/sd1/model", {
    body: { model: "qwen3-coder" }, headers: userHeaders });
  assert.equal(ok.status, 200);
  const beat = await request("POST", "/api/heartbeat", { body: { device: "hmdsh",
    dsh: { available: true, defaultModel: "deepseek-chat",
           models: [{ id: "deepseek-chat", contextTokens: 128000 },
                    { id: "qwen3-coder", contextTokens: 32768 }] },
    sessions: [{ id: "sd1", repo: "r", agentType: "dsh", model: "deepseek-chat" }] },
    headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [
    { type: "setModel", sessionId: "sd1", model: "qwen3-coder", cmdId: ok.body.cmdId },
  ]);
  // A model the host does NOT serve -> 409 (not queued), like the local route.
  const unserved = await request("POST", "/api/agents/hmdsh/sessions/sd1/model", {
    body: { model: "some-other-model" }, headers: userHeaders });
  assert.equal(unserved.status, 409);
  // A slash-bearing id (a bedrock-style route) passes the endpoint charset gate
  // that the Claude-alias branch would reject — here it 409s only because it is
  // not in the discovered set, proving it reached the dsh branch not the alias one.
  const slashy = await request("POST", "/api/agents/hmdsh/sessions/sd1/model", {
    body: { model: "bedrock/us.anthropic.foo" }, headers: userHeaders });
  assert.equal(slashy.status, 409);
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

test("http: a running session's scrollback is served INSTANTLY from the archive (200, not 202) + refresh queued", async () => {
  // The agent keeps a running worktree-backed session syncing to the archive, so
  // /history serves it hub-locally on a cache miss instead of waiting out an agent
  // round-trip — while still queuing a refresh to heal to the freshest copy.
  const meta = { remoteKey: "github.com/x/r", repo: "r", worktree: "/w/live",
    slug: "-w-live", createdAt: "2026-08-30T00:00:00Z", summary: "Live chat" };
  const push = await request("POST", "/api/agents/hh7/archive/tconv", {
    headers: agentHeaders,
    body: { startOffset: 0, endOffset: 60, size: 60, meta, entries: [
      { uuid: "a1", role: "user", ts: "2026-08-30T00:00:00Z", text: "hello" },
      { uuid: "a2", role: "assistant", ts: "2026-08-30T00:00:10Z", text: "hi there" },
    ] },
  });
  assert.equal(push.status, 200);
  // The host reports the session RUNNING with that transcript.
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: {
    device: "hh7",
    sessions: [{ id: "sa", status: "running", repo: "r", worktreePath: "/w/live",
      transcriptId: "tconv", session: { transcriptAgeSec: 1 } }],
  } });

  const res = await request("GET", "/api/agents/hh7/sessions/sa/history", { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.body.fromArchive, true);
  // uuid -> id mapping: the archive keys on uuid, the client merge keys on id.
  assert.deepEqual(res.body.entries.map((e) => e.id), ["a1", "a2"]);
  assert.equal(res.body.entries[1].role, "assistant");
  // A refresh command was queued so the cache heals to the agent's fresh copy.
  const beat = await request("POST", "/api/heartbeat", { headers: agentHeaders, body: { device: "hh7" } });
  assert.ok((beat.body.commands || []).some((c) => c.type === "history" && c.sessionId === "sa"));
});

test("http: a running session with nothing in the archive yet still 202s (cold start)", async () => {
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: {
    device: "hh8",
    sessions: [{ id: "sb", status: "running", repo: "r", worktreePath: "/w/new",
      transcriptId: "no-archive-yet", session: { transcriptAgeSec: 1 } }],
  } });
  const res = await request("GET", "/api/agents/hh8/sessions/sb/history", { headers: userHeaders });
  assert.equal(res.status, 202);
  assert.equal(res.body.pending, true);
});

test("http: a STOPPED session is NOT served from the archive even when its transcript is there", async () => {
  // The archive-serve path is gated on the LIVE session (`status === "running"`);
  // a stopped/killed session's /history takes the old queue-and-202 path, so it
  // never reads archive content as if it were the live conversation.
  const meta = { remoteKey: "github.com/x/r2", repo: "r2", worktree: "/w/dead",
    slug: "-w-dead", createdAt: "2026-08-30T00:00:00Z", summary: "Dead chat" };
  const push = await request("POST", "/api/agents/hh9/archive/tdead", {
    headers: agentHeaders,
    body: { startOffset: 0, endOffset: 40, size: 40, meta, entries: [
      { uuid: "z1", role: "user", ts: "2026-08-30T00:00:00Z", text: "bye" },
    ] },
  });
  assert.equal(push.status, 200);
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: {
    device: "hh9",
    sessions: [{ id: "sc", status: "stopped", repo: "r2", worktreePath: "/w/dead",
      transcriptId: "tdead", session: { transcriptAgeSec: 1 } }],
  } });
  const res = await request("GET", "/api/agents/hh9/sessions/sc/history", { headers: userHeaders });
  assert.equal(res.status, 202);
  assert.notEqual(res.body.fromArchive, true);
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
    { type: "subagentHistory", sessionId: "s1", agentType: "Explore", label: "Map the code", agentId: "", cmdId: first.body.cmdId },
    { type: "subagentHistory", sessionId: "s1", agentType: "Explore", label: "Other", agentId: "", cmdId: other.body.cmdId },
  ]);
});

test("http: subagent-history requires a type", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "sh2" }, headers: agentHeaders });
  const res = await request(
    "GET", "/api/agents/sh2/sessions/s1/subagents/history?label=x", { headers: userHeaders });
  assert.equal(res.status, 400);
});

// ---- workflow drill-down (XERK-304) ----------------------------------------

test("XERK-304: a workflow row and one of its agents are DISTINCT cache rows", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "wf1" }, headers: agentHeaders });

  const list = "/api/agents/wf1/sessions/s1/subagents/history?type=workflow&label=code-review";
  const one = list + "&agentId=a0123";
  const listRes = await request("GET", list, { headers: userHeaders });
  const oneRes = await request("GET", one, { headers: userHeaders });
  assert.equal(listRes.status, 202);
  assert.equal(oneRes.status, 202);
  assert.notEqual(oneRes.body.cmdId, listRes.body.cmdId,
    "the run's agent list and one agent's transcript are different reads");

  // Both deliveries land, each under its own key — the agentId is what keeps the
  // agent's transcript from overwriting the list it was picked from.
  await request("POST", "/api/heartbeat", {
    body: {
      device: "wf1",
      subagentHistoryResults: [
        { sessionId: "s1", type: "workflow", label: "code-review", agentId: "",
          entries: [], truncated: false, agentsTruncated: false,
          agents: [{ id: "a0123", label: "review:bugs", status: "done" }] },
        { sessionId: "s1", type: "workflow", label: "code-review", agentId: "a0123",
          entries: [{ id: "1", role: "user", text: "review it" }], truncated: false },
      ],
    },
    headers: agentHeaders,
  });

  const gotList = await request("GET", list, { headers: userHeaders });
  assert.equal(gotList.status, 200);
  // Every row is normalized to the full shape on the way in, so a client that
  // TYPES the field never meets a missing one.
  assert.deepEqual(gotList.body.agents,
    [{ id: "a0123", label: "review:bugs", startedAt: "", status: "done" }]);
  assert.equal(gotList.body.agentsTruncated, false);

  const gotOne = await request("GET", one, { headers: userHeaders });
  assert.equal(gotOne.status, 200);
  assert.deepEqual(gotOne.body.entries, [{ id: "1", role: "user", text: "review it" }]);
  assert.equal(gotOne.body.agents, undefined,
    "an ordinary transcript must not carry `agents` — its presence is what means `this is a run`");
});

test("XERK-304: a malformed agentId is refused, never queued", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "wf2" }, headers: agentHeaders });
  const base = "/api/agents/wf2/sessions/s1/subagents/history?type=workflow&label=x&agentId=";
  for (const bad of ["../../etc/passwd", "a/b", "a".repeat(65), "a b"]) {
    const res = await request("GET", base + encodeURIComponent(bad), { headers: userHeaders });
    assert.equal(res.status, 400, `agentId ${bad} should be refused`);
    assert.ok(res.body.error);
  }
  const beat = await request("POST", "/api/heartbeat", { body: { device: "wf2" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands, [], "a refused id must not reach the agent's queue");
});

test("XERK-304: a wrong-shaped agents list is coerced, never served raw", async () => {
  // Android TYPES this field, so an unexpected shape reaching a decoder is a
  // thrown response, not a cosmetic problem. Same rule as every other typed
  // heartbeat field: coerce at ingest.
  await request("POST", "/api/heartbeat", { body: { device: "wf3" }, headers: agentHeaders });
  const url = "/api/agents/wf3/sessions/s1/subagents/history?type=workflow&label=x";

  await request("POST", "/api/heartbeat", {
    body: {
      device: "wf3",
      subagentHistoryResults: [{
        sessionId: "s1", type: "workflow", label: "x", agentId: "",
        entries: [], truncated: false, agentsTruncated: "yes",
        agents: [
          { id: { nested: 1 }, label: ["a"], status: 7, startedAt: null },
          "not an object",
          { label: "no id at all" },
          { id: "ok1", label: "fine", startedAt: "t", status: "done" },
        ],
      }],
    },
    headers: agentHeaders,
  });

  const got = await request("GET", url, { headers: userHeaders });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.agents, [
    { id: "[object Object]", label: "a", startedAt: "", status: "7" },
    { id: "ok1", label: "fine", startedAt: "t", status: "done" },
  ], "non-objects and id-less rows dropped; every surviving value a string");
  assert.equal(got.body.agentsTruncated, true, "coerced to a boolean");
});

test("XERK-304: a row with no status keeps its omission through the hub", async () => {
  // The agent OMITS status when the run's journal cannot say. An absent field
  // meaning "that agent can't tell" is the fleet-wide rule, so coercing every
  // row to a full shape would put it back as "" and lose the distinction the
  // agent went to trouble to preserve.
  await request("POST", "/api/heartbeat", { body: { device: "wf5" }, headers: agentHeaders });
  const url = "/api/agents/wf5/sessions/s1/subagents/history?type=workflow&label=x";
  await request("POST", "/api/heartbeat", {
    body: {
      device: "wf5",
      subagentHistoryResults: [{
        sessionId: "s1", type: "workflow", label: "x", agentId: "",
        entries: [], truncated: false,
        agents: [{ id: "a1", label: "no journal here", startedAt: "t" },
                 { id: "a2", label: "knows", startedAt: "t", status: "done" }],
      }],
    },
    headers: agentHeaders,
  });
  const got = await request("GET", url, { headers: userHeaders });
  assert.equal(got.status, 200);
  assert.ok(!("status" in got.body.agents[0]), "omission survives, never blanked to ''");
  assert.equal(got.body.agents[1].status, "done");
});

test("XERK-304: a whitespace-only status omits rather than splitting the clients", async () => {
  // Web tests truthiness and would paint an empty chip; Android tests isNotBlank
  // and would hide it. A value that says nothing must not reach either.
  await request("POST", "/api/heartbeat", { body: { device: "wf6" }, headers: agentHeaders });
  const url = "/api/agents/wf6/sessions/s1/subagents/history?type=workflow&label=x";
  await request("POST", "/api/heartbeat", {
    body: {
      device: "wf6",
      subagentHistoryResults: [{
        sessionId: "s1", type: "workflow", label: "x", agentId: "",
        entries: [], agents: [{ id: "a1", label: "x", status: "   " }],
      }],
    },
    headers: agentHeaders,
  });
  const got = await request("GET", url, { headers: userHeaders });
  assert.ok(!("status" in got.body.agents[0]));
});

test("XERK-304: field values are capped, so one row cannot bloat the record", () => {
  const a = { subagentHistory: { k: { agents: [
    { id: "i".repeat(5000), label: "l".repeat(5000), status: "s".repeat(5000),
      startedAt: "t".repeat(5000) },
  ] } } };
  hub.normalizeRecord(a);
  const row = a.subagentHistory.k.agents[0];
  for (const f of ["id", "label", "status", "startedAt"]) {
    assert.equal(row[f].length, 256, `${f} must be capped`);
  }
});

test("XERK-304: a state.json restore re-coerces the cached workflow rows", () => {
  // The cache is PERSISTED, so a restart serves whatever was on disk — and the
  // restore is the first thing a freshly-shipped coercion has to cover. Without
  // this the typed Android decode meets `status: 99` straight off the volume.
  const a = {
    device: "h",
    subagentHistory: {
      k1: { agents: [
        { id: "a1", label: { deep: "object" }, startedAt: 12345, status: 99 },
        "not-an-object",
      ], agentsTruncated: "yes" },
      k2: { entries: [{ id: "1", role: "user", text: "hi" }] },  // a transcript
      k3: { agents: "lots" },
    },
  };
  hub.normalizeRecord(a);
  // Every value becomes a string — `status: 99` is the one that throws Android's
  // typed decode — and the bare string element is dropped for having no id.
  assert.deepEqual(a.subagentHistory.k1.agents,
    [{ id: "a1", label: "[object Object]", startedAt: "12345", status: "99" }]);
  assert.equal(a.subagentHistory.k1.agentsTruncated, true);
  assert.ok(!("agents" in a.subagentHistory.k2),
    "a plain transcript must not grow an agents key on restore");
  assert.equal(a.subagentHistory.k3.agents, null, "junk becomes 'not a run'");
});

test("XERK-304: a non-array `agents` leaves the reply a plain transcript", async () => {
  // `agents` present is what means "this is a run", so a junk value must not be
  // able to turn an ordinary transcript into a list.
  await request("POST", "/api/heartbeat", { body: { device: "wf4" }, headers: agentHeaders });
  const url = "/api/agents/wf4/sessions/s1/subagents/history?type=workflow&label=x";
  await request("POST", "/api/heartbeat", {
    body: {
      device: "wf4",
      subagentHistoryResults: [{
        sessionId: "s1", type: "workflow", label: "x", agentId: "",
        entries: [{ id: "1", role: "user", text: "hi" }], truncated: false,
        agents: "lots",
      }],
    },
    headers: agentHeaders,
  });
  const got = await request("GET", url, { headers: userHeaders });
  assert.equal(got.status, 200);
  assert.equal(got.body.agents, undefined);
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
  // `ticketSource` is the hub's own note of what kind of work this was (XERK-303)
  // and is stripped before the reply — the next test asserts that.
  assert.deepEqual(agents.ts1.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
      ticketSite: "t1.atlassian.net", cmdId: res.body.cmdId },
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

test("XERK-331: the start single-flight spans the org, not one host", async () => {
  // The D3 double-start: a spawn is committed to hostA, but the second click's
  // routing picks hostB (hostA now scores lower for the in-flight spawn). A
  // per-host guard sees nothing on hostB and mints a SECOND spawn — one ticket,
  // two sessions. The guard must find hostA's in-flight spawn and reuse it.
  await ticketBeat("sf331A", "sf331.atlassian.net");
  await ticketBeat("sf331B", "sf331.atlassian.net");
  agents.sf331A.capacity = { maxSessions: 6, running: 0, queued: 0, free: 6 };
  agents.sf331B.capacity = { maxSessions: 6, running: 0, queued: 0, free: 6 };
  // First: a tie, insertion order gives hostA.
  const first = await request("POST", "/api/jira/sf331.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(first.body.host, "sf331A");
  // Second, before any beat delivers the spawn: hostA's in-flight command drops
  // its availability below hostB's, so routing now prefers hostB.
  const second = await request("POST", "/api/jira/sf331.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(second.body.cmdId, first.body.cmdId);
  assert.equal(second.body.host, "sf331A");
  // The reuse landed nothing new anywhere: one command total, on hostA.
  assert.equal((agents.sf331A.commands || []).length, 1);
  assert.equal((agents.sf331B.commands || []).length, 0);
});

test("XERK-331: a DELIVERED spawn on an offline host still blocks a second start", async () => {
  // Delivered means the agent may already be mid-spawn, so a second session must
  // not be started even though its host has since gone offline — the session is
  // coming when the host returns (delivery is at-least-once).
  await ticketBeat("sf331d", "sf331d.atlassian.net");
  const first = await request("POST", "/api/jira/sf331d.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  agents.sf331d.commands[0].deliveredAt = Date.now();
  agents.sf331d.lastSeen = Date.now() - 10 * 60 * 1000;
  const second = await request("POST", "/api/jira/sf331d.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(second.status, 200);
  assert.equal(second.body.cmdId, first.body.cmdId);
  assert.equal(second.body.host, "sf331d");
  assert.equal((agents.sf331d.commands || []).length, 1);
});

test("XERK-331: an UNDELIVERED spawn on an offline host does NOT block a fresh start", async () => {
  // The complement of reclaimStrandedTicketSpawns: an undelivered command on a
  // dead host is safe to disregard (reclaim withdraws it), so a Start goes
  // through to a live host rather than being blocked forever.
  await ticketBeat("sf331oA", "sf331o.atlassian.net");
  await ticketBeat("sf331oB", "sf331o.atlassian.net");
  const first = await request("POST", "/api/jira/sf331o.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  // Strand the first spawn on its (now offline) host, undelivered.
  const strandedHost = first.body.host;
  const otherHost = strandedHost === "sf331oA" ? "sf331oB" : "sf331oA";
  agents[strandedHost].lastSeen = Date.now() - 10 * 60 * 1000;
  assert.ok(!("deliveredAt" in agents[strandedHost].commands[0]));
  // A fresh click routes to the live sibling and mints a NEW spawn there.
  const second = await request("POST", "/api/jira/sf331o.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(second.status, 200);
  assert.equal(second.body.host, otherHost);
  assert.notEqual(second.body.cmdId, first.body.cmdId);
  assert.equal((agents[otherHost].commands || []).length, 1);
});

test("XERK-331: the start guard is org-scoped — a colliding key in another org is not reused", async () => {
  // Two different Jira orgs both have an ENG-5. A spawn in flight for org A's
  // ENG-5 must not make org B's ENG-5 reuse it (issue keys are unique only within
  // an org). Guards the `a.jira.siteKey !== siteKey` filter in committedTicketSpawn.
  await ticketBeat("sf331xA", "sf331xa.atlassian.net");
  await ticketBeat("sf331xB", "sf331xb.atlassian.net");
  const a = await request("POST", "/api/jira/sf331xa.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  const b = await request("POST", "/api/jira/sf331xb.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(a.body.host, "sf331xA");
  assert.equal(b.body.host, "sf331xB");
  // Distinct spawns, one per org — not a reuse across the org boundary.
  assert.notEqual(b.body.cmdId, a.body.cmdId);
  assert.equal((agents.sf331xA.commands || []).length, 1);
  assert.equal((agents.sf331xB.commands || []).length, 1);
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
    { type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
      ticketSite: "t5.atlassian.net", cmdId: res.body.cmdId },
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
    { type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
      ticketSite: "tmSpawn.atlassian.net", model: "opus", cmdId: res.body.cmdId },
  ]);
});

test("http: an unpinned ticket spawns with no model on the command (unchanged)", async () => {
  await ticketBeat("tmNone", "tmNone.atlassian.net");
  const res = await request("POST", "/api/jira/tmNone.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.deepEqual(agents.tmNone.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
      ticketSite: "tmNone.atlassian.net", cmdId: res.body.cmdId },
  ]);
});

// POST /api/jira/<siteKey>/<issueKey>/runtime — the operator's per-ticket
// runtime pin (XERK-473). Hub-owned durable like the /model pin; the runtime
// rides the spawnTicket command as `agentType`, and the dispatch routes a dsh
// ticket only to a host that offers dsh.

const setRuntime = (site, key, body) =>
  request("POST", `/api/jira/${site}/${key}/runtime`, { body, headers: userHeaders });

// A ticket host that ALSO offers the dsh runtime.
const dshTicketBeat = (device, site, { key = "ENG-5", repo = "Turma" } = {}) =>
  request("POST", "/api/heartbeat", {
    body: {
      device,
      repos: [{ name: repo, path: `/git/${repo}` }],
      dsh: { available: true },
      jira: {
        available: true, configured: true, siteKey: site, user: `${device}@x.com`,
        fetchedAt: "2026-07-14T12:00:00Z",
        tickets: [{ key, summary: "Fix it", repoGuess: { repo, cloned: true } }],
      },
    },
    headers: agentHeaders,
  });

test("http: pinning a ticket to dsh needs an org host offering it; claude releases", async () => {
  hub.__setDshEnabled(true);
  await jiraBeat("trNo", "trNo.atlassian.net");
  // No host of this org offers dsh, so a dsh pin is refused (nothing could run it).
  assert.equal((await setRuntime("trNo.atlassian.net", "ENG-1", { runtime: "dsh" })).status, 400);
  assert.ok(!("trNo.atlassian.net/ENG-1" in hub.ticketRuntimes));

  // A host that offers dsh makes the pin acceptable.
  await dshTicketBeat("trYes", "trYes.atlassian.net");
  const ok = await setRuntime("trYes.atlassian.net", "ENG-5", { runtime: "dsh" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.runtime, "dsh");
  assert.equal(hub.ticketRuntimes["trYes.atlassian.net/ENG-5"].runtime, "dsh");

  // "claude" (the default) releases the pin — nothing to store.
  const rel = await setRuntime("trYes.atlassian.net", "ENG-5", { runtime: "claude" });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.runtime, "claude");
  assert.ok(!("trYes.atlassian.net/ENG-5" in hub.ticketRuntimes));

  // Bad runtime and an org nobody reports.
  assert.equal((await setRuntime("trYes.atlassian.net", "ENG-5", { runtime: "gpt" })).status, 400);
  assert.equal((await setRuntime("nobody.atlassian.net", "ENG-1", { runtime: "dsh" })).status, 404);
});

test("http: the runtime pin rides the /api/agents payload + requires the user login", async () => {
  hub.__setDshEnabled(true);
  await dshTicketBeat("trPay", "trPay.atlassian.net");
  await setRuntime("trPay.atlassian.net", "ENG-5", { runtime: "dsh" });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(res.body.ticketRuntimes["trPay.atlassian.net/ENG-5"].runtime, "dsh");
  // No user login → refused, pin untouched.
  const anon = await request("POST", "/api/jira/trPay.atlassian.net/ENG-6/runtime",
    { body: { runtime: "dsh" } });
  assert.equal(anon.status, 401);
});

test("http: a dsh-pinned ticket carries agentType on its spawnTicket command", async () => {
  hub.__setDshEnabled(true);
  await dshTicketBeat("trSpawn", "trSpawn.atlassian.net");
  await setRuntime("trSpawn.atlassian.net", "ENG-5", { runtime: "dsh" });
  const res = await request("POST", "/api/jira/trSpawn.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(agents.trSpawn.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
      ticketSite: "trSpawn.atlassian.net", agentType: "dsh", cmdId: res.body.cmdId },
  ]);
});

test("findTicketHost routes a dsh ticket only to a host that offers dsh", async () => {
  hub.__setDshEnabled(true);
  // A dsh pin plus one org host that does NOT offer dsh: blocked, not full — a
  // freed slot would not give it the runtime.
  await ticketBeat("trPlain", "trRoute.atlassian.net", { key: "ENG-9" });
  hub.setTicketRuntime("trRoute.atlassian.net", "ENG-9", "dsh");
  const blocked = hub.findTicketHost("trRoute.atlassian.net", "Turma", "ENG-9",
    { requireFree: true });
  assert.equal(blocked.host, undefined);
  assert.ok(!blocked.full);                     // blocked, ages out — not a capacity wait
  assert.match(blocked.error, /dsh runtime/);

  // A dsh-capable host in the same org is chosen.
  await dshTicketBeat("trCap", "trRoute.atlassian.net", { key: "ENG-9" });
  const ok = hub.findTicketHost("trRoute.atlassian.net", "Turma", "ENG-9",
    { requireFree: true });
  assert.equal(ok.host, "trCap");
  hub.setTicketRuntime("trRoute.atlassian.net", "ENG-9", null);   // cleanup
});

// ---- XERK-515 [Qwen I]: a ticket can be pinned to the qwen runtime ----------

// A ticket host that ALSO offers the qwen runtime — the qwen twin of dshTicketBeat.
const qwenTicketBeat = (device, site, { key = "ENG-5", repo = "Turma" } = {}) =>
  request("POST", "/api/heartbeat", {
    body: {
      device,
      repos: [{ name: repo, path: `/git/${repo}` }],
      qwen: { available: true },
      jira: {
        available: true, configured: true, siteKey: site, user: `${device}@x.com`,
        fetchedAt: "2026-07-14T12:00:00Z",
        tickets: [{ key, summary: "Fix it", repoGuess: { repo, cloned: true } }],
      },
    },
    headers: agentHeaders,
  });

test("http: pinning a ticket to qwen needs an org host offering it; claude releases", async () => {
  hub.__setQwenEnabled(true);
  await jiraBeat("trqNo", "trqNo.atlassian.net");
  // No host of this org offers qwen, so a qwen pin is refused (nothing could run it).
  const refused = await setRuntime("trqNo.atlassian.net", "ENG-1", { runtime: "qwen" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /qwen runtime/);
  assert.ok(!("trqNo.atlassian.net/ENG-1" in hub.ticketRuntimes));

  // A host that offers qwen makes the pin acceptable.
  await qwenTicketBeat("trqYes", "trqYes.atlassian.net");
  const ok = await setRuntime("trqYes.atlassian.net", "ENG-5", { runtime: "qwen" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.runtime, "qwen");
  assert.equal(hub.ticketRuntimes["trqYes.atlassian.net/ENG-5"].runtime, "qwen");

  // "claude" releases the pin — nothing to store.
  const rel = await setRuntime("trqYes.atlassian.net", "ENG-5", { runtime: "claude" });
  assert.equal(rel.status, 200);
  assert.ok(!("trqYes.atlassian.net/ENG-5" in hub.ticketRuntimes));
});

test("http: a qwen-pinned ticket carries agentType:qwen on its spawnTicket command", async () => {
  hub.__setQwenEnabled(true);
  await qwenTicketBeat("trqSpawn", "trqSpawn.atlassian.net");
  await setRuntime("trqSpawn.atlassian.net", "ENG-5", { runtime: "qwen" });
  const res = await request("POST", "/api/jira/trqSpawn.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(agents.trqSpawn.commands, [
    { type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
      ticketSite: "trqSpawn.atlassian.net", agentType: "qwen", cmdId: res.body.cmdId },
  ]);
});

test("findTicketHost routes a qwen ticket only to a host that offers qwen", async () => {
  hub.__setQwenEnabled(true);
  // A qwen pin plus one org host that does NOT offer qwen: blocked, not full — a
  // freed slot would not add the runtime.
  await ticketBeat("trqPlain", "trqRoute.atlassian.net", { key: "ENG-9" });
  hub.setTicketRuntime("trqRoute.atlassian.net", "ENG-9", "qwen");
  const blocked = hub.findTicketHost("trqRoute.atlassian.net", "Turma", "ENG-9",
    { requireFree: true });
  assert.equal(blocked.host, undefined);
  assert.ok(!blocked.full);
  assert.match(blocked.error, /qwen runtime/);

  // A qwen-capable host in the same org is chosen.
  await qwenTicketBeat("trqCap", "trqRoute.atlassian.net", { key: "ENG-9" });
  const ok = hub.findTicketHost("trqRoute.atlassian.net", "Turma", "ENG-9",
    { requireFree: true });
  assert.equal(ok.host, "trqCap");
  hub.setTicketRuntime("trqRoute.atlassian.net", "ENG-9", null);   // cleanup
});

// ---- XERK-544: pause auto-start past the weekly subscription pace line -------

// A ticket host that reports a 7-day subscription window, so its pace can be
// judged. The window is opened `7 - resetsInDays` days ago, so with the default
// (resets in 6) the pace fraction is ~1/7 (~14%): usedPct 80 is well PAST pace,
// usedPct 3 well under it. Carries a triage block so the auto sweep enqueues it.
const NOW = () => Math.floor(Date.now() / 1000);
const paceBeat = (device, site, {
  usedPct = 0, key = "ENG-5", repo = "Turma", sub = null, defaultRuntime = null,
  capturedAgeSec = 0, resetsInDays = 6, qwen = false, free = 5,
  // XERK-548: the 5-hour window. Defaults are well UNDER the 90% cap with a
  // window still open, so a 7-day-only test is never accidentally 5h-paused.
  fiveHourPct = 0, fiveHourResetsInSec = 3 * 3600,
} = {}) => request("POST", "/api/heartbeat", {
  body: {
    device,
    repos: [{ name: repo, path: `/git/${repo}` }],
    capacity: { maxSessions: 6, running: 6 - free, queued: 0, free },
    ...(qwen ? { qwen: { available: true } } : {}),
    ...(defaultRuntime ? { defaultRuntime } : {}),
    ...(sub ? { subscription: { key: sub } } : {}),
    limits: {
      capturedAt: NOW() - capturedAgeSec,
      sevenDay: { usedPct, resetsAt: NOW() + resetsInDays * 86400 },
      fiveHour: { usedPct: fiveHourPct, resetsAt: NOW() + fiveHourResetsInSec },
    },
    jira: {
      available: true, configured: true, siteKey: site, user: `${device}@x.com`,
      fetchedAt: "2026-07-14T12:00:00Z",
      tickets: [{ key, summary: "Fix it", statusCategory: "todo",
                  repoGuess: { repo, cloned: true },
                  triage: { priority: "P2", type: "task", actionable: true } }],
    },
  },
  headers: agentHeaders,
});

test("XERK-544: limitsPastPace compares usedPct against the elapsed fraction", () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const snap = (usedPct, resetsInDays, ageSec = 0) => ({
    capturedAt: nowSec - ageSec,
    sevenDay: { usedPct, resetsAt: nowSec + resetsInDays * 86400 },
  });
  // Window opened 1 day ago → pace ≈ 14%.
  assert.equal(hub.limitsPastPace(snap(80, 6), now), true);   // 80% ≫ 14%
  assert.equal(hub.limitsPastPace(snap(3, 6), now), false);   // 3% < 14%
  // EXACTLY at pace counts as past ("at or past"): reset in 3.5 days ⇒ elapsed
  // is exactly half the window ⇒ pace 0.5, and usedPct 50 == 0.5.
  const half = { capturedAt: nowSec, sevenDay: { usedPct: 50, resetsAt: nowSec + 302400 } };
  assert.ok(Math.abs(hub.sevenDayPaceFrac(half.sevenDay, nowSec) - 0.5) < 1e-9);
  assert.equal(hub.limitsPastPace(half, now), true);
  // A stale snapshot is "can't tell" — never a pause, even at 99%.
  assert.equal(hub.limitsPastPace(snap(99, 6, 25 * 3600), now), false);
  // An expired window (already reset) can't be paced → not past.
  assert.equal(hub.limitsPastPace(
    { capturedAt: nowSec, sevenDay: { usedPct: 99, resetsAt: nowSec - 3600 } }, now), false);
  // No window / no snapshot → not past.
  assert.equal(hub.limitsPastPace({ capturedAt: nowSec }, now), false);
  assert.equal(hub.limitsPastPace(null, now), false);
});

test("XERK-544: pausedSubscriptions groups by subscription, freshest reading wins", async () => {
  const now = Date.now();
  // Two hosts on ONE account 'ppAcctA'; the FRESHEST reading decides.
  await paceBeat("ppA1", "pp1.atlassian.net", { usedPct: 3, sub: "ppAcctA", capturedAgeSec: 0 });     // fresh, under
  await paceBeat("ppA2", "pp1.atlassian.net", { usedPct: 90, sub: "ppAcctA", capturedAgeSec: 3600 }); // older, over
  assert.equal(hub.pausedSubscriptions(now).has("ppAcctA"), false);
  // The freshest reading flips over-pace when a newer over-pace read lands.
  await paceBeat("ppA1", "pp1.atlassian.net", { usedPct: 90, sub: "ppAcctA", capturedAgeSec: 0 });
  assert.equal(hub.pausedSubscriptions(now).has("ppAcctA"), true);
  // A host with no subscription block paces against itself under "host:<key>".
  await paceBeat("ppC1", "pp3.atlassian.net", { usedPct: 80, capturedAgeSec: 0 });
  assert.equal(hub.pausedSubscriptions(now).has("host:ppC1"), true);
});

test("XERK-544: findTicketHost pauses an AUTO ticket on a claude host past pace, never a manual one", async () => {
  await paceBeat("fpPaused", "fp1.atlassian.net", { usedPct: 80, sub: "fpSub" });
  // AUTO: paused → BLOCKED (not full — a freed slot would not un-pause it).
  const autoBlocked = hub.findTicketHost("fp1.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true });
  assert.equal(autoBlocked.host, undefined);
  assert.ok(!autoBlocked.full);
  assert.match(autoBlocked.error, /usage limit/);
  // MANUAL (no auto flag): always allowed.
  const manual = hub.findTicketHost("fp1.atlassian.net", "Turma", "ENG-5", { requireFree: true });
  assert.equal(manual.host, "fpPaused");
  // A claude host UNDER pace is not paused for auto either.
  await paceBeat("fpUnder", "fp1u.atlassian.net", { usedPct: 3, sub: "fpUnderSub" });
  const okUnder = hub.findTicketHost("fp1u.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true });
  assert.equal(okUnder.host, "fpUnder");
});

test("XERK-544: a qwen-default host and a qwen-pinned ticket are never pace-paused", async () => {
  hub.__setQwenEnabled(true);
  // A qwen-DEFAULT host past pace still takes an auto ticket — it spends no Claude pool.
  await paceBeat("fpQwen", "fp2.atlassian.net",
    { usedPct: 90, sub: "fpQwenSub", defaultRuntime: "qwen" });
  const okQwenDefault = hub.findTicketHost("fp2.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true });
  assert.equal(okQwenDefault.host, "fpQwen");
  // A claude-DEFAULT host past pace, but the ticket is qwen-PINNED → not paused
  // (the host must OFFER qwen for the pin to route there).
  await paceBeat("fpClaudeQ", "fp3.atlassian.net",
    { usedPct: 90, sub: "fpCQSub", key: "ENG-7", qwen: true });
  hub.setTicketRuntime("fp3.atlassian.net", "ENG-7", "qwen");
  const okQwenPin = hub.findTicketHost("fp3.atlassian.net", "Turma", "ENG-7",
    { requireFree: true, auto: true });
  assert.equal(okQwenPin.host, "fpClaudeQ");
  hub.setTicketRuntime("fp3.atlassian.net", "ENG-7", null);   // cleanup
});

test("XERK-544: /api/agents flags a paused claude host, not a qwen-default or under-pace one", async () => {
  hub.__setQwenEnabled(true);
  await paceBeat("apPaused", "ap1.atlassian.net", { usedPct: 85, sub: "apSub1" });
  await paceBeat("apQwen", "ap2.atlassian.net",
    { usedPct: 85, sub: "apSub2", defaultRuntime: "qwen" });
  await paceBeat("apUnder", "ap3.atlassian.net", { usedPct: 3, sub: "apSub3" });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const byKey = Object.fromEntries(res.body.agents.map((a) => [a.key, a]));
  assert.equal(byKey.apPaused.autoPaused, true);
  assert.ok(!("autoPaused" in byKey.apQwen), "a qwen-default host is never paused");
  assert.ok(!("autoPaused" in byKey.apUnder), "an under-pace host is not paused");
});

test("XERK-544: a heartbeat cannot forge its own autoPaused flag", async () => {
  // A host UNDER pace that asserts autoPaused:true — the hub strips the forged
  // field and recomputes it (false), so it never rides the payload.
  await request("POST", "/api/heartbeat", { body: {
    device: "apForge", autoPaused: true,
    capacity: { maxSessions: 6, running: 1, queued: 0, free: 5 },
    limits: { capturedAt: NOW(), sevenDay: { usedPct: 2, resetsAt: NOW() + 6 * 86400 } },
    jira: { available: true, configured: true, siteKey: "apf.atlassian.net",
            user: "apForge@x.com", fetchedAt: "2026-07-14T12:00:00Z", tickets: [] },
  }, headers: agentHeaders });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const a = res.body.agents.find((x) => x.key === "apForge");
  assert.ok(!("autoPaused" in a), "a forged autoPaused is stripped, not served");
});

test("XERK-544: auto-start holds a ticket whose only claude host is past pace; manual still starts", async () => {
  resetAutoStart();
  await paceBeat("dpPaced", "dp1.atlassian.net", { usedPct: 85, sub: "dpSub" });
  setAutoStartOrg("dp1.atlassian.net", true);
  autoStartRound();
  // The sweep queued it (it decides WHICH), but the drain found the only host
  // paused, so nothing was handed over and the entry HOLDS as blocked.
  assert.equal((agents.dpPaced.commands || []).length, 0);
  const q = queuedTicket("dp1.atlassian.net", "ENG-5");
  assert.equal(q.reason, "blocked");
  assert.match(q.error, /usage limit/);
  // A MANUAL start on the same ticket is never paused — it dispatches at once.
  const r = await startTicket("dp1.atlassian.net", "ENG-5");
  assert.equal(r.status, 200);
  assert.equal(r.body.host, "dpPaced");
  setAutoStartOrg("dp1.atlassian.net", false);   // leave global state clean
});

// ---- XERK-548: also pause at 90% of the 5-hour window, resume on its reset ----

test("XERK-548: limitsFiveHourMaxed pauses at/above 90% and clears when the window resets", () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const snap = (usedPct, resetsInSec, ageSec = 0) => ({
    capturedAt: nowSec - ageSec,
    fiveHour: { usedPct, resetsAt: nowSec + resetsInSec },
  });
  assert.equal(hub.limitsFiveHourMaxed(snap(90, 3600), now), true);    // exactly 90% (at-or-past)
  assert.equal(hub.limitsFiveHourMaxed(snap(95, 3600), now), true);
  assert.equal(hub.limitsFiveHourMaxed(snap(89, 3600), now), false);   // under the cap
  // The window has already reset (resetsAt passed) → resumed, even at 99%.
  assert.equal(hub.limitsFiveHourMaxed(snap(99, -60), now), false);
  // Stale snapshot is "can't tell" — never a pause, even at 99%.
  assert.equal(hub.limitsFiveHourMaxed(snap(99, 3600, 25 * 3600), now), false);
  // Absent window / missing resetsAt → not maxed.
  assert.equal(hub.limitsFiveHourMaxed({ capturedAt: nowSec }, now), false);
  assert.equal(hub.limitsFiveHourMaxed(
    { capturedAt: nowSec, fiveHour: { usedPct: 99 } }, now), false);
  // The combined predicate fires on EITHER trigger and neither.
  const paced = { capturedAt: nowSec, sevenDay: { usedPct: 99, resetsAt: nowSec + 6 * 86400 } };
  const maxed = { capturedAt: nowSec, fiveHour: { usedPct: 92, resetsAt: nowSec + 3600 } };
  const fine  = { capturedAt: nowSec, sevenDay: { usedPct: 1, resetsAt: nowSec + 6 * 86400 },
                  fiveHour: { usedPct: 1, resetsAt: nowSec + 3600 } };
  assert.equal(hub.subscriptionLimitsPaused(paced, now), true);
  assert.equal(hub.subscriptionLimitsPaused(maxed, now), true);
  assert.equal(hub.subscriptionLimitsPaused(fine, now), false);
});

test("XERK-548: a 5-hour-maxed claude host pauses auto-start and flags autoPaused, qwen exempt", async () => {
  hub.__setQwenEnabled(true);
  // 7-day well under pace, but the 5-hour window at 95% → paused.
  await paceBeat("fhPaused", "fh1.atlassian.net", { usedPct: 2, sub: "fhSub", fiveHourPct: 95 });
  const blocked = hub.findTicketHost("fh1.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true });
  assert.equal(blocked.host, undefined);
  assert.ok(!blocked.full);                       // blocked, self-clearing — not full
  assert.match(blocked.error, /usage limit/);
  // Manual is never paused.
  assert.equal(hub.findTicketHost("fh1.atlassian.net", "Turma", "ENG-5",
    { requireFree: true }).host, "fhPaused");
  // A qwen-default host at 95% of its 5-hour window is not paused (spends no Claude pool).
  await paceBeat("fhQwen", "fh2.atlassian.net",
    { usedPct: 2, sub: "fhQwenSub", fiveHourPct: 95, defaultRuntime: "qwen" });
  assert.equal(hub.findTicketHost("fh2.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true }).host, "fhQwen");
  // The served flag reflects the 5-hour pause on /api/agents.
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const byKey = Object.fromEntries(res.body.agents.map((a) => [a.key, a]));
  assert.equal(byKey.fhPaused.autoPaused, true);
  assert.ok(!("autoPaused" in byKey.fhQwen));
});

test("XERK-548: auto-start RESUMES the moment the 5-hour window resets", async () => {
  // Host at 95% with the 5-hour window still open → paused.
  await paceBeat("frHost", "fr1.atlassian.net", { usedPct: 2, sub: "frSub", fiveHourPct: 95 });
  assert.equal(hub.findTicketHost("fr1.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true }).host, undefined);
  // Re-beat with the SAME high used-% but a window that has already rolled over
  // (resetsAt in the past): the pause clears without waiting for a fresh reading.
  await paceBeat("frHost", "fr1.atlassian.net",
    { usedPct: 2, sub: "frSub", fiveHourPct: 95, fiveHourResetsInSec: -60 });
  assert.equal(hub.findTicketHost("fr1.atlassian.net", "Turma", "ENG-5",
    { requireFree: true, auto: true }).host, "frHost");
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
  autoStart = true, repos = ["Turma"], capacity, user,
  sessions = [], closedSessions = [],
  tickets = [{ key: "ENG-5", summary: "Fix it", statusCategory: "todo",
               repoGuess: { repo: "Turma", cloned: true },
               triage: { priority: "P2", type: "task", actionable: true } }],
  fetchedAt = "2026-07-14T12:00:00Z",
  ticketPriorityResults,
  ticketLinkResults,
  jiraSource,
  ackedCommands,
} = {}) => {
  const r = await request("POST", "/api/heartbeat", {
    body: {
      device,
      repos: repos.map((name) => ({ name, path: `/git/${name}` })),
      sessions, closedSessions,
      ...(capacity ? { capacity } : {}),
      jira: { available: true, configured: true, siteKey: site,
              user: user || `${device}@x.com`, fetchedAt, tickets,
              ...(jiraSource ? { source: jiraSource } : {}) },
      ...(ticketPriorityResults ? { ticketPriorityResults } : {}),
      ...(ticketLinkResults ? { ticketLinkResults } : {}),
      ...(ackedCommands ? { ackedCommands } : {}),
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
  autoStartRate.clear();
  ticketQueue.length = 0;
  for (const k of Object.keys(autoStartOrgs)) delete autoStartOrgs[k];
};

// XERK-296 split the sweep in two: it decides WHICH tickets should run and puts
// them in the HUB's queue, and drainTicketQueue chooses the host and hands the
// spawn over at the moment one can actually take it. A sweep on its own
// therefore queues nothing onto a host, so every case below that asserts on a
// host's commands runs both halves — which is exactly what the 15s interval
// does. The queue's own behaviour (waiting, re-routing, cancelling) is covered
// by the XERK-296 block further down.
const autoStartRound = () => { autoStartSweep(); drainTicketQueue(); };

test("auto-start: a To Do ticket with a repo is queued once the org opts in", async () => {
  resetAutoStart();
  await asBeat("asHost", "as1.atlassian.net");
  autoStartRound();
  assert.deepEqual((agents.asHost.commands || []).map((c) => [c.type, c.issueKey]),
    [["spawnTicket", "ENG-5"]]);
});

test("auto-start: does nothing until the org is opted in (off by default)", async () => {
  resetAutoStart();
  await asBeat("asOff", "as2.atlassian.net", { autoStart: false });
  autoStartRound();
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
        repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P2", type: "task", actionable: true } }, // eligible
    ],
  });
  autoStartRound();
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
  autoStartRound();
  assert.equal((agents.asDup.commands || []).length, 0);

  // Same for a ticket whose only session was killed (in closedSessions): a
  // deliberate kill must not be resurrected by auto-start.
  autoStarted.clear();
  await asBeat("asDup2", "as5.atlassian.net", {
    closedSessions: [{ id: "s2", transcriptId: "t-killed",
                       ticket: { key: "ENG-5", siteKey: "as5.atlassian.net" } }],
  });
  autoStartRound();
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
  autoStartRound();
  assert.equal((agents.asResume.commands || []).length, 0);
});

// XERK-61: a spawnTicket the agent acked but that produced no session is a
// FAILED attempt, not a completed one — the agent acks a refusal and a mid-spawn
// exception exactly like a success. So the sweep retries it, bounded and backed
// off, instead of dropping the ticket for the hub's lifetime.
test("auto-start: an acked spawn that left no session is retried, not dropped", async () => {
  resetAutoStart();
  await asBeat("asRetry", "as7.atlassian.net");
  autoStartRound();
  assert.equal((agents.asRetry.commands || []).length, 1);

  // The agent took the command and produced nothing (a refusal, or a Jira fetch
  // that blew up). Immediately after, the backoff holds the retry off.
  agents.asRetry.commands = [];
  autoStartRound();
  assert.equal((agents.asRetry.commands || []).length, 0,
    "the retry waits out its backoff rather than re-queuing every 15s");

  // Once the backoff has elapsed, the ticket is tried again.
  autoStarted.get("as7.atlassian.net\x00ENG-5").nextAt = 0;
  autoStartRound();
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
    autoStartRound();
    assert.deepEqual((agents.asBudget.commands || []).map((c) => c.issueKey),
      ["ENG-5"], "the ticket is retried on every eligible sweep, never abandoned");
  }
  assert.equal(autoStarted.get(k).attempts, 5,
    "the counter settles at the backoff ceiling (AUTO_START_BACKOFF_STEPS)");
  // The steady-state retry is spaced by the max backoff, so a still-stuck ticket
  // re-queues at most once per ceiling interval rather than every sweep.
  agents.asBudget.commands = [];
  autoStartRound();  // nextAt is now ~10min out, so this sweep must NOT re-queue
  assert.equal((agents.asBudget.commands || []).length, 0,
    "within the ceiling backoff the retry holds off");
});

test("auto-start: a session appearing ends the retries and forgets the attempts", async () => {
  resetAutoStart();
  await asBeat("asWon", "as7c.atlassian.net");
  autoStartRound();
  const k = "as7c.atlassian.net\x00ENG-5";
  assert.equal(autoStarted.get(k).attempts, 1);
  // The spawn worked: the session (queued or running) reports its ticket back.
  agents.asWon.commands = [];
  agents.asWon.sessions = [{ id: "s1", status: "queued", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "as7c.atlassian.net" } }];
  autoStartRound();
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
    autoStartRound();
  }
  assert.ok((agents.asHeal.commands || []).some((c) => c.issueKey === "ENG-5"),
    "still retrying after the old budget would have blacklisted it");
  // Now the transient condition clears and the spawn finally takes: the session
  // reports its ticket, and auto-start settles for good.
  agents.asHeal.commands = [];
  agents.asHeal.sessions = [{ id: "s1", status: "running", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "as7e.atlassian.net" } }];
  autoStartRound();
  assert.equal((agents.asHeal.commands || []).length, 0);
  assert.ok(!autoStarted.has(k), "the attempt record is dropped once it starts");
});

test("auto-start: an offline org spends no attempt (the failure isn't the ticket's)", async () => {
  resetAutoStart();
  await asBeat("asDown", "as7d.atlassian.net");
  agents.asDown.lastSeen = Date.now() - 10 * 60 * 1000;  // offline
  autoStartRound();
  assert.equal((agents.asDown.commands || []).length, 0);
  assert.ok(!autoStarted.has("as7d.atlassian.net\x00ENG-5"));
  // The host returns: the ticket starts on the very next sweep, with its full
  // budget intact rather than sitting out a backoff it never earned.
  agents.asDown.lastSeen = Date.now();
  autoStartRound();
  assert.deepEqual((agents.asDown.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("auto-start: an in-flight spawnTicket (e.g. a manual click) is not doubled", async () => {
  resetAutoStart();
  await asBeat("asInflight", "as8.atlassian.net");
  // A spawnTicket already queued by the /session route sits on the host.
  queueCommand("asInflight", { type: "spawnTicket", issueKey: "ENG-5" });
  autoStartRound();
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
  autoStartRound();
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
  autoStartRound();
  assert.deepEqual((agents.asPinBusy.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal((agents.asPinFree.commands || []).length, 0);
});

test("auto-start: a pinned agent that's offline retries later, never reroutes", async () => {
  resetAutoStart();
  await asBeat("asPinOffA", "asPinOff.atlassian.net");
  await asBeat("asPinOffB", "asPinOff.atlassian.net");
  await setAgent("asPinOff.atlassian.net", "ENG-5", { host: "asPinOffB" });
  agents.asPinOffB.lastSeen = Date.now() - 10 * 60 * 1000;
  autoStartRound();
  // Not rerouted around the pin, and left UNrecorded so a later sweep retries.
  assert.equal((agents.asPinOffA.commands || []).length, 0);
  assert.equal((agents.asPinOffB.commands || []).length, 0);
  assert.ok(!autoStarted.has("asPinOff.atlassian.net\x00ENG-5"));
  // The pinned host comes back — the next sweep spawns there.
  agents.asPinOffB.lastSeen = Date.now();
  autoStartRound();
  assert.deepEqual((agents.asPinOffB.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("auto-start: an org with every host offline queues nothing until one returns", async () => {
  resetAutoStart();
  await asBeat("asStale", "as10.atlassian.net");        // opts the org in
  agents.asStale.lastSeen = Date.now() - 10 * 60 * 1000; // offline
  // The opt-in is durable hub state, so the org stays "on"...
  assert.equal(orgsWithAutoStart().has("as10.atlassian.net"), true);
  // ...but with no online host to route to, the sweep queues nothing.
  autoStartRound();
  assert.equal((agents.asStale.commands || []).length, 0);
  // The host returns — the next sweep spawns there.
  agents.asStale.lastSeen = Date.now();
  autoStartRound();
  assert.deepEqual((agents.asStale.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

// ---- per-org auto-start opt-in from the hub (XERK-41) -------------------------

test("auto-start: the hub-side org toggle is the ONLY opt-in", async () => {
  resetAutoStart();
  // A reporting host is not enough — the org is off until the hub toggle is set.
  await asBeat("asHub", "ashub.atlassian.net", { autoStart: false });
  assert.equal(orgsWithAutoStart().has("ashub.atlassian.net"), false);
  autoStartRound();
  assert.equal((agents.asHub.commands || []).length, 0);
  // The toggle drives the sweep.
  setAutoStartOrg("ashub.atlassian.net", true);
  assert.equal(orgsWithAutoStart().has("ashub.atlassian.net"), true);
  autoStartRound();
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

// ---- triage priority write-back (XERK-483) -----------------------------------
// Hub-side half of the third tracker write: a per-org opt-in toggle plus a
// sweep that queues setTicketPriority commands where the triage band disagrees
// with the tracker's own priority field. The AGENT makes the conservative
// decision (a human-set value is never overwritten); the sweep only decides
// WHEN to ask, and suppresses re-queueing from the agent's own staged results.

// A triaged ticket the sweep can act on: band P1 (-> "High" on Jira), still at
// the tracker default "Medium".
const pwTicket = (o = {}) => ({
  key: "ENG-5", summary: "Fix it", statusCategory: "todo",
  triage: { priority: "P1", type: "bug", value: "high",
            at: "2026-08-30T00:00:00Z", source: "model" },
  priority: "Medium",
  ...o,
});
const resetPriorityWriteBack = () => {
  priorityWriteBackSkips.clear();
  for (const k of Object.keys(priorityWriteBackOrgs)) delete priorityWriteBackOrgs[k];
};

test("POST /api/jira/<site>/priority-writeback flips the opt-in and rides the payload", async () => {
  resetPriorityWriteBack();
  await asBeat("pwApi", "pwapi.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/pwapi.atlassian.net/priority-writeback",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, enabled: true });
  assert.equal(priorityWriteBackOrgs["pwapi.atlassian.net"], true);
  assert.equal(orgsWithPriorityWriteBack().has("pwapi.atlassian.net"), true);
  // Rides the fleet payload like autoStartOrgs.
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.priorityWriteBackOrgs["pwapi.atlassian.net"], true);
  // Disable it — the key is removed (presence = enabled).
  r = await request("POST", "/api/jira/pwapi.atlassian.net/priority-writeback",
    { body: { enabled: false }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal("pwapi.atlassian.net" in priorityWriteBackOrgs, false);
});

test("POST /api/jira/<site>/priority-writeback rejects a bad body and an unknown org", async () => {
  resetPriorityWriteBack();
  await asBeat("pwApi2", "pwapi2.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/pwapi2.atlassian.net/priority-writeback",
    { body: {}, headers: userHeaders });
  assert.equal(r.status, 400);
  r = await request("POST", "/api/jira/pwapi2.atlassian.net/priority-writeback",
    { body: { enabled: "yes" }, headers: userHeaders });
  assert.equal(r.status, 400);
  // An org no host reports can't be toggled (no phantom entries).
  r = await request("POST", "/api/jira/nobody.atlassian.net/priority-writeback",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody.atlassian.net" in priorityWriteBackOrgs, false);
});

test("priority-writeback: sweep queues setTicketPriority only for opted-in orgs with a mismatch", async () => {
  resetPriorityWriteBack();
  await asBeat("pwOff", "pwoff.atlassian.net", {
    autoStart: false, tickets: [pwTicket()],
  });
  // Off by default: nothing is queued even though the value mismatches.
  priorityWriteBackSweep();
  assert.equal((agents.pwOff.commands || []).filter((c) => c.type === "setTicketPriority").length, 0);
  // Opt in: the P1 band wants "High", the tracker shows the default "Medium".
  setPriorityWriteBackOrg("pwoff.atlassian.net", true);
  priorityWriteBackSweep();
  let cmds = (agents.pwOff.commands || []).filter((c) => c.type === "setTicketPriority");
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].issueKey, "ENG-5");
  assert.equal(cmds[0].priority, "P1");
  // The command is still riding the host's queue: no double-queue.
  priorityWriteBackSweep();
  cmds = (agents.pwOff.commands || []).filter((c) => c.type === "setTicketPriority");
  assert.equal(cmds.length, 1);
  resetPriorityWriteBack();
});

test("priority-writeback: no queue when the tracker already matches the band", async () => {
  resetPriorityWriteBack();
  setPriorityWriteBackOrg("pwmatch.atlassian.net", true);
  await asBeat("pwMatch", "pwmatch.atlassian.net", {
    autoStart: false, tickets: [pwTicket({ priority: "High" })], // P1 band, already "High"
  });
  priorityWriteBackSweep();
  assert.equal((agents.pwMatch.commands || []).filter((c) => c.type === "setTicketPriority").length, 0);
  resetPriorityWriteBack();
});

test("priority-writeback: untriaged tickets are never queued", async () => {
  resetPriorityWriteBack();
  setPriorityWriteBackOrg("pwnotri.atlassian.net", true);
  await asBeat("pwNoTri", "pwnotri.atlassian.net", {
    autoStart: false,
    tickets: [{ key: "ENG-7", summary: "No triage yet", statusCategory: "todo", priority: "Low" }],
  });
  priorityWriteBackSweep();
  assert.equal((agents.pwNoTri.commands || []).filter((c) => c.type === "setTicketPriority").length, 0);
  resetPriorityWriteBack();
});

test("priority-writeback: a 'skipped' result suppresses re-queueing while the human's value holds", async () => {
  resetPriorityWriteBack();
  setPriorityWriteBackOrg("pwsup.atlassian.net", true);
  // Human set "Low"; the band wants "High". The agent already answered that it
  // left the human's value alone, and the answer rides this beat.
  await asBeat("pwSup", "pwsup.atlassian.net", {
    autoStart: false,
    tickets: [pwTicket({ priority: "Low" })],
    ticketPriorityResults: [{
      cmdId: "pw-c1", key: "ENG-5", siteKey: "pwsup.atlassian.net",
      band: "P1", ok: true, action: "skipped", priority: "Low",
    }],
  });
  priorityWriteBackSweep();
  assert.equal((agents.pwSup.commands || []).filter((c) => c.type === "setTicketPriority").length, 0);
  // The human resets the ticket back to the default: the sweep re-arms and
  // queues again, so the field gets filled in.
  await asBeat("pwSup", "pwsup.atlassian.net", {
    autoStart: false, tickets: [pwTicket({ priority: "Medium" })],
  });
  priorityWriteBackSweep();
  assert.equal((agents.pwSup.commands || []).filter((c) => c.type === "setTicketPriority").length, 1);
  resetPriorityWriteBack();
});

test("priority-writeback: an error result suppresses re-queueing regardless of value", async () => {
  resetPriorityWriteBack();
  setPriorityWriteBackOrg("pwerr.atlassian.net", true);
  await asBeat("pwErr", "pwerr.atlassian.net", {
    autoStart: false,
    tickets: [pwTicket()],
    ticketPriorityResults: [{
      cmdId: "pw-c2", key: "ENG-5", siteKey: "pwerr.atlassian.net",
      band: "P1", ok: false, error: "HTTP Error 403: Forbidden", priority: null,
    }],
  });
  priorityWriteBackSweep();
  assert.equal((agents.pwErr.commands || []).filter((c) => c.type === "setTicketPriority").length, 0);
  resetPriorityWriteBack();
});

test("priority-writeback: keys over 50 chars suppress via the agent's truncated key", async () => {
  resetPriorityWriteBack();
  setPriorityWriteBackOrg("pwlong.atlassian.net", true);
  // Legal Jira key longer than the agent's 50-char staged-key bound (the same
  // k[:50] record-size convention every staged result uses). The agent stages
  // its result keyed by the truncated value; the sweep must look suppression
  // up with the same truncated key or this ticket re-queues every 15s forever.
  const LK = "A".repeat(49) + "-12345"; // 55 chars
  const longTicket = () => ({ key: LK, summary: "long key", statusCategory: "todo",
    triage: { priority: "P1", type: "bug", value: "high",
              at: "2026-08-30T00:00:00Z", source: "model" },
    priority: "Low", repoGuess: { repo: "Turma", cloned: true } });
  await asBeat("pwLong", "pwlong.atlassian.net", { autoStart: false, tickets: [longTicket()] });
  priorityWriteBackSweep();
  let cmds = (agents.pwLong.commands || []).filter((c) => c.type === "setTicketPriority");
  assert.equal(cmds.length, 1);
  const cmdId = cmds[0].cmdId;
  // What the REAL agent stages: key truncated to 50, error result.
  await asBeat("pwLong", "pwlong.atlassian.net", {
    autoStart: false,
    tickets: [longTicket()],
    ackedCommands: [cmdId],
    ticketPriorityResults: [{
      cmdId, key: LK.slice(0, 50), siteKey: "pwlong.atlassian.net",
      band: "P1", ok: false, error: "HTTP Error 404: Not Found", priority: null,
    }],
  });
  priorityWriteBackSweep();
  cmds = (agents.pwLong.commands || []).filter((c) => c.type === "setTicketPriority");
  assert.equal(cmds.length, 0); // suppressed, not re-queued
  // The suppression entry is keyed on the truncated form, not the full key.
  assert.equal(priorityWriteBackSkips.has("pwlong.atlassian.net" + "\x00" + LK.slice(0, 50) + "\x00" + "P1"), true);
  assert.equal(priorityWriteBackSkips.has("pwlong.atlassian.net" + "\x00" + LK + "\x00" + "P1"), false);
  resetPriorityWriteBack();
});

// ---- duplicate linking (XERK-484) ------------------------------------------
// Hub-side half of the fourth tracker write: a per-org opt-in toggle plus a
// sweep that queues createDuplicateLink commands for tickets the classifier
// flagged with triage.dedupeOf. The AGENT is the idempotency authority (live
// GET-links read; its ledger makes a human's removal sticky); the sweep only
// decides WHEN to ask, and suppresses re-queueing from the agent's own staged
// results: an ok outcome is sticky, an error is suppressed for the retry window.

const dlTicket = (o = {}) => ({
  key: "ENG-9", summary: "Fix it", statusCategory: "todo",
  triage: { priority: "P1", type: "bug", value: "high",
            at: "2026-08-30T00:00:00Z", source: "model",
            dedupeOf: "ENG-8" },
  ...o,
});
const resetDedupeLink = () => {
  dedupeLinkSkips.clear();
  for (const k of Object.keys(dedupeLinkOrgs)) delete dedupeLinkOrgs[k];
};
const dlCmds = (host) =>
  (agents[host].commands || []).filter((c) => c.type === "createDuplicateLink");

test("POST /api/jira/<site>/dedupe-link flips the opt-in and rides the payload", async () => {
  resetDedupeLink();
  await asBeat("dlApi", "dlapi.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/dlapi.atlassian.net/dedupe-link",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, enabled: true });
  assert.equal(dedupeLinkOrgs["dlapi.atlassian.net"], true);
  assert.equal(orgsWithDedupeLink().has("dlapi.atlassian.net"), true);
  // Rides the fleet payload like priorityWriteBackOrgs.
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.dedupeLinkOrgs["dlapi.atlassian.net"], true);
  // Disable it — the key is removed (presence = enabled).
  r = await request("POST", "/api/jira/dlapi.atlassian.net/dedupe-link",
    { body: { enabled: false }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal("dlapi.atlassian.net" in dedupeLinkOrgs, false);
});

test("POST /api/jira/<site>/dedupe-link rejects a bad body and an unknown org", async () => {
  resetDedupeLink();
  await asBeat("dlApi2", "dlapi2.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/dlapi2.atlassian.net/dedupe-link",
    { body: {}, headers: userHeaders });
  assert.equal(r.status, 400);
  r = await request("POST", "/api/jira/dlapi2.atlassian.net/dedupe-link",
    { body: { enabled: "yes" }, headers: userHeaders });
  assert.equal(r.status, 400);
  // An org no host reports can't be toggled (no phantom entries).
  r = await request("POST", "/api/jira/nobody.atlassian.net/dedupe-link",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody.atlassian.net" in dedupeLinkOrgs, false);
});

test("dedupe-link: sweep queues createDuplicateLink only for opted-in orgs with a dedupeOf", async () => {
  resetDedupeLink();
  await asBeat("dlOff", "dloff.atlassian.net", {
    autoStart: false, tickets: [dlTicket()],
  });
  // Off by default: nothing is queued even though the ticket carries a dedupeOf.
  dedupeLinkSweep();
  assert.equal(dlCmds("dlOff").length, 0);
  // Opt in: the sweep queues one command carrying both keys.
  setDedupeLinkOrg("dloff.atlassian.net", true);
  dedupeLinkSweep();
  let cmds = dlCmds("dlOff");
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].issueKey, "ENG-9");
  assert.equal(cmds[0].twinKey, "ENG-8");
  // The command is still riding the host's queue: no double-queue.
  dedupeLinkSweep();
  assert.equal(dlCmds("dlOff").length, 1);
  resetDedupeLink();
});

test("dedupe-link: untriaged tickets and self-flags are never queued", async () => {
  resetDedupeLink();
  setDedupeLinkOrg("dlnotri.atlassian.net", true);
  await asBeat("dlNoTri", "dlnotri.atlassian.net", {
    autoStart: false,
    tickets: [
      { key: "ENG-7", summary: "No triage yet", statusCategory: "todo" }, // no triage
      { key: "ENG-6", summary: "self", statusCategory: "todo",
        triage: { priority: "P2", dedupeOf: "ENG-6" } },                // self-flag
    ],
  });
  dedupeLinkSweep();
  assert.equal(dlCmds("dlNoTri").length, 0);
  resetDedupeLink();
});

test("dedupe-link: a Jira org with no Jira host is never queued", async () => {
  resetDedupeLink();
  setDedupeLinkOrg("dlnohost.atlassian.net", true);
  // The org is opted in but no host beats for it, so pickBoardWriteHost
  // returns null and the sweep queues nothing.
  dedupeLinkSweep();
  assert.equal(dedupeLinkSkips.size, 0);
  resetDedupeLink();
});

test("dedupe-link: an Azure org is skipped even when opted in", async () => {
  resetDedupeLink();
  setDedupeLinkOrg("dlado.atlassian.net", true);
  await asBeat("dlAzo", "dlado.atlassian.net", {
    autoStart: false, tickets: [dlTicket()], jiraSource: "azure",
  });
  dedupeLinkSweep();
  assert.equal(dlCmds("dlAzo").length, 0);
  resetDedupeLink();
});

test("dedupe-link: an ok result suppresses the pair sticky (no relink storm)", async () => {
  resetDedupeLink();
  setDedupeLinkOrg("dlsup.atlassian.net", true);
  await asBeat("dlSup", "dlsup.atlassian.net", { autoStart: false, tickets: [dlTicket()] });
  dedupeLinkSweep();
  const cmdId = dlCmds("dlSup")[0].cmdId;
  // The agent acks the command and reports a successful link.
  await asBeat("dlSup", "dlsup.atlassian.net", {
    autoStart: false,
    tickets: [dlTicket()],
    ackedCommands: [cmdId],
    ticketLinkResults: [{
      cmdId, key: "ENG-9", twinKey: "ENG-8", siteKey: "dlsup.atlassian.net",
      ok: true, error: null, action: "linked",
    }],
  });
  // The acked command left the queue; the sticky suppression stops the re-queue.
  assert.equal(dlCmds("dlSup").length, 0);
  dedupeLinkSweep();
  assert.equal(dlCmds("dlSup").length, 0);
  const entry = dedupeLinkSkips.get("dlsup.atlassian.net" + "\x00" + "ENG-9" + "\x00" + "ENG-8");
  assert.ok(entry && entry.sticky === true, "ok outcome is sticky");
  resetDedupeLink();
});

test("dedupe-link: an error result suppresses re-queueing for the retry window", async () => {
  resetDedupeLink();
  setDedupeLinkOrg("dlerr.atlassian.net", true);
  await asBeat("dlErr", "dlerr.atlassian.net", { autoStart: false, tickets: [dlTicket()] });
  dedupeLinkSweep();
  const cmdId = dlCmds("dlErr")[0].cmdId;
  await asBeat("dlErr", "dlerr.atlassian.net", {
    autoStart: false,
    tickets: [dlTicket()],
    ackedCommands: [cmdId],
    ticketLinkResults: [{
      cmdId, key: "ENG-9", twinKey: "ENG-8", siteKey: "dlerr.atlassian.net",
      ok: false, error: "HTTP Error 403: Forbidden", action: null,
    }],
  });
  dedupeLinkSweep();
  assert.equal(dlCmds("dlErr").length, 0);
  const entry = dedupeLinkSkips.get("dlerr.atlassian.net" + "\x00" + "ENG-9" + "\x00" + "ENG-8");
  assert.ok(entry && entry.sticky === false, "error outcome is non-sticky (retryable)");
  resetDedupeLink();
});

test("dedupe-link: keys over 50 chars suppress via the agent's truncated key", async () => {
  resetDedupeLink();
  setDedupeLinkOrg("dllong.atlassian.net", true);
  // Legal key longer than the agent's 50-char staged-key bound. The agent
  // stages its result keyed by the truncated value; the sweep must look
  // suppression up with the same truncated key or this pair re-queues every
  // 15s forever (the XERK-483 lesson).
  const LK = "A".repeat(49) + "-12345"; // 55 chars
  const longTicket = { key: LK, summary: "long key", statusCategory: "todo",
    triage: { priority: "P2", at: "2026-08-30T00:00:00Z", source: "model",
              dedupeOf: "ENG-8" } };
  await asBeat("dlLong", "dllong.atlassian.net", { autoStart: false, tickets: [longTicket] });
  dedupeLinkSweep();
  const cmds = dlCmds("dlLong");
  assert.equal(cmds.length, 1);
  const cmdId = cmds[0].cmdId;
  // What the REAL agent stages: key truncated to 50, ok result.
  await asBeat("dlLong", "dllong.atlassian.net", {
    autoStart: false,
    tickets: [longTicket],
    ackedCommands: [cmdId],
    ticketLinkResults: [{
      cmdId, key: LK.slice(0, 50), twinKey: "ENG-8", siteKey: "dllong.atlassian.net",
      ok: true, error: null, action: "linked",
    }],
  });
  dedupeLinkSweep();
  assert.equal(dlCmds("dlLong").length, 0); // suppressed, not re-queued
  // The suppression entry is keyed on the truncated form, not the full key.
  assert.equal(dedupeLinkSkips.has("dllong.atlassian.net" + "\x00" + LK.slice(0, 50) + "\x00" + "ENG-8"), true);
  assert.equal(dedupeLinkSkips.has("dllong.atlassian.net" + "\x00" + LK + "\x00" + "ENG-8"), false);
  resetDedupeLink();
});

// ---- the hub-side ticket queue (XERK-296) -----------------------------------
// Work waiting for a slot is a QUEUED TICKET on the hub, with no host chosen and
// no session created. The host is picked at DISPATCH, so whichever agent frees a
// slot first takes the oldest waiting ticket.

// A full host: capacity reported with no free slot.
const FULL = { maxSessions: 2, running: 2, queued: 0, free: 0 };
const ROOMY = { maxSessions: 2, running: 0, queued: 0, free: 2 };

const startTicket = (site, key) =>
  request("POST", `/api/jira/${site}/${key}/session`, { headers: userHeaders });

test("XERK-296: a full org queues the TICKET — no host chosen, no session created", async () => {
  resetAutoStart();
  await asBeat("tqFullA", "tq1.atlassian.net", { autoStart: false, capacity: FULL });
  await asBeat("tqFullB", "tq1.atlassian.net", { autoStart: false, capacity: FULL });
  const r = await startTicket("tq1.atlassian.net", "ENG-5");
  assert.equal(r.status, 200);
  assert.equal(r.body.queued, true);
  assert.equal(r.body.position, 1);
  assert.ok(!r.body.cmdId, "nothing was handed to a host, so there is no cmdId");
  assert.ok(!r.body.host, "no host is claimed while a ticket waits");
  assert.equal((agents.tqFullA.commands || []).length, 0);
  assert.equal((agents.tqFullB.commands || []).length, 0);
  // Draining changes nothing while every host is still full.
  drainTicketQueue();
  assert.equal((agents.tqFullA.commands || []).length, 0);
  assert.equal(queuedTicket("tq1.atlassian.net", "ENG-5").reason, "capacity");
  // It rides the fleet payload, which is the only place a waiting ticket exists.
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  const q = (list.body.ticketQueue || []).find((x) => x.issueKey === "ENG-5");
  assert.deepEqual([q.siteKey, q.source, q.position], ["tq1.atlassian.net", "manual", 1]);
});

test("XERK-296: the host is chosen at DISPATCH — whichever agent frees up takes it", async () => {
  // The complaint this ticket opens with: the old flow nailed the ticket to one
  // host the moment it was queued, so a slot freeing on ANY other host couldn't
  // take it. Here the ticket is queued while both are full, and the SECOND host
  // — the one availability would not have picked at enqueue time — frees first.
  resetAutoStart();
  await asBeat("tqRaceA", "tq2.atlassian.net", { autoStart: false, capacity: FULL });
  await asBeat("tqRaceB", "tq2.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq2.atlassian.net", "ENG-5");
  drainTicketQueue();
  assert.equal((agents.tqRaceA.commands || []).length, 0);
  assert.equal((agents.tqRaceB.commands || []).length, 0);
  // B finishes a session.
  agents.tqRaceB.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqRaceB.commands || []).map((c) => [c.type, c.issueKey]),
    [["spawnTicket", "ENG-5"]]);
  assert.equal((agents.tqRaceA.commands || []).length, 0, "A never got it");
  assert.equal(queuedTicket("tq2.atlassian.net", "ENG-5"), null,
    "dispatched, so it leaves the queue");
});

test("XERK-296: a host with a free slot is used straight away (nothing queues needlessly)", async () => {
  resetAutoStart();
  await asBeat("tqOpen", "tq3.atlassian.net", { autoStart: false, capacity: ROOMY });
  const r = await startTicket("tq3.atlassian.net", "ENG-5");
  assert.equal(r.body.queued, undefined);
  assert.equal(r.body.host, "tqOpen");
  assert.deepEqual((agents.tqOpen.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(ticketQueue.length, 0);
});

test("XERK-296: one dispatch per host per pass (the shared login is what limits it)", async () => {
  resetAutoStart();
  await asBeat("tqOne", "tq4.atlassian.net", { autoStart: false, capacity: FULL,
    tickets: [
      { key: "ENG-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true } },
      { key: "ENG-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true } },
    ] });
  await startTicket("tq4.atlassian.net", "ENG-1");
  await startTicket("tq4.atlassian.net", "ENG-2");
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["ENG-1", "ENG-2"]);
  agents.tqOne.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqOne.commands || []).map((c) => c.issueKey), ["ENG-1"],
    "the oldest goes first, and only one per pass");
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["ENG-2"]);
  // The next pass takes the next one (its predecessor's spawn has been acked).
  agents.tqOne.commands = [];
  drainTicketQueue();
  assert.deepEqual((agents.tqOne.commands || []).map((c) => c.issueKey), ["ENG-2"]);
});

test("XERK-296: an agent that reports no capacity is 'can't tell', never 'full'", async () => {
  // The heartbeat contract: an absent capability degrades, it doesn't block. Such
  // a host still takes the spawn and queues it itself, exactly as before.
  resetAutoStart();
  await asBeat("tqOld", "tq5.atlassian.net", { autoStart: false });   // no capacity block
  assert.equal(hostHasFreeSlot(agents.tqOld), true);
  const r = await startTicket("tq5.atlassian.net", "ENG-5");
  assert.equal(r.body.host, "tqOld");
  assert.equal(ticketQueue.length, 0);
});

test("XERK-296: a hard failure still refuses — only capacity queues", async () => {
  resetAutoStart();
  await asBeat("tqDown", "tq6.atlassian.net", { autoStart: false, capacity: FULL });
  agents.tqDown.lastSeen = Date.now() - 10 * 60 * 1000;             // offline
  const r = await startTicket("tq6.atlassian.net", "ENG-5");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /offline/);
  assert.equal(ticketQueue.length, 0, "queuing can't fix an offline org");
});

test("XERK-296: a pinned agent that's full is waited for, not routed around", async () => {
  resetAutoStart();
  await asBeat("tqPinFull", "tq7.atlassian.net", { autoStart: false, capacity: FULL });
  await asBeat("tqPinFree", "tq7.atlassian.net", { autoStart: false, capacity: ROOMY });
  await setAgent("tq7.atlassian.net", "ENG-5", { host: "tqPinFull" });
  const r = await startTicket("tq7.atlassian.net", "ENG-5");
  assert.equal(r.body.queued, true);
  drainTicketQueue();
  assert.equal((agents.tqPinFree.commands || []).length, 0, "the pin is not worked around");
  agents.tqPinFull.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqPinFull.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-296: turning Auto off clears that org's auto-queued tickets and nothing else", async () => {
  resetAutoStart();
  await asBeat("tqAuto", "tq8.atlassian.net", { capacity: FULL, tickets: [
    { key: "ENG-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } },
    { key: "ENG-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } },
  ] });
  await asBeat("tqOther", "tq9.atlassian.net", { capacity: FULL });
  // A live session on the same host, to prove nothing here touches one.
  agents.tqAuto.sessions = [{ id: "live1", status: "running", transcriptId: "t-live" }];
  autoStartSweep();
  drainTicketQueue();                       // both orgs full: everything waits
  // One of tq8's tickets is ALSO clicked by hand, which upgrades its entry.
  await startTicket("tq8.atlassian.net", "ENG-2");
  assert.deepEqual(ticketQueue.map((e) => [e.siteKey, e.issueKey, e.source]), [
    ["tq8.atlassian.net", "ENG-1", "auto"],
    ["tq8.atlassian.net", "ENG-2", "manual"],
    ["tq9.atlassian.net", "ENG-5", "auto"],
  ]);
  setAutoStartOrg("tq8.atlassian.net", false);
  assert.deepEqual(ticketQueue.map((e) => [e.siteKey, e.issueKey]), [
    ["tq8.atlassian.net", "ENG-2"],         // an operator asked for this one
    ["tq9.atlassian.net", "ENG-5"],         // a different org is untouched
  ]);
  assert.deepEqual(agents.tqAuto.sessions.map((s) => s.status), ["running"],
    "no session was killed, interrupted or otherwise touched");
  assert.equal((agents.tqAuto.commands || []).length, 0, "and no command was sent");
});

test("XERK-296: DELETE takes a waiting ticket out of the queue", async () => {
  resetAutoStart();
  await asBeat("tqCancel", "tq10.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq10.atlassian.net", "ENG-5");
  assert.equal(ticketQueue.length, 1);
  let r = await request("DELETE", "/api/jira/tq10.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal(ticketQueue.length, 0);
  // A second cancel says so rather than pretending: it isn't queued any more.
  r = await request("DELETE", "/api/jira/tq10.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(r.status, 404);
  // The route validates the key like its POST twin, and needs the user login.
  r = await request("DELETE", "/api/jira/tq10.atlassian.net/12ab/session",
    { headers: userHeaders });
  assert.equal(r.status, 400);
  r = await request("DELETE", "/api/jira/tq10.atlassian.net/ENG-5/session");
  assert.equal(r.status, 401);
});

test("XERK-296: an auto-queued ticket leaves the queue once the work has started", async () => {
  resetAutoStart();
  await asBeat("tqGone", "tq11.atlassian.net", { capacity: FULL });
  autoStartSweep();
  drainTicketQueue();
  assert.equal(ticketQueue.length, 1);
  // Someone started it by hand while it waited: the session is the evidence, and
  // auto-start's whole job is never to open a SECOND session for started work.
  agents.tqGone.sessions = [{ id: "s1", status: "running", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "tq11.atlassian.net" } }];
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0);
});

test("XERK-296: a MANUAL entry is not dropped for an existing session (the + is a second session)", async () => {
  resetAutoStart();
  await asBeat("tqSecond", "tq11b.atlassian.net", { autoStart: false, capacity: FULL });
  agents.tqSecond.sessions = [{ id: "s1", status: "running", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "tq11b.atlassian.net" } }];
  await startTicket("tq11b.atlassian.net", "ENG-5");
  drainTicketQueue();
  assert.equal(ticketQueue.length, 1, "the operator asked for another one");
  agents.tqSecond.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqSecond.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-296: a ticket a human moves to Done while it waits is dropped, not started", async () => {
  resetAutoStart();
  await asBeat("tqDone", "tq11c.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq11c.atlassian.net", "ENG-5");
  assert.equal(ticketQueue.length, 1);
  agents.tqDone.jira.tickets = [{ key: "ENG-5", statusCategory: "done",
    repoGuess: { repo: "Turma", cloned: true } }];
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0);
  assert.equal((agents.tqDone.commands || []).length, 0);
});

test("XERK-296: waiting in the queue spends no auto-start attempt", async () => {
  // Queuing commits nothing, so it must not burn a retry — the backoff exists
  // for a spawn an agent ACKED and left no session (XERK-61/109).
  resetAutoStart();
  await asBeat("tqAttempt", "tq12.atlassian.net", { capacity: FULL });
  const k = "tq12.atlassian.net\x00ENG-5";
  for (let i = 0; i < 3; i++) { autoStartSweep(); drainTicketQueue(); }
  assert.equal(ticketQueue.length, 1);
  assert.ok(!autoStarted.has(k), "no attempt is spent while it waits");
  agents.tqAttempt.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.equal(autoStarted.get(k).attempts, 1, "the attempt is spent at dispatch");
});

test("XERK-296: a manual entry is NOT retired by a session it didn't ask for", async () => {
  // The + button asks for a SECOND session, so the queue cannot infer "the ask
  // is satisfied" from the ticket's session count: a session appearing from
  // anywhere else (the auto sweep, another operator, another board) would eat
  // the click, and a count that DIPS — an agent mid-restart, a closedSessions
  // eviction — would eat it with no new session at all.
  resetAutoStart();
  await asBeat("tqForeign", "tq24.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq24.atlassian.net", "ENG-5");
  assert.equal(ticketQueue.length, 1);
  agents.tqForeign.sessions = [{ id: "s1", status: "running", transcriptId: "t1",
    ticket: { key: "ENG-5", siteKey: "tq24.atlassian.net" } }];
  drainTicketQueue();
  assert.equal(ticketQueue.length, 1, "someone else's session is not the one asked for");
  // It ends the way an operator's ask should: on a dispatch, their cancel, Done,
  // or — the backstop — having waited too long to still be what anyone wants,
  // which it says out loud rather than vanishing (see the give-up case above).
  queuedTicket("tq24.atlassian.net", "ENG-5").at = Date.now() - TICKET_QUEUE_MAX_WAIT_MS - 1;
  drainTicketQueue();
  assert.equal(queuedTicket("tq24.atlassian.net", "ENG-5").reason, "expired");
  assert.equal((agents.tqForeign.commands || []).length, 0, "and it starts nothing on the way out");
});

test("XERK-296: giving up is VISIBLE — the entry goes terminal, it doesn't vanish", async () => {
  // A queued click that disappeared after its hours were up read exactly like
  // someone else cancelling it: the chip went, the button came back, nothing
  // said why. Work going quietly missing is the failure this ticket is about.
  resetAutoStart();
  await asBeat("tqGiveUp", "tq29.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq29.atlassian.net", "ENG-5");
  queuedTicket("tq29.atlassian.net", "ENG-5").at = Date.now() - TICKET_QUEUE_MAX_WAIT_MS - 1;
  drainTicketQueue();
  const e = queuedTicket("tq29.atlassian.net", "ENG-5");
  assert.ok(e, "it stays on the payload as a note");
  assert.equal(e.reason, "expired");
  assert.match(e.error, /stopped waiting/);
  // A terminal entry is not IN the line: it takes no place and dispatches never.
  assert.equal(ticketQueuePayload().find((q) => q.issueKey === "ENG-5").position, 0);
  agents.tqGiveUp.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.equal((agents.tqGiveUp.commands || []).length, 0, "a note never starts a session");
  // Asking again replaces the note with a real place in line.
  agents.tqGiveUp.capacity = { ...FULL };
  await startTicket("tq29.atlassian.net", "ENG-5");
  const again = queuedTicket("tq29.atlassian.net", "ENG-5");
  assert.equal(again.expiredAt, undefined);
  assert.equal(again.reason, null);
  // And the note itself is swept once it has been on screen long enough.
  again.expiredAt = Date.now() - TICKET_QUEUE_EXPIRED_TTL_MS - 1;
  again.reason = "expired";
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0);
});

test("XERK-296: when two hosts of one org report the same ticket, the FRESHER row decides", async () => {
  // Both hosts legitimately report — this is the tie-break, and its failure mode
  // is silent: which host's row decides a queued ticket's status would otherwise
  // depend on the agents map's iteration order.
  resetAutoStart();
  const todo = [{ key: "ENG-5", statusCategory: "todo",
    repoGuess: { repo: "Turma", cloned: true } }];
  const done = [{ key: "ENG-5", statusCategory: "done",
    repoGuess: { repo: "Turma", cloned: true } }];
  // BOTH REGISTRATION ORDERS, because `Object.values(agents)` iterates in
  // insertion order: with only the stale-host-first fixture, a plain
  // last-writer-wins would produce the same answer and the rule would be
  // pinned by coincidence rather than by the compare.
  for (const [n, freshFirst] of [[0, true], [1, false]]) {
    const site = `tq30-${n}.atlassian.net`;
    const stale = { autoStart: false, capacity: FULL,
      fetchedAt: "2026-07-14T12:00:00Z", tickets: done };
    const fresh = { autoStart: false, capacity: FULL,
      fetchedAt: "2026-07-14T12:05:00Z", tickets: todo };
    if (freshFirst) {
      await asBeat(`tqFresh${n}`, site, fresh);
      await asBeat(`tqStale${n}`, site, stale);
    } else {
      await asBeat(`tqStale${n}`, site, stale);
      await asBeat(`tqFresh${n}`, site, fresh);
    }
    await startTicket(site, "ENG-5");
    drainTicketQueue();
    assert.ok(queuedTicket(site, "ENG-5"),
      `a stale Done must not retire it (fresh host registered ${freshFirst ? "first" : "last"})`);
    // Now the FRESH host reports Done too: it goes.
    await asBeat(`tqFresh${n}`, site, { ...fresh, fetchedAt: "2026-07-14T12:10:00Z",
      tickets: done });
    drainTicketQueue();
    assert.equal(queuedTicket(site, "ENG-5"), null);
  }
});

// ---- per-repo importance tiers (XERK-487) -----------------------------------
// Feeds triage ordering (a tiebreaker under [E]'s priority key) and policy
// ([F]'s allow/deny), and gates auto-start (ignore-tier repos never auto-start).
const resetRepoTiers = () => { for (const k of Object.keys(repoTiers)) delete repoTiers[k]; };

test("XERK-487: tiers are a total order, live > active(default) > archive > ignore", () => {
  resetRepoTiers();
  assert.deepEqual(REPO_TIERS, ["ignore", "archive", "active", "live"]);
  assert.equal(DEFAULT_REPO_TIER, "active");
  setRepoTier("Live", "live");
  setRepoTier("Arch", "archive");
  setRepoTier("Ign", "ignore");
  // An unset repo is the default MIDDLE tier — the "can't tell" answer, never
  // top, and it still routes (only ignore is withheld).
  assert.equal(repoTier("Unset"), "active");
  assert.equal(isRepoIgnored("Unset"), false);
  const rank = repoTierRank;
  assert.ok(rank("Live") > rank("Unset"), "live outranks the default");
  assert.ok(rank("Unset") > rank("Arch"), "the default outranks archive");
  assert.ok(rank("Arch") > rank("Ign"), "archive outranks ignore");
  assert.ok(isRepoIgnored("Ign"));
});

test("XERK-487: setRepoTier stores non-defaults and clears back to the default", () => {
  resetRepoTiers();
  setRepoTier("Hub", "live");
  assert.equal(repoTiers.Hub, "live");
  assert.equal(repoTier("Hub"), "live");
  // Setting the default is stored implicitly — the key is REMOVED, not written,
  // so the map only ever holds the repos that differ from the default.
  setRepoTier("Hub", DEFAULT_REPO_TIER);
  assert.equal("Hub" in repoTiers, false);
  assert.equal(repoTier("Hub"), "active");
});

test("XERK-487: an ignore-tier repo's tickets never enter the auto stream", async () => {
  resetAutoStart();
  resetRepoTiers();
  await asBeat("rtIgnore", "rt1.atlassian.net", { repos: ["Junk"],
    tickets: [{ key: "ENG-7", statusCategory: "todo",
      repoGuess: { repo: "Junk", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } }] });
  setRepoTier("Junk", "ignore");
  // The SWEEP alone must not even enqueue it (not just rely on the drain drop):
  // a transient enqueue would flash a ticketQueue SSE frame and churn every
  // sweep before the drain removed it. This pins the sweep gate on its own.
  autoStartSweep();
  assert.equal(ticketQueue.length, 0, "the sweep never enqueues an ignore-tier ticket");
  autoStartRound();
  assert.equal((agents.rtIgnore.commands || []).length, 0, "no session auto-started");
  assert.equal(ticketQueue.length, 0, "and nothing queued for it either");
  // Retiering it back to a routable tier lets it start again.
  setRepoTier("Junk", "active");
  autoStartRound();
  assert.deepEqual((agents.rtIgnore.commands || []).map((c) => c.issueKey), ["ENG-7"]);
});

test("XERK-487: two same-priority tickets take the auto slots in tier order", async () => {
  resetAutoStart();
  resetRepoTiers();
  // One host, no free slots, three eligible To Do tickets in three repos. All
  // three share the same triage band and type, so the tier tiebreak is what
  // decides. The board order deliberately runs LOW→HIGH, so a pass that honors
  // tier must reorder it high→low.
  const triage = { priority: "P2", type: "task", actionable: true };
  await asBeat("rtOrder", "rt2.atlassian.net", { capacity: FULL,
    repos: ["Live", "Arch", "Mystery"],
    tickets: [
      { key: "ENG-1", statusCategory: "todo", repoGuess: { repo: "Arch", cloned: true }, triage },
      { key: "ENG-2", statusCategory: "todo", repoGuess: { repo: "Mystery", cloned: true }, triage },
      { key: "ENG-3", statusCategory: "todo", repoGuess: { repo: "Live", cloned: true }, triage },
    ] });
  setRepoTier("Live", "live");
  setRepoTier("Arch", "archive");            // "Mystery" stays unset -> active
  autoStartRound();                          // host is full, so all three queue
  // live > default(active) > archive — and the unset repo still routes, in the
  // middle.
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["ENG-3", "ENG-2", "ENG-1"]);
  // So when the single slot frees, the live-tier ticket is the one dispatched.
  agents.rtOrder.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.rtOrder.commands || []).map((c) => c.issueKey), ["ENG-3"]);
});

test("XERK-487: a repo retiered to ignore while its ticket waits drops from the queue", async () => {
  resetAutoStart();
  resetRepoTiers();
  await asBeat("rtLate", "rt5.atlassian.net", { capacity: FULL, repos: ["Late"],
    tickets: [{ key: "ENG-9", statusCategory: "todo",
      repoGuess: { repo: "Late", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } }] });
  autoStartRound();                          // queues (host full, repo routable)
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["ENG-9"]);
  setRepoTier("Late", "ignore");             // operator marks it ignore mid-wait
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0, "the auto entry drops, no session");
  assert.equal((agents.rtLate.commands || []).length, 0);
});

test("XERK-487: POST /api/repos/<repo>/tier pins a tier, rides the payload, resets on auto", async () => {
  resetRepoTiers();
  await asBeat("rtApi", "rt3.atlassian.net", { autoStart: false, repos: ["Hub"] });
  let r = await request("POST", "/api/repos/Hub/tier",
    { body: { tier: "live" }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, tier: "live" });
  assert.equal(repoTiers.Hub, "live");
  // Rides the fleet payload as a top-level {repo: tier} map.
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.repoTiers.Hub, "live");
  // {auto:true} resets to the default — the key is removed (default is implicit).
  r = await request("POST", "/api/repos/Hub/tier",
    { body: { auto: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, tier: DEFAULT_REPO_TIER });
  assert.equal("Hub" in repoTiers, false);
});

test("XERK-487: the tier route rejects a bad tier and a phantom repo", async () => {
  resetRepoTiers();
  await asBeat("rtApi2", "rt4.atlassian.net", { autoStart: false, repos: ["Hub"] });
  // Not one of the four tiers.
  let r = await request("POST", "/api/repos/Hub/tier",
    { body: { tier: "urgent" }, headers: userHeaders });
  assert.equal(r.status, 400);
  // A repo no host reports (and with no existing tier) can't be pinned — no
  // phantom entries, and no unbounded key growth.
  r = await request("POST", "/api/repos/Ghost/tier",
    { body: { tier: "live" }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("Ghost" in repoTiers, false);
});

// ---- triage gate, priority-ordered drain, P0 preemption, rate limit (XERK-485) ----
// The sweep previously started every To Do ticket that had a repo, in board
// order: untriaged noise spent attempts, chores beat P0 bugs, and a 50-ticket
// backlog could fan out 50 sessions on one beat. Now the gate keeps untriaged,
// non-actionable and duplicate work out of the stream, the queue drains by
// triage band -> type weight -> repo tier -> FIFO, a P0 breaks through the
// org's auto share (the fleet cap is its only bound), and each org gets at
// most N auto starts per rolling window.

test("XERK-485: untriaged, non-actionable and duplicate tickets render but are never swept", async () => {
  // They stay on the board; they just take no attempt and no place in line.
  resetAutoStart();
  const site = "x485g.atlassian.net";
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await asBeat("gGate", site, { capacity: FULL, tickets: [
      { key: "G-1", statusCategory: "todo",
        repoGuess: { repo: "Turma", cloned: true } },
      { key: "G-2", statusCategory: "todo",
        repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P1", type: "bug", actionable: false } },
      { key: "G-3", statusCategory: "todo",
        repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P1", type: "bug", actionable: true, dedupeOf: "G-9" } },
      { key: "G-4", statusCategory: "todo",
        repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P2", type: "task", actionable: true } },
    ] });
    autoStartSweep();
  } finally {
    console.log = real;
  }
  assert.deepEqual(ticketQueue.map((e) => [e.siteKey, e.issueKey]), [[site, "G-4"]],
    "only the triaged, actionable, non-duplicate ticket enters the line");
  assert.equal(autoStarted.size, 0, "a gated ticket spends no attempt");
  assert.ok(lines.some((l) => l.includes("G-1") && l.includes("untriaged")));
  assert.ok(lines.some((l) => l.includes("G-2") && l.includes("not actionable")));
  assert.ok(lines.some((l) => l.includes("G-3") && l.includes("duplicate")));
  // The gate, unit-level: strict `actionable === true`, dedupeOf wins over it.
  assert.equal(triageGateReason({}), "untriaged");
  assert.equal(triageGateReason({ triage: [] }), "untriaged");
  assert.equal(triageGateReason({ triage: { actionable: false } }), "not actionable");
  assert.equal(triageGateReason({ triage: { actionable: true, dedupeOf: "G-9" } }), "duplicate");
  assert.equal(triageGateReason({ triage: { priority: "P0", actionable: true } }), null);
  ticketQueue.length = 0;
});

test("XERK-485: the auto stream orders by triage band, type, repo tier — then FIFO", async () => {
  resetAutoStart();
  resetRepoTiers();
  const site = "x485o.atlassian.net";
  // Board order deliberately runs LOW -> HIGH priority: a sweep that honoured
  // board order would queue chores ahead of the P0, exactly as before.
  const tri = (o) => Object.assign({ priority: "P2", type: "task", actionable: true }, o);
  await asBeat("oOrder", site, { capacity: FULL, repos: ["Turma", "Live", "Arch"],
    tickets: [
      { key: "O-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: tri({ priority: "P3", type: "chore" }) },
      { key: "O-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: tri({ priority: "P1", type: "feature" }) },
      { key: "O-5", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: tri({ priority: "P1", type: "bug" }) },
      { key: "O-7", statusCategory: "todo", repoGuess: { repo: "Live", cloned: true },
        triage: tri({}) },
      { key: "O-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: tri({}) },
      { key: "O-6", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: tri({}) },
      { key: "O-8", statusCategory: "todo", repoGuess: { repo: "Arch", cloned: true },
        triage: tri({}) },
      { key: "O-4", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: tri({ priority: "P0", type: "bug" }) },
    ] });
  setRepoTier("Live", "live");
  setRepoTier("Arch", "archive");           // "Turma" stays default (active)
  autoStartSweep();
  // band -> type -> tier -> FIFO: the P0 leads; in P1 the bug beats the
  // feature; in P2 the live-tier ticket leads, O-2 precedes its identical-key
  // twin O-6 only because the board listed it first, and the archive-tier
  // ticket trails.
  assert.deepEqual(ticketQueue.map((e) => e.issueKey),
    ["O-4", "O-5", "O-3", "O-7", "O-2", "O-6", "O-8", "O-1"]);
  // So when the single slot frees, the P0 bug is the one that goes out.
  agents.oOrder.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.oOrder.commands || []).map((c) => c.issueKey), ["O-4"]);
  resetRepoTiers();
});

test("XERK-485: a P0 breaks through the org's auto share, bounded only by the fleet cap", async () => {
  resetAutoStart();
  const site = "x485p.atlassian.net";
  const fill = [];
  for (let i = 0; i < TICKET_QUEUE_PER_ORG_AUTO_MAX; i++) {
    fill.push({ key: `F-${i}`, statusCategory: "todo",
      repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } });
  }
  await asBeat("pPreempt", site, { capacity: FULL, tickets: fill });
  autoStartSweep();
  assert.equal(ticketQueue.filter((e) => e.source === "auto").length,
    TICKET_QUEUE_PER_ORG_AUTO_MAX, "the sweep takes its share and no more");
  // The P0 lands in the same org's To Do afterwards.
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await asBeat("pPreempt", site, { autoStart: false, capacity: FULL,
      tickets: [...fill,
        { key: "P0-1", statusCategory: "todo",
          repoGuess: { repo: "Turma", cloned: true },
          triage: { priority: "P0", type: "bug", actionable: true } }] });
    autoStartSweep();
  } finally {
    console.log = real;
  }
  assert.equal(ticketQueue.filter((e) => e.source === "auto").length,
    TICKET_QUEUE_PER_ORG_AUTO_MAX + 1, "the P0 queues past the org's auto share");
  assert.ok(queuedTicket(site, "P0-1"), "the P0 is in the line");
  assert.ok(lines.some((l) => l.includes('"P0-1" (P0) is preempting')),
    "the preemption is logged");
  // And it goes out before all 20 of its P2 siblings when a slot frees.
  agents.pPreempt.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.pPreempt.commands || []).map((c) => c.issueKey), ["P0-1"]);
  // The fleet cap is the only bound left: at TICKET_QUEUE_MAX live entries a
  // P0 is refused just like anything else.
  resetAutoStart();
  for (let s = 0; s < 8; s++) {
    const org = `x485f${s}.atlassian.net`;
    for (let i = 0; i < TICKET_QUEUE_PER_ORG_MAX; i++) {
      assert.ok(enqueueTicketStart(org, `FL-${i}`, "manual"),
        `${org} FL-${i} should still be admitted`);
    }
  }
  assert.equal(liveQueueCount(), TICKET_QUEUE_MAX);
  assert.equal(ticketQueueAdmission("x485z.atlassian.net", "P0-9", "auto", "P0"),
    "fleet-full", "P0 preemption stops at the fleet cap");
  assert.equal(ticketQueueAdmission("x485z.atlassian.net", "M-9", "manual"), "fleet-full");
  ticketQueue.length = 0;
});

test("XERK-485: a 50-ticket burst starts at most the window's auto slots; the rest hold", async () => {
  // Over the limit -> entries HOLD under reason "rate": they keep their place
  // in line instead of being dropped or dropped-and-re-queued every sweep.
  resetAutoStart();
  const site = "x485r.atlassian.net";
  const tickets = [];
  for (let i = 0; i < 50; i++) {
    tickets.push({ key: `B-${i}`, statusCategory: "todo",
      repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } });
  }
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await asBeat("rBurst", site, { capacity: ROOMY, tickets });
    for (let i = 0; i < 8; i++) {
      autoStartRound();
      // The hub counts a host's pending spawnTicket commands against its free
      // slots; each round, the host "takes" its command (an ack with the
      // session still starting) so the next ticket can claim a slot.
      agents.rBurst.commands = [];
    }
  } finally {
    console.log = real;
  }
  const autoLines = lines.filter((l) =>
    l.startsWith("ticket queue: dispatched") && l.includes("(auto,"));
  assert.equal(autoLines.length, TICKET_QUEUE_RATE_MAX,
    "the burst starts exactly the window's worth of auto sessions");
  assert.deepEqual(
    autoLines.map((l) => l.split(" ")[3].replace(/"/g, "")),
    ["B-0", "B-1", "B-2", "B-3", "B-4"], "the first ones in line start, FIFO");
  const held = ticketQueue.filter((e) => e.siteKey === site);
  assert.equal(held.length, TICKET_QUEUE_PER_ORG_AUTO_MAX,
    "the org's line holds at its auto share");
  for (const e of held) assert.equal(e.reason, "rate", "held, not dropped");
  assert.equal(autoStartRate.get(site).length, TICKET_QUEUE_RATE_MAX,
    "each auto dispatch stamped the window");
  // A manual click is deliberate intent: it cuts straight through the full
  // window and does not stamp it.
  const r = await startTicket(site, "B-49");
  assert.equal(r.status, 200);
  assert.ok((agents.rBurst.commands || []).some(
    (c) => c.type === "spawnTicket" && c.issueKey === "B-49" && c.ticketSource === "manual"),
    "the manual start is dispatched");
  assert.equal(autoStartRate.get(site).length, TICKET_QUEUE_RATE_MAX,
    "a manual start did not stamp the org's auto window");
});

test("XERK-485: an auto entry re-triaged to held or duplicate while waiting drops; a manual one survives", async () => {
  // The drain re-reads the ticket's CURRENT triage: the sweep's gate only sees
  // tickets at sweep time, so a re-triage landing mid-wait must be caught here
  // or the ticket dispatches on a stale "go ahead".
  resetAutoStart();
  const site = "x485d.atlassian.net";
  // 4 free slots: three dispatches (D-1, D-4, D-2) each leave a PENDING spawn
  // command on the host, and the hub counts those against the free slots.
  await asBeat("dRecheck", site, { autoStart: false,
    capacity: { maxSessions: 4, running: 0, queued: 0, free: 4 }, tickets: [
    { key: "D-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } },
    { key: "D-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: false } },
    { key: "D-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true, dedupeOf: "D-1" } },
    { key: "D-4", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true } },
  ] });
  setAutoStartOrg(site, true);
  // Enqueued directly: this test exercises the DRAIN's re-check, not the gate.
  enqueueTicketStart(site, "D-1", "auto");
  enqueueTicketStart(site, "D-2", "auto");
  enqueueTicketStart(site, "D-3", "auto");
  enqueueTicketStart(site, "D-4", "auto");
  drainTicketQueue();
  assert.ok(!queuedTicket(site, "D-2"),
    "actionable:false while waiting -> dropped (the gate won't re-queue it)");
  assert.ok(!queuedTicket(site, "D-3"), "flagged a duplicate while waiting -> dropped");
  assert.deepEqual((agents.dRecheck.commands || []).map((c) => c.issueKey), ["D-1"],
    "the still-actionable ticket took the slot");
  // D-4 has no triage block at all: "can't tell" is not "held" — it stays
  // dispatchable. It skipped this pass only because D-1 claimed the host.
  drainTicketQueue();
  assert.deepEqual((agents.dRecheck.commands || []).map((c) => c.issueKey),
    ["D-1", "D-4"]);
  // A manual entry is deliberate intent: the same held re-triage does not drop it.
  enqueueTicketStart(site, "D-2", "manual");
  drainTicketQueue();
  assert.deepEqual((agents.dRecheck.commands || []).map((c) => c.issueKey),
    ["D-1", "D-4", "D-2"], "manual work ignores the triage gate");
});

test("XERK-485: a flaked dispatch refunds the org's rate slot when the retry re-queues", async () => {
  // A spawn that was acked but left no session spent its rate slot for nothing.
  // Without the refund, one flapping ticket would burn the whole window on its
  // retries and starve the org's other tickets until the stamps aged out.
  resetAutoStart();
  const site = "x485v.atlassian.net";
  await asBeat("vRefund", site, { capacity: ROOMY });   // default triaged To Do ENG-5
  autoStartRound();
  const k = site + "\x00" + "ENG-5";
  assert.equal(autoStartRate.get(site).length, 1, "the dispatch stamped the window");
  // Fill the rest of the window with other tickets' stamps: the org is now AT
  // its limit, so only the refund can let the retry through.
  for (let i = 1; i < TICKET_QUEUE_RATE_MAX; i++) {
    recordAutoStartRate(site, `${site}\x00OTHER-${i}`, Date.now());
  }
  assert.equal(autoStartRate.get(site).length, TICKET_QUEUE_RATE_MAX);
  agents.vRefund.commands = [];           // the agent took the command...
  autoStarted.get(k).nextAt = 0;          // ...but left no session; backoff elapsed
  autoStartRound();
  assert.deepEqual((agents.vRefund.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "the retry dispatches instead of holding behind its own spent slot");
  assert.equal(autoStartRate.get(site).length, TICKET_QUEUE_RATE_MAX,
    "refund + re-stamp keeps the window honest (4 others + this retry)");
});

test("XERK-296: a terminal note counts against NO line — per org or fleet-wide", async () => {
  // A note is a message about work that ended, not work. Counting one is how
  // dead notes came to 429 a live click from an unrelated org.
  resetAutoStart();
  await asBeat("tqNotes", "tq31.atlassian.net", { autoStart: false, capacity: FULL });
  await asBeat("tqNotesB", "tq32.atlassian.net", { autoStart: false, capacity: FULL });
  const note = (site, i) => {
    const e = enqueueTicketStart(site, `NOTE-${i}`, "manual");
    e.expiredAt = Date.now();
    e.reason = "expired";
    return e;
  };
  for (let i = 0; i < TICKET_QUEUE_PER_ORG_MAX; i++) note("tq31.atlassian.net", i);
  // Its own org can still queue past a line's worth of notes…
  assert.equal(ticketQueueAdmission("tq31.atlassian.net", "ENG-5", "manual"), "ok");
  // …and so can everyone else, even at a fleet cap's worth of them.
  for (let i = 0; i < TICKET_QUEUE_MAX; i++) note("tq32.atlassian.net", 1000 + i);
  const r = await startTicket("tq31.atlassian.net", "ENG-5");
  assert.equal(r.body.queued, true, "dead notes must not refuse live work");
  // The notes are still bounded — nothing else counts them.
  assert.ok(ticketQueue.filter((e) => e.expiredAt).length <= TICKET_QUEUE_NOTES_MAX);
  ticketQueue.length = 0;
});

test("XERK-296: notes are bounded, and the OLDEST go first", async () => {
  // Which one is evicted is the half with user impact: a note is a message
  // somebody is meant to read, so the newest — least likely to have been seen —
  // must be the one that survives.
  resetAutoStart();
  const site = "tq34.atlassian.net";
  await asBeat("tqEvict", site, { autoStart: false, capacity: FULL });
  for (let i = 0; i < TICKET_QUEUE_NOTES_MAX + 10; i++) {
    const e = enqueueTicketStart(site, `OLD-${1000 + i}`, "manual");
    if (!e) break;
    e.expiredAt = 1000 + i;          // ascending: OLD-1000 is the oldest note
    e.reason = "expired";
  }
  enqueueTicketStart(site, "NEW-1", "manual");   // the enqueue that trims
  const notes = ticketQueue.filter((e) => e.expiredAt);
  assert.ok(notes.length <= TICKET_QUEUE_NOTES_MAX, "the bound holds");
  assert.ok(!notes.some((e) => e.issueKey === "OLD-1000"), "the oldest note went");
  assert.ok(notes.some((e) => e.issueKey === `OLD-${1000 + TICKET_QUEUE_NOTES_MAX + 9}`),
    "and the newest survived");
  ticketQueue.length = 0;
});

test("XERK-296: a terminal note doesn't block its own ticket's auto-start", async () => {
  // The sweep's "already queued" guard read a note as a place in line, so an
  // auto ticket that waited out its hours then sat inert for the note's whole
  // TTL — hours more — before auto-start could try again.
  resetAutoStart();
  await asBeat("tqNoteAuto", "tq33.atlassian.net", { capacity: FULL });
  autoStartSweep();
  const e = queuedTicket("tq33.atlassian.net", "ENG-5");
  e.expiredAt = Date.now();
  e.reason = "expired";
  autoStartSweep();
  const again = queuedTicket("tq33.atlassian.net", "ENG-5");
  assert.equal(again.expiredAt, undefined, "the sweep replaces the note with a real place");
  assert.equal(again.reason, null);
});

test("XERK-296: a state log line is throttled — it describes a condition, not an event", async () => {
  // The sweep re-derives every verdict every 15s, so an unthrottled line about a
  // STATE buries the log in exactly the situation it exists to explain.
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    for (let i = 0; i < 5; i++) logQueueState("throttle-test", "the same condition");
    logQueueState("another-key", "a different condition");
  } finally {
    console.log = real;
  }
  assert.deepEqual(lines, ["the same condition", "a different condition"]);
});

test("XERK-296: a ticket only ONE host of a multi-host org reports still routes", async () => {
  // Each agent polls Jira as `assignee = currentUser()`, so two hosts in one org
  // routinely report DIFFERENT ticket lists ~10 minutes apart. Resolving a queued
  // ticket against one winning block per org made a ticket the other host's user
  // owns look deleted: dispatch-blocked, then aged out.
  resetAutoStart();
  await asBeat("tqSeenA", "tq25.atlassian.net", { autoStart: false, capacity: FULL,
    fetchedAt: "2026-07-14T12:00:00Z" });
  await asBeat("tqSeenB", "tq25.atlassian.net", { autoStart: false, capacity: FULL,
    fetchedAt: "2026-07-14T12:05:00Z", tickets: [] });   // fresher, sees nothing
  await startTicket("tq25.atlassian.net", "ENG-5");
  drainTicketQueue();
  const e = queuedTicket("tq25.atlassian.net", "ENG-5");
  assert.ok(e, "the ticket exists — one host of the org reports it");
  assert.equal(e.unknownSince, 0, "so it is not on the way to being aged out");
  agents.tqSeenA.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqSeenA.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-296: one unqueueable ticket row doesn't stop the rest of the org's sweep", async () => {
  // enqueue refuses a key this hub won't serve. Reported to the sweep as "the
  // queue is full", it truncated that org's auto-start at the bad row — every
  // sweep, forever — and blamed a queue that was empty.
  resetAutoStart();
  const g = { priority: "P2", type: "task", actionable: true };
  await asBeat("tqBadRow", "tq26.atlassian.net", { capacity: FULL, tickets: [
    { key: "OK-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: g },
    { key: { evil: 1 }, statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: g },
    { key: "OK-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: g },
    { key: "OK-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: g },
  ] });
  autoStartSweep();
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["OK-1", "OK-2", "OK-3"]);
});

test("XERK-296: an org whose hosts are all offline HOLDS, it doesn't churn", async () => {
  // Dropping a blocked auto entry dropped it into the sweep's arms: re-queued
  // 15s later, every 15s, churning the log, the payload and the board's chip for
  // as long as the org stayed down.
  resetAutoStart();
  await asBeat("tqChurn", "tq27.atlassian.net", { capacity: FULL, tickets: [
    { key: "CH-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } },
  ] });
  autoStartSweep();
  drainTicketQueue();
  agents.tqChurn.lastSeen = Date.now() - 10 * 60 * 1000;      // the org goes dark
  for (let i = 0; i < 5; i++) { autoStartSweep(); drainTicketQueue(); }
  const e = queuedTicket("tq27.atlassian.net", "CH-1");
  assert.ok(e, "it keeps its place rather than being dropped and re-queued");
  assert.equal(e.reason, "blocked");
  assert.match(e.error, /offline/);
  // And it starts the moment the org is back.
  agents.tqChurn.lastSeen = Date.now();
  agents.tqChurn.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqChurn.commands || []).map((c) => c.issueKey), ["CH-1"]);
});

test("XERK-296: the sweep cannot fill an org's whole line — a person can always get in", async () => {
  // An opted-in org refills its line every 15s, so a single per-org cap just
  // moved the starvation one level down: the operator's own Start button
  // answering "that org already has N waiting" for as long as the backlog lasts.
  resetAutoStart();
  const tickets = [];
  for (let i = 0; i < 40; i++) {
    tickets.push({ key: `AUT-${i}`, statusCategory: "todo",
      repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } });
  }
  tickets.push({ key: "MINE-1", statusCategory: "todo",
    repoGuess: { repo: "Turma", cloned: true } });
  await asBeat("tqShare", "tq28.atlassian.net", { capacity: FULL, tickets });
  autoStartSweep();
  const auto = ticketQueue.filter((e) => e.source === "auto").length;
  assert.equal(auto, TICKET_QUEUE_PER_ORG_AUTO_MAX, "the sweep takes its share and no more");
  const r = await startTicket("tq28.atlassian.net", "MINE-1");
  assert.equal(r.body.queued, true, "and the operator's own click still gets a place");
  ticketQueue.length = 0;
});

test("XERK-296: the FLEET cap still bounds the queue across many orgs", async () => {
  // The per-org cap fires first for one org, which left the memory bound behind
  // it unexercised — so it is pinned here across enough orgs to reach it.
  resetAutoStart();
  const orgs = Math.ceil(TICKET_QUEUE_MAX / TICKET_QUEUE_PER_ORG_MAX) + 1;
  for (let o = 0; o < orgs; o++) {
    for (let i = 0; i < TICKET_QUEUE_PER_ORG_MAX; i++) {
      enqueueTicketStart(`fleet${o}.atlassian.net`, `ENG-${100 + i}`, "manual");
    }
  }
  assert.equal(ticketQueue.length, TICKET_QUEUE_MAX);
  assert.equal(ticketQueueAdmission("fleetX.atlassian.net", "ENG-1", "manual"), "fleet-full");
  ticketQueue.length = 0;
});

test("XERK-296: one org's backlog cannot starve ticket-starting for another org", async () => {
  // A 250-ticket To Do backlog is an ordinary board, not an attack. With only a
  // fleet-wide cap, one opted-in org filled the whole queue in a single sweep and
  // every OTHER org's Start button then answered "the queue is full" — one org's
  // routine backlog switching ticket-starting off fleet-wide.
  resetAutoStart();
  await asBeat("tqHog", "tq13.atlassian.net", { autoStart: false, capacity: FULL });
  await asBeat("tqVictim", "tq14.atlassian.net", { autoStart: false, capacity: FULL });
  for (let i = 0; i < TICKET_QUEUE_PER_ORG_MAX; i++) {
    assert.ok(enqueueTicketStart("tq13.atlassian.net", `ENG-${1000 + i}`, "manual"));
  }
  assert.equal(enqueueTicketStart("tq13.atlassian.net", "ENG-9999", "manual"), null,
    "the hogging org is cut off at its own line's length");
  let r = await startTicket("tq13.atlassian.net", "ENG-5");
  assert.equal(r.status, 429);
  assert.match(r.body.error, /that org already has/);
  // The victim org is unaffected: its ticket queues normally.
  r = await startTicket("tq14.atlassian.net", "ENG-5");
  assert.equal(r.body.queued, true);
  assert.ok(queuedTicket("tq14.atlassian.net", "ENG-5"));
  ticketQueue.length = 0;
});

test("XERK-296: a hostile or wrong-typed issue key never enters the queue", async () => {
  // On the SWEEP path both fields come off an agent's jira block — untrusted —
  // and an entry is then served to every client on the top-level payload, where
  // Android types issueKey as a String and decodes the payload atomically. So the
  // key is validated at the door, not only on the manual route.
  resetAutoStart();
  const site = "tq15.atlassian.net";
  for (const bad of ["../../../etc/passwd", "<img src=x onerror=1>", "ENG 5", "",
                     "A".repeat(80) + "-1", { evil: [1, 2] }, null, 42]) {
    assert.equal(enqueueTicketStart(site, bad, "auto"), null, JSON.stringify(bad));
  }
  assert.equal(enqueueTicketStart("s".repeat(300), "ENG-5", "auto"), null, "long siteKey");
  assert.equal(ticketQueue.length, 0);
  // And the sweep itself drops such a ticket rather than dispatching it.
  await asBeat("tqBad", site, { capacity: FULL, tickets: [
    { key: "../../../etc/passwd", statusCategory: "todo",
      repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } },
  ] });
  autoStartSweep();
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0);
  assert.equal((agents.tqBad.commands || []).length, 0);
});

test("XERK-296: a direct start retires the ticket's queue entry (never a second session)", async () => {
  // The entry and the dispatch are the same intent. Left in place, that entry
  // fires again on the next free slot — a second session for a ticket that is
  // already being worked, hours later and unasked.
  resetAutoStart();
  await asBeat("tqDouble", "tq16.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq16.atlassian.net", "ENG-5");
  assert.equal(ticketQueue.length, 1);
  // A slot frees and a board that hadn't seen the queue clicks Start.
  agents.tqDouble.capacity = { ...ROOMY };
  const r = await startTicket("tq16.atlassian.net", "ENG-5");
  assert.equal(r.body.host, "tqDouble");
  assert.equal(ticketQueue.length, 0, "its place in line is spent");
  agents.tqDouble.commands = [];
  drainTicketQueue();
  assert.equal((agents.tqDouble.commands || []).length, 0, "and nothing fires later");
});

test("XERK-296: a cancel that LOST to a dispatch says so, rather than reporting success", async () => {
  resetAutoStart();
  await asBeat("tqRace2", "tq18.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq18.atlassian.net", "ENG-5");
  agents.tqRace2.capacity = { ...ROOMY };
  drainTicketQueue();                                    // dispatched
  const r = await request("DELETE", "/api/jira/tq18.atlassian.net/ENG-5/session",
    { headers: userHeaders });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /just started/);
  // A ticket that was never queued still reads as a plain 404 — the two are
  // different facts and the operator needs to be told which.
  const r2 = await request("DELETE", "/api/jira/tq18.atlassian.net/ENG-6/session",
    { headers: userHeaders });
  assert.equal(r2.status, 404);
});

test("XERK-296: an entry whose ticket stops existing ages out of its org's line", async () => {
  resetAutoStart();
  await asBeat("tqStale2", "tq19.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq19.atlassian.net", "ENG-5");
  agents.tqStale2.jira.tickets = [];                     // the board stops listing it
  drainTicketQueue();
  assert.equal(ticketQueue.length, 1, "a poll gap or host restart must not lose it");
  queuedTicket("tq19.atlassian.net", "ENG-5").unknownSince =
    Date.now() - TICKET_QUEUE_STALE_MS - 1;
  drainTicketQueue();
  assert.equal(liveQueueCount(), 0, "out of the line…");
  // …but a MANUAL click never leaves silently (XERK-303): it goes terminal, on
  // the payload, with the ✕ — the same treatment the max-wait backstop gives.
  const note = queuedTicket("tq19.atlassian.net", "ENG-5");
  assert.equal(note.reason, "expired");
  assert.match(note.error, /no agent reports that ticket any more/);
});

test("XERK-296: a permanently blocked entry ages out; an auto one leaves at once", async () => {
  resetAutoStart();
  await asBeat("tqBlock", "tq20.atlassian.net", { capacity: FULL, tickets: [
    { key: "ENG-5", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true } },
  ] });
  await startTicket("tq20.atlassian.net", "ENG-5");
  // The ticket loses its triaged repo: nothing the hub can do until someone acts.
  agents.tqBlock.jira.tickets = [{ key: "ENG-5", statusCategory: "todo", repoGuess: null }];
  drainTicketQueue();
  const e = queuedTicket("tq20.atlassian.net", "ENG-5");
  assert.equal(e.reason, "blocked");
  assert.match(e.error, /no triaged repo/);
  e.blockedSince = Date.now() - TICKET_QUEUE_BLOCKED_MAX_MS - 1;
  drainTicketQueue();
  assert.equal(liveQueueCount(), 0, "a manual click is given a while, then let go");
  // Let go VISIBLY (XERK-303). It was survivable while only a click could reach
  // this state and the operator was watching it; a reclaimed spawn arrives with
  // nobody watching, so a silent drop is a click that vanishes 30 minutes later.
  assert.equal(queuedTicket("tq20.atlassian.net", "ENG-5").reason, "expired");
  // An AUTO entry is re-derivable, so it leaves outright the moment it can't be
  // routed — the sweep re-queues it as soon as it's eligible again.
  dropQueuedTicket("tq20.atlassian.net", "ENG-5", null);
  assert.ok(enqueueTicketStart("tq20.atlassian.net", "ENG-5", "auto"));
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0, "and leaves nothing behind");
});

test("XERK-296: the heartbeat itself drains the queue (a freed slot fills in a beat)", async () => {
  // The beat IS the capacity report, so it is when a waiting ticket may have
  // become startable; without this the wait is up to a whole 15s sweep.
  resetAutoStart();
  await asBeat("tqBeat", "tq21.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq21.atlassian.net", "ENG-5");
  assert.equal(ticketQueue.length, 1);
  await asBeat("tqBeat", "tq21.atlassian.net", { autoStart: false, capacity: ROOMY });
  assert.equal(ticketQueue.length, 0, "drained by the beat, with no sweep in between");
  assert.deepEqual((agents.tqBeat.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-296: the model pin is read at DISPATCH, not at enqueue", async () => {
  resetAutoStart();
  await asBeat("tqPinM", "tq22.atlassian.net", { autoStart: false, capacity: FULL });
  await startTicket("tq22.atlassian.net", "ENG-5");
  await setModel("tq22.atlassian.net", "ENG-5", { model: "opus" });  // set while it waits
  agents.tqPinM.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.deepEqual((agents.tqPinM.commands || []).map((c) => [c.issueKey, c.model]),
    [["ENG-5", "opus"]]);
});

test("XERK-296: a hold reason from the hub is length-capped on the entry", async () => {
  // It rides /api/agents to every client, and interpolates a routing error.
  resetAutoStart();
  await asBeat("tqLong", "tq23.atlassian.net", { autoStart: false, capacity: FULL,
    tickets: [{ key: "ENG-5", statusCategory: "todo", repoGuess: null }] });
  assert.ok(enqueueTicketStart("tq23.atlassian.net", "ENG-5", "manual"));
  const e = queuedTicket("tq23.atlassian.net", "ENG-5");
  holdQueued(e, "blocked", "x".repeat(TICKET_QUEUE_ERROR_MAX + 500));
  assert.equal(e.error.length, TICKET_QUEUE_ERROR_MAX);
  ticketQueue.length = 0;
});

// ---- per-org triage policy + per-ticket verdicts (XERK-486 [F]) -------------
// The policy shapes WHAT an opted-in org's auto sweep queues (minPriority,
// excludeTypes, repo allow/deny, rateMax); a per-ticket verdict (approve /
// hold / reject) sits on top of both — hold and reject keep a ticket out of the
// auto stream at sweep AND drain time, approve forces it past gate and policy.
// Both maps are hub-owned durable state riding /api/agents, like the pins.
const resetTriagePolicy = () => {
  for (const k of Object.keys(triagePolicies)) delete triagePolicies[k];
};
const resetTriageActions = () => {
  for (const k of Object.keys(ticketTriageActions)) delete ticketTriageActions[k];
};

test("XERK-486 [F]: triagePolicyReason enforces the min-priority / type / repo knobs", () => {
  resetTriagePolicy();
  // No policy at all -> unrestricted (the common org stays exactly as it was).
  assert.equal(triagePolicyReason("x486u.com", { priority: "P2", type: "chore" }, "Turma"), null);
  // minPriority: this band and HIGHER pass; the band below fails; an
  // untriaged ticket (no band at all) fails too.
  setTriagePolicy("x486u.com", { minPriority: "P1" });
  assert.equal(triagePolicyReason("x486u.com", { priority: "P0", type: "bug" }, "Turma"), null);
  assert.equal(triagePolicyReason("x486u.com", { priority: "P1", type: "bug" }, "Turma"), null);
  assert.match(triagePolicyReason("x486u.com", { priority: "P2", type: "task" }, "Turma"),
    /minimum auto-start priority \(P1\+\)/);
  assert.match(triagePolicyReason("x486u.com", null, "Turma"),
    /minimum auto-start priority \(P1\+\)/, "an untriaged ticket has no band to pass");
  // excludeTypes matches the triage TYPE only; an untriaged ticket has no type,
  // so it is not excluded by a type filter.
  setTriagePolicy("x486u.com", { minPriority: null, excludeTypes: ["chore"] });
  assert.match(triagePolicyReason("x486u.com", { priority: "P1", type: "chore" }, "Turma"),
    /excluded by policy/);
  assert.equal(triagePolicyReason("x486u.com", { priority: "P1", type: "bug" }, "Turma"), null);
  assert.equal(triagePolicyReason("x486u.com", { priority: "P1" }, "Turma"), null);
  // repoDeny beats repoAllow; an allow list blocks everything it omits.
  setTriagePolicy("x486u.com", { minPriority: null, excludeTypes: null,
    repoAllow: ["Turma", "Hub"], repoDeny: ["Hub"] });
  assert.match(triagePolicyReason("x486u.com", { priority: "P0", type: "bug" }, "Hub"),
    /denied by policy/);
  assert.equal(triagePolicyReason("x486u.com", { priority: "P0", type: "bug" }, "Turma"), null);
  setTriagePolicy("x486u.com", { repoDeny: null });
  assert.match(triagePolicyReason("x486u.com", { priority: "P0", type: "bug" }, "Other"),
    /not on the allow list/);
  // The knobs are per-org: an org with no policy is untouched by them.
  assert.equal(triagePolicyReason("x486-none.com", { priority: "P2", type: "chore" }, "Other"), null);
});

test("XERK-486 [F]: setTriagePolicy merges patches; null clears a knob; an empty org clears", () => {
  resetTriagePolicy();
  setTriagePolicy("x486m.com", { minPriority: "P0", excludeTypes: ["chore"], rateMax: 3 });
  assert.deepEqual(triagePolicies["x486m.com"],
    { minPriority: "P0", excludeTypes: ["chore"], rateMax: 3 });
  setTriagePolicy("x486m.com", { rateMax: null, repoDeny: ["Bad"] });
  assert.deepEqual(triagePolicies["x486m.com"],
    { minPriority: "P0", excludeTypes: ["chore"], repoDeny: ["Bad"] });
  setTriagePolicy("x486m.com", { minPriority: null, excludeTypes: null, repoDeny: null });
  assert.equal("x486m.com" in triagePolicies, false, "all knobs cleared -> no policy object");
  // autoStartRateMax reads the org's knob, else the fleet default.
  assert.equal(autoStartRateMax("x486m.com"), TICKET_QUEUE_RATE_MAX);
  setTriagePolicy("x486m.com", { rateMax: 2 });
  assert.equal(autoStartRateMax("x486m.com"), 2);
  setTriagePolicy("x486m.com", { rateMax: null });
  assert.equal(autoStartRateMax("x486m.com"), TICKET_QUEUE_RATE_MAX);
});

test("XERK-486 [F]: a ticket verdict sets, clears, and evicts oldest-first at the cap", () => {
  resetTriageActions();
  setTicketTriageAction("x486v.com", "T-1", "hold");
  assert.equal(ticketTriageAction("x486v.com", "T-1"), "hold");
  setTicketTriageAction("x486v.com", "T-1", null);
  assert.equal(ticketTriageAction("x486v.com", "T-1"), null);
  for (let i = 0; i <= TRIAGE_ACTIONS_MAX + 2; i++) {
    setTicketTriageAction("x486v.com", `EV-${i}`, "approve");
  }
  assert.equal(Object.keys(ticketTriageActions).length, TRIAGE_ACTIONS_MAX);
  assert.equal(ticketTriageAction("x486v.com", "EV-0"), null, "the oldest verdict evicted");
  assert.equal(ticketTriageAction("x486v.com", `EV-${TRIAGE_ACTIONS_MAX + 2}`), "approve");
  // An unknown key or a malformed stored value reads as "no verdict".
  assert.equal(ticketTriageAction("x486v.com", "T-9"), null);
  ticketTriageActions["x486v.com/T-9"] = { action: "yolo" };
  assert.equal(ticketTriageAction("x486v.com", "T-9"), null);
  delete ticketTriageActions["x486v.com/T-9"];
});

test("XERK-486 [F]: 'auto-start highs+ only' queues P0/P1 and leaves mediums unqueued", async () => {
  resetAutoStart();
  resetTriagePolicy();
  const site = "x486m.atlassian.net";
  await asBeat("x486m", site, { capacity: FULL,
    tickets: [
      { key: "M-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P0", type: "bug", actionable: true } },
      { key: "M-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P1", type: "task", actionable: true } },
      { key: "M-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P2", type: "task", actionable: true } },
      { key: "M-4", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P3", type: "chore", actionable: true } },
    ] });
  setTriagePolicy(site, { minPriority: "P1" });   // "highs+ only"
  autoStartSweep();
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["M-1", "M-2"],
    "highs and above queue; the mediums render but take no place in line");
  // Lifting the knob lets the rest in on the next sweep.
  setTriagePolicy(site, { minPriority: null });
  autoStartSweep();
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["M-1", "M-2", "M-3", "M-4"]);
  ticketQueue.length = 0;
});

test("XERK-486 [F]: an excluded triage type never enters the auto stream", async () => {
  resetAutoStart();
  resetTriagePolicy();
  const site = "x486x.atlassian.net";
  await asBeat("x486x", site, { capacity: FULL,
    tickets: [
      { key: "X-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P1", type: "chore", actionable: true } },
      { key: "X-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
        triage: { priority: "P1", type: "bug", actionable: true } },
    ] });
  setTriagePolicy(site, { excludeTypes: ["chore"] });
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { autoStartSweep(); } finally { console.log = real; }
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["X-2"]);
  assert.ok(lines.some((l) => l.includes("X-1") && l.includes("excluded by policy")),
    "the skip is logged, throttled like the other held lines");
  ticketQueue.length = 0;
});

test("XERK-486 [F]: repo deny beats repo allow, and the allow list blocks the rest", async () => {
  resetAutoStart();
  resetTriagePolicy();
  const site = "x486r.atlassian.net";
  const tri = { priority: "P1", type: "task", actionable: true };
  await asBeat("x486r", site, { capacity: FULL, repos: ["Turma", "Hub", "Bad"],
    tickets: [
      { key: "R-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
      { key: "R-2", statusCategory: "todo", repoGuess: { repo: "Hub", cloned: true }, triage: tri },
      { key: "R-3", statusCategory: "todo", repoGuess: { repo: "Bad", cloned: true }, triage: tri },
    ] });
  setTriagePolicy(site, { repoAllow: ["Turma", "Bad"], repoDeny: ["Bad"] });
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { autoStartSweep(); } finally { console.log = real; }
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["R-1"]);
  assert.ok(lines.some((l) => l.includes("R-3") && l.includes("denied by policy")));
  assert.ok(lines.some((l) => l.includes("R-2") && l.includes("not on the allow list")));
  ticketQueue.length = 0;
});

test("XERK-486 [F]: hold and reject keep a ticket out of the sweep; approve overrides", async () => {
  resetAutoStart();
  resetTriagePolicy();
  resetTriageActions();
  const site = "x486v.atlassian.net";
  const hi = { priority: "P0", type: "bug", actionable: true };
  const mid = { priority: "P1", type: "task", actionable: true };
  await asBeat("x486v", site, { capacity: FULL,
    tickets: [
      { key: "V-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: hi },
      { key: "V-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: hi },
      { key: "V-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: mid },
      { key: "V-4", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true } }, // untriaged
      { key: "V-5", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: mid },
    ] });
  setTicketTriageAction(site, "V-1", "hold");
  setTicketTriageAction(site, "V-2", "reject");
  setTicketTriageAction(site, "V-3", "approve");   // past the policy's P0 floor
  setTicketTriageAction(site, "V-4", "approve");   // past the "untriaged" gate
  setTriagePolicy(site, { minPriority: "P0" });
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { autoStartSweep(); autoStartSweep(); } finally { console.log = real; }
  // The hold survives a second sweep (the 15s interval) exactly as the first.
  assert.deepEqual(ticketQueue.map((e) => e.issueKey), ["V-3", "V-4"],
    "hold and reject are never swept; approve forces past gate and policy");
  assert.ok(lines.some((l) => l.includes("V-1") && l.includes("hold by triage")));
  assert.ok(lines.some((l) => l.includes("V-2") && l.includes("reject by triage")));
  assert.ok(lines.some((l) => l.includes("V-5") && l.includes("skipped by")),
    "the unapproved P1 is still skipped by the policy");
  // Releasing the hold lets the held ticket sweep in.
  setTicketTriageAction(site, "V-1", null);
  autoStartSweep();
  assert.deepEqual([...ticketQueue.map((e) => e.issueKey)].sort(), ["V-1", "V-3", "V-4"]);
  ticketQueue.length = 0;
  resetTriageActions();
});

test("XERK-486 [F]: approve still respects the ignore-tier / missing-repo candidate filter", async () => {
  resetAutoStart();
  resetRepoTiers();
  resetTriagePolicy();
  resetTriageActions();
  const site = "x486i.atlassian.net";
  await asBeat("x486i", site, { capacity: FULL, repos: ["Junk"],
    tickets: [
      { key: "I-1", statusCategory: "todo", repoGuess: { repo: "Junk", cloned: true },
        triage: { priority: "P0", type: "bug", actionable: true } },
      { key: "I-2", statusCategory: "todo", repoGuess: null,
        triage: { priority: "P0", type: "bug", actionable: true } },
    ] });
  setRepoTier("Junk", "ignore");
  setTicketTriageAction(site, "I-1", "approve");
  setTicketTriageAction(site, "I-2", "approve");
  autoStartSweep();
  assert.equal(ticketQueue.length, 0,
    "approve bypasses gate and policy, not the candidate filter");
  ticketQueue.length = 0;
  resetRepoTiers();
  resetTriageActions();
});

test("XERK-486 [F]: a verdict changed while the ticket waits is honoured at drain", async () => {
  resetAutoStart();
  resetTriagePolicy();
  resetTriageActions();
  const site = "x486d.atlassian.net";
  const tri = { priority: "P2", type: "task", actionable: true };
  await asBeat("x486d", site, { autoStart: false, capacity: FULL,
    tickets: [
      { key: "D-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
      { key: "D-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
      { key: "D-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
      { key: "D-4", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
    ] });
  setAutoStartOrg(site, true);
  // Enqueued directly: this test exercises the DRAIN's re-check, not the sweep.
  enqueueTicketStart(site, "D-1", "auto");
  enqueueTicketStart(site, "D-2", "auto");
  enqueueTicketStart(site, "D-3", "manual");
  enqueueTicketStart(site, "D-4", "manual");
  setTicketTriageAction(site, "D-1", "hold");
  setTicketTriageAction(site, "D-2", "reject");
  setTicketTriageAction(site, "D-4", "hold");
  agents.x486d.capacity = { ...ROOMY };
  drainTicketQueue();
  assert.equal(queuedTicket(site, "D-1"), null, "the held auto entry drops at drain");
  assert.equal(queuedTicket(site, "D-2"), null, "the rejected auto entry drops at drain");
  const cmds = (agents.x486d.commands || []).map((c) => c.issueKey);
  assert.ok(cmds.includes("D-3"), "the manual entry is unaffected by any verdict");
  assert.ok(queuedTicket(site, "D-4"),
    "one ticket per host per pass: the held MANUAL D-4 still waits");
  // Release D-1's hold and re-queue it: a dropped entry is gone, and the sweep
  // won't re-queue it while the verdict said hold — the drain must honour the
  // NEW verdict on the fresh entry. D-4 is older in line, so it dispatches
  // first; D-1 takes the next pass.
  agents.x486d.commands = [];
  setTicketTriageAction(site, "D-1", "approve");
  enqueueTicketStart(site, "D-1", "auto");
  drainTicketQueue();
  assert.ok((agents.x486d.commands || []).some((c) => c.issueKey === "D-4"),
    "a held MANUAL entry is deliberate intent and keeps draining");
  agents.x486d.commands = [];
  drainTicketQueue();
  assert.ok((agents.x486d.commands || []).some((c) => c.issueKey === "D-1"),
    "a hold released to approve dispatches at drain");
  resetTriageActions();
});

test("XERK-486 [F]: the policy's rateMax caps the org's auto window (read live)", async () => {
  resetAutoStart();
  resetTriagePolicy();
  const site = "x486q.atlassian.net";
  const tri = { priority: "P2", type: "task", actionable: true };
  await asBeat("x486q", site, { capacity: ROOMY,
    tickets: [
      { key: "Q-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
      { key: "Q-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
      { key: "Q-3", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true }, triage: tri },
    ] });
  setTriagePolicy(site, { rateMax: 2 });
  autoStartRound();           // Q-1 out
  agents.x486q.commands = []; // the host "takes" it, freeing the slot again
  drainTicketQueue();         // Q-2 out — the org's window is now full
  agents.x486q.commands = [];
  drainTicketQueue();         // Q-3: the rate window is full, so it HOLDS
  const e = queuedTicket(site, "Q-3");
  assert.ok(e, "the third auto entry stays in line");
  assert.equal(e.reason, "rate");
  assert.equal(autoStartRate.get(site).length, 2, "each dispatch stamped the window");
  // And the org's knob is live: raising it frees the hold on the next drain.
  setTriagePolicy(site, { rateMax: 3 });
  drainTicketQueue();
  assert.equal(queuedTicket(site, "Q-3"), null, "a raised rateMax lets it out");
  resetTriagePolicy();
});

test("XERK-486 [F]: POST /api/jira/<site>/<key>/triage sets and clears a verdict, rides the payload", async () => {
  resetTriageActions();
  await asBeat("x486api", "x486a.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/x486a.atlassian.net/ENG-5/triage",
    { body: { action: "hold" }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, action: "hold" });
  assert.equal(ticketTriageAction("x486a.atlassian.net", "ENG-5"), "hold");
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.ticketTriageActions["x486a.atlassian.net/ENG-5"].action, "hold");
  // {clear:true} releases the verdict — the key leaves the map, so the
  // payload's entry goes with it.
  r = await request("POST", "/api/jira/x486a.atlassian.net/ENG-5/triage",
    { body: { clear: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, null);
  assert.equal(ticketTriageAction("x486a.atlassian.net", "ENG-5"), null);
  const list2 = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal("x486a.atlassian.net/ENG-5" in list2.body.ticketTriageActions, false);
});

test("XERK-486 [F]: the triage route rejects a bad action, a bad key, and a phantom org", async () => {
  await asBeat("x486api2", "x486b.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/x486b.atlassian.net/ENG-5/triage",
    { body: { action: "yolo" }, headers: userHeaders });
  assert.equal(r.status, 400);
  r = await request("POST", "/api/jira/x486b.atlassian.net/bad/triage",
    { body: { action: "hold" }, headers: userHeaders });
  assert.equal(r.status, 400, "not an issue key");
  r = await request("POST", "/api/jira/nobody486.atlassian.net/ENG-5/triage",
    { body: { action: "hold" }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody486.atlassian.net/ENG-5" in ticketTriageActions, false);
});

test("XERK-486 [F]: POST /api/jira/<site>/triage-policy upserts, merges, and rides the payload", async () => {
  resetTriagePolicy();
  await asBeat("x486p", "x486c.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/x486c.atlassian.net/triage-policy",
    { body: { minPriority: "P1", excludeTypes: ["chore"], rateMax: 3 }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true,
    policy: { minPriority: "P1", excludeTypes: ["chore"], rateMax: 3 } });
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.deepEqual(list.body.triagePolicies["x486c.atlassian.net"],
    { minPriority: "P1", excludeTypes: ["chore"], rateMax: 3 });
  // A null knob clears just that knob — the rest of the policy survives.
  r = await request("POST", "/api/jira/x486c.atlassian.net/triage-policy",
    { body: { rateMax: null }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.policy, { minPriority: "P1", excludeTypes: ["chore"] });
});

test("XERK-486 [F]: the triage-policy route rejects bad knobs and a phantom org", async () => {
  await asBeat("x486p2", "x486d.atlassian.net", { autoStart: false });
  for (const body of [
    { minPriority: "P4" },
    { rateMax: 0 },
    { rateMax: 51 },
    { rateMax: 2.5 },
    { excludeTypes: [42] },
    { repoAllow: "Turma" },
  ]) {
    const r = await request("POST", "/api/jira/x486d.atlassian.net/triage-policy",
      { body, headers: userHeaders });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal("x486d.atlassian.net" in triagePolicies, false, "no partial state on refusal");
  const r = await request("POST", "/api/jira/nobody486p.atlassian.net/triage-policy",
    { body: { minPriority: "P0" }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody486p.atlassian.net" in triagePolicies, false);
});

test("POST /api/jira/<site>/<key>/triage needs the user login", async () => {
  await asBeat("x486auth", "x486auth.atlassian.net", { autoStart: false });
  const r = await request("POST", "/api/jira/x486auth.atlassian.net/ENG-5/triage",
    { body: { action: "hold" } });
  assert.equal(r.status, 401);
  assert.equal(ticketTriageAction("x486auth.atlassian.net", "ENG-5"), null);
});

// ---- reclaiming a spawn stranded on a dead host (XERK-303) ------------------
// XERK-296's guarantee — any host in the org can take waiting work — ends at
// DISPATCH. Past that the command belongs to one host, and nothing re-routed it
// if that host died before taking it. The discriminator is `deliveredAt`, not
// onlineness: undelivered is provably never run, delivered may be mid-spawn.

// Dispatch ENG-5 to `a` and then take `a` offline, leaving `b` free. Returns
// the command that is now stranded on `a`.
const strandOn = async (site, a, b) => {
  await asBeat(a, site, { autoStart: false, capacity: { ...ROOMY } });
  await asBeat(b, site, { autoStart: false, capacity: { ...FULL } });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.body.host, a, "the only free host takes it");
  agents[a].lastSeen = Date.now() - 10 * 60 * 1000;   // A goes dark, still holding it
  agents[b].capacity = { ...ROOMY };                  // B finishes a session
  return (agents[a].commands || [])[0];
};

test("XERK-303: an undelivered spawn on a dead host is reclaimed and re-routed", async () => {
  resetAutoStart();
  await strandOn("tq40.atlassian.net", "tqRecA", "tqRecB");
  // Before the reclaim this is the bug: the queue is empty, the command is
  // parked on a host that is never coming back to it, and the free host in the
  // same org is handed nothing.
  drainTicketQueue();
  assert.equal(ticketQueue.length, 0);
  assert.equal((agents.tqRecB.commands || []).length, 0);

  reclaimStrandedTicketSpawns();
  assert.equal((agents.tqRecA.commands || []).length, 0, "withdrawn from the dead host");
  const e = queuedTicket("tq40.atlassian.net", "ENG-5");
  assert.ok(e, "and back in the hub's queue, where any org host can take it");
  drainTicketQueue();
  assert.deepEqual((agents.tqRecB.commands || []).map((c) => [c.type, c.issueKey]),
    [["spawnTicket", "ENG-5"]]);
  assert.equal(queuedTicket("tq40.atlassian.net", "ENG-5"), null, "dispatched again");
});

test("XERK-540: a stranded spawn a concurrent Start already re-routed is withdrawn, not re-queued", async () => {
  // The transient double-start QA found on XERK-331: a MANUAL spawn stranded
  // undelivered on an offline host, then Start clicked. committedTicketSpawn lets
  // that Start through (an undelivered-offline command is reclaim's to own), so a
  // fresh session comes up on a live host under a new cmdId. Reclaim must NOT
  // then re-queue the stranded command — a manual entry skips drain's in-flight
  // guard by design, so it would start a SECOND session for the one ticket.
  resetAutoStart();
  const site = "tq61.atlassian.net";
  const stranded = await strandOn(site, "tq61A", "tq61B");

  // The operator clicks Start again. A is offline holding an UNDELIVERED command,
  // so the org-wide single-flight guard does not fire and a fresh spawn routes to
  // the now-free B under a brand-new cmdId.
  const again = await startTicket(site, "ENG-5");
  assert.equal(again.body.host, "tq61B", "the fresh Start routes to the live host");
  assert.notEqual(again.body.cmdId, stranded.cmdId, "under a brand-new cmdId");

  reclaimStrandedTicketSpawns();
  drainTicketQueue();

  assert.equal((agents.tq61A.commands || []).length, 0,
    "the superseded command is withdrawn from the dead host");
  assert.equal(ticketQueue.length, 0, "and it is NOT re-queued");
  assert.deepEqual((agents.tq61B.commands || []).map((c) => [c.type, c.issueKey]),
    [["spawnTicket", "ENG-5"]],
    "so exactly ONE session comes up — the fresh Start's, no second one");
});

test("XERK-540: an ordinary stranded spawn (no fresh Start) is still reclaimed", async () => {
  // The supersession check must fire ONLY when a DIFFERENT cmdId superseded this
  // one. The stranded command's own dispatch stamped the memo under its own
  // cmdId, so a plain reclaim (no concurrent Start) must still re-route it —
  // dispatchSupersedes returns false when the newest dispatch IS this command.
  resetAutoStart();
  const stranded = await strandOn("tq62.atlassian.net", "tq62A", "tq62B");
  assert.ok(stranded.cmdId, "the stranded command has a cmdId");
  reclaimStrandedTicketSpawns();
  assert.equal((agents.tq62A.commands || []).length, 0, "withdrawn from the dead host");
  assert.ok(queuedTicket("tq62.atlassian.net", "ENG-5"), "and re-queued for any org host");
  drainTicketQueue();
  assert.deepEqual((agents.tq62B.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-303: a DELIVERED spawn is never withdrawn — a double start beats no start", async () => {
  // The case the whole gate exists for: a host routinely goes silent BETWEEN
  // delivery and ack, so "it is offline" is not evidence the command didn't run.
  resetAutoStart();
  const cmd = await strandOn("tq41.atlassian.net", "tqDelA", "tqDelB");
  cmd.deliveredAt = Date.now();                  // the agent has seen it
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqDelA.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "it stays where it is — it re-delivers when that host returns");
  assert.equal(ticketQueue.length, 0, "and it is NOT re-queued");
  assert.equal((agents.tqDelB.commands || []).length, 0, "so no second session");
});

test("XERK-303: a reclaimed MANUAL click comes back as manual, not as auto", async () => {
  // An auto entry is swept out of the queue when its org's switch is off, so
  // re-queueing a click as auto would swallow it on the very next drain.
  resetAutoStart();
  await strandOn("tq42.atlassian.net", "tqKindA", "tqKindB");
  assert.equal(autoStartOrgs["tq42.atlassian.net"], undefined, "auto-start is OFF here");
  reclaimStrandedTicketSpawns();
  assert.equal(queuedTicket("tq42.atlassian.net", "ENG-5").source, "manual");
  drainTicketQueue();
  assert.deepEqual((agents.tqKindB.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-303: a reclaimed AUTO ticket comes back as auto, and spends a retry", async () => {
  resetAutoStart();
  await asBeat("tqAutoA", "tq43.atlassian.net", { capacity: { ...ROOMY } });
  await asBeat("tqAutoB", "tq43.atlassian.net", { capacity: { ...FULL } });
  autoStartRound();
  const k = "tq43.atlassian.net\x00ENG-5";
  assert.equal(autoStarted.get(k).attempts, 1, "dispatch spent one");
  assert.deepEqual((agents.tqAutoA.commands || []).map((c) => c.issueKey), ["ENG-5"]);

  agents.tqAutoA.lastSeen = Date.now() - 10 * 60 * 1000;
  agents.tqAutoB.capacity = { ...ROOMY };
  autoStarted.set(k, { attempts: 1, nextAt: 0 });     // that attempt's backoff has elapsed
  reclaimStrandedTicketSpawns();
  assert.equal(queuedTicket("tq43.atlassian.net", "ENG-5").source, "auto");
  drainTicketQueue();
  assert.deepEqual((agents.tqAutoB.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(autoStarted.get(k).attempts, 2,
    "the rescue is an attempt of its own, not a free one");
});

test("XERK-303: a ticket nothing can route away is LEFT on the dead host", async () => {
  // The one way this can be worse than the bug it fixes. A single-host org has
  // nowhere to re-route to, so a withdrawn entry is held `blocked` and then
  // dropped SILENTLY at TICKET_QUEUE_BLOCKED_MAX_MS: a click that would have run
  // when its host came back ends up on no host and in no queue.
  resetAutoStart();
  await asBeat("tqSolo", "tq46.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  const r = await startTicket("tq46.atlassian.net", "ENG-5");
  assert.equal(r.body.host, "tqSolo");
  agents.tqSolo.lastSeen = Date.now() - 10 * 60 * 1000;
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqSolo.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "left where it is — today's behaviour, not destroyed");
  assert.equal(ticketQueue.length, 0);
  // Age it well past every queue timer: still there, because it never entered
  // the queue to be aged by one.
  for (let i = 0; i < 3; i++) { reclaimStrandedTicketSpawns(); drainTicketQueue(); }
  assert.deepEqual((agents.tqSolo.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  // And it runs when the host comes back.
  agents.tqSolo.lastSeen = Date.now();
  const beat = await request("POST", "/api/heartbeat",
    { body: { device: "tqSolo" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands.map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-303: a ticket pinned to the dead host is not withdrawn from it", async () => {
  // The pin means findTicketHost can only ever return that host, so withdrawing
  // takes the ticket off the only agent that will ever run it.
  resetAutoStart();
  await asBeat("tqPinA", "tq47.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  await asBeat("tqPinB", "tq47.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  hub.ticketAgents["tq47.atlassian.net/ENG-5"] = { host: "tqPinA", at: Date.now() };
  const r = await startTicket("tq47.atlassian.net", "ENG-5");
  assert.equal(r.body.host, "tqPinA");
  agents.tqPinA.lastSeen = Date.now() - 10 * 60 * 1000;
  reclaimStrandedTicketSpawns();
  assert.deepEqual((agents.tqPinA.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(ticketQueue.length, 0, "and it is not put in a line it cannot leave");
  delete hub.ticketAgents["tq47.atlassian.net/ENG-5"];
});

test("XERK-303: a free host that has NOT triaged the ticket is not withdrawn into", async () => {
  // The reclaim's routability precondition passes issueKey to findTicketHost, so
  // it inherits XERK-325's triage rule for free: a host that has not triaged the
  // ticket would refuse the spawn (`spawn_ticket` re-derives from its OWN ledger),
  // so withdrawing into it is a session that never starts. Dropping the issueKey
  // to "simplify" that call silently removes this.
  //
  // A third host owns the fleet's row for the ticket (freshest fetchedAt, and it
  // is online), so the repo the fleet resolves is NOT whatever the free host
  // happens to have decided for itself — otherwise the free host's own triage
  // becomes the thing being checked against.
  resetAutoStart();
  const site = "tq60.atlassian.net";
  await strandOn(site, "tqTriA", "tqTriB");
  await asBeat("tqTriRow", site, { autoStart: false, capacity: { ...FULL },
    fetchedAt: "2026-07-14T13:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  // The free host has triaged this ticket to a DIFFERENT repo, so it cannot run
  // the spawn even though it has the slot.
  agents.tqTriB.jira.tickets = [{ key: "ENG-5", statusCategory: "todo",
    repoGuess: { repo: "SomethingElse", cloned: true } }];
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqTriA.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "left on the dead host — the free host would only refuse it");
  assert.equal((agents.tqTriB.commands || []).length, 0);
  // Flip ONLY that: once the free host agrees with the board, the rescue lands.
  agents.tqTriB.jira.tickets = [{ key: "ENG-5", statusCategory: "todo",
    repoGuess: { repo: "Turma", cloned: true } }];
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqTriB.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal((agents.tqTriA.commands || []).length, 0, "and it leaves the dead host");
});

test("XERK-303: a merely BUSY org is not somewhere to withdraw INTO either", async () => {
  // `full` is a wait that clears itself for a ticket already in line. For one
  // that is NOT, withdrawing into it just trades a week on a dead host for four
  // hours and a "gave up waiting" note. It waits where it is, and the 15s sweep
  // rescues it the moment a slot actually exists.
  resetAutoStart();
  await strandOn("tq48.atlassian.net", "tqBusyA", "tqBusyB");
  agents.tqBusyB.capacity = { ...FULL };            // nothing free anywhere, yet
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqBusyA.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "left on the dead host rather than put in a line it cannot leave");
  assert.equal(ticketQueue.length, 0);
  // A slot frees: the very next sweep rescues and dispatches it.
  agents.tqBusyB.capacity = { ...ROOMY };
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqBusyB.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-303: a command restored from state.json is never reclaimed", async () => {
  // scheduleSave is a 30s debounce, so a save that landed between the queue and
  // the delivery wrote the command WITHOUT deliveredAt. Restoring that as
  // undelivered would re-route work the agent has already run, under a fresh
  // cmdId its in-memory de-dup cannot catch — one ticket, two sessions.
  resetAutoStart();
  await strandOn("tq49.atlassian.net", "tqRstA", "tqRstB");
  const blob = serializeAgentsForSave();            // the save that lands 30s later
  // The agent takes delivery, then the hub restarts before the next save.
  await request("POST", "/api/heartbeat",
    { body: { device: "tqRstA" }, headers: agentHeaders });
  const restored = JSON.parse(blob);
  assert.equal("deliveredAt" in restored.tqRstA.commands[0], false,
    "the copy on disk genuinely says 'never delivered'");
  hub.sanitizeRestoredCommands(restored);             // what the boot restore does
  agents.tqRstA.commands = restored.tqRstA.commands;
  agents.tqRstA.lastSeen = Date.now() - 10 * 60 * 1000;
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.equal((agents.tqRstB.commands || []).length, 0, "no second spawn");
  assert.equal(ticketQueue.length, 0);
});

test("XERK-303: the BOOT restore is what stamps a restored command, not the caller", async () => {
  // The stamping only protects anything if the restore actually runs it: a
  // freshly-required module reading a state.json whose command has no
  // deliveredAt must come up with that command marked delivered.
  const f = path.join(os.tmpdir(), `turma-x303-restore-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({
    bootHost: {
      device: "bootHost", lastSeen: Date.now(), sessions: [], repos: [],
      commands: [{ type: "spawnTicket", issueKey: "ENG-5", ticketSource: "manual",
                   ticketSite: "boot.atlassian.net", cmdId: "boot1" }],
    },
  }));
  const mod = freshServerModule((env) => { env.STATE_FILE = f; });
  const c = mod.agents.bootHost.commands[0];
  assert.ok(c.deliveredAt, "restored as delivered — the hub can no longer prove otherwise");
  fs.unlinkSync(f);
});

test("XERK-303: junk in a restored command list is DROPPED, not carried", async () => {
  // A corrupt state.json is the only door: nothing on the wire reaches this
  // array, and queueCommand only pushes objects. Dropping it at the restore is
  // what makes every c.type / c.cmdId read in the file safe.
  const f = path.join(os.tmpdir(), `turma-x303-junk-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({
    junkHost: {
      device: "junkHost", lastSeen: Date.now(), sessions: [], repos: [],
      commands: [null, "not-an-object", 7, { type: "kill", sessionId: "s1", cmdId: "k1" }],
    },
  }));
  const mod = freshServerModule((env) => { env.STATE_FILE = f; });
  assert.deepEqual(mod.agents.junkHost.commands.map((c) => c.cmdId), ["k1"]);
  assert.ok(mod.agents.junkHost.commands[0].deliveredAt, "and the survivor is stamped");
  fs.unlinkSync(f);
});

test("XERK-303: an AUTO entry that reaches giveUp still leaves outright, with no note", async () => {
  // The auto half of the XERK-296 blocked-timer test uses an UNTRIAGED ticket,
  // which is dropped one `if` above giveUp — so nothing covered giveUp's own auto
  // arm, and making it mint notes for auto entries too left the suite green.
  // This drives the routing-failure timer, which is a path giveUp really governs.
  resetAutoStart();
  await asBeat("tqAutoNote", "tq58.atlassian.net", { tickets: [
    { key: "ENG-7", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "task", actionable: true } },
  ] });
  autoStartSweep();
  const e = queuedTicket("tq58.atlassian.net", "ENG-7");
  assert.equal(e.source, "auto");
  agents.tqAutoNote.lastSeen = Date.now() - 10 * 60 * 1000;   // the whole org goes dark
  drainTicketQueue();
  assert.equal(e.reason, "blocked");
  e.blockedSince = Date.now() - TICKET_QUEUE_BLOCKED_MAX_MS - 1;
  drainTicketQueue();
  assert.equal(queuedTicket("tq58.atlassian.net", "ENG-7"), null,
    "re-derivable work leaves outright — a note for it would be noise nobody asked for");
  assert.equal(ticketQueue.length, 0);
});

test("XERK-303: a give-up note's text is capped like every other hold reason", async () => {
  // It interpolates findTicketHost's wording, which carries a DEVICE NAME, and
  // rides /api/agents to every client. The longest such reason — pinned to a host
  // that no longer reports the org — plus this path's own prefix runs past the cap
  // at a 200-char host, which is a name the door actually admits.
  resetAutoStart();
  const host = "tqLong" + "z".repeat(194);
  await asBeat(host, "tq59.atlassian.net", { autoStart: false, capacity: { ...FULL } });
  // A second host keeps REPORTING the ticket, so the entry stays on the routing
  // path rather than ageing out as one nobody lists any more.
  await asBeat("tq59Reporter", "tq59.atlassian.net", { autoStart: false, capacity: { ...FULL } });
  hub.ticketAgents["tq59.atlassian.net/ENG-5"] = { host, at: Date.now() };
  const r = await startTicket("tq59.atlassian.net", "ENG-5");
  assert.equal(r.body.queued, true, "pinned-but-full is a wait, so it enters the queue");
  // The pinned host now reports a DIFFERENT org: the longest refusal there is.
  await asBeat(host, "tq59other.atlassian.net", { autoStart: false, capacity: { ...FULL } });
  drainTicketQueue();
  const e = queuedTicket("tq59.atlassian.net", "ENG-5");
  assert.equal(e.reason, "blocked");
  e.blockedSince = Date.now() - TICKET_QUEUE_BLOCKED_MAX_MS - 1;
  drainTicketQueue();
  const note = ticketQueuePayload().find((q) => q.issueKey === "ENG-5");
  assert.equal(note.reason, "expired");
  assert.equal(note.error.length, TICKET_QUEUE_ERROR_MAX,
    "this case really does hit the cap, so the assertion below means something");
  delete hub.ticketAgents["tq59.atlassian.net/ENG-5"];
});

test("XERK-303: a non-ARRAY commands list is rewritten, not skipped past", async () => {
  // Fatal one line SOONER than a junk element: `(a.commands || []).some` is not
  // a function, and `for…of` a plain object is not iterable — same setInterval,
  // same no-handler exit. A string is a plausible hand-edit precisely because it
  // looks scalar.
  for (const junk of ['"junk"', "5", '{"0":{"type":"kill","cmdId":"k1"}}', "true"]) {
    const f = path.join(os.tmpdir(), `turma-x303-arr-${process.pid}.json`);
    fs.writeFileSync(f, `{"badHost":{"device":"badHost","lastSeen":${Date.now()},`
      + `"sessions":[],"repos":[],"commands":${junk}}}`);
    const mod = freshServerModule((env) => { env.STATE_FILE = f; });
    assert.deepEqual(mod.agents.badHost.commands, [], `commands:${junk} rewritten`);
    assert.doesNotThrow(() => { mod.autoStartSweep(); }, `sweep survives ${junk}`);
    assert.doesNotThrow(() => { mod.reclaimStrandedTicketSpawns(); }, `reclaim survives ${junk}`);
    fs.unlinkSync(f);
  }
});

test("XERK-303: a MANUAL entry the hub gives up on never leaves the queue silently", async () => {
  // The reclaim puts entries in the queue with nobody watching, so the blocked
  // timer's silent drop became a click that vanishes 30 minutes later with
  // nothing on the board. Every give-up path a manual entry can reach must leave
  // a terminal note, exactly as the max-wait backstop does.
  resetAutoStart();
  await asBeat("tqGoneA", "tq57.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  await asBeat("tqGoneB", "tq57.atlassian.net", { autoStart: false, capacity: { ...FULL } });
  const r = await startTicket("tq57.atlassian.net", "ENG-5");
  assert.equal(r.body.host, "tqGoneA");
  agents.tqGoneA.lastSeen = Date.now() - 10 * 60 * 1000;
  agents.tqGoneB.capacity = { ...ROOMY };
  reclaimStrandedTicketSpawns();                    // rescued into the queue…
  assert.ok(queuedTicket("tq57.atlassian.net", "ENG-5"));
  // …and then the whole fleet goes dark, which is the likeliest continuation of
  // whatever killed the first host.
  agents.tqGoneB.lastSeen = Date.now() - 10 * 60 * 1000;
  drainTicketQueue();
  const e = queuedTicket("tq57.atlassian.net", "ENG-5");
  assert.equal(e.reason, "blocked");
  e.blockedSince = Date.now() - TICKET_QUEUE_BLOCKED_MAX_MS - 1;
  drainTicketQueue();
  assert.equal(liveQueueCount(), 0, "out of the line");
  const note = queuedTicket("tq57.atlassian.net", "ENG-5");
  assert.ok(note, "but NOT gone without a word");
  assert.equal(note.reason, "expired");
  const payload = ticketQueuePayload().find((q) => q.issueKey === "ENG-5");
  assert.equal(payload.reason, "expired", "and the board can see it");
  assert.match(payload.error, /nothing could run it/);
});

test("XERK-303: a junk command cannot take the whole hub down via the 15s sweep", async () => {
  // autoStartSweep reads c.type inside a setInterval, and nothing installs an
  // uncaughtException handler — `null.type` there EXITS THE HUB, taking every
  // host's control plane with it, and re-fires 15s after each restart. The
  // heartbeat's ack filter does not save it: that only heals a host that BEATS,
  // and an offline host holding a stranded spawn is the subject here.
  resetAutoStart();
  await asBeat("tqCrash", "tq56.atlassian.net", { capacity: { ...ROOMY } });
  agents.tqCrash.commands = [null, "not-an-object",
    { type: "spawnTicket", issueKey: "ENG-9", ticketSource: "auto",
      ticketSite: "tq56.atlassian.net", cmdId: "c9", deliveredAt: Date.now() }];
  agents.tqCrash.lastSeen = Date.now() - 10 * 60 * 1000;      // offline: never heals
  assert.doesNotThrow(() => { autoStartSweep(); });
  assert.doesNotThrow(() => { reclaimStrandedTicketSpawns(); });
  assert.doesNotThrow(() => { drainTicketQueue(); });
});

test("XERK-303: a spawn whose deliveredAt is present but FALSY is still not reclaimed", async () => {
  // publicCommands strips on presence, so the gate reads presence too. The two
  // disagreeing is how a command gets hidden from the wire and reclaimed anyway.
  resetAutoStart();
  await strandOn("tq54.atlassian.net", "tqZeroA", "tqZeroB");
  agents.tqZeroA.commands[0].deliveredAt = 0;
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqZeroA.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal((agents.tqZeroB.commands || []).length, 0);
});

test("XERK-303: a spawn missing only its SOURCE is not reclaimed either", async () => {
  // Each of the two stamps stands alone: with the org known but the kind not,
  // guessing is how an operator's click comes back as auto and is swept away.
  resetAutoStart();
  await strandOn("tq55.atlassian.net", "tqNoSrcA", "tqNoSrcB");
  delete agents.tqNoSrcA.commands[0].ticketSource;    // ticketSite still present
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqNoSrcA.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(ticketQueue.length, 0);
});

test("XERK-303: an unstamped spawn is never reclaimed — its kind can't be guessed", async () => {
  // Every command an older hub queued is unstamped. Read as "auto" it is dropped
  // by the very next drain when the org's switch is off; read as "manual" it
  // escapes every auto guard. Neither is knowable, so it is left alone.
  resetAutoStart();
  await strandOn("tq50.atlassian.net", "tqBareA", "tqBareB");
  const c = agents.tqBareA.commands[0];
  delete c.ticketSource;
  delete c.ticketSite;
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  assert.deepEqual((agents.tqBareA.commands || []).map((x) => x.issueKey), ["ENG-5"]);
  assert.equal(ticketQueue.length, 0);
});

test("XERK-303: the org comes from the COMMAND, not the host record's jira block", async () => {
  // `jira.siteKey` is self-reported and bound to no credential (XERK-268 proves
  // the HOST, not the org), so the org a stranded spawn is re-queued under must
  // come from the command. Reading it live off the record would let a host whose
  // Jira config has moved re-queue another org's ticket into its own — and that
  // org's host would then run it.
  //
  // Driven by mutating the record rather than over the wire, deliberately: a beat
  // is what changes the reported org AND is what takes delivery, so the two
  // cannot both happen to one undelivered command today. This pins the rule, not
  // a live exploit.
  resetAutoStart();
  await asBeat("tqOrgA", "tq51a.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  await asBeat("tqOrgHome", "tq51a.atlassian.net", { autoStart: false, capacity: { ...FULL } });
  await asBeat("tqOrgVictim", "tq51b.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  const r = await startTicket("tq51a.atlassian.net", "ENG-5");
  assert.equal(r.body.host, "tqOrgA");
  assert.equal(agents.tqOrgA.commands[0].ticketSite, "tq51a.atlassian.net");
  agents.tqOrgA.jira.siteKey = "tq51b.atlassian.net";   // the record now claims org B
  agents.tqOrgA.lastSeen = Date.now() - 10 * 60 * 1000;
  agents.tqOrgHome.capacity = { ...ROOMY };
  reclaimStrandedTicketSpawns();
  assert.equal(queuedTicket("tq51a.atlassian.net", "ENG-5").source, "manual");
  drainTicketQueue();
  assert.equal((agents.tqOrgVictim.commands || []).length, 0,
    "org B's host is never handed org A's ticket");
  assert.deepEqual((agents.tqOrgHome.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "it goes back to a host of the org it was dispatched for");
});

test("XERK-303: a non-object command element cannot throw out of publicCommands", async () => {
  // `in` throws on a truthy primitive. Thrown here it 400s that host's every beat
  // with the internal error text and serves every dashboard a stale payload —
  // XERK-235's offline loop, from a one-word gap. Not reachable from the wire
  // (the handler overwrites `commands` after the spread); a corrupt state.json is.
  resetAutoStart();
  await asBeat("tqPoison", "tq52.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  agents.tqPoison.commands = ["not-an-object", null,
    { type: "kill", sessionId: "s1", cmdId: "c1" }];
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.status, 200);
  const rec = list.body.agents.find((x) => x.key === "tqPoison");
  assert.ok(rec, "the fleet payload still serializes");
  const beat = await request("POST", "/api/heartbeat",
    { body: { device: "tqPoison" }, headers: agentHeaders });
  assert.equal(beat.status, 200, "and the host's beat is not refused");
  assert.deepEqual(beat.body.commands.map((c) => c.cmdId), ["c1"],
    "the junk is filtered out rather than tolerated");
  assert.deepEqual(agents.tqPoison.commands.map((c) => c.cmdId), ["c1"],
    "and the record self-heals in one round trip");
});

test("XERK-303: an AUTO rescue waits out the backoff, so a flapping pair cannot churn", async () => {
  // Two hosts flapping alternately pass every other precondition forever: each
  // bounce finds the other host up, so the ticket is reclaimed, re-dispatched,
  // stranded again, and never starts — while the log, the payload and the board
  // churn every OFFLINE_AFTER_MS. A rescue is an attempt that produced nothing,
  // so it costs a retry and honours the backoff the dispatch spent.
  resetAutoStart();
  await asBeat("tqFlapA", "tq53.atlassian.net", { capacity: { ...ROOMY } });
  await asBeat("tqFlapB", "tq53.atlassian.net", { capacity: { ...ROOMY } });
  const k = "tq53.atlassian.net\x00ENG-5";
  const dead = (h) => { agents[h].lastSeen = Date.now() - 10 * 60 * 1000; };
  const alive = (h) => { agents[h].lastSeen = Date.now(); };

  autoStartRound();
  const first = ["tqFlapA", "tqFlapB"].find((h) => (agents[h].commands || []).length);
  assert.ok(first, "dispatched somewhere");
  assert.equal(autoStarted.get(k).attempts, 1);
  dead(first);
  // The backoff from that attempt has NOT elapsed, so the rescue holds.
  reclaimStrandedTicketSpawns();
  assert.deepEqual((agents[first].commands || []).map((c) => c.issueKey), ["ENG-5"],
    "held: the attempt this ticket just spent is still backing off");
  assert.equal(ticketQueue.length, 0);

  // Once it elapses the rescue happens, and SPENDS another attempt rather than
  // refunding one — which is what makes each bounce cost more than the last.
  autoStarted.set(k, { attempts: 1, nextAt: 0 });
  reclaimStrandedTicketSpawns();
  drainTicketQueue();
  const second = first === "tqFlapA" ? "tqFlapB" : "tqFlapA";
  assert.deepEqual((agents[second].commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(autoStarted.get(k).attempts, 2, "the rescue cost a retry");
  assert.ok(autoStarted.get(k).nextAt > Date.now(), "and the next one waits longer");

  // Eight more bounces with no time passing buy nothing at all.
  for (let i = 0; i < 8; i++) {
    alive(first); dead(second);
    reclaimStrandedTicketSpawns(); drainTicketQueue();
  }
  assert.equal(autoStarted.get(k).attempts, 2, "the loop is throttled, not spinning");
  assert.deepEqual((agents[second].commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-303: ticketSource is hub-only — the agent and the fleet payload never see it", async () => {
  // Same rule as deliveredAt: bookkeeping that rides the command must not become
  // a client contract, and Android decodes the fleet payload atomically.
  resetAutoStart();
  await asBeat("tqSrc", "tq45.atlassian.net", { autoStart: false, capacity: { ...ROOMY } });
  await startTicket("tq45.atlassian.net", "ENG-5");
  assert.equal((agents.tqSrc.commands || [])[0].ticketSource, "manual",
    "the hub keeps it");
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = list.body.agents.find((x) => x.key === "tqSrc");
  for (const c of rec.commands || []) {
    assert.equal("ticketSource" in c, false, "not on the fleet payload");
  }
  const beat = await request("POST", "/api/heartbeat",
    { body: { device: "tqSrc" }, headers: agentHeaders });
  assert.deepEqual(beat.body.commands.map((c) => c.type), ["spawnTicket"]);
  for (const c of beat.body.commands) {
    assert.equal("ticketSource" in c, false, "nor in the agent's reply");
  }
  // Stripping must not cost the agent the fields it actually runs on.
  assert.equal(beat.body.commands[0].issueKey, "ENG-5");
});

// ---- routing only to a host that has TRIAGED the ticket (XERK-325) ----------
// Triage is per-host (each agent's own ledger, its own model run, its own
// candidate repos), while `ticketRepo` publishes the freshest host's answer
// fleet-wide. `spawn_ticket` re-derives from the LOCAL ledger and refuses what it
// has no decision for, so a host that has not triaged the ticket cannot run the
// spawn — routing to one is a session that never starts.

test("XERK-325: a host that has not triaged the ticket is not dispatched to", async () => {
  // The reported bug: host B has the ticket triaged, host A is free and does not.
  // The old pool ranked purely on availability, so the free untriaged host won and
  // its agent refused the spawn with nothing on screen to say so.
  resetAutoStart();
  const site = "tq325a.atlassian.net";
  await asBeat("tq325aUntriaged", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo" }] });          // no repoGuess
  // Fresher, so this is the copy the card renders — the board shows Turma.
  await asBeat("tq325aTriaged", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.status, 200);
  assert.deepEqual((agents.tq325aUntriaged.commands || []).map((c) => c.issueKey), [],
    "the untriaged host must never be handed a spawn it will refuse");
  assert.deepEqual((agents.tq325aTriaged.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-325: a host that triaged the ticket ELSEWHERE is not dispatched to either", async () => {
  // It would spawn against its OWN answer, so the operator would get a session on
  // a repo the card never showed. Agreement with the published repo is the test,
  // not merely having some decision.
  resetAutoStart();
  const site = "tq325b.atlassian.net";
  await asBeat("tq325bOther", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Veiller", cloned: true } }] });
  // Fresher, so ticketRepo publishes "Turma" — which is what the card shows.
  await asBeat("tq325bTurma", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:05:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  await startTicket(site, "ENG-5");
  assert.deepEqual((agents.tq325bOther.commands || []).map((c) => c.issueKey), []);
  assert.deepEqual((agents.tq325bTurma.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-325: a 'nothing fits' verdict is not a triage decision", async () => {
  // _apply_triage publishes a declined ticket as repoGuess.repo = null, and
  // spawn_ticket refuses it exactly as it refuses an absent one. This host is
  // permanently that way (_triage_stale never re-triages a decided entry), which
  // is what made the symptom look host-specific rather than like a race.
  resetAutoStart();
  const site = "tq325c.atlassian.net";
  await asBeat("tq325cNull", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo", repoGuess: { repo: null } }] });
  await asBeat("tq325cReal", site, { autoStart: false, capacity: FULL,
    fetchedAt: "2026-07-14T12:30:00Z",                    // the copy the card shows
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  // The only host that can run it is full, so this waits on capacity — it does
  // NOT fall through to the host holding a null verdict.
  assert.equal(r.body.queued, true);
  assert.deepEqual((agents.tq325cNull.commands || []).map((c) => c.issueKey), []);
  ticketQueue.length = 0;
});

test("XERK-325: no online host having triaged it HOLDS as blocked, not as capacity", async () => {
  // A freed slot does not give a host a triage decision, so reporting this as
  // "waiting for a slot" would promise a wait that clears itself. It holds on the
  // blocked timer instead, which is bounded and says what is wrong.
  resetAutoStart();
  const site = "tq325d.atlassian.net";
  // The offline host is the only one whose Jira user is assigned ENG-5, so its
  // row IS what the card renders — the chip is there and Start is live. The
  // online host is in the org but has never seen the ticket.
  await asBeat("tq325dOff", site, { autoStart: false, capacity: ROOMY,
    user: "off@x.com",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  agents.tq325dOff.lastSeen = Date.now() - 10 * 60 * 1000;
  await asBeat("tq325dOn", site, { autoStart: false, capacity: ROOMY,
    user: "on@x.com", tickets: [] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /has triaged that ticket to Turma/);
  assert.equal(r.body.queued, undefined, "a hard refusal reaches the operator, it doesn't queue");
  assert.deepEqual((agents.tq325dOn.commands || []).map((c) => c.issueKey), []);
});

test("XERK-325: an agent PIN to a host that hasn't triaged it is refused, not routed around", async () => {
  // The pin says which host, never that the host can run it — and the one thing a
  // pin asserts is that no other host is chosen, so this reports rather than
  // silently picking the host that did triage it.
  resetAutoStart();
  const site = "tq325e.atlassian.net";
  await asBeat("tq325ePinned", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo" }] });
  await asBeat("tq325eOther", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:30:00Z",                    // the copy the card shows
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  const pin = await setAgent(site, "ENG-5", { host: "tq325ePinned" });
  assert.equal(pin.status, 200);
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /pinned to agent "tq325ePinned", which has not triaged it/);
  assert.deepEqual((agents.tq325eOther.commands || []).map((c) => c.issueKey), [],
    "the pin still forbids routing elsewhere");
});

test("XERK-325: an OFFLINE host's fresher triage never dictates the repo", async () => {
  // ticketRepo and findTicketHost have to resolve against the SAME pool. The
  // freshest block routinely belongs to a host that is down (hosts poll Jira
  // ~10 min apart), and routing can only reach an online host that AGREES — so
  // ranking on freshness alone named a repo nothing could be dispatched against
  // and stalled a ticket an online host had triaged and could run.
  resetAutoStart();
  const site = "tq325g.atlassian.net";
  await asBeat("tq325gDown", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:30:00Z",                                // freshest
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Veiller", cloned: true } }] });
  agents.tq325gDown.lastSeen = Date.now() - 10 * 60 * 1000;
  await asBeat("tq325gUp", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z",                                // staler
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.status, 200);
  assert.equal(r.body.queued, undefined, "it starts — it does not stall as blocked");
  assert.equal(r.body.repo, "Turma", "the online host's answer is the one routed on");
  assert.deepEqual((agents.tq325gUp.commands || []).map((c) => c.issueKey), ["ENG-5"]);
});

test("XERK-325: a wholly OFFLINE org still resolves a repo, so the ticket can wait", async () => {
  // The online tier is a preference, not a filter: with nothing online the
  // offline answer still stands, so the queue holds the ticket instead of the
  // sweep dropping it for having no triaged repo at all.
  resetAutoStart();
  const site = "tq325h.atlassian.net";
  await asBeat("tq325hDown", site, { autoStart: false, capacity: ROOMY,
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  agents.tq325hDown.lastSeen = Date.now() - 10 * 60 * 1000;
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /offline/,
    "the refusal is about the org being down, not about triage");
});

test("XERK-325: 'slots full' names the hosts that can actually run it", async () => {
  // The pool is the hosts that triaged this ticket to this repo, so reporting
  // the ORG as full while a host with four free slots sits idle sends the
  // operator to look at capacity they do not have a problem with.
  resetAutoStart();
  const site = "tq325i.atlassian.net";
  await asBeat("tq325iAgreesFull", site, { autoStart: false, capacity: FULL,
    fetchedAt: "2026-07-14T12:05:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  await asBeat("tq325iDisagreesFree", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Veiller", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  // Still a capacity wait — the one host that can run it really is full, and
  // that reason clears itself — but worded truthfully.
  assert.equal(r.body.queued, true);
  const e = queuedTicket(site, "ENG-5");
  drainTicketQueue();
  assert.ok(e, "it waits on the agreeing host rather than being refused");
  assert.deepEqual((agents.tq325iDisagreesFree.commands || []).map((c) => c.issueKey), []);
  // And the wording says WHICH hosts are full.
  const { error, full } = hub.findTicketHost(site, "Turma", "ENG-5", { requireFree: true });
  assert.equal(full, true);
  assert.match(error, /has triaged that ticket to Turma has its session slots full/);
  ticketQueue.length = 0;
});

test("XERK-325: spawnRefusals is coerced, since Android types it", async () => {
  // A full /api/agents decode is atomic on Android, so one bad entry from the
  // state.json restore (served before any host re-beats, and NOT stripped from
  // the payload like the other caches) would fail the whole fleet array.
  // Driven through normalizeRecord, not the leaf: the wiring is the half that
  // can go missing, and calling the coercion directly passes with it unhooked.
  const bad = { device: "old", spawnRefusals: "not-a-map" };
  hub.normalizeRecord(bad);
  assert.deepEqual(bad.spawnRefusals, {});

  const mixed = { device: "old", spawnRefusals: {
    ok: { error: "no triaged repo", at: 123 },
    numericError: { error: 12345, at: 5 },        // reason unusable, refusal real
    badAt: { error: "x", at: "yesterday" },       // cannot be aged out — dropped
    notAnObject: 7,
  } };
  hub.normalizeRecord(mixed);
  assert.deepEqual(Object.keys(mixed.spawnRefusals).sort(), ["numericError", "ok"]);
  assert.deepEqual(mixed.spawnRefusals.ok, { error: "no triaged repo", at: 123 });
  // Coerced to the default the ingest uses, never to a fabricated reason.
  assert.equal(mixed.spawnRefusals.numericError.error, "the agent refused it");
  // A dangerous key name never becomes an entry, and never re-points the
  // record's prototype — the keys come off a file this coercion exists to
  // distrust, and JSON can express any of them.
  const proto = { device: "old", spawnRefusals: JSON.parse(
    '{"__proto__":{"error":"x","at":1},"constructor":{"error":"y","at":1},' +
    '"c9":{"error":"real","at":2}}') };
  hub.normalizeRecord(proto);
  assert.deepEqual(Object.keys(proto.spawnRefusals), ["c9"]);
  assert.equal(Object.getPrototypeOf(proto.spawnRefusals), Object.prototype,
    "same shape as the ingest path builds, not a null-prototype special case");
  assert.equal(typeof ({}).error, "undefined", "Object.prototype is untouched");
  // The COUNT is bounded here too, not just at the ingest. The restore is the
  // one path this coercion exists for, and a map it serves is served on every
  // /api/agents until that host next beats — a host that never beats again
  // serves it forever. Oldest go first, like the ingest's own eviction.
  const flood = { device: "old", spawnRefusals: {} };
  for (let i = 0; i < 3000; i++) flood.spawnRefusals["c" + i] = { error: "x", at: i };
  hub.normalizeRecord(flood);
  const kept = Object.keys(flood.spawnRefusals);
  assert.equal(kept.length, 40);
  assert.equal(kept.includes("c2999"), true, "the newest survive");
  assert.equal(kept.includes("c0"), false, "the oldest are evicted");
  // The reason is length-capped here as well as at the ingest.
  const long = { device: "old", spawnRefusals: { c: { error: "x".repeat(5000), at: 1 } } };
  hub.normalizeRecord(long);
  assert.equal(long.spawnRefusals.c.error.length, 500);
});

test("XERK-325: auto-start reads the ticket list the BOARD shows, not a dead host's", async () => {
  // The sweep is the FIFTH reader of the online-first ranking. Left on freshness
  // alone it failed twice over: it queued tickets present only in an OFFLINE
  // host's fresher block — which no card shows, so the entry has no chip and no
  // way to cancel it — while never starting the To Do tickets on screen.
  // SAME Jira user on both hosts — the documented common case (an org's agents
  // share one token), where the board keeps ONE winning block rather than
  // unioning. The other user's case is the test below.
  resetAutoStart();
  const site = "tq325j.atlassian.net";
  const user = "shared@x.com";
  await asBeat("tq325jDown", site, { autoStart: false, capacity: ROOMY, user,
    fetchedAt: "2026-07-14T12:30:00Z",                                // freshest
    tickets: [{ key: "GHOST-1", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true },
                triage: { priority: "P2", type: "task", actionable: true } }] });
  agents.tq325jDown.lastSeen = Date.now() - 10 * 60 * 1000;
  await asBeat("tq325jUp", site, { autoStart: false, capacity: ROOMY, user,
    fetchedAt: "2026-07-14T12:00:00Z",                                // staler
    tickets: [{ key: "SEEN-1", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true },
                triage: { priority: "P2", type: "task", actionable: true } }] });
  setAutoStartOrg(site, true);
  autoStartSweep();
  assert.deepEqual(ticketQueue.filter((e) => e.siteKey === site).map((e) => e.issueKey),
    ["SEEN-1"], "the visible ticket is queued, and the invisible one is not");
  drainTicketQueue();
  assert.deepEqual((agents.tq325jUp.commands || []).map((c) => c.issueKey), ["SEEN-1"]);
  ticketQueue.length = 0;
});

test("XERK-325: a strictly newer `updated` beats block rank, as mergeSites does", async () => {
  // The two hosts' copies of a ticket normally carry an IDENTICAL `updated` (it
  // is the tracker's own field), so this override only fires when the fleet is
  // mid-poll — and it was the one piece of mergeSites parity with no test, which
  // meant it could be deleted outright with the suite still green.
  resetAutoStart();
  const site = "tq325o.atlassian.net";
  // Fresher BLOCK, older copy of the ticket.
  await asBeat("tq325oFreshBlock", site, { autoStart: false, capacity: ROOMY,
    user: "a@x.com", fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T08:00:00.000+0000",
                repoGuess: { repo: "Stale", cloned: true } }] });
  // Staler block, but a strictly newer copy of the ticket — what the board shows.
  await asBeat("tq325oNewTicket", site, { autoStart: false, capacity: ROOMY,
    user: "b@x.com", fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T11:00:00.000+0000",
                repoGuess: { repo: "Fresh", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.body.repo, "Fresh",
    "the newer ticket copy decides the repo, not the fresher block");
});

test("XERK-325: the SWEEP resolves the repo off the row too, not a rank of its own", async () => {
  // `ticketRepo` feeds three routes and only the POST was pinned: a divergent
  // freshness-only resolver wired into the sweep and the drain passed the whole
  // suite while auto-starting a ticket the board shows UNTRIAGED. This is the
  // sweep half — the winning copy carries no repoGuess, so the card shows no
  // chip and no Start button, and the hub must not invent one from a losing block.
  resetAutoStart();
  const site = "tq325p.atlassian.net";
  await asBeat("tq325pWinner", site, { autoStart: false, capacity: ROOMY,
    user: "shared@x.com", fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo" }] });        // no repoGuess
  await asBeat("tq325pLoser", site, { autoStart: false, capacity: ROOMY,
    user: "shared@x.com", fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  setAutoStartOrg(site, true);
  autoStartSweep();
  assert.deepEqual(ticketQueue.filter((e) => e.siteKey === site).map((e) => e.issueKey), [],
    "the board shows it untriaged, so the sweep must not start it");
  drainTicketQueue();
  for (const h of ["tq325pWinner", "tq325pLoser"]) {
    assert.deepEqual((agents[h].commands || []).map((c) => c.type), [], h);
  }
  ticketQueue.length = 0;
});

test("XERK-325: the DRAIN resolves the repo off the row too", async () => {
  // The third route, and it needs a fixture where the two resolvers genuinely
  // DISAGREE — an earlier version of this test used one where they happened to
  // agree, so it pinned nothing. Here the winning copy carries no repoGuess (the
  // card shows the ticket untriaged), so a rank of its own resurrects a losing
  // block's guess and dispatches a session against a repo nobody was shown; the
  // row says untriaged, and the entry must hold as blocked instead.
  resetAutoStart();
  const site = "tq325q.atlassian.net";
  await asBeat("tq325qWinner", site, { autoStart: false, capacity: ROOMY,
    user: "shared@x.com", fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo" }] });        // no repoGuess
  await asBeat("tq325qLoser", site, { autoStart: false, capacity: ROOMY,
    user: "shared@x.com", fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  // Queued directly: the POST would refuse it (409, no triaged repo), which is
  // the same rule from the other end — this exercises the DRAIN's own read.
  assert.ok(enqueueTicketStart(site, "ENG-5", "manual"));
  drainTicketQueue();
  for (const h of ["tq325qWinner", "tq325qLoser"]) {
    assert.deepEqual((agents[h].commands || []).map((c) => c.type), [],
      `${h} must not be dispatched a spawn for a ticket the card shows untriaged`);
  }
  const e = queuedTicket(site, "ENG-5");
  assert.equal(e && e.reason, "blocked");
  assert.match(e.error, /no triaged repo/);
  ticketQueue.length = 0;
});

test("XERK-325: the sweep and drain honour the newer `updated` too, not just the winner", async () => {
  // The two route tests above pin "winning copy untriaged -> invent nothing".
  // They do NOT pin "winning copy triaged DIFFERENTLY -> don't use the other
  // one", which is the other way the row and a block rank disagree — and a
  // resolver dropping only the `updated` override passed the whole suite while
  // dispatching a repo the card never showed.
  resetAutoStart();
  const site = "tq325r.atlassian.net";
  // Staler BLOCK, but a strictly newer copy of the ticket — this is the row.
  await asBeat("tq325rRow", site, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T12:00:00Z", repos: ["Turma"],
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T11:00:00.000+0000",
                repoGuess: { repo: "Turma", cloned: true },
                triage: { priority: "P2", type: "task", actionable: true } }] });
  // Fresher block, older copy — the answer a block rank would give.
  await asBeat("tq325rRank", site, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T12:30:00Z", repos: ["Veiller"],
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T08:00:00.000+0000",
                repoGuess: { repo: "Veiller", cloned: true },
                triage: { priority: "P2", type: "task", actionable: true } }] });
  // The DRAIN route.
  assert.ok(enqueueTicketStart(site, "ENG-5", "manual"));
  drainTicketQueue();
  assert.deepEqual((agents.tq325rRow.commands || []).map((c) => c.issueKey), ["ENG-5"],
    "routed to the host holding the repo the card shows");
  assert.deepEqual((agents.tq325rRank.commands || []).map((c) => c.issueKey), []);
  ticketQueue.length = 0;
  agents.tq325rRow.commands = [];

  // The SWEEP route, same fixture.
  setAutoStartOrg(site, true);
  autoStartSweep();
  drainTicketQueue();
  assert.deepEqual((agents.tq325rRow.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.deepEqual((agents.tq325rRank.commands || []).map((c) => c.issueKey), []);
  ticketQueue.length = 0;
});

test("XERK-325: an UNTRIAGED copy winning on `updated` is still untriaged", async () => {
  // The third divergence class, and the intersection of the two above: the
  // pinned cases are untriaged-winner-by-BLOCK-RANK and triaged-differently-by-
  // `updated`. A resolver preferring a triaged older copy over an untriaged newer
  // one satisfies both and still dispatches a repo the card shows as untriaged.
  //
  // Ordinary fleet shape, not an edge case: a ticket is edited in Jira, the host
  // that re-polled first has not triaged the new copy yet, and the other still
  // holds the older triaged one.
  resetAutoStart();
  const site = "tq325t.atlassian.net";
  await asBeat("tq325tFresh", site, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T11:00:00Z",
    tickets: [{ key: "ENG-9", statusCategory: "todo",
                updated: "2026-07-14T12:00:00.000+0000" }] });   // newer, untriaged
  await asBeat("tq325tStale", site, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "ENG-9", statusCategory: "todo",
                updated: "2026-07-14T08:00:00.000+0000",
                repoGuess: { repo: "RepoOld", cloned: true } }] });
  // The POST refuses it, because the card shows no chip.
  const r = await startTicket(site, "ENG-9");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no triaged repo/);
  // And the DRAIN holds it rather than reviving the older triaged copy.
  assert.ok(enqueueTicketStart(site, "ENG-9", "manual"));
  drainTicketQueue();
  for (const h of ["tq325tFresh", "tq325tStale"]) {
    assert.deepEqual((agents[h].commands || []).map((c) => c.type), [], h);
  }
  const e = queuedTicket(site, "ENG-9");
  assert.equal(e && e.reason, "blocked");
  ticketQueue.length = 0;
});

test("XERK-325: `updated` is compared as a STRING, like both client mirrors", async () => {
  // `Date.parse` is the plausible "compare timestamps properly" edit and it
  // escapes every other test here: it disagrees on mixed `+0000`/`Z` spellings,
  // and on an absent `updated` it yields NaN, so every comparison goes false and
  // the override silently stops firing. Both client mirrors string-compare.
  resetAutoStart();
  const site = "tq325u.atlassian.net";
  // Same instant, two spellings. As strings "2026-07-14T12:00:00.000+0000" sorts
  // BELOW "2026-07-14T12:00:00.000Z" ('+' < 'Z'), so the Z copy is the row;
  // Date.parse calls them equal and first-wins by block rank would give Offset.
  await asBeat("tq325uZ", site, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T11:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T12:00:00.000Z",
                repoGuess: { repo: "Zulu", cloned: true } }] });
  await asBeat("tq325uOffset", site, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T12:30:00Z",                       // fresher block
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T12:00:00.000+0000",
                repoGuess: { repo: "Offset", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.body.repo, "Zulu",
    "string order decides, not Date.parse — which would call these equal");
});

test("XERK-325: a copy with NO `updated` never overrides one that has it", async () => {
  // The fourth divergence class, and the one the rules paragraph predicted.
  // Dropping the `|| ""` fallback — the most plausible "that's redundant" edit —
  // makes `String(null)`/`String(undefined)` sort ABOVE every ISO date, so a copy
  // with no `updated` wins outright. It is a real shape, not a contrived one:
  // `hub-agent.py` writes `fields.get("updated")` and `System.ChangedDate`
  // straight through, both of which can be null, and the hub coerces neither.
  resetAutoStart();
  const site = "tq325v.atlassian.net";
  // Fresher block, so it is seen FIRST: untriaged, and carrying no `updated`.
  await asBeat("tq325vNull", site, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo", updated: null }] });
  await asBeat("tq325vReal", site, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T12:00:00Z", repos: ["Turma"],
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T11:00:00.000+0000",
                repoGuess: { repo: "Turma", cloned: true } }] });
  // Withheld work: without the fallback this 409s while the card shows Turma.
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.status, 200);
  assert.equal(r.body.repo, "Turma");

  // And the wrong-repo half: both copies triaged, the null one in the fresher
  // block. The copy that HAS an `updated` is still the row.
  const site2 = "tq325w.atlassian.net";
  await asBeat("tq325wNull", site2, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T12:30:00Z", repos: ["Veiller"],
    tickets: [{ key: "ENG-5", statusCategory: "todo", updated: null,
                repoGuess: { repo: "Veiller", cloned: true } }] });
  await asBeat("tq325wReal", site2, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T12:00:00Z", repos: ["Turma"],
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                updated: "2026-07-14T11:00:00.000+0000",
                repoGuess: { repo: "Turma", cloned: true } }] });
  const r2 = await startTicket(site2, "ENG-5");
  assert.equal(r2.body.repo, "Turma", "the copy carrying an `updated` is the row");
});

test("XERK-325: `fetchedAt` is compared with `>`, and the board agrees", async () => {
  // Nothing pinned the OPERATOR, so reverting either side to localeCompare
  // passed every test and silently re-opened the divergence. The two disagree on
  // a trailing `Z` vs `z`: `>` makes the lowercase copy win (0x7a > 0x5a),
  // ICU collation makes the uppercase one. Asserting the `>` outcome pins the
  // hub; `board.test.js` pins the same fixture on the client side.
  resetAutoStart();
  const site = "tq325s.atlassian.net";
  await asBeat("tq325sUpper", site, { autoStart: false, capacity: ROOMY,
    user: "shared@x.com", fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Upper", cloned: true } }] });
  await asBeat("tq325sLower", site, { autoStart: false, capacity: ROOMY,
    user: "shared@x.com", fetchedAt: "2026-07-14T12:00:00z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Lower", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.body.repo, "Lower",
    "code-unit order, not ICU collation — the mirrors all use `>`");
});

test("XERK-325: auto-start sees BOTH Jira users' tickets, as the board does", async () => {
  // A host polls as `assignee = currentUser()`, so an org whose hosts
  // authenticate as different users reports different lists and the board UNIONS
  // them. Resolving the org to one block left the other user's tickets sitting
  // on the board in To Do, never started, with nothing to say why.
  resetAutoStart();
  const site = "tq325m.atlassian.net";
  await asBeat("tq325mA", site, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T12:30:00Z",
    tickets: [{ key: "AAA-1", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true },
                triage: { priority: "P2", type: "task", actionable: true } }] });
  await asBeat("tq325mB", site, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "BBB-1", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true },
                triage: { priority: "P2", type: "task", actionable: true } }] });
  setAutoStartOrg(site, true);
  autoStartSweep();
  assert.deepEqual(
    ticketQueue.filter((e) => e.siteKey === site).map((e) => e.issueKey).sort(),
    ["AAA-1", "BBB-1"]);
  ticketQueue.length = 0;
});

test("XERK-325: auto-STOP sees the other Jira user's Done too", async () => {
  // The same grouping bug on the sweep that KILLS: a Done the board plainly
  // displayed never stopped its session, because the ticket belonged to the
  // other user and the org resolved to one block.
  resetAutoStart();
  const site = "tq325n.atlassian.net";
  const sess = { id: "s-other", status: "running", repo: "Turma",
                 ticket: { key: "BBB-9", siteKey: site } };
  await asBeat("tq325nA", site, { autoStart: false, capacity: ROOMY, user: "a@x.com",
    fetchedAt: "2026-07-14T12:30:00Z", sessions: [sess],
    tickets: [{ key: "AAA-9", statusCategory: "todo" }] });
  await asBeat("tq325nB", site, { autoStart: false, capacity: ROOMY, user: "b@x.com",
    fetchedAt: "2026-07-14T12:00:00Z",
    tickets: [{ key: "BBB-9", statusCategory: "done" }] });
  autoStopSweep();
  assert.deepEqual((agents.tq325nA.commands || []).map((c) => c.type), ["kill"]);
});

test("XERK-325: auto-STOP does not kill a session over a Done only a dead host reports", async () => {
  // The sweep KILLS, so ranking it differently from the board is the most
  // damaging divergence of the set: the operator's running session ended for a
  // status no card anywhere displayed, with nothing on screen saying why.
  resetAutoStart();
  const site = "tq325k.atlassian.net";
  const sess = { id: "s-live", status: "running", repo: "Turma",
                 ticket: { key: "ENG-5", siteKey: site } };
  await asBeat("tq325kDown", site, { autoStart: false, capacity: ROOMY, user: "shared@x.com",
    fetchedAt: "2026-07-14T12:30:00Z",                                // freshest
    tickets: [{ key: "ENG-5", statusCategory: "done" }] });
  agents.tq325kDown.lastSeen = Date.now() - 10 * 60 * 1000;
  await asBeat("tq325kUp", site, { user: "shared@x.com", autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:00:00Z", sessions: [sess],             // staler
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  autoStopSweep();
  assert.deepEqual((agents.tq325kUp.commands || []).map((c) => c.type), [],
    "the board shows ENG-5 in To Do, so nothing may be killed for it");
  // And the reverse still works: once the ONLINE host reports Done, it stops.
  await asBeat("tq325kUp", site, { user: "shared@x.com", autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:40:00Z", sessions: [sess],
    tickets: [{ key: "ENG-5", statusCategory: "done" }] });
  autoStopSweep();
  assert.deepEqual((agents.tq325kUp.commands || []).map((c) => c.type), ["kill"]);
});

test("XERK-325: a queued click is not dropped over a Done only a dead host reports", async () => {
  // `fleetTicketRows` feeds the drainer's "its ticket moved to Done" check, so
  // ranking it on freshness alone accepted the click with `{queued:true,
  // position:1}` and discarded it within one beat — silently, since the drop is
  // a log line and the entry simply vanishes from the payload.
  resetAutoStart();
  const site = "tq325l.atlassian.net";
  await asBeat("tq325lDown", site, { autoStart: false, capacity: ROOMY, user: "shared@x.com",
    fetchedAt: "2026-07-14T12:30:00Z",                                // freshest
    tickets: [{ key: "ENG-5", statusCategory: "done" }] });
  agents.tq325lDown.lastSeen = Date.now() - 10 * 60 * 1000;
  await asBeat("tq325lUp", site, { user: "shared@x.com", autoStart: false, capacity: FULL,
    fetchedAt: "2026-07-14T12:00:00Z",                                // staler
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.body.queued, true);
  drainTicketQueue();
  assert.ok(queuedTicket(site, "ENG-5"),
    "the board still shows it in To Do, so the click survives the drain");
  // A Done from the ONLINE host still retires it, as it always did.
  await asBeat("tq325lUp", site, { user: "shared@x.com", autoStart: false, capacity: FULL,
    fetchedAt: "2026-07-14T12:40:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "done" }] });
  drainTicketQueue();
  assert.equal(queuedTicket(site, "ENG-5"), null);
  ticketQueue.length = 0;
});

test("XERK-325: only the shared resolvers may read a block's ticket list", () => {
  // A TRIPWIRE, not a proof — read the limits below before trusting it.
  //
  // The ranking diverged three times, every time because a new site walked the
  // agents map and re-derived the board's view instead of calling the shared
  // resolver. A behavioural test catches that only once some fleet shape happens
  // to exercise the new site, so this is the structural half: the thing such a
  // site must do to exist at all is read a tracker block's `tickets`. Two
  // functions may — `fleetTicketRows` (the board's own view, which everything
  // else reads, `ticketRepo` included) and `hostTriagedTicket` (can THIS host run
  // it: a per-host question with no ranking in it) — and a third is the defect.
  //
  // WHAT IT DOES NOT CATCH, measured rather than guessed — QA escaped earlier
  // versions eight ways. Now covered: bracket notation, destructuring, an
  // arrow-`const`, an `async`/`export`/indented `function` (each of which used to
  // be invisible to the declaration scan and got its read blamed on the previous
  // declaration), a divergent walk added BESIDE a legitimate `fleetTicketRows()`
  // call.
  //
  // Still open, stated as the CLASS rather than a list of instances — the list
  // was enumerated twice and was incomplete both times, so it will age again:
  //   - a COMPUTED key (`j["tick" + "ets"]`), which escapes in EVERY position;
  //   - a resolver in ANOTHER FILE, since this greps `server.js` alone;
  //   - **any declaration form `DECL` does not match, sitting directly after an
  //     allow-listed declaration** so the attribution lands on that name.
  //     Measured examples: an object-literal method, a class method, an
  //     object-literal arrow property, a bare `x = function …` assignment, an
  //     IIFE, and a getter. All are caught in any other position;
  //   - a divergent re-rank written INSIDE an allow-listed function, where the
  //     attribution is correct and simply permissive. Not a `DECL` miss, so no
  //     amount of pattern work reaches it. Measured on two shapes — a
  //     freshest-block-wins re-rank inside `fleetTicketRows`, and a
  //     grouping-kept freshness-only one — this test passes both while 8-9
  //     behavioural tests fail. The same re-rank inside a NON-allow-listed
  //     function does trip it, so the boundary is the allow-list, not the read.
  //
  // So it is a tripwire for the honest edit, not a proof. **The guarantee lives
  // in the behavioural tests above** — the two-user, ghost, auto-stop,
  // queued-click, and the sweep/drain repo-resolution cases, which do catch the
  // computed-key version on every route. A change that keeps those green while
  // making this fail is a naming problem, not a bug; say so here rather than
  // widening the pattern until it means nothing.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  // Dot, bracket and destructured reads alike.
  const READ = /\.tickets\b|\[\s*["']tickets["']\s*\]|\{[^{}]*\btickets\b[^{}]*\}\s*=/g;
  // Named functions AND `const x = (…) =>` / `= function`, so an arrow is
  // attributed to itself rather than to whatever declaration sits above it.
  // Anchored at the START of a line, tolerating leading whitespace and `async`/
  // `export` — without the anchor an inner `const t = (…)` claims the
  // attribution, and with too STRICT an anchor (`^function` alone) an
  // `async function` or a one-space-indented one is invisible and its read is
  // blamed on whatever declaration precedes it.
  // The two forms are anchored DIFFERENTLY on purpose. A `function` declaration
  // may be indented and may be `async`/`export`/generator — a one-space indent or
  // a bare `async` was an escape, since the read then got blamed on whatever
  // declaration preceded it. An arrow-`const` must be at column 0, because inner
  // ones are always indented and would otherwise claim their enclosing
  // function's reads (`hostTriagedTicket`'s own `const t = (…)` is the case).
  const DECL = new RegExp(
    "^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(\\w+)\\s*\\("
    + "|^(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:async\\s+)?(?:function\\b|\\()",
    "gm");
  const readers = [];
  for (const m of code.matchAll(READ)) {
    const decls = [...code.slice(0, m.index).matchAll(DECL)];
    const last = decls[decls.length - 1];
    readers.push(last ? (last[1] || last[2]) : "(top level)");
  }
  // `normalizeJira` reads `tickets` but is NOT a ranking site — it is the
  // ingest/restore COERCION pass (XERK-481) that sanitizes each ticket's typed
  // `triage` block in place, exactly as normalizeSessions does for `sessions`.
  // It resolves no repo and picks no host, so it is on the allow-list beside the
  // two resolvers rather than being a new ranking site to route through them.
  assert.deepEqual([...new Set(readers)].sort(),
    ["fleetTicketRows", "hostTriagedTicket", "normalizeJira"],
    "a new reader of a block's ticket list is a new ranking site — route it "
    + "through fleetTicketRows instead. (If this is an unrelated `tickets` "
    + "field, or a non-ranking coercion pass like normalizeJira, say so here "
    + "rather than widening the pattern.)");

  // The other half of agreeing with the board is the GROUPING, not just the
  // tie-break, and it is the one that broke most recently: both sweeps must read
  // the board's view rather than resolving an org to a block of their own.
  for (const fn of ["function autoStartSweep(", "function autoStopSweep("]) {
    const at = code.indexOf(fn);
    assert.ok(at > -1, `${fn} must be locatable`);
    const body = code.slice(at, code.indexOf("\n}", at));
    assert.match(body, /fleetTicketRows\(\)|ticketRowsForSite\(/,
      `${fn} must resolve tickets through fleetTicketRows, not its own walk`);
  }
});

test("XERK-325: the drainer re-checks triage, so a decision landing later dispatches", async () => {
  // The common case is a race, not a permanent disagreement: a new ticket is
  // untriaged on a host for the few minutes its batch takes. The queue must pick
  // it up on the beat the decision lands rather than having given up.
  resetAutoStart();
  const site = "tq325f.atlassian.net";
  await asBeat("tq325fLate", site, { autoStart: false, capacity: FULL,
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  await asBeat("tq325fFree", site, { autoStart: false, capacity: ROOMY,
    tickets: [{ key: "ENG-5", statusCategory: "todo" }] });          // untriaged
  const r = await startTicket(site, "ENG-5");
  assert.equal(r.body.queued, true, "the only triaged host is full, so it waits");
  drainTicketQueue();
  assert.deepEqual((agents.tq325fFree.commands || []).map((c) => c.issueKey), []);
  // Its triage batch comes back and it publishes the same repo.
  await asBeat("tq325fFree", site, { autoStart: false, capacity: ROOMY,
    fetchedAt: "2026-07-14T12:05:00Z",
    tickets: [{ key: "ENG-5", statusCategory: "todo",
                repoGuess: { repo: "Turma", cloned: true } }] });
  drainTicketQueue();
  assert.deepEqual((agents.tq325fFree.commands || []).map((c) => c.issueKey), ["ENG-5"]);
  assert.equal(queuedTicket(site, "ENG-5"), null, "and the entry retires with the dispatch");
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

// ---- auto-merge + auto-close (XERK-550) ------------------------------------
// For orgs that opt in, the hub MERGES a merge-ready PR of an auto-start-eligible
// ticket session, then moves the ticket to Done and kills the session to free
// its slot — the review/merge/close bottleneck removed for the bug class the org
// already auto-starts. The merge itself is an agent command (gh auth lives
// there); the hub decides which PRs and does the close+kill.
const PR1 = "https://github.com/x/y/pull/1";
const resetMerge = () => {
  autoMergeState.clear();
  autoClosed.clear();
  autoStopped.clear();
  for (const k of Object.keys(autoMergeOrgs)) delete autoMergeOrgs[k];
};
// A running ticket session in an opted-in org with one PR. Defaults: idle
// (paneBusy false), an actionable bug (auto-start-eligible), a merge-ready OPEN
// PR — the state the hub acts on.
const mergeBeat = async (device, site, {
  autoMerge = true, ready = "ready", state = "OPEN", mergeable = "MERGEABLE",
  paneBusy = false, ticketType = "bug", statusCategory = "inprogress",
  question, prs, tickets, url = PR1,
} = {}) => {
  const r = await asBeat(device, site, {
    autoStart: false,
    tickets: tickets || [{ key: "ENG-9", summary: "A bug", statusCategory,
      repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: ticketType, actionable: true } }],
    sessions: [{ id: "sm1", status: "running",
      ticket: { key: "ENG-9", siteKey: site },
      prs: prs || [{ url, state, ready, mergeable }],
      session: { transcriptAgeSec: 30, paneBusy,
                 ...(question ? { question } : {}) } }],
  });
  setAutoMergeOrg(site, autoMerge);
  return r;
};
const cmds = (device) => (agents[device].commands || []).map((c) => [c.type, c.sessionId || c.issueKey, c.url || c.category]);

test("automerge route: sets/clears the org opt-in and rides the payload + SSE", async () => {
  resetMerge();
  await asBeat("amR", "amr.atlassian.net", { autoStart: false });
  let r = await request("POST", "/api/jira/amr.atlassian.net/automerge",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, enabled: true });
  assert.equal(autoMergeOrgs["amr.atlassian.net"], true);
  let list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(list.body.autoMergeOrgs["amr.atlassian.net"], true);
  // Distinct from auto-start: flipping merge on must not turn auto-start on.
  assert.equal(orgsWithAutoStart().has("amr.atlassian.net"), false);

  r = await request("POST", "/api/jira/amr.atlassian.net/automerge",
    { body: { enabled: false }, headers: userHeaders });
  assert.equal(r.status, 200);
  assert.equal("amr.atlassian.net" in autoMergeOrgs, false);
  list = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal("amr.atlassian.net" in (list.body.autoMergeOrgs || {}), false);
});

test("automerge route: rejects a bad body, an unknown org, and no login", async () => {
  resetMerge();
  await asBeat("amV", "amv.atlassian.net", { autoStart: false });
  for (const body of [{}, { enabled: "yes" }, { enabled: 1 }]) {
    const r = await request("POST", "/api/jira/amv.atlassian.net/automerge",
      { body, headers: userHeaders });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  let r = await request("POST", "/api/jira/nobody.atlassian.net/automerge",
    { body: { enabled: true }, headers: userHeaders });
  assert.equal(r.status, 404);
  assert.equal("nobody.atlassian.net" in autoMergeOrgs, false);
  r = await request("POST", "/api/jira/amv.atlassian.net/automerge",
    { body: { enabled: true } });
  assert.equal(r.status, 401);
  assert.equal("amv.atlassian.net" in autoMergeOrgs, false);
});

test("XERK-550: the auto-merge content gate agrees with what auto-start would sweep", async () => {
  resetAutoStart();
  // Four To Do tickets: an eligible bug, a held one, a policy-excluded type, and
  // an untriaged one. Opt the org into BOTH auto-start and auto-merge, run the
  // auto-start round, and assert: a ticket is queued for auto-start IFF the
  // auto-merge content gate calls it eligible. Same predicate, no drift.
  setTriagePolicy("xcheck.atlassian.net", { excludeTypes: ["chore"] });
  setTicketTriageAction("xcheck.atlassian.net", "BUG-2", "hold");
  const tickets = [
    { key: "BUG-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "bug", actionable: true } },
    { key: "BUG-2", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "bug", actionable: true } },
    { key: "CHORE-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true },
      triage: { priority: "P2", type: "chore", actionable: true } },
    { key: "RAW-1", statusCategory: "todo", repoGuess: { repo: "Turma", cloned: true } },
  ];
  await asBeat("xc", "xcheck.atlassian.net", { autoStart: true, tickets });
  setAutoMergeOrg("xcheck.atlassian.net", true);
  autoStartRound();
  const queued = new Set((agents.xc.commands || [])
    .filter((c) => c.type === "spawnTicket").map((c) => c.issueKey));
  const rows = new Map(tickets.map((t) => [t.key, t]));
  for (const key of rows.keys()) {
    const t = rows.get(key);
    const gate = autoStartContentGate("xcheck.atlassian.net", t, "Turma");
    assert.equal(gate === null, queued.has(key),
      `${key}: gate ${gate ? gate.reason : "null"} vs queued=${queued.has(key)}`);
  }
  // The eligible bug is the only one that both queued and gates clean.
  assert.equal(autoStartContentGate("xcheck.atlassian.net", rows.get("BUG-1"), "Turma"), null);
  resetAutoStart();
  delete triagePolicies["xcheck.atlassian.net"];
});

test("XERK-550: an ignore-tier repo is never eligible, even opted in", () => {
  setRepoTier("Junk", "ignore");
  assert.ok(autoStartContentGate("z.atlassian.net",
    { key: "K-1", triage: { type: "bug", actionable: true } }, "Junk"));
  setRepoTier("Junk", "active");
});

test("XERK-550: auto-merge dispatches mergePr for a ready, idle, eligible session", async () => {
  resetMerge();
  await mergeBeat("am1", "am1.atlassian.net", {});
  autoMergeSweep();
  const c = (agents.am1.commands || []).find((x) => x.type === "mergePr");
  assert.ok(c, "expected a mergePr command");
  assert.equal(c.url, PR1);
  assert.equal(c.sessionId, "sm1");
  assert.equal(autoMergeState.get(PR1).attempts, 1);
});

test("XERK-550: auto-merge skips when the org has NOT opted in", async () => {
  resetMerge();
  await mergeBeat("am2", "am2.atlassian.net", { autoMerge: false });
  autoMergeSweep();
  assert.equal((agents.am2.commands || []).filter((c) => c.type === "mergePr").length, 0);
});

test("XERK-550: auto-merge skips a session that is still WORKING", async () => {
  resetMerge();
  await mergeBeat("am3", "am3.atlassian.net", { paneBusy: true });
  autoMergeSweep();
  assert.equal((agents.am3.commands || []).filter((c) => c.type === "mergePr").length, 0);
});

test("XERK-550: auto-merge skips a session blocked on a pending question", async () => {
  resetMerge();
  await mergeBeat("am4", "am4.atlassian.net", { question: { prompt: "which?" } });
  autoMergeSweep();
  assert.equal((agents.am4.commands || []).filter((c) => c.type === "mergePr").length, 0);
});

test("XERK-550: auto-merge skips a PR that is not merge-ready or already landed", async () => {
  resetMerge();
  await mergeBeat("am5", "am5.atlassian.net", { ready: "pending" });
  autoMergeSweep();
  assert.equal((agents.am5.commands || []).filter((c) => c.type === "mergePr").length, 0);
  resetMerge();
  await mergeBeat("am6", "am6.atlassian.net", { state: "MERGED" });
  autoMergeSweep();
  assert.equal((agents.am6.commands || []).filter((c) => c.type === "mergePr").length, 0);
});

test("XERK-550: auto-merge skips a ticket the auto stream would NOT start (untriaged)", async () => {
  resetMerge();
  await mergeBeat("am7", "am7.atlassian.net", {
    tickets: [{ key: "ENG-9", statusCategory: "inprogress",
      repoGuess: { repo: "Turma", cloned: true } }] });  // no triage block
  autoMergeSweep();
  assert.equal((agents.am7.commands || []).filter((c) => c.type === "mergePr").length, 0);
});

test("XERK-550: auto-merge backs off — a second sweep does not re-dispatch", async () => {
  resetMerge();
  await mergeBeat("am8", "am8.atlassian.net", {});
  autoMergeSweep();
  autoMergeSweep();
  assert.equal((agents.am8.commands || []).filter((c) => c.type === "mergePr").length, 1);
});

test("XERK-550: a gh merge refusal (ok:false) marks the PR gaveUp and stops retrying", async () => {
  resetMerge();
  await mergeBeat("am9", "am9.atlassian.net", {});
  autoMergeSweep(); // attempt 1
  // The agent reports the merge was refused (branch protection, review required…).
  ingestMergeResults(agents.am9, [{ cmdId: "c1", url: PR1, ok: false, error: "review required" }]);
  autoMergeSweep(); // folds the failure -> gaveUp
  assert.equal(autoMergeState.get(PR1).gaveUp, true);
  // Even past the backoff window it never retries a gaveUp PR.
  autoMergeState.get(PR1).at = 0;
  autoMergeSweep();
  assert.equal((agents.am9.commands || []).filter((c) => c.type === "mergePr").length, 1);
});

test("XERK-550: auto-merge gives up after too many attempts", async () => {
  resetMerge();
  await mergeBeat("am10", "am10.atlassian.net", {});
  autoMergeState.set(PR1, { at: 0, attempts: 99 }); // already past the cap, backoff elapsed
  autoMergeSweep();
  assert.equal((agents.am10.commands || []).filter((c) => c.type === "mergePr").length, 0);
  assert.equal(autoMergeState.get(PR1).gaveUp, true);
});

test("XERK-550: ingestMergeResults caches by cmdId and is stripped from the payload", async () => {
  resetMerge();
  await mergeBeat("am11", "am11.atlassian.net", {});
  ingestMergeResults(agents.am11, [{ cmdId: "cX", url: PR1, ok: true }]);
  assert.deepEqual(
    { url: agents.am11.mergeResults.cX.url, ok: agents.am11.mergeResults.cX.ok },
    { url: PR1, ok: true });
  const list = await request("GET", "/api/agents", { headers: userHeaders });
  const rec = list.body.agents.find((a) => a.key === "am11");
  assert.ok(!("mergeResults" in rec), "mergeResults leaked into /api/agents");
});

test("XERK-550: auto-close moves an all-merged ticket to Done AND kills the session", async () => {
  resetMerge();
  await mergeBeat("amC", "amc.atlassian.net", { state: "MERGED" });
  autoCloseSweep();
  const got = cmds("amC");
  assert.ok(got.some(([t, , cat]) => t === "setTicketStatus" && cat === "done"),
    `expected a Done write, got ${JSON.stringify(got)}`);
  assert.ok(got.some(([t, sid]) => t === "kill" && sid === "sm1"),
    `expected a kill, got ${JSON.stringify(got)}`);
});

test("XERK-550: auto-close is idempotent across repeated sweeps", async () => {
  resetMerge();
  await mergeBeat("amC2", "amc2.atlassian.net", { state: "MERGED" });
  autoCloseSweep();
  autoCloseSweep();
  const got = cmds("amC2");
  assert.equal(got.filter(([t]) => t === "setTicketStatus").length, 1);
  assert.equal(got.filter(([t]) => t === "kill").length, 1);
});

test("XERK-550: auto-close waits until EVERY PR has landed", async () => {
  resetMerge();
  await mergeBeat("amC3", "amc3.atlassian.net", { prs: [
    { url: PR1, state: "MERGED", ready: "ready", mergeable: "MERGEABLE" },
    { url: "https://github.com/x/y/pull/2", state: "OPEN", ready: "ready", mergeable: "MERGEABLE" },
  ] });
  autoCloseSweep();
  assert.equal((agents.amC3.commands || []).length, 0);
});

test("XERK-550: auto-close does nothing without an actually-merged PR (all CLOSED)", async () => {
  resetMerge();
  await mergeBeat("amC4", "amc4.atlassian.net", { state: "CLOSED" });
  autoCloseSweep();
  assert.equal((agents.amC4.commands || []).length, 0);
});

// --- regressions the QA pass caught (XERK-550) ---

test("XERK-550: a ticket a human moved to Done is NOT auto-merged", async () => {
  // autoStopSweep only QUEUES the kill, so the session still reads running this
  // beat — the Done column, not the run state, must stand the merge down. Else a
  // human's abandon/reject gesture would still land the PR on main.
  resetMerge();
  await mergeBeat("amD", "amd.atlassian.net", { statusCategory: "done" });
  autoMergeSweep();
  autoCloseSweep();
  assert.equal((agents.amD.commands || []).filter((c) => c.type === "mergePr").length, 0);
  assert.equal((agents.amD.commands || []).filter((c) => c.type === "setTicketStatus").length, 0);
});

test("XERK-550: a DRAFT PR is never auto-merged (would gaveUp forever)", async () => {
  // _merge_ready calls a green+MERGEABLE DRAFT "ready", but gh refuses to merge a
  // draft — which would mark it gaveUp permanently, excluding the session for
  // good even after it marks the PR ready. Only OPEN PRs are merged.
  resetMerge();
  const draftUrl = "https://github.com/x/y/pull/990";  // unique: other tests' leftover sessions share PR1
  await mergeBeat("amDr", "amdr.atlassian.net", { state: "DRAFT", ready: "ready", url: draftUrl });
  autoMergeSweep();
  assert.equal((agents.amDr.commands || []).filter((c) => c.type === "mergePr").length, 0);
  assert.equal(autoMergeState.has(draftUrl), false);  // not even attempted
});

test("XERK-550: auto-close does NOT kill when the Done write cannot be dispatched", async () => {
  // No board-cred host can take the setTicketStatus (here: the only host is too
  // old for it). Killing anyway would orphan the ticket In Progress with a merged
  // PR and no session, forever. So stand down and retry — never kill.
  resetMerge();
  await mergeBeat("amO", "amo.atlassian.net", { state: "MERGED" });
  agents.amO.unsupported = { setTicketStatus: Date.now() };  // agentGapError -> truthy
  autoCloseSweep();
  assert.equal((agents.amO.commands || []).length, 0, "must neither write Done nor kill");
  // Once the host can write again, it closes + kills.
  delete agents.amO.unsupported;
  autoCloseSweep();
  const types = (agents.amO.commands || []).map((c) => c.type).sort();
  assert.deepEqual(types, ["kill", "setTicketStatus"]);
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

  // Select the arm/re-arm frames by CONTENT, never by frame index. The control
  // channel also multiplexes keepalive {ping} frames, and under the full-tree
  // CI run's load a ping can interleave between the arm and the re-arm — a fixed
  // index then picks up the ping and the test flakes (XERK-454, a timing flake,
  // not an ordering bug: the re-arm itself is always correct). Watch frames are
  // the only ones carrying a `watch` field, so filter to those.
  const watchArms = () =>
    ctrlFrames
      .filter((f) => f.op === 0x1)
      .map((f) => { try { return JSON.parse(f.payload.toString("utf8")); } catch { return null; } })
      .filter((m) => m && m.watch === "ms1");

  // finally, not a tail of straight-line destroys: an open socket keeps the
  // run's event loop alive, so a failing assertion here would hang the suite
  // instead of reporting itself.
  try {
    await waitFor(() => watchArms().length >= 1);
    assert.equal(watchArms()[0].transcriptId, "conv-one");

    // A beat reporting the same transcript is not a move — nothing is re-sent.
    await beat("conv-one");
    // The restart lands: a new conversation, so the watch follows it.
    await beat("conv-two");
    await waitFor(() => watchArms().some((m) => m.transcriptId === "conv-two"));

    // Exactly two watch frames — the initial conv-one arm and the conv-two
    // re-arm — which is also what proves the unchanged beat above re-sent
    // nothing: a spurious re-arm would add a second conv-one frame.
    const arms = watchArms();
    assert.deepEqual(arms.map((m) => m.transcriptId), ["conv-one", "conv-two"]);
    assert.equal(arms[1].watch, "ms1");
    assert.equal(arms[1].worktreePath, "/wt/ms1");
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

test("SSE /api/events: a sweep's queued tickets cost ONE ticketQueue frame (XERK-296)", async () => {
  // The sweep queues one ticket at a time, so a frame per entry cost every open
  // board a frame — and the whole queue's JSON — per ticket: 201 frames and
  // 2.8 MB for a single 200-ticket backlog. The cache is still invalidated
  // synchronously; only the broadcast coalesces to the end of the turn.
  ticketQueue.length = 0;
  const { req, res } = await sseConnect(userHeaders);
  assert.equal(res.statusCode, 200);
  const events = collectSse(res);
  // Measured as a DELTA, not an absolute count: a broadcast another case
  // coalesced can still be in flight when this one connects, and under a loaded
  // full-suite run it lands here. Settle first, then count only what our own
  // enqueues produce.
  await new Promise((r) => setTimeout(r, 50));
  const frames = () => events.filter((e) => e.event === "ticketQueue");
  const before = frames().length;
  for (let i = 0; i < 12; i++) {
    enqueueTicketStart("sseq.atlassian.net", `SSE-${i}`, "manual");
  }
  await waitFor(() => frames().length > before);
  await new Promise((r) => setTimeout(r, 50));   // let any stragglers arrive
  const mine = frames().slice(before);
  assert.equal(mine.length, 1, `12 enqueues in one pass sent ${mine.length} frames`);
  assert.equal(JSON.parse(mine[0].data).length, 12, "and the one frame is the whole queue");
  ticketQueue.length = 0;
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
    //
    // This direction is robust against event-loop jitter (unlike the "kept"
    // test below, XERK-450): it only needs the drop to land INSIDE a window many
    // times the dead-after (CONTROL_DEAD_AFTER_MS≈400ms, drop observed ~450ms,
    // window 3000ms), and a stall only ever DELAYS the drop — so a real timer is
    // fine here where a survival assertion would flake.
    const closed = await new Promise((resolve) => {
      socket.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    assert.ok(closed, "hub kept a silent (half-open) control channel forever");
  } finally {
    socket.destroy();
  }
});

// Yield to the REAL event loop so socket bytes queued by the last mocked tick get
// read/written; setImmediate is deliberately left un-mocked below so this pumps
// real I/O without advancing the mocked clock.
const pumpIO = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

// The wound-down liveness env (set at the top of this file), read so the tick
// math below stays in step with it.
const CONTROL_PING_EVERY_MS = Number(process.env.CONTROL_PING_EVERY_MS);
const CONTROL_DEAD_AFTER_MS = Number(process.env.CONTROL_DEAD_AFTER_MS);

// XERK-450: the ONE liveness test that asserts SURVIVAL, driven by node:test
// mock timers instead of a wall-clock wait. The hub's sweep is a setInterval
// computing `idle = Date.now() - lastSeen` and drops the channel once idle
// passes CONTROL_DEAD_AFTER_MS. The old form slept 1500ms of real time and
// asserted "not closed": a single >CONTROL_DEAD_AFTER_MS event-loop stall (a GC
// pause on this suite's large heap, even on an idle box) made the sweep fire
// with a stale `idle` and drop a peer that was in fact answering — a ~7-10%
// flake that silently poisons any benchmark grading on this suite. Mocking Date
// + setInterval ADVANCES the clock deterministically: only those two APIs are
// faked, so real socket I/O still pumps and the pongs round-trip between ticks,
// while no real stall can advance the mocked `idle`.
//
// This MUST stay the only mock-timers test in the suite: node:test's mock timers
// do not re-capture an interval created inside a pre-existing server's
// connection handler on a SECOND consecutive mock-timers test (the hub's ping
// interval then never fires on ticks). It is the sole such test here on purpose;
// the two liveness tests above deliberately stay on real timers because their
// assertions are robust without it.
test("control WS: a channel that pongs is kept past the dead-after window", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { socket, leftover } = await wsConnect(CONTROL_PATH);
  try {
    let closed = false;
    socket.on("close", () => { closed = true; });
    // Mirror what a real agent's WebSocket does for free: auto-pong every ping.
    // Client->server frames must be masked, so encode the empty pong by hand.
    const parse = wsParser((op) => {
      if (op !== 0x9) return;
      socket.write(Buffer.concat([Buffer.from([0x80 | 0xa, 0x80]), Buffer.from([1, 2, 3, 4])]));
    });
    if (leftover && leftover.length) parse(leftover);
    socket.on("data", parse);
    // Advance well PAST CONTROL_DEAD_AFTER_MS in ping-sized steps, letting each
    // ping's pong round-trip (real I/O) before the next tick — so `lastSeen`
    // stays fresh and the channel must survive every step.
    const steps = Math.ceil((CONTROL_DEAD_AFTER_MS * 3) / CONTROL_PING_EVERY_MS);
    for (let i = 0; i < steps; i++) {
      t.mock.timers.tick(CONTROL_PING_EVERY_MS);
      await pumpIO();
      assert.ok(!closed, "hub dropped a live channel that was answering its pings");
    }
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
      // `site` null models a host with no tracker configured — the shape a
      // Jira-less agent really sends, which has a `jira` block but no siteKey.
      jira: site
        ? { available: true, configured: true, siteKey: site, user: `${device}@x.com`, tickets: [] }
        : { available: false, configured: false, tickets: [] },
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
//
// It TIMES OUT rather than waiting forever. A route that stops answering — the
// spool relay has two failure paths that could, and both were live bugs — would
// otherwise hang whichever test reached it and take the CI job's whole budget
// with it, reported as a timeout with no failing assertion to read. The
// sentinel status makes the assertion that was going to run fail instead.
const RAW_REQUEST_TIMEOUT_MS = 10_000;
// The spool unlink is FIRE-AND-FORGET — `dropMigrationBlob` calls
// `fs.unlink(p, () => {})` and returns — so any assertion that the file is gone
// is racing it. Deliberately so: the comment there explains that dropping the
// name while a reader still holds the fd is the point.
//
// Poll rather than sleep a fixed amount. A fixed 30ms is what two of these
// tests used, and it passes on a quiet laptop and loses on a loaded CI runner,
// which is exactly how this surfaced — one green local run after another and an
// intermittent red on a merge gate.
async function awaitUnlinked(p, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (fs.existsSync(p)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

function requestRaw(method, pathName, { body, headers, timeoutMs = RAW_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ status: `no reply in ${timeoutMs}ms — the route hung`, body: null,
        buf: Buffer.alloc(0), headers: {} });
    }, timeoutMs);
    timer.unref?.(); // never hold the loop open on its own
    const req = http.request(baseUrl + pathName, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, body: parsed, buf, headers: res.headers });
      });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
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

test("a host that stops declaring an org keeps its binding, and is not drifted", () => {
  // Drift is declaring a DIFFERENT org, not failing to declare one. Treating an
  // absent `jira` block as drift locked a host out of its roster AND out of
  // migration on the beat its tracker went quiet — an outage caused by the
  // boundary rather than prevented by it. Real migrate tests beat exactly this
  // shape, which is how it was caught.
  assert.equal(orgDrifted({ orgBound: "acme", jira: { siteKey: "acme" } }), false);
  assert.equal(orgDrifted({ orgBound: "acme" }), false);              // no jira at all
  assert.equal(orgDrifted({ orgBound: "acme", jira: {} }), false);    // block, no key
  assert.equal(orgDrifted({ orgBound: "acme", jira: { available: false } }), false);
  // The attack still trips it: joining another org means naming that org.
  assert.equal(orgDrifted({ orgBound: "acme", jira: { siteKey: "rival" } }), true);
});

test("orgPeers still serves a host that stopped declaring its org", () => {
  peerHost("quietA", "acme.atlassian.net", [peerSession("q1")]);
  peerHost("quietB", "acme.atlassian.net", [peerSession("q2")]);
  delete agents.quietA.jira;              // its tracker went quiet this beat
  try {
    assert.deepEqual(orgPeers("quietA").map((p) => p.id).sort(), ["q1", "q2"]);
  } finally {
    dropPeerHosts("quietA", "quietB");
  }
});

test("migrate: an ORG-LESS fleet can still move sessions", async () => {
  // Parity with what this route did before it compared bound orgs: two hosts
  // with no tracker configured are not "in a different org", they are in no
  // org, and refusing them is a regression. The clients cannot mirror such a
  // rule either — `orgBound` is stripped from the served payload — so their
  // Move menus would keep offering a host the hub then refuses.
  await migHost("mFreeA", null);
  await migHost("mFreeB", null);
  const r = await migrate("mFreeA", "s1", { host: "mFreeB" });
  // `notEqual(409)` passes on ANY other status — including the 503 the fleet-wide
  // in-flight cap really returns, since every migrate test holds a slot. Assert
  // the success, or this pins nothing.
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // A started move stays in flight until it settles, and the in-flight cap is
  // shared with every other migrate test — drop it rather than leaking a slot.
  if (r.body && r.body.migrationId) migrations.delete(r.body.migrationId);
});

test("migrate: a DRIFTED host is still a legal target — the binding is not here", async () => {
  // Pins the REVERT, in the one direction it can regress. Two attempts to
  // bind-gate this route were made and reverted (see .claude/rules/turma.md);
  // re-inserting `if (orgDrifted(src) || orgDrifted(tgt)) return 409` above the
  // claim compare escaped the whole suite, so a future session could ship the
  // thing the docs warn against, green.
  //
  // A drifted host that still CLAIMS the source's org is the only case the two
  // candidate predicates disagree on, so it is the only case that pins this.
  // Refusing it is not wrong on its own — it is wrong without XERK-349, because
  // no client can mirror it and every Move menu would keep offering this host.
  await migHost("mDriftT", "dt1.atlassian.net");     // binds dt1
  await migHost("mDriftT", "dt2.atlassian.net");     // now claims dt2: drifted
  await migHost("mDriftS", "dt2.atlassian.net");     // claims dt2 too
  const r = await migrate("mDriftS", "s1", { host: "mDriftT" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body && r.body.migrationId) migrations.delete(r.body.migrationId);
});

test("migrate: matches on the CLAIMED org, and the client predicate agrees", async () => {
  // The org binding gates the peer roster and NOT this route. No client can
  // mirror a rule keyed on `orgBound` — it is stripped from the served payload,
  // so `eligibleMoveTargets` and its Android/glasses twins see only
  // `jira.siteKey`. A host BOUND to an org but declaring none this beat is where
  // a binding-keyed rule would diverge from every Move menu.
  //
  // The hole this leaves is real and deliberate (XERK-349): two hosts that both
  // declare NO org match each other whatever they are bound to. The second half
  // of this test asserts that, so the day it is closed this test fails loudly
  // rather than the behaviour changing unnoticed.
  await migHost("mQuietA", "q1.atlassian.net");
  await migHost("mQuietB", "q1.atlassian.net");
  await migHost("mQuietB", null);          // still bound to q1, declaring nothing
  const toQuiet = await migrate("mQuietA", "s1", { host: "mQuietB" });
  assert.equal(toQuiet.status, 409, JSON.stringify(toQuiet.body));
  // `sessions.html`'s own predicate, verbatim, over what the client is really
  // served — this test was once titled "the clients agree" while running no
  // client code at all. `eligibleMoveTargets` keys on this, so if it disagrees
  // with the hub the Move menu offers a host that 409s (or hides a legal one).
  const siteKeyOfAgent = (a) => (a && a.jira && a.jira.siteKey) || "";
  // Fetched FRESH per assertion, and every host asserted to be PRESENT in it.
  // A snapshot taken before a host's first beat makes `find` undefined, which
  // the client-style `|| ""` turns into "" — so `"" === ""` passed while proving
  // nothing about the host it named.
  const keysOf = async (...devices) => {
    const served = (await request("GET", "/api/agents", { headers: userHeaders })).body.agents;
    return devices.map((d) => {
      const a = served.find((x) => x.device === d);
      assert.ok(a, `${d} is not in the served payload — this assertion is vacuous`);
      return siteKeyOfAgent(a);
    });
  };
  const [kA, kB] = await keysOf("mQuietA", "mQuietB");
  assert.notEqual(kA, kB);                               // the UI hides it too
  // And the org-less pair the clients DO offer is allowed, so agreement holds
  // in both directions.
  await migHost("mQuietC", null);
  const bothQuiet = await migrate("mQuietC", "s1", { host: "mQuietB" });
  assert.equal(bothQuiet.status, 200, JSON.stringify(bothQuiet.body));
  const [kC, kB2] = await keysOf("mQuietC", "mQuietB");
  assert.equal(kC, kB2);
  if (bothQuiet.body && bothQuiet.body.migrationId)
    migrations.delete(bothQuiet.body.migrationId);
});


test("migrate: a genuine same-org move is not refused on the org check", async () => {
  await migHost("mOkA", "ok1.atlassian.net");
  await migHost("mOkB", "ok1.atlassian.net");
  const r = await migrate("mOkA", "s1", { host: "mOkB" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body && r.body.migrationId) migrations.delete(r.body.migrationId);
});

test("http: a persisted non-string orgBound cannot wedge a host's heartbeat", async () => {
  // An earlier build of this branch bound a non-string org (siteKeyOf did not
  // coerce yet) and PERSISTED it, so a hub upgrading over its own /data reads
  // one back. Unguarded, `.slice()` on it threw out of the heartbeat handler:
  // 400 with the raw exception text on every beat from that host, forever, with
  // the recovery path throwing too. Nothing coerces orgBound on restore.
  const host = "wedge-host";
  try {
    await request("POST", "/api/heartbeat", {
      body: { device: host, jira: { siteKey: "acme.atlassian.net" } },
      headers: agentHeaders,
    });
    agents[host].orgBound = { o: 1 };            // what the restore hands back
    const r = await request("POST", "/api/heartbeat", {
      body: { device: host, jira: { siteKey: "acme.atlassian.net" } },
      headers: agentHeaders,
    });
    assert.equal(r.status, 200);
  } finally {
    delete agents[host];
    orgDriftWarned.delete(host);
  }
});

test("http: a non-string siteKey is dropped before it is served", async () => {
  // Android TYPES jira.siteKey and a full /api/agents decode is atomic there, so
  // one host beating an object key throws the whole fleet array on every phone.
  // The coercion belongs in normalizeRecord so the state.json restore is covered
  // too — see the heartbeat contract in CLAUDE.md.
  const host = "objkey-host";
  try {
    await request("POST", "/api/heartbeat", {
      body: { device: host, jira: { available: true, siteKey: { o: 1 } } },
      headers: agentHeaders,
    });
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    const served = res.body.agents.find((a) => a.device === host);
    assert.ok(served);
    assert.equal("siteKey" in (served.jira || {}), false);
  } finally {
    delete agents[host];
  }
});

test("normalizeJira drops a non-string key and leaves a good one alone", () => {
  const bad = { jira: { available: true, siteKey: ["a"] } };
  normalizeJira(bad);
  assert.deepEqual(bad.jira, { available: true });
  const good = { jira: { siteKey: "acme" } };
  normalizeJira(good);
  assert.equal(good.jira.siteKey, "acme");
  // Shapes that are not an object are left alone rather than thrown on — a
  // throw here lands in the restore's silent catch and abandons every host
  // after this one.
  assert.doesNotThrow(() => normalizeJira({ jira: "nope" }));
  assert.doesNotThrow(() => normalizeJira({ jira: null }));
  assert.doesNotThrow(() => normalizeJira(null));
});

test("normalizeTriage coerces the capability flag strictly boolean (XERK-481)", () => {
  // Same atomic-decode hazard as normalizeQwen: one host's bad `triage` block
  // would fail Android's whole /api/agents decode and empty the fleet.
  const norm = (triage) => { const p = { device: "h", triage }; normalizeTriage(p); return p.triage; };
  assert.deepEqual(norm({ available: true }), { available: true });
  // Strictly boolean: a truthy non-true value reads as "cannot triage".
  assert.deepEqual(norm({ available: "yes" }), { available: false });
  assert.deepEqual(norm({ available: 1 }), { available: false });
  assert.deepEqual(norm({ available: false }), { available: false });
  // Carries ONLY {available}: any unknown extra key is dropped (rebuilt, not
  // spread), so nothing triage-shaped leaks onto the wire.
  assert.deepEqual(norm({ available: true, extra: 1 }), { available: true });
  // Not an object at all -> null, which every client reads as "cannot triage".
  assert.equal(norm("yes"), null);
  assert.equal(norm([1]), null);
  assert.equal(norm(null), null);
  // A pre-triage agent sends nothing; the key stays absent, not an explicit null.
  const old = { device: "h" };
  normalizeTriage(old);
  assert.ok(!("triage" in old));
});

test("normalizeJira coerces each ticket's triage block to the contract shape (XERK-481)", () => {
  // The assessment rides jira.tickets[].triage and Android TYPES it, so a
  // malformed one must be coerced here (jira is a KNOWN key sanitizeHeartbeat
  // never looks inside), covering the state.json restore too.
  const a = {
    device: "h",
    jira: {
      siteKey: "acme",
      tickets: [
        // A full, valid assessment survives verbatim.
        { key: "ENG-1", triage: {
          priority: "P1", priorityName: "High", type: "bug", value: "medium",
          actionable: true, dedupeOf: "ENG-9", reason: "dup of ENG-9",
          at: "2026-08-30T00:00:00Z", source: "auto" } },
        // An out-of-band priority is DROPPED (absence reads as unknown, never
        // "P-something"); a non-bool actionable and a non-string label go too.
        { key: "ENG-2", triage: {
          priority: "P9", actionable: "yes", type: 3, reason: "kept" } },
        // A non-object triage is removed outright.
        { key: "ENG-3", triage: "junk" },
        // A ticket with no triage is untouched.
        { key: "ENG-4" },
      ],
    },
  };
  hub.normalizeRecord(a);
  assert.deepEqual(a.jira.tickets[0].triage, {
    priority: "P1", priorityName: "High", type: "bug", value: "medium",
    actionable: true, dedupeOf: "ENG-9", reason: "dup of ENG-9",
    at: "2026-08-30T00:00:00Z", source: "auto",
  });
  assert.deepEqual(a.jira.tickets[1].triage, { reason: "kept" });
  assert.ok(!("triage" in a.jira.tickets[2]));
  assert.ok(!("triage" in a.jira.tickets[3]));
  // A per-ticket string field is length-capped (agent-supplied, unbounded on the
  // wire otherwise — the XERK-348 lesson).
  const big = { device: "h", jira: { tickets: [
    { key: "ENG-5", triage: { reason: "x".repeat(5000), priorityName: "y".repeat(500) } }] } };
  hub.normalizeRecord(big);
  assert.equal(big.jira.tickets[0].triage.reason.length, 2000);
  assert.equal(big.jira.tickets[0].triage.priorityName.length, 120);
  // Malformed tickets/shapes never throw (a throw lands in the restore's catch).
  assert.doesNotThrow(() => normalizeJira({ jira: { tickets: [null, 1, "x", []] } }));
  assert.doesNotThrow(() => normalizeJira({ jira: { tickets: "nope" } }));
});

test("normalizeClones coerces every field a client types, and caps progress", () => {
  // There was no coercion here at all while Android types EVERY field on
  // CloneInfo as a String — and a full /api/agents decode is atomic there, so
  // one host beating a number threw the whole fleet array on every phone.
  const a = {
    clones: [
      { repo: "o/r", name: "r", status: 123, error: null, startedAt: {},
        progress: "Receiving objects:  47%" },
    ],
  };
  normalizeClones(a);
  const c = a.clones[0];
  assert.equal(c.repo, "o/r");
  assert.equal(c.status, undefined, "a non-string is dropped, not stringified");
  assert.equal(c.error, undefined);
  assert.equal(c.startedAt, undefined);
  assert.equal(c.progress, "Receiving objects:  47%");

  // Capped: agent-supplied, per-clone and otherwise unbounded on the wire —
  // the shape that OOM-killed a hub in XERK-348.
  const long = { clones: [{ progress: "x".repeat(5000) }] };
  normalizeClones(long);
  assert.equal(long.clones[0].progress.length, CLONE_PROGRESS_MAX);

  // Entries that are not objects are dropped rather than iterated into.
  const junk = { clones: [null, "nope", ["a"], { repo: "keep" }] };
  normalizeClones(junk);
  assert.deepEqual(junk.clones, [{ repo: "keep" }]);

  // And nothing here may throw: a throw lands in the restore's silent catch
  // and abandons every host after this one.
  assert.doesNotThrow(() => normalizeClones({ clones: "nope" }));
  assert.doesNotThrow(() => normalizeClones({ clones: null }));
  assert.doesNotThrow(() => normalizeClones({}));
  assert.doesNotThrow(() => normalizeClones(null));
  const notArray = { clones: "nope" };
  normalizeClones(notArray);
  assert.equal("clones" in notArray, false, "a non-array clones is dropped whole");
});

test("normalizeRecord runs the clone coercion too, on ingest and on restore", () => {
  const a = { clones: [{ status: 7 }] };
  hub.normalizeRecord(a);
  assert.equal(a.clones[0].status, undefined);
});

test("normalizeRecord coerces session summary: type, whitespace, length", () => {
  // Android types SessionInfo.summary as String and decodes /api/agents
  // atomically — a non-string would hide the whole fleet from that phone,
  // and the notification titles now lead with it, so an unbounded name
  // would push the FCM payload past its ~4 KB limit.
  const a = {
    sessions: [
      { id: "s1", summary: 42 },
      { id: "s2", summary: "   " },
      { id: "s3", summary: "  Fix terminal font  " },
      { id: "s4", summary: "x".repeat(500) },
      { id: "s5" },
    ],
  };
  hub.normalizeRecord(a);
  assert.equal(a.sessions[0].summary, "", "non-string coerced to empty");
  assert.equal(a.sessions[1].summary, "", "whitespace-only trimmed to empty");
  assert.equal(a.sessions[2].summary, "Fix terminal font", "trimmed");
  assert.equal(a.sessions[3].summary.length, 120, "capped at 120 chars");
  assert.equal("summary" in a.sessions[4], false, "absent stays absent");
});

test("normalizeRecord runs the triage coercions too, on ingest and on restore (XERK-481)", () => {
  // Pins the WIRING, not just the leaves: a malformed TOP-LEVEL `triage` block is
  // decode-fatal for Android's whole /api/agents array, so normalizeRecord must
  // call normalizeTriage on both the ingest and the state.json restore. Driving
  // through normalizeRecord (not the leaf directly) is the half that catches the
  // call being dropped in a refactor — the same reason the clone case above and
  // the qwen ones exist.
  const top = { device: "h", triage: "yes" };
  hub.normalizeRecord(top);
  assert.equal(top.triage, null);
  const flag = { device: "h", triage: { available: "yes", extra: 1 } };
  hub.normalizeRecord(flag);
  assert.deepEqual(flag.triage, { available: false });
  // The per-ticket coercion (via normalizeJira) is wired too — a bad band is
  // dropped rather than served as a P-something to a typed client.
  const perTicket = { device: "h", jira: { tickets: [{ key: "ENG-1", triage: { priority: "P9", reason: "x" } }] } };
  hub.normalizeRecord(perTicket);
  assert.deepEqual(perTicket.jira.tickets[0].triage, { reason: "x" });
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
  // It landed on DISK, not in the record — that is the whole point of XERK-263.
  assert.equal(m.blob, undefined);
  const spoolFile = m.blobPath;
  assert.equal(spoolFile, path.join(MIGRATE_SPOOL_DIR, `${mid}.bin`));
  assert.equal(m.blobSize, blob.length);
  assert.ok(blob.equals(fs.readFileSync(spoolFile)));
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
  // The bundle is freed on handoff — the record's pointer AND the spool file
  // (XERK-263): a leaked file is 65 MiB of disk nothing comes back for.
  assert.equal(after.blobPath, null);
  assert.equal(await awaitUnlinked(spoolFile), true,
    "the spool file should be unlinked once the migration is done");
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
  const mid = r.body.migrationId;
  const m = migrations.get(mid);
  const up = await requestRaw("POST", `/api/agents/toA/migrations/${mid}/blob`,
    { body: Buffer.from("BUNDLE"), headers: { authorization: "Bearer agenttok" } });
  assert.equal(up.status, 200);
  const spoolFile = m.blobPath;
  assert.ok(fs.existsSync(spoolFile));
  m.startedAt = Date.now() - 10 * 60 * 1000; // well past MIGRATE_TIMEOUT_MS
  advanceMigrations();
  assert.equal(m.phase, "failed");
  assert.match(m.error, /timed out/);
  assert.equal(m.blobPath, null);
  assert.equal(await awaitUnlinked(spoolFile), true,
    "a timed-out move must not leave its spool file behind");
});

test("migrate: an empty bundle is refused and leaves no spool file", async () => {
  await migHost("emA", "em.atlassian.net");
  await migHost("emB", "em.atlassian.net");
  const r = await migrate("emA", "s1", { host: "emB" });
  const mid = r.body.migrationId;
  const up = await requestRaw("POST", `/api/agents/emA/migrations/${mid}/blob`,
    { headers: { authorization: "Bearer agenttok", "content-length": "0" } });
  // The uniform 404 every other POST refusal answers (XERK-266) — the point is
  // that this one is indistinguishable from a stranger's probe.
  assert.equal(up.status, 404);
  assert.match(up.body.error, /unknown migration/);
  const m = migrations.get(mid);
  assert.equal(m.phase, "exporting"); // still awaiting a real bundle
  assert.equal(m.blobPath, null);
  assert.equal(await awaitUnlinked(path.join(MIGRATE_SPOOL_DIR, `${mid}.bin`)), true,
    "a refused bundle must not leave its spool file behind");
});

test("migrate: a bundle past the cap is refused 413 and spools nothing", async () => {
  await migHost("bigA", "big.atlassian.net");
  await migHost("bigB", "big.atlassian.net");
  const r = await migrate("bigA", "s1", { host: "bigB" });
  const mid = r.body.migrationId;
  // Past MIGRATE_BLOB_MAX (65 MiB), but WELL inside RAW_BODY_DRAIN_SLACK — the
  // 413 only holds while the route is still draining, and a body sized to the
  // exact slack boundary would make this test one byte from flaking. The route
  // must answer on the same connection rather than hanging the socket up on the
  // agent, and must not leave the partial spool behind.
  const over = Buffer.alloc((1 << 26) + (1 << 20) + 4096, 0x41);
  const up = await requestRaw("POST", `/api/agents/bigA/migrations/${mid}/blob`,
    { body: over, headers: { authorization: "Bearer agenttok" } });
  assert.equal(up.status, 413);
  const m = migrations.get(mid);
  assert.equal(m.phase, "failed");
  assert.match(m.error, /too large/);
  assert.equal(m.blobPath, null);
  await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(fs.existsSync(path.join(MIGRATE_SPOOL_DIR, `${mid}.bin`)), false,
    "a rejected upload must not leave a partial spool file");
});

test("migrate: a second upload for one migration can't interleave into the spool", async () => {
  // The phase only flips to `importing` once the first upload finishes writing,
  // so without the `uploading` guard two concurrent POSTs would both pass the
  // phase check and write into the SAME file, producing a corrupt bundle.
  await migHost("dupA", "dup.atlassian.net");
  await migHost("dupB", "dup.atlassian.net");
  const r = await migrate("dupA", "s1", { host: "dupB" });
  const mid = r.body.migrationId;
  const hdr = { authorization: "Bearer agenttok" };
  const [a, b] = await Promise.all([
    requestRaw("POST", `/api/agents/dupA/migrations/${mid}/blob`,
      { body: Buffer.alloc(1 << 20, 0x41), headers: hdr }),
    requestRaw("POST", `/api/agents/dupA/migrations/${mid}/blob`,
      { body: Buffer.alloc(1 << 20, 0x42), headers: hdr }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 404]);
  const loser = a.status === 404 ? a : b;
  // The loser is REFUSED, not hung up on: it must read a real reply — and it is
  // the same 404 as every other POST refusal (XERK-266), not a distinct status
  // that would name the source to anyone holding the id.
  assert.match(loser.body.error, /unknown migration/);
  const spooled = fs.readFileSync(migrations.get(mid).blobPath);
  assert.equal(spooled.length, 1 << 20);
  assert.equal(new Set(spooled).size, 1, "the spool must hold ONE upload's bytes, not two interleaved");
});

test("migrate: a spool that can't be written fails the move, and doesn't hang", async () => {
  // Stand in for the disk saying no (ENOSPC/EACCES/EDQUOT): a DIRECTORY where
  // the spool file goes makes the write stream error. The route must answer —
  // an unanswerable POST would leave the source agent, which never retries,
  // waiting out the whole migration timeout.
  await migHost("errA", "err.atlassian.net");
  await migHost("errB", "err.atlassian.net");
  const r = await migrate("errA", "s1", { host: "errB" });
  const mid = r.body.migrationId;
  fs.mkdirSync(path.join(MIGRATE_SPOOL_DIR, `${mid}.bin`), { recursive: true });
  // requestRaw times out on its own, so an unanswerable POST fails on this
  // assertion rather than by running the whole CI job out of time.
  const up = await requestRaw("POST", `/api/agents/errA/migrations/${mid}/blob`,
    { body: Buffer.from("BUNDLE"), headers: { authorization: "Bearer agenttok" }, timeoutMs: 2000 });
  // Uniform with every other POST refusal (XERK-266) — a status of its own
  // would name the source the moment the hub's disk misbehaved. It also can't
  // hand the agent the hub's filesystem layout; that detail goes to the log.
  assert.equal(up.status, 404);
  assert.match(up.body.error, /unknown migration/);
  assert.doesNotMatch(up.body.error, /\//);
  const m = migrations.get(mid);
  assert.equal(m.phase, "failed");
  assert.equal(m.blobPath, null);
  assert.equal(agents.errB.commands.some((c) => c.type === "importSession"), false,
    "a bundle that never landed must not queue an import");
  fs.rmSync(path.join(MIGRATE_SPOOL_DIR, `${mid}.bin`), { recursive: true, force: true });
});

test("migrate: a download racing the migration's settle is not truncated", async () => {
  // dropMigrationBlob zeroes blobPath/blobSize, and the unlink leaves an open
  // read valid — so a GET that read the size AFTER its first async hop served
  // the whole body under `Content-Length: 0`, which the agent's reader takes
  // for an empty bundle. The response must describe what it actually sends.
  await migHost("rcA", "rc.atlassian.net");
  await migHost("rcB", "rc.atlassian.net");
  const r = await migrate("rcA", "s1", { host: "rcB" });
  const mid = r.body.migrationId;
  const blob = Buffer.alloc(1 << 19, 0x5a);
  await requestRaw("POST", `/api/agents/rcA/migrations/${mid}/blob`,
    { body: blob, headers: { authorization: "Bearer agenttok" } });
  const m = migrations.get(mid);
  // The window is between `createReadStream` and its `open` event, which a
  // sleep can only straddle by luck — timed from out here this caught a
  // reintroduced bug once in five runs, and a drop that lands EARLY hides in a
  // legitimate 404. So land the settle in the window by construction: patch the
  // one call that opens it, exactly where the race would put the settle.
  const realCreateReadStream = fs.createReadStream;
  let dropped = false;
  fs.createReadStream = function (p, ...rest) {
    const s = realCreateReadStream.call(fs, p, ...rest);
    // On `open`, and registered BEFORE the route's own open handler so it runs
    // first: that is the production window exactly — the descriptor exists (so
    // the unlink can't stop the read) but the response header hasn't been
    // written yet. Dropping any earlier just races the open and 404s, which is
    // a different, harmless outcome.
    if (p === m.blobPath) s.once("open", () => { dropMigrationBlob(m); dropped = true; });
    return s;
  };
  let got;
  try {
    got = await requestRaw("GET", `/api/agents/rcB/migrations/${mid}/blob`,
      { headers: { authorization: "Bearer agenttok" } });
  } finally {
    fs.createReadStream = realCreateReadStream;
  }
  assert.ok(dropped, "the settle must land inside the window, or this proves nothing");
  // The unlink leaves this read's fd valid, so the bytes still arrive. What
  // must never happen is a 200 whose length disagrees with what it sends: the
  // agent's reader believes the header and takes a `Content-Length: 0` for an
  // empty bundle.
  assert.equal(got.status, 200);
  assert.equal(Number(got.headers["content-length"]), got.buf.length);
  assert.ok(blob.equals(got.buf), "the target must get every byte it was promised");
});

test("migrate: the spool path can only ever be a hub-minted id", async () => {
  // The comment says the filename comes from the hub-minted id and not from the
  // agent's path segment; this is what makes that true rather than a promise
  // about today's one caller. Nothing here should be reachable from a route —
  // that is the point of asserting it directly.
  assert.equal(migrationSpoolPath("0123456789abcdef"),
    path.join(MIGRATE_SPOOL_DIR, "0123456789abcdef.bin"));
  for (const bad of ["../../etc/passwd", "0123456789abcde/", "0123456789ABCDEF",
                     "0123456789abcdefff", "..", "", null, undefined]) {
    assert.throws(() => migrationSpoolPath(bad), /did not mint/, `should refuse ${bad}`);
  }
});

test("migrate: the boot sweep deletes only spool files, never a neighbour", async () => {
  // MIGRATE_SPOOL_DIR is deployment config. Pointed at /data by a compose slip,
  // an unfiltered sweep would delete state.json and devices.json on boot.
  const mine = path.join(MIGRATE_SPOOL_DIR, "0123456789abcdef.bin");
  const theirs = path.join(MIGRATE_SPOOL_DIR, "state.json");
  fs.writeFileSync(mine, "bundle");
  fs.writeFileSync(theirs, "{}");
  sweepMigrationSpool();
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(theirs), true, "the sweep must not touch a name it didn't write");
  fs.unlinkSync(theirs);
});

test("migrate: too many moves in flight is refused, not spooled", async () => {
  // Each in-flight move can hold a 65 MiB bundle on /data, so the hub caps how
  // many can be doing that at once (XERK-263). The refusal lands on the
  // OPERATOR's click, where it can be shown, never on the agent's upload.
  await migHost("cpA", "cp.atlassian.net", {
    extraSessions: ["s2", "s3", "s4", "s5"].map((id) => ({
      id, status: "running", root: false, repo: "Turma", transcriptId: "trans-" + id,
      worktreePath: `/git/.turma/worktrees/Turma/${id}`,
    })),
  });
  await migHost("cpB", "cp.atlassian.net");
  // The cap is fleet-wide (so is /data), so settle what earlier cases left in
  // flight rather than counting on an empty map — and settle this case's own
  // moves on the way out, or it hands every later test a fleet already at the
  // cap and their migrate() calls come back 503.
  const settleInFlight = () => {
    for (const m of migrations.values()) {
      if (m.phase === "exporting" || m.phase === "importing") m.phase = "failed";
    }
  };
  settleInFlight();
  try {
  for (const id of ["s1", "s2", "s3", "s4"]) {
    assert.equal((await migrate("cpA", id, { host: "cpB" })).status, 200, id);
  }
  const over = await migrate("cpA", "s5", { host: "cpB" });
  assert.equal(over.status, 503);
  assert.match(over.body.error, /too many moves in flight/);
  // Settling one frees the slot again.
  const first = [...migrations.values()].find(
    (m) => m.srcHost === "cpA" && m.srcSessionId === "s1");
  first.phase = "failed";
  assert.equal((await migrate("cpA", "s5", { host: "cpB" })).status, 200);
  } finally {
    settleInFlight();
  }
});

test("migrate: the boot sweep clears spool files a restart orphaned", async () => {
  // The records live in memory, so a restart abandons every in-flight move; the
  // files it was relaying belong to nobody and must not survive.
  const orphan = path.join(MIGRATE_SPOOL_DIR, "deadbeefdeadbeef.bin");
  fs.writeFileSync(orphan, "orphaned bundle");
  sweepMigrationSpool();
  assert.equal(fs.existsSync(orphan), false);
});

// ---- refused session starts (XERK-265) --------------------------------------
// A resume/import the agent DECLINES is ACKed like any other command, so before
// this the hub could not tell a refusal from a slow spawn: the move sat in
// `importing` for the whole MIGRATE_TIMEOUT_MS and failed with no reason.

test("migrate: a target that refuses the import fails the move now, with its reason", async () => {
  await migHost("rfA", "rf.atlassian.net");
  await migHost("rfB", "rf.atlassian.net");
  const r = await migrate("rfA", "s1", { host: "rfB" });
  const mid = r.body.migrationId;
  await requestRaw("POST", `/api/agents/rfA/migrations/${mid}/blob`,
    { body: Buffer.from("BYTES"), headers: { authorization: "Bearer agenttok", "content-type": "application/octet-stream" } });
  const m = migrations.get(mid);
  assert.equal(m.phase, "importing");
  const impCmdId = m.importCmdId;

  // The target beats in saying it refused, naming the migration.
  await request("POST", "/api/heartbeat", {
    body: {
      device: "rfB",
      spawnFailures: [{ cmdId: impCmdId, migrationId: mid,
                        error: "the host is at MAX_SESSIONS (4)" }],
    },
    headers: agentHeaders,
  });
  assert.equal(m.phase, "failed");
  assert.match(m.error, /MAX_SESSIONS/);
  assert.equal(m.blobPath, null, "and its spool file is dropped, like a timeout's");
  // The source is untouched — a refused import loses nothing, so no kill.
  assert.ok(!(agents.rfA.commands || []).some((c) => c.type === "kill"));
  // And it rides the fleet payload keyed by cmdId, for the page following it.
  assert.equal(agents.rfB.spawnRefusals[impCmdId].error,
    "the host is at MAX_SESSIONS (4)");
  const fleet = await request("GET", "/api/agents", { headers: userHeaders });
  const served = fleet.body.agents.find((a) => a.key === "rfB");
  assert.ok(served.spawnRefusals[impCmdId], "served, not stripped like the caches");
});

test("migrate: a source that never ships its blob fails the move too", async () => {
  await migHost("rxA", "rx.atlassian.net");
  await migHost("rxB", "rx.atlassian.net");
  const r = await migrate("rxA", "s1", { host: "rxB" });
  const mid = r.body.migrationId;
  assert.equal(migrations.get(mid).phase, "exporting");
  await request("POST", "/api/heartbeat", {
    body: { device: "rxA", spawnFailures: [{ migrationId: mid, error: "packing failed: boom" }] },
    headers: agentHeaders,
  });
  const m = migrations.get(mid);
  assert.equal(m.phase, "failed");
  assert.match(m.error, /packing failed/);
});

test("migrate: a target reporting BOTH the session and a refusal still completes", async () => {
  // Ordering guard: the handoff check runs first, so a refusal that raced a
  // successful launch can never fail a move that actually landed.
  await migHost("rcA", "rc.atlassian.net");
  await migHost("rcB", "rc.atlassian.net");
  const r = await migrate("rcA", "s1", { host: "rcB" });
  const mid = r.body.migrationId;
  await requestRaw("POST", `/api/agents/rcA/migrations/${mid}/blob`,
    { body: Buffer.from("BYTES"), headers: { authorization: "Bearer agenttok", "content-type": "application/octet-stream" } });
  const m = migrations.get(mid);
  await migHost("rcB", "rc.atlassian.net", {
    extraSessions: [{ id: "new9", status: "running", root: false, repo: "Turma",
      transcriptId: "trans-rcA", worktreePath: "/git/.turma/worktrees/Turma/s1",
      spawnCmdId: m.importCmdId }],
  });
  await request("POST", "/api/heartbeat", {
    body: { device: "rcB", spawnFailures: [{ migrationId: mid, error: "stale refusal" }] },
    headers: agentHeaders,
  });
  assert.equal(m.phase, "done");
});

test("migrate: a bundle landing after the move settled cannot resurrect it", async () => {
  // The source's upload POST times out at 30s while the hub is still spooling,
  // so the agent stages "uploading … failed" and the next beat fails the move
  // (XERK-265) — then the bytes finish arriving. Advancing anyway would queue
  // an importSession for a move the operator was told had failed, and kill the
  // source when the target came up.
  await migHost("resA", "res.atlassian.net");
  await migHost("resB", "res.atlassian.net");
  const mid = (await migrate("resA", "s1", { host: "resB" })).body.migrationId;
  await request("POST", "/api/heartbeat", {
    body: { device: "resA", spawnFailures: [{ migrationId: mid, error: "uploading failed" }] },
    headers: agentHeaders,
  });
  const m = migrations.get(mid);
  assert.equal(m.phase, "failed");

  const late = await requestRaw("POST", `/api/agents/resA/migrations/${mid}/blob`, {
    body: Buffer.from("LATE-BYTES"),
    headers: { authorization: "Bearer agenttok", "content-type": "application/octet-stream" },
  });
  assert.equal(late.status, 404);
  assert.equal(m.phase, "failed", "still failed");
  assert.equal(m.blobPath, null, "and holds no spool file");
  assert.ok(!(agents.resB.commands || []).some((c) => c.type === "importSession"),
    "no importSession was queued for a settled move");
});

test("migrate: a move failed WHILE its bundle is being spooled is not resurrected", async () => {
  // The route's entry guard sees `exporting` and lets the body through; the
  // refusal lands DURING the spool, which is the real window (a 65 MiB upload
  // is not instant, and the agent's own POST timing out is exactly what makes
  // it stage that refusal). Only the post-spool re-check can catch this one.
  await migHost("racA", "rac.atlassian.net");
  await migHost("racB", "rac.atlassian.net");
  const mid = (await migrate("racA", "s1", { host: "racB" })).body.migrationId;
  const m = migrations.get(mid);
  assert.equal(m.phase, "exporting");

  const body = Buffer.from("X".repeat(4096));
  const done = new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/api/agents/racA/migrations/${mid}/blob`, {
      method: "POST",
      headers: {
        authorization: "Bearer agenttok",
        "content-type": "application/octet-stream",
        "content-length": body.length * 2,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.write(body);                       // half the bundle...
    setTimeout(() => { req.write(body); req.end(); }, 120);  // ...and the rest
  });

  // Mid-spool: the source reports its upload failed, so the hub fails the move.
  // The beat KEEPS reporting the session — a heartbeat replaces the record, and
  // dropping it would make the route take its "source session gone" branch and
  // 404 for a reason that has nothing to do with what this test is pinning.
  await new Promise((r) => setTimeout(r, 40));
  await request("POST", "/api/heartbeat", {
    body: {
      device: "racA",
      repos: [{ name: "Turma", path: "/git/Turma" }],
      sessions: [{
        id: "s1", status: "running", root: false, repo: "Turma",
        transcriptId: "trans-racA",
        worktreePath: "/git/.turma/worktrees/Turma/s1",
      }],
      spawnFailures: [{ migrationId: mid, error: "uploading failed" }],
    },
    headers: agentHeaders,
  });
  assert.equal(m.phase, "failed", "failed while the body was still arriving");

  const res = await done;
  assert.equal(res.status, 404);
  assert.equal(m.phase, "failed", "the completed upload must not revive it");
  assert.equal(m.blobPath, null, "and must not leave a spool file behind");
  assert.ok(!(agents.racB.commands || []).some((c) => c.type === "importSession"),
    "no importSession for a move already reported failed");
});

test("migrate: a bystander host cannot fail someone else's move", async () => {
  // Every agent shares one token, so the migration id alone must not be enough.
  await migHost("byA", "by.atlassian.net");
  await migHost("byB", "by.atlassian.net");
  const r = await migrate("byA", "s1", { host: "byB" });
  const mid = r.body.migrationId;
  await request("POST", "/api/heartbeat", {
    body: { device: "byC", spawnFailures: [{ migrationId: mid, error: "not mine to fail" }] },
    headers: agentHeaders,
  });
  assert.equal(migrations.get(mid).phase, "exporting");
  // Settle it: this suite shares one hub and MIGRATE_INFLIGHT_MAX is 4, so a
  // test that parks a move in flight silently refuses a later test's /migrate.
  migrations.delete(mid);
});

// Queue `n` real commands on `device` and answer the beat that collects them,
// so their cmdIds are ones the hub actually gave that host — the only ones it
// will accept a refusal for.
async function issuedCmds(device, n) {
  await request("POST", "/api/heartbeat", { body: { device }, headers: agentHeaders });
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(queueCommand(device, { type: "resumeTranscript", transcriptId: `t${i}` }));
  }
  return ids;
}

test("spawn refusals are bounded and age out of a host's record", async () => {
  const ids = await issuedCmds("bndH", 60);
  await request("POST", "/api/heartbeat", {
    body: { device: "bndH", spawnFailures: ids.map((c, i) => ({ cmdId: c, error: `no ${i}` })) },
    headers: agentHeaders,
  });
  const kept = Object.keys(agents.bndH.spawnRefusals);
  assert.ok(kept.length <= 40, `bounded, got ${kept.length}`);
  assert.ok(kept.includes(ids[59]), "newest kept — the trim is oldest-first");
  // The wire field itself never lands on the record — it's a delivery, like the
  // other *Results.
  assert.equal(agents.bndH.spawnFailures, undefined);
});

test("a spawn refusal ages out on its own, well under the count cap", async () => {
  // Deliberately far from SPAWN_FAILURE_MAX, so the count trim cannot retire
  // this entry and pass the test for the wrong reason.
  const ids = await issuedCmds("ageH", 3);
  await request("POST", "/api/heartbeat", {
    body: { device: "ageH", spawnFailures: ids.map((c, i) => ({ cmdId: c, error: `no ${i}` })) },
    headers: agentHeaders,
  });
  assert.equal(Object.keys(agents.ageH.spawnRefusals).length, 3);
  agents.ageH.spawnRefusals[ids[1]].at = Date.now() - 60 * 60 * 1000;
  const [fresh] = await issuedCmds("ageH", 1);
  await request("POST", "/api/heartbeat",
    { body: { device: "ageH", spawnFailures: [{ cmdId: fresh, error: "x" }] }, headers: agentHeaders });
  assert.ok(!agents.ageH.spawnRefusals[ids[1]], "the stale one is gone");
  assert.ok(agents.ageH.spawnRefusals[ids[0]], "its same-age neighbours stay");
  assert.ok(agents.ageH.spawnRefusals[ids[2]]);
  assert.ok(agents.ageH.spawnRefusals[fresh]);
});

test("a refusal cannot grow a host's record past the ceiling and wedge it", async () => {
  // The cache is SERVED, so agentRecordSize counts it — and the ceiling check
  // runs before the ingest. An unbounded reason would land, push the record over
  // AGENT_RECORD_MAX, and 413 every later beat including the ones that sweep it.
  const ids = await issuedCmds("bigH", 3);
  const r = await request("POST", "/api/heartbeat", {
    body: {
      device: "bigH",
      spawnFailures: ids.map((c) => ({ cmdId: c, error: "x".repeat(4 << 20) })),
    },
    headers: agentHeaders,
  });
  assert.equal(r.status, 200);
  for (const c of ids) assert.ok(agents.bigH.spawnRefusals[c].error.length <= 500);
  // The host keeps beating, and the fleet payload stays small.
  assert.equal((await request("POST", "/api/heartbeat",
    { body: { device: "bigH" }, headers: agentHeaders })).status, 200);
  const fleet = await request("GET", "/api/agents", { headers: userHeaders });
  const served = fleet.body.agents.find((a) => a.key === "bigH");
  assert.ok(JSON.stringify(served).length < 64 * 1024, "record stays small");
});

test("a refusal for a command this host was never given is ignored", async () => {
  // Every agent shares one token, and the page scans the WHOLE fleet for a
  // followed cmdId — so an unchecked one lets any host end another host's wait.
  const [mine] = await issuedCmds("ownA", 1);
  await request("POST", "/api/heartbeat", {
    body: { device: "ownB", spawnFailures: [{ cmdId: mine, error: "not mine to refuse" }] },
    headers: agentHeaders,
  });
  assert.deepEqual(agents.ownB.spawnRefusals, {});
  // The host it WAS issued to is believed.
  await request("POST", "/api/heartbeat", {
    body: { device: "ownA", ackedCommands: [mine],
            spawnFailures: [{ cmdId: mine, error: "at MAX_SESSIONS" }] },
    headers: agentHeaders,
  });
  assert.equal(agents.ownA.spawnRefusals[mine].error, "at MAX_SESSIONS");
});

test("a malformed refusal can't poison the cache or break the beat", async () => {
  const [id] = await issuedCmds("malH", 1);
  const r = await request("POST", "/api/heartbeat", {
    body: {
      device: "malH",
      spawnFailures: [
        { cmdId: "__proto__", error: "prototype setter, not an entry" },
        { cmdId: id, error: { not: "a string" } },
      ],
    },
    headers: agentHeaders,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(agents.malH.spawnRefusals), [id]);
  assert.equal(typeof agents.malH.spawnRefusals[id].error, "string");
  assert.equal(agents.malH.spawnRefusals[id].error, "the agent refused it");
  assert.equal(({}).error, undefined, "no prototype was re-pointed");
  // A non-array must not throw mid-handler: the record is already replaced by
  // then, so the host would lose its commands (and its ack) every beat.
  const bad = await request("POST", "/api/heartbeat",
    { body: { device: "malH", spawnFailures: 42 }, headers: agentHeaders });
  assert.equal(bad.status, 200);
});

// ---- the queued-command cap (XERK-261) --------------------------------------

test("queueCommand caps the per-host queue, dropping the oldest", async () => {
  // An operator hammering a control against an OFFLINE host: nothing drains the
  // queue, so without a cap the record grows until it 413s the host out of the
  // fleet on the beat that would have drained it. The cap holds the depth and
  // drops the OLDEST (already-stale) command, not the just-enqueued one.
  await request("POST", "/api/heartbeat", { body: { device: "floodH" }, headers: agentHeaders });
  const ids = [];
  for (let i = 0; i < hub.AGENT_COMMAND_QUEUE_MAX + 50; i++) {
    ids.push(queueCommand("floodH", { type: "kill", sessionId: `s${i}` }));
  }
  assert.equal(agents.floodH.commands.length, hub.AGENT_COMMAND_QUEUE_MAX,
    "queue is held at the cap");
  const queued = new Set(agents.floodH.commands.map((c) => c.cmdId));
  assert.ok(queued.has(ids[ids.length - 1]), "the newest command survives");
  assert.ok(!queued.has(ids[0]), "the oldest command was dropped");
  // The record stays well under the ceiling, so the host can still beat.
  assert.ok(hub.agentRecordSize(agents.floodH) < hub.AGENT_RECORD_MAX);
  assert.equal((await request("POST", "/api/heartbeat",
    { body: { device: "floodH" }, headers: agentHeaders })).status, 200);
});

test("queueCommand never grows a record past AGENT_RECORD_MAX, even with fat payloads", async () => {
  // A command payload is not fixed-size (a spawn `label` is taken up to 100k),
  // so the COUNT cap alone does not hold the byte ceiling — the general
  // invariant is that no hub-side write leaves a record over AGENT_RECORD_MAX.
  await request("POST", "/api/heartbeat", { body: { device: "fatH" }, headers: agentHeaders });
  const big = "x".repeat(200 * 1024);
  let last;
  for (let i = 0; i < 100; i++) {
    last = queueCommand("fatH", { type: "spawn", label: big, sessionId: `s${i}` });
  }
  assert.ok(hub.agentRecordSize(agents.fatH) <= hub.AGENT_RECORD_MAX,
    "record trimmed to fit under the ceiling");
  assert.ok(agents.fatH.commands.length >= 1, "the queue is never emptied below the last command");
  assert.equal(agents.fatH.commands[agents.fatH.commands.length - 1].cmdId, last,
    "the just-enqueued command is the one kept");
  assert.equal((await request("POST", "/api/heartbeat",
    { body: { device: "fatH" }, headers: agentHeaders })).status, 200);
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

// ---- per-host agent identity (XERK-268) -------------------------------------
// Scoping a relay to `m.srcHost`/`m.targetHost`/`u.host` only means something if
// `<host>` is PROVED rather than typed. Under one fleet-shared token it was
// typed, so the guards refused a caller naming its own host and passed one
// naming the victim's. These hold both halves: the scoping, and the binding that
// makes it an identity check.

// The token the fleet master derives for `host` — what that host's agent runs
// with, and what `node server.js --agent-token <host>` prints.
const asHost = (host) => ({ authorization: `Bearer ${hostAgentToken(host)}` });
// Settle a migration this suite started. `MIGRATE_INFLIGHT_MAX` (4) counts
// exporting/importing moves fleet-wide, so a test that leaves one in flight
// spends one of those four slots for the whole rest of the run — the next test
// to start a move gets 503 and fails somewhere unrelated to what it tests.
const settleMigration = (mid) => {
  const m = migrations.get(mid);
  if (m) { m.phase = "done"; m.at = Date.now(); }
};

const beatAs = (device, headers) =>
  request("POST", "/api/heartbeat", { body: { device }, headers: { ...headers, "content-type": "application/json" } });

test("XERK-268: a host's token names its host and proves that name", () => {
  // Stable (the hub re-derives it per request rather than storing a map),
  // distinct per host, and nothing without a master to derive from.
  assert.equal(hostAgentToken("nas01"), hostAgentToken("nas01"));
  assert.notEqual(hostAgentToken("nas01"), hostAgentToken("nas02"));
  assert.match(hostAgentToken("nas01"), /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  // Never the master itself — handing an agent the master back would defeat it.
  assert.notEqual(hostAgentToken("nas01"), "agenttok");
  // It carries its host on its face, which is what lets the heartbeat gate
  // identify a caller before reading a body. The name half is not a secret; the
  // HMAC half is what makes it unforgeable, so editing the name breaks it.
  const [name, mac] = hostAgentToken("nas01").split(".");
  assert.equal(Buffer.from(name, "base64url").toString(), "nas01");
  assert.equal(hostAgentToken("nas01").split(".")[1], mac);
  // A host name with dots/unicode round-trips (the name is base64url, so the
  // separator can never appear inside it).
  for (const h of ["a.b.c", "héllo-01", "日本-01", "x".repeat(200)]) {
    assert.equal(Buffer.from(hostAgentToken(h).split(".")[0], "base64url").toString(), h);
  }
  // Non-strings and the empty name get NO token: String() coercion would mint a
  // real credential for an array or a toString()-carrying object.
  for (const bad of [["nas01"], { toString: () => "nas01" }, 5, null, undefined, ""]) {
    assert.equal(hostAgentToken(bad), "");
  }
  // Nor a name the hub would refuse to REGISTER (XERK-269). Minting one is the
  // worst outcome available: the agent renames itself to its next naming
  // source, the token stops matching, and the tunnel reconnect-loops forever
  // without ever naming the cause. `x`.repeat(201) is over the key length cap.
  for (const bad of [".", "..", "__proto__", "constructor", "prototype", "x".repeat(201)]) {
    assert.equal(hostAgentToken(bad), "", `must not mint for ${JSON.stringify(bad)}`);
  }
  // ...while names that merely contain dots still mint, since they register fine.
  for (const good of ["...", ".hidden", "..host", "HOST.local."]) {
    assert.match(hostAgentToken(good), /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/, good);
  }
});

test("XERK-268: a bearer proves at most the ONE host it derives to", () => {
  const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  // Its own host: proved. Any other host: refused outright — that is the whole
  // fix, and it holds without strict mode, because a wrong-host derived token
  // matches neither the named host's token nor the master.
  assert.equal(agentBearerKind(bearer(hostAgentToken("hA")), "hA"), "proved");
  assert.equal(agentBearerKind(bearer(hostAgentToken("hA")), "hB"), null);
  // The master authenticates "some agent" and nothing about which one.
  assert.equal(agentBearerKind(bearer("agenttok"), "hA"), "legacy");
  assert.equal(agentBearerKind(bearer("agenttok"), "hB"), "legacy");
  // The operator's own login may name any host: they can already drive every
  // host through the user API, so refusing here would only break curl.
  assert.equal(agentBearerKind({ headers: { authorization: basic("hubuser", "hubpass") } }, "hA"), "operator");
  assert.equal(agentBearerKind({ headers: {} }, "hA"), null);
  assert.equal(agentBearerKind(bearer("garbage"), "hA"), null);
  // A host token that is for someone else is NEVER downgraded to `legacy` —
  // that would hand it the fleet-wide rights its own binding just refused.
  assert.equal(agentBearerKind(bearer(hostAgentToken("hB")), null), null);
  // A non-string host cannot be coerced into one that "matches".
  assert.equal(agentBearerKind(bearer(hostAgentToken("hA")), ["hA"]), null);
  assert.equal(agentBearerKind(bearer(hostAgentToken("hA")), { toString: () => "hA" }), null);
});

test("XERK-268: a wrong-host token says so, so a RENAME is diagnosable", () => {
  // The host name is inside the token, so renaming a host silently invalidates
  // its credential. A bare "unauthorized" sends the operator hunting for a wrong
  // secret instead of a changed name; this tells them nothing the caller does
  // not already hold, since the token names its own host on its face.
  const refusal = agentHostRefusal(
    { headers: { authorization: `Bearer ${hostAgentToken("oldname")}` } }, "newname");
  assert.equal(refusal.status, 403);
  assert.match(refusal.error, /oldname's, not newname's/);
  assert.match(refusal.error, /re-derive it if the host was renamed/);
  // A token that is not a host token at all stays a flat 401 — there is nothing
  // to say about it, and saying more would be an oracle.
  assert.deepEqual(agentHostRefusal({ headers: { authorization: "Bearer garbage" } }, "hA"),
    { status: 401, error: "unauthorized" });
});

test("migrate: the blob relay's host scope holds for a proved caller", async () => {
  await migHost("scA", "sc.atlassian.net");
  await migHost("scB", "sc.atlassian.net");
  await migHost("scC", "sc.atlassian.net");
  const mid = (await migrate("scA", "s1", { host: "scB" })).body.migrationId;

  // A third host naming ITSELF is refused on both halves, and told nothing
  // about whether the id exists (404, not 403).
  const post = await requestRaw("POST", `/api/agents/scC/migrations/${mid}/blob`,
    { body: Buffer.from("ATTACKER-BYTES"), headers: asHost("scC") });
  assert.equal(post.status, 404);
  assert.equal(post.body.error, "unknown migration");
  const get = await requestRaw("GET", `/api/agents/scC/migrations/${mid}/blob`,
    { headers: asHost("scC") });
  assert.equal(get.status, 404);

  // Nothing moved: still awaiting the real source's bundle, nothing queued on
  // the real target.
  assert.equal(migrations.get(mid).phase, "exporting");
  assert.ok(!(agents.scB.commands || []).some((c) => c.type === "importSession"));

  // The GET half is scoped to the TARGET specifically, not merely to "one of the
  // two". Once a bundle exists, even the migration's own SOURCE cannot pull it
  // back — it is the raw transcript, and only the host resuming it needs it.
  const up = await requestRaw("POST", `/api/agents/scA/migrations/${mid}/blob`,
    { body: Buffer.from("SOURCE-BUNDLE"), headers: asHost("scA") });
  assert.equal(up.status, 200);
  const bySrc = await requestRaw("GET", `/api/agents/scA/migrations/${mid}/blob`,
    { headers: asHost("scA") });
  assert.equal(bySrc.status, 404);
  const byTgt = await requestRaw("GET", `/api/agents/scB/migrations/${mid}/blob`,
    { headers: asHost("scB") });
  assert.equal(byTgt.status, 200);
  settleMigration(mid);
});

test("migrate: a third host cannot relay by naming the victim's host", async () => {
  await migHost("vcA", "vc.atlassian.net");
  await migHost("vcB", "vc.atlassian.net");
  const mid = (await migrate("vcA", "s1", { host: "vcB" })).body.migrationId;

  // The attack the scoping alone let through: a third host spoofing the SOURCE
  // in the path. Its own credential derives to vcC, so naming vcA is refused
  // before the migration is ever looked up.
  const spoofPost = await requestRaw("POST", `/api/agents/vcA/migrations/${mid}/blob`,
    { body: Buffer.from("ATTACKER-BYTES-FORGED"), headers: asHost("vcC") });
  assert.equal(spoofPost.status, 403);
  assert.match(spoofPost.body.error, /is vcC's, not vcA's/);
  assert.equal(migrations.get(mid).phase, "exporting");
  assert.ok(!(agents.vcB.commands || []).some((c) => c.type === "importSession"));

  // The real source, with its own token, still relays.
  const real = await requestRaw("POST", `/api/agents/vcA/migrations/${mid}/blob`,
    { body: Buffer.from("REAL-BUNDLE"), headers: asHost("vcA") });
  assert.equal(real.status, 200);
  assert.equal(migrations.get(mid).phase, "importing");

  // ...and the download half the same way: spoofing the TARGET is refused,
  // the real target gets its bytes.
  const spoofGet = await requestRaw("GET", `/api/agents/vcB/migrations/${mid}/blob`,
    { headers: asHost("vcC") });
  assert.equal(spoofGet.status, 403);
  const realGet = await requestRaw("GET", `/api/agents/vcB/migrations/${mid}/blob`,
    { headers: asHost("vcB") });
  assert.equal(realGet.status, 200);
  assert.equal(realGet.buf.toString(), "REAL-BUNDLE");
  settleMigration(mid);
});

test("XERK-268: an agent can only collect an attachment staged for its own host", async () => {
  await upHost("atA");
  const id = (await stage("atA", "s1", "a.png", Buffer.from("SECRET"))).body.uploadId;
  // Naming the victim's host with another host's credential — the case
  // `u.host !== host` alone could not catch.
  const spoof = await requestRaw("GET", `/api/agents/atA/uploads/${id}/blob`, { headers: asHost("atB") });
  assert.equal(spoof.status, 403);
  const own = await requestRaw("GET", `/api/agents/atA/uploads/${id}/blob`, { headers: asHost("atA") });
  assert.equal(own.status, 200);
  assert.equal(own.buf.toString(), "SECRET");
});

test("XERK-268: a heartbeat's `device` is bound to the credential too", async () => {
  // This is what makes the relay guards worth anything: unbound, an attacker
  // beats as the victim and is handed the commands queued for it — including
  // the migrationId/uploadId the relays are keyed on — so no per-relay secret
  // could have helped.
  await migHost("hbA", "hb.atlassian.net");
  await migHost("hbB", "hb.atlassian.net");
  const mid = (await migrate("hbA", "s1", { host: "hbB" })).body.migrationId;

  // hbC's own token cannot beat as hbA, so the exportSession command carrying
  // the id stays with hbA.
  const spoof = await beatAs("hbA", asHost("hbC"));
  assert.equal(spoof.status, 403);
  assert.match(spoof.body.error, /is hbC's, not hbA's/);

  const real = await beatAs("hbA", asHost("hbA"));
  assert.equal(real.status, 200);
  assert.ok(real.body.commands.some((c) => c.type === "exportSession" && c.migrationId === mid));
  settleMigration(mid);
});

test("XERK-268: only the CANONICAL encoding of a host name authenticates", () => {
  // tokenHost compares the WHOLE token, not just the HMAC half. Verifying only
  // the MAC would leave the name half free to re-encode — still the same host,
  // so not directly exploitable, but it would make a credential have many valid
  // spellings, and every equality this system rests on assumes it has one.
  for (const host of ["alpha", "ab", "ÿÿÿ", "a.b"]) {
    const real = hostAgentToken(host);
    assert.equal(tokenHost(real), host);
    const [name, mac] = real.split(".");
    const variants = [
      Buffer.from(host).toString("base64") + "." + mac,         // std alphabet + padding
      name + "=." + mac,                                        // padded
      name.replace(/-/g, "+").replace(/_/g, "/") + "." + mac,   // +/ instead of -_
      name.toUpperCase() + "." + mac,
      "." + name + "." + mac,
      name + "." + mac.toUpperCase(),
      name + "." + mac + ".junk",
      mac,
      name + ".",
    ];
    for (const v of variants) {
      if (v === real) continue;
      assert.equal(tokenHost(v), null, `${host}: ${v.slice(0, 24)}… must not authenticate`);
    }
  }
  // Swapping a name onto another host's MAC fails: the MAC is over the name.
  const [aName] = hostAgentToken("alpha").split(".");
  const [, vMac] = hostAgentToken("victim").split(".");
  assert.equal(tokenHost(`${aName}.${vMac}`), null);
  // A host name that does not survive the UTF-8 round trip gets no token at all,
  // so two names can never derive one credential.
  assert.equal(hostAgentToken("\uD800"), "");
  assert.notEqual(hostAgentToken("�"), "");
});

test("XERK-268: a malformed <host> segment is refused, not 400'd before auth", async () => {
  // The gate decodes the segment to check the credential against it, so a bad
  // percent-escape must not throw there — that turned an anonymous caller's 401
  // into a 400 that ran before any auth did.
  for (const seg of ["%", "a%ZZb", "%E0%A4%A"]) {
    const anon = await requestRaw("GET", `/api/agents/${seg}/uploads/x/blob`);
    assert.equal(anon.status, 401, `anonymous ${seg}`);
    const wrong = await requestRaw("GET", `/api/agents/${seg}/uploads/x/blob`, { headers: asHost("someone") });
    assert.equal(wrong.status, 403, `wrong-host ${seg}`);
  }
});

test("XERK-268: TURMA_AGENT_STRICT retires the fleet master", () => {
  const strict = freshServerModule((env) => { env.TURMA_AGENT_STRICT = "1"; });
  const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  // Derived tokens keep working; the master is refused with a reason the
  // operator can act on, not a bare 401.
  assert.equal(strict.agentHostRefusal(bearer(strict.hostAgentToken("hA")), "hA"), null);
  const refusal = strict.agentHostRefusal(bearer("agenttok"), "hA");
  assert.equal(refusal.status, 403);
  assert.match(refusal.error, /hA's own agent token/);
  // The tunnel WebSockets are held to the same rule (their token rides a query
  // param, so they cannot share the header path).
  const q = (t) => new URL(`http://x/agent/control?name=hA&token=${t}`);
  assert.equal(strict.agentWsAuthorized(q(strict.hostAgentToken("hA")), { headers: {} }, "hA"), true);
  assert.equal(strict.agentWsAuthorized(q(strict.hostAgentToken("hB")), { headers: {} }, "hA"), false);
  assert.equal(strict.agentWsAuthorized(q("agenttok"), { headers: {} }, "hA"), false);
  // Non-strict (the suite's own module) still accepts the master, so a fleet
  // mid-rollover keeps beating.
  assert.equal(agentWsAuthorized(q("agenttok"), { headers: {} }, "hA"), true);

  // Strict must retire the master AT THE HEARTBEAT'S PRE-BODY GATE too, not
  // only at the authorization check past it: that gate stands in front of a
  // 32 MiB read, so a master still usable through it means a leaked master
  // OOMs the hub on a fleet whose whole point was that it had been retired.
  assert.equal(strict.agentPresented(bearer("agenttok")), false);
  assert.equal(strict.agentPresented(bearer(strict.hostAgentToken("hA"))), true);
  // ...and it refuses with the rollover message, host-less because the host is
  // still unread behind that gate — never a bare "unauthorized" an agent
  // mid-rollover cannot act on.
  const gate = strict.agentPresentedRefusal(bearer("agenttok"));
  assert.equal(gate.status, 403);
  assert.match(gate.error, /each agent's own token \(TURMA_AGENT_STRICT is set\)/);
  assert.deepEqual(strict.agentPresentedRefusal(bearer("garbage")),
    { status: 401, error: "unauthorized" });
  assert.equal(strict.agentPresentedRefusal(bearer(strict.hostAgentToken("hA"))), null);
  // Non-strict lets the master through that gate, as a rollover needs.
  assert.equal(agentPresented(bearer("agenttok")), true);
});

test("XERK-268: the tunnel control channel can only register its own host", async () => {
  // Registering another host's tunnel would route that host's terminals through
  // the impostor, so `?name=` is checked before the socket is accepted.
  await assert.rejects(
    () => wsConnect(`/agent/control?name=tunA&token=${hostAgentToken("tunB")}`, 1500),
    /closed before headers|timed out/
  );
  const ok = await wsConnect(`/agent/control?name=tunA&token=${hostAgentToken("tunA")}`, 1500);
  assert.match(ok.statusLine, /101/);
  ok.socket.destroy();
});

test("XERK-268: a data channel can only be answered by the host it was opened for", async () => {
  // `ch` is unguessable, but it identifies the CHANNEL and proves nothing about
  // who dialled back — the duplex becomes that host's terminal stream.
  await request("POST", "/api/heartbeat", {
    body: {
      device: "dchA",
      sessions: [{ id: "dch1", repo: "Turma", status: "running", ttydPort: 7777,
        worktreePath: "/git/.turma/worktrees/Turma/dch1", transcriptId: "t-dch" }],
    },
    headers: agentHeaders,
  });
  const ctrl = await wsConnect(`/agent/control?name=dchA&token=${hostAgentToken("dchA")}`);
  const frames = collectFrames(ctrl.socket, ctrl.leftover);
  try {
    // Ask for a terminal: the hub sends {open:<ch>} down the control channel.
    request("GET", "/term/dch1/", { headers: userHeaders }).catch(() => {});
    await waitFor(() => frames.some((f) => {
      try { return JSON.parse(f.payload).open; } catch { return false; }
    }));
    const ch = frames.map((f) => { try { return JSON.parse(f.payload).open; } catch { return null; } })
      .find(Boolean);
    assert.ok(ch);

    // Another host answering it is destroyed; the channel stays pending.
    await assert.rejects(
      () => wsConnect(`/agent/data?ch=${ch}&token=${hostAgentToken("dchB")}`, 1500),
      /closed before headers|timed out/
    );
    const ok = await wsConnect(`/agent/data?ch=${ch}&token=${hostAgentToken("dchA")}`, 1500);
    assert.match(ok.statusLine, /101/);
    ok.socket.destroy();
  } finally {
    ctrl.socket.destroy();
  }
});

// Drive one terminal request through the tunnel and hand back the request line
// the hub actually wrote to ttyd. The test IS the wire: a fake ttyd that never
// answers is enough, because what's asserted is the path we sent, not a reply.
async function forwardedRequestLine(host, sessionId, port, pathAndQuery) {
  await request("POST", "/api/heartbeat", {
    body: {
      device: host,
      sessions: [{ id: sessionId, repo: "Turma", status: "running", ttydPort: port,
        worktreePath: `/git/.turma/worktrees/Turma/${sessionId}`, transcriptId: `t-${sessionId}` }],
    },
    headers: agentHeaders,
  });
  const ctrl = await wsConnect(`/agent/control?name=${host}&token=${hostAgentToken(host)}`);
  const ctrlFrames = collectFrames(ctrl.socket, ctrl.leftover);
  let client = null;
  try {
    // Written to a raw socket rather than through http.request: the client
    // normalizes the target it is given (percent-encoding, backslashes), and
    // what is asserted here is the exact bytes the hub received and passed on.
    // Nothing answers — our fake ttyd sends no response — so it is not awaited.
    client = net.connect(server.address().port, "127.0.0.1", () => {
      client.write(
        `GET ${pathAndQuery} HTTP/1.1\r\n` +
          "Host: x\r\n" +
          `Authorization: ${userHeaders.authorization}\r\n\r\n`
      );
    });
    client.on("error", () => {});
    await waitFor(() => ctrlFrames.some((f) => {
      try { return JSON.parse(f.payload).open; } catch { return false; }
    }));
    const ch = ctrlFrames
      .map((f) => { try { return JSON.parse(f.payload).open; } catch { return null; } })
      .find(Boolean);
    const data = await wsConnect(`/agent/data?ch=${ch}&token=${hostAgentToken(host)}`, 1500);
    const dataFrames = collectFrames(data.socket, data.leftover);
    try {
      await waitFor(() => dataFrames.some((f) => f.payload.includes("HTTP/1.1")));
      const sent = Buffer.concat(dataFrames.map((f) => f.payload)).toString("utf8");
      return sent.split("\r\n")[0];
    } finally {
      data.socket.destroy();
    }
  } finally {
    if (client) client.destroy();
    ctrl.socket.destroy();
  }
}

test("the terminal document is fetched at ttyd's base path, slash or no slash", async () => {
  // ttyd runs with `-b /term/<id>` and 302s the bare base path to the slash
  // form, so a hop that strips the trailing slash makes that redirect point at
  // itself and the browser gives up (cloudflared 2026.8.0 stripped it via
  // path.Clean, and every terminal on the fleet died while the agents stayed
  // connected). The hub must not depend on the slash reaching it.
  assert.equal(
    await forwardedRequestLine("slashA", "sl1", 7801, "/term/sl1"),
    "GET /term/sl1/ HTTP/1.1",
  );
});

test("a terminal request that kept its trailing slash is forwarded unchanged", async () => {
  assert.equal(
    await forwardedRequestLine("slashB", "sl2", 7802, "/term/sl2/"),
    "GET /term/sl2/ HTTP/1.1",
  );
});

test("the terminal base path keeps its query string when the slash is restored", async () => {
  assert.equal(
    await forwardedRequestLine("slashC", "sl3", 7803, "/term/sl3?arg=1"),
    "GET /term/sl3/?arg=1 HTTP/1.1",
  );
});

test("restoring the slash does not re-encode the query on its way to ttyd", async () => {
  // The slash is inserted into the original target rather than rebuilt from the
  // parsed URL, so ttyd sees the query byte-for-byte. Rebuilding it would send
  // WHATWG-normalized bytes on the bare path and raw bytes on the slash path —
  // the same terminal reached two ways, arriving differently.
  assert.equal(
    await forwardedRequestLine("slashE", "sl5", 7805, "/term/sl5?a=<>\""),
    "GET /term/sl5/?a=<>\" HTTP/1.1",
  );
});

test("a non-origin-form target is not rewritten into a working terminal", async () => {
  // `new URL` reads a pathname out of absolute-form, protocol-relative and
  // backslash targets too. Those reach ttyd as a 404 today, and restoring a
  // slash must not quietly turn them into a served terminal — hence the rewrite
  // only fires when the target actually STARTS with that pathname.
  //
  // All three spellings are pinned, because they fail differently: a guard that
  // merely CONTAINED the pathname leaves the backslash case correct while
  // splicing a slash into the middle of the other two, so pinning one of them
  // lets that regression ship green.
  assert.equal(
    await forwardedRequestLine("slashF", "sl6", 7806, "/term\\sl6"),
    "GET /term\\sl6 HTTP/1.1",
  );
  assert.equal(
    await forwardedRequestLine("slashG", "sl7", 7807, "http://evil.example/term/sl7"),
    "GET http://evil.example/term/sl7 HTTP/1.1",
  );
  assert.equal(
    await forwardedRequestLine("slashH", "sl8", 7808, "//evil/term/sl8"),
    "GET //evil/term/sl8 HTTP/1.1",
  );
});

test("assets below the terminal base path are never rewritten", async () => {
  // Only the base path gets a slash: ttyd's own asset and WS URLs already sit
  // below it, and appending one there would 404 them.
  assert.equal(
    await forwardedRequestLine("slashD", "sl4", 7804, "/term/sl4/token"),
    "GET /term/sl4/token HTTP/1.1",
  );
});

test("XERK-268: the tunnel maps are null-prototype", () => {
  // Asserted on the maps THEMSELVES, not through a socket: on a plain object a
  // `ch` of `__proto__` read back as Object.prototype — truthy, so it sailed
  // past the "is there a pending channel" check and died on `.resolve is not a
  // function`, out of an async upgrade handler. Reaching that through the wire
  // means the regression is detected by the hub DYING mid-run, which reads as a
  // CI timeout rather than as a failing test.
  assert.equal(Object.getPrototypeOf(controlChannels), null);
  assert.equal(Object.getPrototypeOf(pendingChannels), null);
  // The property that actually matters: an attacker-supplied key is absent, not
  // inherited-and-truthy.
  for (const k of ["__proto__", "constructor", "prototype", "toString", "valueOf"]) {
    assert.equal(pendingChannels[k], undefined, `pendingChannels[${k}]`);
    assert.equal(controlChannels[k], undefined, `controlChannels[${k}]`);
  }
});

test("XERK-268: a `ch` of __proto__ is not a pending channel", async () => {
  await assert.rejects(
    () => wsConnect("/agent/data?ch=__proto__&token=agenttok", 1500),
    /closed before headers|timed out/
  );
  await assert.rejects(
    () => wsConnect("/agent/data?ch=constructor&token=agenttok", 1500),
    /closed before headers|timed out/
  );
  // Still serving: the point of the test is that the hub is alive to answer.
  assert.equal((await request("GET", "/healthz")).status, 200);
});

test("XERK-268: ttyd is proxied with the token that host actually runs", async () => {
  // The hub injects the agent's own credential into every proxied ttyd request.
  // Which one that is follows how the host authenticated its heartbeat, so a
  // half-rolled fleet keeps every terminal working instead of 401ing the hosts
  // that haven't been given their derived token yet.
  await beatAs("ttLegacy", { authorization: "Bearer agenttok" });
  await beatAs("ttBound", asHost("ttBound"));
  const cred = (h) => Buffer.from(ttydAuth(h).slice(6), "base64").toString();
  assert.equal(cred("ttLegacy"), "term:agenttok");
  assert.equal(cred("ttBound"), `term:${hostAgentToken("ttBound")}`);
  // A heartbeat cannot talk itself into the bound branch.
  await request("POST", "/api/heartbeat", {
    body: { device: "ttLegacy", tokenBound: true },
    headers: { authorization: "Bearer agenttok", "content-type": "application/json" },
  });
  assert.equal(cred("ttLegacy"), "term:agenttok");
  // ...nor does it reach the clients as a wire field.
  const fleet = await request("GET", "/api/agents", { headers: userHeaders });
  const row = fleet.body.agents.find((a) => a.key === "ttBound");
  assert.ok(row && !("tokenBound" in row));
});

// Build a client->server (masked, FIN) binary WebSocket frame. The hub's
// wsParser accepts masked or unmasked frames; masking matches what a real
// WS client (the tunnel-agent) sends, so this exercises the same wire bytes.
function wsClientFrame(opcode, payload) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

test("term: terminal HTML serves JBMNerd with font-display:swap (not block)", async () => {
  // The font swap is the whole point of PR #569: the terminal must never go
  // blank waiting on the 1 MB Nerd Font. This drives the REAL proxyTerm path —
  // a fake ttyd answers the document request over the tunnel with a minimal
  // </head>-containing page — and asserts what the browser actually receives.
  const host = "fontSwapHost";
  await request("POST", "/api/heartbeat", {
    body: {
      device: host,
      sessions: [{ id: "fs1", repo: "Turma", status: "running", ttydPort: 7910,
        worktreePath: "/git/.turma/worktrees/Turma/fs1", transcriptId: "t-fs1" }],
    },
    headers: agentHeaders,
  });
  const ctrl = await wsConnect(`/agent/control?name=${host}&token=${hostAgentToken(host)}`);
  const ctrlFrames = collectFrames(ctrl.socket, ctrl.leftover);

  // Fire the document request; the hub cannot answer until the (fake) ttyd
  // responds over the tunnel, so drive the tunnel by hand.
  const docP = request("GET", "/term/fs1/", { headers: userHeaders });

  // Wait for the hub to ask the agent to dial back a data channel.
  await waitFor(() => ctrlFrames.some((f) => {
    try { return JSON.parse(f.payload).open; } catch { return false; }
  }));
  const ch = ctrlFrames
    .map((f) => { try { return JSON.parse(f.payload).open; } catch { return null; } })
    .find(Boolean);
  assert.ok(ch, "hub should request a data channel for the terminal");

  const data = await wsConnect(`/agent/data?ch=${ch}&token=${hostAgentToken(host)}`, 1500);
  const dataFrames = collectFrames(data.socket, data.leftover);

  // Wait for the hub's HTTP request to arrive over the channel, then answer it
  // with a minimal ttyd-style HTML document.
  await waitFor(() => dataFrames.some((f) => f.payload.length), 3000);
  const sent = Buffer.concat(dataFrames.map((f) => f.payload));
  assert.match(sent.toString("utf8"), /GET \/term\/fs1\/ HTTP\/1\.1/);

  const html = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";
  const resp =
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/html\r\n" +
    `Content-Length: ${html.length}\r\n` +
    "\r\n" + html;
  data.socket.write(wsClientFrame(0x2, Buffer.from(resp, "utf8")));

  const doc = await Promise.race([
    docP,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error("terminal document timed out")), 5000);
      t.unref?.();
    }),
  ]);
  assert.equal(doc.status, 200);
  const text = doc.raw;
  // PR #569: text must render immediately on the fallback stack.
  assert.ok(text.includes("font-display:swap"), "terminal HTML must serve font-display:swap");
  assert.ok(!text.includes("font-display:block"), "font-display:block must not regress");
  assert.ok(text.includes("rel='preload' as='font'"), "preload link must survive injection");
  assert.ok(text.includes("@font-face"), "@font-face rule must be injected");
  assert.ok(text.includes("JBMNerd"), "injected family must be JBMNerd");
  // The injected <style> must land before </head>, not in the body.
  assert.ok(
    text.indexOf("@font-face") < text.indexOf("</head>"),
    "@font-face must be injected before </head>"
  );
  // The jump-to-bottom pill is a UNIVERSAL injection — one code path for every
  // runtime (fs1 reports no agentType, i.e. a Claude session). It lands in <head>
  // beside the other injections, which must all coexist.
  assert.ok(text.includes("turmaToBottom"),
    "the scroll-to-bottom control is injected for every session");
  assert.ok(text.indexOf("turmaToBottom") < text.indexOf("</head>"),
    "the control must be injected before </head>");
  assert.ok(text.includes("@font-face") && text.includes("registerOscHandler"),
    "font + clipboard injections must coexist with the scroll control");
  data.socket.destroy();
  ctrl.socket.destroy();

  // The font route itself: content-typed + immutable, so the preloaded fetch
  // hits the browser cache on every repeat load (the swap only matters cold).
  const font = await request("GET", "/term-font.woff2", { headers: userHeaders });
  assert.equal(font.status, 200);
  assert.match(font.headers["content-type"], /^font\/woff2/);
  assert.match(font.headers["cache-control"], /max-age=31536000/);
  assert.ok(font.headers["cache-control"].includes("immutable"), "font must be immutable");
});


test("migrate: the blob relay is scoped to the migration's own two hosts", async () => {
  // The <host> segment is checked against the migration's own halves (XERK-266),
  // so a mis-addressed call can no longer act on someone else's move. It is
  // defense in depth, not identity: the segment is self-asserted, and a caller
  // that names the real source/target still passes (XERK-268).
  await migHost("hsA", "hs.atlassian.net");
  await migHost("hsB", "hs.atlassian.net");
  await migHost("hsC", "hs.atlassian.net"); // same org, no part of the move
  const mid = (await migrate("hsA", "s1", { host: "hsB" })).body.migrationId;
  const agentTok = { authorization: "Bearer agenttok" };

  // A host that is not the SOURCE can't inject a bundle: 404 (not 403 — the
  // relay doesn't confirm the id exists), and the move stays exporting.
  const inject = await requestRaw("POST", `/api/agents/hsC/migrations/${mid}/blob`,
    { body: Buffer.from("ATTACKER-BYTES"), headers: { ...agentTok, "content-type": "application/octet-stream" } });
  assert.equal(inject.status, 404);
  assert.equal(migrations.get(mid).phase, "exporting");
  assert.equal(migrations.get(mid).blobPath, null);
  assert.ok(!agents.hsB.commands.some((c) => c.type === "importSession"));

  // The POST compare is EXACT, and this has to be asked while the migration is
  // still AWAITING its bundle — that is the state where the host compare is the
  // only thing that can answer. Asked after the upload it would sit behind the
  // phase check and "pass" on a build whose compare is lenient, which is not
  // what it is here to catch.
  const nearMissUp = await requestRaw("POST", `/api/agents/HSA/migrations/${mid}/blob`,
    { body: Buffer.from("x"), headers: { ...agentTok, "content-type": "application/octet-stream" } });
  assert.equal(nearMissUp.status, 404);
  assert.equal(migrations.get(mid).phase, "exporting");

  // The real source's upload still works.
  const blob = Buffer.from("PRETEND-GZIP-TAR-BYTES");
  const up = await requestRaw("POST", `/api/agents/hsA/migrations/${mid}/blob`,
    { body: blob, headers: { ...agentTok, "content-type": "application/octet-stream" } });
  assert.equal(up.status, 200);

  // A host that is not the TARGET can't read the bundle — it is the raw
  // transcript of another host's conversation.
  const steal = await requestRaw("GET", `/api/agents/hsC/migrations/${mid}/blob`,
    { headers: agentTok });
  assert.equal(steal.status, 404);
  // The source can't read it back either — only the target has business with it.
  const backAtSrc = await requestRaw("GET", `/api/agents/hsA/migrations/${mid}/blob`,
    { headers: agentTok });
  assert.equal(backAtSrc.status, 404);
  // The real target still gets the bytes.
  const dl = await requestRaw("GET", `/api/agents/hsB/migrations/${mid}/blob`,
    { headers: agentTok });
  assert.equal(dl.status, 200);
  assert.ok(blob.equals(dl.buf));

  // Same on the GET: a host name that merely resembles the target's is a
  // different host, and a lenient compare would hand it the bundle.
  const nearMiss = await requestRaw("GET", `/api/agents/HSB/migrations/${mid}/blob`,
    { headers: agentTok });
  assert.equal(nearMiss.status, 404);
});

test("migrate: every POST refusal is the same 404, so the responses name no host", async () => {
  // `<host>` is self-asserted (XERK-268), so any refusal a NON-source can't
  // also get names the source to anyone holding the id — and then the injection
  // above is a matter of re-addressing. The refusals are therefore uniform: a
  // wrong host, a wrong phase, an empty body and a spool that could not be
  // written must be indistinguishable.
  // This pins the RESPONSES only. The route still leaks the source through the
  // timing of an accepted vs rejected POST, which no test here can close —
  // see the route's comment; that one needs XERK-268.
  await migHost("orA", "or.atlassian.net");
  await migHost("orB", "or.atlassian.net");
  await migHost("orC", "or.atlassian.net");
  const agentTok = { authorization: "Bearer agenttok", "content-type": "application/octet-stream" };
  const post = (host, id, body) =>
    requestRaw("POST", `/api/agents/${host}/migrations/${id}/blob`, { body, headers: agentTok });
  const mid = (await migrate("orA", "s1", { host: "orB" })).body.migrationId;

  // The empty-body probe is the cheap one: it mutates nothing, so without this
  // the source could be found silently, at no cost and without tripping a move.
  const emptyAtSrc = await post("orA", mid, Buffer.alloc(0));
  const emptyElsewhere = await post("orC", mid, Buffer.alloc(0));
  assert.equal(emptyAtSrc.status, 404);
  assert.deepEqual(emptyAtSrc.body, emptyElsewhere.body);
  assert.equal(emptyAtSrc.status, emptyElsewhere.status);
  assert.equal(migrations.get(mid).phase, "exporting"); // and nothing moved

  // Same once the real bundle has landed: the source re-POSTing (at-least-once
  // delivery makes that ordinary) reads exactly like a stranger's probe.
  assert.equal((await post("orA", mid, Buffer.from("REAL"))).status, 200);
  const rePost = await post("orA", mid, Buffer.from("REAL"));
  const stranger = await post("orC", mid, Buffer.from("REAL"));
  assert.equal(rePost.status, 404);
  assert.deepEqual(rePost.body, stranger.body);
  // An unknown id answers the same thing again.
  const unknown = await post("orA", "0123456789abcdef", Buffer.from("REAL"));
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, rePost.body);
  // The re-POST didn't disturb the move it was refused from.
  assert.equal(migrations.get(mid).phase, "importing");
  assert.ok(fs.readFileSync(migrations.get(mid).blobPath).equals(Buffer.from("REAL")));

  // The refusal AFTER the body read counts too: only the real source can reach
  // "source session gone", so a status of its own would name it. The reply is
  // the same 404; the RECORD keeps the true reason for the operator.
  await migHost("orD", "or.atlassian.net", { session: "s9" });
  await migHost("orE", "or.atlassian.net");
  const gone = (await migrate("orD", "s9", { host: "orE" })).body.migrationId;
  await request("POST", "/api/heartbeat", { // the source session vanishes mid-move
    body: { device: "orD", repos: [{ name: "Turma", path: "/git/Turma" }], sessions: [] },
    headers: agentHeaders,
  });
  const afterGone = await post("orD", gone, Buffer.from("REAL"));
  assert.equal(afterGone.status, 404);
  assert.deepEqual(afterGone.body, rePost.body);
  assert.equal(migrations.get(gone).phase, "failed");
  assert.equal(migrations.get(gone).error, "source session gone");});

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
  // A named endpoint model is charset-gated exactly like the /model-source route
  // — including when modelSource is OMITTED, so parity holds on every entry.
  const badLm = await request("POST", "/api/agents/lm5/sessions", {
    body: { repo: "Turma", localModel: "bad name!" }, headers: userHeaders,
  });
  assert.equal(badLm.status, 400);
  const badLmLocal = await request("POST", "/api/agents/lm5/sessions", {
    body: { repo: "Turma", modelSource: "local", localModel: "has/space !" }, headers: userHeaders,
  });
  assert.equal(badLmLocal.status, 400);
});

test("http: spawning onto local is refused on a host without one", async () => {
  await request("POST", "/api/heartbeat", { body: { device: "lm6" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/lm6/sessions", {
    body: { repo: "Turma", modelSource: "local" }, headers: userHeaders,
  });
  assert.equal(res.status, 409);
});

test("http: /model on a local session picks an ENDPOINT model, validated by membership", async () => {
  // XERK-489: a local session's model is an endpoint model, not a Claude alias,
  // so the /model route no longer 409s it — the agent rewrites the env and
  // relaunches. But it accepts ONLY a model the host's discovered set serves,
  // and against the endpoint charset (ids carry ':' the Claude-alias regex bars).
  await request("POST", "/api/heartbeat", {
    body: {
      device: "lm7",
      localModel: { available: true, model: "gpt-oss:120b", defaultModel: "gpt-oss:120b",
        models: [{ id: "gpt-oss:120b", contextTokens: 81920 },
                 { id: "qwen:32b", contextTokens: 32768 }] },
      sessions: [
        { id: "loc", repo: "R", status: "running", modelSource: "local" },
        { id: "sub", repo: "R", status: "running", modelSource: "subscription" },
      ],
    },
    headers: agentHeaders,
  });
  // A served endpoint model (note the colon) is accepted.
  const ok = await request("POST", "/api/agents/lm7/sessions/loc/model", {
    body: { model: "qwen:32b" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
  // One the host does NOT serve is refused 409.
  const refused = await request("POST", "/api/agents/lm7/sessions/loc/model", {
    body: { model: "not-served" }, headers: userHeaders,
  });
  assert.equal(refused.status, 409);
  // A subscription session still takes a Claude alias through the picker path.
  const sub = await request("POST", "/api/agents/lm7/sessions/sub/model", {
    body: { model: "opus" }, headers: userHeaders,
  });
  assert.equal(sub.status, 200);
});

test("http: /model on a local session carries the context override (XERK-489)", async () => {
  await request("POST", "/api/heartbeat", {
    body: {
      device: "lm8",
      localModel: { available: true, model: "qwen:32b", defaultModel: "qwen:32b",
        models: [{ id: "qwen:32b", contextTokens: 32768 }] },
      sessions: [{ id: "loc", repo: "R", status: "running", modelSource: "local" }],
    },
    headers: agentHeaders,
  });
  // A positive-int context rides the setModel command as localContext.
  await request("POST", "/api/agents/lm8/sessions/loc/model", {
    body: { model: "qwen:32b", context: 16000 }, headers: userHeaders,
  });
  let cmd = agents.lm8.commands.filter((c) => c.type === "setModel").pop();
  assert.equal(cmd.model, "qwen:32b");
  assert.equal(cmd.localContext, 16000);
  // A non-int / non-positive context is dropped, so the served figure applies.
  await request("POST", "/api/agents/lm8/sessions/loc/model", {
    body: { model: "qwen:32b", context: "big" }, headers: userHeaders,
  });
  cmd = agents.lm8.commands.filter((c) => c.type === "setModel").pop();
  assert.equal("localContext" in cmd, false);
});

test("http: spawn onto local carries localModel + localContext (XERK-489)", async () => {
  await request("POST", "/api/heartbeat", {
    body: {
      device: "lm9",
      localModel: { available: true, model: "qwen:32b", defaultModel: "qwen:32b",
        models: [{ id: "qwen:32b", contextTokens: 32768 }] },
    },
    headers: agentHeaders,
  });
  const ok = await request("POST", "/api/agents/lm9/sessions", {
    body: { repo: "Turma", modelSource: "local", localModel: "qwen:32b", localContext: 20000 },
    headers: userHeaders,
  });
  assert.equal(ok.status, 200);
  const cmd = agents.lm9.commands.filter((c) => c.type === "spawn").pop();
  assert.equal(cmd.localModel, "qwen:32b");
  assert.equal(cmd.localContext, 20000);
  // A non-int context is dropped (the agent clamps a real one to the served window).
  const ok2 = await request("POST", "/api/agents/lm9/sessions", {
    body: { repo: "Turma", modelSource: "local", localModel: "qwen:32b", localContext: -5 },
    headers: userHeaders,
  });
  assert.equal(ok2.status, 200);
  const cmd2 = agents.lm9.commands.filter((c) => c.type === "spawn").pop();
  assert.equal("localContext" in cmd2, false);
});

test("normalizeSessions coerces the per-session local model fields (XERK-489)", () => {
  // localModelName is String? and localModelContext is Int? on Android, which
  // decodes /api/agents atomically — a wrong-typed one from a rogue agent must
  // degrade to null, never fail the whole fleet decode.
  const p = { device: "h", sessions: [
    { id: "a", localModelName: "qwen:32b", localModelContext: 32768 },   // good
    { id: "b", localModelName: 123, localModelContext: 1.5 },            // bad types
    { id: "c", localModelName: "m", localModelContext: 9999999999 },     // out of Int
    { id: "d", localModelName: "m", localModelContext: -5 },             // non-positive
  ] };
  hub.normalizeRecord(p);
  assert.deepEqual(p.sessions.map((s) => [s.localModelName, s.localModelContext]), [
    ["qwen:32b", 32768],
    [null, null],
    ["m", null],
    ["m", null],
  ]);
});

test("normalizeSessions coerces the context-meter fields (XERK-489 Phase 4)", () => {
  // lastTurnContextTokens + contextWindowTokens are Int? on Android; a rogue
  // figure must degrade to null (the client hides the meter), never fail the
  // whole /api/agents decode nor divide by junk.
  const p = { device: "h", sessions: [
    { id: "a", lastTurnContextTokens: 21500, contextWindowTokens: 200000 },   // good
    { id: "b", lastTurnContextTokens: 1.5, contextWindowTokens: "lots" },      // bad
    { id: "c", lastTurnContextTokens: 9999999999, contextWindowTokens: -1 },   // out of range
  ] };
  hub.normalizeRecord(p);
  assert.deepEqual(
    p.sessions.map((s) => [s.lastTurnContextTokens, s.contextWindowTokens]),
    [[21500, 200000], [null, null], [null, null]],
  );
});

test("heartbeat: localModel is a known key, not an unknown-field remnant", async () => {
  // It is the capability flag the hub and every composer gate on. Dropping it
  // from HEARTBEAT_KNOWN_KEYS would make the control vanish fleet-wide.
  assert.ok(hub.HEARTBEAT_KNOWN_KEYS.has("localModel"));
});

test("heartbeat: dsh flag + session agentType survive into the fleet payload (XERK-465)", async () => {
  hub.__setDshEnabled(true);
  await request("POST", "/api/heartbeat", {
    body: {
      device: "dsh1",
      dsh: { available: true },
      sessions: [{ id: "s1", repo: "Turma", status: "running", agentType: "dsh" }],
    },
    headers: agentHeaders,
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const host = res.body.agents.find((a) => a.device === "dsh1");
  assert.equal(host.dsh.available, true);
  // The per-session runtime the card chips off must reach clients too.
  assert.equal(host.sessions[0].agentType, "dsh");
});

test("http: spawn validates agentType like modelSource does (XERK-465)", async () => {
  hub.__setDshEnabled(true);
  await request("POST", "/api/heartbeat", {
    body: { device: "dsh2", dsh: { available: true } }, headers: agentHeaders,
  });
  // Junk must 400 here rather than land as an errored session card on the host.
  const bad = await request("POST", "/api/agents/dsh2/sessions", {
    body: { repo: "Turma", agentType: "codex; rm -rf /" }, headers: userHeaders,
  });
  assert.equal(bad.status, 400);
  const ok = await request("POST", "/api/agents/dsh2/sessions", {
    body: { repo: "Turma", agentType: "dsh" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
});

test("http: spawning dsh is refused on a host that does not offer it (XERK-465)", async () => {
  // No dsh block -> capability absent -> a stale composer's dsh click gets a
  // clear 409 rather than a session the host silently drops.
  await request("POST", "/api/heartbeat", { body: { device: "dsh3" }, headers: agentHeaders });
  const res = await request("POST", "/api/agents/dsh3/sessions", {
    body: { repo: "Turma", agentType: "dsh" }, headers: userHeaders,
  });
  assert.equal(res.status, 409);
  // ...but plain claude still spawns.
  const ok = await request("POST", "/api/agents/dsh3/sessions", {
    body: { repo: "Turma", agentType: "claude" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
});

test("heartbeat: dsh is a known key, not an unknown-field remnant (XERK-465)", async () => {
  assert.ok(hub.HEARTBEAT_KNOWN_KEYS.has("dsh"));
});

// ---- XERK-506 [Qwen A]: the qwen runtime field + capability flag -------------

test("normalizeQwen coerces the capability flag strictly boolean (XERK-506)", () => {
  hub.__setQwenEnabled(true);
  // Same atomic-decode hazard as normalizeDsh: one host's bad `qwen` block would
  // fail Android's whole /api/agents decode and empty the fleet.
  const norm = (qwen) => { const p = { device: "h", qwen }; hub.normalizeQwen(p); return p.qwen; };
  assert.deepEqual(norm({ available: true }), { available: true });
  // Strictly boolean: a truthy non-true value reads as "cannot do qwen".
  assert.deepEqual(norm({ available: "yes" }), { available: false });
  assert.deepEqual(norm({ available: 1 }), { available: false });
  assert.deepEqual(norm({ available: false }), { available: false });
  // [Qwen A] carries ONLY {available}: any unknown extra key is dropped (rebuilt,
  // not spread), so no qwen model plumbing leaks onto the wire before [Qwen B].
  assert.deepEqual(norm({ available: true, models: [{ id: "x" }] }), { available: true });
  // Not an object at all -> null, which every client reads as "cannot do qwen".
  assert.equal(norm("yes"), null);
  assert.equal(norm([1]), null);
  assert.equal(norm(null), null);
  // A pre-qwen agent sends nothing; the key stays absent, not an explicit null.
  const old = { device: "h" };
  hub.normalizeQwen(old);
  assert.ok(!("qwen" in old));
});

test("QWEN_ENABLED flipped OFF makes the hub serve an inert qwen block and no qwen runtime", () => {
  // QWEN_ENABLED now ships TRUE (the XERK-520 go-live), but the kill switch must
  // still gate when an operator flips it off — prove the mechanism holds so qwen
  // can be disabled fleet-wide without every hub gate having rotted. (afterEach
  // resets it to false, so set it explicitly here rather than lean on ordering.)
  hub.__setQwenEnabled(false);
  // qwenAvailable refuses whatever an agent claims.
  assert.equal(hub.qwenAvailable({ qwen: { available: true } }), false);
  // normalizeQwen forces the block inert even from a populated agent report.
  const p = { qwen: { available: true } };
  hub.normalizeQwen(p);
  assert.deepEqual(p.qwen, { available: false });
  // normalizeRecord (the real ingest/restore path) coerces a qwen session runtime
  // to claude on the wire, so no client renders a session as qwen.
  const rec = { device: "h", qwen: { available: true }, sessions: [{ id: "s1", agentType: "qwen" }] };
  hub.normalizeRecord(rec);
  assert.equal(rec.qwen.available, false);
  assert.equal(rec.sessions[0].agentType, "");
});

test("heartbeat: qwen flag + session agentType survive into the fleet payload (XERK-506)", async () => {
  hub.__setQwenEnabled(true);
  await request("POST", "/api/heartbeat", {
    body: {
      device: "qwen1",
      qwen: { available: true },
      sessions: [{ id: "s1", repo: "Turma", status: "running", agentType: "qwen" }],
    },
    headers: agentHeaders,
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const host = res.body.agents.find((a) => a.device === "qwen1");
  assert.equal(host.qwen.available, true);
  assert.equal(host.sessions[0].agentType, "qwen");
});

test("heartbeat: triage flag + per-ticket assessment survive into the fleet payload (XERK-481)", async () => {
  try {
    await request("POST", "/api/heartbeat", {
      body: {
        device: "triage1",
        triage: { available: true },
        jira: { siteKey: "acme", tickets: [
          { key: "ENG-1", summary: "x", triage: { priority: "P0", actionable: true, source: "auto" } }] },
      },
      headers: agentHeaders,
    });
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    const host = res.body.agents.find((a) => a.device === "triage1");
    assert.equal(host.triage.available, true);
    assert.deepEqual(host.jira.tickets[0].triage, { priority: "P0", actionable: true, source: "auto" });
  } finally {
    delete agents["triage1"];
  }
});

test("heartbeat: a pre-triage agent carries no triage block (absence == cannot triage, XERK-481)", async () => {
  try {
    await request("POST", "/api/heartbeat", {
      body: { device: "old1", jira: { siteKey: "acme", tickets: [{ key: "ENG-1", summary: "x" }] } },
      headers: agentHeaders,
    });
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    const host = res.body.agents.find((a) => a.device === "old1");
    // Absent, never a fabricated {available:false} — clients read absent as
    // "this host can't triage", and the ticket carries no assessment.
    assert.equal(host.triage == null, true);
    assert.ok(!("triage" in host.jira.tickets[0]));
  } finally {
    delete agents["old1"];
  }
});

// ---- XERK-521: per-host default runtime (defaultRuntime) --------------------

test("normalizeDefaultRuntime coerces to the runtime enum, absent stays absent", () => {
  hub.__setQwenEnabled(true);
  hub.__setDshEnabled(true);
  const norm = (v) => { const p = { device: "h", defaultRuntime: v }; hub.normalizeDefaultRuntime(p); return p.defaultRuntime; };
  // Valid enum values pass through (both runtimes enabled here).
  assert.equal(norm("claude"), "claude");
  assert.equal(norm("qwen"), "qwen");
  assert.equal(norm("dsh"), "dsh");
  // Anything else — unknown string, non-string, the same atomic-decode hazard as
  // the qwen/dsh blocks — reads as "claude", the composer's "unchanged" default.
  assert.equal(norm("codex"), "claude");
  assert.equal(norm(123), "claude");
  assert.equal(norm(null), "claude");
  assert.equal(norm({}), "claude");
  // A pre-XERK-521 agent sends nothing; the key stays absent (client treats it
  // as claude), not an explicit value.
  const old = { device: "h" };
  hub.normalizeDefaultRuntime(old);
  assert.ok(!("defaultRuntime" in old));
});

test("normalizeDefaultRuntime forces a disabled runtime to claude (kill-switch consistency)", () => {
  // With a runtime's fleet-wide kill switch OFF, its capability block is served
  // inert — so a served default naming it must also fall to claude, or the
  // composer would pre-select a runtime whose option normalizeQwen/normalizeDsh
  // just hid. Deliberately does NOT flip the flags (pins the shipped default).
  assert.equal(hub.__getQwenEnabled(), false);
  assert.equal(hub.__getDshEnabled(), false);
  const norm = (v) => { const p = { defaultRuntime: v }; hub.normalizeDefaultRuntime(p); return p.defaultRuntime; };
  assert.equal(norm("qwen"), "claude");
  assert.equal(norm("dsh"), "claude");
  assert.equal(norm("claude"), "claude");
  // The real ingest/restore path coerces it too.
  const rec = { device: "h", defaultRuntime: "qwen" };
  hub.normalizeRecord(rec);
  assert.equal(rec.defaultRuntime, "claude");
});

test("heartbeat: defaultRuntime survives into the fleet payload (XERK-521)", async () => {
  hub.__setQwenEnabled(true);
  await request("POST", "/api/heartbeat", {
    body: { device: "drt1", qwen: { available: true }, defaultRuntime: "qwen" },
    headers: agentHeaders,
  });
  const res = await request("GET", "/api/agents", { headers: userHeaders });
  const host = res.body.agents.find((a) => a.device === "drt1");
  assert.equal(host.defaultRuntime, "qwen");
});

test("http: spawn validates a qwen agentType and 409s a host without the capability (XERK-506)", async () => {
  hub.__setQwenEnabled(true);
  // A host offering qwen accepts the choice; one without it 409s a stale click.
  await request("POST", "/api/heartbeat", {
    body: { device: "qwen2", qwen: { available: true } }, headers: agentHeaders,
  });
  await request("POST", "/api/heartbeat", { body: { device: "qwen3" }, headers: agentHeaders });
  const ok = await request("POST", "/api/agents/qwen2/sessions", {
    body: { repo: "Turma", agentType: "qwen" }, headers: userHeaders,
  });
  assert.equal(ok.status, 200);
  const refused = await request("POST", "/api/agents/qwen3/sessions", {
    body: { repo: "Turma", agentType: "qwen" }, headers: userHeaders,
  });
  assert.equal(refused.status, 409);
  // The enum accepts claude/dsh/qwen and 400s anything else.
  const bad = await request("POST", "/api/agents/qwen2/sessions", {
    body: { repo: "Turma", agentType: "codex" }, headers: userHeaders,
  });
  assert.equal(bad.status, 400);
});

test("heartbeat: qwen is a known key, not an unknown-field remnant (XERK-506)", () => {
  assert.ok(hub.HEARTBEAT_KNOWN_KEYS.has("qwen"));
});


// ---- XERK-273: the concurrent-connection cap ---------------------------------

test("connections: the cap is applied to the listening server", async () => {
  // Unset, `maxConnections` is Infinity and nothing bounds concurrent sockets —
  // which is the whole bug: 1024 overlapping heartbeats OOM-kill the hub at the
  // deployed 256m regardless of how small each body is, because the cost is per
  // CONNECTION. A regression here is silent (every test still passes, the hub
  // just dies under load), so the value is pinned rather than merely non-zero.
  assert.equal(server.maxConnections, 256);
});

test("connections: a connection over the cap is refused, and says so", async () => {
  const open = [];
  const connections = () =>
    new Promise((res, rej) =>
      server.getConnections((e, n) => (e ? rej(e) : res(n)))
    );
  const connect = () =>
    new Promise((res, rej) => {
      const s = net.connect(server.address().port, "127.0.0.1");
      s.once("connect", () => res(s));
      s.once("error", rej);
      open.push(s);
    });

  const before = server.maxConnections;
  try {
    // Relative to what is already open: earlier tests leave keep-alive sockets
    // behind, so an absolute cap here would refuse the probe's own two sockets.
    const base = await connections();
    server.maxConnections = base + 2;
    await connect();
    await connect();
    while ((await connections()) < base + 2) await new Promise((r) => setImmediate(r));

    // The refusal is observable ONLY as the `drop` event: Node destroys the
    // socket before parsing, so there is no request to answer with a 503 and
    // nothing but this event (and the log it drives) to diagnose it by.
    const dropped = new Promise((res) => server.once("drop", () => res(true)));
    const extra = await connect();
    // ...and the client just gets closed on, with no HTTP response at all.
    const closed = new Promise((res) => extra.once("close", () => res(true)));
    extra.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n");
    let answered = "";
    extra.on("data", (c) => (answered += c));

    assert.equal(await dropped, true);
    assert.equal(await closed, true);
    assert.equal(answered, "");
  } finally {
    server.maxConnections = before;
    for (const s of open) s.destroy();
  }
});

// ---- XERK-258: the in-flight body budget ------------------------------------
// The most a single real body can charge: the per-request wire cap at full
// parse cost. Strictly below the ceiling by design, so a body holding the
// exclusive lane always leaves room beside it — staging anything larger models
// a body that cannot exist.
const bigMax = () => hub.BODY_INFLIGHT_MAX * hub.BODY_PARSE_COST;

// Mirrors BODY_PARSE_COST in server.js: a JSON body is charged a multiple of
// its wire size, because the string and JSON.parse's object graph are the real
// bill. Held here so a test can assert the exact charge rather than "> 0".
const BODY_PARSE_COST_EXPECTED = 3;

test("budget: the ceilings are derived from the container limit, and only tighten", async () => {
  // Fixed numbers are what made this a bug: UPLOAD_TOTAL_MAX_BYTES was a flat
  // 128 MiB, DOUBLE the 256m the hub is deployed with, so it could never refuse
  // anything before the OOM killer fired. Every ceiling is now a fraction of the
  // limit -- and capped, so a big host can't hand one request the whole machine.
  assert.ok(hub.MEMORY_LIMIT > 0);
  assert.ok(hub.BODY_INFLIGHT_TOTAL_MAX <= Math.floor(hub.MEMORY_LIMIT / 2));
  assert.ok(hub.BODY_INFLIGHT_MAX <= Math.floor(hub.MEMORY_LIMIT / 8));
  assert.ok(hub.BODY_INFLIGHT_MAX <= 32 << 20, "one body may never exceed the sanity bound");
  assert.ok(hub.UPLOAD_TOTAL_MAX_BYTES <= Math.floor(hub.MEMORY_LIMIT / 4));
  // The load-bearing relationship: ONE max-size body, at its full parse cost,
  // must leave room beside it. Otherwise a body holding the exclusive lane
  // starves ordinary traffic outright -- the total outage that separating the
  // lanes was meant to end -- and the worst case stops fitting the container.
  assert.ok(
    hub.BODY_INFLIGHT_MAX * hub.BODY_PARSE_COST < hub.BODY_INFLIGHT_TOTAL_MAX,
    "a max-size body must not be able to consume the whole ceiling"
  );
});

test("budget: one big body may exceed the room left, and exactly one", async () => {
  assert.equal(hub.bodyInflightHeld(), 0, "no request should be in flight here");
  // Leave less room than one big body needs, so the big lane is the only way in.
  // (With the hub quiet a max-size body simply fits the shared lane -- the
  // exclusive lane exists for when it does not.)
  const stage = hub.BODY_INFLIGHT_TOTAL_MAX - Math.floor(bigMax() / 2);
  try {
    hub.chargeBody(stage, "shared");
    // Keyed on the hub being bit-for-bit IDLE instead, this was unusable: one
    // trickling request defeated it, and a real 65 MiB migration bundle was
    // refused with 3 KB in flight -- stranding the move -- while HEARTBEAT_MAX
    // went on advertising a 32 MiB beat no concurrent moment would accept.
    assert.equal(hub.bodyLaneFor(bigMax()), "big",
      "a big body is admitted even though the hub is not idle");
    hub.chargeBody(bigMax(), "big");
    assert.equal(hub.bodyLaneFor(bigMax()), null, "a second big body must be refused");
    hub.releaseBody(bigMax(), "big");
    assert.equal(hub.bodyLaneFor(bigMax()), "big", "the lane frees for the next one");
  } finally {
    hub.releaseBody(stage, "shared");
  }
  assert.equal(hub.bodyInflightHeld(), 0, "every charge must be given back");
});

test("budget: ordinary bodies share the budget until it is full", async () => {
  const total = hub.BODY_INFLIGHT_TOTAL_MAX;
  try {
    assert.equal(hub.bodyLaneFor(Math.floor(total / 2)), "shared");
    hub.chargeBody(Math.floor(total / 2), "shared");
    assert.equal(hub.bodyLaneFor(Math.floor(total / 2)), "shared");
    hub.chargeBody(Math.floor(total / 2), "shared");
    // Full: the next ordinary body falls through to the big lane rather than
    // being admitted over budget.
    assert.equal(hub.bodyLaneFor(total), "big");
    assert.ok(hub.bodyInflightHeld() <= total, "the shared lane never exceeds the budget");
  } finally {
    hub.releaseBody(hub.bodyInflightHeld(), "shared");
  }
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("budget: a leaked big lane would refuse every large body forever", async () => {
  // The one bookkeeping slip that is silent AND permanent: the bytes come back
  // but the lane does not, and from then on nothing large is ever admitted.
  const stage = hub.BODY_INFLIGHT_TOTAL_MAX - Math.floor(bigMax() / 2);
  try {
    hub.chargeBody(stage, "shared");
    hub.chargeBody(bigMax(), "big");
    hub.releaseBody(bigMax(), "big");
    assert.equal(hub.bodyLaneFor(bigMax()), "big", "the lane must be free again");
  } finally {
    hub.releaseBody(stage, "shared");
  }
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("budget: a release can never drive the held total negative", async () => {
  // A double release would read as "idle" and silently disable the budget --
  // the same OOM again, only with the guard apparently in place.
  hub.releaseBody(1 << 30, "shared");
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("http: a request over the budget is refused 503, not 413", async () => {
  // The two refusals mean opposite things to the caller: 413 says "your body is
  // too big, send less", 503 says "the hub is momentarily full, send it again".
  // Collapsing them would tell an agent to shrink a beat that was fine.
  try {
    // BOTH lanes have to be occupied for a refusal: the shared budget full, and
    // the one big-body lane taken. With the big lane free, a body that does not
    // fit the shared budget is admitted there -- that is the point of it.
    hub.chargeBody(hub.BODY_INFLIGHT_TOTAL_MAX, "shared");
    hub.chargeBody(1, "big");
    const res = await request("POST", "/api/heartbeat", {
      body: { device: "budget-host" },
      headers: { ...agentHeaders, connection: "close" },
    });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /busy/i);
    assert.equal(res.body.limit, hub.BODY_INFLIGHT_TOTAL_MAX);
  } finally {
    hub.releaseBody(hub.BODY_INFLIGHT_TOTAL_MAX, "shared");
    hub.releaseBody(1, "big");
  }
  // And with the budget clear again the very same beat succeeds -- the refusal
  // was transient, which is exactly what the 503 promised.
  const ok = await request("POST", "/api/heartbeat", {
    body: { device: "budget-host" }, headers: agentHeaders,
  });
  assert.equal(ok.status, 200);
});

test("budget: a body that completes gives its charge back", async () => {
  // The leak that would matter most: a charge outliving its buffer ratchets the
  // budget shut, and the hub 503s everything forever with nothing logged.
  assert.equal(hub.bodyInflightHeld(), 0);
  for (let i = 0; i < 5; i++) {
    const res = await request("POST", "/api/heartbeat", {
      body: { device: "leak-host", pad: "z".repeat(64 * 1024) }, headers: agentHeaders,
    });
    assert.equal(res.status, 200);
  }
  assert.equal(hub.bodyInflightHeld(), 0, "nothing may still be charged once the beats are answered");
});

test("budget: a body refused for being too large also gives its charge back", async () => {
  // The 413 path releases on a DIFFERENT branch to the success path, so it is
  // its own way for the budget to leak.
  assert.equal(hub.bodyInflightHeld(), 0);
  const res = await request("POST", "/api/heartbeat", {
    body: { device: "big-host", pad: "y".repeat((33 << 20)) },
    headers: { ...agentHeaders, connection: "close" },
  });
  assert.equal(res.status, 413);
  assert.equal(hub.bodyInflightHeld(), 0, "a refused body must not stay charged");
});

test("budget: a declared Content-Length reserves NOTHING until the bytes arrive", async () => {
  // Charging the declared length turned the budget into a cheap DoS: one socket
  // that declares a huge body and then sends nothing held the whole budget for
  // the request timeout, and every other body on the hub was refused 503. It
  // needs no credentials (/api/login reads a body before any auth gate), no
  // bandwidth, and is renewable -- a worse outage than the OOM this prevents.
  assert.equal(hub.bodyInflightHeld(), 0);
  const sock = net.connect(server.address().port, "127.0.0.1");
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.write(
      "POST /api/login HTTP/1.1\r\nHost: x\r\n" +
        "Content-Type: application/json\r\nContent-Length: 33554432\r\n\r\n{"
    );
    // Give the hub every chance to have charged something for the 32 MiB the
    // socket claims it is about to send.
    await new Promise((r) => setTimeout(r, 150));
    // Charging the declaration would hold 32 MiB x BODY_PARSE_COST here. Only
    // what genuinely arrived may be charged, which is at most the single byte.
    assert.ok(
      hub.bodyInflightHeld() <= 1 * BODY_PARSE_COST_EXPECTED,
      `nothing may be reserved for bytes that never came (held ${hub.bodyInflightHeld()})`
    );

    // ...and the hub is still fully serving everyone else meanwhile.
    const beat = await request("POST", "/api/heartbeat", {
      body: { device: "unwedged-host" }, headers: agentHeaders,
    });
    assert.equal(beat.status, 200);
  } finally {
    sock.destroy();
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.bodyInflightHeld(), 0, "the abandoned read must give its charge back");
});

test("budget: a lone oversized body still completes once it has started", async () => {
  // The flip side of charging only real bytes: a body admitted into an idle hub
  // must not be refused mid-stream by its OWN accumulated charge. This is what
  // keeps a single 65 MiB migration bundle -- larger than the whole budget at
  // 256m -- working.
  assert.equal(hub.bodyInflightHeld(), 0);
  const pad = "q".repeat(Math.min(4 << 20, hub.BODY_INFLIGHT_MAX - (1 << 16)));
  const res = await request("POST", "/api/heartbeat", {
    body: { device: "lone-big-host", pad }, headers: agentHeaders,
  });
  assert.equal(res.status, 200);
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("http: a large LEGAL body is admitted while other traffic is in flight", async () => {
  // The rule this replaced was keyed on the hub being bit-for-bit idle, so a few
  // KB in flight refused a body the hub itself advertises as legal: a real
  // 65 MiB migration bundle 503'd with 3 KB held, stranding the move, and
  // HEARTBEAT_MAX promised a 32 MiB beat that no concurrent moment accepted.
  // A ceiling only reachable on a perfectly idle hub is not a ceiling.
  assert.equal(hub.bodyInflightHeld(), 0);
  try {
    // Leave the shared lane with almost nothing free, so a modest and plainly
    // legal body cannot fit it. Expressed against the budget rather than in
    // absolute bytes, because the ceilings scale with the container and the
    // suite does not run in one.
    hub.chargeBody(hub.BODY_INFLIGHT_TOTAL_MAX - 1024, "shared");
    const wire = 64 * 1024; // costs 192 KiB, far past the 1 KiB left
    assert.ok(wire <= hub.BODY_INFLIGHT_MAX, "the probe must still be a LEGAL body");
    const res = await request("POST", "/api/heartbeat", {
      body: { device: "big-legal-host", pad: "w".repeat(wire) }, headers: agentHeaders,
    });
    assert.equal(res.status, 200, "a body within HEARTBEAT_MAX must not be refused");
  } finally {
    hub.releaseBody(hub.bodyInflightHeld(), "shared");
  }
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("http: an oversize body is NOT refused on its declaration", async () => {
  // XERK-235 in one assertion. Refusing at header time makes Node close the
  // connection under a request still being written, and a client that writes its
  // whole body before reading -- python urllib, which is what hub-agent.py posts
  // with -- loses the response and sees a socket error instead of its LIMIT.
  // That is the loop XERK-235 fixed: the agent re-sends the same oversized body
  // every beat forever, host offline, nothing logged. Proven end to end against
  // a real container with real urllib; held here as the cheap guard.
  //
  // What keeps this bounded is the BUDGET, not an early size check: those bytes
  // are charged like any other, so a flood is refused 503 before buffering and
  // only what the hub can afford ever buffers its way to a 413.
  const res = await request("POST", "/api/heartbeat", {
    body: { device: "declared-oversize", pad: "y".repeat(33 << 20) },
    headers: { ...agentHeaders, connection: "close" },
  });
  assert.equal(res.status, 413, "the caller must get a status, not a reset");
  assert.equal(res.body.limit, hub.BODY_INFLIGHT_MAX,
    "and the limit it needs to resize against");
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("drain: only so many refused bodies may drain at once", async () => {
  // Draining lets a refused request still read its 413 (XERK-235), but it is not
  // free: Node allocates for every read, and 256 sockets streaming past an
  // oversize refusal out-allocated the collector and OOM-killed the hub --
  // unauthenticated, through /api/login's 1 MiB cap.
  assert.ok(hub.DRAIN_CONCURRENCY_MAX >= 1);
  // The one oversize body a healthy fleet produces still drains and still gets
  // its status back, which is the whole reason the cap is a count and not zero.
  const res = await request("POST", "/api/heartbeat", {
    body: { device: "oversize-host", pad: "y".repeat((33 << 20)) },
    headers: { ...agentHeaders, connection: "close" },
  });
  assert.equal(res.status, 413);
  assert.ok(res.body.limit > 0, "the agent needs the limit to resize against");
});

// Reclaim only fires under CONTENTION, so these hold the big lane to create it.
// The suite does not run in a container, where the ceilings are container-sized;
// here they are host-RAM-sized, so pressure has to be staged rather than assumed.
function withBudgetPressure(fn) {
  return async () => {
    // Contend the SHARED budget, since the lanes are accounted separately now:
    // occupying the big lane no longer pressures shared-lane reads (that
    // separation is what stopped one big body from refusing every tiny one).
    // Just over half, so the body under test is still admitted.
    const stage = Math.floor(hub.BODY_INFLIGHT_TOTAL_MAX / 2) + 1;
    hub.chargeBody(stage, "shared");
    try { await fn(); } finally { hub.releaseBody(stage, "shared"); }
  };
}

test("budget: under pressure, a body that goes SILENT is taken back", withBudgetPressure(async () => {
  // The budget bounds how MUCH may be held; this bounds how LONG. One socket
  // that streamed 22 MiB and then stopped took the big lane and refused every
  // other body on the hub -- tiny heartbeats and the operator's own login --
  // until the 300s request timeout, renewably, for ~0.6 kbit/s.
  const held0 = hub.bodyInflightHeld();
  const sock = net.connect(server.address().port, "127.0.0.1");
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    const pad = "z".repeat(256 * 1024);
    sock.write(
      "POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer agenttok\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${33 << 20}\r\n\r\n` +
        `{"device":"staller","pad":"${pad}`
    );
    // ...and then nothing. Wait for the charge to land, then for it to be taken.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(hub.bodyInflightHeld() > held0, "the bytes it DID send are charged");

    const deadline = Date.now() + hub.BODY_IDLE_TIMEOUT_MS + 5000;
    while (hub.bodyInflightHeld() > held0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(hub.bodyInflightHeld(), held0,
      "a hold with no progress must not be permanent");
  } finally {
    sock.destroy();
  }
}));

test("budget: under pressure, a DRIBBLE cannot hold its charge open", withBudgetPressure(async () => {
  // The idle window alone was not enough. Reset by any byte, it is a liveness
  // check an attacker can forge: one byte per window is neither silence nor
  // slowness, and it held the big lane -- refusing every POST on the hub,
  // operator login included -- indefinitely, for ~0.5 bit/s after a one-time
  // warmup, without ever having to re-stream. The window must therefore reopen
  // on real PROGRESS, not on a sign of life.
  const held0 = hub.bodyInflightHeld();
  const sock = net.connect(server.address().port, "127.0.0.1");
  let dribbler = null;
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.write(
      "POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer agenttok\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${33 << 20}\r\n\r\n` +
        `{"device":"dribbler","pad":"${"d".repeat(256 * 1024)}`
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(hub.bodyInflightHeld() > held0, "the warmup is charged");

    // One byte per window -- under BODY_MIN_PROGRESS_BYTES, and often enough
    // that a reset-on-any-byte rule would never expire.
    dribbler = setInterval(() => { try { sock.write("d"); } catch {} },
      Math.max(20, Math.floor(hub.BODY_IDLE_TIMEOUT_MS / 3)));

    const deadline = Date.now() + hub.BODY_IDLE_TIMEOUT_MS * 4 + 2000;
    while (hub.bodyInflightHeld() > held0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(hub.bodyInflightHeld(), held0, "dribbling must not renew the hold");
  } finally {
    if (dribbler) clearInterval(dribbler);
    sock.destroy();
  }
}));

test("budget: under pressure, a body making REAL progress is never reclaimed",
  withBudgetPressure(async () => {
  // The other half: the rule is a minimum RATE, and anything clearing it must be
  // left alone however long it takes. A real slow migration lives here.
  const held0 = hub.bodyInflightHeld();
  const chunk = Math.max(hub.BODY_MIN_PROGRESS_BYTES * 2, 128 * 1024);
  const sock = net.connect(server.address().port, "127.0.0.1");
  let pump = null;
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.write(
      "POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer agenttok\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${33 << 20}\r\n\r\n` +
        '{"device":"steady","pad":"'
    );
    pump = setInterval(() => { try { sock.write("s".repeat(chunk)); } catch {} },
      Math.max(20, Math.floor(hub.BODY_IDLE_TIMEOUT_MS / 2)));
    await new Promise((r) => setTimeout(r, hub.BODY_IDLE_TIMEOUT_MS * 3));
    assert.ok(hub.bodyInflightHeld() > held0,
      "a body meeting the progress floor must not be reclaimed");
  } finally {
    if (pump) clearInterval(pump);
    sock.destroy();
  }
}));

test("budget: with room to spare, a slow body is NOT reclaimed", async () => {
  // The false positive the pressure gate exists to prevent. A small request over
  // a bad link holds a few hundred KB of a 64 MiB budget -- it monopolizes
  // nothing, and dropping it would break a legitimate call to protect capacity
  // that was never scarce. Reclaiming is for contention, not for slowness.
  // The previous test's socket teardown is asynchronous, so settle first —
  // this case is specifically about an idle hub and must actually start on one.
  for (let i = 0; i < 50 && hub.bodyInflightHeld() > 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(hub.bodyInflightHeld(), 0, "this one runs on an UNcontended hub");
  const sock = net.connect(server.address().port, "127.0.0.1");
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.write(
      "POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer agenttok\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${8 << 20}\r\n\r\n` +
        `{"device":"slowpoke","pad":"${"p".repeat(32 * 1024)}`
    );
    await new Promise((r) => setTimeout(r, 150));
    const held = hub.bodyInflightHeld();
    assert.ok(held > 0, "it is holding a charge");
    // Silent for several windows -- and still alive, because nobody is waiting.
    await new Promise((r) => setTimeout(r, hub.BODY_IDLE_TIMEOUT_MS * 3));
    assert.equal(hub.bodyInflightHeld(), held,
      "an uncontended hub must not drop a slow caller");
  } finally {
    sock.destroy();
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("budget: holding the big lane does not starve ordinary traffic", async () => {
  // Billed to the shared budget, merely OCCUPYING the exclusive lane was a total
  // outage: the big body's own charge exceeds the budget, so a 200-byte
  // heartbeat and the operator's own login were refused 503 behind it -- one
  // authenticated socket holding the fleet's control plane down for ~29 kbit/s.
  // Accounted separately, it delays only other LARGE bodies.
  assert.equal(hub.bodyInflightHeld(), 0);
  try {
    // The largest body that can exist, holding the exclusive lane. The ceiling
    // is set above it on purpose, so what it leaves behind is real room.
    hub.chargeBody(bigMax(), "big");
    assert.equal(hub.bodyLaneFor(1), "shared", "a tiny body still has its lane");
    const res = await request("POST", "/api/heartbeat", {
      body: { device: "unstarved" }, headers: agentHeaders,
    });
    assert.equal(res.status, 200, "ordinary traffic must flow past a held big lane");
    // Another body needing the LANE is what legitimately waits.
    assert.equal(hub.bodyLaneFor(hub.BODY_INFLIGHT_TOTAL_MAX), null);
  } finally {
    hub.releaseBody(bigMax(), "big");
  }
  assert.equal(hub.bodyInflightHeld(), 0);
});

test("budget: the big lane cannot be held past its occupancy ceiling", async () => {
  // The progress floor cannot close this on its own: a body dribbling AT the
  // floor is byte-for-byte indistinguishable from a legitimate slow migration at
  // the same rate, so no rate threshold separates them. This is the orthogonal
  // bound -- not "are you making progress" but "you have had the lane long
  // enough" -- and it is what stops an indefinite hold.
  assert.equal(hub.bodyInflightHeld(), 0);
  const sock = net.connect(server.address().port, "127.0.0.1");
  let pump = null;
  // Fill the shared lane so a modest body is pushed into the big one. The suite
  // does not run in a container, where the budget is container-sized; here it is
  // host-RAM-sized and nothing reasonable would reach the lane on its own.
  const stage = hub.BODY_INFLIGHT_TOTAL_MAX - (1 << 20);
  hub.chargeBody(stage, "shared");
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    const warm = 512 * 1024; // costs 1.5 MiB — past the 1 MiB left in shared
    sock.write(
      "POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer agenttok\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${33 << 20}\r\n\r\n` +
        `{"device":"lanehog","pad":"${"h".repeat(warm)}`
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hub.bodyLaneFor(bigMax()), null,
      "it is holding the lane");
    pump = setInterval(() => {
      try { sock.write("h".repeat(hub.BODY_MIN_PROGRESS_BYTES * 2)); } catch {}
    }, Math.max(20, Math.floor(hub.BODY_IDLE_TIMEOUT_MS / 2)));

    const deadline = Date.now() + hub.BIG_LANE_MAX_HOLD_MS + 4000;
    while (hub.bodyLaneFor(bigMax()) === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(hub.bodyLaneFor(bigMax()), "big",
      "paying the floor rate must not buy the lane forever");
  } finally {
    if (pump) clearInterval(pump);
    sock.destroy();
    hub.releaseBody(stage, "shared");
  }
});

test("budget: a body PROMOTED to the big lane leaks nothing", async () => {
  // The leak this pins was not an attack: one legitimate 22 MiB heartbeat --
  // inside HEARTBEAT_MAX, and the size XERK-235 exists because staged history
  // reaches -- permanently consumed the whole shared budget, after which every
  // non-trivial body was refused for the life of the process.
  //
  // Cause: a large body starts in the shared lane (its first chunks are small),
  // is promoted when it outgrows the budget, and then release() can only name
  // the lane it ENDED in -- so the pre-promotion charge was never given back.
  // A body's charge has to live entirely in the lane it currently occupies.
  assert.equal(hub.bodyInflightHeld(), 0);
  // Force promotion by leaving almost no shared room, then sending a body that
  // starts small enough to be admitted there and grows past what is left.
  const stage = hub.BODY_INFLIGHT_TOTAL_MAX - (2 << 20);
  hub.chargeBody(stage, "shared");
  try {
    const res = await request("POST", "/api/heartbeat", {
      body: { device: "promoted", pad: "m".repeat(4 << 20) }, headers: agentHeaders,
    });
    assert.equal(res.status, 200, "a legal body must still be served");
  } finally {
    hub.releaseBody(stage, "shared");
  }
  assert.equal(hub.bodyInflightHeld(), 0, "the promoted body's whole charge came back");
  // And the shared lane is genuinely usable again, not merely reading as zero.
  assert.equal(hub.bodyLaneFor(hub.BODY_INFLIGHT_TOTAL_MAX), "shared");
  assert.equal(hub.budgetUnderPressure("shared"), false);
});

test("budget: a big-lane holder leaves the shared budget to everyone else", async () => {
  // The other half of the same bug. While a promoted body held the lane, its
  // pre-promotion charge stayed billed to shared, so a holder occupied ~the
  // entire shared budget: a 0.5 MiB beat, a 4 MiB attachment upload and a
  // 65 MiB migration bundle were all refused behind it. "Ordinary traffic is
  // unaffected" has to mean more than the few hundred KB that fit in the sliver.
  assert.equal(hub.bodyInflightHeld(), 0);
  const stage = hub.BODY_INFLIGHT_TOTAL_MAX - (2 << 20);
  hub.chargeBody(stage, "shared");
  let promoted = 0;
  try {
    // Drive a body through promotion and measure what it leaves behind.
    await request("POST", "/api/heartbeat", {
      body: { device: "holder", pad: "h".repeat(4 << 20) }, headers: agentHeaders,
    });
    promoted = hub.bodyInflightHeld();
  } finally {
    hub.releaseBody(stage, "shared");
  }
  assert.equal(promoted - stage, 0,
    "a promoted body must not go on holding shared budget after it completes");
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

  // A good block passes through unchanged. With no discovered list the models[]
  // is [] and defaultModel falls back to the single `model` (XERK-489).
  assert.deepEqual(
    norm({ available: true, model: "gpt-oss:120b", contextTokens: 81920 }),
    { available: true, model: "gpt-oss:120b", contextTokens: 81920,
      models: [], defaultModel: "gpt-oss:120b" },
  );

  // `available` is STRICTLY boolean: a truthy string would offer the switch on
  // a host that cannot do it, and the command would be acked and dropped.
  assert.deepEqual(norm({ available: "yes", model: "x" }),
    { available: false, model: null, contextTokens: null, models: [], defaultModel: null });
  assert.deepEqual(norm({ available: 1 }),
    { available: false, model: null, contextTokens: null, models: [], defaultModel: null });

  // A non-string model and an out-of-Int contextTokens degrade to null rather
  // than failing the decode. contextTokens is unused by the UI, so this is free.
  assert.deepEqual(norm({ available: true, model: 12345, contextTokens: 9999999999 }),
    { available: true, model: null, contextTokens: null, models: [], defaultModel: null });
  assert.deepEqual(norm({ available: true, model: "m", contextTokens: 1.5 }),
    { available: true, model: "m", contextTokens: null, models: [], defaultModel: "m" });

  // The name is BOUNDED, and cut on code points. A UTF-16 `slice` through an
  // astral pair emits a lone surrogate — unencodable, and it kills Android's
  // uiautomator outright. Nothing else pins this length.
  const long = norm({ available: true, model: "x".repeat(500) });
  assert.equal(long.model.length, 60);
  const astral = norm({ available: true, model: "x".repeat(59) + "😀" + "tail" });
  assert.equal([...astral.model].length, 60);
  assert.ok(astral.model.isWellFormed(), "the cut manufactured a lone surrogate");
  // ...and one that ARRIVES that way is replaced, not passed through. Either
  // direction kills uiautomator, so the guarantee has to cover both.
  for (const evil of ["qwen\uD83Dcoder", "abc\uDE00def", "x".repeat(59) + "\uD83Dtail"]) {
    assert.ok(norm({ available: true, model: evil }).model.isWellFormed(),
      `a lone surrogate survived: ${JSON.stringify(evil)}`);
  }
  // The guarantee is the whole XML-ILLEGAL class, not just surrogates: a C0
  // control and the noncharacters U+FFFE/U+FFFF each kill `uiautomator dump`
  // the same way (a 0-byte file), and closing only the case that bit us leaves
  // the next one to be rediscovered — which is how the second and third of
  // these were found, one pass apart.
  const ctl = norm({ available: true, model: "qwen\x01ctl\x00nul\x0bvt\x7fdel" });
  assert.equal(ctl.model, "qwenctlnulvtdel");
  assert.equal(norm({ available: true, model: "qwen\uffffbad\ufffemore" }).model, "qwenbadmore");
  // ...but U+FDD0 and U+1FFFE are LEGAL XML and must survive: over-stripping
  // would mangle a name for no reason.
  assert.equal(norm({ available: true, model: "a\ufdd0b\u{1FFFE}c" }).model, "a\ufdd0b\u{1FFFE}c");
  // Tab/newline/CR are legal XML and are only trimmed at the edges.
  assert.equal(norm({ available: true, model: "  a\tb  " }).model, "a\tb");

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

test("normalizeDsh coerces the capability flag strictly boolean (XERK-465)", () => {
  hub.__setDshEnabled(true);
  // Same atomic-decode hazard as normalizeLocalModel: one host's bad `dsh`
  // block would fail Android's whole /api/agents decode and empty the fleet.
  const norm = (dsh) => {
    const p = { device: "h", dsh };
    hub.normalizeDsh(p);
    return p.dsh;
  };
  // The discovered-model fields (XERK-503) ride every block; empty until
  // discovery lands. A helper keeps these tests focused on the flag.
  const M = { models: [], defaultModel: null, contextTokens: null };
  // A good block passes through.
  assert.deepEqual(norm({ available: true }), { available: true, ...M });
  // Strictly boolean: a truthy non-true value reads as "cannot do dsh", so the
  // composer hides the selector rather than queue a spawn the host refuses.
  assert.deepEqual(norm({ available: "yes" }), { available: false, ...M });
  assert.deepEqual(norm({ available: 1 }), { available: false, ...M });
  assert.deepEqual(norm({ available: false }), { available: false, ...M });
  // Any UNKNOWN extra key a newer agent adds is dropped — the block is rebuilt,
  // not spread (a bogus `model` field is not the typed `defaultModel`).
  assert.deepEqual(norm({ available: true, model: "deepseek" }), { available: true, ...M });
  // Not an object at all -> null, which every client reads as "cannot do dsh".
  assert.equal(norm("yes"), null);
  assert.equal(norm([1]), null);
  assert.equal(norm(null), null);
  // A pre-dsh agent sends nothing; the key stays absent, not an explicit null.
  const old = { device: "h" };
  hub.normalizeDsh(old);
  assert.ok(!("dsh" in old));
});

test("normalizeDsh whitelists the host-wide web viewer sub-block (XERK-501)", () => {
  hub.__setDshEnabled(true);
  const norm = (dsh) => {
    const p = { device: "h", dsh };
    hub.normalizeDsh(p);
    return p.dsh;
  };
  const M = { models: [], defaultModel: null, contextTokens: null };
  // A viewer that is UP passes through as {running, port, url}.
  assert.deepEqual(
    norm({ available: true, web: { running: true, port: 7788, url: "http://box:7788" } }),
    { available: true, ...M, web: { running: true, port: 7788, url: "http://box:7788" } });
  // Kept only when running:true — a launch-failed / absent viewer carries no
  // web block (the capability-absence the client reads as "no dsh web here").
  assert.deepEqual(norm({ available: true, web: { running: false } }),
                   { available: true, ...M });
  assert.deepEqual(norm({ available: true }), { available: true, ...M });
  // A non-string / absent url -> null (host-only reachable), never a dead link.
  assert.deepEqual(
    norm({ available: true, web: { running: true, port: 7788 } }),
    { available: true, ...M, web: { running: true, port: 7788, url: null } });
  assert.deepEqual(
    norm({ available: true, web: { running: true, port: 7788, url: 42 } }),
    { available: true, ...M, web: { running: true, port: 7788, url: null } });
  // A non-finite port -> null.
  assert.equal(
    norm({ available: true, web: { running: true, port: "80" } }).web.port, null);
  // The url is length-capped on the wire (the PEER_CELL_MAX / retiredUsage
  // memory-hazard class): an uncapped agent-set string must not ride /api/agents.
  const long = "http://box/" + "a".repeat(5000);
  assert.ok(norm({ available: true, web: { running: true, port: 1, url: long } })
              .web.url.length <= 512);
  // The url must be http(s): — it flows to an anchor href on the client, so an
  // agent-set javascript:/data: is dropped to null (defence in depth).
  const u = (url) => norm({ available: true, web: { running: true, port: 1, url } }).web.url;
  assert.equal(u("javascript:alert(1)"), null);
  assert.equal(u("data:text/html,<script>x</script>"), null);
  assert.equal(u("HTTP://box:7788/"), "HTTP://box:7788/");   // scheme case-insensitive
  assert.equal(u("https://box:7788/"), "https://box:7788/");
  // A junk web block on an otherwise-good dsh block drops the web, keeps the flag.
  assert.deepEqual(norm({ available: true, web: "yes" }), { available: true, ...M });
  assert.deepEqual(norm({ available: true, web: [1] }), { available: true, ...M });
});

test("DSH_ENABLED off (the shipped default) makes the hub serve an inert dsh block and no dsh runtime", () => {
  // This test deliberately does NOT flip the flag — it pins the SHIPPED default.
  // The dsh tests around it enable the flag and the top-level afterEach resets it,
  // so the flag is false here. Without this, all the flag-on dsh tests stay green
  // even if every hub kill-switch gate is removed (the coverage gap QA flagged).
  assert.equal(hub.__getDshEnabled(), false);
  // dshAvailable refuses whatever an agent claims.
  assert.equal(hub.dshAvailable({ dsh: { available: true } }), false);
  // normalizeDsh forces the block fully inert: no capability, no models, no
  // default, no web viewer — even from a fully-populated agent report.
  const p = { dsh: { available: true, web: { running: true, port: 7788, url: "http://x:7788/" },
    models: [{ id: "deepseek-chat", contextTokens: 64000 }], defaultModel: "deepseek-chat", contextTokens: 64000 } };
  hub.normalizeDsh(p);
  assert.deepEqual(p.dsh, { available: false, models: [], defaultModel: null, contextTokens: null });
  assert.equal("web" in p.dsh, false);
  // normalizeRecord (the real ingest/restore path) coerces a dsh session runtime
  // to claude on the wire, so no client renders a session as dsh.
  const rec = { device: "h", dsh: { available: true }, sessions: [{ id: "s1", agentType: "dsh" }] };
  hub.normalizeRecord(rec);
  assert.equal(rec.dsh.available, false);
  assert.equal(rec.sessions[0].agentType, "");
});

test("normalizeDsh coerces the discovered model list (XERK-503)", () => {
  hub.__setDshEnabled(true);
  const norm = (dsh) => {
    const p = { device: "h", dsh };
    hub.normalizeDsh(p);
    return p.dsh;
  };
  // A good list passes through with defaultModel + contextTokens.
  assert.deepEqual(
    norm({ available: true, defaultModel: "deepseek-chat", contextTokens: 128000,
           models: [{ id: "deepseek-chat", contextTokens: 128000 },
                    { id: "qwen3", contextTokens: null }] }),
    { available: true, defaultModel: "deepseek-chat", contextTokens: 128000,
      models: [{ id: "deepseek-chat", contextTokens: 128000 },
               { id: "qwen3", contextTokens: null }] });
  // A nameless / off-charset id is DROPPED; a doubled id is deduped.
  const d = norm({ available: true,
                   models: [{ id: "a", contextTokens: 1 }, { id: "a", contextTokens: 1 },
                            { id: "" }, { id: 42 }, "junk", null] });
  assert.deepEqual(d.models, [{ id: "a", contextTokens: 1 }]);
  // A non-array models -> [] (Android types it; a bad shape must not decode-fail
  // the whole fleet array).
  assert.deepEqual(norm({ available: true, models: "lots" }).models, []);
  // defaultModel outside the list is kept (the zero-config single-DSH_MODEL case).
  assert.equal(norm({ available: true, defaultModel: "solo", models: [] }).defaultModel,
               "solo");
  // A bad contextTokens is dropped to null, never a plausible default.
  assert.equal(norm({ available: true, contextTokens: "big" }).contextTokens, null);
});

test("normalizeLocalModel bounds and sanitizes the discovered models[] (XERK-489)", () => {
  // The discovered set rides the heartbeat and Android decodes /api/agents
  // ATOMICALLY into `List<LocalModelInfo>` — so an endpoint answering thousands
  // of ids, or one malformed entry, from ONE host must not drop the whole fleet.
  // This is the PEER_CELL_MAX / retiredUsage failure class the ticket names, and
  // the length bound is the load-bearing part: without a test, removing the cap
  // leaves every other assertion green (mutation-proven).
  const norm = (localModel) => {
    const p = { device: "h", localModel };
    hub.normalizeLocalModel(p);
    return p.localModel;
  };

  // LENGTH BOUND: an endpoint answering thousands of ids is capped at 200.
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, contextTokens: 1000 }));
  const capped = norm({ available: true, model: "m0", models: many });
  assert.equal(capped.models.length, 200, "models[] must be length-bounded");
  assert.equal(capped.models[0].id, "m0");   // taken in order, not sampled

  // PER-ELEMENT: a nameless id is DROPPED (a row the dropdown can't label); a
  // non-object element is skipped; contextTokens is int-safe or null.
  const mixed = norm({
    available: true, model: "a",
    models: [
      { id: "keep", contextTokens: 128000 },
      { id: "", contextTokens: 1 },          // sanitizes to "" -> dropped
      { id: 12345, contextTokens: 1 },       // non-string id -> dropped
      "not-an-object",                       // -> skipped
      { id: "flt", contextTokens: 1.5 },     // float -> null
      { id: "neg", contextTokens: -5 },      // negative -> null
      { id: "huge", contextTokens: 9999999999 }, // out of Int -> null
      { id: "nowin" },                       // absent -> null
    ],
  });
  assert.deepEqual(mixed.models, [
    { id: "keep", contextTokens: 128000 },
    { id: "flt", contextTokens: null },
    { id: "neg", contextTokens: null },
    { id: "huge", contextTokens: null },
    { id: "nowin", contextTokens: null },
  ]);

  // DEDUP: a doubled id can't pad the list past its real size.
  const deduped = norm({
    available: true, model: "a",
    models: [{ id: "x", contextTokens: 1 }, { id: "x", contextTokens: 2 }, { id: "y" }],
  });
  assert.deepEqual(deduped.models.map((m) => m.id), ["x", "y"]);

  // Each id runs through the SAME XML-illegal / astral sanitize as `model` — an
  // id that would kill Android's uiautomator must not survive in the list.
  const evil = norm({ available: true, model: "a",
    models: [{ id: "qwen￿bad" }, { id: "x".repeat(59) + "😀" + "tail" }] });
  assert.equal(evil.models[0].id, "qwenbad");
  assert.equal([...evil.models[1].id].length, 60);
  assert.ok(evil.models[1].id.isWellFormed());

  // defaultModel must be one the SANITIZED list carries, else fall back to the
  // single `model` — the dropdown must never preselect a value it can't show.
  assert.equal(norm({ available: true, model: "a",
    models: [{ id: "b" }, { id: "c" }], defaultModel: "c" }).defaultModel, "c");
  assert.equal(norm({ available: true, model: "a",
    models: [{ id: "b" }], defaultModel: "gone" }).defaultModel, "a");  // fallback
  assert.equal(norm({ available: true, model: "a",
    models: [{ id: "b" }], defaultModel: 999 }).defaultModel, "a");     // non-string

  // A non-array models[] is simply []; the block stays decodable.
  assert.deepEqual(norm({ available: true, model: "a", models: "lots" }).models, []);
  assert.deepEqual(norm({ available: true, model: "a", models: { id: "x" } }).models, []);
});

test("isPlainHostKey refuses exactly the names the hub cannot address", () => {
  // Prototype keys (XERK-235) and URL dot segments (XERK-269): the first is not
  // a host at all, the second is a host no /api/agents/<host>/... route can
  // reach, because the URL parser collapses the segment before it ever matches.
  for (const bad of ["__proto__", "constructor", "prototype", ".", "..",
    "", "x".repeat(201), null, undefined, 12, {}, ["x"]]) {
    assert.equal(hub.isPlainHostKey(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  // Padded dots ARE addressable — the padding percent-encodes to %20/%0A, which
  // no parser collapses — so refusing them would be over-scoping the guard.
  // Names that merely contain dots are ordinary host names.
  for (const good of ["truenas", "WIN-DESK01", "HOST.local.", "...", ".hidden",
    "a.b", "..host", " . ", ".\n", "\t..\n", "x".repeat(200),
    "日本語ホスト", "host%name", "a/b"]) {
    assert.equal(hub.isPlainHostKey(good), true, `${JSON.stringify(good)} must be accepted`);
  }
});

test("dropUnusableHostKeys actually REMOVES the keys, in every position", () => {
  // A source regex over the restore loop proves the call is there, not that it
  // drops anything: removing the `delete` still printed "dropping …" while
  // dropping nothing, and `continue`→`break` made survival depend on JSON key
  // order. Both kept the suite green, so this asserts the mutation instead.
  const store = {
    ".": { device: "." }, "truenas": { device: "truenas" },
    "..": { device: ".." }, "HOST.local.": { device: "HOST.local." },
    "__proto__x": { device: "__proto__x" }, "...": { device: "..." },
  };
  // A bad key FIRST, LAST and in the MIDDLE — an early `break` survives only a
  // fixture whose refused keys happen to lead.
  const dropped = hub.dropUnusableHostKeys(store);
  assert.deepEqual(dropped.sort(), [".", ".."], "both dot keys reported");
  assert.deepEqual(Object.keys(store).sort(),
    ["...", "HOST.local.", "__proto__x", "truenas"],
    "the dot keys are GONE and every ordinary name survived");
  assert.equal(Object.hasOwn(store, "."), false);

  // Nothing to do is not an error, and reports nothing.
  const clean = { truenas: {} };
  assert.deepEqual(hub.dropUnusableHostKeys(clean), []);
  assert.deepEqual(Object.keys(clean), ["truenas"]);

  // A corrupt state file is not a registry: Object.keys("hello") is ["0".."4"],
  // which restored a five-"agent" fleet out of a bare JSON string.
  for (const junk of ["hello", [], null, undefined, 12, true]) {
    assert.deepEqual(hub.dropUnusableHostKeys(junk), [],
      `${JSON.stringify(junk)} must be left alone, not iterated`);
  }
});

test("a refused device name is truncated before it reaches the log", () => {
  // `sanitizeHeartbeat` does not cap `device` — only HEARTBEAT_MAX (32 MiB)
  // does — so logging a refused key raw let two beats write 9 MiB into the hub
  // log, synchronously, on the request path.
  const huge = "z".repeat(5 * 1024 * 1024);
  const line = hub.hostKeyLabel(huge);
  assert.ok(line.length < 200, `logged ${line.length} chars for a 5 MiB key`);
  assert.match(line, /\(5242880 chars\)/, "the real length is still reported");
  // Short keys are logged whole, quoted, so the common case stays readable.
  assert.equal(hub.hostKeyLabel("."), '"."');
  assert.equal(hub.hostKeyLabel("__proto__"), '"__proto__"');
  assert.equal(hub.hostKeyLabel(12), '"12"', "a non-string key still logs safely");
});

test("the state.json restore coerces too, not just the ingest path", () => {
  // A hub restart is exactly when a new coercion ships, and the restore is the
  // FIRST thing it serves. A record written before it — or belonging to an
  // OFFLINE host, where no beat will ever rewrite it — would otherwise reach
  // the phone raw and throw for the whole fleet. Held here rather than by
  // booting a second hub: the loader is a bare `for` over the parsed blob, so
  // what matters is that all three coercions are applied to a loaded record.
  const restored = {
    device: "old",
    localModel: { available: "yes", model: 12345, contextTokens: 9999999999 },
    limits: { fiveHour: { usedPct: "lots" } },
  };
  hub.normalizeLocalModel(restored);
  assert.deepEqual(restored.localModel,
    { available: false, model: null, contextTokens: null, models: [], defaultModel: null });

  // The durable form of "the restore can't fall behind the ingest": both go
  // through ONE function, so there is no list here to keep in step. A previous
  // version of this test named three coercions and therefore could not notice
  // the fourth (`sanitizeLiveAgents`) missing from the restore — enumerating is
  // exactly the shape that let the hole exist.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Anchored on the section header rather than a statement, so rewording the
  // parse doesn't silently slice nothing and pass this whole block vacuously.
  const loStart = src.indexOf("---- persistence");
  const loEnd = src.indexOf("first boot or no volume");
  assert.ok(loStart > -1 && loEnd > loStart, "the loader block must be locatable");
  const loader = src.slice(loStart, loEnd);
  assert.ok(/normalizeRecord\(a\)/.test(loader),
    "the state.json restore must go through normalizeRecord, like the ingest path");
  const ingest = src.slice(src.indexOf('url.pathname === "/api/heartbeat"'),
    src.indexOf("ingestHistory(next, historyResults)"));
  // The ingest reaches it through `recordCoercion` (XERK-262) so a test can
  // force the backstop around it to run; that holder carries `normalizeRecord`
  // itself, which is asserted directly by "the coercion holder runs the real
  // normalizeRecord in production". So this stays a check that the ingest and
  // the restore share ONE function, not a list of coercions to keep in step.
  assert.ok(/recordCoercion\.normalize\(next\)/.test(ingest),
    "the heartbeat ingest must go through the same normalizeRecord");
  // The KEY needs the same treatment as the record, and for the same reason: a
  // guard shipped only at ingest leaves an already-persisted bad key restored
  // verbatim at boot. A dot-segment key is uncommandable AND undeletable, so it
  // would sit there until prune() ages it out days later (XERK-269).
  assert.ok(/dropUnusableHostKeys\(agents\)/.test(loader),
    "the state.json restore must drop keys the ingest path would refuse");
  assert.ok(/isPlainHostKey\(key\)/.test(ingest),
    "the heartbeat ingest must go through the same key guard");
  // ...and BETWEEN the two size measurements. Before the raw check it could
  // shrink away the amplifier the ceiling exists to refuse (an 8 MiB string
  // `sessions` became `[]` and the beat 200'd); after the coerced check, an
  // EXPANDING coercion escapes the ceiling entirely (normalizeModelUsage is
  // ~3.5x, and an 8 MiB beat parked 28 MiB per host for a week).
  const iRaw = ingest.indexOf("rawSize > AGENT_RECORD_MAX");
  const iCoerce = ingest.indexOf("recordCoercion.normalize(next)");
  const iStored = ingest.indexOf("recordSize > AGENT_RECORD_MAX");
  assert.ok(iRaw > -1 && iCoerce > iRaw && iStored > iCoerce,
    "the ingest must measure raw size, THEN coerce, THEN measure the stored size");
});

test("the restore actually RUNS — it must not throw into its own catch", () => {
  // The restore sits at module init inside `try { … } catch {}`, so anything it
  // throws is swallowed: the record loads HALF-coerced, with no log line and no
  // error anywhere. That is not hypothetical — `sanitizeLiveAgents` read two
  // module `const`s declared 1700 lines BELOW the restore, i.e. in their
  // temporal dead zone at that moment, so the localModel half was applied and
  // the session half silently was not, with every suite green.
  //
  // Held BEHAVIOURALLY, by loading the real module against a fixture in a child
  // process. An earlier version asserted the line order of two constants BY
  // NAME, which a third constant walks straight past — the same enumerate-the-
  // instances mistake that let the original hole exist.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
  const state = {
    h1: {
      device: "h1", online: true,
      localModel: { available: "yes", model: 12345, contextTokens: 9999999999 },
      dsh: { available: "yes" },                     // XERK-465 capability flag
      limits: { fiveHour: { usedPct: "lots" } },
      sessions: [
        null,                                        // decode-fatal element
        { id: "s1", modelSource: { a: 1 }, modelSourceAt: ["x"], agentType: { a: 1 },
          session: { agents: [{ sel: "yes", type: { a: 1 }, label: ["x"] }] } },
        "not-a-session",
      ],
    },
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const out = require("child_process").execFileSync(process.execPath, ["-e", `
    process.env.TURMA_TEST = "1";
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    // Marker-delimited: the loader logs "loaded N agents …" to stdout on the
    // way past, and that line landing here is itself the proof it ran.
    process.stdout.write("<<<" + JSON.stringify(hub.agents) + ">>>");
    process.exit(0);
  `], {
    env: { ...process.env, TURMA_TEST: "1", STATE_FILE: path.join(dir, "state.json"),
           ARCHIVE_DIR: path.join(dir, "a"), ARCHIVE_DB: path.join(dir, "a.db"),
           NODE_NO_WARNINGS: "1" },
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  assert.match(out, /loaded 1 agents from/,
    "the restore did not run — it threw into its own catch");
  const rec = JSON.parse(out.slice(out.indexOf("<<<") + 3, out.lastIndexOf(">>>"))).h1;
  assert.deepEqual(rec.localModel, { available: false, model: null, contextTokens: null, models: [], defaultModel: null });
  assert.deepEqual(rec.dsh, { available: false, models: [], defaultModel: null,
                              contextTokens: null });
  assert.equal(rec.limits, null);
  assert.equal(rec.sessions.length, 1, "non-object session elements must be dropped");
  assert.equal(rec.sessions[0].modelSource, "");
  assert.equal(rec.sessions[0].modelSourceAt, "");
  assert.equal(rec.sessions[0].agentType, "");
  assert.deepEqual(rec.sessions[0].session.agents,
    [{ sel: true, type: "[object Object]", label: "x" }]);
});

// Boot the real module against a fixture state file and hand back its `agents`.
// Shares the child-process approach of "the restore actually RUNS" above: the
// restore happens at module init, so nothing short of a real load exercises it.
function bootWithState(t, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-key-"));
  fs.writeFileSync(path.join(dir, "state.json"), raw);
  // console.warn goes to stderr, which this harness discards, so it is captured
  // BEFORE the require — the restore runs during module init — and handed back
  // on stdout with the agents.
  return require("child_process").execFileSync(process.execPath, ["-e", `
    process.env.TURMA_TEST = "1";
    const warns = [];
    console.warn = (...a) => warns.push(a.join(" "));
    // The restore reports a refused file through console.error (XERK-272) and
    // its dropped KEYS through console.warn, so both are captured here.
    console.error = (...a) => warns.push(a.join(" "));
    const hub = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    process.stdout.write("<<<" + JSON.stringify({ agents: hub.agents, warns }) + ">>>");
    process.exit(0);
  `], {
    env: { ...process.env, TURMA_TEST: "1", STATE_FILE: path.join(dir, "state.json"),
           ARCHIVE_DIR: path.join(dir, "a"), ARCHIVE_DB: path.join(dir, "a.db"),
           NODE_NO_WARNINGS: "1" },
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
}

test("a restored state file cannot carry a host the hub could not address", () => {
  // The end-to-end form of the drop: not "the call is in the source" and not
  // "the helper works", but a real module init over a real file. The ghost this
  // prevents was uncommandable AND undeletable, so it outlived every route that
  // could have cleared it (XERK-269).
  // Written as raw JSON, not via JSON.stringify of a literal: `"__proto__":` in
  // an object literal sets the PROTOTYPE and creates no key, so a stringified
  // fixture silently omits the very case XERK-235 is about. JSON.parse does
  // make it an own property, which is the real hazard.
  const out = bootWithState(this, '{' +
    '"__proto__":{"device":"proto"},' +
    '".":{"device":"."},' +
    '"truenas":{"device":"truenas"},' +
    '"..":{"device":".."},' +
    '"HOST.local.":{"device":"HOST.local."},' +
    '"...":{"device":"..."}}');
  const { agents: restored, warns } = JSON.parse(
    out.slice(out.indexOf("<<<") + 3, out.lastIndexOf(">>>")));
  assert.deepEqual(Object.keys(restored).sort(), ["...", "HOST.local.", "truenas"],
    "dot segments and prototype keys must not survive a restore");
  // The log line alone is NOT evidence — a drop that reports but does not
  // delete still prints it, which is how the earlier version passed. The key
  // list above is the proof; this only checks the operator is told at all.
  assert.equal(warns.filter((w) => /dropping restored agent/.test(w)).length, 3);
});

test("a corrupt state file restores nothing, rather than a registry of characters", () => {
  // `Object.keys("hello")` is ["0".."4"], so a bare JSON string loaded as "5
  // agents". The array/number/boolean shapes are the ones that matter most:
  // they throw nowhere on their own, so the catch's `agents = {}` reset never
  // fires for them and only the shape check keeps them out of the registry.
  for (const junk of ['"hello"', "[]", "12", "null", "true"]) {
    const out = bootWithState(this, junk);
    const { agents: restored } = JSON.parse(
      out.slice(out.indexOf("<<<") + 3, out.lastIndexOf(">>>")));
    assert.deepEqual(restored, {}, `state.json of ${junk} must restore nothing`);
    assert.doesNotMatch(out, /loaded \d+ agents/,
      `${junk} must not report a successful load`);
    // ...and it SAYS so, rather than being indistinguishable from first boot.
    const { warns } = JSON.parse(out.slice(out.indexOf("<<<") + 3, out.lastIndexOf(">>>")));
    assert.ok(warns.some((w) => /state restore skipped/.test(w)),
      `${junk} must be reported, not silently treated as first boot`);
  }
  // A well-formed file still loads, so the guard isn't refusing everything.
  const ok = bootWithState(this, JSON.stringify({ truenas: { device: "truenas" } }));
  assert.match(ok, /loaded 1 agents from/);
});

test("XERK-297: one null record in state.json does not blank the whole fleet", () => {
  // The failure this fixes: a single non-object record (a torn write leaving
  // `"bad":null` as valid JSON) alongside healthy hosts passed every per-field
  // guard — they all early-return on a non-object — and reached serializeAgent,
  // where `a.lastSeen` threw a TypeError that emptied the ENTIRE payload. Every
  // host vanished, not just the bad one, and it persisted across restarts.
  //
  // Written as raw JSON, not a stringified literal: an object literal's `null`
  // value is fine, but the array/scalar shapes below are the ones a hand-edit or
  // torn write also produce, and all four must be dropped per-record, not fail
  // the whole restore. The healthy host beside them must survive.
  const out = bootWithState(this, '{' +
    '"bad":null,' +
    '"arr":[1,2],' +
    '"num":7,' +
    '"str":"x",' +
    '"truenas":{"device":"truenas"}}');
  const { agents: restored, warns } = JSON.parse(
    out.slice(out.indexOf("<<<") + 3, out.lastIndexOf(">>>")));
  assert.deepEqual(Object.keys(restored), ["truenas"],
    "the healthy host must survive; every non-object record is dropped");
  // The operator is told, once per dropped record — not left to infer it from a
  // fleet that silently emptied.
  assert.equal(
    warns.filter((w) => /dropping restored agent with a non-object record/.test(w)).length, 4);
  // ...and the restore reports a SUCCESSFUL load of the one real host, not a
  // wholesale skip.
  assert.match(out, /loaded 1 agents from/);
});

test("XERK-297: dropNonObjectRecords removes non-object records, in every position", () => {
  // The behavioural twin of the dropUnusableHostKeys test — a source regex over
  // the restore loop proves only that the CALL is there, not that it drops the
  // right things. A bad record FIRST, in the MIDDLE and LAST, so an early break
  // couldn't pass on a fixture whose junk merely leads.
  const store = {
    bad: null, truenas: { device: "truenas" }, arr: [1],
    ok2: { device: "ok2" }, num: 3, str: "x",
  };
  const dropped = hub.dropNonObjectRecords(store);
  assert.deepEqual(dropped.sort(), ["arr", "bad", "num", "str"]);
  assert.deepEqual(Object.keys(store).sort(), ["ok2", "truenas"],
    "the non-object records are GONE and every real record survived");

  // Nothing to do reports nothing; a non-object STORE is left alone, not iterated
  // (Object.entries("hi") would otherwise restore a two-record fleet).
  assert.deepEqual(hub.dropNonObjectRecords({ truenas: {} }), []);
  for (const junk of ["hello", [], null, undefined, 12, true]) {
    assert.deepEqual(hub.dropNonObjectRecords(junk), [],
      `${JSON.stringify(junk)} must be left alone, not iterated`);
  }

  // And the restore actually CALLS it, between the parsed blob and the record
  // walk that would crash on a non-object.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const loStart = src.indexOf("---- persistence");
  const loEnd = src.indexOf("first boot or no volume");
  const loader = src.slice(loStart, loEnd);
  assert.ok(/dropNonObjectRecords\(agents\)/.test(loader),
    "the restore must drop non-object records before serializing them");
});

test("XERK-297: the degraded fleet body names the failure class, not always 'payload too large'", () => {
  // Only V8's ~512 MiB string ceiling (a RangeError) is genuinely a size problem;
  // the null-record TypeError this ticket is about is NOT, and the blanket
  // "payload too large" sent whoever debugged it hunting AGENT_RECORD_MAX.
  assert.equal(hub.degradedAgentsError(new RangeError("Invalid string length")),
    "payload too large");
  assert.equal(
    hub.degradedAgentsError(new TypeError("Cannot read properties of null (reading 'lastSeen')")),
    "agents payload could not be serialized");
  // The default for any other throw is the honest one, not the size claim.
  assert.equal(hub.degradedAgentsError(new Error("nope")),
    "agents payload could not be serialized");
});

test("XERK-297: scheduleSave writes atomically — temp file then rename", () => {
  // A non-atomic fs.writeFile is how a torn state.json arises in the first place:
  // a reader (this hub's own next-boot restore) can catch a half-written blob
  // that is still valid-but-null-ish JSON. Held structurally — the write is a
  // 30-second debounced timer, so driving it end-to-end is not a unit test — but
  // the shape is unambiguous: write to a sibling temp path, then rename over it.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const fn = src.slice(src.indexOf("function scheduleSave"),
    src.indexOf("function prune"));
  assert.match(fn, /STATE_FILE\}\.tmp-/,
    "the save must write to a sibling temp file, not STATE_FILE directly");
  const iWrite = fn.indexOf("fs.writeFile(tmp");
  const iRename = fn.indexOf("fs.rename(tmp, STATE_FILE");
  assert.ok(iWrite > -1 && iRename > iWrite,
    "the save must writeFile the temp path THEN rename it over STATE_FILE");
});

test("normalizeLocalModel bounds the name BEFORE spreading it", () => {
  // `[...s]` allocates per code point over the WHOLE string, so an unbounded
  // spread let one agent-authed heartbeat with a 24 MiB name OOM-kill the hub
  // at its deployed `mem_limit: 256m`, on repeat.
  //
  // Two DETERMINISTIC assertions, because neither is sufficient alone: a
  // STRUCTURAL one that the slice precedes the spread, and a BEHAVIOURAL one on
  // the coerced OUTPUT. There used to be a third — a wall-clock RESOURCE BUDGET
  // (`coercing a 32 MiB name must take < 60ms`) — but it flaked in the full-tree
  // CI run (XERK-454): `node --test` runs every suite in parallel, and on a
  // loaded box a bounded coercion measured 90-170ms with no bug present. The
  // budget was nondeterministic at any margin (an earlier 8 MiB/50ms version
  // caught the reintroduced bug only 5 runs in 8, decided by whether a GC landed
  // between the samples) and added no signal the two assertions below lack, so
  // it was dropped rather than have an arbitrary threshold redden green PRs.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // The name coercion now lives in the shared sanitizeModelName helper (reused
  // for every discovered id too, XERK-489). It must slice(0, 512) BEFORE the
  // per-code-point spread that materialises the array.
  const fn = src.slice(src.indexOf("function sanitizeModelName"),
    src.indexOf("function sanitizeContextTokens"));
  assert.match(fn, /\[\.\.\.s\.slice\(0, 512\)/,
    "the model name must be bounded BEFORE the per-code-point spread");

  // The behavioural half: a 32 MiB name (`HEARTBEAT_MAX`, the largest a beat can
  // carry) coerces to the bounded 60-char value. A reintroduced unbounded spread
  // still produces this output, so this alone doesn't catch the bug — the
  // structural assertion above does — but it proves the coercion runs and bounds
  // the served value, deterministically at any load.
  const huge = { device: "h", localModel: { available: true, model: "x".repeat(32 << 20) } };
  hub.normalizeRecord(huge);
  assert.equal(huge.localModel.model, "x".repeat(60));
});

test("http: an EXPANDING coercion cannot escape the record ceiling", async () => {
  // normalizeModelUsage rewrites `"m"` to `{model:"m"}` — ~3.5x. Measuring only
  // the raw size let an 8 MiB beat of bare model names park 28 MiB per host for
  // a week, in state.json, in every /api/agents response and every SSE frame:
  // exactly the amplification the ceiling was added to stop.
  const host = "fat-expand";
  const models = new Array(2_000_000).fill("m");
  const res = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, sessions: [], usage: { models } },
  });
  assert.equal(res.status, 413);
  assert.equal(agents[host], undefined, "a refused beat must not install a record");
});

test("http: a beat whose coercion throws is refused, never installed raw", async () => {
  // The coercion runs AFTER `agents[key] = next`, so a throw inside it would
  // leave the RAW record installed — worse than refusing, because every gate
  // downstream then reads uncoerced values (`localModelAvailable` treats the
  // string "yes" as true and hands out a switch the host cannot honour), and
  // the poison reaches state.json where the restore chokes on it forever.
  const host = "throw-host";
  const res = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    // A non-iterable `repoUsage` used to throw out of normalizeUsage's `for…of`.
    body: { device: host, sessions: [], repoUsage: { a: 1 },
            localModel: { available: "yes" } },
  });
  // Either it coerces cleanly (the guards below) or it is refused — never both
  // 4xx AND installed.
  if (res.status !== 200) {
    assert.equal(agents[host], undefined, "a refused beat must not install a record");
  } else {
    // Accepted means fully coerced — never accepted-and-raw, which is the state
    // that defeats every gate downstream and poisons state.json.
    assert.equal(agents[host].localModel.available, false, "served uncoerced");
    assert.deepEqual(agents[host].repoUsage, [], "a non-array repoUsage must not be served");
  }
  // And the capability gate must not be fooled by the raw string either way.
  const spawn = await request("POST", `/api/agents/${host}/sessions`, {
    headers: userHeaders, body: { repo: "Turma", modelSource: "local" },
  });
  assert.equal(spawn.status, 409, "an uncoerced `available` must not pass the gate");
});

test("normalizeUsage survives a non-iterable repoUsage or sessions", () => {
  // A bare `for (… of payload.repoUsage || [])` throws on an object, and on the
  // restore path that throw aborts EVERY host after this one, silently.
  for (const bad of [{ a: 1 }, "str", 7, true]) {
    const p = { device: "h", repoUsage: bad, sessions: bad, usage: { models: ["m"] } };
    hub.normalizeRecord(p);             // must not throw
    // BOTH are typed lists on Android, so both are rewritten — not merely
    // stepped around. Guarding the loop alone turned a 400 (which never
    // installed the host) into a 200 serving a fleet-killing shape.
    assert.deepEqual(p.sessions, []);
    assert.deepEqual(p.repoUsage, []);
  }
});

test("a null usage is dropped in silence; a wrong-typed one still warns", () => {
  // The agent sends `usage: null` on purpose — a host reports one until it has
  // spent something, and a session's stays null until its transcript carries a
  // usage block. Tallying that made a NEW host warn on every beat that its
  // "token figures understate what it really spent", which was false and, at a
  // line per beat, buried the hosts genuinely sending the wrong shape.
  const warnings = [];
  const realWarn = console.warn;
  // One line a minute, fleet-wide — an earlier test in this file may have spent
  // the window, which would let the second assertion below pass for the wrong
  // reason.
  hub.resetUsageCoercionLog();
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    // Nulls in all three places one can ride: the host block, a repo row, and a
    // session. Every one is the deliberate value, so none of them may warn.
    const rec = {
      device: "quiet-host", usage: null,
      repoUsage: [{ repo: "Turma", usage: null }],
      sessions: [{ id: "s1", usage: null }],
    };
    hub.normalizeRecord(rec);
    assert.deepEqual(warnings, [], `a deliberate null must not warn: ${warnings[0] || ""}`);
    // Silence is only half of it: the key must still be DELETED, not left as an
    // explicit null. `RepoUsage.usage` is NON-nullable on Android
    // (Models.kt), so a served null there is decode-fatal for the whole
    // /api/agents array — and an early return in front of the delete is a
    // plausible edit now that the null case has a branch of its own.
    assert.ok(!("usage" in rec), "a null host usage must be dropped, not served");
    assert.ok(!("usage" in rec.repoUsage[0]), "a null repo usage must be dropped, not served");
    assert.ok(!("usage" in rec.sessions[0]), "a null session usage must be dropped, not served");

    // The other half, and the reason this is not just "stop warning": a host
    // that genuinely got the shape wrong must still be named.
    hub.resetUsageCoercionLog();
    hub.normalizeRecord({ device: "broken-host", usage: "lots" });
    assert.equal(warnings.length, 1, "a non-object, non-null usage must still warn");
    assert.match(warnings[0], /broken-host/, "the warning must name the host");
  } finally {
    console.warn = realWarn;
  }
});

test("normalizeSessions coerces the per-session fields Android types", () => {
  // Typing a field on `SessionInfo` is what makes it decode-fatal: before that
  // `ignoreUnknownKeys` skipped it and any value was harmless. `modelSource`
  // and `modelSourceAt` were typed by XERK-246, so they are coerced from it.
  const payload = {
    device: "h",
    sessions: [
      { id: "s1", modelSource: { a: 1 }, modelSourceAt: ["x"] },
      { id: "s2", modelSource: "local", modelSourceAt: "2026-08-11T00:00:00Z" },
      { id: "s3", session: { agents: [{ sel: "yes", type: { a: 1 }, label: ["x"] }] } },
      // `session` itself, not just its `agents`. `"agents" in []` is false, so
      // a bare `typeof live === "object"` guard neither coerces nor rejects an
      // ARRAY here and serves it raw — `LiveSignals?` is typed on Android, so
      // that is decode-fatal for the whole payload and blocks sign-in.
      { id: "s5", session: [] },
      { id: "s6", session: [1, 2] },
      { id: "s7", session: "busy" },
      { id: "s8", session: 7 },
      // Every non-object shape, not a representative one. An ARRAY element is
      // the case a `typeof s !== "object"` predicate misses (`typeof [] ===
      // "object"`), and it is decode-fatal exactly like the other two: measured
      // as the Android app unable to SIGN IN, because the login probe decodes
      // /api/agents and reads the throw as "Could not reach the hub".
      null,
      "nope",
      [1, 2],
      [],
    ],
  };
  hub.normalizeRecord(payload);
  assert.equal(payload.sessions.length, 7, "every non-object ELEMENT is dropped");
  assert.deepEqual(payload.sessions.map((s) => s.id),
    ["s1", "s2", "s3", "s5", "s6", "s7", "s8"]);
  // ...and every non-object `session` is REWRITTEN to null, not left raw.
  for (const id of ["s5", "s6", "s7", "s8"]) {
    assert.equal(payload.sessions.find((s) => s.id === id).session, null, `${id}.session`);
  }
  // A session that never carried `session` must not gain the key.
  assert.equal("session" in payload.sessions.find((s) => s.id === "s1"), false);
  assert.equal(payload.sessions[0].modelSource, "");
  assert.equal(payload.sessions[0].modelSourceAt, "");
  assert.equal(payload.sessions[1].modelSource, "local");        // good values untouched
  assert.equal(payload.sessions[1].modelSourceAt, "2026-08-11T00:00:00Z");
  assert.deepEqual(payload.sessions[2].session.agents,
    [{ sel: true, type: "[object Object]", label: "x" }]);
  // A session that never carried the keys must not gain them — an older agent's
  // payload has to stay byte-identical.
  hub.normalizeRecord({ device: "h", sessions: [{ id: "s4" }] });
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


// ---- the coercion backstop (XERK-262) ---------------------------------------
//
// A QA mutation pass deleted the whole try/catch around the heartbeat's
// coercion step and the entire node suite stayed green. It was reported as a
// gap on dead defensive code — no input could be found that made
// `normalizeRecord` throw. Half of that turned out to be wrong: one exists, and
// the first test below pins it. What it does NOT do is reach the backstop,
// because `sanitizeHeartbeat` walks the same rows first and refuses the beat
// before any record is installed. That ordering is the reason the catch looks
// dead, so both halves are held here — the ordering, and the rollback it hides.

test("heartbeat: a live-agent field with no primitive conversion never reaches the record", async () => {
  const host = "poison-host";
  // Pure JSON, straight off the wire: an object whose own `toString` and
  // `valueOf` are both non-callable has NO primitive conversion. It is the one
  // input that reaches a throw anywhere in the coercion path — which is what
  // makes the ordering below (sanitizeHeartbeat ahead of the record install)
  // load-bearing rather than incidental.
  const poison = JSON.parse('{"toString":1,"valueOf":1}');

  const good = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, sessions: [{ id: "s1", status: "running", repo: "r" }] },
  });
  assert.equal(good.status, 200);

  const bad = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: {
      device: host,
      sessions: [{ id: "s1", status: "running", session: { agents: [{ type: poison }] } }],
    },
  });
  // A DEFINITE verdict, never a 5xx and never a hang. Deliberately not pinned to
  // one status: this beat is refused 400 while the coercion can throw, and
  // becomes an ordinary 200 with the row dropped once XERK-278 makes
  // `sanitizeLiveAgents` total. Both are correct; what must never change is that
  // the poisoned row does not survive and the hub keeps serving.
  assert.ok(bad.status === 200 || bad.status === 400, `unexpected ${bad.status}`);
  const live = agents[host].sessions[0].session;
  assert.deepEqual(live ? live.agents : [], []);
  // Still answering — the throw must not have escaped the request handler.
  assert.equal((await request("GET", "/api/agents", { headers: userHeaders })).status, 200);
});

test("heartbeat: a coercion that throws rolls the record back rather than banking it raw", async () => {
  const host = "coercion-throw-host";
  const real = hub.recordCoercion.normalize;

  // A first beat the host is entitled to keep.
  assert.equal((await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { device: host, sessions: [{ id: "s1", status: "running", repo: "before" }] },
  })).status, 200);

  hub.recordCoercion.normalize = () => {
    throw new TypeError("coercion blew up");
  };
  try {
    const r = await request("POST", "/api/heartbeat", {
      headers: agentHeaders,
      body: { device: host, sessions: [{ id: "s1", status: "running", repo: "after" }] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "malformed heartbeat");
  } finally {
    hub.recordCoercion.normalize = real;
  }

  // `agents[key] = next` has ALREADY run by the time the coercion is called, so
  // without the rollback the RAW, uncoerced record stays installed and is what
  // every client is served — which is the whole reason the catch exists.
  assert.equal(agents[host].sessions[0].repo, "before");
});

test("heartbeat: a coercion that throws on a host's FIRST beat leaves no record at all", async () => {
  const host = "coercion-throw-first";
  const real = hub.recordCoercion.normalize;
  hub.recordCoercion.normalize = () => {
    throw new TypeError("coercion blew up");
  };
  try {
    const r = await request("POST", "/api/heartbeat", {
      headers: agentHeaders,
      body: { device: host, sessions: [{ id: "s1", status: "running", repo: "r" }] },
    });
    assert.equal(r.status, 400);
  } finally {
    hub.recordCoercion.normalize = real;
  }
  // No `prev` to restore, so the half-installed record must be DELETED. Leaving
  // it would put a host on the dashboard whose payload never passed a coercion.
  assert.ok(!(host in agents));
});

test("heartbeat: the coercion holder runs the real normalizeRecord in production", () => {
  // The seam must not become a place a coercion can be quietly unhooked: what
  // the holder carries by default IS the function every client's decode depends
  // on, and the two tests above only prove the catch given that it is.
  assert.equal(hub.recordCoercion.normalize, hub.normalizeRecord);
});

// ---- XERK-278: an unstringifiable value must never kill the process ---------
//
// `String(x)` throws `TypeError: Cannot convert object to primitive value` for a
// value with no usable primitive conversion, and pure JSON can express one:
// `{"toString":1,"valueOf":1}` has both hooks as own, NON-CALLABLE properties.
//
// `sanitizeLiveAgents` took that straight off an `/agent/control` WebSocket
// frame, inside a `socket.on("data")` listener with no try/catch above it and no
// process-level `uncaughtException` handler — so ONE frame exited node, and
// DockerOps' `restart: unless-stopped` turned that into an outage loop of the
// whole control plane. The socket only needs the ordinary single-user web login
// (`agentWsAuthorized` falls back to `agentAuthorized` falls back to
// `userAuthorized`), which is reachable through the public tunnel.
//
// These run in the SAME process as the rest of the suite, so a regression does
// not fail one assertion — it takes the entire test run down with it. That is
// the intended signal.

const UNSTRINGIFIABLE = JSON.parse('{"toString":1,"valueOf":1}');

test("sanitizeLiveAgents: an unstringifiable field is dropped, never thrown on", () => {
  // The `type` decides whether the row survives at all, so an unconvertible one
  // reads as absent and the row goes — exactly what a blank type already gets.
  assert.deepEqual(sanitizeLiveAgents([{ type: UNSTRINGIFIABLE }]), []);
  // A `label` is display-only, so the row survives with a blank label rather
  // than being dropped: losing the row would lose the "an agent is running"
  // signal that `hasLiveAgents` reads.
  assert.deepEqual(
    sanitizeLiveAgents([{ type: "qa", label: UNSTRINGIFIABLE }]),
    [{ sel: false, type: "qa", label: "" }]
  );
  // Good rows beside a poisoned one still come through.
  assert.deepEqual(
    sanitizeLiveAgents([{ type: UNSTRINGIFIABLE }, { type: "Explore", label: "look" }]),
    [{ sel: false, type: "Explore", label: "look" }]
  );
  // The ordinary coercions are unchanged.
  assert.deepEqual(sanitizeLiveAgents([{ type: 42 }]), [{ sel: false, type: "42", label: "" }]);
});

test("control WS: a poisoned agent row does not kill the hub", async () => {
  const host = "poison-ctrl";
  const ctrl = await wsConnect(`/agent/control?name=${host}&token=agenttok`);
  assert.match(ctrl.statusLine, /^HTTP\/1\.1 101/);

  ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify({
    turn: "s1", text: "hi", agents: [{ type: UNSTRINGIFIABLE }],
  }))));

  // The proof is that anything at all still answers afterwards. Before the fix
  // the process was gone by this point and no assertion ran.
  await waitFor(() => true, 200);
  const alive = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(alive.status, 200);
  ctrl.socket.destroy();
});

test("control WS: a non-string session id is refused, not used as a property key", async () => {
  // `liveFanout` does `liveClients[host]?.[sessionId]`, and coercing an object
  // to a property key runs the same ToPrimitive. It only bites once a viewer
  // socket exists for the host (the optional chain short-circuits otherwise), so
  // this test opens one first — which is why the frame handler now type-checks
  // the id rather than relying on `safeString` alone.
  const host = "poison-key";
  agents[host] = {
    device: host, online: true, lastSeen: Date.now(),
    sessions: [{ id: "pk1", status: "running", repo: "r", worktreePath: "/w",
      transcriptId: "conv-pk1", session: { tail: [] } }],
  };
  const ctrl = await wsConnect(`/agent/control?name=${host}&token=agenttok`);
  assert.match(ctrl.statusLine, /^HTTP\/1\.1 101/);
  const token = await issueToken();
  const live = await wsConnect(`/live/${host}/pk1?auth=${token}`);
  assert.match(live.statusLine, /^HTTP\/1\.1 101/);

  for (const frame of [
    { turn: UNSTRINGIFIABLE, text: "hi" },
    { tail: UNSTRINGIFIABLE, entries: [] },
  ]) {
    ctrl.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify(frame))));
  }

  await waitFor(() => true, 200);
  const alive = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(alive.status, 200);
  live.socket.destroy();
  ctrl.socket.destroy();
  delete agents[host];
});

test("heartbeat: the same poison on the ingest path is dropped, not crashed on", async () => {
  // The third caller. It was never the crash — the request handler's catch
  // turned the throw into a 400 — so the fix CHANGES its answer: the coercion no
  // longer throws, so the beat is now an ordinary 200 with the poisoned row
  // dropped. The pre-existing XERK-262 case above deliberately accepts either
  // status and asserts only the invariant (no poisoned row survives, the hub
  // keeps serving); this one pins the post-fix contract exactly, so a future
  // change back to refusing the whole beat has to be deliberate.
  const r = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: {
      device: "poison-ingest",
      sessions: [{ id: "s1", status: "running", session: { agents: [{ type: UNSTRINGIFIABLE }] } }],
    },
  });
  assert.equal(r.status, 200);
  // The poisoned row is dropped; the beat is otherwise honoured.
  assert.deepEqual(agents["poison-ingest"].sessions[0].session.agents, []);
});

// ---- durable token usage (XERK-338) -----------------------------------------
//
// Usage is an agent-derived aggregate that used to live only on the registry
// record, so removing a host threw its spend away and a host whose DISK was
// wiped came back reporting near-zero and overwrote its own past in place. The
// ledger's own arithmetic is unit-tested in usage-ledger.test.js; what is held
// here is the WIRING — that the hub folds it into what /api/agents serves, that
// a removed host keeps riding the payload, and that removing a host is not
// silently a purge.

// One host's usage half, shaped as the agent reports it (_finalize_usage).
// `days` is {date: tokens}; the all-time total is their sum.
function usageBeat(device, days, { repo = "r1" } = {}) {
  const b = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
  const total = Object.values(days).reduce((a, n) => a + n, 0);
  const block = () => ({
    totals: b(total), today: b(0), week: b(total),
    days: Object.fromEntries(Object.entries(days).map(([d, n]) => [d, b(n)])),
    sessions: 1, lastActivity: "2026-08-18T11:00:00Z",
    models: [{ model: "m1", totals: b(total), today: b(0), week: b(0) }],
  });
  return {
    device,
    usage: block(),
    repoUsage: [{ repo, remoteKey: `rk-${repo}`, remote: "", usage: block() }],
  };
}
const totalOf = (u) => (u ? u.totals.input : null);
async function fleet() {
  const r = await request("GET", "/api/agents", { headers: userHeaders });
  assert.equal(r.status, 200);
  return r.body;
}

test("usage: a wiped host's history is added back to what it reports", async () => {
  const host = "usage-wipe-host";
  usageLedger.forget(host);
  await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: usageBeat(host, { "2026-08-17": 900 }) });
  let a = (await fleet()).agents.find((x) => x.key === host);
  // Nothing lost yet, so the record is exactly the agent's own report.
  assert.equal(totalOf(a.usage), 900);

  // The box is re-imaged and rejoins under the same name: same host, near-empty
  // projects dir, so the aggregate it reports collapses.
  await request("POST", "/api/heartbeat", {
    headers: agentHeaders, body: usageBeat(host, { "2026-08-18": 20 }) });
  a = (await fleet()).agents.find((x) => x.key === host);
  assert.equal(totalOf(a.usage), 920);
  assert.equal(totalOf(a.repoUsage.find((r) => r.remoteKey === "rk-r1").usage), 920);
  // The STORED record stays the agent's raw report — the fold is a serving-time
  // view, so what is size-budgeted and saved is still what the agent sent.
  assert.equal(agents[host].usage.totals.input, 20);

  delete agents[host];
  usageLedger.forget(host);
});

test("usage: transcripts aging out from under a live host are not double-counted", async () => {
  // Claude Code deletes its own transcripts on `cleanupPeriodDays`, so a live,
  // healthy host's reported all-time total drops routinely. Adding the old total
  // to the new one would count every surviving transcript twice, every month —
  // which is why the ledger is a per-DAY high-water mark and not a carry.
  const host = "usage-prune-host";
  usageLedger.forget(host);
  await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: usageBeat(host, { "2026-08-16": 300, "2026-08-17": 700 }) });
  const aged = usageBeat(host, { "2026-08-17": 700 });
  for (let i = 0; i < 3; i++) {
    await request("POST", "/api/heartbeat", { headers: agentHeaders, body: aged });
    const a = (await fleet()).agents.find((x) => x.key === host);
    assert.equal(totalOf(a.usage), 1000, `beat ${i}: the answer must be stable, not compounding`);
  }
  delete agents[host];
  usageLedger.forget(host);
});

test("usage: removing a host keeps its spend, as a retired series", async () => {
  const host = "usage-removed-host";
  usageLedger.forget(host);
  await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { ...usageBeat(host, { "2026-08-18": 400 }), jira: { siteKey: "XERK" } },
  });
  const del = await request("DELETE", `/api/agents/${host}`, { headers: userHeaders });
  assert.equal(del.status, 200);
  assert.equal(del.body.usagePurged, false);

  const body = await fleet();
  assert.equal(body.agents.some((x) => x.key === host), false);
  const rec = body.retiredUsage.find((x) => x.key === host);
  assert.ok(rec, "a removed host's usage still rides /api/agents");
  assert.equal(rec.retired, true);
  assert.equal(rec.online, false);
  assert.equal(totalOf(rec.usage), 400);
  // Carried so the header's org filter still applies to it on both clients.
  assert.deepEqual(rec.jira, { siteKey: "XERK" });
  // And it is NOT a host: nothing outside the Usage page may treat it as one.
  assert.equal("sessions" in rec, false);

  usageLedger.forget(host);
});

test("usage: purging is a separate, deliberate step from removing the host", async () => {
  const host = "usage-purge-host";
  usageLedger.forget(host);
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: usageBeat(host, { "2026-08-18": 700 }) });
  const del = await request("DELETE", `/api/agents/${host}?usage=purge`, { headers: userHeaders });
  assert.equal(del.status, 200);
  assert.equal(del.body.usagePurged, true);
  assert.equal(usageLedger.has(host), false);
  const body = await fleet();
  assert.equal(body.retiredUsage.some((x) => x.key === host), false);
});

test("usage: a host that returns intact is never counted twice", async () => {
  const host = "usage-return-host";
  usageLedger.forget(host);
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: usageBeat(host, { "2026-08-18": 500 }) });
  // Removed from the registry — the operator tidying a card, or prune()/eviction
  // — and then back with its transcripts untouched.
  delete agents[host];
  invalidateAgentsCache();
  await request("POST", "/api/heartbeat", { headers: agentHeaders, body: usageBeat(host, { "2026-08-18": 500 }) });
  const a = (await fleet()).agents.find((x) => x.key === host);
  assert.equal(totalOf(a.usage), 500);
  delete agents[host];
  usageLedger.forget(host);
});

test("usage: a refused beat is not history", async () => {
  // The ingest sits behind every gate that can still refuse the beat: a record
  // rolled back to `prev` must not have been banked into the ledger first.
  const host = "usage-refused-host";
  usageLedger.forget(host);
  const fat = await request("POST", "/api/heartbeat", {
    headers: agentHeaders,
    body: { ...usageBeat(host, { "2026-08-18": 300 }), sessions: "A".repeat(AGENT_RECORD_MAX + 1024) },
  });
  assert.equal(fat.status, 413);
  assert.equal(usageLedger.has(host), false);
});

// --- the org-scoped peer roster (XERK-348) ---------------------------------
// `ListAgents` is denied agent-side, so this roster is the ONLY address book a
// session has. What the hub puts in it IS the org boundary, which is why these
// assert what is EXCLUDED as hard as what is included.

// `bound` defaults to the declared org — the ordinary case, a host the hub bound
// on its first beat. Pass it explicitly to model a host DECLARING one org while
// bound to another, which is what an agent token trying to change orgs looks
// like from here.
function peerHost(key, siteKey, sessions, ageMs = 0, bound = siteKey) {
  agents[key] = {
    key, device: key, lastSeen: Date.now() - ageMs,
    jira: siteKey ? { siteKey } : undefined,
    orgBound: bound || undefined,
    sessions,
  };
}
function peerSession(id, extra = {}) {
  return { id, rcName: `rc-${id}`, repo: "Turma", status: "running", ...extra };
}
function dropPeerHosts(...keys) {
  for (const k of keys) delete agents[k];
}

test("orgPeers spans the org's hosts and excludes every other org", () => {
  peerHost("nasA", "acme.atlassian.net", [peerSession("s1")]);
  peerHost("nasB", "acme.atlassian.net", [peerSession("s2")]);
  peerHost("other", "rival.atlassian.net", [peerSession("s3")]);
  try {
    const names = orgPeers("nasA").map((p) => p.id);
    // The whole point: a multi-host org still reaches itself...
    assert.deepEqual(names.sort(), ["s1", "s2"]);
    // ...and never anyone else. A regression here is a cross-org leak, not a
    // cosmetic bug.
    assert.equal(names.includes("s3"), false);
  } finally {
    dropPeerHosts("nasA", "nasB", "other");
  }
});

test("an org-less host is alone, never pooled with other org-less hosts", () => {
  // "No tracker block" is not an org they share — it is the absence of one, and
  // pooling them would build a roster spanning unrelated deployments.
  peerHost("loneA", null, [peerSession("s1")]);
  peerHost("loneB", null, [peerSession("s2")]);
  try {
    assert.deepEqual(orgPeers("loneA").map((p) => p.id), ["s1"]);
  } finally {
    dropPeerHosts("loneA", "loneB");
  }
});

test("an offline host's sessions are left out; the caller's own are not", () => {
  // A name that can only absorb a message is worse than no name. The caller is
  // exempt: it is beating right now, by definition.
  peerHost("nasA", "acme.atlassian.net", [peerSession("mine")]);
  peerHost("gone", "acme.atlassian.net", [peerSession("dead")], 10 * 60 * 1000);
  try {
    assert.deepEqual(orgPeers("nasA").map((p) => p.id), ["mine"]);
  } finally {
    dropPeerHosts("nasA", "gone");
  }
});

test("only running sessions are listed", () => {
  peerHost("nasA", "acme.atlassian.net", [
    peerSession("run"),
    peerSession("q", { status: "queued" }),
    peerSession("stop", { status: "stopped" }),
  ]);
  try {
    assert.deepEqual(orgPeers("nasA").map((p) => p.id), ["run"]);
  } finally {
    dropPeerHosts("nasA");
  }
});

test("a row carries the ticket, the live branch and the host", () => {
  peerHost("nasA", "acme.atlassian.net", [
    peerSession("s1", {
      ticket: { key: "XERK-348", summary: "Scope messaging" },
      summary: "ignored when a ticket names it",
      git: { liveBranch: "XERK-348" },
    }),
  ]);
  try {
    const [row] = orgPeers("nasA");
    assert.equal(row.host, "nasA");
    assert.equal(row.branch, "XERK-348");
    assert.equal(row.task, "XERK-348 Scope messaging");
  } finally {
    dropPeerHosts("nasA");
  }
});

test("a long task is cut on the wire, before the agent ever sees it", () => {
  peerHost("nasA", "acme.atlassian.net", [
    peerSession("s1", { summary: "x".repeat(5000) }),
  ]);
  try {
    assert.ok(orgPeers("nasA")[0].task.length <= 200);
  } finally {
    dropPeerHosts("nasA");
  }
});

test("the roster is capped, and same-host rows survive the cap first", () => {
  // Every session reads this file, so an unbounded roster is charged to all of
  // them — and the peer in the next worktree is likelier to be worth a message
  // than one two hosts away.
  peerHost("nasA", "acme.atlassian.net",
    Array.from({ length: 40 }, (_, i) => peerSession(`mine${i}`)));
  peerHost("nasB", "acme.atlassian.net",
    Array.from({ length: 400 }, (_, i) => peerSession(`theirs${i}`)));
  try {
    const rows = orgPeers("nasA");
    assert.equal(rows.length, 120);
    assert.equal(rows.filter((r) => r.host === "nasA").length, 40);
  } finally {
    dropPeerHosts("nasA", "nasB");
  }
});

test("an unknown host gets no roster at all", () => {
  assert.deepEqual(orgPeers("never-heard-of-it"), []);
});

test("a host is served on the org it is BOUND to, never the one it claims", () => {
  // The defect this binding exists for: `jira.siteKey` is asserted by the agent
  // about itself, so without a binding any host token could join any org and
  // read that org's whole roster — session ids, names, repos, branches, ticket
  // summaries — which no agent credential can reach otherwise (/api/agents
  // refuses one). Same objection XERK-268 makes to a self-asserted <host>.
  peerHost("alpha", "acme.atlassian.net", [peerSession("secret")]);
  peerHost("alpha2", "acme.atlassian.net", [peerSession("secret2")]);
  // The rogue must be bound to an org that HAS another member. With a
  // lone-member binding, BOTH guards in orgPeers are dead code in the fixture:
  // deleting either left the whole suite green while a drifting host kept its
  // real org's roster and was served back to its org-mates.
  peerHost("rmate", "rival.atlassian.net", [peerSession("rivalmate")]);
  peerHost("rogue", "rival.atlassian.net", [peerSession("mine")]);
  agents.rogue.jira.siteKey = "acme.atlassian.net";   // bound rival, claiming acme
  try {
    const ids = orgPeers("rogue").map((p) => p.id);
    // Not acme's roster (the org it claims)...
    assert.equal(ids.includes("secret"), false);
    assert.equal(ids.includes("secret2"), false);
    // ...and not rival's either (the org it is bound to): a host lying about its
    // org is quarantined from BOTH while it says so.
    assert.equal(ids.includes("rivalmate"), false);
    assert.deepEqual(ids, ["mine"]);
    // And it is absent from the impersonated org's roster AND its own mate's.
    assert.deepEqual(orgPeers("alpha").map((p) => p.id).sort(), ["secret", "secret2"]);
    assert.deepEqual(orgPeers("rmate").map((p) => p.id), ["rivalmate"]);
  } finally {
    dropPeerHosts("alpha", "alpha2", "rmate", "rogue");
  }
});

test("orgDrifted/boundOrgOf read the binding, not the claim", () => {
  assert.equal(boundOrgOf({ orgBound: "a" }), "a");
  assert.equal(boundOrgOf({ jira: { siteKey: "a" } }), "");   // claim alone binds nothing
  assert.equal(boundOrgOf(null), "");
  assert.equal(orgDrifted({ orgBound: "a", jira: { siteKey: "a" } }), false);
  assert.equal(orgDrifted({ orgBound: "a", jira: { siteKey: "b" } }), true);
  // Never bound: nothing to drift from, and it gets no peers by the org check.
  assert.equal(orgDrifted({ jira: { siteKey: "b" } }), false);
});

test("http: the org binds on first sight and does not move afterwards", async () => {
  const beat = (payload) =>
    request("POST", "/api/heartbeat", { body: payload, headers: agentHeaders });
  const host = "tofu-host";
  try {
    await beat({ device: host, jira: { siteKey: "first.atlassian.net" } });
    assert.equal(agents[host].orgBound, "first.atlassian.net");
    // A later beat claiming a different org must not move the binding — this is
    // the whole mechanism, and it has to hold on the real route, not just in
    // the helper.
    await beat({ device: host, jira: { siteKey: "second.atlassian.net" } });
    assert.equal(agents[host].orgBound, "first.atlassian.net");
    // And a heartbeat cannot simply assert its own binding: the field is
    // assigned AFTER the payload spread, like tokenBound.
    await beat({ device: host, orgBound: "third.atlassian.net",
                 jira: { siteKey: "first.atlassian.net" } });
    assert.equal(agents[host].orgBound, "first.atlassian.net");
  } finally {
    delete agents[host];
    orgDriftWarned.delete(host);
  }
});

test("http: orgBound is hub-internal and never served to clients", async () => {
  const host = "tofu-hidden";
  try {
    await request("POST", "/api/heartbeat", {
      body: { device: host, jira: { siteKey: "acme.atlassian.net" } },
      headers: agentHeaders,
    });
    const res = await request("GET", "/api/agents", { headers: userHeaders });
    const served = res.body.agents.find((a) => a.device === host);
    assert.ok(served);
    assert.equal("orgBound" in served, false);
  } finally {
    delete agents[host];
  }
});

test("every roster cell is capped on the wire, not just the free-text one", () => {
  // rcName has no length bound anywhere in the hub's normalizers, and the hub's
  // own spawn route accepts a 100k label the agent slugs into it. Uncapped, a
  // few such names build a reply large enough to OOM a 256 MiB hub.
  peerHost("nasA", "acme.atlassian.net", [
    peerSession("i".repeat(9000), {
      rcName: "n".repeat(200000),
      repo: "r".repeat(9000),
      summary: "t".repeat(9000),
      git: { liveBranch: "b".repeat(9000) },
    }),
  ]);
  try {
    const [row] = orgPeers("nasA");
    for (const [field, value] of Object.entries(row)) {
      assert.ok(value.length <= 120, `${field} was ${value.length} chars`);
    }
    // And the whole roster with it: six capped cells x the row cap.
    assert.ok(JSON.stringify(orgPeers("nasA")).length < 100 * 1024);
  } finally {
    dropPeerHosts("nasA");
  }
});

test("the roster BUILDS at most the cap, however many sessions are declared", () => {
  // Capping cell width left the row COUNT unbounded. Nothing limits how many
  // running sessions a heartbeat may declare, so materialising every row before
  // slicing to 120 OOM-killed a 256 MiB hub on four hosts x 60k sessions while a
  // pre-roster hub served the same load. Assert on what is BUILT.
  const many = (n, p) => Array.from({ length: n }, (_, i) => peerSession(`${p}${i}`));
  peerHost("nasA", "acme.atlassian.net", many(5000, "mine"));
  peerHost("nasB", "acme.atlassian.net", many(5000, "theirs"));
  try {
    const built = [];
    const rows = orgPeers("nasA");
    assert.equal(rows.length, 120);
    // Own host first and the cap reached there, so no other host is even walked.
    assert.equal(rows.every((r) => r.host === "nasA"), true);
    built.push(rows);
    // And the second host is reached when the first leaves room.
    peerHost("nasA", "acme.atlassian.net", many(10, "mine"));
    const mixed = orgPeers("nasA");
    assert.equal(mixed.length, 120);
    assert.equal(mixed.filter((r) => r.host === "nasA").length, 10);
  } finally {
    dropPeerHosts("nasA", "nasB");
  }
});

test("a non-string siteKey is no org at all, not a permanent drift", () => {
  // `jira` is agent-supplied and `siteKey` is never coerced. An object would be
  // compared by reference, so a host declaring the same shape every beat reads
  // as drifted forever: it silently loses every peer and warns on every beat.
  assert.equal(siteKeyOf({ jira: { siteKey: { o: 1 } } }), "");
  assert.equal(siteKeyOf({ jira: { siteKey: ["a"] } }), "");
  assert.equal(siteKeyOf({ jira: { siteKey: 5 } }), "");
  assert.equal(siteKeyOf({ jira: { siteKey: true } }), "");
  assert.equal(siteKeyOf({ jira: { siteKey: "acme" } }), "acme");
  // So a host declaring one is org-less and stable, never drifting.
  const a = { orgBound: undefined, jira: { siteKey: { o: 1 } } };
  assert.equal(orgDrifted(a), false);
});

test("the drift warning is rate-limited per host, and capped on both sides", () => {
  // Keying the de-dupe on the declared VALUE let a host alternating two site
  // keys warn every beat; keying it on a drifted/not-drifted FLAG was no better,
  // because the flag flips just as easily — whether the host alternates two orgs
  // or alternates one org with silence. Both measured ~10 warns per 20 beats.
  // Only a time bound holds, and the interpolated keys need capping on both
  // sides: they are agent-supplied and uncapped upstream, and a 100 KB siteKey
  // wrote a 100 KB log line from a single agent token.
  const lines = [];
  const realWarn = console.warn;
  console.warn = (m) => lines.push(String(m));
  peerHost("flip", "a".repeat(100000), [peerSession("s1")], 0, "bound.example");
  try {
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) agents.flip.jira.siteKey = "a".repeat(100000);
      else if (i % 3 === 1) delete agents.flip.jira.siteKey;   // silence
      else agents.flip.jira.siteKey = "bound.example";          // its real org
      warnOrgDrift("flip", agents.flip);
    }
    assert.equal(lines.length, 1, `warned ${lines.length} times in 20 beats`);
    assert.ok(lines[0].length < 500, `log line was ${lines[0].length} chars`);
    // The SUBSTANCE of the line, not just its length. It is the only thing that
    // tells an operator what happened, and it once claimed the only recovery was
    // deleting the host — which is false, since the binding never moves. Without
    // this the whole sentence can be replaced and the suite stays green.
    assert.match(lines[0], /declares org/);
    assert.match(lines[0], /but is bound to/);
    assert.match(lines[0], /no peers beyond its own sessions/);
    assert.match(lines[0], /declares the bound org again is served normally/);

    // BOTH interpolated sides need the cap. Only the claimed side was covered,
    // and deleting the bound-side slice escaped the suite.
    lines.length = 0;
    orgDriftWarned.delete("flip");            // clear the rate limit, not the drift
    agents.flip.orgBound = "b".repeat(100000);
    agents.flip.jira.siteKey = "short";
    warnOrgDrift("flip", agents.flip);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length < 500, `bound-side line was ${lines[0].length} chars`);

    // A host that is NOT drifting never warns, however often it beats.
    lines.length = 0;
    orgDriftWarned.delete("flip");
    agents.flip.orgBound = "bound.example";
    agents.flip.jira.siteKey = "bound.example";
    for (let i = 0; i < 5; i++) warnOrgDrift("flip", agents.flip);
    assert.equal(lines.length, 0);
  } finally {
    console.warn = realWarn;
    dropPeerHosts("flip");
    orgDriftWarned.delete("flip");
  }
});


test("a models block with no usable label cannot clear a real host's label", async () => {
  // `mergeSites` (board.js, its vendored copies, and Board.kt) writes the label
  // whenever `at` is at least the incumbent's, so a block with a FRESH `at` and an
  // empty label takes "Opus 5" off a host that probed properly — the picker drops
  // to "Default". A real agent reaches this honestly: the probe returns
  // `label or None` when there is no "Current model:" line to read.
  for (const bad of [{ available: ["Opus 5"], defaultLabel: 5, at: "2099-01-01" },
                     { available: ["Opus 5"], defaultLabel: null, at: "2099-01-01" },
                     { available: ["Opus 5"], at: "2099-01-01" }]) {
    const rec = { device: "labelless-host", models: bad };
    hub.normalizeRecord(rec);
    assert.deepEqual(rec.models.available, ["Opus 5"], "the list it does know still rides");
    assert.equal(rec.models.defaultLabel, "");
    assert.equal(rec.models.at, "", `a labelless block kept its claim: ${JSON.stringify(bad)}`);
  }
  // A block that HAS a label keeps its date, or it could never win legitimately.
  const good = { device: "real-host",
                 models: { available: ["Opus 5"], defaultLabel: "Opus 5", at: "2026-01-01" } };
  hub.normalizeRecord(good);
  assert.equal(good.models.at, "2026-01-01");
});
