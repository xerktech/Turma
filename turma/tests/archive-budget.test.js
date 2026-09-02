// Unit tests for the archive's two size ceilings (XERK-267): the per-transcript
// budget that sheds SendUserFile payloads, and the whole-store ceiling that
// stops ingest before /data fills under the hub's own state.json.
//
// Its own file, not a case in archive.test.js, because both ceilings are read
// from the environment at require() time and one of these tests needs the store
// to be FULL — which every later assertion in a shared module instance would
// then inherit. node --test gives each file its own process.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const TMP = mkdtemp("turma-archive-budget-");
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
// INSIDE ARCHIVE_DIR, matching the production default — the ceiling must be
// exercised in the layout it actually runs in. It works with these small
// ceilings precisely because the index is NOT counted against them.
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
  // Establish a REAL non-zero baseline first — otherwise "kept the previous
  // total" and "measured zero" are the same number and the test proves nothing.
  archive.__resetTotalCache();
  const baseline = archive.totalArchiveBytes();
  assert.ok(baseline > 0);

  const moved = process.env.ARCHIVE_DIR + ".away";
  fs.renameSync(process.env.ARCHIVE_DIR, moved);
  let whileGone;
  try {
    archive.__resetTotalCache(baseline);          // as if a walk had just seen it
    whileGone = archive.totalArchiveBytes(Date.now() + 6 * 60_000);
  } finally {
    fs.renameSync(moved, process.env.ARCHIVE_DIR);
    archive.__resetTotalCache();
  }
  assert.equal(whileGone, 0, "a removed store must read as empty, not as its last total");
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
  assert.equal(archive.byteCeiling(" \t\n\r\f\v16 \t\n\r\f\v", 999), 16);  // the exact ASCII set, both sides
});

test("bytes written inside the cache window still count against the ceiling", () => {
  // The cache is a baseline, not the total. Frozen alone it left ingest
  // unmetered between refreshes — measured 4.85 GiB written past a 4 MiB
  // ceiling in one window — so overshoot must stay bounded by one chunk even
  // though no walk happens in between.
  archive.__resetTotalCache();
  const t0 = Date.now();
  const base = archive.totalArchiveBytes(t0);
  const max = Number(process.env.ARCHIVE_TOTAL_MAX_BYTES);
  assert.ok(base < max);

  // Fill past the ceiling WITHOUT ever letting the cache expire.
  let n = 0;
  while (archive.totalArchiveBytes(t0 + 1000) < max && n < 80) {
    archive.ingestChunk("nas", `burst${n}`, { ...META, summary: `Burst ${n}` }, 0, 100,
      [{ uuid: `bu${n}`, role: "user", ts: "2026-07-10T00:07:00Z", text: "w".repeat(2000) }]);
    n++;
  }
  assert.ok(n < 80, "the total never moved inside the cache window");
  // Overshoot is one chunk's worth, not a window's worth.
  assert.ok(archive.totalArchiveBytes(t0 + 1000) < max + 4096,
    `overshot by ${archive.totalArchiveBytes(t0 + 1000) - max} bytes`);
  // ...and the refusal follows immediately, on the same frozen cache.
  const r = archive.ingestChunk("nas", "past-it", { ...META, summary: "Past It" }, 0, 40,
    [{ uuid: "pi1", role: "user", ts: "2026-07-10T00:07:30Z", text: "no" }]);
  assert.equal(r.full, true);

  for (const f of fs.readdirSync(path.join(process.env.ARCHIVE_DIR, "turma"))) {
    if (f.startsWith("2026-07-10__burst")) {
      fs.rmSync(path.join(process.env.ARCHIVE_DIR, "turma", f));
    }
  }
  archive.__resetTotalCache();
});

test("ONE transcript pushed as many deltas is metered too", () => {
  // The production shape, and the one the other ceiling tests miss: a long
  // session arrives as many deltas against the SAME transcriptId. A charge that
  // only fires for a first-sight transcript passes every per-chunk test in this
  // file and still writes tens of MB past the ceiling.
  archive.__resetTotalCache();
  const t0 = Date.now();
  const max = Number(process.env.ARCHIVE_TOTAL_MAX_BYTES);
  let off = 0, n = 0, refused = null;
  while (n < 200) {
    const r = archive.ingestChunk("nas", "onestream", { ...META, summary: "One Stream" },
      off, off + 100,
      [{ uuid: `os${n}`, role: "user", ts: "2026-07-10T00:09:00Z", text: "s".repeat(2000) }]);
    if (r.full) { refused = r; break; }
    off += 100;
    n++;
    // Never let the cache expire — the charge alone must stop this.
    assert.ok(archive.totalArchiveBytes(t0 + 1000) < max + 8192,
      `ran ${archive.totalArchiveBytes(t0 + 1000) - max} bytes past the ceiling on delta ${n}`);
  }
  assert.ok(refused, "a single-transcript stream was never refused");

  for (const f of fs.readdirSync(path.join(process.env.ARCHIVE_DIR, "turma"))) {
    if (f.includes("one-stream")) fs.rmSync(path.join(process.env.ARCHIVE_DIR, "turma", f));
  }
  archive.__resetTotalCache();
});

test("the charge equals the bytes actually written, for every entry shape", () => {
  // Pins the accounting itself rather than its consequences: charging UTF-16
  // units, charging twice, charging the cumulative total, or charging before the
  // append instead of after all survive a coarser assertion, and each is a
  // production-visible error (a CJK session reached 3x the ceiling).
  const t0 = Date.now();
  const cases = [
    ["ascii", "plain prose"],
    ["cjk", "中文".repeat(200)],
    ["emoji", "😀".repeat(150)],
    ["mixed", "a中😀".repeat(100)],
    ["big", "x".repeat(5000)],
  ];
  let off = 0;
  for (const [name, text] of cases) {
    archive.__resetTotalCache();
    const before = archive.totalArchiveBytes(t0);
    // .jsonl only: the charge covers the APPEND. The .meta sidecar beside it is
    // rewritten in place rather than grown, so its contribution is bounded by
    // the transcript count and is absorbed by the next walk.
    const rel = path.join(process.env.ARCHIVE_DIR, "turma");
    const sizeOf = () => fs.readdirSync(rel).reduce(
      (n, f) => n + (f.endsWith(".jsonl") ? fs.statSync(path.join(rel, f)).size : 0), 0);
    const diskBefore = sizeOf();
    archive.ingestChunk("nas", "charge", { ...META, summary: "Charge" }, off, off + 100,
      [{ uuid: `c${name}${off}`, role: "user", ts: "2026-07-10T00:10:00Z", text }]);
    off += 100;
    // Read through the CACHE (no walk), so this is the charge talking.
    const charged = archive.totalArchiveBytes(t0 + 1000) - before;
    assert.equal(charged, sizeOf() - diskBefore, `${name}: charged != written`);
  }
  archive.__resetTotalCache();
});

test("an append that throws charges nothing", () => {
  // The charge has to sit AFTER the write. Before it, a failed append still
  // spends ceiling on bytes that never reached the disk.
  archive.__resetTotalCache();
  const t0 = Date.now();
  const before = archive.totalArchiveBytes(t0);
  // Make the target path a directory so appendFileSync throws EISDIR.
  const rel = "turma/2026-07-10__eisdir__nas__eisdir.jsonl";
  fs.mkdirSync(path.join(process.env.ARCHIVE_DIR, rel), { recursive: true });
  try {
    assert.throws(() => archive.ingestChunk("nas", "eisdir", { ...META, summary: "Eisdir" },
      0, 60, [{ uuid: "ed1", role: "user", ts: "2026-07-10T00:12:00Z", text: "y".repeat(400) }]));
  } finally {
    fs.rmSync(path.join(process.env.ARCHIVE_DIR, rel), { recursive: true, force: true });
  }
  assert.equal(archive.totalArchiveBytes(t0 + 1000), before, "charged for a write that failed");
  archive.__resetTotalCache();
});

test("a full store re-measures on the SHORT cadence, so freeing space is noticed in seconds", () => {
  // Recovery latency is what this buys. Without it an operator who has just
  // deleted archives waits out the whole 5-minute window with nothing saying
  // why, and TOTAL_CACHE_MS cannot be shortened without paying the walk on
  // every beat of every host.
  const max = Number(process.env.ARCHIVE_TOTAL_MAX_BYTES);
  const t0 = Date.now();
  archive.__resetTotalCache(max + 1000);            // as if the last walk found it full
  assert.ok(archive.totalForCeiling(t0) >= max, "should read full");
  // 40s later: past FULL_RECHECK_MS, far short of TOTAL_CACHE_MS. The real
  // store is under the ceiling, so a re-measure must see that.
  const seen = archive.totalForCeiling(t0 + 40_000);
  assert.ok(seen < max, `still ${seen} after a re-check window`);
  // ...while a store that is NOT full is left on the long cadence.
  archive.__resetTotalCache(1);
  assert.equal(archive.totalForCeiling(t0 + 40_000), 1, "re-walked a store that wasn't full");
  archive.__resetTotalCache();
});

test("a walk that FAILS keeps the last baseline, so blips can't hand out fresh ceilings", (t) => {
  // fs errors that are not ENOENT mean "couldn't look", not "nothing there".
  // Recording one as a measurement re-baselines to zero and zeroes the charge,
  // so every blip grants another whole ceiling — measured amplifying to 6.2x
  // over five blips, silently, with the store reading full throughout.
  archive.__resetTotalCache();
  const t0 = Date.now();
  const real = archive.totalArchiveBytes(t0);
  assert.ok(real > 0);

  const realReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (p, ...rest) => {
    if (String(p) === process.env.ARCHIVE_DIR) {
      const e = new Error("EMFILE: too many open files");
      e.code = "EMFILE";
      throw e;
    }
    return realReaddir(p, ...rest);
  });
  // Force a walk; it fails, and must hand back the previous baseline.
  const duringBlip = archive.totalArchiveBytes(t0 + 6 * 60_000);
  assert.equal(duringBlip, real, "a failed walk was recorded as a measurement");
  // ...and a write during the blip still accrues on top of it, rather than
  // starting again from zero.
  archive.ingestChunk("nas", "blip", { ...META, summary: "Blip" }, 0, 60,
    [{ uuid: "bl1", role: "user", ts: "2026-07-10T00:11:00Z", text: "z".repeat(400) }]);
  assert.ok(archive.totalArchiveBytes(t0 + 6 * 60_000) > real,
    "the blip reset the charge");
  t.mock.restoreAll();
  archive.__resetTotalCache();
});

test("an unreadable SUBDIRECTORY costs its subtree, never the whole store", (t) => {
  // The asymmetry, deliberately: letting a nested error propagate froze the
  // baseline forever, so no deletion was ever seen again and the store latched
  // full with no exit. One root-owned or over-long directory is enough. Losing
  // that subtree is an under-measure, which the ceiling errs toward anyway.
  //
  // A SECOND repo folder holds the unreadable part, so the expected answer is a
  // specific non-zero number: "everything except that subtree". Asserting only
  // "less than the real total" would pass on a frozen zero, which is the very
  // failure this pins.
  const otherDir = path.join(process.env.ARCHIVE_DIR, "otherrepo");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, "x.jsonl"), "y".repeat(3333));
  archive.__resetTotalCache();
  const real = archive.totalArchiveBytes();
  const withoutOther = real - 3333;
  assert.ok(withoutOther > 0);

  const realReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (p2, ...rest) => {
    if (String(p2) === otherDir) {
      const e = new Error("EACCES: permission denied");
      e.code = "EACCES";
      throw e;
    }
    return realReaddir(p2, ...rest);
  });
  archive.__resetTotalCache();
  const measured = archive.totalArchiveBytes();
  t.mock.restoreAll();

  // Exactly the rest of the store — measured, not frozen and not thrown.
  assert.equal(measured, withoutOther);
  archive.__resetTotalCache();
  assert.equal(archive.totalArchiveBytes(), real, "and it comes back when readable");
  fs.rmSync(otherDir, { recursive: true });
  archive.__resetTotalCache();
});

test("a failed walk is rate-limited, not retried on every call", (t) => {
  // Synchronous, on the one event loop, at exactly the moment the filesystem is
  // sick and slow — so a failure must not re-walk per call. Left un-stamped this
  // measured 20 walks per beat.
  archive.__resetTotalCache();
  const t0 = Date.now();
  archive.totalArchiveBytes(t0);
  let reads = 0;
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (p2, ...rest) => {
    if (String(p2) === process.env.ARCHIVE_DIR) {
      reads++;
      const e = new Error("EIO");
      e.code = "EIO";
      throw e;
    }
    return realReaddir(p2, ...rest);
  });
  const at = t0 + 6 * 60_000;
  for (let i = 0; i < 25; i++) archive.totalArchiveBytes(at);
  t.mock.restoreAll();
  archive.__resetTotalCache();
  assert.equal(reads, 1, `re-walked ${reads} times on a failing store`);
});

test("the CALL SITES read through totalForCeiling, not the raw total", () => {
  // Pinning the helper alone left both product call sites free to bypass it —
  // reverting them failed no test at all. Each is checked on its own: seed a
  // full baseline on the real clock, then jump past FULL_RECHECK_MS but nowhere
  // near TOTAL_CACHE_MS, so only a call site that re-measures sees recovery.
  const max = Number(process.env.ARCHIVE_TOTAL_MAX_BYTES);
  const realNow = Date.now;
  const jumpPast = (fn) => {
    archive.__resetTotalCache(max + 5000);          // last walk said: full
    const at = realNow() + 45_000;
    Date.now = () => at;
    try { return fn(); } finally { Date.now = realNow; }
  };
  try {
    archive.__resetTotalCache(max + 5000);
    assert.equal(archive.archiveLimits([]).full, true, "should start full");

    assert.equal(jumpPast(() => archive.archiveLimits([]).full), false,
      "archiveLimits bypassed the re-check");

    // Exactly AT the ceiling counts as full for the re-check decision, same as
    // for the refusal itself — otherwise a store sitting on the line never
    // re-measures and never notices space being freed.
    archive.__resetTotalCache(max);
    const atLine = realNow() + 45_000;
    Date.now = () => atLine;
    try {
      assert.ok(archive.totalForCeiling() < max, "a store exactly at the ceiling never re-checked");
    } finally { Date.now = realNow; }

    const r = jumpPast(() => archive.ingestChunk("nas", "recheck",
      { ...META, summary: "Recheck" }, 0, 40,
      [{ uuid: "rc1", role: "user", ts: "2026-07-10T00:13:00Z", text: "ok" }]));
    assert.equal(r.full, undefined, "ingestChunk bypassed the re-check");
    assert.equal(r.bytesStored, 40);
  } finally {
    Date.now = realNow;
    archive.__resetTotalCache();
  }
});

test("the index is NOT counted against the ceiling — refusing ingest can't shrink it", () => {
  // The ceiling is enforced by refusing ingest, so it may only bound what that
  // refusal can reclaim. index.db is on this volume and is ~2.4x the .jsonl
  // total, but nothing reaps its rows for a deleted file and nothing VACUUMs —
  // counted, an operator who deleted every transcript stayed full forever.
  archive.__resetTotalCache();
  const before = archive.totalArchiveBytes();
  // db + WAL + sidecars: whatever SQLite has on disk right now, wherever it
  // keeps it (WAL mode leaves most of it in index.db-wal until a checkpoint).
  let overhead = 0;
  const stack = [process.env.ARCHIVE_DIR];
  while (stack.length) {
    for (const d of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = path.join(d.parentPath || d.path, d.name);
      if (d.isDirectory()) stack.push(full);
      else if (!d.name.endsWith(".jsonl")) overhead += fs.statSync(full).size;
    }
  }
  assert.ok(overhead > 100_000, `index+sidecars only ${overhead} bytes`);
  // ...and a stray non-.jsonl file is not budget either.
  const stray = path.join(process.env.ARCHIVE_DIR, "turma", "notes.txt");
  fs.writeFileSync(stray, Buffer.alloc(7777));
  try {
    archive.__resetTotalCache();
    assert.equal(archive.totalArchiveBytes(), before);
  } finally {
    fs.rmSync(stray);
    archive.__resetTotalCache();
  }
});

test("one unreadable file does not abandon the whole measurement", (t) => {
  // A file deleted between readdir and stat is an ordinary race. Letting it
  // throw abandons the walk, and the caller then treats a partial (or zero)
  // total as the truth — silently disabling the ceiling.
  archive.__resetTotalCache();
  const real = archive.totalArchiveBytes();
  assert.ok(real > 0);

  let first = true;
  const realStat = fs.statSync;
  t.mock.method(fs, "statSync", (p, ...rest) => {
    if (first && String(p).endsWith(".jsonl")) {
      first = false;
      const e = new Error("ENOENT: raced with a delete");
      e.code = "ENOENT";
      throw e;
    }
    return realStat(p, ...rest);
  });
  archive.__resetTotalCache();
  const measured = archive.totalArchiveBytes();
  t.mock.restoreAll();
  archive.__resetTotalCache();

  assert.ok(measured > 0, "the walk gave up on the first bad stat");
  assert.ok(measured < real, "the skipped file should be missing from the total");
  assert.equal(archive.totalArchiveBytes(), real, "and it recovers on the next walk");
});

test("a walk re-baselines: bytes counted once, not twice", () => {
  // writtenSinceWalk rides ON TOP of the last walk, so the walk that absorbs
  // those bytes has to zero it. Left standing, every window's writes are added
  // to a baseline that already includes them and the total runs away upward.
  archive.__resetTotalCache();
  const t0 = Date.now();
  archive.totalArchiveBytes(t0);
  archive.ingestChunk("nas", "rebase", { ...META, summary: "Rebase" }, 0, 60,
    [{ uuid: "rb1", role: "user", ts: "2026-07-10T00:08:00Z", text: "q".repeat(300) }]);
  // Force the next walk, then read again from the cache it just wrote — the
  // walk's own return value looks right either way; the double-count only shows
  // once writtenSinceWalk is added back on top of a baseline containing it.
  archive.totalArchiveBytes(t0 + 6 * 60_000);
  const walked = archive.totalArchiveBytes(t0 + 6 * 60_000 + 1000);
  let real = 0;
  const stack = [path.join(process.env.ARCHIVE_DIR)];
  while (stack.length) {
    for (const d of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = path.join(d.parentPath || d.path, d.name);
      if (d.isDirectory()) stack.push(full);
      else if (d.isFile() && d.name.endsWith(".jsonl")) real += fs.statSync(full).size;
    }
  }
  assert.equal(walked, real, "the walk double-counted the window's writes");
});

test("the store total is cached, and the cache does expire", () => {
  // It runs on the heartbeat path and walks every file, so it must not be paid
  // per beat — and must not be permanent either, or a deletion never registers.
  archive.__resetTotalCache();
  const t0 = Date.now();
  const first = archive.totalArchiveBytes(t0);
  fs.writeFileSync(path.join(process.env.ARCHIVE_DIR, "turma", "cache-probe.jsonl"), "x".repeat(500));
  assert.equal(archive.totalArchiveBytes(t0 + 1000), first, "not cached");
  assert.equal(archive.totalArchiveBytes(t0 + 6 * 60_000), first + 500, "cache never expires");
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
