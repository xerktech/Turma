---
paths:
  - turma/server.js
  - turma/relay.js
  - turma/tests/tunnel-directory.test.js
  - turma/tests/tunnel-relay.test.js
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
- **The duplex BYTE-STREAM relay TRANSPORT is now SHIPPED** (XERK-777, `turma/relay.js`) — the
  transport PRIMITIVE only. `/term`, the `/live` deltas and the `openChannel` data channel are the
  CONSUMERS, a follow-up (w2-relay-consumers): until they wire it, those bytes still serve from the
  tunnel owner's replica (the Option-2 leader-only-serving behaviour), so nothing regresses. See "The
  byte-stream relay transport" below.
- **NEVER push raw terminal / `/live` / ttyd bytes through `store.publish`/`subscribe`.** Bulk
  interactive traffic there would ride the SAME single shared subscriber connection the SSE bus
  (XERK-762) and the registry watch (XERK-756) depend on — head-of-line blocking the fleet's LIVENESS
  channel. The relay is a DEDICATED pod-to-pod transport for exactly this reason; the store carries
  only its byte-free endpoint directory.

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
  is kept extensible (`{type, target, …}`); the byte relay does NOT ride it (below).

## The byte-stream relay transport (XERK-777, `turma/relay.js`)

The duplex relay XERK-764 deferred, for the DATA plane `/term` / `/live` / `openChannel` bytes. It is
a DEDICATED pod-to-pod transport, NOT the control/SSE bus — see the "never through store pub/sub"
rule above. Rationale (recommended shape vs the rejected route-by-host-at-ingress) is in
`docs/turma-ha-store-adr.md` ("The cross-replica byte-stream relay transport").

- **`makeRelay(store, replicaId, deps)` is standalone + store/directory-injected**, exactly like
  `makeControlBus`/`makeSseBus`, so the routing + duplex bridging + lifecycle are unit-testable with a
  `FileLiveStore` and an in-process LOOPBACK PAIR — no live Valkey and no cluster. The deps inject the
  seams that are deployment-coupled or live in server.js: `owners` (the `hostTunnelOwners` mirror),
  `ttlMs`, `localTunnel` (`!!controlChannels[host]`, the ownership check), `openLocal` (`openChannel`,
  the local tunnel bridge, OWNER side only), `dial` (the raw pod-to-pod byte channel), and `endpoint`
  (this replica's dial address).
- **Shape: an in-hub pod-to-pod reverse-proxy.** The ORIGIN (the replica a client landed on) resolves
  the host's owner from `hostTunnelOwners` — SAME `local`/`self`/`stale`/`absent` gate as `pokeHost`,
  a fresh REMOTE owner is the only relay target — resolves that replica's dial address from the
  endpoint directory, and `dial`s a DIRECT duplex to it. The OWNER `accept`s it, verifies it STILL
  holds the tunnel (`localTunnel`), bridges to `openChannel`, and pipes both ways.
- **The endpoint DIRECTORY is the store's only job here, and it is byte-FREE**: `relayEndpoint:<id>`
  → `{addr, at}`, TTL'd + refreshed + watch-mirrored + boot-scanned, the exact `hostTunnelOwners`
  pattern. A stream byte NEVER touches the store.
- **Framing:** a tiny length-prefixed frame (`[type][u32 len][payload]`, NOT WS, NOT the store) —
  DATA (raw bytes), CTRL (JSON: the `{t:"open",host,port}` handshake, a reconnect hint, ping/pong),
  CLOSE. The declared length is capped (`frameMax`, the `wsParser`/XERK-357 memory discipline: a
  deframer over the cap goes DEAD, no unbounded `Buffer.concat`).
- **Duplex + backpressure-aware:** `_write` honours the conn's `drain`; inbound DATA pauses the conn
  when `push()` says the consumer is behind — so a slow peer pod can't buffer a whole terminal stream
  in the hub heap.
- **Clean close on all three failure modes, a reconnect HINT, never a hung socket:** owner HANDOFF
  (host reconnected elsewhere → `accept` refuses with `{t:"hint",reason:"not-owner"}`), TUNNEL DROP
  (`openLocal` rejects → `{reason:"tunnel-down"}`), REPLICA LOSS (`dial`/conn fails → `connect`
  rejects / the duplex closes). A teardown hint fully closes the origin duplex a tick later (the
  consumer has seen the hint); a bare CLOSE frame is a half-close (the reverse flow may still stream);
  a broken conn EOFs + destroys. Every teardown destroys WITHOUT an error arg (a re-thrown `error`
  with no consumer listener would crash the process — the `channelDuplex` rule).
- **Liveness:** a ping/idle loop over the pod-to-pod hop (mirrors the control channel) tears down a
  half-open conn rather than reporting it live forever.
- **Consumers are a follow-up (w2-relay-consumers).** server.js CONSTRUCTS the relay under HA (binding
  `owners`/`ttlMs`/`localTunnel`/`openLocal`) but does NOT `start()` it or wire `dial`/a listener/
  `endpoint` — so `connect`/`accept` are reachable by no client yet and no byte crosses replicas.

## Non-HA is byte-identical (the load-bearing invariant)

- With HA off, `hostTunnelOwners` stays empty and `controlBus`/`sseBus`/`relay` null: `publishHostTunnel`/
  `retireHostTunnel` early-return, `terminalOnline` is purely `controlChannels`, and `pokeHost` never
  leaves the process. Everything gates on `HA_ON` at its entry, exactly like the registry watch.

## Tests

- `turma/tests/tunnel-directory.test.js` (own process; HA flipped per-test via `__setLiveStore`, never
  the env): non-HA inert (no store write, local `terminalOnline`, local-only poke); publish/retire
  writing + deleting the key and mirror; the handed-off owner-guard; freshness-gated `terminalOnline`
  via `serializeAgent`; the watch mirroring a peer's set/del + ignoring a malformed value; boot
  hydrate leaving watch-won keys alone; `pokeHost` local-vs-bus routing (fresh remote → bus, stale/
  self/absent → nothing); `makeControlBus` delivering only messages addressed to this replica.
- `turma/tests/tunnel-relay.test.js` (own process; `FileLiveStore` + net loopback pairs, no
  cluster): the `remoteOwner` routing gate (local/self/absent/stale → no relay, fresh remote → dial);
  `connect` returning null with no dial when no remote owner; the end-to-end bridge (origin bytes →
  owner's `openLocal` → back); the three clean-close hints (handoff/tunnel-down/replica-loss) with no
  hung socket; a broken mid-stream conn EOFing the origin; large-payload framing + backpressure
  integrity; the framing codec (split chunks, overflow → dead); the handshake timeout; and the
  endpoint directory (publish/watch-mirror/hydrate/retire + `connect` resolving the peer addr).
- `turma/tests/server.test.js` (HA off) is the non-HA byte-identity guard and must stay green.
