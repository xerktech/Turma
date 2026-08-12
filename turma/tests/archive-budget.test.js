// Unit tests for the archive's two size ceilings (XERK-267): the per-transcript
// budget that sheds SendUserFile payloads, and the whole-store ceiling that
// stops ingest before /data fills under the hub's own state.json.
//
// Its own file, not a case in archive.test.js, because both ceilings are read
// from the environment at require() time and one of these tests needs the store
// to be FULL — which every later assertion in a shared module instance would
// then inherit. node --test gives each file its own process.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "turma-archive-budget-"));
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
process.env.ARCHIVE_DB = path.join(TMP, "archive", "index.db");
// Tiny stand-ins for the 16 MiB / 64 GiB defaults. The store ceiling is set
// above what the budget tests below write, so it engages only in the last test.
process.env.ARCHIVE_TRANSCRIPT_MAX_BYTES = "4096";
process.env.ARCHIVE_TOTAL_MAX_BYTES = "40000";

const archive = require("../archive.js");

const META = {
  remoteKey: "github.com/xerk/turma", repo: "turma", worktree: "/repos/.turma/worktrees/ab",
  slug: "-repos--turma-worktrees-ab", createdAt: "2026-07-10T00:00:00Z",
  endedTs: "2026-07-10T01:00:00Z", summary: "Screenshot Heavy",
};

// One SendUserFile delivery as the agent ships it: a tool_use block whose
// files[] carries the image inline as a base64 data: URI.
function delivery(uuid, bytes, ts) {
  return {
    uuid, role: "assistant", ts: ts || "2026-07-10T00:00:00Z", text: "",
    blocks: [{
      t: "tool_use", name: "SendUserFile",
      files: [{ name: "screen.png", kind: "image", src: "data:image/png;base64," + "A".repeat(bytes) }],
    }],
  };
}

function storedLines(transcriptId) {
  const t = archive.getTranscript(transcriptId);
  return t.entries;
}

test("under budget: a delivery keeps its inline payload", () => {
  const r = archive.ingestChunk("nas", "small", { ...META, summary: "Small" }, 0, 50,
    [delivery("s1", 200)]);
  assert.equal(r.shed, undefined);
  const f = storedLines("small")[0].blocks[0].files[0];
  assert.equal(f.kind, "image");
  assert.ok(f.src.startsWith("data:image/png;base64,"));
  assert.equal(f.shed, undefined);
});

test("crossing the budget sheds the REST of the transcript, not what came before", () => {
  // Three 2 KB deliveries: the first two fit inside the 4096-byte budget, and
  // the entry that carries it over is the last one stored whole.
  const r = archive.ingestChunk("nas", "big", { ...META }, 0, 300, [
    delivery("b1", 2000, "2026-07-10T00:00:01Z"),
    delivery("b2", 2000, "2026-07-10T00:00:02Z"),
    delivery("b3", 2000, "2026-07-10T00:00:03Z"),
  ]);
  // The reply tells the agent to stop shipping payloads for this transcript.
  assert.equal(r.shed, true);
  const files = storedLines("big").map((e) => e.blocks[0].files[0]);
  assert.equal(files[0].kind, "image");            // under budget, kept whole
  assert.ok(files[0].src.length > 2000);
  assert.equal(files[2].kind, "file");             // past it, name chip only
  assert.equal(files[2].src, undefined);
  assert.equal(files[2].html, undefined);
  assert.equal(files[2].shed, true);               // dropped for size, not missing
  assert.equal(files[2].name, "screen.png");       // ...and still identifiable
});

test("the shed is sticky across chunks — a later delta sheds from its first entry", () => {
  const r = archive.ingestChunk("nas", "big", { ...META }, 300, 400,
    [delivery("b4", 2000, "2026-07-10T00:00:04Z")]);
  assert.equal(r.shed, true);
  const files = storedLines("big").map((e) => e.blocks[0].files[0]);
  assert.equal(files[3].shed, true);
  assert.equal(files[3].src, undefined);
});

test("archiveLimits reports the over-budget transcripts for the heartbeat reply", () => {
  const lim = archive.archiveLimits(["small", "big", "never-seen"]);
  assert.deepEqual(lim.shed, ["big"]);
  assert.equal(lim.full, false);
});

test("the budget bounds the file: a runaway transcript can't outgrow it by much", () => {
  // 40 deliveries of 4 KB each — 160 KB of payload offered, which is what the
  // ticket measured blowing up to hundreds of MB at full scale.
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push(delivery(`r${i}`, 4096, "2026-07-10T00:01:00Z"));
  archive.ingestChunk("nas", "runaway", { ...META, summary: "Runaway" }, 0, 5000, entries);
  const rel = "turma/2026-07-10__runaway__nas__runaway.jsonl";
  const size = fs.statSync(path.join(process.env.ARCHIVE_DIR, rel)).size;
  // One entry may carry the overshoot; everything after it is a name chip.
  assert.ok(size < 4096 * 3, `stored ${size} bytes for 160 KB of payload`);
  // Full fidelity is NOT the promise here — the conversation is, so every
  // message survives with its file named.
  assert.equal(storedLines("runaway").length, 40);
});

test("an HTML preview sheds like an image one", () => {
  archive.ingestChunk("nas", "big", { ...META }, 400, 450, [{
    uuid: "b5", role: "assistant", ts: "2026-07-10T00:00:05Z", text: "",
    blocks: [{
      t: "tool_use", name: "SendUserFile",
      files: [{ name: "report.html", kind: "html", html: "<h1>" + "x".repeat(500) + "</h1>" }],
    }],
  }]);
  const f = storedLines("big").at(-1).blocks[0].files[0];
  assert.equal(f.kind, "file");
  assert.equal(f.html, undefined);   // the other payload key, easy to miss
  assert.equal(f.shed, true);
});

test("rebuildIndex re-derives archiveBytes from the files, so a lost DB keeps the budget", () => {
  const spend = () => {
    const r = archive.listArchive({ limit: 500 }).sessions.find((s) => s.transcriptId === "big");
    return r;
  };
  assert.ok(spend(), "big should be indexed before the rebuild");
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DB, { force: true });
  fs.rmSync(process.env.ARCHIVE_DB + "-wal", { force: true });
  fs.rmSync(process.env.ARCHIVE_DB + "-shm", { force: true });
  archive.openDb();   // rebuilds from the organized files
  // The rebuild must read the real FILE. The sidecars carry archiveBytes now,
  // but every archive written before this feature has a sidecar without it, and
  // a stale sidecar would hand a big transcript its budget back.
  const lim = archive.archiveLimits(["small", "big"]);
  assert.deepEqual(lim.shed, ["big"]);
  // Byte-exact against what's on disk, not merely "over the ceiling".
  const rel = "turma/2026-07-10__screenshot-heavy__nas__big.jsonl";
  const onDisk = fs.statSync(path.join(process.env.ARCHIVE_DIR, rel)).size;
  archive.ingestChunk("nas", "big", { ...META }, 450, 460, []);   // no-op append
  const after = fs.statSync(path.join(process.env.ARCHIVE_DIR, rel)).size;
  assert.equal(onDisk, after);
  assert.deepEqual(archive.archiveLimits(["big"]).shed, ["big"]);
});

test("a file that is merely UNREACHABLE is not treated as deleted", () => {
  // The dangerous direction. Dropping the row resets the cursor to 0, and ingest
  // APPENDS — so a false "gone" makes the re-push write a second copy of the
  // conversation into a file that was there all along. An EACCES/EIO blip, or an
  // archive mount that drops for one syscall, must change nothing.
  const rel = "turma/2026-07-10__small__nas__small.jsonl";
  const abs = path.join(process.env.ARCHIVE_DIR, rel);
  const linesBefore = fs.readFileSync(abs, "utf8").split("\n").length;

  // The whole store momentarily not at its path — every row would look deleted.
  const moved = process.env.ARCHIVE_DIR + ".away";
  fs.renameSync(process.env.ARCHIVE_DIR, moved);
  let sweptWhileGone;
  try {
    sweptWhileGone = archive.reconcileMissingFiles();
  } finally {
    fs.renameSync(moved, process.env.ARCHIVE_DIR);
  }
  assert.equal(sweptWhileGone, 0, "an unreachable store must not empty the index");

  // ...and the transcript still ingests onto its real cursor, not from 0.
  const t = archive.getTranscript("small");
  assert.ok(t, "the row must survive");
  assert.equal(fs.readFileSync(abs, "utf8").split("\n").length, linesBefore);

  // The other shape: the STORE is fine and this one file errors for a reason
  // that isn't deletion. fs.existsSync collapses every errno to false, which is
  // what made an EACCES/EIO blip read as "the operator deleted it".
  archive.ingestChunk("nas", "enotdir", { ...META, repo: "sub", summary: "Enotdir" }, 0, 60,
    [{ uuid: "e1", role: "user", ts: "2026-07-10T00:00:00Z", text: "still here" }]);
  const subdir = path.join(process.env.ARCHIVE_DIR, "sub");
  const stash = subdir + ".stash";
  fs.renameSync(subdir, stash);
  fs.writeFileSync(subdir, "not a directory");   // stat now fails ENOTDIR, not ENOENT
  let sweptOnEnotdir;
  try {
    archive.__resetReconcileClock();
    sweptOnEnotdir = archive.reconcileMissingFiles();
  } finally {
    fs.rmSync(subdir);
    fs.renameSync(stash, subdir);
  }
  assert.equal(sweptOnEnotdir, 0, "a non-ENOENT stat error is not a deletion");
  assert.ok(archive.getTranscript("enotdir"), "the row must survive an unreadable path");
});

test("deleting an archived file gives its bytes back and re-arms the transcript", () => {
  // The operator's remedy for a full store. Without this the spend is counted
  // forever against a file that no longer exists, and the next delta appends
  // onto a hole while msgCount still claims the earlier messages.
  const rel = "turma/2026-07-10__runaway__nas__runaway.jsonl";
  const abs = path.join(process.env.ARCHIVE_DIR, rel);
  const freed = fs.statSync(abs).size;
  const before = archive.listArchive({ limit: 500 }).sessions.length;
  fs.rmSync(abs);

  // The next delta for it is taken as a fresh archive from offset 0...
  const stale = archive.ingestChunk("nas", "runaway", { ...META, summary: "Runaway" }, 5000, 5100,
    [{ uuid: "r-new", role: "user", ts: "2026-07-10T00:02:00Z", text: "after the delete" }]);
  assert.equal(stale.bytesStored, 0, "the cursor must reset, not append onto a hole");
  assert.equal(archive.listArchive({ limit: 500 }).sessions.length, before - 1);
  assert.ok(freed > 0);
  // The FTS entries have to go with the row. Asserted against the FTS table
  // itself, not through searchArchive: that joins onto `sessions`, so a dropped
  // row HIDES orphaned entries rather than removing them, and the leak would sit
  // there growing the index until a rebuild.
  const probe = new DatabaseSync(process.env.ARCHIVE_DB);
  try {
    const left = probe.prepare(
      "SELECT COUNT(*) AS n FROM entries_fts WHERE transcriptId=?").get("runaway");
    assert.equal(left.n, 0, "FTS entries outlived their session row");
  } finally {
    probe.close();
  }
  assert.deepEqual(archive.searchArchive("runaway").groups, []);
});

test("a full store recovers on the HEARTBEAT path too, not only through ingest", () => {
  // The deadlock this pair of call sites exists to break: a `full` verdict stops
  // the agent pushing, so if only ingestChunk reconciled, ingest would never run
  // again to notice the operator's deletions and the store would stay full on
  // the strength of files that are gone.
  const fillDir = path.join(process.env.ARCHIVE_DIR, "turma");
  let n = 0;
  while (!archive.archiveLimits([]).full && n < 60) {
    archive.ingestChunk("nas", `heart${n}`, { ...META, summary: `Heart ${n}` }, 0, 100,
      [{ uuid: `h${n}`, role: "user", ts: "2026-07-10T00:00:00Z", text: "y".repeat(2000) }]);
    n++;
  }
  assert.ok(archive.archiveLimits([]).full, "the store ceiling never engaged");

  // Delete what we just wrote — WITHOUT going through ingest at all.
  for (const f of fs.readdirSync(fillDir)) {
    if (f.startsWith("2026-07-10__heart")) fs.rmSync(path.join(fillDir, f));
  }
  // The rate limit is the only thing between here and recovery, so reach past it
  // the way a later beat would rather than sleeping a minute in a unit test.
  archive.__resetReconcileClock();
  assert.equal(archive.archiveLimits([]).full, false,
    "deleting archives must reopen the store from the heartbeat path");

  // ...and immediately again is a no-op EVEN WITH work to do, so the sweep
  // can't run on every beat of every host: it walks every row and stats every
  // file. A throwaway of its own, so this can't delete a transcript a later
  // test is asserting on.
  archive.ingestChunk("nas", "victim", { ...META, summary: "Victim" }, 0, 30,
    [{ uuid: "v1", role: "user", ts: "2026-07-10T00:04:00Z", text: "delete me" }]);
  fs.rmSync(path.join(fillDir, "2026-07-10__victim__nas__victim.jsonl"));
  assert.equal(archive.reconcileMissingFiles(), 0, "the sweep is not rate-limited");
  archive.__resetReconcileClock();
  assert.equal(archive.reconcileMissingFiles(), 1, "...but a later beat does see it");
});

test("a full store recovers through INGEST too, without a heartbeat in between", () => {
  // The other half of the pair. An agent that never reads archiveFull (an older
  // one) only ever learns the store reopened by pushing at it, so ingest has to
  // reconcile on its own rather than leaning on archiveLimits having run.
  const fillDir = path.join(process.env.ARCHIVE_DIR, "turma");
  let n = 0;
  while (!archive.archiveLimits([]).full && n < 60) {
    archive.ingestChunk("nas", `ing${n}`, { ...META, summary: `Ing ${n}` }, 0, 100,
      [{ uuid: `i${n}`, role: "user", ts: "2026-07-10T00:00:00Z", text: "z".repeat(2000) }]);
    n++;
  }
  assert.ok(archive.archiveLimits([]).full);
  for (const f of fs.readdirSync(fillDir)) {
    if (f.startsWith("2026-07-10__ing")) fs.rmSync(path.join(fillDir, f));
  }
  archive.__resetReconcileClock();
  // Straight to ingest — no archiveLimits call to do the reconciling for it.
  const r = archive.ingestChunk("nas", "post-full", { ...META, summary: "Post Full" }, 0, 40,
    [{ uuid: "pf1", role: "user", ts: "2026-07-10T00:03:00Z", text: "stored again" }]);
  assert.equal(r.full, undefined, "ingest must reconcile before refusing");
  assert.equal(r.bytesStored, 40);
});

test("the shed accounting is in BYTES, not UTF-16 units", () => {
  // The budgets are named and spent in bytes, so a non-ASCII preview must not
  // report (or be charged) a third of what it actually cost.
  const html = "中".repeat(500) + "😀".repeat(100);
  const entry = { blocks: [{ t: "tool_use", files: [{ name: "p.html", kind: "html", html }] }] };
  assert.equal(archive.shedFilePayloads(entry), Buffer.byteLength(html));
  assert.notEqual(Buffer.byteLength(html), html.length);   // the two really differ
});

test("byteCeiling: an explicit 0 disables, a typo falls back, digits win", () => {
  // The whole point of the helper — parseInt would read "0" as unset and
  // "16MiB" as 16, the second of which sheds every payload in the store.
  assert.equal(archive.byteCeiling("0", 999), 0);
  assert.equal(archive.byteCeiling("16MiB", 999), 999);
  assert.equal(archive.byteCeiling("-5", 999), 999);
  assert.equal(archive.byteCeiling("", 999), 999);
  assert.equal(archive.byteCeiling(undefined, 999), 999);
  assert.equal(archive.byteCeiling("1048576", 999), 1048576);
});

test("archiveLimits is what the heartbeat reply is built from, present AND absent", () => {
  // server.test.js asserts the fields stay OFF the wire under the ceilings; the
  // other half — that an over-budget transcript is actually NAMED — has to be
  // asserted somewhere the ceilings are reachable.
  assert.deepEqual(archive.archiveLimits(["big"]).shed, ["big"]);
  assert.deepEqual(archive.archiveLimits(["small"]).shed, []);
  assert.deepEqual(archive.archiveLimits([]).shed, []);
});

test("a full store stops storing, and says so instead of erroring", () => {
  // Fill past the 40000-byte ceiling with ordinary prose (nothing sheddable).
  let n = 0;
  while (!archive.archiveLimits([]).full && n < 50) {
    archive.ingestChunk("nas", `fill${n}`, { ...META, summary: `Fill ${n}` }, 0, 100,
      [{ uuid: `f${n}`, role: "user", ts: "2026-07-10T00:00:00Z", text: "x".repeat(2000) }]);
    n++;
  }
  assert.ok(n < 50, "the store ceiling never engaged");

  const before = archive.getTranscript("small").entries.length;
  const r = archive.ingestChunk("nas", "small", { ...META, summary: "Small" }, 50, 90,
    [{ uuid: "s2", role: "user", ts: "2026-07-10T00:00:00Z", text: "after the ceiling" }]);
  // Reported as no forward progress (the agent's own stop condition) plus an
  // explicit flag — never a rejection it would retry forever, which is the
  // failure mode XERK-255 documented.
  assert.equal(r.bytesStored, 50);
  assert.equal(r.full, true);
  assert.equal(archive.getTranscript("small").entries.length, before);
});
