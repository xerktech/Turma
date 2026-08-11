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
