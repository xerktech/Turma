// Unit tests for the chat scroll's paint guards (public/chat.js repaint()).
// A repaint replaces #chatScroll's innerHTML wholesale, so it destroys any
// selection the reader has made — and a live session repaints ~1s (the `turn`
// frame) whether or not anything changed, which made copying text out of the
// chat impossible. These lock the two guards that fix it: skip the write when
// the HTML is unchanged, and defer a changed write while a selection is live.
// node:test, no npm — no jsdom here, so chat.js's real repaint() is driven
// against a minimal document/window shim.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- minimal DOM shim (installed before chat.js is required) -----------------
let scroll, bubble, selection;

function makeEl(id) {
  return {
    id,
    _html: "",
    writes: 0,             // how many times innerHTML was actually assigned
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    dataset: {}, hidden: false,
    set innerHTML(v) { this._html = v; this.writes++; },
    get innerHTML() { return this._html; },
    // The selection lives inside the scroll iff the shim says so.
    contains: (node) => !!(node && node.inScroll),
    addEventListener() {},
  };
}

globalThis.document = {
  getElementById: (id) => (id === "chatScroll" ? scroll : id === "chatLiveBubble" ? bubble : null),
  // repaint() also repaints the compose button (Send/Stop); no button here.
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = { getSelection: () => selection };

const chat = require("../public/chat.js");

function selectInside() {
  selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => ({ collapsed: false, commonAncestorContainer: { inScroll: true } }),
  };
}
function selectOutside() {
  selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => ({ collapsed: false, commonAncestorContainer: { inScroll: false } }),
  };
}
function selectNothing() {
  selection = { isCollapsed: true, rangeCount: 0, getRangeAt: () => null };
}

function entry(id, text) {
  return { id, role: "user", text, blocks: [{ t: "text", text }] };
}

test.beforeEach(() => {
  scroll = makeEl("chatScroll");
  bubble = makeEl("chatLiveBubble");
  selectNothing();
  chat.__setLiveTurn("");
  chat.__setBuffer([]);
  chat.__setQueued([]);
  chat.__resetPaint();
});

test("an unchanged repaint doesn't touch the DOM (so it can't drop a selection)", () => {
  chat.__setBuffer([entry("a", "hello")]);
  chat.repaint();
  assert.equal(scroll.writes, 1);
  assert.match(scroll.innerHTML, /hello/);

  // The `turn`/poll cadence repainting identical content: no further writes.
  chat.repaint();
  chat.repaint();
  assert.equal(scroll.writes, 1);
});

test("a changed repaint is deferred while text is selected, then flushes", () => {
  chat.__setBuffer([entry("a", "hello")]);
  chat.repaint();
  assert.equal(scroll.writes, 1);

  // The reader starts dragging, and a tail delta lands with genuinely new text.
  selectInside();
  chat.__setBuffer([entry("a", "hello"), entry("b", "world")]);
  chat.repaint();
  assert.equal(scroll.writes, 1, "held the paint while the reader was selecting");
  assert.doesNotMatch(scroll.innerHTML, /world/, "the held paint never reached the DOM");

  // More content keeps arriving mid-selection — still held.
  chat.__setBuffer([entry("a", "hello"), entry("b", "world"), entry("c", "again")]);
  chat.repaint();
  assert.equal(scroll.writes, 1);

  // Reader clicks away: the flush that selectionchange triggers.
  selectNothing();
  chat.repaint();
  assert.equal(scroll.writes, 2, "flushed once the selection collapsed");
  assert.match(scroll.innerHTML, /hello/);
  assert.match(scroll.innerHTML, /world/, "the flush paints the content that arrived during the hold");
  assert.match(scroll.innerHTML, /again/);
});

// XERK-604: a session SWITCH must paint the incoming transcript even if a stale
// selection is still live in the outgoing one. open()'s seed paint calls
// repaint(true), which bypasses the mid-selection defer — otherwise the header
// updated while the chat stayed frozen on the previous session, and every
// further switch re-deferred against the same selection until a page reload.
test("a forced repaint paints through a live in-scroll selection (session switch)", () => {
  chat.__setBuffer([entry("a", "old session")]);
  chat.repaint();
  assert.equal(scroll.writes, 1);

  // A selection is left live inside the (outgoing) transcript, and we switch to a
  // different session whose seed content is genuinely different.
  selectInside();
  chat.__setBuffer([entry("z", "new session")]);
  chat.repaint(true);
  assert.equal(scroll.writes, 2, "the forced paint is NOT held by the selection");
  assert.match(scroll.innerHTML, /new session/, "the incoming session reached the DOM");
  assert.doesNotMatch(scroll.innerHTML, /old session/);

  // And an UNFORCED repaint still defers while the selection is live — the guard
  // that makes copy reliable is unchanged for in-place live repaints.
  chat.__setBuffer([entry("z", "new session"), entry("y", "later delta")]);
  chat.repaint();
  assert.equal(scroll.writes, 2, "an ordinary live repaint still holds during selection");
  assert.doesNotMatch(scroll.innerHTML, /later delta/);
});

// XERK-251: the live turn no longer types in — the bubble shows every character
// the classifier accepted, the frame it arrives.
test("the live turn paints in full, with no typewriter holding text back", () => {
  chat.__setLiveTurn("streaming answer text");
  chat.repaint();
  assert.match(scroll.innerHTML, /chatLiveBubble/);
  assert.match(scroll.innerHTML, /streaming answer text/, "the whole capture is on screen at once");

  // A grown capture repaints the whole text again — no partial slice, ever.
  chat.__applyTurn("streaming answer text, now longer");
  chat.repaint();
  assert.match(scroll.innerHTML, /streaming answer text, now longer/);
});

// XERK-19: the pane scrape's "last ● bullet" swaps between unrelated blocks as
// tools run (prose -> Bash(…) -> Read(…) -> next prose). The classifier is what
// keeps those swaps from reading as the last line deleting and re-appearing.
test("a swap to different live-turn text replaces the bubble wholesale", () => {
  chat.__setLiveTurn("Bash(ls -la)");
  chat.repaint();

  // The scrape swaps to a LONGER, unrelated block (the next prose).
  chat.__applyTurn("Now reading the configuration file in detail");
  chat.repaint();
  assert.equal(chat.__liveTurn(), "Now reading the configuration file in detail");
  assert.match(scroll.innerHTML, /Now reading the configuration file in detail/);
  assert.doesNotMatch(scroll.innerHTML, /ls -la/, "the previous block is gone, not merged");
});

// XERK-19 (the real fix): the `turn` frame is classified by applyTurn before it
// reaches the bubble, so the pane's block-swap can't drive it.
test("a tool-use bullet clears the live bubble instead of showing as text", () => {
  chat.__applyTurn("Let me check the config");
  assert.equal(chat.__liveTurn(), "Let me check the config");

  // The pane's last ● bullet swaps to a tool call — the block is done, and the
  // tool renders as a committed card, not raw text here. The bubble clears; it
  // does NOT flash "Bash(…)" (the "line deletes and re-appears" symptom).
  chat.__applyTurn("Bash(git status)");
  assert.equal(chat.__liveTurn(), "", "tool bullet clears the live bubble");

  // The same for an MCP tool and an empty (turn-ended) frame.
  chat.__applyTurn("mcp__github__create_pr(title=fix)");
  assert.equal(chat.__liveTurn(), "");
  chat.__applyTurn("Reading the whole file now");
  assert.equal(chat.__liveTurn(), "Reading the whole file now");
  chat.__applyTurn("");
  assert.equal(chat.__liveTurn(), "");
});

test("the same prose block grows, but a shorter re-capture never shrinks it", () => {
  chat.__applyTurn("Here's the plan");           // 15
  chat.__applyTurn("Here's the plan, step one");  // 25 — same block, grew
  assert.equal(chat.__liveTurn(), "Here's the plan, step one", "grows to the longer capture");

  // A partial re-capture of the same block (the TUI redrew mid-frame) must be
  // ignored — shrinking then re-growing is the char-level flicker.
  chat.__applyTurn("Here's the");
  assert.equal(chat.__liveTurn(), "Here's the plan, step one", "held the longer text");
});

test("a genuinely different prose block replaces the previous one", () => {
  chat.__applyTurn("First block of prose");
  chat.__applyTurn("An unrelated second block");   // shares no prefix
  assert.equal(chat.__liveTurn(), "An unrelated second block");
});

test("isToolBullet matches tool calls, not prose", () => {
  assert.equal(chat.isToolBullet("Bash(ls -la)"), true);
  assert.equal(chat.isToolBullet("Read(app.js)"), true);
  assert.equal(chat.isToolBullet("mcp__srv__do(x=1)"), true);
  assert.equal(chat.isToolBullet("Update(foo.py) ⎿ 3 lines"), true);
  assert.equal(chat.isToolBullet("Let me look at the file."), false);
  assert.equal(chat.isToolBullet("Here is a summary of what I did"), false);
  assert.equal(chat.isToolBullet(""), false);
});

test("a selection outside the scroll doesn't hold the chat's paints", () => {
  chat.__setBuffer([entry("a", "hello")]);
  chat.repaint();
  selectOutside();
  chat.__setBuffer([entry("a", "hello"), entry("b", "world")]);
  chat.repaint();
  assert.equal(scroll.writes, 2);
  assert.match(scroll.innerHTML, /world/);
});

test("selectionInScroll: only a live, in-scroll range counts", () => {
  selectNothing();
  assert.equal(chat.selectionInScroll(), false);
  selectOutside();
  assert.equal(chat.selectionInScroll(), false);
  selectInside();
  assert.equal(chat.selectionInScroll(), true);
  selection = null;
  assert.equal(chat.selectionInScroll(), false);
});

test("the guards leave the committed transcript + live bubble intact", () => {
  chat.__setBuffer([entry("a", "hi")]);
  chat.__setLiveTurn("thinking out loud");
  chat.repaint();
  assert.match(scroll.innerHTML, /hi/, "committed messages still paint");
  assert.match(scroll.innerHTML, /chatLiveBubble/, "the in-progress turn still gets its bubble");
});

test("still-queued prompts trail the live turn as dimmed queued bubbles", () => {
  chat.__setBuffer([entry("a", "start work")]);
  chat.__setLiveTurn("working on it");
  chat.__setQueued(["also do X", "and Y"]);
  chat.repaint();
  const html = scroll.innerHTML;
  assert.match(html, /tr-msg user queued/);
  assert.match(html, /also do X/);
  assert.match(html, /and Y/);
  // Queued bubbles come AFTER the live turn — they run once it finishes.
  assert.ok(html.indexOf("chatLiveBubble") < html.indexOf("also do X"));
  // A frame reporting the queue drained (its prompt became a real user turn)
  // drops the bubbles.
  chat.__setQueued([]);
  chat.__setBuffer([entry("a", "start work"), entry("b", "also do X")]);
  chat.repaint();
  assert.doesNotMatch(scroll.innerHTML, /queued/);
});

test("queued prompts alone defeat the empty-state placeholder", () => {
  chat.__setQueued(["waiting prompt"]);
  chat.repaint();
  assert.doesNotMatch(scroll.innerHTML, /No messages yet/);
  assert.match(scroll.innerHTML, /waiting prompt/);
  chat.__setQueued([]);
});

// ---- the live bubble renders, it isn't just escaped ------------------------
test("the live turn renders inline markdown, not raw escaped text", () => {
  // It used to be esc(liveTurn): no code spans, no links, on the one surface
  // the operator watches while the agent is actually working.
  chat.__setLiveTurn("Reading `file_path` from https://example.com/x — **found** it");
  chat.repaint();
  const html = scroll.innerHTML;
  assert.match(html, /<code class="md-code-inline">file_path<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x"/);
  assert.match(html, /<strong class="md-strong">found<\/strong>/);
});

test("the live turn is renderInline, NOT renderProse (the pane reflows it to one line)", () => {
  // parsePaneLiveTurn joins the pane's wrapped lines into ONE flowed line, so a
  // `##` there lands mid-sentence and must stay literal — a block pass has no
  // line structure to read.
  chat.__setLiveTurn("planning ## next steps - one - two");
  chat.repaint();
  assert.doesNotMatch(scroll.innerHTML, /<h2|<ul|<li/);
  assert.match(scroll.innerHTML, /## next steps/);
});

test("the live turn is still escaped — markup in it can never reach the DOM", () => {
  chat.__setLiveTurn('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  chat.repaint();
  const html = scroll.innerHTML;
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=/);
});

// ---- an ended (static) transcript opens at its newest messages (XERK-2956) --
// A static scroll that records its listeners so a test can fire scroll/load.
function staticScroll(id) {
  const st = makeEl(id);
  const on = {};
  st.addEventListener = (t, fn) => { (on[t] = on[t] || []).push(fn); };
  st.fire = (t) => (on[t] || []).forEach((fn) => fn({ target: {} }));
  st.querySelector = () => null;
  st.querySelectorAll = () => [];
  st.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  return st;
}
const twoEntries = () => [entry("a", "first"), entry("b", "last")];

test("an ended session's transcript opens scrolled to the bottom", () => {
  const st = staticScroll("trScroll");
  window.TurmaChat.renderStatic({ entries: twoEntries(), scrollEl: st, transcriptId: "t1" });
  assert.equal(st.scrollTop, st.scrollHeight);
});

test("an image loading after the paint re-pins a reader parked at the bottom", () => {
  const st = staticScroll("trScroll2");
  window.TurmaChat.renderStatic({ entries: twoEntries(), scrollEl: st, transcriptId: "t1" });
  st.scrollHeight = 1800; // a lazy image below the fold grew the pane
  st.fire("load");
  assert.equal(st.scrollTop, 1800);
});

test("a reader who scrolled up is not yanked back down by a late image", () => {
  const st = staticScroll("trScroll3");
  window.TurmaChat.renderStatic({ entries: twoEntries(), scrollEl: st, transcriptId: "t1" });
  st.scrollTop = 100; st.fire("scroll");
  st.scrollHeight = 1800; st.fire("load");
  assert.equal(st.scrollTop, 100);
});

test("a search-hit open still lands on its hit, not the bottom", () => {
  const st = staticScroll("trScroll4");
  window.CSS = globalThis.CSS = { escape: (s) => s }; // chat.js checks window.CSS, then calls CSS.escape
  // The hit sits 900px down; centring it in the 400px pane scrolls to 725.
  st.querySelector = () => ({ offsetHeight: 50, getBoundingClientRect: () => ({ top: 900 }),
    classList: { add() {}, remove() {} } });
  window.TurmaChat.renderStatic({ entries: [entry("a", "x")], scrollEl: st, transcriptId: "t2", scrollUuid: "a" });
  assert.equal(st.scrollTop, 725);
  st.scrollHeight = 1800; st.fire("load"); // nor pulled to the bottom by a late image
  assert.equal(st.scrollTop, 725);
  delete window.CSS; delete globalThis.CSS;
});

test("a verbosity change mid-transcript keeps the first message in view, not a tall group above it", () => {
  // The pane's top is y=0. A folded thought group starts 2000px above it and
  // runs into view; the first message whose top is in view is "m21" at +30.
  const st = staticScroll("trScroll5");
  st.scrollHeight = 20000;
  const rects = { g: { top: -2000, bottom: 380 }, m21: { top: 30, bottom: 90 } };
  const node = (u) => ({ dataset: { uuid: u }, getBoundingClientRect: () => rects[u] });
  st.querySelectorAll = () => [node("g"), node("m21")];
  st.querySelector = (sel) => (sel.includes('"m21"') ? node("m21") : null);
  const buttons = [];
  const verb = { set innerHTML(v) {}, querySelectorAll: () => ["concise", "normal", "verbose"].map((n) => {
    const b = { getAttribute: () => n, addEventListener: (t, fn) => { b.click = fn; } };
    buttons.push(b); return b;
  }) };
  window.CSS = globalThis.CSS = { escape: (s) => s }; // chat.js checks window.CSS, then calls CSS.escape
  window.TurmaChat.renderStatic({ entries: twoEntries(), scrollEl: st, verbHost: verb, transcriptId: "t5" });
  st.scrollTop = 5000; st.fire("scroll"); // the reader parks mid-transcript
  // The re-render moves m21 down 700px.
  Object.defineProperty(st, "innerHTML", { set() { rects.m21 = { top: 730, bottom: 790 }; }, get() { return ""; } });
  buttons.find((b) => b.getAttribute() === "verbose").click();
  assert.equal(st.scrollTop, 5700, "m21 is back at +30, not the group's -2000");
  delete window.CSS; delete globalThis.CSS;
});

test("a pane un-hidden after a hidden render re-pins to the bottom", () => {
  let observed = null;
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { observed = this.cb; } };
  const st = staticScroll("trScroll6");
  st.scrollHeight = 0; // hidden: nothing to scroll
  window.TurmaChat.renderStatic({ entries: twoEntries(), scrollEl: st, transcriptId: "t6" });
  st.scrollHeight = 2400; // laid out again
  observed();
  assert.equal(st.scrollTop, 2400);
  delete globalThis.ResizeObserver;
});
