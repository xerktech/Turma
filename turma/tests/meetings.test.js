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
function loadPage(reply = () => ({}), orgKeys = [], preset = {}) {
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
    TurmaBoard: { bareKey: require("../public/board.js").bareKey, orgName: (k, o) => o || k, mergeSites: (agents) => agents.map((a) => a.jira).filter(Boolean) },
    TurmaNewTicket: { update: noop },
  };
  const keys = Object.keys(stubs);
  new Function(...keys, script)(...keys.map((k) => stubs[k]));
  const api = stubs.window.TurmaMeetings;
  api.mount(document.getElementById("meetingList"));
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
