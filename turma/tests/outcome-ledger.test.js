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
  assert.equal(r.key, "acme.atlassian.net/ACME-1/h1/s1");
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
  // An unpinned session with nothing known reads "default".
  L._internals.reset();
  L.observe([obs({ model: null })], T0);
  assert.equal(only().model, "default");
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
  assert.equal(L._internals.rows().get("acme.atlassian.net/ACME-1/h1/s2").reopenedAt, undefined);
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
    obs({ issue: "../../etc" }), obs({ sid: "" }), obs({ site: "a/b" }), null, 7,
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
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
  L._internals.reset();
  const store = new L.OutcomeLedgerPgStore(pool);
  L._internals.setBackend(store);
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
  await store.close();
  L._internals.reset();
});
