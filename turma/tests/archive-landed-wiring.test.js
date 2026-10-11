// The HA archive mirror as server.js WIRES it (XERK-1050). Its `onLanded` must
// reconcile a late-landed file's cursor before the transcript reopens; a no-op
// there passed every unit and lost a chunk on a live HA hub (XERK-1050 QA D3).
// Also pins the /metrics body and its cache. Own process: it requires server.js.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp, scratchDir } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
const tmp = (name) => path.join(scratchDir(), `turma-landed-${name}-${process.pid}.json`);
for (const [k, n] of [["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["ORG_COLORS_FILE", "org-colors"], ["USAGE_LEDGER_FILE", "usage-ledger"], ["STATE_FILE", "state"]]) {
  process.env[k] = tmp(n);
}
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-landed-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-landed-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const archive = require("../archive.js");

test("the wired onLanded reconciles, and a reconcile failure keeps the key blocked", async () => {
  const store = { async list() { return []; }, async put() {}, async stat() { return null; },
    async getToFile(k, dest) { fs.writeFileSync(dest, "x\n"); return true; } };
  hub.setArchiveMirror(store, true);
  const mirror = hub.getArchiveMirror();
  const calls = [];
  const real = archive.reconcileLanded;
  archive.reconcileLanded = (...a) => { calls.push(a); };
  try {
    mirror._blocked.set("repo/t.jsonl", "x");
    await mirror.retryBlocked();
    assert.equal(calls.length, 1, "retryBlocked's onLanded reached archive.reconcileLanded");
    assert.equal(mirror.blockedCount(), 0);
    archive.reconcileLanded = () => { throw new Error("an index hydrate is running"); };
    mirror._blocked.set("repo/t.jsonl", "x");
    await mirror.retryBlocked();
    assert.equal(mirror.blockedCount(), 1, "not reconciled, so not reopened");
  } finally {
    archive.reconcileLanded = real;
    hub.setArchiveMirror(null, false);
    archive.setBlobSink(null);
    archive.setRawRemote(null);
  }
});

test("/metrics reports the gauges and recomputes the blocked count at most every 15s", () => {
  const store = { async list() { return []; }, async put() {}, async stat() { return null; },
    async getToFile(k, dest) { fs.writeFileSync(dest, "x\n"); return true; } };
  hub.setArchiveMirror(store, true);
  try {
    const mirror = hub.getArchiveMirror();
    const t0 = 1e12;
    assert.match(hub.metricsText(t0), /^turma_archive_hydrate_incomplete 0$/m);
    assert.match(hub.metricsText(t0), /^turma_archive_ingest_gated 0$/m);
    mirror._blocked.set("repo/a.jsonl", "x");
    mirror._blocked.set("repo/a.jsonl.meta", "x"); // one transcript, not two
    assert.match(hub.metricsText(t0 + 1000), /^turma_archive_hydrate_incomplete 0$/m); // cached
    assert.match(hub.metricsText(t0 + 15000), /^turma_archive_hydrate_incomplete 1$/m);
    assert.match(hub.metricsText(t0 + 15000), /^turma_archive_ingest_gated_seconds 0$/m);
    archive.setHydrating(true);
    const closedAt = Date.now();
    assert.match(hub.metricsText(t0 + 15001), /^turma_archive_ingest_gated 1$/m);
    assert.match(hub.metricsText(closedAt + 90500), /^turma_archive_ingest_gated_seconds (90|91)$/m);
    archive.setHydrating(false);
    assert.match(hub.metricsText(closedAt + 90500), /^turma_archive_ingest_gated_seconds 0$/m);
  } finally {
    hub.setArchiveMirror(null, false);
    archive.setBlobSink(null);
    archive.setRawRemote(null);
  }
});

test("re-closing the gate keeps its first closed-since stamp (XERK-1282)", async () => {
  archive.setHydrating(true);
  try {
    await new Promise((r) => setTimeout(r, 40));
    archive.setHydrating(true); // a later phase re-asserting it
    assert.ok(archive.hydratingForMs() >= 35, `${archive.hydratingForMs()}ms`);
  } finally {
    archive.setHydrating(false);
  }
  assert.equal(archive.hydratingForMs(), 0);
});

test("a hung index hydrate is abandoned at its deadline and its loader cut (XERK-1282)", async () => {
  const wrote = [];
  let late;
  const load = (l) => { l.reset(); late = l; return new Promise(() => {}); }; // never settles
  await assert.rejects(
    hub.withLoaderDeadline(load, { reset() { wrote.push("reset"); }, sessions(r) { wrote.push(r); } },
      "the Postgres sessions hydrate", 20),
    /the Postgres sessions hydrate did not finish within 0s and was abandoned/);
  late.sessions(["stale"]); // the hung await returns after all: nothing lands
  assert.deepEqual(wrote, ["reset"]);
  // A load that finishes in time passes through untouched.
  assert.equal(await hub.withLoaderDeadline(async (l) => { l.sessions([1]); return 7; },
    { sessions(r) { wrote.push(r); } }, "x", 1000), 7);
  assert.deepEqual(wrote, ["reset", [1]]);
});

test("timer env knobs clamp to setTimeout's 2^31-1 ceiling (XERK-1523)", () => {
  process.env.XERK1523_TIMER = String(2 ** 31 + 5);
  try {
    assert.equal(hub.timerEnv("XERK1523_TIMER", 1000), 2147483647);
    process.env.XERK1523_TIMER = "60000";
    assert.equal(hub.timerEnv("XERK1523_TIMER", 1000), 60000);
  } finally {
    delete process.env.XERK1523_TIMER;
  }
  assert.equal(hub.timerEnv("XERK1523_TIMER", 1000), 1000);
});

// The two knobs themselves, resolved at module load: a fresh hub booted with both set
// past the ceiling must come up clamped, or inlining positiveEnv at either reopens it.
test("the hydrate deadline and watch knobs boot clamped (XERK-1523)", () => {
  const { execFileSync } = require("child_process");
  const boot = (deadline, watch) => JSON.parse(execFileSync(process.execPath, ["-e",
    "const h = require(process.argv[1]); process.stdout.write(JSON.stringify(" +
    "[h.ARCHIVE_INDEX_HYDRATE_DEADLINE_MS, h.ARCHIVE_HYDRATE_WATCH_MS])); process.exit(0);",
    path.join(__dirname, "..", "server.js")],
  { env: { ...process.env, ARCHIVE_INDEX_HYDRATE_DEADLINE_MS: String(deadline),
    ARCHIVE_HYDRATE_WATCH_MS: String(watch) }, encoding: "utf8" }));
  // One knob past the ceiling at a time, so each is also pinned to its OWN env var.
  assert.deepEqual(boot(2 ** 32, 60000), [2147483647, 60000]);
  assert.deepEqual(boot(60000, 2 ** 33), [60000, 2147483647]);
});

// One whole hydrate run, spying on the ingest gate. With an index hydrate to follow,
// the byte phase must never open the gate, or its closed-since stamp resets at the
// phase boundary while ingest stays closed (XERK-1282/1523).
async function gateCallsOfHydrate(indexStore) {
  const store = { async list() { return []; }, async put() {}, async stat() { return null; },
    async getToFile() { return false; } };
  const calls = [];
  const real = { setHydrating: archive.setHydrating, isPgMode: archive.isPgMode,
    backfill: archive.backfillPgIndexFromFiles, reconcile: archive.reconcileHydratedCursors };
  archive.setHydrating = (v) => { calls.push(v); real.setHydrating(v); };
  archive.isPgMode = () => true;
  archive.backfillPgIndexFromFiles = () => {};
  archive.reconcileHydratedCursors = () => {};
  hub.setArchiveIndexStore(indexStore);
  hub.setArchiveMirror(store, true);
  try {
    await hub.hydrateArchiveOnce();
  } finally {
    Object.assign(archive, { setHydrating: real.setHydrating, isPgMode: real.isPgMode,
      backfillPgIndexFromFiles: real.backfill, reconcileHydratedCursors: real.reconcile });
    hub.setArchiveIndexStore(null);
    hub.setArchiveMirror(null, false);
    archive.setBlobSink(null);
    archive.setRawRemote(null);
  }
  assert.equal(archive.isHydrating(), false, "the run ends with ingest open");
  return calls;
}

test("a hydrate with an index phase keeps the gate closed across the boundary (XERK-1523)", async () => {
  let hydrated = 0;
  const calls = await gateCallsOfHydrate({ async hydrateSessionsInto() { hydrated++; } });
  assert.equal(hydrated, 1);
  assert.deepEqual(calls, [true, true, false], "opened once, at the very end");
});

test("a byte-only hydrate opens the gate when the byte phase ends (XERK-1523)", async () => {
  assert.deepEqual(await gateCallsOfHydrate(null), [true, false]);
});

// A transcript whose file holds its lines twice (XERK-1364 damage) — the XERK-1450 seed.
function seedDuplicated(id) {
  archive.ingestChunk("nas", id, { repo: "qa", summary: id, endedTs: "2026-07-10T00:00:00Z" }, 0, 10,
    [{ uuid: "a", role: "user", ts: "t", text: "one" }, { uuid: "b", role: "assistant", ts: "t", text: "two" }]);
  const jsonl = archive.__walkJsonl().find((p) => p.includes(id));
  const once = fs.readFileSync(jsonl, "utf8");
  fs.appendFileSync(jsonl, once);
  return { jsonl, once };
}

test("XERK-1450: the hydrate de-dups local copies BEFORE it lists the bucket, then publishes", async () => {
  const { jsonl, once } = seedDuplicated("t-hyd");
  const atList = [];
  const store = { async list() { atList.push(fs.readFileSync(jsonl, "utf8")); return []; },
    async put() {}, async stat() { return null; }, async getToFile() { return true; } };
  hub.setArchiveMirror(store, true);
  try {
    await hub.hydrateArchive();
    assert.deepEqual(atList, [once], "the size compare saw the de-duplicated copy");
    const meta = JSON.parse(fs.readFileSync(jsonl + ".meta", "utf8"));
    assert.equal(meta.dedupPending, undefined, "the leader pass re-seated the index");
    assert.equal(archive.sessionRow("t-hyd").msgCount, 2);
  } finally {
    hub.setArchiveMirror(null, false);
    archive.setBlobSink(null);
    archive.setRawRemote(null);
    archive.setRenderedGate(null);
  }
});

test("XERK-1450: a late-landed file is repaired by the wired onLanded", async () => {
  const { jsonl, once } = seedDuplicated("t-land");
  const store = { async list() { return []; }, async put() {}, async stat() { return null; },
    async getToFile(k, dest) { fs.writeFileSync(dest, "x\n"); return true; } };
  hub.setArchiveMirror(store, true);
  try {
    const mirror = hub.getArchiveMirror();
    // The landed file itself: still blocked while onLanded runs, so the repair waits a tick.
    mirror._blocked.set(mirror.keyFor(jsonl), "x");
    const realGet = store.getToFile;
    store.getToFile = async (k, dest) => { fs.copyFileSync(jsonl, dest); return true; };
    await mirror.retryBlocked();
    await new Promise((r) => setImmediate(r));
    assert.equal(mirror.blockedCount(), 0);
    assert.equal(fs.readFileSync(jsonl, "utf8"), once);
    store.getToFile = realGet;
  } finally {
    hub.setArchiveMirror(null, false);
    archive.setBlobSink(null);
    archive.setRawRemote(null);
    archive.setRenderedGate(null);
  }
});

test("XERK-1450: IndexMirror applies a repair as replace + exact counts, acks it, never re-queues it", async () => {
  const calls = [];
  let fail = false;
  let failed = 0;
  const store = {
    async replaceEntries(t, e) { if (fail) { failed += 1; throw new Error("pg down"); } calls.push(["replace", t, e.length]); },
    async setCounts(t, n, b) { calls.push(["counts", t, n, b]); },
  };
  const m = new hub.IndexMirror(store);
  let acked = 0;
  m.sink().repair("t1", [{ text: "a" }, { text: "b" }], 2, 99, () => { acked += 1; });
  await m._drain();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["replace", "t1", 2], ["counts", "t1", 2, 99]]);
  assert.equal(acked, 1);
  fail = true;
  calls.length = 0;
  m.sink().repair("t2", [], 0, 0, () => { acked += 1; });
  await new Promise((r) => setImmediate(r));
  await m._drain();
  assert.deepEqual(calls, []);
  assert.equal(m._q.length, 0, "a failed repair is dropped, left pending for the next pass");
  assert.equal(failed, 1, "tried once, never re-queued behind newer ops");
  assert.equal(acked, 1);
});

test.after(() => { if (hub.server && hub.server.close) hub.server.close(); });
