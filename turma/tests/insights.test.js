// Unit tests for the Insights page (public/insights.html, XERK-2386): its sub-pages,
// the decisions log (XERK-1574), the permission-prompt card (XERK-1563) and the
// model-quality card (XERK-1849).
// node:test, no npm — matches this package's zero-dependency stance. There's no
// jsdom here, so the page's real inline <script> is loaded into a minimal DOM
// shim (the same trick sessions.test.js uses) and the pure helpers are returned
// out of the sandbox; only those helpers are exercised, so the shim only has to
// be complete enough for the page's boot to not throw.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
// The page loads board.js/nav.js/org.js/newticket.js by <script src>, then its
// own logic in the one inline block — take the last, which is that block.
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const script = blocks[blocks.length - 1][1];

function makeEl() {
  const el = {
    _html: "", textContent: "", value: "", hidden: false,
    style: { setProperty(k, v) { this[k] = String(v); } }, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    listeners: {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener() {},
    append(...c) { this.children.push(...c); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; }, set(v) { this._html = String(v); },
  });
  return el;
}

// Run the page once and hand back the pure helpers. The page's boot calls
// (renderViewbar/connectSSE/the poll) run against the shim and are inert: fetch
// never settles and EventSource is a no-op, so nothing renders.
// What the page's TurmaOrg.filter stub does, swappable per test. Identity by
// default, which is "All orgs".
let orgFilter = (agents) => agents;
// The header's selected org keys, for the permission card's scoped fetch.
let orgKeys = [];
// A test may stand in org.js's own key/update behaviour (getKeys is [] until
// update() has seen the sites the data names); null = the plain stub above.
let orgHooks = null;

function loadHelpers(fetchReply = null, hash = "#permissions") {
  const els = {};
  const sse = [];
  const fetches = [];
  const timers = [];
  const intervals = [];
  const winListeners = {};
  const scrollCalls = [];
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); },
    createElementNS() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener: noop, removeEventListener: noop,
    body: makeEl(), documentElement: makeEl(),
  };
  const stubs = {
    document,
    localStorage: {
      _m: {},
      getItem(k) { return this._m[k] ?? null; },
      setItem(k, v) { this._m[k] = String(v); },
      removeItem(k) { delete this._m[k]; },
    },
    location: { href: "", search: "", pathname: "/insights", hash },
    navigator: { userAgent: "node" },
    fetch: (u) => {
      fetches.push(String(u));
      if (!fetchReply) return new Promise(() => {});
      // `fetchReply.httpStatus(url)` returning n answers that refusal instead of a body.
      const status = fetchReply.httpStatus && fetchReply.httpStatus(String(u));
      if (status) return Promise.resolve({ status, ok: false,
        json: () => Promise.resolve(fetchReply.refusalBody ? fetchReply.refusalBody(String(u)) : {}) });
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(fetchReply(String(u))) });
    },
    // Captures the page's SSE handlers so a test can deliver a real `removed`
    // event — the fallback poll is skipped while the stream is healthy, so that
    // handler is the only thing that keeps `retiredUsage` current.
    EventSource: class {
      constructor() { sse.push(this); this.handlers = {}; this.readyState = 1; }
      addEventListener(name, fn) { this.handlers[name] = fn; }
      close() {}
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: noop,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    history: { replaceState: noop, pushState: noop },
    URL: global.URL, URLSearchParams: global.URLSearchParams,
    console, Date, Math, JSON, encodeURIComponent, decodeURIComponent,
    parseInt, parseFloat, isNaN, Number, String, Object, Array, Map, Set,
    addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); }, removeEventListener: noop,
    TurmaNav: { preserveScroll: (el, paint) => { scrollCalls.push(el); paint(); },
      refusalText: (what, status, body) => (body && typeof body.error === "string" && body.error) || `the hub answered HTTP ${status}` },
    // Indirected through `orgFilter` so a test can narrow the page the way the
    // header's org control does, and check what each section was rendered from.
    TurmaOrg: { get: () => (orgKeys.length === 1 ? orgKeys[0] : ""), getKeys: () => (orgHooks ? orgHooks.getKeys() : orgKeys),
      update: (d) => { if (orgHooks) orgHooks.update(d); }, filter: (a) => orgFilter(a),
      subscribe: noop, sse: noop, orgColors: () => ({}) },
    TurmaBoard: { orgName: (k, o) => o || k, orgColorMap: () => ({}),
      mergeSites: (agents) => agents.map((a) => a.jira).filter(Boolean) },
    TurmaNewTicket: { update: noop },
  };
  const keys = Object.keys(stubs);
  const body = `${script}\n;return { render, refresh, paneOf, PANES, getPane: () => pane,
    decisionsHtml, renderDecisions, drafts, syncPermissionsScope,
    modelQualityCardHtml, refreshModelQuality, syncModelQualityScope, mqBadRate, mqOrdered, getMqView: () => mqView,
    permissionsCardHtml, refreshPermissions, getPermView: () => permView, setCache: (c) => { cache = c; }, getCache: () => cache };`;
  // `els` rides along so the render-level tests can reach the containers the
  // page paints INTO — the strip is written to #totals rather than returned.
  const api = new Function(...keys, body)(...keys.map((k) => stubs[k]));
  const runTimers = async () => {
    for (const t of timers.splice(0).filter(Boolean)) await t.fn();
  };
  return Object.assign(api, { els, sse, fetches, timers, runTimers, scrollCalls, intervals, winListeners, stubs,
    navigator: stubs.navigator });
}

const H = loadHelpers();

// --- Sub-pages (XERK-2386) -------------------------------------------------------

test("XERK-2386: the hash picks the sub-page; anything else is Decisions", () => {
  assert.deepEqual(H.PANES, ["decisions", "permissions", "model-quality"]);
  assert.equal(H.paneOf("#model-quality"), "model-quality");
  assert.equal(H.paneOf("#permissions"), "permissions");
  assert.equal(H.paneOf(""), "decisions");
  assert.equal(H.paneOf("#brief"), "decisions");
  assert.equal(H.paneOf("#__proto__"), "decisions");
});

test("XERK-2386: only the shown sub-page fetches", async () => {
  const reply = (u) => (u.startsWith("/api/agents") ? { agents: [] } : { days: 7, top: [], recent: [], groups: [] });
  const onDecisions = loadHelpers(reply, "");
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(onDecisions.getPane(), "decisions");
  assert.equal(onDecisions.fetches.some((u) => u.startsWith("/api/permissions") || u.startsWith("/api/model-quality")), false);
  const onMq = loadHelpers(reply, "#model-quality");
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.ok(onMq.fetches.some((u) => u.startsWith("/api/model-quality")));
  assert.equal(onMq.fetches.some((u) => u.startsWith("/api/permissions")), false);
});

test("XERK-2386: each sub-page has a tab and a pane; the page is the nav's Insights tab", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
  for (const p of ["decisions", "permissions", "model-quality"]) {
    assert.match(src, new RegExp(`<a href="#${p}" data-pane="${p}">`));
    assert.match(src, new RegExp(`data-pane-body="${p}"`));
  }
  assert.match(src, /data-page="insights"/);
});

test("XERK-2386: no element id equals a sub-page hash, so loading one never scrolls the tabs away", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
  for (const p of H.PANES) assert.equal(src.includes(`id="${p}"`), false, p);
});

test("XERK-2386: switching sub-page by hash shows it and refetches its card", async () => {
  const reply = (u) => (u.startsWith("/api/agents") ? { agents: [] } : { days: 7, top: [], recent: [], groups: [] });
  const P = loadHelpers(reply, "#permissions");
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const perms = () => P.fetches.filter((u) => u.startsWith("/api/permissions")).length;
  const before = perms();
  assert.ok(before >= 1);
  P.stubs.location.hash = "#decisions";
  for (const fn of P.winListeners.hashchange) fn();
  assert.equal(P.getPane(), "decisions");
  P.stubs.location.hash = "#permissions";
  for (const fn of P.winListeners.hashchange) fn();
  assert.equal(P.getPane(), "permissions");
  assert.equal(perms(), before + 1, "coming back refetches; its timer did not run while hidden");
});

test("XERK-2386: a card's minute timer fetches only while its sub-page shows", async () => {
  const reply = (u) => (u.startsWith("/api/agents") ? { agents: [] } : { days: 7, top: [], recent: [], groups: [] });
  const P = loadHelpers(reply, "");
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  P.syncPermissionsScope();   // each card was shown once, so it is scoped
  P.syncModelQualityScope([]);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const n = P.fetches.length;
  for (const t of P.intervals.filter((x) => x.ms === 60000)) t.fn();
  const cards = P.fetches.slice(n).filter((u) => u.startsWith("/api/permissions") || u.startsWith("/api/model-quality"));
  assert.deepEqual(cards, []);
});

test("XERK-1574: a note's text is escaped; the draft survives a repaint", () => {
  H.drafts.set("a.net", 'half <img src=x onerror="alert(1)">');
  try {
    const html = H.decisionsHtml("a.net", [{ at: 1000, source: "note", text: "<script>x</script>" }], 5000, true);
    assert.equal(html.includes("<script>"), false);
    assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
    assert.ok(html.includes('value="half &lt;img src=x onerror=&quot;alert(1)&quot;&gt;"'));
  } finally { H.drafts.delete("a.net"); }
});

test("XERK-2386: a first visit to a card fetches it once; a return to Model quality refetches", async () => {
  const reply = (u) => (u.startsWith("/api/agents") ? { agents: [] } : { days: 7, top: [], recent: [], groups: [] });
  const P = loadHelpers(reply, "");
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const count = (pre) => P.fetches.filter((u) => u.startsWith(pre)).length;
  const go = (h) => { P.stubs.location.hash = h; for (const fn of P.winListeners.hashchange) fn(); };
  go("#permissions");
  assert.equal(count("/api/permissions"), 1, "the scope sync's fetch, not a second one");
  go("#model-quality");
  assert.equal(count("/api/model-quality"), 1);
  go("#decisions");
  go("#model-quality");
  assert.equal(count("/api/model-quality"), 2, "coming back refetches");
});

test("XERK-2386: a decisions card names its org as the hosts report it, not the derived name", () => {
  const P = loadHelpers(null, "");
  P.renderDecisions({ agents: [{ org: "acme.atlassian.net", jira: { siteKey: "acme.atlassian.net", orgName: "Acme Corp" } }],
    decisions: { "acme.atlassian.net": [{ at: 1000, source: "note", text: "n" }] } }, 5000);
  assert.match(P.els.decisionsLog.innerHTML, /<span class="dec-org-name">Acme Corp <span class="n">1<\/span>/);
});

// --- Decisions (XERK-1574) -------------------------------------------------------

test("XERK-1574: the decisions tail is newest first, escaped, a composer only for a live org", () => {
  const list = [
    { at: 1000, source: "question", question: "Which <DB>?", answer: "PG", ticket: "X-1", host: "h" },
    { at: 2000, source: "note", text: "No infra merges." },
  ];
  const html = H.decisionsHtml("a.net", list, 5000, true);
  assert.ok(html.indexOf("No infra merges.") < html.indexOf("Which &lt;DB&gt;?"), "newest first");
  assert.match(html, /data-note="a\.net"/);
  assert.equal(H.decisionsHtml("a.net", list, 5000, false).includes("data-note"), false);
  assert.equal(H.decisionsHtml("a.net", [], 5000, false), "", "nothing to show, nowhere to add");
  assert.match(H.decisionsHtml("a.net", [], 5000, true), /No decisions recorded yet/);
});

test("XERK-1574: the decisions count is the org's, not the served tail's", () => {
  const tail = Array.from({ length: 20 }, (_, i) => ({ at: 1000 + i, source: "note", text: `n${i}` }));
  assert.match(H.decisionsHtml("a.net", tail, 5000, false, 50, "Acme"), /Acme <span class="n">50<\/span>/);
  assert.match(H.decisionsHtml("a.net", tail, 5000, false, 50, "Acme"), /\+30 earlier/);
  // An older hub sends no count: the served list is the floor.
  assert.match(H.decisionsHtml("a.net", tail, 5000, false, undefined, "Acme"), /Acme <span class="n">20<\/span>/);
  assert.match(H.decisionsHtml("a.net", tail, 5000, false, 3, "Acme"), /Acme <span class="n">20<\/span>/);
});

test("XERK-1574: a decision row names the session it came from, clipped", () => {
  const html = H.decisionsHtml("a.net", [
    { at: 1000, source: "question", question: "Q?", answer: "A", label: "archive <index> work", host: "h" },
    { at: 2000, source: "question", question: "Q2?", answer: "B", label: "x".repeat(80) },
  ], 5000, false);
  const text = (s) => s.replace(/<[^>]*>/g, "");
  assert.ok(text(html).includes("question · archive &lt;index&gt; work · 4s ago · h"));
  assert.ok(html.includes(`${"x".repeat(59)}…`));
  assert.equal(html.includes("x".repeat(60)), false, "a long label is clipped");
});

test("XERK-1574: a typed-answer marker is muted, never bold as if chosen", () => {
  const html = H.decisionsHtml("a.net", [
    { at: 1000, source: "question", question: "Which DB?", answer: "Postgres, plus a typed answer" },
    { at: 2000, source: "question", question: "Why?", answer: "(a typed answer)" },
    { at: 3000, source: "question", question: "Q?", answer: "Yes" },
  ], 5000, false);
  assert.ok(html.includes('Which DB? → <b>Postgres</b><span class="typed">, plus a typed answer</span>'));
  assert.ok(html.includes('Why? → <span class="typed">(a typed answer)</span>'));
  assert.ok(html.includes("Q? → <b>Yes</b>"));
  assert.equal(/<b>[^<]*typed answer/.test(html), false);
});

test("XERK-1574: a decision's kind is a noun, its meta pieces each unbreakable", () => {
  const html = H.decisionsHtml("a.net", [
    { at: 1000, source: "question", question: "Q?", answer: "A", ticket: "X-1", label: "work", host: "Jira poller" },
    { at: 2000, source: "permission", question: "Bash", answer: "Yes" },
    { at: 3000, source: "note", text: "n" },
  ], 5000, false);
  for (const k of ["question", "permission", "note"]) assert.ok(html.includes(`<span class="kind">${k}</span>`), k);
  // The "·" ENDS each piece but the last, so a wrapped line never starts with one.
  const sep = '<span class="sep"> ·</span>';
  assert.ok(html.includes(`<span class="bit"><span class="v"><span class="kind">question</span></span>${sep}</span>`
    + ` <span class="bit"><span class="v"><span class="key">X-1</span></span>${sep}</span>`
    + ` <span class="bit"><span class="v"><span class="sess">work</span></span>${sep}</span>`
    + ` <span class="bit"><span class="v">4s ago</span>${sep}</span>`
    + ' <span class="bit"><span class="v">Jira poller</span></span></div>'));
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
  assert.match(src, /\.dec-meta \.bit \{[^}]*white-space: nowrap;/);
  assert.match(src, /\.dec-meta \.bit > \.v \{[^}]*text-overflow: ellipsis/);
  assert.match(src, /\.dec-meta \.bit > \.sep \{[^}]*flex: none/);
});

test("XERK-1574: a decisions frame that lands mid-fetch survives the older snapshot", async () => {
  let release;
  const P = loadHelpers((u) => (u.startsWith("/api/agents")
    ? new Promise((r) => { release = () => r({ agents: [], decisions: { "a.net": [{ text: "old" }] }, decisionCounts: { "a.net": 3 } }); })
    : {}), "");
  P.setCache({ agents: [], decisions: {}, decisionCounts: {} });
  const done = P.refresh();
  await new Promise((r) => setImmediate(r));
  const es = P.sse[0];
  es.handlers.decisionCounts({ data: JSON.stringify({ "a.net": 4 }) });
  es.handlers.decisions({ data: JSON.stringify({ "a.net": [{ text: "new" }] }) });
  release();
  await done;
  assert.equal(P.getCache().decisions["a.net"][0].text, "new");
  assert.equal(P.getCache().decisionCounts["a.net"], 4);
});

// --- Permission prompts (XERK-1563) --------------------------------------------

const PERM_NOW = Date.parse("2026-10-03T12:00:00Z");
const permView = {
  days: 7,
  top: [
    { kind: "dialog", dialogKind: "permission", tool: "Bash", head: "git status", count: 12,
      allowed: 11, denied: 1, medianWaitMs: 95000, lastAt: PERM_NOW, suggestedRule: "Bash(git status:*)" },
    { kind: "classifier-denied", tool: "Bash", head: "git rev-parse", count: 3, allowed: 0, denied: 3,
      medianWaitMs: null, lastAt: PERM_NOW, suggestedRule: "autoMode.environment: allow Bash(git rev-parse:*)" },
    { kind: "dialog", dialogKind: "plan", tool: "ExitPlanMode", head: "ExitPlanMode", count: 1,
      allowed: 1, denied: 0, medianWaitMs: 4000, lastAt: PERM_NOW, suggestedRule: null },
  ],
  recent: [
    { host: "nas01", kind: "ask-in-chat", prompt: "Should I proceed with the deploy?",
      openedAt: PERM_NOW - 120000, waitedMs: 60000, answer: "unknown" },
  ],
};

test("XERK-1563: the permission card lists each prompt with its rule and a copy button", () => {
  const html = H.permissionsCardHtml(permView, PERM_NOW);
  assert.match(html, /Permission prompts \(7 days\)/);
  assert.match(html, /<code>Bash\(<wbr>git status:\*\)<\/code><button[^>]*data-perm-rule="Bash\(git status:\*\)"/);
  // count, answers, median wait — each labelled for the phone's stacked block
  assert.match(html, /data-label="Count">12<\/td>\s*<td[^>]*data-label="Allowed \/ denied">11 \/ 1<\/td>\s*<td[^>]*data-label="Median wait">2m<\/td>/);
  assert.match(html, /k-classifier-denied/);
  assert.match(html, /Dialog · plan/);
  assert.match(html, /no rule retires this/);             // a plan approval has no rule
  assert.match(html, /Recent prompts \(1\)/);
  // An ask has no allow/deny by design: its stored "unknown" never shows (the
  // table says "—" for the same group), and the host leads the meta group.
  assert.match(html, /Should I proceed with the deploy\?<\/span><span class="perm-meta"><span class="meta">nas01<\/span><span class="meta">waited 1m<\/span><span class="meta">2m ago<\/span><\/span>/);
  assert.doesNotMatch(html, /unknown/);
});

test("XERK-1566: a judged row is labelled and says what the judge decided, escaped", () => {
  const html = H.permissionsCardHtml({ days: 7,
    top: [{ kind: "judged", tool: "Bash", head: "npm run", count: 1, allowed: 1, denied: 0 }],
    recent: [{ kind: "judged", tool: "Bash", head: "npm run", host: "nas01", answer: "allow",
      verdict: "allow", judgeReason: "tests <b>ok</b>", openedAt: PERM_NOW - 60000, closedAt: PERM_NOW }] },
  PERM_NOW);
  assert.match(html, /<span class="perm-kind k-judged">Judged<\/span>/);
  assert.match(html, /judge: allow — tests &lt;b&gt;ok&lt;\/b&gt;/);
});

test("XERK-1566: a long judge reason wraps inside the card; host, wait and age stay unbroken", () => {
  const reason = "the command only runs the project's own unit tests against a scratch directory and touches nothing outside the worktree";
  const html = H.permissionsCardHtml({ days: 7,
    top: [{ kind: "judged", tool: "Bash", head: "npm test", count: 1, allowed: 1, denied: 0 }],
    recent: [{ kind: "judged", tool: "Bash", head: "npm test", host: "nas01", answer: "allow", waitedMs: 4000,
      verdict: "allow", judgeReason: reason, openedAt: PERM_NOW - 60000, closedAt: PERM_NOW }] },
  PERM_NOW);
  // The judge line is its OWN span, so the no-break wait span stays short and
  // the host still leads the group.
  assert.match(html, new RegExp('<span class="perm-meta"><span class="meta">nas01</span>' +
    '<span class="meta">waited 4s · allow</span>' +
    `<span class="meta meta-judge">judge: allow — ${reason.replace("'", "&#39;")}</span>` +
    '<span class="meta">1m ago</span></span>'));
  // Only that span may wrap: every other meta keeps white-space: nowrap.
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
  assert.match(src, /\.perm-recent \.meta \{[^}]*white-space: nowrap;/);
  const rule = src.match(/\.perm-recent \.meta\.meta-judge \{([^}]*)\}/);
  assert.ok(rule, "a wrapping rule for the judge span");
  assert.match(rule[1], /white-space: normal;/);
  assert.match(rule[1], /overflow-wrap: break-word;/);
  assert.match(rule[1], /min-width: 0;/);
});

test("XERK-1563: a group still waiting on its only answer reads 'open', never 0 / 0", () => {
  const g = { kind: "dialog", dialogKind: "permission", tool: "Bash", head: "terraform apply",
    suggestedRule: "Bash(terraform apply:*)", medianWaitMs: null };
  const one = H.permissionsCardHtml({ days: 7, recent: [], top: [{ ...g, count: 1, allowed: 0, denied: 0, open: 1 }] }, PERM_NOW);
  assert.match(one, /data-label="Allowed \/ denied"><span class="perm-na"[^>]*>still open<\/span><\/td>/);
  assert.doesNotMatch(one, /0 \/ 0/);
  // Some answered, some still open: the answers, and how many still wait.
  const mixed = H.permissionsCardHtml({ days: 7, recent: [], top: [{ ...g, count: 3, allowed: 1, denied: 0, open: 2 }] }, PERM_NOW);
  assert.match(mixed, /data-label="Allowed \/ denied">1 \/ 0 <span class="perm-na">· 2 open<\/span><\/td>/);
  // An older hub sends no `open`: unchanged.
  const old = H.permissionsCardHtml({ days: 7, recent: [], top: [{ ...g, count: 1, allowed: 1, denied: 0 }] }, PERM_NOW);
  assert.match(old, /data-label="Allowed \/ denied">1 \/ 0<\/td>/);
  // An ask still waiting is open too; once answered it is "—".
  const ask = { kind: "ask-in-chat", prompt: "May I push?", count: 1, allowed: null, denied: null };
  assert.match(H.permissionsCardHtml({ days: 7, recent: [], top: [{ ...ask, open: 1 }] }, PERM_NOW), />still open<\/span>/);
  assert.match(H.permissionsCardHtml({ days: 7, recent: [], top: [{ ...ask, open: 0 }] }, PERM_NOW), />—<\/span>/);
});

test("XERK-1563: a recent row says 'still open' only while it has no answer at all", () => {
  const rows = (r) => H.permissionsCardHtml({ days: 7, top: [{ kind: "dialog", head: "x", count: 1 }],
    recent: [{ host: "h1", kind: "dialog", head: "x", openedAt: PERM_NOW - 60000, ...r }] }, PERM_NOW);
  assert.match(rows({}), /<span class="meta">h1<\/span><span class="meta">still open<\/span>/);
  // A request answered between two beats arrives closed-less but answered.
  const between = rows({ answer: "unknown" });
  assert.doesNotMatch(between, /still open/);
  assert.match(between, /<span class="meta">h1<\/span><span class="meta">unknown<\/span>/);
  // No host: the group leads with the next part rather than an empty slot.
  assert.match(H.permissionsCardHtml({ days: 7, top: [{ kind: "dialog", head: "x", count: 1 }],
    recent: [{ kind: "dialog", head: "x", openedAt: PERM_NOW - 60000, waitedMs: 1000, closedAt: PERM_NOW, answer: "allow" }] }, PERM_NOW),
    /<span class="perm-meta"><span class="meta">waited 1s · allow<\/span>/);
});

test("XERK-1563: every agent-supplied field in the card is escaped", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = H.permissionsCardHtml({ days: 7,
    top: [{ kind: "dialog", tool: evil, head: `"${evil}`, count: 1, suggestedRule: `Bash(${evil})` }],
    recent: [{ host: evil, kind: "dialog", head: evil, openedAt: PERM_NOW }] }, PERM_NOW);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-perm-rule="Bash\(&lt;img/);
});

test("XERK-1563: the card says loading, then empty, never a broken table", () => {
  assert.match(H.permissionsCardHtml(null, PERM_NOW), /Loading/);
  const empty = H.permissionsCardHtml({ days: 7, top: [], recent: [] }, PERM_NOW);
  assert.match(empty, /No permission prompts recorded in the last 7 days/);
  assert.doesNotMatch(empty, /<table/);
  // A malformed view (an older hub answering something else) degrades the same way.
  assert.match(H.permissionsCardHtml({ top: "nope", recent: [null] }, PERM_NOW), /No permission prompts/);
});

test("XERK-1563: a refused first fetch says it failed; a later one keeps the last view", async () => {
  let refuse = 401;
  const reply = () => permView;
  reply.httpStatus = (u) => (u.startsWith("/api/permissions") ? refuse : 0);
  const H5 = loadHelpers(reply);
  await H5.refreshPermissions();
  const el = H5.els.permissionsCard;
  assert.match(el.innerHTML, /Could not load permission prompts \(HTTP 401\)\./);
  assert.doesNotMatch(el.innerHTML, /Loading/);
  refuse = 0;
  await H5.refreshPermissions();
  assert.match(el.innerHTML, /Bash\(git status:\*\)/);
  refuse = 503;
  await H5.refreshPermissions();
  assert.match(el.innerHTML, /Bash\(git status:\*\)/, "a failed refresh keeps the last view");
  assert.doesNotMatch(el.innerHTML, /Could not load/);
  // The error is escaped like every other field.
  assert.match(H5.permissionsCardHtml(null, PERM_NOW, false, "<b>"), /\(&lt;b&gt;\)/);
});

test("XERK-1563: a failed fetch after an org change never shows the old org's view", async () => {
  let refuse = 0;
  const reply = () => permView;
  reply.httpStatus = (u) => (u.startsWith("/api/permissions") ? refuse : 0);
  const H6 = loadHelpers(reply);
  const el = H6.els.permissionsCard;
  orgKeys = ["acme.atlassian.net"];
  try {
    await H6.refreshPermissions();
    assert.match(el.innerHTML, /Bash\(git status:\*\)/);
    // The operator picks another org and that org's read is refused.
    orgKeys = ["rival.atlassian.net"];
    refuse = 503;
    const pending = H6.refreshPermissions();
    // While it is in flight the old org's prompts are already gone.
    assert.match(el.innerHTML, /Loading/);
    assert.doesNotMatch(el.innerHTML, /git status/);
    await pending;
    assert.match(el.innerHTML, /Could not load permission prompts \(HTTP 503\)\./);
    assert.doesNotMatch(el.innerHTML, /git status/, "acme's view must not read as rival's");
    assert.equal(H6.getPermView(), null);
    // A good read for the new org replaces the failure.
    refuse = 0;
    await H6.refreshPermissions();
    assert.match(el.innerHTML, /Bash\(git status:\*\)/);
    assert.doesNotMatch(el.innerHTML, /Could not load/);
  } finally { orgKeys = []; }
});

test("XERK-1563: the minute repaint keeps Recent prompts open and goes through preserveScroll", async () => {
  const H4 = loadHelpers(() => permView);
  await H4.refreshPermissions();
  const el = H4.els.permissionsCard;
  assert.match(el.innerHTML, /<details class="table-view perm-recent-view"><summary>/);   // closed by default
  assert.ok(H4.scrollCalls.includes(el), "the repaint must go through TurmaNav.preserveScroll");
  // The operator opens it; the next refresh must not snap it shut.
  const toggle = (open) => el.listeners.toggle.forEach((fn) => fn({
    target: { open, matches: (sel) => sel === "details.perm-recent-view" } }));
  toggle(true);
  await H4.refreshPermissions();
  assert.match(el.innerHTML, /<details class="table-view perm-recent-view" open><summary>/);
  toggle(false);
  await H4.refreshPermissions();
  assert.doesNotMatch(el.innerHTML, /perm-recent-view" open/);
  // An unchanged card is not repainted at all — even though a browser hands
  // innerHTML back re-serialized (`open` as `open=""`), so the skip must not
  // compare against what it reads back.
  toggle(true);
  await H4.refreshPermissions();
  el.innerHTML = el.innerHTML.replace(/ open>/g, ' open="">');
  const n = H4.scrollCalls.length;
  await H4.refreshPermissions();
  assert.equal(H4.scrollCalls.length, n);
});

test("XERK-1563: the card's fetch is scoped by the header's org filter", async () => {
  const H3 = loadHelpers(() => permView);
  orgKeys = ["acme.atlassian.net", "rival.atlassian.net"];
  try {
    await H3.refreshPermissions();
  } finally { orgKeys = []; }
  const url = H3.fetches.filter((u) => u.startsWith("/api/permissions")).pop();
  assert.equal(url, "/api/permissions?days=7&org=acme.atlassian.net%2Crival.atlassian.net");
  assert.equal(H3.getPermView(), permView);
  assert.match(H3.els.permissionsCard.innerHTML, /Bash\(git status:\*\)/);
});

test("XERK-1563: the card's first fetch waits for the org scope, then follows it", async () => {
  // org.js's real order: getKeys() is [] until update() has seen the sites
  // /api/agents names, so a fetch at script start would go out unscoped.
  let site = null;
  orgHooks = {
    getKeys: () => (site ? [site] : []),
    update: (d) => { if (!site) site = d && d.site; },   // the sites are now known
  };
  try {
    const H5 = loadHelpers((u) => (u.startsWith("/api/agents")
      ? { now: Date.now(), agents: [], retiredUsage: [], site: "acme.atlassian.net" }
      : permView));
    const card = () => H5.fetches.filter((u) => u.startsWith("/api/permissions"));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(card(), ["/api/permissions?days=7&org=acme.atlassian.net"],
      "never an unscoped fetch before the org keys are known");
    // A render whose keys did not move does not refetch…
    H5.render(H5.getCache());
    assert.equal(card().length, 1);
    // …one whose keys moved does, scoped to the new org.
    site = "rival.atlassian.net";
    H5.render(H5.getCache());
    assert.equal(card().pop(), "/api/permissions?days=7&org=rival.atlassian.net");
  } finally { orgHooks = null; }
});

test("XERK-1563: an ask-in-chat group shows its question as prose and no 0 / 0", () => {
  const html = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "ask-in-chat", prompt: "Should I rebuild the Dockerfile?", count: 2, allowed: null,
      denied: null, medianWaitMs: 60000, suggestedRule: "model behaviour: see CLAUDE.md step 0" },
  ] }, PERM_NOW);
  // The question is the subject, as prose — never mono, never broken mid-word.
  assert.match(html, /<div class="perm-subj">Should I rebuild the Dockerfile\?<\/div>/);
  assert.match(html, /data-label="Allowed \/ denied"><span class="perm-na"[^>]*>—<\/span>/);
  assert.doesNotMatch(html, /0 \/ 0/);
  // A model-behaviour pointer is not a setting: shown as text, nothing to copy.
  assert.match(html, /<td class="perm-rule"><span class="none">Instructions, not a setting — see the note below<\/span><\/td>/);
  assert.doesNotMatch(html, /data-perm-rule/);
  // The note names the file and the step, once — never the hub's bare pointer.
  assert.match(html, /<div class="note perm-foot"><b>Asked in chat<\/b>[^<]*step 0 of “Delivering work” in the global <code>~\/\.claude\/CLAUDE\.md<\/code>/);
  assert.doesNotMatch(html, /see CLAUDE\.md step 0/);
  // An answered ask has no allow/deny: its "—" cell is the one a phone hides.
  assert.match(html, /<td class="perm-stat perm-stat-na" data-label="Allowed \/ denied">/);
  // An older hub that still sends 0 / 0 for an ask reads the same.
  assert.doesNotMatch(H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "ask-in-chat", prompt: "ok?", count: 1, allowed: 0, denied: 0 }] }, PERM_NOW), /0 \/ 0/);
});

test("XERK-1563: four asks share ONE explanatory note; a card with no ask has none", () => {
  const ask = (q) => ({ kind: "ask-in-chat", prompt: q, count: 1, allowed: null, denied: null,
    suggestedRule: "model behaviour: see CLAUDE.md step 0" });
  const html = H.permissionsCardHtml({ days: 7, recent: [], top: [
    ask("May I push?"), ask("Shall I open the PR?"), ask("OK to delete it?"), ask("Proceed?")] }, PERM_NOW);
  assert.equal([...html.matchAll(/perm-foot/g)].length, 1);
  assert.equal([...html.matchAll(/Instructions, not a setting/g)].length, 4);
  // The note sits between the table and the recent list.
  assert.match(html, /<\/table><\/div><div class="note perm-foot">/);
  const plain = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "dialog", tool: "Bash", head: "ls", count: 1, suggestedRule: "Bash(ls:*)" }] }, PERM_NOW);
  assert.doesNotMatch(plain, /perm-foot/);
});

test("XERK-1563: an ask's markdown renders — code spans as code, bold markers dropped", () => {
  const q = "Should I delete `legacy/` and **all** of `__init__.py`? Or `<b>`";
  const html = H.permissionsCardHtml({ days: 7, top: [
    { kind: "ask-in-chat", prompt: q, count: 1, allowed: null, denied: null }],
  recent: [{ host: "h1", kind: "ask-in-chat", prompt: q, openedAt: PERM_NOW - 60000 }] }, PERM_NOW);
  const want = "Should I delete <code>legacy/</code> and all of <code>__init__.py</code>? Or <code>&lt;b&gt;</code>";
  assert.ok(html.includes(`<div class="perm-subj">${want}</div>`), "table subject");
  assert.ok(html.includes(`<span class="perm-subj">${want}</span>`), "recent subject");
  assert.doesNotMatch(html, /`|\*\*|<b>/);
  // An unpaired marker (a question cut at its cap) stays as typed; a COMMAND
  // subject is never read as markdown.
  const cut = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "ask-in-chat", prompt: "Delete `legacy/ and", count: 1 },
    { kind: "dialog", tool: "Bash", head: "echo", count: 1 }] }, PERM_NOW);
  assert.match(cut, /<div class="perm-subj">Delete `legacy\/ and<\/div>/);
});

test("XERK-1563: a rule and its Copy share one line, however long the rule", () => {
  const rule = "sandbox.network.allowedDomains: registry.npmjs.org";
  const html = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "dialog", dialogKind: "sandbox", tool: "Bash", head: "registry.npmjs.org", count: 2,
      allowed: 2, denied: 0, suggestedRule: rule }] }, PERM_NOW);
  assert.ok(html.includes(`<td class="perm-rule"><span class="perm-rule-line"><code>${rule}</code><button type="button" class="perm-copy" data-perm-rule="${rule}"`));
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
  // The line never wraps Copy under the rule: the rule shrinks, Copy does not.
  assert.match(src, /\.perm-rule-line \{ display: flex; align-items: center; gap: 6px; \}/);
  assert.match(src, /\.perm-rule-line code \{ flex: 0 1 auto; min-width: 0; \}/);
  assert.match(src, /\.perm-rule-line \.perm-copy \{ flex: none;/);
  assert.doesNotMatch(src, /td\.perm-rule:has\(\.perm-copy\)/);
  // A narrow box wraps at `(` or a value-starting `:`, not mid-name; Copy
  // still copies the raw rule.
  const wf = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "dialog", tool: "WebFetch", head: "docs.example.com", count: 1,
      suggestedRule: "WebFetch(domain:docs.example.com)" }] }, PERM_NOW);
  assert.ok(wf.includes('<code>WebFetch(<wbr>domain:<wbr>docs.example.com)</code>'));
  assert.ok(wf.includes('data-perm-rule="WebFetch(domain:docs.example.com)"'));
});

test("XERK-1563: a classifier block's only why is its deny reason, not the allowlist's", () => {
  const html = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "classifier-denied", tool: "Bash", head: "kubectl delete", count: 1, allowed: 0, denied: 1,
      suggestedRule: null, noRuleReason: "not on the known read-only list, so its arguments may run code",
      denyReason: "Deleting cluster resources is out of scope" }] }, PERM_NOW);
  assert.match(html, /<td class="perm-rule"><span class="none">no safe rule — review it<\/span><div class="perm-why">Blocked: Deleting cluster resources is out of scope<\/div><\/td>/);
  assert.doesNotMatch(html, /read-only list/);
  // With no deny reason recorded, the allowlist reason is the only why left.
  const bare = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "classifier-denied", tool: "Bash", head: "kubectl delete", count: 1, suggestedRule: null,
      noRuleReason: "not on the known read-only list, so its arguments may run code" }] }, PERM_NOW);
  assert.match(bare, /<div class="perm-why">not on the known read-only list, so its arguments may run code<\/div><\/td>/);
});

test("XERK-1563: a Bash head with no safe rule says review it, and Copy copies nothing", async () => {
  const noRule = { kind: "dialog", dialogKind: "permission", tool: "Bash", head: "pkexec", count: 4,
    allowed: 4, denied: 0, suggestedRule: null,
    noRuleReason: "runs whatever follows it" };
  const safe = { kind: "dialog", dialogKind: "permission", tool: "Bash", head: "git status",
    count: 1, allowed: 1, denied: 0, suggestedRule: "Bash(git status:*)" };
  const html = H.permissionsCardHtml({ days: 7, recent: [], top: [noRule] }, PERM_NOW);
  assert.match(html, /<td class="perm-rule"><span class="none">no safe rule — review it<\/span><div class="perm-why">runs whatever follows it<\/div><\/td>/);
  // Nothing to copy: no button, no rule attribute, no Bash(...) anywhere.
  assert.doesNotMatch(html, /data-perm-rule|perm-copy|Bash\(/);
  // The click handler copies only a [data-perm-rule] button: a click anywhere in
  // the no-rule row writes nothing; a rule's own button writes exactly its rule.
  const H6 = loadHelpers(() => ({ days: 7, recent: [], top: [noRule, safe] }));
  await H6.refreshPermissions();
  const writes = [];
  H6.navigator.clipboard = { writeText: (t) => { writes.push(t); return Promise.resolve(); } };
  const click = (target) => H6.els.permissionsCard.listeners.click.forEach((fn) => fn({ target }));
  click({ closest: () => null });                    // the no-rule cell: no button inside it
  assert.deepEqual(writes, []);
  const btn = { textContent: "Copy", getAttribute: (k) => (k === "data-perm-rule" ? "Bash(git status:*)" : null) };
  click({ closest: (sel) => (sel === "[data-perm-rule]" ? btn : null) });
  assert.deepEqual(writes, ["Bash(git status:*)"]);
  // The rendered card holds exactly one copyable rule — the safe group's.
  const rules = [...H6.els.permissionsCard.innerHTML.matchAll(/data-perm-rule="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(rules, ["Bash(git status:*)"]);
});

test("XERK-1563: a classifier block with no rule says why, with nothing to copy", () => {
  const html = H.permissionsCardHtml({ days: 7, recent: [], top: [
    { kind: "classifier-denied", tool: "Write", head: "/home/u/.ssh/config", count: 1, allowed: 0,
      denied: 1, suggestedRule: null, denyReason: "Writing to SSH configuration <is> out of scope" },
  ] }, PERM_NOW);
  assert.match(html, /no rule retires this<\/span><div class="perm-why">Blocked: Writing to SSH configuration &lt;is&gt; out of scope<\/div>/);
  assert.doesNotMatch(html, /data-perm-rule|autoMode/);
  // A command subject is the mono, break-anywhere kind; its tool rides under it.
  assert.match(html, /<div class="perm-subj cmd">\/home\/u\/\.ssh\/config<\/div><div class="perm-tool">Write<\/div>/);
});

test("XERK-1563: on a phone the card reflows to blocks, not a sideways-scrolling table", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "insights.html"), "utf8");
  const phone = src.slice(src.indexOf("@media (max-width: 600px)", src.indexOf(".perm-empty")));
  const block = phone.slice(0, phone.indexOf("\n  }\n"));
  assert.match(block, /\.perm-card \.table-scroll \{ overflow-x: visible; \}/);
  assert.match(block, /\.perm-card thead \{ display: none; \}/);
  assert.match(block, /\.perm-card tbody tr \{[^}]*display: flex; flex-wrap: wrap;/);
  // The sticky Prompt column is what hid the rules: it must not stick here.
  assert.match(block, /\.perm-card tbody td \{[^}]*position: static;/);
  assert.match(block, /td\.perm-rule \{ flex: 1 1 100%;/);
  assert.match(block, /td\.perm-stat::before \{ content: attr\(data-label\)/);
  // Recent prompts: host · wait · age always on a second line of their own.
  assert.match(block, /\.perm-recent \.perm-meta \{ flex: 1 1 100%; \}/);
  // Prose subjects wrap at word boundaries; only commands may break mid-token.
  assert.doesNotMatch(src, /\.perm-subj \{[^}]*break-all/);
  assert.match(src, /\.perm-subj\.cmd \{[^}]*overflow-wrap: anywhere;/);
});

// --- Model quality (XERK-1849) ---------------------------------------------------
const MQ_NOW = Date.UTC(2026, 9, 12);
const mqG = (o) => Object.assign({ cls: "bug", model: "opus", sessions: 0, good: 0, bad: 0, pending: 0,
  "no-change": 0, undelivered: 0, reasons: {} }, o);

test("XERK-1849: bad rate counts only decided sessions; Opus column is the class's Opus rate", () => {
  assert.equal(H.mqBadRate(mqG({ pending: 4 })), null);
  assert.equal(H.mqBadRate(mqG({ good: 3, bad: 1 })), 0.25);
  const html = H.modelQualityCardHtml({ windowDays: 90, groups: [
    mqG({ model: "opus", sessions: 8, good: 7, bad: 1 }),
    mqG({ model: "sonnet", sessions: 2, good: 1, bad: 1 }),
    mqG({ cls: "task", model: "haiku", sessions: 1, good: 1 }),
  ] }, MQ_NOW);
  const row = (m) => html.split("<tr").find((r) => r.includes(`mq-model">${m}<`));
  assert.match(row("sonnet"), /data-label="Bad rate">50%</);
  assert.match(row("sonnet"), /data-label="Opus">13%</);
  // Opus itself, and a class with no Opus session, show no baseline figure.
  assert.match(row("opus"), /mq-na" data-label="Opus">—</);
  assert.match(row("haiku"), /mq-na" data-label="Opus">—</);
  assert.match(row("opus"), /data-label="Status">baseline</);
});

test("XERK-1849: classes order by total sessions, Opus first inside each", () => {
  const out = H.mqOrdered([mqG({ cls: "story", sessions: 5 }), mqG({ model: "sonnet", sessions: 12 }),
    mqG({ sessions: 3 }), mqG({ model: "haiku", sessions: 4 })]);
  assert.deepEqual(out.map((g) => `${g.cls}/${g.model}`), ["bug/opus", "bug/sonnet", "bug/haiku", "story/opus"]);
});

test("XERK-1849: rework and shadow columns appear only once the hub serves them", () => {
  const plain = H.modelQualityCardHtml({ groups: [mqG({ model: "sonnet", sessions: 1 })] }, MQ_NOW);
  assert.doesNotMatch(plain, /QA runs|CI rounds|Shadow pairs/);
  const served = H.modelQualityCardHtml({ groups: [mqG({ model: "sonnet", sessions: 1,
    rework: { qaRuns: { median: 1.5, n: 4 }, ciRounds: { median: 2, n: 3 } }, shadow: { pairs: 23, candidateOnlyBad: 1 }, promotion: "candidate" })] }, MQ_NOW);
  assert.match(served, /data-label="QA runs" title="median of 4 sessions">1.5</);
  assert.match(served, /data-label="CI rounds" title="median of 3 sessions">2</);
  const big = H.modelQualityCardHtml({ groups: [mqG({ sessions: 1, rework: { qaRuns: { median: 3e8, n: 1 },
    ciRounds: { median: -1, n: 5 } } })] }, MQ_NOW);
  assert.match(big, /data-label="QA runs" title="median of 1 session">300000000</);
  assert.doesNotMatch(big, /CI rounds/);
  // A signal no group reported gets no column at all.
  assert.doesNotMatch(served, /Changes requested|QA failed/);
  assert.match(served, /data-label="Shadow pairs">23 · 1 worse</);
  assert.match(served, /data-label="Status">candidate</);
});

test("XERK-1849: session rows show only for one org, escaped, PR links http only", () => {
  const view = { groups: [mqG({ sessions: 1, bad: 1 })], rows: [{ issue: "A-1", cls: "bug", model: "opus",
    outcome: "bad", reason: "reopened", host: "<b>h</b>", repo: "<i>r</i>", updatedAt: MQ_NOW - 3600e3,
    prs: [{ url: "https://github.com/a/b/pull/7", state: "MERGED" }, { url: "javascript:alert(1)" }] }] };
  assert.match(H.modelQualityCardHtml(view, MQ_NOW, ""), /Pick one org in the header/);
  const html = H.modelQualityCardHtml(view, MQ_NOW, "acme.atlassian.net", true);
  assert.match(html, /<details class="table-view mq-rows-view" open>/);
  assert.match(html, /mq-outcome o-bad/);
  assert.match(html, /&lt;b&gt;h&lt;\/b&gt;/);
  assert.match(html, /&lt;i&gt;r&lt;\/i&gt;/);
  assert.match(html, /href="https:\/\/github.com\/a\/b\/pull\/7"[^>]*>#7<\/a> merged/);
  assert.doesNotMatch(html, /javascript:/);
});

test("XERK-1849: the card asks for rows only when exactly one org applies", async () => {
  const saved = orgKeys;
  try {
    for (const [keys, want] of [[[], "/api/model-quality"], [["a", "b"], "/api/model-quality"],
      [["acme"], "/api/model-quality?org=acme&rows=1"]]) {
      orgKeys = keys;
      const H6 = loadHelpers(() => ({ windowDays: 90, groups: [] }));
      await H6.refreshModelQuality();
      assert.ok(H6.fetches.includes(want), `${keys}: ${H6.fetches}`);
      assert.deepEqual(H6.getMqView(), { windowDays: 90, groups: [] });
    }
  } finally { orgKeys = saved; }
});

test("XERK-1849: a failed first read says why rather than loading forever", async () => {
  const H7 = loadHelpers(Object.assign(() => ({}), { httpStatus: (u) => (u.includes("model-quality") ? 503 : 0) }));
  await H7.refreshModelQuality();
  assert.match(H7.els.modelQualityCard.innerHTML, /Could not load model quality \(the hub answered HTTP 503\)/);
});

// fetchReply may return a Promise: a deferred answer lets a test land replies out of order.
test("XERK-1849: a late answer for an org the operator left is discarded", async () => {
  const saved = orgKeys;
  const pending = new Map();
  try {
    orgKeys = ["acme"];
    const H8 = loadHelpers((u) => new Promise((res) => pending.set(u.includes("acme") ? "acme" : "rival", res)));
    const first = H8.refreshModelQuality();
    orgKeys = ["rival"];
    const second = H8.refreshModelQuality();
    await new Promise((r) => setImmediate(r));   // both reads reach their json()
    pending.get("rival")({ groups: [], rows: [{ issue: "R-1" }] });
    await second;
    pending.get("acme")({ groups: [], rows: [{ issue: "A-1" }] });
    await first;
    assert.deepEqual(H8.getMqView().rows.map((r) => r.issue), ["R-1"]);
  } finally { orgKeys = saved; }
});

test("XERK-1849: a pick change drops the old org's rows and error at once", async () => {
  const saved = orgKeys;
  try {
    orgKeys = ["acme"];
    let hang = false;
    const H9 = loadHelpers(Object.assign((u) => (hang ? new Promise(() => {}) : { groups: [mqG({ sessions: 1 })], rows: [{ issue: "A-1" }] }),
      { httpStatus: (u) => (u.includes("org=bad") ? 500 : 0) }));
    await H9.refreshModelQuality();
    assert.match(H9.els.modelQualityCard.innerHTML, /A-1/);
    hang = true;
    orgKeys = ["rival"];
    H9.refreshModelQuality();
    assert.doesNotMatch(H9.els.modelQualityCard.innerHTML, /A-1/);
    assert.match(H9.els.modelQualityCard.innerHTML, /Loading…/);
    orgKeys = ["bad"];
    await H9.refreshModelQuality();
    assert.match(H9.els.modelQualityCard.innerHTML, /Could not load/);
    orgKeys = ["rival"];
    H9.refreshModelQuality();
    assert.doesNotMatch(H9.els.modelQualityCard.innerHTML, /Could not load/);
  } finally { orgKeys = saved; }
});

test("XERK-1849: a failed refresh keeps that org's view; rework with no figures adds no column", async () => {
  const saved = orgKeys;
  try {
    orgKeys = ["acme"];
    let fail = false;
    const H10 = loadHelpers(Object.assign(() => ({ groups: [mqG({ sessions: 1, rework: {} })], rows: [{ issue: "A-1" }] }),
      { httpStatus: () => (fail ? 500 : 0) }));
    await H10.refreshModelQuality();
    fail = true;
    await H10.refreshModelQuality();
    assert.match(H10.els.modelQualityCard.innerHTML, /A-1/);
    assert.doesNotMatch(H10.els.modelQualityCard.innerHTML, /QA runs/);
  } finally { orgKeys = saved; }
});

test("XERK-1849: an outcome named like an Object member reads pending", () => {
  const html = H.modelQualityCardHtml({ groups: [mqG({ sessions: 1 })], rows: [{ issue: "A-1", outcome: "constructor" }] },
    MQ_NOW, "acme", true);
  assert.match(html, /mq-outcome o-pending/);
  assert.doesNotMatch(html, /native code/);
});

test("XERK-1849: a rework block with no figure adds no column", () => {
  const html = H.modelQualityCardHtml({ groups: [mqG({ sessions: 1,
    rework: { qaRuns: { median: null, n: 0 }, ciRounds: "n/a", constructor: { median: 1 } } })] }, MQ_NOW);
  assert.doesNotMatch(html, /QA runs|CI rounds/);
});

test("XERK-1849: the drill-down names the org as the header does", async () => {
  const saved = orgKeys;
  try {
    orgKeys = ["acme"];
    const H11 = loadHelpers(() => ({ groups: [mqG({ sessions: 1 })], rows: [{ issue: "A-1" }] }));
    H11.syncModelQualityScope([{ jira: { siteKey: "acme", orgName: "Acme Corp" } }]);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.match(H11.els.modelQualityCard.innerHTML, /Sessions in Acme Corp \(1\)/);
  } finally { orgKeys = saved; }
});

test("XERK-1849: a late refusal for an org the operator left is discarded", async () => {
  const saved = orgKeys;
  let release;
  try {
    orgKeys = ["acme"];
    const H12 = loadHelpers(Object.assign(() => ({ groups: [mqG({ sessions: 1 })], rows: [{ issue: "R-1" }] }), {
      httpStatus: (u) => (u.includes("acme") ? 500 : 0),
      refusalBody: () => new Promise((res) => { release = () => res({ error: "acme down" }); }),
    }));
    const first = H12.refreshModelQuality();
    orgKeys = ["rival"];
    await H12.refreshModelQuality();
    release();
    await first;
    assert.match(H12.els.modelQualityCard.innerHTML, /R-1/);
    assert.doesNotMatch(H12.els.modelQualityCard.innerHTML, /acme down/);
  } finally { orgKeys = saved; }
});
