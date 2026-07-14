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
