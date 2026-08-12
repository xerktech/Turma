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
// 2: dropped the never-populated `cost` column when the product went
// token-only. 3: added archiveBytes (the budget below reads it). A bump
// recreates the tables and refills them from the files.
const SCHEMA_VERSION = 3;

// The largest byte offset a transcript may claim (1 TiB). Far above any real
// conversation, far below the 2^53 point where a stored value stops being
// readable back as a JS number. See the cursor guard in appendDelta.
const MAX_TRANSCRIPT_BYTES = 1024 ** 4;

// One of the two ceilings below, read from the environment. Two rules, both of
// which a bare parseInt gets wrong in a damaging direction:
//   - an explicit 0 turns that ceiling OFF and is honoured as such, where
//     `parseInt(x) || fallback` reads it as "unset" and restores the default;
//   - a value must be ENTIRELY digits, where parseInt("16MiB") is 16 — a
//     plausible operator typo that would otherwise set a 16-BYTE ceiling and
//     shed every payload in the store.
// Anything else falls back to the default. Mirrored by _byte_ceiling in
// hub-agent.py, which must agree on both rules (XERK-267).
function byteCeiling(raw, fallback) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}

// Per-transcript archive budget (XERK-267). What we store is the agent's
// PRE-PARSED entries, and a SendUserFile block carries the delivered file inline
// — a base64 data: URI per image, raw markup per HTML page. That is bounded per
// tool call agent-side (SEND_FILE_MAX_FILES x SEND_FILE_MAX_BYTES) but unbounded
// relative to the transcript it came from: a measured 28 KB screenshot-heavy
// transcript archived as 447 MB, ~15,700x its source.
//
// So an ordinary session keeps full fidelity, and only a transcript that crosses
// this ceiling degrades — its file payloads shed to the same name-only chip the
// live chat already shows for an unreadable or oversized delivery, for the REST
// of that transcript.
//
// Sized against the RAW transcripts on the reference host, not against what is
// already archived there: the biggest stored .jsonl is ~1.2 MB, but that is an
// artefact of the 1 MiB ingest body cap (XERK-255) truncating exactly the large
// sessions, so it measures the transport rather than the sessions. Re-running
// _entry_blocks over the 12 largest real transcripts (11.0 MB down to 3.8 MB
// raw) encodes them at 0.07x-0.31x, a 2.6 MB worst case — so this ceiling sits
// ~6x above the largest real session and no real conversation reaches it.
const ARCHIVE_TRANSCRIPT_MAX = byteCeiling(
  process.env.ARCHIVE_TRANSCRIPT_MAX_BYTES, 16 * 1024 * 1024);
// Whole-store ceiling. ARCHIVE_DIR shares its volume with the hub's state.json,
// so an archive blow-up takes the hub's own state down with it when the volume
// fills — this is the backstop against that, not a sizing target (the reference
// deployment holds ~110 MB on a 12 TB pool). Past it we stop STORING rather than
// stop replying: ingest hands back its real cursor, which the agent reads as no
// forward progress and drops, instead of retrying a doomed POST forever the way
// an error response did (XERK-255).
const ARCHIVE_TOTAL_MAX = byteCeiling(
  process.env.ARCHIVE_TOTAL_MAX_BYTES, 64 * 1024 * 1024 * 1024);

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
     msgCount INTEGER DEFAULT 0, bytesStored INTEGER DEFAULT 0,
     archiveBytes INTEGER DEFAULT 0,
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
  if (ver !== SCHEMA_VERSION) {
    // A bump can drop or retype columns, and CREATE TABLE IF NOT EXISTS won't
    // touch a table that already exists — so recreate them outright. The
    // organized files are the source of truth; rebuildIndex() refills below.
    db.exec("DROP TABLE IF EXISTS entries_fts");
    db.exec("DROP TABLE IF EXISTS sessions");
    createSchema();
  }
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

// Bytes of .jsonl the whole store holds, summed over the index.
function totalArchiveBytes() {
  const r = db.prepare("SELECT SUM(archiveBytes) AS n FROM sessions").get();
  return (r && r.n) || 0;
}

// Has this transcript's file actually been DELETED — as opposed to being
// momentarily unreachable? The difference is not academic: a false "gone" drops
// the row and resets the cursor, and since ingest APPENDS, the re-push from
// offset 0 writes a second copy of the conversation into a file that was there
// all along. That is durable corruption of the store's own source of truth, so
// this errs hard toward "still there".
//
//   - Only ENOENT counts. `fs.existsSync` collapses EVERY error to false, so an
//     EACCES/EIO/ESTALE blip on the archive volume read as a deletion.
//   - A missing PARENT also reports ENOENT, so an archive mount that drops for
//     one syscall would make every row look deleted at once — hence the second
//     check. If ARCHIVE_DIR itself isn't there, nothing was deleted; the volume
//     is gone, and the right response is to touch nothing.
function fileIsGone(relPath) {
  const paths = filePaths(relPath);
  try {
    fs.statSync(paths.jsonl);
    return false;                       // still there
  } catch (e) {
    if (e.code !== "ENOENT") return false;   // unreachable != deleted
  }
  try {
    fs.statSync(ARCHIVE_DIR);
  } catch {
    return false;                       // the whole store is unreachable
  }
  return true;
}

// Forget a transcript whose organized file is no longer on disk: its row, its
// budget spend and its FTS entries. Returns true if anything was dropped.
//
// The FILES are the source of truth here, not the index — so deleting one has
// to actually give its bytes back. Without this, `archiveBytes` only ever grows
// and the operator's obvious remedy for a full store (delete some archives)
// changes nothing, leaving the ceiling measured against bytes that no longer
// exist and no way out short of deleting index.db.
//
// It also repairs the cursor: an agent still holding that transcript re-offers
// it, sees have=0, and re-pushes from the start — where a kept cursor made the
// hub accept the NEXT delta as if the earlier ones were still stored, silently
// leaving a truncated conversation behind a msgCount that claimed otherwise.
function forgetMissingTranscript(transcriptId, relPath) {
  if (!relPath || !fileIsGone(relPath)) return false;
  tx(() => {
    db.prepare("DELETE FROM entries_fts WHERE transcriptId=?").run(transcriptId);
    db.prepare("DELETE FROM sessions WHERE transcriptId=?").run(transcriptId);
  });
  console.error(`archive: ${transcriptId}'s file is gone (${relPath}); ` +
    `dropped its index row, so it re-archives from the start`);
  return true;
}

// Sweep every indexed transcript for a file that has since been deleted. Only
// worth its cost on the full-store path, where it is the difference between a
// recoverable ceiling and a wedged one — so it is rate-limited rather than run
// per chunk.
let lastReconcileAt = 0;
// Test seam: reach past the rate limit the way a later beat would, rather than
// making a unit test sleep a minute to observe a recovery.
function __resetReconcileClock() { lastReconcileAt = 0; }
function reconcileMissingFiles() {
  const now = Date.now();
  if (now - lastReconcileAt < 60 * 1000) return 0;
  lastReconcileAt = now;
  let dropped = 0;
  for (const row of db.prepare("SELECT transcriptId, filePath FROM sessions").all()) {
    if (forgetMissingTranscript(row.transcriptId, row.filePath)) dropped++;
  }
  return dropped;
}

// Drop the SendUserFile payloads embedded on an entry's blocks — the base64
// data: URI of an image, the raw markup of an HTML preview — leaving the
// name-only chip the chat already renders for a delivery it can't preview
// (chat.js renderToolFiles: anything that isn't a valid image/html src). `shed`
// marks it as dropped-for-size rather than never-captured, so the stored .jsonl
// stays honest about what happened to it. Mutates the entry in place; it was
// parsed out of this one request body and is written straight after.
function shedFilePayloads(entry) {
  let dropped = 0;
  const blocks = entry && Array.isArray(entry.blocks) ? entry.blocks : [];
  for (const b of blocks) {
    if (!b || !Array.isArray(b.files)) continue;
    for (const f of b.files) {
      if (!f || typeof f !== "object") continue;
      for (const key of ["src", "html"]) {
        if (typeof f[key] !== "string" || !f[key]) continue;
        dropped += Buffer.byteLength(f[key]);   // bytes, not UTF-16 units
        delete f[key];
        f.kind = "file";
        f.shed = true;
      }
    }
  }
  return dropped;
}

// Rate-limited operator warning: a full store is a standing condition, so it
// would otherwise print once per delta of every transcript, every sync pass.
let lastFullWarnAt = 0;
function warnArchiveFull(total) {
  const now = Date.now();
  if (now - lastFullWarnAt < 60 * 60 * 1000) return;
  lastFullWarnAt = now;
  console.error(
    `archive is full: ${total} bytes stored, ceiling ${ARCHIVE_TOTAL_MAX} ` +
    `(ARCHIVE_TOTAL_MAX_BYTES) — refusing new deltas so ${ARCHIVE_DIR}'s volume ` +
    `stays writable for the hub's own state`);
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
  let row = db.prepare(
    "SELECT bytesStored, archiveBytes, filePath FROM sessions WHERE transcriptId=?"
  ).get(transcriptId);
  // Someone deleted this transcript's file out from under the index. Forget it
  // and take the push as a fresh one rather than appending onto a hole.
  if (row && row.bytesStored > 0 && forgetMissingTranscript(transcriptId, row.filePath)) {
    row = undefined;
  }
  const have = row ? row.bytesStored : 0;
  // Store full: hand back the cursor we already hold and store nothing. Not an
  // error status — the agent must read this as "no progress" and move on, never
  // as a chunk to retry (XERK-267).
  if (ARCHIVE_TOTAL_MAX && totalArchiveBytes() >= ARCHIVE_TOTAL_MAX) {
    // Deleted archives are the way out of a full store, so give them back
    // before refusing — else the ceiling is measured against bytes that are no
    // longer there and no amount of deleting reopens it.
    reconcileMissingFiles();
    const total = totalArchiveBytes();
    if (total >= ARCHIVE_TOTAL_MAX) {
      warnArchiveFull(total);
      return { bytesStored: have, full: true };
    }
  }
  if (Number(startOffset) !== have) return { bytesStored: have };
  // The cursor only ever moves forward. Without this an endOffset BELOW
  // startOffset rewound bytesStored, and the next chunk re-ingested a range
  // already stored — duplicating it in the canonical .jsonl, the msgCount and
  // the FTS index at once. This store is the durable record that outlives the
  // host, so a corruption here is not recoverable from the agent (XERK-235).
  // The upper bound matters as much as the lower one. bytesStored goes into a
  // SQLite INTEGER column, so an endOffset past 2^53 is stored faithfully and
  // then throws "Value is too large to be represented as a JavaScript number"
  // on every subsequent read — bricking that transcript's ingest permanently,
  // with the poison chunk left as its last archived content. The agent chooses
  // transcriptId, so one misbehaving agent could brick any of them.
  const end = Number(endOffset);
  if (!Number.isFinite(end) || end < have || end > MAX_TRANSCRIPT_BYTES) {
    return { bytesStored: have };
  }

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
  // What this transcript's .jsonl already costs us, and whether that has taken
  // it past its budget. Sticky once crossed — the rest of the conversation sheds
  // rather than every other chunk flipping, so a reader sees one clean cutover.
  let archiveBytes = (row && row.archiveBytes) || 0;
  let shed = ARCHIVE_TRANSCRIPT_MAX > 0 && archiveBytes >= ARCHIVE_TRANSCRIPT_MAX;
  let shedBytes = 0;

  tx(() => {
    let lines = "";
    for (const e of list) {
      const text = String(e.text || "");
      // Persist the rich blocks[] (thinking / tool_use / tool_result /
      // task_notification) so the archive renders identically to a live session;
      // omitted for legacy text-only pushes so those lines stay byte-identical.
      // The FTS index still keys on `text` only (search scope unchanged).
      const rec = { uuid: e.uuid || null, role: e.role || null, ts: e.ts || null, text };
      if (Array.isArray(e.blocks) && e.blocks.length) rec.blocks = e.blocks;
      if (shed) shedBytes += shedFilePayloads(rec);
      const line = JSON.stringify(rec) + "\n";
      lines += line;
      // Budget checked per ENTRY, not per chunk: one 8 MiB delta can carry the
      // whole overshoot on its own, so waiting for the next chunk to notice
      // would store the very thing the ceiling exists to refuse.
      archiveBytes += Buffer.byteLength(line);
      if (ARCHIVE_TRANSCRIPT_MAX > 0 && archiveBytes >= ARCHIVE_TRANSCRIPT_MAX) shed = true;
      insert.run(text, transcriptId, e.uuid || null, e.role || null, e.ts || null);
    }
    if (lines) fs.appendFileSync(paths.jsonl, lines);
    db.prepare(`INSERT INTO sessions(
        transcriptId, host, remoteKey, repo, worktree, slug, createdAt, endedTs,
        summary, msgCount, bytesStored, archiveBytes, filePath, updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(transcriptId) DO UPDATE SET
        host=excluded.host, remoteKey=excluded.remoteKey, repo=excluded.repo,
        worktree=excluded.worktree, slug=excluded.slug,
        createdAt=COALESCE(excluded.createdAt, sessions.createdAt),
        endedTs=excluded.endedTs, summary=COALESCE(excluded.summary, sessions.summary),
        msgCount=excluded.msgCount, bytesStored=excluded.bytesStored,
        archiveBytes=excluded.archiveBytes,
        filePath=excluded.filePath, updatedAt=excluded.updatedAt`).run(
      transcriptId, host, meta.remoteKey || null, meta.repo || null,
      meta.worktree || null, meta.slug || null, meta.createdAt || null,
      meta.endedTs || null, meta.summary || null, msgCount, bytesStored,
      archiveBytes, relPath, nowIso
    );
  });
  if (shedBytes) {
    console.error(
      `archive: ${transcriptId} is over its ${ARCHIVE_TRANSCRIPT_MAX}-byte budget ` +
      `(ARCHIVE_TRANSCRIPT_MAX_BYTES); dropped ${shedBytes} bytes of inline file ` +
      `previews from this delta`);
  }

  writeSidecar(paths.meta, {
    transcriptId, host, remoteKey: meta.remoteKey || null, repo: meta.repo || null,
    worktree: meta.worktree || null, slug: meta.slug || null,
    createdAt: meta.createdAt || null, endedTs: meta.endedTs || null,
    summary: meta.summary || null, msgCount, bytesStored, archiveBytes,
    updatedAt: nowIso,
  });

  // `shed` tells the agent this transcript is over budget so it stops putting
  // the payloads on the wire at all; the hub sheds regardless, since an agent
  // too old to read the flag still pushes them.
  return shed ? { bytesStored, shed: true } : { bytesStored };
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

// The budget state the heartbeat reply carries back beside archiveHave (XERK-267):
// which of these transcripts have already spent their per-transcript budget, and
// whether the store as a whole is full. It lets the agent shed BEFORE the bytes
// go on the wire and skip a push that could only be refused — but it is an
// optimisation, not the enforcement: ingestChunk applies both ceilings itself,
// because an agent too old to read either flag keeps pushing regardless.
function archiveLimits(ids) {
  openDb();
  const shed = [];
  const list = Array.isArray(ids) ? ids : [];
  if (ARCHIVE_TRANSCRIPT_MAX > 0 && list.length) {
    // One query for the over-budget set, intersected in JS, rather than a point
    // lookup per manifest entry: this runs on every heartbeat of every host, a
    // manifest carries up to ARCHIVE_MANIFEST_MAX (200) ids, and in the ordinary
    // case the over-budget set is empty.
    const over = new Set(db.prepare(
      "SELECT transcriptId FROM sessions WHERE archiveBytes >= ?"
    ).all(ARCHIVE_TRANSCRIPT_MAX).map((r) => r.transcriptId));
    for (const id of list) if (over.has(id)) shed.push(id);
  }
  let full = !!(ARCHIVE_TOTAL_MAX && totalArchiveBytes() >= ARCHIVE_TOTAL_MAX);
  if (full) {
    // Reconcile HERE too, not only in ingestChunk: a `full` verdict makes the
    // agent skip the push entirely, so ingest would never run again to notice
    // that the operator has since deleted archives — the store would stay full
    // forever on the strength of files that no longer exist.
    reconcileMissingFiles();
    full = totalArchiveBytes() >= ARCHIVE_TOTAL_MAX;
  }
  return { shed, full };
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
      createdAt, endedTs, msgCount
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
      if (e && typeof e === "object") entries.push({
        uuid: e.uuid, role: e.role, ts: e.ts, text: e.text || "",
        blocks: Array.isArray(e.blocks) ? e.blocks : [],
      });
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
      summary, msgCount, bytesStored, archiveBytes, filePath, updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const jsonl of files) {
    const meta = readSidecar(jsonl + ".meta") || {};
    const transcriptId = meta.transcriptId;
    if (!transcriptId) continue; // can't attribute without the sidecar
    const relPath = path.relative(ARCHIVE_DIR, jsonl);
    let raw = "";
    try { raw = fs.readFileSync(jsonl, "utf8"); } catch { /* empty */ }
    // From the file, not the sidecar: this is what the budgets spend, so it has
    // to be what's actually on disk even if a sidecar is stale or predates the
    // field (every pre-XERK-267 archive has none).
    const archiveBytes = Buffer.byteLength(raw);
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
        msgCount, meta.bytesStored || 0, archiveBytes, relPath,
        meta.updatedAt || null);
    });
  }
  return files.length;
}

module.exports = {
  ARCHIVE_DIR, ARCHIVE_DB, ARCHIVE_TRANSCRIPT_MAX, ARCHIVE_TOTAL_MAX,
  slugify, archiveRelPath, ftsQuery, byteCeiling, shedFilePayloads,
  openDb, closeDb, rebuildIndex,
  ingestChunk, manifestCursors, archiveLimits,
  reconcileMissingFiles, __resetReconcileClock,
  searchArchive, listArchive, getTranscript,
};
