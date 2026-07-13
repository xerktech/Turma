// Unit tests for the native chat engine's pure core (public/chat.js): the
// transcript merge (grow-only, rich-beats-text) and the entry->display-item
// builder (bubble grouping + tool_use/tool_result pairing). node:test, no npm —
// matches this package's zero-dependency stance. The DOM/streaming/verbosity
// paths are exercised manually (see the plan's E2E checklist); this locks the
// logic that decides what the chat actually shows.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTail, weight, buildItems, itemsToHtml, __setVerbosity } = require("../public/chat.js");

const PRESETS = {
  concise: { thinking: false, tools: false, outputs: false },
  normal:  { thinking: false, tools: true,  outputs: false },
  verbose: { thinking: true,  tools: true,  outputs: true },
};
function withVerbosity(preset, run) {
  __setVerbosity({ preset, show: { ...PRESETS[preset] } });
  return run();
}

test("mergeTail: appends new ids oldest-first, dedups, preserves order", () => {
  const a = mergeTail([], [
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "yo" },
  ]);
  assert.deepEqual(a.map((e) => e.id), ["u1", "a1"]);
  const b = mergeTail(a, [{ id: "a2", role: "assistant", text: "more" }]);
  assert.deepEqual(b.map((e) => e.id), ["u1", "a1", "a2"]);
});

test("mergeTail: rich (has blocks) upgrades a text-only seed at equal text length", () => {
  const seed = [{ id: "a1", role: "assistant", text: "answer" }]; // heartbeat seed, no blocks
  const rich = [{ id: "a1", role: "assistant", text: "answer", blocks: [{ t: "text", text: "answer" }] }];
  const merged = mergeTail(seed, rich);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].blocks && merged[0].blocks.length, "rich delta must replace the text-only seed");
});

test("mergeTail: grow-only — a shorter/truncated preview never clobbers a fuller copy", () => {
  const full = [{ id: "a1", role: "assistant", text: "the full long answer" }];
  const preview = [{ id: "a1", role: "assistant", text: "the full" }];
  const merged = mergeTail(full, preview);
  assert.equal(merged[0].text, "the full long answer");
});

test("mergeTail: history (looser caps, higher weight) replaces the live copy", () => {
  const live = [{ id: "a1", role: "assistant", text: "", blocks: [{ t: "tool_result", text: "short", truncated: true }] }];
  const hist = [{ id: "a1", role: "assistant", text: "", blocks: [{ t: "tool_result", text: "short but much longer output" }] }];
  const merged = mergeTail(live, hist);
  assert.equal(merged[0].blocks[0].text, "short but much longer output");
  assert.ok(weight(hist[0]) > weight(live[0]));
});

test("buildItems: user text -> right bubble; assistant text+tool_use pairs its result", () => {
  const entries = [
    { id: "u1", role: "user", blocks: [{ t: "text", text: "run ls" }] },
    { id: "a1", role: "assistant", blocks: [
      { t: "text", text: "sure" },
      { t: "tool_use", id: "t1", name: "Bash", input: "ls" },
    ] },
    // The tool_result lands in the NEXT (user-role) entry — it must fold into
    // the action card above, NOT render as a user bubble.
    { id: "r1", role: "user", blocks: [{ t: "tool_result", forId: "t1", text: "file.txt" }] },
  ];
  const items = buildItems(entries);
  assert.deepEqual(items.map((i) => i.kind), ["msg", "msg", "action"]);
  assert.equal(items[0].role, "user");
  assert.equal(items[0].text, "run ls");
  assert.equal(items[1].role, "assistant");
  assert.equal(items[1].text, "sure");
  assert.equal(items[2].name, "Bash");
  assert.equal(items[2].input, "ls");
  assert.deepEqual(items[2].result, { text: "file.txt", isError: false, truncated: false });
  // No user bubble was produced for the tool_result-only turn.
  assert.ok(!items.some((i) => i.kind === "msg" && i.role === "user" && i.text === "file.txt"));
});

test("buildItems: thinking becomes its own item; error results flagged", () => {
  const items = buildItems([
    { id: "a1", role: "assistant", blocks: [
      { t: "thinking", text: "hmm" },
      { t: "tool_use", id: "t1", name: "Bash", input: "boom" },
    ] },
    { id: "r1", role: "user", blocks: [{ t: "tool_result", forId: "t1", text: "err", isError: true }] },
  ]);
  assert.equal(items[0].kind, "thinking");
  assert.equal(items[0].text, "hmm");
  assert.equal(items[1].kind, "action");
  assert.equal(items[1].result.isError, true);
});

test("buildItems: an orphan tool_result (no matching tool_use) renders standalone", () => {
  const items = buildItems([
    { id: "r1", role: "user", blocks: [{ t: "tool_result", forId: "gone", text: "leftover" }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "action");
  assert.equal(items[0].orphan, true);
  assert.equal(items[0].result.text, "leftover");
});

test("buildItems: text-only entry with no blocks (older agent / seed) still bubbles", () => {
  const items = buildItems([{ id: "a1", role: "assistant", text: "legacy text" }]);
  assert.deepEqual(items, [{ kind: "msg", role: "assistant", id: "a1", text: "legacy text", truncated: false }]);
});

// ---- verbosity-driven HTML rendering -------------------------------------
const SAMPLE = [
  { id: "u1", role: "user", blocks: [{ t: "text", text: "go" }] },
  { id: "a1", role: "assistant", blocks: [
    { t: "thinking", text: "hmm" },
    { t: "text", text: "on it" },
    { t: "tool_use", id: "t1", name: "Bash", input: "ls" },
  ] },
  { id: "r1", role: "user", blocks: [{ t: "tool_result", forId: "t1", text: "out.txt" }] },
];

test("render: user bubble is right-aligned (.tr-msg.user), assistant left (.tr-msg.assistant)", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems(SAMPLE)));
  assert.match(html, /class="tr-msg user"/);
  assert.match(html, /class="tr-msg assistant"/);
});

test("render: Verbose shows thinking + tool card open; Concise hides thinking and collapses to a count", () => {
  const items = buildItems(SAMPLE);
  const verbose = withVerbosity("verbose", () => itemsToHtml(items));
  assert.match(verbose, /class="thought"/);            // thinking shown
  assert.match(verbose, /class="action-card ok"[^>]* open>/); // output expanded, ok status
  assert.match(verbose, /out\.txt/);                   // tool output present

  const concise = withVerbosity("concise", () => itemsToHtml(items));
  assert.doesNotMatch(concise, /class="thought"/);   // thinking hidden
  assert.match(concise, /class="actions-group"/);    // collapsed run
  assert.match(concise, /1 action/);                 // count row
});

test("render: Normal shows tool cards but collapsed (no open attr), no thinking", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems(SAMPLE)));
  assert.match(html, /class="action-card ok"/);
  assert.doesNotMatch(html, /class="action-card ok"[^>]* open>/); // outputs collapsed
  assert.doesNotMatch(html, /class="thought"/);
});

test("render: an error result gets the .err class on its card", () => {
  const items = buildItems([
    { id: "a1", role: "assistant", blocks: [{ t: "tool_use", id: "t1", name: "Bash", input: "boom" }] },
    { id: "r1", role: "user", blocks: [{ t: "tool_result", forId: "t1", text: "nope", isError: true }] },
  ]);
  const html = withVerbosity("verbose", () => itemsToHtml(items));
  assert.match(html, /class="action-card err"/);
});

test("render: a truncated block emits a Show more button carrying its entry id", () => {
  const items = buildItems([
    { id: "a9", role: "assistant", blocks: [{ t: "text", text: "loooong", truncated: true }] },
  ]);
  const html = withVerbosity("verbose", () => itemsToHtml(items));
  assert.match(html, /class="trunc" data-eid="a9"/);
});

test("render: HTML in transcript text is escaped (no injection)", () => {
  const items = buildItems([{ id: "x", role: "assistant", blocks: [{ t: "text", text: "<script>alert(1)</script>" }] }]);
  const html = withVerbosity("verbose", () => itemsToHtml(items));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
