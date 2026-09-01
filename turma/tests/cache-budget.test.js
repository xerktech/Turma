// Unit tests for the on-demand caches' byte budget (XERK-292).
//
// AGENT_CACHE_KEYS (history, subagentHistory, jiraIssues, create*, …) are
// excluded from `agentRecordSize` and so from every byte gate a heartbeat passes
// (AGENT_RECORD_MAX, the aggregate registry budget) — XERK-235, so a legitimate
// ~6 MiB /history delivery can never cost a host its heartbeat. That left them
// bounded only by COUNT: one device name sending 8 oversized `historyResults`
// parked HISTORY_MAX_SESSIONS entries of arbitrary size for HISTORY_MAX_AGE_MS
// and OOM-killed a 256 MiB hub with no concurrency. The fix bounds them by BYTES
// too, per host and fleet-wide, by EVICTION — never by refusing a beat.
//
// This gets its OWN process because the caps are process-wide constants read at
// require time, and the numbers that make the behaviour testable (KiB, not MiB)
// are nothing like a real hub's. node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

// Environment must be pinned BEFORE the module under test loads.
process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
// Registry caps kept out of the way — this file is about the cache budget, not
// the record budget, so a single host must be able to beat freely.
process.env.AGENTS_MAX = "16";
process.env.AGENTS_TOTAL_MAX = String(64 << 20);
// The caps under test, tiny so a handful of chunky history entries cross them.
process.env.AGENT_CACHE_HOST_MAX = String(200 << 10); // 200 KiB per host
process.env.AGENT_CACHE_TOTAL_MAX = String(320 << 10); // 320 KiB fleet-wide

const tmp = (name) => path.join(os.tmpdir(), `turma-cachebud-${name}-${process.pid}.json`);
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.STATE_FILE = tmp("state");
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-cachebud-migrations-"));
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-cachebud-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const {
  server, agents, recordBytes,
  AGENT_CACHE_KEYS, AGENT_CACHE_HOST_MAX, AGENT_CACHE_TOTAL_MAX,
  cacheEntryRows, agentRecordSize, serializeAgentsForSave, AGENT_RECORD_MAX,
} = hub;

// ---- HTTP ------------------------------------------------------------------

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
        try { parsed = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const agentHeaders = { authorization: "Bearer agenttok", "content-type": "application/json" };
const beat = (body) => request("POST", "/api/heartbeat", { body, headers: agentHeaders });

function resetRegistry() {
  for (const key of Object.keys(agents)) delete agents[key];
  recordBytes.clear();
}

// One history delivery of roughly `kib` KiB for a session, the shape the agent
// stages. The entry text is what carries the weight.
const historyDelivery = (sessionId, kib) => ({
  sessionId,
  entries: [{ id: "e1", role: "assistant", text: "x".repeat(kib << 10), blocks: [] }],
  truncated: false,
});

const cacheBytes = (agent) =>
  cacheEntryRows(agent).reduce((n, r) => n + r.bytes, 0);

// ---- the constants are sane ------------------------------------------------

test("caps: per-host is at or under the fleet-wide budget", () => {
  // A per-host cap above the aggregate would never bite — the aggregate would
  // refuse first — so the derivation must keep host <= total on every container.
  assert.ok(AGENT_CACHE_HOST_MAX <= AGENT_CACHE_TOTAL_MAX);
  assert.equal(AGENT_CACHE_HOST_MAX, 200 << 10);
  assert.equal(AGENT_CACHE_TOTAL_MAX, 320 << 10);
});

// ---- the per-host bound (the XERK-292 repro) -------------------------------

test("host: sequential oversized deliveries stay bounded, not accumulated", async () => {
  resetRegistry();
  // The repro: ONE device name, beats sent sequentially, each carrying a large
  // history delivery for a DIFFERENT session (so the count cap does not evict
  // them). Without the byte budget these accumulate to HISTORY_MAX_SESSIONS x
  // their size and OOM the hub; with it the host is held to its cache cap.
  for (let i = 0; i < 8; i++) {
    const r = await beat({
      device: "flooder",
      historyResults: [historyDelivery(`s${i}`, 100)], // 100 KiB each
    });
    assert.equal(r.status, 200, `beat ${i} should be accepted, not refused`);
  }
  const held = cacheBytes(agents["flooder"]);
  assert.ok(held <= AGENT_CACHE_HOST_MAX,
    `held ${held} bytes, over the ${AGENT_CACHE_HOST_MAX}-byte host cap`);
  // 8 x 100 KiB = 800 KiB was delivered; the cap held it near 200 KiB.
  assert.ok(held < 800 << 10);
});

test("host: the record byte gate is NOT what bounds the caches (XERK-235)", async () => {
  resetRegistry();
  // A delivery far over the per-host CACHE cap but the RECORD (caches excluded)
  // stays tiny — the beat must be accepted (200), never 413. This is the whole
  // reason the bound is eviction and not a record-ceiling refusal.
  const r = await beat({
    device: "big-history",
    historyResults: [historyDelivery("s1", 500)], // 500 KiB, > 200 KiB host cap
  });
  assert.equal(r.status, 200);
  assert.ok(agentRecordSize(agents["big-history"]) < AGENT_RECORD_MAX);
  assert.ok(cacheBytes(agents["big-history"]) <= AGENT_CACHE_HOST_MAX);
});

test("host: the freshest delivery survives eviction", async () => {
  resetRegistry();
  await beat({ device: "h", historyResults: [historyDelivery("old", 150)] });
  await beat({ device: "h", historyResults: [historyDelivery("new", 150)] });
  // 300 KiB delivered over a 200 KiB cap: the older session is evicted, the one
  // just delivered is kept — a legit re-fetch must never be the entry dropped.
  assert.ok(!("old" in (agents["h"].history || {})), "stale entry should be gone");
  assert.ok("new" in agents["h"].history, "freshest entry must survive");
});

// ---- the aggregate bound ---------------------------------------------------

test("fleet: many hosts cannot exceed the aggregate cache budget", async () => {
  resetRegistry();
  // Each host is under its own per-host cap, but together they cross the
  // fleet-wide budget — the aggregate pass evicts the globally-oldest entries.
  for (let i = 0; i < 8; i++) {
    await beat({ device: `agg-${i}`, historyResults: [historyDelivery("s", 150)] });
  }
  let total = 0;
  for (const a of Object.values(agents)) total += cacheBytes(a);
  assert.ok(total <= AGENT_CACHE_TOTAL_MAX,
    `fleet holds ${total} bytes, over the ${AGENT_CACHE_TOTAL_MAX}-byte budget`);
});

// ---- the persistence half (state.json) -------------------------------------

test("save: serializeAgentsForSave strips the on-demand caches", async () => {
  resetRegistry();
  await beat({ device: "p", historyResults: [historyDelivery("s1", 150)] });
  assert.ok(cacheBytes(agents["p"]) > 0, "precondition: the cache is populated");
  const blob = serializeAgentsForSave();
  const restored = JSON.parse(blob);
  for (const cacheKey of AGENT_CACHE_KEYS) {
    // A stripped map serializes to absent (undefined -> dropped by JSON), so the
    // key must not carry a populated object in the saved blob.
    const v = restored["p"] && restored["p"][cacheKey];
    assert.ok(v === undefined || (v && Object.keys(v).length === 0) || v === null,
      `${cacheKey} should not be persisted, got ${JSON.stringify(v)}`);
  }
  // The blob is far smaller than the live record's cache would make it.
  assert.ok(blob.length < 150 << 10);
});
