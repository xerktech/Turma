// A follower's queued heal (XERK-1837) must never trim the leader's appends. The heal
// re-seats a transcript's entries from the follower's LOCAL copy, which can be behind
// what another replica has appended to the same Postgres rows by the time it applies.
// A "replace" trims every seq >= its length, so it deleted those appends. Own process:
// it requires server.js.

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
const tmp = (name) => path.join(scratchDir(), `turma-idxheal-${name}-${process.pid}.json`);
for (const [k, n] of [["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["ORG_COLORS_FILE", "org-colors"], ["USAGE_LEDGER_FILE", "usage-ledger"], ["STATE_FILE", "state"]]) {
  process.env[k] = tmp(n);
}
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-idxheal-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-idxheal-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");

// Postgres-shaped stand-in: rows keyed by seq. seat overwrites seq 0..n-1 and trims
// nothing (PgIndexStore.seatEntries); append is ON CONFLICT DO NOTHING.
function fakeStore() {
  const rows = new Map();
  const seqsOf = (id) => rows.get(id) || (rows.set(id, new Map()), rows.get(id));
  const texts = (id) => [...seqsOf(id).entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e.text);
  return {
    texts,
    async upsertSession() {},
    async replaceEntries(id, entries) {
      const m = seqsOf(id);
      entries.forEach((e, i) => m.set(i, e));
      for (const s of [...m.keys()]) if (s >= entries.length) m.delete(s);
      return true;
    },
    async appendEntries(id, entries, startSeq) {
      const m = seqsOf(id);
      entries.forEach((e, i) => { if (!m.has(startSeq + i)) m.set(startSeq + i, e); });
    },
    async seatEntries(id, entries) {
      const m = seqsOf(id);
      entries.forEach((e, i) => m.set(i, e));
    },
    async deleteTranscript(id) { rows.delete(id); },
  };
}

test("XERK-1837: a follower's queued heal does not trim the leader's appends", async () => {
  const store = fakeStore();
  const mirror = new hub.IndexMirror(store, () => false);   // follower at queue AND apply
  const e = (t) => ({ uuid: null, role: "user", ts: null, text: t });
  await store.seatEntries("t", [e("e0"), e("e1")]);        // PG holds the file's first two lines
  mirror._running = true;                                   // hold the queue: heal queued, not applied
  mirror.sink().seat("t", [e("e0"), e("e1")]);             // the follower's heal, from its stale copy
  await store.appendEntries("t", [e("n2"), e("b3")], 2);   // another replica appends meanwhile
  mirror._running = false;
  await mirror._drain();
  assert.deepEqual(store.texts("t"), ["e0", "e1", "n2", "b3"]);
});

test.after(() => { if (hub.server && hub.server.close) hub.server.close(); });

// The call sites, not just the op: reindexHeld (the ingest heal) and the backfill must
// reach the sink as `seat`, never `replace`, or the op test above guards nothing (XERK-1837 QA D1).
test("XERK-1837: reindexHeld and the backfill mirror seat, never replace", async () => {
  const archive = require("../archive.js");
  const calls = [];
  const sink = {
    session() {}, entries() {}, repair() {}, remove() {},
    seat: (t, e) => calls.push(["seat", t, e.length]),
    replace: (t, e) => calls.push(["replace", t, e.length]),
  };
  archive.setIndexSink(sink);
  archive.setIndexMode("pg", { upsertSession() {}, appendEntries() {}, setCounts() {} });
  try {
    const e = (t) => ({ uuid: null, role: "user", ts: null, text: t });
    archive.reindexHeld("t-heal", [e("a"), e("b")]);
    assert.deepEqual(calls, [["seat", "t-heal", 2]]);
    calls.length = 0;
    const dir = path.join(process.env.ARCHIVE_DIR, "repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bf.jsonl"), JSON.stringify({ uuid: "u1", role: "user", text: "x" }) + "\n");
    fs.writeFileSync(path.join(dir, "bf.jsonl.meta"), JSON.stringify({ transcriptId: "t-bf", host: "h" }));
    archive.backfillPgIndexFromFiles();
    assert.ok(calls.some((c) => c[0] === "seat" && c[1] === "t-bf"), `backfill seated: ${JSON.stringify(calls)}`);
    assert.ok(!calls.some((c) => c[0] === "replace"), "no replace anywhere on the backfill path");
  } finally {
    archive.setIndexSink(null);
    archive.setIndexMode(null);
  }
});
