---
paths:
  - turma/store.js
  - turma/ha-config.js
  - turma/tests/store.test.js
  - turma/tests/ha-config.test.js
---

# The HA storage-abstraction seam (XERK-754, epic XERK-751)

The spine every state-externalization child (wave-3) plugs into. **Read
`docs/turma-ha-store-adr.md` first** — it is the accepted decision record for the
store(s), the abstract `LiveStore` contract, and the `HA_MODE`/URL config switch.
This file is the operative rules for the two modules that landed it.

## What XERK-754 landed, and what it deliberately did NOT

- **Landed:** the `LiveStore` interface + two backends (`FileLiveStore` default,
  `SharedLiveStore` Valkey client), the config resolver, the boot-time backend
  selection + fail-loud validation + boot print, and unit tests (incl. the
  byte-for-byte file-backend proof).
- **NOT rewired:** no existing store's save/load in `server.js` was moved onto the
  adapter. `scheduleSave`/`loadState` and the ~14 policy/pin stores are UNCHANGED,
  so with HA off the non-HA docker path is byte-identical and nothing here is on
  the hot path. **Wave-3 children flip each call site** onto the already-proven
  adapter, one store at a time — that is where "moving a store's semantics" lives.
  Do not fold a call-site rewire into this seam.

## Load-bearing invariants

- **stdlib only — the hub ships no `node_modules`.** `SharedLiveStore` speaks RESP2
  on a raw `node:net`/`node:tls` socket; NEVER add a redis/ioredis dependency (there
  is no `package.json`, and CI runs `node --test` with no npm/network). The RESP
  codec (`encodeCommand`/`RespParser`) is the unit-testable core; the socket
  lifecycle is host-QA-only (no live Valkey in CI).
- **All `LiveStore` methods are ASYNC** (return Promises) — one interface both
  backends satisfy, since a shared backend is inherently async. `FileLiveStore`
  resolves immediately.
- **`get` returns a SNAPSHOT** (`structuredClone`), not the stored reference —
  callers mutate-then-`set`, never in place. This is what makes the two backends
  interchangeable (a shared store could never hand back a live object). CAS compares
  by JSON canonicalisation (`sameValue`); pass back what `get` returned unchanged.
- **`watch` is implemented over the store's OWN change channel** (`WATCH_CHANNEL`),
  NOT Redis keyspace notifications — those need `CONFIG SET notify-keyspace-events`,
  which managed Valkey often denies. Every mutating op PUBLISHes a small
  `{type,key,value}` event; watchers filter by prefix. Cross-replica by construction
  (warm standbys), at the cost of one extra publish per mutation — accepted for the
  seam; a wave-3 op may fold it into Lua. `watch`/`publish` are in the contract even
  though Option 2 is leader-only, for warm standbys + the reachable Option 3 (ADR).
- **Durable persistence is full-file temp+rename**, on-disk bytes exactly
  `JSON.stringify(value)` — identical to every store's current format, so a wave-3
  child moves a store on with NO on-disk change. A durable write NEVER throws inside
  its timer (an uncaught throw in `setTimeout` exits the process — the XERK-235
  rule); it logs and gives up. `flush()` is the synchronous drain-path write.

## The config contract (`ha-config.js`, pure)

- **`resolveHaConfig(env)` is PURE** — returns `{ha, fatal[], bootLine, ...}`, never
  exits or logs. `server.js` owns the `process.exit(2)` and the print, so the
  resolver is unit-tested with plain objects and can't kill a test process.
- **Precedence:** explicit `HA_MODE` (1/0) wins over URL presence; `HA_MODE` unset →
  HA inferred ON iff `TURMA_STORE_URL` present. `HA_MODE=0` forces off and drags NO
  shared URL in (the escape hatch). A non-0/1 `HA_MODE` is fatal (typo, not a guess).
- **Fail loud, never half-HA:** when HA is on, a missing/malformed required URL is
  FATAL and NAMED at boot (refuse, don't degrade) — `TURMA_STORE_URL` (this ticket's
  live plane), `DATABASE_URL` and `ARCHIVE_S3_*` (wave-3 backends, validated now so
  the contract lands once). `ARCHIVE_S3_REGION` is the one S3 var with a default.
- **The effective mode PRINTS at boot** (`HA: on (...)` / `HA: off (single-process)`),
  same idiom as the memory-ceiling prints — the only way to tell a correctly-wired
  hub from one whose env moved under it.

## Wave-3 consumers already on the seam

- **SSE fan-out across replicas (XERK-762)** — the first live-plane consumer of `publish`/`subscribe`.
  In `turma/server.js`, `sseBroadcast` = `sseDeliverLocal` (this process's `sseClients`, as always)
  **plus** `sseBus.publish` when HA is on. `makeSseBus(store, replicaId, deliverLocal)` subscribes to
  `SSE_BUS_CHANNEL` and re-emits a PEER's frames to local clients; it SKIPS a frame stamped with its
  own `SSE_REPLICA_ID` (a fresh per-boot random), so an event a replica both originated and received
  back is delivered once. `sseBus` is null single-process (`FileLiveStore` pub/sub is NOT wired for
  SSE — one process has no peer), so the non-HA path is unchanged.
  - **Payloads/event names are byte-identical** — the bus only carries `{origin, event, data}` and
    unwraps to the same `(event, dataObj)`, so the client merge machinery (`mergeSnapshot`/`sseClock`/
    `patchedAt`, XERK-444/545, all CLIENT-side) converges a cross-replica patch as it does a local
    one. There is NO server-side clock; do not add one.
  - **Publish is best-effort** (caught): a store blip never fails the mutation, and each host's next
    beat re-ships its FULL serialized record, so a frame missed during a blip self-heals within a
    beat. Tests: the `XERK-762:` cases in `server.test.js`.

## Tests

- `turma/tests/ha-config.test.js`: precedence, fail-loud (each required URL named),
  the region default, the escape hatch, malformed URL/scheme refusal.
- `turma/tests/store.test.js`: the whole `FileLiveStore` contract, snapshot
  semantics, the byte-for-byte durable proof (content == `JSON.stringify`, no `.tmp-`
  leftover, reload, RAM-only untouched), the RESP2 codec (every type, split chunks,
  multi-reply), and the factory + `SharedLiveStore` URL parse / health / not-connected
  rejection.
