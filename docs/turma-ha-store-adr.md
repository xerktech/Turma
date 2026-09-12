# Turma HA — shared store, archive/ledger of-record, and the HA config contract (XERK-752)

> **A decision record, not an implementation.** This is the child that settles *"the one infra
> decision this forces"* named in `docs/turma-ha-design.md` §"The one infra decision this forces":
> the new stateful dependency the k8x cluster takes on so the hub can run as 2–3 replicas without a
> deploy outage (parent epic XERK-751). It is written to be **decided before any hub code is
> written** — every sibling under XERK-751 (state externalization, leader lease, graceful drain,
> Service gating) depends on the store chosen here, so this ticket ships **no hub code**; it unblocks
> the rest.
>
> Read `docs/turma-ha-design.md` first for the topology analysis, the state inventory (§A/B/C), and
> the recommendation (**Option 2, active-passive leader-failover**) this ADR builds on. This document
> answers only: *which store(s), what abstract contract the code targets, and what switch selects the
> backend.*

**Status:** Accepted, pending operator sign-off on the two/three new k8x dependencies (Valkey,
CloudNativePG, and — if not already present — MinIO). The parent design explicitly said *"confirm
before building — it adds an operational surface to k8x."* This ADR **is** that confirmation
artifact: the decision is recorded here to be reviewed on the PR, not re-derived by each sibling.

---

## The decision, in one paragraph

Split the state by the shape of its traffic, not by convenience:

- **Live plane → Valkey** (Redis-wire-compatible; the BSD-licensed fork most k8s operators now
  default to). Hot, high-churn, loss-tolerant coordination state — the fleet registry, per-host
  command queues, the ticket queue, the migration record, hot copies of the policy/pin and OIDC
  side-stores, and the pub/sub bus. This is state the hub today keeps in RAM and snapshots
  best-effort to `state.json`, so Valkey's AOF (`everysec`) durability is *more* than the current
  guarantee, and its native CAS / atomic-increment / keyspace-watch / pub-sub are exactly the
  primitives §B needs.
- **Durable of-record for structured history → Postgres (CloudNativePG)**. The usage ledger (*"the
  only copy of a year of spend"*) and the archive's **searchable index** (today the single-writer,
  NFS-hostile SQLite `index.db`). These are durability-critical and query-shaped, so they belong in
  a transactional relational store, not the loss-tolerant live plane.
- **Archive of-record for bytes → object storage (MinIO/S3)**. The archive's rendered-entry layer
  and the byte-for-byte raw session layer — 190 MB+ today and *"about to accumulate much faster"*
  (XERK-356). Blobs at that scale and growth do not belong in a row store, and keeping them on the
  RWO `turma-data` volume is exactly what defeats fast failover (a standby can't be promoted without
  a volume detach/attach — `docs/turma-ha-design.md` §Option 2 "Storage").

Two new stateful operators are unconditional (Valkey, CloudNativePG); MinIO is the third only if the
cluster does not already run object storage. See §"If we must cut to fewer dependencies".

---

## Why the live plane is Valkey, not Postgres

The parent floated the fork directly: *"Redis (or Valkey) … or Postgres/CloudNativePG."* The live
plane's traffic decides it.

- **It is hot and high-churn.** Every heartbeat rewrites a host's registry record (the offline
  window is 75 s and beats are frequent); command queues drain on every reply. Putting that write
  rate on the same store that must be the durable year-of-spend of-record couples a loss-tolerant hot
  path to a durability-critical one. Valkey isolates it.
- **The primitives §B needs are native.** The single-flight guards (`committedTicketSpawn`,
  `createInFlight`, `autoStarted`/`autoStopped`, `rememberDispatch`, `resultWaits`) are exactly
  compare-and-set / set-if-absent; command/ticket queues are list or stream ops; a warm-standby cache
  stays hot by *watching* keys. Valkey has `SET NX`, `WATCH/MULTI/EXEC`, Lua for atomic
  read-modify-write, `INCRBY`, keyspace notifications, and native pub/sub. Postgres can express all
  of these (advisory locks, `SELECT … FOR UPDATE`, `LISTEN/NOTIFY`), but `LISTEN/NOTIFY` carries real
  caveats for fan-out — an 8 KB payload cap, a connection per listener, and notifications that can be
  missed under load — so it is the weaker fit for the *bus*, which is the one thing the live plane
  most needs.
- **Durability requirement is low here by construction.** `state.json` is documented as a best-effort
  30 s snapshot read once at boot and never re-read — *not* a source of truth. Valkey AOF `everysec`
  already exceeds that. The state that genuinely must not be lost (spend, archive) is *not* on the
  live plane.

## Why watch + pub/sub are in the contract even though Option 2 is leader-only

The recommended topology (Option 2, active-passive) serves all traffic from the leader, so SSE
fan-out is single-process and cross-replica delivery *"disappears."* The store contract still
includes `watch` and `publish/subscribe`, deliberately:

1. **Warm standbys.** A standby subscribes to registry/queue changes and keeps its in-memory caches
   hot, so on failover it is promotable in ~1–2 s without a cold rebuild from the store.
2. **Option 3 is the reachable future, not a rewrite.** Active-active (full horizontal scale) needs
   every mutation to reach every replica's SSE clients. If the code targets `watch`/`publish` from
   day one, reaching Option 3 later is a topology + routing change, **not a store swap.** Choosing a
   live-plane store *without* a first-class bus would foreclose that.

## Why the ledger's high-water lives in Postgres, not as a Valkey counter

The ticket names *"per-day high-water increments"* as a primitive to evaluate. The high-water merge
is **not** an `INCRBY` and **not** a CAS loop — it is `max`, and it is a durability-critical write.
In Postgres it is one atomic, contention-free statement:

```sql
INSERT INTO usage_day (host, day, token_key, tokens) VALUES ($1,$2,$3,$4)
ON CONFLICT (host, day, token_key) DO UPDATE SET tokens = GREATEST(usage_day.tokens, EXCLUDED.tokens);
```

That is the exact rule `usage-ledger.js` `raiseBucket` implements today (*"a report can only
under-state a past day"*), expressed as a single upsert with no read-modify-write window — so it is
correct under concurrent replicas with no lock. The live plane's CAS/increment primitives serve the
**single-flight guards and queue sequencing**; the ledger's high-water is a durable write and belongs
in the of-record. Keeping them separate is the point of the split.

## Why the archive splits: index → Postgres, bytes → object storage

The archive is two layers (`.claude/rules/turma-archive.md`): rendered entries every surface reads,
and a byte-for-byte raw copy of each session's files (~5–10× the bytes). Its index is `node:sqlite`
`index.db` on the RWO volume — **single-writer, and unsafe over Longhorn-RWX/NFS** (the parent's §A
and §"The one infra decision" both flag SQLite as the corruption hazard).

- **Bytes → object storage** because they are blobs, they are 190 MB+ and growing fast, and any
  by-volume home (RWO or RWX-NFS) either blocks failover or reintroduces the NFS hazard. Object
  storage is read/written identically by every replica with no volume move, which is what makes a
  standby promotable.
- **Index → Postgres**, replacing SQLite. The searchable index is relational query-shaped
  (by session, host, date, size ceilings, `maybeReclaimIndex` reclaim) and must have exactly one safe
  writer story under replicas — a row store gives that natively, and it is the same Postgres the
  ledger already needs, so it adds no new dependency.

This is the precise answer to the ticket's *"object storage (S3/MinIO) vs Postgres"* question for the
archive: **both, by layer** — bytes to object storage, index to Postgres — never SQLite over shared
RWX, which the ticket rules out outright.

> **Implementation note (XERK-759, the archive child).** The bytes-to-object-storage half landed as
> specified. For the INDEX the child took the ticket's EXPLICIT alternative — *"designate a SINGLE
> archive-writer"* — over this ADR's Postgres index, and the two are equivalent on the property that
> matters: the SQLite index stays **per-replica, local and disposable** (`rebuildIndex` re-derives
> every row, cursors included, from the object-store bytes a replica hydrates), so there is **no
> shared SQLite file to corrupt** — a strictly stronger guarantee than "one writer of a shared
> index" — and the leader is the single owning writer of the of-record (only it ingests, so only it
> mirrors up). The driver was the **stdlib-only** constraint (the hub ships no `node_modules`, CI is
> offline): a shared Postgres FTS index means hand-rolling a Postgres wire-protocol + SCRAM +
> tsvector/tsquery client and porting archive.js's whole query/reclaim path onto it — deferred by
> XERK-759, kept rebuildable-from-files in the interim.
>
> **Update (XERK-780, w2-index): the Postgres index the ADR designated has LANDED.** XERK-776 shipped
> the stdlib Postgres client (`pgclient.js`); XERK-780 built `index-store.js` on it — the archive
> index is now the shared Postgres of-record. archive.js keeps its local node:sqlite as the per-replica
> hot read/write CACHE (the sync request + beat-cursor paths need it, and no Postgres round trip may
> sit on the beat, XERK-395), mirrored to Postgres with idempotent `ON CONFLICT` upserts and HYDRATED
> from Postgres on promotion instead of rebuilt from the S3 bytes — so the cold-promote gap (finding
> A) shrinks and concurrent-replica ingest is safe. The byte layer was unchanged, as this note
> predicted. Direct per-replica PG SERVING is the one deferred piece (Option 2 still serves from the
> leader; the query layer is built + parity-tested for when active-active serving lands). Mechanics:
> `.claude/rules/turma-ha-archive.md`.

---

## The abstract store contract (what hub code will target)

HA is a swap of *backends behind stable interfaces*, never a rewrite of the 13k-line request path.
The code targets these contracts; the single-process default (§config) and the HA backend both
implement them. Method names are illustrative; the shapes are the contract.

### 1. `LiveStore` — the live plane (Valkey in HA; in-memory Maps in single-process)

```
get(key) -> value | null
set(key, value, {ttlMs?}) -> void
del(key) -> void
setIfAbsent(key, value, {ttlMs?}) -> boolean        // single-flight guards; returns false if present
compareAndSet(key, expected, next, {ttlMs?}) -> boolean   // optimistic guards, lease-adjacent state
incrBy(key, n) -> number                             // counters/sequencing (NOT the ledger high-water)
mget(prefix) / scan(prefix) -> [{key, value}]        // whole-fleet reads (e.g. /api/agents)
watch(prefix, cb(event)) -> unsubscribe              // warm-standby cache invalidation
publish(channel, message) -> void                    // SSE fan-out bus
subscribe(channel, cb(message)) -> unsubscribe
queuePush(key, item) / queueDrain(key) -> [item]     // per-host command queue, ticket queue
```

- **Shapes are unchanged.** `scheduleSave`/`loadState` and each policy store's save/load become
  `LiveStore` reads/writes that carry the *same JSON shapes* the file paths do today, so the rest of
  `server.js` is untouched (parent §"Code seams").
- **Leader election is NOT in this contract.** Per `docs/turma-ha-design.md` §Option 2 it is a
  Kubernetes `Lease` in `coordination.k8s.io` (with the ServiceAccount + Role the deployment must
  add), so the singleton sweeps and migration-advance gate on `isLeader()`, not on a store key. The
  store could offer a CAS-based lease, but the k8s-native `Lease` is the parent's choice and this ADR
  keeps it there — one less thing to get right in the store layer.

### 2. `LedgerStore` / `IndexStore` — durable structured of-record (Postgres in HA; JSON/SQLite files in single-process)

```
raiseDay(host, day, tokenKey, tokens) -> void        // atomic high-water upsert (GREATEST)
readSeries(host?, range?) -> rows                     // usage page + retiredUsage
putEntry(sessionId, entry) -> void                    // archive rendered-index row
queryEntries(filter) -> rows                           // archive browse/query, reclaim bookkeeping
```

- `raiseDay` is the high-water rule, contention-free (§"Why the ledger's high-water lives in
  Postgres"). Single-process backend keeps `usage-ledger.js`'s file + SQLite `index.db` unchanged.

### 3. `BlobStore` — archive bytes of-record (MinIO/S3 in HA; the local `archive/` tree in single-process)

```
put(objectKey, bytes, {contentType?}) -> void
get(objectKey) -> bytes
stat(objectKey) -> {size, ...} | null
list(prefix) -> [objectKey]
del(objectKey) -> void
```

- Carries both archive layers (rendered + raw). Size ceilings (`ARCHIVE_TOTAL_MAX_BYTES` et al.)
  become object-count/byte accounting against the bucket; the single-process backend is the existing
  local `archive/` directory, byte-for-byte unchanged.

---

## The HA config contract

One switch selects the backend. **When it is off, the hub runs single-process on the existing
file/in-memory backend and the docker-compose path is byte-identical** — this is the load-bearing
invariant the ticket demands, and every sibling must preserve it.

### The switch and its precedence

- **`HA_MODE`** — `unset` (default) | `1` | `0`.
  - **`HA_MODE` unset →** HA is inferred **on iff the live-plane store URL is present**
    (`TURMA_STORE_URL`). No URL, no HA. This makes "add the store URL to the deployment" the single
    action that turns HA on, and keeps a bare `docker compose up` (no such env) single-process with
    zero new config.
  - **`HA_MODE=1` →** HA is forced on. Every required URL (§below) **must** be present or the hub
    **refuses to boot with a named error** — never a silent fallback to single-process (a hub that
    quietly runs local while its replicas run shared is the split-brain the whole epic exists to
    avoid).
  - **`HA_MODE=0` →** HA is forced off even if store URLs are present — the escape hatch to run a
    known-good single-process hub against a cluster that still has the env wired.
- **Precedence, top to bottom:** explicit `HA_MODE` (1/0) wins over URL presence; URL presence is the
  fallback signal only when `HA_MODE` is unset.

### The env surface

**Single-process (default) — unchanged, already in the tree:**

| Var | Backend |
|---|---|
| `STATE` / `state.json`, the ~10 policy/pin JSON files | `LiveStore` |
| `USAGE_LEDGER_FILE`, `ARCHIVE_DB` (SQLite `index.db`) | `LedgerStore`/`IndexStore` |
| `ARCHIVE_DIR` (local `archive/` tree) | `BlobStore` |

**HA — new, all required together when HA is on:**

| Var | Selects | Example |
|---|---|---|
| `TURMA_STORE_URL` | `LiveStore` (Valkey) — **also the HA-on signal when `HA_MODE` unset** | `rediss://valkey.turma.svc:6379/0` |
| `DATABASE_URL` | `LedgerStore` + `IndexStore` (Postgres/CNPG) | `postgres://…/turma` |
| `ARCHIVE_S3_ENDPOINT` / `ARCHIVE_S3_BUCKET` / `ARCHIVE_S3_REGION` / `ARCHIVE_S3_ACCESS_KEY` / `ARCHIVE_S3_SECRET_KEY` | `BlobStore` (MinIO/S3) | `https://minio.turma.svc` / `turma-archive` |

### Validation rules (fail loud, never half-HA)

- **All-or-nothing.** When HA is on, a **missing required URL is fatal at boot**, named in the error.
  Half the state shared and half local is the worst outcome — worse than either pure mode — so it is
  refused, not degraded. (This mirrors the hub's existing "refuse loudly, don't silently half-work"
  posture, e.g. `ARGOCD_DEPLOY_KEY` in `release.md`.)
- **Leader lease is a boot prerequisite in HA.** With `HA_MODE` on, the k8s `Lease` RBAC
  (`coordination.k8s.io`, ServiceAccount + Role) must be reachable, or the singleton sweeps
  (offline-alert, the auto-start bundle, migration-advance) would run N times. Absence is fatal at
  boot, not a silent double-run.
- **Effective mode + resolved backends print at boot** (the same idiom the memory-ceiling and
  registry-cap knobs already use — *"the effective budget prints at boot"*), so an operator sees the
  effective mode in the log, not a guess: `HA: off (single-process)`, or `HA: on (...)` naming the
  backends genuinely in use. **The boot line must name what is ACTUALLY wired, never the intended
  design (XERK-773)** — today `HA: on (store=valkey, ledger=valkey, index=postgres, blobs=s3)`: the
  archive INDEX is now the shared Postgres of-record (XERK-780), while the ledger's high-water still
  lives in the Valkey live store (XERK-758). It must not claim Postgres for a backend nothing writes.
  `DATABASE_URL` stays required (consumed by the index now, by the ledger once `w2-ledger` lands);
  `ha-config.js`'s per-backend flags (`INDEX_BACKEND_WIRED`/`LEDGER_BACKEND_WIRED`) gate each claim —
  granularized from the single conflated flag XERK-773 used, so the index can read `postgres` while
  the ledger still reads `valkey`.
- Every new URL/knob reads through the existing `positiveEnv`-style guards where numeric; a malformed
  store URL is a boot refusal, never a runtime surprise.

---

## If we must cut to fewer dependencies

Three new stateful operators (Valkey + CloudNativePG + MinIO) is real k8x surface. Two honest
reductions, in preference order, if the operator wants fewer:

1. **Drop MinIO, keep archive bytes on a shared RWX volume with a single writer.** Raw + rendered
   *files* (not SQLite) over Longhorn-RWX are safe when exactly one leader writes them, and RWX
   mounts on every replica so it does not block promotion the way RWO does. Loses object storage's
   clean scaling and its independence from the volume story; keeps the index in Postgres regardless.
   Choose this only if object storage is genuinely unavailable on k8x.
2. **Collapse the live plane into Postgres (no Valkey).** Everything in one CloudNativePG, fan-out via
   `LISTEN/NOTIFY`. Two deps become one. Cost: the hot heartbeat write-rate lands on the durable
   store, and `LISTEN/NOTIFY`'s payload/connection/under-load caveats make it the weaker bus — which
   is why this ADR does not recommend it as the default. Viable for a *small* fleet if minimizing
   operators outweighs the coupling; revisit before Option 3 (active-active fan-out would strain
   `LISTEN/NOTIFY`).

Neither is the recommendation — the split by traffic shape is — but both are real, and both keep the
same abstract contracts above, so the choice is a backend wiring decision, not a code rewrite.

---

## What this ADR does and does not settle

- **Settles:** the store(s), the archive/ledger of-record by layer, the abstract contracts hub code
  targets, and the `HA_MODE`/URL-presence config switch with its precedence and fail-loud rules.
- **Does not touch:** hub code (none in this child, per the ticket), the topology decision (Option 2,
  already recommended in `docs/turma-ha-design.md`), the leader-election mechanism beyond naming it a
  k8s `Lease`, or the `xerktech/ArgoCD` manifests (a sibling adds the Applications for the store(s),
  the RBAC, and the `RollingUpdate` switch).
- **Open, for the operator to confirm on this PR:** whether MinIO already exists on k8x (decides
  dependency #3 vs reduction #1), and whether the two/three-operator surface is accepted or reduction
  #2 is preferred. The abstract contracts hold either way.
