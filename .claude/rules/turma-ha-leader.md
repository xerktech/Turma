---
paths:
  - turma/leader.js
  - turma/forward.js
  - turma/server.js
  - turma/tests/leader.test.js
  - turma/tests/forward.test.js
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

## Serving — the leader is the SINGLE WRITER; followers forward (XERK-919)

- **Every replica is Ready, but only the lease leader SERVES.** A follower transparently forwards
  every HTTP request and WebSocket upgrade to the leader (`turma/forward.js`, wired first thing in
  both server.js handlers); only `/healthz` + `/readyz` are always answered locally. So the hub's
  whole request path runs in ONE process — the single-process semantics every path was written
  against — while rolling deploys keep a Ready endpoint and a warm standby.
- **Why active-active (XERK-782) was reverted: per-process state is everywhere, and a request and its
  follow-up landed on different replicas.** Reproduced on a real 2-replica stack (XERK-919): the
  agent's `/agent/data` dial-back paired against `pendingChannels` on the WRONG replica ~50% of the
  time (every failed terminal open = a 5s stall into the reconnect interstitial); commands queued on
  one replica were overwritten by the other's whole-record beat write (46% of chat inputs lost at a
  600ms cadence); the `AGENT_CACHE_KEYS` results, ticket queue and alert dedup were per-replica; a
  re-dialed tunnel left a live-looking stale channel on the old replica. **Do NOT restore
  active-active serving** — each of those needs its own cross-replica protocol and more remain.
- **The leader publishes its HTTP address** (`hubLeader:endpoint` → `{replica, addr, at}`, TTL'd,
  refreshed every 2s + on the store ready edge + at promotion); followers hold a hot mirror (watch +
  boot hydrate), freshness judged on the RECEIVER's clock. `addr` = `TURMA_HUB_ENDPOINT` ?? `POD_IP:PORT`
  ?? first IPv4 — so the hub's own port (8300) must be reachable pod-to-pod, like the relay port.
- **Never two writers — a replica that can neither serve nor forward HOLDS the request** (100ms
  polls, bounded `holdMs`). `canServeLocally()` = leader AND past the promotion re-sync. Past the
  bound it serves locally, logged `DEGRADED` — correct when it is the sole survivor (2 replicas, the
  leader crashed), an accepted brief split with 3+. A leader that published `addr:null` degrades at
  once. `TURMA_HA_FORWARD=0` is the escape hatch back to active-active.
- **The hop list (`x-turma-forwarded-by`) bounds forwarding**: never back through a replica already
  traversed, never past `MAX_HOPS` (2) — two replicas that briefly disagree hold rather than bounce.
  **It is only trusted with a valid proof** (`x-turma-forward-auth` = HMAC of the list under
  `HMAC(SESSION_KEY,"turma-forward")`); a client-supplied list is ignored and stripped. Unproven, any
  client could force a follower to hold 5s and then serve DEGRADED — a second writer on demand
  (QA measured 3/100 acknowledged inputs lost that way).
- **A follower hands back tunnels it holds** (`dropDegradedTunnels`: every control channel closed
  1001, local `/live` viewers dropped) the moment a fresh remote leader is known — on the forwarder's
  `onRemoteLeader` edge and a 2s sweep. A tunnel accepted while this replica led, or while it served
  DEGRADED after a crash, otherwise stays pinned to a replica the dial-backs never reach: that host's
  terminals fail forever (QA: 3/5 SIGKILL+restart trials). Never while this replica serves.
- **A leader entry naming THIS replica's own address under another id is a previous incarnation**
  (a container restart keeps `POD_IP`) — ignored, never dialed (it forwarded to itself).
- **While this replica's STORE link is down, the last known leader stays the target** regardless of
  entry age (`storeHealthy`) — a stale-by-age entry proves nothing when refreshes cannot arrive; only
  a failed dial ends it. Else a store blip turned a follower into a DEGRADED second writer.
- **Forwarding is byte-faithful**: the follower dials the leader BEFORE reading the request (a failed
  dial leaves it unread, so it can still be held/served), pipes the body, relays raw headers
  (duplicate `Set-Cookie` kept), streams SSE chunk-by-chunk, and a leader dying mid-body TRUNCATES
  the client (never a hang — the XERK-865 lesson). An upgrade is rebuilt from `rawHeaders` + `head`
  and piped raw, so the leader does the handshake. `Connection: close` upstream (one socket each),
  headers flushed at once (a client that sends `Expect: 100-continue` then no body still gets the
  leader's 401/413), a `Host` added for an HTTP/1.0 client that sent none.
- **Residual: a body past the leader's cap + drain slack can surface as 502, not 413, ~1 in 6.**
  The hub answers 413 then RESETS; Node reports our next write's `ECONNRESET` before reading the
  queued answer. The body is fed through a stage that yields to the event loop between chunks (and
  stops on the answer) so the read usually wins; the agent retries a 502, so it self-heals. Fully
  closing it needs the hub not to reset forwarded bodies — which weakens its runaway-body defence. Tracked: XERK-936
  (with the hop proof binding only the list, not the request — replayable pod-to-pod).
- **Asymmetric store partition — a store-less leader STEPS DOWN, a store-less replica REFUSES if the
  lease is held elsewhere (XERK-935).** A leader whose store link is down cannot publish/refresh its
  endpoint, so a healthy-store follower used to degrade and serve too (two writers). Two-part fix, one
  signal — the k8s lease lives in the API, NOT the store, so it stays readable/writable when the store
  link is down:
  - **The elector ABSTAINS while it cannot lead** (`canLead` = `storeHealthy`, `turma/leader.js`): a
    store-less holder drops leadership and BACKDATES the lease (`_abstain`, release-style but the loop
    keeps running) so a healthy replica promotes within a retry, keeps GETting the lease to observe who
    takes over and to re-elect on store recovery, and never acquires/renews meanwhile. So a store-less
    leader stops leading (its sweeps + `canServeLocally` fall with `isLeader()`), and the healthy
    replica becomes the proper single writer.
  - **The forwarder REFUSES (503) instead of degrading when `!storeHealthy() && leaseHeldElsewhere()`**
    (`decide()`): a store-less replica cannot learn the new leader's endpoint (it rides the store), but
    `leaseHeldByOther()` (off the elector's lease observation) says a healthy replica leads — so refuse
    and let the client's LB retry reach it, never become a second writer. With NO other lease holder we
    may be the SOLE SURVIVOR, so the normal hold/degrade path still serves locally (unchanged). Both
    deps default to always-lead / never-elsewhere, so HA-off and a StandaloneLeader (single-process /
    ha-no-lease) are byte-identical.
  - Accepted residual: a brief (~one retry) window between the store-less leader abstaining and the
    healthy replica acquiring, where the store-less replica may still serve degraded (no other holder
    yet) — the same "accepted brief split" class as a crashed-leader failover, bounded by the backdated
    handover, not the permanent double-write it replaces.
- **The hop proof is compared as BYTES** — a non-ASCII value of the right string length made
  `timingSafeEqual` throw, an unauthenticated crash of any follower via one upgrade (QA). The upgrade
  handler also catches any forwarding fault. With the store down, a leader is "fresh" for the tunnel
  hand-back only while dials to it recently SUCCEEDED (else tunnels went to a dead leader).
- **The graceful handover, in this order (load-bearing)** — the leader KEEPS leading through the
  `/readyz` hold (followers keep forwarding to it), then in `cutAndFlush`: close the listener →
  `await flushAgentsToStoreNow()` → `await release()` → `await forwarder.retract()` (deletes its
  endpoint so followers hold for the successor) → cut SSE/tunnels. Releasing at signal receipt (the
  old order) left ~2s of two writers and lost the old leader's last commands. Each await is bounded.
- **A promoted leader re-reads the registry before serving** (`resyncAgentsFromStore` in
  `onLeaderPromoted`, bounded `PROMOTION_SYNC_MAX_MS`): it flushes its OWN pending writes, then applies
  every stored host over its mirror — EXCEPT a host it wrote after the scan began (`localWriteGen`),
  whose local copy is newer. Covers a dropped/late pub/sub event and the degraded-window writes.
- **A draining follower never degrades to local** — `stop()` makes a hold end in `503 Retry-After`.
- **What HA now buys**: zero-gap rolling deploys (measured: a follower-then-leader roll under load,
  240/240 inputs delivered, 0 lost, max 678ms) and pod-loss survival (a SIGKILLed leader: 0 inputs
  lost; terminals down until the lease expires, ~15s). **Not** horizontal request scale-out.
- The tunnel directory + byte relay (`turma-ha-tunnel.md`) stay as the handover/degraded path.
- **The graceful-drain readiness gate is per replica**: SIGTERM flips `hubDraining` → `/readyz` 503.
- Tests: `turma/tests/forward.test.js` (incl. the `XERK-919 QA:` cases, and a SOURCE pin on the
  drain's release-at-signal wiring, which no TURMA_TEST path reaches); the `XERK-919:` cases in
  `registry-store.test.js`. The `XERK-935:` cases pin the store-partition fix: in `leader.test.js` a
  store-less leader abstains + backdates so a healthy replica promotes, `leaseHeldByOther()`
  (holder/other/sole-survivor + wedged-observation staleness), re-lead on recovery, and the
  always-lead default; in `forward.test.js` the refuse-not-degrade when the lease is held elsewhere,
  the sole-survivor still serving, and the byte-identical default.

### Verifying HA for real (the local stack recipe)

- **The unit suite cannot see these bugs** — every one above was found on a real multi-process
  stack behind a no-affinity LB. Stand one up locally: Valkey (static binary from
  `download.valkey.io`), Postgres (`pip install pgserver`; initdb/pg_ctl as `nobody` via `setpriv`,
  `LD_LIBRARY_PATH=…/pgserver.libs`, every path component `o+x`), S3 (`pip install 'moto[server]'`),
  two `node server.js` with `HA_MODE=1` + distinct `PORT`/`TURMA_RELAY_PORT`/`TURMA_HUB_ENDPOINT`, a
  round-robin TCP LB that polls `/readyz`, the real `agent/tunnel-agent.js` (poke via
  `~/.turma/poke-port`), and a fake heartbeat agent + fake ttyd.
- **TRAP: this host's pod service account is in prod's namespace (`ai`).** A test hub finds it and
  elects against the PROD `turma-hub-leader` Lease. Always point `KUBERNETES_SERVICE_HOST` at a local
  fake Lease API and set `TURMA_LEADER_TOKEN_FILE`/`_CA_FILE`/`_NAMESPACE`/`TURMA_LEADER_LEASE`.
- **Judge a terminal by BODY, not status** — a failed open returns the reconnect interstitial as 200.
  Judge a command by what the agent RECEIVED, not the 200 + cmdId.

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
  warm standby promotes within one retry instead of waiting out the lease — but only AFTER its
  registry writes landed (the handover order above); a draining FOLLOWER stops its elector at once.

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
