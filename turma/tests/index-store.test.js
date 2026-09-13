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

  // ---- the pg-mode (XERK-793) query layer: what archive.js calls when the local
  //      node:sqlite is retired. Faithful enough to drive searchArchive/listArchive
  //      + the sessions-only hydrate off this in-memory of-record.
  async searchQuery(ftsExpr, opts) {
    const terms = String(ftsExpr || "").split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/gi, "").toLowerCase()).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const [tid, m] of this.entries) {
      const s = this.sessions.get(tid);
      if (!s) continue;
      if (opts && opts.repo && s.repo !== opts.repo) continue;
      if (opts && opts.host && s.host !== opts.host) continue;
      for (const [, e] of [...m].sort((a, b) => a[0] - b[0])) {
        const text = String(e.text || "").toLowerCase();
        if (terms.every((t) => text.includes(t))) {
          out.push({
            transcript_id: tid, host: s.host, remote_key: s.remoteKey || null,
            repo: s.repo || null, summary: s.summary || null, ended_ts: s.endedTs || null,
            role: e.role || null, ts: e.ts || null, uuid: e.uuid || null,
            snippet: `<mark>${e.text}</mark>`,
          });
        }
      }
    }
    return opts && opts.limit ? out.slice(0, opts.limit) : out;
  }
  async listQuery(opts) {
    let rows = [...this.sessions.values()];
    if (opts && opts.repo) rows = rows.filter((r) => r.repo === opts.repo);
    if (opts && opts.host) rows = rows.filter((r) => r.host === opts.host);
    rows.sort((a, b) =>
      String(b.endedTs || b.createdAt || "").localeCompare(String(a.endedTs || a.createdAt || "")) ||
      String(b.transcriptId).localeCompare(String(a.transcriptId)));
    const off = (opts && opts.offset) || 0;
    const lim = (opts && opts.limit) || 100;
    return rows.slice(off, off + lim);
  }
  async rowQuery(id) { return this.sessions.get(id) || null; }
  async hydrateSessionsInto(apply) {
    apply.reset();
    const srows = [...this.sessions.values()];
    for (let i = 0; i < srows.length; i += 500) apply.sessions(srows.slice(i, i + 500));
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
    const before = (await archive.listArchive({})).sessions;
    assert.equal(before.length, 2);
    archive.closeDb();
    fs.rmSync(process.env.ARCHIVE_DB, { force: true });
    fs.rmSync(path.join(process.env.ARCHIVE_DIR, "turma"), { recursive: true, force: true });
    assert.ok(!fs.existsSync(path.join(process.env.ARCHIVE_DIR, "turma")), "the .jsonl files are gone");

    // HYDRATE FROM THE OF-RECORD (not the files) via archive.js's bulk loader.
    await mem.hydrateInto(archive.indexLoader());

    // The browse index reconstructed entirely from the of-record — no files read.
    const after = (await archive.listArchive({})).sessions;
    assert.equal(after.length, 2, "both transcripts reconstructed from the of-record");
    const byId = Object.fromEntries(after.map((s) => [s.transcriptId, s]));
    assert.equal(byId["t-hydrate-1"].msgCount, 2);
    assert.equal(byId["t-hydrate-1"].host, "nas");
    assert.equal(byId["t-hydrate-2"].summary, "Docs");
    // Full-text search reconstructed too (entries_fts came from the of-record).
    const hit = (await archive.searchArchive("quantum"));
    const ids = hit.groups.flatMap((g) => g.matches.map((m) => m.transcriptId));
    assert.ok(ids.includes("t-hydrate-1"), "search finds the hydrated transcript's entry");
    assert.equal((await archive.searchArchive("nonexistentzzz")).groups.length, 0);
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

test("XERK-793 PgIndexStore.hydrateSessionsInto: pages SESSIONS only, never the entries table", async () => {
  let sPage = [{ transcript_id: "t1", host: "nas", site_key: "", msg_count: "3",
    bytes_stored: "10", archive_bytes: "20", raw_bytes: "0", file_path: "turma/x.jsonl",
    remote_key: null, repo: "turma", worktree: null, slug: null, created_at: null,
    ended_ts: null, summary: "S", updated_at: null }];
  const queries = [];
  const pool = {
    async query(text) {
      queries.push(text);
      if (/CREATE /.test(text)) return [];
      if (/FROM archive_sessions ORDER BY/.test(text)) { const p = sPage; sPage = []; return p; }
      // A sessions-only hydrate must NEVER page the entries table (entries stay in PG,
      // searched direct — pg mode keeps no local entry index, XERK-793).
      if (/FROM archive_entries/.test(text)) throw new Error("must not page entries in a sessions-only hydrate");
      return [];
    },
    async execute() { return { rows: [], rowCount: 1 }; },
  };
  const store = new PgIndexStore(pool, { prefix: DEFAULT_PREFIX });
  const seen = { reset: 0, sessions: [], done: 0 };
  await store.hydrateSessionsInto({
    reset() { seen.reset++; },
    sessions(rows) { seen.sessions.push(...rows); },
    done() { seen.done++; },
  });
  assert.equal(seen.reset, 1, "reset once before any page");
  assert.equal(seen.done, 1);
  assert.equal(seen.sessions.length, 1);
  assert.equal(seen.sessions[0].transcriptId, "t1");
  assert.equal(seen.sessions[0].msgCount, 3, "bigint coerced to a number");
  assert.equal(seen.sessions[0].siteKey, "", "'' org preserved (rowFromPg)");
  assert.ok(queries.some((q) => /FROM archive_sessions ORDER BY/.test(q)), "paged the sessions table");
  assert.ok(!queries.some((q) => /FROM archive_entries/.test(q)), "never paged the entries table");
});

// ============================================================================
// 4. pg mode (XERK-793): the local node:sqlite index is RETIRED. Under HA the index
//    is the in-memory session-row MAP (hydrated from Postgres, beat-safe) + Postgres-
//    DIRECT full-text search — there is no local entries_fts to corrupt. Driven end to
//    end against the MemIndexStore of-record via setIndexMode("pg", store).
// ============================================================================

function pgSetup() {
  archive.closeDb();
  fs.rmSync(process.env.ARCHIVE_DIR, { recursive: true, force: true });
  const mem = new MemIndexStore();
  archive.setIndexSink(mem.sink());     // server.js wires this via IndexMirror
  archive.setIndexMode("pg", mem);      // ...and this: the retirement seam
  return mem;
}
function pgTeardown() {
  archive.setIndexSink(null);
  archive.setIndexMode(null);           // back to sqlite for any later test
  archive.closeDb();
}

test("XERK-793 pg mode: ingest writes NO local index.db, mirrors PG, reads serve from PG/map", async () => {
  const mem = pgSetup();
  try {
    assert.equal(archive.isPgMode(), true);
    const b1 = [ent("u0", "user", "the quantum widget failed"), ent("u1", "assistant", "patched it")];
    const len1 = Buffer.byteLength(JSON.stringify(b1));
    assert.equal(archive.ingestChunk("nas", "t-pg-1", META, 0, len1, b1, "acme").bytesStored, len1);
    const b2 = [ent("v0", "user", "unrelated docs typo")];
    archive.ingestChunk("nas", "t-pg-2", { ...META, summary: "Docs", repo: "other" }, 0,
      Buffer.byteLength(JSON.stringify(b2)), b2, "acme");

    // The whole point: NO local node:sqlite was ever opened or created.
    assert.ok(!fs.existsSync(process.env.ARCHIVE_DB), "no index.db created in pg mode");
    // The rows + entries reached the Postgres of-record (via the sync mirror sink).
    assert.equal(mem.sessions.get("t-pg-1").msgCount, 2);
    assert.equal(mem.sessions.get("t-pg-1").siteKey, "acme");
    assert.equal(mem.entries.get("t-pg-1").size, 2);

    // getTranscript: row from the MAP, CONTENT from the local .jsonl.
    const t = archive.getTranscript("t-pg-1");
    assert.equal(t.entries.length, 2);
    assert.equal(t.entries[0].text, "the quantum widget failed");
    assert.equal(t.host, "nas");
    // sessionRow (restore path) also reads the map.
    assert.equal(archive.sessionRow("t-pg-1").repo, "turma");

    // search: DIRECT from Postgres (there is no local entries_fts).
    const ids = (await archive.searchArchive("quantum")).groups.flatMap((g) => g.matches.map((m) => m.transcriptId));
    assert.ok(ids.includes("t-pg-1"));
    assert.equal((await archive.searchArchive("nonexistentzzz")).groups.length, 0);

    // list: DIRECT from Postgres, filters applied.
    assert.equal((await archive.listArchive({})).sessions.length, 2);
    assert.deepEqual((await archive.listArchive({ repo: "other" })).sessions.map((s) => s.transcriptId), ["t-pg-2"]);

    // restampOrg re-points the map row (host + org) and re-mirrors to PG.
    assert.equal(archive.restampOrg("t-pg-1", "rival", "other-host"), true);
    assert.equal(archive.sessionRow("t-pg-1").host, "other-host");
    assert.equal(mem.sessions.get("t-pg-1").siteKey, "rival");
  } finally { pgTeardown(); }
});

test("XERK-793 pg mode: the beat cursor path + org gate run off the in-memory map", async () => {
  const mem = pgSetup();
  try {
    // manifestCursors creates a placeholder (0 bytes) in the map AND mirrors it to PG.
    const have = archive.manifestCursors("nas",
      [{ transcriptId: "t-mc", remoteKey: "rk", repo: "turma" }], "acme");
    assert.equal(have["t-mc"], 0);
    assert.equal(mem.sessions.get("t-mc").siteKey, "acme", "org stamped on the placeholder (XERK-344)");

    // A cross-org host's first chunk is REFUSED by the ownership gate on the map row.
    const refused = archive.ingestChunk("evil", "t-mc", META, 0, 10, [ent("x", "user", "hijack")], "rival");
    assert.equal(refused.bytesStored, 0);
    assert.equal(mem.entries.get("t-mc"), undefined, "nothing written for the cross-org push");

    // The owning host fills it (same-host append, never gated).
    const body = [ent("u0", "user", "alpha needle")];
    const len = Buffer.byteLength(JSON.stringify(body));
    assert.equal(archive.ingestChunk("nas", "t-mc", META, 0, len, body, "acme").bytesStored, len);
    assert.equal((await archive.searchArchive("needle")).groups.length, 1);

    // inventoryCursors: names back a rendered-short transcript, off the map.
    assert.equal(archive.inventoryCursors("nas", [{ i: "t-mc", s: len + 999, r: 0 }], "acme")["t-mc"], len);
    // archiveLimits reads the map cursor (under budget -> not shed).
    assert.deepEqual(archive.archiveLimits(["t-mc"]).shed, []);
  } finally { pgTeardown(); }
});

test("XERK-793 pg mode: a promoted replica hydrates its map from PG (sessions only)", async () => {
  const mem = pgSetup();
  try {
    const b = [ent("u0", "user", "gamma content")];
    const len = Buffer.byteLength(JSON.stringify(b));
    archive.ingestChunk("nas", "t-hy", META, 0, len, b, "acme");
    archive.ingestRaw("nas", "t-hy", "t-hy.jsonl", 0, Buffer.from("rawbytes"));

    // Simulate a FRESH replica: drop the local map (setIndexMode(null) then a fresh
    // pg mode makes a new empty map), keeping the of-record + the local files.
    archive.setIndexMode(null);
    archive.setIndexSink(mem.sink());
    archive.setIndexMode("pg", mem);
    assert.equal(archive.sessionRow("t-hy"), null, "the fresh replica's map is empty pre-hydrate");

    // Hydrate SESSIONS from PG into the map (entries stay in PG — no entry paging).
    await mem.hydrateSessionsInto(archive.sessionLoader());
    assert.equal(archive.sessionRow("t-hy").msgCount, 1, "the row hydrated into the map");
    // reconcile cursors from local files: a no-op here (PG == files), must not throw.
    assert.equal(archive.reconcileHydratedCursors(), 0);
    // search still serves from PG; getTranscript still reads the local file.
    assert.equal((await archive.searchArchive("gamma")).groups.length, 1);
    assert.equal(archive.getTranscript("t-hy").entries.length, 1);
  } finally { pgTeardown(); }
});

test("XERK-793 pg mode: heal-on-read and reclaim do NOT mutate the of-record", async () => {
  const mem = pgSetup();
  try {
    const b = [ent("u0", "user", "delta one"), ent("u1", "assistant", "delta two")];
    const len = Buffer.byteLength(JSON.stringify(b));
    archive.ingestChunk("nas", "t-heal", META, 0, len, b, "acme");
    const relPath = mem.sessions.get("t-heal").filePath;
    // Truncate the local .jsonl under the surviving row (an operator hand-edit / a
    // hydration gap on THIS replica). The of-record (Postgres) is authoritative.
    fs.writeFileSync(path.join(process.env.ARCHIVE_DIR, relPath), "");
    const t = archive.getTranscript("t-heal");
    assert.equal(t.entries.length, 0, "reads the honest local (truncated) view");
    assert.equal(mem.entries.get("t-heal").size, 2, "PG entries untouched — heal-on-read is disabled in pg mode");
    assert.equal(mem.sessions.get("t-heal").msgCount, 2, "PG row msgCount untouched");
  } finally { pgTeardown(); }
});
