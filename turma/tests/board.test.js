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
  cardHtml, boardHtml, detailHtml, textHtml, linkify,
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

// ---- expanded ticket detail -------------------------------------------------

function detail(over = {}) {
  return {
    key: "X-1",
    url: "https://myorg.atlassian.net/browse/X-1",
    summary: "do the thing",
    status: "In Review",
    statusCategory: "inprogress",
    priority: "High",
    type: "Bug",
    project: "X",
    projectName: "Project X",
    labels: ["backend"],
    updated: "2026-07-14T10:00:00.000+0000",
    created: "2026-07-01T10:00:00.000+0000",
    description: "why it matters",
    descriptionTruncated: false,
    reporter: "Ada",
    assignee: "Grace",
    comments: [],
    commentTotal: 0,
    ...over,
  };
}

test("cardHtml: the card is a clickable detail trigger carrying its issue+org", () => {
  const html = cardHtml(ticket("X-1"), { siteKey: "myorg.atlassian.net" }, {});
  assert.ok(html.includes(`data-key="X-1"`));
  assert.ok(html.includes(`data-site="myorg.atlassian.net"`));
  assert.ok(html.includes(`role="button"`) && html.includes(`tabindex="0"`));
  // The link out to Jira must survive — the click handler defers to it.
  assert.ok(html.includes(`class="kc-key" href="https://myorg.atlassian.net/browse/X-1"`));
});

test("detailHtml: before the fetch lands, renders the card's fields and a loading note", () => {
  const html = detailHtml(ticket("X-1"), null, { siteKey: "s" });
  assert.ok(html.includes("do the thing"), "summary shows immediately");
  assert.ok(html.includes("In Review"));
  assert.ok(/Loading description and comments/.test(html));
  assert.ok(!html.includes("No description"), "absent detail is not an empty description");
});

test("detailHtml: renders every detail field once fetched", () => {
  const html = detailHtml(ticket("X-1"), detail({
    resolution: "Fixed",
    parentKey: "X-9",
    parentSummary: "the epic",
    dueDate: "2026-08-01",
    labels: ["backend", "api"],
  }), { siteKey: "s", now: Date.parse("2026-07-14T12:00:00Z") });
  for (const expected of ["Assignee", "Grace", "Reporter", "Ada", "Resolution",
                          "Fixed", "Project X", "X-9", "the epic", "backend",
                          "api", "why it matters", "2026-08-01"]) {
    assert.ok(html.includes(expected), `missing ${expected}`);
  }
});

test("detailHtml: the fetched copy wins over the card's older heartbeat fields", () => {
  const stale = ticket("X-1", { status: "To Do", priority: "Low", summary: "old title" });
  const html = detailHtml(stale, detail({ status: "In Review", priority: "High", summary: "new title" }), {});
  assert.ok(html.includes("In Review") && !html.includes("To Do"));
  assert.ok(html.includes("new title") && !html.includes("old title"));
});

test("detailHtml: escapes every untrusted field — summary, description, comments, labels", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = detailHtml(ticket("X-1", { summary: evil }), detail({
    summary: evil,
    description: evil,
    assignee: evil,
    labels: [evil],
    comments: [{ id: "1", author: evil, body: evil, created: "2026-07-02T10:00:00Z" }],
    commentTotal: 1,
  }), { siteKey: evil, color: evil });
  assert.ok(!html.includes("<img"), "no unescaped markup anywhere in the panel");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("detailHtml: comments render newest-visible with the count and an older-in-Jira note", () => {
  const html = detailHtml(ticket("X-1"), detail({
    commentTotal: 25,
    comments: [
      { id: "1", author: "Ada", body: "first", created: "2026-07-02T10:00:00Z", updated: "2026-07-02T10:00:00Z" },
      { id: "2", author: "Grace", body: "second", created: "2026-07-03T10:00:00Z", updated: "2026-07-03T10:00:00Z" },
    ],
  }), { now: Date.parse("2026-07-04T10:00:00Z") });
  assert.ok(html.includes("Ada") && html.includes("first"));
  assert.ok(html.includes("Grace") && html.includes("second"));
  assert.ok(html.includes("25"), "the full comment count is shown");
  assert.ok(/23 older in Jira/.test(html), "says what it dropped");
});

test("detailHtml: empty description and comments say so rather than rendering blank", () => {
  const html = detailHtml(ticket("X-1"), detail({ description: "", comments: [], commentTotal: 0 }));
  assert.ok(html.includes("No description."));
  assert.ok(html.includes("No comments."));
});

test("detailHtml: truncation is surfaced, not silent", () => {
  const html = detailHtml(ticket("X-1"), detail({
    descriptionTruncated: true,
    comments: [{ id: "1", author: "A", body: "cut", truncated: true }],
    commentTotal: 1,
  }));
  assert.ok(/Description truncated/.test(html));
  assert.ok(/Comment truncated/.test(html));
});

test("detailHtml: a failed fetch explains itself and offers Jira, keeping the card's fields", () => {
  const html = detailHtml(ticket("X-1"), null, { error: "HTTP 404" });
  assert.ok(html.includes("HTTP 404"));
  assert.ok(html.includes("Open in Jira"));
  assert.ok(html.includes("do the thing"), "what we already knew still shows");
  assert.ok(!/Loading/.test(html), "error replaces the loading state");
});

test("detailHtml: an error string is escaped too", () => {
  const html = detailHtml(ticket("X-1"), null, { error: "<script>x</script>" });
  assert.ok(!html.includes("<script>"));
});

test("detailHtml: always offers a way out to Jira, and a close control", () => {
  const html = detailHtml(ticket("X-1"), detail(), { siteKey: "s" });
  assert.ok(html.includes(`href="https://myorg.atlassian.net/browse/X-1"`));
  assert.ok(html.includes("td-close"));
});

test("textHtml: blank lines split paragraphs, single newlines break lines", () => {
  const html = textHtml("one\ntwo\n\nthree");
  assert.equal(html, "<p>one<br>two</p><p>three</p>");
  assert.equal(textHtml(""), "");
  assert.equal(textHtml(null), "");
});

test("textHtml: escapes before linkifying, so markup can't ride in on a URL", () => {
  const html = textHtml('<b>x</b> https://ex.com/"onmouseover="alert(1)');
  assert.ok(!html.includes("<b>"), "markup escaped");
  assert.ok(!html.includes('onmouseover="'), "no attribute can be injected via the href");
  assert.ok(html.includes("&quot;"));
});

test("linkify: links bare URLs, leaving trailing punctuation outside the href", () => {
  assert.equal(
    linkify("see https://ex.com/a"),
    'see <a href="https://ex.com/a" target="_blank" rel="noopener">https://ex.com/a</a>'
  );
  // A sentence-final period belongs to the sentence, not the URL.
  const dotted = linkify("see https://ex.com/a.");
  assert.ok(dotted.endsWith("</a>."), dotted);
  const paren = linkify("(https://ex.com/a)");
  assert.ok(paren.endsWith("</a>)"), paren);
  assert.equal(linkify("no links here"), "no links here");
});

test("linkify: an escaped entity right after a URL is not swallowed into the href", () => {
  // textHtml escapes first, so `https://ex.com/a&amp;b` must not link the entity
  // fragment as if it were part of the path in a way that breaks the anchor.
  const html = textHtml('go to https://ex.com/a "now"');
  assert.ok(html.includes('href="https://ex.com/a"'), html);
  assert.ok(!html.includes('href="https://ex.com/a&quot;'), "the escaped quote stays out of the href");
});
