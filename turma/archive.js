// turma archive — durable, searchable store of ended-session transcripts.
//
// The hub pulls each INACTIVE session's transcript in from the agent that owns
// it (agents are outbound-only, so the agent pushes; see hub-agent.py
// _archive_deltas) and lands it here, independent of the live fleet state. That
// makes history survive a host being wiped, offline, or decommissioned, and
// makes search instant (local FTS, no per-keystroke fan-out).
//
// Two layers:
//   1. CANONICAL = organized files on disk, under ARCHIVE_DIR, one folder per
//      repo, each file renamed + dated:
//        <repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl
//      The .jsonl holds the shipped, displayable entries (one {uuid,role,ts,text}
//      per line — the same subset the rest of Turma renders); a tiny sidecar
//      <file>.meta carries the session metadata + the raw-byte sync cursor, so
//      the whole store is self-describing and the index can be rebuilt from it.
//   2. INDEX = a node:sqlite (Node core, no npm) DB: a `sessions` table for fast
//      browse and an FTS5 `entries_fts` table for ranked full-text search. The
//      DB is disposable — rebuildIndex() repopulates it from the files.
//
// stdlib + node:sqlite only, matching the hub's zero-npm-dependency stance.
// (node:sqlite prints an ExperimentalWarning to stderr; that's expected.)

"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || "/data/archive";
const ARCHIVE_DB = process.env.ARCHIVE_DB || path.join(ARCHIVE_DIR, "index.db");
const SCHEMA_VERSION = 1;

// ---- filename / path building ----------------------------------------------

// Sanitize a component to a safe, flat token. Every character outside the
// allowlist collapses to '-', so the result is a single path component with no
// separators or '..' — it can never escape its repo folder.
function slugify(s, fallback) {
  const out = String(s == null ? "" : s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return out || fallback;
}

function repoFolder(meta) {
  return slugify(meta.repo || meta.remoteKey || "unknown", "unknown");
}

// The organized, human-readable relative path for one transcript:
//   <repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl
function archiveRelPath(transcriptId, meta) {
  const date = String(meta.endedTs || meta.createdAt || "").slice(0, 10) || "undated";
  const summary = slugify(meta.summary, "session");
  const host = slugify(meta.host, "host");
  const short = String(transcriptId || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "unknown";
  // Not path-traversable: repoFolder() and every filename part run through
  // slugify(), which collapses anything outside [A-Za-z0-9._-] and strips
  // leading dots/dashes — so no component can contain a separator or '..'.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(repoFolder(meta), `${slugify(date, "undated")}__${summary}__${host}__${short}.jsonl`);
}

// ---- database ---------------------------------------------------------------

let db = null;

function createSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions(
     transcriptId TEXT PRIMARY KEY,
     host TEXT, remoteKey TEXT, repo TEXT, worktree TEXT, slug TEXT,
     createdAt TEXT, endedTs TEXT, summary TEXT,
     msgCount INTEGER DEFAULT 0, bytesStored INTEGER DEFAULT 0, cost REAL,
     filePath TEXT, updatedAt TEXT)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
     text, transcriptId UNINDEXED, uuid UNINDEXED, role UNINDEXED, ts UNINDEXED)`);
}

// Open (once) and ensure the schema. If the DB was absent/empty but organized
// files already exist on disk, rebuild the index from them (self-heal after a
// lost/corrupt DB or a schema bump).
function openDb() {
  if (db) return db;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  db = new DatabaseSync(ARCHIVE_DB);
  db.exec("PRAGMA journal_mode=WAL");
  createSchema();
  const verRow = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get();
  const ver = verRow ? parseInt(verRow.value, 10) : 0;
  const sessionCount = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  if (ver !== SCHEMA_VERSION || sessionCount === 0) {
    rebuildIndex();
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schemaVersion',?)")
      .run(String(SCHEMA_VERSION));
  }
  return db;
}

// Test seam / graceful shutdown: drop the handle so a later openDb() re-opens.
function closeDb() {
  if (db) { try { db.close(); } catch { /* already closed */ } db = null; }
}

// node:sqlite's DatabaseSync has no .transaction() helper (unlike
// better-sqlite3), so wrap a unit of work in BEGIN/COMMIT by hand. Not nested.
function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    throw e;
  }
}

// ---- ingest -----------------------------------------------------------------

// Absolute path of a session's organized file (and its sidecar).
function filePaths(relPath) {
  // relPath is never raw input: it's produced by archiveRelPath() (all parts
  // slugify()-sanitized) or read back from the DB filePath we wrote, so it can
  // only ever name a child of ARCHIVE_DIR.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const jsonl = path.join(ARCHIVE_DIR, relPath);
  return { jsonl, meta: jsonl + ".meta", dir: path.dirname(jsonl) };
}

function readSidecar(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function writeSidecar(metaPath, obj) {
  const tmp = metaPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, metaPath);
}

// Ingest one delta chunk pushed by an agent. `entries` are the already-parsed,
// displayable {uuid,role,ts,text} records for the raw byte range
// [startOffset,endOffset) of the agent's source transcript; startOffset must
// equal what we've already stored (append-only). Returns {bytesStored} — the
// caller relays it so the agent can resume. On an offset mismatch we DON'T
// append; we just report our real cursor and let the agent realign.
function ingestChunk(host, transcriptId, meta, startOffset, endOffset, entries) {
  openDb();
  meta = meta || {};
  const row = db.prepare("SELECT bytesStored, filePath FROM sessions WHERE transcriptId=?").get(transcriptId);
  const have = row ? row.bytesStored : 0;
  if (Number(startOffset) !== have) return { bytesStored: have };

  const full = { ...meta, host, transcriptId };
  let relPath = row && row.filePath ? row.filePath : archiveRelPath(transcriptId, full);
  const paths = filePaths(relPath);
  fs.mkdirSync(paths.dir, { recursive: true });

  // First sight: write the sidecar header so the file is self-describing.
  const list = Array.isArray(entries) ? entries : [];
  const nowIso = new Date().toISOString();

  const insert = db.prepare(
    "INSERT INTO entries_fts(text, transcriptId, uuid, role, ts) VALUES(?,?,?,?,?)"
  );
  const prevCount = row ? (db.prepare("SELECT msgCount FROM sessions WHERE transcriptId=?").get(transcriptId)?.msgCount || 0) : 0;
  const msgCount = prevCount + list.length;
  const bytesStored = Number(endOffset);

  tx(() => {
    let lines = "";
    for (const e of list) {
      const text = String(e.text || "");
      lines += JSON.stringify({ uuid: e.uuid || null, role: e.role || null, ts: e.ts || null, text }) + "\n";
      insert.run(text, transcriptId, e.uuid || null, e.role || null, e.ts || null);
    }
    if (lines) fs.appendFileSync(paths.jsonl, lines);
    db.prepare(`INSERT INTO sessions(
        transcriptId, host, remoteKey, repo, worktree, slug, createdAt, endedTs,
        summary, msgCount, bytesStored, cost, filePath, updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(transcriptId) DO UPDATE SET
        host=excluded.host, remoteKey=excluded.remoteKey, repo=excluded.repo,
        worktree=excluded.worktree, slug=excluded.slug,
        createdAt=COALESCE(excluded.createdAt, sessions.createdAt),
        endedTs=excluded.endedTs, summary=COALESCE(excluded.summary, sessions.summary),
        msgCount=excluded.msgCount, bytesStored=excluded.bytesStored,
        filePath=excluded.filePath, updatedAt=excluded.updatedAt`).run(
      transcriptId, host, meta.remoteKey || null, meta.repo || null,
      meta.worktree || null, meta.slug || null, meta.createdAt || null,
      meta.endedTs || null, meta.summary || null, msgCount, bytesStored,
      meta.cost == null ? null : Number(meta.cost), relPath, nowIso
    );
  });

  writeSidecar(paths.meta, {
    transcriptId, host, remoteKey: meta.remoteKey || null, repo: meta.repo || null,
    worktree: meta.worktree || null, slug: meta.slug || null,
    createdAt: meta.createdAt || null, endedTs: meta.endedTs || null,
    summary: meta.summary || null, msgCount, bytesStored, updatedAt: nowIso,
  });

  return { bytesStored };
}

// Upsert metadata rows for a manifest and return the bytes-have cursor map the
// heartbeat reply carries back (transcriptId -> bytesStored we already hold).
function manifestCursors(host, manifest) {
  openDb();
  const have = {};
  const list = Array.isArray(manifest) ? manifest : [];
  const upsert = db.prepare(`INSERT INTO sessions(
      transcriptId, host, remoteKey, repo, worktree, slug, createdAt, endedTs,
      summary, updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(transcriptId) DO UPDATE SET
      host=excluded.host, remoteKey=excluded.remoteKey, repo=excluded.repo,
      worktree=excluded.worktree, slug=excluded.slug,
      createdAt=COALESCE(excluded.createdAt, sessions.createdAt),
      endedTs=excluded.endedTs, summary=COALESCE(excluded.summary, sessions.summary),
      updatedAt=excluded.updatedAt`);
  const nowIso = new Date().toISOString();
  tx(() => {
    for (const m of list) {
      if (!m || !m.transcriptId) continue;
      const row = db.prepare("SELECT bytesStored FROM sessions WHERE transcriptId=?").get(m.transcriptId);
      have[m.transcriptId] = row ? row.bytesStored : 0;
      if (!row) {
        upsert.run(m.transcriptId, host, m.remoteKey || null, m.repo || null,
          m.worktree || null, m.slug || null, m.createdAt || null,
          m.endedTs || null, m.summary || null, nowIso);
      }
    }
  });
  return have;
}

// ---- query ------------------------------------------------------------------

// Turn free text into a safe FTS5 MATCH expression: each token becomes a quoted
// prefix term, implicitly AND-ed. Avoids FTS syntax errors from punctuation and
// never lets a user string reach the FTS parser raw. "" when there's no usable
// token (caller returns no results).
function ftsQuery(q) {
  const terms = String(q || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => `"${t}"*`);
  return terms.join(" ");
}

// Full-text search across all archived sessions. Returns matches grouped by
// remoteKey (so the same repo across hosts unifies), most recent first.
function searchArchive(query, opts) {
  openDb();
  const match = ftsQuery(query);
  if (!match) return { query: String(query || ""), groups: [] };
  const limit = Math.min(Math.max(parseInt((opts && opts.limit) || 100, 10) || 100, 1), 500);
  const where = ["entries_fts MATCH ?"];
  const args = [match];
  if (opts && opts.repo) { where.push("s.repo = ?"); args.push(opts.repo); }
  if (opts && opts.host) { where.push("s.host = ?"); args.push(opts.host); }
  const sql = `
    SELECT s.transcriptId, s.host, s.remoteKey, s.repo, s.summary, s.endedTs,
           f.role AS role, f.ts AS ts, f.uuid AS uuid,
           snippet(entries_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
           rank AS rnk
    FROM entries_fts f JOIN sessions s ON s.transcriptId = f.transcriptId
    WHERE ${where.join(" AND ")}
    ORDER BY rank
    LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit);

  // Group by remoteKey (fallback repo/transcriptId), preserving rank order.
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    const key = r.remoteKey || r.repo || r.transcriptId;
    let g = byKey.get(key);
    if (!g) { g = { remoteKey: key, repo: r.repo || null, matches: [] }; byKey.set(key, g); groups.push(g); }
    g.matches.push({
      transcriptId: r.transcriptId, host: r.host, summary: r.summary || null,
      role: r.role || null, ts: r.ts || r.endedTs || null, uuid: r.uuid || null,
      snippet: r.snippet || "",
    });
  }
  return { query: String(query || ""), groups };
}

// Browse ended sessions (newest first), independent of live fleet state — so
// offline hosts' history still lists. Optional repo/host filters + paging.
function listArchive(opts) {
  openDb();
  opts = opts || {};
  const limit = Math.min(Math.max(parseInt(opts.limit || 100, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(opts.offset || 0, 10) || 0, 0);
  const where = [];
  const args = [];
  if (opts.repo) { where.push("repo = ?"); args.push(opts.repo); }
  if (opts.host) { where.push("host = ?"); args.push(opts.host); }
  const sql = `SELECT transcriptId, host, remoteKey, repo, worktree, summary,
      createdAt, endedTs, msgCount, cost
    FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(endedTs, createdAt, '') DESC, transcriptId DESC
    LIMIT ? OFFSET ?`;
  const sessions = db.prepare(sql).all(...args, limit, offset);
  return { sessions };
}

// The full stored transcript of one archived session, read from its canonical
// organized file (not the index). null when unknown/missing.
function getTranscript(transcriptId) {
  openDb();
  const row = db.prepare("SELECT filePath, repo, host, summary, endedTs, createdAt FROM sessions WHERE transcriptId=?").get(transcriptId);
  if (!row || !row.filePath) return null;
  const paths = filePaths(row.filePath);
  let raw;
  try { raw = fs.readFileSync(paths.jsonl, "utf8"); } catch { return null; }
  const entries = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (e && typeof e === "object") entries.push({ uuid: e.uuid, role: e.role, ts: e.ts, text: e.text || "" });
    } catch { /* skip a torn line */ }
  }
  return {
    transcriptId, repo: row.repo, host: row.host, summary: row.summary,
    endedTs: row.endedTs, createdAt: row.createdAt, entries,
  };
}

// ---- rebuild ----------------------------------------------------------------

function walkJsonl(dir, out) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    // d.name is a single readdirSync entry (never contains a separator), so
    // this stays inside `dir` — a recursive walk of our own ARCHIVE_DIR.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walkJsonl(full, out);
    else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(full);
  }
}

// Repopulate `sessions` + `entries_fts` from the canonical organized files. The
// files (+ their .meta sidecars) are the source of truth; the DB is disposable.
function rebuildIndex() {
  openDb();
  db.exec("DELETE FROM entries_fts");
  db.exec("DELETE FROM sessions");
  const files = [];
  walkJsonl(ARCHIVE_DIR, files);
  const insertEntry = db.prepare(
    "INSERT INTO entries_fts(text, transcriptId, uuid, role, ts) VALUES(?,?,?,?,?)"
  );
  const upsert = db.prepare(`INSERT OR REPLACE INTO sessions(
      transcriptId, host, remoteKey, repo, worktree, slug, createdAt, endedTs,
      summary, msgCount, bytesStored, cost, filePath, updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const jsonl of files) {
    const meta = readSidecar(jsonl + ".meta") || {};
    const transcriptId = meta.transcriptId;
    if (!transcriptId) continue; // can't attribute without the sidecar
    const relPath = path.relative(ARCHIVE_DIR, jsonl);
    let raw = "";
    try { raw = fs.readFileSync(jsonl, "utf8"); } catch { /* empty */ }
    tx(() => {
      let msgCount = 0;
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        let e;
        try { e = JSON.parse(s); } catch { continue; }
        if (!e || typeof e !== "object") continue;
        insertEntry.run(String(e.text || ""), transcriptId, e.uuid || null, e.role || null, e.ts || null);
        msgCount++;
      }
      upsert.run(transcriptId, meta.host || null, meta.remoteKey || null,
        meta.repo || null, meta.worktree || null, meta.slug || null,
        meta.createdAt || null, meta.endedTs || null, meta.summary || null,
        msgCount, meta.bytesStored || 0, meta.cost == null ? null : Number(meta.cost),
        relPath, meta.updatedAt || null);
    });
  }
  return files.length;
}

module.exports = {
  ARCHIVE_DIR, ARCHIVE_DB,
  slugify, archiveRelPath, ftsQuery,
  openDb, closeDb, rebuildIndex,
  ingestChunk, manifestCursors, searchArchive, listArchive, getTranscript,
};
