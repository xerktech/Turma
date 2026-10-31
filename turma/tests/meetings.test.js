// Unit tests for the Meetings page (public/meetings.html, XERK-2510): the
// proposal render (escaped model text, quotes linked to that moment in Tenir),
// the review states, and Approve / Approve + start / Reject posting to the hub.
// Same harness as brief.test.js: the page's real inline <script> runs against a
// minimal DOM shim and its helpers are returned out of the sandbox.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "meetings.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const script = blocks[blocks.length - 1][1];

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
function loadPage(reply = () => ({})) {
  const els = {};
  const fetches = [];
  const toasts = [];
  const store = {};
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); }, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener: noop, removeEventListener: noop, body: makeEl(), activeElement: null,
  };
  const stubs = {
    document,
    location: { href: "", search: "", pathname: "/meetings", hash: "" },
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
    TurmaOrg: { getKeys: () => [], update: noop, subscribe: noop, sse: noop },
    TurmaBoard: { orgName: (k, o) => o || k, mergeSites: (agents) => agents.map((a) => a.jira).filter(Boolean) },
    TurmaNewTicket: { update: noop },
  };
  const keys = Object.keys(stubs);
  const body = `${script}\n;return { renderMeetings, review, startEdit, edits, setProject, itemKey,
    setCache: (c) => { cache = c; } };`;
  const api = new Function(...keys, body)(...keys.map((k) => stubs[k]));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return Object.assign(api, { els, fetches, toasts, store, settle, list: () => els.meetingList.innerHTML });
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
  assert.match(h, /<h2 class="mt-org-name">Acme<\/h2>/);
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
  assert.match(post.body.description, /^It 500s\n\nProposed from the meeting "Sprint <sync>"/);
  assert.match(post.body.description, /> Ann: login <b>is<\/b> broken \[1:01\]/);
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
  const items = meeting().items;
  P.renderMeetings(data([meeting({ items: [
    { ...items[0], review: { state: "created", at: 1, key: "ACME-9", start: true, session: "queued" } },
    { ...items[1], review: { state: "logged", at: 1 } }] }),
  meeting({ meetingId: "m2", items: [{ ...items[0], review: { state: "failed", at: 1, error: "<boom>" } },
    { ...items[1], review: { state: "rejected", at: 1 } }] })]));
  const h = P.list();
  assert.match(h, /Created <a href="\/board\?ticket=ACME-9&amp;site=acme\.atlassian\.net">ACME-9<\/a>/);
  assert.match(h, /session starting/);
  P.renderMeetings(data([meeting({ items: [{ ...items[0], review: { state: "created", at: 1, key: "ACME-9", start: true,
    session: "failed", sessionError: "<img src=x>" } }] })]));
  assert.match(P.list(), /no session — &lt;img src=x&gt;/);
  assert.match(h, /Added to the decisions log/);
  assert.match(h, /Not created — &lt;boom&gt;/);
  assert.match(h, /class="mt-item rejected"/);
  // A pending or failed run says so instead of items.
  P.renderMeetings(data([meeting({ status: "running", host: "k8x-02", items: undefined }),
    meeting({ meetingId: "m3", status: "failed", error: "timed out", items: undefined })]));
  assert.match(P.list(), /Reading the captions on k8x-02/);
  assert.match(P.list(), /Could not propose work items — timed out/);
});
