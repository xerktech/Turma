---
paths:
  - turma/blobstore.js
  - turma/archive-mirror.js
  - turma/index-store.js
  - turma/tests/blobstore.test.js
  - turma/tests/archive-mirror.test.js
  - turma/tests/index-store.test.js
---

# The archive's HA of-record: object-store bytes + Postgres index (XERK-759, XERK-780)

Wave-3 of the HA epic (XERK-751) for the DURABLE ARCHIVE. Read `.claude/rules/turma-archive.md`
first (the two byte layers, the size ceilings, `rebuildIndex`, `maybeReclaimIndex`) and
`docs/turma-ha-store-adr.md` (the store-of-record decision). This file is the two NEW modules;
archive.js and its hot path are unchanged bar one optional write sink.

## The decision this ticket implements (and where it refines the ADR)

The ADR splits the archive: **bytes → object storage (MinIO/S3)**, **index → Postgres**. XERK-759
landed the **bytes → object storage** half in full; **XERK-780 (w2-index) landed the Postgres index
of-record**, so both halves of the ADR split now hold:

- **Bytes (rendered `.jsonl`+`.meta` AND the `.raw/` layer) become object-store objects**, keyed by
  their path relative to `ARCHIVE_DIR` (`repo/<file>.jsonl`, `…/<file>.jsonl.meta`,
  `…/<file>.jsonl.raw/<member>`). The bucket is the of-record; the RWO `turma-data` volume is no
  longer required for the archive (a standby hydrates a local working copy from the bucket). Unchanged.
- **The INDEX has a shared Postgres OF-RECORD** (`index-store.js` over pgclient, XERK-780), and under
  HA the per-replica LOCAL node:sqlite index is now **RETIRED entirely (XERK-793)** — it was the
  recurring FTS5 corruption surface (XERK-789/791). The index becomes, in `pg` mode
  (`archive.setIndexMode("pg", store)`, wired by server.js when a PgIndexStore exists):
  - **an in-memory `sessionsMap`** — the full session ROW (metadata + cursors + owner + filePath),
    the BEAT-SAFE synchronous model the heartbeat cursor path (`manifestCursors`/`inventoryCursors`/
    `rawCursors`/`archiveLimits`) AND the sync reads (`getTranscript`/`sessionRow`) use. It cannot be
    async (XERK-395: no Postgres on the beat), so it is HYDRATED from Postgres on boot/promotion
    (`hydrateSessionsInto` → `sessionLoader`, sessions only — entries stay in PG) and mirrored back on
    every write (the existing `setIndexSink`). A `relPath → id` side-index keeps `relPathOwner` O(1).
  - **Postgres-DIRECT full-text SEARCH** — `searchArchive`/`listArchive` are now **async** and serve
    from `searchQuery`/`listQuery` (there is no local `entries_fts`). Their two routes (`/api/search`,
    `/api/archive`) `await`; every other read stays sync off the map/files.
- **HA-OFF keeps the local node:sqlite unchanged** (byte-identical): there is no shared Postgres, so
  the local index IS the of-record, and it never corrupts there — the hydrate that races ingest is
  itself HA-only. So the retirement is HA-on-and-PG-wired only; an HA hub with no PG (a misconfig)
  degrades to the legacy sqlite hot-cache path (XERK-780).
- **The corruption class is eliminated under HA, not merely serialized:** `pg` mode opens no
  `DatabaseSync` at all, so there is no FTS5 to corrupt and no ROUTINE per-pod file rebuild (the one
  file rebuild that remains is the XERK-797 wiped-PG backstop below, which runs only when PG is
  empty/lagging while the files are present). The XERK-789/791
  `setHydrating`→503-ingest gate STILL wraps the (map) hydrate — a reset-then-fill must not race a
  concurrent map write — but `checkIndexIntegrity`/`resetLocalIndex`/`isSqliteCorruption` and the
  file-rebuild fallback are now sqlite-mode-only (the degraded HA-no-PG path); they are inert in `pg`
  mode. `heal-on-read` (`reconcileRow`, XERK-280) is DISABLED in `pg` mode — the local `.jsonl` is a
  hydrated working COPY and Postgres is authoritative, so a one-replica file discrepancy must not
  rewrite the shared index — and `reclaim` (`maybeReclaimIndex`, XERK-332) is a no-op (no on-disk
  `index.db` to bloat, and it must not delete from PG).
- **`sessionsMap` grows with the archive** (heap, per replica), unbounded like the old on-disk
  `sessions` table — a few MB at the "thousands, not millions" scale `HYDRATE_PAGE` already assumes;
  a bound/keyset cursor is future work if a fleet's index outgrows heap.
- **Trade-off, accepted (active-active):** a freshly-STARTED or -promoted replica still hydrates the
  BYTES from the bucket before it can serve transcript CONTENT (getTranscript reads the local
  `.jsonl`), and until the sessions hydrate completes archive reads answer "still syncing" — but that
  hydrate is a Postgres read (indexed rows over the wire), not a file walk + re-parse. A
  startup/promotion event, not a per-request one.

## `blobstore.js` — the object-store client

- **stdlib ONLY.** A hand-rolled SigV4 signer over `node:https`/`node:http`, **path-style**
  addressing (`<endpoint>/<bucket>/<key>` — what MinIO and any S3-compatible endpoint speak), and a
  regex ListObjectsV2 parse. NEVER add an aws-sdk / minio dependency (no `package.json`, CI is
  offline).
- **`x-amz-content-sha256: UNSIGNED-PAYLOAD`** so a multi-hundred-MiB raw file STREAMS from disk
  (`fs.createReadStream` → the request) instead of being read into memory to hash it — the
  `mem_limit: 512m` constraint. Safe over the TLS endpoint HA uses; every SDK falls back to it for a
  streaming body. The signer is pinned to **AWS's own canonical GET-Object vector** in the test, so a
  future edit can't silently break it.
- Contract (async): `put(key, {file}|{body})`, `getToFile(key, dest)` (streams the response to disk;
  false on 404), `stat(key)` (`{size}`|null), `list(prefix)` (pages past the 1000-key truncation),
  `del(key)` (404 = no-op success). The socket path is exercised in CI against a LOCAL http fake-S3;
  a REAL MinIO/S3 is host-QA-only (the SharedLiveStore posture).
- **`createBlobStore(haConfig)` returns null with HA off** (or a fatal config), so the mirror is
  never wired and archive.js's local tree is the of-record, byte-identical to the pre-HA path.

## `archive-mirror.js` — mirror up, hydrate down

- **`note(absPath)` is the archive.js write sink** — SYNC and cheap, just records the path's
  blob-key in a dirty Set. archive.js calls it after each durable write (`writeSidecar`, the ingest
  `.jsonl` append, the raw write) via `archive.setBlobSink`. NOTHING here runs on the heartbeat/
  ingest path; the network is only touched by the off-beat drain (XERK-395).
- **`drain()` pushes the dirty files up.** `ArchiveMirror` carries an `isLeader` gate as a SEAM, but
  server.js deliberately wires it **`() => true`** — under active-active (XERK-782) archive ingest
  spreads across replicas (a `note()` populates the INGESTING replica's own dirty Set), so EACH
  replica must mirror ITS OWN ingested bytes. **Do NOT wire this to the real leader** (the stale
  "not-yet-landed XERK-763 lease" the seam comment names — the lease HAS landed, but gating the byte
  drain on it would strand every non-leader-ingested transcript's bytes off the of-record: they'd
  reach the bucket only if that pod later became leader, and be lost on an emptyDir restart before
  then). Concurrent per-replica drains are safe: keys are per-transcript, puts are idempotent, and
  hydrate skips a same-size-or-larger local copy (the INDEX mirror is likewise NOT leader-gated, its
  GREATEST/`DO NOTHING` upserts safe under concurrent writers). Best-effort per file: a transient push
  failure re-queues (a lagging of-record is never data loss, matching the archive's append-only/re-push
  discipline); an ENOENT (raced operator delete) is dropped. Serialized so two workers never overlap.
  Run on an off-beat `setInterval` (`ARCHIVE_MIRROR_DRAIN_MS`, 15s) and once on graceful shutdown
  (best-effort, not awaited).
- **`hydrate()` pulls the RENDERED layer down + `reindex()`** — run at boot AND on promotion (the XERK-763
  seam, via `hydrateArchive()` in server.js). Downloads only a key whose local copy is **absent or
  SMALLER** than the object (missing, or a partial download to finish) — **never same-size-or-larger**,
  so a leader warm-restarting with un-mirrored appends (local ahead of the bucket) is NOT truncated
  back to the of-record; its files are append-only + authoritative and re-mirror on the next drain. A
  leader that has been writing thus hydrates to a near-no-op. Best-effort per key; a store blip
  leaves the local copy stale, not the hub down.
- **Ingest stays CLOSED until the byte hydrate COMPLETES (XERK-1048)** — listed AND every rendered
  download landed (`mirror.hydrated`). `hydrateArchiveOnce` holds `setHydrating(true)` across it
  (`hydrateUntilListed`: capped backoff, retried forever) and hands straight to the index hydrate.
  A failed listing (or a rendered GET that never landed) used to return and open
  ingest over an empty tree with Postgres cursors: agents re-shipped tails onto missing files and
  the drain PUT those over the complete objects (reproduced on MinIO: 30190 → 324 bytes).
  - The gate lives in `mirror.hydrateGated(setGate)`, not inline in server.js, so a test pins it.
  - Accepted trade-off: ONE rendered key that never downloads (403, local EACCES/ENOSPC) keeps
    this replica's archive ingest closed indefinitely. Fail closed (agents re-offer, nothing is
    lost) over fail open (truncation). The retry line names the cause (`lastFailure`), one line
    per attempt. A per-transcript gate is the refinement (XERK-1050).
- **The raw layer is LAZY (XERK-1043)** — keys under `<x>.jsonl.raw/` are ~83% of the bucket, and
  pulling them into every replica's size-limited `/data` emptyDir evicted each pod mid-hydrate once
  the bucket outgrew it (8.55 GiB vs 8Gi, 2026-09-25). Hydrate records them as REMOTE-PENDING
  (grouped by raw root) and downloads none of them.
  - **A pending raw file's INGEST cursor is "cannot tell" (`null`), never 0.** Its local ENOENT is
    not "absent": an agent restarting it from 0 would build a partial local copy the drain then PUTs
    OVER the complete object. `archive.setRawRemote` wires `rawCursor` to `rawPending`, and
    `ingestRaw` already refuses a `null` cursor.
  - **Hydrate swaps the pending set in ONE sync step after listing, BEFORE any download await.**
    Clearing it and refilling across the download loop left a promotion window where a raw file read
    ENOENT → cursor 0 → the of-record truncated (QA D1, reproduced on MinIO).
  - **The HEARTBEAT cursor for a pending file is the bucket's size** (`pendingSize`/`pendingFiles`,
    advisory; ingest still refuses). An unchanged file ships nothing, and asking fetches nothing, so a
    replica never re-pulls the whole agent-held raw layer. Only an INGEST ask queues a fetch.
  - A fetch re-checks pending before its GET and before its rename: renaming the bucket copy over a
    file that landed (and grew) meanwhile regresses the cursor (QA D2).
  - EVERY hydrate download (rendered too) lands in `ARCHIVE_DIR/.raw-fetch/` and is RENAMED into
    place (`_download`): a half-written file must never be visible at a path whose size is a cursor. `getToFile` destroys its stream on any
    failure: an open fd kept the unlinked temp's bytes allocated, invisible to `du` (QA D4).
  - `rawBytes` = local walk + `pendingBytes`, where pending counts only the bucket's EXCESS over a
    partial local copy — counting the full size double-counts it and refuses ingest (QA D3).
  - Routes `await fetchRawUnder(dir)` (4 at a time, answering 503 "still syncing" after 10s while the
    fetches carry on) — never the S3 client's 60s timeout.
  - `archive.setRawRemote` THROWS on an incomplete hook set: silently unwiring disables every
    pending guard.
  - Hydrate takes sizes from the listing (`listSizes`, ListObjectsV2 `<Size>`): no HEAD per key.
  - Tests: `archive-mirror.test.js` (the `QA D1`–`D3`/`L1` cases), `blobstore.test.js` (fd leak).
- **`reindex` is INJECTED and is a NO-OP when the Postgres index is wired** (XERK-780): the byte
  hydrate no longer rebuilds the index from files (the expensive walk) — server.js's `hydrateArchive`
  runs the Postgres index hydrate separately, AFTER the bytes. With no PG index store (HA off, or an
  HA hub without one) `reindex` stays `openDb()`+`rebuildIndex()`, and it is ALSO the FALLBACK when a
  PG index hydrate fails, so a store blip never leaves a promoted replica index-blind.
- **Path safety both ways**: `keyFor` rejects a path escaping `ARCHIVE_DIR`; `pathFor` rejects a
  listing key that would write outside it (the tar-extract discipline — never trust a listing).

## `index-store.js` — the archive index Postgres of-record (XERK-780)

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
  (bounded `INDEX_MIRROR_QUEUE_MAX`, drop-oldest on overflow: a lost mirror op self-heals — Postgres
  is the of-record and a promotion re-hydrates the map from it). A SESSION mutation mirrors the FULL
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

## Wiring (server.js)

- `archiveBlobStore = createBlobStore(...)`, `archiveIndexPool = createPgClient(...)`,
  `archiveIndexStore = createIndexStore(..., archiveIndexPool)` at module load (all null off HA),
  like `liveStore`. When a Postgres LedgerStore lands (w2-ledger) it shares `archiveIndexPool`.
- Boot HA branch: `setArchiveMirror(archiveBlobStore, HA_ON)` + `setIndexMirror(archiveIndexStore,
  HA_ON)` wire `archive.setBlobSink` + `archive.setIndexSink`, AND `setIndexMirror` calls
  `archive.setIndexMode("pg", archiveIndexStore)` (XERK-793) so the local node:sqlite is retired; then
  `hydrateArchive()` + the drain `setInterval` (`.unref()`). A boot line prints `archive index
  of-record: postgres`.
- **`hydrateArchive()` runs at boot AND on promotion** (`onLeaderPromoted` calls it — a promoted
  standby did not ingest as a follower, so its map only advances via hydrate): it downloads the bytes
  (byte mirror) then `hydrateArchiveIndex()`, which in `pg` mode pages SESSIONS from Postgres into the
  in-memory map (`hydrateSessionsInto` → `archive.sessionLoader`) — no local sqlite, no entry paging,
  no file rebuild (a failed hydrate leaves the map partial and catches up on ingest / next promotion).
  The legacy sqlite hydrate + file-rebuild fallback remains for the degraded HA-no-PG path.
- **The byte mirror's `reindex` is a NO-OP when `archiveIndexStore` is wired** (the PG hydrate does
  the indexing); else `() => { archive.openDb(); archive.rebuildIndex(); }` — idempotent (INSERT OR
  REPLACE), `rebuildIndex` skips a `.raw/` directory whole.

## Deployment

- The HA compose stack (`examples/compose/hub-ha.yaml`, XERK-755) already provisions MinIO with the
  `turma-archive` bucket and wires `ARCHIVE_S3_*`; the k8s Application is the ArgoCD concern
  (XERK-765). Non-HA needs none of it.
- **The size ceilings still bind LOCALLY** (`totalArchiveBytes` walks the local `ARCHIVE_DIR`, which
  under HA is the hydrated working copy), so `ARCHIVE_TOTAL_MAX_BYTES` et al. behave exactly as
  before. The bucket itself is unbounded object storage (it scales — the ADR's whole reason for the
  split); an operator-side lifecycle/quota on the bucket is the deployment's concern, not the hub's.
- **Known gap, documented not closed:** an operator HAND-DELETING a local `.jsonl` is not propagated
  to the bucket (the mirror only pushes writes). The of-record keeps the object until a bucket-side
  lifecycle rule or a future reconcile sweep removes it. This mirrors the archive's existing posture
  that deletion is an out-of-band operator action.

## Tests

- `blobstore.test.js`: the SigV4 AWS canonical vector, UNSIGNED-PAYLOAD default, the pure
  encoders/parsers (`encodeS3Path`, `canonicalQuery`, `parseListXml`, `xmlDecode`), the factory
  selection, and the FULL put/get/stat/list/del round-trip over a local http fake-S3 (asserting every
  request is SigV4-signed).
- `archive-mirror.test.js`: `keyFor`/`pathFor` escape rejection, note→drain push, the leader gate
  (non-leader drains nothing, keeps the queue), transient-fail re-queue vs ENOENT-drop, hydrate
  pull+skip-same-size+reindex, and the REAL archive.js integration — the sink fires for the rendered
  `.jsonl`, its `.meta` and the raw file, and those bytes hydrate into a FRESH replica dir whose
  rebuilt index reads the transcript back and RESUMES the cursor (a re-ingest from 0 stores nothing,
  no duplication).
- `index-store.test.js`: the pure SQL builders (the `GREATEST`-on-exactly-the-monotonic-columns
  upsert, the entry `ON CONFLICT (transcript_id, seq) DO NOTHING`, the search/list SQL, `ftsToTsquery`,
  the camel↔snake mappers, `intParam`); the mirror + CONCURRENCY logic against a faithful in-memory
  of-record (a low/partial writer never lowers a cursor; a replayed entry range is a no-op); the
  archive.js sink→of-record→hydrate ROUND-TRIP reconstructing the index (browse + full-text search)
  with the `.jsonl` FILES DELETED — the retirement of the rebuild-from-files; the no-sink byte-identity;
  and the `PgIndexStore`→pool contract over a spy pool (the socket itself is `pgclient.test.js`'s).
- `index-store.test.js` `XERK-793 pg mode:` cases (via `setIndexMode("pg", MemIndexStore)` +
  `hydrateSessionsInto`): ingest writes NO local `index.db`, mirrors PG, and search/list serve DIRECT
  from PG while getTranscript/sessionRow read the map + local `.jsonl`; the beat cursor path +
  ownership gate run off the map; a fresh replica hydrates its map (sessions-only) from PG; heal-on-read
  + reclaim do NOT mutate the of-record.
- `index-store.test.js` `XERK-797 pg mode:` cases: a WIPED PG (of-record cleared, files kept) is
  rebuilt-of-record by `backfillPgIndexFromFiles` — the map + PG repopulate (session + entries), the
  restored cursor makes an agent's re-push from 0 a no-op so the `.jsonl` is NOT duplicated, and it is
  a no-op on a healthy boot AND a legitimately-empty archive. The whole HA-off suite (`archive.test.js` et al.) is the
  byte-identity guard for sqlite mode. **Real prod-scale Postgres + a real HA boot are host-QA only**
  (fake-pool unit coverage, the `PgIndexStore` posture).
