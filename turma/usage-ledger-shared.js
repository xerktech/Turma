// The HA persistence backend for the usage ledger (XERK-758, epic XERK-751).
//
// The usage ledger is "the only copy of a year of spend", kept as a per-UTC-day,
// per-host HIGH-WATER model (usage-ledger.js). Its SINGLE-PROCESS backend rewrites
// the whole `/data/usage-ledger.json` file on every save. With the hub running as
// multiple active-active replicas (XERK-751), each replica holds only a PARTIAL
// in-memory copy — the beats IT received — so a full-object rewrite from any one
// replica would CLOBBER history: a replica that has seen less would lower a total
// another replica already recorded. That is the exact failure this backend closes.
//
// The fix is the ticket's own words: fold each host's recorded history into the
// shared store via an ATOMIC, per-host HIGH-WATER (max-merge) write, using the
// store's own CAS op (XERK-754's `LiveStore.compareAndSet`). Because the merge is
// a per-key MAXIMUM — never a replace — it is commutative and idempotent, so:
//   - a replica with a PARTIAL view can never lower a recorded total (it max-merges
//     the store's value INTO its own before writing back, so what it writes is
//     >= what was there);
//   - two replicas racing the same host converge (the CAS loser re-reads the
//     winner's higher marks and re-applies max), with no lock and no lost update.
//
// This is the LiveStore expression of the ADR's high-water rule
// (docs/turma-ha-store-adr.md, "Why the ledger's high-water lives in Postgres":
// `GREATEST(existing, incoming)`). See that file and .claude/rules/turma-usage.md
// for the DELIBERATE DIVERGENCE from the ADR here — the ADR names Postgres as the
// ledger of-record, but only the Valkey LiveStore backend exists today (no stdlib
// Postgres client), and the ticket asks for "the store's CAS/atomic ops chosen in
// the spike", which is exactly this. The write path is backend-agnostic: a future
// Postgres `LedgerStore` implementing the same per-host max-merge slots in behind
// `configure()` with no call-site change.
//
// READ MODEL. The served views (`fold`, `retiredAgents`, `has`) read the SAME
// in-memory `hosts` model the single-process ledger does, SYNCHRONOUSLY and
// unchanged — a shared store could never hand back a live object on the hot serve
// path. This backend keeps that model HOT: its own writes raise it, and a `watch`
// subscription folds in the writes of OTHER replicas (the warm-standby design in
// the ADR, "Why watch + pub/sub are in the contract"). So on the leader — which
// receives every beat and serves `/api/agents` (Option 2, leader-only) — the model
// is complete; a standby stays promotable without a cold rebuild.

"use strict";

// One store key per host entry: `usage:host:<ledgerKey>`. The ledger key is the
// hub's registry key (host-proved, XERK-268), which is what the file backend keys
// `hosts` on too, so a host is one row here and one entry there.
const KEY_PREFIX = "usage:host:";

// How many times a per-host CAS write re-reads and re-applies the max-merge before
// giving up for this cycle. Contention is near-zero under Option 2 (leader-only
// writes) and low even under Option 3 (only the same host's concurrent beats touch
// one key), so a small bound is ample; a give-up is retried on the next dirty flush
// (the write is a durable of-record, but a beat that only re-states costs nothing).
const CAS_RETRIES = 8;

class SharedLedgerBackend {
  /**
   * @param {object} store  a LiveStore (store.js) — async get/set/compareAndSet/
   *   setIfAbsent/del/scan/watch.
   * @param {object} ops    the ledger's own internals (from usage-ledger.js's
   *   `sharedOps()`): the in-memory model accessors + the pure high-water reducers,
   *   passed in to avoid a require cycle and to mutate the SAME `hosts` object the
   *   read path serves.
   * @param {object} [cfg]  { debounceMs }
   */
  constructor(store, ops, cfg = {}) {
    this.store = store;
    this.ops = ops;
    this.debounceMs = cfg.debounceMs || ops.SAVE_DEBOUNCE_MS || 5000;
    this._dirty = new Set(); // host keys changed since the last flush
    this._timer = null;
    this._closed = false;
    this._unwatch = null;
    // A per-key promise chain so two flushes never race the same host's CAS (a
    // second CAS reading the value the first is mid-writing would livelock the
    // retry). Serialises writes per host WITHIN this replica; cross-replica races
    // are still handled by the CAS itself.
    this._writing = new Map(); // key -> Promise
  }

  storeKey(key) {
    return KEY_PREFIX + key;
  }

  keyOf(storeKey) {
    return storeKey.slice(KEY_PREFIX.length);
  }

  // Boot: load every host row from the store into the in-memory model, then watch
  // for peer writes. Awaited before the hub serves, so the first `/api/agents` is
  // already whole (not an empty beat while the scan runs).
  async init() {
    let rows = [];
    try {
      rows = await this.store.scan(KEY_PREFIX);
    } catch (e) {
      // A store down at boot must not crash the hub (availability) — start with an
      // empty model and let `watch` + the next beats refill it as the store returns.
      console.error(`usage ledger: shared-store scan failed at boot: ${(e && e.message) || e}`);
      rows = [];
    }
    let kept = 0;
    for (const { key, value } of rows) {
      const entry = this.ops.coerce(value); // JSON -> coerced entry, or null
      if (!entry) continue;
      this.ops.setEntry(this.keyOf(key), entry);
      kept += 1;
    }
    if (kept) console.log(`loaded usage history for ${kept} host(s) from the shared store`);
    // Fold in peer writes. Best-effort (the store's watch is a cache-warming hint,
    // not a correctness guarantee — this replica's own reads/writes are the floor).
    try {
      this._unwatch = this.store.watch(KEY_PREFIX, (ev) => this._onPeerEvent(ev));
    } catch (e) {
      console.error(`usage ledger: shared-store watch failed: ${(e && e.message) || e}`);
    }
  }

  // A write from ANOTHER replica (or this one — a self-event is harmless, it folds
  // in values already present). Raise the local model by the peer's high-water; a
  // delete forgets the host here too (a `forget` on any replica is authoritative).
  _onPeerEvent(ev) {
    if (!ev || typeof ev.key !== "string") return;
    const key = this.keyOf(ev.key);
    if (!key) return;
    if (ev.type === "del") {
      this.ops.deleteEntry(key);
      return;
    }
    const peer = this.ops.coerce(ev.value);
    if (!peer) return;
    const local = this.ops.getEntry(key);
    if (local) this.ops.mergeEntry(local, peer); // raise local by the peer's marks
    else this.ops.setEntry(key, peer);
  }

  // The ledger changed host `key` this beat. Mark it dirty and arm the debounce —
  // the same "a beat that only re-states rides a slow timer" discipline the file
  // backend uses, except a max-merge write is per-host and idempotent, so there is
  // no separate snapshot cadence: a re-stating beat that changed nothing structural
  // still schedules a cheap CAS that no-ops against an equal stored value.
  onChange(key /* , prompt */) {
    if (this._closed) return;
    this._dirty.add(key);
    this._arm();
  }

  onForget(key) {
    if (this._closed) return;
    // Durable delete is immediate — forgetting a host is an operator action, not a
    // debounced re-state — and it must beat any in-flight dirty write for the key.
    this._dirty.delete(key);
    this._serialize(key, async () => {
      try {
        await this.store.del(this.storeKey(key));
      } catch (e) {
        console.error(`usage ledger: shared-store forget of a host failed: ${(e && e.message) || e}`);
      }
    });
  }

  _arm() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flushDirty();
    }, this.debounceMs);
    this._timer.unref?.();
  }

  _flushDirty(done) {
    const keys = [...this._dirty];
    this._dirty.clear();
    const writes = keys.map((key) => this._serialize(key, () => this._persistHost(key)));
    if (!done) return;
    Promise.allSettled(writes).then(() => done(null), () => done(null));
  }

  // Serialise writes to one host key within this replica (see `_writing`).
  _serialize(key, fn) {
    const prev = this._writing.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).catch(() => {});
    this._writing.set(key, next);
    next.finally(() => {
      if (this._writing.get(key) === next) this._writing.delete(key);
    });
    return next;
  }

  // The atomic per-host HIGH-WATER write. Read the store's current row, RAISE THE
  // LOCAL entry in place by it (so the value written is >= both the local partial
  // view AND whatever any other replica has recorded), then CAS the local entry in.
  // A lost CAS means a concurrent writer landed a higher mark; re-read and re-raise.
  async _persistHost(key) {
    const entry = this.ops.getEntry(key);
    if (!entry) return; // forgotten between the mark and the flush
    // Bound this host's bytes exactly as the file backend does before a save — the
    // store's whole-value ceiling is per-KEY here, so each host must fit its share.
    try {
      this.ops.enforceHostShare(key, entry);
    } catch {
      /* enforceHostShare never throws in practice; guard the timer-adjacent path */
    }
    const skey = this.storeKey(key);
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      let cur;
      try {
        cur = await this.store.get(skey);
      } catch (e) {
        console.error(`usage ledger: shared-store read failed for a host: ${(e && e.message) || e}`);
        return; // retried on the next dirty flush
      }
      // Raise the LIVE local entry by the stored high-water. In place: the local
      // model is what the serve path reads, and raising it can only ever add spend
      // the store already knew, never lower a served number. If a beat mutated
      // `entry` further between our get and CAS, that delta is still in `entry` and
      // is written too (nothing is dropped).
      if (cur != null) {
        const stored = this.ops.coerce(cur);
        if (stored) this.ops.mergeEntry(entry, stored);
      }
      let ok;
      try {
        ok =
          cur == null
            ? await this.store.setIfAbsent(skey, entry)
            : await this.store.compareAndSet(skey, cur, entry);
      } catch (e) {
        console.error(`usage ledger: shared-store write failed for a host: ${(e && e.message) || e}`);
        return; // retried on the next dirty flush
      }
      if (ok) return;
      // Lost the race (a concurrent set, or the absent key filled): loop to re-read
      // and re-max-merge. Bounded by CAS_RETRIES; a give-up is picked up next flush.
    }
  }

  // Flush every pending durable write now — the graceful-shutdown drain path
  // (server.js). Cancels the debounce, writes all dirty hosts, then calls `done`.
  flush(done) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._flushDirty(done || (() => {}));
  }

  async close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._unwatch) {
      try {
        this._unwatch();
      } catch {
        /* best effort */
      }
      this._unwatch = null;
    }
  }
}

module.exports = { SharedLedgerBackend, KEY_PREFIX, CAS_RETRIES };
