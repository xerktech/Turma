// The archive's searchable index as a shared Postgres of-record (XERK-780, epic
// XERK-775). The ADR (docs/turma-ha-store-adr.md, "Why the archive splits")
// designates Postgres the durable of-record for the archive INDEX; the BYTES stay
// in object storage (XERK-759, unchanged). This is that index backend.
//
// WHY a Postgres index at all. Before this, the index was a per-pod local
// node:sqlite file (archive.js) that a booting/promoted replica REBUILT by walking
// every hydrated `.jsonl` and re-parsing it (archive.js `rebuildIndex`). That
// per-pod rebuild is the bulk of the cold-promote gap (prod finding A, XERK-772),
// and under active-active it races concurrent-replica ingest. A shared Postgres
// index of-record removes both: a promoted/new replica HYDRATES its local index
// FROM POSTGRES (indexed rows over the wire, no file walk, no re-parse), and every
// ingest is an IDEMPOTENT ON-CONFLICT upsert so more than one replica ingesting the
// same transcript concurrently converges instead of corrupting.
//
// THE DESIGN, and where it draws the line (the ledger/registry house pattern —
// .claude/rules/turma-usage.md, turma-ha-registry.md). archive.js keeps its LOCAL
// node:sqlite index as the SYNCHRONOUS read/write model in BOTH modes:
//   - HA off: byte-identical — this module is never created, no sink is wired, the
//     local SQLite tree is the whole story exactly as before.
//   - HA on: the local SQLite is a per-replica HOT read cache. It is what the
//     synchronous request path (searchArchive/listArchive/getTranscript) and the
//     heartbeat cursor path (manifestCursors/rawCursors/…) read — those CANNOT be
//     async (the request path is sync throughout server.js) and a Postgres round
//     trip may never sit on the beat (XERK-395, restated in turma-ha-postgres.md).
//     Postgres is the DURABLE MIRROR + hydration source ON TOP: every index write is
//     mirrored here (idempotent upsert, off the beat), and a promoted/booting replica
//     hydrates the local cache FROM here instead of rebuilding from the S3 bytes.
// DEFERRED (documented scope boundary, exactly like XERK-764's byte relay and
// XERK-778's request-path scope): a replica serving archive READS DIRECTLY from
// Postgres. Today only the LEADER serves (Option 2, `/readyz` leader-gated —
// turma-ha-leader.md), so its local cache answers every read; the query layer below
// (`searchQuery`/`listQuery`/`rowQuery`/`reclaimScan`) is implemented and
// parity-tested so direct per-replica serving is a wiring change when active-active
// serving lands, NOT a store swap.
//
// CONCURRENCY STORY (the genuine change from the leader-only Option-2 posture the
// ticket asks be stated). Every write here is an idempotent upsert:
//   - SESSION rows upsert ON CONFLICT(transcript_id): the monotonic byte/count
//     columns (bytes_stored, archive_bytes, raw_bytes, msg_count) are raised with
//     GREATEST(existing, incoming) — a low/partial writer can NEVER lower a recorded
//     cursor, the same high-water rule the ledger uses — and the metadata columns
//     take the incoming value. archive.js's own append-only + forward-only + ownership
//     gates (XERK-255/344/573) run in the local SQLite BEFORE the mirror fires, so the
//     value mirrored here is already the resolved one; GREATEST is the belt that keeps
//     two replicas reflecting the same transcript from ever regressing a cursor.
//   - ENTRY rows upsert ON CONFLICT(transcript_id, seq) DO NOTHING — entries are
//     append-only and keyed by their ordinal in the transcript, so a replayed beat or
//     a second replica reflecting the same range writes the same rows and the second
//     write is a no-op. A reconcile (a deleted/truncated `.jsonl` healed on read,
//     XERK-280) REPLACES a transcript's entries wholesale, matching the SQLite heal.
// Two replicas racing one transcript therefore converge with no lock and no lost
// update — the safe-concurrent-writer property the ticket names.
//
// stdlib ONLY. This speaks to Postgres exclusively through pgclient.js's PgPool
// (XERK-776) — a hand-rolled v3 wire client, no `pg`/`node_modules`. The pure SQL
// builders below are exported and unit-tested like buildUpsertGreatest; the socket
// path is exercised against pgclient's local protocol fake in CI and a real Postgres
// only in host QA (the SharedLiveStore / S3BlobStore posture).

"use strict";

// The columns of the session row, in one place so the DDL, the upsert and the
// hydration read never drift. `key` is the conflict target; `greatest` are the
// monotonic high-water columns (never lowered); the rest overwrite last-writer-wins.
// snake_case on the wire (Postgres folds unquoted identifiers to lower-case), mapped
// back to archive.js's camelCase `sessions` shape by `rowFromPg` / `pgFromRow`.
const SESSION_COLS = [
  "transcript_id", "host", "site_key", "remote_key", "repo", "worktree", "slug",
  "created_at", "ended_ts", "summary",
  "msg_count", "bytes_stored", "archive_bytes", "raw_bytes",
  "file_path", "updated_at",
];
const SESSION_GREATEST = ["msg_count", "bytes_stored", "archive_bytes", "raw_bytes"];

// archive.js's camelCase field <-> the snake_case column. Kept explicit (not a
// generic camel<->snake) so a rename on either side is a deliberate two-line edit,
// never a silent mismatch that mis-files a column.
const FIELD_TO_COL = {
  transcriptId: "transcript_id", host: "host", siteKey: "site_key",
  remoteKey: "remote_key", repo: "repo", worktree: "worktree", slug: "slug",
  createdAt: "created_at", endedTs: "ended_ts", summary: "summary",
  msgCount: "msg_count", bytesStored: "bytes_stored", archiveBytes: "archive_bytes",
  rawBytes: "raw_bytes", filePath: "file_path", updatedAt: "updated_at",
};
const COL_TO_FIELD = Object.fromEntries(
  Object.entries(FIELD_TO_COL).map(([f, c]) => [c, f]));

// The integer columns, so a text-protocol row (every value comes back as a string,
// or null) is coerced back to a number where archive.js expects one.
const INT_COLS = new Set(["msg_count", "bytes_stored", "archive_bytes", "raw_bytes"]);

// ============================================================================
// Pure SQL builders — exported for unit tests (the buildUpsertGreatest posture).
// Table/column names here are the module's OWN constants, never caller input, and
// pgclient's quoteIdent would reject anything outside [A-Za-z_][A-Za-z0-9_]* anyway;
// VALUES are always bound $n parameters, never interpolated.
// ============================================================================

// The schema DDL. `simple` text-search config (no stemming) so a stored term is
// matched as written — the closest analogue to the SQLite FTS5 default tokenizer the
// local index uses, so search parity holds. The tsvector is a STORED generated
// column so an insert never has to compute it and the GIN index stays current.
function schemaStatements(prefix) {
  const sessions = `${prefix}_sessions`;
  const entries = `${prefix}_entries`;
  return [
    `CREATE TABLE IF NOT EXISTS ${sessions} (
       transcript_id TEXT PRIMARY KEY,
       host TEXT, site_key TEXT, remote_key TEXT, repo TEXT, worktree TEXT, slug TEXT,
       created_at TEXT, ended_ts TEXT, summary TEXT,
       msg_count BIGINT NOT NULL DEFAULT 0, bytes_stored BIGINT NOT NULL DEFAULT 0,
       archive_bytes BIGINT NOT NULL DEFAULT 0, raw_bytes BIGINT NOT NULL DEFAULT 0,
       file_path TEXT, updated_at TEXT)`,
    // file_path is looked up by VALUE for the canonical-name collision check
    // (relPathOwner, XERK-277) — NOT unique (a pre-fix collided file legitimately
    // has two rows on one path), exactly as the SQLite index has it.
    `CREATE INDEX IF NOT EXISTS ${sessions}_file_path ON ${sessions} (file_path)`,
    `CREATE INDEX IF NOT EXISTS ${sessions}_ended ON ${sessions} (ended_ts, created_at)`,
    // The tsvector INPUT is bounded with left(): a Postgres tsvector has a ~1 MiB
    // hard size limit and raises "string is too long for tsvector" (an ERROR, not a
    // warning) past it, so a single pathological entry (a big log/code paste — an
    // entry text is bounded only by the ~2 MiB ingest chunk cap) would error its
    // INSERT and the mirror would best-effort DROP the whole sub-batch, silently
    // losing those entries from the of-record's search. The local FTS5 index has no
    // such limit, so this keeps the two tolerances aligned: TSVECTOR_INPUT_MAX chars
    // of any one entry are indexed for search (its FULL text is still STORED and
    // hydrated back verbatim — only search coverage of a huge single entry is capped,
    // which nothing real reaches). See the tsvector-limit note in the QA memory.
    `CREATE TABLE IF NOT EXISTS ${entries} (
       transcript_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       uuid TEXT, role TEXT, ts TEXT, text TEXT,
       tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(COALESCE(text, ''), ${TSVECTOR_INPUT_MAX}))) STORED,
       PRIMARY KEY (transcript_id, seq))`,
    `CREATE INDEX IF NOT EXISTS ${entries}_tsv ON ${entries} USING GIN (tsv)`,
  ];
}

// The session-row upsert: INSERT … ON CONFLICT(transcript_id) DO UPDATE, the
// SESSION_GREATEST columns raised with GREATEST() (never lowered — the high-water
// rule), the rest overwritten. Params are in column order. Pure.
function buildSessionUpsert(prefix, row) {
  const table = `${prefix}_sessions`;
  const cols = SESSION_COLS;
  const params = cols.map((c) => (INT_COLS.has(c) ? intParam(row[c]) : row[c] == null ? null : row[c]));
  const colList = cols.join(", ");
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const greatest = new Set(SESSION_GREATEST);
  const assignments = cols
    .filter((c) => c !== "transcript_id")
    .map((c) =>
      greatest.has(c)
        ? `${c} = GREATEST(${table}.${c}, EXCLUDED.${c})`
        : `${c} = EXCLUDED.${c}`)
    .join(", ");
  const text =
    `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ` +
    `ON CONFLICT (transcript_id) DO UPDATE SET ${assignments}`;
  return { text, params };
}

// One entry-row upsert value tuple builder (transcript_id, seq, uuid, role, ts, text).
// The batch insert below composes N of these into one multi-row INSERT with a single
// ON CONFLICT DO NOTHING — idempotent by (transcript_id, seq).
function buildEntryInsert(prefix, transcriptId, entries, startSeq) {
  const table = `${prefix}_entries`;
  const rows = [];
  const params = [];
  let seq = startSeq || 0;
  for (const e of entries) {
    const base = params.length;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
    params.push(transcriptId, seq, e.uuid == null ? null : e.uuid,
      e.role == null ? null : e.role, e.ts == null ? null : e.ts,
      e.text == null ? "" : String(e.text));
    seq += 1;
  }
  const text =
    `INSERT INTO ${table} (transcript_id, seq, uuid, role, ts, text) ` +
    `VALUES ${rows.join(", ")} ON CONFLICT (transcript_id, seq) DO NOTHING`;
  return { text, params };
}

// Full-text search across archived sessions, the Postgres analogue of archive.js's
// searchArchive FTS5 MATCH. `tsquery` is built by `ftsToTsquery` (prefix terms,
// AND-joined) so the query semantics match the local index. Returns the same row
// shape searchArchive's SQL projects (id/host/remoteKey/repo/summary/endedTs +
// role/ts/uuid + a <mark>…</mark> snippet + rank), ordered by rank. Pure builder.
function buildSearch(prefix, tsquery, opts) {
  const sessions = `${prefix}_sessions`;
  const entries = `${prefix}_entries`;
  const where = [`e.tsv @@ to_tsquery('simple', $1)`];
  const params = [tsquery];
  if (opts && opts.repo) { params.push(opts.repo); where.push(`s.repo = $${params.length}`); }
  if (opts && opts.host) { params.push(opts.host); where.push(`s.host = $${params.length}`); }
  params.push(opts && opts.limit ? opts.limit : 100);
  const limitIdx = params.length;
  const text = `
    SELECT s.transcript_id, s.host, s.remote_key, s.repo, s.summary, s.ended_ts,
           e.role AS role, e.ts AS ts, e.uuid AS uuid,
           ts_headline('simple', e.text, to_tsquery('simple', $1),
             'StartSel=<mark>,StopSel=</mark>,MaxWords=14,MinWords=3,ShortWord=0,HighlightAll=false,MaxFragments=1,FragmentDelimiter=…') AS snippet,
           ts_rank(e.tsv, to_tsquery('simple', $1)) AS rnk
    FROM ${entries} e JOIN ${sessions} s ON s.transcript_id = e.transcript_id
    WHERE ${where.join(" AND ")}
    ORDER BY rnk DESC
    LIMIT $${limitIdx}`;
  return { text, params };
}

// Browse ended sessions (newest first), the analogue of listArchive. Pure.
function buildList(prefix, opts) {
  const sessions = `${prefix}_sessions`;
  const where = [];
  const params = [];
  if (opts && opts.repo) { params.push(opts.repo); where.push(`repo = $${params.length}`); }
  if (opts && opts.host) { params.push(opts.host); where.push(`host = $${params.length}`); }
  params.push(opts && opts.limit ? opts.limit : 100);
  const limitIdx = params.length;
  params.push(opts && opts.offset ? opts.offset : 0);
  const offIdx = params.length;
  const text =
    `SELECT ${SESSION_COLS.join(", ")} FROM ${sessions} ` +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `ORDER BY COALESCE(ended_ts, created_at, '') DESC, transcript_id DESC ` +
    `LIMIT $${limitIdx} OFFSET $${offIdx}`;
  return { text, params };
}

// Turn archive.js's ftsQuery output (space-separated `"term"*` FTS5 prefix tokens)
// into a Postgres tsquery (`term:* & term:*`). Reuses the caller's already-sanitized
// token list rather than re-parsing free text, so the two indexes tokenize the same
// user string identically. "" (no usable token) yields "" and the caller returns no
// results, exactly as searchArchive does.
function ftsToTsquery(ftsExpr) {
  const terms = String(ftsExpr || "")
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean)
    .map((t) => `${t}:*`);
  return terms.join(" & ");
}

// Coerce a value bound as a BIGINT param to an integer string Postgres accepts, or
// null. archive.js may hand a JS number; a non-finite/absurd one is dropped to 0
// (the same defensive posture the SQLite side takes — a poisoned counter must not
// break the mirror write).
function intParam(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

// Map a Postgres text-protocol row (snake_case keys, all-string/null values) to
// archive.js's camelCase `sessions` row shape, coercing the integer columns back to
// numbers. The one place the wire shape becomes the in-memory shape.
function rowFromPg(pg) {
  const out = {};
  for (const [col, field] of Object.entries(COL_TO_FIELD)) {
    let v = pg[col];
    if (v !== undefined && INT_COLS.has(col)) v = v == null ? 0 : Number(v);
    if (v !== undefined) out[field] = v == null ? null : v;
  }
  return out;
}

// Map archive.js's camelCase `sessions` row to the snake_case column bag the upsert
// builder consumes.
function pgFromRow(row) {
  const out = {};
  for (const [field, col] of Object.entries(FIELD_TO_COL)) {
    if (row[field] !== undefined) out[col] = row[field];
  }
  // A placeholder/partial row may omit columns; the builder reads undefined as null.
  return out;
}

// ============================================================================
// PgIndexStore — the live backend over a PgPool. The socket path (its round trips)
// is host-QA-only; CI drives the SQL builders + the mirror/hydration LOGIC against a
// fake pool. Every method is async (Postgres is), so callers on the sync request
// path never reach it — the local SQLite answers them; this is the mirror + hydrate.
// ============================================================================

const DEFAULT_PREFIX = "archive";
// The batch size hydration pages a large index back in — bounded so one SELECT never
// buffers an unbounded result (pgclient caps a single message, but a giant row set is
// still memory) and a slow store never holds the promotion open on one query.
const HYDRATE_PAGE = 1000;
// Max entry rows per INSERT. Each entry is 6 bound params, so this keeps one
// statement at 6000 params — far under pgclient's Int16 value-count encode (throws
// past 32767) AND Postgres's own 65535-param statement cap. A large transcript's
// entries are inserted across several statements, seq continuity preserved.
const ENTRY_INSERT_MAX = 1000;
// Max CHARACTERS of one entry's text fed to `to_tsvector` (see the schema). The
// tsvector's ~1 MiB hard limit is measured in LEXEME BYTES, not characters, so the
// cap must be byte-safe for the WORST encoding: a UTF-8 char is up to 4 bytes, and a
// space-separated multibyte run (CJK prose) yields short indexed tokens whose lexeme
// bytes ≈ the input bytes (a SPACELESS run instead becomes one >2046-byte token that
// Postgres SKIPS with a notice, so it can't overflow). At 200k chars the input is
// ≤ ~800 KB and the worst-case tsvector (all-distinct short tokens + positions) stays
// comfortably under 1 MiB for ANY encoding — closing the char-vs-byte gap a 500k cap
// left for CJK/emoji text. Only search COVERAGE of one pathological huge entry is
// capped here; its full text is still STORED and hydrated verbatim.
const TSVECTOR_INPUT_MAX = 200000;

class PgIndexStore {
  /**
   * @param {object} pool  a pgclient PgPool (query/execute/ready/health).
   * @param {object} [cfg] { prefix }
   */
  constructor(pool, cfg = {}) {
    this.pool = pool;
    this.prefix = cfg.prefix || DEFAULT_PREFIX;
    this._schemaReady = null;
  }

  // Create the tables/indexes once (idempotent DDL). Awaited by the first write and
  // by hydrate; a second caller reuses the same promise so DDL runs once per boot.
  ensureSchema() {
    if (this._schemaReady) return this._schemaReady;
    this._schemaReady = (async () => {
      for (const sql of schemaStatements(this.prefix)) {
        // Simple Query for parameter-less DDL (pgclient exposes it via query()).
        await this.pool.query(sql, []);
      }
    })().catch((e) => {
      // A failed DDL must be retried on the next attempt, not cached as done.
      this._schemaReady = null;
      throw e;
    });
    return this._schemaReady;
  }

  // Mirror one session row (metadata + high-water cursors) to the of-record. The row
  // is archive.js's camelCase shape; `pgFromRow` maps it. Idempotent (GREATEST +
  // last-writer metadata). Awaited by the mirror worker, off the beat.
  async upsertSession(row) {
    await this.ensureSchema();
    const { text, params } = buildSessionUpsert(this.prefix, pgFromRow(row));
    await this.pool.execute(text, params);
  }

  // Append a transcript's entries at their ordinals, idempotent by (transcript_id,
  // seq) — a replayed/concurrent write of the same range is a no-op. `startSeq` is
  // the count of entries this transcript already had (the local msgCount before this
  // chunk), so the ordinals continue the transcript's own sequence.
  async appendEntries(transcriptId, entries, startSeq) {
    if (!entries || !entries.length) return;
    await this.ensureSchema();
    await this._insertEntriesBatched(transcriptId, entries, startSeq || 0);
  }

  // Replace a transcript's entries wholesale (the reconcile / rebuild-one case — a
  // deleted/truncated `.jsonl` healed on read, XERK-280). Deletes then re-inserts
  // from seq 0, matching the SQLite heal.
  async replaceEntries(transcriptId, entries) {
    await this.ensureSchema();
    await this.pool.execute(`DELETE FROM ${this.prefix}_entries WHERE transcript_id = $1`, [transcriptId]);
    if (entries && entries.length) {
      await this._insertEntriesBatched(transcriptId, entries, 0);
    }
  }

  // Insert entries in SUB-BATCHES so one INSERT never exceeds the Postgres v3 bound
  // parameter limit. Each entry is 6 bound params; the wire encodes the value count
  // as an Int16 (pgclient's `encodeBind` throws past 32767, and Postgres itself caps
  // at 65535 params per statement), so a single INSERT of a whole large transcript's
  // entries would overflow — a chunk's first delta is its ENTIRE transcript, easily
  // thousands of entries. Without the sub-batch the write threw, the IndexMirror
  // caught + dropped it, and a promoted replica's full-text search silently missed
  // that transcript. ENTRY_INSERT_MAX rows keep the count far under both limits. Seq
  // continuity is preserved across sub-batches (each starts at startSeq+offset).
  async _insertEntriesBatched(transcriptId, entries, startSeq) {
    for (let i = 0; i < entries.length; i += ENTRY_INSERT_MAX) {
      const slice = entries.slice(i, i + ENTRY_INSERT_MAX);
      const { text, params } = buildEntryInsert(this.prefix, transcriptId, slice, startSeq + i);
      await this.pool.execute(text, params);
    }
  }

  // Drop a transcript entirely (the reclaim case — rows for a deleted `.jsonl`,
  // XERK-332). Idempotent.
  async deleteTranscript(transcriptId) {
    await this.ensureSchema();
    await this.pool.execute(`DELETE FROM ${this.prefix}_entries WHERE transcript_id = $1`, [transcriptId]);
    await this.pool.execute(`DELETE FROM ${this.prefix}_sessions WHERE transcript_id = $1`, [transcriptId]);
  }

  // ---- the query layer (parity with archive.js; the active-active read seam) -----

  // Search rows (already grouped/shaped by the caller like searchArchive does).
  async searchQuery(ftsExpr, opts) {
    const tq = ftsToTsquery(ftsExpr);
    if (!tq) return [];
    await this.ensureSchema();
    const { text, params } = buildSearch(this.prefix, tq, opts);
    return this.pool.query(text, params);
  }

  // Browse rows (snake_case → camelCase via rowFromPg).
  async listQuery(opts) {
    await this.ensureSchema();
    const { text, params } = buildList(this.prefix, opts);
    const rows = await this.pool.query(text, params);
    return rows.map(rowFromPg);
  }

  // One session row by id, or null.
  async rowQuery(transcriptId) {
    await this.ensureSchema();
    const rows = await this.pool.query(
      `SELECT ${SESSION_COLS.join(", ")} FROM ${this.prefix}_sessions WHERE transcript_id = $1`,
      [transcriptId]);
    return rows.length ? rowFromPg(rows[0]) : null;
  }

  // ---- hydration: Postgres -> a local-SQLite applier (retires the S3 rebuild) -----

  // Page every session row and every entry row out of the of-record and hand each
  // PAGE (an array) to `apply` — archive.js's bulk loader, which clears the local
  // index once and inserts each page into node:sqlite in ONE synchronous transaction.
  // This REPLACES rebuildIndex's walk-and-reparse of the hydrated `.jsonl` files on
  // boot/promotion: the rows come straight off the indexed of-record, so a just-
  // promoted replica is index-ready without re-reading the store.
  //
  // The apply is BATCH-per-page, NOT streaming-per-row, on purpose: a node:sqlite
  // transaction must never be held OPEN across one of this method's `await`s (a
  // concurrent request that starts its own transaction during that window would hit
  // "cannot start a transaction within a transaction"). Each page is applied in a
  // self-contained synchronous tx between the awaits.
  //
  // `apply` = { reset(), sessions(camelRows[]), entries([{transcriptId,uuid,role,ts,
  //   text}]), done() }.
  async hydrateInto(apply) {
    await this.ensureSchema();
    apply.reset(); // clear the local index once, before any page lands
    await this._pageAll(`${this.prefix}_sessions`, "transcript_id", SESSION_COLS,
      (page) => apply.sessions(page.map(rowFromPg)));
    await this._pageAll(`${this.prefix}_entries`, "transcript_id, seq",
      ["transcript_id", "uuid", "role", "ts", "text"],
      (page) => apply.entries(page.map((pg) => ({
        transcriptId: pg.transcript_id, uuid: pg.uuid, role: pg.role,
        ts: pg.ts, text: pg.text == null ? "" : pg.text,
      }))));
    if (apply.done) apply.done();
  }

  // Paginate a table by an ORDER BY key so a large index never buffers one giant
  // result set, handing each PAGE (array of raw pg rows) to `onPage`. LIMIT/OFFSET
  // is O(n^2)-ish but simple and only ever runs at promotion — a first-fill index is
  // ~thousands of transcripts, not millions, and a keyset cursor is future work if a
  // real fleet's index outgrows it.
  async _pageAll(table, orderCols, cols, onPage) {
    // `table`/`orderCols`/`cols` are the module's OWN constants; the page size and
    // offset are bound $n params (never interpolated), like every value here.
    let offset = 0;
    for (;;) {
      const rows = await this.pool.query(
        `SELECT ${cols.join(", ")} FROM ${table} ORDER BY ${orderCols} LIMIT $1 OFFSET $2`,
        [HYDRATE_PAGE, offset]);
      if (rows.length) onPage(rows);
      if (rows.length < HYDRATE_PAGE) break;
      offset += HYDRATE_PAGE;
    }
  }
}

// Factory — the ONE place the HA toggle + the wired Postgres pool decide whether a
// Postgres index of-record exists. Returns null when HA is off, when there is no
// pool (DATABASE_URL absent / config fatal — createPgClient already returned null),
// so nothing is wired single-process and the non-HA path is byte-identical, exactly
// like createBlobStore / createPgClient.
function createIndexStore(haConfig, pool, cfg = {}) {
  if (!haConfig || !haConfig.ha || !pool) return null;
  if (Array.isArray(haConfig.fatal) && haConfig.fatal.length) return null;
  return new PgIndexStore(pool, cfg);
}

module.exports = {
  createIndexStore,
  PgIndexStore,
  // Pure builders + mappers, exported for the unit tests.
  schemaStatements,
  buildSessionUpsert,
  buildEntryInsert,
  buildSearch,
  buildList,
  ftsToTsquery,
  rowFromPg,
  pgFromRow,
  intParam,
  SESSION_COLS,
  SESSION_GREATEST,
  FIELD_TO_COL,
  DEFAULT_PREFIX,
  HYDRATE_PAGE,
  ENTRY_INSERT_MAX,
};
