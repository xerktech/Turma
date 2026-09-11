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
function replica(store, cfg = {}) {
  const model = new Map();
  const base = ledger._internals.sharedOps();
  const ops = {
    ...base,
    getEntry: (k) => model.get(k) || null,
    setEntry: (k, e) => model.set(k, e),
    deleteEntry: (k) => model.delete(k),
  };
  const backend = new SharedLedgerBackend(store, ops, { debounceMs: 5, ...cfg });
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

// A store that mimics SharedLiveStore's boot lifecycle: NOT ready until its socket
// connects, and a `scan`/`get` issued while not-ready REJECTS ("store not
// connected"), exactly as SharedLiveStore._sendOn does. This is what FileLiveStore
// cannot reproduce (it is always "ready", synchronous) — the XERK-758 QA D1 gap.
class LazyStore {
  constructor() {
    this._health = "connecting";
    this.data = new Map();
    this._healthCbs = new Set();
    this._watchers = [];
  }
  get health() { return this._health; }
  onHealth(cb) { this._healthCbs.add(cb); return () => this._healthCbs.delete(cb); }
  becomeReady() { this._health = "ready"; for (const cb of [...this._healthCbs]) cb("ready"); }
  _assertReady() { if (this._health !== "ready") throw new Error("store not connected (closed)"); }
  async scan(prefix) {
    this._assertReady();
    const out = [];
    for (const [k, v] of this.data) if (k.startsWith(prefix)) out.push({ key: k, value: structuredClone(v) });
    return out;
  }
  async get(k) { this._assertReady(); return this.data.has(k) ? structuredClone(this.data.get(k)) : null; }
  async set(k, v) { this._assertReady(); this.data.set(k, structuredClone(v)); this._fire("set", k, v); }
  async setIfAbsent(k, v) { this._assertReady(); if (this.data.has(k)) return false; await this.set(k, v); return true; }
  async compareAndSet(k, exp, next) {
    this._assertReady();
    const cur = this.data.has(k) ? this.data.get(k) : null;
    if (JSON.stringify(cur) !== JSON.stringify(exp)) return false;
    await this.set(k, next);
    return true;
  }
  async del(k) { this._assertReady(); if (this.data.delete(k)) this._fire("del", k, null); }
  watch(prefix, cb) {
    const e = { prefix, cb };
    this._watchers.push(e);
    return () => { const i = this._watchers.indexOf(e); if (i >= 0) this._watchers.splice(i, 1); };
  }
  _fire(type, key, value) {
    for (const w of this._watchers) if (key.startsWith(w.prefix)) w.cb({ type, key, value: type === "del" ? null : structuredClone(value) });
  }
}

test("XERK-758 QA D1: boot scan runs on the READY edge, not synchronously in init", async () => {
  const store = new LazyStore();
  // A durable row a prior boot left in the store (e.g. a now-retired host).
  store.data.set(KEY_PREFIX + "retired", structuredClone(entryWithDay(DAY, 777)));

  const b = replica(store);
  await b.backend.init(); // store is NOT ready yet — must NOT throw, must NOT scan
  assert.equal(b.model.has("retired"), false, "init must not scan a not-ready store (it would reject)");

  store.becomeReady(); // the socket connects -> health->ready edge fires the scan
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    dayTokens(b.model.get("retired"), DAY), 777,
    "the retired host's durable row loads once the store is ready — without this it vanishes from retiredUsage"
  );
  await b.backend.close();
});

test("XERK-758 QA D1: a reconnect (a second ready edge) re-scans and catches up", async () => {
  const store = new LazyStore();
  const b = replica(store);
  await b.backend.init();
  store.becomeReady();
  await new Promise((r) => setTimeout(r, 5)); // first scan: empty

  // A peer writes a row while this replica is "disconnected" (health flaps down/up).
  store.data.set(KEY_PREFIX + "late", structuredClone(entryWithDay(DAY, 321)));
  store._health = "reconnecting";
  store.becomeReady(); // reconnect edge -> re-scan catches up the row written meanwhile
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(dayTokens(b.model.get("late"), DAY), 321, "a reconnect re-scan catches up rows written while disconnected");
  await b.backend.close();
});

test("XERK-758 QA D1b: a reconnect scan load INVALIDATES the served cache", async () => {
  // The scan raising the model with no local beat must fire onExternalChange, or
  // /api/agents keeps serving a stale retiredUsage until an unrelated mutation.
  const store = new LazyStore();
  store.data.set(KEY_PREFIX + "r", structuredClone(entryWithDay(DAY, 88)));
  let invalidations = 0;
  const b = replica(store, { onExternalChange: () => { invalidations += 1; } });
  await b.backend.init(); // not ready -> no scan, no invalidation
  assert.equal(invalidations, 0);

  store.becomeReady();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(dayTokens(b.model.get("r"), DAY), 88);
  assert.ok(invalidations >= 1, "loading rows on the ready edge must invalidate the served cache");
  await b.backend.close();
});

test("XERK-758 QA D1b: a peer's watch-folded write invalidates the served cache", async () => {
  const store = new FileLiveStore();
  const writer = replica(store);
  let invalidations = 0;
  const reader = replica(store, { onExternalChange: () => { invalidations += 1; } });
  await reader.backend.init(); // reader starts watching

  writer.model.set("h", entryWithDay(DAY, 600, { lastSeen: 4 }));
  writer.backend.onChange("h");
  await new Promise((r) => writer.backend.flush(r));

  assert.equal(dayTokens(reader.model.get("h"), DAY), 600, "peer write folded into the reader's model");
  assert.ok(invalidations >= 1, "a peer's fold must invalidate the reader's served cache");
  await writer.backend.close();
  await reader.backend.close();
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
