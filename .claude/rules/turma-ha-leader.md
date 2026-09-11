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

## Service gating — the leader is the only Ready endpoint (XERK-765)

- **`/readyz` returns 200 ONLY on the leader** (`hubDraining` false AND `isLeader()` true); a
  non-leader answers **503 `{ready:false, leader:false}`**. This is the "Service gating" the design
  doc pairs with the lease: XERK-763 gated the SWEEPS, this gates the SERVICE. k8s pulls a NotReady
  pod from the Service EndpointSlice, so under HA the leader is the ONLY pod client/agent traffic
  reaches — the standbys stay warm off the shared store and serve nothing.
- **This is load-bearing, not cosmetic.** The shipped hub only supports Option 2 (leader-serves-all):
  the cross-replica terminal/`/live` byte-stream relay is deferred (XERK-764) so terminal bytes serve
  only from the tunnel owner's replica, and the migration request path reads a leader-only in-memory
  Map (`server.js` `:3588`, `:11905`). A non-leader that served traffic would return dead terminals
  and stale 404s. **Do NOT remove the `isLeader()` gate from `/readyz` or make non-leaders serve**
  until the byte-stream relay lands (true active-active).
- **It does not flap:** `isLeader()` is refreshed on every ~2s lease renewal and self-expires only
  after the full ~15s window, so a healthy leader stays Ready through a transient API blip; only a
  genuine partition drops it (which SHOULD pull it from the Service). **HA off / no elector →
  `isLeader()` always true → always Ready**, so single-replica and docker-compose are unchanged.
- **Failover has a bounded gap, by design.** On a rolling update the draining leader flips NotReady
  and renounces the lease (backdated `renewTime`); a standby wins it within a beat or two and flips
  Ready. Between the two there can be zero Ready endpoints for ~1–2s — the reconnect the epic accepts,
  NOT a sustained outage (streams close with reconnect hints). The ArgoCD `deployment.yaml`
  readinessProbe must point at `/readyz` (NOT `/healthz`) for this to take effect; liveness/startup
  stay on `/healthz` so a warm standby is never SIGKILLed for being un-Ready.
- Tests: `XERK-765: /readyz follows leadership …` in `server.test.js`.

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
