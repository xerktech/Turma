// Unit tests for the Meetings review (public/meetings.js, XERK-2510; the Brief
// page's Meetings pane since XERK-2623): the proposal render (escaped model text,
// quotes linked to that moment in Tenir), the review states, and Approve /
// Approve + start / Reject posting to the hub. The module's real source runs
// against a minimal DOM shim and its API is returned out of the sandbox.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "..", "public", "meetings.js"), "utf8");
const calendarScript = fs.readFileSync(path.join(__dirname, "..", "public", "calendar.js"), "utf8");

function makeEl() {
  const el = {
    _html: "", textContent: "", value: "", dataset: {}, style: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener() {},
    appendChild(c) { return c; }, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, remove() {}, contains() { return false; },
  };
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  return el;
}

// `reply(url, init)` answers each non-/api/agents fetch: a body for 200, or
// {status, body} for a refusal.
// `opts.hooks`: the page's mount hooks; `opts.calendar`: also run calendar.js in the
// same sandbox (the Calendar view's panel reviews through this module, XERK-2898).
function loadPage(reply = () => ({}), orgKeys = [], preset = {}, opts = {}) {
  const els = {};
  const fetches = [];
  const toasts = [];
  const store = { ...preset };
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); }, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener: noop, removeEventListener: noop, body: makeEl(), activeElement: null,
  };
  const stubs = {
    document,
    location: { href: "", search: "", pathname: "/brief", hash: "#meetings" },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    fetch: (u, init = {}) => {
      if (fetches.length > 50) return new Promise(() => {});
      fetches.push({ url: String(u), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
      if (String(u) === "/api/agents") return new Promise(() => {});
      const r = reply(String(u), init);
      if (r && r.status) return Promise.resolve({ status: r.status, ok: false, json: () => Promise.resolve(r.body || {}) });
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(r) });
    },
    EventSource: class { constructor() { this.readyState = 1; } addEventListener() {} close() {} },
    setInterval: () => 0, clearInterval: noop, setTimeout: (fn) => { fn(); return 1; }, clearTimeout: noop,
    addEventListener: noop, removeEventListener: noop, window: {},
    console, Date, Math, JSON, encodeURIComponent, Number, String, Object, Array, Map, Set, Promise,
    TurmaNav: { preserveScroll: (el, paint) => paint(), toast: (m) => toasts.push(m),
      refusalText: (what, status, body) => `${what} failed — ${(body && body.error) || `the hub answered HTTP ${status}`}` },
    TurmaOrg: { getKeys: () => orgKeys, update: noop, subscribe: noop, sse: noop },
    TurmaBoard: { bareKey: require("../public/board.js").bareKey, orgName: (k, o) => o || k, mergeSites: (agents) => agents.map((a) => a.jira).filter(Boolean),
      orgColorMap: (keys) => new Map(keys.map((k, i) => [k, i ? "url(x)" : `var(--s${i + 3})`])) },
    TurmaNewTicket: { update: noop },
  };
  const keys = Object.keys(stubs);
  new Function(...keys, script)(...keys.map((k) => stubs[k]));
  const api = stubs.window.TurmaMeetings;
  api.mount(document.getElementById("meetingList"), opts.hooks || {});
  if (opts.calendar) {
    stubs.TurmaMeetings = api;
    const ck = Object.keys(stubs);
    new Function(...ck, calendarScript)(...ck.map((k) => stubs[k]));
    api.cal = stubs.window.TurmaCalendar;
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  // A click on an element carrying `dataset` (what the delegated handler's closest() finds).
  const click = (dataset, aria = null) => {
    for (const fn of els.meetingList.listeners.click) fn({ target: { closest: () => ({ dataset, getAttribute: () => aria }) } });
  };
  return Object.assign(api, { els, fetches, toasts, store, settle, click, document, list: () => els.meetingList.innerHTML });
}

const SITE = "acme.atlassian.net";
const meeting = (over = {}) => ({
  meetingId: "m1", status: "ok", title: "Sprint <sync>", platform: "zoom", startedAt: 1.7e12,
  endedAt: 1.7e12 + 1.8e6, tenirUrl: "https://tenir.example/c/1", participants: ["Ann", "Bo"],
  items: [
    { id: "p1", kind: "bug", title: "Fix the <img src=x onerror=alert(1)> bug", description: "It 500s",
      suggestedAssignee: "Ann", quotes: [{ speaker: "Ann", text: "login <b>is</b> broken", atMs: 61000 }],
      duplicateKeys: ["ACME-7"] },
    { id: "p2", kind: "decision", title: "Ship Friday", description: "", quotes: [], duplicateKeys: [] },
  ], ...over });
const data = (list = [meeting()]) => ({ agents: [{ org: SITE, jira: { siteKey: SITE, orgName: "Acme" } }],
  meetingProposals: { [SITE]: list } });
const META = (u) => (/create-meta\?project=/.test(u)
  ? { types: [{ id: "10001", name: "Task" }, { id: "10004", name: "Bug" }] }
  : /create-meta/.test(u) ? { projects: [{ key: "ACME", name: "Acme" }] } : {});

test("XERK-2510: a meeting's proposals render escaped, with quotes linked to that moment in Tenir", async () => {
  const P = loadPage(META);
  P.setCache(data());
  P.renderMeetings(data());
  const h = P.list();
  assert.match(h, /<span class="nm">Acme<\/span>/);
  assert.match(h, /<h2 class="tri-title">Sprint &lt;sync&gt;<\/h2>/);
  assert.match(h, /Sprint &lt;sync&gt;/);
  assert.match(h, /Fix the &lt;img src=x onerror=alert\(1\)&gt; bug/);
  assert.doesNotMatch(h, /<img|<b>is/);
  assert.match(h, /href="https:\/\/tenir\.example\/c\/1#t=61"[^>]*>▸ 1:01</);
  assert.match(h, /Open in Tenir/);
  assert.match(h, /href="\/board\?ticket=ACME-7&amp;site=acme\.atlassian\.net"/);
  assert.match(h, /data-act="start"/);
  assert.match(h, />Log decision</);
  // An item key survives an HTML attribute (no NUL, no quote), and decodes back to its parts.
  assert.match(h, /data-k="acme\.atlassian\.net\/m1\/p1"/);
  P.startEdit(decodeURIComponent("acme.atlassian.net/m1/p1"));
  assert.match(P.list(), /data-edit-title=/);
  // A link is only ever built from an http(s) URL.
  P.renderMeetings(data([meeting({ tenirUrl: "javascript:alert(1)" })]));
  assert.doesNotMatch(P.list(), /javascript:|Open in Tenir|#t=/);
  // The projects the org can create in are fetched, the lone one preselected.
  await P.settle();
  P.renderMeetings(data());
  assert.match(P.list(), /<option value="ACME" selected>Acme \(ACME\)<\/option>/);
});

test("XERK-2894: the summary renders escaped in paragraphs, and an inferred title names the meeting", async () => {
  const P = loadPage(META);
  const d = data([meeting({ title: "Meeting", inferredTitle: "Login <b>bug</b> triage",
    summary: "We met about <script>x</script>.\nAnn reported it.\n\nDecisions: ship Friday." })]);
  P.setCache(d);
  P.renderMeetings(d);
  const h = P.list();
  assert.match(h, /<h2 class="tri-title">Login &lt;b&gt;bug&lt;\/b&gt; triage<\/h2>/);
  assert.match(h, /<div class="mt-summary" aria-label="Summary"><p>We met about &lt;script&gt;x&lt;\/script&gt;\.<br>Ann reported it\.<\/p><p>Decisions: ship Friday\.<\/p><\/div>/);
  assert.doesNotMatch(h, /<script>|<b>bug/);
  // No summary (an older agent) = no block; a failed row never shows one.
  for (const over of [{}, { status: "failed", error: "x", summary: "s" }]) {
    const d2 = data([meeting(over)]);
    P.setCache(d2);
    P.renderMeetings(d2);
    assert.doesNotMatch(P.list(), /mt-summary/);
    assert.match(P.list(), /Sprint &lt;sync&gt;/);
  }
});

test("XERK-2885: Retry on a failed project list asks the hub to skip its cached failure", async () => {
  let fail = true;
  const P = loadPage((u) => (/create-meta/.test(u) && !/project=/.test(u) && fail
    ? { error: "Jira said 403 Forbidden" } : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  P.renderMeetings(data());
  assert.match(P.list(), /Jira said 403 Forbidden<\/span> <button class="btn-sm" data-meta-retry="acme\.atlassian\.net" data-meta-focus="acme\.atlassian\.net">Retry/);
  assert.ok(P.fetches.every((f) => !/retry=1/.test(f.url)), "a first load serves the cache");
  fail = false;
  P.click({ metaRetry: SITE });
  // While loading, a focusable placeholder holds the same focus key.
  assert.match(P.list(), /<span class="mt-meta" tabindex="-1" data-meta-focus="acme\.atlassian\.net">loading projects/);
  await P.settle();
  const metas = P.fetches.filter((f) => /create-meta/.test(f.url) && !/project=/.test(f.url));
  assert.equal(metas.at(-1).url, `/api/jira/${encodeURIComponent(SITE)}/create-meta?retry=1`);
  P.renderMeetings(data());
  assert.match(P.list(), /<select data-project="acme\.atlassian\.net" aria-label="New tickets go to" data-meta-focus="acme\.atlassian\.net">/);
});

test("XERK-2885: a failed types load is not re-asked on repaint, only on the operator's act", async () => {
  let typesOk = false;
  const P = loadPage((u, init) => (init.method === "POST" ? { ok: true, meeting: meeting() }
    : /project=/.test(u) && !typesOk ? { error: "Jira said 403 Forbidden" } : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  const typeFetches = () => P.fetches.filter((f) => /project=/.test(f.url));
  assert.equal(typeFetches().length, 1);
  // Every repaint calls ensureMeta -> ensureTypes; an errored entry must stay put
  // (it used to re-ask the tracker every few seconds while the page was open).
  for (let i = 0; i < 5; i++) { P.renderMeetings(data(), true); await P.settle(); }
  assert.equal(typeFetches().length, 1, "no repaint-driven refetch");
  // Edit and a project pick are acts too: each asks again with retry=1.
  P.startEdit(P.itemKey(SITE, "m1", "p1"));
  await P.settle();
  assert.equal(typeFetches().length, 2);
  assert.match(typeFetches()[1].url, /project=ACME&retry=1$/);
  P.edits.clear();
  for (const fn of P.els.meetingList.listeners.change) fn({ target: { value: "ACME", dataset: { project: SITE } } });
  await P.settle();
  assert.equal(typeFetches().length, 3);
  assert.match(typeFetches()[2].url, /project=ACME&retry=1$/);
  // Approve is an act: it asks again, telling the hub to skip its cached failure.
  typesOk = true;
  await P.review(P.itemKey(SITE, "m1", "p1"), "approve");
  assert.equal(typeFetches().length, 4);
  assert.match(typeFetches()[3].url, /project=ACME&retry=1$/);
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, 1);
});

test("XERK-2885: only the first request of a Retry carries retry=1; its polls go without", async () => {
  let n = 0;
  const P = loadPage((u) => (/create-meta/.test(u) && !/project=/.test(u)
    ? (n++ === 0 ? { error: "Jira said 403 Forbidden" } : n <= 3 ? { status: 202, body: { pending: true } } : META(u))
    : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  P.click({ metaRetry: SITE });
  for (let i = 0; i < 4; i++) await P.settle();
  const urls = P.fetches.filter((f) => /create-meta/.test(f.url) && !/project=/.test(f.url)).map((f) => f.url);
  const base = `/api/jira/${encodeURIComponent(SITE)}/create-meta`;
  assert.deepEqual(urls, [base, `${base}?retry=1`, base, base]);
});

test("XERK-2885: focus on Retry follows the swap to the picker instead of dropping to <body>", async () => {
  let fail = true;
  const P = loadPage((u) => (/create-meta/.test(u) && !/project=/.test(u) && fail
    ? { error: "Jira said 403 Forbidden" } : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  const list = P.els.meetingList;
  const focused = [];
  // A focused control of the pane, and the controls the repaint leaves behind.
  P.document.activeElement = { dataset: { metaFocus: SITE }, tagName: "BUTTON" };
  list.contains = (el) => el === P.document.activeElement;
  list.querySelectorAll = (sel) => (/\[data-meta-focus\]/.test(sel)
    ? [{ dataset: { metaFocus: SITE }, focus() { focused.push(SITE); } }] : []);
  fail = false;
  P.click({ metaRetry: SITE });
  await P.settle();
  assert.ok(focused.length >= 2, `focus restored on the loading swap and the picker (${focused.length})`);
});

test("XERK-2510: Approve + start posts the org's project, the kind's issue type and the meeting context", async () => {
  const P = loadPage((u, init) => (init.method === "POST"
    ? { ok: true, meeting: meeting({ items: [{ ...meeting().items[0], review: { state: "creating", at: 1, start: true } }, meeting().items[1]] }) }
    : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  await P.review(P.itemKey(SITE, "m1", "p1"), "approve", true);
  const post = P.fetches.find((f) => f.method === "POST");
  assert.equal(post.url, `/api/orgs/${encodeURIComponent(SITE)}/meetings/m1/items/p1`);
  assert.deepEqual([post.body.action, post.body.project, post.body.issueType, post.body.start],
    ["approve", "ACME", "10004", true]);
  // The proposal only: no meeting title, quote or Tenir link reaches the tracker (XERK-2514).
  assert.equal(post.body.description, "It 500s");
  assert.equal("edited" in post.body, false, "the default text is not an edit");
  assert.match(P.list(), /Creating the ticket…/);
  // A decision: its detail fits the decisions log, and an editor opened and changed says so.
  const k2 = P.itemKey(SITE, "m1", "p2");
  P.startEdit(k2);
  assert.match(P.list(), /data-edit-desc="[^"]+" maxlength="290"/);
  P.edits.get(k2).description += " more";
  await P.review(k2, "approve");
  const dec = P.fetches.filter((f) => f.method === "POST").at(-1);
  assert.deepEqual([dec.body.edited, "project" in dec.body], [true, false]);
});

test("XERK-2510: a refusal reaches the operator in the hub's words; review states render", async () => {
  const P = loadPage((u, init) => (init.method === "POST" ? { status: 409, body: { error: "no online host reports that org" } } : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  await P.review(P.itemKey(SITE, "m1", "p1"), "reject");
  assert.deepEqual(P.toasts, ["Rejecting failed — no online host reports that org"]);
  assert.match(P.list(), /class="mt-err">Rejecting failed/);
  // An editor opened and left alone sends no `edited`; a ticket description has no decision cap.
  const k1 = P.itemKey(SITE, "m1", "p1");
  P.startEdit(k1);
  assert.match(P.list(), /<textarea data-edit-desc="[^"]+">/);
  await P.review(k1, "approve");
  assert.equal("edited" in P.fetches.filter((f) => f.method === "POST").at(-1).body, false);
  const items = meeting().items;
  P.update(data([meeting({ items: [
    { ...items[0], review: { state: "created", at: 1, key: "ACME-9", start: true, session: "queued" } },
    { ...items[1], review: { state: "logged", at: 1 } }] }),
  meeting({ meetingId: "m2", items: [{ ...items[0], review: { state: "failed", at: 1, error: "<boom>" } },
    { ...items[1], review: { state: "rejected", at: 1 } }] })]));
  P.setFilter("all");
  P.select(P.entryKey(SITE, "m:m1"));
  assert.doesNotMatch(P.list(), /Created <a/, "a reviewed proposal leaves the list");
  P.click({ showReviewed: P.meetingKey(SITE, "m1") });
  const h = P.list();
  assert.match(h, /Created <a href="\/board\?ticket=ACME-9&amp;site=acme\.atlassian\.net">ACME-9<\/a>/);
  assert.match(h, /session starting/);
  P.select(P.entryKey(SITE, "m:m2"));
  P.click({ showReviewed: P.meetingKey(SITE, "m2") });
  const h2 = P.list();
  P.renderMeetings(data([meeting({ items: [{ ...items[0], review: { state: "created", at: 1, key: "ACME-9", start: true,
    session: "failed", sessionError: "<img src=x>" } }] })]));
  assert.match(P.list(), /no session — &lt;img src=x&gt;/);
  assert.match(h, /Added to the decisions log/);
  assert.match(h2, /Not created — &lt;boom&gt;/);
  assert.match(h2, /data-act="reopen" data-k="acme\.atlassian\.net\/m2\/p1"/);
  // XERK-2864/2865: a create that may have gone through offers neither Reopen nor Approve.
  P.update(data([meeting({ meetingId: "m2", items: [{ ...items[0],
    review: { state: "failed", at: 1, error: "may have been created", maybeCreated: true } }] })]));
  P.select(P.entryKey(SITE, "m:m2"));
  const h3 = P.list();
  assert.doesNotMatch(h3, /data-act="reopen"/);
  assert.doesNotMatch(h3, /data-act="approve"/);
  assert.match(h3, /data-act="reject" data-k="acme\.atlassian\.net\/m2\/p1"/);
  assert.match(h2, /class="mt-item rejected"/);
  // A pending or failed run says so instead of items.
  P.update(data([meeting({ status: "running", host: "k8x-02", items: undefined }),
    meeting({ meetingId: "m3", status: "failed", error: "timed out", items: undefined })]));
  P.select(P.entryKey(SITE, "m:m1"));
  assert.match(P.list(), /Reading the captions on k8x-02/);
  P.select(P.entryKey(SITE, "m:m3"));
  assert.match(P.list(), /Could not propose work items — timed out/);
});

test("XERK-2865: a proposal whose ticket may exist offers Reject only, and still awaits review", () => {
  const P = loadPage(META);
  const items = meeting().items;
  const maybe = { state: "failed", at: 1, maybeCreated: true,
    error: "the host went silent while creating the ticket — it may have been created" };
  const d = data([meeting({ items: [{ ...items[0], review: maybe }] })]);
  P.setCache(d);
  P.renderMeetings(d);
  P.setFilter("all");
  P.select(P.entryKey(SITE, "m:m1"));
  const h = P.list();
  assert.match(h, /Maybe created — the host went silent/);
  assert.doesNotMatch(h, /Not created/);
  const k = P.itemKey(SITE, "m1", items[0].id);
  const acts = [...h.matchAll(new RegExp(`data-act="(\\w+)" data-k="${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"))].map((x) => x[1]);
  assert.deepEqual(acts, ["reject"]);
  assert.equal(P.pendingCount(d), 1);
  // Rejected after a check, it keeps only Reopen (the hub returns it to this verdict).
  const r = data([meeting({ items: [{ ...items[0], review: { ...maybe, state: "rejected" } }] })]);
  P.update(r);
  P.select(P.entryKey(SITE, "m:m1"));
  P.click({ showReviewed: P.meetingKey(SITE, "m1") });
  assert.match(P.list(), /data-act="reopen"/);
  assert.doesNotMatch(P.list(), /data-act="approve"/);
});

test("XERK-2511: a second press while an Approve awaits its issue types posts nothing", async () => {
  const P = loadPage((u, init) => (init.method === "POST" ? { ok: true } : META(u)));
  P.setCache(data());
  P.renderMeetings(data());
  await P.settle();
  const k = P.itemKey(SITE, "m1", "p1");
  const approving = P.review(k, "approve"); // awaits the project's types before its POST
  assert.match(P.list(), /aria-disabled="true"[^>]*>Working…</, "busy from the first await");
  await P.review(k, "reject"); // a Reject in that window must not post, then be overtaken
  await approving;
  await P.settle();
  assert.deepEqual(P.fetches.filter((f) => f.method === "POST").map((f) => f.body.action), ["approve"]);
});

test("XERK-2623: the module paints nothing before it is mounted, and counts what awaits review", () => {
  const P = loadPage(META);
  const items = meeting().items;
  // Two reviewable proposals; a rejected, a created and a still-running meeting's count none.
  assert.equal(P.pendingCount(data()), 2);
  assert.equal(P.pendingCount(data([meeting({ items: [
    { ...items[0], review: { state: "rejected", at: 1 } },
    { ...items[1], review: { state: "logged", at: 1 } }] }),
  meeting({ meetingId: "m2", status: "running", items: undefined })])), 0);
  // A failed create is back in the operator's hands.
  assert.equal(P.pendingCount(data([meeting({ items: [{ ...items[0], review: { state: "failed", at: 1, error: "x" } }] })])), 1);
  // update() takes the host page's snapshot and paints it.
  P.update(data());
  assert.match(P.list(), /Sprint &lt;sync&gt;/);
});

test("XERK-2623: the header org pick scopes the list and the tab's count", () => {
  const OTHER = "globex.atlassian.net";
  const both = { agents: [], meetingProposals: { [SITE]: [meeting()], [OTHER]: [meeting({ meetingId: "g1", title: "Globex sync" })] } };
  const all = loadPage(META);
  assert.equal(all.pendingCount(both), 4);
  const P = loadPage(META, [OTHER]);
  assert.equal(P.pendingCount(both), 2);
  P.update(both);
  assert.match(P.list(), /Globex sync/);
  assert.doesNotMatch(P.list(), /Sprint &lt;sync&gt;/);
});

test("XERK-2638: the Tenir labels list and an unmapped label's banner, escaped, post the label", async () => {
  const B = "dev.azure.com/Bolt";
  const labeled = { ...data(), meetingLabels: { [SITE]: { label: "acme", custom: false }, [B]: { label: "bolt", custom: true } },
    meetingLabelMisses: { "north<x>": { at: 1 }, northwind: { at: 2 }, ["globex@" + "a".repeat(32)]: { at: 3, shared: true } } };
  const P = loadPage((u, init) => (/meeting-label/.test(u)
    ? (JSON.parse(init.body).label === "taken" ? { status: 409, body: { error: "the org x already has the meeting label \"taken\"" } }
      : { ok: true, label: JSON.parse(init.body).label || "bolt", custom: JSON.parse(init.body).label !== null })
    : META(u)));
  P.update(labeled);
  // Each org's label is in its settings drawer; a custom label offers Reset, a default one says so.
  P.openDrawer(SITE);
  assert.match(P.list(), /data-label="acme\.atlassian\.net" value="acme"/);
  assert.doesNotMatch(P.list(), /data-label-reset="acme\.atlassian\.net"/);
  P.openDrawer(B);
  assert.match(P.list(), /data-label-reset="dev\.azure\.com\/Bolt"/);
  P.openDrawer(null);
  const html = P.list();
  assert.doesNotMatch(html, /data-label=/, "no label row outside the drawer");
  // A miss shows its plain label (tenant suffix dropped); a malformed key never renders.
  assert.match(html, /meeting for <b>northwind<\/b>, which no org has/);
  assert.match(html, /meeting for <b>globex<\/b>, which more than one org answers to/);
  assert.doesNotMatch(html, /north&lt;x&gt;|north<x>/);
  // Saving posts the label; null resets; a refusal is shown in the hub's words.
  await P.saveLabel(B, "northwind");
  await P.saveLabel(B, null);
  await P.saveLabel(SITE, "taken");
  await P.settle();
  const posts = P.fetches.filter((f) => /meeting-label/.test(f.url));
  assert.deepEqual(posts.map((f) => [f.url, f.body.label]), [
    [`/api/orgs/${encodeURIComponent(B)}/meeting-label`, "northwind"],
    [`/api/orgs/${encodeURIComponent(B)}/meeting-label`, null],
    [`/api/orgs/${encodeURIComponent(SITE)}/meeting-label`, "taken"]]);
  assert.match(P.toasts.at(-1), /already has the meeting label/);
  P.openDrawer(SITE);
  assert.match(P.list(), /mt-err-inline">Saving the label failed/);
  // A malformed label never reaches the hub.
  assert.equal(await P.saveLabel(SITE, "Has Space"), false);
  assert.equal(P.fetches.filter((f) => /meeting-label/.test(f.url)).length, 3);
  // The header org pick scopes the banner's org pick and the rail.
  const Q = loadPage(META, [B]);
  Q.update(labeled);
  assert.doesNotMatch(Q.list(), /value="acme\.atlassian\.net"|data-org-toggle="acme/);
  assert.match(Q.list(), /<option value="dev\.azure\.com\/Bolt">/);
});

// A visible "New tickets go to" is text right after a tag; the select's aria-label is not.
const visibleTarget = (h) => (h.match(/>New tickets go to/g) || []).length;
const drawerOf = (P) => P.list().slice(P.list().indexOf('<aside class="tri-drawer"'));

test("the settings drawer says \"New tickets go to\" once; the inline picker keeps its own label", async () => {
  const P = loadPage(META);
  P.update(data());
  await P.settle();
  P.update(data(), true);
  assert.match(P.list(), /<label class="mt-target">New tickets go to <select/, "inline picker keeps its words");
  P.click({ orgSettings: SITE });
  const drawer = drawerOf(P);
  assert.equal(visibleTarget(drawer), 1, "only the section heading shows it");
  assert.match(drawer, /<label class="mt-target"><select data-project="acme\.atlassian\.net" aria-label="New tickets go to"[^>]*>/);
});

test("the settings drawer says \"New tickets go to\" once while the projects load and when they fail", async () => {
  const loading = loadPage(() => new Promise(() => {}));
  loading.update(data());
  loading.click({ orgSettings: SITE });
  assert.match(drawerOf(loading), /loading projects/);
  assert.equal(visibleTarget(drawerOf(loading)), 1);

  const failed = loadPage((u) => (/create-meta/.test(u) ? { error: "Jira said 403 Forbidden" } : {}));
  failed.update(data());
  await failed.settle();
  failed.click({ orgSettings: SITE });
  assert.match(drawerOf(failed), /Jira said 403 Forbidden/);
  assert.equal(visibleTarget(drawerOf(failed)), 1);
});

test("XERK-2514: the Whose work rows, escaped, post names and role; Clear posts empty", async () => {
  const d = { ...data(), meetingLabels: { [SITE]: { label: "acme", custom: false } },
    meetingFocus: { [SITE]: { names: ["Ann <b>Lee</b>", "Lee, Ann"], role: "QA \"lead\"" } } };
  const P = loadPage((u, init) => (/meeting-focus/.test(u)
    ? (JSON.parse(init.body).names.length ? { ok: true, focus: { names: JSON.parse(init.body).names, role: JSON.parse(init.body).role } }
      : { ok: true, focus: null })
    : META(u)));
  P.update(d);
  assert.doesNotMatch(P.list(), /data-focus-names=/, "whose work lives in the org's drawer");
  P.click({ orgSettings: SITE });
  const html = P.list();
  assert.match(html, /<div class="tri-dlabel">Whose work<\/div>/);
  assert.match(html, /data-focus-names="acme\.atlassian\.net" value="Ann &lt;b&gt;Lee&lt;\/b&gt;, Lee, Ann"/);
  assert.match(html, /data-focus-role="acme\.atlassian\.net" value="QA &quot;lead&quot;"/);
  assert.match(html, /data-focus-clear="acme\.atlassian\.net"/);
  await P.saveFocus(SITE, " Ann Lee ,, Bo ", " QA ");
  await P.saveFocus(SITE, "", "");
  assert.equal(await P.saveFocus(SITE, "a,b,c,d,e,f", ""), false, "over 5 names never posts");
  await P.settle();
  const posts = P.fetches.filter((f) => /meeting-focus/.test(f.url)).map((f) => f.body);
  assert.deepEqual(posts, [{ names: ["Ann Lee", "Bo"], role: "QA" }, { names: [], role: "" }]);
  assert.match(P.list(), /everyone's work/);
});

test("XERK-2638: an org with no label is still listed and pickable; same-named orgs show their site", () => {
  const T1 = "twin-a.atlassian.net", T2 = "twin-b.atlassian.net";
  const d = { agents: [{ org: T1, jira: { siteKey: T1, orgName: "Twin Co" } }, { org: T2, jira: { siteKey: T2, orgName: "Twin Co" } }],
    meetingProposals: {}, meetingLabels: { [T1]: { label: "", custom: false }, [T2]: { label: "twin-co", custom: true } },
    meetingLabelMisses: { other: { at: 1 } } };
  const P = loadPage(META);
  P.update(d);
  P.openDrawer(T1);
  const html = P.list();
  assert.match(html, /data-label="twin-a\.atlassian\.net" value="" maxlength="40"[^>]*placeholder="no label"/);
  assert.match(html, /no label — give it one/);
  assert.match(html, /<option value="twin-a\.atlassian\.net">Twin Co \(twin-a\.atlassian\.net\)<\/option>/);
  assert.match(html, /Twin Co \(twin-b\.atlassian\.net\)/);
});

// XERK-2634: a meeting's host is a registry key, tenant-suffixed after the
// tenancy migration; the running line prints the device alone.
test("a meeting read on a tenant host names the host without the tenant", () => {
  const P = loadPage(META);
  P.renderMeetings(data([meeting({ status: "running", host: "k8x-02@77778a16d8b028aab55c7729d587dbd7", items: undefined })]));
  assert.match(P.list(), /Reading the captions on k8x-02…/);
  assert.doesNotMatch(P.list(), /77778a16/);
});

// ---- XERK-2857: the two-pane triage ---------------------------------------------
const OTHER = "globex.atlassian.net";
const two = () => ({ agents: [{ org: SITE, jira: { siteKey: SITE, orgName: "Acme" } }, { org: OTHER, jira: { siteKey: OTHER, orgName: "Globex" } }],
  meetingProposals: { [SITE]: [meeting()], [OTHER]: [meeting({ meetingId: "g1", title: "Globex sync" })] } });

test("XERK-2857: an org collapses to its header, the pick is kept per viewer, and survives a reload", () => {
  const P = loadPage(META);
  P.update(two());
  assert.match(P.list(), /data-org-toggle="globex\.atlassian\.net" aria-expanded="true"/);
  assert.match(P.list(), /data-entry="globex\.atlassian\.net\/m%3Ag1"/);
  P.click({ orgToggle: OTHER });
  assert.match(P.list(), /data-org-toggle="globex\.atlassian\.net" aria-expanded="false"/);
  assert.doesNotMatch(P.list(), /data-entry="globex/);
  assert.match(P.list(), /<span class="nm">Globex<\/span><\/button><span class="tri-count"[^>]*>2</, "a collapsed org still counts");
  assert.deepEqual(JSON.parse(P.store["turma-meetings-collapsed"]), [OTHER]);
  // A reload reads it back; a broken store is ignored, never thrown.
  const R = loadPage(META, [], { "turma-meetings-collapsed": P.store["turma-meetings-collapsed"] });
  R.update(two());
  assert.doesNotMatch(R.list(), /data-entry="globex/);
  const Bad = loadPage(META, [], { "turma-meetings-collapsed": "{not json" });
  Bad.update(two());
  assert.match(Bad.list(), /data-entry="globex/);
  P.click({ orgToggle: OTHER });
  assert.deepEqual(JSON.parse(P.store["turma-meetings-collapsed"]), []);
});

test("XERK-2857: a reviewed proposal leaves the list, counts as progress, and shows again under show reviewed with Reopen", () => {
  const P = loadPage(META);
  const items = meeting().items;
  const d = data([meeting({ items: [{ ...items[0], review: { state: "rejected", at: 1 } }, items[1]] })]);
  P.update(d);
  let h = P.list();
  assert.doesNotMatch(h, /Fix the &lt;img/, "a rejected proposal goes away, not greyed");
  assert.match(h, /1 of 2 reviewed · 1 rejected/);
  assert.match(h, /aria-valuenow="1"/);
  assert.match(h, />show reviewed \(1\)</);
  P.click({ showReviewed: P.meetingKey(SITE, "m1") });
  h = P.list();
  assert.match(h, /<ul class="mt-items mt-done"[^>]*><li class="mt-item rejected"/);
  assert.match(h, /data-act="reopen" data-k="acme\.atlassian\.net\/m1\/p1">Reopen</);
  assert.doesNotMatch(h.slice(h.indexOf("mt-done")), /data-act="approve"/, "a reviewed one is reopened, not re-approved");
  assert.match(h, />hide reviewed</);
});

test("XERK-2857: Needs review / All / Archived filter the rail; a done meeting leaves Needs review", () => {
  const P = loadPage(META);
  const items = meeting().items;
  const done = meeting({ meetingId: "m2", title: "All done", items: [{ ...items[1], review: { state: "logged", at: 1 } }] });
  const arch = meeting({ meetingId: "m3", title: "Shelved", archivedAt: 1.7e12 + 5e6 });
  P.update(data([meeting(), done, arch]));
  const entries = () => (P.list().match(/data-entry="[^"]+"/g) || []).map((x) => decodeURIComponent(x.split("/").pop().slice(0, -1)));
  assert.deepEqual(entries(), ["m:m1"]);
  assert.match(P.list(), /data-filter="review" aria-pressed="true"/);
  P.click({ filter: "all" });
  assert.deepEqual(entries().sort(), ["m:m1", "m:m2"]);
  assert.match(P.list(), /<span class="tri-note good" aria-label="all reviewed">✓</);
  P.click({ filter: "archived" });
  assert.deepEqual(entries(), ["m:m3"]);
  assert.match(P.list(), />Unarchive</);
  // An archived meeting's proposals count nowhere.
  assert.equal(P.pendingCount(data([arch])), 0);
  P.click({ filter: "bogus" });
  assert.match(P.list(), /data-filter="archived" aria-pressed="true"/, "an unknown filter is ignored");
});

test("XERK-2857: the search matches meeting and proposal titles, case-blind, and echoes escaped", () => {
  const P = loadPage(META);
  P.update(two());
  const typed = (v) => P.els.meetingList.listeners.input.forEach((fn) => fn({ target: { value: v, dataset: { search: "1" } } }));
  typed("SHIP friday");
  assert.match(P.list(), /data-entry="acme[^"]*"/);
  assert.match(P.list(), /data-entry="globex[^"]*"/, "both meetings carry that proposal");
  typed("globex");
  assert.doesNotMatch(P.list(), /data-entry="acme/);
  // XERK-2894: an inferred title is searchable too.
  const d = two();
  d.meetingProposals[SITE][0].inferredTitle = "Login bug triage";
  P.update(d);
  typed("login BUG");
  assert.match(P.list(), /data-entry="acme[^"]*"/);
  assert.doesNotMatch(P.list(), /data-entry="globex/);
  P.update(two());
  typed("globex");
  assert.doesNotMatch(P.list(), /data-org-toggle="acme/, "an org with no match is hidden while searching");
  typed(`"><img src=x>`);
  assert.doesNotMatch(P.list(), /<img/);
  assert.match(P.list(), /value="&quot;&gt;&lt;img src=x&gt;"/);
  assert.match(P.list(), /Nothing matches “&quot;&gt;&lt;img src=x&gt;”/);
});

test("XERK-2857: Archive posts {archived}, moves on to the next entry, and a refusal is shown in the hub's words", async () => {
  let refuse = false;
  const P = loadPage((u, init) => {
    if (/\/archive$/.test(u)) {
      if (refuse) return { status: 409, body: { error: "a meeting still being read can't be archived <yet>" } };
      return { ok: true, meeting: meeting({ archivedAt: 1.7e12 + 9e6 }) };
    }
    return META(u);
  });
  const d = data([meeting(), meeting({ meetingId: "m2", title: "Second", startedAt: 1.7e12 - 1e6 })]);
  P.update(d);
  assert.equal(P.state().selected, P.entryKey(SITE, "m:m1"));
  P.click({ archive: P.meetingKey(SITE, "m1"), to: "true" });
  await P.settle();
  const post = P.fetches.find((f) => /\/archive$/.test(f.url));
  assert.equal(post.url, `/api/orgs/${encodeURIComponent(SITE)}/meetings/m1/archive`);
  assert.deepEqual(post.body, { archived: true });
  assert.equal(P.state().selected, P.entryKey(SITE, "m:m2"), "the next entry opens");
  assert.doesNotMatch(P.list(), /data-entry="[^"]*m%3Am1"/);
  // A busy button refuses a second press; a refusal stays inline and toasts.
  refuse = true;
  P.click({ archive: P.meetingKey(SITE, "m2"), to: "true" }, "true");
  await P.settle();
  assert.equal(P.fetches.filter((f) => /\/archive$/.test(f.url)).length, 1, "aria-disabled is the guard");
  await P.archive(P.meetingKey(SITE, "m2"), true);
  assert.deepEqual(P.toasts, ["Archiving the meeting failed — a meeting still being read can't be archived <yet>"]);
  assert.match(P.list(), /class="mt-err">Archiving the meeting failed — a meeting still being read can&#39;t be archived &lt;yet&gt;/);
  // Unarchive sends false.
  refuse = false;
  await P.archive(P.meetingKey(SITE, "m1"), false);
  assert.deepEqual(P.fetches.filter((f) => /\/archive$/.test(f.url)).at(-1).body, { archived: false });
});

test("XERK-2857: Reopen posts the reopen action; a hub that lacks it answers in its own words", async () => {
  const items = meeting().items;
  const rejected = meeting({ items: [{ ...items[0], review: { state: "rejected", at: 1 } }, items[1]] });
  const P = loadPage((u, init) => (init.method === "POST"
    ? { status: 400, body: { error: "action must be approve or reject" } } : META(u)));
  P.update(data([rejected]));
  P.click({ showReviewed: P.meetingKey(SITE, "m1") });
  P.click({ act: "reopen", k: P.itemKey(SITE, "m1", "p1") });
  await P.settle();
  const post = P.fetches.find((f) => f.method === "POST");
  assert.equal(post.url, `/api/orgs/${encodeURIComponent(SITE)}/meetings/m1/items/p1`);
  assert.deepEqual(post.body, { action: "reopen" });
  assert.deepEqual(P.toasts, ["Reopening failed — action must be approve or reject"]);
  assert.match(P.list(), /class="mt-err">Reopening failed/);
});

test("XERK-2857: the last proposal answered moves the selection on; a mid-click repaint never yanks it", async () => {
  const items = meeting().items;
  const answered = (m) => ({ ...m, items: m.items.map((it) => ({ ...it, review: { state: it.kind === "decision" ? "logged" : "rejected", at: 1 } })) });
  const one = meeting({ items: [items[1]] });
  const second = meeting({ meetingId: "m2", title: "Second", startedAt: 1.7e12 - 1e6 });
  const P = loadPage((u, init) => (init.method === "POST" ? { ok: true, meeting: answered(one) } : META(u)));
  P.update(data([one, second]));
  // An SSE frame saying the selected meeting is done does not take it away.
  P.update(data([answered(one), second]));
  assert.equal(P.state().selected, P.entryKey(SITE, "m:m1"));
  assert.match(P.list(), /data-entry="[^"]*m%3Am1"/);
  P.update(data([one, second]));
  await P.review(P.itemKey(SITE, "m1", "p2"), "approve");
  assert.equal(P.state().selected, P.entryKey(SITE, "m:m2"));
  assert.doesNotMatch(P.list(), /data-entry="[^"]*m%3Am1"/, "it dropped out of Needs review once the selection moved");
});

test("XERK-2857: keyboard triage — J/K move, A/R/E act on the current proposal, never while typing", async () => {
  const P = loadPage((u, init) => (init.method === "POST" ? { ok: true } : META(u)));
  P.update(data());
  await P.settle();
  const key = (k, target = { tagName: "BODY" }, extra = {}) => {
    let prevented = false;
    P.onKey({ key: k, target, preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
  };
  const k1 = P.itemKey(SITE, "m1", "p1"), k2 = P.itemKey(SITE, "m1", "p2");
  assert.equal(key("j"), true);
  assert.equal(P.state().curItem, k1);
  assert.match(P.list(), /class="mt-item cur" data-item="acme\.atlassian\.net\/m1\/p1"/);
  assert.match(P.list(), /Approve <kbd class="mt-kbd" aria-hidden="true">A<\/kbd>/);
  key("j");
  assert.equal(P.state().curItem, k2);
  key("j");
  assert.equal(P.state().curItem, k2, "J stops at the last");
  key("k");
  assert.equal(P.state().curItem, k1);
  // Typing in a field, a contenteditable, with a modifier, or in a dialog: nothing.
  for (const [t, extra] of [[{ tagName: "INPUT" }, {}], [{ tagName: "TEXTAREA" }, {}], [{ tagName: "SELECT" }, {}],
    [{ tagName: "DIV", isContentEditable: true }, {}], [{ tagName: "BODY" }, { ctrlKey: true }], [{ tagName: "BODY" }, { metaKey: true }],
    [{ tagName: "BUTTON", closest: () => ({}) }, {}]]) {
    assert.equal(key("r", t, extra), false);
  }
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, 0);
  key("e");
  assert.ok(P.edits.has(k1), "E opens the editor");
  P.edits.delete(k1);
  key("r");
  await P.settle();
  assert.deepEqual(P.fetches.filter((f) => f.method === "POST").map((f) => [f.url.split("/").pop(), f.body.action]), [["p1", "reject"]]);
  // S on a decision does nothing (no session for a decision).
  key("k"); key("j"); key("j");
  const before = P.fetches.filter((f) => f.method === "POST").length;
  P.state().curItem === k2 && key("s");
  await P.settle();
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, before);
  // The settings drawer open: no shortcuts.
  P.openDrawer(SITE);
  assert.equal(key("a"), false);
});

test("XERK-2857: every new string is escaped — org, entry title, settings drawer, unmapped-label banner", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const site = `x"><script>alert(1)</script>`;
  const d = { agents: [{ org: site, jira: { siteKey: site, orgName: evil } }],
    meetingProposals: { [site]: [meeting({ title: evil, platform: evil, participants: [evil] })] },
    meetingLabels: { [site]: { label: "x", custom: true } }, meetingFocus: { [site]: { names: [evil], role: evil } },
    meetingLabelMisses: { "mis-label": { at: 1 } } };
  const P = loadPage(META);
  P.update(d);
  P.openDrawer(site);
  const h = P.list();
  assert.doesNotMatch(h, /<img|<script>/);
  assert.match(h, /<span class="nm">&lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
  assert.match(h, /<span class="t">&lt;img/);
  assert.match(h, /data-org-toggle="x&quot;&gt;&lt;script&gt;/);
  assert.match(h, /aria-label="Meeting settings for &lt;img/);
  assert.match(h, /<h2>&lt;img src=x onerror=alert\(1\)&gt; — meeting settings<\/h2>/);
  assert.match(h, /<option value="x&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;">/);
});

test("XERK-2857: a phone shows one pane at a time — picking an entry opens it, Back returns to the rail", () => {
  const P = loadPage(META);
  P.update(two());
  assert.match(P.list(), /<div class="tri">/);
  P.click({ entry: P.entryKey(OTHER, "m:g1") });
  assert.match(P.list(), /<div class="tri show-main">/);
  assert.match(P.list(), /<h2 class="tri-title">Globex sync<\/h2>/);
  P.click({ back: "1" });
  assert.match(P.list(), /<div class="tri">/);
});

// QA D2: the hub broadcasts the meetingProposals frame BEFORE it answers the POST.
// The cursor must land on the proposal that took the answered one's place either
// way — clearing it made the next key act on the FIRST proposal (a wrong ticket).
test("XERK-2857: the keyboard cursor moves to the next proposal when the SSE frame beats the POST answer", async () => {
  const four = ["p1", "p2", "p3", "p4"].map((id) => ({ id, kind: "task", title: `Item ${id}`, description: "" }));
  const m = (rejected) => meeting({ items: four.map((it) => (rejected.includes(it.id) ? { ...it, review: { state: "rejected", at: 1 } } : it)) });
  const answers = [];
  const P = loadPage((u, init) => (init.method === "POST" ? new Promise((r) => answers.push(r)) : META(u)));
  P.update(data([m([])]));
  await P.settle();
  const key = (k) => P.onKey({ key: k, target: { tagName: "BODY" }, preventDefault() {} });
  key("j"); key("j");
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p2"));
  key("r");
  P.update(data([m(["p2"])]));                 // the frame lands first
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p3"), "the frame moves the cursor on, not off");
  answers.shift()({ ok: true, meeting: m(["p2"]) });
  await P.settle();
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p3"), "the answer does not move it twice");
  key("r");
  answers.shift()({ ok: true, meeting: m(["p2", "p3"]) });  // the answer first this time
  await P.settle();
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p4"));
  P.update(data([m(["p2", "p3"])]));
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p4"));
  assert.deepEqual(P.fetches.filter((f) => f.method === "POST").map((f) => f.url.split("/").pop()), ["p2", "p3"]);
  // The last one answered: the cursor steps back to the one before.
  key("r");
  P.update(data([m(["p2", "p3", "p4"])]));
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p1"));
  answers.shift()({ ok: true, meeting: m(["p2", "p3", "p4"]) });
  await P.settle();
});

test("XERK-2857: a held key's auto-repeat acts on nothing", async () => {
  const P = loadPage((u, init) => (init.method === "POST" ? { ok: true } : META(u)));
  P.update(data());
  await P.settle();
  let prevented = false;
  P.onKey({ key: "r", repeat: true, target: { tagName: "BODY" }, preventDefault: () => { prevented = true; } });
  P.onKey({ key: "j", repeat: true, target: { tagName: "BODY" }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(P.state().curItem, null);
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, 0);
});

// QA D3: a title-matched daily meeting re-keys the brief-only entry it claims
// (`d:<M>` → `d:<startedAt>`); the selection follows it, never another org's first entry.
test("XERK-2857: a selected entry re-keyed under the viewer stays selected as the entry carrying its brief", () => {
  const M = 1.7e12 + 9 * 3600e3, S = M + 2 * 3600e3;
  const AAA = "aaa.atlassian.net";
  const brief = { runId: "b9", status: "ok", trigger: "scheduled", meetingAt: M, startedAt: M - 300e3, day: "D." };
  const base = (meetings) => ({ agents: [{ org: SITE, jira: { siteKey: SITE, orgName: "Acme" } }, { org: AAA, jira: { siteKey: AAA, orgName: "Aaa" } }],
    dailyBriefs: { [SITE]: [brief] },
    meetingProposals: { [SITE]: meetings, [AAA]: [meeting({ meetingId: "a1", title: "Aaa sync" })] } });
  const P = loadPage(META);
  P.update(base([]));
  P.select(P.entryKey(SITE, `d:${M}`));
  assert.equal(P.state().selected, P.entryKey(SITE, `d:${M}`));
  P.update(base([meeting({ meetingId: "st", title: "Standup", startedAt: S, daily: { meetingAt: S, briefRunId: "b9" } })]));
  assert.equal(P.state().selected, P.entryKey(SITE, `d:${S}`), "the entry now carrying its brief");
  // Gone with nothing carrying it: the nearest entry of the same org, not the first org's.
  P.update(base([meeting({ meetingId: "x2", title: "Other", startedAt: S + 3600e3 })]));
  assert.equal(P.state().selected.startsWith(encodeURIComponent(SITE)), true);
});

// ---- XERK-2898: reviewing from the calendar's event panel ---------------------------
const panelClick = (el, dataset, aria = null) => {
  for (const fn of el.listeners.click) fn({ target: { closest: () => ({ dataset, getAttribute: () => aria }) } });
};

test("XERK-2898: the calendar panel renders a capture's summary, people and proposals — escaped, with the notes view's controls", async () => {
  const P = loadPage(META);
  const d = data([meeting({ summary: "Talked <b>login</b>.", participants: ["Ann <x>", "Bo"] })]);
  P.update(d);
  const el = P.document.createElement();
  assert.equal(P.showPanel(el, { site: SITE, meetingIds: ["m1"] }), true);
  const h = el.innerHTML;
  assert.match(h, /<div class="mt-people" aria-label="Participants"><span>Ann &lt;x&gt;<\/span><span>Bo<\/span><\/div>/);
  assert.match(h, /<div class="mt-summary" aria-label="Summary"><p>Talked &lt;b&gt;login&lt;\/b&gt;\.<\/p><\/div>/);
  assert.match(h, /Fix the &lt;img src=x onerror=alert\(1\)&gt; bug/);
  assert.match(h, /href="https:\/\/tenir\.example\/c\/1"[^>]*>Open in Tenir/);
  assert.match(h, /data-act="approve" data-k="acme\.atlassian\.net\/m1\/p1"/);
  assert.match(h, />Log decision</);
  assert.doesNotMatch(h, /<img|<b>login/);
  assert.deepEqual(P.state().panel, { site: SITE, meetingIds: ["m1"], dailyAt: 0 });
  // A meeting the snapshot does not carry paints nothing (the calendar shows its own copy).
  assert.equal(P.showPanel(el, { site: SITE, meetingIds: ["nope"] }), false);
  assert.equal(el.innerHTML, "");
  // A wrong-typed spec is no panel at all.
  assert.equal(P.showPanel(el, { site: 7 }), false);
  assert.equal(P.state().panel, null);
});

test("XERK-2898: review from the calendar — Reject posts, the busy guard holds, the notes view's selection stays put", async () => {
  const answers = [];
  const P = loadPage((u, init) => (init.method === "POST" ? new Promise((r) => answers.push(r)) : META(u)));
  const two = [meeting(), meeting({ meetingId: "m2", title: "Other", startedAt: 1.6e12 })];
  P.update(data(two));
  await P.settle();
  const before = P.state().selected;
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  panelClick(el, { act: "reject", k: P.itemKey(SITE, "m1", "p1") });
  assert.match(el.innerHTML, /data-act="reject" data-k="acme\.atlassian\.net\/m1\/p1" aria-disabled="true">Reject/);
  panelClick(el, { act: "reject", k: P.itemKey(SITE, "m1", "p1") }, "true");   // a second press while busy
  await P.settle();
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, 1);
  const rejected = meeting({ items: meeting().items.map((it) => (it.id === "p1" ? { ...it, review: { state: "rejected", at: 1 } } : it)) });
  answers.shift()({ ok: true, meeting: rejected });
  await P.settle();
  assert.doesNotMatch(el.innerHTML, /data-k="acme\.atlassian\.net\/m1\/p1"/, "a reviewed proposal leaves the list");
  assert.match(el.innerHTML, /1 of 2 reviewed/);
  assert.equal(P.state().selected, before, "reviewing in the calendar never moves the notes view");
  // A refusal shows in the hub's words, inline and as the toast.
  P.showPanel(el, null);
  const R = loadPage((u, init) => (init.method === "POST" ? { status: 409, body: { error: "already <creating>" } } : META(u)));
  R.update(data());
  await R.settle();
  const el2 = R.document.createElement();
  R.showPanel(el2, { site: SITE, meetingIds: ["m1"] });
  panelClick(el2, { act: "reject", k: R.itemKey(SITE, "m1", "p2") });
  await R.settle();
  assert.match(el2.innerHTML, /Rejecting failed — already &lt;creating&gt;/);
  assert.deepEqual(R.toasts, ["Rejecting failed — already <creating>"]);
});

test("XERK-2898: the keys act on the panel while it shows a meeting, and the cursor follows its place when the SSE frame beats the POST", async () => {
  const four = ["p1", "p2", "p3", "p4"].map((id) => ({ id, kind: "task", title: `Item ${id}`, description: "" }));
  const m = (rejected) => meeting({ items: four.map((it) => (rejected.includes(it.id) ? { ...it, review: { state: "rejected", at: 1 } } : it)) });
  const answers = [];
  const P = loadPage((u, init) => (init.method === "POST" ? new Promise((r) => answers.push(r)) : META(u)));
  // The notes view is hidden (the calendar is shown): its keys are inert...
  P.els.meetingList.offsetParent = null;
  P.update(data([m([]), meeting({ meetingId: "m2", title: "Other" })]));
  await P.settle();
  const key = (k) => P.onKey({ key: k, target: { tagName: "BODY" }, preventDefault() {} });
  key("j");
  assert.equal(P.state().curItem, null);
  // ...until the calendar's panel shows a meeting: then they walk ITS proposals.
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  key("j"); key("j");
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p2"));
  assert.match(el.innerHTML, /class="mt-item cur" data-item="acme\.atlassian\.net\/m1\/p2"/);
  key("r");
  P.update(data([m(["p2"]), meeting({ meetingId: "m2", title: "Other" })]));   // the frame lands first
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p3"), "the frame moves the cursor on, not off");
  answers.shift()({ ok: true, meeting: m(["p2"]) });
  await P.settle();
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p3"), "the answer does not move it twice");
  key("r");
  answers.shift()({ ok: true, meeting: m(["p2", "p3"]) });                  // the answer first this time
  await P.settle();
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p4"));
  assert.deepEqual(P.fetches.filter((f) => f.method === "POST").map((f) => f.url.split("/").pop()), ["p2", "p3"]);
  // A key typed into the panel's Edit field is the field's.
  key("e");
  assert.match(el.innerHTML, /data-edit-title=/);
  const before = P.fetches.length;
  P.onKey({ key: "r", target: { tagName: "TEXTAREA" }, preventDefault() {} });
  assert.equal(P.fetches.length, before);
  // The panel closed: inert again.
  P.showPanel(el, null);
  key("j");
  assert.equal(P.fetches.length, before);
  assert.equal(P.state().curItem, null);
});

test("XERK-2898: a daily meeting's event shows the Daily brief, as the notes view does", async () => {
  const seen = [];
  const hooks = { briefHtml: (site, e) => { seen.push(e); return `<section class="brief-block">BRIEF ${e.briefs.length}</section>`; } };
  const P = loadPage(META, [], {}, { hooks });
  const at = 1.7e12;
  const d = data([meeting({ daily: { meetingAt: at, briefRunId: "r1" } })]);
  d.dailyBriefs = { [SITE]: [{ runId: "r1", status: "ok", meetingAt: at, startedAt: at - 3e5, day: "d" }, { runId: "r0", status: "ok", meetingAt: at - 864e5 }] };
  P.update(d);
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"], dailyAt: at + 60000 });
  assert.match(el.innerHTML, /<div class="mt-panel"><div class="tri-brief"><section class="brief-block">BRIEF 1<\/section><\/div><section class="mt-meeting">/);
  // A daily event no capture is linked to yet (upcoming, or not captured): the brief of its meetingAt alone.
  P.showPanel(el, { site: SITE, meetingIds: [], dailyAt: at - 864e5 + 5 * 60000 });
  assert.match(el.innerHTML, /BRIEF 1/);
  assert.doesNotMatch(el.innerHTML, /mt-meeting/);
  assert.equal(seen[seen.length - 1].briefs[0].runId, "r0");
  // Further than 20 minutes from any daily meeting: nothing.
  P.showPanel(el, { site: SITE, meetingIds: [], dailyAt: at - 864e5 + 30 * 60000 });
  assert.equal(el.innerHTML, "");
});

test("XERK-2898: meetingState — proposals pending, a meeting being read, archived counts none", () => {
  const P = loadPage(META);
  assert.deepEqual(P.meetingState(data(), SITE, "m1"), { pending: 2, reading: false, title: "Sprint <sync>", calendarBy: "" });
  const one = meeting({ items: meeting().items.map((it, i) => (i ? { ...it, review: { state: "logged", at: 1 } } : it)), calendarBy: "operator" });
  assert.deepEqual(P.meetingState(data([one]), SITE, "m1"), { pending: 1, reading: false, title: "Sprint <sync>", calendarBy: "operator" });
  assert.equal(P.meetingState(data([meeting({ archivedAt: 5 })]), SITE, "m1").pending, 0);
  assert.deepEqual(P.meetingState(data([meeting({ status: "running", items: undefined })]), SITE, "m1"),
    { pending: 0, reading: true, title: "Sprint <sync>", calendarBy: "" });
  assert.equal(P.meetingState(data(), SITE, "nope"), null);
  assert.equal(P.meetingState(data(), "__proto__", "m1"), null);
});

test("XERK-2898: end to end — click a past event on the calendar, review its capture in the panel, the badge counts down", async () => {
  const start = Date.now() - 2 * 864e5;
  const answers = [];
  const ev = { host: "h1", id: "OUT1", org: SITE, source: "outlook", subject: "Sprint sync", startMs: start, endMs: start + 18e5,
    meetings: [{ site: SITE, meetingId: "m1", title: "Sprint <sync>" }] };
  const P = loadPage((u, init) => {
    if (u.startsWith("/api/calendar")) return { hosts: [], events: [ev] };
    if (u.startsWith("/api/holidays")) return [];
    if (init.method === "POST") return new Promise((r) => answers.push(r));
    return META(u);
  }, [], {}, { calendar: true });
  const cal = P.cal;
  const root = P.document.createElement();
  cal.mount(root, { now: () => Date.now() });
  const d = data([meeting({ startedAt: start, endedAt: start + 18e5 })]);
  P.update(d);
  cal.update(d);
  cal.setActive(true);
  cal._go(start);
  await P.settle();
  const grid = cal._els().grid.innerHTML;
  assert.match(grid, /, 2 proposals to review"/);
  const btn = /data-ev="(\d+)" data-day="(\d+)"/.exec(grid);
  for (const fn of root.listeners.click) fn({ target: { closest: () => ({ dataset: { ev: btn[1], day: btn[2] }, getAttribute: () => null }) } });
  const { mt, info } = cal._els();
  assert.match(info.innerHTML, /Tenir capture: <b>Sprint &lt;sync&gt;<\/b>/);
  assert.match(mt.innerHTML, /Fix the &lt;img src=x onerror=alert\(1\)&gt; bug/);
  // Log the decision from the calendar.
  panelClick(mt, { act: "approve", k: P.itemKey(SITE, "m1", "p2") });
  await P.settle();
  const post = P.fetches.find((f) => f.method === "POST");
  assert.equal(post.url, `/api/orgs/${SITE}/meetings/m1/items/p2`);
  assert.equal(post.body.action, "approve");
  const logged = meeting({ startedAt: start, endedAt: start + 18e5,
    items: meeting().items.map((it) => (it.id === "p2" ? { ...it, review: { state: "logged", at: 1 } } : it)) });
  answers.shift()({ ok: true, meeting: logged });
  await P.settle();
  const d2 = data([logged]);
  P.update(d2);
  cal.update(d2);
  assert.match(cal._els().grid.innerHTML, /, 1 proposal to review"/);
  assert.match(mt.innerHTML, /1 of 2 reviewed/);
  // Closing the event closes the panel: the keys go back to the (hidden) notes view.
  for (const fn of root.listeners.click) fn({ target: { closest: () => ({ dataset: { closeDetail: "" }, getAttribute: () => null }) } });
  assert.equal(P.state().panel, null);
  assert.equal(mt.innerHTML, "");
});

test("XERK-2898 QA: a review pressed in the panel never moves the notes view, even when the panel closed before the answer", async () => {
  // (An archive takes the entry out of Needs review, so that selection moves wherever it was pressed.)
  for (const what of ["review"]) {
    const answers = [];
    const P = loadPage((u, init) => (init.method === "POST" ? new Promise((r) => answers.push(r)) : META(u)));
    const one = meeting({ items: [meeting().items[0]] });
    const other = meeting({ meetingId: "m2", title: "Other", startedAt: 1.6e12 });
    P.update(data([one, other]));
    await P.settle();
    P.select(P.entryKey(SITE, "m:m1"));
    const el = P.document.createElement();
    P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
    if (what === "review") panelClick(el, { act: "reject", k: P.itemKey(SITE, "m1", "p1") });
    else P.archive(P.meetingKey(SITE, "m1"), true);
    await P.settle();
    P.showPanel(el, null);                                   // the panel closes before the answer
    const row = what === "review" ? meeting({ items: [{ ...meeting().items[0], review: { state: "rejected", at: 1 } }] })
      : { ...one, archivedAt: 5 };
    answers.shift()({ ok: true, meeting: row });
    await P.settle();
    assert.equal(P.state().selected, P.entryKey(SITE, "m:m1"), `${what}: the selection stays`);
  }
});

test("XERK-2898 QA: J walks the PANEL's meeting, not the notes view's selection; the notes cursor comes back after", async () => {
  const P = loadPage(META);
  const m2 = meeting({ meetingId: "m2", title: "Other", startedAt: 1.6e12 });
  P.update(data([meeting(), m2]));
  await P.settle();
  P.select(P.entryKey(SITE, "m:m2"));
  const key = (k) => P.onKey({ key: k, target: { tagName: "BODY" }, preventDefault() {} });
  key("j");
  assert.equal(P.state().curItem, P.itemKey(SITE, "m2", "p1"));
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  key("j");
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p1"), "the panel's meeting, not the notes view's m2");
  P.showPanel(el, null);
  assert.equal(P.state().curItem, P.itemKey(SITE, "m2", "p1"), "the notes view's cursor is back");
});

test("XERK-2898 QA: the panel's repaint waits while one of its fields has focus, and lands on focusout", async () => {
  const P = loadPage(META);
  P.update(data());
  await P.settle();
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  const field = { tagName: "TEXTAREA", dataset: {} };
  el.contains = (a) => a === field;
  P.document.activeElement = field;
  const before = el.innerHTML;
  P.update(data([meeting({ title: "Renamed" })]));               // an SSE frame while typing
  assert.equal(el.innerHTML, before, "held");
  P.document.activeElement = null;
  for (const fn of el.listeners.focusout) fn({});
  assert.match(el.innerHTML, /Renamed/, "painted once focus left");
});

test("XERK-2898 QA: a notes-view review that lands while a panel is open leaves the PANEL's cursor alone", async () => {
  const answers = [];
  const P = loadPage((u, init) => (init.method === "POST" ? new Promise((r) => answers.push(r)) : META(u)));
  const last = meeting({ meetingId: "m2", title: "Other", startedAt: 1.6e12, items: [meeting().items[0]] });
  const three = meeting({ items: ["p1", "p2", "p3"].map((id) => ({ id, kind: "task", title: id, description: "" })) });
  P.update(data([three, last]));
  await P.settle();
  P.select(P.entryKey(SITE, "m:m2"));
  P.click({ act: "reject", k: P.itemKey(SITE, "m2", "p1") });        // pressed in the notes view
  await P.settle();
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  const key = (k) => P.onKey({ key: k, target: { tagName: "BODY" }, preventDefault() {} });
  key("j"); key("j");
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p2"));
  answers.shift()({ ok: true, meeting: { ...last, items: [{ ...last.items[0], review: { state: "rejected", at: 1 } }] } });
  await P.settle();
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p2"), "the panel cursor survives the notes view's answer");
  key("r");
  await P.settle();
  assert.match(P.fetches.filter((f) => f.method === "POST").pop().url, /\/m1\/items\/p2$/);
  // The notes view moved on meanwhile: its saved cursor was reset, so closing the panel
  // never brings back one pointing into the entry just answered.
  P.showPanel(el, null);
  assert.equal(P.state().curItem, null);
});

test("XERK-2898 QA: the review answer follows the panel's order, not the notes view's", async () => {
  const answers = [];
  const P = loadPage((u, init) => (init.method === "POST" ? new Promise((r) => answers.push(r)) : META(u)));
  const four = ["p1", "p2", "p3"].map((id) => ({ id, kind: "task", title: id, description: "" }));
  const m1 = (rej) => meeting({ items: four.map((it) => (rej.includes(it.id) ? { ...it, review: { state: "rejected", at: 1 } } : it)) });
  P.update(data([m1([]), meeting({ meetingId: "m2", title: "Other", startedAt: 1.6e12 })]));
  await P.settle();
  P.select(P.entryKey(SITE, "m:m2"));
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  const key = (k) => P.onKey({ key: k, target: { tagName: "BODY" }, preventDefault() {} });
  key("j"); key("j");
  key("r");                                                         // p2; no frame this time, only the answer
  answers.shift()({ ok: true, meeting: m1(["p2"]) });
  await P.settle();
  assert.equal(P.state().curItem, P.itemKey(SITE, "m1", "p3"));
});

// ---- XERK-2899: the calendar in the notes review --------------------------------------
const HOUR = 3600000;
const calEv = (id, startMs, over = {}) => ({ host: "h1", id, org: SITE, source: "outlook", subject: id,
  startMs, endMs: startMs + HOUR, joinUrl: "https://zoom.us/j/9", attendees: [], ...over });
function calPage(events, opened = []) {
  const P = loadPage(META);
  P.setHooks({ upcomingOf: (site) => events.filter((e) => e.org === site), openCalendar: (t) => opened.push(t) });
  return P;
}

test("XERK-2899: upcoming calendar meetings list under Upcoming, org-colored with time and join link — never as needing review", () => {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(14, 0, 0, 0);
  const opened = [];
  const evs = [calEv("plan", tomorrow.getTime(), { subject: "Planning <b>Q1</b>", location: "Room <1>", organizer: "Ann",
    attendees: [{ name: "Ann", role: "organizer" }, { name: "Bo", role: "required" }, { name: "Room 1", role: "resource" }] }),
  calEv("bad-link", tomorrow.getTime() + 2 * HOUR, { joinUrl: "javascript:alert(1)" }),
  calEv("taken", tomorrow.getTime() + 3 * HOUR)];
  const P = calPage(evs, opened);
  const d = data([meeting({ calendarEventId: "taken" })]);    // already this capture's: not listed again
  P.setCache(d);
  // Needs review (the default): the event alone needs nothing reviewed.
  P.renderMeetings(d);
  assert.doesNotMatch(P.list(), /Planning/);
  assert.equal(P.pendingCount(d), 2, "the capture's two proposals, nothing for the event");
  P.setFilter("all");
  const h = P.list();
  assert.match(h, /<div class="tri-sec">Upcoming<\/div>(?:(?!tri-sec).)*<div class="tri-entry-row"><button type="button" class="tri-entry cal" data-entry="[^"]*c%3Aplan" style="--org:var\(--s3\)">/);
  assert.match(h, /<span class="t">Planning &lt;b&gt;Q1&lt;\/b&gt;<\/span><span class="w">[^<]*\d:00/);
  assert.match(h, /<a class="tri-join" href="https:\/\/zoom\.us\/j\/9"[^>]*>Join<\/a>/);
  assert.doesNotMatch(h, /javascript:|<b>Q1|c%3Ataken/);
  // Upcoming reads soonest first.
  assert.ok(h.indexOf("c%3Aplan") < h.indexOf("c%3Abad-link"), "the sooner meeting first");
  // Selected, it shows what Outlook says, and Open in calendar jumps to it.
  P.select(P.entryKey(SITE, "c:plan"));
  const m = P.list();
  assert.match(m, /<h2 class="tri-title">Planning &lt;b&gt;Q1&lt;\/b&gt;<\/h2>/);
  assert.match(m, /<span class="k">Where<\/span> Room &lt;1&gt;/);
  assert.match(m, /<span class="k">Invited<\/span> Ann, Bo<\/div>/);
  assert.match(m, /Join meeting ↗/);
  const idx = /data-open-cal="(\d+)"/.exec(m)[1];
  P.click({ openCal: idx });
  assert.deepEqual(opened, [{ site: SITE, eventId: "plan", startMs: tomorrow.getTime() }]);
  // Back on Needs review the selection is sticky; moving it on drops the event from the list.
  P.setFilter("review");
  assert.match(P.list(), /c%3Aplan/);
  P.select(P.entryKey(SITE, "m:m1"));
  assert.doesNotMatch(P.list(), /c%3Aplan/);
});

test("XERK-2899: the daily meeting's calendar occurrence joins its daily entry, not an entry of its own", () => {
  const at = Date.now() + 2 * 864e5;
  const P = loadPage(META);
  P.setHooks({ nextOf: () => ({ meetingAt: at, runAt: at - 30 * 60000 }), openCalendar: () => {},
    upcomingOf: () => [calEv("standup", at + 5 * 60000, { subject: "Standup" }), calEv("later", at + 4 * HOUR)] });
  const d = data([]);
  const list = P.entriesOf(d, SITE, Date.now());
  const daily = list.find((e) => e.daily);
  assert.equal(daily.event.id, "standup");
  assert.deepEqual(list.filter((e) => e.cal).map((e) => e.id), ["c:later"]);
  // Pairing adds nothing to review: the daily entry is current already, the event changes no count.
  assert.equal(daily.pending, 0);
  P.setCache(d);
  P.select(daily.key);
  assert.match(P.list(), /<span class="k">On the calendar<\/span> Standup · /);
  assert.match(P.list(), /data-open-cal=/);
});

test("XERK-2899: a linked capture shows its Outlook title, time and attendees; an impromptu one is labeled", () => {
  const opened = [];
  const P = calPage([], opened);
  const ev = { host: "h1", org: SITE, subject: "Design <review>", startMs: 1.7e12, endMs: 1.7e12 + HOUR,
    canceled: false, moved: true, attendees: ["Ann", "Bo <x>"] };
  const d = data([meeting({ title: "Zoom meeting", calendarEventId: "ev1", calendarEvent: ev, summary: "We met." }),
    meeting({ meetingId: "m2", title: "Hallway", startedAt: 1.6e12 }),
    meeting({ meetingId: "m3", title: "Hidden", startedAt: 1.5e12, calendarEventId: "pv",
      calendarEvent: { ...ev, subject: "Private event", private: true, attendees: [] } })]);
  P.setCache(d);
  P.setFilter("all");
  P.select(P.entryKey(SITE, "m:m1"));
  let h = P.list();
  assert.match(h, /<h2 class="tri-title">Design &lt;review&gt;<\/h2>/);
  assert.match(h, /<span class="t">Design &lt;review&gt;<\/span><span class="w">/, "the rail names it by Outlook too");
  assert.match(h, /<span class="k">On the calendar<\/span> [^<]*· moved since<\/div>/);
  assert.match(h, /<span class="k">Invited<\/span> Ann, Bo &lt;x&gt;<\/div>/);
  assert.match(h, /mt-summary/);
  assert.doesNotMatch(h, /Impromptu/);
  assert.match(h, /<span class="t">Hallway<\/span><span class="tri-tag">impromptu<\/span>/);
  P.click({ openCal: /data-open-cal="(\d+)"/.exec(h)[1] });
  assert.deepEqual(opened, [{ site: SITE, meetingId: "m1", eventId: "ev1", startMs: 1.7e12 }]);
  P.select(P.entryKey(SITE, "m:m2"));
  h = P.list();
  assert.match(h, /<span class="mt-tag">Impromptu<\/span> Not on the calendar\./);
  P.click({ openCal: /data-open-cal="(\d+)"/.exec(h)[1] });
  assert.deepEqual(opened[1], { site: SITE, meetingId: "m2", eventId: "", startMs: 1.6e12 });
  // A private event never names the capture "Private event".
  P.select(P.entryKey(SITE, "m:m3"));
  assert.match(P.list(), /<h2 class="tri-title">Hidden<\/h2>/);
});

test("XERK-2899: Open in notes review selects the capture or meeting wherever the filters put it", () => {
  const soon = Date.now() + 864e5 * 2;
  const P = calPage([calEv("soon", soon, { subject: "Soon" })]);
  const d = data([meeting({ meetingId: "old", title: "Old one", archivedAt: 1.7e12 + 5e6, items: [] }), meeting()]);
  P.setCache(d);
  P.renderMeetings(d);
  P.setQuery("sprint");
  // An archived capture: the filter moves to Archived and the search that hid it clears.
  P.reveal({ site: SITE, meetingId: "old" });
  assert.equal(P.state().filter, "archived");
  assert.equal(P.state().selected, P.entryKey(SITE, "m:old"));
  assert.equal(P.state().narrowMain, true);
  assert.match(P.list(), /<h2 class="tri-title">Old one<\/h2>/);
  // An upcoming calendar meeting from Archived: All, and it stays selected under Needs review too.
  P.reveal({ site: SITE, eventId: "soon" });
  assert.equal(P.state().filter, "all");
  assert.equal(P.state().selected, P.entryKey(SITE, "c:soon"));
  P.setFilter("review");
  assert.equal(P.state().selected, P.entryKey(SITE, "c:soon"));
  // A collapsed org opens to show it.
  P.click({ orgToggle: SITE });
  assert.deepEqual(P.state().collapsed, [SITE]);
  P.reveal({ site: SITE, meetingId: "m1" });
  assert.deepEqual(P.state().collapsed, []);
  assert.equal(P.state().selected, P.entryKey(SITE, "m:m1"));
});

test("XERK-2899 QA: an org color is only a palette slot; a week-out meeting carries its date", () => {
  const G = "globex.atlassian.net";
  const far = new Date(); far.setDate(far.getDate() + 6); far.setHours(9, 0, 0, 0);
  const P = calPage([calEv("a", Date.now() + 2 * 864e5), calEv("g", far.getTime(), { org: G })]);
  const d = { ...data([]), agents: [{ org: SITE, jira: { siteKey: SITE, orgName: "Acme" } }, { org: G, jira: { siteKey: G, orgName: "Globex" } }] };
  P.setCache(d);
  P.setFilter("all");
  const h = P.list();
  assert.match(h, /data-entry="[^"]*c%3Aa"[^>]*style="--org:var\(--s3\)"/);
  assert.match(h, /data-entry="[^"]*c%3Ag">/, "a non-palette color paints neutral");
  assert.doesNotMatch(h, /url\(x\)/);
  const day = far.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  assert.ok(h.includes(`<span class="w">${day} `), `dated: ${day}`);
});

test("XERK-2914: every paint numbers its Open in calendar buttons afresh, so an index never outlives its paint", () => {
  const opened = [];
  const soon = Date.now() + 2 * 864e5;
  const P = calPage([calEv("soon", soon)], opened);
  const d = data([]);
  P.setCache(d);
  P.setFilter("all");
  P.select(P.entryKey(SITE, "c:soon"));
  for (let i = 0; i < 3; i++) P.renderMeetings(d);
  assert.deepEqual([...P.list().matchAll(/data-open-cal="(\d+)"/g)].map((m) => m[1]), ["0"]);
  P.click({ openCal: "0" });
  assert.deepEqual(opened, [{ site: SITE, eventId: "soon", startMs: soon }]);
  // An index from an earlier paint that this one did not hand out opens nothing.
  P.click({ openCal: "1" });
  assert.equal(opened.length, 1);
});

test("XERK-2898: the calendar's own panel offers no 'Open in calendar'; the notes view still does", async () => {
  const P = loadPage(META, [], {}, { hooks: { openCalendar: () => {} } });
  P.update(data());
  await P.settle();
  assert.match(P.list(), /data-open-cal=/);
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  assert.match(el.innerHTML, /data-act="approve"/);
  assert.doesNotMatch(el.innerHTML, /data-open-cal/);
});

test("XERK-2914: archiving from the calendar panel leaves the notes view's selection to its own fallback, not the archive's advance", async () => {
  const P = loadPage((u) => (/\/archive$/.test(u) ? { ok: true, meeting: meeting({ archivedAt: 1.7e12 + 9e6 }) } : META(u)));
  const three = [meeting({ meetingId: "m0", title: "Newest", startedAt: 1.7e12 + 1e6 }), meeting(),
    meeting({ meetingId: "m2", title: "Oldest", startedAt: 1.7e12 - 1e6 })];
  P.update(data(three));
  await P.settle();
  P.select(P.entryKey(SITE, "m:m1"));
  const el = P.document.createElement();
  P.showPanel(el, { site: SITE, meetingIds: ["m1"] });
  await P.archive(P.meetingKey(SITE, "m1"), true);
  await P.settle();
  // The guard skips the archive's advance (which would pick m2, the next entry): the view's
  // own fallback for a selection that left Needs review picks the first entry.
  assert.equal(P.state().selected, P.entryKey(SITE, "m:m0"));
});
