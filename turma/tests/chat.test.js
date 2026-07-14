// Unit tests for the native chat engine's pure core (public/chat.js): the
// transcript merge (grow-only, rich-beats-text) and the entry->display-item
// builder (bubble grouping + tool_use/tool_result pairing). node:test, no npm —
// matches this package's zero-dependency stance. The DOM/streaming/verbosity
// paths are exercised manually (see the plan's E2E checklist); this locks the
// logic that decides what the chat actually shows.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTail, weight, buildItems, itemsToHtml, linkify, renderProse, prFooterChip, filterModeOpts, MODE_OPTS, __setVerbosity, __setNoExpand } = require("../public/chat.js");

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

// ---- slash-command + compact-summary turns --------------------------------
// Claude Code writes these as USER turns; the chat must not render them as the
// operator typing raw XML. Agent-side parity: agent/tests/test_hub_agent.py
// TestLocalCommand / TestCompactSummary.

test("buildItems: a command block + the output entry after it fold into one card", () => {
  const items = buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact", args: "be brief" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "Compacted" }] },
  ]);
  assert.equal(items.length, 1);                 // the output folded into the invocation
  assert.equal(items[0].kind, "command");
  assert.equal(items[0].name, "/compact");
  assert.equal(items[0].args, "be brief");
  assert.equal(items[0].result.text, "Compacted");
  assert.equal(items[0].result.isError, false);
});

test("buildItems: a command with no output stays a resultless chip", () => {
  const items = buildItems([{ id: "c1", role: "user", blocks: [{ t: "command", name: "/clear" }] }]);
  assert.equal(items[0].kind, "command");
  assert.equal(items[0].args, "");
  assert.equal(items[0].result, null);
});

test("buildItems: stderr output flags the command card as an error", () => {
  const items = buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "No messages", isError: true }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].result.isError, true);
});

test("buildItems: an output with no invocation ahead of it stands alone", () => {
  // A tail window that starts mid-sequence: the command scrolled off.
  const items = buildItems([{ id: "o1", role: "user", blocks: [{ t: "command_output", text: "Compacted" }] }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "command");
  assert.equal(items[0].name, "output");
  assert.equal(items[0].result.text, "Compacted");
});

test("buildItems: a message between a command and an output stops the fold", () => {
  const items = buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact" }] },
    { id: "u1", role: "user", blocks: [{ t: "text", text: "actually wait" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "Compacted" }] },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ["command", "msg", "command"]);
  assert.equal(items[0].result, null);          // never paired across the message
  assert.equal(items[2].name, "output");
});

test("buildItems: a compact_summary is its own item, never a bubble", () => {
  const items = buildItems([{
    id: "s1", role: "assistant", blocks: [{ t: "compact_summary", text: "Summary: we did things" }],
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "compact");
  assert.equal(items[0].text, "Summary: we did things");
});

test("render: a command is a chip on the operator's side, not a bubble, in every verbosity", () => {
  const entries = [
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact", args: "be brief" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "Compacted" }] },
  ];
  for (const preset of ["concise", "normal", "verbose"]) {
    const html = withVerbosity(preset, () => itemsToHtml(buildItems(entries)));
    assert.match(html, /class="cmd-card"/);
    assert.match(html, /\/compact/);
    assert.match(html, /Compacted/);
    // It's the operator's own intent, so unlike a tool card it survives Concise…
    assert.doesNotMatch(html, /tr-msg/);        // …but is never a chat bubble.
  }
});

test("render: a command card collapses its output and flags stderr with .err", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "No messages", isError: true }] },
  ])));
  assert.match(html, /class="cmd-card err"/);
  assert.doesNotMatch(html, /<details[^>]* open>/); // collapsed by default
});

test("render: a compact summary renders collapsed on the assistant's side", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "s1", role: "assistant", blocks: [{ t: "compact_summary", text: "Summary: we did things" }] },
  ])));
  assert.match(html, /class="compact-card"/);
  assert.match(html, /Context compacted/);
  assert.match(html, /Summary: we did things/);
  assert.doesNotMatch(html, /tr-msg user/);     // the bug: never the operator's bubble
  assert.doesNotMatch(html, /<details[^>]* open>/);
});

test("render: HTML in a command / compact turn is escaped (no injection)", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/x", args: "<img src=x onerror=alert(1)>" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "<script>alert(1)</script>" }] },
    { id: "s1", role: "assistant", blocks: [{ t: "compact_summary", text: "<script>alert(2)</script>" }] },
  ])));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("render: a truncated command output / compact summary offers Show more", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "cut", truncated: true }] },
    { id: "s1", role: "assistant", blocks: [{ t: "compact_summary", text: "cut", truncated: true }] },
  ])));
  // The output folds into c1's card but is o1's entry — Show more must re-fetch
  // the entry the text actually came from, not the card it's drawn in.
  assert.match(html, /<button class="trunc" data-eid="o1">/);
  assert.match(html, /<button class="trunc" data-eid="s1">/);
});

test("render: a folded card's truncated ARGS still expand the invocation entry", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact", args: "cut", truncated: true }] },
  ])));
  assert.match(html, /<button class="trunc" data-eid="c1">/);
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

test("render: noExpand (archived view) suppresses the Show more button", () => {
  const items = buildItems([
    { id: "a9", role: "assistant", blocks: [{ t: "text", text: "loooong", truncated: true }] },
  ]);
  __setNoExpand(true);
  try {
    const html = withVerbosity("verbose", () => itemsToHtml(items));
    assert.doesNotMatch(html, /class="trunc"/); // no /history to expand into in the archive
  } finally { __setNoExpand(false); }
});

test("render: bubbles, thinking, and tool cards carry data-uuid for scroll-to-hit", () => {
  // Both the live and archived views scroll a search hit into view by the
  // entry's uuid, so every renderable element must expose data-uuid.
  const html = withVerbosity("verbose", () => itemsToHtml(buildItems(SAMPLE)));
  assert.match(html, /class="tr-msg user" data-uuid="u1"/);
  assert.match(html, /class="tr-msg assistant" data-uuid="a1"/);
  assert.match(html, /class="thought"[^>]*data-uuid="a1"/);
  assert.match(html, /class="action-card ok"[^>]*data-uuid="a1"/);
});

test("render: archive-shaped entries (uuid, no id) still emit a real data-uuid", () => {
  // GET /api/archive/<id> keys the entry on `uuid`, not `id` (the live path maps
  // uuid->id agent-side). buildItems must fall back to `uuid` so scroll-to-hit
  // and per-card persistence keys aren't "undefined" for archived transcripts.
  const archived = [
    { uuid: "au1", role: "user", text: "make it searchable", blocks: [{ t: "text", text: "make it searchable" }] },
    { uuid: "aa1", role: "assistant", text: "added an index", blocks: [
      { t: "thinking", text: "hmm" },
      { t: "text", text: "added an index" },
      { t: "tool_use", id: "b1", name: "Bash", input: "ls" } ] },
  ];
  const html = withVerbosity("verbose", () => itemsToHtml(buildItems(archived)));
  assert.match(html, /class="tr-msg user" data-uuid="au1"/);
  assert.match(html, /class="tr-msg assistant" data-uuid="aa1"/);
  assert.match(html, /class="thought"[^>]*data-uuid="aa1"/);
  assert.match(html, /class="action-card"[^>]*data-uuid="aa1"/);
  assert.doesNotMatch(html, /data-uuid="undefined"/);
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

test("linkify: typographic (curly) quotes wrapping a bare URL stay out of the link", () => {
  // Claude emits curly ‘’ “” around URLs; the closing curly quote must not be
  // slurped into the href (the ASCII '"' peel misses these Unicode chars).
  for (const [open, close] of [["‘", "’"], ["“", "”"]]) {
    const html = linkify("see " + open + "https://github.com/o/r/pull/9" + close + " now");
    assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/9"/,
      "curly quote " + open + close + " leaked into href: " + html);
  }
  // A bare URL ending a clause with a curly apostrophe/quote, no opener.
  assert.match(linkify("opened https://github.com/o/r/pull/9”"), /href="https:\/\/github\.com\/o\/r\/pull\/9"/);
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

test("prFooterChip: '' when the session has no PRs", () => {
  assert.equal(prFooterChip(null), "");
  assert.equal(prFooterChip({}), "");
  assert.equal(prFooterChip({ prs: [] }), "");
});

test("prFooterChip: lists every PR, newest first, each linked with state + CI mark", () => {
  const html = prFooterChip({ prs: [
    { url: "https://github.com/o/r/pull/1", number: 1, state: "MERGED" },
    { url: "https://github.com/o/r/pull/2", number: 2, state: "OPEN", checks: "passing", title: "Add flag" },
  ] });
  assert.match(html, /pr-badge pr-open/);          // newest PR's state
  assert.match(html, /#2 Open/);                    // number + capitalized state
  assert.match(html, /pr-badge pr-merged/);        // older PR still shown
  assert.match(html, /#1 Merged/);
  assert.match(html, /pr-checks passing/);          // CI rollup mark
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/1"/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/2"/);
  assert.match(html, /title="Add flag"/);
  // newest (pull/2) is rendered before the older (pull/1)
  assert.ok(html.indexOf("pull/2") < html.indexOf("pull/1"));
});

test("prFooterChip: derives #number from the URL when absent, no CI mark when unknown", () => {
  const html = prFooterChip({ prs: [{ url: "https://github.com/o/r/pull/42" }] });
  assert.match(html, /#42/);
  assert.doesNotMatch(html, /pr-checks/);
});

test("prFooterChip: escapes a malicious PR title (no injection)", () => {
  const html = prFooterChip({ prs: [{ url: "https://github.com/o/r/pull/1", number: 1, state: "OPEN", title: '<img src=x onerror=alert(1)>' }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ---- filterModeOpts (mode selector shows only reachable modes) -----------
const modeVals = (opts) => opts.map((o) => o.value);

test("filterModeOpts: no permissionModes info -> every mode shown (older agent)", () => {
  assert.deepEqual(filterModeOpts(MODE_OPTS, undefined, "auto"), MODE_OPTS);
  assert.deepEqual(filterModeOpts(MODE_OPTS, null, "auto"), MODE_OPTS);
});

test("filterModeOpts: auto-launched cycle hides the unreachable bypassPermissions", () => {
  const avail = ["default", "acceptEdits", "plan", "auto"];
  assert.deepEqual(modeVals(filterModeOpts(MODE_OPTS, avail, "auto")),
    ["auto", "acceptEdits", "plan", "default"]);  // MODE_OPTS order, no bypass
});

test("filterModeOpts: bypass-launched cycle shows bypass, hides the unreachable auto", () => {
  const avail = ["default", "acceptEdits", "plan", "bypassPermissions"];
  const vals = modeVals(filterModeOpts(MODE_OPTS, avail, "bypassPermissions"));
  assert.ok(vals.includes("bypassPermissions"));
  assert.ok(!vals.includes("auto"));
});

test("filterModeOpts: the current mode is always kept even if not in the reachable set", () => {
  // Defensive: a stale current mode outside the reported cycle still appears, so
  // the selector never hides the active choice.
  const avail = ["default", "acceptEdits", "plan"];
  const vals = modeVals(filterModeOpts(MODE_OPTS, avail, "bypassPermissions"));
  assert.ok(vals.includes("bypassPermissions"));
});

// ---- renderProse (markdown tables in prose bubbles) ----------------------
test("renderProse: a GFM table becomes a real <table> with header + body cells", () => {
  const md = [
    "| Check | Status |",
    "|---|---|",
    "| Semgrep SAST | ✅ pass |",
    "| Unit tests | ✅ pass |",
  ].join("\n");
  const html = renderProse(md);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<thead><tr><th>Check<\/th><th>Status<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody>.*<td>Semgrep SAST<\/td><td>✅ pass<\/td>/s);
  assert.match(html, /<td>Unit tests<\/td><td>✅ pass<\/td>/);
  // No raw pipe characters leak into the rendered output.
  assert.doesNotMatch(html, /\|/);
});

test("renderProse: prose around a table is linkified, the table is lifted out", () => {
  const md = "Here are the results:\n\n| A | B |\n|---|---|\n| see https://x.io | y |\n\nDone.";
  const html = renderProse(md);
  assert.match(html, /Here are the results:/);
  assert.match(html, /<table class="md-table">/);
  // A link inside a cell is still clickable.
  assert.match(html, /<td>see <a href="https:\/\/x\.io"[^>]*>https:\/\/x\.io<\/a><\/td>/);
  // Trailing prose after the table is preserved.
  assert.match(html, /Done\./);
});

test("renderProse: alignment colons in the delimiter row set text-align", () => {
  const md = "| L | C | R |\n|:--|:-:|--:|\n| a | b | c |";
  const html = renderProse(md);
  assert.match(html, /<th style="text-align:left">L<\/th>/);
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
  assert.match(html, /<td style="text-align:center">b<\/td>/);
});

test("renderProse: cell contents are HTML-escaped (no injection)", () => {
  const md = "| Col |\n|---|\n| <script>alert(1)</script> |";
  const html = renderProse(md);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderProse: a lone pipe row with no delimiter stays plain (not a table)", () => {
  // "a | b" without a following delimiter row must not become a table.
  const html = renderProse("cost is 3 | 4 dollars");
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /cost is 3 \| 4 dollars/);
});

test("renderProse: table-free text is byte-identical to linkify", () => {
  const t = "opened [PR #42](https://github.com/o/r/pull/42) — <b>done</b> & dusted";
  assert.equal(renderProse(t), linkify(t));
});
