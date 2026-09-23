---
paths:
  - turma/server.js
  - turma/tests/registry-store.test.js
---

# The fleet registry in the shared store (XERK-756, epic XERK-751)

The central HA blocker: the `agents` fleet registry AND the per-host command queues move OFF the RWO
`state.json` volume into the shared `LiveStore` (XERK-754, `turma-ha-store.md`), so ANY replica can
ingest ANY host's beat and serve the WHOLE fleet from `/api/agents`. Read `docs/turma-ha-store-adr.md`
for the store contract this plugs into.

## The design in one line

- **`agents` stays the SYNCHRONOUS in-memory read/write model in BOTH modes** — the 13k-line request
  path, `buildAgentsCache`, `serializeAgent`, `a.commands`/`publicCommands`/ack/reclaim are ALL
  UNTOUCHED. HA adds a per-host write-through + boot hydration + a watch on top; that is the whole change.

## Non-HA is byte-identical (the load-bearing invariant)

- **With HA off (default), nothing here runs** — state.json save/load is exactly as before. The seam
  is gated on `HA_ON` at every entry: `markAgentDirty`/`markAgentRemoved` early-return, `scheduleSave`
  is unchanged, the state.json restore runs (`if (!HA_ON) try { … }`), `flushStateNow` writes the file.
- `HA_CONFIG`/`HA_ON` are resolved ONCE at module top (pure, dials nothing) so the module-top state
  loader can skip state.json in HA; `liveStore` is BUILT in the boot branch and assigned to the module
  binding the seam reads. A test injects one via `__setLiveStore(store, on)`.

## HA write model (per-host, non-clobbering)

- **REPLACES the full-map state.json serialize with ONE `set` per host record** (`agent:<host>`), so
  concurrent replicas write DISJOINT keys and never clobber each other's hosts.
- **A replica writes ONLY the records it OWNS.** `publishAgent` marks the key dirty (a beat, a queued
  command, a refusal stamp, an offline mark); the three GENUINE-removal sites (`makeRegistryRoom`
  eviction, the `DELETE /api/agents/<host>` route, the 7-day `prune`) mark it removed. The debounced
  `flushAgentsToStore` (`HA_STORE_DEBOUNCE_MS`, 1s) `set`s the dirty and `del`s the removed.
- **Boot trim (`trimRestoredAgents`) drops LOCALLY, never from the store.** It is a per-process
  capacity decision — this replica cannot hold the whole durable fleet under its OWN `AGENTS_MAX`/byte
  budget (a local bound, like the caches) — NOT a removal. Deleting the over-budget (oldest-`lastSeen`)
  keys from the SHARED store would drop offline hosts' records cluster-wide, the exact durable state
  this externalization exists to preserve (QA MEDIUM defect, fixed). **Do NOT call `markAgentRemoved`
  from `trimRestoredAgents`** — the store keeps every record for a replica with room / the host's
  return. Pinned by the "boot trim drops locally but never deletes peer records" test.
- **`applyRemoteAgent`/`applyRemoteRemoval` (the watch handlers) NEVER mark dirty** — a record learned
  from another replica must not be echoed back and re-written under its owner. This split (own = dirty,
  remote = apply-only) is what keeps per-host writes disjoint; do not route the watch through
  `publishAgent`.
- **The watch handlers update the MAP only — they do NOT `sseBroadcast`.** The client PUSH is the
  XERK-762 SSE shared bus's job (the owning replica's `publishAgent` published the `agent` frame to the
  bus, which every replica re-emits to its own clients). Broadcasting in the watch handler too would
  double-deliver each frame and amplify bus publishes O(replicas). The registry watch is the MAP/state
  channel; the SSE bus is the client channel. Both are gated on `HA_ON` and wired together at boot, so
  the bus is always present when the watch is. Do not re-add `sseBroadcast` to the watch handlers.
- **The store record is the record MINUS `AGENT_CACHE_KEYS`** (`agentStoreRecord`, the same subset
  `serializeAgentsForSave` strips). The caches stay PER-PROCESS (the ticket's rule); `commands` is
  KEPT, so **the per-host command queue rides the record — there is no separate list key to sync.**
- **Store writes are best-effort, fire-and-forget, and NEVER throw** (`storeWriteFailed` logs) — an
  uncaught throw in a timer exits the hub (XERK-235). A dropped write self-heals: the record re-writes
  on the host's next beat, and a warm standby re-reads on promotion.

## Reads + hydration

- `/api/agents`/`buildAgentsCache` read the whole fleet from `agents`, which HA keeps hot: boot
  `hydrateAgentsFromStore` (`scan("agent:")`) + a `watch("agent:")` that mirrors records other replicas
  wrote. Memoization/ETag are preserved (the read path is unchanged).
- **Hydration runs the SAME restore coercions as the state.json path** (`dropUnusableHostKeys`,
  `dropNonObjectRecords`, `normalizeRecord(…, "restore")`, `sanitizeRestoredCommands`,
  `trimRestoredAgents`) — so the STATE_FILE size-gate/eviction semantics and the wire-contract
  coercions hold against the store, and a restored undelivered command is stamped delivered (XERK-303).
- **Watch FIRST, then scan** (boot order) so no cross-replica change is missed during the async scan; a
  key a watch event already populated is left alone (the watched value is fresher).

## Known constraints

- **Serving is single-writer (XERK-919)**: the lease leader serves every request and followers
  forward to it (`.claude/rules/turma-ha-leader.md`), so in steady state ONE replica mutates records
  and the whole-record last-writer-wins model is safe. Under active-active it was not — a command
  queued on one replica was overwritten by another replica's beat write. Do not reintroduce
  concurrent writers to one host record without a merge protocol.
- **Every stored record carries its writer's replica id (`__writer`, `STORE_WRITER_KEY`), and the
  watch drops ANY own echo by it** — never rely on `lastStoreWritten` alone. It remembers only the
  LAST write, so with two writes for one host in flight the echo of the EARLIER one read as remote
  and reverted the record, silently dropping every command queued since (measured). The stamp is
  stripped (`withoutWriter`) on every path that installs a store value: watch, hydrate, re-sync.
- **A queued command is flushed to the store AT ONCE** (`queueCommand` → `flushAgentsToStoreNow`),
  not on the 1s debounce: the 200 + cmdId promises the command exists, and a leader crash inside the
  debounce lost it. Beats and other mutations keep the debounce.
- **Leader election IS wired** — a k8s `Lease` (XERK-763), gating the singleton sweeps + the
  eviction/prune `del`s, and (XERK-919) who serves. Do not add a store-key lease here (the ADR keeps
  election in k8s).

## Tests

- `turma/tests/registry-store.test.js` (own process): non-HA inert; the per-host write (caches
  stripped, one key per host, commands kept); a queued command riding the record; removal deleting the
  key; hydration with the restore coercions + the XERK-303 delivered stamp; the watch mirroring a
  remote record without an echo write, and a remote deletion; the `XERK-919:` cases (a LATE older own
  echo never reverts a record, the writer stamp stripped on apply, the immediate command flush, the
  promotion re-sync skipping a host written mid-scan).
- The full existing suite (`server.test.js`, `registry-cap.test.js`, `registry-restore.test.js`,
  `cache-budget.test.js`) is the non-HA byte-identity guard — it runs with HA off and must stay green.
