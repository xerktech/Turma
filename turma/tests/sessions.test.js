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
function loadPage({ search = "", sidebar = null, textareas = [] } = {}) {
  const els = {};
  const opened = [];
  const posts = [];
  const chat = { busy: false, stopped: 0 };
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
      if (init && init.method === "POST") posts.push({ url, body: JSON.parse(init.body || "{}") });
      return new Promise(() => {});
    },
    EventSource: class { addEventListener() {} close() {} static get CLOSED() { return 2; } },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    history: { replaceState: noop, pushState: noop },
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
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
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
      + " termComposeAction,"
      + " setCache: (c) => { cache = c; }, setDraft: (t) => { renameDraft = t; } };");
  const api = fn(...names.map((k) => stubs[k]), stubs);
  // One heartbeat, as the page would see it.
  api.beat = (data) => { api.setCache(data); api.render(data); };
  return { ...api, els, opened, posts, chat };
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

  assert.ok(els.stopped.innerHTML.includes("Dead Task"), "stopped section still renders");
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

test("the Ended-sessions archive browser is gone from the sidebar markup", () => {
  // The archive list + its toggle were removed; only the search box remains as
  // the path to ended-session history. Guards against a regression re-adding it.
  assert.ok(!html.includes("Ended sessions"), "no 'Ended sessions' header");
  assert.ok(!/id="archiveWrap"/.test(html), "no #archiveWrap element");
  assert.ok(!/id="archiveDetails"/.test(html), "no #archiveDetails element");
  assert.ok(/id="idle"/.test(html), "new #idle section present");
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
