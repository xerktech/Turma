// XERK-2550 — the usage, permission and outcome ledgers partitioned by tenant.
//
// Every ledger row is keyed by the registry key of the host that produced it,
// and a tenant host's key is `<device>@<tenantId>` (XERK-2533), so a row's
// tenant is read off its key. These pin, per ledger: a scoped read sees only its
// scope's rows, no aggregate (fold, pair, defect, eviction budget) mixes two
// tenants, and a tenant purge removes exactly that tenant's rows.
//
// Its own process: each ledger reads its file and budgets at require time.

"use strict";

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp } = require("./tmpdirs");

const DIR = mkdtemp("turma-ledger-tenancy-");
process.env.USAGE_LEDGER_FILE = path.join(DIR, "usage-ledger.json");
process.env.PERMISSION_LEDGER_FILE = path.join(DIR, "permission-ledger.json");
process.env.OUTCOME_LEDGER_FILE = path.join(DIR, "outcome-ledger.json");
process.env.OUTCOME_LEDGER_SAVE_MS = "10";
process.env.OUTCOME_LEDGER_MAX_ROWS = "100";
// Small enough that one tenant's retired hosts could fill it on their own.
process.env.USAGE_LEDGER_SERVE_MAX = "3000";

const { tenantOfHostKey } = require("../tenancy.js");
const usage = require("../usage-ledger.js");
const perms = require("../permission-ledger.js");
const outcome = require("../outcome-ledger.js");

const TA = "a".repeat(32);
const TB = "b".repeat(32);
const onlyT = (t) => (k) => tenantOfHostKey(k) === t;

test("tenantOfHostKey reads the tenant off a key, and nothing else", () => {
  assert.equal(tenantOfHostKey(`laptop@${TA}`), TA);
  assert.equal(tenantOfHostKey("laptop"), "");
  assert.equal(tenantOfHostKey(`laptop@${TA.toUpperCase()}`), "");   // not a tenant key
  assert.equal(tenantOfHostKey(null), "");
  assert.equal(tenantOfHostKey(`x@${TA}y`), "");
});

// ---- usage ledger -------------------------------------------------------------

const DAY = "2026-10-30";
const NOW = Date.parse(`${DAY}T12:00:00Z`);
const bucket = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
function beat(device, n, siteKey = "acme.atlassian.net") {
  const u = { totals: bucket(n), today: bucket(n), week: bucket(n), days: { [DAY]: bucket(n) },
    sessions: 1, lastActivity: `${DAY}T11:00:00Z`, models: [] };
  return { device, jira: { siteKey }, usage: u,
    repoUsage: [{ repo: "Turma", remoteKey: "rk-turma", remote: "git@x:/Turma.git", usage: u }] };
}
const tokens = (rec) => rec.usage.totals.input;

test("XERK-2550: retired usage is served per tenant, and the byte budget is the scope's own", () => {
  usage._internals.reset();
  // Tenant B has many newer retired hosts; tenant A one older one.
  usage.ingest(`old@${TA}`, beat("old", 7), NOW - 3600_000);
  for (let i = 0; i < 12; i++) usage.ingest(`b${i}@${TB}`, beat(`b${i}`, 100 + i), NOW + i);
  usage.ingest("ops", beat("ops", 5), NOW);
  const all = usage.retiredAgents([], NOW);
  assert.ok(!all.some((r) => r.key === `old@${TA}`), "fleet-wide, B's newer hosts crowd A out");
  const a = usage.retiredAgents([], NOW, onlyT(TA));
  assert.deepEqual(a.map((r) => r.key), [`old@${TA}`]);
  assert.equal(tokens(a[0]), 7);
  const ops = usage.retiredAgents([], NOW, onlyT(""));
  assert.deepEqual(ops.map((r) => r.key), ["ops"]);
  assert.ok(usage.retiredAgents([], NOW, onlyT(TB)).every((r) => tenantOfHostKey(r.key) === TB));
});

test("XERK-2550: no case twin or rename folds one tenant's spend into another's card", () => {
  usage._internals.reset();
  const { foldKey, setHostAliases } = usage._internals;
  // The same device name in two tenants, and an untenanted name shaped like a tenant key.
  usage.ingest(`laptop@${TA}`, beat("laptop", 10), NOW);
  usage.ingest(`LAPTOP@${TB}`, beat("LAPTOP", 20), NOW);
  usage.ingest(`laptop@${TA.toUpperCase()}`, beat("x", 40), NOW);
  assert.notEqual(foldKey(`laptop@${TA}`), foldKey(`LAPTOP@${TB}`));
  assert.notEqual(foldKey(`laptop@${TA}`), foldKey(`laptop@${TA.toUpperCase()}`));
  const live = usage.fold(`laptop@${TA}`, beat("laptop", 10), NOW, new Set([`laptop@${TA}`]));
  assert.equal(live ? tokens(live) : 10, 10);
  // A tenant bind (`laptop` -> `laptop@<t>`) is recorded as a rename; the
  // untenanted pre-bind spend must not fold into the tenant's card.
  usage.ingest("desk", beat("desk", 50), NOW);
  setHostAliases([["desk", `desk@${TA}`], [`l1@${TA}`, `l2@${TB}`]]);
  try {
    assert.notEqual(foldKey("desk"), foldKey(`desk@${TA}`));
    assert.notEqual(foldKey(`l1@${TA}`), foldKey(`l2@${TB}`));
    const card = usage.fold(`desk@${TA}`, beat("desk", 1), NOW, new Set([`desk@${TA}`]));
    assert.equal(card ? tokens(card) : 1, 1);
    // The groups themselves never join two tenants: aliasing the untenanted
    // `desk` to a smaller untenanted name must leave the tenant key's root alone.
    setHostAliases([["desk", `desk@${TA}`], ["desk", "dask"]]);
    assert.equal(foldKey(`desk@${TA}`), `${TA}\u0000desk@${TA}`);
    // Same-tenant renames still fold.
    setHostAliases([[`old@${TA}`, `new@${TA}`]]);
    assert.equal(foldKey(`old@${TA}`), foldKey(`new@${TA}`));
  } finally { setHostAliases([]); }
});

test("XERK-2550: a tenant purge forgets that tenant's hosts only (and an invalid id nothing)", async () => {
  usage._internals.reset();
  usage.ingest(`a1@${TA}`, beat("a1", 1), NOW);
  usage.ingest(`a2@${TA}`, beat("a2", 2), NOW);
  usage.ingest(`b1@${TB}`, beat("b1", 3), NOW);
  usage.ingest("ops", beat("ops", 4), NOW);
  assert.deepEqual(usage.purgeTenant(""), []);
  assert.deepEqual(usage.purgeTenant("nope"), []);
  assert.deepEqual(usage.purgeTenant(TA).sort(), [`a1@${TA}`, `a2@${TA}`]);
  assert.deepEqual(Object.keys(usage._internals.hosts()).sort(), [`b1@${TB}`, "ops"].sort());
  // The file no longer holds them once written.
  await new Promise((r) => usage._internals.writeNow(r));
  const raw = fs.readFileSync(process.env.USAGE_LEDGER_FILE, "utf8");
  assert.ok(!raw.includes(TA));
  assert.ok(raw.includes(TB));
});

test("XERK-2550: the Postgres usage store deletes a purged tenant's rows", async () => {
  usage._internals.reset();
  const forgot = [];
  usage._internals.setBackend({ onChange() {}, onForget(k) { forgot.push(k); }, flush(d) { d && d(); },
    close() {} });
  try {
    usage.ingest(`a1@${TA}`, beat("a1", 1), NOW);
    usage.ingest(`b1@${TB}`, beat("b1", 1), NOW);
    usage.purgeTenant(TA);
    assert.deepEqual(forgot, [`a1@${TA}`]);
  } finally { usage._internals.reset(); }
});

// ---- permission ledger --------------------------------------------------------

const PNOW = Date.parse("2026-10-30T12:00:00Z");
const prow = (id, extra = {}) => ({ id, kind: "dialog", dialogKind: "permission", tool: "Bash",
  head: "npm test", openedAt: PNOW - 60000, closedAt: PNOW, waitedMs: 60000, answer: "allow",
  via: "terminal", ...extra });

test("XERK-2550: permission aggregates and kind totals read only their scope's hosts", () => {
  perms._internals.reset();
  perms.ingest(`a@${TA}`, [prow("1"), prow("2")], PNOW);
  perms.ingest(`b@${TB}`, [prow("1"), prow("2"), prow("3")], PNOW);
  perms.ingest("ops", [prow("1")], PNOW);
  const a = perms.aggregate({ now: PNOW, visible: onlyT(TA) });
  assert.equal(a.top[0].count, 2);
  assert.ok(a.recent.every((r) => r.host === `a@${TA}`));
  assert.equal(perms.aggregate({ now: PNOW, visible: onlyT("") }).top[0].count, 1);
  assert.equal(perms.aggregate({ now: PNOW }).top[0].count, 6, "unscoped = every row");
  assert.equal(perms.kindTotals(onlyT(TB)).dialog.count, 3);
  assert.equal(perms.kindTotals(onlyT("")).dialog.count, 1);
});

test("XERK-2550: a permission purge drops the tenant's hosts and deletes them in Postgres", async () => {
  perms._internals.reset();
  perms.ingest(`a@${TA}`, [prow("1")], PNOW);
  perms.ingest(`b@${TB}`, [prow("1")], PNOW);
  assert.deepEqual(perms.purgeTenant("x"), []);
  assert.deepEqual(perms.purgeTenant(TA), [`a@${TA}`]);
  assert.deepEqual([...perms._internals.hosts().keys()], [`b@${TB}`]);
  // The Postgres store: queued writes for the tenant go, then one suffix DELETE.
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push([sql, params]); return []; } };
  const store = new perms.PermissionLedgerPgStore(pool);
  store._schemaReady = true;
  store._queue.push([`a@${TA}`, "9", "1", "1", "{}"], [`b@${TB}`, "9", "1", "1", "{}"]);
  // A batch already in flight must land BEFORE the DELETE (QA: it landed after).
  let release;
  store._draining = new Promise((r) => { release = r; }).then(() => { queries.push(["INSERT in-flight", []]); });
  const purge = store.onPurgeTenant(TA);
  await new Promise((r) => setImmediate(r));
  assert.ok(!queries.some(([sql]) => /^DELETE/.test(sql)), "waits for the in-flight batch");
  store._queue.unshift([`a@${TA}`, "8", "1", "1", "{}"]);   // a failed batch put back
  release();
  await purge;
  assert.ok(queries.findIndex(([sql]) => /^INSERT/.test(sql)) < queries.findIndex(([sql]) => /^DELETE/.test(sql)));
  assert.deepEqual(store._queue.map((v) => v[0]), [`b@${TB}`]);
  const del = queries.find(([sql]) => /^DELETE/.test(sql));
  assert.ok(del && /right\(host, 33\) = \$1/.test(del[0]));
  assert.deepEqual(del[1], [`@${TA}`]);
  await store.close();
});

// ---- outcome ledger -----------------------------------------------------------

let seq = 0;
function live(host, cls, model, { outcome: o = "merged", at = Date.now() - 1000, site = "acme.atlassian.net" } = {}) {
  const id = `s${++seq}`;
  const r = outcome.sanitizeRow({ site, issue: `E-${seq}`, host, sid: id, cls, model,
    firstSeen: at, updatedAt: at, startedAt: at, repo: "Turma",
    prs: [{ url: `https://github.com/x/y/pull/${seq}`, state: o === "bad" ? "CLOSED" : "MERGED",
      mergedAt: at, mergeCommit: "c".repeat(40) }] });
  outcome._internals.rows().set(r.key, r);
  return r;
}
function shadow(of, host, model, verdict) {
  const r = outcome.sanitizeRow({ site: of.site, issue: of.issue, host, sid: `sh-${++seq}`,
    cls: of.cls, model, firstSeen: of.firstSeen, updatedAt: of.updatedAt, kind: "shadow",
    pairOf: of.key, shadowState: "graded", grade: { verdict } });
  outcome._internals.rows().set(r.key, r);
  return r;
}

test("XERK-2550: outcome groups, pairs and rates read only their scope", () => {
  outcome._internals.reset();
  const a = live(`h@${TA}`, "bug", "opus");
  shadow(a, `h2@${TA}`, "sonnet", "good");
  const b = live(`h@${TB}`, "bug", "opus");
  shadow(b, `h@${TB}`, "sonnet", "bad");
  live("ops", "bug", "opus", { outcome: "bad" });
  const va = outcome.aggregate({ visible: onlyT(TA) });
  assert.equal(va.groups.find((g) => g.model === "opus").sessions, 1);
  assert.deepEqual(va.pairs.map((p) => [p.model, p.graded, p.mOnlyFail]), [["sonnet", 1, 0]]);
  const vb = outcome.aggregate({ visible: onlyT(TB) });
  assert.deepEqual(vb.pairs.map((p) => [p.model, p.graded, p.mOnlyFail]), [["sonnet", 1, 1]]);
  assert.deepEqual(outcome.pairEvidence("bug", "sonnet", { visible: onlyT(TA) }), { graded: 1, mOnlyFail: 0 });
  assert.equal(outcome.liveRate("bug", "opus", { visible: onlyT("") }).bad, 1);
  assert.equal(outcome.liveRate("bug", "opus", { visible: onlyT(TA) }).bad, 0);
  assert.deepEqual([...outcome.tenants()].sort(), ["", TA, TB].sort());
});

test("XERK-2550: a shadow pair never spans two tenants, even if a row claims one", () => {
  outcome._internals.reset();
  const a = live(`h@${TA}`, "bug", "opus");
  shadow(a, `h@${TB}`, "haiku", "bad");   // a forged / legacy cross-tenant pair
  assert.deepEqual(outcome.aggregate({}).pairs, []);
  assert.deepEqual(outcome.aggregate({ visible: onlyT(TB) }).pairs, []);
  assert.deepEqual(outcome.pairEvidence("bug", "haiku"), { graded: 0, mOnlyFail: 0 });
});

test("XERK-2550: a defect report marks only its own tenant's rows of the org", () => {
  outcome._internals.reset();
  const a = live(`h@${TA}`, "bug", "opus");
  const b = live(`h@${TB}`, "bug", "opus");
  // Both rows merged with the same commit sha in the same org.
  const sha = "c".repeat(40);
  const report = { fix: "f".repeat(40), kind: "revert", at: Date.now(), fixPrs: [],
    introducers: [{ sha, prs: [] }] };
  outcome.attributeDefects([{ site: a.site, tenant: TB, reports: [report] }]);
  const rows = outcome._internals.rows();
  assert.ok(!rows.get(a.key).defects, "tenant A's row is untouched");
  assert.equal(rows.get(b.key).defects.length, 1);
  // An older caller (no tenant) reads as untenanted and marks neither.
  outcome.attributeDefects([{ site: a.site, reports: [{ ...report, fix: "e".repeat(40) }] }]);
  assert.ok(!rows.get(a.key).defects);
  assert.equal(rows.get(b.key).defects.length, 1);
});

test("XERK-2550: shadow candidates carry their tenant and the daily count is per scope", () => {
  outcome._internals.reset();
  const a = live(`h@${TA}`, "bug", "opus");
  live("ops", "bug", "opus");
  const c = outcome.shadowCandidates();
  assert.deepEqual(c.map((x) => x.tenant).sort(), ["", TA].sort());
  outcome.decideShadow(a.key, { sampled: true, at: Date.now(), id: "sh-0123456789abcdef", model: "sonnet", host: `h@${TA}` });
  assert.equal(outcome.shadowsDispatchedSince(0, Date.now(), onlyT(TA)), 1);
  assert.equal(outcome.shadowsDispatchedSince(0, Date.now(), onlyT("")), 0);
});

test("XERK-2550: the outcome purge drops every live and shadow row of the tenant", () => {
  outcome._internals.reset();
  const a = live(`h@${TA}`, "bug", "opus");
  shadow(a, `s@${TA}`, "sonnet", "good");
  const b = live(`h@${TB}`, "bug", "opus");
  const deleted = [];
  outcome._internals.setBackend({ onChange() {}, onDelete(keys) { deleted.push(...keys); },
    flush(d) { d && d(); }, close() {} });
  try {
    assert.deepEqual(outcome.purgeTenant(""), []);
    const gone = outcome.purgeTenant(TA);
    assert.equal(gone.length, 2);
    assert.deepEqual(deleted.sort(), gone.sort());
    assert.deepEqual([...outcome._internals.rows().keys()], [b.key]);
  } finally { outcome._internals.reset(); }
});

test("XERK-2550: past MAX_ROWS one tenant's rows never evict another tenant's in the same org", () => {
  outcome._internals.reset();
  // The org pass groups by (tenant, org): the busiest PAIR loses first.
  const { evict } = outcome._internals;
  const t0 = Date.now() - 10_000;
  for (let i = 0; i < 3; i++) live(`h@${TB}`, "bug", "opus", { at: t0 + i });
  const a = live(`h@${TA}`, "bug", "opus", { at: t0 - 5000 });   // the OLDEST row
  const max = outcome.MAX_ROWS;
  // Simulate the cap by filling B up to it.
  for (let i = 0; i < max - 3; i++) live(`x${i % 50}@${TB}`, "bug", "opus", { at: t0 + 10 + i });
  evict(Date.now());
  assert.ok(outcome._internals.rows().has(a.key), "tenant A's single row survives B's overflow");
  outcome._internals.reset();
});
