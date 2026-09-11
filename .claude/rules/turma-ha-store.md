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
- **The store is now created at MODULE LOAD** (`liveStore`, before the TURMA_TEST/production split)
  rather than only in the production boot branch — so the test and production paths share one store
  and a wave-3 call site can reach it. The boot-time PRINT + fail-loud `exit(2)` stay on the
  production path (a `require` under TURMA_TEST must not print or exit); a FATAL config is coerced to
  the file backend at creation so `createLiveStore` never parses a broken shared URL before the
  branch names the error. `void liveStore` is gone.

## Wave-3 children (call sites flipped onto the store)

- **XERK-760 — the OIDC PKCE/session/handoff side-stores** (`oidcTx`/`oidcSessions`/`oidcHandoffs` →
  `OIDC_*_PREFIX` keys, TTL'd). The first wave-3 child. Mechanics + the cross-replica rationale live
  in `.claude/rules/turma-oidc.md` ("HA requirements" + the tx/session/handoff invariants). Note the
  count-cap (`oidcEnforceCap`) is a FILE-BACKEND-ONLY heap guard: on the shared backend a
  scan-then-evict-oldest across replicas would race and evict another replica's in-flight entry — TTL
  + Valkey maxmemory bound it there instead.
- **`getDel(key)` was added to the contract by XERK-760** — atomic get-and-delete (RESP `GETDEL` on
  the shared backend; a no-await-between read+delete on the file backend), so a single-use consume
  can't be double-read by concurrent callers. Decomposing it into `get()`+`del()` at a call site
  reintroduces that race — the file backend yields the event loop between the two awaits.
- **XERK-758 — the durable USAGE LEDGER** (`usage-ledger.js` → a pluggable persistence backend, file
  default byte-identical / `SharedLedgerBackend` in `usage-ledger-shared.js`). UNLIKE the OIDC child it
  did NOT flip a `LiveStore` call site inline: the in-memory model + every read (`fold`/`retiredAgents`/
  `has`) stay synchronous, and only PERSISTENCE swaps — each host is its own key
  `usage:host:<key>`, written by an atomic per-host high-water **max-merge** under `compareAndSet`/
  `setIfAbsent` (a low/partial writer can never lower a recorded total). Wired by
  `usageLedger.configure(liveStore, haConfig, invalidateAgentsCache)` at boot; reuses `scan`/`watch`
  unchanged — **no new store primitive.** The boot/reconnect scan runs on the store's health→ready
  edge (never inline in `init`, which would reject on a not-yet-connected socket) and invalidates the
  hub's `/api/agents` cache on any non-beat model change. DELIBERATE ADR divergence (ledger on Valkey,
  not the ADR's Postgres — no stdlib PG client yet); the max-merge write is backend-agnostic so a PG
  `LedgerStore` slots in later with no call-site change. Full rules: `.claude/rules/turma-usage.md`
  ("HA: the shared-store backend").

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
