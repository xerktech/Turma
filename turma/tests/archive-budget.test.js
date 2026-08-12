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

test("the store total is measured off the FILES, so deleting archives frees bytes", () => {
  // The whole reason the total is not an indexed column. Deleting archives is
  // the operator's remedy for a full store, and it works because the bytes are
  // actually gone — nothing has to notice a deletion, which is a thing the
  // filesystem cannot reliably be asked (an unmounted volume, a renamed parent
  // and a real delete all report ENOENT; EACCES/EIO report neither).
  const rel = "turma/2026-07-10__runaway__nas__runaway.jsonl";
  const abs = path.join(process.env.ARCHIVE_DIR, rel);
  const freed = fs.statSync(abs).size;
  assert.ok(freed > 0);

  archive.__resetTotalCache();
  const before = archive.totalArchiveBytes();
  fs.rmSync(abs);
  archive.__resetTotalCache();
  assert.equal(archive.totalArchiveBytes(), before - freed);
});

test("an unreachable store reads as empty, never as full — a wedge has no exit", () => {
  // The direction that cannot be recovered from in production: latching `full`
  // on a store that is merely unreachable stops every agent on the fleet
  // archiving, and no amount of deleting reopens it. Measuring the files means
  // "can't see it" reads as 0 bytes, so ingest recreates the directory and
  // carries on.
  const moved = process.env.ARCHIVE_DIR + ".away";
  fs.renameSync(process.env.ARCHIVE_DIR, moved);
  let whileGone;
  try {
    archive.__resetTotalCache();
    whileGone = archive.totalArchiveBytes();
  } finally {
    fs.renameSync(moved, process.env.ARCHIVE_DIR);
    archive.__resetTotalCache();
  }
  assert.equal(whileGone, 0);
});

test("a deleted archive does not disturb the cursor or the stored file", () => {
  // The counterpart. This deliberately does NOT try to detect the deletion and
  // reset the transcript: inferring "deleted" from a failed stat is what made a
  // momentarily-unreachable file drop its row, reset the cursor to 0, and — since
  // ingest APPENDS — write a SECOND copy of the conversation into a file that was
  // there all along. The append-only cursor is left exactly as it was (XERK-280).
  const rel = "turma/2026-07-10__small__nas__small.jsonl";
  const abs = path.join(process.env.ARCHIVE_DIR, rel);
  const before = fs.readFileSync(abs, "utf8");

  const moved = process.env.ARCHIVE_DIR + ".away";
  fs.renameSync(process.env.ARCHIVE_DIR, moved);
  fs.renameSync(moved, process.env.ARCHIVE_DIR);
  archive.__resetTotalCache();

  assert.ok(archive.getTranscript("small"), "the row must survive an unreachable moment");
  assert.equal(fs.readFileSync(abs, "utf8"), before, "and the file must be untouched");
});

test("a full store stays refusable and recovers by deletion, on both paths", () => {
  const fillDir = path.join(process.env.ARCHIVE_DIR, "turma");
  let n = 0;
  archive.__resetTotalCache();
  while (!archive.archiveLimits([]).full && n < 60) {
    archive.ingestChunk("nas", `heart${n}`, { ...META, summary: `Heart ${n}` }, 0, 100,
      [{ uuid: `h${n}`, role: "user", ts: "2026-07-10T00:00:00Z", text: "y".repeat(2000) }]);
    archive.__resetTotalCache();
    n++;
  }
  assert.ok(archive.archiveLimits([]).full, "the store ceiling never engaged");
  // Ingest refuses without erroring — the agent reads it as no progress.
  const refused = archive.ingestChunk("nas", "blocked", { ...META, summary: "Blocked" }, 0, 40,
    [{ uuid: "bl1", role: "user", ts: "2026-07-10T00:05:00Z", text: "nope" }]);
  assert.equal(refused.full, true);
  assert.equal(refused.bytesStored, 0);

  // Delete, WITHOUT going through ingest: the heartbeat path must reopen too,
  // since a `full` verdict is exactly what stops the agent pushing at all.
  for (const f of fs.readdirSync(fillDir)) {
    if (f.startsWith("2026-07-10__heart")) fs.rmSync(path.join(fillDir, f));
  }
  archive.__resetTotalCache();
  assert.equal(archive.archiveLimits([]).full, false,
    "deleting archives must reopen the store on the heartbeat path");
  const after = archive.ingestChunk("nas", "unblocked", { ...META, summary: "Unblocked" }, 0, 40,
    [{ uuid: "ub1", role: "user", ts: "2026-07-10T00:06:00Z", text: "stored again" }]);
  assert.equal(after.full, undefined);
  assert.equal(after.bytesStored, 40);
});

test("the ceiling engages AT the limit, not one byte past it", () => {
  // Seeded rather than filled: landing the store on exactly ARCHIVE_TOTAL_MAX
  // by writing files is not something a test can do reliably, and `>` in place
  // of `>=` is otherwise invisible.
  const max = Number(process.env.ARCHIVE_TOTAL_MAX_BYTES);
  archive.__resetTotalCache(max - 1);
  assert.equal(archive.archiveLimits([]).full, false);
  archive.__resetTotalCache(max);
  assert.equal(archive.archiveLimits([]).full, true);
  archive.__resetTotalCache();
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
  // The two parsers read the SAME env var, so they must trim the same set.
  // String.trim() strips U+FEFF and str.strip() doesn't; str.strip() strips
  // U+0085 and U+001C-1F and String.trim() doesn't. A BOM in front of the value
  // is an ordinary copy-paste accident, and under either default one side got a
  // 16-BYTE ceiling while the other read 16 MiB. Both must reject both classes;
  // the agent asserts the mirror of this in test_byte_ceiling_agrees_with_the_hub.
  for (const odd of ["﻿16", "16", "16", " 16", "16﻿"]) {
    assert.equal(archive.byteCeiling(odd, 999), 999, JSON.stringify(odd));
  }
  assert.equal(archive.byteCeiling(" \t\n16\r\n ", 999), 16);   // ASCII space still trims
});

test("the store total is cached, and the cache does expire", () => {
  // It runs on the heartbeat path and walks every file, so it must not be paid
  // per beat — and must not be permanent either, or a deletion never registers.
  archive.__resetTotalCache();
  const t0 = Date.now();
  const first = archive.totalArchiveBytes(t0);
  fs.writeFileSync(path.join(process.env.ARCHIVE_DIR, "turma", "cache-probe.jsonl"), "x".repeat(500));
  assert.equal(archive.totalArchiveBytes(t0 + 1000), first, "not cached");
  assert.equal(archive.totalArchiveBytes(t0 + 61_000), first + 500, "cache never expires");
  fs.rmSync(path.join(process.env.ARCHIVE_DIR, "turma", "cache-probe.jsonl"));
  archive.__resetTotalCache();
});

test("archiveLimits is what the heartbeat reply is built from, present AND absent", () => {
  // server.test.js asserts the fields stay OFF the wire under the ceilings; the
  // other half — that an over-budget transcript is actually NAMED — has to be
  // asserted somewhere the ceilings are reachable.
  assert.deepEqual(archive.archiveLimits(["big"]).shed, ["big"]);
  assert.deepEqual(archive.archiveLimits(["small"]).shed, []);
  assert.deepEqual(archive.archiveLimits([]).shed, []);
});

test("a refusal preserves the transcript's real cursor, so the agent realigns", () => {
  // The refusal must hand back what we actually hold for THAT transcript, not a
  // zero: the agent's stop condition is "no forward progress", and a bogus
  // cursor would make it re-push from the wrong offset once the store reopens.
  const before = archive.getTranscript("small").entries.length;
  const have = 50;   // where the first test in this file left "small"
  archive.__resetTotalCache(Number(process.env.ARCHIVE_TOTAL_MAX_BYTES));
  const r = archive.ingestChunk("nas", "small", { ...META, summary: "Small" }, have, have + 40,
    [{ uuid: "s2", role: "user", ts: "2026-07-10T00:00:00Z", text: "after the ceiling" }]);
  archive.__resetTotalCache();
  // Never a rejection it would retry forever, which is the failure mode
  // XERK-255 documented.
  assert.equal(r.bytesStored, have);
  assert.equal(r.full, true);
  assert.equal(archive.getTranscript("small").entries.length, before);
});
