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
