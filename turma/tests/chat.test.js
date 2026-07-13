// Unit tests for the native chat engine's pure core (public/chat.js): the
// transcript merge (grow-only, rich-beats-text) and the entry->display-item
// builder (bubble grouping + tool_use/tool_result pairing). node:test, no npm —
// matches this package's zero-dependency stance. The DOM/streaming/verbosity
// paths are exercised manually (see the plan's E2E checklist); this locks the
// logic that decides what the chat actually shows.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTail, weight, buildItems, itemsToHtml, linkify, __setVerbosity } = require("../public/chat.js");

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

test("buildItems: a task_notification block -> an action card, not a user bubble", () => {
  const items = buildItems([{
    id: "n1", role: "user", blocks: [{
      t: "task_notification", summary: 'Agent "CI edits" finished', status: "completed", result: "all green",
    }],
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "action");     // rendered like a tool call, not a msg
  assert.equal(items[0].task, true);
  assert.equal(items[0].name, 'Agent "CI edits" finished');
  assert.equal(items[0].result.text, "all green");
  assert.equal(items[0].result.isError, false);
});

test("buildItems: non-completed task_notification flags its result as an error", () => {
  const items = buildItems([{
    id: "n1", role: "user", blocks: [{ t: "task_notification", summary: "Agent died", status: "failed" }],
  }]);
  assert.equal(items[0].result.isError, true);
  assert.equal(items[0].result.text, "status: failed");
});

test("render: task_notification card carries the task class + glyph, hidden by 'concise'", () => {
  const entries = [{ id: "n1", role: "user", blocks: [{ t: "task_notification", summary: "done", status: "completed", result: "ok" }] }];
  const shown = withVerbosity("normal", () => itemsToHtml(buildItems(entries)));
  assert.match(shown, /class="action-card ok task"/);
  assert.match(shown, /tool-glyph/);
  assert.doesNotMatch(shown, /tr-msg user/); // never a user bubble
  const concise = withVerbosity("concise", () => itemsToHtml(buildItems(entries)));
  assert.doesNotMatch(concise, /action-card/); // Concise hides tool actions (incl. task cards) entirely
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

test("render: Verbose shows thinking + tool card open; Concise hides thinking and omits tool actions entirely", () => {
  const items = buildItems(SAMPLE);
  const verbose = withVerbosity("verbose", () => itemsToHtml(items));
  assert.match(verbose, /class="thought"/);            // thinking shown
  assert.match(verbose, /class="action-card ok"[^>]* open>/); // output expanded, ok status
  assert.match(verbose, /out\.txt/);                   // tool output present

  const concise = withVerbosity("concise", () => itemsToHtml(items));
  assert.doesNotMatch(concise, /class="thought"/);      // thinking hidden
  assert.doesNotMatch(concise, /class="action-card"/);  // no tool cards
  assert.doesNotMatch(concise, /class="actions-group"/); // no collapsed box either
  assert.doesNotMatch(concise, /out\.txt/);             // tool output absent
  assert.match(concise, /class="tr-msg assistant"/);    // message text still shown
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

// ---- linkify (clickable URLs in prose bubbles) ---------------------------
test("linkify: a bare http(s) URL becomes a new-tab anchor", () => {
  const html = linkify("see https://example.com/x for details");
  assert.equal(html,
    'see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a> for details');
});

test("linkify: trailing sentence punctuation stays out of the link", () => {
  assert.equal(linkify("go to https://example.com."),
    'go to <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>.');
  // A URL wrapped in parens keeps the ')' out of the href...
  assert.match(linkify("(https://example.com)"), /href="https:\/\/example\.com"[^>]*>https:\/\/example\.com<\/a>\)/);
  // ...but a balanced paren inside the path is preserved.
  const wiki = linkify("https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.match(wiki, /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});

test("linkify: markdown emphasis markers wrapping a bare URL stay out of the link", () => {
  // Claude emits PR links in bold: **https://.../pull/131** — the ** must not
  // be slurped into the href.
  const html = linkify("PR created: **https://github.com/xerktech/Turma/pull/131**");
  assert.match(html, /href="https:\/\/github\.com\/xerktech\/Turma\/pull\/131"[^>]*>https:\/\/github\.com\/xerktech\/Turma\/pull\/131<\/a>/);
  assert.doesNotMatch(html, /href="[^"]*\*/);
});

test("linkify: markdown [text](url) becomes an anchor with the label as text", () => {
  const html = linkify("opened [PR #42](https://github.com/o/r/pull/42) just now");
  assert.equal(html,
    'opened <a href="https://github.com/o/r/pull/42" target="_blank" rel="noopener noreferrer">PR #42</a> just now');
});

test("linkify: only http/https is linkified; other schemes stay plain escaped text", () => {
  assert.equal(linkify("run javascript:alert(1) now"), "run javascript:alert(1) now");
  // A markdown link to a non-http scheme is NOT turned into an anchor.
  assert.doesNotMatch(linkify("[x](javascript:alert(1))"), /<a /);
});

test("linkify: link label and non-link text are still HTML-escaped (no injection)", () => {
  const html = linkify('<b>hi</b> https://example.com/?a=1&b=2 <script>');
  assert.doesNotMatch(html, /<b>hi<\/b>/);
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;/);
  // Ampersand inside the href is escaped too.
  assert.match(html, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
});

test("linkify: link-free text matches a plain esc()", () => {
  const t = 'plain <text> with "quotes" & ampersand';
  // esc() output for the same string (mirrors chat.js's esc()).
  const escd = t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  assert.equal(linkify(t), escd);
});

test("render: a URL in an assistant bubble is rendered as a clickable link", () => {
  const items = buildItems([{ id: "a1", role: "assistant", blocks: [{ t: "text", text: "PR up: https://github.com/o/r/pull/1" }] }]);
  const html = withVerbosity("normal", () => itemsToHtml(items));
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/1" target="_blank" rel="noopener noreferrer">/);
});
