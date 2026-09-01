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
  archive.ingestChunk("srchost", "moved", { ...RAW_META, summary: "Moved" }, 0, 10,
    [ent("u1", "user", "before the move")]);
  const a = Buffer.from("first half\n");
  assert.equal(archive.ingestRaw("srchost", "moved", "moved.jsonl", 0, a).stored, a.length);
  // The move: the target carries the same transcript id and a byte-identical
  // prefix, and its rendered push re-points the row.
  assert.equal(archive.ingestRaw("tgthost", "moved", "moved.jsonl", a.length,
    Buffer.from("x")).skip, true, "the target must not write before it owns the row");
  archive.ingestChunk("tgthost", "moved", { ...RAW_META, summary: "Moved" }, 10, 20,
    [ent("u2", "user", "after the move")]);
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
  // refuse; restampOrg is what keeps the restored session's new turns reachable.
  const tid = "xerk344-restore-aaaa";
  archive.ingestChunk("srchost", tid, { ...RAW_META, summary: "Restore" }, 0, 20,
    [ent("r1", "user", "before restore")], "orgA.atlassian.net");
  // Without the restamp the org-B continuation is refused (the very data loss).
  const blocked = archive.ingestChunk("tgthost", tid, { ...RAW_META, summary: "Restore" }, 20, 40,
    [ent("x", "user", "blocked")], "orgB.atlassian.net");
  assert.deepEqual(blocked, { bytesStored: 20 }, "cross-org continuation refused before restamp");
  // The restore stamps the target's org; then it archives cleanly.
  assert.equal(archive.restampOrg(tid, "orgB.atlassian.net"), true);
  const cont = archive.ingestChunk("tgthost", tid, { ...RAW_META, summary: "Restore" }, 20, 40,
    [ent("r2", "user", "after restore")], "orgB.atlassian.net");
  assert.equal(cont.bytesStored, 40);
  const t = archive.getTranscript(tid);
  assert.equal(t.host, "tgthost");
  assert.equal(t.entries.length, 2);
  // The stamp survives a rebuild (sidecar updated), so a THIRD org stays refused.
  archive.rebuildIndex();
  const evil = archive.ingestChunk("evil", tid, { ...RAW_META, summary: "Restore" }, 40, 60,
    [ent("e", "user", "nope")], "orgC.atlassian.net");
  assert.deepEqual(evil, { bytesStored: 40 });
  // An unknown transcript is a no-op.
  assert.equal(archive.restampOrg("never-seen-restore", "orgX"), false);
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turma-statcap-"));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turma-cursor427-"));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turma-mancap-"));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turma-charge-"));
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

test("dshTrajectory returns null when a session has no dsh native log (XERK-498)", () => {
  seedRaw("nodsh");
  archive.ingestRaw("nas", "nodsh", "nodsh.jsonl", 0, Buffer.from("x"));
  assert.equal(archive.dshTrajectory("nodsh"), null);
  assert.equal(archive.dshTrajectory("never-seen-at-all"), null);
});
