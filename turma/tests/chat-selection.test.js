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
globalThis.requestAnimationFrame = () => 1;

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

test("the typewriter reveal idles while text is selected, then resumes", () => {
  chat.__setLiveTurn("streaming answer text");
  chat.repaint();                       // paints the (empty) live bubble, arms revealFull
  const before = bubble.writes;

  // Mid-selection: the reveal must not rewrite the bubble under the reader.
  selectInside();
  chat.tick(1000);
  chat.tick(1016);
  assert.equal(bubble.writes, before, "reveal held the bubble while selecting");
  assert.equal(chat.__revealShown(), 0, "and didn't advance past what's painted");

  // Selection released: typing resumes.
  selectNothing();
  chat.tick(1032);
  assert.ok(bubble.writes > before, "reveal resumed after the selection cleared");
  assert.ok(chat.__revealShown() > 0);
  assert.match(bubble.innerHTML, /^<span class="role">assistant<\/span>s/);
});

// XERK-19: the pane scrape's "last ● bullet" swaps between unrelated blocks as
// tools run (prose -> Bash(…) -> Read(…) -> next prose). Each such swap must
// snap the reveal to the new text — NOT keep typing from the previous block's
// offset, which reads as the last line deleting and re-streaming over and over.
test("a swap to different live-turn text snaps the reveal instead of re-typing", () => {
  // A tool bullet, fully revealed.
  chat.__setLiveTurn("");                       // reset shown to 0
  chat.__setLiveTurnRaw("Bash(ls -la)");        // 12 chars
  chat.__setRevealShown(12);                    // typed all the way out
  chat.repaint();

  // The scrape swaps to a LONGER, unrelated block (the next prose). The old
  // length-only clamp only caught shrinks, so this one kept re-typing from 12.
  chat.__setLiveTurnRaw("Now reading the configuration file in detail"); // 44
  chat.repaint();
  assert.equal(chat.__revealShown(), 44, "swap to longer text snaps, no re-stream");

  // And a swap to a shorter, unrelated block snaps down too (not to 0).
  chat.__setLiveTurnRaw("Read(app.js)");        // 12 chars
  chat.repaint();
  assert.equal(chat.__revealShown(), 12, "swap to shorter text snaps to its length");
});

// The flip side: when the SAME block genuinely grows (real streaming prose),
// the reveal must keep its place and type only the delta, not snap.
test("a genuine continuation of the live turn keeps typing the delta", () => {
  chat.__setLiveTurn("");        // fresh turn: revealFull="", shown=0
  chat.repaint();
  chat.__setLiveTurnRaw("Hello wor");
  chat.repaint();               // arms revealFull="Hello wor" (continuation of "")
  chat.__setRevealShown(5);     // typewriter has revealed "Hello" so far

  chat.__setLiveTurnRaw("Hello world, and here is a lot more prose");
  chat.repaint();
  assert.equal(chat.__revealShown(), 5, "continuation kept its place; the delta types in");
});

// XERK-19 (the real fix): the `turn` frame is classified by applyTurn before it
// ever reaches the reveal, so the pane's block-swap can't drive the bubble.
test("a tool-use bullet clears the streaming bubble instead of showing as text", () => {
  // Prose is streaming and partly revealed.
  chat.__applyTurn("Let me check the config");
  chat.__setRevealShown(10);
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
  chat.__setRevealShown(15);                      // fully typed out
  chat.__applyTurn("Here's the plan, step one");  // 25 — same block, grew
  assert.equal(chat.__liveTurn(), "Here's the plan, step one", "grows to the longer capture");
  assert.equal(chat.__revealShown(), 15, "kept its place; only the delta types");

  // A partial re-capture of the same block (the TUI redrew mid-frame) must be
  // ignored — shrinking then re-growing is the char-level flicker.
  chat.__applyTurn("Here's the");
  assert.equal(chat.__liveTurn(), "Here's the plan, step one", "held the longer text");
  assert.equal(chat.__revealShown(), 15, "reveal offset untouched");
});

test("a genuinely different prose block retypes from zero", () => {
  chat.__applyTurn("First block of prose");
  chat.__setRevealShown(21);
  chat.__applyTurn("An unrelated second block");   // shares no prefix
  assert.equal(chat.__liveTurn(), "An unrelated second block");
  assert.equal(chat.__revealShown(), 0, "new block types in from the start, not a stale offset");
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
