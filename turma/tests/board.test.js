// Unit tests for the /board page's pure core (public/board.js): the cross-host
// merge of agents' `jira` heartbeat blocks (freshest-block-wins per site+user,
// issue-key dedupe across users), category/column mapping, org color
// stability, and the HTML builders' escaping. node:test, no npm — matches this
// package's zero-dependency stance, same pattern as chat.test.js.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeSites, categoryOf, isReviewStatus, ticketSort, orgColor, orgName, autoStartState, ageStr, prioClass,
  cardHtml, boardHtml, detailHtml, textHtml, linkify,
  newestFetchedAt, jiraRefreshPending, jiraRefreshFailed,
  repoChipHtml, repoFieldHtml, repoPickerHtml, repoPickerValue,
  agentPinOf, agentFieldHtml, agentPickerHtml, agentPickerValue,
  ticketSessionIndex, ticketSessionsOf, sessionChipHtml, ticketStartHtml,
  startSweepVerdict,
} = require("../public/board.js");

function ticket(key, over = {}) {
  return {
    key,
    url: `https://myorg.atlassian.net/browse/${key}`,
    summary: "do the thing",
    status: "In Progress",
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
  assert.equal(categoryOf({ statusCategory: "inprogress", status: "In Progress" }), "inprogress");
  assert.equal(categoryOf({ statusCategory: "done" }), "done");
  assert.equal(categoryOf({ statusCategory: "???" }), "todo");
  assert.equal(categoryOf({}), "todo");
  assert.equal(categoryOf(null), "todo");
});

test("categoryOf: review/testing statuses split out of inprogress into review", () => {
  // These all live in Jira's `indeterminate` category (agent-mapped to
  // inprogress); the column is carved out by the status NAME.
  for (const name of ["In Review", "Review", "Code Review", "Reviewing",
                      "Testing", "In Test", "Ready for Test", "QA"]) {
    assert.equal(categoryOf({ statusCategory: "inprogress", status: name }),
      "review", `"${name}" -> review`);
  }
});

test("categoryOf: only inprogress splits — a done/todo review-named status is left", () => {
  // "Testing complete"/"Test failed" etc. keep whatever category Jira assigned.
  assert.equal(categoryOf({ statusCategory: "done", status: "Tested" }), "done");
  assert.equal(categoryOf({ statusCategory: "todo", status: "Needs Review" }), "todo");
  // Unknown category defaults to todo even with a review-ish name.
  assert.equal(categoryOf({ statusCategory: "???", status: "In Review" }), "todo");
});

test("isReviewStatus: matches on word boundaries, no substring leaks", () => {
  assert.ok(isReviewStatus({ status: "In Review" }));
  assert.ok(isReviewStatus({ status: "Testing" }));
  assert.ok(!isReviewStatus({ status: "In Progress" }));
  assert.ok(!isReviewStatus({ status: "Attestation" }), "'test' inside a word doesn't match");
  assert.ok(!isReviewStatus({ status: "Contested" }), "'test' inside a word doesn't match");
  assert.ok(!isReviewStatus({ status: "" }));
  assert.ok(!isReviewStatus({}));
  assert.ok(!isReviewStatus(null));
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

test("orgName: the org, not the Jira Cloud host", () => {
  assert.equal(orgName("myorg.atlassian.net"), "myorg");
  assert.equal(orgName("MyOrg.Atlassian.Net"), "MyOrg", "case-insensitive suffix");
  // Only the Jira Cloud suffix goes: on any other host the whole host is the
  // org's name there, and a site merely CONTAINING the suffix keeps it.
  assert.equal(orgName("jira.example.com"), "jira.example.com");
  assert.equal(orgName("atlassian.net.example.com"), "atlassian.net.example.com");
  // A host with no Jira reports no siteKey — the empty string the dashboard
  // renders as no org suffix at all.
  assert.equal(orgName(null), "");
  assert.equal(orgName(undefined), "");
  // Azure DevOps siteKeys carry an org/collection PATH; the last segment is the
  // readable org (XERK-43) — the host alone would name every unrelated org alike.
  assert.equal(orgName("dev.azure.com/myorg"), "myorg");
  assert.equal(orgName("tfs.company.com/tfs/DefaultCollection"), "DefaultCollection");
});

test("autoStartState: the org-chip switch reflects hub toggle OR a legacy agent env", () => {
  const site = "acme.atlassian.net";
  const envAgent = { online: true, ticketAutoStart: true, jira: { siteKey: site } };
  const plainAgent = { online: true, ticketAutoStart: false, jira: { siteKey: site } };

  // Off by default: no hub toggle, no env.
  assert.deepEqual(autoStartState([plainAgent], {}, site),
    { on: false, hubOn: false, envForced: false });

  // The hub toggle alone turns it on and is not locked.
  assert.deepEqual(autoStartState([plainAgent], { [site]: true }, site),
    { on: true, hubOn: true, envForced: false });

  // A legacy env on an ONLINE host forces it on and locks it (can't clear from
  // the hub), even with the hub toggle off.
  assert.deepEqual(autoStartState([envAgent], {}, site),
    { on: true, hubOn: false, envForced: true });

  // An OFFLINE host's stale env flag drives nothing — matches orgsWithAutoStart.
  const offlineEnv = { online: false, ticketAutoStart: true, jira: { siteKey: site } };
  assert.deepEqual(autoStartState([offlineEnv], {}, site),
    { on: false, hubOn: false, envForced: false });

  // Another org's env doesn't leak across siteKeys.
  assert.deepEqual(autoStartState([envAgent], {}, "other.atlassian.net"),
    { on: false, hubOn: false, envForced: false });

  // Tolerates missing inputs.
  assert.deepEqual(autoStartState(undefined, undefined, site),
    { on: false, hubOn: false, envForced: false });
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

test("boardHtml: four columns with counts, org filter scopes tickets", () => {
  const sites = mergeSites([
    agent("hostA", block({ tickets: [
      ticket("T-1", { status: "To Do", statusCategory: "todo" }),
      ticket("T-2", { status: "In Progress", statusCategory: "inprogress" }),
      ticket("T-3", { status: "In Review", statusCategory: "inprogress" }),
      ticket("T-4", { status: "Done", statusCategory: "done" }),
    ] })),
    agent("hostB", block({ siteKey: "other.atlassian.net", user: "b@x.com",
                           tickets: [ticket("O-1", { status: "To Do", statusCategory: "todo" })] })),
  ]);
  const all = boardHtml(sites, null, {});
  assert.ok(all.includes("T-1") && all.includes("O-1"));
  assert.equal((all.match(/kanban-col[ "]/g) || []).length, 4);
  assert.ok(all.includes("In Review"), "the In Review column heading renders");
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
  assert.ok(html.includes("In Progress"));
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

// --- Manual refresh (the /board Refresh button's completion signals) --------

test("newestFetchedAt: the watermark is the newest block across the fleet", () => {
  assert.equal(newestFetchedAt([
    agent("hostA", block({ fetchedAt: "2026-07-14T11:00:00Z" })),
    agent("hostB", block({ fetchedAt: "2026-07-14T12:00:00Z" })),
    agent("hostC", block({ fetchedAt: "2026-07-14T10:00:00Z" })),
  ]), "2026-07-14T12:00:00Z");
});

test("newestFetchedAt: degrades to '' for empty/never-polled/jira-less fleets", () => {
  // "" is the click-time mark on a cold board; every real fetchedAt sorts
  // above it, so the first poll to land still reads as an advance.
  assert.equal(newestFetchedAt([]), "");
  assert.equal(newestFetchedAt(undefined), "");
  assert.equal(newestFetchedAt([{ key: "bare", device: "bare" }]), "");
  assert.equal(newestFetchedAt([agent("hostA", block({ fetchedAt: null }))]), "");
  assert.ok(newestFetchedAt([agent("hostA", block())]) > "");
});

test("jiraRefreshPending: true only while a targeted host holds an unacked refreshJira", () => {
  const pendingHost = agent("hostA", block(), {
    commands: [{ type: "refreshJira", cmdId: "c1" }],
  });
  const idleHost = agent("hostB", block(), { commands: [] });

  assert.equal(jiraRefreshPending([pendingHost, idleHost], ["hostA", "hostB"]), true);
  assert.equal(jiraRefreshPending([idleHost], ["hostB"]), false);
  // The hub drops the command once the agent acks it -> the refresh is done.
  assert.equal(jiraRefreshPending([agent("hostA", block(), { commands: [] })], ["hostA"]), false);
});

test("jiraRefreshPending: ignores untargeted hosts and unrelated commands", () => {
  // Another dashboard's prune, or a refresh on a host this click didn't target,
  // must not hold this button busy.
  const other = agent("hostZ", block(), { commands: [{ type: "refreshJira", cmdId: "c9" }] });
  assert.equal(jiraRefreshPending([other], ["hostA"]), false);

  const busyElsewhere = agent("hostA", block(), {
    commands: [{ type: "prune", repo: "Turma", cmdId: "c2" }],
  });
  assert.equal(jiraRefreshPending([busyElsewhere], ["hostA"]), false);
});

test("jiraRefreshFailed: only when EVERY targeted host errored", () => {
  // The regression a browser run caught: one permanently-broken host (a host
  // whose creds/site are wrong, say) must not label a refresh that updated the
  // rest of the fleet as a failure.
  const okHost = agent("hostA", block({ error: null }));
  const badHost = agent("hostB", block({ error: "HTTP Error 503" }));

  assert.equal(jiraRefreshFailed([okHost, badHost], ["hostA", "hostB"]), false);
  assert.equal(jiraRefreshFailed([badHost], ["hostB"]), true);
  assert.equal(jiraRefreshFailed([okHost], ["hostA"]), false);
  // Only the targeted hosts count — an untargeted host's error is not ours.
  assert.equal(jiraRefreshFailed([okHost, badHost], ["hostA"]), false);
  assert.equal(jiraRefreshFailed([okHost, badHost], ["hostB"]), true);
});

test("jiraRefreshFailed: no targeted host on record is not a failure", () => {
  // Nothing to judge yet (records not arrived) must not read as failure.
  assert.equal(jiraRefreshFailed([], ["hostA"]), false);
  assert.equal(jiraRefreshFailed(undefined, ["hostA"]), false);
  assert.equal(jiraRefreshFailed([agent("hostA", block())], []), false);
  // A targeted host with no jira block at all isn't an error either.
  assert.equal(jiraRefreshFailed([{ key: "hostA", device: "hostA" }], ["hostA"]), false);
});

test("jiraRefreshPending: tolerates missing commands/garbage entries", () => {
  assert.equal(jiraRefreshPending([agent("hostA", block())], ["hostA"]), false);
  assert.equal(jiraRefreshPending([null, undefined], ["hostA"]), false);
  assert.equal(jiraRefreshPending([agent("hostA", block(), { commands: [null] })], ["hostA"]), false);
  assert.equal(jiraRefreshPending([], ["hostA"]), false);
});

// ---- triaged repo chip ------------------------------------------------------
// The agent guesses which repo a ticket's work belongs in (hub-agent.py's
// "Jira -> repo triage") and stamps it on the ticket as `repoGuess`. These
// assert the three states stay visually distinguishable, since the whole value
// of the chip is that "ready to work in", "clone it first", and "no repo fits"
// are different answers.

test("repoChipHtml: a cloned repo reads as a plain, actionable chip", () => {
  const html = repoChipHtml(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, reason: "board code lives there" },
  }));
  assert.ok(html.includes(">Turma<"));
  assert.ok(html.includes(`class="kc-repo"`), "cloned repos get no modifier class");
  assert.ok(html.includes("board code lives there"), "the why rides as a tooltip");
});

test("repoChipHtml: an uncloned repo is marked as needing a clone first", () => {
  const html = repoChipHtml(ticket("X-1", {
    repoGuess: { repo: "Widget", cloned: false, nameWithOwner: "xerktech/Widget" },
  }));
  assert.ok(html.includes("kc-repo-uncloned"));
  assert.ok(html.includes("not cloned on this host"));
});

test("repoChipHtml: a declined ticket says so rather than naming a repo", () => {
  const html = repoChipHtml(ticket("X-1", { repoGuess: { repo: null, cloned: false } }));
  assert.ok(html.includes("kc-repo-none"));
  assert.ok(html.includes(">no repo<"));
});

test("repoChipHtml: an untriaged ticket gets no chip at all", () => {
  // "Not looked at yet" is NOT the same claim as "no repo fits" — a ticket the
  // agent hasn't reached must not render as though the model rejected it.
  assert.equal(repoChipHtml(ticket("X-1")), "");
  assert.equal(repoChipHtml(ticket("X-1", { repoGuess: null })), "");
  assert.equal(repoChipHtml({}), "");
  assert.equal(repoChipHtml(null), "");
});

test("cardHtml: the repo chip rides the card, before the org chip", () => {
  const html = cardHtml(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, reason: "" },
  }), { siteKey: "myorg.atlassian.net" }, {});
  assert.ok(html.includes("kc-repo"));
  // kc-org is margin-left:auto, so anything after it would be pushed off the
  // right edge of the meta row.
  assert.ok(html.indexOf("kc-repo") < html.indexOf("kc-org"));
});

test("cardHtml: an untriaged card is unchanged", () => {
  assert.ok(!cardHtml(ticket("X-1"), { siteKey: "s" }, {}).includes("kc-repo"));
});

test("repoChipHtml: escapes a hostile repo name and reason", () => {
  // The name is allowlisted agent-side, but the chip must not be the only thing
  // standing between a compromised heartbeat and script execution.
  const html = repoChipHtml(ticket("X-1", {
    repoGuess: {
      repo: '<img src=x onerror=alert(1)>',
      cloned: true,
      reason: '"><script>alert(1)</script>',
    },
  }));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
});

test("repoFieldHtml: the detail panel spells out what the chip implied", () => {
  const html = repoFieldHtml(ticket("X-1", {
    repoGuess: {
      repo: "Widget", cloned: false, nameWithOwner: "xerktech/Widget",
      reason: "the widget API",
    },
  }));
  assert.ok(html.includes("Widget"));
  assert.ok(html.includes("xerktech/Widget"));
  assert.ok(html.includes("not cloned on this host"));
  assert.ok(html.includes("the widget API"));
});

test("repoFieldHtml: declined and untriaged stay distinct", () => {
  // The panel has room to say which it is, so unlike the card chip (which draws
  // nothing at all for an untriaged ticket) it states both — but it must never
  // report "not looked at yet" as the verdict "nothing fits".
  const declined = repoFieldHtml(ticket("X-1", { repoGuess: { repo: null } }));
  const untriaged = repoFieldHtml(ticket("X-1"));
  assert.ok(declined.includes("No repository fits"));
  assert.ok(untriaged.includes("Not triaged yet"));
  assert.ok(!untriaged.includes("No repository fits"));
});

test("repoFieldHtml: a manual pin says so instead of borrowing a rationale", () => {
  const html = repoFieldHtml(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, reason: "stale model reason", manual: true },
  }));
  assert.ok(html.includes("set by you"));
  assert.ok(!html.includes("stale model reason"));
});

test("repoFieldHtml: the Change control appears only when a host can take it", () => {
  const t = ticket("X-1", { repoGuess: { repo: "Turma", cloned: true } });
  assert.ok(repoFieldHtml(t, { editable: true }).includes("data-repo-edit"));
  assert.ok(!repoFieldHtml(t, { editable: false }).includes("data-repo-edit"));
});

test("repoPickerHtml: only a manual pin preselects a repo", () => {
  const opts = [{ name: "Turma", cloned: true }, { name: "Widget", cloned: false }];
  // An auto guess of Turma means the operator's setting is "let it decide" —
  // preselecting Turma would turn a Save meant as "leave it" into a pin.
  const auto = repoPickerHtml(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, manual: false },
  }), opts);
  assert.ok(/<option value="__auto__" selected>/.test(auto));
  assert.ok(!/<option value="Turma" selected>/.test(auto));

  const pinned = repoPickerHtml(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, manual: true },
  }), opts);
  assert.ok(/<option value="Turma" selected>/.test(pinned));
  assert.ok(!/<option value="__auto__" selected>/.test(pinned));

  const none = repoPickerHtml(ticket("X-1", {
    repoGuess: { repo: null, manual: true },
  }), opts);
  assert.ok(/<option value="__none__" selected>/.test(none));
});

test("repoPickerHtml: cloned and uncloned repos are offered, in separate groups", () => {
  const html = repoPickerHtml(ticket("X-1"), [
    { name: "Turma", cloned: true }, { name: "Widget", cloned: false, nameWithOwner: "x/Widget" },
  ]);
  assert.ok(html.includes('<optgroup label="Cloned">'));
  assert.ok(html.includes('<optgroup label="Not cloned">'));
  assert.ok(html.includes('value="Turma"'));
  assert.ok(html.includes('value="Widget"'));
  assert.ok(html.includes("x/Widget"));
  // Both non-repo answers are real options: "nothing fits" and "let the model
  // decide" are different claims and the agent acts on them differently.
  assert.ok(html.includes('value="__auto__"'));
  assert.ok(html.includes('value="__none__"'));
});

test("repoPickerHtml: a pin whose repo left the options stays selected", () => {
  // The regression this guards: with nothing selected the browser falls back to
  // its FIRST option — "Let the agent decide" — so the picker misreported the
  // pin, and an untouched Save silently released it. `_apply_triage` keeps
  // rendering such a repo on purpose, so this state is reachable by design.
  const html = repoPickerHtml(ticket("X-1", {
    repoGuess: { repo: "legacy-api", cloned: false, manual: true },
  }), [{ name: "Turma", cloned: true }]);
  assert.ok(/<option value="legacy-api" selected>/.test(html));
  assert.ok(!/<option value="__auto__" selected>/.test(html));
  assert.ok(html.includes('<optgroup label="Currently set">'));
});

test("repoPickerHtml: an auto guess whose repo left the options doesn't get carried in", () => {
  // Only a pin is preselected, so there's nothing to preserve — the current
  // setting really is "let it decide".
  const html = repoPickerHtml(ticket("X-1", {
    repoGuess: { repo: "legacy-api", cloned: false, manual: false },
  }), [{ name: "Turma", cloned: true }]);
  assert.ok(/<option value="__auto__" selected>/.test(html));
  assert.ok(!html.includes("legacy-api"));
});

test("repoPickerHtml: choosing an option is the save — there is no Save button", () => {
  // The regression: the picker used to need a separate Save, so selecting a repo
  // and clicking away (the ordinary way to leave a ticket) discarded the choice
  // silently and the row snapped back to the model's guess. The dropdown is the
  // setting; picking IS answering. Cancel stays as the way out for someone who
  // opened it by mistake.
  const html = repoPickerHtml(ticket("X-1"), [{ name: "Turma", cloned: true }]);
  assert.ok(!html.includes("data-repo-save"));
  assert.ok(html.includes("data-repo-select"));
  assert.ok(html.includes("data-repo-cancel"));
});

test("repoPickerValue: the picker's current answer, as the handler reads it", () => {
  // The handler saves only what CHANGED against this, so it has to agree with
  // what repoPickerHtml preselects — hence one function serving both.
  assert.equal(repoPickerValue(ticket("X-1")), "__auto__");
  // An auto guess is the model's answer; the operator's setting is still "auto",
  // so re-picking "let the agent decide" must not fire a pin.
  assert.equal(repoPickerValue(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, manual: false },
  })), "__auto__");
  assert.equal(repoPickerValue(ticket("X-1", {
    repoGuess: { repo: "Turma", cloned: true, manual: true },
  })), "Turma");
  assert.equal(repoPickerValue(ticket("X-1", {
    repoGuess: { repo: null, manual: true },
  })), "__none__");
});

test("repoPickerValue: agrees with what the picker preselects", () => {
  // Drift here is what would make a re-pick of the shown value read as a change
  // (a needless fleet command) — or a real change read as a re-pick, and get
  // silently dropped, which is the very bug this control just came out of.
  const opts = [{ name: "Turma", cloned: true }, { name: "Widget", cloned: false }];
  for (const g of [null,
                   { repo: "Turma", cloned: true, manual: false },
                   { repo: "Turma", cloned: true, manual: true },
                   { repo: "legacy-api", cloned: false, manual: true },  // left the options
                   { repo: null, manual: true }]) {
    const t = ticket("X-1", g ? { repoGuess: g } : {});
    const html = repoPickerHtml(t, opts);
    const selected = /<option value="([^"]*)" selected>/.exec(html);
    assert.ok(selected, `nothing preselected for ${JSON.stringify(g)}`);
    assert.equal(selected[1], repoPickerValue(t));
  }
});

// ---- ticket -> agent pin (XERK-38): the detail panel's Agent row ------------

test("mergeSites: collects the org's hosts as picker options, online first", () => {
  const sites = mergeSites([
    agent("hostB", block(), { online: false }),
    agent("hostA", block()),
  ]);
  assert.deepEqual(sites[0].hostOptions, [
    { key: "hostA", name: "hostA", online: true },
    { key: "hostB", name: "hostB", online: false },
  ]);
});

test("agentPinOf: reads the hub's siteKey/issueKey-keyed map", () => {
  const ta = { "myorg.atlassian.net/X-1": { host: "hostA", at: 1 } };
  assert.equal(agentPinOf(ta, "myorg.atlassian.net", "X-1").host, "hostA");
  assert.equal(agentPinOf(ta, "myorg.atlassian.net", "X-2"), null);
  assert.equal(agentPinOf(null, "myorg.atlassian.net", "X-1"), null);
  // A malformed entry (no host) is no pin, not a crash.
  assert.equal(agentPinOf({ "s/X-1": {} }, "s", "X-1"), null);
});

test("agentFieldHtml: auto routing is the stated default, a pin says set by you", () => {
  const hosts = [{ key: "hostA", name: "hostA", online: true }];
  const auto = agentFieldHtml(null, hosts, { editable: true });
  assert.ok(auto.includes("Auto — most available agent"));
  assert.ok(auto.includes("data-agent-edit"));
  const pinned = agentFieldHtml({ host: "hostA" }, hosts, { editable: true });
  assert.ok(pinned.includes("hostA"));
  assert.ok(pinned.includes("set by you"));
});

test("agentFieldHtml: an offline or vanished pinned host is said, not hidden", () => {
  // findTicketHost refuses rather than reroutes around a dead pin, so the row
  // must say what the next spawn will hit instead of painting a healthy pin.
  const offline = agentFieldHtml({ host: "hostA" },
    [{ key: "hostA", name: "hostA", online: false }], {});
  assert.ok(offline.includes("(offline)"));
  const gone = agentFieldHtml({ host: "hostGone" },
    [{ key: "hostA", name: "hostA", online: true }], {});
  assert.ok(gone.includes("no longer reports this org"));
});

test("agentFieldHtml: a failed save is reported on the row", () => {
  const html = agentFieldHtml(null, [], { error: "the hub is unreachable" });
  assert.ok(html.includes("Couldn't save"));
  assert.ok(html.includes("the hub is unreachable"));
});

test("agentPickerHtml: auto preselected without a pin, the pinned host with one", () => {
  const hosts = [{ key: "hostA", name: "hostA", online: true },
                 { key: "hostB", name: "hostB", online: false }];
  const auto = agentPickerHtml(null, hosts);
  assert.ok(/<option value="__auto__" selected>/.test(auto));
  assert.ok(auto.includes('value="hostA"'));
  assert.ok(auto.includes("hostB (offline)"));
  // A pick IS the save — same contract as the repo picker, so no Save button.
  assert.ok(!auto.includes("data-agent-save"));
  assert.ok(auto.includes("data-agent-cancel"));
  const pinned = agentPickerHtml({ host: "hostB" }, hosts);
  assert.ok(/<option value="hostB" selected>/.test(pinned));
  assert.ok(!/<option value="__auto__" selected>/.test(pinned));
});

test("agentPickerHtml: a pinned host that left the fleet stays selected", () => {
  // Same trap the repo picker documents: with nothing selected the browser
  // falls back to the first option — Auto — misreporting the pin, and turning a
  // click-away into a silent release of it.
  const html = agentPickerHtml({ host: "hostGone" },
    [{ key: "hostA", name: "hostA", online: true }]);
  assert.ok(/<option value="hostGone" selected>/.test(html));
  assert.ok(html.includes('<optgroup label="Currently set">'));
  assert.ok(!/<option value="__auto__" selected>/.test(html));
});

test("agentPickerValue: agrees with what the picker preselects", () => {
  const hosts = [{ key: "hostA", name: "hostA", online: true }];
  for (const pin of [null, { host: "hostA" }, { host: "hostGone" }]) {
    const html = agentPickerHtml(pin, hosts);
    const selected = /<option value="([^"]*)" selected>/.exec(html);
    assert.ok(selected, `nothing preselected for ${JSON.stringify(pin)}`);
    assert.equal(selected[1], agentPickerValue(pin));
  }
});

test("detailHtml: the Agent row renders, and swaps for the picker when editing", () => {
  const hosts = [{ key: "hostA", name: "hostA", online: true }];
  const row = detailHtml(ticket("X-1"), null,
    { siteKey: "s", agentPin: null, hostOptions: hosts });
  assert.ok(row.includes("Agent"));
  assert.ok(row.includes("Auto — most available agent"));
  assert.ok(row.includes("data-agent-edit"));
  const editing = detailHtml(ticket("X-1"), null,
    { siteKey: "s", agentPin: null, hostOptions: hosts, agentEditing: true });
  assert.ok(editing.includes("data-agent-select"));
});

test("detailHtml: no hosts and no pin leaves the Agent row read-only", () => {
  // Nothing to pick and nothing to release — a Change button would open an
  // empty picker.
  const html = detailHtml(ticket("X-1"), null,
    { siteKey: "s", agentPin: null, hostOptions: [] });
  assert.ok(!html.includes("data-agent-edit"));
  // But an existing pin must stay releasable even with the options blanked.
  const pinned = detailHtml(ticket("X-1"), null,
    { siteKey: "s", agentPin: { host: "hostGone" }, hostOptions: [] });
  assert.ok(pinned.includes("data-agent-edit"));
});

test("repoPickerHtml: a hostile repo name can't break out of the option", () => {
  const html = repoPickerHtml(ticket("X-1"), [
    { name: '"><script>alert(1)</script>', cloned: true },
  ]);
  assert.ok(!html.includes("<script"));
});

test("detailHtml: shows the guess from the card, which the Jira fetch lacks", () => {
  // repoGuess only ever exists on the heartbeat ticket — the on-demand issue
  // fetch comes straight from Jira, which knows nothing about repos. So a
  // landed `detail` must not blank the row.
  const t = ticket("X-1", { repoGuess: { repo: "Turma", cloned: true, reason: "" } });
  for (const d of [null, detail()]) {
    const html = detailHtml(t, d, { siteKey: "myorg.atlassian.net" });
    assert.ok(html.includes("<dt>Repo</dt>"), String(d));
    assert.ok(html.includes(">Turma<"), String(d));
  }
});

test("detailHtml: an untriaged ticket still gets a Repo row to answer from", () => {
  // The card draws no chip for one (absence isn't a verdict), but the panel is
  // where an override is made, and a ticket nobody has classified is exactly the
  // one worth pinning by hand — so the row is present and says which state it's
  // in rather than vanishing.
  const html = detailHtml(ticket("X-1"), detail(), { canEdit: true });
  assert.ok(html.includes("<dt>Repo</dt>"));
  assert.ok(html.includes("Not triaged yet"));
  assert.ok(html.includes("data-repo-edit"));
});

test("detailHtml: editing swaps the Repo row for the picker in place", () => {
  const t = ticket("X-1", { repoGuess: { repo: "Turma", cloned: true } });
  const html = detailHtml(t, detail(), {
    editing: true, canEdit: true, repoOptions: [{ name: "Turma", cloned: true }],
  });
  assert.ok(html.includes("<dt>Repo</dt>"));
  assert.ok(html.includes("data-repo-select"));
  assert.ok(!html.includes("data-repo-edit"));
});

test("detailHtml: a failed save is reported on the row it failed to change", () => {
  const html = detailHtml(ticket("X-1"), detail(), {
    canEdit: true, repoError: "host is offline",
  });
  assert.ok(html.includes("Couldn't save"));
  assert.ok(html.includes("host is offline"));
});

test("mergeSites: picker options union across the org's hosts, cloned winning", () => {
  // `cloned` is host-relative, so a repo cloned on ANY host of the org is
  // offerable — the override fans out to all of them anyway.
  const sites = mergeSites([
    agent("hostA", block({ siteKey: "s.atlassian.net", user: "a", fetchedAt: "2026-01-02",
      repoOptions: [{ name: "Turma", cloned: false }, { name: "OnlyA", cloned: true }] })),
    agent("hostB", block({ siteKey: "s.atlassian.net", user: "b", fetchedAt: "2026-01-01",
      repoOptions: [{ name: "Turma", cloned: true }] })),
  ]);
  assert.deepEqual(sites[0].repoOptions, [
    { name: "OnlyA", cloned: true },
    { name: "Turma", cloned: true },
  ]);
});

test("mergeSites: picker options survive the same-user block dedupe", () => {
  // The regression this guards: options were unioned over the blocks that WIN
  // `byUser`, which is one per (site, user) — and an org's hosts commonly all
  // poll as the same user. The loser's repos vanished from the picker, so which
  // repos you could pin depended on which host polled Jira last.
  const sites = mergeSites([
    agent("nas", block({ siteKey: "s.atlassian.net", user: "me@x.com", fetchedAt: "2026-01-02",
      repoOptions: [{ name: "OnlyNas", cloned: true }] })),
    agent("wsl", block({ siteKey: "s.atlassian.net", user: "me@x.com", fetchedAt: "2026-01-01",
      repoOptions: [{ name: "OnlyWsl", cloned: true }] })),
  ]);
  assert.equal(sites[0].users.length, 1, "one user: the blocks really do dedupe");
  assert.deepEqual(sites[0].repoOptions.map(o => o.name), ["OnlyNas", "OnlyWsl"]);
});

test("mergeSites: an org whose hosts report no options gets an empty list", () => {
  const sites = mergeSites([agent("hostA", block({ tickets: [ticket("X-1")] }))]);
  assert.deepEqual(sites[0].repoOptions, []);
});

test("mergeSites: the repo guess survives the cross-host merge", () => {
  const t = ticket("X-1", { repoGuess: { repo: "Turma", cloned: true, reason: "" } });
  const sites = mergeSites([agent("hostA", block({ tickets: [t] }))]);
  assert.deepEqual(sites[0].tickets[0].repoGuess, { repo: "Turma", cloned: true, reason: "" });
});

// ---- ticket -> session link + the start button -------------------------------
// The agent stamps `session.ticket` on any session it spawns from a ticket; the
// board walks that backwards out of the fleet payload it already polls. These
// assert the link survives the walk and that the four button states stay
// distinguishable — "start it", "starting", "clone it first" and "not triaged"
// are four different answers, and only one of them is a working button.

function sess(id, over = {}) {
  return { id, status: "running", createdAt: "2026-07-14T10:00:00Z", ...over };
}
function tsess(id, key, over = {}) {
  return sess(id, {
    ticket: { key, siteKey: "myorg.atlassian.net", branch: key,
              url: `https://myorg.atlassian.net/browse/${key}` },
    ...over,
  });
}
const guess = (over = {}) => ({ repoGuess: { repo: "Turma", cloned: true, reason: "", ...over } });

test("ticketSessionIndex: finds a ticket's sessions across the fleet", () => {
  const idx = ticketSessionIndex([
    agent("hostA", block(), { sessions: [tsess("s1", "X-1"), sess("s9")] }),
    agent("hostB", block(), { sessions: [tsess("s2", "X-1"), tsess("s3", "X-2")] }),
  ]);
  assert.deepEqual(
    ticketSessionsOf(idx, "myorg.atlassian.net", "X-1").map(s => s.id), ["s1", "s2"]);
  assert.deepEqual(
    ticketSessionsOf(idx, "myorg.atlassian.net", "X-2").map(s => s.id), ["s3"]);
  // A session with no ticket is simply not in the index.
  assert.deepEqual(ticketSessionsOf(idx, "myorg.atlassian.net", "X-9"), []);
});

test("ticketSessionIndex: the host is carried onto each session", () => {
  const idx = ticketSessionIndex([agent("hostA", block(), { sessions: [tsess("s1", "X-1")] })]);
  assert.equal(ticketSessionsOf(idx, "myorg.atlassian.net", "X-1")[0].host, "hostA");
});

test("ticketSessionIndex: same key in two orgs never collides", () => {
  // Issue keys are only unique WITHIN a site, and the board is cross-org.
  const other = { ...tsess("s2", "X-1"), ticket: { key: "X-1", siteKey: "other.atlassian.net" } };
  const idx = ticketSessionIndex([agent("hostA", block(), { sessions: [tsess("s1", "X-1"), other] })]);
  assert.deepEqual(ticketSessionsOf(idx, "myorg.atlassian.net", "X-1").map(s => s.id), ["s1"]);
  assert.deepEqual(ticketSessionsOf(idx, "other.atlassian.net", "X-1").map(s => s.id), ["s2"]);
});

test("ticketSessionIndex: sessions read oldest first (branch order)", () => {
  // The first session on a ticket holds the bare X-1 branch; -1 came after it.
  const idx = ticketSessionIndex([agent("hostA", block(), {
    sessions: [tsess("new", "X-1", { createdAt: "2026-07-14T12:00:00Z" }),
               tsess("old", "X-1", { createdAt: "2026-07-14T09:00:00Z" })],
  })]);
  assert.deepEqual(ticketSessionsOf(idx, "myorg.atlassian.net", "X-1").map(s => s.id),
    ["old", "new"]);
});

test("ticketSessionIndex: a STOPPED session still shows on its ticket", () => {
  // Its claude exited on its own, so the registry record (and the link hanging
  // off it) is still right here in a.sessions. Contrast the killed case below,
  // which this test was once named for but never exercised: a kill DROPS the
  // record from the registry, so nothing in a.sessions could have covered it.
  const idx = ticketSessionIndex([agent("hostA", block(), {
    sessions: [tsess("s1", "X-1", { status: "stopped" })],
  })]);
  assert.equal(ticketSessionsOf(idx, "myorg.atlassian.net", "X-1").length, 1);
});

test("ticketSessionIndex: a KILLED session still shows on its ticket", () => {
  // A kill drops the registry record and moves it to the closed history, so this
  // is the only channel carrying the link — read it, or a ticket forgets its work
  // the instant that work is killed.
  const idx = ticketSessionIndex([agent("hostA", block(), {
    sessions: [],
    closedSessions: [tsess("s1", "X-1", { transcriptId: "tr1", closedAt: "2026-07-14T11:00:00Z" })],
  })]);
  const got = ticketSessionsOf(idx, "myorg.atlassian.net", "X-1");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "s1");
  assert.equal(got[0].host, "hostA");
});

test("ticketSessionIndex: a session aged out of the closed history still shows", () => {
  // closed.json keeps only CLOSED_PER_REPO per repo. Past that the durable
  // transcript scan is the last channel reporting the session at all, and its
  // ticket comes from the agent's transcript -> ticket ledger.
  const idx = ticketSessionIndex([agent("hostA", block(), {
    sessions: [],
    repos: [{ name: "Turma", resumable: [
      { transcriptId: "tr9", endedTs: "2026-07-13T09:00:00Z", summary: "Work Jira ticket X-1.",
        ticket: { key: "X-1", siteKey: "myorg.atlassian.net", branch: "X-1" } },
      { transcriptId: "tr8", endedTs: "2026-07-13T08:00:00Z", summary: "something else" },
    ] }],
  })]);
  const got = ticketSessionsOf(idx, "myorg.atlassian.net", "X-1");
  assert.equal(got.length, 1);
  assert.equal(got[0].transcriptId, "tr9");
});

test("ticketSessionIndex: the closed record beats its own resumable scan entry", () => {
  // A killed session is reported through BOTH channels once the slow scan catches
  // up. Only the record knows its id, its createdAt and that it was renamed — so
  // it must win, and the ticket must not chip twice.
  const idx = ticketSessionIndex([agent("hostA", block(), {
    sessions: [],
    closedSessions: [tsess("s1", "X-1", { transcriptId: "tr1" })],
    repos: [{ name: "Turma", resumable: [
      { transcriptId: "tr1", endedTs: "2026-07-13T09:00:00Z",
        ticket: { key: "X-1", siteKey: "myorg.atlassian.net", branch: "X-1" } },
    ] }],
  })]);
  const got = ticketSessionsOf(idx, "myorg.atlassian.net", "X-1");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "s1");
});

test("ticketSessionIndex: a running session beats its scan entry on ANOTHER host's turn", () => {
  // Resumable is sweept in its own pass over the whole fleet, after every
  // registry-backed record is in `seen` — otherwise a record reported by a host
  // listed later would lose to an earlier host's scan entry.
  const idx = ticketSessionIndex([
    agent("hostA", block(), {
      sessions: [],
      repos: [{ name: "Turma", resumable: [
        { transcriptId: "tr1", endedTs: "2026-07-13T09:00:00Z",
          ticket: { key: "X-1", siteKey: "myorg.atlassian.net", branch: "X-1" } },
      ] }],
    }),
    agent("hostA", block(), { sessions: [tsess("s1", "X-1", { transcriptId: "tr1" })] }),
  ]);
  const got = ticketSessionsOf(idx, "myorg.atlassian.net", "X-1");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "s1");
});

test("ticketSessionIndex: the same transcript on two hosts is not deduped", () => {
  // The shared ~/.claude login syncs transcripts between hosts, so an id alone is
  // not unique across the fleet — two hosts reporting one really are two rows.
  const idx = ticketSessionIndex([
    agent("hostA", block(), { sessions: [tsess("s1", "X-1", { transcriptId: "tr1" })] }),
    agent("hostB", block(), { sessions: [tsess("s2", "X-1", { transcriptId: "tr1" })] }),
  ]);
  assert.deepEqual(
    ticketSessionsOf(idx, "myorg.atlassian.net", "X-1").map(s => s.host), ["hostA", "hostB"]);
});

test("ticketSessionIndex: a scan-recovered session sorts on when it last spoke", () => {
  // It was never a record, so it has no createdAt — endedTs is the only timestamp
  // its scan recovers, and without it it would sort to an arbitrary spot.
  const idx = ticketSessionIndex([agent("hostA", block(), {
    sessions: [tsess("new", "X-1", { createdAt: "2026-07-14T12:00:00Z" })],
    repos: [{ name: "Turma", resumable: [
      { transcriptId: "old", endedTs: "2026-07-13T09:00:00Z",
        ticket: { key: "X-1", siteKey: "myorg.atlassian.net", branch: "X-1" } },
    ] }],
  })]);
  assert.deepEqual(
    ticketSessionsOf(idx, "myorg.atlassian.net", "X-1").map(s => s.id || s.transcriptId),
    ["old", "new"]);
});

test("sessionChipHtml: links into the session and shows its live state", () => {
  const html = sessionChipHtml(tsess("abc12", "X-1", { summary: "X-1 Fixing The Board" }));
  assert.ok(html.includes(`href="/sessions?session=abc12"`));
  assert.ok(html.includes("running"));
  assert.ok(!html.includes("kc-sess-off"));
});

test("sessionChipHtml: anything not running opens the READ-ONLY view", () => {
  // The Sessions page's ?session= wait only ever resolves a RUNNING session, so
  // pointing a stopped/killed chip at it parks the stage on "Opening session…"
  // forever. The conversation is what an ended session has to offer, and
  // ?ended=<transcriptId> is the deep link that opens it.
  for (const s of [
    tsess("s1", "X-1", { status: "stopped", transcriptId: "tr1" }),   // registry, exited
    tsess("s1", "X-1", { status: undefined, transcriptId: "tr1" }),   // killed / scan-recovered
  ]) {
    const html = sessionChipHtml(s);
    assert.ok(html.includes(`href="/sessions?ended=tr1"`), html);
    assert.ok(!html.includes("?session="), html);
  }
});

test("sessionChipHtml: a session with no conversation is not a link", () => {
  // Killed before its first turn: there is nothing to open, and an <a> to nowhere
  // is worse than plain text saying so.
  const html = sessionChipHtml(tsess("s1", "X-1", { status: "stopped" }));
  assert.ok(!html.includes("<a"));
  assert.ok(html.includes("no conversation"));
  assert.ok(html.includes(">X-1<"));      // still labelled, still readable
});

test("sessionChipHtml: a scan-recovered session labels and links with no id at all", () => {
  // It was never a registry record — no id, no git, no summaryManual. The ledger's
  // reserved branch is its label and its transcript is its link.
  const html = sessionChipHtml({
    transcriptId: "tr9", endedTs: "2026-07-13T09:00:00Z",
    ticket: { key: "X-1", siteKey: "myorg.atlassian.net", branch: "X-1" },
  });
  assert.ok(html.includes(`href="/sessions?ended=tr9"`));
  assert.ok(html.includes(">X-1<"));
  assert.ok(html.includes("kc-sess-off"));
});

test("sessionChipHtml: labels with the BRANCH, not the ticket-derived name", () => {
  // The session is named FROM the ticket, so its name just repeats the key and
  // summary already on this card; the branch is what tells two sessions apart.
  const html = sessionChipHtml(tsess("s1", "X-1", {
    summary: "X-1 Fixing The Board", git: { branch: "X-1-2" },
  }));
  assert.ok(html.includes(">X-1-2<"), "the branch is the label");
  assert.ok(!html.includes(">X-1 Fixing The Board<"), "the name must not be the label");
  assert.ok(html.includes(`title="X-1 Fixing The Board · running"`), "the name rides the tooltip");
});

test("sessionChipHtml: an operator's rename beats the branch", () => {
  // A typed name is deliberate; the branch is derived. summaryManual is the flag
  // that tells them apart.
  const html = sessionChipHtml(tsess("s1", "X-1", {
    summary: "Chasing The Real Bug", summaryManual: true, git: { branch: "X-1-2" },
  }));
  assert.ok(html.includes(">Chasing The Real Bug<"));
  assert.ok(html.includes("branch X-1-2"), "the branch drops to the tooltip");
});

test("sessionChipHtml: the label can ellipsise (its own element, not the flex chip)", () => {
  // text-overflow can't clip anonymous flex content — it hard-cuts mid-letter.
  const html = sessionChipHtml(tsess("s1", "X-1"));
  assert.ok(/<span class="kc-sess-name">/.test(html));
});

test("sessionChipHtml: a stopped session is visibly not running", () => {
  const html = sessionChipHtml(tsess("s1", "X-1", { status: "stopped", summary: "Done Thing" }));
  assert.ok(html.includes("kc-sess-off"));
  assert.ok(html.includes("stopped"));
});

test("sessionChipHtml: an errored session reads as failed, not merely stopped", () => {
  const html = sessionChipHtml(tsess("s1", "X-1", { status: "error" }));
  assert.ok(html.includes("kc-sess-err"));
  assert.ok(html.includes("failed"));
});

test("sessionChipHtml: prefers the LIVE branch over the reserved one", () => {
  // The reservation is what the agent was TOLD; git is what it did.
  const html = sessionChipHtml(tsess("s1", "X-1", { git: { branch: "X-1-actual" } }));
  assert.ok(html.includes(">X-1-actual<"));
});

test("sessionChipHtml: falls back to the reserved branch, then the id", () => {
  // Before the agent branches there's no live branch, only the reserved one.
  assert.ok(sessionChipHtml(tsess("s1", "X-1")).includes(">X-1<"));
  assert.ok(sessionChipHtml(sess("s1", { ticket: { key: "X-1" } })).includes(">s1<"));
});

test("sessionChipHtml: escapes a hostile session name", () => {
  const html = sessionChipHtml(tsess("s1", "X-1", {
    summary: `<img src=x onerror=1>`, summaryManual: true,
  }));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("ticketStartHtml: a triaged, cloned ticket gets a working start button", () => {
  const html = ticketStartHtml(ticket("X-1", guess()), [], null);
  assert.ok(html.includes(`data-start="X-1"`), "the handler routes off data-start");
  assert.ok(html.includes("Start session"));
  assert.ok(!html.includes("disabled"));
});

test("ticketStartHtml: an untriaged ticket gets no button at all", () => {
  // "not looked at yet" is not "no repo fits" — neither is something to start.
  assert.equal(ticketStartHtml(ticket("X-1"), [], null), "");
  assert.equal(ticketStartHtml(ticket("X-1", { repoGuess: { repo: null } }), [], null), "");
});

test("ticketStartHtml: an uncloned repo gets a live 'clone first' start button", () => {
  // Clone-on-demand: the hub routes to the most-available org host, which clones
  // the repo and queues the session behind it — so this is no longer a dead end.
  const html = ticketStartHtml(ticket("X-1", guess({ cloned: false })), [], null);
  assert.ok(!html.includes("disabled"), "the button is live now, not disabled");
  assert.ok(html.includes(`data-start="X-1"`), "it's clickable and routes off data-start");
  assert.ok(html.includes("clone first"), "the label flags the extra clone step");
  assert.ok(html.includes("clones first"), "the tooltip explains it");
});

test("ticketStartHtml: an in-flight start shows busy, not a second button", () => {
  const html = ticketStartHtml(ticket("X-1", guess()), [], { pending: true });
  assert.ok(html.includes("kc-start-busy"));
  assert.ok(html.includes("starting"));
  assert.ok(!html.includes("data-start"), "no re-click while a spawn is in flight");
});

test("ticketStartHtml: a failed start shows the reason AND keeps the button", () => {
  // Every failure here is fleet-state ("no online host", "not cloned there"), so
  // the operator needs both the reason and the retry.
  const html = ticketStartHtml(ticket("X-1", guess()), [], { error: "no online host" });
  assert.ok(html.includes("kc-start-err"));
  assert.ok(html.includes("no online host"));
  assert.ok(html.includes("data-start"), "the retry stays clickable");
});

test("ticketStartHtml: a started ticket shows its session, and can start another", () => {
  const html = ticketStartHtml(ticket("X-1", guess()), [tsess("s1", "X-1")], null);
  assert.ok(html.includes(`href="/sessions?session=s1"`));
  assert.ok(html.includes("kc-start-more"), "the button compacts to a +");
  assert.ok(html.includes("data-start"), "a second session on a ticket is supported");
  assert.ok(html.includes("its own branch"));
});

test("ticketStartHtml: chips for every session on the ticket", () => {
  const html = ticketStartHtml(ticket("X-1", guess()),
    [tsess("s1", "X-1"), tsess("s2", "X-1")], null);
  assert.ok(html.includes("session=s1") && html.includes("session=s2"));
});

test("ticketStartHtml: an untriaged ticket still shows sessions it has", () => {
  // The repo guess can go stale/absent; sessions already started are facts.
  const html = ticketStartHtml(ticket("X-1"), [tsess("s1", "X-1")], null);
  assert.ok(html.includes("session=s1"));
  assert.ok(!html.includes("data-start"));
});

test("ticketStartHtml: escapes a hostile error", () => {
  const html = ticketStartHtml(ticket("X-1", guess()), [], { error: `<img src=x>` });
  assert.ok(!html.includes("<img"));
});

test("cardHtml: the start control sits before the org (which is margin-left:auto)", () => {
  const html = cardHtml(ticket("X-1", guess()), { siteKey: "myorg.atlassian.net" },
    { sessions: [], start: null });
  assert.ok(html.includes("data-start"));
  assert.ok(html.indexOf("kc-start") < html.indexOf("kc-org"));
  assert.ok(html.indexOf("kc-repo") < html.indexOf("kc-start"), "repo, then start");
});

test("boardHtml: wires each card to its own sessions and start state", () => {
  const t1 = ticket("X-1", { ...guess(), statusCategory: "todo" });
  const t2 = ticket("X-2", { ...guess(), statusCategory: "todo" });
  const sites = mergeSites([agent("hostA", block({ tickets: [t1, t2] }), {
    sessions: [tsess("s1", "X-1")],
  })]);
  const html = boardHtml(sites, "", {
    sessionIndex: ticketSessionIndex([agent("hostA", block(), { sessions: [tsess("s1", "X-1")] })]),
    starts: new Map([["myorg.atlassian.net\x00X-2", { pending: true }]]),
  });
  assert.ok(html.includes("session=s1"), "X-1 shows its session");
  assert.ok(html.includes("kc-start-busy"), "X-2 shows its in-flight start");
});

test("boardHtml: no session index or starts is fine (an ordinary render)", () => {
  const sites = mergeSites([agent("hostA", block({ tickets: [ticket("X-1", guess())] }))]);
  const html = boardHtml(sites, "", {});
  assert.ok(html.includes("data-start"));
  assert.ok(!html.includes("kc-start-busy"));
});

// --- startSweepVerdict: when an optimistic start resolves ------------------
const TMO = 60000;

test("startSweepVerdict: a just-clicked start with no cmdId yet always holds", () => {
  // The POST hasn't replied, so there's no cmdId to look for and nothing to
  // time out against — its own fetch resolves it, never the sweep. This is the
  // state the synchronous press-acknowledgement paints.
  const p = { cmdId: null, host: "hostA", sawCmd: false, ageMs: 999999 };
  assert.equal(startSweepVerdict(p, [], false, true, TMO), "hold");
});

test("startSweepVerdict: a stale cache that never saw the command must not clear it", () => {
  // The regression: after the POST, the SSE-fallback cache hasn't refreshed past
  // the click, so the command is absent — but that is "not seen yet", not
  // "acked". Clearing here sweeps the ⏳ the instant it's set.
  const p = { cmdId: "c1", host: "hostA", sawCmd: false, ageMs: 200 };
  assert.equal(startSweepVerdict(p, [], false, true, TMO), "hold");
  assert.equal(p.sawCmd, false, "never marked seen — the command was never present");
});

test("startSweepVerdict: the command present marks it seen and holds", () => {
  const p = { cmdId: "c1", host: "hostA", sawCmd: false, ageMs: 200 };
  assert.equal(startSweepVerdict(p, [], true, true, TMO), "hold");
  assert.equal(p.sawCmd, true, "watched it land");
});

test("startSweepVerdict: a command we watched land, now drained, clears (agent ran/refused it)", () => {
  const p = { cmdId: "c1", host: "hostA", sawCmd: true, ageMs: 5000 };
  assert.equal(startSweepVerdict(p, [], false, true, TMO), "clear");
});

test("startSweepVerdict: a session reporting the cmdId clears it (it landed)", () => {
  const p = { cmdId: "c1", host: "hostA", sawCmd: false, ageMs: 200 };
  assert.equal(startSweepVerdict(p, [{ spawnCmdId: "c1" }], true, true, TMO), "clear");
});

test("startSweepVerdict: a host that dropped out of the fleet only ever times out", () => {
  // Not knowing the host, we can't read the queue; holding-then-timing-out is
  // the only honest verdict (never a false clear against a fleet we can't see).
  const fresh = { cmdId: "c1", host: "gone", sawCmd: false, ageMs: 200 };
  assert.equal(startSweepVerdict(fresh, [], false, false, TMO), "hold");
  const old = { cmdId: "c1", host: "gone", sawCmd: false, ageMs: TMO + 1 };
  assert.equal(startSweepVerdict(old, [], false, false, TMO), "error");
});

test("startSweepVerdict: a never-seen command past the timeout errors (backstop)", () => {
  const p = { cmdId: "c1", host: "hostA", sawCmd: false, ageMs: TMO + 1 };
  assert.equal(startSweepVerdict(p, [], false, true, TMO), "error");
});
