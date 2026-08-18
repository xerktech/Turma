// Unit tests for turma/archive.js (node:test, built-in — zero-npm stance).
// Runs against a real on-disk DB + ARCHIVE_DIR in a temp folder so the rebuild
// path (delete the DB, repopulate from the organized files) is exercised for
// real. node:sqlite prints an ExperimentalWarning to stderr; that's expected.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "turma-archive-"));
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
process.env.ARCHIVE_DB = path.join(TMP, "archive", "index.db");

const archive = require("../archive.js");

function ent(uuid, role, text, ts) {
  return { uuid, role, ts: ts || "2026-07-10T00:00:00Z", text };
}
const META = {
  remoteKey: "github.com/xerk/turma", repo: "turma", worktree: "/repos/.turma/worktrees/ab",
  slug: "-repos--turma-worktrees-ab", createdAt: "2026-07-10T00:00:00Z",
  endedTs: "2026-07-10T01:00:00Z", summary: "Adding Compose Flag",
};

test("archiveRelPath: dated, slugified summary, repo folder, sanitized", () => {
  const rel = archive.archiveRelPath("abc12345-6789", { ...META, host: "nas" });
  assert.equal(path.dirname(rel), "turma");
  assert.equal(path.basename(rel), "2026-07-10__adding-compose-flag__nas__abc12345.jsonl");
  // No traversal even with hostile input.
  const evil = archive.archiveRelPath("../../etc/passwd", { repo: "../../x", summary: "a/b", host: "../h", endedTs: "2026-01-02" });
  assert.ok(!evil.includes(".."), evil);
  assert.equal(rel.split(path.sep).length, 2);
});

test("ftsQuery: tokenizes, quotes, drops punctuation, empty on no tokens", () => {
  assert.equal(archive.ftsQuery("hello world"), '"hello"* "world"*');
  assert.equal(archive.ftsQuery("  !!! "), "");
  assert.equal(archive.ftsQuery('a-b.c'), '"a"* "b"* "c"*');
});

test("ingestChunk writes the organized file + sidecar and indexes it", () => {
  const r = archive.ingestChunk("nas", "t1", { ...META }, 0, 100, [
    ent("u1", "user", "please add a compose flag"),
    ent("u2", "assistant", "done, added the flag"),
  ]);
  assert.equal(r.bytesStored, 100);
  const rel = archive.archiveRelPath("t1", { ...META, host: "nas" });
  const jsonl = path.join(process.env.ARCHIVE_DIR, rel);
  assert.ok(fs.existsSync(jsonl), "organized .jsonl exists");
  assert.ok(fs.existsSync(jsonl + ".meta"), "sidecar .meta exists");
  const lines = fs.readFileSync(jsonl, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, "please add a compose flag");
  const meta = JSON.parse(fs.readFileSync(jsonl + ".meta", "utf8"));
  assert.equal(meta.transcriptId, "t1");
  assert.equal(meta.bytesStored, 100);
});

test("ingestChunk is append-only: mismatched offset returns the real cursor, no double-write", () => {
  // Wrong startOffset (0 again) -> no append, reports we already have 100.
  const r = archive.ingestChunk("nas", "t1", { ...META }, 0, 50, [ent("dup", "user", "should not append")]);
  assert.equal(r.bytesStored, 100);
  const rel = archive.archiveRelPath("t1", { ...META, host: "nas" });
  const lines = fs.readFileSync(path.join(process.env.ARCHIVE_DIR, rel), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "no duplicate line appended");

  // Correct continuation appends.
  const r2 = archive.ingestChunk("nas", "t1", { ...META }, 100, 160, [ent("u3", "user", "and search it later")]);
  assert.equal(r2.bytesStored, 160);
  const lines2 = fs.readFileSync(path.join(process.env.ARCHIVE_DIR, rel), "utf8").trim().split("\n");
  assert.equal(lines2.length, 3);
});

test("ingestChunk: the cursor never rewinds, so a range can't be ingested twice (XERK-235)", () => {
  // Only startOffset === bytesStored was checked; endOffset was written back
  // unvalidated. An endOffset BELOW startOffset rewound the cursor, and the
  // next (now "valid") chunk replayed a range already stored — duplicating it
  // in the canonical .jsonl, the msgCount AND the FTS index at once.
  const rel = archive.archiveRelPath("t1", { ...META, host: "nas" });
  const file = path.join(process.env.ARCHIVE_DIR, rel);
  const before = fs.readFileSync(file, "utf8").trim().split("\n").length;

  const rewind = archive.ingestChunk("nas", "t1", { ...META }, 160, 5,
    [ent("bad", "user", "rewinding")]);
  assert.equal(rewind.bytesStored, 160, "the cursor must hold, not move backwards");

  // The replay the rewind used to enable is now simply an offset mismatch.
  const replay = archive.ingestChunk("nas", "t1", { ...META }, 5, 160,
    [ent("u3", "user", "and search it later")]);
  assert.equal(replay.bytesStored, 160);

  const after = fs.readFileSync(file, "utf8").trim().split("\n").length;
  assert.equal(after, before, "no line was duplicated into the durable record");

  // A non-numeric endOffset must not poison the cursor either.
  const junk = archive.ingestChunk("nas", "t1", { ...META }, 160, "abc",
    [ent("junk", "user", "nope")]);
  assert.equal(junk.bytesStored, 160);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, before);

  // ...and neither must a HUGE one. The guard had a lower bound and no upper
  // one, so an endOffset past 2^53 was stored into the SQLite INTEGER column
  // and then threw "Value is too large to be represented as a JavaScript
  // number" on every subsequent read — bricking that transcript's ingest
  // permanently, with the poison chunk left as its last archived content. The
  // agent chooses transcriptId, so any transcript was reachable (XERK-235).
  for (const bad of [9007199254740992, 2 ** 53, 1e21, Infinity, "1e21", -0]) {
    const poison = archive.ingestChunk("nas", "t1", { ...META }, 160, bad,
      [ent("poison", "user", "poison")]);
    assert.equal(poison.bytesStored, 160, `endOffset ${bad} must be refused`);
  }
  // The transcript still ingests afterwards — the whole point of refusing.
  // On its OWN transcript, so this assertion doesn't move the shared fixture's
  // line count out from under the tests below it.
  archive.ingestChunk("nas", "tbound", { ...META }, 0, 10,
    [ent("b1", "user", "first")]);
  const poisoned = archive.ingestChunk("nas", "tbound", { ...META }, 10, 2 ** 53,
    [ent("b2", "user", "poison")]);
  assert.equal(poisoned.bytesStored, 10, "the huge cursor must be refused");
  const ok = archive.ingestChunk("nas", "tbound", { ...META }, 10, 20,
    [ent("b3", "user", "still ingesting")]);
  assert.equal(ok.bytesStored, 20, "a legitimate chunk must still land after a refused one");
});

test("searchArchive: ranked, <mark>-highlighted snippets, repo/host filters", () => {
  archive.ingestChunk("nas2", "t2", {
    remoteKey: "github.com/xerk/other", repo: "other", worktree: "/w2",
    slug: "s2", createdAt: "2026-07-09T00:00:00Z", endedTs: "2026-07-09T00:00:00Z", summary: "Other work",
  }, 0, 40, [ent("o1", "assistant", "compose flag lives elsewhere here")]);

  const res = archive.searchArchive("compose flag");
  const allMatches = res.groups.flatMap((g) => g.matches);
  assert.ok(allMatches.length >= 2, "matches across both repos");
  assert.ok(allMatches.some((m) => /<mark>/.test(m.snippet)), "snippet highlights the term");
  // Each match carries the matched entry's uuid so the UI can scroll to it.
  assert.ok(allMatches.some((m) => m.uuid === "o1"), "match returns the matched entry uuid");
  // Grouped by remoteKey.
  assert.ok(res.groups.length >= 2);

  const scoped = archive.searchArchive("compose flag", { repo: "turma" });
  assert.ok(scoped.groups.every((g) => g.repo === "turma"));

  assert.equal(archive.searchArchive("!!!").groups.length, 0, "no usable tokens -> no results");
});

test("listArchive: newest first, filters, offline-host-independent", () => {
  const all = archive.listArchive({});
  assert.ok(all.sessions.length >= 2);
  // Newest endedTs first: t1 (07-10) before t2 (07-09).
  const ids = all.sessions.map((s) => s.transcriptId);
  assert.ok(ids.indexOf("t1") < ids.indexOf("t2"));
  const only = archive.listArchive({ repo: "other" });
  assert.ok(only.sessions.every((s) => s.repo === "other"));
});

test("getTranscript reads the canonical file", () => {
  const t = archive.getTranscript("t1");
  assert.equal(t.repo, "turma");
  assert.equal(t.entries.length, 3);
  assert.equal(t.entries[0].text, "please add a compose flag");
  // Legacy text-only entries round-trip with an empty blocks[] so the chat
  // engine synthesizes a plain bubble.
  assert.deepEqual(t.entries[0].blocks, []);
  assert.equal(archive.getTranscript("nope"), null);
});

test("ingestChunk persists blocks[] and getTranscript returns them", () => {
  const blocks = [
    { t: "thinking", text: "hmm" },
    { t: "text", text: "added an index" },
    { t: "tool_use", id: "b1", name: "Bash", input: "ls" },
  ];
  archive.ingestChunk("nas", "tb", { ...META }, 0, 90, [
    { uuid: "u1", role: "user", ts: "2026-07-10T00:00:00Z", text: "make it searchable", blocks: [{ t: "text", text: "make it searchable" }] },
    { uuid: "a1", role: "assistant", ts: "2026-07-10T00:01:00Z", text: "added an index", blocks },
  ]);
  const t = archive.getTranscript("tb");
  assert.equal(t.entries.length, 2);
  assert.deepEqual(t.entries[1].blocks, blocks); // rich structure preserved for the chat renderer
  // The on-disk line carries the blocks so a rebuild (files are the source of truth) keeps them.
  const rel = archive.archiveRelPath("tb", { ...META, host: "nas" });
  const line1 = fs.readFileSync(path.join(process.env.ARCHIVE_DIR, rel), "utf8").trim().split("\n")[1];
  assert.deepEqual(JSON.parse(line1).blocks, blocks);
});

test("rebuildIndex repopulates search from files after the DB is deleted", () => {
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DB, { force: true });
  fs.rmSync(process.env.ARCHIVE_DB + "-wal", { force: true });
  fs.rmSync(process.env.ARCHIVE_DB + "-shm", { force: true });
  // openDb() on next call sees an empty DB with files present -> auto-rebuild.
  const res = archive.searchArchive("compose flag");
  const allMatches = res.groups.flatMap((g) => g.matches);
  assert.ok(allMatches.length >= 2, "search works again, rebuilt from files");
  const t = archive.getTranscript("t1");
  assert.equal(t.entries.length, 3, "transcript recovered from file");
});

test.after(() => {
  archive.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- the raw layer (XERK-338) ----------------------------------------------
//
// Beside the RENDERED entries the archive has always kept, it now holds a
// byte-for-byte copy of the session's own files. What is held here is the
// append-only rule — which is the whole reason a resumed session cannot
// duplicate data — and the path allowlist, which is the one thing between a
// heartbeating agent and an arbitrary write.

const RAW_META = { ...META, summary: "Raw Layer", endedTs: "2026-07-11T01:00:00Z" };
const rawRel = (tid) => archive.archiveRelPath(tid, { ...RAW_META, host: "nas" });
const rawPath = (tid, rel) =>
  path.join(process.env.ARCHIVE_DIR, rawRel(tid) + archive.RAW_DIR_SUFFIX, rel);

function seedRaw(tid) {
  // The rendered layer creates the row the raw directory hangs off.
  archive.ingestChunk("nas", tid, { ...RAW_META }, 0, 10, [ent("u1", "user", "hi")]);
}

test("safeRawRel allowlists components rather than hunting for '..'", () => {
  assert.equal(archive.safeRawRel("t1.jsonl"), "t1.jsonl");
  assert.equal(archive.safeRawRel("t1/subagents/agent-1.jsonl"), "t1/subagents/agent-1.jsonl");
  for (const bad of [
    "", "..", "../x", "t1/../../x", "/etc/passwd", "t1//x", "./x",
    "t1\\..\\x",                      // a Windows separator is not a component char
    "t1/\u0000x",                      // NUL, which some syscalls truncate at
    "a/".repeat(20) + "x",              // deeper than any real session
    "t1/" + "x".repeat(500),            // longer than the length cap
    "t1/sub agents/a.jsonl",            // a space is outside the allowlist
  ]) {
    assert.equal(archive.safeRawRel(bad), null, `accepted: ${JSON.stringify(bad)}`);
  }
});

test("ingestRaw stores the session's own bytes, byte for byte", () => {
  seedRaw("raw1");
  const body = Buffer.from('{"type":"user","hookRecord":{"x":1}}\n');
  const r = archive.ingestRaw("nas", "raw1", "raw1.jsonl", 0, body);
  assert.equal(r.stored, body.length);
  const full = rawPath("raw1", "raw1.jsonl");
  assert.deepEqual(fs.readFileSync(full), body);
  // Nested files keep their own layout, so the store reads like the host did.
  const sub = Buffer.from('{"agent":"a"}\n');
  archive.ingestRaw("nas", "raw1", "raw1/subagents/agent-1.jsonl", 0, sub);
  assert.deepEqual(fs.readFileSync(rawPath("raw1", "raw1/subagents/agent-1.jsonl")), sub);
  // ...including the ones that are not .jsonl at all, which is the half of a
  // session no other surface carries.
  const txt = Buffer.from("overflowed tool output");
  archive.ingestRaw("nas", "raw1", "raw1/tool-results/b1.txt", 0, txt);
  assert.deepEqual(fs.readFileSync(rawPath("raw1", "raw1/tool-results/b1.txt")), txt);
});

test("a resumed session appends and never re-stores what it already sent", () => {
  seedRaw("raw2");
  const a = Buffer.from("first turn\n");
  const b = Buffer.from("second turn, after a resume\n");
  assert.equal(archive.ingestRaw("nas", "raw2", "raw2.jsonl", 0, a).stored, a.length);
  // The resume appends: the cursor is where the last chunk ended.
  assert.equal(archive.ingestRaw("nas", "raw2", "raw2.jsonl", a.length, b).stored,
               a.length + b.length);
  assert.deepEqual(fs.readFileSync(rawPath("raw2", "raw2.jsonl")), Buffer.concat([a, b]));

  // A re-send of a range already stored writes NOTHING and hands back the real
  // cursor. Without this an agent that lost its place would append a second copy
  // of the conversation into the same file — the exact duplication the ticket is
  // about, and undetectable afterwards.
  const before = fs.readFileSync(rawPath("raw2", "raw2.jsonl"));
  assert.equal(archive.ingestRaw("nas", "raw2", "raw2.jsonl", 0, a).stored, before.length);
  assert.deepEqual(fs.readFileSync(rawPath("raw2", "raw2.jsonl")), before);
  // A chunk from BEYOND the cursor is refused too — it would leave a hole.
  assert.equal(archive.ingestRaw("nas", "raw2", "raw2.jsonl", before.length + 99, b).stored,
               before.length);
  assert.deepEqual(fs.readFileSync(rawPath("raw2", "raw2.jsonl")), before);
});

test("the raw cursor is the FILE's size, so deleting one re-syncs it", () => {
  seedRaw("raw3");
  const a = Buffer.from("aaaa");
  archive.ingestRaw("nas", "raw3", "raw3.jsonl", 0, a);
  fs.unlinkSync(rawPath("raw3", "raw3.jsonl"));
  // Nothing had to notice the deletion: the next push from 0 is simply correct,
  // where the rendered layer's indexed cursor appends onto the gap (XERK-280).
  assert.equal(archive.ingestRaw("nas", "raw3", "raw3.jsonl", 0, a).stored, a.length);
  assert.deepEqual(fs.readFileSync(rawPath("raw3", "raw3.jsonl")), a);
});

test("ingestRaw cannot be talked into writing outside its own directory", () => {
  seedRaw("raw4");
  const dir = path.join(process.env.ARCHIVE_DIR, rawRel("raw4") + archive.RAW_DIR_SUFFIX);
  const escapee = path.join(process.env.ARCHIVE_DIR, "escaped.jsonl");
  for (const bad of ["../../escaped.jsonl", "/tmp/escaped.jsonl", "..", "raw4/../../escaped.jsonl"]) {
    const r = archive.ingestRaw("nas", "raw4", bad, 0, Buffer.from("nope"));
    assert.equal(r.skip, true, `not refused: ${bad}`);
  }
  assert.equal(fs.existsSync(escapee), false);
  // And an unknown transcript has no directory to write into at all.
  assert.equal(archive.ingestRaw("nas", "never-seen", "x.jsonl", 0, Buffer.from("x")).skip, true);
  assert.equal(fs.existsSync(dir + path.sep + "x.jsonl"), false);
});

test("the per-transcript raw ceiling stops that session, not the archive", () => {
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turma-rawcap-"));
    process.env.ARCHIVE_DIR = path.join(tmp, "archive");
    process.env.ARCHIVE_DB = path.join(tmp, "archive", "index.db");
    process.env.ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES = "32";
    const a = require(${JSON.stringify(path.join(__dirname, "..", "archive.js"))});
    const meta = { repo: "r", endedTs: "2026-07-11T00:00:00Z", summary: "s" };
    a.ingestChunk("nas", "cap", meta, 0, 10, [{ uuid: "u", role: "user", text: "hi" }]);
    const out = [];
    out.push(a.ingestRaw("nas", "cap", "cap.jsonl", 0, Buffer.alloc(40, 0x61)).stored);
    // Now over the 32-byte ceiling: the next push is refused with \`skip\`...
    out.push(a.ingestRaw("nas", "cap", "cap.jsonl", 40, Buffer.alloc(8, 0x62)).skip === true);
    // ...and rawLimits tells the agent so before it puts bytes on the wire.
    out.push(a.rawLimits(["cap"]).includes("cap"));
    // The RENDERED transcript is untouched — the session stays readable.
    out.push(a.getTranscript("cap").entries.length);
    console.log(JSON.stringify(out));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout.trim().split("\n").pop()), [40, true, true, 1]);
});

test("the store total counts raw bytes of EVERY extension", () => {
  // The ceiling exists to keep this volume writable for the hub's own state, so
  // it has to see the raw layer — most of which is not named .jsonl.
  seedRaw("raw5");
  archive.__resetTotalCache();
  const before = archive.totalArchiveBytes(Date.now(), 0);
  archive.ingestRaw("nas", "raw5", "raw5/tool-results/big.txt", 0, Buffer.alloc(4096, 0x63));
  archive.__resetTotalCache();
  const after = archive.totalArchiveBytes(Date.now(), 0);
  assert.ok(after - before >= 4096, `raw .txt bytes uncounted: ${before} -> ${after}`);
});

test("a rebuild derives rawBytes from disk and never indexes a raw file as a session", () => {
  seedRaw("raw6");
  archive.ingestRaw("nas", "raw6", "raw6.jsonl", 0, Buffer.from("x".repeat(50)));
  archive.ingestRaw("nas", "raw6", "raw6/subagents/a.jsonl", 0, Buffer.from("y".repeat(25)));
  const before = archive.listArchive({ limit: 500 }).sessions.length;
  // The rebuild's file walk must not DESCEND a raw directory at all. Its
  // contents are the session's own .jsonl files, which carry no `.meta` and so
  // would be skipped as rows anyway — but only after the rebuild had read every
  // one of them into memory, on a pass that already re-reads the whole store.
  const walked = archive.__walkJsonl();
  assert.equal(walked.filter((f) => f.includes(archive.RAW_DIR_SUFFIX + path.sep)).length, 0,
    "the rebuild walk descended a raw directory");
  assert.ok(walked.length, "the walk found the rendered files");
  archive.rebuildIndex();
  const after = archive.listArchive({ limit: 500 });
  assert.equal(after.sessions.length, before, "a raw file was indexed as a session");
  // rawBytes comes off the disk, like archiveBytes — so an operator's `rm -rf`
  // of a raw directory actually gives the budget back.
  const db = archive.openDb();
  const row = db.prepare("SELECT rawBytes FROM sessions WHERE transcriptId=?").get("raw6");
  assert.equal(row.rawBytes, 75);
});

test("listRawFiles and rawFileFor read the layer back", () => {
  seedRaw("raw7");
  archive.ingestRaw("nas", "raw7", "raw7.jsonl", 0, Buffer.from("abc"));
  archive.ingestRaw("nas", "raw7", "raw7/tool-results/b.txt", 0, Buffer.from("de"));
  const files = archive.listRawFiles("raw7");
  assert.deepEqual(files.map((f) => f.path).sort(),
    ["raw7.jsonl", "raw7/tool-results/b.txt"]);
  assert.equal(files.find((f) => f.path === "raw7.jsonl").bytes, 3);
  assert.ok(archive.rawFileFor("raw7", "raw7.jsonl"));
  // The same allowlist guards the read path as the write path.
  assert.equal(archive.rawFileFor("raw7", "../../etc/passwd"), null);
  assert.equal(archive.rawFileFor("raw7", "nope.jsonl"), null);
  assert.equal(archive.listRawFiles("never-seen"), null);
});
