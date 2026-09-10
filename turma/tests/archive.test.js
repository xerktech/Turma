// Unit tests for turma/archive.js (node:test, built-in — zero-npm stance).
// Runs against a real on-disk DB + ARCHIVE_DIR in a temp folder so the rebuild
// path (delete the DB, repopulate from the organized files) is exercised for
// real. node:sqlite prints an ExperimentalWarning to stderr; that's expected.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

const TMP = mkdtemp("turma-archive-");
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

test("XERK-453: getTranscript serves the row's origin org (siteKey) for the restore cross-org warning", () => {
  // The restore picker compares the archived row's ORIGIN org against a target's
  // decided org to warn on a cross-org restore. That comparison needs the origin
  // org on the served transcript — the hub-decided `siteKey` stored on the row
  // (7th ingest arg), NOT the agent-claimed one.
  archive.ingestChunk("orgabox", "xorg1", { ...META }, 0, 40,
    [ent("u1", "user", "restore me later")], "orga.atlassian.net");
  const t = archive.getTranscript("xorg1");
  assert.equal(t.siteKey, "orga.atlassian.net",
    "the served transcript carries its recorded origin org");
  // A legacy/org-less row (no siteKey ingested) serves "" — read by the client as
  // "no org to compare", so the warning never fires on it (never null/undefined,
  // which the `from && to` guard would also skip, but "" is the honest value).
  assert.equal(archive.getTranscript("t1").siteKey, "",
    "an org-less row serves an empty origin org, never null");
});

test("XERK-422: a transcript that rendered ZERO entries reads back as empty, not a 404", () => {
  // A transcript whose lines are all non-renderable (mode/permission-mode/
  // system/last-prompt records) projects to no entries: the agent read the bytes
  // and advanced its cursor to size, so ingestChunk gets an empty entry list at a
  // real endOffset. It appends nothing (no `.jsonl` is ever written) but still
  // upserts the row with a filePath and bytesStored = size.
  const r = archive.ingestChunk("nas", "empty1", { ...META }, 0, 1025, []);
  assert.equal(r.bytesStored, 1025, "the cursor reaches size even with no entries");
  const rel = archive.archiveRelPath("empty1", { ...META, host: "nas" });
  assert.ok(!fs.existsSync(path.join(process.env.ARCHIVE_DIR, rel)),
    "no organized .jsonl is written when there are no renderable entries");
  // It lists (the row exists) ...
  assert.ok(archive.listArchive({ host: "nas" }).sessions.some((s) => s.transcriptId === "empty1"),
    "the row is listable");
  // ... and now reads back as an honest empty conversation rather than 404ing
  // forever. `null` (an unknown transcript) stays reserved for a row that isn't
  // there at all.
  const t = archive.getTranscript("empty1");
  assert.ok(t, "the row reads back instead of 404ing");
  assert.deepEqual(t.entries, [], "with an empty entry list");
  assert.equal(t.transcriptId, "empty1");
  assert.equal(t.repo, "turma", "carrying the row's metadata so the viewer can name it");
});

test("XERK-422: only ENOENT reads back empty — a present-but-unreadable file stays a 404", () => {
  // The empty-conversation rescue is ENOENT-SPECIFIC on purpose: a transient
  // read failure on a file that IS present (EIO/EACCES/EISDIR) must NOT be
  // served as a false "recorded no conversation". `t1` has a real .jsonl; force
  // its read to fail with a non-ENOENT error and confirm getTranscript answers
  // null (→ 404), not empty.
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p.endsWith(".jsonl")) {
      const err = new Error("simulated I/O error");
      err.code = "EIO";
      throw err;
    }
    return realRead(p, ...rest);
  };
  try {
    assert.equal(archive.getTranscript("t1"), null,
      "a non-ENOENT read failure is 'not here', never a false empty conversation");
  } finally {
    fs.readFileSync = realRead;
  }
  // And with the stub gone it reads normally again.
  assert.equal(archive.getTranscript("t1").entries.length, 3);
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
  path.join(process.env.ARCHIVE_DIR, rawRel(tid) + archive.RAW_DIR_SUFFIX, tid, rel);

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

test("only the session's OWN host may write its raw files", () => {
  // `<host>` is proved by the credential at the gate, but proving WHO is calling
  // says nothing about WHOSE session they may write into. With a properly bound
  // token any agent could create arbitrary named files inside another host's
  // archived session — and serve them back through the read-back route as part
  // of that host's "byte-for-byte record" (XERK-338 QA D5).
  seedRaw("owned");            // ingested as host "nas"
  const evil = archive.ingestRaw("evil-host", "owned", "owned.jsonl", 0, Buffer.from("x"));
  assert.equal(evil.skip, true);
  assert.equal(fs.existsSync(rawPath("owned", "owned.jsonl")), false);
  assert.equal(archive.ingestRaw("nas", "owned", "owned.jsonl", 0, Buffer.from("x")).stored, 1);
});

test("a MIGRATED session keeps writing raw as its new host", () => {
  // The host that owns a transcript legitimately changes on a migration, so the
  // ownership check above must not wedge the target out. The rendered delta is
  // what re-points the row (`ingestChunk` sets `host`), and the beat pushes the
  // rendered layer BEFORE the raw one — so by the time the target's raw push
  // lands, the row is already its own. Held here so the ordering cannot drift.
  // A migration is a shared NON-EMPTY decided org on both sides (XERK-349/573), so
  // the re-point is gated on that org, never the org-less "" a no-Jira fleet reads.
  archive.ingestChunk("srchost", "moved", { ...RAW_META, summary: "Moved" }, 0, 10,
    [ent("u1", "user", "before the move")], "orgM.atlassian.net");
  const a = Buffer.from("first half\n");
  assert.equal(archive.ingestRaw("srchost", "moved", "moved.jsonl", 0, a).stored, a.length);
  // The move: the target carries the same transcript id and a byte-identical
  // prefix, and its rendered push re-points the row.
  assert.equal(archive.ingestRaw("tgthost", "moved", "moved.jsonl", a.length,
    Buffer.from("x")).skip, true, "the target must not write before it owns the row");
  archive.ingestChunk("tgthost", "moved", { ...RAW_META, summary: "Moved" }, 10, 20,
    [ent("u2", "user", "after the move")], "orgM.atlassian.net");
  const b = Buffer.from("second half\n");
  assert.equal(archive.ingestRaw("tgthost", "moved", "moved.jsonl", a.length, b).stored,
    a.length + b.length);
  // One file, continued — not a second copy.
  const rel = archive.archiveRelPath("moved", { ...RAW_META, summary: "Moved", host: "srchost" });
  const full = path.join(process.env.ARCHIVE_DIR, rel + archive.RAW_DIR_SUFFIX, "moved", "moved.jsonl");
  assert.deepEqual(fs.readFileSync(full), Buffer.concat([a, b]));
});

test("XERK-344: a host from another org cannot append to or re-point a transcript", () => {
  // `<host>` is credential-bound (XERK-268), but proving WHO is calling says
  // nothing about WHOSE archived transcript they may write into. Without the
  // ownership gate, any host holding its own token could append arbitrary entries
  // to another host's durable record AND re-attribute the row to itself.
  archive.ingestChunk("victim", "xerk344-corrupt", { ...RAW_META, summary: "Victim" },
    0, 20, [ent("v1", "user", "victim-secret")], "orgA.atlassian.net");
  assert.equal(archive.getTranscript("xerk344-corrupt").host, "victim");
  // Attacker (org B) holds a valid token for its OWN host and knows the id (a
  // compromised/buggy host); it pushes at the real cursor.
  const evil = archive.ingestChunk("evil", "xerk344-corrupt", { ...RAW_META, summary: "Evil" },
    20, 40, [ent("e1", "user", "evil-injected")], "orgB.atlassian.net");
  // Refused like an offset mismatch: no progress, no error status.
  assert.deepEqual(evil, { bytesStored: 20 });
  const after = archive.getTranscript("xerk344-corrupt");
  assert.equal(after.host, "victim", "the row must not be re-attributed to the attacker");
  assert.equal(after.entries.length, 1, "no injected entry");
  assert.ok(!after.entries.some((e) => (e.text || "").includes("evil-injected")));
});

test("XERK-344: a same-org host CAN re-point the row (a migration continues)", () => {
  archive.ingestChunk("src", "xerk344-move", { ...RAW_META, summary: "Move" },
    0, 20, [ent("s1", "user", "before move")], "orgA.atlassian.net");
  const cont = archive.ingestChunk("tgt", "xerk344-move", { ...RAW_META, summary: "Move" },
    20, 40, [ent("t1", "user", "after move")], "orgA.atlassian.net");
  assert.equal(cont.bytesStored, 40);
  const t = archive.getTranscript("xerk344-move");
  assert.equal(t.host, "tgt", "the migration target legitimately owns the row");
  assert.equal(t.entries.length, 2);
});

test("XERK-344: a manifest placeholder is stamped, so a cross-org first chunk can't hijack it", () => {
  const tid = "xerk344-placeholder";
  // The owner's heartbeat manifest creates the 0-byte placeholder row (org A).
  archive.manifestCursors("owner", [{ transcriptId: tid, ...RAW_META }], "orgA.atlassian.net");
  // Before the owner's first content chunk lands, an attacker (org B) that knows
  // the id pushes content at offset 0.
  const evil = archive.ingestChunk("evil", tid, { ...RAW_META }, 0, 20,
    [ent("e", "user", "hijack")], "orgB.atlassian.net");
  assert.equal(evil.bytesStored, 0, "the cross-org first chunk is refused, not stored");
  assert.equal(archive.getTranscript(tid), null, "nothing stored under the placeholder");
  // The owner's own first chunk is accepted.
  const ok = archive.ingestChunk("owner", tid, { ...RAW_META }, 0, 20,
    [ent("o", "user", "real")], "orgA.atlassian.net");
  assert.equal(ok.bytesStored, 20);
  assert.equal(archive.getTranscript(tid).host, "owner");
});

test("XERK-344: a legacy row (no recorded org) admits the first writer once, then re-locks", () => {
  // A pre-XERK-344 archive has sidecars with no siteKey; the schema bump rebuilds
  // its rows with siteKey NULL. Such an owner can't be proven cross-org, so the
  // first host to touch it stamps the org — after which the gate is in force.
  const tid = "xerk344-legacy-aaaa-bbbb-cccc-000000000001";
  archive.ingestChunk("hostA", tid, { ...RAW_META, summary: "Legacy" }, 0, 20,
    [ent("l1", "user", "legacy body")], "orgA.atlassian.net");
  const rel = archive.getTranscript(tid);
  const metaPath = path.join(process.env.ARCHIVE_DIR,
    archive.archiveRelPath(tid, { ...RAW_META, summary: "Legacy", host: "hostA" }) + ".meta");
  const sc = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(sc.siteKey, "orgA.atlassian.net");
  delete sc.siteKey;                       // simulate a pre-XERK-344 sidecar
  fs.writeFileSync(metaPath, JSON.stringify(sc));
  archive.rebuildIndex();                   // row rebuilds with siteKey NULL
  assert.equal(rel.host, "hostA");
  // A different-org host may take the NULL-org row once (trust-on-first-sight)...
  const first = archive.ingestChunk("hostB", tid, { ...RAW_META, summary: "Legacy" }, 20, 40,
    [ent("l2", "user", "continued")], "orgB.atlassian.net");
  assert.equal(first.bytesStored, 40);
  assert.equal(archive.getTranscript(tid).host, "hostB");
  // ...but the org is now stamped, so a THIRD org is refused.
  const third = archive.ingestChunk("hostC", tid, { ...RAW_META, summary: "Legacy" }, 40, 60,
    [ent("l3", "user", "nope")], "orgC.atlassian.net");
  assert.deepEqual(third, { bytesStored: 40 });
  assert.equal(archive.getTranscript(tid).host, "hostB", "the stamped org re-locks the row");
});

test("XERK-344: restampOrg lets a cross-org restore continuation archive (XERK-441)", () => {
  // A restore resumes an archived org-A session on an org-B host — deliberately
  // allowed (the archive is not org-scoped). The resumed session keeps the same
  // transcript id, so its later archival is a cross-org re-point the gate would
  // refuse; restampOrg re-points the row (host + org) to the target so its new
  // turns land as a same-host append.
  const tid = "xerk344-restore-aaaa";
  archive.ingestChunk("srchost", tid, { ...RAW_META, summary: "Restore" }, 0, 20,
    [ent("r1", "user", "before restore")], "orgA.atlassian.net");
  // Without the restamp the org-B continuation is refused (the very data loss).
  const blocked = archive.ingestChunk("tgthost", tid, { ...RAW_META, summary: "Restore" }, 20, 40,
    [ent("x", "user", "blocked")], "orgB.atlassian.net");
  assert.deepEqual(blocked, { bytesStored: 20 }, "cross-org continuation refused before restamp");
  // The restore re-points to the target (host + decided org); then it archives
  // cleanly as a same-host append.
  assert.equal(archive.restampOrg(tid, "orgB.atlassian.net", "tgthost"), true);
  const cont = archive.ingestChunk("tgthost", tid, { ...RAW_META, summary: "Restore" }, 20, 40,
    [ent("r2", "user", "after restore")], "orgB.atlassian.net");
  assert.equal(cont.bytesStored, 40);
  const t = archive.getTranscript(tid);
  assert.equal(t.host, "tgthost");
  assert.equal(t.entries.length, 2);
  // The stamp survives a rebuild (sidecar updated), so a THIRD org stays refused.
  archive.rebuildIndex();
  assert.equal(archive.getTranscript(tid).host, "tgthost", "the re-pointed host survives a rebuild");
  const evil = archive.ingestChunk("evil", tid, { ...RAW_META, summary: "Restore" }, 40, 60,
    [ent("e", "user", "nope")], "orgC.atlassian.net");
  assert.deepEqual(evil, { bytesStored: 40 });
  // An unknown transcript is a no-op.
  assert.equal(archive.restampOrg("never-seen-restore", "orgX", "someHost"), false);
});

test("XERK-573: two ORG-LESS hosts do NOT pool — a re-point needs a shared non-empty org", () => {
  // The residual XERK-349 closed on the migrate route but deferred here: with the
  // gate keyed on the CLAIMED org, two hosts that both read "" (a genuinely
  // org-less pair, or a bound host momentarily omitting its `jira` block) matched
  // each other, so one could APPEND to and re-attribute the other's durable
  // transcript. The DECIDED-org gate requires a shared NON-EMPTY org, so an
  // org-less re-point is refused — exactly as `sameDecidedOrg` refuses an org-less
  // migration.
  const tid = "xerk573-orgless";
  archive.ingestChunk("ownerless", tid, { ...RAW_META, summary: "Orgless" }, 0, 20,
    [ent("o1", "user", "owner-secret")], "");           // decided org ""
  const evil = archive.ingestChunk("evilless", tid, { ...RAW_META, summary: "Orgless" }, 20, 40,
    [ent("e1", "user", "evil-injected")], "");           // also decided org ""
  assert.deepEqual(evil, { bytesStored: 20 }, "an org-less re-point is refused, no progress");
  const after = archive.getTranscript(tid);
  assert.equal(after.host, "ownerless", "the row must not be re-attributed to the org-less attacker");
  assert.equal(after.entries.length, 1);
  assert.ok(!after.entries.some((e) => (e.text || "").includes("evil-injected")));
  // The owner itself keeps appending (a same-host push never re-points, never gated).
  assert.equal(
    archive.ingestChunk("ownerless", tid, { ...RAW_META, summary: "Orgless" }, 20, 40,
      [ent("o2", "user", "more")], "").bytesStored, 40);
});

test("XERK-573: an ORG-LESS restore still continues (restampOrg re-points the host)", () => {
  // The flip side of the strict gate: an org-less fleet has no shared non-empty
  // org for the gate to match on, so an org-less restore could never continue on
  // the org compare alone — its restored turns would be stranded, the loss this
  // ticket exists to avoid. restampOrg re-points the HOST too, so the target's
  // push is a same-host append the gate never touches.
  const tid = "xerk573-orgless-restore";
  archive.ingestChunk("srcless", tid, { ...RAW_META, summary: "OrglessRestore" }, 0, 20,
    [ent("r1", "user", "before restore")], "");
  // Before the restamp, a cross-host org-less push is refused (the strict gate).
  const blocked = archive.ingestChunk("tgtless", tid, { ...RAW_META, summary: "OrglessRestore" }, 20, 40,
    [ent("x", "user", "blocked")], "");
  assert.deepEqual(blocked, { bytesStored: 20 });
  // The restore re-points host + (empty) org to the target; the continuation lands.
  assert.equal(archive.restampOrg(tid, "", "tgtless"), true);
  const cont = archive.ingestChunk("tgtless", tid, { ...RAW_META, summary: "OrglessRestore" }, 20, 40,
    [ent("r2", "user", "after restore")], "");
  assert.equal(cont.bytesStored, 40);
  const t = archive.getTranscript(tid);
  assert.equal(t.host, "tgtless");
  assert.equal(t.entries.length, 2);
});

test("XERK-573: accepted LOW residual — an org-less manifest squat blocks the owner's first push", () => {
  // Documented, not closed (QA): on a no-Jira fleet a rogue org-less host that knows
  // a victim's uuid4 id can list it in its manifest, creating the 0-byte placeholder
  // as its own — after which the org-less owner's first push is a cross-host re-point
  // with no shared non-empty org, so it is refused. Availability-only: the placeholder
  // is EMPTY (manifestCursors only INSERTs), so nothing of the victim is read or
  // injected. It makes the org-less case behave like every other org, where a
  // cross-org squat was already denied. Pinned so the behaviour can't drift silently.
  const tid = "xerk573-orgless-squat";
  archive.manifestCursors("roguel", [{ transcriptId: tid, ...RAW_META }], ""); // org-less squat
  const owner = archive.ingestChunk("ownerl", tid, { ...RAW_META, summary: "Squat" }, 0, 20,
    [ent("o", "user", "mine")], "");
  assert.deepEqual(owner, { bytesStored: 0 }, "the org-less owner is refused over the squatted placeholder");
  assert.equal(archive.getTranscript(tid), null, "nothing stored — an empty squat, no content leaked");
  // Clean up the fileless placeholder this test deliberately leaves, so a later
  // rebuild-count invariant isn't skewed by it (a real rebuild drops it too, since
  // it has no on-disk file).
  archive.openDb().prepare("DELETE FROM sessions WHERE transcriptId=?").run(tid);
});

test("the per-transcript raw ceiling stops that session, not the archive", () => {
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    const { mkdtemp } = require(${JSON.stringify(path.join(__dirname, "tmpdirs.js"))});
    const tmp = mkdtemp("turma-rawcap-");
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

test("the per-beat cursor stat loop is bounded by the HUB, not by the agent", () => {
  // `rawCursors` is synchronous on the heartbeat path and the hub is one event
  // loop, so every stat it makes is a hub-wide stall. Measured at ~5.6us each:
  // the 40,000 files an agent may offer under its own caps cost 223 ms, and the
  // ~780,000 that fit in a 32 MiB HEARTBEAT_MAX cost ~4.4 SECONDS — per beat, per
  // host. The agent's own cap is not this bound; a bound the receiving path does
  // not enforce is not a bound (XERK-235).
  //
  // The budget covers the manifest ENTRY's row lookup as well as the per-file
  // stats — charging only the files left the outer loop free, which just moved
  // the stall (QA F4). Held deterministically rather than by wall clock: with a
  // FILE budget of 2 and a LOOKUP budget of 1, one entry lookup plus two stats
  // spends the sum, so the THIRD stored file gets no cursor even though it is on
  // disk. Sizing the two knobs separately is XERK-427 (below); this proves the
  // lookup is still charged, so the loop stays bounded.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    const { mkdtemp } = require(${JSON.stringify(path.join(__dirname, "tmpdirs.js"))});
    const tmp = mkdtemp("turma-statcap-");
    process.env.ARCHIVE_DIR = path.join(tmp, "archive");
    process.env.ARCHIVE_DB = path.join(tmp, "archive", "index.db");
    process.env.ARCHIVE_RAW_CURSOR_MAX = "2";
    process.env.ARCHIVE_RAW_CURSOR_LOOKUP_MAX = "1";
    const a = require(${JSON.stringify(path.join(__dirname, "..", "archive.js"))});
    const meta = { repo: "r", endedTs: "2026-08-18T00:00:00Z", summary: "s" };
    a.ingestChunk("nas", "cap", meta, 0, 10, [{ uuid: "u", role: "user", text: "hi" }]);
    const rels = ["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"];
    for (const r of rels) a.ingestRaw("nas", "cap", r, 0, Buffer.from("xx"));
    const have = a.rawCursors([{ transcriptId: "cap", rawFiles: rels.map((r) => [r, 2]) }]).cap;
    console.log(JSON.stringify(Object.keys(have).sort()));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const covered = JSON.parse(fresh.stdout.trim().split("\n").pop());
  assert.deepEqual(covered, ["a.jsonl", "b.jsonl"],
    "the cap did not stop the stat loop");
  // And the truncation is LOUD: silence would read as "the hub holds nothing",
  // which is a re-ship rather than a refusal.
  assert.match(fresh.stderr, /ARCHIVE_RAW_CURSOR_MAX/);
});

test("an in-cap agent keeps every cursor even with files spread across transcripts (XERK-427)", () => {
  // The per-entry lookup and the per-file stat used to share ONE budget sized to
  // the FILE cap alone, so N files spread across N transcripts cost N + files and
  // overran by exactly N — the last N offers got no cursor though the agent was
  // inside its own ARCHIVE_RAW_MANIFEST_FILES_MAX. The lookups now have their own
  // term, so a well-behaved agent is never truncated. Set the FILE budget to the
  // exact file count (4) and leave the lookup budget at its default: under the old
  // single-budget-of-4 arithmetic the two lookups would eat into it and the SECOND
  // transcript's files would be dropped; both transcripts' files must survive now.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    const { mkdtemp } = require(${JSON.stringify(path.join(__dirname, "tmpdirs.js"))});
    const tmp = mkdtemp("turma-cursor427-");
    process.env.ARCHIVE_DIR = path.join(tmp, "archive");
    process.env.ARCHIVE_DB = path.join(tmp, "archive", "index.db");
    process.env.ARCHIVE_RAW_CURSOR_MAX = "4";        // exactly the 4 files offered
    delete process.env.ARCHIVE_RAW_CURSOR_LOOKUP_MAX; // default (200) covers the 2 lookups
    const a = require(${JSON.stringify(path.join(__dirname, "..", "archive.js"))});
    const meta = { repo: "r", endedTs: "2026-08-18T00:00:00Z", summary: "s" };
    for (const tid of ["t1", "t2"]) {
      a.ingestChunk("nas", tid, meta, 0, 10, [{ uuid: "u", role: "user", text: "hi" }]);
      for (const r of ["a.jsonl", "b.jsonl"]) a.ingestRaw("nas", tid, r, 0, Buffer.from("xx"));
    }
    const out = a.rawCursors([
      { transcriptId: "t1", rawFiles: [["a.jsonl", 2], ["b.jsonl", 2]] },
      { transcriptId: "t2", rawFiles: [["a.jsonl", 2], ["b.jsonl", 2]] },
    ]) || {};
    console.log(JSON.stringify({
      t1: Object.keys(out.t1 || {}).sort(),
      t2: Object.keys(out.t2 || {}).sort(),
    }));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const got = JSON.parse(fresh.stdout.trim().split("\n").pop());
  assert.deepEqual(got.t1, ["a.jsonl", "b.jsonl"], "t1 lost a cursor");
  assert.deepEqual(got.t2, ["a.jsonl", "b.jsonl"],
    "t2 was truncated — the entry lookups ate the file budget (the XERK-427 bug)");
  // No truncation happened, so the over-budget warning must NOT have fired.
  assert.doesNotMatch(fresh.stderr, /got no cursor/);
});

test("two transcripts that would collide on 8 alnum chars get separate canonical files (XERK-277)", () => {
  // `archiveRelPath` keeps only the first 8 alnum characters of the id, so two
  // transcripts agreeing on repo/date/summary/host and that prefix WOULD land on
  // ONE canonical .jsonl — and ingestChunk APPENDS, so each session's read-back
  // then serves the other's entries. `transcriptId` is agent-chosen, so this can
  // be forced, not just hit by accident. resolveNewRelPath disambiguates the
  // second one's filename on first sight.
  const A = "collide1-aaaa-bbbb-cccc-000000000001";
  const B = "collide1-aaaa-bbbb-cccc-000000000002";
  for (const tid of [A, B]) {
    archive.ingestChunk("nas", tid, { ...RAW_META, summary: "Collide" }, 0, 10,
      [ent("u1", "user", `secret of ${tid}`)]);
  }
  const db = archive.openDb();
  const byId = new Map(
    db.prepare("SELECT transcriptId, filePath FROM sessions WHERE transcriptId IN (?,?)")
      .all(A, B).map((r) => [r.transcriptId, r.filePath]));
  assert.notEqual(byId.get(A), byId.get(B), "the two transcripts still share one file");
  // The disambiguated name still carries the readable prefix; only a suffix differs.
  assert.match(byId.get(B), /-2\.jsonl$/);
  // Neither read-back leaks the other's content.
  assert.equal(archive.getTranscript(A).entries.length, 1);
  assert.equal(archive.getTranscript(A).entries[0].text, `secret of ${A}`);
  assert.equal(archive.getTranscript(B).entries[0].text, `secret of ${B}`);
});

test("ids with fewer than 8 alnum chars don't collapse onto one 'unknown' file (XERK-277)", () => {
  // Any id with <8 alnum characters slugs to the literal "unknown", so ids like
  // "..." and ".-." landed on one file even without a prefix collision.
  const A = "...";
  const B = ".-.";
  for (const tid of [A, B]) {
    archive.ingestChunk("nas", tid, { ...RAW_META, summary: "Short" }, 0, 10,
      [ent("u1", "user", `content of ${tid}`)]);
  }
  const db = archive.openDb();
  const rows = db.prepare("SELECT transcriptId, filePath FROM sessions WHERE transcriptId IN (?,?)").all(A, B);
  assert.notEqual(rows[0].filePath, rows[1].filePath, "two short ids share one 'unknown' file");
  assert.equal(archive.getTranscript(A).entries[0].text, `content of ${A}`);
  assert.equal(archive.getTranscript(B).entries[0].text, `content of ${B}`);
});

test("a re-pushed transcript reuses its filePath rather than disambiguating again (XERK-277)", () => {
  // Disambiguation runs ONLY on first sight. A second delta for the same id must
  // find its row.filePath and append to the same file, never fork a new one.
  const tid = "reuse01-aaaa-bbbb-cccc-000000000001";
  archive.ingestChunk("nas", tid, { ...RAW_META, summary: "Reuse" }, 0, 10, [ent("u1", "user", "one")]);
  const db = archive.openDb();
  const first = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(tid).filePath;
  archive.ingestChunk("nas", tid, { ...RAW_META, summary: "Reuse" }, 10, 20, [ent("u2", "user", "two")]);
  const second = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(tid).filePath;
  assert.equal(first, second);
  assert.equal(archive.getTranscript(tid).entries.length, 2);
});

test("two transcripts sharing a prefix keep separate raw directories (XERK-338)", () => {
  // Belt to resolveNewRelPath's braces: rawDirFor is keyed on the FULL id, so
  // even a forced canonical collision could never cross raw layers — each one's
  // /raw listing returns only its own files.
  const A = "collide2-aaaa-bbbb-cccc-000000000001";
  const B = "collide2-aaaa-bbbb-cccc-000000000002";
  for (const tid of [A, B]) {
    archive.ingestChunk("nas", tid, { ...RAW_META, summary: "Collide2" }, 0, 10,
      [ent("u1", "user", "hi")]);
    archive.ingestRaw("nas", tid, `${tid}.jsonl`, 0, Buffer.from(tid));
  }
  assert.deepEqual(archive.listRawFiles(A).map((f) => f.path), [`${A}.jsonl`]);
  assert.deepEqual(archive.listRawFiles(B).map((f) => f.path), [`${B}.jsonl`]);
  assert.deepEqual(fs.readFileSync(archive.rawFileFor(A, `${A}.jsonl`)), Buffer.from(A));
  assert.equal(archive.rawFileFor(A, `${B}.jsonl`), null, "A served B's file");
});

test("a deleted .jsonl whose row survives still OWNS its path — no interleave onto the gap (XERK-277/XERK-280)", () => {
  // relPathOwner consults the sessions TABLE first, not just the on-disk sidecar,
  // exactly so that a transcript whose .jsonl (and .meta) was deleted out from
  // under a surviving row keeps its path. A disk-only check would call the path
  // free and hand it to a colliding transcript, which — since ingest appends —
  // would then interleave onto the surviving row's cursor gap.
  const A = "gaprow01-aaaa-bbbb-cccc-000000000001";
  const B = "gaprow01-aaaa-bbbb-cccc-000000000002";
  archive.ingestChunk("nas", A, { ...RAW_META, summary: "Gap" }, 0, 10, [ent("u1", "user", "a-secret")]);
  const db = archive.openDb();
  const relA = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(A).filePath;
  // Delete BOTH files, leave the row (XERK-280).
  fs.rmSync(path.join(process.env.ARCHIVE_DIR, relA), { force: true });
  fs.rmSync(path.join(process.env.ARCHIVE_DIR, relA + ".meta"), { force: true });
  archive.ingestChunk("nas", B, { ...RAW_META, summary: "Gap" }, 0, 10, [ent("u1", "user", "b-secret")]);
  const relB = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(B).filePath;
  assert.notEqual(relB, relA, "B was handed A's still-owned path");
});

test("the fallback past the readable probes stays ownership-checked — no leak (XERK-277)", () => {
  // Fill base + -2..-N so a further collision has to reach the id-seeded
  // fallback, then push two ids whose slugify() collapses to the SAME token
  // (they differ only by a leading '-'). The fallback must NOT hand both one
  // file — an earlier version returned the id-seeded name unchecked.
  const fam = { ...RAW_META, summary: "Fallback" };
  // A tiny probe cap would make this cheap, but the module reads it at load; N is
  // 1000, so seed enough distinct owners to exhaust the readable band.
  const N = archive.__RELPATH_PROBE_MAX;
  for (let i = 1; i <= N; i++) {
    // 8-alnum prefix "floodpre" shared; the rest keeps each id distinct.
    archive.ingestChunk("nas", `floodpre-fill-${i}`, fam, 0, 10, [ent("u", "user", `fill${i}`)]);
  }
  const X = "-floodpre-tail-zzz";
  const Y = "floodpre-tail-zzz";
  archive.ingestChunk("nas", X, fam, 0, 10, [ent("u", "user", "X-SECRET")]);
  archive.ingestChunk("nas", Y, fam, 0, 10, [ent("u", "user", "Y-SECRET")]);
  const db = archive.openDb();
  const px = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(X).filePath;
  const py = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(Y).filePath;
  assert.notEqual(px, py, "two slug-colliding ids shared one fallback file");
  assert.equal(archive.getTranscript(X).entries[0].text, "X-SECRET");
  assert.equal(archive.getTranscript(Y).entries[0].text, "Y-SECRET");
});

test("rebuildIndex re-derives two disambiguated files without merging them (XERK-277)", () => {
  const A = "rebuild1-aaaa-bbbb-cccc-000000000001";
  const B = "rebuild1-aaaa-bbbb-cccc-000000000002";
  for (const tid of [A, B]) {
    archive.ingestChunk("nas", tid, { ...RAW_META, summary: "Rebuilt" }, 0, 10,
      [ent("u1", "user", `body of ${tid}`)]);
  }
  const db = archive.openDb();
  const before = new Map(
    db.prepare("SELECT transcriptId, filePath FROM sessions WHERE transcriptId IN (?,?)")
      .all(A, B).map((r) => [r.transcriptId, r.filePath]));
  // Wipe and rebuild from the files on disk (their .meta sidecars).
  archive.rebuildIndex();
  const after = new Map(
    db.prepare("SELECT transcriptId, filePath FROM sessions WHERE transcriptId IN (?,?)")
      .all(A, B).map((r) => [r.transcriptId, r.filePath]));
  assert.equal(after.get(A), before.get(A));
  assert.equal(after.get(B), before.get(B));
  assert.notEqual(after.get(A), after.get(B));
  assert.equal(archive.getTranscript(B).entries[0].text, `body of ${B}`);
});

test("a repo folder named like a raw directory is still archived", () => {
  // `isRawDir` is `<name>.jsonl.raw` AND depth > 0. The depth half matters
  // because a REPO FOLDER is a slugified repo name at depth 0 — a repo literally
  // called `x.jsonl.raw` would otherwise have its whole archive skipped by the
  // rebuild's walk and its bytes counted under the wrong rule. Dropping the
  // depth check left the suite green before this (XERK-338 QA D9).
  const meta = { ...RAW_META, repo: "x.jsonl.raw", summary: "Edge Repo" };
  archive.ingestChunk("nas", "edgerepo", meta, 0, 10, [ent("u1", "user", "hi")]);
  const rel = archive.archiveRelPath("edgerepo", { ...meta, host: "nas" });
  assert.equal(rel.split(path.sep)[0], "x.jsonl.raw", "the fixture no longer names the edge case");
  const walked = archive.__walkJsonl();
  assert.ok(walked.some((f) => f.endsWith(rel)),
    "the rebuild walk skipped a REPO folder that merely looks like a raw directory");
});

test("safeRawRel bounds a COMPONENT, not just the whole path", () => {
  // Every common filesystem caps one name at 255 bytes, so a longer component
  // passed the allowlist and then failed at the syscall — an unthrottled error
  // per attempt, per beat (QA D10). The 400-byte whole-path cap does not imply
  // it: a two-component path can be 260/130 and pass that one.
  assert.ok(archive.safeRawRel("a".repeat(255) + "/b.txt"));
  assert.equal(archive.safeRawRel("a".repeat(256) + "/b.txt"), null);
  assert.equal(archive.safeRawRel("a".repeat(300)), null);
});

test("manifestCursors is capped, and the cap bounds ROWS WRITTEN", () => {
  // Pre-existing, and the costlier of the two per-beat loops: a SELECT plus an
  // INSERT per entry, measured at 6.9 SECONDS of blocked event loop for 973,677
  // ids in one beat — which also wrote 973,682 rows and grew index.db to 161 MB,
  // outside ARCHIVE_TOTAL_MAX (QA D7). The agent's ARCHIVE_MANIFEST_MAX is not
  // this bound.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    const { mkdtemp } = require(${JSON.stringify(path.join(__dirname, "tmpdirs.js"))});
    const tmp = mkdtemp("turma-mancap-");
    process.env.ARCHIVE_DIR = path.join(tmp, "archive");
    process.env.ARCHIVE_DB = path.join(tmp, "archive", "index.db");
    process.env.ARCHIVE_MANIFEST_CURSOR_MAX = "5";
    const a = require(${JSON.stringify(path.join(__dirname, "..", "archive.js"))});
    a.manifestCursors("nas", Array.from({ length: 500 },
      (_, i) => ({ transcriptId: "m" + i, repo: "r", remoteKey: "rk" })));
    const db = a.openDb();
    console.log(JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout.trim().split("\n").pop()), 5,
    "the manifest cap did not stop the row writes");
  assert.match(fresh.stderr, /ARCHIVE_MANIFEST_CURSOR_MAX/);
});

test("the cursor budget is charged for REJECTED paths and unknown ids too", () => {
  // The budget bounds WORK, and validating a path costs work — a max-length
  // depth-10 path failing on its last character measured 700 ms per 780k entries.
  // Charging only what survives validation (or only what resolves to a row) left
  // the cap walk-around-able and just moved the stall (QA D4/F4). The lookup term
  // is what bounds unknown ids (they resolve to no row, so they cost a lookup and
  // no stats); set it so the 4 total lookups exhaust the SUM before the real file.
  const fresh = require("child_process").spawnSync(process.execPath, ["-e", `
    const os = require("os"), fs = require("fs"), path = require("path");
    const { mkdtemp } = require(${JSON.stringify(path.join(__dirname, "tmpdirs.js"))});
    const tmp = mkdtemp("turma-charge-");
    process.env.ARCHIVE_DIR = path.join(tmp, "archive");
    process.env.ARCHIVE_DB = path.join(tmp, "archive", "index.db");
    process.env.ARCHIVE_RAW_CURSOR_MAX = "1";
    process.env.ARCHIVE_RAW_CURSOR_LOOKUP_MAX = "3";  // sum = 4: three unknown + one real lookup
    const a = require(${JSON.stringify(path.join(__dirname, "..", "archive.js"))});
    const meta = { repo: "r", endedTs: "2026-08-18T00:00:00Z", summary: "s" };
    a.ingestChunk("nas", "chg", meta, 0, 10, [{ uuid: "u", role: "user", text: "hi" }]);
    a.ingestRaw("nas", "chg", "real.jsonl", 0, Buffer.from("xx"));
    // Three ids the hub has never seen (each costs a lookup), then the real one
    // with its stored file last. With the budget charged for the lookups, the
    // real file's cursor is never reached.
    const manifest = ["nope1", "nope2", "nope3"].map((t) => (
      { transcriptId: t, rawFiles: [["a.jsonl", 1]] }));
    manifest.push({ transcriptId: "chg", rawFiles: [["real.jsonl", 2]] });
    console.log(JSON.stringify(a.rawCursors(manifest) || {}));
  `], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const out = JSON.parse(fresh.stdout.trim().split("\n").pop());
  assert.deepEqual(out, {}, "unknown ids were not charged, so the cap did not bind");
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

test("dshTrajectory parses the D3 native log into turns/steps/tool-calls/tokens (XERK-498)", () => {
  seedRaw("dshtraj");
  const events = [
    { type: "session/title", seq: 1, time: 1000, data: { title: "my dsh session" } },
    { type: "turn/start", seq: 2, time: 1000, data: { turn: 1 } },
    { type: "step/start", seq: 3, time: 1000, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", seq: 4, time: 1100, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 120, outputTokens: 8 } } } },
    { type: "assistant/message", seq: 5, time: 1100, data: { turn: 1, step: 1, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "tool/call", seq: 6, time: 1100, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: { command: "echo hi" } } },
    { type: "tool/result", seq: 7, time: 1150, data: { turn: 1, step: 1, message: { source: { callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", isError: false }] } } },
    { type: "step/start", seq: 75, time: 1200, data: { turn: 1, step: 2 } },
    { type: "tool/call", seq: 8, time: 1200, data: { turn: 1, step: 2, callId: "c2", name: "str_replace_editor", arguments: {} } },
    { type: "tool/result", seq: 9, time: 1260, data: { turn: 1, step: 2, message: { source: { callId: "c2" }, content: [{ type: "tool-result", toolCallId: "c2", isError: true }] } } },
    { type: "turn/end", seq: 10, time: 1300, data: { turn: 1, reason: { kind: "completed" } } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  archive.ingestRaw("nas", "dshtraj", "dshtraj/dsh/events.jsonl", 0, Buffer.from(events, "utf8"));
  const t = archive.dshTrajectory("dshtraj");
  assert.equal(t.title, "my dsh session");
  assert.equal(t.model, "deepseek-v4-flash");
  assert.equal(t.totals.turns, 1);
  assert.equal(t.totals.steps, 2);
  assert.equal(t.totals.toolCalls, 2);
  assert.equal(t.totals.errors, 1);          // one tool-result carried isError
  assert.equal(t.totals.tokens.input, 120);
  assert.equal(t.totals.tokens.output, 8);
  assert.equal(t.durationMs, 300);           // 1300 - 1000
  const turn = t.turns[0];
  assert.equal(turn.turn, 1);
  assert.equal(turn.reason, "completed");
  assert.equal(turn.calls.length, 2);
  const bash = turn.calls.find((c) => c.name === "bash");
  assert.equal(bash.ok, true);
  assert.equal(bash.durationMs, 50);         // 1150 - 1100
  const edit = turn.calls.find((c) => c.name === "str_replace_editor");
  assert.equal(edit.ok, false);
  assert.equal(edit.error, true);
  assert.ok(bash.args.includes("echo hi"));
  assert.equal(t.truncated, false);
});

test("dshTrajectory: a long tool arg carries the FULL copy for expand (XERK-720)", () => {
  seedRaw("dshtrajfull");
  const long = "z".repeat(2000);
  const events = [
    { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
    { type: "tool/call", seq: 2, time: 1100, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: { command: long } } },
    { type: "turn/end", seq: 3, time: 1200, data: { turn: 1, reason: { kind: "completed" } } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  archive.ingestRaw("nas", "dshtrajfull", "dshtrajfull/dsh/events.jsonl", 0, Buffer.from(events, "utf8"));
  const call = archive.dshTrajectory("dshtrajfull").turns[0].calls[0];
  assert.ok(call.args.length <= 401 && call.args.endsWith("…"), "display arg is the snippet");
  assert.ok(call.argsFull.includes(long) && call.argsFull.length > 401, "full arg carried for expand");
  assert.ok(call.argsClipped === undefined);
});

test("dshTrajectory returns null when a session has no dsh native log (XERK-498)", () => {
  seedRaw("nodsh");
  archive.ingestRaw("nas", "nodsh", "nodsh.jsonl", 0, Buffer.from("x"));
  assert.equal(archive.dshTrajectory("nodsh"), null);
  assert.equal(archive.dshTrajectory("never-seen-at-all"), null);
});

// --- XERK-280: a deleted/truncated .jsonl under a surviving row is healed on read ---

// The canonical .jsonl path for an id, as ingestChunk placed it.
function jsonlFor(id, meta, host) {
  return path.join(process.env.ARCHIVE_DIR, archive.archiveRelPath(id, { ...meta, host }));
}

test("XERK-280: getTranscript heals msgCount + FTS after a delete+recreate", () => {
  const M = { ...META, summary: "x280 recreate" };
  archive.ingestChunk("nas280", "x280a", { ...M }, 0, 100, [
    ent("a1", "user", "one alpha280"), ent("a2", "assistant", "two beta280"),
  ]);
  archive.ingestChunk("nas280", "x280a", { ...M }, 100, 200, [ent("a3", "user", "three gamma280")]);
  // Index believes 3 messages are stored.
  assert.equal(archive.listArchive({ host: "nas280" }).sessions
    .find((s) => s.transcriptId === "x280a").msgCount, 3);

  // Operator deletes the .jsonl by hand; the row survives, cursor untouched.
  fs.unlinkSync(jsonlFor("x280a", M, "nas280"));
  // The next delta appends at the old cursor onto the now-recreated (short) file.
  archive.ingestChunk("nas280", "x280a", { ...M }, 200, 300, [ent("a4", "user", "after deletion x280")]);

  // On disk: only the post-deletion line survives.
  const t = archive.getTranscript("x280a");
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0].text, "after deletion x280");

  // The read healed the row: msgCount now matches disk, not the lie.
  assert.equal(archive.listArchive({ host: "nas280" }).sessions
    .find((s) => s.transcriptId === "x280a").msgCount, 1);
  // And search no longer returns the vanished messages.
  const hitsGamma = archive.searchArchive("gamma280").groups
    .flatMap((g) => g.matches).filter((m) => m.transcriptId === "x280a");
  assert.equal(hitsGamma.length, 0, "deleted message dropped from FTS");
  const hitsAfter = archive.searchArchive("after").groups
    .flatMap((g) => g.matches).filter((m) => m.transcriptId === "x280a");
  assert.equal(hitsAfter.length, 1, "surviving message still searchable");
});

test("XERK-280: listArchive heals a stale row on its own (before any transcript view)", () => {
  const M = { ...META, summary: "x280 listheal" };
  archive.ingestChunk("nas280", "x280b", { ...M }, 0, 100, [
    ent("b1", "user", "one"), ent("b2", "assistant", "two"), ent("b3", "user", "three"),
  ]);
  fs.unlinkSync(jsonlFor("x280b", M, "nas280"));
  archive.ingestChunk("nas280", "x280b", { ...M }, 100, 200, [ent("b4", "user", "survivor")]);
  // listArchive alone (no getTranscript first) reports the true, healed count.
  const row = archive.listArchive({ host: "nas280" }).sessions.find((s) => s.transcriptId === "x280b");
  assert.equal(row.msgCount, 1);
  // Helper columns never leak onto the wire.
  assert.equal("filePath" in row, false);
  assert.equal("archiveBytes" in row, false);
  // Healed values match a full rebuild-from-disk (the file is the source of truth).
  archive.rebuildIndex();
  assert.equal(archive.listArchive({ host: "nas280" }).sessions
    .find((s) => s.transcriptId === "x280b").msgCount, 1);
});

test("XERK-280: a healthy transcript is never mutated on read", () => {
  const M = { ...META, summary: "x280 healthy" };
  archive.ingestChunk("nas280", "x280c", { ...M }, 0, 100, [
    ent("c1", "user", "hello"), ent("c2", "assistant", "world"),
  ]);
  const jsonl = jsonlFor("x280c", M, "nas280");
  const before = fs.statSync(jsonl).mtimeMs;
  // Capture the heal's own log line: reconcileRow only reaches it PAST its no-op
  // guard, so its absence pins that a healthy read takes the early return and
  // runs no FTS delete/re-insert + row UPDATE on the hot browse/search path
  // (drop the guard and every healthy read churns the tx — this catches it).
  const origErr = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(" "));
  let t;
  try {
    t = archive.getTranscript("x280c");
    archive.listArchive({ host: "nas280" });
    archive.searchArchive("hello");
  } finally { console.error = origErr; }
  assert.equal(t.entries.length, 2);
  assert.equal(archive.listArchive({ host: "nas280" }).sessions
    .find((s) => s.transcriptId === "x280c").msgCount, 2);
  // No heal ran: no reconcile log, and the file was not rewritten.
  assert.equal(logs.filter((l) => l.includes("reconciled x280c")).length, 0,
    "healthy read must not trigger a heal");
  assert.equal(fs.statSync(jsonl).mtimeMs, before);
});

test("XERK-280: a fully-deleted file (ENOENT) is NOT mutated on read — blip-safe residual", () => {
  const M = { ...META, summary: "x280 enoent" };
  archive.ingestChunk("nas280", "x280d", { ...M }, 0, 100, [
    ent("d1", "user", "one"), ent("d2", "assistant", "two"),
  ]);
  fs.unlinkSync(jsonlFor("x280d", M, "nas280"));
  // getTranscript serves the honest empty view (XERK-422) but must NOT heal:
  // ENOENT cannot be told from a mount blip, so a read mutates nothing.
  const t = archive.getTranscript("x280d");
  assert.deepEqual(t.entries, []);
  // The row's count is deliberately left as-is (the ambiguous case the ticket
  // isolates); it is not zeroed on an absence.
  assert.equal(archive.listArchive({ host: "nas280" }).sessions
    .find((s) => s.transcriptId === "x280d").msgCount, 2);
});

// ---- XERK-431: the hub-driven inventory / want path -------------------------

test("inventoryCursors names back only the transcripts the hub is SHORT of", () => {
  // Seed: inv-a fully stored (bytesStored==s), inv-b partially stored, inv-c new.
  archive.ingestChunk("invh", "inv-a", { ...META }, 0, 100, [ent("a1", "user", "hello there world")]);
  archive.ingestChunk("invh", "inv-b", { ...META }, 0, 40, [ent("b1", "user", "partial start")]);
  const have = archive.inventoryCursors("invh", [
    { i: "inv-a", s: 100, r: 0 },   // complete -> not wanted
    { i: "inv-b", s: 150, r: 0 },   // 40 < 150 -> wanted from 40
    { i: "inv-c", s: 80, r: 0 },    // brand new -> wanted from 0, row created
  ], "");
  assert.deepEqual(Object.keys(have).sort(), ["inv-b", "inv-c"]);
  assert.equal(have["inv-b"], 40);
  assert.equal(have["inv-c"], 0);
  assert.ok(!("inv-a" in have), "a complete transcript is never wanted");
  // The new id got a placeholder row (so a raw/rendered push has one to hang off).
  assert.ok(archive.sessionRow("inv-c"), "wanted-new id gets a placeholder row");
});

test("inventoryCursors wants a rendered-COMPLETE transcript that is raw-SHORT", () => {
  // inv-d rendered-complete but the hub holds none of its raw sidecars, so r>0
  // must still pull it into the want set — the exact case the old rotation had to
  // reach because a raw-short/rendered-complete transcript reads as "done".
  archive.ingestChunk("invh", "inv-d", { ...META }, 0, 60, [ent("d1", "user", "complete rendered")]);
  const have = archive.inventoryCursors("invh", [
    { i: "inv-d", s: 60, r: 5000 },  // rendered done, raw 0<5000 -> wanted
  ], "");
  assert.deepEqual(Object.keys(have), ["inv-d"]);
  assert.equal(have["inv-d"], 60, "the cursor is the rendered bytesStored");
});

test("inventoryCursors NEVER re-points a row another host owns (squat protection)", () => {
  archive.ingestChunk("ownerH", "inv-owned", { ...META }, 0, 30, [ent("o1", "user", "owned by ownerH")]);
  // A different host lists the same id in its inventory: not wanted, not touched.
  const have = archive.inventoryCursors("rogueH", [{ i: "inv-owned", s: 999, r: 0 }], "");
  assert.ok(!("inv-owned" in have), "another host's transcript is never wanted for us");
  assert.equal(archive.sessionRow("inv-owned").host, "ownerH", "owner is unchanged");
});

test("inventoryCursors wants EVERY short entry in the window (no starving prefix-cap)", () => {
  // The window is bounded by the AGENT (ARCHIVE_INVENTORY_MAX) and, against a
  // hostile oversize, by ARCHIVE_MANIFEST_CURSOR_MAX — never a smaller want-cap,
  // which would take the same prefix every beat and starve the tail.
  const many = [];
  for (let i = 0; i < 300; i++) many.push({ i: `wm-${i}`, s: 10, r: 0 });  // all new -> all short
  const have = archive.inventoryCursors("wmh", many, "");
  assert.equal(Object.keys(have).length, 300, "all short entries are wanted, not a prefix");
});

test("rawCursorsForIds reads back the hub's own stored raw files", () => {
  // Give inv-b a rendered file (so it has a filePath/raw dir) then a raw sidecar.
  archive.ingestRaw("invh", "inv-b", "inv-b/tool-results/x.txt", 0, Buffer.from("abcde"));
  const cur = archive.rawCursorsForIds(["inv-b", "inv-a"]);
  assert.ok(cur && cur["inv-b"], "raw cursor present for the transcript with raw bytes");
  assert.equal(cur["inv-b"]["inv-b/tool-results/x.txt"], 5);
  assert.ok(!("inv-a" in (cur || {})), "no raw bytes -> no entry");
});

// ---- claudeTrajectory: the Claude+Qwen Trajectory reducer (XERK-714) ----
// One parser folds both the Claude raw <sid>.jsonl and the Qwen projected
// <sid>.jsonl into the Trajectory JSON contract (docs/trajectory-contract.md).
// Driven against the committed real fixtures, not a mock.

const TRAJ_FIXTURES = path.join(__dirname, "fixtures", "trajectory");

// Seed a row (the raw dir hangs off it) and lay the raw <tid>.jsonl the parser
// resolves via listRawFiles/rawFileFor. `body` is the raw bytes to store.
function seedTraj(tid, body) {
  archive.ingestChunk("nas", tid, { ...RAW_META }, 0, 10, [ent("s1", "user", "seed")]);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  archive.ingestRaw("nas", tid, `${tid}.jsonl`, 0, buf);
}
function seedTrajFixture(tid, name) {
  seedTraj(tid, fs.readFileSync(path.join(TRAJ_FIXTURES, name)));
  return archive.claudeTrajectory(tid);
}

test("claudeTrajectory: null when the transcript / raw file is absent", () => {
  assert.equal(archive.claudeTrajectory("no-such-transcript"), null);
});

test("claudeTrajectory: folds the real Claude fixture into the contract", () => {
  const t = seedTrajFixture("traj-claude", "claude.jsonl");
  assert.equal(t.runtime, "claude");
  assert.equal(t.transcriptId, "traj-claude");
  assert.equal(t.model, "claude-opus-4-8");
  // Two real user turns (both `<task-notification>` strings open a turn);
  // tool_result-only user lines never open one.
  assert.equal(t.totals.turns, 2);
  assert.equal(t.turns.length, 2);
  assert.equal(t.totals.toolCalls, 4);
  assert.equal(t.totals.errors, 1);          // the one is_error tool_result
  // Claude repeats message.usage across the split lines of one message; the
  // parser dedupes on message.id, so tokens are counted once, not per line.
  assert.deepEqual(t.totals.tokens,
    { input: 48, output: 15131, cacheRead: 9648263, cacheWrite: 26613 });
  assert.equal(t.totals.tokens.input, t.turns[0].tokens.input + t.turns[1].tokens.input);
  assert.equal(t.totals.tokens.output, t.turns[0].tokens.output + t.turns[1].tokens.output);

  const t1 = t.turns[0];
  assert.equal(t1.turn, 1);
  assert.ok(t1.user && t1.user.text.startsWith("<task-notification>"));
  assert.ok(t1.output.some((o) => o.kind === "thinking"));
  assert.ok(t1.output.some((o) => o.kind === "text"));
  assert.equal(t1.reason, "end_turn");
  assert.equal(t1.calls.length, 4);
  assert.equal(t1.startedAt, Date.parse("2026-08-25T21:08:31.412Z"));
  assert.ok(t1.durationMs > 0 && t1.durationMs === t1.endedAt - t1.startedAt);

  // The error Edit correlates by tool_use_id: !ok, error, a duration from the
  // two timestamps, and a stringified result present.
  const errCall = t1.calls.find((c) => c.callId === "toolu_014fHV5pvJXMyPrxTxFCW8k2");
  assert.equal(errCall.ok, false);
  assert.equal(errCall.error, true);
  assert.equal(errCall.name, "Edit");
  assert.equal(typeof errCall.durationMs, "number");
  assert.ok(errCall.result.includes("tool_use_error"));
  // A successful call is ok:true / error:false with a result.
  const okCall = t1.calls.find((c) => c.callId === "toolu_01GB7VeiABq9ttM4DTHGbjQF");
  assert.equal(okCall.ok, true);
  assert.equal(okCall.error, false);
  assert.ok(okCall.result.length > 0);

  assert.equal(t.truncated, false);
  assert.equal(t.turnsDropped, 0);
  assert.equal(t.callsDropped, 0);
});

test("claudeTrajectory: encrypted Claude thinking is emitted empty, signature never leaks", () => {
  const t = seedTrajFixture("traj-claude-sig", "claude.jsonl");
  const thinking = t.turns.flatMap((tn) => tn.output).filter((o) => o.kind === "thinking");
  assert.ok(thinking.length >= 1, "has thinking blocks");
  assert.ok(thinking.every((o) => o.text === ""), "encrypted -> empty text");
  // The `signature` field is the encrypted blob — it must never appear anywhere.
  assert.ok(!JSON.stringify(t).includes("signature"));
  assert.ok(!JSON.stringify(t).includes("REDACTED"));  // the scrubbed signature value
});

test("claudeTrajectory: folds the real Qwen projected fixture, same shape, no branch", () => {
  const t = seedTrajFixture("traj-qwen", "qwen.jsonl");
  assert.equal(t.runtime, "qwen");
  assert.equal(t.model, "qwen3.8-27b-dflash");
  assert.equal(t.totals.turns, 3);           // three real user turns
  assert.equal(t.totals.toolCalls, 6);
  assert.equal(t.totals.errors, 4);          // four error tool results
  // Gemini-shaped usage maps via promptTokenCount/candidatesTokenCount/
  // cachedContentTokenCount; no distinct cacheWrite.
  assert.equal(t.totals.tokens.input, 855483);
  assert.equal(t.totals.tokens.output, 5138);
  assert.equal(t.totals.tokens.cacheWrite, 0);

  // Qwen keeps thinking PLAINTEXT (unlike Claude), so a thinking block carries text.
  const thinking = t.turns.flatMap((tn) => tn.output).filter((o) => o.kind === "thinking");
  assert.ok(thinking.some((o) => o.text.trim().length > 0), "qwen thinking is plaintext");

  // functionCall <-> functionResponse pairs correlate by id; the last call in
  // the run has no result -> ok stays null (not-yet-seen).
  const closed = t.turns.flatMap((tn) => tn.calls).find((c) => c.error === true);
  assert.ok(closed && closed.ok === false && closed.durationMs >= 0);
  const open = t.turns.flatMap((tn) => tn.calls).find((c) => c.ok === null);
  assert.ok(open && open.result === null && open.durationMs === null,
    "a call with no result stays ok:null");

  assert.equal(t.truncated, false);
});

test("claudeTrajectory: bounds turns, sets truncated + turnsDropped over the cap", () => {
  // One user line per turn, one past TRAJ_TURNS_MAX (1000).
  const n = 1001;
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `turn ${i}` } }));
  }
  seedTraj("traj-turncap", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-turncap");
  assert.equal(r.totals.turns, n);           // all counted
  assert.equal(r.turns.length, 1000);        // only the newest kept
  assert.equal(r.turnsDropped, 1);
  assert.equal(r.truncated, true);
});

test("claudeTrajectory: bounds tool calls, sets truncated + callsDropped over the cap", () => {
  // One user turn, then TRAJ_CALLS_MAX + 1 tool_use lines.
  const n = 4001;
  const lines = [JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "go" } })];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", model: "m", content: [
        { type: "tool_use", id: `c${i}`, name: "Bash", input: { i } }] } }));
  }
  seedTraj("traj-callcap", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-callcap");
  assert.equal(r.totals.toolCalls, n);       // all counted in totals
  assert.equal(r.callsDropped, 1);           // one shed from the kept calls[]
  assert.equal(r.truncated, true);
  const kept = r.turns.reduce((a, tn) => a + tn.calls.length, 0);
  assert.equal(kept, 4000);
});

test("claudeTrajectory: every text/args/result is snippeted, no un-snippeted content leaks", () => {
  const long = "x".repeat(5000);
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: long } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", model: "m", content: [
        { type: "text", text: long },
        { type: "thinking", thinking: long, signature: "SECRETSIG" },
        { type: "tool_use", id: "c1", name: "Bash", input: { cmd: long } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: long, is_error: false }] } }),
  ];
  seedTraj("traj-snip", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-snip");
  const cap = 401;  // TRAJ_SNIPPET (400) + the trailing "…"
  assert.ok(r.turns[0].user.text.length <= cap && r.turns[0].user.text.endsWith("…"));
  for (const o of r.turns[0].output) {
    assert.ok(o.text.length <= cap, `output ${o.kind} not snippeted`);
  }
  const call = r.turns[0].calls[0];
  assert.ok(call.args.length <= cap && call.args.endsWith("…"));
  assert.ok(call.result.length <= cap && call.result.endsWith("…"));
  // The signature must NEVER survive anywhere in the structured output.
  assert.ok(!JSON.stringify(r).includes("SECRETSIG"));
});

test("claudeTrajectory: a snipped field carries the FULL copy for expand (XERK-720)", () => {
  const long = "x".repeat(5000);  // > TRAJ_SNIPPET, < TRAJ_FULL_MAX (1 MiB)
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: long } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", model: "m", content: [
        { type: "text", text: long },
        { type: "tool_use", id: "c1", name: "Bash", input: { cmd: long } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: long, is_error: false }] } }),
  ];
  seedTraj("traj-full", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-full");
  const tn = r.turns[0], call = tn.calls[0];
  // The display field stays the 400-char snippet; the *Full sibling is the whole
  // value, unclipped (it fits under TRAJ_FULL_MAX), so the UI can expand it.
  assert.equal(tn.user.textFull, long);
  assert.ok(tn.user.textClipped === undefined);
  assert.equal(tn.output.find((o) => o.kind === "text").textFull, long);
  assert.equal(call.argsFull.length, 5000 + '{"cmd":""}'.length, "args full is the whole stringified input");
  assert.equal(call.resultFull, long);
  assert.ok(call.argsClipped === undefined && call.resultClipped === undefined);
});

test("claudeTrajectory: a short field gets NO *Full copy; a >1MiB field is clipped (XERK-720)", () => {
  const short = "hello";                       // <= TRAJ_SNIPPET: no expand
  const huge = "y".repeat(1024 * 1024 + 10);   // > TRAJ_FULL_MAX (1 MiB): clipped
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: short } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", model: "m", content: [
        { type: "tool_use", id: "c1", name: "Bash", input: huge }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: huge, is_error: false }] } }),
  ];
  seedTraj("traj-clip", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-clip");
  const tn = r.turns[0], call = tn.calls[0];
  assert.equal(tn.user.text, short);
  assert.ok(tn.user.textFull === undefined, "short field carries no expand copy");
  assert.equal(call.argsFull.length, 1024 * 1024, "full copy bounded to TRAJ_FULL_MAX");
  assert.equal(call.argsClipped, true);
  assert.equal(call.resultFull.length, 1024 * 1024);
  assert.equal(call.resultClipped, true);
});

test("claudeTrajectory: deeply-nested tool content returns JSON, never throws (XERK-714 QA D1)", () => {
  // A real Read/Bash/MCP result can hold a deeply-nested object that JSON.parse
  // accepts but JSON.stringify blows the stack on (depth >= ~6000 here). The
  // fold must snip it to a bounded fallback, not crash. Built as raw text so the
  // test itself isn't the thing that stringifies (and throws) the deep value.
  const deepJson = '{"n":'.repeat(6000) + "0" + "}".repeat(6000);
  const lines = [
    '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"go"}}',
    '{"type":"assistant","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"c1","name":"Read","input":' + deepJson + "}]}}",
    '{"type":"user","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":' + deepJson + ',"is_error":false}]}}',
  ];
  seedTraj("traj-deep", lines.join("\n") + "\n");
  let r;
  assert.doesNotThrow(() => { r = archive.claudeTrajectory("traj-deep"); });
  assert.ok(r && r.runtime === "claude");
  const call = r.turns[0].calls[0];
  assert.ok(call && call.args.length <= 401, "deep input still snipped/bounded");
  assert.ok(call.result != null && call.result.length <= 401);
});

test("claudeTrajectory: a duplicate/orphan error tool_result counts errors once (XERK-714 QA D2)", () => {
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", model: "m", content: [
        { type: "tool_use", id: "c1", name: "Bash", input: {} }] } }),
    // two error results for the SAME call, plus an orphan error result
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: "boom again", is_error: true },
        { type: "tool_result", tool_use_id: "nope", content: "orphan", is_error: true }] } }),
  ];
  seedTraj("traj-duperr", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-duperr");
  assert.equal(r.totals.errors, 1, "one errored call -> errors:1, not 3");
  assert.equal(r.turns[0].calls[0].error, true);
});

test("claudeTrajectory: a finite-but-absurd token count is clamped, totals stay finite (XERK-714 QA D3)", () => {
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", uuid: "a1",
      message: { role: "assistant", model: "m", id: "a1",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1e308, output_tokens: 1e308,
          cache_read_input_tokens: 1e308, cache_creation_input_tokens: 1e308 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:02.000Z", uuid: "a2",
      message: { role: "assistant", model: "m", id: "a2",
        content: [{ type: "text", text: "yo" }],
        usage: { input_tokens: 1e308, output_tokens: 5, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0 } } }),
  ];
  seedTraj("traj-bigtok", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-bigtok");
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    assert.ok(isFinite(r.totals.tokens[k]), `${k} finite, not Infinity`);
  }
  assert.equal(r.totals.tokens.output, 1e15 + 5);  // clamped 1e308 + a real 5
});

test("claudeTrajectory: an empty-array user content line opens no turn (XERK-714 QA D4)", () => {
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "real turn" } }),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [] } }),
  ];
  seedTraj("traj-empty", lines.join("\n") + "\n");
  const r = archive.claudeTrajectory("traj-empty");
  assert.equal(r.totals.turns, 1, "the [] line opens no turn");
  assert.equal(r.turns[0].user.text, "real turn");
});
