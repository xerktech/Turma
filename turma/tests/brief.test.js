// Unit tests for the Daily Brief page (public/brief.html, XERK-2396): the
// read-aloud render, the schedule editor's save, escaping of model-written text,
// and Run now. Same harness as insights.test.js: no jsdom, so the page's real
// inline <script> runs against a minimal DOM shim and its helpers are returned
// out of the sandbox.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "brief.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const script = blocks[blocks.length - 1][1];

function makeEl() {
  const el = {
    _html: "", textContent: "", value: "", hidden: false, dataset: {}, children: [],
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    listeners: {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, remove() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; }, set(v) { this._html = String(v); },
  });
  return el;
}

// `reply(url, init)` answers each fetch: a body for 200, {status, body} for a
// refusal, or a Promise (resolving to a body) to hold the answer. `agents`, when
// given, answers the boot's /api/agents the same way; else that never lands.
function loadPage(reply = null, agents = null) {
  const els = {};
  const sse = [];
  const winListeners = {};
  const fetches = [];
  const toasts = [];
  const timers = [];
  const clip = [];
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener: noop, removeEventListener: noop,
    body: makeEl(), documentElement: makeEl(), activeElement: null,
  };
  const stubs = {
    document,
    location: { href: "", search: "", pathname: "/brief", hash: "" },
    navigator: { userAgent: "node", clipboard: { writeText: async (t) => { clip.push(t); } } },
    fetch: (u, init = {}) => {
      // A page that loops on a route would starve the runner: past 50 calls it
      // gets no answer, so the test fails on its count instead of hanging.
      if (fetches.length > 50) return new Promise(() => {});
      fetches.push({ url: String(u), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
      if (String(u) === "/api/agents") {
        if (!agents) return new Promise(() => {});
        return Promise.resolve(agents()).then((b) => ({ status: 200, ok: true, json: () => Promise.resolve(b) }));
      }
      if (!reply) return new Promise(() => {});
      const r = reply(String(u), init);
      if (r instanceof Error) return Promise.reject(r);
      if (r && typeof r.then === "function") {
        return r.then((b) => ({ status: 200, ok: true, json: () => Promise.resolve(b) }));
      }
      if (r && r.status) {
        return Promise.resolve({ status: r.status, ok: false, json: () => Promise.resolve(r.body || {}) });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(r) });
    },
    EventSource: class {
      constructor() { sse.push(this); this.handlers = {}; this.readyState = 1; }
      addEventListener(name, fn) { this.handlers[name] = fn; } close() {}
    },
    setInterval: () => 0, clearInterval: noop,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: noop,
    addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); }, removeEventListener: noop,
    console, Date, Math, JSON, Intl, encodeURIComponent, Number, String, Object, Array, Map, Set,
    TurmaNav: { preserveScroll: (el, paint) => paint(), toast: (m) => toasts.push(m),
      refusalText: (what, status, body) => {
        const why = (body && typeof body.error === "string" && body.error) || `the hub answered HTTP ${status}`;
        return what ? `${what} failed — ${why}` : why;
      } },
    TurmaOrg: { getKeys: () => [], update: noop, subscribe: noop, sse: noop },
    TurmaBoard: { orgName: (k, o) => o || k, mergeSites: (agents) => agents.map((a) => a.jira).filter(Boolean) },
    TurmaNewTicket: { update: noop },
  };
  const keys = Object.keys(stubs);
  const body = `${script}\n;return { render, renderBriefs, briefOrgHtml, briefText, runNow, saveSchedule,
    editField, drafts, nextFor, schedOpen, runRefusal, setCache: (c) => { cache = c; }, getCache: () => cache };`;
  const api = new Function(...keys, body)(...keys.map((k) => stubs[k]));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const runTimers = () => { for (const t of timers.splice(0)) t(); };
  const list = els.briefList;
  // What a test puts "inside" the list: the focused element counts as inside.
  list.contains = (el) => !!el && el.inside === true;
  return Object.assign(api, { els, fetches, toasts, clip, settle, runTimers, sse, winListeners, document,
    list: () => list.innerHTML, fire: (name, data) => sse[0].handlers[name]({ data: JSON.stringify(data) }) });
}

const SITE = "acme.atlassian.net";
const NOW = Date.UTC(2026, 9, 29, 13, 30);
function okBrief(over = {}) {
  return { runId: "a1", status: "ok", trigger: "scheduled", meetingAt: NOW, startedAt: NOW - 300e3,
    generatedAt: NOW - 240e3, model: "haiku", host: "k8x-03",
    day: "PROJ-1 merged. PROJ-2 is still open.", week: "Five tickets closed.", next: "PROJ-3 is next.", ...over };
}
function data(over = {}) {
  return { agents: [{ org: SITE, jira: { siteKey: SITE, orgName: "Acme" } }],
    dailyBriefs: { [SITE]: [okBrief()] }, dailyBriefSchedules: {}, ...over };
}

test("XERK-2396: the latest brief renders as its three read-aloud sections with its meta", () => {
  const P = loadPage();
  P.renderBriefs(data(), NOW);
  const h = P.list();
  assert.match(h, /<h2 class="brief-name">Acme<\/h2>/);
  assert.match(h, /Since yesterday · still open<\/h3><p>PROJ-1 merged\. PROJ-2 is still open\.<\/p>/);
  assert.match(h, /This week<\/h3><p>Five tickets closed\.<\/p>/);
  assert.match(h, /Up next<\/h3><p>PROJ-3 is next\.<\/p>/);
  assert.match(h, /For the .+ meeting/);
  assert.match(h, /written /);
  assert.match(h, /haiku/);
  assert.match(h, /on k8x-03/);
  assert.match(h, /data-copy=/);
  assert.match(h, /data-run="acme\.atlassian\.net"/);
});

test("XERK-2396: a running brief keeps the last one on screen and says it is being written", () => {
  const P = loadPage();
  const running = { runId: "b2", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW - 120e3,
    model: "haiku", host: "k8x-02" };
  P.renderBriefs(data({ dailyBriefs: { [SITE]: [running, okBrief()] } }), NOW);
  const h = P.list();
  assert.match(h, /Writing a brief on k8x-02… started 2m ago/);
  assert.match(h, /PROJ-1 merged/);
  assert.match(h, /data-run="[^"]+" disabled/, "Run now is off while one runs");
});

test("XERK-2396: a failed newest run shows the hub's reason; earlier briefs list headlines", () => {
  const P = loadPage();
  const failed = { runId: "c3", status: "failed", trigger: "scheduled", meetingAt: NOW, startedAt: NOW - 60e3,
    model: "haiku", error: "no online host of this org can write the brief" };
  const older = { runId: "d4", status: "ok", trigger: "scheduled", meetingAt: NOW - 86400e3, startedAt: NOW - 86700e3,
    model: "haiku", headline: "Yesterday's first sentence." };
  P.renderBriefs(data({ dailyBriefs: { [SITE]: [failed, okBrief({ runId: "e5" }), older] } }), NOW);
  const h = P.list();
  assert.match(h, /class="brief-status failed">The .+ brief failed — no online host of this org can write the brief/);
  assert.match(h, /Earlier briefs<span class="sum">2<\/span>/);
  assert.match(h, /Yesterday&#39;s first sentence\./);
});

test("XERK-2396: model-written text, host, model and org name are escaped", () => {
  const P = loadPage();
  const evil = "<img src=x onerror=alert(1)>";
  const d = data({
    agents: [{ org: SITE, jira: { siteKey: SITE, orgName: evil } }],
    dailyBriefs: { [SITE]: [okBrief({ day: evil, week: `"${evil}'`, next: evil, model: evil, host: evil }),
      { runId: "f6", status: "failed", meetingAt: NOW - 86400e3, startedAt: NOW - 86400e3, model: "haiku", error: evil }] },
  });
  P.renderBriefs(d, NOW);
  const h = P.list();
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // A hostile site key stays inert inside the data attributes too.
  const Q = loadPage();
  const key = `x"><script>alert(1)</script>`;
  Q.renderBriefs({ agents: [{ org: key }], dailyBriefs: { [key]: [okBrief()] }, dailyBriefSchedules: {} }, NOW);
  assert.doesNotMatch(Q.list(), /<script>/);
  assert.match(Q.list(), /data-run="x&quot;&gt;&lt;script&gt;/);
});

test("XERK-2396: an org with no host decided into it shows its briefs but no Run now or schedule", () => {
  const P = loadPage();
  P.renderBriefs(data({ agents: [] }), NOW);
  const h = P.list();
  assert.match(h, /PROJ-1 merged/);
  assert.doesNotMatch(h, /data-run=/);
  assert.doesNotMatch(h, /data-sched/);
});

test("XERK-2396: Copy puts the sections on the clipboard as plain text", async () => {
  const P = loadPage();
  assert.equal(P.briefText(okBrief()),
    "Since yesterday · still open\nPROJ-1 merged. PROJ-2 is still open.\n\nThis week\nFive tickets closed.\n\nUp next\nPROJ-3 is next.");
});

test("XERK-2396: the schedule editor defaults to the viewer's zone and weekdays, and saves the whole schedule", async () => {
  const schedule = { enabled: true, time: "09:30", timeZone: "America/New_York", weekdays: [1, 2, 3, 4, 5],
    leadMinutes: 5, model: "auto", updatedAt: 1 };
  const next = { runAt: NOW + 3600e3, meetingAt: NOW + 3900e3 };
  const P = loadPage((url, init) => (init.method === "PUT"
    ? { ok: true, schedule: { ...schedule, time: "10:00", model: "sonnet", weekdays: [1, 3] }, next }
    : { ok: true, schedule: null, next: null }));
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  assert.match(P.list(), /data-sched-toggle="acme\.atlassian\.net" aria-expanded="false"/);
  assert.doesNotMatch(P.list(), /data-sched=/, "the schedule hides behind its gear");
  P.schedOpen.add(SITE);
  P.renderBriefs(d, NOW);
  assert.match(P.list(), /aria-expanded="true"/);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.match(P.list(), new RegExp(`<option value="${zone.replace("/", "\\/")}" selected>`));
  assert.match(P.list(), /value="1" checked>Mon/);
  assert.doesNotMatch(P.list(), /value="0" checked>Sun/);
  assert.match(P.list(), /No schedule yet/);

  const form = { dataset: { sched: SITE } };
  const field = (f, value, checked) => ({ dataset: { f }, value, checked, closest: () => form });
  P.editField(SITE, field("time", "10:00"));
  P.editField(SITE, field("model", "sonnet"));
  P.editField(SITE, field("weekdays", "2", false));
  P.editField(SITE, field("weekdays", "4", false));
  P.editField(SITE, field("weekdays", "5", false));
  P.editField(SITE, field("leadMinutes", "7"));
  P.editField(SITE, field("timeZone", "America/New_York"));
  await P.saveSchedule(SITE);
  const put = P.fetches.find((f) => f.method === "PUT");
  assert.equal(put.url, `/api/orgs/${encodeURIComponent(SITE)}/daily-brief/schedule`);
  assert.deepEqual(put.body, { enabled: true, time: "10:00", timeZone: "America/New_York", weekdays: [1, 3],
    leadMinutes: 7, model: "sonnet" });
  assert.equal(P.drafts.has(SITE), false, "a saved draft is cleared");
  const h = P.list();
  assert.match(h, /Mon, Wed at 10:00 America\/New_York/);
  assert.match(h, /Next brief: <b>/);
  assert.match(h, /value="10:00"/);
});

test("XERK-2396: a refused save keeps the draft and shows the hub's words", async () => {
  const P = loadPage((url, init) => (init.method === "PUT"
    ? { status: 400, body: { error: "weekdays must list at least one day, 0 (Sunday) to 6 (Saturday)" } }
    : { ok: true, schedule: null, next: null }));
  const d = data();
  P.setCache(d);
  P.schedOpen.add(SITE);
  P.renderBriefs(d, NOW);
  const form = { dataset: { sched: SITE } };
  for (const i of ["1", "2", "3", "4", "5"]) P.editField(SITE, { dataset: { f: "weekdays" }, value: i, checked: false, closest: () => form });
  await P.saveSchedule(SITE);
  assert.equal(P.drafts.has(SITE), true);
  assert.match(P.list(), /class="sched-err">Saving the schedule failed — weekdays must list at least one day/);
  assert.equal(P.toasts.length, 1);
});

test("XERK-2396: the next run comes from the hub's schedule route and is refetched when the schedule changes", async () => {
  const next = { runAt: NOW + 3600e3, meetingAt: NOW + 3900e3 };
  const P = loadPage(() => ({ ok: true, schedule: {}, next }));
  const schedule = { enabled: true, time: "09:30", timeZone: "UTC", weekdays: [1], leadMinutes: 5, model: "auto", updatedAt: 1 };
  const d = data({ dailyBriefSchedules: { [SITE]: schedule } });
  P.setCache(d);
  P.schedOpen.add(SITE);
  P.renderBriefs(d, NOW);
  await P.settle();
  const gets = () => P.fetches.filter((f) => f.method === "GET" && f.url.endsWith("/daily-brief/schedule")).length;
  assert.equal(gets(), 1);
  assert.match(P.list(), /Next brief: <b>/);
  P.renderBriefs(d, NOW);
  await P.settle();
  assert.equal(gets(), 1, "an unchanged schedule is not refetched");
  d.dailyBriefSchedules = { [SITE]: { ...schedule, time: "10:00", updatedAt: 2 } };
  P.renderBriefs(d, NOW);
  await P.settle();
  assert.equal(gets(), 2);
  // A disabled schedule says so rather than naming a run.
  d.dailyBriefSchedules = { [SITE]: { ...schedule, enabled: false } };
  P.renderBriefs(d, NOW);
  assert.match(P.list(), /Off — no brief is scheduled\./);
});

test("XERK-2396: Run now posts, shows the started run, and shows a refusal in the hub's words", async () => {
  const started = { runId: "aa", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "k8x-01" };
  const P = loadPage((url, init) => (init.method === "POST" ? { ok: true, brief: started } : { ok: true, schedule: null, next: null }));
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  await P.runNow(SITE);
  const post = P.fetches.find((f) => f.method === "POST");
  assert.equal(post.url, `/api/orgs/${encodeURIComponent(SITE)}/daily-brief/run`);
  assert.equal(P.getCache().dailyBriefs[SITE][0].runId, "aa");
  assert.match(P.list(), /Writing a brief on k8x-01/);

  const R = loadPage((url, init) => (init.method === "POST"
    ? { status: 429, body: { error: "a brief was just asked for — try again in 42s" } }
    : { ok: true, schedule: null, next: null }));
  const d2 = data();
  R.setCache(d2);
  R.renderBriefs(d2, NOW);
  await R.runNow(SITE);
  assert.match(R.list(), /class="brief-status failed">Run now failed — a brief was just asked for — try again in 42s/);
  assert.deepEqual(R.toasts, ["Run now failed — a brief was just asked for — try again in 42s"]);
});

test("XERK-2396: no org yet says so", () => {
  const P = loadPage();
  P.renderBriefs({ agents: [], dailyBriefs: {}, dailyBriefSchedules: {} }, NOW);
  assert.match(P.list(), /No org yet/);
});

test("XERK-2396: a background repaint waits while a schedule field has focus; the viewer's own action paints", async () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.schedOpen.add(SITE);
  P.renderBriefs(d, NOW);
  const before = P.list();
  P.document.activeElement = { tagName: "SELECT", inside: true, dataset: { f: "model" }, closest: () => ({ dataset: { sched: SITE } }) };
  d.dailyBriefs = { [SITE]: [okBrief({ day: "A newer brief." })] };
  P.renderBriefs(d, NOW);
  assert.equal(P.list(), before, "held while the select has focus");
  P.renderBriefs(d, NOW, true);
  assert.match(P.list(), /A newer brief\./, "an action's paint is not held");
});

test("XERK-2396: a repaint waits out a pointer press in the list, then paints after the click", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  for (const fn of P.els.briefList.listeners.pointerdown) fn({});
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Landed mid-press." })] };
  P.renderBriefs(d, NOW);
  assert.doesNotMatch(P.list(), /Landed mid-press/, "no swap between mousedown and mouseup");
  P.renderBriefs(d, NOW, true);
  assert.doesNotMatch(P.list(), /Landed mid-press/, "not even a forced paint (a Save answer landing mid-press)");
  for (const fn of P.winListeners.pointerup) fn({});
  P.runTimers();
  assert.match(P.list(), /Landed mid-press/);
});

test("XERK-2396: a repaint keeps keyboard focus on the button it was on", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  let focused = 0;
  const fresh = { dataset: { run: SITE }, focus: () => { focused++; } };
  P.els.briefList.querySelectorAll = (sel) => (sel === "button" ? [{ dataset: { copy: SITE } }, fresh] : []);
  P.document.activeElement = { tagName: "BUTTON", inside: true, dataset: { run: SITE } };
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Changed." })] };
  P.renderBriefs(d, NOW);
  assert.equal(focused, 1);
});

test("XERK-2396: a failed next-run lookup backs off instead of re-asking every repaint", async () => {
  const P = loadPage(() => new Error("network down"));
  const schedule = { enabled: true, time: "09:30", timeZone: "UTC", weekdays: [1], leadMinutes: 5, model: "auto", updatedAt: 1 };
  const d = data({ dailyBriefSchedules: { [SITE]: schedule } });
  P.setCache(d);
  for (let i = 0; i < 5; i++) { P.renderBriefs(d, Date.now()); await P.settle(); }
  assert.equal(P.fetches.filter((f) => f.url.endsWith("/daily-brief/schedule")).length, 1);
  // A minute on, it asks again.
  P.renderBriefs(d, Date.now() + 61000);
  await P.settle();
  assert.equal(P.fetches.filter((f) => f.url.endsWith("/daily-brief/schedule")).length, 2);
});

test("XERK-2396: a Run now refusal gives way once the org's runs move on", async () => {
  const P = loadPage((url, init) => (init.method === "POST"
    ? { status: 429, body: { error: "a brief was just asked for — try again in 59s" } } : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  await P.runNow(SITE);
  assert.match(P.list(), /try again in 59s/);
  const running = { runId: "zz", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "k8x-09" };
  P.fire("dailyBriefs", { [SITE]: [running, okBrief()] });
  assert.doesNotMatch(P.list(), /try again/);
  assert.match(P.list(), /Writing a brief on k8x-09/);
});

test("XERK-2396: Run now pressed twice sends one request", async () => {
  const releases = [];
  const P = loadPage((url, init) => (init.method === "POST" ? new Promise((r) => { releases.push(r); }) : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  const a = P.runNow(SITE);
  const b = P.runNow(SITE);
  // Release every request sent, so a broken guard fails the count, never hangs.
  for (const r of releases) r({ ok: true, brief: { runId: "q1", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "h" } });
  await Promise.all([a, b]);
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, 1);
});

test("XERK-2396: the running status line escapes its host", () => {
  const P = loadPage();
  const running = { runId: "r9", status: "running", trigger: "scheduled", meetingAt: NOW, startedAt: NOW, model: "haiku",
    host: "<img src=x onerror=alert(1)>" };
  P.renderBriefs(data({ dailyBriefs: { [SITE]: [running] } }), NOW);
  assert.doesNotMatch(P.list(), /<img/);
  assert.match(P.list(), /on &lt;img/);
});

test("XERK-2396: an SSE frame landing while /api/agents is in flight is not overwritten by the older body", async () => {
  let release;
  const P = loadPage(null, () => new Promise((r) => { release = r; }));
  await P.settle();
  P.setCache(data());
  P.fire("dailyBriefs", { [SITE]: [okBrief({ day: "From the frame." })] });
  release(data({ dailyBriefs: { [SITE]: [okBrief({ day: "From the older body." })] } }));
  await P.settle();
  assert.equal(P.getCache().dailyBriefs[SITE][0].day, "From the frame.");
});

test("XERK-2396: Run now for an org named __proto__ adds an own key, not a prototype", async () => {
  const started = { runId: "p1", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "h" };
  const P = loadPage((url, init) => (init.method === "POST" ? { ok: true, brief: started } : { ok: true, next: null }));
  const d = { agents: [{ org: "__proto__" }], dailyBriefs: JSON.parse("{}"), dailyBriefSchedules: {} };
  P.setCache(d);
  await P.runNow("__proto__");
  assert.deepEqual(Object.keys(P.getCache().dailyBriefs), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(P.getCache().dailyBriefs), Object.prototype);
  assert.match(P.list(), /Writing a brief on h/);
  assert.match(P.list(), /<h2 class="brief-name">__proto__<\/h2>/);
});

const fieldIn = (f, value, site = SITE) => ({ tagName: "INPUT", inside: true, dataset: { f }, value,
  closest: () => ({ dataset: { sched: site } }) });

test("XERK-2396: Save and the gear paint at once even with a field focused; the hub's answer does not swap a field", async () => {
  let release;
  const P = loadPage((url, init) => (init.method === "PUT" ? new Promise((r) => { release = r; }) : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.schedOpen.add(SITE);
  P.renderBriefs(d, NOW);
  P.document.activeElement = fieldIn("time", "09:00");
  const saving = P.saveSchedule(SITE);
  assert.match(P.list(), /Saving…/, "Save's own paint is not held by the focused field");
  const during = P.list();
  release({ ok: true, schedule: { enabled: true, time: "09:00", timeZone: "UTC", weekdays: [1], leadMinutes: 5, model: "auto" }, next: null });
  await saving;
  assert.equal(P.list(), during, "the answer waits while a field (maybe half-typed) has focus");
  P.document.activeElement = null;
  P.renderBriefs(d, NOW);
  assert.doesNotMatch(P.list(), /Saving…/);

  // The gear, clicked with a field focused, opens/closes at once.
  const Q = loadPage();
  Q.setCache(d);
  Q.renderBriefs(d, NOW);
  Q.document.activeElement = fieldIn("time", "09:00");
  const gear = { dataset: { schedToggle: SITE } };
  for (const fn of Q.els.briefList.listeners.click) fn({ target: { closest: () => gear } });
  assert.match(Q.list(), /aria-expanded="true"/);
});

test("XERK-2396: a repaint gives focus back to the same weekday box", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.schedOpen.add(SITE);
  P.renderBriefs(d, NOW);
  const hits = [];
  const box = (v) => ({ dataset: { f: "weekdays" }, value: v, closest: () => ({ dataset: { sched: SITE } }), focus: () => hits.push(v) });
  P.els.briefList.querySelectorAll = (sel) => (sel === "[data-f]" ? ["1", "2", "3"].map(box) : []);
  P.document.activeElement = fieldIn("weekdays", "3");
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Changed." })] };
  P.renderBriefs(d, NOW, true);
  assert.deepEqual(hits, ["3"]);
});
