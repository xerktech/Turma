// Unit tests for the Sessions page sidebar render (public/sessions.html): the
// running-session split into Active (waiting/working) vs Idle (auto-demoted),
// the Idle-hidden-when-empty rule, and the Active empty-state messaging.
// node:test, no npm — matches this package's zero-dependency stance. There's no
// jsdom here, so we load the page's real inline <script> into a minimal DOM
// shim and drive its render() with fabricated heartbeat data, asserting on the
// #active / #idle / #stopped innerHTML it produces.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "sessions.html"), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// The page reads window.TurmaBoard.orgColorMap for the org card tint (XERK-142),
// loaded by board.html alongside sessions.html; require the real module so the
// tint the cards carry is the same one the board paints.
const TurmaBoard = require("../public/board.js");
// The terminal compose bar words a failed send through the chat engine, so the
// two bars can't disagree (XERK-227) — use the real functions, not a stub.
const TurmaChatCore = require("../public/chat.js");
// The chrome's toast + refusal wording (XERK-264) is shared with the dashboard,
// so the page is driven against the real module rather than a re-typed copy.
const TurmaNavCore = require("../public/nav.js");

// --- minimal DOM shim --------------------------------------------------------
function makeEl(id) {
  const el = {
    id, _html: "", textContent: "", value: "", hidden: false,
    style: {}, dataset: {}, children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f == null ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    // `focused` records the last focus() call, which is how the draft-carry
    // tests observe that the box you can now see is the one taking keystrokes.
    closest() { return null; }, focus() { this.focused = true; }, blur() { this.focused = false; },
    select() {}, setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; },
    scrollIntoView() {}, remove() {},
  };
  // `_onHtml` lets a test model what the real browser does around an innerHTML
  // swap — chiefly clamping an ancestor's scrollTop while the panel is empty.
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = String(v); if (this._onHtml) this._onHtml(); },
  });
  return el;
}

// Build a fresh sandbox per test so state (cache, section innerHTML) never leaks.
// `search` seeds the page's query string (the ?session=/?spawn= deep links,
// read once at load); `opened` collects the sessions TurmaChat.open() is asked
// to put on the stage, which is how the select-on-arrival tests observe it;
// `posts` collects the {url, body} of every command the page fires, which is how
// the card-menu tests observe kill/rename.
// `sidebar` opts in to a stand-in for the real scrolling <aside class="sidebar">,
// which the shim's null-returning querySelector otherwise hides from the page;
// `textareas` is what document.querySelectorAll(".composer textarea[data-rk]")
// finds, i.e. the composer boxes already on screen when a re-render starts.
// `postReply`: opt a test into POSTs that actually answer, with this as the JSON
// body. Off by default — a POST that never settles is what keeps the boot
// refresh() inert for every other test, and only the paths that correlate a
// reply (the cmdId a resumed transcript comes back under) need it.
// `postStatus`: the HTTP status those answers carry (200 unless a test wants a
// refusal, e.g. the hub's 413 for a message past its character cap).
function loadPage({ search = "", sidebar = null, textareas = [], postReply = null, postStatus = 200, narrow = false } = {}) {
  const els = {};
  const opened = [];
  const posts = [];
  const toasts = [];
  const chat = { busy: false, stopped: 0, failed: null, closed: 0, reconnected: 0, rendered: [] };
  // Window-level listeners the page registers (e.g. popstate), so a test can
  // drive the mobile back-button flow that `history.back()` triggers.
  const winListeners = {};
  // The EventSource(s) the page opens, plus `emit` to deliver one hub event to
  // every listener registered for it.
  const sse = {
    streams: [],
    emit(name, data) {
      const payload = { data: JSON.stringify(data) };
      for (const s of sse.streams) for (const fn of (s._ls[name] || [])) fn(payload);
    },
  };
  const document = {
    getElementById(id) { return (els[id] ||= makeEl(id)); },
    querySelector(sel) { return sel === ".sidebar" ? sidebar : null; },
    querySelectorAll(sel) { return sel.includes(".composer textarea") ? textareas : []; },
    createElement(tag) { return makeEl("<" + tag + ">"); },
    addEventListener() {}, removeEventListener() {},
    body: makeEl("body"), activeElement: null,
  };
  const gets = [];
  let getReply = null;
  const noop = () => {};
  const stubs = {
    document,
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    location: { href: "", search, pathname: "/sessions" },
    navigator: { userAgent: "node" },
    // Records what the page asks for and never resolves, so the boot refresh()
    // is inert and a command POST can't race a test's assertions.
    fetch: (url, init) => {
      if (init && init.method === "POST") {
        posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (postReply) return Promise.resolve({
          ok: postStatus < 400, status: postStatus, json: async () => postReply,
        });
      }
      if (!init || (init.method || "GET") === "GET") {
        gets.push(url);
        // `setGet` lets a test answer one specific GET (the subagent-history
        // poll, say) while every other read stays inert.
        const body = getReply && getReply(url);
        // A plain object is the 200 it always was; one carrying its own `json`
        // is a full response stub, which is how a test drives a REFUSAL (a 404
        // with a body) rather than only the happy path.
        if (body) return Promise.resolve(
          typeof body.json === "function" ? body : { ok: true, status: 200, json: async () => body });
      }
      return new Promise(() => {});
    },
    // Records the page's SSE listeners so a test can deliver a real hub event
    // (the fleet payload is only polled ONCE at load while the stream is
    // healthy, so an event is the only way some state ever moves).
    EventSource: class {
      constructor() { this._ls = {}; sse.streams.push(this); }
      addEventListener(name, fn) { (this._ls[name] ||= []).push(fn); }
      close() {}
      static get CLOSED() { return 2; }
    },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    // pushState/back mirror the browser closely enough to test the mobile stage:
    // enterStage() pushes a state, and backToList()'s history.back() fires the
    // page's popstate handler (which drops the showing-term view).
    history: { replaceState: noop, pushState: noop, back() { (winListeners.popstate || []).forEach((fn) => fn()); } },
    URL: global.URL, URLSearchParams: global.URLSearchParams,
    TurmaChat: {
      open: (hostKey, id) => opened.push(id),
      // `close` and `reconnectNow` are counted: the stage tears the chat down
      // when its session goes, and nudges it back when a flapped tunnel
      // returns (XERK-252) — both are observable only from here.
      close: () => { chat.closed++; },
      reconnectNow: () => { chat.reconnected++; },
      onPoll: noop, closeStatic: noop, repaint: noop,
      renderStatic: (o) => { chat.rendered.push(o); },
      // The chat engine owns the live busy read and the interrupt; the terminal's
      // compose button just defers to it. `busy` is what a test flips to model a
      // turn being in flight, and `stopped` records the delegation.
      isBusy: () => chat.busy, stop: () => { chat.stopped++; },
      actionFailed: (t) => { chat.failed = t; },
      sendFailure: TurmaChatCore.sendFailure, isTooLong: TurmaChatCore.isTooLong,
    },
    console, Date, Math, JSON, encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); }, removeEventListener: noop,
    matchMedia: () => ({ matches: narrow, addEventListener: noop }),
    // The header's org filter (org.js). Stubbed as the identity scope ("all
    // orgs") so these tests see every fabricated host; `setOrg` lets an
    // org-scoping test narrow it.
    TurmaOrg: { _k: "", get() { return this._k; }, filter(a) { return this._k ? (a || []).filter((x) => (x.jira && x.jira.siteKey) === this._k) : (a || []); }, update: noop, subscribe: noop, sse: noop, orgColors: () => ({}) },
    // The header's New-ticket control (newticket.js), fed the beat like the org
    // filter; stubbed inert here — the page just hands it the fleet.
    TurmaNewTicket: { update: noop },
    // The chrome's shared failure toast (nav.js, XERK-264) — the one surface a
    // refused command reaches the operator through, so `toasts` is how a test
    // observes that a refusal was reported at all. The real refusalText is
    // used, not a stand-in, so the wording under test is the shipped one.
    TurmaNav: { toast: (m) => toasts.push(m), refusalText: TurmaNavCore.refusalText },
    TurmaBoard,
    scrollTo: noop, innerWidth: 1200, innerHeight: 800,
  };
  const names = Object.keys(stubs);
  // The trailing return is ours, not the page's: it reaches into the module
  // scope for the handful of functions under test. setCache stands in for the
  // /api/agents fetch that normally fills `cache` before render() — the
  // select-on-arrival path reads it, so a bare render() isn't enough.
  const fn = new Function(...names, "window",
    script + "\n;return { render, selectSession, followSpawn, toggleComposer, startSession,"
      + " toggleCardMenu, cardKill, startRename, cancelRename, submitRename,"
      + " openMove, moveTo, closeMove,"
      + " showRestore, hideRestore, toggleRestoreMenu, restoreTo, eligibleRestoreTargets,"
      + " termComposeAction, termComposeStop, sendTermInput, openEndedSession, resumeEnded, openTranscript, backToList,"
      + " openSubagentView, transcriptBack,"
      + " chatToTerminal, terminalToChat, sessMeta, autoGrowTermInput, clearStage, prBadgeHtml,"
      + " setCache: (c) => { cache = c; }, setDraft: (t) => { renameDraft = t; } };");
  const api = fn(...names.map((k) => stubs[k]), stubs);
  // One heartbeat, as the page would see it.
  api.beat = (data) => { api.setCache(data); api.render(data); };
  return { ...api, els, opened, posts, toasts, chat, sse, gets, body: document.body,
    setGet: (fn) => { getReply = fn; },
    // `setOrg` narrows the header's org filter, the way picking an org in the
    // menu does — the sidebar lists only that org's hosts afterwards.
    setOrg: (k) => { stubs.TurmaOrg._k = k; } };
}
// The card's ⋯/menu buttons pass their click event on; the shim has no events.
const click = { stopPropagation() {} };

function host(sessions) {
  const now = Date.now();
  return {
    now,
    host: {
      key: "hostA", device: "hostA", online: true, terminalOnline: true,
      lastSeen: now, repos: [{ name: "repoX" }], sessions,
    },
  };
}
const running = (id, summary, session) => ({ id, status: "running", repo: "repoX", summary, session });
const working = (id, summary) => running(id, summary, { paneBusy: true, transcriptAgeSec: 3 });
const waiting = (id, summary) => running(id, summary, { question: "Pick one?", paneBusy: false, transcriptAgeSec: 5 });
const idle = (id, summary) => running(id, summary, { paneBusy: false, transcriptAgeSec: 800 });
// A session that finished its turn: quiet, and the newest transcript entry is
// plain assistant output with no tool call pending — the "research is done"
// signal a no-PR task leaves behind (XERK-224).
const finished = (id, summary, extra) => ({
  ...running(id, summary, { paneBusy: false, transcriptAgeSec: 800, lastRole: "assistant", lastHasToolUse: false }),
  ...extra,
});
const pr = (state, number = 7) => ({ url: `https://github.com/o/r/pull/${number}`, number, state });

// XERK-245. A session that launches a background agent ends its own turn right
// away: paneBusy goes false and the newest entry is plain assistant text with no
// tool call — so it landed under Ready for review, buzzing the operator, while
// the agent it delegated to was still working. The live agent list is what says
// otherwise, and the card names what is running instead of reading "idle".
test("background agents keep a session Active and name what is running", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    running("11111", "Delegating Task", {
      paneBusy: false, transcriptAgeSec: 5, lastRole: "assistant", lastHasToolUse: false,
      agents: [{ type: "qa", label: "QA the parity change" }],
    }),
  ]);
  render({ now, agents: [h] });

  assert.match(els.active.innerHTML, /Active <span class="count">1<\/span>/);
  assert.ok(els.active.innerHTML.includes("Delegating Task"));
  assert.ok(els.active.innerHTML.includes("1 background agent"),
    "the card says what is running, not a bare 'working'");
  assert.ok(!els.review.innerHTML.includes("Delegating Task"),
    "not ready for review while an agent it launched is still going");
});

test("background agents: the count is pluralized, and an empty list changes nothing", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    running("11111", "Fan Out", {
      paneBusy: false, transcriptAgeSec: 5,
      agents: [{ type: "qa", label: "QA it" }, { type: "Explore", label: "Map it" }],
    }),
    // An agent predating the field reports none: unchanged, still Idle.
    idle("22222", "Quiet Task"),
  ]);
  render({ now, agents: [h] });
  assert.ok(els.active.innerHTML.includes("2 background agents"));
  assert.ok(els.idle.innerHTML.includes("Quiet Task"));
});

test("running sessions split: working -> Active, quiet-with-nothing-pending -> Idle", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    working("11111", "Working Task"),
    idle("33333", "Idle Task A"),
    running("44444", "Idle Task B", { paneBusy: null, transcriptAgeSec: 9999 }), // stale transcript, unknown paneBusy -> idle
    { id: "55555", status: "stopped", repo: "repoX", summary: "Dead Task" },
  ]);
  render({ now, agents: [h] });

  const a = els.active.innerHTML;
  const i = els.idle.innerHTML;
  assert.match(a, /Active <span class="count">1<\/span>/);
  assert.ok(a.includes("Working Task"));
  assert.ok(!a.includes("Idle Task A") && !a.includes("Idle Task B"), "idle sessions must not appear under Active");

  assert.match(i, /Idle <span class="count">2<\/span>/);
  assert.ok(i.includes("Idle Task A") && i.includes("Idle Task B"));
  assert.ok(!i.includes("Working Task"), "working sessions must not appear under Idle");

  assert.equal(els.review.innerHTML, "", "Ready for review is hidden when nothing qualifies");
  assert.ok(els.ended.innerHTML.includes("Dead Task"), "ended section still renders");
});

// --- Ready for review (XERK-224) ---------------------------------------------
// The section between Active and Idle: work that has stopped and is waiting on
// the operator. Derived from the signals alone — no acknowledgement — so these
// pin down exactly which signals qualify, and the one that un-qualifies.

test("ready for review: question, open PR and a finished turn all qualify", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    working("11111", "Working Task"),
    waiting("22222", "Waiting Task"),
    finished("33333", "Research Task"),                          // no PR at all
    finished("44444", "PR Task", { prs: [pr("OPEN")] }),
    idle("55555", "Never Ran"),                                  // no transcript signal yet
  ]);
  render({ now, agents: [h] });

  const r = els.review.innerHTML;
  assert.match(r, /Ready for review <span class="count">3<\/span>/);
  assert.ok(r.includes("Waiting Task"), "a pending question is waiting on you");
  assert.ok(r.includes("Research Task"), "a finished turn with no PR still qualifies");
  assert.ok(r.includes("PR Task"), "an open PR qualifies");
  // A question is the most urgent, so it leads the section (collect()'s ranking
  // survives the filter).
  assert.ok(r.indexOf("Waiting Task") < r.indexOf("Research Task"), "waiting leads the section");

  assert.match(els.active.innerHTML, /Active <span class="count">1<\/span>/);
  assert.ok(els.active.innerHTML.includes("Working Task"));
  assert.ok(!els.active.innerHTML.includes("Waiting Task"), "a question moved out of Active");
  assert.match(els.idle.innerHTML, /Idle <span class="count">1<\/span>/);
  assert.ok(els.idle.innerHTML.includes("Never Ran"));
});

test("ready for review: a session whose every PR has landed drops back to Idle", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    finished("11111", "Merged Task", { prs: [pr("MERGED", 1)] }),
    finished("22222", "Closed Task", { prs: [pr("CLOSED", 2)] }),
    finished("33333", "Half Landed", { prs: [pr("MERGED", 3), pr("OPEN", 4)] }),
    finished("44444", "Unknown State", { prs: [pr("", 5)] }),
  ]);
  render({ now, agents: [h] });

  const r = els.review.innerHTML, i = els.idle.innerHTML;
  assert.ok(i.includes("Merged Task") && i.includes("Closed Task"),
    "a merged/closed PR IS the review — park it in Idle until the build is verified");
  assert.ok(r.includes("Half Landed"), "one PR still open keeps it up for review");
  assert.ok(r.includes("Unknown State"), "an unfetched PR state counts as live, never as landed");
  assert.ok(!r.includes("Merged Task"), "a landed session must not stay under review");
});

// A session is a CONVERSATION, not a pull request: the same one can be handed a
// new task after its PR merged. The demotion is therefore scoped in time — it
// holds only until the conversation moves past the landing (`newWorkSincePrs`).
test("ready for review: a new task on a merged-PR session is not hidden by that PR", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    finished("11111", "Follow-up", { prs: [pr("MERGED", 1)] }),
  ]);
  render({ now, agents: [h] });
  assert.ok(els.idle.innerHTML.includes("Follow-up"),
    "merged and nothing said since: parked in Idle until the build is verified");

  // The operator gives it a new task; it works, finishes, and opens no new PR.
  // Only the old merged one is on the record — which must not bury the result.
  const worked = { ...h, sessions: [{ ...h.sessions[0], newWorkSincePrs: true }] };
  render({ now, agents: [worked] });
  assert.ok(els.review.innerHTML.includes("Follow-up"),
    "new work after the merge belongs under Ready for review");
  assert.ok(!els.idle.innerHTML.includes("Follow-up"));
  // ...and it says so as a finished turn, since the landed PR is not the thing
  // awaiting review.
  assert.ok(els.review.innerHTML.includes("finished · awaiting review"));

  // A pending question always qualifies, whatever the PRs did.
  const asking = { ...h, sessions: [{ ...h.sessions[0], session: { ...h.sessions[0].session, question: "Ship it?" } }] };
  render({ now, agents: [asking] });
  assert.ok(els.review.innerHTML.includes("Follow-up"), "a question always needs you");
});

test("ready for review: an agent too old to report newWorkSincePrs keeps the old behaviour", () => {
  const { render, els } = loadPage();
  // No `newWorkSincePrs` key at all — the field is what expires the demotion,
  // so without it a landed PR still parks the session, as it did before.
  const { now, host: h } = host([finished("11111", "Legacy", { prs: [pr("MERGED", 1)] })]);
  render({ now, agents: [h] });
  assert.ok(els.idle.innerHTML.includes("Legacy"));
  assert.equal(els.review.innerHTML, "");
});

test("ready for review: an unlanded PR wins before the new-work question is asked", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    // Still open: a diff to read, regardless of what the transcript did since.
    running("11111", "Open PR", { paneBusy: false, transcriptAgeSec: 900, lastRole: "user" },
      ),
  ]);
  h.sessions[0].prs = [pr("MERGED", 1), pr("OPEN", 2)];
  render({ now, agents: [h] });
  assert.ok(els.review.innerHTML.includes("Open PR"));
  assert.ok(els.review.innerHTML.includes("PR awaiting review"));
});

test("ready for review: a card says why it is there instead of a bare 'idle'", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    finished("11111", "Research Task"),
    finished("22222", "PR Task", { prs: [pr("OPEN")] }),
  ]);
  render({ now, agents: [h] });

  const r = els.review.innerHTML;
  assert.ok(r.includes(`<div class="state review">PR awaiting review</div>`), "an open PR says so");
  assert.ok(r.includes(`<div class="state review">finished · awaiting review</div>`), "a no-PR task says so");
  assert.ok(r.includes(`<span class="dot review">`), "and takes the accent dot, not the muted idle one");
});

test("ready for review: the header count and the Active empty state point at it", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([finished("11111", "Research Task"), waiting("22222", "Waiting Task")]);
  render({ now, agents: [h] });

  assert.equal(els.hdrMeta.textContent, "2 running · 1 waiting on you · 2 ready for review");
  assert.match(els.active.innerHTML, /No active sessions\. See Ready for review above\./);
});

test("session cards carry their host's org tint as --org (XERK-142)", () => {
  const { render, els } = loadPage();
  const now = Date.now();
  const jira = { siteKey: "org.atlassian.net" };
  const withOrg = {
    key: "hostA", device: "hostA", online: true, terminalOnline: true,
    lastSeen: now, jira, repos: [{ name: "repoX" }],
    sessions: [working("11111", "Tinted Task")],
  };
  const noOrg = {
    key: "hostB", device: "hostB", online: true, terminalOnline: true,
    lastSeen: now, repos: [{ name: "repoY" }],
    sessions: [working("22222", "Grey Task")],
  };
  render({ now, agents: [withOrg, noOrg] });
  const color = TurmaBoard.orgColorMap(["org.atlassian.net"]).get("org.atlassian.net");
  const a = els.active.innerHTML;
  // The org host's card wrap sets --org to its palette colour...
  assert.ok(a.includes(`style="--org:${color}"`), "org host's card carries the tint");
  // ...and the org-less host's card sets no --org, staying on plain surface.
  const wraps = a.match(/<div class="s-card-wrap"[^>]*>/g) || [];
  assert.ok(wraps.some((w) => !w.includes("--org")), "org-less host's card carries no tint");
});

test("a queued session lands under Queued, not Ended, and offers Cancel", () => {
  const { render, els } = loadPage();
  const t0 = Date.now();
  const { now, host: h } = host([
    working("11111", "Live Task"),
    { id: "q1234", status: "queued", repo: "repoX", summary: "Waiting Task",
      queuedReason: "capacity", queuedAt: new Date(t0 - 5000).toISOString() },
    { id: "q5678", status: "queued", repo: "repoX", summary: "Cloning Task",
      queuedReason: "awaiting-clone", queuedAt: new Date(t0 - 2000).toISOString() },
  ]);
  render({ now, agents: [h] });

  const q = els.queued.innerHTML;
  assert.match(q, /Queued <span class="count">2<\/span>/);
  assert.ok(q.includes("Waiting Task") && q.includes("waiting for a free session slot"));
  assert.ok(q.includes("Cloning Task") && q.includes("cloning the repo first"));
  assert.ok(q.includes("Cancel"), "a queued card offers Cancel");
  // A queued session is NOT in the ended list, and not a live/attachable card.
  assert.ok(!els.ended.innerHTML.includes("Waiting Task"),
    "a queued session must not read as ended");
  assert.ok(!els.active.innerHTML.includes("Waiting Task"));
});

test("cancelling a queued session arms then kills it", () => {
  const { beat, posts, cardKill } = loadPage();
  const { now, host: h } = host([
    { id: "q1234", status: "queued", repo: "repoX", summary: "Waiting Task",
      queuedReason: "capacity", queuedAt: new Date().toISOString() },
  ]);
  beat({ now, agents: [h] });
  cardKill(click, "hostA", "q1234");   // first click arms
  assert.deepEqual(posts, [], "arming fires no command");
  cardKill(click, "hostA", "q1234");   // second click confirms
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/sessions\/q1234\/kill$/);
});

test("all running idle: Active shows empty-state pointing at Idle; Idle lists them", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([idle("66666", "Only Idle")]);
  render({ now, agents: [h] });

  assert.match(els.active.innerHTML, /Active <span class="count">0<\/span>/);
  assert.ok(els.active.innerHTML.includes("No active sessions"));
  assert.ok(els.active.innerHTML.includes("See Idle below"));
  assert.ok(els.idle.innerHTML.includes("Only Idle"));
});

test("no idle sessions: Idle section renders empty (hidden)", () => {
  const { render, els } = loadPage();
  els.idle.innerHTML = "SENTINEL"; // prove render() clears it, not just leaves stale content
  const { now, host: h } = host([working("77777", "Busy Only")]);
  render({ now, agents: [h] });

  assert.equal(els.idle.innerHTML, "");
  assert.match(els.active.innerHTML, /Active <span class="count">1<\/span>/);
});

// --- the card's ⋯ menu (rename / kill) ---------------------------------------

test("each card carries a ⋯ trigger; its menu opens only for the clicked card", () => {
  const { beat, toggleCardMenu, els } = loadPage();
  const { now, host: h } = host([working("11111", "One"), working("22222", "Two")]);
  beat({ now, agents: [h] });

  assert.equal(els.active.innerHTML.match(/class="s-dots/g).length, 2, "one ⋯ per card");
  assert.ok(!els.active.innerHTML.includes("s-menu"), "menus start closed");

  toggleCardMenu(click, "22222");
  const open = els.active.innerHTML;
  assert.equal(open.match(/class="s-menu"/g).length, 1, "only the clicked card's menu opens");
  assert.ok(open.includes("Rename…") && open.includes("Kill session"));
  assert.ok(open.includes("cardKill(event,'hostA','22222')"), "the menu acts on its own card");

  toggleCardMenu(click, "22222"); // a second click closes it
  assert.ok(!els.active.innerHTML.includes("s-menu"));
});

test("menu Kill arms first and only fires on the confirming click", () => {
  const { beat, toggleCardMenu, cardKill, els, posts } = loadPage();
  const { now, host: h } = host([working("11111", "One")]);
  beat({ now, agents: [h] });
  toggleCardMenu(click, "11111");

  cardKill(click, "hostA", "11111");
  assert.deepEqual(posts, [], "the first click must not kill anything");
  assert.ok(els.active.innerHTML.includes("Confirm kill"), "it arms instead");

  cardKill(click, "hostA", "11111");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/agents/hostA/sessions/11111/kill");
  assert.ok(!els.active.innerHTML.includes("s-menu"), "the menu closes on the kill");
});

// --- move a session to another agent (XERK-101) ------------------------------

// hostA runs session 11111 on repoX; the extra hosts share the same org.
function moveFleet(extraHosts = []) {
  const now = Date.now();
  const jira = { siteKey: "org.atlassian.net" };
  const a = {
    key: "hostA", device: "hostA", online: true, terminalOnline: true,
    lastSeen: now, jira, repos: [{ name: "repoX" }],
    sessions: [working("11111", "Log Task")],
  };
  return { now, agents: [a, ...extraHosts] };
}
const otherHost = (key, { org = "org.atlassian.net", online = true, repos = ["repoX"] } = {}) => ({
  key, device: key, online, terminalOnline: online, lastSeen: Date.now(),
  jira: { siteKey: org }, repos: repos.map((name) => ({ name })), sessions: [],
});

test("the ⋯ menu offers Move only when an eligible same-org host has the repo", () => {
  const { beat, toggleCardMenu, els } = loadPage();
  // No other host yet -> no Move item.
  beat(moveFleet());
  toggleCardMenu(click, "11111");
  assert.ok(!els.active.innerHTML.includes("Move to another agent"),
    "no eligible target -> no Move item");

  // A same-org host with the repo appears; the still-open menu re-renders with
  // the Move item (menuOpenId persists across the beat).
  beat(moveFleet([otherHost("hostB")]));
  assert.ok(els.active.innerHTML.includes("Move to another agent…"));
});

test("Move excludes offline, other-org, and repo-less hosts", () => {
  const { beat, toggleCardMenu, openMove, els } = loadPage();
  beat(moveFleet([
    otherHost("hostB"),                               // eligible
    otherHost("hostOff", { online: false }),          // offline
    otherHost("hostOrg", { org: "other.atlassian.net" }), // different org
    otherHost("hostNoRepo", { repos: ["nope"] }),     // lacks the repo
  ]));
  toggleCardMenu(click, "11111");
  openMove(click, "11111");
  const menu = els.active.innerHTML;
  assert.ok(menu.includes("hostB"), "the one eligible host is offered");
  assert.ok(!menu.includes("hostOff") && !menu.includes("hostOrg") && !menu.includes("hostNoRepo"),
    "offline / other-org / repo-less hosts are excluded");
});

// ---- restoring an archived session (XERK-441) --------------------------------
// The archive outlives the host, so this control's targets are NOT the move's:
// there is no source agent left to compare an org against.

function restoreFleet(extra = []) {
  const now = Date.now();
  return { now, agents: [
    { key: "hostA", device: "hostA", online: true, lastSeen: now,
      repos: [{ name: "repoX" }], sessions: [] },
    ...extra,
  ] };
}
const archived = { transcriptId: "tid-1", repo: "repoX", host: "gone-host",
                   worktree: "/repos/.turma/worktrees/repoX/ab12c", entries: [] };

test("Restore offers every online host that has the repo", () => {
  const { beat, showRestore, toggleRestoreMenu, els } = loadPage();
  beat(restoreFleet([
    { key: "hostB", device: "hostB", online: true, lastSeen: Date.now(), repos: [{ name: "repoX" }], sessions: [] },
    { key: "hostOff", device: "hostOff", online: false, lastSeen: 0, repos: [{ name: "repoX" }], sessions: [] },
    { key: "hostNoRepo", device: "hostNoRepo", online: true, lastSeen: Date.now(), repos: [{ name: "nope" }], sessions: [] },
  ]));
  showRestore(archived);
  toggleRestoreMenu(click);
  const menu = els.trRestoreMenu.innerHTML;
  assert.ok(menu.includes("hostA") && menu.includes("hostB"), "both online hosts with the repo");
  assert.ok(!menu.includes("hostOff"), "an offline host cannot take it");
  assert.ok(!menu.includes("hostNoRepo"), "a host without the repo cannot take it");
});

test("Restore names the repo when nothing can take the session", () => {
  // "No eligible agent" leaves the operator with nothing to do about it; the
  // repo name is the actionable half — clone it somewhere.
  const { beat, showRestore, toggleRestoreMenu, els } = loadPage();
  beat(restoreFleet([]));
  showRestore({ transcriptId: "tid-2", repo: "otherRepo", host: "gone-host",
                worktree: "/repos/.turma/worktrees/otherRepo/cd34e" });
  toggleRestoreMenu(click);
  assert.match(els.trRestoreMenu.innerHTML, /No online agent has otherRepo cloned/);
});

test("picking a host posts the restore to the ARCHIVE, not to a source agent", () => {
  const { beat, showRestore, toggleRestoreMenu, restoreTo, posts } =
    loadPage({ postReply: { migrationId: "mig9" } });
  beat(restoreFleet());
  showRestore(archived);
  toggleRestoreMenu(click);
  restoreTo(click, "hostA");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/archive/tid-1/restore");
  assert.deepEqual(posts[0].body, { host: "hostA" });
});

test("Restore is hidden until an archived transcript is open", () => {
  const { beat, showRestore, hideRestore, toggleRestoreMenu, els } = loadPage();
  beat(restoreFleet());
  showRestore(archived);
  hideRestore();
  toggleRestoreMenu(click);
  assert.equal(els.trRestoreMenu.innerHTML, "",
    "with no archived view open there is nothing to restore");
  assert.equal(els.trRestoreWrap.hidden, true);
});

test("picking a target posts the migrate command to the source host", () => {
  const { beat, toggleCardMenu, openMove, moveTo, posts } = loadPage({ postReply: { migrationId: "mig1" } });
  beat(moveFleet([otherHost("hostB")]));
  toggleCardMenu(click, "11111");
  openMove(click, "11111");
  moveTo(click, "hostA", "11111", "hostB");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/agents/hostA/sessions/11111/migrate");
  assert.deepEqual(posts[0].body, { host: "hostB" });
});

test("a source card shows a 'Moving to …' hint while its migration is in flight", () => {
  const { beat, els } = loadPage();
  const data = moveFleet([otherHost("hostB")]);
  data.migrations = [{
    id: "mig1", srcHost: "hostA", srcSessionId: "11111", targetHost: "hostB",
    phase: "exporting", importCmdId: null,
  }];
  beat(data);
  assert.ok(els.active.innerHTML.includes("Moving to hostB…"),
    "the in-flight move is surfaced on the source card");
});

test("rename swaps the card for a field seeded with the current name, and saves it", () => {
  const { beat, startRename, submitRename, setDraft, els, posts } = loadPage();
  const { now, host: h } = host([working("11111", "Auto Name")]);
  beat({ now, agents: [h] });

  startRename(click, "11111");
  const editing = els.active.innerHTML;
  assert.ok(editing.includes('class="s-rename"'), "the card is replaced by the rename row");
  assert.ok(editing.includes('value="Auto Name"'), "seeded with the name it's replacing");
  assert.ok(!editing.includes('class="s-menu"'), "the menu closed behind it");

  setDraft("My Own Name");
  submitRename("hostA", "11111");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/agents/hostA/sessions/11111/summary");
  assert.deepEqual(posts[0].body, { summary: "My Own Name" });
  // The rename rides the next heartbeat, so the card shows the new name now
  // rather than sitting on the old one and reading as a no-op.
  assert.ok(els.active.innerHTML.includes("My Own Name"));
  assert.ok(!els.active.innerHTML.includes("Auto Name"));
});

test("the optimistic name holds until the agent reports it, then gives way", () => {
  const { beat, startRename, submitRename, setDraft, els } = loadPage();
  const { now, host: h } = host([working("11111", "Auto Name")]);
  beat({ now, agents: [h] });
  startRename(click, "11111");
  setDraft("My Own Name");
  submitRename("hostA", "11111");

  // Beats that predate the rename landing must not flash the old name back.
  beat({ now, agents: [h] });
  assert.ok(els.active.innerHTML.includes("My Own Name"));
  assert.ok(!els.active.innerHTML.includes("Auto Name"));

  // The agent reports it: the overlay is dropped and the card runs on real data
  // again (a name it later reports differently would now win, as it should).
  h.sessions = [working("11111", "My Own Name")];
  beat({ now, agents: [h] });
  assert.ok(els.active.innerHTML.includes("My Own Name"));
  h.sessions = [working("11111", "Renamed Elsewhere")];
  beat({ now, agents: [h] });
  assert.ok(els.active.innerHTML.includes("Renamed Elsewhere"));
});

test("an empty rename clears the name back to the label/worktree fallback", () => {
  const { beat, startRename, submitRename, setDraft, els, posts } = loadPage();
  const { now, host: h } = host([
    { ...working("11111", "Auto Name"), label: "my-label" },
  ]);
  beat({ now, agents: [h] });

  startRename(click, "11111");
  setDraft("   ");
  submitRename("hostA", "11111");
  assert.deepEqual(posts[0].body, { summary: "" });
  assert.ok(els.active.innerHTML.includes("my-label"), "falls through to the label");
  assert.ok(!els.active.innerHTML.includes("Auto Name"));
});

// --- refused commands are visible (XERK-264) ---------------------------------
// The hub refuses commands with a status and a JSON {error} body — an org
// mismatch, an agent too old, an offline host, a full command queue. post()
// ignored res.status entirely, so every one of those read to the operator as a
// command that worked: the menu closed, the name repainted, the spinner span,
// and nothing had happened. These pin the two halves of the fix — the hub's own
// words reach the operator, and anything painted optimistically is taken back.

// post() → fetch → res.json() → the caller's .then is four microtask turns; the
// shim's setTimeout never fires, so drain the queue by hand.
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("a refused kill says why instead of passing for one that worked", async () => {
  const { beat, cardKill, posts, toasts } = loadPage({
    postReply: { error: "the host's command queue is full", limit: 200 }, postStatus: 429,
  });
  const { now, host: h } = host([working("11111", "Busy One")]);
  beat({ now, agents: [h] });

  cardKill(click, "hostA", "11111");   // arms
  cardKill(click, "hostA", "11111");   // confirms
  await flush();
  assert.equal(posts.length, 1, "the kill was sent");
  // 429 is the worst case to swallow: the reason it didn't run is a backlog
  // that won't clear on its own, so an operator who saw nothing would retry and
  // make it worse.
  assert.deepEqual(toasts, ["Kill failed — the host's command queue is full"]);
});

test("a refused rename takes the optimistically painted name back", async () => {
  const { beat, startRename, submitRename, setDraft, els, toasts } = loadPage({
    postReply: { error: "unknown session" }, postStatus: 404,
  });
  const { now, host: h } = host([working("11111", "Auto Name")]);
  beat({ now, agents: [h] });

  startRename(click, "11111");
  setDraft("My Own Name");
  submitRename("hostA", "11111");
  assert.ok(els.active.innerHTML.includes("My Own Name"), "painted while in flight");

  await flush();
  assert.deepEqual(toasts, ["Rename failed — unknown session"]);
  assert.ok(els.active.innerHTML.includes("Auto Name"),
    "the name the session actually has is back");
  assert.ok(!els.active.innerHTML.includes("My Own Name"));
});

test("a refused spawn drops the repo's 'Starting…' spinner", async () => {
  const page = loadPage({
    postReply: { error: "the agent is offline" }, postStatus: 503,
  });
  const now = Date.now();
  const h = {
    key: "hostA", device: "hostA", online: true, terminalOnline: true,
    lastSeen: now, repos: [{ name: "repoX" }], sessions: [],
  };
  page.setCache({ now, agents: [h] });
  page.render({ now, agents: [h] });
  page.toggleComposer("hostA::repoX", "repoX");
  page.startSession("hostA", "repoX");
  assert.ok(page.els.spawn.innerHTML.includes("Starting…"), "optimistic while in flight");

  await flush();
  assert.deepEqual(page.toasts, ["Start failed — the agent is offline"]);
  // Left up, the disabled spinner sits on the repo for the whole PENDING_TTL_MS
  // and reads as a session on its way.
  assert.ok(!page.els.spawn.innerHTML.includes("Starting…"));
});

test("a refusal with no error body still names the status", async () => {
  const { beat, cardKill, toasts } = loadPage({ postReply: {}, postStatus: 502 });
  const { now, host: h } = host([working("11111", "Busy One")]);
  beat({ now, agents: [h] });
  cardKill(click, "hostA", "11111");
  cardKill(click, "hostA", "11111");
  await flush();
  assert.deepEqual(toasts, ["Kill failed — the hub answered HTTP 502"]);
});

test("terminal compose: a refusal the button can't word goes to the toast", async () => {
  const { beat, selectSession, sendTermInput, els, chat, toasts } = loadPage({
    postReply: { error: "the host's command queue is full" }, postStatus: 429,
  });
  const { now, host: h } = host([idle("11111", "Waiting")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  els.termInput = makeEl("termInput");
  els.termInput.value = "ship it";
  await sendTermInput();
  // The compose button has room for a label, not a sentence — it used to render
  // the bare status number — so the hub's reason rides the toast instead.
  assert.equal(chat.failed, "Send failed");
  assert.deepEqual(toasts, ["Send failed — the host's command queue is full"]);
  assert.equal(els.termInput.value, "ship it", "and the message is still there");
});

test("cancelling a rename restores the card untouched", () => {
  const { beat, startRename, cancelRename, setDraft, els, posts } = loadPage();
  const { now, host: h } = host([working("11111", "Auto Name")]);
  beat({ now, agents: [h] });

  startRename(click, "11111");
  setDraft("Discarded");
  cancelRename();
  assert.ok(!els.active.innerHTML.includes("s-rename"));
  assert.ok(els.active.innerHTML.includes("Auto Name"));
  assert.deepEqual(posts, [], "nothing was sent");
});

test("an idle card gets the same menu as an active one", () => {
  const { beat, toggleCardMenu, els } = loadPage();
  const { now, host: h } = host([idle("33333", "Quiet")]);
  beat({ now, agents: [h] });
  toggleCardMenu(click, "33333");
  assert.ok(els.idle.innerHTML.includes('class="s-menu"'));
  assert.ok(els.idle.innerHTML.includes("cardKill(event,'hostA','33333')"));
});

// --- opening the session you just started ------------------------------------
// A spawn/resume can't name its session: the agent mints the id, so the POST
// only answers with the queued command's cmdId and the new session echoes it
// back as `spawnCmdId` on a later beat. These cover that correlation.

test("?spawn=<cmdId>: opens the session the agent mints for that command", () => {
  const { beat, els, opened } = loadPage({ search: "?spawn=cmd-77" });
  const { now, host: h } = host([working("11111", "Someone Else's Task")]);

  // Beat 1: the spawn hasn't landed yet — nothing is opened, and the idle stage
  // says a session is coming rather than "No session attached".
  beat({ now, agents: [h] });
  assert.deepEqual(opened, []);
  assert.match(els.stageEmptyBig.innerHTML, /Starting your session/);

  // Beat 2: the agent reports the session it created for cmd-77.
  h.sessions = [...h.sessions, { ...working("99999", "My New Task"), spawnCmdId: "cmd-77" }];
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["99999"], "the followed spawn is opened on arrival");
  assert.match(els.stageEmptyBig.innerHTML, /No session attached/, "waiting state cleared");

  // It's one-shot: a later beat must not re-open (and fight a manual pick).
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["99999"]);
});

test("a spawn started on this page is followed the same way", () => {
  const { beat, followSpawn, opened } = loadPage();
  const { now, host: h } = host([]);
  followSpawn("cmd-5"); // what startSession() does with the POST's reply

  h.sessions = [{ ...working("abcde", "Fresh"), spawnCmdId: "cmd-5" }];
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["abcde"]);
});

test("an unrelated session's spawnCmdId is not mistaken for ours", () => {
  const { beat, els, opened } = loadPage({ search: "?spawn=cmd-mine" });
  const { now, host: h } = host([{ ...working("77777", "Other"), spawnCmdId: "cmd-theirs" }]);
  beat({ now, agents: [h] });
  assert.deepEqual(opened, [], "only the cmdId we issued may open");
  assert.match(els.stageEmptyBig.innerHTML, /Starting your session/, "still waiting on ours");
});

test("picking a session cancels a pending follow, so the spawn can't yank the stage", () => {
  const { beat, selectSession, opened } = loadPage({ search: "?spawn=cmd-77" });
  const { now, host: h } = host([working("11111", "Reading This")]);
  beat({ now, agents: [h] });

  selectSession("11111");
  assert.deepEqual(opened, ["11111"]);

  // The followed spawn now lands — the operator stays where they are.
  h.sessions = [...h.sessions, { ...working("99999", "Late Arrival"), spawnCmdId: "cmd-77" }];
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["11111"], "an explicit pick wins over the pending follow");
});

test("a spawn the agent refused stops the wait and says why (XERK-265)", () => {
  const { beat, els, opened, toasts } = loadPage({ search: "?spawn=cmd-ref" });
  const { now, host: h } = host([]);
  // Beat 1: nothing reported yet — the ordinary wait.
  beat({ now, agents: [h] });
  assert.match(els.stageEmptyBig.innerHTML, /Starting your session/);

  // Beat 2: the host reports it declined that command.
  h.spawnRefusals = { "cmd-ref": { error: "the host is at MAX_SESSIONS (4)", at: now } };
  beat({ now, agents: [h] });
  assert.deepEqual(toasts, ["Couldn't start session: the host is at MAX_SESSIONS (4)"]);
  assert.match(els.stageEmptyBig.innerHTML, /No session attached/,
    "and the wait ends instead of spinning out SPAWN_FOLLOW_MS");
  assert.deepEqual(opened, []);
});

test("a followed move advances on its SSE event, not just on a page reload", async () => {
  // The fleet payload is polled ONCE at load while SSE is healthy (fastPoll
  // returns early, the fallback interval only runs when it isn't), so without a
  // `migrations` listener a move's phase never moved in the browser: the follow
  // never saw importCmdId and never surfaced a failure (XERK-101/XERK-265).
  const { beat, sse, moveTo, toasts } = loadPage({ postReply: { ok: true, migrationId: "m8" } });
  const { now, host: h } = host([{ ...working("s1", "Moving Me") }]);
  beat({ now, agents: [h], migrations: [] });
  await moveTo(click, "hostA", "s1", "hostB");   // arms pendingMigration from the reply

  sse.emit("migrations", [{ id: "m8", phase: "importing", importCmdId: "cmd-i8",
                            srcHost: "hostA", srcSessionId: "s1" }]);
  sse.emit("migrations", [{ id: "m8", phase: "failed", importCmdId: "cmd-i8", srcHost: "hostA",
                            srcSessionId: "s1", error: "a root session is already running" }]);
  // Only reachable because the event moved the page's copy of the migration:
  // with the poll alone it would still read `exporting` from the load.
  assert.deepEqual(toasts, ["Move failed: a root session is already running"]);
});

test("a session that DID come up beats a cached refusal for the same command", () => {
  // Mirrors the hub's own tie-break in advanceMigrations. A refusal stays
  // served for ten minutes, so reading it before the session list would let a
  // stale one abandon a spawn that has since landed.
  const { beat, opened, toasts } = loadPage({ search: "?spawn=cmd-both" });
  const { now, host: h } = host([{ ...working("55555", "Landed"), spawnCmdId: "cmd-both" }]);
  h.spawnRefusals = { "cmd-both": { error: "a stale refusal", at: now } };
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["55555"], "the reported session wins");
  assert.deepEqual(toasts, [], "and nothing is said");
});

test("a refused MOVE is reported once, by the migration that owns it", () => {
  const { beat, toasts } = loadPage({ search: "?spawn=cmd-imp" });
  const { now, host: h } = host([]);
  h.spawnRefusals = { "cmd-imp": { error: "a root session is already running", at: now } };
  beat({
    now, agents: [h],
    migrations: [{ id: "m1", phase: "importing", importCmdId: "cmd-imp",
                   srcHost: "hostA", srcSessionId: "s1" }],
  });
  // The migration follow words this one ("Move failed: …"); the spawn wait must
  // not toast the same refusal a second time.
  assert.deepEqual(toasts, []);
});

test("a hub or agent too old to report refusals waits exactly as before", () => {
  const { beat, els, toasts } = loadPage({ search: "?spawn=cmd-old" });
  const { now, host: h } = host([]);
  beat({ now, agents: [h] });   // no spawnRefusals key at all
  assert.deepEqual(toasts, []);
  assert.match(els.stageEmptyBig.innerHTML, /Starting your session/);
});

test("mobile: re-selecting a session after backing out re-reveals its stage (XERK-17)", () => {
  const { beat, selectSession, backToList, opened, body } = loadPage({ narrow: true });
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });

  selectSession("11111");
  assert.deepEqual(opened, ["11111"]);
  assert.ok(body.classList.contains("showing-term"), "the stage is revealed on select");

  // "Back to Sessions" — the mobile flow only HIDES the stage; currentId/viewMode
  // stay put so the live tail stays warm, and the sidebar card is tappable again.
  backToList();
  assert.ok(!body.classList.contains("showing-term"), "backing out hides the stage");

  // Re-tapping the same card used to hit the desktop no-op guard and do nothing,
  // stranding the session unopenable. It must now re-reveal the warm stage.
  selectSession("11111");
  assert.ok(body.classList.contains("showing-term"), "re-selecting re-reveals the stage");
  assert.deepEqual(opened, ["11111"], "the warm chat is NOT torn down and rebuilt");
});

// XERK-252. The host's terminal tunnel (the agent's control-channel WebSocket)
// flaps in normal operation — a Cloudflare hiccup, an agent restart, a hub
// deploy — and reconnects within a second or two. The session never stops
// running and never stops being heartbeated, so the operator must not be thrown
// off the conversation they are reading.
test("a tunnel flap holds the staged session, and heals it when the tunnel returns", () => {
  const { beat, selectSession, els, chat, opened } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });
  selectSession("11111");
  assert.deepEqual(opened, ["11111"]);
  const closedAtOpen = chat.closed;

  // The tunnel drops: same running session, host still heartbeating, only
  // `terminalOnline` flips. The stage stays, and says why it has gone quiet.
  beat({ now, agents: [{ ...h, terminalOnline: false }] });
  assert.equal(chat.closed, closedAtOpen, "the chat's live tail is NOT torn down");
  assert.equal(els.chatTunnelOff.hidden, false, "the chat bar shows the tunnel is down");
  assert.equal(els.termTunnelOff.hidden, false, "and so does the terminal bar");
  assert.equal(chat.reconnected, 0, "nothing to reconnect while it's still down");

  // ...and comes back: the chip clears and the chat is nudged to reconnect at
  // once rather than waiting out its backoff.
  beat({ now, agents: [h] });
  assert.equal(els.chatTunnelOff.hidden, true);
  assert.equal(chat.reconnected, 1, "the live socket is reconnected on the spot");
  assert.equal(chat.closed, closedAtOpen, "still never closed");

  // A steady stream of online beats must not re-nudge (or the terminal iframe
  // below would restart every few seconds).
  beat({ now, agents: [h] });
  beat({ now, agents: [h] });
  assert.equal(chat.reconnected, 1, "only the transition acts");
});

test("a tunnel flap re-attaches the terminal iframe, whose socket cannot self-heal", () => {
  const { beat, selectSession, chatToTerminal, els } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });
  selectSession("11111");
  chatToTerminal();
  els.termFrame.src = "";  // forget the initial attach so the re-attach is unambiguous

  beat({ now, agents: [{ ...h, terminalOnline: false }] });
  assert.equal(els.termFrame.src, "", "nothing to re-attach while the tunnel is down");
  beat({ now, agents: [h] });
  assert.equal(els.termFrame.src, "/term/11111/", "the ttyd frame is re-navigated on return");
});

// The stage's tunnel state belongs to ONE staged subject. Left over from the
// previous one, the next session's first beat reads as a tunnel RETURN and
// fires the heal — which in the browser meant TurmaChat.reconnectNow() landing
// inside the open()'s own connect and opening a second /live socket the page
// could never close (found in QA of this change).
test("switching sessions while a tunnel is down doesn't fire the heal at the new one", () => {
  const { beat, selectSession, els, chat } = loadPage();
  const now = Date.now();
  const h1 = { key: "hostA", device: "hostA", online: true, terminalOnline: true, lastSeen: now,
    repos: [{ name: "repoX" }], sessions: [working("11111", "First")] };
  const h2 = { key: "hostB", device: "hostB", online: true, terminalOnline: true, lastSeen: now,
    repos: [{ name: "repoY" }], sessions: [working("22222", "Second")] };
  beat({ now, agents: [h1, h2] });
  selectSession("11111");

  // hostA's tunnel drops while its session is staged.
  beat({ now, agents: [{ ...h1, terminalOnline: false }, h2] });
  assert.equal(els.chatTunnelOff.hidden, false);
  const nudgesBefore = chat.reconnected;

  // The operator picks hostB's session instead — nothing about THAT view ever
  // went offline, so nothing about it needs healing.
  selectSession("22222");
  beat({ now, agents: [{ ...h1, terminalOnline: false }, h2] });
  assert.equal(chat.reconnected, nudgesBefore, "no stale heal on the new session");
  assert.equal(els.chatTunnelOff.hidden, true, "and no stale chip either");
});

// A host that has stopped heartbeating altogether is a different story from a
// flapping tunnel, and the chip must not keep promising the session is fine.
// The stage still holds (the machine may be up and merely unreachable), so it
// also has to offer a way off it.
test("a host that goes silent says so, and offers a way off the stage", () => {
  const { beat, selectSession, els, clearStage } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  beat({ now, agents: [{ ...h, terminalOnline: false, online: false }] });
  assert.match(els.chatTunnelOff.textContent, /host offline/);
  assert.doesNotMatch(els.chatTunnelOff.title, /keeps running/,
    "no promise the page can't keep about a host it hasn't heard from");
  assert.equal(els.chatTunnelClose.hidden, false, "and an explicit way out");

  // The tunnel-only case keeps the softer wording.
  beat({ now, agents: [{ ...h, terminalOnline: false }] });
  assert.match(els.chatTunnelOff.textContent, /tunnel offline/);
  assert.match(els.chatTunnelOff.title, /keeps running/);

  // What that button does (its onclick): drop the stage, and the chip with it.
  // The session itself is untouched — it is still running on its host.
  clearStage();
  assert.equal(els.stageEmpty.hidden, false);
  assert.equal(els.chatTunnelOff.hidden, true);
  assert.equal(els.chatTunnelClose.hidden, true);
});

// A beat that doesn't mention the host at all says nothing about its sessions:
// the hub restarts with its persisted fleet but can also answer before the
// first heartbeat lands, and a refresh can fail outright. Silence is not
// evidence the session died (XERK-252).
test("a beat that can't see the host holds the stage rather than clearing it", () => {
  const { beat, selectSession, chat } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });
  selectSession("11111");
  const closedAtOpen = chat.closed;

  beat({ now, agents: [] });
  assert.equal(chat.closed, closedAtOpen, "an empty payload doesn't evict the operator");
  beat({ now, agents: [h] });
  assert.equal(chat.closed, closedAtOpen);
});

// The org filter is a SIDEBAR scope (XERK-62) — sessionHit deliberately ignores
// it so an open session isn't torn off the stage when its org leaves the list.
// The vanish check has to read the same whole fleet, or narrowing the filter
// closed the session the operator was reading.
test("narrowing the org filter doesn't tear the staged session off the stage", () => {
  const { beat, selectSession, setOrg, chat } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  h.jira = { siteKey: "acme.atlassian.net" };
  beat({ now, agents: [h] });
  selectSession("11111");
  const closedAtOpen = chat.closed;

  setOrg("other.atlassian.net");   // the staged session's host leaves the sidebar
  beat({ now, agents: [h] });
  assert.equal(chat.closed, closedAtOpen, "the stage keeps the session it was showing");
});

// Toggling chat -> terminal is a VIEW change on the same session, not a new
// subject: it must not spend the tunnel's return edge. It used to, so the
// terminal opened black (ttyd can't attach through a downed tunnel) and nothing
// ever re-navigated it — with the chip that would have explained it also gone.
test("toggling to the terminal during a flap keeps the chip and still re-attaches", () => {
  const { beat, selectSession, chatToTerminal, els } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  beat({ now, agents: [{ ...h, terminalOnline: false }] });
  chatToTerminal();
  assert.equal(els.termTunnelOff.hidden, false, "the terminal bar still says why it's dead");
  els.termFrame.src = "";   // forget the toggle's own (doomed) attach

  beat({ now, agents: [h] });
  assert.equal(els.termFrame.src, "/term/11111/", "the return re-attaches the terminal");
  assert.equal(els.termTunnelOff.hidden, true);
});

// The other half of the rule: a session that genuinely went (killed elsewhere,
// or its host stopped reporting it at all) still drops the stage.
test("a vanished session still clears the stage", () => {
  const { beat, selectSession, els, chat } = loadPage();
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });
  selectSession("11111");
  const closedAtOpen = chat.closed;

  beat({ now, agents: [{ ...h, sessions: [] }] });
  assert.ok(chat.closed > closedAtOpen, "the chat's live tail is torn down");
  assert.equal(els.stageEmpty.hidden, false, "and the stage is back to the empty prompt");
});

test("desktop: re-selecting the current session stays a no-op", () => {
  const { beat, selectSession, opened } = loadPage(); // narrow:false — desktop
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });

  selectSession("11111");
  selectSession("11111");
  assert.deepEqual(opened, ["11111"], "no rebuild when the stage is already visible");
});

// --- the terminal's split compose bar (Send + separate ◼ Stop) ---------------
// (The chat pane's own buttons are chat.js's — see chat.test.js.)

test("terminal compose: Send sends even while the agent works (the send queues)", () => {
  const { beat, selectSession, termComposeAction, els, posts, chat } = loadPage();
  const { now, host: h } = host([working("11111", "Long Turn")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  // Mid-turn, Send must NOT stop: the message queues (Claude Code holds it
  // until the turn ends, and the chat shows it as a "queued" bubble).
  chat.busy = true;
  els.termInput = makeEl("termInput");
  els.termInput.value = "also do the thing";
  termComposeAction();
  assert.equal(chat.stopped, 0, "sending mid-turn must not interrupt the turn");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/agents/hostA/sessions/11111/input");
  assert.equal(posts[0].body.text, "also do the thing");
});

test("terminal compose: the separate Stop button delegates to the chat engine", () => {
  const { beat, selectSession, termComposeStop, posts, chat } = loadPage();
  const { now, host: h } = host([working("11111", "Long Turn")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  chat.busy = true;
  termComposeStop();
  // One click is the whole interaction — unlike Kill, nothing is destroyed, so
  // there's no arm-then-confirm step. The engine owns the interrupt POST so the
  // two compose bars can't disagree about the turn's state.
  assert.equal(chat.stopped, 1, "the click stops the turn");
  assert.deepEqual(posts, [], "the page doesn't post the interrupt itself");
});

test("terminal compose: Send sends the typed message when idle", () => {
  const { beat, selectSession, termComposeAction, els, posts, chat } = loadPage();
  const { now, host: h } = host([idle("11111", "Waiting")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  chat.busy = false;
  els.termInput = makeEl("termInput");
  els.termInput.value = "do the thing";
  termComposeAction();
  assert.equal(chat.stopped, 0, "an idle agent has no turn to stop");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/agents/hostA/sessions/11111/input");
  assert.equal(posts[0].body.text, "do the thing");
});

test("terminal compose: a multi-line paste goes as ONE message, verbatim (XERK-227)", async () => {
  const { beat, selectSession, sendTermInput, els, posts } = loadPage({ postReply: { ok: true } });
  const { now, host: h } = host([idle("11111", "Waiting")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  // The pasted log the old 4k cap refused. Nothing here splits or clips it — the
  // agent pastes it into the pane, which is what the raw terminal always did.
  const pasted = Array.from({ length: 500 }, (_, i) => `line ${i}: some log output`).join("\n");
  els.termInput = makeEl("termInput");
  els.termInput.value = pasted;
  await sendTermInput();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.text, pasted);
  assert.equal(els.termInput.value, "", "a sent message clears the box");
});

test("terminal compose: the hub's 413 says 'too long' and keeps the text (XERK-227)", async () => {
  const { beat, selectSession, sendTermInput, els, chat } = loadPage({
    postReply: { error: "message too long", limit: 4000 }, postStatus: 413,
  });
  const { now, host: h } = host([idle("11111", "Waiting")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  els.termInput = makeEl("termInput");
  els.termInput.value = "x".repeat(20);
  await sendTermInput();
  // A refusal the operator can act on: it reads as a length problem, not as the
  // hub being down, and the message is put back so it can be split rather than
  // retyped.
  // The cap is per host — 4k on an agent too old to paste — so the bar names it
  // rather than leaving the operator to guess how much to cut.
  assert.equal(chat.failed, "Too long — max 4,000");
  assert.equal(els.termInput.value, "x".repeat(20));
});

// --- the draft survives a chat <-> terminal toggle (XERK-122) ----------------

test("toggling to the terminal carries the half-typed chat draft, and back again", () => {
  const { beat, selectSession, chatToTerminal, terminalToChat, els } = loadPage();
  const { now, host: h } = host([working("11111", "Long Turn")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  els.chatInput = makeEl("chatInput");
  els.termInput = makeEl("termInput");
  els.chatInput.value = "check the logs and then";
  chatToTerminal();
  assert.equal(els.termInput.value, "check the logs and then", "the draft follows the view");
  assert.equal(els.chatInput.value, "", "the source box is cleared, so only one box holds it");
  assert.ok(els.termInput.focused, "a carried draft takes focus, ready to keep typing");

  // Keep typing in the terminal's box, then go back — the whole draft returns.
  els.termInput.value = "check the logs and then restart it";
  terminalToChat();
  assert.equal(els.chatInput.value, "check the logs and then restart it");
  assert.equal(els.termInput.value, "");
  assert.ok(els.chatInput.focused);
});

test("an empty compose box doesn't grab focus on a toggle (no soft keyboard on a phone)", () => {
  const { beat, selectSession, chatToTerminal, els } = loadPage();
  const { now, host: h } = host([working("11111", "Long Turn")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  els.chatInput = makeEl("chatInput");
  els.termInput = makeEl("termInput");
  els.chatInput.value = "   ";
  chatToTerminal();
  assert.equal(els.termInput.value, "   ", "whitespace still moves — it's the operator's text");
  assert.ok(!els.termInput.focused, "but nothing worth continuing means no focus steal");
});

// --- autoGrow never squishes a hidden compose box (XERK-149) -----------------
// The compose box grows to its scrollHeight, but a not-laid-out textarea reports
// scrollHeight 0 — and growCompose runs autoGrow during the carryDraft when its
// pane is hidden. Left unguarded that pins height:0px, squishing the box below a
// line until a page refresh. offsetParent is null for a display:none element, so
// the guard keeps the last laid-out height instead. (autoGrowTermInput is the
// mirror of chat.js autoGrow; both carry the identical guard.)
test("autoGrowTermInput leaves the height alone while the box is hidden", () => {
  const { autoGrowTermInput, els } = loadPage();
  const inp = els.termInput = makeEl("termInput");
  inp.style.height = "42px";     // its last correct, laid-out height
  inp.scrollHeight = 40;         // what a browser reports even when hidden it's 0
  inp.offsetParent = null;       // display:none somewhere up the tree
  autoGrowTermInput();
  assert.equal(inp.style.height, "42px", "a hidden box keeps its last good height, never 0px");
});

test("autoGrowTermInput sizes to scrollHeight while the box is laid out", () => {
  const { autoGrowTermInput, els } = loadPage();
  const inp = els.termInput = makeEl("termInput");
  inp.offsetParent = els.termPane || makeEl("termPane"); // laid out (non-null)
  inp.scrollHeight = 73;
  autoGrowTermInput();
  assert.equal(inp.style.height, "73px", "a visible box grows to fit its content");
});

test("autoGrowTermInput clamps a tall box to the 160px max", () => {
  const { autoGrowTermInput, els } = loadPage();
  const inp = els.termInput = makeEl("termInput");
  inp.offsetParent = makeEl("termPane");
  inp.scrollHeight = 500;
  autoGrowTermInput();
  assert.equal(inp.style.height, "160px", "past the cap it scrolls internally");
});

test("?session=<id>: waits for a session that isn't running yet, then opens it", () => {
  const { beat, els, opened } = loadPage({ search: "?session=55555" });
  const { now, host: h } = host([{ id: "55555", status: "stopped", repo: "repoX", summary: "Resuming" }]);

  // A resumed session keeps its id, so the dashboard deep-links by id before the
  // agent has relaunched it. Stopped -> not attachable yet: hold, don't open.
  beat({ now, agents: [h] });
  assert.deepEqual(opened, []);
  assert.match(els.stageEmptyBig.innerHTML, /Opening session/);

  h.sessions = [working("55555", "Resumed")];
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["55555"]);
});

test("the archive BROWSER is still gone from the sidebar markup", () => {
  // The old #archiveWrap/#archiveDetails list paged GET /api/archive to enumerate
  // every archived transcript on the hub, and was dropped as redundant with the
  // search box, which reaches the same history by content instead of by scrolling.
  // That removal still stands and this guards it.
  //
  // It does NOT guard the string "Ended sessions", which this test used to assert
  // was absent: the sidebar's Ended-sessions section is a different thing that
  // reuses the name. It lists the SESSIONS this fleet has ended (killed + stopped,
  // from the heartbeat) so they can be read and resumed — a lifecycle control, not
  // an archive index. Its rows are bounded by the fleet's own closed history, it
  // carries Resume + PR state the browser never had, and it pages nothing.
  assert.ok(!/id="archiveWrap"/.test(html), "no #archiveWrap element");
  assert.ok(!/id="archiveDetails"/.test(html), "no #archiveDetails element");
  assert.ok(!/\/api\/archive\?/.test(html), "sidebar must not page the archive index");
  assert.ok(/id="idle"/.test(html), "#idle section present");
  assert.ok(/id="ended"/.test(html), "#ended section present");
});

// --- Ended sessions ----------------------------------------------------------
// A killed session and a stopped one reach the page down different channels
// (a.closedSessions vs a non-running a.sessions record) and resume through
// different endpoints, but the operator sees one list. These cover the merge,
// the ordering, and that an ended session's stage view stays read-only.

// A killed session, as the agent's closed history reports it.
const closed = (id, summary, closedAt, extra) => ({
  id, repo: "repoX", summary, closedAt, worktreePath: "/g/.turma/worktrees/" + id, ...extra,
});

test("Ended sessions merges killed + stopped, newest-ended first", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([
    working("11111", "Live One"),
    { id: "22222", status: "stopped", repo: "repoX", summary: "Stopped Mid",
      stoppedAt: "2026-07-15T12:00:00Z" },
  ]);
  h.closedSessions = [
    closed("33333", "Killed Oldest", "2026-07-15T09:00:00Z"),
    closed("44444", "Killed Newest", "2026-07-15T18:00:00Z"),
  ];
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  assert.match(e, /Ended sessions <span class="count">3<\/span>/);
  assert.ok(!e.includes("Live One"), "a running session is not ended");
  // Newest kill at the top, and the stopped one interleaves by ITS OWN end time
  // rather than being segregated into a second list.
  const order = ["Killed Newest", "Stopped Mid", "Killed Oldest"].map((t) => e.indexOf(t));
  assert.ok(order.every((i) => i >= 0), "all three ended sessions listed");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "sorted newest-ended first");
});

test("Ended sessions is collapsed by default and hidden when there are none", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([working("11111", "Live One")]);
  els.ended.innerHTML = "SENTINEL";
  beat({ now, agents: [h] });
  assert.equal(els.ended.innerHTML, "", "no ended sessions -> no section");

  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z")];
  beat({ now, agents: [h] });
  // <details> with no `open` attribute — the list is history, so it stays folded
  // until asked for.
  assert.match(els.ended.innerHTML, /<details class="ended-wrap-sec"/);
  assert.ok(!/<details class="ended-wrap-sec"[^>]*\sopen/.test(els.ended.innerHTML),
    "the ended list must start collapsed");
});

test("the Ended sessions heading IS the disclosure control", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([working("11111", "Live One")]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z")];
  beat({ now, agents: [h] });

  // The heading lives inside the <summary>, so clicking it toggles the section.
  // A heading rendered as a sibling ABOVE the <details> looks identical but is
  // dead to the click, which is what leaves the operator hunting for a second,
  // smaller target below it.
  assert.match(els.ended.innerHTML,
    /<summary><h2>Ended sessions <span class="count">1<\/span><\/h2><\/summary>/,
    "the <h2> must be the <summary>'s own content");
  assert.ok(!/<\/h2>\s*<details/.test(els.ended.innerHTML),
    "the heading must not sit outside the <details> as an inert sibling");
  // The separate 'Show / hide ended sessions' line the heading replaced.
  assert.ok(!/show\s*\/\s*hide/i.test(els.ended.innerHTML),
    "no second toggle target below the heading");
});

test("resuming dispatches on how the session ended: killed -> resume, stopped -> start", () => {
  const { beat, resumeEnded, posts } = loadPage();
  const { now, host: h } = host([
    { id: "22222", status: "stopped", repo: "repoX", summary: "Stopped Mid",
      stoppedAt: "2026-07-15T12:00:00Z" },
  ]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z")];
  beat({ now, agents: [h] });

  // A killed session was dropped from the registry; only `resume` can re-register
  // it. A stopped one still has its record and just needs relaunching.
  resumeEnded(click, "33333");
  resumeEnded(click, "22222");
  assert.deepEqual(posts.map((p) => p.url), [
    "/api/agents/hostA/sessions/33333/resume",
    "/api/agents/hostA/sessions/22222/start",
  ]);
});

test("a resumed session is followed onto the stage once it comes back running", () => {
  const { beat, resumeEnded, opened } = loadPage();
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z")];
  beat({ now, agents: [h] });

  resumeEnded(click, "33333");
  assert.deepEqual(opened, [], "nothing to open until the agent relaunches it");

  // The agent re-registers it under the same id on a later beat: it leaves the
  // ended list of its own accord (the list is derived) and lands on the stage.
  h.closedSessions = [];
  h.sessions = [working("33333", "Killed")];
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["33333"]);
});

test("an ended session's card carries Resume and its PR chips", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z", {
    prs: [{ url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED", checks: "passing" }],
  })];
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  assert.match(e, /class="s-resume"/, "Resume button present");
  assert.match(e, /resumeEnded\(event,'33333'\)/);
  assert.ok(e.includes("#7 Merged"), "the PR state it reached still shows");
  // The card is a <button>, so its chips must stay inert spans — a nested <a>
  // is invalid HTML the parser hoists out of the button.
  assert.ok(!/<a class="pr-badge/.test(e), "card chips are spans, not links");
});

// --- Ended sessions: the durable channel -------------------------------------
// closed.json and sessions.json live in the agent's ~/.turma, whose durability is
// the host's to provide: a container that doesn't bind-mount it has them on the
// image's writable layer, and an agent update recreates the container with both
// gone. Even mounted, closed.json is capped at CLOSED_PER_REPO. repo.resumable is
// re-derived from the transcripts under ~/.claude (a bind mount), so it is what
// carries the list across a restart, and it isn't capped that way either. These
// cover the third channel, its dedupe against the first two, and its own resume
// path.

// A prior session as the agent's transcript scan reports it: no session id and
// no PR links, because there is no registry record left to have held them.
const resumable = (tid, summary, endedTs, extra) => ({
  transcriptId: tid, summary, endedTs, repo: "repoX",
  cwd: "/g/.turma/worktrees/repoX/" + tid, slug: "-g--turma-worktrees-repoX-" + tid,
  origin: tid, root: false, ...extra,
});
const withResumable = (h, list) => { h.repos = [{ name: "repoX", resumable: list }]; return h; };

test("ended sessions survive an agent restart that empties ~/.turma", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([]);
  // The agent came back with no registry and no closed history — exactly what a
  // recreated container reports. Only the transcript scan is left, and the list
  // has to be built out of it rather than reading empty.
  h.sessions = [];
  h.closedSessions = [];
  // Transcript ids deliberately sort OPPOSITE to the end times: ties fall back to
  // the id, so ids that agree with the times would let a row that never got a
  // sort key at all still land in the right order, for the wrong reason.
  withResumable(h, [
    resumable("t-zzz", "Recovered Newer", "2026-07-15T18:00:00Z"),
    resumable("t-aaa", "Recovered Older", "2026-07-15T09:00:00Z"),
  ]);
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  assert.match(e, /Ended sessions <span class="count">2<\/span>/);
  const order = ["Recovered Newer", "Recovered Older"].map((t) => e.indexOf(t));
  assert.ok(order.every((i) => i >= 0), "both recovered sessions listed");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "sorted newest-ended first");
  assert.match(e, /class="s-resume"/, "a recovered session is still resumable");
  // The row has to SAY when it ended, which is the same field the sort reads.
  assert.match(e, /ended \d+[smhd]/, "a recovered row carries its end time");
});

test("a resumable-only ended session keeps its PR chip (XERK-13)", () => {
  // The point of the ticket: a session aged out of closed.json is reported only
  // through the transcript scan, which now carries the PRs it opened from the
  // agent's durable PR ledger — so its chip survives past its closed record.
  const { beat, els } = loadPage();
  const { now, host: h } = host([]);
  h.sessions = [];
  h.closedSessions = [];
  withResumable(h, [resumable("t-pr", "Recovered With PR", "2026-07-15T09:00:00Z", {
    prs: [{ url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED", checks: "passing" }],
  })]);
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  assert.match(e, /Recovered With PR/, "the recovered session is listed");
  assert.match(e, /pull\/7/, "and its PR link rides along");
  assert.match(e, /#7/, "and the chip shows the PR number");
});

test("all three channels interleave into one list by when they ended", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([
    { id: "22222", status: "stopped", repo: "repoX", summary: "Stopped Mid",
      stoppedAt: "2026-07-15T12:00:00Z" },
  ]);
  h.closedSessions = [closed("33333", "Killed Newest", "2026-07-15T18:00:00Z")];
  withResumable(h, [resumable("t-old", "Scanned Oldest", "2026-07-15T06:00:00Z")]);
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  assert.match(e, /Ended sessions <span class="count">3<\/span>/);
  const order = ["Killed Newest", "Stopped Mid", "Scanned Oldest"].map((t) => e.indexOf(t));
  assert.ok(order.every((i) => i >= 0), "all three channels listed");
  assert.deepEqual(order, [...order].sort((a, b) => a - b),
    "one list ordered by end time, not grouped by channel");
});

test("a killed session reported through both channels collapses to one row", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([]);
  // The scan finds a killed session's transcript too, so for as long as its
  // closed record survives it is reported twice. The record has to win: it is
  // the only one of the two that knows the PRs and the original id.
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z", {
    transcriptId: "t-dup",
    prs: [{ url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED", checks: "passing" }],
  })];
  withResumable(h, [resumable("t-dup", "Killed", "2026-07-15T09:00:01Z")]);
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  assert.match(e, /Ended sessions <span class="count">1<\/span>/, "one session, one row");
  assert.ok(e.includes("#7 Merged"), "the surviving row is the one carrying the PR chips");
  assert.match(e, /resumeEnded\(event,'33333'\)/, "and it resumes by its own session id");
});

test("a running session's transcript is never also listed as ended", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([
    { ...working("11111", "Live One"), transcriptId: "t-live" },
  ]);
  // The agent cuts these against its live registry every beat, but the page must
  // not depend on that: a session listed as both running and ended at once is
  // the worst version of this list being wrong.
  withResumable(h, [resumable("t-live", "Live One", "2026-07-15T09:00:00Z")]);
  beat({ now, agents: [h] });
  assert.equal(els.ended.innerHTML, "", "nothing ended — that transcript is live");
});

test("resuming a scanned transcript posts to resumeTranscript with its origin cwd", () => {
  const { beat, resumeEnded, posts } = loadPage();
  const { now, host: h } = host([]);
  withResumable(h, [resumable("t-abc", "Recovered", "2026-07-15T09:00:00Z")]);
  beat({ now, agents: [h] });

  // No registry record exists to `resume` or `start` — the transcript is the only
  // handle, and the agent re-creates its origin dir if a prune removed it.
  resumeEnded(click, "t:t-abc");
  assert.deepEqual(posts.map((p) => p.url),
    ["/api/agents/hostA/transcripts/t-abc/resume"]);
  assert.deepEqual(posts[0].body, { cwd: "/g/.turma/worktrees/repoX/t-abc" });
});

test("a resumed transcript is followed onto the stage under its new id", async () => {
  const { beat, resumeEnded, opened } = loadPage({ postReply: { ok: true, cmdId: "cmd-9" } });
  const { now, host: h } = host([]);
  withResumable(h, [resumable("t-abc", "Recovered", "2026-07-15T09:00:00Z")]);
  beat({ now, agents: [h] });

  resumeEnded(click, "t:t-abc");
  assert.deepEqual(opened, [], "nothing to open until the agent relaunches it");
  await new Promise((r) => setImmediate(r)); // let the POST's reply land

  // Unlike a killed session, this comes back under an id the agent mints, so the
  // page can only recognise it by the cmdId its own POST was answered with.
  h.repos = [{ name: "repoX", resumable: [] }];
  h.sessions = [{ ...working("99999", "Recovered"), spawnCmdId: "cmd-9" }];
  beat({ now, agents: [h] });
  assert.deepEqual(opened, ["99999"]);
});

test("Resume is disabled while its host is offline, but the card still opens", () => {
  const { beat, els } = loadPage();
  const { now, host: h } = host([]);
  h.online = false;
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z")];
  beat({ now, agents: [h] });

  const e = els.ended.innerHTML;
  // Resume rides the heartbeat, so it needs the host. Reading the conversation
  // does not — the hub archived it — so the card itself stays clickable.
  assert.match(e, /<button class="s-resume" disabled/);
  assert.match(e, /onclick="openEndedSession\('33333'\)"/);
  assert.ok(!/class="s-card ended[^"]*" disabled/.test(e), "card must stay clickable offline");
});

test("resumeEnded is a no-op for an offline host", () => {
  const { beat, resumeEnded, posts } = loadPage();
  const { now, host: h } = host([]);
  h.online = false;
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z")];
  beat({ now, agents: [h] });
  resumeEnded(click, "33333");
  assert.deepEqual(posts, [], "no command can be queued on a host that can't take it");
});

// --- ?ended=<transcriptId>: the board's ticket chips deep-link here -----------
// A chip for a session that isn't running can't use ?session=, whose wait only
// ever resolves a RUNNING session and would park the stage on "Opening session…"
// indefinitely. It keys on the transcript id because that is the one handle all
// three ended channels share — a resumable row's entry id is a synthesised
// "t:<id>", a killed one's is the session's own.

// The transcript pane's title is only ever fetched from inside openEndedSession,
// and the DOM shim materialises an element the first time the page asks for it —
// so #trTitle's presence is what says an ended view was really opened. (The pane
// itself is a module-level const, created at load and `hidden: false` by shim
// default, so it can't stand in for this either way.)
const openedEnded = (els) => els.trTitle !== undefined;

test("?ended= opens a KILLED session's read-only view", () => {
  const { beat, els } = loadPage({ search: "?ended=t-abc" });
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z",
    { transcriptId: "t-abc" })];
  beat({ now, agents: [h] });
  assert.ok(openedEnded(els), "read-only view opened");
  assert.equal(els.trTitle.textContent, "Killed");
  assert.equal(els.transcriptPane.hidden, false);
  assert.equal(els.chatPane.hidden, true);
  assert.equal(els.termPane.hidden, true);
});

test("?ended= opens a session recovered by the transcript scan", () => {
  // The channel with no registry record behind it at all — the one a ticket chip
  // falls back to once closed.json has evicted the session.
  const { beat, els } = loadPage({ search: "?ended=t-zzz" });
  const { now, host: h } = host([]);
  h.sessions = [];
  h.closedSessions = [];
  withResumable(h, [resumable("t-zzz", "Recovered", "2026-07-15T18:00:00Z")]);
  beat({ now, agents: [h] });
  assert.ok(openedEnded(els));
  assert.equal(els.trTitle.textContent, "Recovered");
  assert.equal(els.transcriptPane.hidden, false);
});

test("?ended= waits for the session to be reported rather than reading as empty", () => {
  // A kill is in the very next heartbeat, but a scan-recovered session can take a
  // slow beat — the stage must say it's working, not "No session attached".
  const { beat, els } = loadPage({ search: "?ended=t-not-yet" });
  const { now, host: h } = host([]);
  beat({ now, agents: [h] });
  assert.match(els.stageEmptyBig.innerHTML, /Opening session/);
  assert.ok(!openedEnded(els), "nothing opened on the stage");
});

test("?ended= for an unknown transcript never opens the wrong session", () => {
  const { beat, els } = loadPage({ search: "?ended=t-nope" });
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z",
    { transcriptId: "t-abc" })];
  beat({ now, agents: [h] });
  assert.ok(!openedEnded(els), "the one ended session it CAN see is not a match");
});

test("an explicit pick beats a pending ?ended=", () => {
  // Same rule the other two waits follow: an operator who clicks a session means
  // it, and a deep link resolving a beat LATER must not yank them off it.
  const { beat, selectSession, els, opened } = loadPage({ search: "?ended=t-abc" });
  const { now, host: h } = host([running("live1", "Live Task")]);
  beat({ now, agents: [h] });          // ?ended= still unresolved — nothing to open
  selectSession("live1");              // ...so the operator picks one by hand
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z",
    { transcriptId: "t-abc" })];       // and now the killed session lands
  beat({ now, agents: [h] });

  assert.deepEqual(opened, ["live1"]);
  assert.equal(els.chatPane.hidden, false, "stayed on the session they chose");
  assert.equal(els.transcriptPane.hidden, true);
});

test("opening an ended session shows PRs + Resume and never a terminal or compose box", () => {
  const { beat, openEndedSession, els } = loadPage();
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z", {
    transcriptId: "t-abc",
    prs: [{ url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN", checks: "failing" }],
  })];
  beat({ now, agents: [h] });
  openEndedSession("33333");

  // The read-only transcript pane — not the chat pane (compose box) and not the
  // terminal pane. That IS the "no textbox, no terminal" requirement.
  assert.equal(els.transcriptPane.hidden, false);
  assert.equal(els.chatPane.hidden, true);
  assert.equal(els.termPane.hidden, true);
  assert.equal(els.trResume.hidden, false, "Resume offered on the stage");
  assert.equal(els.trPrs.hidden, false);
  // On the stage the chips ARE links — nothing wraps them, so a PR can be clicked
  // through to GitHub, which is often the reason to open an ended session at all.
  assert.match(els.trPrs.innerHTML, /<a href="https:\/\/github.com\/o\/r\/pull\/7"/);
  assert.match(els.trPrs.innerHTML, /#7 Open/);
});

// XERK-356. A refused archive push never arrives, so the reassuring "it syncs
// within a few minutes of ending" is a promise nothing will keep — and the
// operator waits for a conversation that is not coming. The hub says WHY on the
// 404; this pane is where that reaches a person.
test("an archive push the hub refused is worded as a refusal, not as 'not yet'", async () => {
  const { beat, openEndedSession, els, setGet } = loadPage();
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z", { transcriptId: "t-abc" })];
  beat({ now, agents: [h] });

  // First the ordinary case: a 404 with nothing to say is still "not here yet".
  setGet((url) => url.startsWith("/api/archive/")
    ? { ok: false, status: 404, json: async () => ({ error: "unknown transcript" }) } : null);
  openEndedSession("33333");
  await new Promise((r) => setImmediate(r));
  assert.match(els.trScroll.innerHTML, /hasn't reached the archive yet/);

  // Then the refusal: the hub's own words, and no promise that it will sync.
  setGet((url) => url.startsWith("/api/archive/")
    ? { ok: false, status: 404, json: async () => ({
        error: "unknown transcript",
        refused: { host: "nas", at: 1, error: "archive chunk is larger than this hub takes (1048576 bytes)" },
      }) } : null);
  openEndedSession("33333");
  await new Promise((r) => setImmediate(r));
  assert.match(els.trScroll.innerHTML, /nas&rsquo;s last push/);
  assert.match(els.trScroll.innerHTML, /larger than this hub takes/);
  assert.doesNotMatch(els.trScroll.innerHTML, /within a few minutes/);
  // Resume is unaffected — the worktree is still there whatever the archive holds.
  assert.match(els.trScroll.innerHTML, /Resume still works/);
});

test("the ended-session bar is cleared when the pane is reused for an archive transcript", () => {
  const { beat, openEndedSession, openTranscript, els } = loadPage();
  const { now, host: h } = host([]);
  h.closedSessions = [closed("33333", "Killed", "2026-07-15T09:00:00Z", {
    transcriptId: "t-abc", prs: [{ url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN" }],
  })];
  beat({ now, agents: [h] });
  openEndedSession("33333");
  assert.equal(els.trResume.hidden, false);
  assert.equal(els.trPrs.hidden, false);

  // The archive + subagent views share this one pane. A search result is a
  // transcript, not a live registry record, so it has nothing to resume — a
  // Resume button left over from the previous view would act on the wrong
  // session entirely.
  openTranscript("t-other", "Some Archived Session", null);
  assert.equal(els.trResume.hidden, true, "Resume cleared for the archive view");
  assert.equal(els.trPrs.hidden, true, "PR chips cleared for the archive view");
  assert.equal(els.trPrs.innerHTML, "");
});

// --- composer survives the poll/SSE re-render --------------------------------
// Both of these guard the same hazard from opposite sides: render() rebuilds the
// whole spawn panel with innerHTML on every heartbeat, and anything the browser
// owns rather than our markup (an inline height the resize handle wrote, the
// sidebar's scroll offset) is collateral damage unless render() carries it over.

test("a Task box dragged taller keeps its height across a re-render", () => {
  // The composer already on screen, as the resize handle left it.
  const dragged = { style: { height: "160px" }, dataset: { rk: "hostA::repoX" } };
  const { beat, toggleComposer, els } = loadPage({ textareas: [dragged] });
  const { now, host: h } = host([]);
  beat({ now, agents: [h] });
  toggleComposer("hostA::repoX", "repoX");
  assert.ok(els.spawn.innerHTML.includes('id="cmp-task-hostA__repoX"'), "composer is open");

  beat({ now, agents: [h] }); // the heartbeat that used to snap it back to min-height
  assert.match(els.spawn.innerHTML, /style="height:160px"/);
});

test("a scrolled-down Task box keeps its offset across a re-render", () => {
  // A composer already on screen, scrolled past its first screen of typed text.
  const box = { style: {}, dataset: { rk: "hostA::repoX" }, scrollTop: 0 };
  const { beat, toggleComposer, els } = loadPage({ textareas: [box] });
  const { now, host: h } = host([]);
  beat({ now, agents: [h] });
  toggleComposer("hostA::repoX", "repoX");

  box.scrollTop = 96;                                // operator types past the fold
  els.spawn._onHtml = () => { box.scrollTop = 0; };  // the swap rebuilds the box at the top
  beat({ now, agents: [h] }); // the heartbeat that used to yank the text back up

  assert.equal(box.scrollTop, 96, "render must restore the offset the swap dropped");
});

test("a scrolled sidebar stays put across a re-render", () => {
  const sidebar = { scrollTop: 0 };
  const { beat, els } = loadPage({ sidebar });
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });

  sidebar.scrollTop = 240;                       // operator scrolls down
  els.spawn._onHtml = () => { sidebar.scrollTop = 0; }; // browser clamps while the panel is empty
  beat({ now, agents: [h] });

  assert.equal(sidebar.scrollTop, 240, "render must restore the offset the swap clamped away");
});

// The session header's meta line (XERK-121): host is prefixed by each header's
// caller, so sessMeta returns "repo · branch" — matching the Android chat header
// (core/Sessions.kt sessionHeaderMeta).
test("sessMeta shows the repo and branch, dropping blanks", () => {
  const { sessMeta } = loadPage();
  assert.equal(sessMeta({ repo: "Turma", git: { branch: "XERK-121" } }), "Turma · XERK-121");
  // A not-yet-branched (or transcript-recovered without git) session: branch
  // reads "detached" only when a git block is present.
  assert.equal(sessMeta({ repo: "Turma", git: { branch: "HEAD" } }), "Turma · detached");
  assert.equal(sessMeta({ repo: "Turma" }), "Turma");
  // Repos-root sessions have no repo/branch of their own.
  assert.equal(sessMeta({ root: true, repo: "" }), "repos root");
});

// --- local-model failover, on the page you actually scan (XERK-246) ----------
// A session on the self-hosted model is running a much weaker model, so it must
// never be indistinguishable from a subscription one at a glance.

test("local mark: shown on a live card running the self-hosted model, not on its neighbour", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    { ...working("11111", "On local"), modelSource: "local",
      modelSourceAt: "2026-08-10T12:00:00Z" },
    { ...working("22222", "On subscription"), modelSource: "subscription" },
  ]);
  render({ now, agents: [h] });
  const a = els.active.innerHTML;
  assert.equal((a.match(/local-mark/g) || []).length, 1,
    "exactly one card carries the mark");
  // The marked card is the local one: the mark sits inside the same card body,
  // ahead of the next card's title.
  const localAt = a.indexOf("On local"), subAt = a.indexOf("On subscription");
  const markAt = a.indexOf("local-mark");
  const [first, second] = localAt < subAt ? [localAt, subAt] : [subAt, localAt];
  const markBelongsToFirst = markAt > first && markAt < second;
  assert.equal(markBelongsToFirst, localAt === first,
    "the mark belongs to the local session's card");
});

test("local mark: shown on an ENDED row — reading the transcript is when it matters", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([]);
  h.closedSessions = [
    { id: "99999", repo: "repoX", summary: "Killed on local", modelSource: "local",
      closedAt: new Date(now - 60000).toISOString(), worktreePath: "/w/x" },
  ];
  render({ now, agents: [h] });
  assert.match(els.ended.innerHTML, /local-mark/);
});

test("local mark: absent when the session never left the subscription", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([working("11111", "Plain")]);
  render({ now, agents: [h] });
  assert.doesNotMatch(els.active.innerHTML, /local-mark/);
});

test("composer: 'Run against' appears only when the host reports a local model", () => {
  // Without this control an operator can fail EXISTING sessions over but cannot
  // start any new work once usage is gone, which is half the point.
  const open = (h) => {
    const page = loadPage();
    const { now } = host([]);
    page.setCache({ now, agents: [h] });
    page.render({ now, agents: [h] });
    page.toggleComposer("hostA::repoX", "repoX");    // open the repo's composer
    return page.els.spawn.innerHTML;
  };
  const withLocal = open({
    key: "hostA", device: "hostA", online: true, terminalOnline: true,
    lastSeen: Date.now(), repos: [{ name: "repoX" }], sessions: [],
    localModel: { available: true, model: "gpt-oss:120b" },
  });
  assert.match(withLocal, /Run against/);
  assert.match(withLocal, /gpt-oss:120b/, "names the host's actual model");

  const without = open({
    key: "hostA", device: "hostA", online: true, terminalOnline: true,
    lastSeen: Date.now(), repos: [{ name: "repoX" }], sessions: [],
    localModel: { available: false },
  });
  assert.doesNotMatch(without, /Run against/);
});

test("composer: the chosen 'Run against' actually reaches the spawn request", () => {
  // Rendering the select is not the same as sending it. Without this, the
  // composer silently ignores the choice and new work always starts on the
  // subscription — the half of the feature that matters once usage is gone.
  const spawnWith = (value) => {
    const page = loadPage();
    const now = Date.now();
    const h = {
      key: "hostA", device: "hostA", online: true, terminalOnline: true,
      lastSeen: now, repos: [{ name: "repoX" }], sessions: [],
      localModel: { available: true, model: "gpt-oss:120b" },
    };
    page.setCache({ now, agents: [h] });
    page.render({ now, agents: [h] });
    page.toggleComposer("hostA::repoX", "repoX");
    // The page reads its options straight off the DOM by id.
    // cid(rk, field) => "cmp-<field>-<rk with non-alnum replaced by _>".
    // The shim creates elements lazily, so seed the select the page will read.
    page.els["cmp-source-hostA__repoX"] = { value };
    page.startSession("hostA", "repoX");
    return page.posts.find((p) => p.url.endsWith("/sessions"));
  };
  assert.equal(spawnWith("local").body.modelSource, "local");
  // The default is not sent at all, so a host without a local model is unaffected.
  assert.equal(spawnWith("subscription").body.modelSource, undefined);
});

// XERK-162: the sidebar's own prBadgeHtml copy labels a GitLab MR / ADO PR
// with its platform's !n sigil, GitHub with #n. Guarded here because a QA
// mutation pass flipped this copy's sigil back to "#" and every suite stayed
// green — only chat.js's copy was covered.
test("prBadgeHtml: !n for GitLab/ADO, #n for GitHub", () => {
  const { prBadgeHtml } = loadPage();
  assert.match(prBadgeHtml({ url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN" }), /#7/);
  const mr = prBadgeHtml({
    url: "https://gitlab.example.com/grp/app/-/merge_requests/12",
    number: 12, state: "OPEN",
  });
  assert.match(mr, /!12/);
  assert.doesNotMatch(mr, /#12/);
  // The URL fallback (bare {url} chip, no status yet) takes the same sigil.
  assert.match(
    prBadgeHtml({ url: "https://gitlab.example.com/grp/app/-/merge_requests/13" }), /!13/);
  assert.match(
    prBadgeHtml({ url: "https://dev.azure.com/org/P/_git/app/pullrequest/9" }), /!9/);
});

// --- workflow drill-down (XERK-304) ------------------------------------------
// A Workflow row is N agents and has no conversation of its own, so it opens the
// run's agent picker rather than a transcript. `agents` present in the reply —
// the empty list included — is the whole signal.

function liveWorkflowPage() {
  const page = loadPage();
  const { now, host: h } = host([working("s1", "Doing work")]);
  page.beat({ now, agents: [h] });
  page.selectSession("s1");
  return page;
}

test("XERK-304: a workflow row opens the run's agent picker, not an empty transcript", async () => {
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("/subagents/history") ? {
    entries: [],
    agents: [
      { id: "ag1", label: "review:bugs", status: "done" },
      { id: "ag2", label: "verify:auth.ts", status: "running" },
    ],
    agentsTruncated: false,
  } : null);
  await page.openSubagentView("workflow", "code-review");

  const html = page.els.trScroll.innerHTML;
  assert.match(html, /review:bugs/);
  assert.match(html, /verify:auth\.ts/);
  assert.match(html, /data-wfid="ag2"/);
  assert.match(html, /wf-status running/, "a running agent is marked as such");
  assert.equal(page.chat.rendered.length, 0,
    "the run itself has no conversation to render");
  // The list read is the one with no agentId — that is what asks for the run.
  assert.ok(page.gets.some((u) => u.includes("type=workflow") && u.includes("agentId=")),
    "the row is fetched by type + label with an empty agentId");
});

test("XERK-304: a run that has started nothing says so, rather than 'unavailable'", async () => {
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("/subagents/history")
    ? { entries: [], agents: [], agentsTruncated: false } : null);
  await page.openSubagentView("workflow", "code-review");
  assert.match(page.els.trScroll.innerHTML, /hasn't started any agents yet/);
  assert.doesNotMatch(page.els.trScroll.innerHTML, /unavailable/);
});

test("XERK-304: picking one agent renders its transcript and Back returns to the RUN", async () => {
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("agentId=ag1")
    ? { entries: [{ id: "1", role: "user", text: "review it" }] }
    : { entries: [], agents: [{ id: "ag1", label: "review:bugs", status: "done" }] });

  await page.openSubagentView("workflow", "code-review");
  assert.equal(page.chat.rendered.length, 0);

  await page.openSubagentView("workflow", "code-review", "ag1");
  assert.equal(page.chat.rendered.length, 1, "one agent IS a conversation");
  assert.deepEqual(page.chat.rendered[0].entries, [{ id: "1", role: "user", text: "review it" }]);
  assert.equal(page.els.trBackLabel.textContent, " Workflow",
    "Back names the rung it actually returns to");

  // Back from one agent goes to that run's list — the middle rung — and only
  // from there to the session.
  page.transcriptBack();
  await new Promise((r) => setImmediate(r));
  assert.match(page.els.trScroll.innerHTML, /review:bugs/, "back landed on the run's agent list");
  assert.equal(page.els.trBackLabel.textContent, " Session");
});

test("XERK-304: Back is not eaten when the session left the cache", async () => {
  // The run list is fetched from the session's host, so once the session is
  // gone there is no list to return to. The middle rung used to consume the
  // press anyway and leave the pane exactly as it was, still labelled Workflow.
  //
  // setCache WITHOUT render is the real race and the only setup that reaches
  // the guard: a render() of a fleet the session has left tears the stage down
  // on its own, clearing both rungs before Back is ever pressed — so a beat()
  // here would pass whether or not the guard exists.
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("agentId=ag1")
    ? { entries: [{ id: "1", role: "user", text: "review it" }] }
    : { entries: [], agents: [{ id: "ag1", label: "review:bugs", status: "done" }] });
  await page.openSubagentView("workflow", "code-review", "ag1");
  assert.equal(page.els.trBackLabel.textContent, " Workflow");
  assert.equal(page.els.transcriptPane.hidden, false);

  const { now, host: h } = host([]);   // the session ends; the stage still shows it
  page.setCache({ now, agents: [h] });

  page.transcriptBack();
  await new Promise((r) => setImmediate(r));
  assert.equal(page.els.transcriptPane.hidden, true,
    "one press left the subagent stage rather than being swallowed");
  assert.equal(page.els.trBackLabel.textContent, " Sessions");
});

test("XERK-304: an unresolved row reads as unavailable, not as an empty conversation", async () => {
  // No `agents` and no entries means the row did not resolve. Handing that to
  // the chat engine paints "This session's transcript is empty." — the wording
  // for a conversation that exists and is empty, which reads as if the agent
  // simply did nothing.
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("/subagents/history") ? { entries: [] } : null);
  await page.openSubagentView("workflow", "no-such-run");
  assert.equal(page.chat.rendered.length, 0, "nothing was handed to the chat engine");
  assert.match(page.els.trScroll.innerHTML, /Agent transcript unavailable/);
});

test("XERK-304: landing on a chat retires both subagent rungs", async () => {
  // They point at the session just left, and the next route that reveals the
  // transcript pane would follow them there.
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("agentId=ag1")
    ? { entries: [{ id: "1", role: "user", text: "review it" }] }
    : { entries: [], agents: [{ id: "ag1", label: "review:bugs", status: "done" }] });
  await page.openSubagentView("workflow", "code-review", "ag1");

  page.selectSession("s1");                 // back to the live chat
  page.transcriptBack();                    // must NOT re-enter the run list
  await new Promise((r) => setImmediate(r));
  assert.doesNotMatch(page.els.trScroll.innerHTML, /review:bugs/,
    "a retired rung must not reopen the run it pointed at");
});

test("XERK-304: an ordinary agent row is untouched — no picker, straight to its transcript", async () => {
  const page = liveWorkflowPage();
  page.setGet((url) => url.includes("/subagents/history")
    ? { entries: [{ id: "1", role: "assistant", text: "found it" }] } : null);
  await page.openSubagentView("Explore", "Map the code");
  assert.equal(page.chat.rendered.length, 1);
  assert.equal(page.els.trBackLabel.textContent, " Session");
});

test("Restore is not offered on a row that can never be restored", () => {
  // Most of the archive is not restorable: `repo == "(root)"` is the agent's
  // catch-all for a cwd it could not attribute, so those rows record a
  // `~/.claude/projects/<slug>` transcript store — 1246 of the 1537 restorable
  // rows on the production hub. A picker that always 409s is a worse failure
  // than no picker, and the route refuses each of these anyway.
  const { beat, showRestore, els } = loadPage();
  beat(restoreFleet([
    { key: "hostB", device: "hostB", online: true, lastSeen: Date.now(),
      repos: [{ name: "repoX" }, { name: "(root)" }], sessions: [] },
  ]));
  for (const [why, wt] of Object.entries({
    "a transcript store": "/root/.claude/projects/-mnt-data-Docker-git-Turma",
    "a transcript store, exactly": "/root/.claude/projects",
    "a traversal": "/repos/.turma/worktrees/repoX/..",
    "nothing recorded": "",
  })) {
    showRestore({ ...archived, repo: "(root)", worktree: wt });
    assert.equal(els.trRestoreWrap.hidden, true, why);
  }
  // And a row that CAN be restored still gets it — including a root session,
  // whose cwd is the source host's REPOS_ROOT and has no worktree tail.
  for (const wt of ["/repos/.turma/worktrees/repoX/ab12c", "/home/me/git", "/repos/.claude/x/y"]) {
    showRestore({ ...archived, worktree: wt });
    assert.equal(els.trRestoreWrap.hidden, false, wt);
  }
});
