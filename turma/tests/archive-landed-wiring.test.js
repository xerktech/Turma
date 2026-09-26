// The HA archive mirror as server.js WIRES it (XERK-1050). Its `onLanded` must
// reconcile a late-landed file's cursor before the transcript reopens; a no-op
// there passed every unit and lost a chunk on a live HA hub (XERK-1050 QA D3).
// Also pins the /metrics body and its cache. Own process: it requires server.js.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
const tmp = (name) => path.join(os.tmpdir(), `turma-landed-${name}-${process.pid}.json`);
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
    archive.setHydrating(true);
    assert.match(hub.metricsText(t0 + 15001), /^turma_archive_ingest_gated 1$/m);
    archive.setHydrating(false);
  } finally {
    hub.setArchiveMirror(null, false);
    archive.setBlobSink(null);
    archive.setRawRemote(null);
  }
});

test.after(() => { if (hub.server && hub.server.close) hub.server.close(); });
