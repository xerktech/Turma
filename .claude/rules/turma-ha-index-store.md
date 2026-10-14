---
paths:
  - turma/index-store.js
  - turma/tests/index-store.test.js
---

# `index-store.js` — the archive index Postgres of-record (XERK-780)

Split out of `turma-ha-archive.md` (size ceiling); read that file for the byte mirror around it.

- **The DESIGN (post-XERK-793).** HA off: byte-identical — no store, no sink, the local node:sqlite is
  the whole index. HA on (`pg` mode): the local node:sqlite is RETIRED — the index is the in-memory
  `sessionsMap` (beat-safe, hydrated from PG, mirrored back) + Postgres-DIRECT search. The beat-cursor
  path (`manifestCursors`/…) and the sync reads (`getTranscript`/`sessionRow`) read the map; the async
  reads (`searchArchive`/`listArchive`) hit `searchQuery`/`listQuery`. Postgres is the durable
  of-record; the map is an ephemeral hot mirror (the ledger/registry house pattern, now with NO local
  sqlite behind it).
- **CLOSED (was DEFERRED): a replica serves archive READS from the shared Postgres of-record**
  (XERK-793). SEARCH/LIST go direct to PG every request (no per-replica staleness); the `sessionsMap`
  covers the beat-cursor path + getTranscript's row, hydrated on boot/promotion. The pre-XERK-793
  freshness residual (a session ingested on another replica invisible until this one re-hydrated its
  local SQLite cache) is gone for search/list — they read the shared of-record live. `getTranscript`
  still needs the local `.jsonl` for CONTENT (bytes hydrate from the bucket), so a transcript's BODY
  is visible on a replica only once its bytes have hydrated there; its metadata/search hit is live.
- **stdlib ONLY, over `pgclient.js`'s `PgPool`** (XERK-776) — no `pg`/`node_modules`. The pure SQL
  builders (`buildSessionUpsert`/`buildEntryInsert`/`buildSearch`/`buildList`/`ftsToTsquery`) +
  camel↔snake mappers are unit-tested; the socket path is host-QA-only.
- **The sink archive.js calls (`archive.setIndexSink`, no-op off HA) is SYNC + never throws** into
  the hot path — it enqueues; server.js's `IndexMirror` drains it to Postgres in a background loop
  (bounded `INDEX_MIRROR_QUEUE_MAX`, drop-oldest on overflow; a dropped op owes its transcript a
  REFILL, and the leader's periodic reconcile re-sends what Postgres is missing,
  `turma-ha-index-mirror.md`). A SESSION mutation mirrors the FULL
  row (re-read from the local index — the in-memory map in `pg` mode, the sqlite table otherwise) so
  the upsert never clobbers untouched metadata; ENTRIES mirror append-only by ordinal, or
  wholesale-replace on a reconcile (XERK-280).
- **CONCURRENCY story (the change from the leader-only Option-2 posture):** every write is idempotent.
  SESSION upserts `ON CONFLICT(transcript_id)` raise the monotonic byte/count columns with
  `GREATEST(existing, incoming)` (a low/partial writer can NEVER lower a cursor — the ledger's
  high-water rule) and overwrite metadata; ENTRY upserts `ON CONFLICT(transcript_id, seq) DO NOTHING`
  (a replayed range is a no-op). Two replicas racing one transcript converge with no lock. archive.js's
  own append-only/forward-only/ownership gates (XERK-255/344/573) run in the local index (the in-memory
  map in `pg` mode) BEFORE the mirror fires, so the mirrored value is already the resolved one;
  GREATEST is the belt.
- **Re-seating from a local copy is a SEAT, never a REPLACE (XERK-1837).** `reindexHeld` and the
  backfill mirror the `seat` op (`PgIndexStore.seatEntries`: overwrite ordinals [0..n), no trim).
  `replace` trims seq >= n, so a follower's heal from its stale copy deleted rows another replica
  had appended by the time it applied. Only a repair (leader-gated, term-checked) or a truncated
  file's heal-on-read (sqlite mode only) may trim.
- **A seat sends its file's FIRST-COPY lines, never the raw copy (XERK-1838)**
  (`heldEntries(jsonl, true)`). A stale pre-repair copy seated after the duplicate repair put the
  repeated lines back. First-copy de-dup is prefix-monotone (the repair's own rule), so the seat
  writes a prefix of the repaired rows; the next append lands at its seq when Postgres holds no
  tail past the seat (below).
  - The ingest path numbers its append after the FIRST-COPY count too (`prevCount = seated.length`),
    and the backfill row's `msgCount` is the first-copy count: raw counts left a seq hole (QA F2/F3).
  - A FOLLOWER's seat never trims: Postgres rows past its file may be another replica's appends.
  - **The leader's INGEST re-seat trims rows past the file** (XERK-1843, `reindexHeld(..., true)` →
    `replaceEntries` with the term check): only while leading under the term that queued it, and
    only at a term > 0 (no-lease mode never bumps it, and every replica leads there). A stale tail
    (pre-XERK-1450 damage, a raw copy with a pending repair) made the next append a `DO NOTHING`
    no-op until the next leader hydrate. Deposed by apply time, it falls back to the plain seat —
    never dropped.
  - **The backfill never trims**, even on the leader: it runs after the elector (term ≥ 1) from a
    copy that can lag entries the old leader already appended to Postgres (QA D1).
  - Do not gate the seat on leader+term instead: a dropped follower heal is a permanent search miss.
  - Tests: `XERK-1838:` + `XERK-1843:` in `index-mirror-heal.test.js` (call sites, trim, term).
- **Hydration (XERK-793, `pg` mode): sessions-only into the map** (`hydrateSessionsInto` →
  `archive.sessionLoader`) — it pages the SESSION rows out of Postgres into the in-memory `sessionsMap`
  (entries stay in PG; search reads them there), so a promotion is a small, entry-free load. The
  `setHydrating`→503-ingest gate wraps it, so `reset()`-then-fill never races a concurrent map write.
  (The legacy sqlite-hot-cache hydrate `PgIndexStore.hydrateInto` → `archive.indexLoader` — session +
  ENTRY pages BATCH-applied into a fresh local sqlite, tx never held across an `await` — remains for
  the degraded HA-no-PG path only.)
- **After the hydrate, `reconcileHydratedCursors` re-derives the BYTE CURSORS from the LOCAL FILES**
  into the index (the map in `pg` mode): bytesStored from the `.meta` sidecar, archiveBytes from the
  `.jsonl` stat, rawBytes from the raw walk — WITHOUT reading `.jsonl` content. Load-bearing: the
  Postgres of-record can LAG the local files on a persistent-volume restart that lost the in-memory
  mirror queue (on k8s emptyDir the disk + queue are lost together, so PG never lags there) — a
  too-low `bytesStored` would make the agent re-push a range the `.jsonl` already holds and
  `appendFileSync` DUPLICATE it. The files are the append-only ground truth for a replica's cursors;
  PG supplies the metadata. A no-op on a fresh replica.
- **`backfillPgIndexFromFiles` is the REBUILD-OF-RECORD-FROM-FILES backstop `pg` mode otherwise
  lacked (XERK-797)** — the companion to `reconcileHydratedCursors`, run right after the sessions
  hydrate. reconcileHydratedCursors only heals rows ALREADY in the map (cursor-lag); this closes the
  ROW-ABSENT case: PG wiped/rebuilt INDEPENDENTLY of the S3 byte-of-record (or a fresh PG beside an
  existing bucket) hydrates an EMPTY/lagging map while the `.jsonl` files are present locally, and the
  agent's next manifest then reads `have = 0` and re-pushes from offset 0 onto the already-populated
  `.jsonl` — `ingestChunk`'s `startOffset === have` guard is the sole duplicate protection and it was
  reset to 0. It walks the local files and, for any transcript whose file is present but whose map row
  is ABSENT or a not-yet-filled placeholder, rebuilds the full row into the map AND back into Postgres
  via the mirror sink (session + entries), so a replica SELF-HEALS a wiped PG from the S3-hydrated
  files. SAFE against a legitimately-empty archive (acts only where a `.jsonl` EXISTS — no files, no
  rebuild) and a NO-OP on the normal path (every file already a filed row), so the expensive entry
  re-parse XERK-793 retired runs ONLY for genuinely-missing rows, off the beat under the `hydrating`
  gate. Idempotent (GREATEST upsert + entry `replace` at [0..n)) so a re-run / concurrent replica
  converges. Rebuilds from each file's OWN sidecar, so it never re-attributes. This makes the
  operator runbook line ("never wipe the archive PG without also wiping S3") a nicety, not a
  requirement.
- **RECLAIM (`maybeReclaimIndex`) is a no-op in `pg` mode** — there is no on-disk `index.db` to bloat
  (it never opens sqlite: `openDb()` early-returns, so the `!db` guard already skips it), and it must
  not delete from the Postgres of-record (deletion is an out-of-band operator action; a bucket/
  of-record lifecycle rule removes it — the SAME posture as the byte mirror's hand-delete gap). In
  sqlite mode (HA off) it reaps disposable local rows + VACUUMs as before (XERK-332).
- **`createIndexStore(haConfig, pool)` returns null with HA off / no pool / a fatal config**, so no
  sink is wired and the local SQLite is the whole story, byte-identical.
- **XERK-793 eliminated the FTS5 corruption surface this section addressed** — `pg` mode opens no
  local node:sqlite (no `entries_fts`), so the hydrate-vs-ingest corruption below CANNOT arise there;
  the `setHydrating`→503-ingest serialize still wraps the (map) hydrate, but the sqlite self-heal
  (`checkIndexIntegrity`/`resetLocalIndex`/`isSqliteCorruption`) is inert in `pg` mode. The rest of
  this section is the **sqlite-mode behavior** (HA off, or the degraded HA-no-PG path) + the history
  the fix descends from.
- **The boot hydrate and live ingest MUST NOT write the local node:sqlite concurrently** (XERK-789,
  the prod regression). `hydrateInto` `await`s each Postgres page, and the server accepts archive
  ingest the whole time, so an `ingestChunk` `tx()` interleaves with the hydrate's bulk fts5 writes /
  its `reset()` DELETE on the SAME `DatabaseSync` handle and PHYSICALLY corrupts `entries_fts`
  ("database disk image is malformed" / "fts5: corruption found reading blob …"), after which every
  later ingest on that replica fails and the archive silently stops. Two guards, both inert off HA:
  - **Serialize**: `archive.setHydrating(true)` wraps `hydrateArchiveIndex` (through the fallback
    rebuild, cleared in `finally`); the ingest ROUTES (`/archive/<id>` and `.../raw/...`) return
    **503 "still syncing"** while `archive.isHydrating()` — the agent's retry signal, the documented
    read-side "still syncing" extended to writes. Do NOT let ingest write the cache during a hydrate.
  - **Self-heal**: the cache is DISPOSABLE, so a corruption is recovered with `archive.resetLocalIndex()`
    — DELETE `index.db` (+ `-wal`/`-shm`) then `openDb()` rebuilds from the local `.jsonl` files —
    NEVER by reopening the corrupt file (the old `openDb()+rebuildIndex()` fallback did exactly that and
    failed identically). `hydrateArchiveIndex`'s catch and both ingest catches call it on
    `archive.isSqliteCorruption(e)`, then 503. `resetLocalIndex` is fully SYNCHRONOUS, so no ingest
    races the rebuild. Tests: the `XERK-789:` cases in `archive.test.js` + `server.test.js`.
- **The serialize guard must cover EVERY local-index WRITER, not just ingest (XERK-791).** The
  `isHydrating()` gate first shipped on the ingest routes + the beat cursor path, but the corruption
  persisted in prod because two OTHER writers of the same handle were still reachable during a hydrate:
  - **Heal-on-read** (`reconcileRow`, XERK-280) — a `tx()` that DELETE+reinserts `entries_fts` for a
    stale row, reached from the READ routes (`/api/search`, `/api/archive`, `/api/archive/<id>`), which
    are NOT 503-gated (clients poll them at boot). `reconcileRow` now early-returns the honest
    file-derived count WITHOUT writing while `hydrating` — the read stays correct and the heal re-fires
    on a later read once the hydrate finishes.
  - **Restore** (`restampOrg` via `POST /api/archive/<id>/restore`) — also a local-index write; the
    route now 503s "still syncing" while `isHydrating()`, like ingest.
  So NO local-index writer runs concurrently with the hydrate. Do not add a new writer without gating it.
- **A hydrate that completed WITHOUT throwing can still have left `entries_fts` corrupt** (XERK-791,
  the leader symptom: hydrated "cleanly", first post-boot ingest hit "malformed"). So `hydrateArchiveIndex`
  runs a PROACTIVE `archive.checkIndexIntegrity()` (FTS5's `'integrity-check'` verb + a bounded MATCH)
  right after `hydrateInto`, while `hydrating` is still set (nothing served yet); on a detected
  corruption it `resetLocalIndex()`s BEFORE serving, turning the reactive error-logging self-heal into a
  controlled one. On a healthy hydrate it is a cheap no-op and the file rebuild NEVER fires (XERK-780's
  cheap-hydrate intent preserved). Tests: the `XERK-791:` cases in `archive.test.js` + `restore.test.js`.
