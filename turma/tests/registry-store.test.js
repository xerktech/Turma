"use strict";

// XERK-756 — the fleet registry + per-host command queues move to the shared
// LiveStore in HA mode, so any replica ingests any beat and serves the whole
// fleet. A real Valkey can't run in CI, so these drive a FileLiveStore standing
// in as the shared store (one process, one store) and pin the seam:
//   - non-HA is inert (the store is never written — byte-identical state.json);
//   - HA writes ONE per-host record (caches stripped, commands kept);
//   - a queued command rides that record into the store;
//   - a removal deletes the host key;
//   - hydration rebuilds `agents` from the store with the state.json coercions;
//   - the watch mirrors a record another replica wrote WITHOUT echoing it back.
//
// Own process (registry caps + HA_ON are read/held at require time). TURMA_TEST
// exports the internals and skips the production listen.

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
// Make sure this process boots single-process; HA is flipped per-test via the
// __setLiveStore hook, never the env, so this file never dials a real store.
delete process.env.HA_MODE;
delete process.env.TURMA_STORE_URL;

const hub = require("../server.js");
const { FileLiveStore } = require("../store.js");

const PFX = hub.AGENT_STORE_PREFIX;

// Wipe the shared `agents` map + the injected store between tests so one case
// cannot leak a record into the next.
function reset(on) {
  for (const k of Object.keys(hub.agents)) delete hub.agents[k];
  const store = new FileLiveStore();
  hub.__setLiveStore(store, on);
  return store;
}

function record(over = {}) {
  return {
    device: "h1",
    agentId: "aid-1",
    lastSeen: Date.now(),
    commands: [],
    sessions: [],
    // An on-demand cache key (AGENT_CACHE_KEYS) — must NOT reach the store, the
    // same subset serializeAgentsForSave strips from state.json.
    history: { "sess-1": { entries: ["a", "b"], big: "x".repeat(1000) } },
    ...over,
  };
}

test("XERK-756: default boot is single-process — HA off, the store untouched", async () => {
  const store = reset(false);
  hub.agents.h1 = record();
  hub.publishAgent("h1");        // the write-through hook, no-op with HA off
  hub.markAgentDirty("h1");      // explicit — still a no-op
  hub.flushAgentsToStore();
  assert.equal(hub.__getHaOn(), false);
  assert.equal(await store.get(PFX + "h1"), null, "nothing written to the store off HA");
});

test("XERK-756: HA writes ONE per-host record, caches stripped, record kept", async () => {
  const store = reset(true);
  hub.agents.h1 = record();
  hub.publishAgent("h1");         // marks dirty
  hub.flushAgentsToStore();       // FileLiveStore.set resolves synchronously
  const stored = await store.get(PFX + "h1");
  assert.ok(stored, "the host record is in the store under its own key");
  assert.equal(stored.device, "h1");
  assert.ok(Array.isArray(stored.sessions));
  assert.equal(stored.history, undefined, "on-demand caches are stripped like state.json");
  // Exactly one key per host — the whole fleet is the prefix scan.
  const all = await store.scan(PFX);
  assert.deepEqual(all.map((r) => r.key), [PFX + "h1"]);
});

test("XERK-756: a queued command rides the host record into the store", async () => {
  const store = reset(true);
  hub.agents.h1 = record();
  const cmdId = hub.queueCommand("h1", { type: "kill", sessionId: "s9" });
  hub.flushAgentsToStore();
  const stored = await store.get(PFX + "h1");
  assert.ok(stored.commands.some((c) => c.cmdId === cmdId && c.type === "kill"),
    "the per-host command queue is carried in the record, not a separate list");
});

test("XERK-756: removing a host deletes its store key", async () => {
  const store = reset(true);
  hub.agents.h1 = record();
  hub.publishAgent("h1");
  hub.flushAgentsToStore();
  assert.ok(await store.get(PFX + "h1"), "present first");
  delete hub.agents.h1;
  hub.markAgentRemoved("h1");
  hub.flushAgentsToStore();
  assert.equal(await store.get(PFX + "h1"), null, "gone from the store after removal");
});

test("XERK-756: hydration rebuilds the fleet from the store with the restore coercions", async () => {
  const store = reset(true);
  // A good record, a non-object (a torn write), and one under an unusable key —
  // the last two must be dropped exactly as the state.json restore drops them.
  await store.set(PFX + "good", { device: "good", lastSeen: Date.now(), sessions: [], commands: [] });
  await store.set(PFX + "torn", null);
  await store.set(PFX + "bad", 42);
  await hub.hydrateAgentsFromStore();
  assert.ok(hub.agents.good, "a good record is restored");
  assert.equal(hub.agents.torn, undefined, "a non-object record is dropped");
  assert.equal(hub.agents.bad, undefined, "a non-object record is dropped");
  assert.ok(hub.recordBytes.get("good") > 0, "recordBytes is set on the restored record");
});

test("XERK-756: hydration stamps a restored, undelivered command delivered (XERK-303)", async () => {
  const store = reset(true);
  await store.set(PFX + "h1", {
    device: "h1", lastSeen: Date.now(), sessions: [],
    commands: [{ type: "spawn", cmdId: "c1" }], // no deliveredAt on disk
  });
  await hub.hydrateAgentsFromStore();
  const cmd = hub.agents.h1.commands.find((c) => c.cmdId === "c1");
  assert.ok(cmd && cmd.deliveredAt, "a restored command cannot be proven undelivered, so it is stamped delivered");
});

test("XERK-756: a write's own watch echo is DROPPED (not re-applied)", async () => {
  const store = reset(true);
  hub.installRegistryWatch();               // the writer also hears its own writes
  const ref = (hub.agents.h1 = record());   // record() carries a `history` cache
  hub.publishAgent("h1");
  hub.flushAgentsToStore();                 // FileLiveStore fires the watch inline
  // If the echo were applied, applyRemoteAgent would REPLACE agents.h1 with the
  // store's (cache-stripped, cache-remerged) clone — a different object. The drop
  // leaves the live object untouched. This is the assertion the echo-drop needs:
  // the cache-survival check alone passes even with the drop disabled, because
  // applyRemoteAgent re-merges the caches anyway (the mutation that escaped QA).
  assert.strictEqual(hub.agents.h1, ref, "the live record object is untouched (echo dropped)");
  assert.ok(hub.agents.h1.history, "so its on-demand cache is intact");
  const stored = await store.get(PFX + "h1");
  assert.equal(stored.history, undefined, "and the stored copy still has no cache");
});

test("XERK-756: boot trim drops locally but never deletes peer records from the shared store", async () => {
  // A replica whose AGENTS_MAX/byte budget is smaller than the durable fleet must
  // hydrate what it can and DECLINE the rest LOCALLY — never del them from the
  // shared store, or offline hosts vanish cluster-wide (the QA MEDIUM defect).
  const store = reset(true);
  const now = Date.now();
  const total = hub.AGENTS_MAX + 5;          // guarantee the count-cap trim bites
  for (let i = 0; i < total; i++) {
    const h = `h${String(i).padStart(3, "0")}`;
    await store.set(PFX + h, { device: h, lastSeen: now - i, sessions: [], commands: [] });
  }
  await hub.hydrateAgentsFromStore();
  // Drain any pending store writes the trim might have queued — the del is
  // debounced, so a check right after hydrate would miss a regression that
  // scheduled the peer-record deletions but had not yet flushed them.
  hub.flushAgentsToStore();
  // The trim held THIS replica's map to the budget...
  assert.ok(Object.keys(hub.agents).length <= hub.AGENTS_MAX, "local map is held to AGENTS_MAX");
  // ...but every durable record must still be in the shared store (no store del).
  const storeKeys = await store.scan(PFX);
  assert.equal(storeKeys.length, total,
    "every durable record survives in the shared store after a boot trim (no peer-record deletion)");
});

test("XERK-756: the watch mirrors another replica's record without echoing it back", async () => {
  const store = reset(true);
  hub.installRegistryWatch();
  // Another replica writes a record — the FileLiveStore fires the watch inline.
  await store.set(PFX + "remote1", { device: "remote1", lastSeen: Date.now(), sessions: [], commands: [] });
  assert.ok(hub.agents.remote1, "the watched record lands in this replica's fleet view");
  // It must NOT be re-written by us (it is owned by the other replica): flushing
  // our dirty set changes nothing about remote1's stored bytes.
  const before = JSON.stringify(await store.get(PFX + "remote1"));
  hub.flushAgentsToStore();
  assert.equal(JSON.stringify(await store.get(PFX + "remote1")), before, "no echo write");
  // A remote deletion is mirrored too.
  await store.del(PFX + "remote1");
  assert.equal(hub.agents.remote1, undefined, "a watched deletion is applied locally");
});
