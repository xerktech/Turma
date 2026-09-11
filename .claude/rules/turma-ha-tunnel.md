---
paths:
  - turma/server.js
  - turma/tests/tunnel-directory.test.js
---

# Cross-replica tunnel/terminal/command plane (XERK-764, epic XERK-751)

The #1 active-active blocker. Each agent holds exactly ONE reverse-tunnel control WebSocket to ONE
replica (`controlChannels[host]`, set in the `/agent/control` upgrade). Under active-active HA a
dashboard read of `terminalOnline`, a queued command's poke, a `/term`/`/live` socket, or an
`openChannel` dial-back can land on a DIFFERENT replica than the one holding a host's tunnel. Read
`docs/turma-ha-design.md` (§Option 3) and `docs/turma-ha-store-adr.md` for the topology this is the
hub half of, and `.claude/rules/turma-ha-store.md` for the `LiveStore` seam it plugs into.

## What this child lands, and what it defers (the scope decision)

- **LANDS: the shared host→owning-replica DIRECTORY + the CONTROL-plane fixes it enables.** Any
  replica can now tell the truth about a host's tunnel and deliver a poke to it, cross-replica.
- **DEFERS: the duplex BYTE-STREAM relay** for `/term`, the `/live` deltas and the `openChannel`
  data channel. Relaying bulk interactive terminal traffic through the store's pub/sub would ride the
  SAME single shared subscriber connection the SSE bus (XERK-762) and the registry watch (XERK-756)
  depend on — head-of-line blocking on the fleet's liveness channel. So the byte relay is a separate
  follow-up (bus-relay or route-by-host-at-ingress). Until it lands, those bytes serve only from the
  tunnel owner's replica — which is exactly the recommended Option-2 (leader-only-serving) topology's
  behaviour, so nothing regresses. Do NOT push raw terminal/`/live`/ttyd bytes through
  `store.publish`/`subscribe`.

## The directory

- **`hostReplica:<host>` → `{replica, at}`** in the shared store (`HOST_REPLICA_PREFIX`). The OWNING
  replica writes it on control-channel connect (`publishHostTunnel`), REFRESHES it on every control
  ping (so its TTL never lapses under a live tunnel), and DELETES it on drop (`retireHostTunnel`).
- **Written with a store TTL (`HOST_REPLICA_TTL_MS`) so a crashed owner's entry expires** even if its
  `del` never runs. TTL = `max(CONTROL_DEAD_AFTER_MS, CONTROL_PING_EVERY_MS × 3)`.
- **Every replica keeps a hot in-memory MIRROR** (`hostTunnelOwners`), populated by
  `watchTunnelDirectory` (a `watch` on the prefix) + the boot `hydrateTunnelDirectory` scan — the
  SAME pattern the registry watch uses to keep `agents` hot. This is what keeps the request path
  SYNCHRONOUS: `serializeAgent`'s `terminalOnline` reads the mirror, never `await`s the store.
- **`publishHostTunnel`/`retireHostTunnel` also write THIS replica's own mirror entry SYNCHRONOUSLY**,
  so `terminalOnline` and the retire owner-guard read the truth for our own tunnels without waiting on
  the self-echo watch. `controlChannels` stays the authoritative local truth; the mirror answers for
  OTHER replicas' tunnels.
- **Freshness gates the read** (`hostTunnelOwnerLive`): a mirror entry older than `HOST_REPLICA_TTL_MS`
  reads as no-owner, so a dead/handed-off tunnel never lingers `terminalOnline` even if the del/expiry
  was missed. The store TTL is the backstop; this is the belt.
- **A periodic `sweepTunnelDirectory` reclaims stale mirror entries.** On the SHARED (Valkey)
  backend a `PX`-TTL expiry fires NO watch event (the store announces only on an explicit set/del,
  deliberately not via Redis keyspace notifications), so a CRASHED owner's entry — whose
  `retireHostTunnel` del never ran — would otherwise linger in `hostTunnelOwners` for the process
  lifetime (the unbounded host-name map class XERK-272 caps `agents` against). The freshness gate
  already keeps every READ correct; the sweep frees the memory. A LIVE owner's entry is refreshed
  within the TTL by its ping-set arriving on the watch, so only genuinely-dead entries are removed.
  On the FILE backend the TTL already fires a `del` watch, so the sweep is a no-op there (and the
  tests, which use the file backend, exercise `sweepTunnelDirectory` directly rather than the timer).
- **`retireHostTunnel`'s owner-guard only `del`s if the mirror still shows US as owner.** A host that
  reconnected to another replica has that replica's newer `set` owning the key; our stale `del` must
  not clear it (the true owner's next ping re-establishes it within `CONTROL_PING_EVERY_MS` either
  way, but the guard avoids the flap). It clears our OWN mirror entry immediately so `terminalOnline`
  on this replica falls to false the instant the tunnel drops.

## `terminalOnline`

- **`terminalOnline` = `!!controlChannels[key] || hostTunnelOwnerLive(key)`** — held by THIS replica,
  OR a fresh directory entry on another one. Was `!!controlChannels[key]`, which answered "offline"
  cross-replica for a host a sibling holds.

## Cross-replica command poke — the control bus

- **`pokeHost(host)` replaces the inline `controlChannels[key].sendPoke()` in `queueCommand`.** Local
  channel → poke directly (unchanged single-process path). Otherwise, in HA, publish an ADDRESSED poke
  on the control bus (`CONTROL_BUS_CHANNEL`) to the owning replica, which pokes its local channel.
- **Never poke a STALE, SELF, or ABSENT owner** — a stale owner's tunnel is presumed dead; a
  self-owner with no local channel is a torn-down tunnel whose del is in flight; either way the
  command still rides the host's next SCHEDULED beat (the poke is only a latency optimisation).
- **`makeControlBus(store, replicaId)` is standalone + store-injected** (like `makeSseBus`) so the
  address routing is unit-testable with a `FileLiveStore` (no live Valkey in CI). Messages are routed
  by `target` (a replica id); a replica ignores anything not addressed to it or malformed. The channel
  is kept extensible (`{type, target, …}`) for the deferred byte relay.

## Non-HA is byte-identical (the load-bearing invariant)

- With HA off, `hostTunnelOwners` stays empty and `controlBus`/`sseBus` null: `publishHostTunnel`/
  `retireHostTunnel` early-return, `terminalOnline` is purely `controlChannels`, and `pokeHost` never
  leaves the process. Everything gates on `HA_ON` at its entry, exactly like the registry watch.

## Tests

- `turma/tests/tunnel-directory.test.js` (own process; HA flipped per-test via `__setLiveStore`, never
  the env): non-HA inert (no store write, local `terminalOnline`, local-only poke); publish/retire
  writing + deleting the key and mirror; the handed-off owner-guard; freshness-gated `terminalOnline`
  via `serializeAgent`; the watch mirroring a peer's set/del + ignoring a malformed value; boot
  hydrate leaving watch-won keys alone; `pokeHost` local-vs-bus routing (fresh remote → bus, stale/
  self/absent → nothing); `makeControlBus` delivering only messages addressed to this replica.
- `turma/tests/server.test.js` (HA off) is the non-HA byte-identity guard and must stay green.
