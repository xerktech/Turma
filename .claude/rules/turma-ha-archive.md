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
- **The INDEX has a shared Postgres OF-RECORD** (`index-store.js` over pgclient, XERK-780). archive.js
  keeps its local node:sqlite index as the SYNCHRONOUS read/write model in BOTH modes — the request
  path and the beat-cursor path read it, and they cannot be async (XERK-395: no Postgres on the beat)
  — but under HA it is a per-replica HOT CACHE, mirrored to Postgres and HYDRATED FROM Postgres on
  boot/promotion instead of rebuilt by re-parsing the S3-hydrated `.jsonl`s. That per-pod rebuild was
  the bulk of the cold-promote gap (finding A, XERK-772), and rebuilding per pod races concurrent-
  replica ingest; the Postgres of-record removes both.
  - **Why XERK-759 took the SQLite-per-pod interim instead of Postgres, and why that is now
    superseded:** the hub ships **no `node_modules`** (XERK-754 stdlib-only), so a Postgres FTS index
    meant first hand-rolling a Postgres wire client (SCRAM + extended query) — a large surface XERK-759
    deferred, keeping the local SQLite rebuildable from the files as an interim (there was then no
    shared SQLite file to corrupt, a strictly-stronger property than "one shared writer"). XERK-776
    landed that stdlib client (`pgclient.js`); XERK-780 is the port the ADR always designated.
- **The local SQLite is STILL never shared** — the corruption hazard the ADR rules out (two processes
  on one SQLite file) still cannot arise: each replica has its OWN disposable node:sqlite cache; the
  SHARED of-record is Postgres, a transactional row store with safe concurrent writers.
- **Trade-off, accepted (active-active):** a freshly-STARTED or -promoted replica still hydrates the
  BYTES from the bucket before it can serve transcript CONTENT (getTranscript reads the local
  `.jsonl`), and until the index hydrate completes archive reads 404 "still syncing" — but the INDEX
  hydrate is now a Postgres read (indexed rows over the wire), not a file walk + re-parse, so it is
  far cheaper. The ADR flags the hydrate window as the cost; it is a startup/promotion event, not a
  per-request one.

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
- **`hydrate()` pulls every object down + `reindex()`** — run at boot AND on promotion (the XERK-763
  seam, via `hydrateArchive()` in server.js). Downloads only a key whose local copy is **absent or
  SMALLER** than the object (missing, or a partial download to finish) — **never same-size-or-larger**,
  so a leader warm-restarting with un-mirrored appends (local ahead of the bucket) is NOT truncated
  back to the of-record; its files are append-only + authoritative and re-mirror on the next drain. A
  leader that has been writing thus hydrates to a near-no-op. Best-effort per key; a store blip
  leaves the local copy stale, not the hub down.
- **`reindex` is INJECTED and is a NO-OP when the Postgres index is wired** (XERK-780): the byte
  hydrate no longer rebuilds the index from files (the expensive walk) — server.js's `hydrateArchive`
  runs the Postgres index hydrate separately, AFTER the bytes. With no PG index store (HA off, or an
  HA hub without one) `reindex` stays `openDb()`+`rebuildIndex()`, and it is ALSO the FALLBACK when a
  PG index hydrate fails, so a store blip never leaves a promoted replica index-blind.
- **Path safety both ways**: `keyFor` rejects a path escaping `ARCHIVE_DIR`; `pathFor` rejects a
  listing key that would write outside it (the tar-extract discipline — never trust a listing).

## `index-store.js` — the archive index Postgres of-record (XERK-780)

- **The DESIGN, and where it draws the line (the ledger/registry house pattern).** archive.js's local
  node:sqlite index stays the SYNCHRONOUS read/write model in BOTH modes. HA off: byte-identical —
  no store, no sink. HA on: the local SQLite is a per-replica HOT read cache that the request path
  (`searchArchive`/`listArchive`/`getTranscript`) and the beat-cursor path (`manifestCursors`/…)
  read (neither can be async, and no Postgres round trip may sit on the beat, XERK-395). Postgres is
  the durable MIRROR + hydration source ON TOP: every index write is mirrored here (idempotent upsert,
  off the beat) and a promoted/booting replica hydrates the local cache FROM here.
- **DEFERRED (documented scope boundary):** a replica serving archive READS DIRECTLY from Postgres.
  Active-active serving HAS landed (XERK-782), and each replica answers archive reads from its OWN
  hydrated local SQLite cache — advanced by that replica's own ingests plus the boot/promotion
  hydrate, with **no continuous cross-replica watch** (unlike the registry XERK-756 / tunnel
  directory XERK-764). So a session ingested on a DIFFERENT replica is durable (its index rows in
  Postgres, its bytes in the bucket) but not visible in THIS replica's browse/search until it next
  hydrates — a bounded freshness residual, NOT data loss. Serving reads directly from the shared
  Postgres of-record (or adding an index watch) would close it; the query layer
  (`searchQuery`/`listQuery`/`rowQuery`) is implemented + parity-tested so it is a WIRING change, NOT
  a store swap.
- **stdlib ONLY, over `pgclient.js`'s `PgPool`** (XERK-776) — no `pg`/`node_modules`. The pure SQL
  builders (`buildSessionUpsert`/`buildEntryInsert`/`buildSearch`/`buildList`/`ftsToTsquery`) +
  camel↔snake mappers are unit-tested; the socket path is host-QA-only.
- **The sink archive.js calls (`archive.setIndexSink`, no-op off HA) is SYNC + never throws** into
  the hot path — it enqueues; server.js's `IndexMirror` drains it to Postgres in a background loop
  (bounded `INDEX_MIRROR_QUEUE_MAX`, drop-oldest on overflow: a lost mirror op self-heals — the local
  SQLite is authoritative and a promotion re-hydrates only what Postgres holds). A SESSION mutation
  mirrors the FULL row (re-read from SQLite) so the upsert never clobbers untouched metadata; ENTRIES
  mirror append-only by ordinal, or wholesale-replace on a reconcile (XERK-280).
- **CONCURRENCY story (the change from the leader-only Option-2 posture):** every write is idempotent.
  SESSION upserts `ON CONFLICT(transcript_id)` raise the monotonic byte/count columns with
  `GREATEST(existing, incoming)` (a low/partial writer can NEVER lower a cursor — the ledger's
  high-water rule) and overwrite metadata; ENTRY upserts `ON CONFLICT(transcript_id, seq) DO NOTHING`
  (a replayed range is a no-op). Two replicas racing one transcript converge with no lock. archive.js's
  own append-only/forward-only/ownership gates (XERK-255/344/573) run in the LOCAL SQLite BEFORE the
  mirror fires, so the mirrored value is already the resolved one; GREATEST is the belt.
- **Hydration RETIRES the per-pod rebuild-from-files** (`PgIndexStore.hydrateInto` → `archive.indexLoader`):
  it pages session + entry rows out of Postgres and BATCH-applies each PAGE into a fresh local SQLite
  in one synchronous transaction — a tx is NEVER held open across a page `await` (a concurrent request
  starting its own tx would hit "transaction within a transaction"). Between reset and done the index
  is partial → reads answer "still syncing", the archive's honest answer.
- **After the hydrate, `reconcileHydratedCursors` re-derives the BYTE CURSORS from the LOCAL FILES**
  (bytesStored from the `.meta` sidecar, archiveBytes from the `.jsonl` stat, rawBytes from the raw
  walk — exactly as `rebuildIndex` does, but WITHOUT reading `.jsonl` content, so the skipped
  FTS-reinsert stays skipped). Load-bearing: the Postgres of-record can LAG the local files on a
  persistent-volume restart that lost the in-memory mirror queue (on k8s emptyDir the disk + queue are
  lost together, so PG never lags there) — a too-low `bytesStored` would make the agent re-push a range
  the `.jsonl` already holds and `appendFileSync` DUPLICATE it. The files are the append-only ground
  truth for a replica's cursors; PG supplies the metadata + FTS entries. A no-op on a fresh replica.
- **RECLAIM (`maybeReclaimIndex`) under HA is a LOCAL-index-size concern only** — it reaps rows for
  a hand-deleted `.jsonl` from the disposable local SQLite but does NOT delete from the Postgres
  of-record, the SAME posture as the byte mirror's documented hand-delete gap (deletion is an
  out-of-band operator action; a bucket/of-record lifecycle rule removes it).
- **`createIndexStore(haConfig, pool)` returns null with HA off / no pool / a fatal config**, so no
  sink is wired and the local SQLite is the whole story, byte-identical.

## Wiring (server.js)

- `archiveBlobStore = createBlobStore(...)`, `archiveIndexPool = createPgClient(...)`,
  `archiveIndexStore = createIndexStore(..., archiveIndexPool)` at module load (all null off HA),
  like `liveStore`. When a Postgres LedgerStore lands (w2-ledger) it shares `archiveIndexPool`.
- Boot HA branch: `setArchiveMirror(archiveBlobStore, HA_ON)` + `setIndexMirror(archiveIndexStore,
  HA_ON)` wire `archive.setBlobSink` + `archive.setIndexSink`, then `hydrateArchive()` + the drain
  `setInterval` (`.unref()`). A boot line prints `archive index of-record: postgres`.
- **`hydrateArchive()` runs at boot AND on promotion** (`onLeaderPromoted` now calls it — a promoted
  standby did not ingest as a follower, so its index only advances via hydrate): it downloads the
  bytes (byte mirror) then `hydrateArchiveIndex()` (Postgres → local SQLite via `archive.indexLoader`),
  with the file rebuild as the hard fallback.
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
