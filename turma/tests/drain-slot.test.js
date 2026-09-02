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
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-drain-migrations-"));
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-drain-archive-"));
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
