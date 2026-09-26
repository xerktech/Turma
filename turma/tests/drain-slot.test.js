// XERK-291: the drain-slot counter (`drainingNow`, capped at DRAIN_CONCURRENCY_MAX)
// must be RELEASED when a refused read settles — not only on the request's
// `close` event, which does not reliably fire for a refused body that PAUSES
// (a budget refusal, or a size refusal past the concurrency cap). A leaked slot
// wedges `drainingNow` at the cap for the life of the process, after which every
// over-cap body takes the no-drain path and is reset instead of getting its 413 —
// defeating this same ticket's fix under exactly the concurrent load it targets.
//
// This gets its OWN process because the memory budget is a require-time constant
// and the numbers that make budget refusals cheap to trigger (a small container
// limit) are nothing like the fleet's. node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

// Pinned BEFORE the module loads. A 64 MiB limit makes the heartbeat cap 8 MiB
// and the in-flight budget 32 MiB, so a ~6 MiB beat (charged 6x for parse cost)
// is refused on BUDGET while still small and quick to send.
process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.MEMORY_LIMIT_BYTES = String(64 << 20);
process.env.AGENTS_MAX = "500";

const tmp = (name) => path.join(os.tmpdir(), `turma-drain-${name}-${process.pid}.json`);
process.env.STATE_FILE = tmp("state");
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-drain-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-drain-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const { server, HEARTBEAT_MAX, DRAIN_CONCURRENCY_MAX } = hub;

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const agentHeaders = { authorization: "Bearer agenttok", "content-type": "application/json" };

// Stream the body in slices with NO Content-Length (chunked), so the refusal
// happens MID-READ as bytes arrive — the path whose paused `close` leaks — not
// on the declared length (which is refused before any body and never leaks).
function streamBeat(bytes) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ device: "d" + Math.random(), pad: "y".repeat(bytes) });
    const req = http.request(
      baseUrl + "/api/heartbeat",
      { method: "POST", headers: { ...agentHeaders, connection: "close" } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode })); }
    );
    req.on("error", (e) => resolve({ status: 0, err: e.code }));
    let off = 0;
    const CHUNK = 128 * 1024;
    (function pump() {
      while (off < body.length) {
        const end = Math.min(off + CHUNK, body.length);
        if (!req.write(body.slice(off, end))) { off = end; req.once("drain", pump); return; }
        off = end;
      }
      req.end();
    })();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function drainingSettlesToZero(tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (hub.drainingNow === 0) return true;
    await sleep(50);
  }
  return hub.drainingNow === 0;
}

test("XERK-291: the drain-slot cap and cost model make this test's beats budget-refused", () => {
  // Guardrails so a future ceiling change can't silently turn the beats below
  // into 200s or plain size refusals and make the leak assertions vacuous.
  assert.equal(HEARTBEAT_MAX, 8 << 20, "64 MiB limit => 8 MiB heartbeat cap");
  assert.ok(DRAIN_CONCURRENCY_MAX >= 1);
});

test("XERK-291: concurrent budget-refused beats do not LEAK drain slots", async () => {
  assert.equal(hub.drainingNow, 0, "starts clean");
  // Several rounds of concurrent ~6 MiB beats (under the 8 MiB cap, so a SIZE
  // check never fires; charged 6x they blow the 32 MiB budget) => mid-read
  // budget refusals, each of which claims a drain slot. Pre-fix these leaked and
  // wedged the counter at DRAIN_CONCURRENCY_MAX; the fix releases at settle.
  const SIX_MIB = 6 << 20;
  for (let round = 0; round < 4; round++) {
    const res = await Promise.all(Array.from({ length: 16 }, () => streamBeat(SIX_MIB)));
    // At least some must actually be budget-refused (503) or reset for the test
    // to mean anything — a 200-only round proves nothing.
    assert.ok(res.some((r) => r.status === 503 || r.status === 0),
      `round ${round}: expected budget refusals, got ${JSON.stringify(res.map((r) => r.status))}`);
  }
  assert.ok(await drainingSettlesToZero(),
    `drainingNow leaked to ${hub.drainingNow} (cap ${DRAIN_CONCURRENCY_MAX}) instead of settling to 0`);
});

test("XERK-291: an honest over-cap beat still gets its 413 after a refusal flood", async () => {
  // The user-visible payoff: with the slots leaked, this over-cap body would take
  // the no-drain path and reset; with them released it drains and answers 413.
  for (let i = 0; i < 6; i++) {
    const r = await streamBeat((8 << 20) + (1 << 20)); // 9 MiB, over the 8 MiB cap
    assert.equal(r.status, 413, `attempt ${i}: over-cap must answer 413, got ${r.status || r.err}`);
  }
  assert.ok(await drainingSettlesToZero(), `drainingNow=${hub.drainingNow} after over-cap beats`);
});

// A raw client shaped like urllib (what hub-agent.py posts with): it writes its WHOLE
// declared body before it reads, and keeps writing after the hub's FIN (allowHalfOpen) —
// that is the case the lingering close exists for. It closes only once it sees the hub's
// FIN. Resolves on close with what was read, whether the whole body went out, any socket
// error, and how long after the status arrived the hub's FIN came.
function postWhileWriting(declared, route = "/api/heartbeat", auth = "Bearer agenttok") {
  const net = require("net");
  const { port } = server.address();
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let got = "";
    let err = null;
    let sent = 0;
    let wroteAt = 0;
    let statusAt = 0;
    let finMs = Infinity;
    sock.on("data", (c) => { if (!statusAt) statusAt = Date.now(); got += c; });
    let finOpen = true; // the hub has not FIN'd yet
    const closeIfDone = () => { if (!finOpen && wroteAt) sock.end(); };
    sock.on("end", () => { finOpen = false; finMs = Date.now() - statusAt; closeIfDone(); });
    sock.on("error", (e) => { err = e.code; });
    sock.on("close", () => resolve({ got, err, wroteAll: sent >= declared, finMs }));
    sock.write(`POST ${route} HTTP/1.1\r\nhost: x\r\nauthorization: ${auth}\r\n` +
      `content-type: application/json\r\ncontent-length: ${declared}\r\n\r\n`);
    const chunk = Buffer.alloc(256 * 1024, 0x79);
    (function pump() {
      while (sent < declared && !sock.destroyed) {
        sent += chunk.length;
        if (!sock.write(chunk)) { sock.once("drain", pump); return; }
      }
      wroteAt = Date.now();
      closeIfDone();
    })();
  });
}

// Take the big lane with a beat that has sent 6 MiB (charged ~6x) of a declared 7 MiB,
// so the next heartbeat declaring 7 MiB is refused 503 on its claim.
async function holdBigLane() {
  const holder = require("net").connect(server.address().port, "127.0.0.1");
  holder.on("error", () => {});
  holder.write(`POST /api/heartbeat HTTP/1.1\r\nhost: x\r\nauthorization: Bearer agenttok\r\n` +
    `content-type: application/json\r\ncontent-length: ${7 << 20}\r\n\r\n` + "y".repeat(6 << 20));
  const inBigLane = () => hub.bodyInflightHeld() > hub.BODY_INFLIGHT_TOTAL_MAX;
  for (let i = 0; i < 80 && !inBigLane(); i++) await sleep(25);
  assert.ok(inBigLane(), "the holder occupies the big lane");
  return holder;
}

for (const [label, declared, status, holdBudget] of [
  // An idle hub admits any one body into the big lane, so another beat takes that
  // lane first; this one is then refused on its claim, before it has sent anything.
  ["a budget 503", 7 << 20, 503, true],
  // Past cap + drain slack: read to there, then refused without draining.
  ["a no-drain 413", 40 << 20, 413, false],
]) {
  test(`XERK-1076: ${label} lingers under a still-writing client — it writes its whole body, reads the status, no reset`, async () => {
    const holder = holdBudget ? await holdBigLane() : null;
    try {
      const r = await postWhileWriting(declared);
      assert.equal(r.err, null, `the connection was reset (${r.err}) instead of closing cleanly`);
      assert.ok(r.wroteAll, "the hub kept reading (and discarding) until the client finished");
      // The FIN follows the response itself — Node's own `connection: close` teardown is
      // what the override replaces, so without the linger's own end() only the time bound
      // would close it.
      assert.ok(r.finMs < hub.REFUSE_LINGER_MS / 4, `FIN ${r.finMs}ms after the status, not at the time bound`);
      assert.match(r.got, /\r\nconnection: close\r\n/i, "the refusal announces the close");
      assert.match(r.got, new RegExp(`^HTTP/1\\.1 ${status} `), `the ${status} reached the client`);
      for (let i = 0; i < 40 && hub.refusalsLingering; i++) await sleep(50);
      assert.equal(hub.refusalsLingering, 0, "lingering refusal released on close");
    } finally {
      if (holder) holder.destroy();
    }
  });
}

test("XERK-1076: an attachment past cap + drain slack lingers too, and announces the close", async () => {
  // A host that takes 1 MiB attachments; 40 MiB is past cap + slack, so no drain.
  const hb = await fetch(baseUrl + "/api/heartbeat", {
    method: "POST", headers: agentHeaders,
    body: JSON.stringify({ device: "up1076", sessions: [], repos: [], uploadMaxBytes: 1 << 20 }),
  });
  assert.equal(hb.status, 200);
  const basic = "Basic " + Buffer.from("hubuser:hubpass").toString("base64");
  const r = await postWhileWriting(40 << 20, "/api/agents/up1076/uploads?name=a.bin", basic);
  assert.equal(r.err, null, `the connection was reset (${r.err})`);
  assert.ok(r.wroteAll, "the hub kept reading (and discarding) until the client finished");
  assert.match(r.got, /^HTTP\/1\.1 413 /, "the 413 reached the client");
  assert.match(r.got, /\r\nconnection: close\r\n/i, "the refusal announces the close");
  assert.ok(r.finMs < hub.REFUSE_LINGER_MS / 4, `FIN ${r.finMs}ms after the status, not at the time bound`);
});

test("XERK-1076: lingers are capped at REFUSE_LINGER_MAX and bounded in time by REFUSE_LINGER_MS", async () => {
  const net = require("net");
  const holder = await holdBigLane();
  // Clients that declare a body, get their 503, and then neither send nor close: each
  // holds a linger until the time bound. More of them than the cap allows to linger.
  const n = hub.REFUSE_LINGER_MAX + 3;
  const socks = [];
  let peak = 0;
  try {
    for (let i = 0; i < n; i++) {
      const s = net.connect({ port: server.address().port, host: "127.0.0.1", allowHalfOpen: true });
      s.on("error", () => {});
      s.write(`POST /api/heartbeat HTTP/1.1\r\nhost: x\r\nauthorization: Bearer agenttok\r\n` +
        `content-type: application/json\r\ncontent-length: ${7 << 20}\r\n\r\n`);
      socks.push(s);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 500) { peak = Math.max(peak, hub.refusalsLingering); await sleep(10); }
    assert.equal(peak, hub.REFUSE_LINGER_MAX, "exactly the cap lingers; the overflow is cut at once");
    // Nobody closes, so only the time bound can release them.
    while (hub.refusalsLingering && Date.now() - t0 < hub.REFUSE_LINGER_MS + 1500) await sleep(25);
    assert.equal(hub.refusalsLingering, 0, "every linger released by the time bound");
  } finally {
    holder.destroy();
    for (const s of socks) s.destroy();
  }
});
