// Unit test for TurmaChat.open()'s seed paint on a session switch (XERK-604).
// The freeze bug was that open() painted through the SAME mid-selection defer
// ordinary live repaints use, so a stale selection left in the OUTGOING
// transcript held back the INCOMING session's first paint — the header updated
// (setHeader) while the chat stayed frozen on the previous session. The fix is
// open() forcing its seed paint (repaint(true)).
//
// chat-selection.test.js already locks repaint(force) in isolation, but NOT the
// call site: reverting open() to an unforced repaint() reintroduces the exact
// freeze while that file stays green. This drives the REAL open() end-to-end so
// the wiring itself is pinned. node:test, no npm — chat.js against DOM/net shims.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- shims (installed before chat.js is required) ----------------------------
let scroll, selection;

function makeEl(id) {
  return {
    id, _html: "", writes: 0,
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    dataset: {}, hidden: false,
    set innerHTML(v) { this._html = v; this.writes++; },
    get innerHTML() { return this._html; },
    contains: (node) => !!(node && node.inScroll),
    addEventListener() {},
    querySelectorAll: () => [],
  };
}

globalThis.document = {
  // Only #chatScroll is real; every other lookup is null, and open()'s helpers
  // (setHeader, renderComposeOpts, verbosity control) are all null-guarded.
  getElementById: (id) => (id === "chatScroll" ? scroll : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = { getSelection: () => selection, addEventListener() {} };
globalThis.location = { origin: "https://hub.example" };
// open() kicks off loadHistory()/startWs() (async, irrelevant to the seed paint)
// and startPollFallback() (an interval). Keep them harmless; close() stops them.
globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ entries: [], token: "t", expiresInSec: 300 }) });
class FakeSocket { constructor() { this.readyState = 0; } close() { this.readyState = 3; } }
FakeSocket.OPEN = 1;
globalThis.WebSocket = FakeSocket;
globalThis.localStorage = { getItem: () => null, setItem() {} };

const chat = require("../public/chat.js");
const open = globalThis.window.TurmaChat.open;
const close = globalThis.window.TurmaChat.close;

function selectInside() {
  selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => ({ collapsed: false, commonAncestorContainer: { inScroll: true } }),
  };
}
function sessWithTail(id, text) {
  return { id, session: { tail: [{ id: id + "-a", role: "assistant", text, blocks: [{ t: "text", text }] }] } };
}

test.beforeEach(() => {
  scroll = makeEl("chatScroll");
  selection = { isCollapsed: true, rangeCount: 0, getRangeAt: () => null };
});
// open() starts a poll interval + a live socket; close() stops both. Run it in
// afterEach so a FAILING assertion still tears them down — otherwise a dangling
// setInterval keeps the node:test process alive and the run hangs instead of
// reporting the failure.
test.afterEach(() => { try { close(); } catch {} });

// The exact XERK-604 scenario: a live selection is anchored in the outgoing
// transcript when the operator opens a different session. open()'s seed paint
// must reach the DOM anyway — a plain repaint() here would DEFER and leave the
// chat frozen on the previous session (with the header already switched).
test("open() paints the incoming session even through a live in-scroll selection", () => {
  // Land on the first session so #chatScroll holds its transcript.
  open("hostA", "s1", sessWithTail("s1", "first session body"), { key: "hostA" });
  assert.match(scroll.innerHTML, /first session body/);
  const writesAfterFirst = scroll.writes;

  // A reader leaves a live selection inside that transcript, then switches.
  selectInside();
  open("hostA", "s2", sessWithTail("s2", "second session body"), { key: "hostA" });

  assert.ok(scroll.writes > writesAfterFirst, "the switch actually repainted #chatScroll");
  assert.match(scroll.innerHTML, /second session body/, "the incoming session reached the DOM (not frozen)");
  assert.doesNotMatch(scroll.innerHTML, /first session body/, "the previous session is gone");
});
