---
paths:
  - turma/leader.js
  - turma/server.js
  - turma/tests/leader.test.js
---

# Leader election + the shared single-flight guards (XERK-763, epic XERK-751)

Under HA (Option 2, `docs/turma-ha-design.md`) the hub runs as N replicas but the SINGLETON
background work must run on EXACTLY ONE. This is the "leader child" the migration/registry siblings
(XERK-756/761) refer to. Read `docs/turma-ha-store-adr.md` §1 (leader election is a k8s `Lease`, NOT
a store key) and `.claude/rules/turma-ha-store.md` first.

## What runs on the leader only

- **The offline-detection sweep** (`offlineDetectionTick`) — else N replicas fire N duplicate offline
  FCM alerts and judge offline against a partial fleet view.
- **The master orchestration tick** (`masterOrchestrationTick`: `reclaimStrandedTicketSpawns`,
  `autoStartSweep`, `autoStopSweep`, `epicRunDriveSweep`, `epicBuilderDriveSweep`,
  `priorityWriteBackSweep`, `dedupeLinkSweep`, `autoMergeSweep`, `autoCloseSweep`,
  `epicRunCompleteSweep`, `drainTicketQueue`) — the fleet-wide ACTIONS: spawn, kill, PR merge, ticket
  close, tracker write-back. N leaders = double-spawns, double kills, double closes, duplicate alerts.
- **Migration-advance** (`migrationAdvanceTick`) — kills the source + finishes the move.

The three interval BODIES are extracted into named, exported functions so the `if (!isLeader()) return;`
gate is BEHAVIORALLY testable (a follower does nothing). The individual sub-sweeps
(`autoStartSweep`, …) stay UNGATED, directly-callable units — the gate is at the tick, not in them
(their own tests call them directly, with no leader, and must keep acting).

## Service gating — active-active: every healthy replica serves (XERK-782, was XERK-765)

- **`/readyz` returns 200 on ANY healthy, non-draining replica** — leader-INDEPENDENT since XERK-782.
  k8s keeps every replica in the Service EndpointSlice, so the LB spreads clients across the whole
  fleet (true active-active / horizontal scale). `/healthz` is unchanged (pure process-up liveness).
- **The XERK-765 leader-serves-all gate is LIFTED — do NOT restore it.** It was load-bearing only
  while cross-replica serving was incomplete. Every prerequisite has landed: the duplex byte-stream
  relay for `/term`, `/live` and `openChannel` (XERK-777 transport + XERK-781 consumers); the
  migration REQUEST-path READ as a hot cross-replica mirror (XERK-778); and the shared archive index
  (XERK-780). **The request-path MUTATION gap the old gate also covered is now CLOSED here** (below),
  so a follower serving write traffic no longer silently drops it.
- **Leader election STAYS, but now gates ONLY the singleton background work — never serving.** The
  three leader-gated ticks (`offlineDetectionTick`, `masterOrchestrationTick`, `migrationAdvanceTick`)
  are unchanged, AND the **inline migration-ADVANCE in the heartbeat handler is now `isLeader()`-gated
  too** (XERK-782): under Option 2 only the leader beat, so that inline `advanceMigrations()` was
  implicitly leader-only; with every replica Ready a host beats to any replica, so an ungated inline
  advance would race the handoff (double source-kill). Every SERVING path a client hits is
  leader-independent: registry/SSE bus (XERK-756/762), command-poke (XERK-764), the terminal/`/live`
  relay (XERK-781), migration reads (XERK-778), archive index (XERK-780).
- **The migration MUTATION flow reaches the leader (XERK-782).** A migration START / blob-upload /
  restore-pack can now land on a non-leader. A FOLLOWER write-throughs ONLY the records it itself
  mutated (`publishMigrations(id)` marks `migrationsDirty`, the follower branch mirrors just those —
  never its whole Map, or it would resurrect a settled move: the registry own=dirty / remote=apply-only
  split). The LEADER FORWARD-LEARNS via `applyRemoteMigration`: it ADOPTS a record it lacks (a
  follower-started move), FORWARD-MERGES phase (exporting→importing→terminal) + progress fields
  (`importCmdId`/`blobPath`/`blobSize`/`targetSessionId`/`error`) it lacks, NEVER regresses phase and
  NEVER touches leader-local `uploading`/`refusal` (so the leader's own mirror self-echo is a no-op).
  A `migrationsRetired` bounded set is the anti-resurrection guard: the leader never re-adopts an id
  it retired, and DELETES the store zombie if a stale echo arrives.
  - **Accepted residual (LOW):** a `refusal` ingested on a follower does NOT travel (mirrorMigration
    still strips it — the leader-local rule XERK-778 pins), so a follower-side agent refusal fast-fails
    only if the leader ingested it; otherwise the move TIMES OUT (`MIGRATE_TIMEOUT_MS`) with the source
    intact — no data loss, just slower failure feedback. Cross-replica command QUEUEING keeps its
    documented ~1s record+watch delivery race (`turma-ha-registry.md`), unchanged. The ticket queue is
    per-replica in-memory (not shared): each replica self-drains its OWN admissions on its own beats
    (the beat-handler `drainTicketQueue` stays UNgated — gating it would strand follower-admitted
    tickets), and the shared double-start guards + agent-side session queue bound the dispatch race.
- **It does not flap:** `isLeader()` is refreshed on every ~2s lease renewal and self-expires only
  after the full ~15s window. **HA off / no elector → `isLeader()` always true**; the flip only removed
  a 503 branch a single-process hub never took, so HA-off / docker-compose is byte-identical.
- **The graceful-drain gate remains, per replica** (XERK-765's other half): a SIGTERM flips
  `hubDraining` so THIS replica reports NotReady and k8s pulls it before its sockets are cut
  (READYZ_DRAIN_DELAY_MS hold). The ArgoCD readinessProbe must point at `/readyz` (NOT `/healthz`);
  liveness/startup stay on `/healthz`.
- **Manifest implication (w4-deploy, XERK-783).** With all replicas Ready, `availableReplicas ==
  replicas`, so a rolling update can use a REAL `maxUnavailable` (e.g. 0/1) for a genuinely
  zero-serving-gap deploy — replacing the FORCED `maxUnavailable: 100%` Option 2 needed (its lone
  Ready pod had to go NotReady before a standby could serve, XERK-772's cold-promote gap). The
  cross-replica byte relay needs the pod-to-pod `RELAY_PORT` exposed + `POD_IP` injected + a
  NetworkPolicy (XERK-781); that manifest work is XERK-783's.
- Tests: `XERK-782: /readyz is leader-INDEPENDENT …`, `XERK-782: the leader FORWARD-LEARNS …`,
  `XERK-782: … never RE-ADOPTS a retired migration …`, `XERK-782: a FOLLOWER write-throughs …` in
  `server.test.js`.

## `isLeader()` and the elector

- **`isLeader()` is SYNCHRONOUS** (the sweeps call it inline) and returns `!hubLeader ||
  hubLeader.isLeader()` — no elector (non-HA production, or a test with none injected) is trivially
  the leader. Non-HA and HA-without-a-lease are ALWAYS leader, so **HA off is byte-identical to today**
  (the full existing suite, run HA-off, is the guard).
- **`createLeader({haOn, …})`** (turma/leader.js) returns:
  - non-HA → `StandaloneLeader("single-process")` (always leader).
  - HA + a reachable k8s service account → a `LeaderElector` (k8s `Lease` in `coordination.k8s.io`).
  - HA + NO k8s API (compose/dev) → `StandaloneLeader("ha-no-lease")` with a LOUD boot warning
    (sweeps then run on every replica). Deliberately DEGRADE, never refuse to boot — a compose HA
    stack (XERK-755) has no k8s API.
- **The election is a k8s `Lease`, stdlib only** — `node:https` with the service-account CA + bearer
  token; the RBAC (ServiceAccount + Role, `automountServiceAccountToken:true`) is the `manifest`
  sibling's job, NOT this ticket. The algorithm is pure over an injected `request(method,path,body)`,
  so acquire/renew/failover/conflict are unit-tested with a fake API (no live cluster) — the same
  no-live-backend discipline as `store.js`'s RESP codec.
- **`isLeader()` self-expires off a LOCAL clock**: `_leader && now - _lastRenew <= leaseSeconds*1000`.
  A wedged election loop (no ticks firing) drops leadership even though `_tick` never cleared it — the
  split-brain defence. A transient API error keeps leadership only within the renewDeadline, then
  drops it. Do NOT remove either guard.
- **The self-expiry bounds on the ADVERTISED lease (`leaseSeconds*1000`), NOT the raw
  `leaseDurationMs`** (XERK-763 QA): a k8s Lease advertises integer SECONDS (`leaseDurationSeconds`),
  which is what a standby reads for expiry, and `leaseSeconds` CEILs — so the local guard's window is
  never LOOSER than the standby's. A raw-ms bound + a round-DOWN `leaseSeconds` (the original bug)
  let a wedged leader outlive the standby's acquisition for a fractional-second custom lease. Keep the
  two in agreement (both `leaseSeconds*1000`, `leaseSeconds` ceiled). Timing tests that need real
  expiry use ≥1s.
- **On graceful shutdown the leader RENOUNCES** (`release()` backdates the lease's `renewTime`) so a
  warm standby promotes within a beat or two instead of waiting out the whole lease — the fast-
  failover point of a deploy. Fire-and-forget; the drain never waits on it.

## The shared single-flight guards (failover re-fires nothing)

The in-memory guards the sweeps rely on are WRITE-THROUGH mirrored to the shared store under
`guard:<name>:<key>` and HYDRATED on leader promotion, so a leader CHANGE mid-flight does not re-fire
an action the old leader already guarded. Each guard keeps its native Map/Set as the SYNCHRONOUS
read/write the sweeps use (unchanged); the store is the durability/handover backend ON TOP — exactly
the wave-3 pattern (`turma-ha-registry.md`). A failover is thus made STRICTLY BETTER than a restart,
which every one of these guards already tolerates (their own comments say so).

- **`registerGuardMirror(name, {ttlMs?, apply})`** binds a guard to its store prefix; `guardStoreSet`/
  `guardStoreDel` are the write-through (both early-return on `!HA_ON` — the byte-identical gate);
  `hydrateGuards()` scans every registered prefix and rebuilds the native structure via `apply`.
- **A per-write TTL bounds the store** (default 7d; `cmdHosts`/`createInFlight`/`dispatch` match their
  native TTLs), so LRU-eviction deletes need NOT propagate — only MEANINGFUL clears do (a completed/
  superseded guard: `forgetCreateInFlight`, `autoStarted`/`epicChildAttempts` on a session appearing).
- The guards mirrored: `cmdHosts`, `createInFlight`, `ticketDispatchedAt` (`dispatch`), `autoStarted`,
  `autoStopped`, `autoStopResumeExempt`, `epicDoneWritten`, `autoCloseNotified` (its `urls` Set stored
  as an array, rebuilt on hydrate), `epicChildAttempts`.
- **`onLeaderPromoted()`** (the elector's onChange edge, and boot-as-leader) runs `hydrateMigrations()`
  + `hydrateGuards()`. It is the seam `session-migration.md` / `turma-ha-registry.md` name as "the
  seam the leader child calls on promotion".
- These guards are DURABILITY-HARDENING, not a correctness prerequisite: the DURABLE guards remain
  authoritative for a true double-action (`startedTicketKeys`, `committedTicketSpawn`, the epic's own
  board Done), so a dropped/blipped store write self-heals (re-derived by the sweep, re-hydrated on
  the next promotion).

## Tests

- `turma/tests/leader.test.js`: StandaloneLeader always-leader; the k8s election over a fake Lease
  API — acquire (404→create), renew, follower-while-valid, failover on expiry, the split-brain
  self-expiry, a 409 stale-RV PUT not claiming leadership, `release()` fast handover, and the
  transient-error keep-then-drop.
- The `XERK-763:` cases in `server.test.js`: `isLeader()` follows an injected leader;
  `migrationAdvanceTick` advances only on the leader; HA-off guard writes are inert; a Set guard and a
  Map guard write-through + hydrate; the `autoCloseNotified` urls-Set round-trip; a meaningful clear
  propagating; `onLeaderPromoted` hydrating. The full suite (HA off) is the byte-identity guard.
