// turma archive — durable, searchable store of ended-session transcripts.
//
// The hub pulls each INACTIVE session's transcript in from the agent that owns
// it (agents are outbound-only, so the agent pushes; see hub-agent.py
// _archive_deltas) and lands it here, independent of the live fleet state. That
// makes history survive a host being wiped, offline, or decommissioned, and
// makes search instant (local FTS, no per-keystroke fan-out).
//
// Three layers:
//   1. CANONICAL = organized files on disk, under ARCHIVE_DIR, one folder per
//      repo, each file renamed + dated:
//        <repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl
//      The .jsonl holds the shipped, displayable entries (one {uuid,role,ts,text}
//      per line — the same subset the rest of Turma renders); a tiny sidecar
//      <file>.meta carries the session metadata + the raw-byte sync cursor, so
//      the whole store is self-describing and the index can be rebuilt from it.
//   2. RAW = a byte-for-byte copy of the session's own files, beside the layer
//      above in `<that file>.raw/` (XERK-338). Layer 1 is a PROJECTION — one
//      rendered line per displayable entry — so everything Claude Code wrote
//      that Turma does not render today is gone the moment the host is wiped:
//      the model, the token counts, tool-call ids, the hook records, the
//      `tool-results/` overflow files, the workflow run records. That is exactly
//      the material a later feature would want, and it cannot be recovered
//      after the fact, so the raw bytes are kept whether or not anything reads
//      them yet. See `ingestRaw` for the layout and the append-only rule.
//   3. INDEX = a node:sqlite (Node core, no npm) DB: a `sessions` table for fast
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
// token-only. 3: added archiveBytes (the budget below reads it). 4: added
// rawBytes, the same for the raw layer (XERK-338). 5: added siteKey — the
// owner's org, which gates a cross-host row RE-POINT so one host cannot corrupt
// or re-attribute another's archived transcript (XERK-344). A bump recreates the
// tables and refills them from the files (an old sidecar has no siteKey, so a
// rebuilt row's is NULL — see the ownership gate in ingestChunk).
const SCHEMA_VERSION = 5;

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
  // An EXPLICIT whitespace set, not .trim(): String.trim() and Python's
  // str.strip() disagree about the edges — JS strips U+FEFF and Python doesn't,
  // Python strips U+0085 and U+001C-1F and JS doesn't. A BOM in front of the
  // value is an ordinary copy-paste accident, and under .trim() it gave the hub
  // 16 where the agent read 16 MiB (or the reverse), which is the fleet-wide
  // preview strip the digits-only rule exists to prevent.
  const s = String(raw == null ? "" : raw).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (!/^[0-9]+$/.test(s)) return fallback;
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

// Per-transcript ceiling on the RAW layer (XERK-338), covering the conversation
// file AND its whole session directory together. Sized against the reference
// host, where 336 transcripts plus their nested files total 53 MB and the
// largest single session directory is 7.6 MB — so nothing real approaches this,
// and what it actually stops is a pathological `tool-results/` tree quietly
// taking the store's whole budget for one session. Past it that transcript's
// raw sync stops; the rendered layer is unaffected, so the session stays
// readable and searchable. `0` disables, like the ceilings above.
//
// There is deliberately NO separate STORE-wide raw ceiling: ARCHIVE_TOTAL_MAX
// exists to keep this volume writable for the hub's own state.json, and a
// second budget beside it could not do that — two ceilings that each pass
// individually still fill the disk together.
const ARCHIVE_RAW_TRANSCRIPT_MAX = byteCeiling(
  process.env.ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES, 128 * 1024 * 1024);
// The per-beat WORK budget for the raw-cursor loop, in TWO terms: one unit per
// file the manifest offers PLUS one per manifest entry whose row it looks up (the
// lookup is real work and is charged too — see rawCursors, QA F4). Split into two
// knobs so each mirrors the agent cap it bounds and their SUM is the true worst
// case a well-behaved agent presents (XERK-427).
//
// `rawCursors` is synchronous and runs on the heartbeat path, and the hub is one
// event loop — so this spends the same hub-wide-stall budget the store-total walk
// is sized against (14 ms there). Measured at ~5.6 us per stat: 2,000 files is
// ~11 ms, where the 40,000 an agent may offer under its OWN caps is 223 ms and the
// ~780,000 that fit in a 32 MiB HEARTBEAT_MAX is ~4.4 SECONDS of blocked loop —
// per beat, per host, with every dashboard, SSE tail and other host's beat queued
// behind it.
//
// ARCHIVE_RAW_CURSOR_MAX mirrors the agent's ARCHIVE_RAW_MANIFEST_FILES_MAX (2000
// FILES); ARCHIVE_RAW_CURSOR_LOOKUP_MAX mirrors its ARCHIVE_MANIFEST_MAX (200
// ENTRIES). The agent's caps are NOT this bound — a bound the receiving path does
// not enforce is not a bound (XERK-235). Past the SUM the extra offers get no
// cursor, which the agent reads as zero and pushes from the start — refused by
// `ingestRaw`'s offset check, so the stored data is safe and the cost is one small
// wasted POST per over-budget file per pass. Sizing the budget for FILES alone (the
// pre-XERK-427 bug) charged the N entry lookups against it as well and truncated an
// in-cap agent by exactly its transcript count N — silently dropping the very
// backlog slice XERK-424 reserves. With the budget sized to the SUM, an agent
// inside its own caps never reaches it.
const ARCHIVE_RAW_CURSOR_MAX = positiveEnvInt("ARCHIVE_RAW_CURSOR_MAX", 2000);
const ARCHIVE_RAW_CURSOR_LOOKUP_MAX = positiveEnvInt("ARCHIVE_RAW_CURSOR_LOOKUP_MAX", 200);
// The same bound for the RENDERED layer's manifest, which is the costlier of the
// two (a SELECT + an INSERT per entry, against one stat). The agent sends at most
// ARCHIVE_MANIFEST_MAX (200); this is generous headroom over that and still ~35x
// under the point where the stall is measurable in seconds.
const ARCHIVE_MANIFEST_CURSOR_MAX = positiveEnvInt("ARCHIVE_MANIFEST_CURSOR_MAX", 2000);

// The suffix that marks a raw directory, so both walks below can tell one from a
// rendered archive without consulting the index.
//
// Recognised as `<name>.jsonl.raw` at depth > 0 ONLY, never as a bare `.raw`
// anywhere: a REPO FOLDER is a slugified repo name at depth 0, and a repo
// actually named `x.jsonl.raw` would otherwise have its whole archive skipped by
// the rebuild and mis-measured by the budget. Both halves are cheap; neither
// alone is airtight.
const RAW_DIR_SUFFIX = ".raw";
function isRawDir(name, depth) {
  return depth > 0 && name.endsWith(".jsonl" + RAW_DIR_SUFFIX);
}

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

// A positive-integer tunable. Deliberately NOT byteCeiling: that reads an explicit
// 0 as "ceiling off", which for a COUNT would mean statting without limit — the
// opposite of what a 0 here could ever be asking for.
function positiveEnvInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
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

// ---- the raw layer's paths --------------------------------------------------

// A session's files keep their own names inside `<canonical .jsonl>.raw/`, so
// the raw layer is browsable and greppable exactly as it was on the host:
//   <repo>/<date>__<summary>__<host>__<short>.jsonl.raw/<id>.jsonl
//   <repo>/<date>__<summary>__<host>__<short>.jsonl.raw/<id>/subagents/agent-x.jsonl
//   <repo>/<date>__<summary>__<host>__<short>.jsonl.raw/<id>/tool-results/b1.txt
// Beside the rendered file rather than in a store of its own so one folder per
// repo stays the whole organisation, and deleting a repo's archive takes its raw
// bytes with it — which is what makes the store total's WALK the honest measure
// of both layers at once.
function rawDirFor(relPath, transcriptId) {
  // Keyed on the FULL transcript id, not the canonical file name. That name
  // carries only the first 8 alnum characters of the id, so two transcripts
  // agreeing on repo/date/summary/host and that prefix share one canonical file
  // — and, without this, one raw directory: each one's `/raw` listing returned
  // the OTHER's files, and the read-back route served them (XERK-338 QA D6, hit
  // accidentally by a QA fixture, and `transcriptId` is agent-chosen so it can
  // be forced). The id is allowlisted `[A-Za-z0-9._-]+` at the route before it
  // reaches here, and re-checked here so no other caller can widen that.
  const id = String(transcriptId || "");
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") return null;
  return filePaths(relPath).jsonl + RAW_DIR_SUFFIX + path.sep + id;
}

// The most components a session-relative path may have, and the most bytes.
// Claude Code's deepest today is `<id>/subagents/workflows/wf_<run>/agent-x.jsonl`
// at 5; the headroom is for a shape it grows later, not for anything to lean on.
const RAW_REL_DEPTH_MAX = 10;
const RAW_REL_LEN_MAX = 400;
// Per COMPONENT, because 400 total is not the binding limit: every common
// filesystem caps one name at 255 bytes, so a longer component passed the
// allowlist and then failed at the syscall with ENAMETOOLONG — an unthrottled
// error line per attempt, per beat, forever (XERK-338 QA D10). Refusing it here
// makes it one quiet skip instead, and the file was never storable either way.
const RAW_REL_COMPONENT_MAX = 255;

/**
 * Validate an agent-supplied, session-relative file path. Returns the normalized
 * path or null.
 *
 * This is the one thing between a heartbeating agent and an arbitrary write
 * anywhere the hub can reach, so it is an ALLOWLIST on every component rather
 * than a search for `..`: a component is `[A-Za-z0-9._-]+` and is never `.` or
 * `..`, which leaves nothing that can name a parent, an absolute path, a
 * Windows drive or a UNC share whatever the platform's separator rules are.
 * The caller still re-checks the joined result against the raw directory — the
 * allowlist is the guarantee, that check is the proof it held.
 */
function safeRawRel(rel) {
  const s = String(rel == null ? "" : rel);
  if (!s || s.length > RAW_REL_LEN_MAX) return null;
  const parts = s.split("/");
  if (!parts.length || parts.length > RAW_REL_DEPTH_MAX) return null;
  for (const p of parts) {
    if (!p || p === "." || p === "..") return null;
    if (Buffer.byteLength(p) > RAW_REL_COMPONENT_MAX) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(p)) return null;
  }
  return parts.join("/");
}

// The absolute path one raw file lands at, or null if `rel` is not nameable.
function rawFilePath(relPath, transcriptId, rel) {
  const safe = safeRawRel(rel);
  if (!safe) return null;
  const dir = rawDirFor(relPath, transcriptId);
  if (!dir) return null;
  // safeRawRel has already made every component a plain token, so this cannot
  // escape `dir`; the check below is the belt to that braces.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const full = path.join(dir, safe);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return full;
}

// ---- the object-store mirror sink (XERK-759) --------------------------------
//
// Under HA the archive's byte layers are mirrored to object storage as the
// of-record (archive-mirror.js). This module STAYS synchronous and filesystem-
// native on its hot path; the only coupling is this optional sink, called with
// the ABSOLUTE path of each durable file the moment it is written. The sink just
// records the path (sync, cheap) for an off-beat worker to push — nothing here
// dials the network. UNSET (the default, and every non-HA path) makes this a
// no-op, so the single-process behaviour is byte-identical.
let blobSink = null;
function setBlobSink(fn) {
  blobSink = typeof fn === "function" ? fn : null;
}
function noteWrite(absPath) {
  // Never let a mirror bookkeeping error break a durable write (XERK-235).
  if (blobSink) { try { blobSink(absPath); } catch { /* best-effort */ } }
}

// ---- the Postgres INDEX mirror sink (XERK-780) ------------------------------
//
// Under HA the archive's searchable index has a shared Postgres OF-RECORD (server.js
// wires this sink to an IndexMirror over pgclient). This module stays synchronous and
// node:sqlite-native on its hot path; the ONLY coupling is this optional sink, called
// after each durable index mutation with a SNAPSHOT of what changed. The sink just
// enqueues (sync, cheap) for an off-beat worker to upsert to Postgres — nothing here
// dials the network. UNSET (the default, and every non-HA path) makes this a no-op,
// so the single-process behaviour is byte-identical.
//
// A session mutation mirrors the FULL row (mirrorSession re-reads it), so the
// Postgres upsert never clobbers a metadata column the mutation didn't touch; the
// monotonic byte/count columns are GREATEST-merged there, never lowered. Entries are
// mirrored append-only by ordinal (idempotent) or replaced wholesale on a reconcile.
let indexSink = null;
function setIndexSink(sink) {
  indexSink = sink && typeof sink === "object" ? sink : null;
}
// Mirror the FULL current SQLite session row for `transcriptId`. Best-effort — a
// mirror hiccup must never break the durable local write (XERK-235).
function mirrorSession(transcriptId) {
  if (!indexSink || typeof indexSink.session !== "function") return;
  try {
    const row = db.prepare(`SELECT transcriptId, host, siteKey, remoteKey, repo, worktree,
        slug, createdAt, endedTs, summary, msgCount, bytesStored, archiveBytes, rawBytes,
        filePath, updatedAt FROM sessions WHERE transcriptId=?`).get(transcriptId);
    if (row) indexSink.session(row);
  } catch { /* best-effort mirror */ }
}
// Mirror newly-appended entries at ordinals [startSeq, startSeq+n). `list` is the
// raw entry objects; only the FTS-indexed {uuid,role,ts,text} projection is mirrored,
// matching what the SQLite entries_fts holds.
function mirrorEntries(transcriptId, list, startSeq) {
  if (!indexSink || typeof indexSink.entries !== "function" || !list || !list.length) return;
  try {
    indexSink.entries(transcriptId, list.map((e) => ({
      uuid: e.uuid || null, role: e.role || null, ts: e.ts || null, text: String(e.text || ""),
    })), startSeq);
  } catch { /* best-effort mirror */ }
}
// Mirror a wholesale replacement of a transcript's entries (the reconcile heal).
function mirrorReplace(transcriptId, list) {
  if (!indexSink || typeof indexSink.replace !== "function") return;
  try {
    indexSink.replace(transcriptId, (list || []).map((e) => ({
      uuid: e.uuid || null, role: e.role || null, ts: e.ts || null, text: String(e.text || ""),
    })));
  } catch { /* best-effort mirror */ }
}

// ---- database ---------------------------------------------------------------

let db = null;

function createSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions(
     transcriptId TEXT PRIMARY KEY,
     host TEXT, siteKey TEXT, remoteKey TEXT, repo TEXT, worktree TEXT, slug TEXT,
     createdAt TEXT, endedTs TEXT, summary TEXT,
     msgCount INTEGER DEFAULT 0, bytesStored INTEGER DEFAULT 0,
     archiveBytes INTEGER DEFAULT 0, rawBytes INTEGER DEFAULT 0,
     filePath TEXT, updatedAt TEXT)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
     text, transcriptId UNINDEXED, uuid UNINDEXED, role UNINDEXED, ts UNINDEXED)`);
  // filePath is looked up by VALUE on first-sight to detect a canonical-name
  // collision (resolveNewRelPath, XERK-277). Not a UNIQUE index — a collided
  // file that predates the fix legitimately has two rows on one path, and a
  // UNIQUE would make rebuildIndex throw over the existing store rather than
  // re-derive it. Created outside the schema bump so an already-open DB gains it.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_filePath ON sessions(filePath)`);
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

// ---- boot/hydrate serialization + corrupt-cache self-heal (XERK-789) --------
// The local node:sqlite index is a DISPOSABLE per-replica hot cache (HA, XERK-780).
// Under HA it is HYDRATED from the Postgres of-record on boot/promotion WHILE the
// server is already accepting archive ingest. Both the async paged hydrate
// (`indexLoader`) and a live `ingestChunk` write the SAME single `DatabaseSync`
// handle, and the hydrate `await`s each Postgres page — so an ingest `tx()`
// interleaves with the hydrate's bulk fts5 writes / its `reset()` DELETE at every
// await point and physically CORRUPTS `entries_fts` ("database disk image is
// malformed" / "fts5: corruption found reading blob …"), after which every later
// ingest on that replica fails. Two guards, both no-ops off HA:
//   1. `hydrating` — set around the index hydrate (server.js `hydrateArchiveIndex`);
//      the ingest ROUTES refuse with a 503 "still syncing" (the documented read
//      behaviour, extended to writes) rather than write the cache concurrently.
//      Set true only while a hydrate runs, so a non-HA hub (no hydrate) never sees it.
//   2. `resetLocalIndex()` — the cache being disposable, a corruption is recovered
//      by DELETING the index.db file (+ its -wal/-shm) and rebuilding from the local
//      `.jsonl` files (themselves hydrated from the S3 of-record), NOT by reopening
//      the corrupt file — which is exactly what the old fallback did, so it failed
//      identically. Callers detect a corruption with `isSqliteCorruption`.
let hydrating = false;
function isHydrating() { return hydrating; }
function setHydrating(v) { hydrating = !!v; }
function isSqliteCorruption(e) {
  // "database disk image is malformed" (SQLITE_CORRUPT), "fts5: corruption found …"
  // (SQLITE_CORRUPT_VTAB), AND "file is not a database" (SQLITE_NOTADB) — a
  // zeroed/header-corrupt index.db surfaces as NOTADB, which must also self-heal
  // rather than 500-loop or reopen the dead file (XERK-789 QA).
  return !!e && /\b(malformed|corrupt|corruption|fts5|not a database|notadb)\b/i
    .test(String((e && e.message) || e));
}
// Drop the corrupt local cache FILE (not just the handle) and reopen fresh, so
// `openDb()` rebuilds it from the on-disk `.jsonl` files (a fresh DB has zero
// sessions → `openDb` runs `rebuildIndex`). Fully SYNCHRONOUS (closeDb + unlink +
// openDb all in one tick), so no other write interleaves during the reset, and a
// concurrent ingest cannot race the rebuild. Best-effort unlink: an absent
// -wal/-shm is fine; a genuinely unremovable main file surfaces on the reopen.
function resetLocalIndex() {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(ARCHIVE_DB + suffix); } catch { /* absent/raced is fine */ }
  }
  return openDb();
}

// PROACTIVELY verify the FTS5 index is not corrupt (XERK-791). A bulk-hydrate or
// concurrent-writer corruption of `entries_fts` is otherwise LATENT — the physical
// damage sits unnoticed until the first later ingest or search hits "database disk
// image is malformed" / "fts5: corruption found …", after which that replica's
// archive silently stops until the reactive self-heal fires (the prod symptom). Run
// right after a hydrate — while the index is still `hydrating` and serving nothing —
// so the caller can reset-and-rebuild at a CONTROLLED point rather than have a random
// live request discover it. Returns true when healthy, false on a detected
// corruption (the caller then `resetLocalIndex()`s). Uses FTS5's own internal
// consistency verb (`'integrity-check'`, which raises SQLITE_CORRUPT_VTAB on a
// damaged index) plus a bounded MATCH that exercises the segment b-tree read path
// the insert-side check does not fully touch. An UNEXPECTED (non-corruption) error is
// re-thrown — it is not evidence to blow the cache away. Cheap on a healthy index (an
// O(index) internal scan, run once per hydrate, off no hot path).
function checkIndexIntegrity() {
  openDb();
  try {
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')");
    db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH ? LIMIT 1").get("a");
    return true;
  } catch (e) {
    if (isSqliteCorruption(e)) return false;
    throw e;
  }
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
  noteWrite(metaPath);
}

// Bytes the whole store holds, measured by WALKING THE FILES — never summed
// from the index.
//
// The ceiling this feeds exists to stop the archive filling the volume the
// hub's own state.json lives on, so the honest input is what is actually on
// that volume. An indexed total has to be kept in step with the disk, and every
// way of doing that means inferring "the operator deleted this" from a failed
// stat — which is not reliably knowable: an unmounted volume, a renamed parent
// and a real deletion all report ENOENT, while EACCES/EIO/ESTALE report neither.
// Guessing wrong in one direction wedges the ceiling shut; in the other it
// drops a live transcript's row, and since ingest APPENDS, the re-push writes a
// SECOND copy of the conversation into a file that was there all along. Walking
// the files needs no such guess: deleting archives frees bytes because the
// bytes are gone, and nothing has to notice.
//
// An unreadable ARCHIVE_DIR measures 0, i.e. "not full" — so a store whose
// directory was removed outright recreates it and carries on, rather than
// latching full forever with no way back.
//
// The walk is CACHED, because it runs on the heartbeat path and is synchronous:
// 14 ms over the reference host's ~1,300 files (~7 us/file warm on that pool),
// and the whole hub is one event loop, so every beat and SSE tail waits on it.
//
// ...but a cached total alone is NOT the ceiling's input, because a frozen
// number means ingest is unmetered between refreshes: measured 4.85 GiB written
// past a 4 MiB ceiling in one cache window, the exact outcome the ceiling
// exists to prevent. So the walk is only the BASELINE, and every byte appended
// since it is added on top (`writtenSinceWalk`). That keeps the two properties
// that matter at once — overshoot is bounded by ONE chunk, as it would be with
// an exactly-maintained counter, and a deletion still frees its bytes at the
// next walk without anyone having to detect a deletion.
//
// Growth is therefore exact and only DELETION is stale, which is why the window
// can be minutes rather than seconds: a deletion is an operator freeing space,
// and waiting one window to see it costs nothing.
let totalCache = { at: 0, bytes: 0 };
let writtenSinceWalk = 0;
const TOTAL_CACHE_MS = 5 * 60 * 1000;
// While the store reads FULL, re-measure far more often. Precision is worth
// most exactly then — ingest is refusing anyway, so a walk costs no throughput,
// and this is what bounds how long an operator waits after freeing space.
const FULL_RECHECK_MS = 30 * 1000;

// XERK-332: reclaim index.db when the store has been wiped. The index holds a
// `sessions` row and the FTS entries for EVERY transcript, and nothing reaps
// them when a `.jsonl` is DELETED off disk — so a store that is repeatedly
// filled and wiped grows the index without bound (measured 61x the ceiling
// after 38 fill/wipe cycles), and a restart does not help (openDb rebuilds only
// on a schema bump or an EMPTY `sessions` table, and a wipe leaves the rows
// behind so the table is never empty). The store walk below already enumerates
// every rendered file each window, so it is the natural, near-free trigger:
// when it finds far fewer files than the index has FILED rows, the difference is
// transcripts an operator deleted, and rebuildIndex() + VACUUM reaps them (see
// maybeReclaimIndex).
//   - A large ABSOLUTE gap so a tiny store's collision-doubles or raced deletes
//     never trip it (a store below this floor keeps a small, bounded index).
//   - "Far fewer files than rows" so the rebuild only runs when the SURVIVING
//     store is small, which is what bounds its cost — it re-reads only the files
//     still on disk, ~0 after a full wipe (the case the ticket measured).
const ARCHIVE_INDEX_RECLAIM_MIN_GAP =
  positiveEnvInt("ARCHIVE_INDEX_RECLAIM_MIN_GAP", 64);
// Belt-and-braces against churn: a reclaim drops the gap to zero, so it is
// single-shot per wipe already, but bound it so nothing re-firing during an
// abnormal walk can rebuild in a tight loop on the one event loop.
const RECLAIM_MIN_INTERVAL_MS = 60 * 1000;
let lastReclaimAt = 0;

// The archive's own per-transcript bytes under ARCHIVE_DIR: the `.jsonl` files.
//
// NOT `index.db`. It lives in this directory and is genuinely large — a second
// full copy of every entry's text (`entries_fts` is FTS5 with no `content=`),
// plus a WAL, measured at ~2.4x the .jsonl total — so counting it looks like the
// more honest measure of the volume. It is not, because the ceiling is enforced
// by REFUSING INGEST, and refusing ingest does not shrink a database. Counted,
// it produced a store that could never be reopened: an operator who deleted
// every transcript was still full, because the db and its WAL alone exceeded the
// ceiling, and nothing reaps rows for a deleted file or VACUUMs (measured: 84
// ingest attempts over 421s still refused, capacity per fill/delete cycle
// ratcheting 429 transcripts down to 4). A budget may only bound what its
// enforcement can actually reclaim.
//
// So the index is OVERHEAD the operator sizes the volume for, not budget, and it
// is ~3x the ceiling at first fill (measured 3.0-3.2x). It was ALSO unbounded
// across fill/wipe cycles — nothing reaps a deleted file's rows and openDb
// rebuilds only on a schema bump or an empty table, so a repeatedly-filled-and-
// wiped store grew the index ~13 MB per cycle to 61x the ceiling by cycle 38,
// with the .jsonl total pinned at the ceiling throughout and a restart not
// reclaiming it. That is now capped: `maybeReclaimIndex` reaps the deleted rows
// and VACUUMs off this same store walk when far fewer files than rows remain
// (XERK-332). Size the volume for the ~3x first-fill overhead; the churn no
// longer accumulates. The `.meta` sidecars are uncounted too: 267 bytes each,
// bounded by transcript count, and rewritten in place rather than grown.
//
// A subdirectory we cannot read is SKIPPED, not fatal. It costs us that subtree
// (an under-measure, which the ceiling errs toward anyway), where letting it
// propagate froze the whole store: one over-long path or one root-owned
// directory left the baseline latched and no deletion ever seen again. Only a
// failure to read ARCHIVE_DIR ITSELF is a failed measurement — that is the whole
// store being unreadable, not one corner of it.
//
// "Costs us that subtree" is one-time only while the subtree is also unwritable,
// which is the realistic case (a root-owned 0700 folder fails both readdir and
// append; a 0755 one readdirs fine). Unreadable-but-WRITABLE — mode 0333, or an
// ACL — under-measures without bound instead, since each walk both misses those
// bytes and zeroes the charge that would have carried them.
// `stats` (optional) accumulates, ALONGSIDE the byte total, the two facts the
// XERK-332 index reclaim needs off this same walk: `files`, the count of
// rendered `.jsonl` transcripts on disk (one per `sessions` row), and `partial`,
// set whenever a directory could not be read. A `partial` walk under-counts
// files, so the reclaim MUST NOT act on it — dropping live rows for a
// transiently-unmounted volume would, since ingest appends, duplicate the
// conversation on re-push (the XERK-280 hazard).
function walkJsonlBytes(dir, depth, stats) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // ENOENT at the root is the store genuinely absent: 0 is right, and is what
    // lets a removed directory be recreated instead of latching full forever.
    if (depth === 0 && e.code !== "ENOENT") throw e;
    // But the file count is now an UNDER-count — the root vanished mid-life
    // (unmounted/renamed, not a fresh empty store) or a subtree was skipped — so
    // mark the walk untrustworthy for the reclaim.
    if (stats) stats.partial = true;
    return 0;
  }
  let bytes = 0;
  for (const d of names) {
    // d.name is a single readdirSync entry (never contains a separator), so
    // this stays inside `dir` — a recursive walk of our own ARCHIVE_DIR.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      // Inside a raw directory EVERY regular file counts, whatever it is named:
      // a session's own files are `.jsonl`, `.json` and `.txt` (the
      // `tool-results/` overflow), and counting only `.jsonl` there would leave
      // most of the raw layer's bytes outside the ceiling that exists to keep
      // this volume writable (XERK-338). Raw files are NOT `sessions` rows, so
      // they are never counted into `stats.files`.
      bytes += isRawDir(d.name, depth)
        ? walkAllBytes(full) : walkJsonlBytes(full, depth + 1, stats);
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      // One unreadable file must not abandon the measurement and hand back a
      // total far under the truth — skip it and keep counting. An ENOENT is a
      // raced delete (the honest signal the reclaim looks for); any other stat
      // failure is an under-count that, like a skipped directory, must not drive
      // the reclaim.
      try { bytes += fs.statSync(full).size; if (stats) stats.files++; }
      catch (e) { if (stats && e && e.code !== "ENOENT") stats.partial = true; }
    }
  }
  return bytes;
}

// Every regular file under one raw directory. Same failure posture as the walk
// above — an unreadable corner costs its subtree rather than the measurement.
function walkAllBytes(dir) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let bytes = 0;
  for (const d of names) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const full = path.join(dir, d.name);
    if (d.isDirectory()) bytes += walkAllBytes(full);
    else if (d.isFile()) { try { bytes += fs.statSync(full).size; } catch { /* raced */ } }
  }
  return bytes;
}

// Bytes the whole store holds, measured by WALKING THE FILES — never summed
// from the index.
//
// The ceiling this feeds exists to stop the archive filling the volume the
// hub's own state.json lives on, so the honest input is what is actually on
// that volume. An indexed total has to be kept in step with the disk, and every
// way of doing that means inferring "the operator deleted this" from a failed
// stat — which is not reliably knowable: an unmounted volume, a renamed parent
// and a real deletion all report ENOENT, while EACCES/EIO/ESTALE report neither.
// Guessing wrong in one direction wedges the ceiling shut; in the other it
// drops a live transcript's row, and since ingest APPENDS, the re-push writes a
// SECOND copy of the conversation into a file that was there all along. Walking
// the files needs no such guess: deleting archives frees bytes because the
// bytes are gone, and nothing has to notice.
//
// The walk is CACHED, because it runs on the heartbeat path and is synchronous:
// 14 ms over the reference host's ~1,300 files (~7 us/file warm on that pool),
// and the whole hub is one event loop, so every beat and SSE tail waits on it.
// Keep it synchronous — that is WHY the charge below cannot be interleaved with
// a walk; making it async buys 14 ms per window and opens that race.
//
// ...but a cached total alone is NOT the ceiling's input, because a frozen
// number means ingest is unmetered between refreshes: measured 4.85 GiB written
// past a 4 MiB ceiling in one cache window, the exact outcome the ceiling
// exists to prevent. So the walk is only the BASELINE, and every byte appended
// since it is added on top (`writtenSinceWalk`). That keeps the two properties
// that matter at once — overshoot is bounded by ONE chunk, as it would be with
// an exactly-maintained counter, and a deletion still frees its bytes at the
// next walk without anyone having to detect a deletion.
//
// Growth is therefore exact and only DELETION is stale, which is why the window
// can be minutes rather than seconds: a deletion is an operator freeing space,
// and waiting one window to see it costs nothing.
function totalArchiveBytes(now, maxAgeMs) {
  now = now || Date.now();
  const age = maxAgeMs === undefined ? TOTAL_CACHE_MS : maxAgeMs;
  if (now - totalCache.at < age) return totalCache.bytes + writtenSinceWalk;
  let bytes;
  const stats = { files: 0, partial: false };
  try {
    bytes = walkJsonlBytes(ARCHIVE_DIR, 0, stats);
  } catch (e) {
    // A measurement we FAILED to take is not a measurement of zero. Recording
    // it would re-baseline to nothing and zero the charge, so each such blip
    // would hand out a whole fresh ceiling — measured amplifying to 6.2x the
    // ceiling over five blips, silently, with the store reading full throughout.
    // Keep the last real baseline and let the charge keep accruing on top.
    // Advance the clock without touching the baseline: keep the last real
    // measurement, but do NOT retry on every single call. Left un-stamped this
    // re-walked per call — measured 20 synchronous walks per beat, on the one
    // event loop, at exactly the moment the filesystem is sick and slow.
    console.error(`archive: could not measure ${ARCHIVE_DIR} (${e.code || e.message}); ` +
      `keeping the previous total of ${totalCache.bytes} bytes`);
    totalCache = { at: now, bytes: totalCache.bytes };
    return totalCache.bytes + writtenSinceWalk;
  }
  totalCache = { at: now, bytes };
  writtenSinceWalk = 0;
  // The walk just enumerated every rendered transcript on disk, so this is the
  // one moment we cheaply know whether the index is holding rows for files an
  // operator has since deleted (XERK-332). Reclaim runs AFTER the cache is set —
  // it does not change the byte total, only the DB — so a caller's total is
  // unaffected whether or not it fires.
  maybeReclaimIndex(now, stats);
  return bytes;
}

// Reap the index rows (and their FTS entries) of transcripts that have been
// DELETED off disk, and VACUUM the freed pages back to the volume (XERK-332).
// Runs only off a fresh, CLEAN store walk, so it is bounded to once per walk
// window and never acts on an under-count. See ARCHIVE_INDEX_RECLAIM_MIN_GAP.
//
// This is on the heartbeat path (via totalForCeiling) and rebuildIndex is
// synchronous, but the trigger's "far fewer files than rows" condition means it
// only fires when the surviving store is SMALL — after a full wipe the rebuild
// re-reads ~0 files. At a pathological scale (hundreds of thousands of surviving
// files) the reindex is a longer synchronous stall, the same class as the walk
// itself and with the same future mitigation (walk/reclaim only near the ceiling
// rather than making it async); nothing real approaches it.
function maybeReclaimIndex(now, stats) {
  // Never act on a walk that skipped an unreadable directory or found the store
  // root gone: the file count is then an UNDER-count, and reclaiming on it would
  // drop live rows for a transiently-unmounted volume and, since ingest appends,
  // duplicate the conversation on re-push (XERK-280). Wait for a clean walk;
  // reclaim is never urgent. `db` is always open here in practice (every caller
  // openDb()s first), but a null handle has nothing to reap regardless.
  //
  // Accepted residual, the same ENOENT ambiguity walkJsonlBytes already lives
  // with: a lazy unmount that leaves ARCHIVE_DIR itself present-but-EMPTY (rather
  // than gone) reads files=0, partial=false, and is indistinguishable from a real
  // wipe — so if ARCHIVE_DB is on a SEPARATE surviving filesystem, its open
  // handle answers while the store reads empty, and the rows are reaped. Safe in
  // the default layout (ARCHIVE_DB lives UNDER ARCHIVE_DIR, and the k8s mount is a
  // PARENT of it, so an unmount is ENOENT → partial): it bites only a deployment
  // that makes ARCHIVE_DIR the exact mountpoint AND puts ARCHIVE_DB elsewhere.
  if (stats.partial || !db) return;
  if (now - lastReclaimAt < RECLAIM_MIN_INTERVAL_MS) return;
  let filedRows;
  try {
    filedRows = db.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE filePath IS NOT NULL").get().n;
  } catch { return; }   // an index hiccup must never break the heartbeat's walk
  // Orphans = rows that NAME a rendered file the walk did not find. Placeholder
  // rows (a manifest entry not yet filled by a chunk) have filePath NULL and are
  // excluded, so an initial bulk sync — many rows, few files yet — never reads
  // as a wipe.
  const orphans = filedRows - stats.files;
  if (orphans < ARCHIVE_INDEX_RECLAIM_MIN_GAP) return;
  if (stats.files * 2 >= filedRows) return;   // not "far fewer" — a small delete
  lastReclaimAt = now;
  try {
    const kept = rebuildIndex();   // drops the orphaned sessions + FTS rows
    db.exec("VACUUM");             // and returns the freed pages to the volume
    console.error(
      `archive: reclaimed index.db — ${orphans} rows for deleted transcripts ` +
      `dropped, ${kept} live transcripts reindexed and the file VACUUMed ` +
      `(XERK-332)`);
  } catch (e) {
    // Not fatal: a failed reclaim leaves the index oversized but correct, and
    // `lastReclaimAt` is already stamped so it won't retry-storm on the beat.
    console.error(`archive: index reclaim failed: ${e.code || e.message}`);
  }
}

// The ceiling's own read of the total: once it says full, re-measure on the
// short cadence so freeing space is noticed in seconds rather than minutes.
function totalForCeiling(now) {
  now = now || Date.now();
  // Read on the short cadence when the last answer was "full", so freeing space
  // is noticed in seconds. One call, not two: asking twice walked twice on the
  // beat that flipped it.
  const wasFull = ARCHIVE_TOTAL_MAX > 0 &&
    totalCache.bytes + writtenSinceWalk >= ARCHIVE_TOTAL_MAX;
  return totalArchiveBytes(now, wasFull ? FULL_RECHECK_MS : undefined);
}

// Test seam: drop the cache so a test observes a recovery without waiting out
// TOTAL_CACHE_MS, or seed it to put the total at an exact value the filesystem
// can't easily be coaxed into. Nothing in the serving path calls it.
function __resetTotalCache(seed) {
  writtenSinceWalk = 0;
  totalCache = seed === undefined ? { at: 0, bytes: 0 } : { at: Date.now(), bytes: seed };
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
// The text fields a delta's `meta` may carry, and the longest each is stored at.
// **Every one is agent-supplied and every one is BOUND INTO SQLITE**, which
// accepts only scalars: a `summary` that arrives as an object or an array throws
// "Provided value cannot be bound to SQLite parameter N", the route answers 500,
// and the agent — which cannot tell a poisoned transcript from a hub that is
// unwell — has that 500 to deal with on every beat (XERK-356 QA pass 2). A
// non-scalar is not text, so it is stored as nothing rather than as
// "[object Object]"; the length cap is the receiving half of the agent's own
// (a bound the receiving path does not enforce is not a bound, XERK-235).
const META_TEXT_MAX = 500;
const META_FIELDS = ["remoteKey", "repo", "worktree", "slug", "createdAt", "endedTs", "summary"];
function metaText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return null;      // arrays and objects are not text
  const s = String(v);
  return s ? s.slice(0, META_TEXT_MAX) : null;
}
function normalizeMeta(meta) {
  const out = {};
  for (const k of META_FIELDS) out[k] = metaText((meta || {})[k]);
  return out;
}

// The transcriptId that already OWNS a canonical relative path, or null if it is
// free (or owned by this same transcript). Used only on first-sight, to keep two
// different transcripts off one .jsonl (XERK-277).
//
// The sessions table is AUTHORITATIVE — it survives a `.jsonl` deleted out from
// under a row that keeps its filePath (XERK-280), where a disk-only check would
// call the path free and hand it to a second transcript, which then appends onto
// the surviving row's gap: the exact interleave this exists to stop. The disk
// sidecar is the backstop for an index that was wiped and has not rebuilt yet.
function relPathOwner(relPath, transcriptId) {
  const row = db.prepare("SELECT transcriptId FROM sessions WHERE filePath=?").get(relPath);
  if (row && row.transcriptId && row.transcriptId !== transcriptId) return row.transcriptId;
  const sc = readSidecar(filePaths(relPath).meta);
  if (sc && sc.transcriptId && sc.transcriptId !== transcriptId) return sc.transcriptId;
  return null;
}

// How many `-N` suffixes to probe before falling back to the full id. A real
// collision needs a repo/date/summary/host match AND an 8-char id-prefix match,
// so even a handful is generous; the cap only bounds a pathological forced flood.
const RELPATH_PROBE_MAX = 1000;

// The canonical relative path for a transcript seen for the FIRST time (no
// filePath row yet, so nothing to be consistent with). archiveRelPath keys the
// filename on only the first 8 alnum characters of the id, and any id with fewer
// than 8 alnum characters collapses to the literal "unknown" — so two distinct
// transcripts agreeing on repo/date/summary/host and that prefix compute the
// SAME path. Left unresolved they interleave into one .jsonl (ingestChunk
// APPENDS) and each session's read-back serves the merged file for either id, a
// cross-session content leak in the durable store (XERK-277). transcriptId is
// agent-chosen and every agent shares one token, so it can be forced, not just
// hit by accident.
//
// On a collision with a DIFFERENT transcript, disambiguate the suffix until the
// path is unowned. The result is written into filePath AND the .meta sidecar, so
// it is stable for the life of the transcript (ingestChunk reuses row.filePath
// thereafter) and rebuildIndex re-derives it from the on-disk name unchanged —
// additive on collision, never a rename of what is already there.
function resolveNewRelPath(transcriptId, full) {
  const base = archiveRelPath(transcriptId, full);
  if (!relPathOwner(base, transcriptId)) return base;
  const stem = base.slice(0, -".jsonl".length);
  // Readable first: <base>-2.jsonl, -3, …
  for (let n = 2; n <= RELPATH_PROBE_MAX; n++) {
    const cand = `${stem}-${n}.jsonl`;
    if (!relPathOwner(cand, transcriptId)) return cand;
  }
  // Only a forced flood on one prefix reaches here. Seed the suffix with the
  // full id — but slugify is NOT injective (it lowercases, strips leading/
  // trailing [-.], and truncates to 60), so two distinct ids in one collision
  // family can slug alike. So this candidate is STILL run through relPathOwner
  // and STILL counts up on a hit: returning it unchecked would re-open the exact
  // cross-session leak this function exists to close.
  const idStem = `${stem}-${slugify(transcriptId, "x")}`;
  for (let n = 0; n <= RELPATH_PROBE_MAX; n++) {
    const cand = n === 0 ? `${idStem}.jsonl` : `${idStem}-${n}.jsonl`;
    if (!relPathOwner(cand, transcriptId)) return cand;
  }
  // Both families exhausted against DIFFERENT owners — needs thousands of
  // pre-placed collisions, i.e. a deliberate flood. Refuse to NAME it rather
  // than hand back an unchecked (leak-prone) path; the caller stores nothing and
  // reports its real cursor, the same "no progress" answer an offset mismatch
  // gives (never an error status, which an agent re-sends forever, XERK-255).
  return null;
}

function ingestChunk(host, transcriptId, meta, startOffset, endOffset, entries, siteKey) {
  openDb();
  meta = normalizeMeta(meta);
  // The pushing host's DECIDED org, supplied by the HUB (decidedOrgOf), never
  // agent-asserted `meta` — trusting the agent's own `jira.siteKey` here would let
  // any host claim any org, the same objection XERK-268/348 make. Bounded like
  // every agent-influenced string that reaches this durable store (XERK-235); ""
  // is the narrow "no org" answer decidedOrgOf returns for an org-less or
  // actively-drifted host.
  const pushOrg = String(siteKey == null ? "" : siteKey).slice(0, META_TEXT_MAX);
  const row = db.prepare(
    "SELECT bytesStored, archiveBytes, filePath, host, siteKey FROM sessions WHERE transcriptId=?"
  ).get(transcriptId);
  const have = row ? row.bytesStored : 0;
  // Ownership (XERK-344). `<host>` is proved by the credential at the route
  // (XERK-268), but proving WHO is calling says nothing about WHOSE archived
  // transcript they may write into: without this, any host holding its own token
  // could APPEND arbitrary entries to another host's durable record AND
  // re-attribute the row to itself (`host=excluded.host` in the upsert below),
  // served straight back through GET /api/archive as that host's history. The raw
  // layer closed the identical hole in XERK-338 (`ingestRaw` requires
  // row.host === host); this is the rendered layer's version, and it also unblocks
  // the raw layer's check, which DEPENDS on this re-point happening.
  //
  // A host legitimately CHANGES on a migration (XERK-101): the target carries the
  // same transcript id, continues the conversation, and its rendered push is what
  // re-points the row. A migration is same-org, so a re-point is allowed exactly
  // when the pushing host shares the current owner's org — and that org is now the
  // hub-DECIDED org (`pushOrg` = `decidedOrgOf`), requiring a shared NON-EMPTY org
  // on both sides, EXACTLY as POST .../migrate does (`sameDecidedOrg`, XERK-349).
  // This closes the org-less pooling hole the CLAIMED-org compare left (XERK-573):
  // two hosts that both read "" — a genuinely org-less pair, or a bound host
  // momentarily omitting its `jira` block so its claimed org coerced to "" — used
  // to satisfy the gate for each other, letting one APPEND to and re-attribute the
  // other's durable transcript. A same-host append never re-points, so it is never
  // gated. A row whose owner org predates this column (rebuilt from a pre-XERK-344
  // sidecar, siteKey NULL) can't be proven cross-org, so the first writer stamps it
  // — one-time trust-on-first-sight, unchanged. A cross-org RESTORE (XERK-441) is
  // not gated here either: `restampOrg` re-points the row (host + decided org) to
  // the target, so the target's push is a same-host append — the org-agnostic
  // admission an org-less fleet needs, since it has no shared non-empty org for
  // this gate to match on. Refused exactly like an offset mismatch: store nothing,
  // hand back the real cursor — never an error status, which an agent re-sends
  // forever (XERK-255).
  const rePoint = !!(row && row.host && row.host !== host);
  const legacyNull = !!(row && row.siteKey == null);
  const sharedOrg = !!(pushOrg && row && String(row.siteKey) === pushOrg);
  if (rePoint && !legacyNull && !sharedOrg) {
    return { bytesStored: have };
  }
  // Store full: hand back the cursor we already hold and store nothing. Not an
  // error status — the agent must read this as "no progress" and move on, never
  // as a chunk to retry (XERK-267). Deleting archives is what reopens it, and
  // needs nothing from us: the total is measured off the files themselves.
  const total = totalForCeiling();
  if (ARCHIVE_TOTAL_MAX && total >= ARCHIVE_TOTAL_MAX) {
    warnArchiveFull(total);
    return { bytesStored: have, full: true };
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
  let relPath = row && row.filePath ? row.filePath : resolveNewRelPath(transcriptId, full);
  // null only when resolveNewRelPath could not find an unowned name after a
  // deliberate collision flood — store nothing and report the real cursor rather
  // than write into another transcript's file.
  if (!relPath) {
    console.error(`archive: could not place ${transcriptId} — its canonical name ` +
      `collides and every disambiguation is owned; storing nothing this beat`);
    return { bytesStored: have };
  }
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
    if (lines) {
      fs.appendFileSync(paths.jsonl, lines);
      noteWrite(paths.jsonl);
      // Charge the store total immediately rather than waiting for the next
      // walk — that gap is what let a burst run 1,200x past the ceiling.
      writtenSinceWalk += Buffer.byteLength(lines);
    }
    db.prepare(`INSERT INTO sessions(
        transcriptId, host, siteKey, remoteKey, repo, worktree, slug, createdAt, endedTs,
        summary, msgCount, bytesStored, archiveBytes, filePath, updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(transcriptId) DO UPDATE SET
        host=excluded.host, siteKey=excluded.siteKey, remoteKey=excluded.remoteKey,
        repo=excluded.repo, worktree=excluded.worktree, slug=excluded.slug,
        createdAt=COALESCE(excluded.createdAt, sessions.createdAt),
        endedTs=excluded.endedTs, summary=COALESCE(excluded.summary, sessions.summary),
        msgCount=excluded.msgCount, bytesStored=excluded.bytesStored,
        archiveBytes=excluded.archiveBytes,
        filePath=excluded.filePath, updatedAt=excluded.updatedAt`).run(
      transcriptId, host, pushOrg, meta.remoteKey || null, meta.repo || null,
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
    transcriptId, host, siteKey: pushOrg,
    remoteKey: meta.remoteKey || null, repo: meta.repo || null,
    worktree: meta.worktree || null, slug: meta.slug || null,
    createdAt: meta.createdAt || null, endedTs: meta.endedTs || null,
    summary: meta.summary || null, msgCount, bytesStored, archiveBytes,
    updatedAt: nowIso,
  });

  // Mirror the durable index write to the Postgres of-record (XERK-780, no-op off
  // HA): the full session row (so the upsert never clobbers untouched metadata) and
  // the entries appended this chunk, at ordinals continuing from prevCount (idempotent
  // by (transcriptId, seq)). After the local write is durable, so a mirror hiccup
  // never affects what we return.
  mirrorSession(transcriptId);
  mirrorEntries(transcriptId, list, prevCount);

  // `shed` tells the agent this transcript is over budget so it stops putting
  // the payloads on the wire at all; the hub sheds regardless, since an agent
  // too old to read the flag still pushes them.
  return shed ? { bytesStored, shed: true } : { bytesStored };
}

// Re-point an archived transcript's OWNER to the restore target — its `siteKey`
// (the target's DECIDED org, XERK-573) AND its `host` — keeping the sidecar in
// step so a rebuild preserves both. Returns false if the transcript is unknown.
//
// A restore (XERK-441) resumes an ENDED session on a host in ANOTHER org — this
// is deliberately allowed (the archive is hub-wide and login-gated, and the dead
// source host has no org left to compare against). The resumed session keeps the
// SAME transcript id, so when it later archives, its push is a cross-host
// re-point that ingestChunk's ownership gate (XERK-344/573) refuses unless it is a
// shared NON-EMPTY decided org on both sides — otherwise the restored session's
// new turns silently never reach the durable archive. Re-pointing the HOST here
// (not just the org) makes the target's first push a same-host append, which the
// gate never touches — the ONLY way an ORG-LESS restore continues, since an
// org-less target has no shared non-empty org for the gate to match on. It also
// removes the old rendered-before-raw ordering dependency: the row is already the
// target's, so its raw push (`row.host === host`) passes regardless of push order.
// The org is still stamped so a LATER migration of the restored session is gated
// on the right (decided) org. `host` defaults to leaving the owner as-is for a
// caller that only wants the org restamped.
function restampOrg(transcriptId, siteKey, host) {
  openDb();
  const org = String(siteKey == null ? "" : siteKey).slice(0, META_TEXT_MAX);
  const row = db.prepare("SELECT filePath, host FROM sessions WHERE transcriptId=?").get(transcriptId);
  if (!row) return false;
  const newHost = host == null ? row.host : String(host).slice(0, META_TEXT_MAX);
  db.prepare("UPDATE sessions SET siteKey=?, host=?, updatedAt=? WHERE transcriptId=?")
    .run(org, newHost, new Date().toISOString(), transcriptId);
  // Keep the sidecar honest so rebuildIndex re-derives the new org+host, not the old.
  if (row.filePath) {
    const metaPath = filePaths(row.filePath).meta;
    const sc = readSidecar(metaPath);
    if (sc) {
      sc.siteKey = org;
      sc.host = newHost;
      try { writeSidecar(metaPath, sc); } catch { /* best-effort */ }
    }
  }
  // Mirror the re-pointed owner (host + org) to the Postgres of-record (XERK-780).
  mirrorSession(transcriptId);
  return true;
}

// ---- the raw layer ----------------------------------------------------------

/**
 * How much of one raw file this store already holds — THE FILE'S OWN SIZE, not a
 * number kept beside it.
 *
 * The cursor has to agree with what a byte-append will actually do, and the file
 * is the only thing that can answer that. It also self-heals: an operator who
 * deletes a raw file gets it re-synced from zero on the next pass, where the
 * rendered layer's indexed cursor appends onto the gap instead (XERK-280, still
 * open there for exactly the reason this avoids).
 *
 * Returns null — NOT 0 — for a stat that failed with anything but ENOENT.
 * ENOENT is the file genuinely absent, which is safe to start fresh from. An
 * EACCES/EIO/ESTALE read as 0 would re-ship the whole file and append it to the
 * copy that is still there, writing a second copy of the session into the same
 * file. Null means "cannot tell", and every caller declines to act on it.
 */
function rawCursor(full) {
  try {
    return fs.statSync(full).size;
  } catch (e) {
    if (e && e.code === "ENOENT") return 0;
    return null;
  }
}

/**
 * The raw-layer cursors for one manifest: `{transcriptId: {relPath: bytes}}`.
 *
 * Only files the agent OFFERED are stat-ed, so this costs one stat per offered
 * file rather than a walk of the store, and a file this hub holds that the agent
 * no longer has simply isn't mentioned — it is history, and nothing re-derives
 * it. A transcript with no row yet is skipped: `manifestCursors` creates the row,
 * and until it exists there is no `filePath` to hang a raw directory off.
 */
function rawCursors(manifest) {
  openDb();
  const out = {};
  // Bounded across the WHOLE manifest, not per transcript — see
  // ARCHIVE_RAW_CURSOR_MAX. Sized for BOTH terms an in-cap agent presents: its
  // ARCHIVE_RAW_MANIFEST_FILES_MAX files plus its ARCHIVE_MANIFEST_MAX entry
  // lookups, so a well-behaved agent is never truncated (XERK-427). The manifest
  // arrives newest-transcript-first, so a truncation of a MISBEHAVING agent drops
  // the oldest history rather than the live sessions.
  let budget = ARCHIVE_RAW_CURSOR_MAX + ARCHIVE_RAW_CURSOR_LOOKUP_MAX;
  let dropped = 0;
  // Prepared ONCE. It was recompiled per iteration inside the loop below.
  const lookup = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?");
  for (const m of Array.isArray(manifest) ? manifest : []) {
    if (!m || !m.transcriptId || !Array.isArray(m.rawFiles) || !m.rawFiles.length) continue;
    if (budget <= 0) { dropped += m.rawFiles.length; continue; }
    // Charged for the LOOKUP, before it happens. Charging only entries that
    // resolve to a row left the outer loop uncharged, so a manifest of unknown
    // ids — or of ids whose row has no `filePath`, which is every transcript
    // that has never had a rendered chunk — did a SELECT apiece and moved the
    // stall here instead of removing it: 2,985 ms for 470,051 entries, against
    // 4.2 ms for the same entries with `rawFiles` omitted (QA F4). Same rule as
    // the inner loop: the budget bounds the WORK, and a lookup is work.
    budget -= 1;
    const row = lookup.get(m.transcriptId);
    if (!row || !row.filePath) continue;
    const have = {};
    for (const f of m.rawFiles) {
      if (budget <= 0) { dropped += 1; continue; }
      // Charged BEFORE validation, not after. Validation is not free — a
      // max-length depth-10 path that fails on its last character measured
      // 700 ms per 780k entries, against 30 ms for valid ones — so charging only
      // the survivors let a caller offer millions of REJECTED paths and walk
      // straight around this cap (XERK-338 QA D4). The budget bounds the WORK,
      // and every offer costs work whether or not it names anything.
      budget -= 1;
      const rel = Array.isArray(f) ? f[0] : (f && f.path);
      const full = rawFilePath(row.filePath, m.transcriptId, rel);
      if (!full) continue;
      const n = rawCursor(full);
      if (n === null) continue;   // cannot tell — say nothing rather than "0"
      if (n > 0) have[safeRawRel(rel)] = n;
    }
    if (Object.keys(have).length) out[m.transcriptId] = have;
  }
  if (dropped) warnRawCursorCap(dropped);
  return Object.keys(out).length ? out : undefined;
}

let lastManifestWarnAt = 0;
function warnManifestCap(dropped) {
  const now = Date.now();
  if (now - lastManifestWarnAt < 60 * 60 * 1000) return;
  lastManifestWarnAt = now;
  console.error(
    `archive: a manifest carried more than ${ARCHIVE_MANIFEST_CURSOR_MAX} entries ` +
    `(ARCHIVE_MANIFEST_CURSOR_MAX); ${dropped} were ignored this beat. An agent ` +
    `inside ARCHIVE_MANIFEST_MAX never reaches this.`);
}

// One line an hour: an agent ignoring its own cap does so on every beat, so an
// unthrottled line turns a survived flood into disk pressure on the hub.
let lastRawCursorWarnAt = 0;
function warnRawCursorCap(dropped) {
  const now = Date.now();
  if (now - lastRawCursorWarnAt < 60 * 60 * 1000) return;
  lastRawCursorWarnAt = now;
  console.error(
    `archive: a manifest's raw cursors exceeded the per-beat work budget ` +
    `(${ARCHIVE_RAW_CURSOR_MAX} files + ${ARCHIVE_RAW_CURSOR_LOOKUP_MAX} lookups, ` +
    `ARCHIVE_RAW_CURSOR_MAX/ARCHIVE_RAW_CURSOR_LOOKUP_MAX); ${dropped} got no cursor ` +
    `this beat. An agent inside its own limits never reaches this — check that ` +
    `host's ARCHIVE_RAW_* config.`);
}

/**
 * Which of these transcripts have spent their raw budget, so the agent stops
 * pushing raw bytes for them. Like `archiveLimits`, an optimisation and not the
 * enforcement — `ingestRaw` applies the ceiling itself, since an agent too old
 * to read the flag pushes regardless.
 */
function rawLimits(ids) {
  openDb();
  const list = Array.isArray(ids) ? ids : [];
  if (!(ARCHIVE_RAW_TRANSCRIPT_MAX > 0) || !list.length) return [];
  const over = new Set(db.prepare(
    "SELECT transcriptId FROM sessions WHERE rawBytes >= ?"
  ).all(ARCHIVE_RAW_TRANSCRIPT_MAX).map((r) => r.transcriptId));
  return list.filter((id) => over.has(id));
}

let lastRawOverWarnAt = 0;

/**
 * Append one raw byte-range to a session's own file, byte for byte.
 *
 * Append-only and forward-only, on the same contract as `ingestChunk`: `start`
 * must equal what is already stored, and a mismatch stores NOTHING and hands
 * back the real cursor for the agent to realign against. That is the whole
 * duplicate-prevention story for a session that is resumed — a resumed
 * conversation appends to the same file under the same transcript id, so the
 * next pass ships only what is new, however many times it is resumed. It is
 * also what makes a MIGRATED session safe: the target host carries the same
 * transcript id and a byte-identical prefix, so its pushes continue this same
 * file instead of starting a second copy.
 *
 * Returns {stored} always, plus {full} at the store ceiling and {skip} at the
 * per-transcript one — never an error status for a refusal, because an agent
 * reads an error as a chunk to re-send forever (XERK-255).
 */
function ingestRaw(host, transcriptId, rel, start, buf) {
  openDb();
  const row = db.prepare(
    "SELECT filePath, rawBytes, host FROM sessions WHERE transcriptId=?").get(transcriptId);
  // No row means no canonical file to hang the raw directory off. The manifest
  // creates the row a beat before any raw push, so this is a stale offer.
  if (!row || !row.filePath) return { stored: 0, skip: true };
  // THE SESSION'S OWN HOST, or nobody. `<host>` is proved by the credential at
  // the gate (XERK-268), but proving WHO is calling says nothing about WHOSE
  // session they may write into: with a properly bound token, any agent could
  // create arbitrary named files inside another host's archived session and
  // serve them back through the read-back route as part of that host's
  // "byte-for-byte record" (XERK-338 QA D5). A row with no host recorded is
  // pre-raw-layer history and is not writable by anyone.
  if (!row.host || row.host !== host) return { stored: 0, skip: true };
  const full = rawFilePath(row.filePath, transcriptId, rel);
  if (!full) return { stored: 0, skip: true };

  const have = rawCursor(full);
  if (have === null) return { stored: 0, skip: true };  // cannot tell; never guess 0
  const startN = Number(start);
  if (!Number.isFinite(startN) || startN !== have) return { stored: have };
  if (!buf || !buf.length) return { stored: have };
  if (have + buf.length > MAX_TRANSCRIPT_BYTES) return { stored: have, skip: true };

  const total = totalForCeiling();
  if (ARCHIVE_TOTAL_MAX && total >= ARCHIVE_TOTAL_MAX) {
    warnArchiveFull(total);
    return { stored: have, full: true };
  }
  const rawBytes = row.rawBytes || 0;
  if (ARCHIVE_RAW_TRANSCRIPT_MAX > 0 && rawBytes >= ARCHIVE_RAW_TRANSCRIPT_MAX) {
    const now = Date.now();
    if (now - lastRawOverWarnAt > 60 * 60 * 1000) {
      lastRawOverWarnAt = now;
      console.error(
        `archive: ${transcriptId} has stored ${rawBytes} raw bytes, over the ` +
        `${ARCHIVE_RAW_TRANSCRIPT_MAX} limit (ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES) — ` +
        `its raw copy stops here; the rendered transcript is unaffected`);
    }
    return { stored: have, skip: true };
  }

  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (have === 0) {
      // EXCLUSIVE create, not a truncating write: the stat above said ENOENT, so
      // anything there now appeared underneath us and truncating it would delete
      // a copy this hub had already accepted.
      fs.writeFileSync(full, buf, { flag: "wx" });
    } else {
      fs.appendFileSync(full, buf);
    }
    noteWrite(full);
  } catch (e) {
    if (e && e.code === "EEXIST") return { stored: rawCursor(full) || 0 };
    console.error(`archive: raw append failed for ${transcriptId} ${rel}: ${e.message}`);
    return { stored: have, skip: true };
  }
  // Charge the store total immediately rather than waiting for the next walk —
  // the same rule the rendered layer follows, and for the same reason.
  writtenSinceWalk += buf.length;
  db.prepare("UPDATE sessions SET rawBytes=?, updatedAt=? WHERE transcriptId=?")
    .run(rawBytes + buf.length, new Date().toISOString(), transcriptId);
  // Mirror the raised raw-byte cursor to the Postgres of-record (XERK-780). GREATEST
  // there keeps a concurrent replica from ever lowering it.
  mirrorSession(transcriptId);
  return { stored: have + buf.length };
}

/** The raw files held for one transcript, as [{path, bytes}], newest walk order. */
function listRawFiles(transcriptId) {
  openDb();
  const row = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(transcriptId);
  if (!row || !row.filePath) return null;
  const dir = rawDirFor(row.filePath, transcriptId);
  if (!dir) return null;
  const out = [];
  const walk = (d, prefix) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const full = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        try { out.push({ path: rel, bytes: fs.statSync(full).size }); } catch { /* raced */ }
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * The index row behind one archived session — where it ran and what of, which is
 * what restoring it onto another host needs (XERK-441) and what the transcript
 * read-back deliberately does not carry (it answers with the CONVERSATION).
 * null when unknown.
 */
function sessionRow(transcriptId) {
  openDb();
  const row = db.prepare(`SELECT transcriptId, host, remoteKey, repo, worktree, summary,
      createdAt, endedTs, msgCount, filePath FROM sessions WHERE transcriptId=?`).get(transcriptId);
  return row || null;
}

/** One raw file's absolute path, for streaming it back. null when unknown. */
function rawFileFor(transcriptId, rel) {
  openDb();
  const row = db.prepare("SELECT filePath FROM sessions WHERE transcriptId=?").get(transcriptId);
  if (!row || !row.filePath) return null;
  const full = rawFilePath(row.filePath, transcriptId, rel);
  if (!full) return null;
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

// Upsert metadata rows for a manifest and return the bytes-have cursor map the
// heartbeat reply carries back (transcriptId -> bytesStored we already hold).
function manifestCursors(host, manifest, siteKey) {
  openDb();
  const have = {};
  // The row this creates is a placeholder (0 bytes) that the OWNER's first chunk
  // fills. Stamp its org here too, or that row's `siteKey` is NULL and the
  // ingestChunk gate (XERK-344) would treat a cross-org host's first chunk as a
  // legacy trust-on-first-sight write and let it HIJACK the not-yet-filled
  // transcript. Only INSERT is reached (the loop guards on `!row`), so this never
  // re-points an existing row — same hub-supplied DECIDED org (XERK-573), bounded,
  // as ingestChunk, so the placeholder and the gate agree on the basis.
  const pushOrg = String(siteKey == null ? "" : siteKey).slice(0, META_TEXT_MAX);
  // Capped like the raw cursors beside it, and for the same reason — it is the
  // same handler, the same beat and the same single event loop. Pre-existing but
  // strictly worse: one SELECT + INSERT per entry, measured at 6.9 SECONDS of
  // blocked loop for 973,677 new ids in one 26.9 MiB beat, which also wrote
  // 973,682 rows and grew index.db + WAL to 161 MB on /data — repeatable every
  // beat, and index.db is outside ARCHIVE_TOTAL_MAX (XERK-332). Left uncapped it
  // also made ARCHIVE_RAW_CURSOR_MAX nearly pointless: anyone who could send
  // 780k rawFiles could send 780k manifest entries instead for 20x the stall
  // (XERK-338 QA D7). The agent caps itself at ARCHIVE_MANIFEST_MAX; that is not
  // this bound.
  let list = Array.isArray(manifest) ? manifest : [];
  if (list.length > ARCHIVE_MANIFEST_CURSOR_MAX) {
    warnManifestCap(list.length - ARCHIVE_MANIFEST_CURSOR_MAX);
    list = list.slice(0, ARCHIVE_MANIFEST_CURSOR_MAX);
  }
  const upsert = db.prepare(`INSERT INTO sessions(
      transcriptId, host, siteKey, remoteKey, repo, worktree, slug, createdAt, endedTs,
      summary, updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(transcriptId) DO UPDATE SET
      host=excluded.host, siteKey=excluded.siteKey, remoteKey=excluded.remoteKey,
      repo=excluded.repo, worktree=excluded.worktree, slug=excluded.slug,
      createdAt=COALESCE(excluded.createdAt, sessions.createdAt),
      endedTs=excluded.endedTs, summary=COALESCE(excluded.summary, sessions.summary),
      updatedAt=excluded.updatedAt`);
  const nowIso = new Date().toISOString();
  const created = [];
  tx(() => {
    for (const m of list) {
      if (!m || !m.transcriptId) continue;
      const row = db.prepare("SELECT bytesStored FROM sessions WHERE transcriptId=?").get(m.transcriptId);
      have[m.transcriptId] = row ? row.bytesStored : 0;
      if (!row) {
        upsert.run(m.transcriptId, host, pushOrg, m.remoteKey || null, m.repo || null,
          m.worktree || null, m.slug || null, m.createdAt || null,
          m.endedTs || null, m.summary || null, nowIso);
        created.push(m.transcriptId);
      }
    }
  });
  // Mirror each newly-created placeholder row to the Postgres of-record (XERK-780)
  // so a promoted replica sees the same not-yet-filled rows the ingestChunk org gate
  // depends on. After the tx (the rows now exist to be read back by mirrorSession).
  for (const id of created) mirrorSession(id);
  return have;
}

// The hub-driven inverse of manifestCursors (XERK-431): instead of the agent
// GUESSING which transcripts to offer and us answering their cursors, a NEW agent
// ships a cheap INVENTORY of what it HAS — `[{i, s, r}]` = transcript id, its
// current rendered size, its current raw-total — and WE name back the subset we
// are SHORT of. That deletes the agent's whole in-RAM offer-rotation
// (`_archive_offered`/`_archive_cand_hwm`/…), whose bound had to be estimated
// against a universe the agent could only guess at and was wrong four times
// (XERK-424); our `sessions` table already knows exactly what we hold. Full
// reasoning + rollover: `docs/archive-offer-inversion-adr.md`.
//
// The return shape IS `manifestCursors`' `archiveHave` map, so the agent's delta
// push is unchanged — it just contains only the WANTED ids (`bytesStored < s` OR
// `rawBytes < r`). `s`/`r` are compared against what we already store and NEVER
// persisted, so this needs no schema change: completeness over the universe is
// carried by the agent ROTATING its bounded inventory window, and our durable
// cursors re-identify a short transcript in every window with no agent memory.
//
// We want EVERY short entry in the window — NOT a smaller prefix. The window is
// already bounded by the agent (ARCHIVE_INVENTORY_MAX) and by us against a hostile
// oversize (ARCHIVE_MANIFEST_CURSOR_MAX), and the push is byte-bounded
// (ARCHIVE_BEAT_BUDGET) regardless. A separate smaller want-cap would take the
// SAME prefix every beat and STARVE the window's tail, because once the window
// already covers the backlog the round-robin is a no-op — the exact cliff XERK-424
// spent six passes closing, reintroduced one layer up.
//
// Placeholder rows are created for wanted NEW ids exactly as manifestCursors does
// (same INSERT-only discipline + decided-org stamp, so the ingestChunk gate
// XERK-344/573 and the raw-owner check XERK-338 both hold), and an id whose row
// another host owns is IGNORED — never re-pointed, never wanted for us (the same
// squat protection). Capped like manifestCursors, and for the same reason: it is
// the same handler on the same event loop.
function inventoryCursors(host, inventory, siteKey) {
  openDb();
  const have = {};
  const pushOrg = String(siteKey == null ? "" : siteKey).slice(0, META_TEXT_MAX);
  let list = Array.isArray(inventory) ? inventory : [];
  if (list.length > ARCHIVE_MANIFEST_CURSOR_MAX) {
    warnManifestCap(list.length - ARCHIVE_MANIFEST_CURSOR_MAX);
    list = list.slice(0, ARCHIVE_MANIFEST_CURSOR_MAX);
  }
  const lookup = db.prepare(
    "SELECT bytesStored, rawBytes, host FROM sessions WHERE transcriptId=?");
  const insert = db.prepare(`INSERT INTO sessions(
      transcriptId, host, siteKey, bytesStored, rawBytes, updatedAt)
    VALUES(?,?,?,0,0,?)
    ON CONFLICT(transcriptId) DO NOTHING`);
  const nowIso = new Date().toISOString();
  const created = [];
  tx(() => {
    for (const m of list) {
      // Inventory entries are the compact `{i, s, r}` the agent ships — id, its
      // current rendered size, its current raw total — NOT the manifest shape.
      const tid = m && m.i;
      if (!tid) continue;
      const s = Number(m.s);
      const r = Number(m.r);
      const row = lookup.get(tid);
      // Another host owns this id: never re-point here (manifestCursors' rule),
      // and never want it for the caller — the owner drives its own sync.
      if (row && row.host && row.host !== host) continue;
      const bytesStored = row ? row.bytesStored : 0;
      const rawBytes = row ? row.rawBytes : 0;
      const rShort = Number.isFinite(r) && r > 0 && rawBytes < r;
      const sShort = Number.isFinite(s) && s > 0 && bytesStored < s;
      if (!sShort && !rShort) continue;
      if (!row) { insert.run(tid, host, pushOrg, nowIso); created.push(tid); }
      have[tid] = bytesStored;
    }
  });
  // Mirror each newly-created placeholder row to the Postgres of-record (XERK-780),
  // as manifestCursors does. After the tx, so the row exists to read back.
  for (const id of created) mirrorSession(id);
  return have;
}

// The raw-layer cursors for a set of transcript ids (XERK-431) — the inverse-path
// twin of `rawCursors`, which reads the offered manifest's `rawFiles`. Here the
// agent sent no per-file list (only the raw TOTAL `r`), so we walk OUR OWN stored
// raw copy of each wanted transcript (`listRawFiles`) and hand back `{rel: bytes}`;
// the agent diffs its local files against it exactly as before. `ids` is the
// wanted (short) set from `inventoryCursors`, itself bounded by the agent's
// inventory window and by ARCHIVE_MANIFEST_CURSOR_MAX, so no separate work budget
// is needed here.
function rawCursorsForIds(ids) {
  openDb();
  const out = {};
  for (const id of Array.isArray(ids) ? ids : []) {
    const files = listRawFiles(id);
    if (!files || !files.length) continue;
    const have = {};
    for (const f of files) if (f && f.path && f.bytes > 0) have[f.path] = f.bytes;
    if (Object.keys(have).length) out[id] = have;
  }
  return Object.keys(out).length ? out : undefined;
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
  return { shed, full: !!(ARCHIVE_TOTAL_MAX && totalForCeiling() >= ARCHIVE_TOTAL_MAX) };
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
  // filePath + archiveBytes are fetched only to verify each row against its file
  // (XERK-280); they are stripped before the row is returned.
  const sql = `SELECT transcriptId, host, remoteKey, repo, worktree, summary,
      createdAt, endedTs, msgCount, filePath, archiveBytes
    FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(endedTs, createdAt, '') DESC, transcriptId DESC
    LIMIT ? OFFSET ?`;
  const sessions = db.prepare(sql).all(...args, limit, offset);
  for (const row of sessions) {
    reconcileListedRow(row);
    delete row.filePath;
    delete row.archiveBytes;
  }
  return { sessions };
}

// Verify one browse row against its `.jsonl` and self-heal a stale msgCount
// (XERK-280). A stat is cheap and the .jsonl's size EQUALS its cached
// archiveBytes on a healthy transcript (both are the append-only line bytes), so
// a size mismatch is the tell that the file was deleted-and-recreated or
// truncated under a surviving row — the only case we then pay a full read to
// recount. An absent file (ENOENT) or a stat error is left untouched: it cannot
// be told from a mount blip, and a browse must never mutate on an absence
// (heal happens on the transcript read, which is positive proof). A placeholder
// row (no filePath) has nothing on disk to check.
function reconcileListedRow(row) {
  if (!row.filePath) return;
  const jsonl = filePaths(row.filePath).jsonl;
  let st;
  try { st = fs.statSync(jsonl); } catch { return; }
  if (!st.isFile() || st.size === row.archiveBytes) return;
  let raw;
  try { raw = fs.readFileSync(jsonl, "utf8"); } catch { return; }
  row.msgCount = reconcileRow(row.transcriptId, row.msgCount, row.archiveBytes,
    parseEntries(raw), Buffer.byteLength(raw));
}

// Parse a stored `.jsonl`'s text into the entry list a viewer renders. One JSON
// object per line (torn/blank lines skipped); the file is the source of truth for
// a transcript's content, so this count IS the true msgCount for what's on disk.
function parseEntries(raw) {
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
  return entries;
}

// Verify a transcript's cached metadata against its file ON READ, and self-heal
// when they disagree (XERK-280). The organized `.jsonl` is the source of truth
// for a transcript's content; the sessions row's msgCount/archiveBytes and the
// entries_fts rows are a cache of it. An operator deleting a `.jsonl` by hand
// leaves that cache describing bytes no longer on disk — the next delta appends
// at the old cursor onto a shorter file, so msgCount over-counts and search
// returns snippets from messages that are gone.
//
// This is deliberately a READ-path repair, never a write-path one. A failed stat
// cannot tell a deletion from a mount blip / renamed parent / ESTALE, and guessing
// wrong on the write path duplicates a re-pushed conversation or latches the store
// full (XERK-267 built and reproduced both). A read heals only on POSITIVE PROOF —
// `entries`/`trueBytes` come from a file we just read IN FULL — never on an
// absence, so a transient unmount yields the honest empty/unknown answer of the
// moment and mutates nothing. The row and FTS are rebuilt from exactly the entries
// the file yields, matching what a full rebuildIndex would derive for this id.
//
// It does NOT resurrect the deleted prefix: `bytesStored` (the agent-facing
// cursor) is left alone, so the agent does not re-push bytes it believes we hold,
// and future deltas append contiguously after the current file — the accepted
// consequence is a truncated view of one already-ended session, matching the
// bytes actually on disk, rather than an index that lies about them. Returns the
// true msgCount. No-op (and no write) when the cache already agrees, which is
// every healthy transcript, so a read is only charged the tx for a stale row.
function reconcileRow(transcriptId, storedCount, storedBytes, entries, trueBytes) {
  const trueCount = entries.length;
  if (trueCount === storedCount && trueBytes === storedBytes) return trueCount;
  // XERK-791: do NOT mutate the local index while it is being HYDRATED from the
  // Postgres of-record. This heal-on-read `tx()` (DELETE + reinsert entries_fts)
  // is a WRITE on the same node:sqlite handle the async paged hydrate is writing,
  // and it is reachable from the archive READ routes (GET /api/search, /api/archive,
  // /api/archive/<id>) — which, unlike the ingest routes and the beat cursor path,
  // are NOT 503-gated during a hydrate. So it was the one concurrent local-index
  // writer the XERK-789 serialize guard missed, and interleaving it with the bulk
  // hydrate is the same `entries_fts` corruption that guard exists to prevent
  // ("the boot hydrate and live index writes MUST NOT run concurrently",
  // turma-ha-archive.md). The read still returns the honest file-derived count for
  // display; the index heal simply re-fires on a later read once the hydrate has
  // finished. Inert off HA (`hydrating` is only ever set around the HA hydrate).
  if (hydrating) return trueCount;
  const insert = db.prepare(
    "INSERT INTO entries_fts(text, transcriptId, uuid, role, ts) VALUES(?,?,?,?,?)"
  );
  tx(() => {
    // entries_fts carries no per-transcript cursor we track, so replace the whole
    // set for this id — the file is bounded (ARCHIVE_TRANSCRIPT_MAX) and this runs
    // only for the rare stale row, never on a healthy read.
    db.prepare("DELETE FROM entries_fts WHERE transcriptId=?").run(transcriptId);
    for (const e of entries) {
      insert.run(String(e.text || ""), transcriptId, e.uuid || null,
        e.role || null, e.ts || null);
    }
    db.prepare("UPDATE sessions SET msgCount=?, archiveBytes=? WHERE transcriptId=?")
      .run(trueCount, trueBytes, transcriptId);
  });
  // Mirror the heal to the Postgres of-record (XERK-780): the transcript's entries
  // are REPLACED wholesale (matching the SQLite DELETE+reinsert), and its row's
  // healed msgCount/archiveBytes re-mirrored.
  mirrorReplace(transcriptId, entries);
  mirrorSession(transcriptId);
  console.error(
    `archive: reconciled ${transcriptId} on read — index claimed ${storedCount} ` +
    `msgs/${storedBytes}B, file holds ${trueCount}/${trueBytes}B (a .jsonl was ` +
    `deleted or truncated under a surviving row; cursor left as-is)`);
  return trueCount;
}

// The full stored transcript of one archived session, read from its canonical
// organized file (not the index). null when unknown/missing.
function getTranscript(transcriptId) {
  openDb();
  const row = db.prepare("SELECT filePath, repo, host, siteKey, worktree, summary, endedTs, createdAt, "
    + "msgCount, archiveBytes FROM sessions WHERE transcriptId=?").get(transcriptId);
  // No row at all — the hub has genuinely never heard of this transcript.
  if (!row) return null;
  // A row with no organized file is a manifest PLACEHOLDER (manifestCursors)
  // whose owner has not pushed a content chunk yet — still syncing, so the
  // client's "syncs within a few minutes of ending" 404 wording is correct.
  if (!row.filePath) return null;
  const meta = {
    transcriptId, repo: row.repo, host: row.host, summary: row.summary,
    // The row's hub-DECIDED org at archive time (schema v5, hub-supplied — never
    // agent `meta`). The restore picker compares it to a target's org to WARN on a
    // cross-org restore (XERK-453); NULL for a legacy/org-less row reads as "no org
    // to compare", so the warning never fires on it. Restore itself stays
    // org-agnostic — this is display-only, not an admission gate.
    siteKey: row.siteKey == null ? "" : row.siteKey,
    // The recorded cwd, so the page can tell a session that CAN be restored from
    // one whose "worktree" is really a transcript store — the majority of the
    // archive — instead of offering a control that always refuses.
    worktree: row.worktree, endedTs: row.endedTs, createdAt: row.createdAt,
  };
  const paths = filePaths(row.filePath);
  let raw;
  try {
    raw = fs.readFileSync(paths.jsonl, "utf8");
  } catch (e) {
    // A transcript whose lines are ALL non-renderable (mode/permission-mode/
    // bridge-session/system/last-prompt records, no user/assistant turn) rendered
    // to zero entries, so ingestChunk advanced the cursor to size but appended
    // nothing and never created the `.jsonl` — yet the row is real and its RAW
    // layer may hold material (XERK-422). Serve it with an empty entry list so
    // the viewer says "this session recorded no conversation", distinguishing it
    // from a transcript the hub never heard of, rather than a permanent 404.
    // Any OTHER read failure (a transient EIO on a file that IS present) stays a
    // null → not-here answer, never a false "empty conversation".
    if (e && e.code === "ENOENT") return { ...meta, entries: [] };
    return null;
  }
  const entries = parseEntries(raw);
  // A successful full read is positive proof of what's on disk: heal the cached
  // msgCount/archiveBytes + FTS if a deleted/truncated file left them stale
  // (XERK-280). The transcript view already returns the true entries below; this
  // stops listArchive/search claiming the vanished ones going forward.
  reconcileRow(transcriptId, row.msgCount, row.archiveBytes, entries,
    Buffer.byteLength(raw));
  return { ...meta, entries };
}

// ---- rebuild ----------------------------------------------------------------

function walkJsonl(dir, out, depth) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    // A raw directory is SKIPPED WHOLE (XERK-338). Its contents are the
    // session's own `.jsonl` files, which are not archive rows and carry no
    // `.meta` — descending would read every one of them into memory to decide
    // that, on a rebuild that already re-reads the entire store.
    if (d.isDirectory() && isRawDir(d.name, depth || 0)) continue;
    // d.name is a single readdirSync entry (never contains a separator), so
    // this stays inside `dir` — a recursive walk of our own ARCHIVE_DIR.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walkJsonl(full, out, (depth || 0) + 1);
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
  walkJsonl(ARCHIVE_DIR, files, 0);
  const insertEntry = db.prepare(
    "INSERT INTO entries_fts(text, transcriptId, uuid, role, ts) VALUES(?,?,?,?,?)"
  );
  const upsert = db.prepare(`INSERT OR REPLACE INTO sessions(
      transcriptId, host, siteKey, remoteKey, repo, worktree, slug, createdAt, endedTs,
      summary, msgCount, bytesStored, archiveBytes, rawBytes, filePath, updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
    // Same rule for the raw layer's budget: walked off its directory, never read
    // back from a sidecar. It is also what makes an operator's `rm -rf` of a raw
    // directory actually give the budget back, rather than only the disk.
    // The whole suffix directory: it now holds one subdirectory per transcript
    // (see rawDirFor), and a collided canonical file legitimately has two.
    const rawBytes = walkAllBytes(jsonl + RAW_DIR_SUFFIX);
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
      // `?? null` KEEPS a recorded "" (a no-org owner, still protected by the
      // gate) and maps only a missing field to NULL — a pre-XERK-344 sidecar has
      // no siteKey, so its row rebuilds NULL (legacy trust-on-first-sight).
      upsert.run(transcriptId, meta.host || null, meta.siteKey ?? null,
        meta.remoteKey || null,
        meta.repo || null, meta.worktree || null, meta.slug || null,
        meta.createdAt || null, meta.endedTs || null, meta.summary || null,
        msgCount, meta.bytesStored || 0, archiveBytes, rawBytes, relPath,
        meta.updatedAt || null);
    });
  }
  return files.length;
}

// ---- bulk load the index FROM the Postgres of-record (XERK-780) --------------
//
// The hydration sink server.js hands to PgIndexStore.hydrateInto — the RETIREMENT of
// the per-pod rebuild-from-files. `reset()` clears the local index ONCE; each page of
// session/entry rows out of Postgres is applied in ONE synchronous transaction (never
// held open across the caller's `await`s between pages, so a concurrent request can't
// hit a nested transaction). `done()` stamps the schema version so openDb does not
// re-rebuild from files afterward. Between reset() and done() the local index is
// partial — archive reads answer "still syncing" exactly as they do during a
// byte-hydrate, the archive's own honest answer.
function indexLoader() {
  openDb();
  let upsertS = null;
  let insertE = null;
  return {
    reset() {
      upsertS = db.prepare(`INSERT OR REPLACE INTO sessions(
          transcriptId, host, siteKey, remoteKey, repo, worktree, slug, createdAt, endedTs,
          summary, msgCount, bytesStored, archiveBytes, rawBytes, filePath, updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      insertE = db.prepare(
        "INSERT INTO entries_fts(text, transcriptId, uuid, role, ts) VALUES(?,?,?,?,?)");
      tx(() => {
        db.exec("DELETE FROM entries_fts");
        db.exec("DELETE FROM sessions");
      });
    },
    sessions(rows) {
      tx(() => {
        for (const r of rows) {
          // `?? null` keeps a recorded "" (a real no-org owner, still gated) distinct
          // from a legacy NULL — the same rule rebuildIndex uses for the sidecar.
          upsertS.run(r.transcriptId, r.host ?? null, r.siteKey ?? null, r.remoteKey ?? null,
            r.repo ?? null, r.worktree ?? null, r.slug ?? null, r.createdAt ?? null,
            r.endedTs ?? null, r.summary ?? null, r.msgCount || 0, r.bytesStored || 0,
            r.archiveBytes || 0, r.rawBytes || 0, r.filePath ?? null, r.updatedAt ?? null);
        }
      });
    },
    entries(rows) {
      tx(() => {
        for (const e of rows) {
          insertE.run(String(e.text || ""), e.transcriptId, e.uuid || null,
            e.role || null, e.ts || null);
        }
      });
    },
    done() {
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schemaVersion',?)")
        .run(String(SCHEMA_VERSION));
    },
  };
}

// After a Postgres hydrate, re-derive each filed transcript's BYTE CURSORS from the
// LOCAL FILES — the append-only ground truth for this replica — exactly as
// rebuildIndex does (bytesStored from the `.meta` sidecar, archiveBytes from the
// `.jsonl` SIZE, rawBytes from the raw directory). This is the correctness backstop
// for the one case where the Postgres of-record can lag the local files: a hub whose
// ARCHIVE_DIR volume PERSISTED across a restart that lost the in-memory index-mirror
// queue (a persistent-volume compose deploy; on k8s emptyDir the disk and the queue
// are lost together, so PG never lags the files there). Without it a too-low
// `bytesStored` makes the agent re-push a range the `.jsonl` already holds, and
// `appendFileSync` DUPLICATES it — the append-only corruption the file-authoritative
// cursor exists to prevent.
//
// It reads only the SIDECAR (267 bytes) + a `.jsonl` stat + the raw-dir walk per
// transcript — NEVER the `.jsonl` content — so the expensive part the Postgres
// hydrate skips (re-parsing every entry into the FTS index) stays skipped; this is
// O(transcripts) stats, the same class as the store-total walk, not O(entries).
// A no-op on a fresh replica (PG == the just-downloaded files). NOT re-mirrored: the
// local cursor is now correct, and the agent's next re-push re-mirrors the tail.
function reconcileHydratedCursors() {
  openDb();
  const rows = db.prepare(
    "SELECT transcriptId, filePath, bytesStored, archiveBytes, rawBytes " +
    "FROM sessions WHERE filePath IS NOT NULL").all();
  const upd = db.prepare(
    "UPDATE sessions SET bytesStored=?, archiveBytes=?, rawBytes=? WHERE transcriptId=?");
  let healed = 0;
  for (const row of rows) {
    const paths = filePaths(row.filePath);
    let fileSize;
    try { fileSize = fs.statSync(paths.jsonl).size; }
    catch { continue; } // no local file (or unreadable): trust PG, as rebuildIndex skips it
    const sc = readSidecar(paths.meta);
    const bytesStored = sc && Number.isFinite(sc.bytesStored) ? sc.bytesStored : (row.bytesStored || 0);
    const rawBytes = walkAllBytes(paths.jsonl + RAW_DIR_SUFFIX);
    if (bytesStored === row.bytesStored && fileSize === row.archiveBytes && rawBytes === row.rawBytes) continue;
    upd.run(bytesStored, fileSize, rawBytes, row.transcriptId);
    healed += 1;
  }
  if (healed) {
    console.error(`archive: reconciled ${healed} transcript cursor(s) against local files ` +
      `after a Postgres index hydrate (files ahead of the of-record; XERK-780)`);
  }
  return healed;
}

// ---- the dsh Trajectory (XERK-498) ------------------------------------------
// A read-only Trajectory over a dsh session's D3 NATIVE event log — the
// canonical record the raw layer already keeps at `<id>/dsh/*.jsonl` (XERK-469),
// so no host proxy and no per-session dsh web server. Parsed HERE, server-side
// and in ONE place, into the turns / steps / tool-calls / token-usage / timings
// the S1 projection flattens away — the richer telemetry D3 exists to retain.
// This is the Turma-native viewer that replaces the removed per-session dsh
// terminal. BOUNDED on every axis: the log is served on an HTTP route and is
// attacker-influenced (a session holds whatever was pasted into it), so the read
// is capped, tool-call args are snippeted, and no raw bytes are returned.
const DSH_TRAJ_READ_MAX = 8 * 1024 * 1024;    // bytes of the log we scan (tail)
const DSH_TRAJ_TURNS_MAX = 1000;              // turns kept (newest)
const DSH_TRAJ_CALLS_MAX = 4000;              // tool calls kept (across turns)
const DSH_TRAJ_SNIPPET = 400;                 // per tool-call arg snippet
// The bounded-FULL copy behind the UI's expand-to-full toggle (XERK-720). The
// snippet above stays the collapsed display; when a field is longer, the fold
// also carries up to this many chars so the operator can expand it in place
// instead of only ever seeing the first 400. Per-field bounded AND — because
// every field is a slice of the tail-capped read — bounded in aggregate by the
// read cap, so this never ships more than the reducer already held in memory.
const DSH_TRAJ_FULL_MAX = 1024 * 1024;        // per text/args/result full copy

// Attach a snippeted display value to obj[key], plus — only when the value was
// actually cut — a bounded-full copy obj[key+"Full"] (and obj[key+"Clipped"]
// when even that bound truncated) for the UI's expand-to-full toggle (XERK-720).
// Additive to the trajectory contract: a fold that omits the extras leaves the
// field simply un-expandable (the superset rule). A short value sets only the
// display key, so the common case is unchanged.
function attachTrajSnip(obj, key, s, snipMax, fullMax) {
  s = String(s == null ? "" : s);
  if (s.length <= snipMax) { obj[key] = s; return; }
  obj[key] = s.slice(0, snipMax) + "…";
  obj[key + "Full"] = s.length > fullMax ? s.slice(0, fullMax) : s;
  if (s.length > fullMax) obj[key + "Clipped"] = true;
}

function dshTrajNum(x) {
  return (typeof x === "number" && isFinite(x) && x >= 0) ? Math.floor(x) : 0;
}

// The session's native dsh events file inside the raw layer, or null. Matches on
// the `/dsh/` segment + `.jsonl` so a renamed log file still resolves.
function dshEventsFile(transcriptId) {
  const files = listRawFiles(transcriptId);
  if (!files) return null;
  const hit = files.find((f) => /(^|\/)dsh\/[^/]+\.jsonl$/.test(f.path));
  return hit ? hit.path : null;
}

function dshTrajectory(transcriptId) {
  const rel = dshEventsFile(transcriptId);
  if (!rel) return null;
  const full = rawFileFor(transcriptId, rel);
  if (!full) return null;
  let text = "", truncated = false;
  try {
    const fd = fs.openSync(full, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const take = Math.min(size, DSH_TRAJ_READ_MAX);
      // Read the TAIL when oversized — a live viewer wants the most RECENT turns,
      // and a leading partial line is dropped below.
      const start = size - take;
      truncated = start > 0;
      const buf = Buffer.allocUnsafe(take);
      let off = 0;
      while (off < take) {
        const n = fs.readSync(fd, buf, off, take - off, start + off);
        if (n <= 0) break;
        off += n;
      }
      text = buf.toString("utf8", 0, off);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (truncated) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; }

  const snip = (s) => {
    s = String(s == null ? "" : s);
    return s.length > DSH_TRAJ_SNIPPET ? s.slice(0, DSH_TRAJ_SNIPPET) + "…" : s;
  };
  // Guarded so a deeply-nested/cyclic tool argument (byte-for-byte arbitrary
  // session content) cannot blow the stack and crash the fold (XERK-714 QA).
  const dshArgStr = (v) => {
    if (typeof v === "string") return v;
    if (v == null) return "";
    try { const s = JSON.stringify(v); return typeof s === "string" ? s : String(v); }
    catch { return "[unserializable]"; }
  };
  const turnsMap = new Map();  // turn number -> object
  const order = [];            // turn numbers, first-seen order
  const stepsSeen = new Set(); // "<turn>/<step>"
  let title = null, model = null, firstTime = null, lastTime = null;
  let calls = 0, callsDropped = 0;
  const totals = { turns: 0, steps: 0, toolCalls: 0, errors: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const getTurn = (n) => {
    let t = turnsMap.get(n);
    if (!t) {
      t = { turn: n, startedAt: null, endedAt: null, reason: null, steps: 0,
        calls: [], tokens: { input: 0, output: 0 } };
      turnsMap.set(n, t); order.push(n); totals.turns++;
    }
    return t;
  };

  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    const type = e.type, d = (e.data && typeof e.data === "object") ? e.data : {};
    const time = (typeof e.time === "number" && isFinite(e.time)) ? e.time : null;
    if (time != null) {
      if (firstTime == null || time < firstTime) firstTime = time;
      if (lastTime == null || time > lastTime) lastTime = time;
    }
    const tn = d.turn;
    if (type === "session/title" && d.title) { title = snip(d.title); continue; }
    if (type === "turn/start" && typeof tn === "number") {
      const t = getTurn(tn); if (t.startedAt == null) t.startedAt = time; continue;
    }
    if (type === "turn/end" && typeof tn === "number") {
      const t = getTurn(tn); t.endedAt = time;
      t.reason = (d.reason && d.reason.kind) ? String(d.reason.kind) : null;
      if (t.reason === "error") totals.errors++;
      continue;
    }
    if (type === "step/start" && typeof tn === "number" && typeof d.step === "number") {
      const k = tn + "/" + d.step;
      if (!stepsSeen.has(k)) { stepsSeen.add(k); getTurn(tn).steps++; totals.steps++; }
      continue;
    }
    if (type === "tool/call" && typeof tn === "number") {
      totals.toolCalls++;
      if (calls < DSH_TRAJ_CALLS_MAX) {
        const call = {
          name: String(d.name || "?"),
          callId: d.callId != null ? String(d.callId) : null,
          at: time, ok: null, error: false,
        };
        attachTrajSnip(call, "args", dshArgStr(d.arguments), DSH_TRAJ_SNIPPET, DSH_TRAJ_FULL_MAX);
        getTurn(tn).calls.push(call);
        calls++;
      } else callsDropped++;
      continue;
    }
    if (type === "tool/result") {
      const msg = (d.message && typeof d.message === "object") ? d.message : {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      const cid = (msg.source && msg.source.callId)
        || (content[0] && content[0].toolCallId) || null;
      const isErr = content.some((c) => c && c.isError === true);
      if (isErr) totals.errors++;
      if (cid != null && typeof tn === "number") {
        const t = turnsMap.get(tn);
        const call = t && t.calls.find((c) => c.callId === String(cid) && c.ok === null);
        if (call) {
          call.ok = !isErr; call.error = isErr;
          call.durationMs = (call.at != null && time != null)
            ? Math.max(0, time - call.at) : null;
        }
      }
      continue;
    }
    if (type === "assistant/chunk" && d.chunk && d.chunk.type === "usage" && d.chunk.usage) {
      const u = d.chunk.usage;
      const inp = dshTrajNum(u.inputTokens), out = dshTrajNum(u.outputTokens);
      totals.tokens.input += inp;
      totals.tokens.output += out;
      totals.tokens.cacheRead += dshTrajNum(u.cacheReadInputTokens);
      totals.tokens.cacheWrite += dshTrajNum(u.cacheCreationInputTokens);
      if (typeof tn === "number") {
        const t = getTurn(tn); t.tokens.input += inp; t.tokens.output += out;
      }
      continue;
    }
    if (type === "assistant/message" && !model
        && d.message && d.message.source && d.message.source.model) {
      const m = d.message.source.model;
      model = snip(typeof m === "string" ? m : ((m && m.model) || ""));
      continue;
    }
  }
  let turns = order.map((n) => turnsMap.get(n));
  let turnsDropped = 0;
  if (turns.length > DSH_TRAJ_TURNS_MAX) {
    turnsDropped = turns.length - DSH_TRAJ_TURNS_MAX;
    turns = turns.slice(-DSH_TRAJ_TURNS_MAX);
  }
  return {
    transcriptId, title, model,
    startedAt: firstTime, endedAt: lastTime,
    durationMs: (firstTime != null && lastTime != null) ? lastTime - firstTime : null,
    totals, turns,
    truncated: truncated || turnsDropped > 0 || callsDropped > 0,
    turnsDropped, callsDropped,
  };
}

// The Trajectory reducer for Claude AND Qwen (XERK-714, epic XERK-712). One
// parser serves both runtimes because Qwen's on-disk transcript is PROJECTED to
// a Claude-shaped envelope (agent/qwen_transcript.py::_project) — the two shapes
// differ only in the message body, which this fold handles per-line with no
// runtime branch. The contract (field names FINAL) is docs/trajectory-contract.md:
// a superset of dshTrajectory() above that also carries the conversation. BOUNDED
// on every axis for the same reason dsh is (attacker-influenced content on an HTTP
// route): the read is tail-capped, every text/args/result is snippeted, and only
// structured JSON is ever returned — never raw bytes.
const TRAJ_READ_MAX = DSH_TRAJ_READ_MAX;      // bytes of the log we scan (tail)
const TRAJ_TURNS_MAX = DSH_TRAJ_TURNS_MAX;    // turns kept (newest)
const TRAJ_CALLS_MAX = DSH_TRAJ_CALLS_MAX;    // tool calls kept (across turns)
const TRAJ_SNIPPET = DSH_TRAJ_SNIPPET;        // per text/args/result snippet (=400)
const TRAJ_FULL_MAX = DSH_TRAJ_FULL_MAX;      // per text/args/result full copy (expand)
// The native Qwen store dir inside the raw layer (mirrors hub-agent.py's
// QWEN_STORE_DIRNAME) — the fallback when no projected <sid>.jsonl is present.
const TRAJ_QWEN_STORE_DIRNAME = "qwen";

// Token counts are agent-supplied: reject NaN/Infinity/negative, and CLAMP a
// finite-but-absurd value (a crafted 1e308) so summing many turns can never
// overflow the totals to a bogus Infinity — 1e15 is orders of magnitude above
// any real session and stays finite when multiplied by the turn cap.
const TRAJ_TOKEN_MAX = 1e15;
function trajNum(x) {
  if (typeof x !== "number" || !isFinite(x) || x < 0) return 0;
  return Math.min(Math.floor(x), TRAJ_TOKEN_MAX);
}

// ISO-8601 timestamp string -> epoch ms, or null. Both the Claude raw and Qwen
// projected shapes carry a per-line ISO `timestamp` (unlike dsh's numeric `time`).
function trajTime(e) {
  if (!e || typeof e.timestamp !== "string") return null;
  const ms = Date.parse(e.timestamp);
  return isFinite(ms) ? ms : null;
}

// Locate the per-session raw transcript to fold. A top-level `<sid>.jsonl` serves
// BOTH the Claude raw transcript and the Qwen projected one (the projection the
// ticket says to prefer); the dsh events file lives under `/dsh/` and is excluded
// by the no-separator match. Falls back to the native Qwen `<tid>/qwen/chat.jsonl`
// when only the un-projected store is present.
function claudeTrajFile(transcriptId) {
  const files = listRawFiles(transcriptId);
  if (!files || !files.length) return null;
  const topLevel = files.filter((f) => /^[^/]+\.jsonl$/.test(f.path));
  if (topLevel.length) {
    // Prefer the file named for this transcript when the store holds several.
    const exact = topLevel.find((f) => f.path === `${transcriptId}.jsonl`);
    return (exact || topLevel[0]).path;
  }
  const qwenRe = new RegExp(`(^|/)${TRAJ_QWEN_STORE_DIRNAME}/[^/]+\\.jsonl$`);
  const hit = files.find((f) => qwenRe.test(f.path));
  return hit ? hit.path : null;
}

// Read the TAIL of the raw file up to `cap` bytes; a leading partial line is
// dropped (as in dshTrajectory) and `truncated` records that we did not see the
// whole file. Returns null only when the file cannot be read at all.
function trajReadTail(full, cap) {
  let text = "", truncated = false;
  try {
    const fd = fs.openSync(full, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const take = Math.min(size, cap);
      const start = size - take;
      truncated = start > 0;
      const buf = Buffer.allocUnsafe(take);
      let off = 0;
      while (off < take) {
        const n = fs.readSync(fd, buf, off, take - off, start + off);
        if (n <= 0) break;
        off += n;
      }
      text = buf.toString("utf8", 0, off);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (truncated) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; }
  return { text, truncated };
}

function claudeTrajectory(transcriptId) {
  const rel = claudeTrajFile(transcriptId);
  if (!rel) return null;
  const full = rawFileFor(transcriptId, rel);
  if (!full) return null;
  const read = trajReadTail(full, TRAJ_READ_MAX);
  if (!read) return null;
  return claudeTrajectoryFromText(transcriptId, read.text, read.truncated);
}

// The line-fold CORE of claudeTrajectory(), over raw <sid>.jsonl text already in
// hand rather than a file on disk. XERK-716 feeds it the BOUNDED raw tail an
// agent returns on demand for a RUNNING claude/qwen session — whose raw layer is
// deferred to session end (agent-archive.md, `defer_raw`), so claudeTrajFile()
// finds nothing hub-side yet — so a live session gets the SAME full-fidelity
// trajectory (real tokens/model/timings) an ended one does, reduced by the SAME
// js fold with no second (python) reducer to keep in parity. `text` is already
// caller-bounded (the agent caps its tail at TRAJECTORY_TAIL_MAX_BYTES);
// `truncated` says the source file was larger than what `text` carries. Returns
// the same shape claudeTrajectory() does; the route stamps `partial:false`.
function claudeTrajectoryFromText(transcriptId, text, truncated) {
  text = String(text == null ? "" : text);
  truncated = !!truncated;

  const snip = (s) => {
    s = String(s == null ? "" : s);
    return s.length > TRAJ_SNIPPET ? s.slice(0, TRAJ_SNIPPET) + "…" : s;
  };
  // Stringify a tool-call input/result for snipping. The value is byte-for-byte
  // arbitrary archived content, so JSON.stringify can BLOW THE STACK on a deeply
  // nested object (a real Read/Bash/MCP result can hold one) or throw on a cycle
  // — guard it and fall back to a bounded string rather than crashing the fold.
  const asStr = (v) => {
    if (typeof v === "string") return v;
    if (v == null) return "";
    try { const s = JSON.stringify(v); return typeof s === "string" ? s : String(v); }
    catch { return "[unserializable]"; }
  };

  const turns = [];            // in first-seen order; 1-based `turn` set at open
  let cur = null;              // the turn open entries attach to
  const callsById = new Map(); // callId -> call obj, for call<->result correlation
  const seenUsage = new Set(); // usage keys already counted (dedupe below)
  let title = null, model = null, firstTime = null, lastTime = null;
  let sawQwen = false;
  let calls = 0, callsDropped = 0;
  const totals = { turns: 0, toolCalls: 0, errors: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

  const openTurn = (time, userText) => {
    let user = null;
    if (userText != null) { user = {}; attachTrajSnip(user, "text", userText, TRAJ_SNIPPET, TRAJ_FULL_MAX); }
    cur = { turn: totals.turns + 1, startedAt: time, endedAt: time, durationMs: null,
      user,
      output: [], model: null,
      calls: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reason: null };
    turns.push(cur); totals.turns++;
    return cur;
  };
  const ensureTurn = (time) => cur || openTurn(time, null);
  const touchEnd = (time) => { if (cur && time != null) cur.endedAt = time; };
  // Push a model-output block (text/thinking) with the snippet + expand-full copy.
  const pushOut = (kind, text) => {
    const b = { kind };
    attachTrajSnip(b, "text", text, TRAJ_SNIPPET, TRAJ_FULL_MAX);
    cur.output.push(b);
  };

  const openCall = (id, name, input, time) => {
    totals.toolCalls++;
    if (calls >= TRAJ_CALLS_MAX) { callsDropped++; return; }
    const call = { name: String(name || "?"),
      callId: id != null ? String(id) : null,
      at: time, ok: null, error: false,
      result: null, durationMs: null };
    attachTrajSnip(call, "args", asStr(input), TRAJ_SNIPPET, TRAJ_FULL_MAX);
    ensureTurn(time).calls.push(call);
    if (call.callId != null) callsById.set(call.callId, call);
    calls++;
  };
  // Close a call by id with its result. `isError` is authoritative (a Qwen
  // toolCallResult.status or a Claude tool_result.is_error). Count the error ONCE,
  // on the transition — a duplicate or orphan result (no in-window call) must not
  // inflate totals.errors, which tracks errored CALLS.
  const closeCall = (id, resultText, isError, time) => {
    if (id == null) return;
    const call = callsById.get(String(id));
    if (!call || call.ok !== null) return;
    call.ok = !isError; call.error = !!isError;
    attachTrajSnip(call, "result", resultText, TRAJ_SNIPPET, TRAJ_FULL_MAX);
    call.durationMs = (call.at != null && time != null) ? Math.max(0, time - call.at) : null;
    if (isError) totals.errors++;
  };

  const addUsage = (key, u) => {
    if (key != null) { if (seenUsage.has(key)) return; seenUsage.add(key); }
    const t = ensureTurn(null);
    for (const [k, v] of Object.entries(u)) { t.tokens[k] += v; totals.tokens[k] += v; }
  };

  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    const type = e.type;
    const m = (e.message && typeof e.message === "object") ? e.message : {};
    const time = trajTime(e);
    if (time != null) {
      if (firstTime == null || time < firstTime) firstTime = time;
      if (lastTime == null || time > lastTime) lastTime = time;
    }

    // ---- Qwen projected: message.parts + separate tool_result lines ----
    if (Array.isArray(m.parts)) {
      sawQwen = true;
      if (type === "user") {
        const txt = m.parts.filter((p) => p && typeof p.text === "string" && !p.thought)
          .map((p) => p.text).join("");
        openTurn(time, txt);
      } else if (type === "assistant") {
        ensureTurn(time);
        if (e.model) { cur.model = snip(String(e.model)); model = cur.model; }
        for (const p of m.parts) {
          if (!p || typeof p !== "object") continue;
          if (p.functionCall && typeof p.functionCall === "object") {
            openCall(p.functionCall.id, p.functionCall.name, p.functionCall.args, time);
          } else if (p.thought) {
            pushOut("thinking", p.text || "");
          } else if (typeof p.text === "string") {
            pushOut("text", p.text);
          }
        }
        const um = (e.usageMetadata && typeof e.usageMetadata === "object") ? e.usageMetadata : null;
        if (um) addUsage(m.id || e.uuid || null, {
          input: trajNum(um.promptTokenCount), output: trajNum(um.candidatesTokenCount),
          cacheRead: trajNum(um.cachedContentTokenCount), cacheWrite: 0 });
      } else if (type === "tool_result") {
        const tcr = (e.toolCallResult && typeof e.toolCallResult === "object") ? e.toolCallResult : {};
        const isErr = tcr.status === "error";
        for (const p of m.parts) {
          const fr = p && p.functionResponse;
          if (!fr || typeof fr !== "object") continue;
          const resText = tcr.resultDisplay != null ? tcr.resultDisplay : asStr(fr.response);
          closeCall(fr.id != null ? fr.id : tcr.callId, resText, isErr, time);
        }
      }
      touchEnd(time);
      continue;
    }

    // ---- Claude raw: message.content string | block[] ----
    if (type === "user") {
      const c = m.content;
      if (typeof c === "string") {
        if (c.trim()) openTurn(time, c);
      } else if (Array.isArray(c)) {
        // A real user turn carries text; a line that is only tool_result blocks
        // (or empty) never opens one — it just correlates results below.
        const textBlocks = c.filter((b) => b && b.type === "text");
        if (textBlocks.length) {
          openTurn(time, textBlocks.map((b) => b.text || "").join(""));
        }
        for (const b of c) {
          if (b && b.type === "tool_result") {
            closeCall(b.tool_use_id, asStr(b.content), b.is_error === true, time);
          }
        }
      }
    } else if (type === "assistant") {
      ensureTurn(time);
      if (m.model) { cur.model = snip(String(m.model)); model = cur.model; }
      if (m.stop_reason) cur.reason = String(m.stop_reason);
      const c = Array.isArray(m.content) ? m.content : [];
      for (const b of c) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") pushOut("text", b.text || "");
        // On this fleet extended-thinking is stored ENCRYPTED: `thinking` is empty
        // and only `signature` is present — emit the block, NEVER surface `signature`.
        else if (b.type === "thinking") pushOut("thinking", b.thinking || "");
        else if (b.type === "tool_use") openCall(b.id, b.name, b.input, time);
      }
      // Claude splits one assistant message across lines that repeat the SAME
      // message.id AND its usage — dedupe on the id or tokens multiply-count.
      const u = (m.usage && typeof m.usage === "object") ? m.usage : null;
      if (u) addUsage(m.id || e.uuid || null, {
        input: trajNum(u.input_tokens), output: trajNum(u.output_tokens),
        cacheRead: trajNum(u.cache_read_input_tokens),
        cacheWrite: trajNum(u.cache_creation_input_tokens) });
      touchEnd(time);
    }
    // Everything else (system, control-plane noise) is ignored per the contract.
  }

  for (const t of turns) {
    t.durationMs = (t.startedAt != null && t.endedAt != null)
      ? Math.max(0, t.endedAt - t.startedAt) : null;
  }
  let kept = turns;
  let turnsDropped = 0;
  if (kept.length > TRAJ_TURNS_MAX) {
    turnsDropped = kept.length - TRAJ_TURNS_MAX;
    kept = kept.slice(-TRAJ_TURNS_MAX);  // keep the newest, as dsh does
  }
  return {
    transcriptId,
    runtime: sawQwen ? "qwen" : "claude",
    title, model,
    startedAt: firstTime, endedAt: lastTime,
    durationMs: (firstTime != null && lastTime != null) ? lastTime - firstTime : null,
    totals, turns: kept,
    truncated: truncated || turnsDropped > 0 || callsDropped > 0,
    turnsDropped, callsDropped,
  };
}

// A DEGRADED Trajectory built from the RENDERED layer, for a session whose RAW
// layer has not synced yet (XERK-715). A running claude/qwen session ships its
// rendered `<sid>.jsonl` hub-side while running but DEFERS its raw native log to
// session end (agent-archive.md, `defer_raw`), so dshTrajectory()/claudeTrajectory()
// — which both fold the RAW layer — return null for it. This folds what the
// rendered entries CAN say into the SAME contract shape: role-grouped turns with
// per-entry timestamps, the display blocks' text/thinking/tool-calls. What the
// rendered layer does NOT carry is flagged honestly rather than faked: token
// counts and per-turn model live only in the raw/usage layers, so `partial` is
// true and every `tokens` field is null (the live figures arrive with the
// live-enrichment ticket; this route must work WITHOUT it). Returns null when the
// rendered transcript is itself absent/placeholder, so the route can 404 "not
// archived". `runtime` is a best-effort hint from the caller (the rendered layer
// cannot tell claude from qwen — both render identically); defaults to claude.
function renderedTrajectory(transcriptId, runtime) {
  let t;
  try { t = getTranscript(transcriptId); } catch { return null; }
  if (!t || !Array.isArray(t.entries)) return null;

  const snip = (s) => {
    s = String(s == null ? "" : s);
    return s.length > TRAJ_SNIPPET ? s.slice(0, TRAJ_SNIPPET) + "…" : s;
  };
  const entryTime = (e) => {
    if (!e || typeof e.ts !== "string") return null;
    const ms = Date.parse(e.ts);
    return isFinite(ms) ? ms : null;
  };

  const turns = [];
  let cur = null;
  const callsById = new Map();
  let firstTime = null, lastTime = null;
  let calls = 0, callsDropped = 0;
  // `tokens` is null on totals AND every turn — the rendered layer cannot answer
  // it, and a fabricated 0 is indistinguishable from a real zero-spend turn.
  const totals = { turns: 0, toolCalls: 0, errors: 0, tokens: null };

  const openTurn = (time, userText) => {
    let user = null;
    if (userText != null) { user = {}; attachTrajSnip(user, "text", userText, TRAJ_SNIPPET, TRAJ_FULL_MAX); }
    cur = { turn: totals.turns + 1, startedAt: time, endedAt: time, durationMs: null,
      user,
      output: [], model: null, calls: [], tokens: null, reason: null };
    turns.push(cur); totals.turns++;
    return cur;
  };
  const ensureTurn = (time) => cur || openTurn(time, null);
  const touchEnd = (time) => { if (cur && time != null) cur.endedAt = time; };
  const pushOut = (kind, text) => {
    const b = { kind };
    attachTrajSnip(b, "text", text, TRAJ_SNIPPET, TRAJ_FULL_MAX);
    cur.output.push(b);
  };

  const openCall = (id, name, args, time) => {
    totals.toolCalls++;
    if (calls >= TRAJ_CALLS_MAX) { callsDropped++; return; }
    const call = { name: String(name || "?"),
      callId: id != null ? String(id) : null,
      at: time, ok: null, error: false,
      result: null, durationMs: null };
    attachTrajSnip(call, "args", args, TRAJ_SNIPPET, TRAJ_FULL_MAX);
    ensureTurn(time).calls.push(call);
    if (call.callId != null) callsById.set(call.callId, call);
    calls++;
  };
  const closeCall = (id, resultText, isError, time) => {
    if (id == null) return;
    const call = callsById.get(String(id));
    if (!call || call.ok !== null) return;
    call.ok = !isError; call.error = !!isError;
    attachTrajSnip(call, "result", resultText, TRAJ_SNIPPET, TRAJ_FULL_MAX);
    call.durationMs = (call.at != null && time != null) ? Math.max(0, time - call.at) : null;
    if (isError) totals.errors++;
  };

  for (const e of t.entries) {
    const time = entryTime(e);
    if (time != null) {
      if (firstTime == null || time < firstTime) firstTime = time;
      if (lastTime == null || time > lastTime) lastTime = time;
    }
    const blocks = Array.isArray(e.blocks) ? e.blocks : [];
    // A rendered block carries its kind on `t` (the tunnel/hub mirror shape),
    // never `type`: text / thinking / tool_use{name,input,id} / tool_result
    // {text,forId,isError} / command / command_output / interrupt / away_summary
    // / compact_summary, plus non-conversational markers (pr_link, compact_boundary,
    // task_notification) we skip.
    const userText = blocks.filter((b) => b && b.t === "text")
      .map((b) => b.text || "").join("");

    if (e.role === "user") {
      // A user entry that carries real text opens a turn; one that is only tool
      // output (no text block) just correlates results into the open turn.
      if (userText.trim()) openTurn(time, userText);
      for (const b of blocks) {
        if (b && b.t === "tool_result") closeCall(b.forId, b.text, b.isError === true, time);
      }
    } else {
      // assistant (and anything else that rendered) attaches to the open turn.
      ensureTurn(time);
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.t === "text" || b.t === "compact_summary" || b.t === "away_summary") {
          if (b.text) pushOut("text", b.text);
        } else if (b.t === "thinking") {
          pushOut("thinking", b.text || "");
        } else if (b.t === "command") {
          const line = b.args ? `${b.name || ""} ${b.args}` : String(b.name || "");
          pushOut("text", line);
        } else if (b.t === "command_output") {
          if (b.text) pushOut("text", b.text);
        } else if (b.t === "interrupt") {
          cur.reason = "interrupt";
        } else if (b.t === "tool_use") {
          openCall(b.id, b.name, b.input, time);
        } else if (b.t === "tool_result") {
          closeCall(b.forId, b.text, b.isError === true, time);
        }
      }
    }
    touchEnd(time);
  }

  for (const tn of turns) {
    tn.durationMs = (tn.startedAt != null && tn.endedAt != null)
      ? Math.max(0, tn.endedAt - tn.startedAt) : null;
  }
  let kept = turns;
  let turnsDropped = 0;
  if (kept.length > TRAJ_TURNS_MAX) {
    turnsDropped = kept.length - TRAJ_TURNS_MAX;
    kept = kept.slice(-TRAJ_TURNS_MAX);  // keep the newest, as the full folds do
  }
  return {
    transcriptId,
    runtime: runtime === "qwen" ? "qwen" : "claude",
    partial: true,
    title: t.summary != null ? snip(String(t.summary)) : null,
    model: null,
    startedAt: firstTime, endedAt: lastTime,
    durationMs: (firstTime != null && lastTime != null) ? lastTime - firstTime : null,
    totals, turns: kept,
    truncated: turnsDropped > 0 || callsDropped > 0,
    turnsDropped, callsDropped,
  };
}

module.exports = {
  ARCHIVE_DIR, ARCHIVE_DB, ARCHIVE_TRANSCRIPT_MAX, ARCHIVE_TOTAL_MAX,
  dshTrajectory, dshEventsFile,
  claudeTrajectory, claudeTrajectoryFromText, claudeTrajFile, renderedTrajectory,
  ARCHIVE_RAW_TRANSCRIPT_MAX, ARCHIVE_RAW_CURSOR_MAX, ARCHIVE_RAW_CURSOR_LOOKUP_MAX,
  ARCHIVE_MANIFEST_CURSOR_MAX,
  RAW_DIR_SUFFIX,
  slugify, archiveRelPath, resolveNewRelPath, __RELPATH_PROBE_MAX: RELPATH_PROBE_MAX,
  ftsQuery, byteCeiling, shedFilePayloads,
  openDb, closeDb, rebuildIndex, setBlobSink,
  // Boot/hydrate serialization + corrupt-cache self-heal (XERK-789) — all inert
  // off HA (`hydrating` is only ever set around the HA index hydrate).
  isHydrating, setHydrating, isSqliteCorruption, resetLocalIndex, checkIndexIntegrity,
  // The Postgres INDEX of-record seam (XERK-780): the write sink + the hydration
  // bulk loader + the post-hydrate cursor reconcile (all no-ops off HA — the sink
  // stays unset, and the loader/reconcile only run on the HA hydrate path).
  setIndexSink, indexLoader, reconcileHydratedCursors,
  ingestChunk, manifestCursors, inventoryCursors, rawCursorsForIds,
  archiveLimits, normalizeMeta, META_TEXT_MAX,
  // The raw layer (XERK-338).
  ingestRaw, rawCursors, rawLimits, listRawFiles, rawFileFor,
  safeRawRel, rawDirFor, rawFilePath,
  totalArchiveBytes, totalForCeiling, __resetTotalCache,
  searchArchive, listArchive, getTranscript, sessionRow, restampOrg,
  // Test seam. The raw layer's own `.jsonl` files carry no `.meta`, so the
  // rebuild would skip them anyway — this is exported so the SKIP itself can be
  // pinned rather than that backstop, because the skip is what stops a rebuild
  // reading the entire raw store into memory to reach the same conclusion.
  __walkJsonl(dir) { const out = []; walkJsonl(dir || ARCHIVE_DIR, out, 0); return out; },
};
