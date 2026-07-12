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

test("searchArchive: ranked, <mark>-highlighted snippets, repo/host filters", () => {
  archive.ingestChunk("nas2", "t2", {
    remoteKey: "github.com/xerk/other", repo: "other", worktree: "/w2",
    slug: "s2", createdAt: "2026-07-09T00:00:00Z", endedTs: "2026-07-09T00:00:00Z", summary: "Other work",
  }, 0, 40, [ent("o1", "assistant", "compose flag lives elsewhere here")]);

  const res = archive.searchArchive("compose flag");
  const allMatches = res.groups.flatMap((g) => g.matches);
  assert.ok(allMatches.length >= 2, "matches across both repos");
  assert.ok(allMatches.some((m) => /<mark>/.test(m.snippet)), "snippet highlights the term");
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
  assert.equal(archive.getTranscript("nope"), null);
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
