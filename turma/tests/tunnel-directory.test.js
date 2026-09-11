"use strict";

// XERK-764 — route the agent tunnel/terminal/command CONTROL plane across HA
// replicas. Each agent holds ONE reverse-tunnel control channel to ONE replica,
// so under active-active a dashboard read of `terminalOnline`, or a queued
// command's poke, can land on a replica that does NOT hold that host's tunnel.
// The owning replica publishes a host->replica DIRECTORY entry to the shared
// store; every replica keeps a hot in-memory MIRROR via a watch, so the
// synchronous request path stays synchronous. These drive a FileLiveStore
// standing in as the shared store (no live Valkey in CI, same constraint as
// registry-store.test.js) and pin:
//   - non-HA is inert (directory writes are no-ops; terminalOnline is purely
//     controlChannels; pokeHost never leaves the process — byte-identical);
//   - publish/retire write and delete the directory key (TTL'd) + the local mirror;
//     retire's owner-guard leaves a handed-off entry alone;
//   - terminalOnline (via serializeAgent) is true for a fresh REMOTE owner and
//     false for a stale one;
//   - the watch mirrors a peer's set/del and ignores a malformed value;
//   - hydrate loads the directory at boot, leaving watch-won keys alone;
//   - pokeHost pokes a LOCAL channel directly (no bus) and routes a REMOTE fresh
//     owner over the control bus (never for a stale/self/absent owner);
//   - makeControlBus delivers a poke addressed to THIS replica and ignores others.
//
// Own process (registry caps + HA_ON are read/held at require time). TURMA_TEST
// exports the internals and skips the production listen.

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
// Boot single-process; HA is flipped per-test via __setLiveStore, never the env,
// so this file never dials a real store.
delete process.env.HA_MODE;
delete process.env.TURMA_STORE_URL;

const hub = require("../server.js");
const { FileLiveStore } = require("../store.js");

const PFX = hub.HOST_REPLICA_PREFIX;
const ME = hub.SSE_REPLICA_ID;
const TTL = 90 * 1000; // Math.max(CONTROL_DEAD_AFTER_MS 90s, PING 30s * 3) at defaults

// Wipe the mirror, controlChannels and the injected store between tests so one
// case cannot leak state into the next.
function reset(on) {
  for (const k of Object.keys(hub.hostTunnelOwners)) delete hub.hostTunnelOwners[k];
  for (const k of Object.keys(hub.controlChannels)) delete hub.controlChannels[k];
  for (const k of Object.keys(hub.agents)) delete hub.agents[k];
  const store = new FileLiveStore();
  hub.__setLiveStore(store, on);
  hub.__setControlBus(null);
  return store;
}

function agentRecord(over = {}) {
  return { device: "h1", lastSeen: Date.now(), commands: [], sessions: [], ...over };
}

test("XERK-764: non-HA is inert — no directory write, terminalOnline is local, poke stays local", async () => {
  const store = reset(false);
  hub.publishHostTunnel("h1");
  hub.retireHostTunnel("h1");
  assert.equal(hub.__getHaOn(), false);
  assert.equal((await store.scan(PFX)).length, 0, "store untouched with HA off");
  assert.equal(Object.keys(hub.hostTunnelOwners).length, 0, "mirror untouched with HA off");

  // terminalOnline is purely controlChannels off-HA.
  const now = Date.now();
  assert.equal(hub.serializeAgent("h1", agentRecord(), now).terminalOnline, false);
  hub.controlChannels.h1 = { sendPoke() {} };
  assert.equal(hub.serializeAgent("h1", agentRecord(), now).terminalOnline, true);

  // pokeHost with a local channel pokes directly; with none it does nothing (no bus).
  let localPokes = 0;
  hub.controlChannels.h1 = { sendPoke() { localPokes += 1; } };
  hub.pokeHost("h1");
  assert.equal(localPokes, 1);
  delete hub.controlChannels.h1;
  hub.pokeHost("h1"); // no channel, HA off -> nothing, no throw
  assert.equal(localPokes, 1);
});

test("XERK-764: publishHostTunnel writes the directory key (TTL'd) + the mirror; retire deletes both", async () => {
  const store = reset(true);
  hub.publishHostTunnel("h1");
  const rec = await store.get(PFX + "h1");
  assert.ok(rec && rec.replica === ME && typeof rec.at === "number", "directory key written for this replica");
  assert.equal(hub.hostTunnelOwners.h1.replica, ME, "local mirror set synchronously");

  hub.retireHostTunnel("h1");
  assert.equal(await store.get(PFX + "h1"), null, "directory key deleted on retire");
  assert.equal("h1" in hub.hostTunnelOwners, false, "mirror cleared on retire");
});

test("XERK-764: retire's owner-guard leaves a HANDED-OFF entry (owned by another replica) alone", async () => {
  const store = reset(true);
  hub.watchTunnelDirectory();
  // The host reconnected to replica 'other' before our stale drop ran: the mirror
  // (kept by the watch) now shows 'other' owns the key. Our retire must NOT del it.
  await store.set(PFX + "h1", { replica: "other", at: Date.now() }, { ttlMs: TTL });
  assert.equal(hub.hostTunnelOwners.h1.replica, "other", "watch mirrored the peer's set");
  hub.retireHostTunnel("h1");
  const rec = await store.get(PFX + "h1");
  assert.ok(rec && rec.replica === "other", "peer's directory entry left intact");
  assert.equal(hub.hostTunnelOwners.h1.replica, "other", "peer's mirror entry left intact");
});

test("XERK-764: terminalOnline is true for a fresh REMOTE owner, false for a stale one", () => {
  reset(true);
  const now = Date.now();
  // No local channel, no mirror -> offline.
  assert.equal(hub.serializeAgent("h1", agentRecord(), now).terminalOnline, false);
  // A fresh entry owned by ANOTHER replica -> terminal-online fleet-wide.
  hub.hostTunnelOwners.h1 = { replica: "other", at: now };
  assert.equal(hub.serializeAgent("h1", agentRecord(), now).terminalOnline, true);
  assert.equal(hub.hostTunnelOwnerLive("h1"), true);
  // A stale entry (owner crashed, del/TTL not yet seen) reads as offline.
  hub.hostTunnelOwners.h1 = { replica: "other", at: now - TTL - 1 };
  assert.equal(hub.hostTunnelOwnerLive("h1"), false);
  assert.equal(hub.serializeAgent("h1", agentRecord(), now).terminalOnline, false);
  // A LOCAL channel wins regardless of the mirror.
  hub.controlChannels.h1 = { sendPoke() {} };
  assert.equal(hub.serializeAgent("h1", agentRecord(), now).terminalOnline, true);
});

test("XERK-764: the watch mirrors a peer's set/del and ignores a malformed value", async () => {
  const store = reset(true);
  hub.watchTunnelDirectory();
  await store.set(PFX + "h2", { replica: "peerX", at: Date.now() }, { ttlMs: TTL });
  assert.equal(hub.hostTunnelOwners.h2.replica, "peerX", "peer set mirrored");
  await store.del(PFX + "h2");
  assert.equal("h2" in hub.hostTunnelOwners, false, "peer del clears the mirror");
  // A shape from a hostile/foreign publisher is ignored (never trust the bus).
  await store.set(PFX + "h3", { replica: 42 }, { ttlMs: TTL });
  assert.equal("h3" in hub.hostTunnelOwners, false, "malformed value ignored");
});

test("XERK-764: hydrate loads the directory at boot, leaving watch-won keys alone", async () => {
  const store = reset(true);
  await store.set(PFX + "a", { replica: "r1", at: Date.now() }, { ttlMs: TTL });
  await store.set(PFX + "b", { replica: "r2", at: Date.now() }, { ttlMs: TTL });
  // A key a concurrent watch already populated with a FRESHER value is left alone.
  hub.hostTunnelOwners.a = { replica: "fresher", at: Date.now() };
  await hub.hydrateTunnelDirectory();
  assert.equal(hub.hostTunnelOwners.a.replica, "fresher", "watch-won key not overwritten by scan");
  assert.equal(hub.hostTunnelOwners.b.replica, "r2", "scanned key loaded");
});

test("XERK-764: sweepTunnelDirectory reclaims stale mirror entries, keeps fresh ones", () => {
  reset(true);
  const now = Date.now();
  // A crashed owner whose retire del never ran (and, on Valkey, whose TTL expiry
  // fires no watch event) leaves a stale mirror entry that the freshness gate reads
  // offline but nothing removes. The sweep reclaims it; a live owner (refreshed by
  // its ping-set within the TTL) is kept.
  hub.hostTunnelOwners.dead = { replica: "gone", at: now - TTL - 1 };
  hub.hostTunnelOwners.live = { replica: "here", at: now };
  hub.sweepTunnelDirectory();
  assert.equal("dead" in hub.hostTunnelOwners, false, "stale entry reclaimed");
  assert.equal(hub.hostTunnelOwners.live.replica, "here", "fresh entry kept");
});

test("XERK-764: pokeHost pokes a LOCAL channel directly and never touches the bus", () => {
  reset(true);
  let localPokes = 0;
  const published = [];
  hub.__setControlBus({ publish: (m) => published.push(m) });
  hub.controlChannels.h1 = { sendPoke() { localPokes += 1; } };
  hub.hostTunnelOwners.h1 = { replica: "other", at: Date.now() }; // even with a mirror entry
  hub.pokeHost("h1");
  assert.equal(localPokes, 1, "local channel poked directly");
  assert.equal(published.length, 0, "bus untouched when the tunnel is local");
});

test("XERK-764: pokeHost routes a REMOTE fresh owner over the control bus; never a stale/self/absent one", () => {
  reset(true);
  const published = [];
  hub.__setControlBus({ publish: (m) => published.push(m) });
  const now = Date.now();

  // A fresh REMOTE owner -> one addressed poke on the bus.
  hub.hostTunnelOwners.h1 = { replica: "owner-B", at: now };
  hub.pokeHost("h1");
  assert.deepEqual(published, [{ type: "poke", target: "owner-B", host: "h1" }]);

  // A STALE owner -> no poke (the tunnel is presumed dead).
  published.length = 0;
  hub.hostTunnelOwners.h1 = { replica: "owner-B", at: now - TTL - 1 };
  hub.pokeHost("h1");
  assert.equal(published.length, 0, "stale owner not poked");

  // The owner is OURSELF but we hold no local channel (a torn-down tunnel whose
  // directory del is still in flight) -> no self-addressed bus poke.
  published.length = 0;
  hub.hostTunnelOwners.h1 = { replica: ME, at: now };
  hub.pokeHost("h1");
  assert.equal(published.length, 0, "self-owner never bus-poked");

  // No owner at all -> nothing.
  published.length = 0;
  delete hub.hostTunnelOwners.h1;
  hub.pokeHost("h1");
  assert.equal(published.length, 0, "absent owner not poked");
});

test("XERK-764: makeControlBus pokes a LOCAL channel for a message addressed to THIS replica, ignores others", async () => {
  const store = reset(true);
  const bus = hub.makeControlBus(store, ME);
  let pokes = 0;
  hub.controlChannels.h1 = { sendPoke() { pokes += 1; } };

  // A message addressed to another replica is ignored.
  await store.publish(hub.CONTROL_BUS_CHANNEL, { origin: "x", target: "someone-else", type: "poke", host: "h1" });
  assert.equal(pokes, 0, "message for another replica ignored");

  // Addressed to us with a local channel -> poke.
  await store.publish(hub.CONTROL_BUS_CHANNEL, { origin: "x", target: ME, type: "poke", host: "h1" });
  assert.equal(pokes, 1, "poke delivered to our local channel");

  // Addressed to us but no local channel for that host -> no throw, no poke.
  await store.publish(hub.CONTROL_BUS_CHANNEL, { origin: "x", target: ME, type: "poke", host: "nope" });
  assert.equal(pokes, 1);

  // Malformed / unknown type -> ignored.
  await store.publish(hub.CONTROL_BUS_CHANNEL, { target: ME, type: "unknown", host: "h1" });
  await store.publish(hub.CONTROL_BUS_CHANNEL, null);
  assert.equal(pokes, 1, "malformed / unknown-type messages ignored");

  // publish() from the bus wrapper carries the origin stamp.
  const seen = [];
  store.subscribe(hub.CONTROL_BUS_CHANNEL, (m) => seen.push(m));
  bus.publish({ type: "poke", target: "z", host: "h9" });
  assert.deepEqual(seen, [{ origin: ME, type: "poke", target: "z", host: "h9" }]);
});
