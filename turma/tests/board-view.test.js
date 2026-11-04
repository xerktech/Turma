// Unit tests for the board toolbar's search / filter / sort view (board.js):
// facets, matching, the sort comparator, the option groups, the URL round-trip
// and boardHtml's filtered columns. Android ports the same rules in
// core/Board.kt (BoardViewTest.kt) — change one, change both.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FILTER_FIELDS, SORTS, emptyBoardView, boardViewActive, boardViewFilterCount, priorityRank,
  ticketFacets, ticketSearchMatch, boardViewMatches, boardViewSort, boardFilterGroups,
  boardViewFromParams, boardViewToParams, hasBoardViewParams,
  boardFilterPanelHtml, boardFilterChipsHtml, boardSortMenuHtml, sortLabel, boardHtml,
} = require("../public/board.js");

const NOW = Date.parse("2026-10-02T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

function tk(over) {
  return Object.assign({
    key: "XERK-1", summary: "A ticket", status: "To Do", statusCategory: "todo",
    priority: "Medium", type: "Task", project: "XERK", projectName: "Xerk",
    labels: [], updated: hoursAgo(1), created: hoursAgo(100), dueDate: null,
    epicKey: null, isEpic: false, blocks: [], blockedBy: [],
    triage: { repo: "Turma" }, repoGuess: { repo: "Turma", cloned: true },
  }, over);
}
const SITE = "acme.atlassian.net";
const site = (tickets) => ({ siteKey: SITE, tickets });
const ctx = { now: NOW };

test("priorityRank folds Jira names, Azure P<n> and alternates onto one scale", () => {
  assert.equal(priorityRank("Highest"), 0);
  assert.equal(priorityRank("blocker"), 0);
  assert.equal(priorityRank("High"), 1);
  assert.equal(priorityRank("P2"), 1);
  assert.equal(priorityRank("Medium"), 2);
  assert.equal(priorityRank("Low"), 3);
  assert.equal(priorityRank("Lowest"), 4);
  assert.equal(priorityRank("P1"), 0);
  assert.ok(priorityRank("Whatever") > priorityRank("Lowest"), "unknown sorts after every known band");
  assert.ok(priorityRank("") > priorityRank("Whatever"), "no priority sorts last");
});

test("ticketFacets: repo, epic, session, deps, due and updated windows", () => {
  const f = ticketFacets(tk({
    labels: ["api", "ui"], epicKey: "XERK-9", blockedBy: ["XERK-2"], blocks: ["XERK-3"],
    dueDate: "2026-10-01", updated: hoursAgo(30),
  }), site([]), ctx);
  assert.deepEqual(f.label, ["api", "ui"]);
  assert.deepEqual(f.repo, ["Turma"]);
  assert.deepEqual(f.epic, ["XERK-9"]);
  assert.deepEqual(f.session, ["none"]);
  assert.deepEqual(f.deps, ["blocked", "blocking"]);
  assert.deepEqual(f.due, ["has", "overdue"]);
  assert.deepEqual(f.updated, ["7d", "30d"]);

  const g = ticketFacets(tk({ repoGuess: { repo: null }, dueDate: "2026-10-06" }), site([]), ctx);
  assert.deepEqual(g.repo, ["-none"], "a declined repo is 'no repo'");
  assert.deepEqual(g.epic, ["-none"]);
  assert.deepEqual(g.due, ["has", "week"]);
  assert.deepEqual(g.updated, ["24h", "7d", "30d"]);

  const h = ticketFacets(tk({ repoGuess: undefined, dueDate: "2026-11-30" }), site([]), ctx);
  assert.deepEqual(h.repo, ["-untriaged"], "no guess yet is 'untriaged'");
  assert.deepEqual(h.due, ["has"], "a far due date is neither overdue nor this week");
  assert.deepEqual(ticketFacets(tk({}), site([]), ctx).due, ["none"]);
});

test("ticketFacets: session reads the session index first, then the hub queue", () => {
  const t = tk({ key: "XERK-5" });
  const sessionIndex = new Map([[SITE + "\x00XERK-5", [{ id: "s1", status: "running" }]]]);
  assert.deepEqual(ticketFacets(t, site([]), { now: NOW, sessionIndex }).session, ["running"]);
  const ticketQueue = [{ siteKey: SITE, issueKey: "XERK-5" }];
  assert.deepEqual(ticketFacets(t, site([]), { now: NOW, ticketQueue }).session, ["queued"]);
  assert.deepEqual(ticketFacets(t, site([]), { now: NOW, sessionIndex, ticketQueue }).session, ["running"]);
  assert.deepEqual(ticketFacets(t, { siteKey: "other" }, { now: NOW, ticketQueue }).session, ["none"],
    "a queue entry for another org's same key doesn't count");
});

test("ticketFacets: a killed/ended/resumable session is not running (QA defect 1)", () => {
  const t = tk({ key: "XERK-5" });
  const idx = (...st) => new Map([[SITE + "\x00XERK-5", st.map((status, i) => ({ id: "s" + i, status }))]]);
  const sess = (sessionIndex, ticketQueue) =>
    ticketFacets(t, site([]), { now: NOW, sessionIndex, ticketQueue }).session;
  assert.deepEqual(sess(idx("stopped")), ["none"], "a killed attempt is not running");
  assert.deepEqual(sess(idx(undefined)), ["none"], "a resumable transcript row is not running");
  assert.deepEqual(sess(idx("stopped", "running")), ["running"]);
  assert.deepEqual(sess(idx("queued")), ["queued"], "an agent-side queued session is queued");
  assert.deepEqual(sess(idx("stopped"), [{ siteKey: SITE, issueKey: "XERK-5" }]), ["queued"],
    "re-queued after a killed attempt reads queued, not running");
});

test("ticketFacets: due buckets use the viewer's local day, not UTC (QA defect 3)", () => {
  const prev = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    // 01:00Z on Oct 3 is 18:00 on Oct 2 in Los Angeles: due Oct 2 is today, not overdue.
    const now = Date.parse("2026-10-03T01:00:00Z");
    assert.deepEqual(ticketFacets(tk({ dueDate: "2026-10-02" }), site([]), { now }).due, ["has", "week"]);
    assert.deepEqual(ticketFacets(tk({ dueDate: "2026-10-01" }), site([]), { now }).due, ["has", "overdue"]);
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

test("ticketSearchMatch: substring over text fields, exact on an issue-key query", () => {
  const t = tk({ key: "XERK-12", summary: "Webhook retry storm", labels: ["api"], epicKey: "XERK-900" });
  assert.ok(ticketSearchMatch(t, "webhook"));
  assert.ok(ticketSearchMatch(t, "  RETRY "), "case- and whitespace-insensitive");
  assert.ok(ticketSearchMatch(t, "api"), "labels are searched");
  assert.ok(ticketSearchMatch(t, "turma"), "the repo guess is searched");
  assert.ok(ticketSearchMatch(t, ""), "an empty query matches everything");
  assert.ok(ticketSearchMatch(t, "xerk-12"), "a key query matches its ticket");
  assert.ok(!ticketSearchMatch(tk({ key: "XERK-120" }), "XERK-12"), "a key query is exact, not a prefix");
  assert.ok(!ticketSearchMatch(t, "XERK-900"), "a key query never matches by the epic key");
  assert.ok(!ticketSearchMatch(t, "nothing-like-it"));
});

test("boardViewMatches: OR within a field, AND across fields, plus the search", () => {
  const bug = tk({ key: "A-1", type: "Bug", priority: "High", labels: ["api"] });
  const story = tk({ key: "A-2", type: "Story", priority: "Low", labels: ["ui"] });
  const view = (f, q) => Object.assign(emptyBoardView(), { f, q: q || "" });
  const m = (t, v) => boardViewMatches(t, site([]), v, ctx);
  assert.ok(m(bug, view({ type: ["Bug", "Story"] })) && m(story, view({ type: ["Bug", "Story"] })));
  assert.ok(m(bug, view({ type: ["Bug"], priority: ["High"] })));
  assert.ok(!m(story, view({ type: ["Story"], priority: ["High"] })), "every field must hold");
  assert.ok(!m(bug, view({ type: ["Bug"] }, "zzz")), "the search narrows too");
  assert.ok(m(bug, view({ label: ["api", "nope"] })), "multi-valued facet: any label matches");
  assert.ok(m(bug, view({ type: [] })), "an empty selection is no filter");
  assert.ok(m(bug, null));
});

test("boardViewActive / boardViewFilterCount ignore sort and the Done toggle", () => {
  const v = emptyBoardView();
  assert.equal(boardViewActive(v), false);
  assert.equal(boardViewActive(Object.assign({}, v, { sort: "key", rev: true, hideDone: true })), false);
  assert.equal(boardViewActive(Object.assign({}, v, { q: "  " })), false, "whitespace isn't a search");
  assert.equal(boardViewActive(Object.assign({}, v, { q: "x" })), true);
  const f = Object.assign({}, v, { f: { type: ["Bug"], label: [], priority: ["High", "Low"] } });
  assert.equal(boardViewActive(f), true);
  assert.equal(boardViewFilterCount(f), 2, "counts fields with a selection, not values");
});

test("boardViewSort: every sort keeps epics pinned and breaks ties on updated", () => {
  const epic = tk({ key: "E-1", isEpic: true, type: "Epic", priority: "Lowest", updated: hoursAgo(500) });
  const a = tk({ key: "X-10", priority: "High", type: "Bug", updated: hoursAgo(5), created: hoursAgo(50), dueDate: "2026-10-09" });
  const b = tk({ key: "X-9", priority: "Highest", type: "Task", updated: hoursAgo(1), created: hoursAgo(90), dueDate: null });
  const c = tk({ key: "X-100", priority: "Low", type: "Story", updated: hoursAgo(3), created: hoursAgo(10), dueDate: "2026-10-03" });
  const order = (sort, rev) => [c, epic, a, b].sort(boardViewSort({ sort, rev })).map(t => t.key);
  assert.deepEqual(order("updated"), ["E-1", "X-9", "X-100", "X-10"]);
  assert.deepEqual(order("updated", true), ["E-1", "X-10", "X-100", "X-9"]);
  assert.deepEqual(order("created"), ["E-1", "X-100", "X-10", "X-9"]);
  assert.deepEqual(order("priority"), ["E-1", "X-9", "X-10", "X-100"]);
  assert.deepEqual(order("priority", true), ["E-1", "X-100", "X-10", "X-9"]);
  assert.deepEqual(order("due"), ["E-1", "X-100", "X-10", "X-9"]);
  assert.deepEqual(order("due", true), ["E-1", "X-10", "X-100", "X-9"], "no due date stays last reversed");
  assert.deepEqual(order("key"), ["E-1", "X-9", "X-10", "X-100"], "keys compare numerically");
  assert.deepEqual(order("key", true), ["E-1", "X-100", "X-10", "X-9"]);
  assert.deepEqual(order("type"), ["E-1", "X-10", "X-100", "X-9"]);
  assert.deepEqual(order("bogus"), order("updated"), "an unknown sort falls back to updated");
  const tie = [tk({ key: "T-1", priority: "High", updated: hoursAgo(9) }), tk({ key: "T-2", priority: "High", updated: hoursAgo(2) })];
  assert.deepEqual(tie.sort(boardViewSort({ sort: "priority" })).map(t => t.key), ["T-2", "T-1"]);
});

test("boardFilterGroups: counts, ordering, epic names and a stale selection", () => {
  const tickets = [
    tk({ key: "A-1", type: "Bug", priority: "Low", labels: ["api", "ui"] }),
    tk({ key: "A-2", type: "Bug", priority: "Highest", labels: ["api"], epicKey: "A-9" }),
    tk({ key: "A-3", type: "Story", priority: "High", repoGuess: undefined }),
    tk({ key: "A-9", type: "Epic", isEpic: true, summary: "Big push" }),
  ];
  const view = Object.assign(emptyBoardView(), { f: { type: ["Bug"], label: ["gone"] } });
  const groups = boardFilterGroups([site(tickets)], view, ctx);
  assert.deepEqual(groups.map(g => g.field), FILTER_FIELDS.map(f => f[0]));
  const g = (field) => groups.find(x => x.field === field).options;
  assert.deepEqual(g("type").map(o => [o.value, o.count, o.selected]),
    [["Bug", 2, true], ["Epic", 1, false], ["Story", 1, false]], "by count, then name");
  assert.deepEqual(g("priority").map(o => o.value), ["Highest", "High", "Medium", "Low"], "by rank");
  assert.deepEqual(g("label").map(o => [o.value, o.count]), [["api", 2], ["ui", 1], ["gone", 0]],
    "a selected value nobody carries stays offered so it can be cleared");
  assert.deepEqual(g("repo").map(o => o.label), ["Turma", "untriaged"], "special values trail");
  assert.deepEqual(g("epic").map(o => o.label), ["A-9 · Big push", "No epic"],
    "an epic on the board is labelled by its summary; 'No epic' trails");
  assert.deepEqual(g("session").map(o => o.value), ["none"], "fixed vocab shows only present values");
});

test("boardFilterGroups: a hidden Done column's tickets don't count", () => {
  const tickets = [
    tk({ key: "A-1", type: "Bug" }),
    tk({ key: "A-2", type: "Bug", statusCategory: "done", status: "Done" }),
    tk({ key: "A-3", type: "Story", statusCategory: "done", status: "Done" }),
  ];
  const type = (view) => boardFilterGroups([site(tickets)], view, ctx)
    .find(g => g.field === "type").options.map(o => [o.value, o.count]);
  assert.deepEqual(type(emptyBoardView()), [["Bug", 2], ["Story", 1]]);
  assert.deepEqual(type(Object.assign(emptyBoardView(), { hideDone: true })), [["Bug", 1]]);
  // A Done epic still names its open child's option when Done is hidden.
  const withEpic = [...tickets,
    tk({ key: "E-9", isEpic: true, summary: "Shipped", statusCategory: "done", status: "Done" }),
    tk({ key: "A-4", epicKey: "E-9" })];
  const epic = boardFilterGroups([site(withEpic)], Object.assign(emptyBoardView(), { hideDone: true }), ctx)
    .find(g => g.field === "epic").options.find(o => o.value === "E-9");
  assert.equal(epic.label, "E-9 · Shipped");
});

test("view <-> URL: round-trips, drops junk, keeps defaults out", () => {
  const p = new URLSearchParams("q=api&type=Bug&type=Story&type=Bug&sort=priority&rev=1&done=0&nope=1&label=");
  const v = boardViewFromParams(p);
  assert.deepEqual(v, { q: "api", f: { type: ["Bug", "Story"] }, sort: "priority", rev: true, hideDone: true });
  assert.deepEqual(boardViewFromParams(new URLSearchParams(new URLSearchParams(boardViewToParams(v)).toString())), v);
  assert.deepEqual(boardViewToParams(emptyBoardView()), [], "the default view writes nothing");
  assert.equal(boardViewFromParams(new URLSearchParams("sort=evil")).sort, "updated");
  assert.equal(boardViewFromParams(new URLSearchParams("q=" + "x".repeat(500))).q.length, 200);
  const many = new URLSearchParams(Array.from({ length: 80 }, (_, i) => ["label", "l" + i]));
  assert.equal(boardViewFromParams(many).f.label.length, 50, "values per field are capped");
  assert.equal(boardViewFromParams(new URLSearchParams("label=" + "y".repeat(201))).f.label, undefined);
  assert.ok(hasBoardViewParams(new URLSearchParams("type=Bug")));
  assert.ok(!hasBoardViewParams(new URLSearchParams("ticket=X-1&site=a")), "the deep link isn't a view");
  assert.deepEqual(boardViewFromParams(null), emptyBoardView());
});

test("panel / chips / sort menu markup escapes and reflects the view", () => {
  const tickets = [tk({ key: "A-1", labels: ['<img src=x onerror=1>'] })];
  const view = Object.assign(emptyBoardView(), { f: { label: ['<img src=x onerror=1>'] } });
  const groups = boardFilterGroups([site(tickets)], view, ctx);
  const panel = boardFilterPanelHtml(groups, view, 1, 3);
  assert.ok(!panel.includes("<img"), "option labels are escaped");
  assert.match(panel, /Showing 1 of 3/);
  assert.match(panel, /data-bf-clear/);
  assert.match(panel, /data-bf-done="1" checked/);
  assert.ok(!boardFilterPanelHtml(groups, emptyBoardView(), 3, 3).includes("data-bf-clear"),
    "no Clear all without a filter");
  assert.ok(!boardFilterPanelHtml(groups, Object.assign(emptyBoardView(), { hideDone: true }), 3, 3)
    .includes("checked"), "hidden Done unchecks the switch");
  const chips = boardFilterChipsHtml(groups, view);
  assert.ok(!chips.includes("<img") && chips.includes('data-bf-unset="label"'));
  assert.equal(boardFilterChipsHtml(groups, emptyBoardView()), "");
  const menu = boardSortMenuHtml({ sort: "priority", rev: true });
  assert.match(menu, /data-bs-sort="priority"[^>]*>Priority<span>✓/);
  assert.match(menu, /data-bs-rev="1"[^>]*>Lowest first<span>✓/);
  assert.equal(sortLabel({ sort: "due" }), "Due date");
  assert.equal(sortLabel({}), "Updated");
  assert.equal(SORTS[0][0], "updated", "updated is the default sort");
});

test("boardHtml: a view filters each column, counts n / total, and can hide Done", () => {
  const tickets = [
    tk({ key: "A-1", type: "Bug", statusCategory: "todo" }),
    tk({ key: "A-2", type: "Story", statusCategory: "todo" }),
    tk({ key: "A-3", type: "Story", statusCategory: "done", status: "Done" }),
  ];
  const sites = [site(tickets)];
  const plain = boardHtml(sites, null, {});
  assert.match(plain, /To Do <span class="kc-count">2<\/span>/);
  const v = Object.assign(emptyBoardView(), { f: { type: ["Bug"] } });
  const html = boardHtml(sites, null, { view: v, now: NOW });
  assert.match(html, /To Do <span class="kc-count">1 \/ 2<\/span>/);
  assert.match(html, /Done <span class="kc-count">0 \/ 1<\/span>/);
  assert.ok(html.includes('data-key="A-1"') && !html.includes('data-key="A-2"'));
  assert.match(html, /no matches/, "an emptied column says so");
  const hidden = boardHtml(sites, null, { view: Object.assign(emptyBoardView(), { hideDone: true }) });
  assert.ok(!hidden.includes('data-cat="done"'), "hideDone drops the Done column");
  assert.match(hidden, /To Do <span class="kc-count">2<\/span>/, "sort/Done alone don't change counts");
  const sorted = boardHtml(sites, null, { view: Object.assign(emptyBoardView(), { sort: "key", rev: true }) });
  assert.ok(sorted.indexOf('data-key="A-2"') < sorted.indexOf('data-key="A-1"'));
});

test("boardHtml: a card mid-move stays visible even when the view would drop it", () => {
  const sites = [site([tk({ key: "A-1", type: "Story" })])];
  const moves = new Map([[SITE + "\x00A-1", { pending: true, category: "inprogress" }]]);
  const v = Object.assign(emptyBoardView(), { f: { type: ["Bug"] } });
  const html = boardHtml(sites, null, { view: v, moves });
  assert.ok(html.includes('data-key="A-1"'));
});

test("board.html carries the toolbar controls its script binds", () => {
  const src = fs.readFileSync(path.join(__dirname, "../public/board.html"), "utf8");
  for (const id of ["boardSearch", "boardSearchClear", "boardFilterBtn", "boardFilterBadge",
    "boardFilterChips", "boardFilterPop", "boardSortBtn", "boardSortLabel", "boardSortMenu",
    "boardMoreBtn", "boardActions"]) {
    assert.ok(src.includes(`id="${id}"`), `#${id} present`);
    assert.ok(src.includes(`getElementById("${id}")`), `#${id} bound`);
  }
  assert.match(src, /view,\n/, "render passes the view to boardHtml");
  assert.match(src, /view\.hideDone && B\.categoryOf\(t\) === "done"/,
    "the Showing N of M footer leaves out a hidden Done column (QA defect 4)");
  assert.match(src, /function fitChips\(\)/, "overflowing chips collapse into +N (QA defect 5)");
  assert.ok(!src.includes('history.replaceState(null, "", location.pathname);'),
    "the deep link no longer wipes the view's query params");
});

// XERK-2634: the policy refusal toasts name the org bare, never the tenant key.
// The save paths are fetch-and-toast glue with no sandbox here, so this pins the
// source: both toasts route the siteKey through TurmaBoard.bareKey.
test("board.html's policy refusal toasts print the siteKey bare", () => {
  const src = fs.readFileSync(path.join(__dirname, "../public/board.html"), "utf8");
  assert.ok(src.includes("`Triage policy for ${B.bareKey(siteKey)}`"));
  assert.ok(src.includes("`Permission policy for ${B.bareKey(siteKey)}`"));
  assert.doesNotMatch(src, /policy for \$\{siteKey\}/);
});

// XERK-2676: paintDetail's innerHTML swap must hand focus back to the control
// that held it (or ✕), not drop it to <body>; closing must return focus to the
// ticket's card even after a board repaint replaced it. Drives the helpers
// lifted out of board.html against a minimal fake DOM whose selectors are the
// exact strings the helpers build.
test("board.html restores detail-panel focus across repaints and on close", () => {
  const src = fs.readFileSync(path.join(__dirname, "../public/board.html"), "utf8");
  const pick = (name) => {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name} not found`);
    return m[0];
  };
  const paint = pick("paintDetail");
  assert.ok(paint.indexOf("focusKeyIn($panel)") < paint.indexOf("$panel.innerHTML ="));
  assert.ok(paint.indexOf("restoreFocusIn($panel, refocus)") > paint.indexOf("$panel.innerHTML ="));
  assert.match(pick("closeDetail"), /returnFocusTarget\(lastFocus\)/);

  // sel: the one selector string this fake element answers to.
  const el = (tag, attrs, cls, sel) => ({
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    classList: cls ? [cls] : [],
    dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-"))
      .map(([k, v]) => [k.slice(5), v])),
    getAttribute(n) { return attrs[n] === undefined ? null : attrs[n]; },
    sel: sel || (cls === "td-close" ? ".td-close" : ""),
    focusArgs: [],
    focus(o) { this.focusArgs.push(o); },
  });
  const panel = (kids) => ({
    contains: (e) => kids.includes(e),
    querySelectorAll: (sel) => kids.filter(k => k.sel === sel),
    querySelector: (sel) => kids.find(k => k.sel === sel) || null,
  });
  const doc = { activeElement: null, contains: () => true, querySelector: () => null };
  const { focusKeyIn, restoreFocusIn, returnFocusTarget } = new Function("document", "CSS",
    `${pick("focusKeyIn")}\n${pick("restoreFocusIn")}\n${pick("returnFocusTarget")}\n` +
    "return { focusKeyIn, restoreFocusIn, returnFocusTarget };")(doc, { escape: (v) => v });
  const close = () => el("button", {}, "td-close");

  // ✕ (class only) → the fresh ✕, without scrolling.
  const x0 = el("button", {}, "td-close", "button.td-close");
  doc.activeElement = x0;
  const k1 = focusKeyIn(panel([x0]));
  assert.deepEqual(k1, { sel: "button.td-close", nth: 0 });
  const x1 = el("button", {}, "td-close", "button.td-close");
  restoreFocusIn(panel([x1]), k1);
  assert.deepEqual(x1.focusArgs, [{ preventScroll: true }]);

  // A data-* control that survives gets focus alone; one that's gone → ✕.
  const btnSel = 'button[data-epic-run="1"]';
  const b0 = el("button", { "data-epic-run": "1", type: "button" }, "", btnSel);
  doc.activeElement = b0;
  const k2 = focusKeyIn(panel([b0]));
  assert.deepEqual(k2, { sel: btnSel, nth: 0 });
  const b1 = el("button", { "data-epic-run": "1" }, "", btnSel), x2 = close();
  restoreFocusIn(panel([x2, b1]), k2);
  assert.equal(b1.focusArgs.length, 1);
  assert.equal(x2.focusArgs.length, 0);
  const x3 = close();
  restoreFocusIn(panel([x3]), k2);
  assert.equal(x3.focusArgs.length, 1);

  // Bare links sharing an href (header key link vs "Open in Jira") keep their place.
  const hSel = 'a[href="https://x.test/W-1"]';
  const head0 = el("a", { href: "https://x.test/W-1" }, "", hSel);
  const foot0 = el("a", { href: "https://x.test/W-1" }, "", hSel);
  doc.activeElement = foot0;
  const k3 = focusKeyIn(panel([head0, foot0]));
  assert.deepEqual(k3, { sel: hSel, nth: 1 });
  const head1 = el("a", { href: "https://x.test/W-1" }, "", hSel);
  const foot1 = el("a", { href: "https://x.test/W-1" }, "", hSel);
  restoreFocusIn(panel([close(), head1, foot1]), k3);
  assert.equal(foot1.focusArgs.length, 1);
  assert.equal(head1.focusArgs.length, 0);

  // A control with no data-*, class or href → ✕.
  doc.activeElement = el("span", {});
  const k4 = focusKeyIn(panel([doc.activeElement]));
  assert.deepEqual(k4, { sel: null, nth: 0 });
  const x5 = close();
  restoreFocusIn(panel([x5]), k4);
  assert.equal(x5.focusArgs.length, 1);

  // Focus outside the panel → nothing is stolen.
  doc.activeElement = el("input", { "data-search": "1" });
  assert.equal(focusKeyIn(panel([])), null);
  const x4 = close();
  restoreFocusIn(panel([x4]), null);
  assert.equal(x4.focusArgs.length, 0);

  // Close: the opener card if still attached, else the card redrawn for that ticket.
  const card = el("div", { "data-key": "W-1", "data-site": "s1" }, "kanban-card");
  assert.equal(returnFocusTarget(card), card);
  const redrawn = {};
  let asked = "";
  doc.contains = () => false;
  doc.querySelector = (sel) => { asked = sel; return redrawn; };
  assert.equal(returnFocusTarget(card), redrawn);
  assert.equal(asked, '.kanban-card[data-key="W-1"][data-site="s1"]');
  assert.equal(returnFocusTarget(null), null);
});
