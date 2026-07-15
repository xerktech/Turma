// Unit tests for the /board page's pure core (public/board.js): the cross-host
// merge of agents' `jira` heartbeat blocks (freshest-block-wins per site+user,
// issue-key dedupe across users), category/column mapping, org color
// stability, and the HTML builders' escaping. node:test, no npm — matches this
// package's zero-dependency stance, same pattern as chat.test.js.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeSites, categoryOf, ticketSort, orgColor, ageStr, prioClass,
  cardHtml, boardHtml,
} = require("../public/board.js");

function ticket(key, over = {}) {
  return {
    key,
    url: `https://myorg.atlassian.net/browse/${key}`,
    summary: "do the thing",
    status: "In Review",
    statusCategory: "inprogress",
    priority: "High",
    type: "Bug",
    project: key.split("-")[0],
    labels: [],
    updated: "2026-07-14T10:00:00.000+0000",
    ...over,
  };
}

function agent(device, jira, over = {}) {
  return { key: device, device, online: true, jira, ...over };
}

function block(over = {}) {
  return {
    available: true,
    site: "myorg.atlassian.net",
    siteKey: "myorg.atlassian.net",
    user: "me@x.com",
    fetchedAt: "2026-07-14T12:00:00Z",
    error: null,
    truncated: false,
    tickets: [],
    ...over,
  };
}

test("mergeSites: freshest block wins for the same site+user (never unioned)", () => {
  // Host A polled last at 12:00 with only T-2 (T-1 was closed/reassigned in
  // between); host B still carries an 11:00 block that includes T-1. A union
  // would resurrect T-1 — the fresh block must win outright.
  const sites = mergeSites([
    agent("hostA", block({ fetchedAt: "2026-07-14T12:00:00Z", tickets: [ticket("T-2")] })),
    agent("hostB", block({ fetchedAt: "2026-07-14T11:00:00Z", tickets: [ticket("T-1"), ticket("T-2")] })),
  ]);
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].tickets.map((t) => t.key), ["T-2"]);
  assert.deepEqual(sites[0].hosts, ["hostA", "hostB"]);
  assert.equal(sites[0].lastFetched, "2026-07-14T12:00:00Z");
});

test("mergeSites: different users on one site union, deduped by issue key", () => {
  // Two hosts poll the same org as DIFFERENT users; a ticket can be returned
  // to both (e.g. moved between them mid-window) — one copy survives, the one
  // with the newer `updated`.
  const shared = ticket("S-1", { updated: "2026-07-14T09:00:00.000+0000" });
  const fresher = ticket("S-1", { updated: "2026-07-14T11:00:00.000+0000", status: "Done", statusCategory: "done" });
  const sites = mergeSites([
    agent("hostA", block({ user: "a@x.com", fetchedAt: "2026-07-14T12:00:00Z", tickets: [shared, ticket("S-2")] })),
    agent("hostB", block({ user: "b@x.com", fetchedAt: "2026-07-14T11:30:00Z", tickets: [fresher, ticket("S-3")] })),
  ]);
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].users, ["a@x.com", "b@x.com"]);
  const keys = sites[0].tickets.map((t) => t.key).sort();
  assert.deepEqual(keys, ["S-1", "S-2", "S-3"]);
  const s1 = sites[0].tickets.find((t) => t.key === "S-1");
  assert.equal(s1.statusCategory, "done", "newer `updated` copy wins the collision");
});

test("mergeSites: separate sites stay separate boards, sorted by siteKey", () => {
  const sites = mergeSites([
    agent("hostA", block({ siteKey: "zeta.atlassian.net", tickets: [ticket("Z-1")] })),
    agent("hostB", block({ siteKey: "alpha.atlassian.net", tickets: [ticket("A-1")] })),
  ]);
  assert.deepEqual(sites.map((s) => s.siteKey), ["alpha.atlassian.net", "zeta.atlassian.net"]);
});

test("mergeSites: offline reporters mark the site stale; error/truncated roll up", () => {
  const sites = mergeSites([
    agent("hostA", block({ error: "410 Gone", truncated: true }), { online: false }),
    agent("hostB", block({ siteKey: "other.atlassian.net" }), { online: true }),
  ]);
  const stale = sites.find((s) => s.siteKey === "myorg.atlassian.net");
  assert.equal(stale.online, false);
  assert.equal(stale.error, "410 Gone");
  assert.equal(stale.truncated, true);
  assert.equal(sites.find((s) => s.siteKey === "other.atlassian.net").online, true);
});

test("mergeSites: skips agents with no jira block or no siteKey (unconfigured)", () => {
  const sites = mergeSites([
    { key: "bare", device: "bare", online: true },
    agent("off", { available: false, siteKey: null, tickets: [] }),
    agent("on", block({ tickets: [ticket("T-1")] })),
  ]);
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].hosts, ["on"]);
});

test("categoryOf: maps the three categories, defaults unknown to todo", () => {
  assert.equal(categoryOf({ statusCategory: "todo" }), "todo");
  assert.equal(categoryOf({ statusCategory: "inprogress" }), "inprogress");
  assert.equal(categoryOf({ statusCategory: "done" }), "done");
  assert.equal(categoryOf({ statusCategory: "???" }), "todo");
  assert.equal(categoryOf({}), "todo");
  assert.equal(categoryOf(null), "todo");
});

test("ticketSort: newest updated first", () => {
  const list = [ticket("A", { updated: "2026-07-01T00:00:00Z" }),
                ticket("B", { updated: "2026-07-10T00:00:00Z" })];
  assert.deepEqual(list.sort(ticketSort).map((t) => t.key), ["B", "A"]);
});

test("orgColor: stable slot regardless of list order, wraps past 8", () => {
  const keys = ["b.net", "a.net", "c.net"];
  assert.equal(orgColor("a.net", keys), "var(--s1)");
  assert.equal(orgColor("b.net", keys), "var(--s2)");
  assert.equal(orgColor("b.net", [...keys].reverse()), "var(--s2)", "order-independent");
  const many = Array.from({ length: 9 }, (_, i) => `s${i}.net`);
  assert.equal(orgColor("s8.net", many), "var(--s1)", "9th key wraps to slot 1");
});

test("ageStr: human ages from ISO timestamps (Jira's +0000 offset included)", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  assert.equal(ageStr("2026-07-14T11:59:30.000+0000", now), "now");
  assert.equal(ageStr("2026-07-14T11:10:00.000+0000", now), "50m");
  assert.equal(ageStr("2026-07-14T03:00:00.000+0000", now), "9h");
  assert.equal(ageStr("2026-07-10T12:00:00.000+0000", now), "4d");
  assert.equal(ageStr("2026-06-01T12:00:00.000+0000", now), "6w");
  assert.equal(ageStr("garbage", now), "");
  assert.equal(ageStr(null, now), "");
});

test("prioClass: highest/high hot, low/lowest muted, else neutral", () => {
  assert.equal(prioClass("Highest"), "prio-high");
  assert.equal(prioClass("High"), "prio-high");
  assert.equal(prioClass("Medium"), "");
  assert.equal(prioClass("Low"), "prio-low");
  assert.equal(prioClass(null), "");
});

test("cardHtml: escapes untrusted text, links the key, flags overdue", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const t = ticket("X-1", {
    summary: 'evil <img src=x onerror=alert(1)> "quote"',
    status: "In <b>Review</b>",
    dueDate: "2026-07-01",
  });
  const html = cardHtml(t, { siteKey: "myorg.atlassian.net" }, { now });
  assert.ok(!html.includes("<img"), "summary HTML is escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("<b>Review</b>"), "status HTML is escaped");
  assert.ok(html.includes(`href="https://myorg.atlassian.net/browse/X-1"`));
  assert.ok(html.includes("overdue"), "past due date flagged");
});

test("cardHtml: done tickets are not overdue", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const t = ticket("X-2", { statusCategory: "done", dueDate: "2026-07-01" });
  assert.ok(!cardHtml(t, { siteKey: "s" }, { now }).includes("overdue"));
});

test("boardHtml: three columns with counts, org filter scopes tickets", () => {
  const sites = mergeSites([
    agent("hostA", block({ tickets: [
      ticket("T-1", { statusCategory: "todo" }),
      ticket("T-2", { statusCategory: "inprogress" }),
      ticket("T-3", { statusCategory: "done" }),
    ] })),
    agent("hostB", block({ siteKey: "other.atlassian.net", user: "b@x.com",
                           tickets: [ticket("O-1", { statusCategory: "todo" })] })),
  ]);
  const all = boardHtml(sites, null, {});
  assert.ok(all.includes("T-1") && all.includes("O-1"));
  assert.equal((all.match(/kanban-col[ "]/g) || []).length, 3);
  const one = boardHtml(sites, "other.atlassian.net", {});
  assert.ok(one.includes("O-1") && !one.includes("T-1"));
});

test("boardHtml: surfaces per-site poll errors and truncation notes", () => {
  const sites = mergeSites([
    agent("hostA", block({ error: "HTTP 401", truncated: true, tickets: [ticket("T-1")] })),
  ]);
  const html = boardHtml(sites, null, {});
  assert.ok(html.includes("last poll failed"));
  assert.ok(html.includes("HTTP 401"));
  assert.ok(html.includes("truncated"));
});
