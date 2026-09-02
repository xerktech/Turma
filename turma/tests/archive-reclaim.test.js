// XERK-332: the index (`index.db`) must reclaim space when transcripts are
// DELETED off disk. Its own file (like archive-budget) because the reclaim floor
// is read from the environment at require() time and set tiny here so a handful
// of transcripts exercises it.
//
// The bug: nothing reaps a `sessions`/`entries_fts` row for a `.jsonl` no longer
// on disk, and openDb rebuilds only on a schema bump or an empty table — so a
// store that is repeatedly filled and wiped grew the index without bound (61x
// the ceiling after 38 cycles, a restart not helping). The fix reaps + VACUUMs
// off the store walk when far fewer files than rows remain.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

const TMP = mkdtemp("turma-archive-reclaim-");
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
process.env.ARCHIVE_DB = path.join(TMP, "archive", "index.db");
// Big ceilings — this file is about reclaiming the INDEX, not refusing ingest.
process.env.ARCHIVE_TRANSCRIPT_MAX_BYTES = "16777216";
process.env.ARCHIVE_TOTAL_MAX_BYTES = "0";           // store ceiling off
// The reclaim floor: far below a real wipe, low enough for a handful of test
// transcripts to cross it.
process.env.ARCHIVE_INDEX_RECLAIM_MIN_GAP = "4";

const archive = require("../archive.js");

const META = {
  remoteKey: "github.com/xerk/turma", repo: "turma",
  createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z",
  summary: "Session",
};

// One transcript with enough text that the index carries real bytes to reclaim.
function fill(n) {
  for (let i = 0; i < n; i++) {
    archive.ingestChunk("nas", `t${i}`, { ...META, summary: `Session ${i}` }, 0, 100,
      [{ uuid: `u${i}`, role: "user", ts: "2026-07-10T00:00:00Z", text: "word ".repeat(400) }]);
  }
}

// Delete every rendered `.jsonl` (+ sidecar) off disk — an operator wiping the
// store, which leaves every index row behind.
function wipeFiles() {
  const repo = path.join(process.env.ARCHIVE_DIR, "turma");
  for (const name of fs.readdirSync(repo)) {
    if (name.endsWith(".jsonl") || name.endsWith(".jsonl.meta")) {
      fs.rmSync(path.join(repo, name));
    }
  }
}

function rowCount() {
  return archive.listArchive({ limit: 1000 }).sessions.length;
}

// A clean fresh walk, past the min-interval so a reclaim is never rate-limited.
let clock = Date.now();
function freshWalk() {
  archive.__resetTotalCache();
  clock += 5 * 60 * 1000;
  return archive.totalArchiveBytes(clock);
}

function reset() {
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DIR, { recursive: true, force: true });
  archive.openDb();
  archive.__resetTotalCache();
}

test("a wipe's orphaned rows are reaped and the file is VACUUMed", () => {
  reset();
  fill(10);
  assert.equal(rowCount(), 10);
  freshWalk();                                   // seed the walk cache
  const before = fs.statSync(process.env.ARCHIVE_DB).size;

  wipeFiles();
  freshWalk();                                   // the walk that finds 0 files

  assert.equal(rowCount(), 0, "orphaned rows must be gone");
  assert.equal(archive.getTranscript("t3"), null, "and unreadable by id");
  assert.equal(archive.searchArchive("word").groups.length, 0, "and out of FTS");
  const after = fs.statSync(process.env.ARCHIVE_DB).size;
  assert.ok(after <= before, `index.db grew after a wipe: ${before} -> ${after}`);
});

test("a store below the floor is left alone (no churn on noise)", () => {
  reset();
  fill(3);                                        // gap of 3 < floor of 4
  wipeFiles();
  freshWalk();
  assert.equal(rowCount(), 3, "a sub-floor gap must not trigger a rebuild");
});

test("a partial delete that leaves the majority does not reclaim", () => {
  reset();
  fill(10);
  // Delete 4 of the 10: gap 4 clears the floor, but files (6) are not FAR fewer
  // than rows (10), so the reindex — whose cost this ratio bounds — must not run.
  const repo = path.join(process.env.ARCHIVE_DIR, "turma");
  const jsonls = fs.readdirSync(repo).filter((n) => n.endsWith(".jsonl")).slice(0, 4);
  for (const n of jsonls) fs.rmSync(path.join(repo, n));
  freshWalk();
  assert.equal(rowCount(), 10, "a majority-surviving store must keep its rows");
});

test("the index no longer grows across fill/wipe cycles (the ticket's scenario)", () => {
  reset();
  fill(10);
  freshWalk();
  const oneFill = fs.statSync(process.env.ARCHIVE_DB).size;
  for (let cycle = 0; cycle < 5; cycle++) {
    wipeFiles();
    freshWalk();                                 // reaps + VACUUMs
    assert.equal(rowCount(), 0);
    fill(10);
    freshWalk();
  }
  const afterCycles = fs.statSync(process.env.ARCHIVE_DB).size;
  // Pre-fix this climbed ~13 MB/cycle without bound. It must now sit near a
  // single fill, not a multiple of it.
  assert.ok(afterCycles < oneFill * 2,
    `index grew across cycles: one fill ${oneFill}, after 5 cycles ${afterCycles}`);
});

test("a bulk sync's placeholder rows are never read as a wipe", () => {
  // manifestCursors creates a `sessions` row (filePath NULL) for every inactive
  // transcript a host offers, a beat or more before its rendered chunk lands. So
  // an initial sync legitimately has many rows and few files — which must NOT
  // look like a wipe. The guard is that the trigger counts only FILED rows
  // (`filePath IS NOT NULL`); this pins it (removing that clause makes the walk
  // below reap all 50 placeholders mid-sync).
  reset();
  const manifest = [];
  for (let i = 0; i < 50; i++) manifest.push({ transcriptId: `p${i}`, repo: "turma" });
  archive.manifestCursors("nas", manifest, "");
  assert.equal(rowCount(), 50, "placeholder rows exist");
  freshWalk();                                   // 50 rows, 0 files on disk
  assert.equal(rowCount(), 50, "a bulk sync must not be reaped as a wipe");
  // And once a couple fill in, still no reap (the filled ones now have files).
  archive.ingestChunk("nas", "p0", { ...META }, 0, 100,
    [{ uuid: "x", role: "user", ts: "2026-07-10T00:00:00Z", text: "hi" }]);
  freshWalk();
  assert.equal(rowCount(), 50, "a partially-filled sync must not be reaped either");
});

test("a walk that skipped an unreadable subtree never reclaims", { skip: process.getuid && process.getuid() === 0 ? "runs as root; chmod is a no-op" : false }, () => {
  reset();
  fill(10);
  // The files are all still on disk, but a permission error hides them from the
  // walk — an under-count that must NOT be read as a wipe (that would drop live
  // rows and, since ingest appends, duplicate the conversation on re-push).
  const repo = path.join(process.env.ARCHIVE_DIR, "turma");
  fs.chmodSync(repo, 0o000);
  try {
    freshWalk();
    assert.equal(rowCount(), 10, "a partial walk must leave every row in place");
  } finally {
    fs.chmodSync(repo, 0o755);
  }
});
