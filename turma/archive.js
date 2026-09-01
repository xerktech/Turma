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
// rawBytes, the same for the raw layer (XERK-338). A bump recreates the tables
// and refills them from the files.
const SCHEMA_VERSION = 4;

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
// The most raw files ONE heartbeat's manifest may have stat-ed for its cursors.
//
// `rawCursors` is synchronous and runs on the heartbeat path, and the hub is one
// event loop — so this spends the same hub-wide-stall budget the store-total walk
// is sized against (14 ms there). Measured at ~5.6 us per stat: 2,000 files is
// ~11 ms, where the 40,000 an agent may offer under its OWN caps is 223 ms and the
// ~780,000 that fit in a 32 MiB HEARTBEAT_MAX is ~4.4 SECONDS of blocked loop —
// per beat, per host, with every dashboard, SSE tail and other host's beat queued
// behind it.
//
// The agent caps itself at ARCHIVE_RAW_MANIFEST_FILES_MAX, and that is NOT this
// bound: a bound the receiving path does not enforce is not a bound (XERK-235).
// Past it the extra files simply get no cursor, which the agent reads as zero and
// pushes from the start — refused by `ingestRaw`'s offset check, so the stored
// data is safe and the cost is one small wasted POST per over-cap file per pass.
// That only ever happens to an agent already ignoring its own cap.
const ARCHIVE_RAW_CURSOR_MAX = positiveEnvInt("ARCHIVE_RAW_CURSOR_MAX", 2000);
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

// ---- database ---------------------------------------------------------------

let db = null;

function createSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions(
     transcriptId TEXT PRIMARY KEY,
     host TEXT, remoteKey TEXT, repo TEXT, worktree TEXT, slug TEXT,
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
// So the index is OVERHEAD the operator sizes the volume for, not budget — and
// that overhead is AT LEAST 3x the ceiling and is NOT bounded. Measured 3.0-3.2x
// at first fill, but nothing reaps a deleted file's rows and rebuildIndex() only
// runs on a schema bump or an empty table, so a store that is repeatedly filled
// and wiped keeps growing the index: ~13 MB per fill/wipe cycle at an 8 MiB
// ceiling, reaching 61x by cycle 38, with the .jsonl total pinned at the ceiling
// throughout, and a hub restart does not reclaim it. Reclaiming that is XERK-332;
// until then, size the volume for the churn, not for one fill. The `.meta`
// sidecars are uncounted too: 267 bytes each, bounded by transcript count, and
// rewritten in place rather than grown.
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
function walkJsonlBytes(dir, depth) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // ENOENT at the root is the store genuinely absent: 0 is right, and is what
    // lets a removed directory be recreated instead of latching full forever.
    if (depth === 0 && e.code !== "ENOENT") throw e;
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
      // this volume writable (XERK-338).
      bytes += isRawDir(d.name, depth)
        ? walkAllBytes(full) : walkJsonlBytes(full, depth + 1);
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      // One unreadable file must not abandon the measurement and hand back a
      // total far under the truth — skip it and keep counting.
      try { bytes += fs.statSync(full).size; } catch { /* raced with a delete */ }
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
  try {
    bytes = walkJsonlBytes(ARCHIVE_DIR, 0);
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
  return bytes;
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
  for (let n = 2; n <= RELPATH_PROBE_MAX; n++) {
    const cand = `${stem}-${n}.jsonl`;
    if (!relPathOwner(cand, transcriptId)) return cand;
  }
  // Pathological (a forced flood on one prefix): the full id is unique by
  // construction and route-allowlisted; slugify keeps it a single component.
  return `${stem}-${slugify(transcriptId, "x")}.jsonl`;
}

function ingestChunk(host, transcriptId, meta, startOffset, endOffset, entries) {
  openDb();
  meta = normalizeMeta(meta);
  const row = db.prepare(
    "SELECT bytesStored, archiveBytes, filePath FROM sessions WHERE transcriptId=?"
  ).get(transcriptId);
  const have = row ? row.bytesStored : 0;
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
      // Charge the store total immediately rather than waiting for the next
      // walk — that gap is what let a burst run 1,200x past the ceiling.
      writtenSinceWalk += Buffer.byteLength(lines);
    }
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
  // ARCHIVE_RAW_CURSOR_MAX. The manifest arrives newest-transcript-first, so a
  // truncation drops the oldest history rather than the live sessions.
  let budget = ARCHIVE_RAW_CURSOR_MAX;
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
    `archive: a manifest offered more than ${ARCHIVE_RAW_CURSOR_MAX} raw files ` +
    `(ARCHIVE_RAW_CURSOR_MAX); ${dropped} got no cursor this beat. An agent inside ` +
    `its own limits never reaches this — check that host's ARCHIVE_RAW_* config.`);
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
function manifestCursors(host, manifest) {
  openDb();
  const have = {};
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
  const row = db.prepare("SELECT filePath, repo, host, worktree, summary, endedTs, createdAt "
    + "FROM sessions WHERE transcriptId=?").get(transcriptId);
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
    // The recorded cwd, so the page can tell a session that CAN be restored from
    // one whose "worktree" is really a transcript store — the majority of the
    // archive — instead of offering a control that always refuses.
    worktree: row.worktree, endedTs: row.endedTs, createdAt: row.createdAt, entries,
  };
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
      transcriptId, host, remoteKey, repo, worktree, slug, createdAt, endedTs,
      summary, msgCount, bytesStored, archiveBytes, rawBytes, filePath, updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      upsert.run(transcriptId, meta.host || null, meta.remoteKey || null,
        meta.repo || null, meta.worktree || null, meta.slug || null,
        meta.createdAt || null, meta.endedTs || null, meta.summary || null,
        msgCount, meta.bytesStored || 0, archiveBytes, rawBytes, relPath,
        meta.updatedAt || null);
    });
  }
  return files.length;
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
        getTurn(tn).calls.push({
          name: String(d.name || "?"),
          callId: d.callId != null ? String(d.callId) : null,
          at: time, ok: null, error: false,
          args: snip(typeof d.arguments === "string"
            ? d.arguments : JSON.stringify(d.arguments == null ? "" : d.arguments)),
        });
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

module.exports = {
  ARCHIVE_DIR, ARCHIVE_DB, ARCHIVE_TRANSCRIPT_MAX, ARCHIVE_TOTAL_MAX,
  dshTrajectory, dshEventsFile,
  ARCHIVE_RAW_TRANSCRIPT_MAX, ARCHIVE_RAW_CURSOR_MAX, ARCHIVE_MANIFEST_CURSOR_MAX,
  RAW_DIR_SUFFIX,
  slugify, archiveRelPath, resolveNewRelPath, ftsQuery, byteCeiling, shedFilePayloads,
  openDb, closeDb, rebuildIndex,
  ingestChunk, manifestCursors, archiveLimits, normalizeMeta, META_TEXT_MAX,
  // The raw layer (XERK-338).
  ingestRaw, rawCursors, rawLimits, listRawFiles, rawFileFor,
  safeRawRel, rawDirFor, rawFilePath,
  totalArchiveBytes, totalForCeiling, __resetTotalCache,
  searchArchive, listArchive, getTranscript, sessionRow,
  // Test seam. The raw layer's own `.jsonl` files carry no `.meta`, so the
  // rebuild would skip them anyway — this is exported so the SKIP itself can be
  // pinned rather than that backstop, because the skip is what stops a rebuild
  // reading the entire raw store into memory to reach the same conclusion.
  __walkJsonl(dir) { const out = []; walkJsonl(dir || ARCHIVE_DIR, out, 0); return out; },
};
