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
// The page opens its stream once its first snapshot is in (XERK-2599, pinned in
// nav.test.js); these tests drive the stream beside an in-flight fetch, so the
// harness opens it at load as the page did before.
const script = blocks[blocks.length - 1][1].replace("\nrefresh().finally(connectSSE);\n", "\nrefresh();\nconnectSSE();\n");
// The page paints through the real triage module (XERK-2857), loaded first in
// the same sandbox; a spy records what the page hands it.
const meetingsScript = fs.readFileSync(path.join(__dirname, "..", "public", "meetings.js"), "utf8");

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
function loadPage(reply = null, agents = null, hash = "", { search = "", store = {} } = {}) {
  const els = {};
  let calendarRefetches = 0;
  const calendarOpts = [], calendarUpcoming = [], calendarReveals = [];
  const calendarActive = [];
  const viewButtons = ["calendar", "notes"].map((v) => {
    const b = makeEl();
    b.dataset.view = v;
    b.attrs = {};
    b.setAttribute = (k, val) => { b.attrs[k] = val; };
    return b;
  });
  const meetings = { mounted: null, updates: [], pending: 0 };
  const sse = [];
  const winListeners = {};
  const fetches = [];
  const toasts = [];
  const timers = [];
  const intervals = [];
  const clip = [];
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll(sel) { return sel === "[data-view]" ? viewButtons : []; },
    addEventListener: noop, removeEventListener: noop,
    body: makeEl(), documentElement: makeEl(), activeElement: null,
  };
  const stubs = {
    document,
    location: { href: "", search, pathname: "/brief", hash },
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
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: noop,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: noop,
    addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); }, removeEventListener: noop,
    window: { name: "the window" },
    console, Date, Math, JSON, Intl, encodeURIComponent, Number, String, Object, Array, Map, Set,
    TurmaNav: { preserveScroll: (el, paint) => paint(), toast: (m) => toasts.push(m),
      refusalText: (what, status, body) => {
        const why = (body && typeof body.error === "string" && body.error) || `the hub answered HTTP ${status}`;
        return what ? `${what} failed — ${why}` : why;
      } },
    TurmaOrg: { getKeys: () => [], update: noop, subscribe: noop, sse: noop },
    TurmaBoard: { bareKey: require("../public/board.js").bareKey, orgName: (k, o) => o || k, mergeSites: (agents) => agents.map((a) => a.jira).filter(Boolean) },
    TurmaNewTicket: { update: noop },
    // The Calendar view (XERK-2897) has its own suite (calendar.test.js); here it only records.
    TurmaCalendar: { mount: (el, o) => { calendarOpts.push(o); }, update: noop, refetch: () => { calendarRefetches++; },
      setActive: (on) => { calendarActive.push(on); },
      upcoming: (site) => calendarUpcoming.filter((e) => e.org === site), reveal: (t) => { calendarReveals.push(t); } },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
  };
  const mkeys = Object.keys(stubs);
  new Function(...mkeys, meetingsScript)(...mkeys.map((k) => stubs[k]));
  const real = stubs.window.TurmaMeetings;
  stubs.TurmaMeetings = { ...real,
    mount: (el, h) => { meetings.mounted = el; real.mount(el, h); },
    update: (d, f) => { meetings.updates.push(d); real.update(d, f); } };
  const keys = Object.keys(stubs);
  const body = `${script}\n;return { render, renderBriefs, briefHtml, scheduleHtml, briefText, runNow, saveSchedule,
    editField, drafts, nextFor, runRefusal, setCache: (c) => { cache = c; }, getCache: () => cache };`;
  const api = new Function(...keys, body)(...keys.map((k) => stubs[k]));
  Object.assign(api, { openDrawer: real.openDrawer, setFilter: real.setFilter, select: real.select,
    entryKey: real.entryKey, mstate: real.state });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const runTimers = () => { for (const t of timers.splice(0)) t(); };
  const list = els.meetingList;
  // What a test puts "inside" the list: the focused element counts as inside.
  list.contains = (el) => !!el && el.inside === true;
  return Object.assign(api, { viewButtons, calendarActive, calendarOpts, calendarUpcoming, calendarReveals, store, calendarRefetches: () => calendarRefetches, intervals, meetings, els, fetches, toasts, clip, settle, runTimers, sse, winListeners, document, window: stubs.window,
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
  // The org's daily meeting is a rail entry under the org; selected, it heads the main pane.
  assert.match(h, /<span class="nm">Acme<\/span>/);
  assert.match(h, /class="tri-entry sel" data-entry="acme\.atlassian\.net\/d%3A\d+"[^>]*><span class="t">Daily meeting</);
  assert.match(h, /<h2 class="tri-title">Daily meeting<\/h2><span class="tri-sub">Acme · /);
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
  assert.match(h, /data-run="[^"]+" aria-disabled="true"/, "Run now is off while one runs");
  assert.doesNotMatch(h, / disabled[ >]/, "never `disabled`: it drops keyboard focus");
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
  // An earlier day's brief is its own daily entry, listed under All.
  assert.doesNotMatch(h, /Yesterday&#39;s/);
  P.setFilter("all");
  assert.equal((P.list().match(/data-entry=/g) || []).length, 2);
  P.select(P.entryKey(SITE, `d:${NOW - 86400e3}`));
  assert.match(P.list(), /<p>Yesterday&#39;s first sentence\.<\/p>/);
  assert.doesNotMatch(P.list(), /data-run=/, "Run now lives on the current entry only");
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
  assert.match(P.list(), /data-org-settings="acme\.atlassian\.net" aria-expanded="false"/);
  assert.doesNotMatch(P.list(), /data-sched=/, "the schedule hides behind the org's gear");
  P.openDrawer(SITE);
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
    leadMinutes: 7, model: "sonnet", meetingTitle: "" });
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
  P.openDrawer(SITE);
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
  P.openDrawer(SITE);
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
  P.openDrawer(SITE);
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
  for (const fn of P.els.meetingList.listeners.pointerdown) fn({});
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
  P.els.meetingList.querySelectorAll = (sel) => (sel === "button" ? [{ dataset: { copy: SITE } }, fresh] : []);
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
  assert.match(P.list(), /<span class="nm">__proto__<\/span>/);
});

const fieldIn = (f, value, site = SITE) => ({ tagName: "INPUT", inside: true, dataset: { f }, value,
  closest: () => ({ dataset: { sched: site } }) });

// A stand-in for one org's rendered form: what patchSave touches.
function fakeForm(site) {
  const btn = { dataset: { schedSave: site }, aria: "false", textContent: "Save schedule",
    setAttribute(k, v) { if (k === "aria-disabled") this.aria = v; } };
  const form = { dataset: { sched: site }, btn, err: null,
    querySelector(sel) { return sel === "[data-sched-save]" ? btn : sel === ".sched-err" ? this.err : null; },
    insertBefore(el) { this.err = el; el.remove = () => { form.err = null; }; } };
  return form;
}

test("XERK-2396: Save's busy state and error reach the controls while a field holds focus, and the next Save is sent", async () => {
  const releases = [];
  const P = loadPage((url, init) => (init.method === "PUT" ? new Promise((r) => { releases.push(r); }) : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  const form = fakeForm(SITE);
  P.els.meetingList.querySelectorAll = (sel) => (sel === "[data-sched]" ? [form] : []);
  P.document.createElement = () => ({ className: "", textContent: "" });
  // An unsaved draft, so a success's repaint (draft dropped) would differ.
  P.drafts.set(SITE, { enabled: true, time: "09:00", timeZone: "UTC", weekdays: [1], leadMinutes: "7", model: "auto" });
  P.renderBriefs(d, NOW, true);
  P.document.activeElement = fieldIn("leadMinutes", "7");
  const listBefore = P.list();
  const first = P.saveSchedule(SITE);
  assert.deepEqual([form.btn.aria, form.btn.textContent], ["true", "Saving…"]);
  assert.equal(P.list(), listBefore, "no swap under the focused field");
  // A 400 comes back while the field still has focus.
  releases[0]({ ok: true, schedule: null, next: null });
  await first;
  assert.deepEqual([form.btn.aria, form.btn.textContent], ["false", "Save schedule"], "never left stuck");
  assert.equal(P.list(), listBefore, "the answer swaps nothing under a field that may hold a half-typed time");
  // The QA repro: the next Save is sent.
  const second = P.saveSchedule(SITE);
  assert.equal(P.fetches.filter((f) => f.method === "PUT").length, 2);
  releases[1]({ ok: true, schedule: null, next: null });
  await second;
});

test("XERK-2396: a refused Save shows its error on the form at once, focus in a field", async () => {
  const P = loadPage((url, init) => (init.method === "PUT" ? { status: 400, body: { error: "leadMinutes must be a whole number from 1 to 30" } } : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  const form = fakeForm(SITE);
  P.els.meetingList.querySelectorAll = (sel) => (sel === "[data-sched]" ? [form] : []);
  P.document.createElement = () => ({ className: "", textContent: "" });
  P.document.activeElement = fieldIn("leadMinutes", "99");
  await P.saveSchedule(SITE);
  assert.equal(form.err && form.err.textContent, "Saving the schedule failed — leadMinutes must be a whole number from 1 to 30");
  assert.equal(form.btn.aria, "false");
  // A later success clears that error on the form, focus still in the field.
  P.document.activeElement = fieldIn("leadMinutes", "9");
  await P.saveSchedule(SITE);
});

test("XERK-2396: Run now's button is disabled in flight and released after, whatever has focus", async () => {
  const releases = [];
  const P = loadPage((url, init) => (init.method === "POST" ? new Promise((r) => { releases.push(r); }) : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  const btn = { dataset: { run: SITE }, aria: "false", setAttribute(k, v) { if (k === "aria-disabled") this.aria = v; } };
  P.els.meetingList.querySelectorAll = (sel) => (sel === "[data-run]" ? [btn] : []);
  const run = P.runNow(SITE);
  assert.equal(btn.aria, "true");
  P.document.activeElement = fieldIn("time", "09:00");
  releases[0]({ ok: true, brief: { runId: "q2", status: "ok", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "h", day: "Done." } });
  await run;
  assert.equal(btn.aria, "false");
});

test("XERK-2396: the gear and Discard paint at once even with a field focused", () => {
  const d = data();
  const Q = loadPage();
  Q.setCache(d);
  Q.renderBriefs(d, NOW);
  Q.document.activeElement = fieldIn("time", "09:00");
  const gear = { dataset: { orgSettings: SITE } };
  for (const fn of Q.els.meetingList.listeners.click) fn({ target: { closest: () => gear } });
  assert.match(Q.list(), /aria-expanded="true"/);
  Q.drafts.set(SITE, { enabled: true, time: "11:11", timeZone: "UTC", weekdays: [1], leadMinutes: 5, model: "auto" });
  Q.renderBriefs(d, NOW, true);
  assert.match(Q.list(), /value="11:11"/);
  const discard = { dataset: { schedReset: SITE } };
  for (const fn of Q.els.meetingList.listeners.click) fn({ target: { closest: () => discard } });
  assert.doesNotMatch(Q.list(), /value="11:11"/);
});

test("XERK-2396: a repaint gives focus back to the same weekday box", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  const hits = [];
  const box = (v) => ({ dataset: { f: "weekdays" }, value: v, closest: () => ({ dataset: { sched: SITE } }), focus: () => hits.push(v) });
  P.els.meetingList.querySelectorAll = (sel) => (sel === "[data-f]" ? ["1", "2", "3"].map(box) : []);
  P.document.activeElement = fieldIn("weekdays", "3");
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Changed." })] };
  P.renderBriefs(d, NOW, true);
  assert.deepEqual(hits, ["3"]);
});

test("XERK-2396: a successful Save takes a shown error off the form at once", async () => {
  let fail = true;
  const P = loadPage((url, init) => (init.method === "PUT"
    ? (fail ? { status: 400, body: { error: "bad" } } : { ok: true, schedule: null, next: null }) : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  const form = fakeForm(SITE);
  P.els.meetingList.querySelectorAll = (sel) => (sel === "[data-sched]" ? [form] : []);
  P.document.createElement = () => ({ className: "", textContent: "" });
  P.document.activeElement = fieldIn("leadMinutes", "9");
  await P.saveSchedule(SITE);
  assert.ok(form.err);
  fail = false;
  await P.saveSchedule(SITE);
  assert.equal(form.err, null);
});

test("XERK-2396: Run now's answer keeps the button off while the org's run is running, and swaps no focused field", async () => {
  const P = loadPage((url, init) => (init.method === "POST"
    ? { ok: true, brief: { runId: "q3", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "h" } }
    : { ok: true, next: null }));
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  const before = P.list();
  const btn = { dataset: { run: SITE }, aria: "false", setAttribute(k, v) { if (k === "aria-disabled") this.aria = v; } };
  P.els.meetingList.querySelectorAll = (sel) => (sel === "[data-run]" ? [btn] : []);
  P.document.activeElement = fieldIn("time", "09:00");
  await P.runNow(SITE);
  assert.equal(btn.aria, "true", "the run it started is running");
  assert.equal(P.list(), before, "the answer is a background paint");
});

test("XERK-2396: a press is released by the window losing focus, never by a field's blur", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  for (const fn of P.els.meetingList.listeners.pointerdown) fn({});
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Held." })] };
  P.renderBriefs(d, NOW);
  // The press blurred the focused field: still pressed.
  for (const fn of P.winListeners.blur || []) fn({ target: { tagName: "INPUT" } });
  P.runTimers();
  assert.doesNotMatch(P.list(), /Held\./);
  // A context menu ate the pointerup: released.
  for (const fn of P.winListeners.contextmenu) fn({});
  P.runTimers();
  assert.match(P.list(), /Held\./);
});

test("XERK-2396: the window losing focus mid-press releases it", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  for (const fn of P.els.meetingList.listeners.pointerdown) fn({});
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Held." })] };
  P.renderBriefs(d, NOW);
  for (const fn of P.winListeners.blur) fn({ target: P.window });
  P.runTimers();
  assert.match(P.list(), /Held\./);
});

test("XERK-2396: a repaint keeps keyboard focus on Save", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  let focused = 0;
  P.els.meetingList.querySelectorAll = (sel) => (sel === "button" ? [{ dataset: { schedSave: SITE }, focus: () => { focused++; } }] : []);
  P.document.activeElement = { tagName: "BUTTON", inside: true, dataset: { schedSave: SITE } };
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Changed." })] };
  P.renderBriefs(d, NOW);
  assert.equal(focused, 1);
});

test("XERK-2396: Save and Run now render aria-disabled, never disabled, and their guards refuse a second press", async () => {
  const releases = [];
  const P = loadPage((url, init) => (init.method === "GET" ? { ok: true, next: null } : new Promise((r) => { releases.push(r); })));
  const running = { runId: "r1", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW, model: "haiku", host: "h" };
  const d = data();
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  P.saveSchedule(SITE);
  P.saveSchedule(SITE);
  assert.equal(P.fetches.filter((f) => f.method === "PUT").length, 1, "schedBusy refuses a second submit");
  P.renderBriefs(d, NOW, true);
  assert.match(P.list(), /data-sched-save="[^"]+" aria-disabled="true">Saving…/);
  assert.doesNotMatch(P.list(), / disabled[ >]/);
  // An org whose run is already running: Run now sends nothing.
  d.dailyBriefs = { [SITE]: [running, okBrief()] };
  P.runNow(SITE); // not awaited: a broken guard's request never answers, and must fail, not hang
  assert.equal(P.fetches.filter((f) => f.method === "POST").length, 0);
  for (const r of releases) r({ ok: true, schedule: null, next: null });
});

test("XERK-2396: a cancelled press (a drag the browser took) releases the hold", () => {
  const P = loadPage();
  const d = data();
  P.setCache(d);
  P.renderBriefs(d, NOW);
  for (const fn of P.els.meetingList.listeners.pointerdown) fn({});
  d.dailyBriefs = { [SITE]: [okBrief({ day: "Held." })] };
  P.renderBriefs(d, NOW);
  for (const fn of P.winListeners.pointercancel) fn({});
  P.runTimers();
  assert.match(P.list(), /Held\./);
});

test("XERK-2857: the triage is mounted once on the page's list, fed every snapshot and frame, whatever the hash", async () => {
  for (const hash of ["", "#brief", "#meetings"]) {
    const P = loadPage(null, () => data({ meetingProposals: { [SITE]: [{ meetingId: "m1", status: "ok", title: "Sync", items: [] }] } }), hash);
    assert.equal(P.meetings.mounted, P.els.meetingList);
    await P.settle();
    assert.equal(P.meetings.updates.length, 1, "the snapshot reaches the triage");
    assert.match(P.list(), /Sync|Daily meeting/);
    P.fire("meetingProposals", { [SITE]: [] });
    assert.deepEqual(P.meetings.updates.at(-1).meetingProposals, { [SITE]: [] });
  }
});

const DAY = 86400e3;
const mtg = (over = {}) => ({ meetingId: "m1", status: "ok", title: "Standup", startedAt: NOW + 60e3, endedAt: NOW + 900e3,
  items: [{ id: "p1", kind: "task", title: "Ship the <thing>", description: "" }], ...over });

test("XERK-2857: a daily meeting pairs with its brief: one entry per meetingAt, brief on top, proposals below", () => {
  const P = loadPage();
  const yBrief = okBrief({ runId: "y1", meetingAt: NOW - DAY, startedAt: NOW - DAY - 300e3, day: "Yesterday's brief." });
  const lone = okBrief({ runId: "l1", meetingAt: NOW - 2 * DAY, startedAt: NOW - 2 * DAY - 300e3, day: "A brief with no meeting." });
  const d = data({
    dailyBriefs: { [SITE]: [okBrief(), yBrief, lone] },
    meetingProposals: { [SITE]: [
      mtg({ daily: { meetingAt: NOW, briefRunId: "a1" } }),
      // The 24h fallback: linked by runId though its brief named another instant.
      mtg({ meetingId: "m2", title: "Late standup", startedAt: NOW - DAY + 7200e3, daily: { meetingAt: NOW - DAY + 7200e3, briefRunId: "y1" } }),
      mtg({ meetingId: "m3", title: "Client <call>", startedAt: NOW - 3600e3 }),
    ] },
  });
  P.setCache(d);
  P.renderBriefs(d, NOW);
  P.setFilter("all");
  const h = P.list();
  // Today's daily entry, yesterday's linked one, the lone brief, and the client call: four entries.
  assert.equal((h.match(/data-entry=/g) || []).length, 4);
  assert.equal((h.match(/<span class="t">Daily meeting</g) || []).length, 3, "no separate entry for a linked brief's own meetingAt");
  assert.match(h, /<span class="t">Client &lt;call&gt;</);
  P.select(P.entryKey(SITE, `d:${NOW}`));
  const today = P.list();
  assert.match(today, /PROJ-1 merged/);
  assert.match(today, /<h3 class="tri-h">Proposals<\/h3>[\s\S]*Ship the &lt;thing&gt;/);
  assert.ok(today.indexOf("PROJ-1 merged") < today.indexOf("Ship the &lt;thing&gt;"), "the brief sits above the proposals");
  P.select(P.entryKey(SITE, `d:${NOW - DAY + 7200e3}`));
  assert.match(P.list(), /Yesterday&#39;s brief\./);
  assert.match(P.list(), /Late standup/);
  P.select(P.entryKey(SITE, `d:${NOW - 2 * DAY}`));
  assert.match(P.list(), /A brief with no meeting\./);
  assert.match(P.list(), /No meeting was captured for this one\./);
});

test("XERK-2857: a hub without `daily` degrades to a meeting entry and a brief entry", () => {
  const P = loadPage();
  const d = data({ meetingProposals: { [SITE]: [mtg()] } });
  P.setCache(d);
  P.renderBriefs(d, NOW);
  const h = P.list();
  assert.match(h, /<span class="t">Daily meeting</);
  assert.match(h, /<span class="t">Standup</);
});

test("XERK-2857: the upcoming daily meeting comes from the hub's next run and says when its brief is written", async () => {
  const schedule = { enabled: true, time: "09:30", timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], leadMinutes: 5, model: "auto", updatedAt: 1 };
  const next = { runAt: NOW + DAY - 300e3, meetingAt: NOW + DAY };
  const P = loadPage(() => ({ ok: true, schedule, next }));
  const d = data({ dailyBriefs: {}, dailyBriefSchedules: { [SITE]: schedule } });
  P.setCache(d);
  P.renderBriefs(d, NOW);
  await P.settle();
  P.renderBriefs(d, NOW); // the lookup's own repaint ran at the wall clock
  const h = P.list();
  assert.match(h, /<div class="tri-sec">Upcoming<\/div>/);
  assert.match(h, /data-entry="acme\.atlassian\.net\/d%3A\d+"[^>]*>.*?brief /);
  assert.match(h, /The brief is written /);
  assert.match(h, /data-run="acme\.atlassian\.net"/, "Run now on the upcoming entry");
  // A disabled schedule names no upcoming meeting.
  d.dailyBriefSchedules = { [SITE]: { ...schedule, enabled: false } };
  P.renderBriefs(d, NOW);
  assert.doesNotMatch(P.list(), /The brief is written/);
});

test("XERK-2857: the drawer's daily meeting title is escaped, kept as a draft and saved with the schedule", async () => {
  const stored = { enabled: true, time: "09:00", timeZone: "UTC", weekdays: [1], leadMinutes: 5, model: "auto",
    meetingTitle: `"><img src=x onerror=alert(1)>` };
  const P = loadPage((url, init) => (init.method === "PUT" ? { ok: true, schedule: { ...stored, meetingTitle: "standup" }, next: null }
    : { ok: true, schedule: stored, next: null }));
  const d = data({ dailyBriefSchedules: { [SITE]: stored } });
  P.setCache(d);
  P.openDrawer(SITE);
  P.renderBriefs(d, NOW);
  const h = P.list();
  assert.match(h, /role="dialog" aria-label="Meeting settings for Acme"/);
  assert.match(h, /data-f="meetingTitle"[^>]*value="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.doesNotMatch(h, /<img/);
  const form = { dataset: { sched: SITE } };
  P.editField(SITE, { dataset: { f: "meetingTitle" }, value: "  standup ", closest: () => form });
  await P.saveSchedule(SITE);
  assert.equal(P.fetches.find((f) => f.method === "PUT").body.meetingTitle, "standup");
});

test("XERK-2623: a snapshot that left before a meetingProposals frame keeps the frame's map", async () => {
  // XERK-444 merge clock: a /api/agents body is older than an SSE frame that lands while it is in flight.
  let release;
  let n = 0;
  const P = loadPage(null, () => (++n === 1
    ? data({ meetingProposals: { [SITE]: [{ meetingId: "old" }] } })
    : new Promise((r) => { release = r; })));
  await P.settle();
  P.sse[0].onopen(); P.sse[0].onopen();           // a reconnect re-reads the snapshot
  await P.settle();
  P.fire("meetingProposals", { [SITE]: [{ meetingId: "fresh" }] });
  release(data({ meetingProposals: { [SITE]: [{ meetingId: "stale" }] } }));
  await P.settle();
  assert.deepEqual(P.getCache().meetingProposals, { [SITE]: [{ meetingId: "fresh" }] });
  assert.equal(P.meetings.updates.at(-1).meetingProposals[SITE][0].meetingId, "fresh");
});

// XERK-2634: the brief's host is a registry key, tenant-suffixed after the
// tenancy migration; both the running line and the meta print the device alone.
test("a brief written on a tenant host names the host without the tenant", () => {
  const P = loadPage();
  const host = "k8x-02@77778a16d8b028aab55c7729d587dbd7";
  const running = { runId: "b2", status: "running", trigger: "manual", meetingAt: NOW, startedAt: NOW - 120e3,
    model: "haiku", host };
  P.renderBriefs(data({ dailyBriefs: { [SITE]: [running, okBrief({ host })] } }), NOW);
  const h = P.list();
  assert.match(h, /Writing a brief on k8x-02… started/);
  assert.match(h, /on k8x-02</);
  assert.doesNotMatch(h, /77778a16/);
});

test("XERK-2897: the Calendar / Notes review switch shows one view, remembers the pick, and a push link opens the notes", () => {
  const P = loadPage();
  // First visit: the calendar.
  assert.equal(P.els.calendarView.hidden, false);
  assert.equal(P.els.meetingList.hidden, true);
  assert.equal(P.els.notesNote.hidden, true);
  assert.deepEqual(P.calendarActive, [true]);
  assert.equal(P.viewButtons[0].attrs["aria-pressed"], "true");
  // Picking Notes review swaps the panes, stops the calendar and is remembered.
  P.viewButtons[1].listeners.click[0]();
  assert.equal(P.els.calendarView.hidden, true);
  assert.equal(P.els.meetingList.hidden, false);
  assert.equal(P.els.notesNote.hidden, false);
  assert.deepEqual(P.calendarActive, [true, false]);
  assert.equal(P.store["turma-meetings-view"], "notes");
  assert.equal(P.viewButtons[1].attrs["aria-pressed"], "true");
  // The next visit opens on it.
  assert.equal(loadPage(null, null, "", { store: { "turma-meetings-view": "notes" } }).els.meetingList.hidden, false);
  // A proposals push (`/meetings?site=…`) opens the notes review whatever was picked.
  const pushed = loadPage(null, null, "", { search: `?site=${SITE}`, store: { "turma-meetings-view": "calendar" } });
  assert.equal(pushed.els.meetingList.hidden, false);
  // Unusable storage falls back to the calendar.
  assert.equal(loadPage(null, null, "", { store: { "turma-meetings-view": "bogus" } }).els.calendarView.hidden, false);
});

test("XERK-2897: calendar, holidaySettings and meetingProposals frames re-read the calendar once per burst", async () => {
  const P = loadPage(null, () => data({}));
  await P.settle();
  P.runTimers();
  P.fire("calendar", { h1: { syncedAt: 1 } });
  P.fire("holidaySettings", {});
  P.fire("meetingProposals", {});                  // a Tenir capture is announced only here
  assert.equal(P.calendarRefetches(), 0, "coalesced");
  P.runTimers();
  assert.equal(P.calendarRefetches(), 1);
  P.fire("meetingProposals", {});
  P.runTimers();
  assert.equal(P.calendarRefetches(), 2);
});

test("XERK-2921: an agent frame re-reads the calendar only when the host's online flips", async () => {
  const P = loadPage(null, () => data({}));
  await P.settle();
  P.runTimers();
  P.fire("agent", { key: "h1", online: true });    // first sight, nothing to compare
  P.fire("agent", { key: "h1", online: true });    // a beat: no flip
  P.runTimers();
  assert.equal(P.calendarRefetches(), 0, "a beat is not a flip");
  P.fire("agent", { key: "h1", online: false });   // the offline sweep's frame
  P.runTimers();
  assert.equal(P.calendarRefetches(), 1, "offline re-reads, so the notice appears");
  P.fire("agent", { key: "h1", online: true });
  P.runTimers();
  assert.equal(P.calendarRefetches(), 2, "back online re-reads too");
  P.fire("agent", { key: "h2" });                  // no online flag: ignored
  P.fire("agent", { key: "h1", online: "false" }); // a non-boolean is not a flip
  P.fire("agent", "junk");
  P.sse[0].handlers.agent({ data: "{not json" });  // unparseable: ignored, no throw
  P.runTimers();
  assert.equal(P.calendarRefetches(), 2);
});

test("XERK-2921: a host's first agent frame compares against the snapshot's online", async () => {
  const P = loadPage(null, () => data({ agents: [{ key: "h1", online: true }] }));
  await P.settle();
  P.runTimers();
  P.fire("agent", { key: "h1", online: false });   // first frame, but the snapshot said online
  P.runTimers();
  assert.equal(P.calendarRefetches(), 1);
});

test("XERK-2897: a stream reconnect re-reads the calendar (frames missed while down)", async () => {
  const P = loadPage(null, () => data({}));
  await P.settle();
  P.sse[0].onopen();
  assert.equal(P.calendarRefetches(), 0, "the first open is not a reconnect");
  P.sse[0].onopen();
  assert.equal(P.calendarRefetches(), 1);
});

test("XERK-2897: with the stream down the calendar polls every 60s; up, it does not", async () => {
  const P = loadPage(null, () => data({}));
  await P.settle();
  const polls = () => { for (const i of P.intervals.filter((x) => x.ms === 60000)) i.fn(); };
  P.sse[0].onopen();
  polls();
  assert.equal(P.calendarRefetches(), 0, "stream up: frames carry the changes");
  P.sse[0].onerror();
  polls();
  assert.equal(P.calendarRefetches(), 1);
});
