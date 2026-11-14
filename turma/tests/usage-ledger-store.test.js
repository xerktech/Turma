// XERK-779 — the Postgres of-record backend for the usage ledger (LedgerStore):
// the atomic per-host/series/day/token-key GREATEST upsert, full-fidelity round-trip
// (per-repo + per-model + pre + sub-agent survive a cold rescan), no-lower-a-total
// under a partial writer, concurrent-writer convergence, boot rehydrate, forget, and
// `configure()` end-to-end through the real ledger.
//
// There is no live Postgres in CI (the same constraint pgclient.test.js's socket path
// works under). So every case drives the REAL LedgerStore against an in-memory FAKE
// PgPool that faithfully implements the SQL the store emits — the four CREATE TABLEs,
// the multi-row INSERT … ON CONFLICT … DO UPDATE SET (GREATEST / COALESCE-nonempty /
// LEAST-nonzero per the store's own clauses), the SELECTs, and the two DELETEs. The
// store's LOGIC is exercised end-to-end; only the raw wire is host-QA-only. Values are
// held as text|null exactly like pgclient's text protocol, so a number/null bug shows.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { LedgerStore } = require("../usage-ledger-store.js");
const ledger = require("../usage-ledger.js");

// ---- the in-memory fake PgPool ---------------------------------------------

// One statement's worth of understanding. The store emits a small, known set of
// statements; the fake recognises them structurally (never a general SQL parser).
class FakePgPool {
  constructor() {
    this.kind = "postgres";
    this.tables = new Map(); // name -> Map(pkString -> rowObject{col:text|null})
    this._onHealth = [];
    this.queries = 0;
  }
  get health() { return "ready"; }
  onHealth(cb) { this._onHealth.push(cb); return () => {}; }
  ready() { return Promise.resolve(); }
  close() {}

  _table(name) {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }
  // text|null, mimicking the wire.
  static _wire(v) { return v == null ? null : String(v); }
  static _num(v) { return v == null ? 0 : Number(v) || 0; }
  static _coalesceNonEmpty(nv, ov) { return nv != null && nv !== "" ? nv : ov; }
  static _leastNonzero(ov, nv) {
    const nz = (x) => (x == null || Number(x) === 0 ? null : Number(x));
    const a = nz(ov), b = nz(nv);
    const r = a == null ? b : b == null ? a : Math.min(a, b);
    return r == null ? null : String(r);
  }
  static _maxStr(a, b) { if (a == null) return b; if (b == null) return a; return a >= b ? a : b; }

  query(text, params = []) {
    this.queries += 1;
    const sql = text.replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE IF NOT EXISTS/i.test(sql)) return Promise.resolve([]);

    let m = /^INSERT INTO "(\w+)" \(([^)]*)\) VALUES (.*) ON CONFLICT \(([^)]*)\) DO UPDATE SET /i.exec(sql);
    if (m) return Promise.resolve(this._insert(m[1], m[2], m[4], params));

    m = /^SELECT .* FROM "(\w+)"$/i.exec(sql);
    if (m) return Promise.resolve([...this._table(m[1]).values()].map((r) => ({ ...r })));

    m = /^DELETE FROM "(\w+)" WHERE host = \$1 AND series = \$2 AND day <= \$3/i.exec(sql);
    if (m) return Promise.resolve(this._deleteStaleDays(m[1], params));

    m = /^DELETE FROM "(\w+)" WHERE host = \$1$/i.exec(sql);
    if (m) return Promise.resolve(this._deleteHost(m[1], params));

    throw new Error(`FakePgPool: unrecognised SQL: ${sql}`);
  }

  _insert(table, colsRaw, conflictRaw, params) {
    const cols = colsRaw.split(",").map((s) => s.trim().replace(/"/g, ""));
    const conflict = conflictRaw.split(",").map((s) => s.trim().replace(/"/g, ""));
    const t = this._table(table);
    for (let i = 0; i < params.length; i += cols.length) {
      const nv = {};
      for (let c = 0; c < cols.length; c++) nv[cols[c]] = FakePgPool._wire(params[i + c]);
      const pk = conflict.map((c) => nv[c]).join("\x00");
      const ov = t.get(pk);
      t.set(pk, ov ? this._merge(table, ov, nv) : nv);
    }
    return [];
  }
  _merge(table, ov, nv) {
    const C = FakePgPool;
    if (table === "usage_host") {
      return {
        host: ov.host,
        device: C._coalesceNonEmpty(nv.device, ov.device),
        site_key: C._coalesceNonEmpty(nv.site_key, ov.site_key),
        first_seen: C._leastNonzero(ov.first_seen, nv.first_seen),
        last_seen: String(Math.max(C._num(ov.last_seen), C._num(nv.last_seen))),
      };
    }
    if (table === "usage_series") {
      return {
        host: ov.host, series: ov.series,
        repo: C._coalesceNonEmpty(nv.repo, ov.repo),
        remote: C._coalesceNonEmpty(nv.remote, ov.remote),
        cutoff: C._maxStr(ov.cutoff, nv.cutoff),
        sessions: String(Math.max(C._num(ov.sessions), C._num(nv.sessions))),
        last_activity: C._maxStr(ov.last_activity, nv.last_activity),
      };
    }
    // usage_day / usage_model: tokens = GREATEST.
    return { ...ov, tokens: String(Math.max(C._num(ov.tokens), C._num(nv.tokens))) };
  }
  _deleteStaleDays(table, params) {
    const [host, series, cutoff] = params.map(FakePgPool._wire);
    const t = this._table(table);
    for (const [pk, r] of [...t]) {
      if (r.host === host && r.series === series && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && r.day <= cutoff) t.delete(pk);
    }
    return [];
  }
  _deleteHost(table, params) {
    const host = FakePgPool._wire(params[0]);
    const t = this._table(table);
    for (const [pk, r] of [...t]) if (r.host === host) t.delete(pk);
    return [];
  }
}

// ---- a "replica": the REAL LedgerStore over a per-replica in-memory model ----
// Reuses the ledger's REAL reducers (coerce=entryOf, mergeEntry, enforceHostShare,
// TOKEN_KEYS, isoDay via `sharedOps`) but keeps a per-replica `hosts` map, so two
// replicas hold different partial views the way real hub replicas do.
function replica(pool, cfg = {}) {
  const model = new Map();
  const base = ledger._internals.sharedOps();
  const ops = {
    ...base,
    getEntry: (k) => model.get(k) || null,
    setEntry: (k, e) => model.set(k, e),
    deleteEntry: (k) => model.delete(k),
  };
  const backend = new LedgerStore(pool, ops, { debounceMs: 5, ...cfg });
  return { model, ops, backend };
}
async function ready(r) { await r.backend.init(); await r.backend.rescan(); }
function flush(r) { return new Promise((res) => r.backend.flush(res)); }

const base = () => ledger._internals.sharedOps();
const bTok = ledger._internals.bucketTokens;
const sTot = ledger._internals.seriesTotals;
function bucket(input = 0, output = 0, cacheWrite = 0, cacheRead = 0) {
  return { input, output, cacheWrite, cacheRead };
}

// ---- cases -----------------------------------------------------------------

test("XERK-779: HA off — configure is a no-op, the file backend stays", async () => {
  ledger._internals.reset();
  const pool = new FakePgPool();
  await ledger.configure({ ha: false }, pool, () => {});
  assert.equal(typeof ledger._internals.getBackend().rescan, "undefined",
    "the file backend has no rescan — the Postgres LedgerStore was not swapped in");
  assert.equal(pool.queries, 0, "HA off dials nothing");
  ledger._internals.reset();
});

test("XERK-779: HA on but no Postgres client — stays on the file backend (degraded, not fatal)", async () => {
  ledger._internals.reset();
  await ledger.configure({ ha: true }, null, () => {});
  assert.equal(typeof ledger._internals.getBackend().rescan, "undefined");
  ledger._internals.reset();
});

test("XERK-779: a rich host round-trips through Postgres — full fidelity on a cold rescan", async () => {
  const pool = new FakePgPool();
  const a = replica(pool);
  await ready(a);
  const rich = base().coerce({
    device: "MaxAI", siteKey: "acme.atlassian.net", firstSeen: 100, lastSeen: 999,
    host: {
      pre: bucket(5, 0, 0, 7), cutoff: "2025-01-01",
      days: { "2026-09-10": bucket(10, 1), "2026-09-11": bucket(20, 2, 3, 4) },
      models: { "claude-opus-5": bucket(30, 3), "claude-sonnet-5": bucket(6, 1) },
      subagent: bucket(4, 0, 0, 1),
      sessions: 8, lastActivity: "2026-09-11T10:00:00Z",
    },
    repos: {
      "git@x/repo-a": { repo: "repo-a", remote: "git@x/repo-a", series: { days: { "2026-09-11": bucket(100, 5) }, models: { "claude-opus-5": bucket(100, 5) } } },
      "git@x/repo-b": { repo: "repo-b", remote: "git@x/repo-b", series: { pre: bucket(2), days: { "2026-09-09": bucket(9) } } },
    },
  });
  a.model.set("MaxAI", rich);
  a.backend.onChange("MaxAI");
  await flush(a);

  // A FRESH replica (a restart / promoted standby) scans the same Postgres.
  const b = replica(pool);
  await ready(b);
  const got = b.model.get("MaxAI");
  assert.ok(got, "the host is rehydrated from Postgres");
  // Host-level all-time = pre + sum(days), and every window/breakdown survives.
  assert.equal(bTok(sTot(got.host)), bTok(sTot(rich.host)));
  assert.deepEqual(got.host.subagent, rich.host.subagent, "sub-agent split survives");
  assert.equal(got.host.sessions, 8);
  assert.equal(got.host.lastActivity, "2026-09-11T10:00:00Z");
  assert.equal(got.device, "MaxAI");
  assert.equal(got.siteKey, "acme.atlassian.net");
  assert.equal(got.firstSeen, 100);
  assert.equal(got.lastSeen, 999);
  assert.equal(Object.keys(got.host.models).length, 2, "per-model breakdown survives");
  assert.equal(bTok(got.host.models["claude-opus-5"]), 33);
  // Per-repo breakdown survives — the fidelity Design A would have lost for a retired host.
  assert.equal(bTok(sTot(got.repos["git@x/repo-a"].series)), 105);
  assert.equal(got.repos["git@x/repo-a"].repo, "repo-a");
  assert.equal(bTok(sTot(got.repos["git@x/repo-b"].series)), 11, "repo-b pre(2)+day(9)");
  await a.backend.close(); await b.backend.close();
});

test("XERK-779: a partial/low writer can NEVER lower a recorded total (GREATEST)", async () => {
  const pool = new FakePgPool();
  const hi = replica(pool); await ready(hi);
  hi.model.set("h", base().coerce({ device: "h", lastSeen: 2, host: { days: { "2026-09-11": bucket(1000) } } }));
  hi.backend.onChange("h"); await flush(hi);

  // A second replica with a LOWER view writes the same day.
  const lo = replica(pool); await ready(lo);
  lo.model.set("h", base().coerce({ device: "h", lastSeen: 1, host: { days: { "2026-09-11": bucket(5) } } }));
  lo.backend.onChange("h"); await flush(lo);

  const seen = replica(pool); await ready(seen);
  assert.equal(bTok(sTot(seen.model.get("h").host)), 1000, "the recorded high-water is never lowered");
  await hi.backend.close(); await lo.backend.close(); await seen.backend.close();
});

test("XERK-779: concurrent replicas writing one host converge (max per day, union of days)", async () => {
  const pool = new FakePgPool();
  const a = replica(pool); const b = replica(pool);
  await ready(a); await ready(b);
  // A holds day-1 high on the shared day + its own day; B holds day-1 low + its own day.
  a.model.set("h", base().coerce({ device: "h", lastSeen: 5, host: { days: { "2026-09-10": bucket(50), "2026-09-11": bucket(40) } } }));
  b.model.set("h", base().coerce({ device: "h", lastSeen: 6, host: { days: { "2026-09-11": bucket(9), "2026-09-12": bucket(70) } } }));
  a.backend.onChange("h"); b.backend.onChange("h");
  await Promise.all([flush(a), flush(b)]);

  const seen = replica(pool); await ready(seen);
  const days = seen.model.get("h").host.days;
  assert.equal(days["2026-09-10"].input, 50);
  assert.equal(days["2026-09-11"].input, 40, "the shared day converges to the MAX, not the last writer");
  assert.equal(days["2026-09-12"].input, 70);
  await a.backend.close(); await b.backend.close(); await seen.backend.close();
});

test("XERK-779: onForget removes the host's rows from Postgres", async () => {
  const pool = new FakePgPool();
  const a = replica(pool); await ready(a);
  a.model.set("h", base().coerce({ device: "h", lastSeen: 1, host: { days: { "2026-09-11": bucket(10) }, models: { m: bucket(10) } } }));
  a.backend.onChange("h"); await flush(a);
  a.backend.onForget("h");
  await new Promise((r) => setTimeout(r, 20)); // let the immediate delete land

  const b = replica(pool); await ready(b);
  assert.equal(b.model.has("h"), false, "a forgotten host is gone from the store");
  await a.backend.close(); await b.backend.close();
});

test("XERK-779: a day at/below the cutoff is dropped (never double-counted with pre)", async () => {
  const pool = new FakePgPool();
  const a = replica(pool); await ready(a);
  // Seed a raw day row that is BELOW a later cutoff, as if written before it aged.
  await pool.query(
    `INSERT INTO "usage_day" ("host","series","day","token_key","tokens") VALUES ($1,$2,$3,$4,$5) ` +
      `ON CONFLICT ("host","series","day","token_key") DO UPDATE SET tokens = GREATEST("usage_day".tokens, EXCLUDED.tokens)`,
    ["h", "", "2025-06-01", "input", "999"]
  );
  // Now write a host whose cutoff has advanced past that day (its value folded into pre).
  a.model.set("h", base().coerce({ device: "h", lastSeen: 1, host: { pre: bucket(999), cutoff: "2025-12-31", days: { "2026-09-11": bucket(10) } } }));
  a.backend.onChange("h"); await flush(a);

  const b = replica(pool); await ready(b);
  const got = b.model.get("h").host;
  assert.equal(got.days["2025-06-01"], undefined, "the stale below-cutoff day row is gone");
  assert.equal(bTok(sTot(got)), 1009, "pre(999) + day(10), NOT 1009+999 double-count");
  await a.backend.close(); await b.backend.close();
});

test("XERK-813: the pre-HA file model is SEEDED up into Postgres on the ready edge", async () => {
  const pool = new FakePgPool();
  // A retired host (never beats again) with rich fidelity, exactly what only the
  // file ledger held pre-cutover.
  const retired = base().coerce({
    device: "MaxAI", siteKey: "acme.atlassian.net", firstSeen: 100, lastSeen: 999,
    host: {
      pre: bucket(5379447205, 0, 0, 0), cutoff: "2026-08-15",
      days: { "2026-09-01": bucket(1000, 10) },
      models: { "claude-opus-5": bucket(1000, 10) },
      subagent: bucket(4, 0, 0, 1), sessions: 3, lastActivity: "2026-09-01T00:00:00Z",
    },
    repos: { "git@x/repo-a": { repo: "repo-a", remote: "git@x/repo-a", series: { days: { "2026-09-01": bucket(500) } } } },
  });
  // Construct the store WITH the seed (what configure passes), drive the ready edge.
  const a = replica(pool, { seed: { MaxAI: retired } });
  await ready(a);
  assert.equal(a.backend._seed, null, "the seed is cleared once it lands (one-shot)");
  assert.equal(a.backend._seeded, true);

  // A FRESH replica with NO seed scans the SAME Postgres — proof the seed reached the
  // of-record, not just this process's memory.
  const b = replica(pool);
  await ready(b);
  const got = b.model.get("MaxAI");
  assert.ok(got, "the retired host's history reached Postgres via the seed");
  assert.equal(bTok(sTot(got.host)), bTok(sTot(retired.host)), "all-time (pre + days) survives");
  assert.deepEqual(got.host.subagent, retired.host.subagent, "sub-agent split survives");
  assert.equal(got.host.sessions, 3);
  assert.equal(got.device, "MaxAI");
  assert.equal(got.siteKey, "acme.atlassian.net");
  assert.equal(bTok(sTot(got.repos["git@x/repo-a"].series)), 500, "per-repo breakdown survives");
  await a.backend.close(); await b.backend.close();
});

test("XERK-813: the seed is IDEMPOTENT and never lowers a total (re-seed on next boot)", async () => {
  const pool = new FakePgPool();
  // First boot: seed a host.
  const a = replica(pool, { seed: { h: base().coerce({ device: "h", lastSeen: 1, host: { days: { "2026-09-11": bucket(1000) } } }) } });
  await ready(a);
  // A live beat raises the same day HIGHER after the cutover.
  a.model.set("h", base().coerce({ device: "h", lastSeen: 2, host: { days: { "2026-09-11": bucket(3000) } } }));
  a.backend.onChange("h"); await flush(a);
  // A LATER boot re-seeds from the still-frozen file (the LOWER pre-HA value).
  const c = replica(pool, { seed: { h: base().coerce({ device: "h", lastSeen: 1, host: { days: { "2026-09-11": bucket(1000) } } }) } });
  await ready(c);
  const seen = replica(pool); await ready(seen);
  assert.equal(bTok(sTot(seen.model.get("h").host)), 3000, "a re-seed GREATEST-no-ops, never lowering the live high-water");
  await a.backend.close(); await c.backend.close(); await seen.backend.close();
});

test("XERK-813: a swallowed seed write leaves the one-shot UNSET so the next ready edge retries (QA D1)", async () => {
  // A pool that throws on usage_day INSERTs while `failDays` is set — the transient
  // mid-seed blip the fix must survive without silently dropping a retired host.
  class FlakyPool extends FakePgPool {
    constructor() { super(); this.failDays = true; }
    query(text, params) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (this.failDays && /^INSERT INTO "usage_day"/i.test(sql)) {
        return Promise.reject(new Error("transient day-insert failure"));
      }
      return super.query(text, params);
    }
  }
  const pool = new FlakyPool();
  const retired = base().coerce({ device: "MaxAI", lastSeen: 9, host: { days: { "2026-09-01": bucket(1000) } } });
  const a = replica(pool, { seed: { MaxAI: retired } });
  await ready(a); // first ready edge: the day upsert throws, _writeEntry returns false
  assert.equal(a.backend._seeded, false, "a partial seed does NOT consume the one-shot");
  assert.ok(a.backend._seed, "the seed is retained for the retry");

  // The transient clears; the next ready edge (a reconnect) retries and lands.
  pool.failDays = false;
  await a.backend._onReady();
  assert.equal(a.backend._seeded, true, "the retry lands and consumes the one-shot");
  assert.equal(a.backend._seed, null);

  const b = replica(pool); await ready(b);
  assert.ok(b.model.get("MaxAI"), "the retired host reached Postgres on the retry (not lost for the process)");
  assert.equal(bTok(sTot(b.model.get("MaxAI").host)), 1000);
  await a.backend.close(); await b.backend.close();
});

test("XERK-813: configure() seeds the pre-HA file model so retired + aged-out history survives the cutover", async () => {
  ledger._internals.reset();
  const pool = new FakePgPool();
  // Simulate what the file backend loaded at require time: a RETIRED host (never
  // beats again) and a LIVE host whose day bucket has since aged off disk — the two
  // classes the ticket proves do NOT self-heal after the cutover.
  const H = ledger._internals.hosts();
  H["MaxAI"] = base().coerce({
    device: "MaxAI", siteKey: "acme.atlassian.net", firstSeen: 1, lastSeen: 9,
    host: { pre: bucket(5379447205), days: { "2026-08-01": bucket(1000) }, sessions: 3 },
  });
  H["box-live"] = base().coerce({ device: "box-live", lastSeen: 5, host: { days: { "2026-07-01": bucket(2000) } } });

  await ledger.configure({ ha: true }, pool, () => {});
  assert.equal(typeof ledger._internals.getBackend().rescan, "function", "the LedgerStore is now the backend");
  // configure kicks the ready-edge work (seed + scan) fire-and-forget; drive it.
  await ledger.rehydrate();

  // A FRESH replica scanning the SAME Postgres sees both — the file history reached
  // the durable of-record, not just this process's memory (the cutover bug).
  const b = replica(pool); await ready(b);
  assert.ok(b.model.get("MaxAI"), "the retired host reached Postgres");
  assert.equal(bTok(sTot(b.model.get("MaxAI").host)), 5379447205 + 1000);
  assert.ok(b.model.get("box-live"), "the aged-out live-host history reached Postgres");
  assert.equal(bTok(sTot(b.model.get("box-live").host)), 2000);
  await b.backend.close();
  ledger._internals.reset();
});

test("XERK-779: configure + ingest + rehydrate end-to-end through the real ledger", async () => {
  ledger._internals.reset();
  const pool = new FakePgPool();
  let external = 0;
  await ledger.configure({ ha: true }, pool, () => { external += 1; });
  assert.equal(typeof ledger._internals.getBackend().rescan, "function", "LedgerStore is now the backend");

  ledger.ingest("box-1", {
    device: "box-1",
    jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(200, 20, 0, 0), days: { "2026-09-11": bucket(200, 20) }, models: [{ model: "claude-opus-5", totals: bucket(200, 20) }] },
    repoUsage: [{ repo: "turma", remoteKey: "git@x/turma", usage: { totals: bucket(150), days: { "2026-09-11": bucket(150) } } }],
  });
  await new Promise((r) => ledger.flush(r));

  // Simulate a restart / promotion: empty the in-memory model, then rehydrate from PG.
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  assert.equal(ledger.has("box-1"), false);
  external = 0;
  await ledger.rehydrate();
  assert.equal(ledger.has("box-1"), true, "the host is reloaded from Postgres on rehydrate");
  assert.ok(external >= 1, "a scan that loaded rows invalidates the /api/agents cache");
  assert.equal(bTok(sTot(ledger._internals.hosts()["box-1"].host)), 220);
  assert.equal(bTok(sTot(ledger._internals.hosts()["box-1"].repos["git@x/turma"].series)), 150);
  ledger._internals.reset();
});

test("XERK-2870: a re-key keeps the old host's rows until the tenant key's write lands", async (t) => {
  ledger._internals.reset();
  class FlakyPool extends FakePgPool {
    constructor() { super(); this.fail = false; }
    query(text, params) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (this.fail && /^INSERT INTO "usage_day"/i.test(sql)) return Promise.reject(new Error("blip"));
      return super.query(text, params);
    }
  }
  const pool = new FlakyPool();
  await ledger.configure({ ha: true }, pool, () => {});
  const T = "b".repeat(32);
  ledger.ingest("box-2", {
    device: "box-2", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(200, 20, 0, 0), days: { "2026-09-11": bucket(200, 20) } },
    repoUsage: [],
  });
  await new Promise((r) => ledger.flush(r));
  const dayHosts = () => new Set([...pool.tables.get("usage_day").values()].map((row) => row.host));
  // Postgres refuses writes through the first attempt AND the debounce flush that
  // follows it — the debounce draining the key must not read as the write landing.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pool.fail = true;
  assert.equal(ledger.rekeyHost("box-2", `box-2@${T}`), true);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(10 * 1000); // past the store's debounce
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(dayHosts().has("box-2"), "the old host's rows survive a failed write of the new key");
  assert.ok(!dayHosts().has(`box-2@${T}`));
  assert.equal(await Promise.race([ledger.rekeysSettled(0), Promise.resolve(1)]) >= 1, true,
    "the migration sees the re-key unsettled");
  // Postgres comes back; the next retry writes the new key, THEN drops the old one.
  pool.fail = false;
  t.mock.timers.tick(30 * 1000);
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.reset();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(dayHosts().has(`box-2@${T}`), "the retry lands the tenant key");
  assert.ok(!dayHosts().has("box-2"), "and only then deletes the old host's rows");
  assert.equal(await ledger.rekeysSettled(), 0);
  ledger._internals.reset();
});

test("XERK-2870: purging the tenant key mid-retry deletes the old host's copy once Postgres is back", async (t) => {
  ledger._internals.reset();
  class DownPool extends FakePgPool {
    constructor() { super(); this.down = false; }
    query(text, params) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (this.down && /^(INSERT|DELETE)/i.test(sql)) return Promise.reject(new Error("down"));
      return super.query(text, params);
    }
  }
  const pool = new DownPool();
  await ledger.configure({ ha: true }, pool, () => {});
  const T = "c".repeat(32);
  ledger.ingest("box-3", {
    device: "box-3", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(90, 0, 0, 0), days: { "2026-09-11": bucket(90) } }, repoUsage: [],
  });
  await new Promise((r) => ledger.flush(r));
  const dayHosts = () => new Set([...pool.tables.get("usage_day").values()].map((row) => row.host));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  pool.down = true;
  assert.equal(ledger.rekeyHost("box-3", `box-3@${T}`), true);
  await settle();
  // The tenant is purged while its new key is still unsaved.
  assert.deepEqual(ledger.purgeTenant(T), [`box-3@${T}`]);
  t.mock.timers.tick(30 * 1000);
  await settle();
  assert.ok(dayHosts().has("box-3"), "still there while Postgres refuses the delete");
  pool.down = false;
  t.mock.timers.tick(30 * 1000);
  await settle();
  t.mock.timers.reset();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!dayHosts().has("box-3"), "the purged history's untenanted copy is deleted, not reloaded later");
  assert.ok(!dayHosts().has(`box-3@${T}`));
  assert.equal(await ledger.rekeysSettled(), 0);
  ledger._internals.reset();
});

test("XERK-2870: an old name that beats again keeps only its new beats in Postgres", async () => {
  ledger._internals.reset();
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool, () => {});
  const T = "d".repeat(32);
  const beat = (n) => ({ device: "box-4", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(n, 0, 0, 0), days: { "2026-09-12": bucket(n) } }, repoUsage: [] });
  ledger.ingest("box-4", beat(200));
  await new Promise((r) => ledger.flush(r));
  assert.equal(ledger.rekeyHost("box-4", `box-4@${T}`), true);
  // The old name beats again before the re-key settles, then its tenant is purged.
  ledger.ingest("box-4", beat(5));
  assert.deepEqual(ledger.purgeTenant(T), [`box-4@${T}`]);
  assert.equal(await ledger.rekeysSettled(), 0);
  await new Promise((r) => ledger.flush(r));
  await new Promise((r) => setTimeout(r, 20));
  // A restart reloads only what memory held: 5, never the moved (then purged) 200.
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  await ledger.rehydrate();
  assert.deepEqual(ledger.keys(), ["box-4"]);
  assert.equal(bTok(sTot(ledger._internals.hosts()["box-4"].host)), 5);
  ledger._internals.reset();
});

test("XERK-2870: an old name that beats again before the move lands is not counted twice", async () => {
  ledger._internals.reset();
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool, () => {});
  const T = "e".repeat(32);
  const beat = (n) => ({ device: "box-5", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(n, 0, 0, 0), days: { "2026-09-13": bucket(n) } }, repoUsage: [] });
  ledger.ingest("box-5", beat(200));
  await new Promise((r) => ledger.flush(r));
  assert.equal(ledger.rekeyHost("box-5", `box-5@${T}`), true);
  ledger.ingest("box-5", beat(5)); // the old name beats again before the settle
  assert.equal(await ledger.rekeysSettled(), 0);
  await new Promise((r) => ledger.flush(r));
  await new Promise((r) => setTimeout(r, 20));
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  await ledger.rehydrate();
  assert.equal(bTok(sTot(ledger._internals.hosts()["box-5"].host)), 5, "the old name keeps only its new beat");
  assert.equal(bTok(sTot(ledger._internals.hosts()[`box-5@${T}`].host)), 200);
  ledger._internals.reset();
});

test("XERK-2870: a rescan while a re-key is still settling does not reload the moved history", async (t) => {
  ledger._internals.reset();
  class DownPool extends FakePgPool {
    constructor() { super(); this.down = false; }
    query(text, params) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (this.down && /^(INSERT|DELETE)/i.test(sql)) return Promise.reject(new Error("down"));
      return super.query(text, params);
    }
  }
  const pool = new DownPool();
  await ledger.configure({ ha: true }, pool, () => {});
  const T = "f".repeat(32);
  ledger.ingest("box-6", { device: "box-6", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(200, 0, 0, 0), days: { "2026-09-14": bucket(200) } }, repoUsage: [] });
  await new Promise((r) => ledger.flush(r));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  pool.down = true;
  assert.equal(ledger.rekeyHost("box-6", `box-6@${T}`), true);
  await settle();
  await ledger.rehydrate(); // a reconnect/promotion rescan inside the outage
  assert.ok(!ledger.has("box-6"), "the old key's stored rows are the history being moved");
  pool.down = false;
  t.mock.timers.tick(30 * 1000);
  await settle();
  t.mock.timers.reset();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await ledger.rekeysSettled(), 0);
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  await ledger.rehydrate();
  assert.deepEqual(ledger.keys(), [`box-6@${T}`]);
  assert.equal(bTok(sTot(ledger._internals.hosts()[`box-6@${T}`].host)), 200);
  ledger._internals.reset();
});

test("XERK-2870: no re-key before the ledger has read its stored history", async () => {
  ledger._internals.reset();
  // Seed 200 of stored history, as a previous hub process left it.
  const pool = new FakePgPool();
  const seed = replica(pool);
  await ready(seed);
  seed.model.set("box-7", base().coerce({ device: "box-7", siteKey: "acme.atlassian.net", firstSeen: 1, lastSeen: 1,
    host: { days: { "2026-09-15": bucket(200) } }, repos: {} }));
  seed.backend.onChange("box-7");
  await flush(seed);
  // This process boots while Postgres refuses reads: the boot scan fails.
  class NoReadPool extends FakePgPool {
    constructor(tables) { super(); this.tables = tables; this.noRead = true; }
    query(text, params) {
      if (this.noRead && /^\s*SELECT/i.test(String(text))) return Promise.reject(new Error("down"));
      return super.query(text, params);
    }
  }
  const pool2 = new NoReadPool(pool.tables);
  await ledger.configure({ ha: true }, pool2, () => {});
  await new Promise((r) => setTimeout(r, 20));
  ledger.ingest("box-7", { device: "box-7", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(5, 0, 0, 0), days: { "2026-09-16": bucket(5) } }, repoUsage: [] });
  const T = "9".repeat(32);
  assert.equal(ledger.isLoaded(), false);
  assert.equal(ledger.rekeyHost("box-7", `box-7@${T}`), false, "memory holds only the new beat");
  pool2.noRead = false;
  await ledger.rehydrate();
  assert.equal(ledger.isLoaded(), true);
  assert.equal(ledger.rekeyHost("box-7", `box-7@${T}`), true);
  assert.equal(await ledger.rekeysSettled(), 0);
  await new Promise((r) => setTimeout(r, 20));
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  await ledger.rehydrate();
  assert.deepEqual(ledger.keys(), [`box-7@${T}`]);
  assert.equal(bTok(sTot(ledger._internals.hosts()[`box-7@${T}`].host)), 205, "stored history + the new beat");
  ledger._internals.reset();
});

test("XERK-2870: a partly-landed seed is not loaded until a rescan lands the rest", async () => {
  class FlakyPool extends FakePgPool {
    constructor() { super(); this.fail = true; }
    query(text, params) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (this.fail && /^INSERT INTO "usage_day"/i.test(sql) && JSON.stringify(params || []).includes("old-host")) {
        return Promise.reject(new Error("blip"));
      }
      return super.query(text, params);
    }
  }
  const pool = new FlakyPool();
  const seed = {
    "old-host": base().coerce({ device: "old-host", siteKey: "acme", firstSeen: 1, lastSeen: 1,
      host: { days: { "2026-09-17": bucket(300) } }, repos: {} }),
  };
  const r = replica(pool, { seed });
  await ready(r);
  assert.equal(r.backend.loaded, false, "the scan read the table but the seed has not landed");
  pool.fail = false;
  await r.backend.rescan();
  assert.equal(r.backend.loaded, true, "a rescan retries the seed");
  assert.equal(bTok(sTot(r.model.get("old-host").host)), 300);
});

// A ledger booted on a Postgres that refuses box-8's seed INSERTs: the pre-HA file
// held 300 for box-8, then it beats 7 under HA.
class SeedPool extends FakePgPool {
  constructor() { super(); this.failSeed = true; this.failSelect = false; this.gate = null; }
  query(text, params) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    if (this.failSeed && /^INSERT/i.test(sql) && JSON.stringify(params || []).includes("box-8")) {
      return Promise.reject(new Error("blip"));
    }
    if (/^SELECT/i.test(sql)) {
      if (this.failSelect) return Promise.reject(new Error("select down"));
      if (this.gate) { const g = this.gate; return g.then(() => super.query(text, params)); }
    }
    return super.query(text, params);
  }
}
async function bootWithPendingSeed() {
  ledger._internals.reset();
  ledger.ingest("box-8", { device: "box-8", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(300, 0, 0, 0), days: { "2026-09-18": bucket(300) } }, repoUsage: [] });
  const pool = new SeedPool();
  await ledger.configure({ ha: true }, pool, () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ledger.isLoaded(), false, "the seed has not landed");
  ledger.ingest("box-8", { device: "box-8", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(7, 0, 0, 0), days: { "2026-09-19": bucket(7) } }, repoUsage: [] });
  return pool;
}
async function tenantTotalAfterRestart(key) {
  await new Promise((r) => setTimeout(r, 20));
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  await ledger.rehydrate();
  return ledger.has(key) ? bTok(sTot(ledger._internals.hosts()[key].host)) : null;
}

test("XERK-2870: a seed that lands while the scan fails is not loaded until a scan reads it", async () => {
  const pool = await bootWithPendingSeed();
  pool.failSeed = false;
  pool.failSelect = true;
  await ledger.rehydrate(); // the seed lands, the scan fails
  assert.equal(ledger.isLoaded(), false, "the seeded rows are not in memory yet");
  const T = "8".repeat(32);
  assert.equal(ledger.rekeyHost("box-8", `box-8@${T}`), false);
  pool.failSelect = false;
  await ledger.rehydrate();
  assert.equal(ledger.isLoaded(), true);
  assert.equal(ledger.rekeyHost("box-8", `box-8@${T}`), true);
  assert.equal(await ledger.rekeysSettled(), 0);
  assert.equal(await tenantTotalAfterRestart(`box-8@${T}`), 307);
  ledger._internals.reset();
});

test("XERK-2870: a rescan overlapping one that began before the seed landed scans again", async () => {
  const pool = await bootWithPendingSeed();
  let open;
  pool.gate = new Promise((r) => { open = r; });
  const a = ledger.rehydrate(); // its seed fails again; its scan waits on the gate
  await new Promise((r) => setTimeout(r, 10));
  pool.failSeed = false;
  const b = ledger.rehydrate(); // lands the seed, then finds A's scan in flight
  await new Promise((r) => setTimeout(r, 10));
  pool.gate = null;
  open();
  await Promise.all([a, b]);
  assert.equal(ledger.isLoaded(), true);
  assert.equal(bTok(sTot(ledger._internals.hosts()["box-8"].host)), 307, "the seeded rows were read back");
  const T = "7".repeat(32);
  assert.equal(ledger.rekeyHost("box-8", `box-8@${T}`), true);
  assert.equal(await ledger.rekeysSettled(), 0);
  assert.equal(await tenantTotalAfterRestart(`box-8@${T}`), 307);
  ledger._internals.reset();
});

test("XERK-2870: a host forgotten while its seed is pending does not come back from it", async () => {
  const pool = await bootWithPendingSeed();
  assert.equal(ledger.forget("box-8"), true);
  pool.failSeed = false;
  await ledger.rehydrate();
  assert.equal(ledger.isLoaded(), true);
  assert.equal(ledger.has("box-8"), false);
  assert.equal(await tenantTotalAfterRestart("box-8"), null);
  ledger._internals.reset();
});

test("XERK-2870: a host forgotten while the seed is being written is not written back", async () => {
  ledger._internals.reset();
  const day = (n, d) => ({ totals: bucket(n, 0, 0, 0), days: { [d]: bucket(n) } });
  ledger.ingest("box-8", { device: "box-8", jira: { siteKey: "acme" }, usage: day(300, "2026-09-18"), repoUsage: [] });
  ledger.ingest("box-9", { device: "box-9", jira: { siteKey: "acme" }, usage: day(40, "2026-09-18"), repoUsage: [] });
  let open;
  const gate = new Promise((r) => { open = r; });
  class SlowPool extends FakePgPool {
    query(text, params) {
      if (/^\s*INSERT/i.test(String(text)) && JSON.stringify(params || []).includes("box-8")) {
        return gate.then(() => super.query(text, params));
      }
      return super.query(text, params);
    }
  }
  const pool = new SlowPool();
  await ledger.configure({ ha: true }, pool, () => {});
  await new Promise((r) => setTimeout(r, 10)); // the seed loop is waiting on box-8
  ledger.ingest("box-9", { device: "box-9", jira: { siteKey: "acme" }, usage: day(2, "2026-09-19"), repoUsage: [] });
  assert.equal(ledger.forget("box-9"), true);
  open();
  await new Promise((r) => setTimeout(r, 40));
  const hostsIn = () => new Set([...pool.tables.values()].flatMap((t) => [...t.values()].map((row) => row.host)));
  assert.ok(!hostsIn().has("box-9"), "the forgotten host's seed write was skipped");
  assert.ok(hostsIn().has("box-8"));
  ledger._internals.reset();
});

test("XERK-2870: every caller waiting on an early scan sees the model loaded", async () => {
  const pool = await bootWithPendingSeed();
  let open;
  pool.gate = new Promise((r) => { open = r; });
  const a = ledger.rehydrate(); // seed fails again; its scan waits on the gate
  await new Promise((r) => setTimeout(r, 10));
  pool.failSeed = false;
  const seen = [];
  const waiters = [1, 2, 3].map(() => ledger.rehydrate().then(() => seen.push(ledger.isLoaded())));
  await new Promise((r) => setTimeout(r, 10));
  pool.gate = null;
  open();
  await Promise.all([a, ...waiters]);
  assert.deepEqual(seen, [true, true, true]);
  ledger._internals.reset();
});

test("XERK-2870: concurrent reloads during an outage share one read", async () => {
  ledger._internals.reset();
  let selects = 0;
  class DownPool extends FakePgPool {
    constructor() { super(); this.down = false; }
    query(text, params) {
      if (/^\s*SELECT/i.test(String(text)) && this.down) {
        selects++;
        return new Promise((_r, rej) => setTimeout(() => rej(new Error("down")), 5));
      }
      return super.query(text, params);
    }
  }
  const pool = new DownPool();
  pool.down = true; // never loaded: every boot read fails
  await ledger.configure({ ha: true }, pool, () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ledger.isLoaded(), false);
  selects = 0;
  await Promise.all(Array.from({ length: 10 }, () => ledger.rehydrate()));
  assert.ok(selects <= 2, `${selects} reads for 10 concurrent reloads`);
  ledger._internals.reset();
});

test("XERK-2554: rekeyHost writes the tenant key to Postgres and deletes the old host's rows", async () => {
  ledger._internals.reset();
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool, () => {});
  const T = "a".repeat(32);
  ledger.ingest("box-1", {
    device: "box-1", jira: { siteKey: "acme.atlassian.net" },
    usage: { totals: bucket(200, 20, 0, 0), days: { "2026-09-11": bucket(200, 20) } },
    repoUsage: [],
  });
  await new Promise((r) => ledger.flush(r));
  const hostsIn = () => new Set([...pool.tables.values()].flatMap((t) => [...t.values()].map((row) => row.host)));
  assert.deepEqual([...hostsIn()], ["box-1"]);
  assert.equal(ledger.rekeyHost("box-1", `box-1@${T}`), true);
  await new Promise((r) => ledger.flush(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...hostsIn()], [`box-1@${T}`]);
  // A promoted replica rescanning finds only the tenant key.
  const H = ledger._internals.hosts();
  for (const k of Object.keys(H)) delete H[k];
  await ledger.rehydrate();
  assert.deepEqual(ledger.keys(), [`box-1@${T}`]);
  assert.equal(bTok(sTot(ledger._internals.hosts()[`box-1@${T}`].host)), 220);
  ledger._internals.reset();
});
