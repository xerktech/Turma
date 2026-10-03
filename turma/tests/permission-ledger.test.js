// XERK-1563 — the permission ledger: ingest bounds (sanitizePermissionEvent), the
// rolling aggregates, the deterministic suggestedRule table, org scoping by host
// set, the non-HA file backend, and the HA Postgres append table.
//
// There is no live Postgres in CI (the pgclient.test.js / usage-ledger-store.test.js
// constraint), so the HA backend is driven against an in-memory FAKE PgPool that
// recognises exactly the statements the store emits — the real store's logic runs
// end to end; only the wire is host-QA-only.

"use strict";

const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp } = require("./tmpdirs");

const dir = mkdtemp("turma-test-permledger-");
process.env.PERMISSION_LEDGER_FILE = path.join(dir, "permission-ledger.json");
process.env.PERMISSION_LEDGER_MAX_ROWS = "40";
process.env.PERMISSION_LEDGER_HOST_MAX_ROWS = "30";

const ledger = require("../permission-ledger.js");
const { sanitizePermissionEvent: sanitize, suggestedRule, aggregate } = ledger;

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MIN = 60000;
const DAY = 86400000;

function row(id, extra = {}) {
  return { id, kind: "dialog", dialogKind: "permission", tool: "Bash", head: "npm test",
    openedAt: NOW - MIN, closedAt: NOW, waitedMs: MIN, answer: "allow", via: "terminal",
    ...extra };
}

test.beforeEach(() => ledger._internals.reset());

// ---- ingest bounds ----------------------------------------------------------

test("sanitize: whitelists, caps and enums every field", () => {
  const got = sanitize({
    ...row("d-1"), sessionId: "s1", extra: "dropped", prompt: "x".repeat(5000),
    tool: "T".repeat(999), head: "h\nforged line", options: ["Yes", 7, "No", ..."abcdefghij"],
    rulesMatched: ["Bash(npm test:*)"], answerNumber: 2,
  }, NOW);
  assert.equal(got.extra, undefined);
  assert.equal(got.prompt.length, 300);
  assert.equal(got.tool.length, 128);
  assert.equal(got.head, "h forged line");              // a control char can't forge a line
  assert.deepEqual(got.options.slice(0, 2), ["Yes", "No"]);
  assert.equal(got.options.length, 9);
  assert.equal(got.answerNumber, 2);
  assert.equal(got.sessionId, "s1");
});

test("sanitize: a wrong-typed field reads as can't-tell, never a plausible value", () => {
  const got = sanitize({ ...row("d-1"), answer: "yes", via: "phone", dialogKind: "weird",
    waitedMs: -5, closedAt: NOW - DAY, answerNumber: 12, sessionId: "../x" }, NOW);
  assert.equal(got.answer, undefined);
  assert.equal(got.via, undefined);
  assert.equal(got.dialogKind, "other");
  assert.equal(got.waitedMs, undefined);
  assert.equal(got.closedAt, undefined);      // before openedAt
  assert.equal(got.answerNumber, undefined);
  assert.equal(got.sessionId, undefined);
});

test("sanitize: refuses what cannot be a row", () => {
  for (const bad of [null, [], "x", { id: "a" }, { ...row("d-1"), kind: "other" },
    { ...row("bad id!") }, { ...row("d-1"), openedAt: "1" },
    { ...row("d-1"), openedAt: Infinity }, { ...row("d-1"), openedAt: NOW + 2 * DAY },
    { ...row("d-1"), openedAt: 0 }]) {
    assert.equal(sanitize(bad, NOW), null, JSON.stringify(bad));
  }
  // dialogKind exists only on a dialog row.
  assert.equal(sanitize({ ...row("c-1"), kind: "classifier-denied" }, NOW).dialogKind, undefined);
});

test("ingest: a row id seen again REPLACES the stored row (open, then closed)", () => {
  ledger.ingest("h1", [{ id: "d-1", kind: "dialog", openedAt: NOW - MIN }], NOW);
  ledger.ingest("h1", [row("d-1")], NOW);
  const m = ledger._internals.hosts().get("h1");
  assert.equal(m.size, 1);
  assert.equal(m.get("d-1").answer, "allow");
});

test("ingest: at most EVENTS_PER_BEAT rows a beat; junk hosts refused", () => {
  const many = Array.from({ length: ledger.EVENTS_PER_BEAT + 50 }, (_, i) =>
    row(`x${i}`, { openedAt: NOW - i }));
  // The per-host cap (30 here) still bounds what is kept — the beat cap bounds work.
  assert.equal(ledger.ingest("h1", many, NOW), ledger.EVENTS_PER_BEAT);
  assert.equal(ledger.ingest("__proto__", [row("a")], NOW), 0);
  assert.equal(ledger.ingest("h1", "nope", NOW), 0);
});

test("eviction: retention, the per-host share, then the store cap — oldest first", () => {
  ledger.ingest("old", [row("ancient", { openedAt: NOW - (ledger.DAYS + 1) * DAY })], NOW - (ledger.DAYS + 1) * DAY);
  ledger.ingest("h1", Array.from({ length: 35 }, (_, i) => row(`a${i}`, { openedAt: NOW - 1000 + i })), NOW);
  assert.equal(ledger._internals.hosts().get("h1").size, ledger.HOST_MAX_ROWS);
  assert.equal(ledger._internals.hosts().has("old"), false);       // aged out
  assert.equal(ledger._internals.hosts().get("h1").has("a0"), false); // oldest went
  ledger.ingest("h2", Array.from({ length: 20 }, (_, i) => row(`b${i}`, { openedAt: NOW - 500 + i })), NOW);
  assert.equal(ledger._internals.rowCount(), ledger.MAX_ROWS);
  // The store-wide eviction took h1's oldest, not h2's fresh rows.
  assert.equal(ledger._internals.hosts().get("h2").size, 20);
});

// ---- aggregates + suggestedRule ---------------------------------------------

test("aggregate: groups by (kind, tool, head) with counts, answers, median wait", () => {
  ledger.ingest("h1", [
    row("1", { waitedMs: 1000 }), row("2", { waitedMs: 3000, answer: "deny" }),
    row("3", { waitedMs: 9000 }),
    row("4", { kind: "classifier-denied", dialogKind: undefined, head: "git push",
      denyReason: "push is outside scope", answer: "deny", waitedMs: undefined }),
    row("5", { openedAt: NOW - 9 * DAY }),                      // outside 7 days
  ], NOW);
  const { top, recent } = aggregate({ now: NOW });
  const npm = top.find((g) => g.head === "npm test" && g.kind === "dialog");
  assert.deepEqual([npm.count, npm.allowed, npm.denied, npm.medianWaitMs], [3, 2, 1, 3000]);
  assert.equal(npm.suggestedRule, "Bash(npm test:*)");
  assert.equal(top[0], npm);                                  // most frequent first
  assert.equal(recent.length, 4);
  assert.equal(recent[0].host, "h1");
  assert.equal(aggregate({ now: NOW, days: 30 }).recent.length, 5);
});

test("aggregate: scoped by host set — another org's host never counts", () => {
  ledger.ingest("acme-1", [row("1")], NOW);
  ledger.ingest("rival-1", [row("2"), row("3")], NOW);
  assert.equal(aggregate({ now: NOW, hosts: new Set(["acme-1"]) }).top[0].count, 1);
  assert.equal(aggregate({ now: NOW, hosts: new Set() }).top.length, 0);
  assert.equal(aggregate({ now: NOW }).top[0].count, 3);
});

test("suggestedRule: the deterministic table", () => {
  const cases = [
    [{ kind: "dialog", dialogKind: "permission", tool: "Bash", head: "npm test" }, "Bash(npm test:*)"],
    [{ kind: "dialog", tool: "mcp__github__create_issue", head: "mcp__github__create_issue" },
      "mcp__github__create_issue"],
    [{ kind: "dialog", tool: "WebFetch", head: "docs.example.com" }, "WebFetch(domain:docs.example.com)"],
    [{ kind: "dialog", dialogKind: "sandbox", tool: "Bash", head: "registry.npmjs.org" },
      "sandbox.network.allowedDomains: registry.npmjs.org"],
    [{ kind: "classifier-denied", tool: "Bash", head: "git push" },
      "autoMode.environment: allow Bash(git push:*)"],
    [{ kind: "classifier-denied", tool: "Edit", head: "/x", denyReason: "Writing outside the repo. Refused" },
      "autoMode.environment: allow Writing outside the repo"],
    [{ kind: "ask-in-chat" }, "model behaviour: see CLAUDE.md step 0"],
    [{ kind: "dialog", dialogKind: "plan", tool: "ExitPlanMode", head: "ExitPlanMode" }, null],
    [{ kind: "dialog", tool: "Edit", head: "/repo/a.py" }, null],
    [{ kind: "dialog", tool: "WebFetch", head: "not a host" }, null],
    [{ kind: "dialog", dialogKind: "sandbox", tool: "Bash", head: "npm" }, "Bash(npm:*)"],
  ];
  for (const [g, want] of cases) assert.equal(suggestedRule(g), want, JSON.stringify(g));
});

test("kindTotals: per-kind counts and summed waits for /metrics", () => {
  ledger.ingest("h1", [row("1", { waitedMs: 2000 }), row("2", { waitedMs: 3000 }),
    { id: "a1", kind: "ask-in-chat", openedAt: NOW - MIN }], NOW);
  const t = ledger.kindTotals();
  assert.deepEqual(t.dialog, { count: 2, waitMs: 5000 });
  assert.deepEqual(t["ask-in-chat"], { count: 1, waitMs: 0 });
  assert.deepEqual(t["classifier-denied"], { count: 0, waitMs: 0 });
});

// ---- the non-HA file backend ------------------------------------------------

test("file backend: flush writes, load restores and re-sanitizes", async () => {
  ledger.ingest("h1", [row("1"), row("2")], Date.now());
  await new Promise((r) => ledger.flush(r));
  const raw = JSON.parse(fs.readFileSync(ledger.LEDGER_FILE, "utf8"));
  assert.equal(raw.hosts.h1.length, 2);
  // A hand-edited row with junk is dropped on restore, the rest kept.
  raw.hosts.h1.push({ id: "bad id", kind: "dialog", openedAt: 1 });
  raw.hosts.__proto__ = [];
  fs.writeFileSync(ledger.LEDGER_FILE, JSON.stringify(raw));
  ledger._internals.load();
  assert.equal(ledger._internals.rowCount(), 2);
});

test("file backend: an unreadable file starts empty, never throws", () => {
  fs.writeFileSync(ledger.LEDGER_FILE, "{not json");
  ledger._internals.load();
  assert.equal(ledger._internals.rowCount(), 0);
});

// ---- the HA Postgres append table -------------------------------------------

class FakePgPool {
  constructor() { this.rows = new Map(); this.sql = []; this.health = "ready"; }
  onHealth() { return () => {}; }
  ready() { return Promise.resolve(); }
  query(text, params = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    this.sql.push(sql);
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(sql)) return Promise.resolve([]);
    let m = /^INSERT INTO "permission_event" \(host, id, opened_at, doc\) VALUES (.*) ON CONFLICT \(host, id\) DO UPDATE SET opened_at = EXCLUDED\.opened_at, doc = EXCLUDED\.doc$/.exec(sql);
    if (m) {
      for (let i = 0; i < params.length; i += 4) {
        const [host, id, openedAt, doc] = params.slice(i, i + 4);
        assert.equal(typeof openedAt, "string");             // text protocol
        this.rows.set(`${host}\u0000${id}`, { host, id, opened_at: openedAt, doc });
      }
      return Promise.resolve([]);
    }
    m = /^SELECT host, doc FROM "permission_event" WHERE opened_at >= \$1 ORDER BY opened_at DESC LIMIT \$2$/.exec(sql);
    if (m) {
      const since = Number(params[0]);
      return Promise.resolve([...this.rows.values()]
        .filter((r) => Number(r.opened_at) >= since)
        .sort((a, b) => Number(b.opened_at) - Number(a.opened_at))
        .slice(0, Number(params[1]))
        .map((r) => ({ host: r.host, doc: r.doc })));
    }
    m = /^DELETE FROM "permission_event" WHERE opened_at < \$1$/.exec(sql);
    if (m) {
      for (const [k, r] of this.rows) if (Number(r.opened_at) < Number(params[0])) this.rows.delete(k);
      return Promise.resolve([]);
    }
    throw new Error(`FakePgPool: unrecognised SQL: ${sql}`);
  }
}

test("HA: configure swaps in the Postgres append table; rows upsert by (host, id)", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  assert.ok(ledger._internals.getBackend() instanceof ledger.PermissionLedgerPgStore);
  const now = Date.now();
  ledger.ingest("h1", [{ id: "d-1", kind: "dialog", openedAt: now - MIN }], now);
  ledger.ingest("h1", [row("d-1", { openedAt: now - MIN, closedAt: now })], now);
  await new Promise((r) => ledger.flush(r));
  assert.equal(pool.rows.size, 1);                            // the closed row replaced the open one
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-1").doc).answer, "allow");
});

test("HA: rehydrate (leader promotion) loads the retained window into the hot model", async () => {
  const pool = new FakePgPool();
  const now = Date.now();
  const put = (host, r) => pool.rows.set(`${host}\u0000${r.id}`,
    { host, id: r.id, opened_at: String(r.openedAt), doc: JSON.stringify(r) });
  put("h1", row("a", { openedAt: now - MIN }));
  put("h2", row("b", { openedAt: now - 2 * MIN }));
  put("h2", { ...row("junk"), kind: "nope" });               // re-sanitized: dropped
  pool.rows.set("h3\u0000x", { host: "h3", id: "x", opened_at: String(now), doc: "{not json" });
  await ledger.configure({ ha: true }, pool);                 // ready edge scans
  ledger._internals.hosts().clear();
  await ledger.rehydrate();
  assert.equal(ledger._internals.rowCount(), 2);
  assert.equal(aggregate({ now }).top[0].count, 2);
});

test("HA: the retention sweep deletes rows past PERMISSION_LEDGER_DAYS", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  pool.rows.set("h1\u0000old", { host: "h1", id: "old",
    opened_at: String(now - (ledger.DAYS + 1) * DAY), doc: "{}" });
  pool.rows.set("h1\u0000new", { host: "h1", id: "new", opened_at: String(now), doc: "{}" });
  await ledger._internals.getBackend().sweep(now);
  assert.deepEqual([...pool.rows.keys()], ["h1\u0000new"]);
});

test("HA: a failed write is logged and dropped, never thrown into the beat", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  pool.query = (t) => (/^INSERT/.test(t) ? Promise.reject(new Error("pg down")) : Promise.resolve([]));
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    assert.equal(ledger.ingest("h1", [row("1", { openedAt: Date.now() })]), 1);
    await new Promise((r) => ledger.flush(r));
  } finally { console.error = orig; }
  assert.ok(errs.some((m) => /Postgres write failed/.test(m)));
  assert.equal(ledger._internals.rowCount(), 1);              // the hot model kept it
});

test("HA off: configure is a no-op, the file backend stays", async () => {
  await ledger.configure({ ha: false }, new FakePgPool());
  await ledger.configure(null, null);
  assert.equal(ledger._internals.getBackend().constructor.name, "Object");
});
