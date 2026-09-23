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
- **The proof is bound to its REQUEST and single-use** (XERK-936): `<at>.<nonce>.<mac>`, the mac over
  list + method + target + stamp + nonce (`hopProof`, the one definition both sides use). Stale
  (`PROOF_MAX_AGE_MS`, 30s either way), another method/target, or a nonce this replica already
  accepted = ignored like a forged one. A list-only mac let one captured pair be replayed forever.
  - Verified ONCE per request (`hopCache`): `decide()` re-runs every hold poll — never a "replay".
  - Only a NON-serving replica verifies (`decide` returns local first), and filling it takes the key,
    so the seen-nonce map stays tiny. Full of FRESH nonces it fails CLOSED (refuses), never evicts.
  - **A valid proof whose LAST hop is this replica is REFUSED at once: 508** (`decide` → `loop`) —
    never forwarded, held or served. It is either a replay onto its minter (the one replica a replay
    bites: its id is in the list, so it would hold, then serve DEGRADED) or a genuine SELF-LOOP (the
    leader endpoint reaches US — an alias, proxy, sidecar, NAT hairpin). The two cannot be told
    apart statelessly, and every attempt to was defeated in QA: a minted-nonce cache (evicted by a
    10k-request flood), a TCP-peer match (lost to address translation). Ignoring the list instead
    recursed forwarding into ourselves until MAX_CONNECTIONS.
  - The 508 carries the looped proof's nonce (`x-turma-forward-loop`); a minter seeing ITS nonce
    come back learns that leader address as an alias of itself (`ownAliases`, 10 min), so later
    requests hold + serve as for `isOwnAddr`. Cost of a loop: ONE retryable 508 per alias TTL.
    Upgrades are piped raw, so they are refused but never teach the alias.
  - The mac cannot cover the body (it streams), so a pair replayed within 30s onto a THIRD replica
    that never saw it, same method + target, is honoured once there. That bites only while that
    replica believes the minter leads (a transient disagreement): one held-then-DEGRADED request.
  - Node clock skew past 30s refuses every proof = the bounce guard off; logged, never a stuck request.
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
- **A body DECLARED past the route's cap + drain slack is refused BY THE FOLLOWER** (XERK-936). The
  leader answers such a body 413 and then RESETS, and Node reported the follower's next write's
  `ECONNRESET` before the queued 413 — a 502 the agent retries instead of the 413 that says SHRINK.
  - `refuseOversize` replays the leader's no-drain path exactly: discard to cap + slack, 413, cut.
    Draining first is XERK-235 — urllib writes the whole body before reading.
  - The follower judges against the LEADER's caps + slack ALONE, published in `hubLeader:endpoint`
    (`bodyCaps`/`drainSlack`, XERK-939) — never its own, nor a `min` of both: mid-rollout (a changed
    memory limit) a smaller-cap follower cut a body the leader takes. No FRESH usable caps (an older
    leader, a malformed entry, a stale entry while the store link is down) = forward, never refuse.
  - It refuses only a request `decide()` would FORWARD, and only after a connect proves the leader is
    up (`leaderAlive`, nothing sent). A refusal never otherwise dials, so a crashed leader's caps
    kept refusing until its entry aged out; a held request (own entry, handover) is never judged.
  - Route keys come from server.js `forwardBodyRoute`, caps from `forwardBodyCaps` — the SAME
    constants the routes read with (drift pinned by a source-match test). Uploads use
    `UPLOAD_MAX_BYTES`, the ceiling over every host's own cap.
  - Only past the auth gate the leader runs BEFORE reading (`agentPresentedRefusal`,
    `userAuthorized`, `agentHostRefusal`): a credential-less body stays the leader's 401, unread.
  - A refusal making less than `drainMinProgress` (64 KiB) per `drainIdleMs` (10s) is cut — else 8
    slow-loris sockets (silent OR a 1-byte trickle) held every slot and switched it off.
  - Only routes whose 413 is STATELESS: heartbeat, both uploads, raw archive. NOT the archive chunk
    or migration blob (the leader RECORDS those refusals), NOT default-`BODY_MAX` routes (not every
    POST reads its body). Those, chunked bodies and anything past `drainMax` concurrent refusals keep
    the old path: forwarded through the yielding feed stage, the 502 race still possible (rare).
- **Known two-writer case (XERK-935, pre-existing): an ASYMMETRIC store partition.** A leader whose
  store link is down cannot publish its endpoint, so a healthy-store follower degrades and serves too.
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
  `registry-store.test.js`.

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
