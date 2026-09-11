---
paths:
  - turma/blobstore.js
  - turma/archive-mirror.js
  - turma/tests/blobstore.test.js
  - turma/tests/archive-mirror.test.js
---

# The archive's HA of-record: object-store bytes + single-writer index (XERK-759)

Wave-3 of the HA epic (XERK-751) for the DURABLE ARCHIVE. Read `.claude/rules/turma-archive.md`
first (the two byte layers, the size ceilings, `rebuildIndex`, `maybeReclaimIndex`) and
`docs/turma-ha-store-adr.md` (the store-of-record decision). This file is the two NEW modules;
archive.js and its hot path are unchanged bar one optional write sink.

## The decision this ticket implements (and where it refines the ADR)

The ADR splits the archive: **bytes → object storage (MinIO/S3)**, index → Postgres. This ticket
takes the **bytes → object storage** half in full, and for the INDEX takes the ticket's EXPLICIT
alternative — *"designate a SINGLE archive-writer"* — instead of a shared Postgres index:

- **Bytes (rendered `.jsonl`+`.meta` AND the `.raw/` layer) become object-store objects**, keyed by
  their path relative to `ARCHIVE_DIR` (`repo/<file>.jsonl`, `…/<file>.jsonl.meta`,
  `…/<file>.jsonl.raw/<member>`). The bucket is the of-record; the RWO `turma-data` volume is no
  longer required for the archive (a standby hydrates a local working copy from the bucket).
- **The index STAYS the per-replica disposable SQLite** archive.js already rebuilds from the files
  (`bytesStored` from the `.meta` sidecar, `rawBytes`/`archiveBytes` from the bytes). There is **no
  shared SQLite file**, so the ticket's corruption hazard (*"two processes on one SQLite file"*)
  cannot arise — a strictly stronger property than "one writer of a shared index". The **leader is
  the single owning WRITER of the of-record** (only it ingests, so only it mirrors up), which is the
  ticket's "single archive-writer" satisfied at the bytes layer.
- **Why not the ADR's Postgres index:** the hub ships **no `node_modules`** (the XERK-754 stdlib-only
  stance; `node --test`, no network in CI). A shared Postgres FTS index means hand-rolling a
  Postgres wire-protocol + SCRAM + tsvector/tsquery client and porting all of archive.js's
  query/reclaim logic onto it — a large, risky surface. archive.js's index is ALREADY documented as
  disposable and rebuildable from the files, so once the files are the of-record the local index
  needs no shared home. `DATABASE_URL` stays validated at boot (ha-config) but the archive does not
  use it; a future ticket may still move the index to Postgres without changing the byte layer.
- **Trade-off, accepted (Option 2):** a freshly-promoted standby must hydrate the bytes from the
  bucket and rebuild its index before it can serve archive reads — until then archive reads 404
  "still syncing" (archive.js's own honest answer). Failover is rare in Option 2; the ADR flags this
  as the single-writer option's cost.

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
- **`drain()` pushes the dirty files up, LEADER-ONLY** (`isLeader`, default true → the not-yet-landed
  XERK-763 lease). In Option 2 only the leader ingests, so only it has dirty files; the gate makes
  "exactly one writer of the of-record" explicit. Best-effort per file: a transient push failure
  re-queues (agents re-push any un-mirrored tail on promotion — a lagging of-record is never data
  loss, matching the archive's append-only/re-push discipline); an ENOENT (raced operator delete) is
  dropped. Serialized so two workers never overlap. Run on an off-beat `setInterval`
  (`ARCHIVE_MIRROR_DRAIN_MS`, 15s) and once on graceful shutdown (best-effort, not awaited).
- **`hydrate()` pulls every object down + `reindex()`** — run at boot AND on promotion (the XERK-763
  seam, via `hydrateArchive()` in server.js). Downloads only a key whose local copy is **absent or
  SMALLER** than the object (missing, or a partial download to finish) — **never same-size-or-larger**,
  so a leader warm-restarting with un-mirrored appends (local ahead of the bucket) is NOT truncated
  back to the of-record; its files are append-only + authoritative and re-mirror on the next drain. A
  leader that has been writing thus hydrates to a near-no-op. Then `openDb()`+`rebuildIndex()`
  re-derives the index from the hydrated files. Best-effort per key; a store blip leaves the local
  copy stale, not the hub down.
- **Path safety both ways**: `keyFor` rejects a path escaping `ARCHIVE_DIR`; `pathFor` rejects a
  listing key that would write outside it (the tar-extract discipline — never trust a listing).

## Wiring (server.js)

- `archiveBlobStore = createBlobStore(...)` at module load (null off HA), like `liveStore`.
- Boot HA branch: `setArchiveMirror(archiveBlobStore, haConfig.ha)` wires `archive.setBlobSink`,
  then `hydrateArchive()` + the drain `setInterval` (`.unref()`, so it never holds the process up).
- `reindex` is `() => { archive.openDb(); archive.rebuildIndex(); }` — idempotent (INSERT OR
  REPLACE), and `rebuildIndex` already skips a `.raw/` directory whole.

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
