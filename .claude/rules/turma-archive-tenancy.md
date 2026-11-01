---
paths:
  - "turma/archive.js"
  - "turma/archive-mirror.js"
  - "turma/index-store.js"
  - "turma/tests/archive*.test.js"
  - "turma/tests/index-store.test.js"
  - "turma/tests/restore.test.js"
---

# The archive partitioned by tenant (XERK-2549)

Decision + rationale: `docs/multi-tenant-adr.md` ("The durable archive is partitioned per tenant").
Tenancy model: `turma-tenancy.md`.

## Layout

- A tenant host's NEW transcript goes under `@<tenantId>/<repo>/…` (`archiveRelPath`); untenanted
  stays `<repo>/…`. A row's tenant is read off its `host` (`tenantOfHost`), a file's off its path
  (`tenantOfRel`). Never add a tenant column: it could only disagree.
- **Every walker treats a top-level `@<32 hex>/` as a root of its own** (repo folders at depth 0
  there): `walkJsonlBytes`, `walkJsonl`, the mirror's `rawRootOf`. Else `isRawDir`'s depth guard
  misreads a repo named `x.jsonl.raw` inside a partition. A new walker must do the same.
- Files are never renamed: a tenant row archived before the partition stays in the untenanted tree.

## Reads are scoped at the store

- `getTranscript`, `sessionRow`, `rawDirOf`, `listRawFiles`, `rawFileFor` and the three
  trajectories take an optional `scope` (`{tenant, untenanted}`, `hostInScope`); a row outside it
  reads as unknown. Routes pass `archiveScopeFor(p)` on top of the route-table gate.
- **`archiveHistory(tid, host)` scopes to the HOST's tenant**: a session's transcript id is
  agent-asserted, so without it another tenant's agent could read this tenant's archive as its
  scrollback. Any new path serving archive content for a live session must do the same.
- **A row never crosses tenants**: `ingestChunk` refuses a re-point to another tenant's host BEFORE
  the legacy NULL-org escape can admit it; the restore route 404s a target of another tenant.

## Quota

- `ARCHIVE_TENANT_MAX_BYTES` (default `ARCHIVE_TOTAL_MAX/8`, `0` off, never above the ceiling) per
  partition, from the same walk + per-append charge as the store total (`tenantCache`,
  `tenantWritten`, `chargeTenant`). `ceilingRefuses(tenant)` is the one check `ingestChunk`,
  `ingestRaw` and `archiveLimits(ids, host)` share. Untenanted hosts: shared ceiling only.
- **Charged and measured by the ROW's host, never the file's path** (XERK-2618): a pre-partition
  tenant row's files sit in the untenanted tree, and a path-keyed charge let a resumed session
  append there outside the quota. `chargeTenant(tenantOfHost(host))`; the walk attributes those
  files via `legacyTenantFiles()` (`.jsonl` by filePath, raw subdirectory by transcript id).

## Purge

- `purgeTenant(t)` deletes every row whose host is the tenant's (finds pre-partition files too),
  their `.jsonl`/`.meta`/raw dir, the partition, and — via `setBlobRemover` →
  `ArchiveMirror.remove` — the bucket objects; Postgres rows go through the index sink's `remove`.
  A `.jsonl` a surviving row also names (pre-XERK-277 collision) is kept.
- **The caller tombstones the tenant FIRST** (server.js `archivePurgedTenants`, HA-shared, no
  debounce). `setTenantPurged` makes rebuild, the pg backfill and the de-dup pass skip it, the
  store walk REAP its partition, and ingest/manifest/inventory store nothing for its hosts. Without
  it a follower's stale local copy is re-indexed on its next boot or promotion.
- **The purge's own deletes are best-effort; every hydrate finishes them** (QA-reproduced: a mirror
  `remove` op dropped after its retries left the rows in Postgres, and the next hydrate reloaded them).
  - `sessionLoader`/`indexLoader` never load a purged tenant's row and RE-SEND its `remove`
    (`resendPurgedRemoves`); pg `searchArchive`/`listArchive` drop such rows meanwhile.
  - `ArchiveMirror` takes `purgedKey`: a purged partition's key is never pushed, never fetched, and
    the leader deletes it when a hydrate lists it (a failed bucket delete heals on the next hydrate).
  - `remove()` awaits the in-flight drain first: a PUT already started re-created the object after
    the delete (QA-reproduced).
  - The store's `install` runs `reapPurgedPartitions`, so a follower (which never walks the store)
    drops its stale partition the moment it learns the tombstone.
  - Residual: a PRE-partition tenant object in the bucket is not keyed by tenant, so only the purge's
    own delete removes it; rebuild/backfill/hydrate skip it by its sidecar or row `host`.

## Tests

- The `XERK-2549:` and `XERK-2618:` cases in `archive.test.js` (layout + per-tenant walk, store-layer read isolation,
  no cross-tenant re-point incl. legacy NULL, quota, purge completeness + no resurrection),
  `index-store.test.js` (pg-mode purge), `archive-mirror.test.js` (`rawRootOf`, `remove`),
  `server.test.js` (cross-tenant `/history`, `purgeTenantData`), `external-stores.test.js`.
