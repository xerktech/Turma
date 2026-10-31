// The HA archive index mirror's retry order (XERK-1832). A failed "replace" retried
// at the queue's tail ran after a later append and its trim deleted that append's
// rows from Postgres. Own process: it requires server.js.

"use strict";

const path = require("path");
const { mkdtemp, scratchDir } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
const tmp = (name) => path.join(scratchDir(), `turma-idxmirror-${name}-${process.pid}.json`);
for (const [k, n] of [["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"], ["AGENT_IDENTITIES_FILE", "agent-identities"], ["TENANCY_FILE", "tenancy"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["ORG_COLORS_FILE", "org-colors"], ["USAGE_LEDGER_FILE", "usage-ledger"], ["STATE_FILE", "state"]]) {
  process.env[k] = tmp(n);
}
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-idxmirror-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-idxmirror-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");

// An in-memory stand-in for PgIndexStore: replace sets the transcript to exactly its
// entries; append inserts rows from startSeq on and skips a seq already present
// (buildEntryInsert's ON CONFLICT DO NOTHING).
function fakeStore(failReplaces) {
  const rows = new Map();
  return {
    rows,
    async upsertSession() {},
    async replaceEntries(id, entries) {
      if (failReplaces-- > 0) throw new Error("transient");
      rows.set(id, entries.slice());
    },
    async appendEntries(id, entries, startSeq) {
      const cur = (rows.get(id) || []).slice();
      entries.forEach((e, i) => { if (cur[startSeq + i] === undefined) cur[startSeq + i] = e; });
      rows.set(id, cur);
    },
    async deleteTranscript(id) { rows.delete(id); },
  };
}

async function run(failReplaces) {
  const store = fakeStore(failReplaces);
  const mirror = new hub.IndexMirror(store);
  store.rows.set("t", ["o0", "o1", "o2", "o3", "o4"]);
  const sink = mirror.sink();
  sink.replace("t", ["n0", "n1", "n2"]);   // drain starts; the replace awaits
  sink.entries("t", ["a3"], 3);            // queued behind it
  while (mirror._running || mirror._q.length) await new Promise((r) => setImmediate(r));
  return store.rows.get("t");
}

test("a replace then an append lands both", async () => {
  assert.deepEqual(await run(0), ["n0", "n1", "n2", "a3"]);
});

test("a replace that fails once is retried BEFORE the later append, which survives", async () => {
  assert.deepEqual(await run(1), ["n0", "n1", "n2", "a3"]);
});

test("a replace failing every try is dropped and the queue moves on to the append", async () => {
  // The append's seq 3 already holds o3, so it is skipped, as Postgres would.
  assert.deepEqual(await run(3), ["o0", "o1", "o2", "o3", "o4"]);
});

// XERK-1836: a heal replace queued while this replica led, applied after it was deposed,
// trimmed the new leader's appends. A gated replace drops once leadership (or its term) is
// gone; the boot backfill replace is ungated, so a follower still rebuilds from files.
function gatedStore(rows) {
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  return {
    store: {
      async upsertSession() { await gate; },
      async replaceEntries(id, entries, proceed) {
        const ok = proceed || (() => true);
        for (let i = 0; i < entries.length; i++) { if (!ok()) return false; rows.set(id, rows.get(id) || []); rows.get(id)[i] = entries[i]; }
        if (!ok()) return false;
        rows.get(id).length = entries.length;
        return true;
      },
      async appendEntries(id, entries, startSeq) {
        const cur = (rows.get(id) || []).slice();
        entries.forEach((e, i) => { cur[startSeq + i] = e; });
        rows.set(id, cur);
      },
    },
    release,
  };
}

test("XERK-1836: a gated replace queued while leading is dropped once deposed", async () => {
  const rows = new Map([["t", [{ text: "o0" }, { text: "o1" }, { text: "o2" }]]]);
  const { store, release } = gatedStore(rows);
  let leader = true;
  const mirror = new hub.IndexMirror(store, () => leader, () => 1);
  const sink = mirror.sink();
  sink.session({ transcriptId: "t" });                   // blocks the drain
  sink.replace("t", [{ text: "e0" }, { text: "e1" }], true); // heal from a stale local copy
  leader = false;                                        // deposed before it runs
  await store.appendEntries("t", [{ text: "n2" }, { text: "b3" }], 2); // new leader's appends
  release();
  while (mirror._running || mirror._q.length) await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows.get("t").map((e) => e.text), ["o0", "o1", "n2", "b3"]);
});

test("XERK-1836: a heal queued by a follower still applies (not dropped)", async () => {
  const rows = new Map();
  const { store, release } = gatedStore(rows);
  const mirror = new hub.IndexMirror(store, () => false, () => 0);
  mirror.sink().replace("t", [{ text: "h0" }], true);
  release();
  while (mirror._running || mirror._q.length) await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows.get("t").map((e) => e.text), ["h0"]);
});

test("XERK-1836: an ungated replace (boot backfill) still applies on a follower", async () => {
  const rows = new Map();
  const { store, release } = gatedStore(rows);
  const mirror = new hub.IndexMirror(store, () => false, () => 0);
  mirror.sink().replace("t", [{ text: "f0" }, { text: "f1" }]);
  release();
  while (mirror._running || mirror._q.length) await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows.get("t").map((e) => e.text), ["f0", "f1"]);
});
