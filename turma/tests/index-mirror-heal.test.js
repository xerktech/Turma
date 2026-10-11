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

// A seat from a stale PRE-REPAIR copy (XERK-1838): Postgres already holds the
// duplicate repair's rows, and the seat must not put the repeated lines back. It is
// sent as the copy's first-copy lines — a prefix of the repaired rows — so the
// next append still lands at its own seq.
const line = (t) => JSON.stringify({ uuid: `u-${t}`, role: "user", ts: "2026-07-10T00:00:00Z", text: t });
function findJsonl(dir, id) {
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    if (!String(f).endsWith(".jsonl.meta")) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (meta.transcriptId === id) return path.join(dir, String(f).slice(0, -".meta".length));
  }
  return null;
}
async function withPgSink(store, fn) {
  const archive = require("../archive.js");
  const mirror = new hub.IndexMirror(store, () => false);
  archive.setIndexSink(mirror.sink());
  archive.setIndexMode("pg", { upsertSession() {}, appendEntries() {}, setCounts() {} });
  try { await fn(archive, mirror); } finally {
    archive.setIndexSink(null);
    archive.setIndexMode(null);
  }
}
const e = (t) => ({ uuid: `u-${t}`, role: "user", ts: "2026-07-10T00:00:00Z", text: t });
// `_drain()` returns at once while a drain the sink started is still running.
async function idle(mirror) {
  const end = Date.now() + 2000;
  while (!mirror.idle()) {
    if (Date.now() > end) throw new Error("mirror never settled");
    await new Promise((r) => setTimeout(r, 1));
  }
}

test("XERK-1838: the backfill's seat from a pre-repair copy re-adds no duplicates", async () => {
  const store = fakeStore();
  await store.replaceEntries("t-bf2", [e("A"), e("B"), e("C")]);   // the leader's repair landed
  await withPgSink(store, async (archive, mirror) => {
    const dir = path.join(process.env.ARCHIVE_DIR, "repo2");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bf2.jsonl"), ["A", "B", "A", "C"].map(line).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "bf2.jsonl.meta"), JSON.stringify({ transcriptId: "t-bf2", host: "h" }));
    archive.backfillPgIndexFromFiles();
    await idle(mirror);
  });
  assert.deepEqual(store.texts("t-bf2"), ["A", "B", "C"]);
  await store.appendEntries("t-bf2", [e("N")], 3);                 // the next append lands
  assert.deepEqual(store.texts("t-bf2"), ["A", "B", "C", "N"]);
});

test("XERK-1838: the ingest re-seat from a pre-repair copy re-adds no duplicates", async () => {
  const store = fakeStore();
  const META = { remoteKey: "github.com/xerk/turma", repo: "turma", host: "nas",
    createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z", summary: "Heal" };
  await withPgSink(store, async (archive, mirror) => {
    const first = [e("A"), e("B")];
    const len = Buffer.byteLength(JSON.stringify(first));
    const r = archive.ingestChunk("nas", "t-ing", META, 0, len, first, "acme");
    await idle(mirror);
    await store.replaceEntries("t-ing", [e("A"), e("B"), e("C")]); // repaired rows in PG
    // This replica's copy is larger than its row and still holds a repeated line.
    const jsonl = findJsonl(process.env.ARCHIVE_DIR, "t-ing");
    fs.appendFileSync(jsonl, ["A", "C"].map(line).join("\n") + "\n");
    const next = [e("D")];
    archive.ingestChunk("nas", "t-ing", META, r.bytesStored,
      r.bytesStored + Buffer.byteLength(JSON.stringify(next)), next, "acme");
    await idle(mirror);
  });
  const texts = store.texts("t-ing");
  assert.deepEqual(texts.slice(0, 3), ["A", "B", "C"], `seat wrote first copies only: ${texts}`);
  assert.equal(texts.filter((t) => t === "A").length, 1, `no duplicate A: ${texts}`);
});
