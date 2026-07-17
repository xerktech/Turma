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
    closest() { return null; }, focus() {}, blur() {}, select() {}, setAttribute() {}, getAttribute() { return null; },
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
function loadPage({ search = "", sidebar = null, textareas = [], postReply = null, narrow = false } = {}) {
  const els = {};
  const opened = [];
  const posts = [];
  const chat = { busy: false, stopped: 0 };
  // Window-level listeners the page registers (e.g. popstate), so a test can
  // drive the mobile back-button flow that `history.back()` triggers.
  const winListeners = {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl(id)); },
    querySelector(sel) { return sel === ".sidebar" ? sidebar : null; },
    querySelectorAll(sel) { return sel.includes(".composer textarea") ? textareas : []; },
    createElement(tag) { return makeEl("<" + tag + ">"); },
    addEventListener() {}, removeEventListener() {},
    body: makeEl("body"), activeElement: null,
  };
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
        if (postReply) return Promise.resolve({ ok: true, status: 200, json: async () => postReply });
      }
      return new Promise(() => {});
    },
    EventSource: class { addEventListener() {} close() {} static get CLOSED() { return 2; } },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    // pushState/back mirror the browser closely enough to test the mobile stage:
    // enterStage() pushes a state, and backToList()'s history.back() fires the
    // page's popstate handler (which drops the showing-term view).
    history: { replaceState: noop, pushState: noop, back() { (winListeners.popstate || []).forEach((fn) => fn()); } },
    URL: global.URL, URLSearchParams: global.URLSearchParams,
    TurmaChat: {
      open: (hostKey, id) => opened.push(id),
      onPoll: noop, close: noop, closeStatic: noop, renderStatic: noop,
      // The chat engine owns the live busy read and the interrupt; the terminal's
      // compose button just defers to it. `busy` is what a test flips to model a
      // turn being in flight, and `stopped` records the delegation.
      isBusy: () => chat.busy, stop: () => { chat.stopped++; }, actionFailed: noop,
    },
    console, Date, Math, JSON, encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); }, removeEventListener: noop,
    matchMedia: () => ({ matches: narrow, addEventListener: noop }),
    scrollTo: noop, innerWidth: 1200, innerHeight: 800,
  };
  const names = Object.keys(stubs);
  // The trailing return is ours, not the page's: it reaches into the module
  // scope for the handful of functions under test. setCache stands in for the
  // /api/agents fetch that normally fills `cache` before render() — the
  // select-on-arrival path reads it, so a bare render() isn't enough.
  const fn = new Function(...names, "window",
    script + "\n;return { render, selectSession, followSpawn, toggleComposer,"
      + " toggleCardMenu, cardKill, startRename, cancelRename, submitRename,"
      + " termComposeAction, openEndedSession, resumeEnded, openTranscript, backToList,"
      + " setCache: (c) => { cache = c; }, setDraft: (t) => { renameDraft = t; } };");
  const api = fn(...names.map((k) => stubs[k]), stubs);
  // One heartbeat, as the page would see it.
  api.beat = (data) => { api.setCache(data); api.render(data); };
  return { ...api, els, opened, posts, chat, body: document.body };
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

test("running sessions split: working/waiting -> Active, idle -> Idle", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    working("11111", "Working Task"),
    waiting("22222", "Waiting Task"),
    idle("33333", "Idle Task A"),
    running("44444", "Idle Task B", { paneBusy: null, transcriptAgeSec: 9999 }), // stale transcript, unknown paneBusy -> idle
    { id: "55555", status: "stopped", repo: "repoX", summary: "Dead Task" },
  ]);
  render({ now, agents: [h] });

  const a = els.active.innerHTML;
  const i = els.idle.innerHTML;
  assert.match(a, /Active <span class="count">2<\/span>/);
  assert.ok(a.includes("Working Task") && a.includes("Waiting Task"));
  assert.ok(!a.includes("Idle Task A") && !a.includes("Idle Task B"), "idle sessions must not appear under Active");

  assert.match(i, /Idle <span class="count">2<\/span>/);
  assert.ok(i.includes("Idle Task A") && i.includes("Idle Task B"));
  assert.ok(!i.includes("Working Task"), "working sessions must not appear under Idle");

  assert.ok(els.ended.innerHTML.includes("Dead Task"), "ended section still renders");
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

test("desktop: re-selecting the current session stays a no-op", () => {
  const { beat, selectSession, opened } = loadPage(); // narrow:false — desktop
  const { now, host: h } = host([working("11111", "Some Task")]);
  beat({ now, agents: [h] });

  selectSession("11111");
  selectSession("11111");
  assert.deepEqual(opened, ["11111"], "no rebuild when the stage is already visible");
});

// --- the terminal's Send/Stop compose button ---------------------------------
// (The chat pane's own button is chat.js's — see chat.test.js.)

test("terminal compose: Stop delegates to the chat engine while the agent works", () => {
  const { beat, selectSession, termComposeAction, posts, chat } = loadPage();
  const { now, host: h } = host([working("11111", "Long Turn")]);
  beat({ now, agents: [h] });
  selectSession("11111");

  chat.busy = true;
  termComposeAction();
  // One click is the whole interaction — unlike Kill, nothing is destroyed, so
  // there's no arm-then-confirm step. The engine owns the interrupt POST so the
  // two compose buttons can't disagree about the turn's state.
  assert.equal(chat.stopped, 1, "the click stops the turn");
  assert.deepEqual(posts, [], "the page doesn't post the interrupt itself");
});

test("terminal compose: the same button sends the typed message when idle", () => {
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
