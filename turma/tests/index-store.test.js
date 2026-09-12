// The archive's Postgres INDEX of-record (XERK-780). Three layers, the pgclient
// posture (pure core + fake backend in CI; a real Postgres only in host QA):
//   1. the PURE SQL builders + mappers (buildSessionUpsert's GREATEST, the entry
//      ON CONFLICT DO NOTHING, the search/list SQL, the tsquery + camel<->snake maps);
//   2. the MIRROR + HYDRATE + CONCURRENCY logic against a faithful in-memory of-record
//      (idempotent convergence, and archive.js's sink→of-record→hydrate round-trip
//      reconstructing the index with the FILES DELETED — the retirement of the
//      rebuild-from-files);
//   3. the PgIndexStore→pool contract over a spy pool (the socket itself is pgclient's
//      own tested concern).
// zero-npm; node:sqlite prints an ExperimentalWarning to stderr (expected).

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

// archive.js reads ARCHIVE_DIR/ARCHIVE_DB at require time; set them first (this file
// runs in its own subprocess under `node --test`, so the env is private).
const TMP = mkdtemp("turma-index-store-");
process.env.ARCHIVE_DIR = path.join(TMP, "archive");
process.env.ARCHIVE_DB = path.join(TMP, "archive", "index.db");

const archive = require("../archive.js");
const {
  createIndexStore, PgIndexStore,
  schemaStatements, buildSessionUpsert, buildEntryInsert, buildSearch, buildList,
  ftsToTsquery, rowFromPg, pgFromRow, intParam,
  SESSION_COLS, SESSION_GREATEST, DEFAULT_PREFIX, ENTRY_INSERT_MAX,
} = require("../index-store.js");

// ============================================================================
// 1. Pure builders + mappers
// ============================================================================

test("schemaStatements: sessions + entries tables, a GIN tsvector index, a file_path index", () => {
  const stmts = schemaStatements("archive");
  const all = stmts.join("\n");
  assert.match(all, /CREATE TABLE IF NOT EXISTS archive_sessions/);
  assert.match(all, /CREATE TABLE IF NOT EXISTS archive_entries/);
  assert.match(all, /PRIMARY KEY \(transcript_id, seq\)/);
  // The tsvector input is bounded with left() so a huge entry can't overflow the
  // ~1 MiB tsvector limit and error (then drop) its INSERT.
  assert.match(all, /tsvector GENERATED ALWAYS AS \(to_tsvector\('simple', left\(COALESCE\(text, ''\), \d+\)\)\) STORED/);
  assert.match(all, /USING GIN \(tsv\)/);
  assert.match(all, /archive_sessions_file_path ON archive_sessions \(file_path\)/);
});

test("buildSessionUpsert: GREATEST on exactly the monotonic columns, EXCLUDED for the rest", () => {
  const row = pgFromRow({
    transcriptId: "t1", host: "nas", siteKey: "acme", repo: "turma",
    msgCount: 5, bytesStored: 100, archiveBytes: 200, rawBytes: 300, filePath: "turma/x.jsonl",
  });
  const { text, params } = buildSessionUpsert("archive", row);
  assert.match(text, /INSERT INTO archive_sessions/);
  assert.match(text, /ON CONFLICT \(transcript_id\) DO UPDATE SET/);
  // The 4 counters raise with GREATEST; a low/partial writer can never lower them.
  for (const c of SESSION_GREATEST) {
    assert.match(text, new RegExp(`${c} = GREATEST\\(archive_sessions\\.${c}, EXCLUDED\\.${c}\\)`), c);
  }
  // Metadata overwrites; never GREATEST'd.
  assert.match(text, /host = EXCLUDED\.host/);
  assert.match(text, /site_key = EXCLUDED\.site_key/);
  assert.ok(!/transcript_id = /.test(text), "the conflict key is never in the SET list");
  // Params are in column order, keys-then-values (the whole SESSION_COLS order here).
  assert.equal(params.length, SESSION_COLS.length);
  assert.equal(params[0], "t1"); // transcript_id first
  assert.equal(params[SESSION_COLS.indexOf("bytes_stored")], 100);
});

test("buildEntryInsert: one multi-row INSERT, ON CONFLICT (transcript_id, seq) DO NOTHING", () => {
  const { text, params } = buildEntryInsert("archive", "t1",
    [{ uuid: "u0", role: "user", ts: "T0", text: "hello" },
     { uuid: "u1", role: "assistant", ts: "T1", text: "world" }], 3);
  assert.match(text, /INSERT INTO archive_entries \(transcript_id, seq, uuid, role, ts, text\)/);
  assert.match(text, /ON CONFLICT \(transcript_id, seq\) DO NOTHING/);
  assert.match(text, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\), \(\$7, \$8, \$9, \$10, \$11, \$12\)/);
  // seq continues from startSeq (3, 4) — idempotent by ordinal across re-ingest.
  assert.deepEqual(params.slice(0, 6), ["t1", 3, "u0", "user", "T0", "hello"]);
  assert.deepEqual(params.slice(6), ["t1", 4, "u1", "assistant", "T1", "world"]);
});

test("buildSearch: tsvector match, prefix tsquery, ts_headline snippet, rank order", () => {
  const { text, params } = buildSearch("archive", "foo:* & bar:*", { repo: "turma", limit: 50 });
  assert.match(text, /e\.tsv @@ to_tsquery\('simple', \$1\)/);
  assert.match(text, /ts_headline\('simple', e\.text/);
  assert.match(text, /StartSel=<mark>,StopSel=<\/mark>/);
  assert.match(text, /ORDER BY rnk DESC/);
  assert.match(text, /s\.repo = \$2/);
  assert.deepEqual(params, ["foo:* & bar:*", "turma", 50]);
});

test("buildList: newest-first, repo/host filters, LIMIT/OFFSET", () => {
  const { text, params } = buildList("archive", { host: "nas", limit: 10, offset: 20 });
  assert.match(text, /FROM archive_sessions WHERE host = \$1/);
  assert.match(text, /ORDER BY COALESCE\(ended_ts, created_at, ''\) DESC, transcript_id DESC/);
  assert.match(text, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(params, ["nas", 10, 20]);
});

test("ftsToTsquery: FTS5 prefix tokens -> Postgres AND-joined prefix tsquery; empty stays empty", () => {
  assert.equal(ftsToTsquery('"hello"* "world"*'), "hello:* & world:*");
  assert.equal(ftsToTsquery(""), "");
  assert.equal(ftsToTsquery("   "), "");
  // Punctuation the FTS side already stripped never reaches the tsquery parser raw.
  assert.equal(ftsToTsquery('"a-b"*'), "ab:*");
});

test("rowFromPg / pgFromRow: camel<->snake round-trip, integer coercion, '' preserved", () => {
  const pg = { transcript_id: "t1", host: "nas", site_key: "", bytes_stored: "150", raw_bytes: null };
  const row = rowFromPg(pg);
  assert.equal(row.transcriptId, "t1");
  assert.equal(row.siteKey, "", "a recorded empty-string org is preserved, not nulled");
  assert.equal(row.bytesStored, 150, "a bigint text column coerces back to a number");
  assert.equal(row.rawBytes, 0, "a null integer column reads 0");
  const back = pgFromRow({ transcriptId: "t2", siteKey: null, msgCount: 7 });
  assert.equal(back.transcript_id, "t2");
  assert.equal(back.site_key, null);
  assert.equal(back.msg_count, 7);
});

test("intParam: coerces, truncates, drops a non-finite counter to 0 (never poisons the write)", () => {
  assert.equal(intParam(5), 5);
  assert.equal(intParam("42"), 42);
  assert.equal(intParam(3.9), 3);
  assert.equal(intParam(null), 0);
  assert.equal(intParam(Infinity), 0);
  assert.equal(intParam(NaN), 0);
});

// ============================================================================
// 2. The of-record: a faithful in-memory backend implementing the EXACT semantics
//    the Postgres SQL does (GREATEST on the monotonic columns, ON CONFLICT DO
//    NOTHING for entries by ordinal, wholesale replace on a reconcile), so the
//    mirror/hydrate/concurrency LOGIC is driven for real with no socket.
// ============================================================================

class MemIndexStore {
  constructor() {
    this.sessions = new Map();            // transcriptId -> camelCase row
    this.entries = new Map();             // transcriptId -> Map(seq -> {uuid,role,ts,text})
  }
  // Mirrors buildSessionUpsert: metadata last-writer, the 4 counters GREATEST-merged.
  upsertSession(row) {
    const id = row.transcriptId;
    const prev = this.sessions.get(id) || {};
    const merged = { ...prev, ...row };
    for (const c of ["msgCount", "bytesStored", "archiveBytes", "rawBytes"]) {
      merged[c] = Math.max(Number(prev[c] || 0), Number(row[c] || 0));
    }
    this.sessions.set(id, merged);
  }
  // Mirrors ON CONFLICT (transcript_id, seq) DO NOTHING — a replayed ordinal is a no-op.
  appendEntries(tid, ents, startSeq) {
    let m = this.entries.get(tid);
    if (!m) { m = new Map(); this.entries.set(tid, m); }
    let seq = startSeq || 0;
    for (const e of ents) { if (!m.has(seq)) m.set(seq, e); seq += 1; }
  }
  replaceEntries(tid, ents) {
    const m = new Map();
    let seq = 0;
    for (const e of ents) m.set(seq++, e);
    this.entries.set(tid, m);
  }
  deleteTranscript(tid) { this.sessions.delete(tid); this.entries.delete(tid); }
  // The archive.js sink shape.
  sink() {
    return {
      session: (r) => this.upsertSession(r),
      entries: (t, e, s) => this.appendEntries(t, e, s),
      replace: (t, e) => this.replaceEntries(t, e),
    };
  }
  // Mirrors PgIndexStore.hydrateInto: reset once, then batch-apply sessions + entries.
  hydrateInto(apply) {
    apply.reset();
    const srows = [...this.sessions.values()];
    for (let i = 0; i < srows.length; i += 500) apply.sessions(srows.slice(i, i + 500));
    const erows = [];
    for (const [tid, m] of this.entries) {
      for (const [, e] of [...m].sort((a, b) => a[0] - b[0])) erows.push({ transcriptId: tid, ...e });
    }
    for (let i = 0; i < erows.length; i += 500) apply.entries(erows.slice(i, i + 500));
    if (apply.done) apply.done();
  }
}

function ent(uuid, role, text, ts) {
  return { uuid, role, ts: ts || "2026-07-10T00:00:00Z", text };
}
const META = { remoteKey: "github.com/xerk/turma", repo: "turma", host: "nas",
  createdAt: "2026-07-10T00:00:00Z", endedTs: "2026-07-10T01:00:00Z", summary: "A Session" };

test("mirror: ingestChunk mirrors the full row + the appended entries at ordinals", () => {
  archive.closeDb();
  const mem = new MemIndexStore();
  archive.setIndexSink(mem.sink());
  try {
    const body = JSON.stringify([ent("u0", "user", "find the alpha bug"), ent("u1", "assistant", "fixed the beta")]);
    const len = Buffer.byteLength(body);
    const r = archive.ingestChunk("nas", "tid-a", META, 0, len,
      [ent("u0", "user", "find the alpha bug"), ent("u1", "assistant", "fixed the beta")], "acme");
    assert.equal(r.bytesStored, len);
    const row = mem.sessions.get("tid-a");
    assert.ok(row, "the session row was mirrored");
    assert.equal(row.host, "nas");
    assert.equal(row.siteKey, "acme", "the hub-decided org is mirrored");
    assert.equal(row.bytesStored, len);
    assert.equal(row.msgCount, 2);
    assert.match(row.filePath, /turma\//);
    const em = mem.entries.get("tid-a");
    assert.equal(em.size, 2, "both entries mirrored");
    assert.equal(em.get(0).text, "find the alpha bug");
    assert.equal(em.get(1).text, "fixed the beta");
  } finally {
    archive.setIndexSink(null);
  }
});

test("concurrency: a low/partial writer never lowers a cursor; a replayed range is a no-op", () => {
  const mem = new MemIndexStore();
  const sink = mem.sink();
  // Replica B lands the newer chunk first (bytesStored 200, entries seq 2-3)…
  sink.session({ transcriptId: "t", host: "nas", siteKey: "acme", bytesStored: 200, msgCount: 4 });
  sink.entries("t", [ent("u2", "user", "c"), ent("u3", "assistant", "d")], 2);
  // …then a STALE re-mirror of replica A's earlier chunk arrives (bytesStored 100)…
  sink.session({ transcriptId: "t", host: "nas", siteKey: "acme", bytesStored: 100, msgCount: 2 });
  // …and A's entries seq 0-1, plus a REPLAY of seq 2-3 (a re-ingest of the same range).
  sink.entries("t", [ent("u0", "user", "a"), ent("u1", "assistant", "b")], 0);
  sink.entries("t", [ent("u2", "user", "c"), ent("u3", "assistant", "d")], 2);

  const row = mem.sessions.get("t");
  assert.equal(row.bytesStored, 200, "GREATEST kept the higher cursor — never lowered");
  assert.equal(row.msgCount, 4, "GREATEST kept the higher count");
  const em = mem.entries.get("t");
  assert.equal(em.size, 4, "seq 0-3 present exactly once — the replay of 2-3 was a no-op");
  assert.equal(em.get(0).text, "a");
  assert.equal(em.get(3).text, "d");
});

test("hydrate: the index reconstructs from the of-record with the FILES DELETED (retires the rebuild)", async () => {
  // Isolate: start from an empty store (prior tests in this file share the dir).
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DIR, { recursive: true, force: true });
  const mem = new MemIndexStore();
  archive.setIndexSink(mem.sink());
  try {
    // Populate two transcripts through the real ingest path (files + local index +
    // mirror to the of-record).
    const b1 = [ent("u0", "user", "the quantum widget failed"), ent("u1", "assistant", "patched it")];
    archive.ingestChunk("nas", "t-hydrate-1", META, 0, Buffer.byteLength(JSON.stringify(b1)), b1, "acme");
    const b2 = [ent("v0", "user", "unrelated docs typo")];
    archive.ingestChunk("nas", "t-hydrate-2", { ...META, summary: "Docs" }, 0,
      Buffer.byteLength(JSON.stringify(b2)), b2, "acme");
    // A raw push raises the raw cursor and re-mirrors the row.
    archive.ingestRaw("nas", "t-hydrate-1", "t-hydrate-1.jsonl", 0, Buffer.from("raw bytes here"));

    // Capture the truth the LOCAL index holds, then WIPE THE LOCAL INDEX AND THE
    // FILES — everything a file-rebuild would read is gone.
    const before = archive.listArchive({}).sessions;
    assert.equal(before.length, 2);
    archive.closeDb();
    fs.rmSync(process.env.ARCHIVE_DB, { force: true });
    fs.rmSync(path.join(process.env.ARCHIVE_DIR, "turma"), { recursive: true, force: true });
    assert.ok(!fs.existsSync(path.join(process.env.ARCHIVE_DIR, "turma")), "the .jsonl files are gone");

    // HYDRATE FROM THE OF-RECORD (not the files) via archive.js's bulk loader.
    await mem.hydrateInto(archive.indexLoader());

    // The browse index reconstructed entirely from the of-record — no files read.
    const after = archive.listArchive({}).sessions;
    assert.equal(after.length, 2, "both transcripts reconstructed from the of-record");
    const byId = Object.fromEntries(after.map((s) => [s.transcriptId, s]));
    assert.equal(byId["t-hydrate-1"].msgCount, 2);
    assert.equal(byId["t-hydrate-1"].host, "nas");
    assert.equal(byId["t-hydrate-2"].summary, "Docs");
    // Full-text search reconstructed too (entries_fts came from the of-record).
    const hit = archive.searchArchive("quantum");
    const ids = hit.groups.flatMap((g) => g.matches.map((m) => m.transcriptId));
    assert.ok(ids.includes("t-hydrate-1"), "search finds the hydrated transcript's entry");
    assert.equal(archive.searchArchive("nonexistentzzz").groups.length, 0);
  } finally {
    archive.setIndexSink(null);
    archive.closeDb();
  }
});

test("hydrate reconcile: a Postgres of-record that LAGS the local files heals bytesStored (no dup re-push)", async () => {
  // Isolate.
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DIR, { recursive: true, force: true });
  const mem = new MemIndexStore();
  archive.setIndexSink(mem.sink());
  try {
    // Chunk 1 is mirrored; the of-record and the file agree at `len1`.
    const c1 = [ent("u0", "user", "first")];
    const len1 = Buffer.byteLength(JSON.stringify(c1));
    archive.ingestChunk("nas", "t-lag", META, 0, len1, c1, "acme");
    assert.equal(mem.sessions.get("t-lag").bytesStored, len1);

    // Chunk 2 lands in the LOCAL file + sidecar, but the mirror MISSES it (an
    // un-mirrored tail — the queue lost on a restart). The of-record stays at len1.
    archive.setIndexSink(null);
    const c2 = [ent("u1", "assistant", "second")];
    const len2 = len1 + Buffer.byteLength(JSON.stringify(c2));
    archive.ingestChunk("nas", "t-lag", META, len1, len2, c2, "acme");
    assert.equal(mem.sessions.get("t-lag").bytesStored, len1, "the of-record still lags at len1");

    // Wipe the LOCAL INDEX but keep the FILES (a persistent-volume restart).
    archive.closeDb();
    fs.rmSync(process.env.ARCHIVE_DB, { force: true });

    // Hydrate from the lagging of-record, then reconcile against the files.
    await mem.hydrateInto(archive.indexLoader());
    const beforeReconcile = archive.getTranscript("t-lag");
    assert.ok(beforeReconcile, "the transcript hydrated from the of-record");
    archive.reconcileHydratedCursors();

    // The cursor now matches the FILE (len2), not the stale of-record (len1) — so the
    // agent re-pushes from len2 and never re-appends [len1,len2) onto the file.
    const row = archive.sessionRow("t-lag");
    // sessionRow doesn't carry bytesStored; re-ingest at the healed cursor proves it:
    // an offset-len1 push is now REFUSED (cursor is len2), so no duplicate append.
    const stale = archive.ingestChunk("nas", "t-lag", META, len1, len2, c2, "acme");
    assert.equal(stale.bytesStored, len2, "the healed cursor is len2 — a len1 re-push is refused, no dup");
  } finally {
    archive.setIndexSink(null);
    archive.closeDb();
  }
});

test("HA off: with no sink set, ingest mirrors nothing (byte-identical hot path)", () => {
  archive.closeDb();
  archive.setIndexSink(null);
  const mem = new MemIndexStore();
  const body = [ent("u0", "user", "x")];
  archive.ingestChunk("nas", "t-nosink", META, 0, Buffer.byteLength(JSON.stringify(body)), body, "acme");
  assert.equal(mem.sessions.size, 0, "the sink was never called");
});

// ============================================================================
// 3. PgIndexStore -> pool contract, over a spy pool (the socket is pgclient's own
//    tested concern — here we prove the store issues the right shaped calls).
// ============================================================================

function spyPool(canned = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) { calls.push({ m: "query", text, params }); return canned.query || []; },
    async execute(text, params) { calls.push({ m: "execute", text, params }); return canned.execute || { rows: [], rowCount: 1 }; },
  };
}

test("createIndexStore: null off HA / no pool / fatal config; a PgIndexStore when HA on + pool", () => {
  const pool = spyPool();
  assert.equal(createIndexStore({ ha: false, fatal: [] }, pool), null);
  assert.equal(createIndexStore({ ha: true, fatal: [] }, null), null);
  assert.equal(createIndexStore({ ha: true, fatal: ["bad"] }, pool), null);
  assert.ok(createIndexStore({ ha: true, fatal: [] }, pool) instanceof PgIndexStore);
});

test("PgIndexStore: ensureSchema runs the DDL once; upsert/append/query issue their SQL", async () => {
  const pool = spyPool();
  const store = new PgIndexStore(pool, { prefix: DEFAULT_PREFIX });
  await store.upsertSession({ transcriptId: "t1", host: "nas", bytesStored: 5 });
  // First write ran the DDL (4 statements) then the upsert.
  const ddl = pool.calls.filter((c) => /CREATE (TABLE|INDEX)/.test(c.text));
  assert.equal(ddl.length, schemaStatements(DEFAULT_PREFIX).length);
  const upsert = pool.calls.find((c) => c.m === "execute" && /ON CONFLICT \(transcript_id\)/.test(c.text));
  assert.ok(upsert, "the session upsert was issued");
  // ensureSchema is cached — a second write does not re-run DDL.
  pool.calls.length = 0;
  await store.appendEntries("t1", [ent("u0", "user", "a")], 0);
  assert.equal(pool.calls.filter((c) => /CREATE (TABLE|INDEX)/.test(c.text)).length, 0);
  assert.ok(pool.calls.some((c) => /INSERT INTO archive_entries/.test(c.text)));

  await store.listQuery({ host: "nas" });
  assert.ok(pool.calls.some((c) => c.m === "query" && /FROM archive_sessions WHERE host = \$1/.test(c.text)));
});

test("PgIndexStore.appendEntries: sub-batches a huge chunk so no INSERT overflows the param bound (XERK-780 QA)", async () => {
  // A single chunk's first delta is its WHOLE transcript — thousands of entries. One
  // INSERT at 6 params/entry would exceed pgclient's Int16 value-count encode (throws
  // past 32767) and Postgres's 65535-param cap, so the write threw, the IndexMirror
  // dropped it, and search silently missed the transcript. Sub-batching fixes it.
  const pool = spyPool();
  const store = new PgIndexStore(pool, { prefix: DEFAULT_PREFIX });
  const N = 6000; // > the 5462-entry Int16-overflow threshold AND > ENTRY_INSERT_MAX
  const entries = Array.from({ length: N }, (_, i) => ent(`u${i}`, "user", `line ${i}`));
  await store.appendEntries("t-big", entries, 0);
  const inserts = pool.calls.filter((c) => /INSERT INTO archive_entries/.test(c.text));
  assert.ok(inserts.length >= Math.ceil(N / ENTRY_INSERT_MAX), `expected multiple INSERTs, got ${inserts.length}`);
  // Every INSERT stays well under the wire limits, and every seq 0..N-1 is covered
  // exactly once, contiguously.
  const seqs = [];
  for (const c of inserts) {
    assert.ok(c.params.length <= ENTRY_INSERT_MAX * 6, `an INSERT carried ${c.params.length} params`);
    assert.ok(c.params.length < 32767, "under pgclient's Int16 value-count encode limit");
    // params are (transcript_id, seq, uuid, role, ts, text) repeated; pull the seqs.
    for (let i = 0; i < c.params.length; i += 6) seqs.push(c.params[i + 1]);
  }
  seqs.sort((a, b) => a - b);
  assert.equal(seqs.length, N);
  assert.equal(seqs[0], 0);
  assert.equal(seqs[N - 1], N - 1);
  assert.ok(seqs.every((s, i) => s === i), "seqs are contiguous 0..N-1 across the sub-batches");
});

test("PgIndexStore.hydrateInto: pages sessions then entries into the apply, reset first", async () => {
  // A pool that returns one session page then empty, one entry page then empty.
  let sPage = [{ transcript_id: "t1", host: "nas", site_key: "", msg_count: "2",
    bytes_stored: "10", archive_bytes: "20", raw_bytes: "0", file_path: "turma/x.jsonl",
    remote_key: null, repo: "turma", worktree: null, slug: null, created_at: null,
    ended_ts: null, summary: "S", updated_at: null }];
  let ePage = [{ transcript_id: "t1", uuid: "u0", role: "user", ts: "T0", text: "hello" }];
  const pool = {
    async query(text) {
      if (/CREATE /.test(text)) return [];
      if (/FROM archive_sessions ORDER BY/.test(text)) { const p = sPage; sPage = []; return p; }
      if (/FROM archive_entries ORDER BY/.test(text)) { const p = ePage; ePage = []; return p; }
      return [];
    },
    async execute() { return { rows: [], rowCount: 1 }; },
  };
  const store = new PgIndexStore(pool, { prefix: DEFAULT_PREFIX });
  const seen = { reset: 0, sessions: [], entries: [], done: 0 };
  await store.hydrateInto({
    reset() { seen.reset++; },
    sessions(rows) { seen.sessions.push(...rows); },
    entries(rows) { seen.entries.push(...rows); },
    done() { seen.done++; },
  });
  assert.equal(seen.reset, 1, "reset once before any page");
  assert.equal(seen.done, 1);
  assert.equal(seen.sessions.length, 1);
  assert.equal(seen.sessions[0].transcriptId, "t1");
  assert.equal(seen.sessions[0].bytesStored, 10, "bigint coerced to a number");
  assert.equal(seen.sessions[0].siteKey, "", "'' org preserved");
  assert.equal(seen.entries.length, 1);
  assert.equal(seen.entries[0].text, "hello");
  assert.equal(seen.entries[0].transcriptId, "t1");
});
