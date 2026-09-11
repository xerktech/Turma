// XERK-758 — the shared (HA) usage-ledger backend: atomic per-host high-water
// max-merge writes into the LiveStore, boot scan, and watch-based peer fold.
//
// There is no live Valkey in CI (the same constraint store.test.js works under),
// so every case drives the REAL SharedLedgerBackend against the in-memory
// FileLiveStore — which is a real LiveStore implementation (async get/set/
// compareAndSet/setIfAbsent/del/scan/watch), so the backend's logic is exercised
// end-to-end; only the raw socket is host-QA-only.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { FileLiveStore } = require("../store.js");
const { SharedLedgerBackend, KEY_PREFIX } = require("../usage-ledger-shared.js");
const ledger = require("../usage-ledger.js");

// A "replica": one SharedLedgerBackend + its own in-memory model, sharing a store.
// It reuses the ledger's REAL reducers (coerce=entryOf, mergeEntry, enforceHostShare
// via `sharedOps`) but keeps a per-replica `hosts` map, so two replicas can hold
// different partial views the way real hub replicas do.
function replica(store) {
  const model = new Map();
  const base = ledger._internals.sharedOps();
  const ops = {
    ...base,
    getEntry: (k) => model.get(k) || null,
    setEntry: (k, e) => model.set(k, e),
    deleteEntry: (k) => model.delete(k),
  };
  const backend = new SharedLedgerBackend(store, ops, { debounceMs: 5 });
  return { model, ops, backend };
}

// Build a coerced ledger entry with one host-level day bucket of `input` tokens.
function entryWithDay(day, input, { device = "h", lastSeen = 1 } = {}) {
  const base = ledger._internals.sharedOps();
  return base.coerce({
    device,
    siteKey: "",
    firstSeen: 1,
    lastSeen,
    host: { days: { [day]: { input, output: 0, cacheWrite: 0, cacheRead: 0 } } },
    repos: {},
  });
}

function dayTokens(entry, day) {
  return entry && entry.host && entry.host.days[day] ? entry.host.days[day].input : null;
}

const DAY = "2026-09-11";

test("XERK-758: a dirty host is written to the store as its own key", async () => {
  const store = new FileLiveStore();
  const a = replica(store);
  a.model.set("h", entryWithDay(DAY, 100));
  await new Promise((r) => a.backend._flushDirty(() => r())); // nothing dirty yet -> noop path
  a.backend.onChange("h");
  await new Promise((r) => a.backend.flush(r));

  const row = await store.get(KEY_PREFIX + "h");
  assert.ok(row, "the host row is persisted under its own key");
  assert.equal(dayTokens(a.ops.coerce(row), DAY), 100);
  await a.backend.close();
});

test("XERK-758: a partial-view replica can NEVER lower a recorded total (max-merge)", async () => {
  const store = new FileLiveStore();
  // Replica A has the full day (100) and writes it.
  const a = replica(store);
  a.model.set("h", entryWithDay(DAY, 100, { lastSeen: 2 }));
  a.backend.onChange("h");
  await new Promise((r) => a.backend.flush(r));
  assert.equal(dayTokens(a.ops.coerce(await store.get(KEY_PREFIX + "h")), DAY), 100);

  // Replica B has a STALE partial view of the same day (only 40) — a low writer.
  const b = replica(store);
  b.model.set("h", entryWithDay(DAY, 40, { lastSeen: 1 }));
  b.backend.onChange("h");
  await new Promise((r) => b.backend.flush(r));

  // The store must still hold 100 — B's write max-merged, it did not clobber.
  assert.equal(
    dayTokens(b.ops.coerce(await store.get(KEY_PREFIX + "h")), DAY), 100,
    "a low writer's full-object write must not lower the stored high-water"
  );
  // And B's OWN local model has been RAISED to the store's mark (never lowered).
  assert.equal(dayTokens(b.model.get("h"), DAY), 100, "the local partial view is raised, not left low");
  await a.backend.close();
  await b.backend.close();
});

test("XERK-758: a higher partial view DOES raise the stored total", async () => {
  const store = new FileLiveStore();
  const a = replica(store);
  a.model.set("h", entryWithDay(DAY, 40));
  a.backend.onChange("h");
  await new Promise((r) => a.backend.flush(r));

  const b = replica(store);
  b.model.set("h", entryWithDay(DAY, 250, { lastSeen: 9 }));
  b.backend.onChange("h");
  await new Promise((r) => b.backend.flush(r));

  assert.equal(dayTokens(b.ops.coerce(await store.get(KEY_PREFIX + "h")), DAY), 250);
  await a.backend.close();
  await b.backend.close();
});

test("XERK-758: init() rebuilds the in-memory model from the store", async () => {
  const store = new FileLiveStore();
  // Seed the store as if a prior replica had written it.
  await store.set(KEY_PREFIX + "h1", entryWithDay(DAY, 111));
  await store.set(KEY_PREFIX + "h2", entryWithDay(DAY, 222, { device: "h2" }));

  const b = replica(store);
  await b.backend.init();
  assert.equal(dayTokens(b.model.get("h1"), DAY), 111);
  assert.equal(dayTokens(b.model.get("h2"), DAY), 222);
  await b.backend.close();
});

test("XERK-758: a peer's write is folded into a watching replica's model", async () => {
  const store = new FileLiveStore();
  const a = replica(store);
  const b = replica(store);
  await b.backend.init(); // b starts watching (FileLiveStore fires watchers synchronously)

  a.model.set("h", entryWithDay(DAY, 500, { lastSeen: 3 }));
  a.backend.onChange("h");
  await new Promise((r) => a.backend.flush(r));

  // b never ingested h, but its model now carries the peer's mark via `watch`.
  assert.equal(dayTokens(b.model.get("h"), DAY), 500, "the peer write reaches the standby's hot model");
  await a.backend.close();
  await b.backend.close();
});

test("XERK-758: forget() deletes the store row and propagates to watchers", async () => {
  const store = new FileLiveStore();
  const a = replica(store);
  const b = replica(store);
  await b.backend.init();

  a.model.set("h", entryWithDay(DAY, 70));
  a.backend.onChange("h");
  await new Promise((r) => a.backend.flush(r));
  assert.equal(dayTokens(b.model.get("h"), DAY), 70);

  a.model.delete("h");
  a.backend.onForget("h");
  // onForget writes immediately (serialised); give the microtask queue a turn.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await store.get(KEY_PREFIX + "h"), null, "the durable row is gone");
  assert.equal(b.model.has("h"), false, "the delete reaches the watching replica");
  await a.backend.close();
  await b.backend.close();
});

test("XERK-758: repo-level spend max-merges independently of the host total", async () => {
  const store = new FileLiveStore();
  const base = ledger._internals.sharedOps();
  const mk = (repoInput) =>
    base.coerce({
      device: "h", firstSeen: 1, lastSeen: 1, host: { days: {} },
      repos: { "git@x/r": { repo: "r", remote: "", series: { days: { [DAY]: { input: repoInput, output: 0, cacheWrite: 0, cacheRead: 0 } } } } },
    });

  const a = replica(store);
  a.model.set("h", mk(900));
  a.backend.onChange("h");
  await new Promise((r) => a.backend.flush(r));

  const b = replica(store);
  b.model.set("h", mk(300)); // partial
  b.backend.onChange("h");
  await new Promise((r) => b.backend.flush(r));

  const row = base.coerce(await store.get(KEY_PREFIX + "h"));
  assert.equal(row.repos["git@x/r"].series.days[DAY].input, 900, "repo day is high-water too");
  await a.backend.close();
  await b.backend.close();
});

test("XERK-758: configure() moves the real ledger onto the shared store end-to-end", async () => {
  const store = new FileLiveStore();
  ledger._internals.reset();
  try {
    await ledger.configure(store, { ha: true });
    // A real heartbeat record, ingested through the ledger's public path.
    ledger.ingest("hostA", {
      device: "hostA",
      usage: { totals: { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 },
               days: { [DAY]: { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 } } },
      repoUsage: [],
    });
    await new Promise((r) => ledger.flush(r));

    const row = await store.get(KEY_PREFIX + "hostA");
    assert.ok(row, "ingest through the configured ledger reaches the shared store");
    assert.equal(dayTokens(ledger._internals.sharedOps().coerce(row), DAY), 1000);
    // The served view still reads the hot local model synchronously.
    assert.equal(ledger.has("hostA"), true);
  } finally {
    ledger._internals.reset(); // restore the file backend for other suites
  }
});
