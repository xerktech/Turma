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
  const seqs = (id) => [...seqsOf(id).entries()].sort((a, b) => a[0] - b[0]).map(([s, e]) => `${s}:${e.text}`);
  return {
    texts,
    seqs,
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
    assert.equal(archive.sessionRow("t-bf2").msgCount, 3, "the row counts first copies, as the seat does");
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
  // First copies seated, and the append numbered after them: no duplicate, no hole.
  assert.deepEqual(store.seqs("t-ing"), ["0:A", "1:B", "2:C", "3:D"]);
});

// A Postgres tail past the leader's clean file (XERK-1843): rows left by pre-XERK-1450
// damage, with no repair pending. The leader's ingest re-seat must remove them, or the
// next append at the file's count hits a stale row and DO NOTHING drops it.
test("XERK-1843: the leader's ingest re-seat trims a stale Postgres tail", async () => {
  const store = fakeStore();
  const META = { remoteKey: "github.com/xerk/turma", repo: "turma", host: "nas",
    createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z", summary: "Tail" };
  const archive = require("../archive.js");
  const mirror = new hub.IndexMirror(store, () => true, () => 7);
  archive.setIndexSink(mirror.sink());
  archive.setIndexMode("pg", { upsertSession() {}, appendEntries() {}, setCounts() {} });
  try {
    const first = [e("A"), e("B")];
    const r = archive.ingestChunk("nas", "t-tail", META, 0,
      Buffer.byteLength(JSON.stringify(first)), first, "acme");
    await idle(mirror);
    await store.replaceEntries("t-tail", [e("A"), e("B"), e("A"), e("C")]); // damaged PG rows
    fs.appendFileSync(findJsonl(process.env.ARCHIVE_DIR, "t-tail"), line("C") + "\n"); // clean file A,B,C
    const next = [e("D")];
    archive.ingestChunk("nas", "t-tail", META, r.bytesStored,
      r.bytesStored + Buffer.byteLength(JSON.stringify(next)), next, "acme");
    await idle(mirror);
  } finally {
    archive.setIndexSink(null);
    archive.setIndexMode(null);
  }
  assert.deepEqual(store.seqs("t-tail"), ["0:A", "1:B", "2:C", "3:D"]);
});

// The comment-2 shape: the leader's OWN file is still raw (A,B,A,C) and so is Postgres.
// The first-copy seat (A,B,C) must trim the stale C at seq 3 so D lands there.
test("XERK-1843: a leader seat over a raw duplicated copy lets the next append land", async () => {
  const store = fakeStore();
  const META = { remoteKey: "github.com/xerk/turma", repo: "turma", host: "nas",
    createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z", summary: "Raw" };
  const archive = require("../archive.js");
  const mirror = new hub.IndexMirror(store, () => true, () => 7);
  archive.setIndexSink(mirror.sink());
  archive.setIndexMode("pg", { upsertSession() {}, appendEntries() {}, setCounts() {} });
  try {
    const first = [e("A"), e("B")];
    const r = archive.ingestChunk("nas", "t-raw", META, 0,
      Buffer.byteLength(JSON.stringify(first)), first, "acme");
    await idle(mirror);
    await store.replaceEntries("t-raw", [e("A"), e("B"), e("A"), e("C")]);
    fs.appendFileSync(findJsonl(process.env.ARCHIVE_DIR, "t-raw"), ["A", "C"].map(line).join("\n") + "\n");
    const next = [e("D")];
    archive.ingestChunk("nas", "t-raw", META, r.bytesStored,
      r.bytesStored + Buffer.byteLength(JSON.stringify(next)), next, "acme");
    await idle(mirror);
  } finally {
    archive.setIndexSink(null);
    archive.setIndexMode(null);
  }
  assert.deepEqual(store.seqs("t-raw"), ["0:A", "1:B", "2:C", "3:D"]);
});

// The trim is the leader's under the term that queued it. Deposed (or re-promoted) by
// apply time, the seat still lands but trims nothing: a new leader may have appended.
test("XERK-1843: a seat queued as leader trims nothing once the term moved", async () => {
  const store = fakeStore();
  let term = 1;
  const mirror = new hub.IndexMirror(store, () => true, () => term);
  await store.seatEntries("t-dep", [e("A"), e("B")]);
  mirror._running = true;                                   // hold the queue
  mirror.sink().seat("t-dep", [e("A"), e("B")], true);
  term = 2;                                                 // lease lost and won back
  await store.appendEntries("t-dep", [e("N")], 2);          // the other leader's append
  mirror._running = false;
  await mirror._drain();
  assert.deepEqual(store.seqs("t-dep"), ["0:A", "1:B", "2:N"]);
});

// Deposed at the SAME term (no re-promotion yet): still no trim (QA M5).
test("XERK-1843: a seat queued as leader trims nothing once deposed at the same term", async () => {
  const store = fakeStore();
  let lead = true;
  const mirror = new hub.IndexMirror(store, () => lead, () => 3);
  await store.seatEntries("t-dep2", [e("A"), e("B")]);
  mirror._running = true;
  mirror.sink().seat("t-dep2", [e("A"), e("B")], true);
  lead = false;
  await store.appendEntries("t-dep2", [e("N")], 2);
  mirror._running = false;
  await mirror._drain();
  assert.deepEqual(store.seqs("t-dep2"), ["0:A", "1:B", "2:N"]);
});

// A replace that stops part-way (deposed mid-batch) still seats every entry (QA M3).
test("XERK-1843: a trimming seat that stops part-way falls back to the full seat", async () => {
  const store = fakeStore();
  store.replaceEntries = async (id, entries) => { await store.seatEntries(id, entries.slice(0, 1)); return false; };
  const mirror = new hub.IndexMirror(store, () => true, () => 3);
  await store.appendEntries("t-part", [e("x"), e("y"), e("z"), e("TAIL")], 0);
  mirror.sink().seat("t-part", [e("A"), e("B"), e("C")], true);
  await idle(mirror);
  assert.deepEqual(store.seqs("t-part"), ["0:A", "1:B", "2:C", "3:TAIL"]);
});

// No lease (term never bumped, every replica leads) and a seat not asking for the trim
// (the backfill) both leave the tail alone (QA D1/D2).
test("XERK-1843: no trim at term 0 or without the ingest's trim flag", async () => {
  for (const [term, trim] of [[0, true], [4, false]]) {
    const store = fakeStore();
    const mirror = new hub.IndexMirror(store, () => true, () => term);
    await store.appendEntries("t-keep", [e("A"), e("B"), e("C"), e("D")], 0);
    mirror.sink().seat("t-keep", [e("A"), e("B")], trim);
    await idle(mirror);
    assert.deepEqual(store.texts("t-keep"), ["A", "B", "C", "D"], `term ${term} trim ${trim}`);
  }
});

test("XERK-1843: the leader's backfill seat never trims rows ahead of its copy", async () => {
  const store = fakeStore();
  await store.appendEntries("t-bf3", [e("A"), e("B"), e("C"), e("D")], 0); // old leader's appends
  const archive = require("../archive.js");
  const mirror = new hub.IndexMirror(store, () => true, () => 5);
  archive.setIndexSink(mirror.sink());
  archive.setIndexMode("pg", { upsertSession() {}, appendEntries() {}, setCounts() {} });
  try {
    const dir = path.join(process.env.ARCHIVE_DIR, "repo3");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bf3.jsonl"), ["A", "B"].map(line).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "bf3.jsonl.meta"), JSON.stringify({ transcriptId: "t-bf3", host: "h" }));
    archive.backfillPgIndexFromFiles();
    await idle(mirror);
  } finally {
    archive.setIndexSink(null);
    archive.setIndexMode(null);
  }
  assert.deepEqual(store.texts("t-bf3"), ["A", "B", "C", "D"]);
});
