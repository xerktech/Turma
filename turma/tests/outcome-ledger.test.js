"use strict";
// The outcome ledger (XERK-1839): the fold of ticket sessions into per-(class,
// model) outcomes, and its two backends. Own process — the module reads its file
// path at require time.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs.js");

const DIR = mkdtemp("turma-outcome-ledger-");
process.env.OUTCOME_LEDGER_FILE = path.join(DIR, "outcome-ledger.json");
process.env.OUTCOME_LEDGER_SAVE_MS = "10";
const L = require("../outcome-ledger.js");

const DAY = 86400000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function obs(extra = {}) {
  return {
    site: "acme.atlassian.net", issue: "ACME-1", host: "h1", sid: "s1", repo: "app",
    model: "opus", running: true, createdAt: "2026-10-01T00:00:00Z", prs: [],
    type: "Bug", statusCategory: "inprogress", ...extra,
  };
}
function only() {
  const rows = [...L._internals.rows().values()];
  assert.equal(rows.length, 1);
  return rows[0];
}

test("XERK-1839: a ticket session becomes one row with its class and model", () => {
  L._internals.reset();
  L.observe([obs()], T0);
  const r = only();
  assert.equal(r.key, JSON.stringify(["acme.atlassian.net", "ACME-1", "h1", "s1"]));
  assert.equal(r.cls, "bug");
  assert.equal(r.model, "opus");
  assert.equal(r.startedAt, T0);
  assert.deepEqual(L.outcomeOf(r, T0), { outcome: "pending", reason: "running" });
});

test("XERK-1839: the model that ANSWERED wins over the spawn alias, and sticks", () => {
  L._internals.reset();
  L.observe([obs({ model: "haiku", modelActual: "claude-sonnet-5-5" })], T0);
  assert.equal(only().model, "sonnet");
  // A later beat with no modelActual (a closed record) never reverts it to the alias.
  L.observe([obs({ model: "haiku", modelActual: undefined, running: false })], T0 + 1);
  assert.equal(only().model, "sonnet");
});

test("an unpinned or 'default' session reads as the model its host's default resolves to", () => {
  // Nothing known: the fleet's login default, never a "default" group.
  L._internals.reset();
  L.observe([obs({ model: null })], T0);
  assert.equal(only().model, "opus");
  // The host probed its default: that family wins, pinned "default" alike.
  L._internals.reset();
  L.observe([obs({ model: "default", modelDefault: "Default (Sonnet 5)" })], T0);
  assert.equal(only().model, "sonnet");
  L._internals.reset();
  L.observe([obs({ model: null, modelDefault: "Haiku 5" })], T0);
  assert.equal(only().model, "haiku");
  // A label naming no model falls back to Opus.
  L._internals.reset();
  L.observe([obs({ model: "default", modelDefault: "Default" })], T0);
  assert.equal(only().model, "opus");
  // A stored legacy "default" row folds into Opus on load.
  assert.equal(L.sanitizeRow({ site: "s.atlassian.net", issue: "ENG-1", host: "h", sid: "abc",
    model: "default", firstSeen: T0, updatedAt: T0 }).model, "opus");
});

test("XERK-1839: merged is pending inside the window and good once it passes clean", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://github.com/o/r/pull/1", state: "OPEN" }] })], T0);
  assert.equal(L.outcomeOf(only(), T0).reason, "PR open");
  L.observe([obs({ prs: [{ url: "https://github.com/o/r/pull/1", state: "MERGED" }] })], T0 + DAY);
  const r = only();
  assert.equal(r.prs[0].mergedAt, T0 + DAY);
  assert.equal(L.outcomeOf(r, T0 + 2 * DAY).outcome, "pending");
  assert.equal(L.outcomeOf(r, T0 + DAY + L.WINDOW_DAYS * DAY).outcome, "good");
  // MERGED is terminal: a stale later read never moves it back.
  L.observe([obs({ prs: [{ url: "https://github.com/o/r/pull/1", state: "OPEN" }] })], T0 + 3 * DAY);
  assert.equal(only().prs[0].state, "MERGED");
});

test("XERK-1839: a PR closed unmerged is bad; an undelivered or stale-closed session is neither", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://github.com/o/r/pull/2", state: "CLOSED" }] })], T0);
  assert.deepEqual(L.outcomeOf(only(), T0), { outcome: "bad", reason: "closed unmerged" });
  L._internals.reset();
  L.observe([obs({ running: false, closedAt: "2026-10-02T00:00:00Z" })], T0 + 2 * DAY);
  assert.equal(only().endedAt, T0 + DAY);
  assert.equal(L.outcomeOf(only(), T0 + 2 * DAY).outcome, "undelivered");
  L._internals.reset();
  L.observe([obs({ running: false, closeKind: "not-reproducible" })], T0);
  assert.equal(L.outcomeOf(only(), T0).outcome, "no-change");
});

test("XERK-1839: a ticket reopened after Done marks the session that worked it bad", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://github.com/o/r/pull/3", state: "MERGED" }] })], T0);
  L.observe([obs({ statusCategory: "done", running: false })], T0 + DAY);
  assert.equal(only().doneAt, T0 + DAY);
  L.observe([obs({ statusCategory: "todo", running: false })], T0 + 2 * DAY);
  const r = only();
  assert.equal(r.reopenedAt, T0 + 2 * DAY);
  assert.deepEqual(L.outcomeOf(r, T0 + 400 * DAY), { outcome: "bad", reason: "reopened" });
  // A session started AFTER the Done is the reopened work, not its cause.
  L.observe([obs({ sid: "s2", createdAt: "2026-10-05T00:00:00Z", statusCategory: "inprogress" })], T0 + 4 * DAY);
  assert.equal(L._internals.rows().get(JSON.stringify(["acme.atlassian.net", "ACME-1", "h1", "s2"])).reopenedAt, undefined);
});

test("XERK-1839: aggregates are fleet-wide; rows only for a named org", () => {
  L._internals.reset();
  L.observe([
    obs({ prs: [{ url: "https://github.com/o/r/pull/4", state: "CLOSED" }] }),
    obs({ site: "rival.atlassian.net", issue: "RIV-9", sid: "s9", host: "h2",
      prs: [{ url: "https://github.com/o/r/pull/5", state: "MERGED" }] }),
    obs({ sid: "s3", type: "Story", model: "sonnet" }),
  ], T0);
  const v = L.aggregate({ now: T0 });
  const bug = v.groups.find((g) => g.cls === "bug" && g.model === "opus");
  assert.deepEqual([bug.sessions, bug.bad, bug.pending, bug.reasons["closed unmerged"]], [2, 1, 1, 1]);
  assert.ok(v.groups.find((g) => g.cls === "story" && g.model === "sonnet"));
  assert.equal(v.rows, undefined, "no rows without an org");
  const acme = L.aggregate({ site: "acme.atlassian.net", withRows: true, now: T0 });
  assert.equal(acme.rows.length, 2);
  assert.ok(acme.rows.every((r) => r.site === "acme.atlassian.net" && r.outcome));
  assert.equal(acme.groups.find((g) => g.cls === "bug").sessions, 2, "groups stay fleet-wide");
});

test("XERK-1839: malformed observations are dropped, strings bounded", () => {
  L._internals.reset();
  L.observe([
    obs({ issue: "../../etc" }), obs({ sid: "" }), obs({ site: "" }), null, 7,
    obs({ sid: "ok", type: "Weird Type!!" + "x".repeat(200), model: "\u0007GPT-9 <b>",
      prs: [{ url: "javascript:alert(1)" }, { url: "https://x/pull/1", state: "BOGUS" }] }),
  ], T0);
  const r = only();
  assert.match(r.cls, /^[a-z0-9-]{1,40}$/);
  assert.match(r.model, /^[a-z0-9._-]{1,40}$/);
  assert.deepEqual(r.prs, [{ url: "https://x/pull/1" }]);
  assert.equal(L.workClass(""), "other");
  assert.equal(L.modelFamily("Claude Opus 4.8"), "opus");
});

test("XERK-1839: an unchanged sweep writes nothing; metrics carry no host or ticket", () => {
  L._internals.reset();
  assert.equal(L.observe([obs()], T0).length, 1);
  assert.equal(L.observe([obs()], T0 + 1000).length, 0);
  const m = L.metricsText(T0);
  assert.match(m, /^turma_model_outcomes\{class="bug",model="opus",outcome="pending"\} 1$/m);
  assert.match(m, /^# TYPE turma_model_outcomes gauge$/m);
  assert.doesNotMatch(m, /ACME-1|h1|acme/);
});

test("XERK-1839: the file backend round-trips through the whitelist", async () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://github.com/o/r/pull/6", state: "MERGED" }] })], T0);
  await new Promise((r) => L.flush(r));
  const before = only();
  const raw = JSON.parse(fs.readFileSync(process.env.OUTCOME_LEDGER_FILE, "utf8"));
  raw.rows.push({ junk: true }, { ...before, key: "forged", sid: "../x" });
  fs.writeFileSync(process.env.OUTCOME_LEDGER_FILE, JSON.stringify(raw));
  L._internals.load();
  assert.deepEqual(only(), before);
});

test("XERK-1839: the Postgres backend upserts monotone and rescans newest-wins", async () => {
  // A fake pool honouring the emitted SQL: key PK, update only when newer.
  const table = new Map();
  const pool = {
    health: "ready",
    async query(sql, params = []) {
      if (/^CREATE TABLE/.test(sql)) return [];
      if (/^INSERT/.test(sql)) {
        for (let i = 0; i < params.length; i += 3) {
          const [key, at, doc] = params.slice(i, i + 3);
          const cur = table.get(key);
          if (!cur || Number(at) >= Number(cur.updated_at)) table.set(key, { updated_at: at, doc });
        }
        return [];
      }
      if (/^SELECT doc/.test(sql)) return [...table.values()];
      if (/^DELETE/.test(sql)) { for (const k of params) table.delete(k); return []; }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
  L._internals.reset();
  const store = new L.OutcomeLedgerPgStore(pool);
  L._internals.setBackend(store);
  await store.rescan(T0);          // a fresh store folds nothing until it has loaded
  L.observe([obs()], T0);
  await store._drain();
  assert.equal(table.size, 1);
  // An older copy arriving late never reverts the table.
  const k = [...table.keys()][0];
  const stale = JSON.parse(table.get(k).doc);
  await pool.query("INSERT", [k, String(T0 - 5), JSON.stringify({ ...stale, model: "haiku" })]);
  assert.equal(JSON.parse(table.get(k).doc).model, "opus");
  // A promoted replica with an empty model rescans the table.
  L._internals.rows().clear();
  await store.rescan(T0);
  assert.equal(only().model, "opus");
  // Until a rescan has loaded the table, a sweep folds nothing.
  store.loaded = false;
  assert.equal(L.observe([obs({ sid: "s-late" })], T0 + 10).length, 0);
  store.loaded = true;
  // A row evicted from the model is deleted from the table too.
  L.observe([obs({ sid: "s-old" })], T0 - 400 * DAY);
  L.observe([obs({ sid: "s-new" })], T0 + 20);
  await store._drain();
  assert.ok(![...table.keys()].some((k) => k.includes("s-old")));
  await store.close();
  L._internals.reset();
});

test("XERK-1839: an Azure DevOps org (a '/' in its site key) is recorded", () => {
  L._internals.reset();
  L.observe([obs({ site: "dev.azure.com/myorg", issue: "123" })], T0);
  const r = only();
  assert.equal(r.site, "dev.azure.com/myorg");
  assert.equal(L.aggregate({ site: "dev.azure.com/myorg", withRows: true, now: T0 }).rows.length, 1);
});

test("XERK-1839: a mix of CLOSED and OPEN PRs is still pending, never bad", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://x/pull/1", state: "CLOSED" },
    { url: "https://x/pull/2", state: "OPEN" }] })], T0);
  assert.deepEqual(L.outcomeOf(only(), T0), { outcome: "pending", reason: "PR open" });
});

test("XERK-1839: Done is dated by the tracker, so a session begun after it is not 'reopened'", () => {
  L._internals.reset();
  // The ticket resolved on day 1; the board still shows Done when s2 starts on day 3.
  L.observe([obs({ sid: "s2", createdAt: "2026-10-04T00:00:00Z", statusCategory: "done",
    resolved: "2026-10-02T00:00:00Z" })], T0 + 3 * DAY);
  assert.equal(only().doneAt, T0 + DAY);
  L.observe([obs({ sid: "s2", createdAt: "2026-10-04T00:00:00Z", statusCategory: "inprogress" })], T0 + 4 * DAY);
  assert.equal(only().reopenedAt, undefined);
  assert.notEqual(L.outcomeOf(only(), T0 + 4 * DAY).reason, "reopened");
});

test("XERK-1839: one host or org churning sessions cannot evict the rest of the fleet", () => {
  L._internals.reset();
  const rival = Array.from({ length: 50 }, (_, i) => obs({ site: "rival.atlassian.net",
    issue: `RIV-${i}`, host: "good", sid: `r${i}`, prs: [{ url: "https://x/pull/1", state: "MERGED" }] }));
  L.observe(rival, T0);
  for (let round = 0; round < 5; round++) {
    L.observe(Array.from({ length: 4000 }, (_, i) => obs({ site: "evil.atlassian.net",
      issue: "EV-1", host: "evil", sid: `e${round}-${i}` })), T0 + round + 1);
  }
  const all = [...L._internals.rows().values()];
  assert.equal(all.filter((r) => r.site === "rival.atlassian.net").length, 50);
  assert.ok(all.filter((r) => r.host === "evil").length <= Math.floor(L.MAX_ROWS / 4));
});

test("XERK-1853: a host reporting more sessions than its cap stops churning its rows", () => {
  L._internals.reset();
  const per = Math.floor(L.MAX_ROWS / 4);
  const sweep = () => Array.from({ length: per + 10 }, (_, i) => obs({ host: "big", sid: `b${i}` }));
  const first = L.observe(sweep(), T0);
  assert.equal(first.length, per);
  const held = new Map([...L._internals.rows().values()].map((r) => [r.key, r.firstSeen]));
  // Nothing changed: no row is re-created, so none is upserted or deleted.
  assert.equal(L.observe(sweep(), T0 + 15000).length, 0);
  assert.equal(L.observe(sweep(), T0 + 30000).length, 0);
  const rows = [...L._internals.rows().values()];
  assert.equal(rows.length, per);
  for (const r of rows) assert.equal(r.firstSeen, held.get(r.key));
  // Just past the cap is over it too.
  L._internals.reset();
  const edge = () => Array.from({ length: per + 1 }, (_, i) => obs({ host: "edge", sid: `e${i}` }));
  L.observe(edge(), T0);
  assert.equal(L.observe(edge(), T0 + 15000).length, 0);
});

test("XERK-1853: a full host still records its current sessions over rows it stopped reporting", () => {
  L._internals.reset();
  const per = Math.floor(L.MAX_ROWS / 4);
  const old = Array.from({ length: per }, (_, i) => obs({ host: "h", sid: `old${i}` }));
  L.observe(old, T0);
  // Under its cap: a new session evicts the oldest row.
  L.observe([obs({ host: "h", sid: "fresh" })], T0 + 1);
  let rows = [...L._internals.rows().values()];
  assert.equal(rows.length, per);
  assert.ok(rows.some((r) => r.sid === "fresh"));
  assert.ok(!rows.some((r) => r.sid === "old0"));
  // Over its cap with only stale rows held: it fills with what it reports now.
  const now = Array.from({ length: per + 5 }, (_, i) => obs({ host: "h", sid: `new${i}` }));
  L.observe(now, T0 + 2);
  rows = [...L._internals.rows().values()];
  assert.equal(rows.length, per);
  assert.ok(rows.every((r) => r.sid.startsWith("new")));
  assert.equal(L.observe(now, T0 + 3).length, 0);
});

function recording() {
  const log = { changed: 0, deleted: 0 };
  L._internals.setBackend({ onChange: (l) => { log.changed += l.length; },
    onDelete: (k) => { log.deleted += k.length; }, flush() {}, close() {} });
  return log;
}

test("XERK-1855: past MAX_ROWS the fleet-wide cap stops re-creating rows hosts still report", () => {
  L._internals.reset();
  const log = recording();
  const per = Math.floor(L.MAX_ROWS / 4);
  const sweep = () => Array.from({ length: 5 * per }, (_, i) => obs({ host: `h${i % 5}`, sid: `s${i}` }));
  assert.equal(L.observe(sweep(), T0).length, L.MAX_ROWS);
  // The rows past the cap were never persisted, so nothing is deleted for them.
  assert.equal(log.changed, L.MAX_ROWS);
  assert.equal(log.deleted, 0);
  const held = new Map([...L._internals.rows().values()].map((r) => [r.key, r.firstSeen]));
  assert.equal(L.observe(sweep(), T0 + 15000).length, 0);
  assert.equal(L.observe(sweep(), T0 + 30000).length, 0);
  assert.deepEqual(log, { changed: L.MAX_ROWS, deleted: 0 });
  const rows = [...L._internals.rows().values()];
  assert.equal(rows.length, L.MAX_ROWS);
  for (const r of rows) assert.equal(r.firstSeen, held.get(r.key));
  L._internals.reset();
});

test("XERK-1855: orgs tied for the most rows lose a row created this sweep, not rotate one", () => {
  L._internals.reset();
  const log = recording();
  const base = Math.floor(L.MAX_ROWS / 3);
  const org = (o, n) => Array.from({ length: n }, (_, i) => obs({ site: `${o}.atlassian.net`,
    host: `${o}${i % 2}`, sid: `${o}${i}` }));
  L.observe([...org("a", base), ...org("b", base), ...org("c", base)], T0);
  L.observe([...org("a", base + 1), ...org("b", base), ...org("c", base)], T0 + 15000);
  // Three orgs tied past the cap: dropping a's held row would re-create it next sweep.
  const all = () => [...org("a", base + 1), ...org("b", base + 1), ...org("c", base + 1)];
  L.observe(all(), T0 + 30000);
  assert.equal(log.deleted, 0);
  const held = new Map([...L._internals.rows().values()].map((r) => [r.key, r.firstSeen]));
  assert.equal(held.size, L.MAX_ROWS);
  const before = { ...log };
  assert.equal(L.observe(all(), T0 + 45000).length, 0);
  assert.equal(L.observe(all(), T0 + 60000).length, 0);
  assert.deepEqual(log, before);
  for (const r of L._internals.rows().values()) assert.equal(r.firstSeen, held.get(r.key));
  L._internals.reset();
});

test("XERK-1855: a row deleted then re-created before the Postgres drain stays in the table", async () => {
  const table = new Map();
  const pool = {
    health: "ready",
    async query(sql, params = []) {
      if (/^CREATE TABLE/.test(sql)) return [];
      if (/^INSERT/.test(sql)) {
        for (let i = 0; i < params.length; i += 3) table.set(params[i], params[i + 2]);
        return [];
      }
      if (/^DELETE/.test(sql)) { for (const k of params) table.delete(k); return []; }
      throw new Error(sql);
    },
  };
  const store = new L.OutcomeLedgerPgStore(pool);
  const row = L.sanitizeRow({ site: "a.atlassian.net", issue: "A-1", host: "h", sid: "x",
    cls: "bug", model: "opus", firstSeen: T0, updatedAt: T0 });
  store._closed = true;              // queue both before either drains
  store.onDelete([row.key]);
  store.onChange([row]);
  store._closed = false;
  await store._drain();
  assert.ok(table.has(row.key));
  // And the reverse: re-created then deleted ends deleted.
  store._closed = true;
  store.onChange([row]);
  store.onDelete([row.key]);
  store._closed = false;
  await store._drain();
  assert.ok(!table.has(row.key));
});

test("XERK-1855: a full host drops a row it stopped reporting before one it still reports", () => {
  L._internals.reset();
  const per = Math.floor(L.MAX_ROWS / 4);
  const ids = (from, to) => Array.from({ length: to - from }, (_, i) => `s${from + i}`);
  L.observe(ids(0, per).map((sid) => obs({ host: "h", sid })), T0);
  // s0 ends — its row is now the most recently updated — while the rest run on.
  L.observe(ids(0, per).map((sid) => obs({ host: "h", sid, running: sid !== "s0" })), T0 + 15000);
  // The host stops reporting s0 and starts two more sessions.
  const now = ids(1, per + 2).map((sid) => obs({ host: "h", sid }));
  L.observe(now, T0 + 30000);
  const rows = new Map([...L._internals.rows().values()].map((r) => [r.sid, r]));
  assert.equal(rows.size, per);
  assert.ok(!rows.has("s0"));
  assert.equal(rows.get("s1").firstSeen, T0);
  assert.equal(L.observe(now, T0 + 45000).length, 0);
  assert.equal(rows.get("s1").firstSeen, L._internals.rows().get(rows.get("s1").key).firstSeen);
});

test("XERK-1839: /metrics label sets stay bounded whatever models the agents report", () => {
  L._internals.reset();
  L.observe(Array.from({ length: 300 }, (_, i) => obs({ sid: `m${i}`, modelActual: `local-model-${i}`,
    type: `Type${i}` })), T0);
  const lines = L.metricsText(T0).split("\n").filter((l) => l.startsWith("turma_model_outcomes{"));
  assert.ok(lines.length <= 21 * 5, `${lines.length} series`);
  assert.match(L.metricsText(T0), /model="other"/);
});

test("XERK-1839: past MAX_ROWS the org holding the most rows loses first, not the oldest rows", () => {
  L._internals.reset();
  // A small org's rows are the OLDEST; a big org's are newer. Eviction must still
  // take from the big org.
  const small = Array.from({ length: 10 }, (_, i) => obs({ site: "small.atlassian.net",
    issue: `S-${i}`, host: `sh${i}`, sid: `s${i}` }));
  L.observe(small, T0);
  const per = Math.floor(L.MAX_ROWS / 4);
  for (let h = 0; h < 5; h++) {
    L.observe(Array.from({ length: per }, (_, i) => obs({ site: "big.atlassian.net",
      issue: "B-1", host: `bh${h}`, sid: `b${h}-${i}` })), T0 + 1 + h);
  }
  const all = [...L._internals.rows().values()];
  assert.equal(all.length, L.MAX_ROWS);
  assert.equal(all.filter((r) => r.site === "small.atlassian.net").length, 10);
});

test("XERK-1839: a rescan resets the load gate, deletes what it evicts, and a failed one is retried", async () => {
  const table = new Map();
  let fail = false;
  let selects = 0;
  const pool = {
    health: "ready",
    async query(sql, params = []) {
      if (/^CREATE TABLE/.test(sql)) return [];
      if (/^SELECT doc/.test(sql)) {
        selects += 1;
        if (fail) throw new Error("postgres query timeout");
        return [...table.values()];
      }
      if (/^INSERT/.test(sql)) {
        for (let i = 0; i < params.length; i += 3) table.set(params[i], { updated_at: params[i + 1], doc: params[i + 2] });
        return [];
      }
      if (/^DELETE/.test(sql)) { for (const k of params) table.delete(k); return []; }
      throw new Error(sql);
    },
  };
  L._internals.reset();
  const store = new L.OutcomeLedgerPgStore(pool);
  L._internals.setBackend(store);
  // An expired row in the table is evicted by the rescan AND deleted from it.
  const oldRow = L.sanitizeRow({ site: "a.atlassian.net", issue: "A-1", host: "h", sid: "x",
    cls: "bug", model: "opus", firstSeen: T0 - 500 * DAY, updatedAt: T0 - 500 * DAY });
  table.set(oldRow.key, { updated_at: String(oldRow.updatedAt), doc: JSON.stringify(oldRow) });
  await store.rescan(T0);
  await store._drain();
  assert.equal(table.has(oldRow.key), false);
  assert.equal(store.loaded, true);
  // A failing rescan leaves the gate shut (it reset it first) ...
  fail = true;
  await store._onReady();
  assert.equal(store.loaded, false);
  assert.equal(L.observe([obs()], T0).length, 0);
  // The retry is throttled: a sweep inside RESCAN_RETRY_MS of the last one reads nothing.
  L.observe([obs()], T0 + 1000);
  await store._readyWork;
  const throttled = selects;
  L.observe([obs()], T0 + 2000);
  await store._readyWork;
  assert.equal(selects, throttled, "no second rescan inside the throttle window");
  // ... and a later sweep retries it once the database answers again.
  fail = false;
  const before = selects;
  L.observe([obs()], T0 + 120000);
  await store._readyWork;
  assert.ok(selects > before);
  assert.equal(store.loaded, true);
  await store.close();
  L._internals.reset();
});

test("XERK-1845: a PR's merge commit and the agent's merge time are kept", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "OPEN" }] })], T0);
  // First seen merged with no agent time: dated at the sighting...
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED" }] })], T0 + 5 * DAY);
  assert.equal(only().prs[0].mergedAt, T0 + 5 * DAY);
  // ...then the agent's real merge time (earlier) and commit replace it, past MERGED.
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED", mergedAt: "2026-10-02T00:00:00Z",
    mergeCommit: "0123456789ABCDEF" }] })], T0 + 6 * DAY);
  assert.equal(only().prs[0].mergedAt, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(only().prs[0].mergeCommit, "0123456789abcdef");
  // A later merge time never moves it, and a junk commit never lands.
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED", mergedAt: "2026-10-09T00:00:00Z",
    mergeCommit: "zz" }] })], T0 + 7 * DAY);
  assert.equal(only().prs[0].mergedAt, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(only().prs[0].mergeCommit, "0123456789abcdef");
});

test("XERK-1845: rework counters only rise and are reported beside the outcome", () => {
  L._internals.reset();
  const pr = (ci, cr) => [{ url: "https://x/pr/1", state: "OPEN", ciRounds: ci, changesRequested: cr }];
  L.observe([obs({ prs: pr(2, 1), qaRuns: [{ agent: "qa", verdict: "FAIL" }, { agent: "qa-delta", verdict: "PASS" }] })], T0);
  // A stale read (a closed record carrying less) never lowers anything.
  L.observe([obs({ prs: pr(1, 0), qaRuns: [{ agent: "qa", verdict: "FAIL" }] })], T0 + DAY);
  const r = only();
  assert.deepEqual([r.prs[0].ciRounds, r.prs[0].changesRequested], [2, 1]);
  assert.deepEqual(r.qa, { runs: 2, pass: 1, partial: 0, fail: 1 });
  // A second session with NO qa list (an older agent) is not counted as zero.
  L.observe([obs({ sid: "s2", prs: [] }), obs({ sid: "s3", qaRuns: [] })], T0 + DAY);
  const g = L.aggregate({ now: T0 + DAY }).groups[0];
  assert.deepEqual(g.rework.qaRuns, { median: 1, n: 2 });
  assert.deepEqual(g.rework.ciRounds, { median: 2, n: 1 });
  assert.equal(g.pending, 3, "rework never changes the outcome");
});

test("XERK-1845: junk counters and qa entries are dropped by the whitelist", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "OPEN", ciRounds: -1, changesRequested: "3" }],
    qaRuns: [{ agent: "x" }, "y", null] })], T0);
  const r = only();
  assert.ok(!("ciRounds" in r.prs[0]) && !("changesRequested" in r.prs[0]));
  assert.deepEqual(r.qa, { runs: 0, pass: 0, partial: 0, fail: 0 });
  // A stored row (file load / Postgres rescan) with a junk qa block drops it.
  assert.ok(!("qa" in L.sanitizeRow({ ...r, qa: { runs: "1", pass: 0, partial: 0, fail: 0 } })));
});

test("XERK-1845: a partial QA list is a floor, never served as the count", () => {
  L._internals.reset();
  L.observe([obs({ qaRuns: [{ agent: "qa", verdict: "PASS" }] }),
    obs({ sid: "s2", qaRuns: [], qaPartial: true })], T0);
  const g = L.aggregate({ now: T0 }).groups[0];
  assert.deepEqual(g.rework.qaRuns, { median: 1, n: 1 }, "the partial session is not a zero");
  // Partial is sticky: a later complete-looking beat cannot clear it.
  L.observe([obs({ sid: "s2", qaRuns: [{ agent: "qa", verdict: "FAIL" }] })], T0 + 1);
  const s2 = [...L._internals.rows().values()].find((r) => r.sid === "s2");
  assert.equal(s2.qa.incomplete, true);
});

test("XERK-1845: a merge time before the session started is junk; the commit is set once", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED", mergedAt: "1970-01-01T00:00:01Z",
    mergeCommit: "aaaaaaa" }] })], T0 + DAY);
  assert.equal(only().prs[0].mergedAt, T0 + DAY, "dated at the sighting, not 1970");
  assert.equal(L.outcomeOf(only(), T0 + DAY).outcome, "pending");
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED", mergeCommit: "bbbbbbb" }] })], T0 + 2 * DAY);
  assert.equal(only().prs[0].mergeCommit, "aaaaaaa");
});

test("XERK-1845: a future merge time is junk too", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED", mergedAt: "2027-10-01T00:00:00Z" }] })], T0 + DAY);
  assert.equal(only().prs[0].mergedAt, T0 + DAY);
  // ...and an earlier-than-sighting but still-future one never replaces it.
  L.observe([obs({ prs: [{ url: "https://x/pr/1", state: "MERGED", mergedAt: "2026-12-01T00:00:00Z" }] })], T0 + 2 * DAY);
  assert.equal(only().prs[0].mergedAt, T0 + DAY);
});

// ---- defect attribution (XERK-1846) ------------------------------------------------

const HEX = (c) => c.repeat(40);
const PR1 = "https://github.com/o/r/pull/1";
const FIXPR = "https://github.com/o/r/pull/9";
function mergedRow(extra = {}) {
  L.observe([obs({
    prs: [{ url: PR1, state: "MERGED", mergeCommit: HEX("a"), mergedAt: T0 + DAY }],
    ...extra,
  })], T0 + DAY);
}
function report(extra = {}) {
  return {
    repo: "r", fix: HEX("f"), fixPrs: [FIXPR], kind: "bug", ticket: "ACME-9", at: T0 + 5 * DAY,
    introducers: [{ sha: HEX("a"), prs: [] }], ...extra,
  };
}

test("XERK-1846: a later bug fix blaming a row's merge commit marks it bad, once", () => {
  L._internals.reset();
  mergedRow();
  L.attributeDefects([{ site: "acme.atlassian.net", reports: [report()] }], T0 + 6 * DAY);
  const r = only();
  assert.deepEqual(r.defects, [{ fix: HEX("f"), kind: "bug", at: T0 + 5 * DAY, prs: [FIXPR] }]);
  assert.deepEqual(L.outcomeOf(r, T0 + 6 * DAY), { outcome: "bad", reason: "defect" });
  // Re-sent every few minutes by the agent: idempotent.
  const changed = L.attributeDefects([{ site: "acme.atlassian.net", reports: [report()] }], T0 + 7 * DAY);
  assert.equal(changed.length, 0);
  assert.equal(only().defects.length, 1);
  // It is BAD in the served groups, with its reason, and survives a reload.
  const g = L.aggregate({ now: T0 + 7 * DAY }).groups[0];
  assert.equal(g.bad, 1);
  assert.equal(g.reasons.defect, 1);
  assert.deepEqual(L.sanitizeRow(JSON.parse(JSON.stringify(only()))).defects, only().defects);
});

test("XERK-1846: the forge's PR url joins too, and a revert reads 'reverted'", () => {
  L._internals.reset();
  mergedRow({ prs: [{ url: PR1, state: "MERGED", mergedAt: T0 + DAY }] }); // no merge sha
  L.attributeDefects([{ site: "acme.atlassian.net", reports: [report({
    kind: "revert", introducers: [{ sha: HEX("b"), prs: [PR1] }],
  })] }], T0 + 6 * DAY);
  assert.equal(L.outcomeOf(only(), T0 + 6 * DAY).reason, "reverted");
});

test("XERK-1846: another org's report, the fix's own PR, a pre-merge or out-of-window fix never mark", () => {
  const cases = [
    { site: "rival.atlassian.net", rep: report() },
    { site: "acme.atlassian.net", rep: report({ fixPrs: [PR1] }) },
    { site: "acme.atlassian.net", rep: report({ fix: HEX("a").replace(/a$/, "c"), at: T0 }) },
    { site: "acme.atlassian.net", rep: report({ at: T0 + DAY + (L.WINDOW_DAYS + 1) * DAY }) },
    // Unattributed: an introducer no row holds (human work, a direct push).
    { site: "acme.atlassian.net", rep: report({ introducers: [{ sha: HEX("d"), prs: ["https://github.com/o/r/pull/77"] }] }) },
  ];
  for (const c of cases) {
    L._internals.reset();
    mergedRow();
    L.attributeDefects([{ site: c.site, reports: [c.rep] }], T0 + 200 * DAY);
    assert.equal(only().defects, undefined, JSON.stringify(c));
  }
});

test("XERK-1846: an open or closed-unmerged PR is never an introducer", () => {
  L._internals.reset();
  L.observe([obs({ prs: [{ url: PR1, state: "OPEN" }] })], T0 + DAY);
  L.attributeDefects([{ site: "acme.atlassian.net", reports: [report({
    introducers: [{ sha: HEX("a"), prs: [PR1] }] })] }], T0 + 6 * DAY);
  assert.equal(only().defects, undefined);
});

test("XERK-1846: reports are whitelisted and capped", () => {
  const out = L.sanitizeDefectReports([
    report(),
    report({ kind: "nope" }),
    report({ fix: "abc" }),
    report({ introducers: [{ sha: HEX("f") }] }),            // the fix itself: dropped → no introducers
    report({ introducers: Array.from({ length: 9 }, (_, i) => ({ sha: String(i).repeat(40), prs: ["javascript:x", PR1] })) }),
    "junk",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].introducers.length, 5);
  assert.deepEqual(out[1].introducers[0].prs, [PR1]);
  assert.equal(L.sanitizeDefectReports(Array.from({ length: 80 }, () => report())).length, 50);
  assert.deepEqual(L.sanitizeDefectReports({}), []);
});

test("XERK-1846: nothing folds under HA until the table is loaded", () => {
  L._internals.reset();
  mergedRow();
  const b = L._internals.getBackend();
  L._internals.setBackend({ ...b, loaded: false });
  try {
    assert.equal(L.attributeDefects([{ site: "acme.atlassian.net", reports: [report()] }], T0 + 6 * DAY).length, 0);
  } finally {
    L._internals.setBackend(b);
  }
  assert.equal(only().defects, undefined);
});

// ---- shadow runs (XERK-1847) ----------------------------------------------------

const SHA = "0123456789abcdef0123456789abcdef01234567";
function mergedLive(extra = {}) {
  L.observe([obs({ running: false, prs: [{ url: "https://x/pr/1", state: "MERGED",
    mergedAt: "2026-10-02T00:00:00Z", mergeCommit: SHA }], ...extra })], T0 + 2 * DAY);
}

test("XERK-1847: a merged live row is a shadow candidate until decided, then never again", () => {
  L._internals.reset();
  mergedLive();
  const [c] = L.shadowCandidates({ now: T0 + 2 * DAY });
  assert.equal(c.mergeSha, SHA);
  assert.equal(c.repo, "app");
  assert.equal(c.cls, "bug");
  assert.equal(L.shadowCandidates({ now: T0 + 30 * DAY, maxAgeMs: 7 * DAY }).length, 0, "too old");
  assert.equal(L.decideShadow(c.key, { sampled: false, at: T0 + 2 * DAY }), true);
  assert.equal(L.shadowCandidates({ now: T0 + 2 * DAY }).length, 0);
  // A decision is final.
  assert.equal(L.decideShadow(c.key, { sampled: true, at: T0, id: "sh-0123456789ab" }), false);
  // A malformed decision is refused.
  L._internals.reset();
  mergedLive();
  assert.equal(L.decideShadow(only().key, { sampled: true, at: T0 }), false, "no id");
});

test("XERK-1847: only a hub-dispatched shadow's report lands, paired with its live row", () => {
  L._internals.reset();
  mergedLive();
  const live = only();
  L.decideShadow(live.key, { sampled: true, at: T0 + 2 * DAY, id: "sh-00112233aabb",
    model: "haiku", host: "h2" }, T0 + 2 * DAY);
  assert.equal(L.shadowsDispatchedSince(T0), 1);
  // Wrong host, wrong org, unknown id: all dropped.
  L.observeShadows([
    { site: "acme.atlassian.net", host: "h3", id: "sh-00112233aabb", state: "running" },
    { site: "evil.atlassian.net", host: "h2", id: "sh-00112233aabb", state: "running" },
    { site: "acme.atlassian.net", host: "h2", id: "sh-ffffffffffff", state: "running" },
  ], T0 + 3 * DAY);
  assert.equal(L._internals.rows().size, 1);
  L.observeShadows([{ site: "acme.atlassian.net", host: "h2", id: "sh-00112233aabb",
    state: "running", modelActual: "claude-haiku-5-5", startedAt: "2026-10-04T00:00:00Z" }], T0 + 3 * DAY);
  const sh = [...L._internals.rows().values()].find((r) => r.kind === "shadow");
  assert.equal(sh.pairOf, live.key);
  assert.equal(sh.model, "haiku");
  assert.equal(sh.shadowState, "running");
  // Shadow rows never feed the live groups.
  const agg = L.aggregate({ now: T0 + 3 * DAY });
  assert.equal(agg.groups.reduce((n, g) => n + g.sessions, 0), 1);
  assert.deepEqual(agg.pairs[0], { cls: "bug", model: "haiku", pairs: 1, graded: 0, shadowGood: 0,
    shadowBad: 0, mOnlyFail: 0, failed: 0 });
  // A bad grade against good-or-pending live work is an M-only failure, and final.
  L.observeShadows([{ site: "acme.atlassian.net", host: "h2", id: "sh-00112233aabb",
    grade: { verdict: "bad", tests: "FAIL", qa: "fail", design: "worse", note: "x\u0007y" } }], T0 + 4 * DAY);
  L.observeShadows([{ site: "acme.atlassian.net", host: "h2", id: "sh-00112233aabb",
    state: "running", grade: { verdict: "good" } }], T0 + 5 * DAY);
  const graded = [...L._internals.rows().values()].find((r) => r.kind === "shadow");
  assert.deepEqual(graded.grade, { verdict: "bad", tests: "fail", qa: "fail", design: "worse", note: "x y" });
  assert.equal(graded.shadowState, "graded");
  const p = L.aggregate({ now: T0 + 5 * DAY }).pairs[0];
  assert.equal(p.shadowBad, 1);
  assert.equal(p.mOnlyFail, 1);
  // ...and per group, as the XERK-1849 card reads it (a zero-session candidate group).
  const g = L.aggregate({ now: T0 + 5 * DAY }).groups.find((x) => x.model === "haiku");
  assert.equal(g.sessions, 0);
  assert.deepEqual([g.shadow.pairs, g.shadow.candidateOnlyBad], [1, 1]);
  // A row-level read serves the shadow with its grade as the outcome.
  const rows = L.aggregate({ site: "acme.atlassian.net", withRows: true, now: T0 + 5 * DAY }).rows;
  assert.equal(rows.find((r) => r.kind === "shadow").outcome, "bad");
  // Metrics carry live outcomes only.
  assert.doesNotMatch(L.metricsText(T0 + 5 * DAY), /model="haiku"/);
});

test("XERK-1847: shadow fields survive the whitelist round-trip and junk is dropped", () => {
  const live = L.sanitizeRow({ site: "a", issue: "A-1", host: "h", sid: "s", firstSeen: 1, updatedAt: 1,
    shadow: { sampled: true, at: 5, id: "sh-0011223344", model: "claude-sonnet-5", host: "h2" } });
  assert.deepEqual(live.shadow, { sampled: true, at: 5, id: "sh-0011223344", model: "sonnet", host: "h2" });
  assert.equal(L.sanitizeRow({ site: "a", issue: "A-1", host: "h", sid: "s", firstSeen: 1, updatedAt: 1,
    shadow: { sampled: "yes", at: 5 } }).shadow, undefined);
  const sh = L.sanitizeRow({ site: "a", issue: "A-1", host: "h", sid: "sh-0011223344", firstSeen: 1,
    updatedAt: 1, kind: "shadow", pairOf: "k", shadowState: "bogus", grade: { verdict: "meh" },
    shadow: { sampled: false, at: 1 } });
  assert.equal(sh.kind, "shadow");
  assert.equal(sh.shadowState, undefined);
  assert.equal(sh.grade, undefined);
  assert.equal(sh.shadow, undefined, "a shadow row never carries a decision");
});

test("XERK-1855: a shadow row on a host at its cap is not evicted and re-created each tick", () => {
  L._internals.reset();
  const log = recording();
  mergedLive();
  const live = only();
  L.decideShadow(live.key, { sampled: true, at: T0 + 2 * DAY, id: "sh-00112233aabb",
    model: "haiku", host: "h2" }, T0 + 2 * DAY);
  const per = Math.floor(L.MAX_ROWS / 4);
  const busy = () => Array.from({ length: per }, (_, i) => obs({ host: "h2", sid: `b${i}` }));
  const shadow = [{ site: "acme.atlassian.net", host: "h2", id: "sh-00112233aabb", state: "running" }];
  let t = T0 + 3 * DAY;
  L.observe(busy(), t);
  L.observeShadows(shadow, t);
  const sh = [...L._internals.rows().values()].find((r) => r.kind === "shadow");
  assert.ok(sh);
  const before = { ...log };
  for (let i = 0; i < 3; i++) {
    t += 15000;
    L.observe(busy(), t);
    L.observeShadows(shadow, t);
  }
  assert.deepEqual(log, before);
  assert.equal(L._internals.rows().get(sh.key).firstSeen, sh.firstSeen);
  L._internals.reset();
});

test("XERK-1855: more orgs than MAX_ROWS evict without throwing", () => {
  L._internals.reset();
  L.observe(Array.from({ length: L.MAX_ROWS + 3 }, (_, i) => obs({ site: `o${i}.atlassian.net`,
    host: `h${i % 8}`, sid: `s${i}` })), T0);
  assert.equal(L._internals.rows().size, L.MAX_ROWS);
  L._internals.reset();
});

test("XERK-1855: a failed in-flight DELETE does not undo a re-create queued behind it", async () => {
  const table = new Map();
  let release;
  let deletes = 0;
  const pool = {
    health: "ready",
    async query(sql, params = []) {
      if (/^CREATE TABLE/.test(sql)) return [];
      if (/^INSERT/.test(sql)) {
        for (let i = 0; i < params.length; i += 3) table.set(params[i], params[i + 2]);
        return [];
      }
      if (/^DELETE/.test(sql)) {
        deletes += 1;
        if (deletes === 1) { await new Promise((r) => { release = r; }); throw new Error("statement timeout"); }
        for (const k of params) table.delete(k);
        return [];
      }
      throw new Error(sql);
    },
  };
  const store = new L.OutcomeLedgerPgStore(pool);
  const row = L.sanitizeRow({ site: "a.atlassian.net", issue: "A-1", host: "h", sid: "x",
    cls: "bug", model: "opus", firstSeen: T0, updatedAt: T0 });
  store.onChange([row]);
  await store._drain();
  store.onDelete([row.key]);              // in flight, will fail
  await new Promise((r) => setImmediate(r));
  store.onChange([row]);                  // re-created while the DELETE is out
  release();
  await store._drain().catch(() => {});
  await store._drain();
  assert.ok(table.has(row.key));
  assert.equal(store._deletes.length, 0);
});

test("XERK-1855: an upsert queued behind an in-flight DELETE drains in the same pass", async () => {
  const table = new Map();
  let release = null;
  const pool = {
    health: "ready",
    async query(sql, params = []) {
      if (/^CREATE TABLE/.test(sql)) return [];
      if (/^INSERT/.test(sql)) {
        for (let i = 0; i < params.length; i += 3) table.set(params[i], params[i + 2]);
        return [];
      }
      if (/^DELETE/.test(sql)) {
        await new Promise((r) => { release = r; });
        for (const k of params) table.delete(k);
        return [];
      }
      throw new Error(sql);
    },
  };
  const store = new L.OutcomeLedgerPgStore(pool);
  const row = (sid) => L.sanitizeRow({ site: "a.atlassian.net", issue: "A-1", host: "h", sid,
    cls: "bug", model: "opus", firstSeen: T0, updatedAt: T0 });
  store.onDelete([row("gone").key]);
  const pass = store._drain();
  await new Promise((r) => setImmediate(r));
  store.onChange([row("new")]);
  release();
  await pass;
  assert.ok(table.has(row("new").key));
});
