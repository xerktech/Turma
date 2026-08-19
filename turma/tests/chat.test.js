// Unit tests for the native chat engine's pure core (public/chat.js): the
// transcript merge (grow-only, rich-beats-text) and the entry->display-item
// builder (bubble grouping + tool_use/tool_result pairing). node:test, no npm —
// matches this package's zero-dependency stance. The DOM/streaming/verbosity
// paths are exercised manually (see the plan's E2E checklist); this locks the
// logic that decides what the chat actually shows.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTail, weight, buildItems, itemsToHtml, linkify, renderInline, renderProse, copyCodeClick, prFooterChip, ticketFooterChip, modelOpts, prettyModel, MODEL_OPTS, modelChipLabel, modeChipValue, __setSess, __setAgent, __setModelSwitchPending, __setModeSwitchPending, agentsHtml, optionCardHtml, panePromptHtml, __setPanePromptActive, filterModeOpts, MODE_OPTS, isBusy, updateComposeAction, updateLiveStatus, sendFailure, isTooLong, TOO_LONG, __setVerbosity, __setLiveStatus, __setLiveAgents, __stopPending, __setQuestionActive, attachmentsHtml, fmtBytes, readyUploadIds, renderAttachments, __setAttachments, __attachments, MAX_ATTACHMENTS, localModelOffered, currentModelSource, modelSourceLabel, modelSourceOpts, __setModelSourcePending, setSessionModelSource, __setHostKey } = require("../public/chat.js");

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

test("buildItems: a skill body folds into its Skill card, never a user bubble", () => {
  // The agent tags a skill body with the id of the Skill tool_use that pulled it
  // in (hub-agent.py _entry_tool_source), so it arrives as that call's
  // tool_result and pairs like any other — the operator never typed it.
  const body = "# Verifying Turma changes\n\nPick the surface the change reaches.";
  const items = buildItems([
    { id: "u1", role: "user", blocks: [{ t: "text", text: "verify the board" }] },
    { id: "a1", role: "assistant", blocks: [
      { t: "tool_use", id: "t1", name: "Skill", input: '{"skill":"verify"}' },
    ] },
    // A Skill call reports twice: the launch stub, then the body tagged with the
    // same id. Both fold into the one card, and the richer body wins.
    { id: "r1", role: "user", blocks: [{ t: "tool_result", forId: "t1", text: "Launching skill: verify" }] },
    { id: "s1", role: "user", blocks: [{ t: "tool_result", forId: "t1", text: body }] },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ["msg", "action"]);
  assert.equal(items[1].name, "Skill");
  assert.equal(items[1].result.text, body);
  // The one user bubble is the human's prompt — the skill body is not beside it.
  const bubbles = items.filter((i) => i.kind === "msg" && i.role === "user");
  assert.deepEqual(bubbles.map((b) => b.text), ["verify the board"]);
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

test("mergeTail: a text-only seed can't clobber an equal-text command-block copy", () => {
  // A command block keeps its content in name/args, which the old weight()
  // ignored — so the rich copy TIED its own flattened text and the `>=`
  // tie-break let the heartbeat's text-only seed strip the blocks back off.
  const rich = [{ id: "b1", role: "user", text: "! git status",
    blocks: [{ t: "command", name: "!", args: "git status" }] }];
  const seed = [{ id: "b1", role: "user", text: "! git status" }];
  const merged = mergeTail(rich, seed);
  assert.deepEqual(merged[0].blocks, [{ t: "command", name: "!", args: "git status" }]);
  // And the seed arriving first is still upgraded by the rich copy.
  assert.deepEqual(mergeTail(seed, rich)[0].blocks,
    [{ t: "command", name: "!", args: "git status" }]);
});

test("buildItems/render: an interrupt block -> a centred marker, not a user bubble", () => {
  const entries = [{ id: "i1", role: "user",
    blocks: [{ t: "interrupt", text: "[Request interrupted by user for tool use]" }] }];
  const items = buildItems(entries);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "interrupt");
  const html = withVerbosity("concise", () => itemsToHtml(items));
  // Visible even in Concise (it says what happened to the turn), never a bubble.
  assert.match(html, /class="chat-interrupt"/);
  assert.match(html, /Request interrupted by user for tool use/);
  assert.doesNotMatch(html, /\[Request/);        // brackets stripped for display
  assert.doesNotMatch(html, /tr-msg user/);
});

test("buildItems/render: an away_summary block -> a collapsed assistant-side card", () => {
  const entries = [{ id: "aw1", role: "assistant",
    blocks: [{ t: "away_summary", text: "Fixed the bug and opened a PR." }] }];
  const items = buildItems(entries);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "away");
  const html = withVerbosity("concise", () => itemsToHtml(items));
  assert.match(html, /class="away-card"/);
  assert.match(html, /While you were away/);
  assert.match(html, /Fixed the bug and opened a PR\./);
  assert.doesNotMatch(html, /tr-msg/); // a card, not a bubble on either side
});

test("buildItems: a bash `!` passthrough pairs its output like a slash command", () => {
  // <bash-input> and <bash-stdout> arrive as consecutive entries; the shared
  // command/command_output shapes mean the existing pairing folds them into
  // one chip + output card.
  const items = buildItems([
    { id: "b1", role: "user", blocks: [{ t: "command", name: "!", args: "git push" }] },
    { id: "b2", role: "user", blocks: [{ t: "command_output", text: "pushed" }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "command");
  assert.equal(items[0].name, "!");
  assert.equal(items[0].args, "git push");
  assert.equal(items[0].result.text, "pushed");
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

test("buildItems/render: an Edit tool_use carries its diff onto the card", () => {
  const entries = [{ id: "e1", role: "assistant", blocks: [{
    t: "tool_use", id: "t1", name: "Edit", input: "/repo/a.py",
    edit: { old: "x = 1", new: "x = 2", replaceAll: true },
  }] }];
  const items = buildItems(entries);
  assert.deepEqual(items[0].edit, { old: "x = 1", new: "x = 2", replaceAll: true });
  const html = withVerbosity("normal", () => itemsToHtml(items));
  assert.match(html, /tool-diff/);
  assert.match(html, /class="diff-old">x = 1</);
  assert.match(html, /class="diff-new">x = 2</);
  assert.match(html, /edit \(replace all\)/);
});

test("buildItems/render: a Write's content and a Bash description show on the card", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "w1", role: "assistant", blocks: [{ t: "tool_use", id: "t1", name: "Write",
      input: "/repo/new.txt", content: "hello\nworld" }] },
    { id: "b1", role: "assistant", blocks: [{ t: "tool_use", id: "t2", name: "Bash",
      input: "ls -la", desc: "List files" }] },
  ])));
  assert.match(html, /tool-label">content<\/div><pre>hello\nworld</);
  assert.match(html, /class="tool-desc">List files</);
});

test("buildItems/render: an ExitPlanMode plan renders as prose, open by default", () => {
  const entries = [{ id: "p1", role: "assistant", blocks: [{
    t: "tool_use", id: "t1", name: "ExitPlanMode", input: '{"allowedPrompts":[]}',
    plan: "## The plan\n\ndo the thing",
  }] }];
  const html = withVerbosity("normal", () => itemsToHtml(buildItems(entries)));
  assert.match(html, /tool-plan/);
  assert.match(html, /The plan/);
  assert.match(html, /<details class="action-card[^"]*" [^>]*open>/); // approvable: open
  // The summary leads with the plan's first line, not the raw input JSON.
  assert.match(html, /tool-arg">## The plan</);
  assert.doesNotMatch(html, /allowedPrompts/);
});

test("buildItems/render: a compact_boundary block -> a centred marker with token counts", () => {
  const items = buildItems([{ id: "cb1", role: "assistant",
    blocks: [{ t: "compact_boundary", trigger: "auto", preTokens: 123380, postTokens: 5920 }] }]);
  assert.equal(items[0].kind, "compact_boundary");
  const html = withVerbosity("concise", () => itemsToHtml(items));
  assert.match(html, /chat-compact-mark/);
  assert.match(html, /Context compacted \(auto\) — 123\.4k → 5\.9k tokens/);
});

test("buildItems/render: pr_link blocks -> one linked marker, consecutive duplicates fold", () => {
  const pr = { t: "pr_link", url: "https://github.com/o/r/pull/230", number: 230, repo: "o/r" };
  const items = buildItems([
    { id: "p1", role: "assistant", blocks: [pr] },
    { id: "p2", role: "assistant", blocks: [pr] }, // the transcript logs the same PR twice
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "pr");
  const html = withVerbosity("concise", () => itemsToHtml(items));
  assert.match(html, /chat-pr-mark/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/230"/);
  assert.match(html, /Opened PR #230 — o\/r/);
});

// Claude Code re-stamps a session's PR links in the metadata preamble it writes
// at the top of EVERY user turn, so the repeats are separated by whole turns
// rather than adjacent — a consecutive-only fold left one marker per re-stamp
// (measured: 1154 markers for 195 real PRs across the corpus). Shape below is
// taken from a real transcript.
test("buildItems: a pr_link re-stamped in later turns marks only its first occurrence", () => {
  const pr = (n) => ({ t: "pr_link", url: "https://github.com/o/r/pull/" + n, number: n, repo: "o/r" });
  const items = buildItems([
    { id: "u1", role: "user", blocks: [{ t: "text", text: "open a pr" }] },
    { id: "p1", role: "assistant", blocks: [pr(230)] },
    { id: "a1", role: "assistant", blocks: [{ t: "text", text: "opened it" }] },
    { id: "u2", role: "user", blocks: [{ t: "text", text: "now another" }] },
    { id: "p2", role: "assistant", blocks: [pr(230)] },   // re-stamp, a turn later
    { id: "p3", role: "assistant", blocks: [pr(231)] },   // a genuinely new PR
    { id: "a2", role: "assistant", blocks: [{ t: "text", text: "done" }] },
    { id: "p4", role: "assistant", blocks: [pr(230)] },   // re-stamped again
    { id: "p5", role: "assistant", blocks: [pr(231)] },
  ]);
  const prs = items.filter((i) => i.kind === "pr");
  assert.deepEqual(prs.map((i) => i.number), [230, 231],
    "one marker per PR, in the order each was first seen");
  // The surviving marker is the FIRST sighting — where the PR actually landed
  // in the conversation, not wherever the preamble last repeated it.
  assert.equal(items.indexOf(prs[0]), 1);
  // Nothing else is disturbed.
  assert.deepEqual(items.filter((i) => i.kind === "msg").map((i) => i.text),
    ["open a pr", "opened it", "now another", "done"]);
});

test("panePromptHtml: renders the TUI dialog with its context and numbered picks", () => {
  const html = panePromptHtml({
    prompt: "Do you want to proceed?",
    detail: "Bash command\ntouch /tmp/marker",
    options: [
      { number: 1, label: "Yes", selected: true },
      { number: 2, label: "Yes, and always allow access to tmp/", selected: false },
      { number: 3, label: "No", selected: false },
    ],
  });
  assert.match(html, /Do you want to proceed\?/);
  assert.match(html, /q-pane-detail">Bash command\ntouch \/tmp\/marker</);
  // Answered by the number the dialog itself shows — that's the key typed.
  assert.match(html, /data-num="1"[^>]*>1\. Choose</);
  assert.match(html, /data-num="3"[^>]*>3\. Choose</);
  // The TUI's own cursor position is carried through as the marked pick.
  assert.match(html, /q-opt-pick sel" data-num="1"/);
  assert.doesNotMatch(html, /q-opt-pick sel" data-num="2"/);
});

test("panePromptHtml: escapes dialog text (it is scraped terminal output)", () => {
  const html = panePromptHtml({
    prompt: "Run <script>alert(1)</script>?",
    detail: "rm -rf <x> && echo 'y'",
    options: [{ number: 1, label: "<b>Yes</b>", selected: true },
              { number: 2, label: "No", selected: false }],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>Yes<\/b>/);
  assert.match(html, /&lt;script&gt;/);
});

test("compose bar: a blocking TUI dialog hides Stop, like a pending question", () => {
  // Same reasoning as XERK-21: the dialog is answered with its own buttons, and
  // a Stop there would cancel the decision rather than a running turn.
  __setLiveStatus({ verb: "Working" });
  __stopPending(0);
  __setQuestionActive(false);
  __setPanePromptActive(true);
  assert.equal(isBusy(), false);
  __setPanePromptActive(false);
  assert.equal(isBusy(), true);
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

test("render: a clipped command output / compact summary is MARKED, never a button (XERK-347)", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact" }] },
    { id: "o1", role: "user", blocks: [{ t: "command_output", text: "cut", truncated: true }] },
    { id: "s1", role: "assistant", blocks: [{ t: "compact_summary", text: "cut", truncated: true }] },
  ])));
  assert.equal(html.match(/class="clipped"/g).length, 2);
  assert.doesNotMatch(html, /<button/);
});

test("render: a folded card's clipped ARGS are marked too", () => {
  const html = withVerbosity("normal", () => itemsToHtml(buildItems([
    { id: "c1", role: "user", blocks: [{ t: "command", name: "/compact", args: "cut", truncated: true }] },
  ])));
  assert.match(html, /class="clipped"/);
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

// XERK-347: a message is shown WHOLE, every time. The agent's block caps are
// the same on the live tail as on /history, so a clipped block has no fuller
// copy anywhere — it gets a static mark, and nothing the operator must press
// before they can read a message.
// XERK-347: the /history 202-retry window must outlast a HEARTBEAT, because a
// delivery the agent shed (its own body ceiling, or two failed beats) can only
// arrive on the NEXT beat — and the poll fallback re-asks only while the socket
// is down, so a session with a healthy live tail that gives up early sits on an
// empty scrollback until it is reopened. Read off the source: these are module
// constants with no export, and the window is the thing that must not regress.
test("chat: the /history retry window outlasts the agent's beat interval", () => {
  const src = require("fs").readFileSync(require.resolve("../public/chat.js"), "utf8");
  const num = (name) => {
    const m = src.match(new RegExp(`const ${name} = (\\d+)`));
    assert.ok(m, `${name} is no longer a plain constant in chat.js`);
    return Number(m[1]);
  };
  const BEAT_MS = 20000;   // hub-agent.py INTERVAL
  assert.ok(num("HISTORY_MAX_RETRIES") * num("HISTORY_RETRY_MS") > BEAT_MS * 2,
    "the window must cover the beat that sheds a delivery AND the one that re-delivers it");
});

test("render: a clipped block gets a static mark, not a Show more button", () => {
  const items = buildItems([
    { id: "a9", role: "assistant", blocks: [{ t: "text", text: "loooong", truncated: true }] },
  ]);
  const html = withVerbosity("verbose", () => itemsToHtml(items));
  assert.match(html, /class="clipped"/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /Show more/);
});

test("render: an un-clipped block carries no mark at all", () => {
  const items = buildItems([
    { id: "a9", role: "assistant", blocks: [{ t: "text", text: "short" }] },
  ]);
  const html = withVerbosity("verbose", () => itemsToHtml(items));
  assert.doesNotMatch(html, /class="clipped"/);
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

// ---- inline images (XERK-221) --------------------------------------------
test("linkify: a markdown image ![alt](url) becomes an <img>, not a stray ! + link", () => {
  const html = linkify("see ![a diagram](https://ex.com/x.png) here");
  assert.equal(html,
    'see <img class="md-img" src="https://ex.com/x.png" alt="a diagram" loading="lazy"> here');
  assert.doesNotMatch(html, /<a /); // an image is not also rendered as a link
});

test("linkify: an image with an empty alt still renders", () => {
  assert.match(linkify("![](https://ex.com/x.png)"), /<img class="md-img" src="https:\/\/ex\.com\/x\.png" alt=""/);
});

test("linkify: a data:image URI is an allowed image src; a non-image data URI is not", () => {
  const ok = linkify("![i](data:image/png;base64,AAAA)");
  assert.match(ok, /<img class="md-img" src="data:image\/png;base64,AAAA"/);
  // data:text/html is not image/*, so it is not turned into an <img> (its label
  // and the leading ! fall through as escaped text).
  assert.doesNotMatch(linkify("![x](data:text/html,<script>alert(1)</script>)"), /<img/);
});

test("linkify: image alt + src are HTML-escaped (no attribute breakout)", () => {
  const html = linkify('![" onerror=alert(1) x](https://ex.com/a".png)');
  // The quote that would close the attribute early is escaped in BOTH attrs, so
  // the onerror text stays inert data inside alt rather than a real attribute.
  assert.doesNotMatch(html, /"\s+onerror=/); // no raw quote begins a new attribute
  assert.match(html, /alt="&quot; onerror=alert\(1\) x"/);
  assert.match(html, /src="https:\/\/ex\.com\/a&quot;\.png"/);
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

// ---- SendUserFile inline previews (XERK-221) -----------------------------
function suItems(files, caption) {
  const block = { t: "tool_use", id: "t1", name: "SendUserFile", input: '{"files":["x"]}' };
  if (files) block.files = files;
  if (caption) block.caption = caption;
  return buildItems([{ id: "a1", role: "assistant", blocks: [block] }]);
}

test("render: a SendUserFile delivery shows in Concise; a plain tool card doesn't (XERK-221)", () => {
  const fileItems = suItems([{ name: "a.svg", kind: "image", src: "data:image/svg+xml,x" }]);
  // Concise hides tool mechanics, but the file-carrying card still renders.
  const conciseHtml = withVerbosity("concise", () => itemsToHtml(fileItems));
  assert.match(conciseHtml, /<img class="md-img/);
  assert.match(conciseHtml, /action-card/);
  // A file-less tool call is still omitted entirely by Concise.
  const plain = buildItems([{ id: "a2", role: "assistant",
    blocks: [{ t: "tool_use", id: "t2", name: "Bash", input: "ls" }] }]);
  assert.equal(withVerbosity("concise", () => itemsToHtml(plain)), "");
  // Normal still renders both.
  assert.match(withVerbosity("normal", () => itemsToHtml(plain)), /action-card/);
});

test("render: a SendUserFile image renders as an <img>, an SVG gets md-svg", () => {
  const html = withVerbosity("normal", () => itemsToHtml(suItems([
    { name: "logo.svg", kind: "image", src: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E" },
    { name: "shot.png", kind: "image", src: "data:image/png;base64,AAAA" },
  ])));
  assert.match(html, /<img class="md-img md-svg" src="data:image\/svg\+xml,[^"]*" alt="logo\.svg"/);
  assert.match(html, /<img class="md-img" src="data:image\/png;base64,AAAA" alt="shot\.png"/);
  assert.match(html, /<figcaption>logo\.svg<\/figcaption>/);
});

test("render: a SendUserFile HTML file renders in a fully sandboxed iframe (srcdoc, esc'd)", () => {
  const html = withVerbosity("normal", () => itemsToHtml(suItems([
    { name: "page.html", kind: "html", html: '<h1>Hi</h1><script>alert(1)</script>' },
  ])));
  assert.match(html, /<iframe class="md-embed" sandbox referrerpolicy="no-referrer"/);
  // srcdoc is HTML-escaped, so the <script> is inert data, and sandbox (no
  // allow-scripts) means it never executes even after the browser decodes it.
  assert.match(html, /srcdoc="&lt;h1&gt;Hi&lt;\/h1&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("render: a preview DROPPED to fit says so; one that never rendered does not (XERK-347)", () => {
  // The agent sheds SendUserFile payloads to keep a reply under the hub's body
  // ceiling. Without this the operator sees a bare 📎 chip and no reason why
  // the screenshot they were sent isn't there.
  const shedHtml = withVerbosity("verbose", () => itemsToHtml(buildItems([
    { id: "a1", role: "assistant", blocks: [{ t: "tool_use", id: "t1", name: "SendUserFile",
      files: [{ name: "shot.png", kind: "file", shed: true }] }] },
  ])));
  assert.match(shedHtml, /📎 shot\.png/);
  assert.match(shedHtml, /preview dropped to fit/);

  const plainHtml = withVerbosity("verbose", () => itemsToHtml(buildItems([
    { id: "a1", role: "assistant", blocks: [{ t: "tool_use", id: "t1", name: "SendUserFile",
      files: [{ name: "notes.bin", kind: "file" }] }] },
  ])));
  assert.match(plainHtml, /📎 notes\.bin/);
  assert.doesNotMatch(plainHtml, /preview dropped/);
});

test("render: a non-renderable / missing SendUserFile file is a name chip, not an image", () => {
  const html = withVerbosity("normal", () => itemsToHtml(suItems([
    { name: "archive.zip", kind: "file" },
  ])));
  assert.match(html, /tool-file file/);
  assert.match(html, /📎 archive\.zip/);
  assert.doesNotMatch(html, /<img/);
});

test("render: an image src limited to data:image/http(s); a hostile scheme is dropped to no <img>", () => {
  const html = withVerbosity("normal", () => itemsToHtml(suItems([
    { name: "x", kind: "image", src: "javascript:alert(1)" },
    { name: "y", kind: "image", src: "https://ex.com/y.png" },
  ])));
  assert.doesNotMatch(html, /javascript:alert/);       // hostile scheme never reaches src=
  assert.match(html, /<img class="md-img" src="https:\/\/ex\.com\/y\.png"/);
});

test("render: SendUserFile summary shows the caption / file count, not raw input JSON", () => {
  const withCap = withVerbosity("normal", () => itemsToHtml(suItems(
    [{ name: "a.svg", kind: "image", src: "data:image/svg+xml,x" }], "three candidates")));
  assert.match(withCap, /three candidates/);
  assert.doesNotMatch(withCap, /"files":/);            // raw input JSON suppressed
  const noCapTwo = withVerbosity("normal", () => itemsToHtml(suItems([
    { name: "a.svg", kind: "image", src: "data:image/svg+xml,x" },
    { name: "b.svg", kind: "image", src: "data:image/svg+xml,x" }])));
  assert.match(noCapTwo, /2 files/);
  assert.match(withVerbosity("normal", () => itemsToHtml(suItems(
    [{ name: "a.svg", kind: "file" }]))), /1 file[^s]/);
  // The caption is rendered in the body too.
  assert.match(withCap, /tool-caption/);
});

test("prFooterChip: '' when the session has no PRs", () => {
  assert.equal(prFooterChip(null), "");
  assert.equal(prFooterChip({}), "");
  assert.equal(prFooterChip({ prs: [] }), "");
});

test("prFooterChip: lists every PR, newest first, each linked with state + readiness mark", () => {
  const html = prFooterChip({ prs: [
    { url: "https://github.com/o/r/pull/1", number: 1, state: "MERGED" },
    { url: "https://github.com/o/r/pull/2", number: 2, state: "OPEN", checks: "passing",
      mergeable: "MERGEABLE", ready: "ready", title: "Add flag" },
  ] });
  assert.match(html, /pr-badge pr-open/);          // newest PR's state
  assert.match(html, /#2 Open/);                    // number + capitalized state
  assert.match(html, /pr-badge pr-merged/);        // older PR still shown
  assert.match(html, /#1 Merged/);
  assert.match(html, /pr-ready ready/);             // merge-readiness mark
  assert.match(html, /title="CI passing · no conflicts"/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/1"/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/2"/);
  assert.match(html, /title="Add flag"/);
  // newest (pull/2) is rendered before the older (pull/1)
  assert.ok(html.indexOf("pull/2") < html.indexOf("pull/1"));
});

test("prFooterChip: derives #number from the URL when absent, no mark when unknown", () => {
  const html = prFooterChip({ prs: [{ url: "https://github.com/o/r/pull/42" }] });
  assert.match(html, /#42/);
  assert.doesNotMatch(html, /pr-ready/);
});

// XERK-162: a GitLab merge request is a chip exactly like a PR — same badge,
// same states — and a bare {url} still derives its number pre-status. The
// label is GitLab's own !n sigil (mirroring the agent's _pr_ref), whether the
// number comes from the status or the URL.
test("prFooterChip: a GitLab MR chips like a PR, labelled !n", () => {
  const html = prFooterChip({ prs: [
    { url: "https://gitlab.example.com/grp/app/-/merge_requests/12" },
    { url: "https://gitlab.example.com/grp/app/-/merge_requests/13", number: 13,
      state: "OPEN", checks: "passing", mergeable: "MERGEABLE", ready: "ready" },
  ] });
  assert.match(html, /!12/);                        // number from the MR URL
  assert.match(html, /!13 Open/);                   // number from the status
  assert.doesNotMatch(html, /#1[23]/);
  assert.match(html, /pr-ready ready/);
  assert.match(html, /href="https:\/\/gitlab\.example\.com\/grp\/app\/-\/merge_requests\/12"/);
});

// XERK-226: and so is an Azure DevOps pull request — the third source, chipped
// identically, its number derived from the ADO URL before any status lands.
// ADO also reads !n: there #n addresses a WORK ITEM.
test("prFooterChip: an Azure DevOps PR chips like a GitHub PR", () => {
  const url = "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12";
  const html = prFooterChip({ prs: [
    { url },
    { url: url.replace("/12", "/13"), number: 13, state: "OPEN",
      checks: "passing", mergeable: "MERGEABLE", ready: "ready" },
  ] });
  assert.match(html, /!12/);                        // number from the ADO URL
  assert.match(html, /!13 Open/);
  assert.match(html, /pr-ready ready/);
  assert.match(html, new RegExp('href="' + url.replace(/[/.]/g, "\\$&") + '"'));
});

// The mark answers "can this land", not "is CI green": a conflicting branch
// merges nowhere however clean its checks are, so it reads ✗ and says why.
test("prFooterChip: a merge conflict blocks the mark despite green CI", () => {
  const html = prFooterChip({ prs: [{
    url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN",
    checks: "passing", mergeable: "CONFLICTING", ready: "blocked",
  }] });
  assert.match(html, /pr-ready blocked/);
  assert.match(html, /✗/);
  assert.match(html, /title="CI passing · merge conflict"/);
});

// An agent predating `ready` reports the CI half alone — render that rather
// than dropping the mark.
test("prFooterChip: falls back to the CI rollup when the agent reports no verdict", () => {
  const html = prFooterChip({ prs: [{
    url: "https://github.com/o/r/pull/9", number: 9, state: "OPEN", checks: "failing",
  }] });
  assert.match(html, /pr-ready blocked/);
  assert.match(html, /title="CI failing"/);   // nothing claimed about conflicts
});

// The Jira ticket this session was spawned to work — the reverse of the board's
// ticket -> session link. It links out to Jira, not back to the board: from
// inside a session, the useful thing is the live ticket.

test("ticketFooterChip: '' for an ordinary session (not started from a ticket)", () => {
  assert.equal(ticketFooterChip(null), "");
  assert.equal(ticketFooterChip({}), "");
  assert.equal(ticketFooterChip({ ticket: null }), "");
  assert.equal(ticketFooterChip({ ticket: {} }), "");
});

test("ticketFooterChip: shows the key and links to the ticket on the turma board", () => {
  const html = ticketFooterChip({ ticket: {
    key: "ENG-42", siteKey: "myorg.atlassian.net",
    url: "https://myorg.atlassian.net/browse/ENG-42",
    summary: "Fix the board", branch: "ENG-42-1",
  } });
  assert.match(html, /jira-chip/);
  assert.match(html, />ENG-42</);
  // Deep-links the board's own ticket panel (XERK-16), not out to Jira.
  assert.match(html, /href="\/board\?ticket=ENG-42&amp;site=myorg\.atlassian\.net"/);
  assert.doesNotMatch(html, /atlassian\.net\/browse/);
  assert.doesNotMatch(html, /target="_blank"/);
  // The summary and the branch it was told to use ride as the tooltip — the
  // chip itself only has room for the key.
  assert.match(html, /title="Fix the board · branch ENG-42-1"/);
});

test("ticketFooterChip: a ticket with no siteKey still links to the board (never a broken chip)", () => {
  const html = ticketFooterChip({ ticket: { key: "ENG-1" } });
  assert.match(html, />ENG-1</);
  assert.match(html, /href="\/board\?ticket=ENG-1"/);
  assert.doesNotMatch(html, /site=/);
  assert.match(html, /title="ENG-1"/);
});

test("ticketFooterChip: escapes a malicious ticket summary (no injection)", () => {
  const html = ticketFooterChip({ ticket: {
    key: "ENG-1", url: "https://x/browse/ENG-1", summary: '<img src=x onerror=alert(1)>',
  } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
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

// ---- modelOpts / prettyModel (the accurate model selector, XERK-33) ------
const modelVals = (opts) => opts.map((o) => o.value);

test("modelOpts: no models block -> the static fallback menu (older agent)", () => {
  assert.deepEqual(modelOpts(undefined), MODEL_OPTS);
  assert.deepEqual(modelOpts(null), MODEL_OPTS);
  assert.deepEqual(modelOpts({ available: [] }), MODEL_OPTS);
});

test("modelOpts: the probed list curates the menu — fable in, absent aliases out", () => {
  const models = { available: ["sonnet", "opus", "fable", "best", "opusplan", "default"] };
  // haiku not probed -> not offered; best/opusplan have no picker row -> never offered.
  assert.deepEqual(modelVals(modelOpts(models)), ["default", "opus", "fable", "sonnet"]);
});

test("modelOpts: the Default entry says what default actually is", () => {
  const models = { available: ["sonnet", "default"], defaultLabel: "Fable 5" };
  assert.equal(modelOpts(models)[0].label, "Default (Fable 5)");
  // ...and stays plain when the probe carried no label.
  assert.equal(modelOpts({ available: ["sonnet", "default"] })[0].label, "Default");
});

test("modelOpts: a probe listing nothing offerable falls back rather than emptying the menu", () => {
  assert.deepEqual(modelOpts({ available: ["best", "opusplan"] }), MODEL_OPTS);
});

test("prettyModel: transcript model ids render human", () => {
  assert.equal(prettyModel("claude-opus-4-8"), "Opus 4.8");
  assert.equal(prettyModel("claude-fable-5"), "Fable 5");
  assert.equal(prettyModel("claude-sonnet-5"), "Sonnet 5");
  assert.equal(prettyModel("claude-haiku-4-5-20251001"), "Haiku 4.5"); // date dropped
  assert.equal(prettyModel("claude-3-5-haiku-20241022"), "Haiku 3.5"); // legacy order
  assert.equal(prettyModel("claude-fable-5[1m]"), "Fable 5 1M");
});

test("prettyModel: a switch confirmation's display label passes through", () => {
  assert.equal(prettyModel("Sonnet 5"), "Sonnet 5");
  assert.equal(prettyModel(""), "");
  assert.equal(prettyModel(null), "");
});

// ---- modelChipLabel / modeChipValue (switch-in-flight display) -----------
function resetChipState() {
  __setSess(null); __setAgent(null);
  __setModelSwitchPending(null); __setModeSwitchPending(null);
}

test("modelChipLabel: the agent's deferred pendingModel outranks everything and reads in-flight", () => {
  __setSess({ pendingModel: "sonnet", modelActual: "claude-opus-4-8", model: null });
  assert.equal(modelChipLabel(), "Sonnet…");
  resetChipState();
});

test("modelChipLabel: actual model beats the picked alias beats Default", () => {
  __setSess({ modelActual: "claude-opus-4-8", model: "sonnet" });
  assert.equal(modelChipLabel(), "Opus 4.8");
  __setSess({ model: "sonnet" });
  assert.equal(modelChipLabel(), "Sonnet");
  __setSess({});
  assert.equal(modelChipLabel(), "Default");
  resetChipState();
});

test("modelChipLabel: the click memo holds until the actual model moves", () => {
  __setSess({ modelActual: "claude-opus-4-8", model: "sonnet" });
  __setModelSwitchPending({ value: "sonnet", prevActual: "claude-opus-4-8", at: Date.now() });
  assert.equal(modelChipLabel(), "Sonnet…"); // a stale heartbeat can't flash the old model back
  __setSess({ modelActual: "Sonnet 5", model: "sonnet" });
  assert.equal(modelChipLabel(), "Sonnet 5"); // confirmation arrived; memo retires
  resetChipState();
});

test("modeChipValue: holds the picked mode until the heartbeat agrees", () => {
  __setSess({ permissionMode: "auto" });
  __setModeSwitchPending({ value: "plan", at: Date.now() });
  assert.equal(modeChipValue(), "plan"); // agent hasn't applied it yet
  __setSess({ permissionMode: "plan" });
  assert.equal(modeChipValue(), "plan"); // agreement retires the memo...
  __setSess({ permissionMode: "auto" });
  assert.equal(modeChipValue(), "auto"); // ...so later changes show through
  resetChipState();
});

test("modeChipValue: an expired memo stops overriding the truth", () => {
  __setSess({ permissionMode: "auto" });
  __setModeSwitchPending({ value: "bypassPermissions", at: Date.now() - 60000 });
  assert.equal(modeChipValue(), "auto"); // unreachable mode never landed; chip goes honest
  resetChipState();
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

// ---- renderProse (fenced code blocks in prose bubbles) -------------------
test("renderProse: a fenced block becomes a <pre> tagged with its language", () => {
  const md = 'Try this:\n\n```hcl\nfeatures = local.env_features[var.environment]\n```\n\nThen apply.';
  const html = renderProse(md);
  assert.match(html, /<pre class="md-code" data-lang="hcl"><code>features = local\.env_features\[var\.environment\]<\/code><\/pre>/);
  // Prose either side survives, and no fence markers leak through.
  assert.match(html, /Try this:/);
  assert.match(html, /Then apply\./);
  assert.doesNotMatch(html, /```/);
});

test("renderProse: a fence with no info string omits data-lang", () => {
  assert.match(renderProse("```\nplain\n```"), /<pre class="md-code"><code>plain<\/code><\/pre>/);
});

test("renderProse: a fenced block carries a copy button in a positioning wrapper (XERK-183)", () => {
  const html = renderProse("```\nplain\n```");
  // The wrapper is the positioning context; the button sits OUTSIDE the <pre>
  // so it never enters a copied selection.
  assert.match(html, /<div class="md-code-wrap"><button class="md-copy"[^>]*><svg[^]*?<\/button><pre class="md-code">/);
  assert.match(html, /aria-label="Copy code"/);
});

test("copyCodeClick: a .md-copy click copies the <code> text and flashes copied (XERK-183)", async () => {
  // Node's global navigator has no clipboard, so this exercises the
  // hidden-textarea execCommand fallback (the path older/webview clients hit).
  const btnClasses = new Set();
  const code = { textContent: "npm ci\nnpm test" };
  const wrap = { querySelector: (sel) => (sel === "pre.md-code code" ? code : null) };
  const btn = {
    closest: (sel) => (sel === ".md-code-wrap" ? wrap : null),
    classList: { add: (c) => btnClasses.add(c), remove: (c) => btnClasses.delete(c) },
  };
  let prevented = false, copiedValue = null;
  const e = { target: { closest: (sel) => (sel === ".md-copy" ? btn : null) }, preventDefault: () => { prevented = true; } };
  const ta = { style: {}, setAttribute() {}, select() { copiedValue = this.value; } };
  global.document = {
    createElement: () => ta,
    execCommand: (cmd) => cmd === "copy",
    body: { appendChild() {}, removeChild() {} },
  };
  try {
    const handled = copyCodeClick(e);
    assert.equal(handled, true);
    assert.equal(prevented, true);
    await Promise.resolve(); await Promise.resolve(); // let the clipboard promise settle
    assert.equal(copiedValue, "npm ci\nnpm test");
    assert.ok(btnClasses.has("copied"));
  } finally { clearDom(); }
});

test("copyCodeClick: a click outside a .md-copy is ignored (XERK-183)", () => {
  const e = { target: { closest: () => null }, preventDefault: () => { throw new Error("should not prevent"); } };
  assert.equal(copyCodeClick(e), false);
});

test("renderProse: code body is escaped and never linkified", () => {
  const html = renderProse('```js\nconst u = "https://x.io"; // <script>alert(1)</script>\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<a /);           // a URL in code stays text
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;https:\/\/x\.io&quot;/);
});

test("renderProse: blank lines and indentation inside a block are preserved", () => {
  const md = "```py\ndef f():\n    return 1\n\n\nx = f()\n```";
  assert.match(renderProse(md), /<code>def f\(\):\n    return 1\n\n\nx = f\(\)<\/code>/);
});

test("renderProse: an unterminated fence still renders as code (mid-turn)", () => {
  // A live turn is captured mid-block; the closer hasn't arrived yet, and the
  // partial body must not flash as prose in the meantime.
  const html = renderProse("Here:\n```hcl\nenv_features = {\n  dev = {");
  assert.match(html, /<pre class="md-code" data-lang="hcl"><code>env_features = \{\n {2}dev = \{<\/code><\/pre>/);
  assert.match(html, /Here:/);
});

test("renderProse: pipe rows inside a code block are not read as a table", () => {
  const md = "```sh\n| Col |\n|---|\n| a |\n```";
  const html = renderProse(md);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<code>\| Col \|\n\|---\|\n\| a \|<\/code>/);
});

test("renderProse: a table after a code block is still a table", () => {
  const html = renderProse("```\ncode\n```\n\n| A |\n|---|\n| b |");
  assert.match(html, /<pre class="md-code"><code>code<\/code><\/pre>/);
  assert.match(html, /<table class="md-table">/);
});

test("renderProse: a longer closing fence closes the block", () => {
  // ````…```` wraps a body that itself contains a ``` fence.
  const html = renderProse("````md\n```\ninner\n```\n````\nafter");
  assert.match(html, /<code>```\ninner\n```<\/code>/);
  assert.match(html, /after/);
});

test("renderProse: inline backticks in prose don't open a block", () => {
  // A fence line must be the fence plus at most a one-word info string; these
  // are inline spans (see renderInline) sitting mid-sentence, not blocks.
  const html = renderProse("run ```npm ci``` first, then ``` npm test ``` after");
  assert.doesNotMatch(html, /<pre/);
  assert.match(html, /run <code class="md-code-inline">npm ci<\/code> first/);
});

test("renderProse: fence-free text is byte-identical to the table renderer", () => {
  const t = "opened [PR #42](https://github.com/o/r/pull/42) — <b>done</b> & dusted";
  assert.equal(renderProse(t), linkify(t));
});

// ---- raw SVG rendering (XERK-221) ----------------------------------------
test("renderProse: a standalone <svg> block renders as a data-URI <img>, not text", () => {
  const html = renderProse("Here it is:\n<svg viewBox=\"0 0 2 2\"><rect width=\"2\" height=\"2\"/></svg>\ndone");
  assert.match(html, /<img class="md-img md-svg" src="data:image\/svg\+xml,/);
  assert.match(html, /Here it is:/);
  assert.match(html, /done/);
  // The markup is URL-encoded (angle brackets gone), so nothing lands in the DOM.
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /%3Csvg/); // encodeURIComponent turned "<svg" into "%3Csvg"
});

test("renderProse: a fenced SVG document renders as an image, not a code block", () => {
  const html = renderProse("```svg\n<svg><circle r=\"1\"/></svg>\n```");
  assert.match(html, /<img class="md-img md-svg"/);
  assert.doesNotMatch(html, /md-code/); // not a code block
});

test("renderProse: a fence that merely mentions <svg> among other content stays code", () => {
  const html = renderProse("```html\n<div><svg></svg></div>\n<p>hi</p>\n```");
  assert.match(html, /md-code/);
  assert.doesNotMatch(html, /md-svg/);
});

test("renderProse: an <svg> inside an inline code span is NOT rendered as an image", () => {
  // The <svg> is mid-line (inside backticks), not at a line start, so it stays code.
  const html = renderProse("the `<svg><rect/></svg>` element");
  assert.doesNotMatch(html, /md-svg/);
  assert.match(html, /md-code-inline/);
});

test("renderProse: an unterminated <svg> (mid-stream) stays escaped text, not an image", () => {
  const html = renderProse("<svg viewBox=\"0 0 2 2\"><rect");
  assert.doesNotMatch(html, /md-svg/);
  assert.match(html, /&lt;svg/); // shown as escaped text until its </svg> lands
});

// ---- renderInline (inline `code` spans in prose) -------------------------
test("renderInline: a backtick span becomes a <code> chip", () => {
  assert.equal(renderInline("run `npm ci` first"),
    'run <code class="md-code-inline">npm ci</code> first');
});

test("renderInline: span contents are escaped and never linkified", () => {
  const html = renderInline("hit `https://x.io/<b>` then");
  assert.doesNotMatch(html, /<a /);        // a URL being shown, not offered
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /<code class="md-code-inline">https:\/\/x\.io\/&lt;b&gt;<\/code>/);
});

test("renderInline: prose around a span is still linkified", () => {
  const html = renderInline("see https://x.io for `--flag` docs");
  assert.match(html, /<a href="https:\/\/x\.io"/);
  assert.match(html, /<code class="md-code-inline">--flag<\/code>/);
});

test("renderInline: an unclosed backtick is literal text", () => {
  const html = renderInline("a lone ` backtick sits here");
  assert.doesNotMatch(html, /<code/);
  assert.match(html, /a lone ` backtick sits here/);
});

test("renderInline: a span never crosses a line break", () => {
  // Two stray backticks on different lines must not swallow the lines between.
  const html = renderInline("first ` line\nsecond ` line");
  assert.doesNotMatch(html, /<code/);
  assert.match(html, /first ` line\nsecond ` line/);
});

test("renderInline: a double-backtick span can hold a literal backtick", () => {
  assert.equal(renderInline("write ``a `b` c`` here"),
    'write <code class="md-code-inline">a `b` c</code> here');
});

test("renderInline: one leading+trailing space is stripped (GFM)", () => {
  assert.equal(renderInline("a `` ` `` b"), 'a <code class="md-code-inline">`</code> b');
  // ...but an all-space body is left alone, and a single side isn't stripped.
  assert.equal(renderInline("a ` x ` b"), 'a <code class="md-code-inline">x</code> b');
  assert.equal(renderInline("a ` x` b"), 'a <code class="md-code-inline"> x</code> b');
});

test("renderInline: several spans in one line all render", () => {
  const html = renderInline("`a` then `b` then `c`");
  assert.equal((html.match(/<code class="md-code-inline">/g) || []).length, 3);
});

test("renderInline: backtick-free text is byte-identical to linkify", () => {
  const t = "opened [PR #42](https://github.com/o/r/pull/42) — <b>done</b> & dusted";
  assert.equal(renderInline(t), linkify(t));
});

test("renderProse: `code` works inside a table cell", () => {
  const html = renderProse("| Flag | Use |\n|---|---|\n| `--fabric` | on in prod |");
  assert.match(html, /<td><code class="md-code-inline">--fabric<\/code><\/td>/);
});

test("renderProse: backticks inside a fenced block stay literal", () => {
  // The fence pass runs first, so the block body is never inline-scanned.
  const html = renderProse("```sh\necho `date`\n```");
  assert.doesNotMatch(html, /md-code-inline/);
  assert.match(html, /<code>echo `date`<\/code>/);
});

// ---- agentsHtml: the live pane agent-list rendered under the status bar ------

test("agentsHtml: '' when there are no agents", () => {
  assert.equal(agentsHtml(null), "");
  assert.equal(agentsHtml([]), "");
});

test("agentsHtml: subagents are buttons carrying type+label; 'main' is a plain marker", () => {
  const html = agentsHtml([
    { sel: true, type: "main", label: "" },
    { sel: false, type: "Explore", label: "Explore Jira agent-side code" },
  ]);
  // main: not a button (no separate transcript), carries the selected dot.
  assert.match(html, /<div class="cc-agent main"><span class="dot sel">/);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*main/);
  // subagent: a button with the data-attrs openSubagentView reads.
  assert.match(html, /<button type="button" class="cc-agent" data-atype="Explore" data-alabel="Explore Jira agent-side code">/);
  assert.match(html, /<span class="alabel">Explore Jira agent-side code<\/span>/);
});

// XERK-245: the status bar carries the agent list past the end of the turn.
// `liveStatus` clears the instant a turn ends (it is what shows Stop), but a
// background agent keeps running — and the bar used to vanish with it, leaving
// the chat looking idle while work continued.
function fakeStatusBar() {
  const bar = { hidden: false, innerHTML: "", dataset: {}, addEventListener() {} };
  global.document = {
    getElementById: (id) => (id === "chatStatus" ? bar : null),
    querySelectorAll: () => [],
  };
  return bar;
}

test("live status bar: agents keep the bar up after the turn ends", () => {
  const bar = fakeStatusBar();
  try {
    __setLiveStatus(null);
    __setLiveAgents([{ sel: true, type: "main", label: "" },
                     { sel: false, type: "qa", label: "QA the parity change" }]);
    updateLiveStatus();
    assert.equal(bar.hidden, false, "the bar stays up while an agent runs");
    assert.match(bar.innerHTML, /Background agents…/);
    assert.match(bar.innerHTML, /QA the parity change/);
    // The turn really has ended, so Stop must stay hidden.
    assert.equal(isBusy(), false);
  } finally { clearDom(); }
});

// `main` is the conversation already on screen. A list carrying only it means
// nothing is delegated, so raising a "Background agents…" bar for it would claim
// work that isn't running — the same carve-out live_subagents makes agent-side.
test("live status bar: a main-only list does not claim background agents", () => {
  const bar = fakeStatusBar();
  try {
    __setLiveStatus(null);
    __setLiveAgents([{ sel: true, type: "main", label: "" }]);
    updateLiveStatus();
    assert.equal(bar.hidden, true);
    assert.equal(bar.innerHTML, "");
  } finally { clearDom(); }
});

// Rows arrive from a pane scrape via the hub; a buggy agent can send junk and it
// must not throw (an uncaught TypeError costs that whole repaint).
test("live status bar: junk rows are dropped, not thrown on", () => {
  const bar = fakeStatusBar();
  try {
    __setLiveStatus(null);
    __setLiveAgents([null, 7, {}, { type: "qa", label: "QA it" }]);
    assert.doesNotThrow(() => updateLiveStatus());
    assert.equal(bar.hidden, false);
    assert.match(bar.innerHTML, /QA it/);
    // ...and a list of nothing BUT junk raises no bar at all.
    __setLiveAgents([null, {}, 7]);
    assert.doesNotThrow(() => updateLiveStatus());
    assert.equal(bar.hidden, true);
  } finally { clearDom(); }
});

test("live status bar: no turn and no agents -> hidden, as before", () => {
  const bar = fakeStatusBar();
  try {
    __setLiveStatus(null);
    __setLiveAgents([]);
    updateLiveStatus();
    assert.equal(bar.hidden, true);
    assert.equal(bar.innerHTML, "");
  } finally { clearDom(); }
});

test("live status bar: a running turn renders verb, hint and agents together", () => {
  const bar = fakeStatusBar();
  try {
    __setLiveStatus({ verb: "Zesting", up: "1.2k", down: "340", elapsed: "12s",
                      hint: "■ Port the stylesheet" });
    __setLiveAgents([{ sel: false, type: "qa", label: "QA it" }]);
    updateLiveStatus();
    assert.match(bar.innerHTML, /Zesting…/);
    assert.match(bar.innerHTML, /Port the stylesheet/);
    assert.match(bar.innerHTML, /QA it/);
    assert.ok(!/Background agents…/.test(bar.innerHTML), "the turn's own verb leads");
  } finally { clearDom(); }
});

test("agentsHtml: escapes type + label (no attribute/markup injection)", () => {
  const html = agentsHtml([{ sel: false, type: "Ex\"plore", label: '<img src=x onerror=1>' }]);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-alabel="&lt;img/);
});


// --- optionCardHtml: an AskUserQuestion option card ---------------------------

test("optionCardHtml: single-select renders a Choose button, no checkbox", () => {
  const html = optionCardHtml({ label: "One-shot" }, 0, false);
  assert.match(html, /class="q-opt-pick" data-idx="0"/);
  assert.match(html, /One-shot/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("optionCardHtml: multiSelect renders a checkbox bound to its label", () => {
  const html = optionCardHtml({ label: "Feature A" }, 1, true);
  assert.match(html, /type="checkbox" class="q-check" id="qopt-1" data-idx="1"/);
  assert.match(html, /<label class="q-opt-label" for="qopt-1">Feature A<\/label>/);
  assert.doesNotMatch(html, /q-opt-pick/);
});

test("optionCardHtml: description and preview render when present", () => {
  const html = optionCardHtml(
    { label: "L", description: "what it means", preview: "Card meta row" }, 0, false);
  assert.match(html, /class="q-opt-desc">what it means</);
  assert.match(html, /<details class="q-prev-wrap">/);
  assert.match(html, /class="q-prev">Card meta row<\/pre>/);
});

test("optionCardHtml: no description/preview -> only the head", () => {
  const html = optionCardHtml({ label: "L" }, 0, false);
  assert.doesNotMatch(html, /q-opt-desc/);
  assert.doesNotMatch(html, /q-prev/);
});

test("optionCardHtml: escapes label, description and preview (no injection)", () => {
  const html = optionCardHtml(
    { label: '<b>x', description: '<i>d', preview: '<script>y</script>' }, 0, false);
  assert.doesNotMatch(html, /<b>x/);
  assert.doesNotMatch(html, /<script>y/);
  assert.match(html, /&lt;script&gt;y/);
});


// --- the compose bar: Send always sends; ◼ Stop appears only mid-turn --------
// The busy read is the live pane status (a `turn` frame every ~1s), not the
// heartbeat, so Stop appears/hides within a second of the turn starting or
// ending. Send never morphs: a mid-turn send QUEUES (the chat renders the
// "queued" bubble), so the button that talks must stay available while the
// agent works — on a phone it is the only way to send.

function fakeButtons(n = 2) {
  const mk = () => ({
    textContent: "Send", title: "", hidden: false, _s: new Set(),
    classList: { _s: new Set(), toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
  });
  const send = [], stop = [];
  for (let i = 0; i < n; i++) { send.push(mk()); stop.push(mk()); }
  global.document = { querySelectorAll: (sel) =>
    (sel === ".compose-action" ? send : sel === ".compose-stop" ? stop : []) };
  return { send, stop };
}
function clearDom() { delete global.document; }

test("compose bar: idle -> Stop hidden; generating -> Stop shown, Send unchanged", () => {
  const { send, stop } = fakeButtons();
  __stopPending(0);

  __setLiveStatus(null);
  updateComposeAction();
  assert.equal(send[0].textContent, "Send");
  assert.equal(stop[0].hidden, true);
  assert.equal(isBusy(), false);

  __setLiveStatus({ verb: "Thinking", up: "1.2k" });
  updateComposeAction();
  assert.equal(isBusy(), true);
  // Every compose bar on the page (chat's and the terminal toggle's) flips
  // together — they read the one status. Send stays Send: it queues mid-turn.
  for (const b of send) assert.equal(b.textContent, "Send");
  for (const b of stop) {
    assert.equal(b.hidden, false);
    assert.equal(b.textContent, "◼ Stop");
  }
  clearDom();
});

test("compose bar: a clicked Stop hides the button immediately", () => {
  const { send, stop } = fakeButtons();
  // The turn is still being reported — the interrupt only lands on the agent's
  // next beat — but the operator already asked for it to end.
  __setLiveStatus({ verb: "Thinking" });
  __stopPending(Date.now());
  updateComposeAction();
  assert.equal(isBusy(), false, "no waiting on the pane to catch up");
  assert.equal(stop[0].hidden, true);
  assert.equal(send[0].textContent, "Send");
  clearDom();
});

test("compose bar: a Stop that never landed gives Stop back", () => {
  fakeButtons();
  __setLiveStatus({ verb: "Thinking" });
  __stopPending(Date.now() - 60000); // clicked long ago; the turn outlived it
  assert.equal(isBusy(), true, "the turn is still running, so Stop is live again");
  clearDom();
});

test("compose bar: the turn ending clears a pending Stop", () => {
  fakeButtons();
  __setLiveStatus(null);
  __stopPending(Date.now());
  assert.equal(isBusy(), false);
  // The suppression is spent, so the NEXT turn shows Stop from its first frame.
  __setLiveStatus({ verb: "Thinking" });
  assert.equal(isBusy(), true);
  clearDom();
});

test("compose bar: a pending question hides Stop (XERK-21)", () => {
  const { send, stop } = fakeButtons();
  __stopPending(0);
  // The AskUserQuestion tool call blocks the pane, so the pane still reads busy —
  // but the answer is typed into the compose box, and an accidental Stop would
  // destroy the question, so the Stop button must not be offered.
  __setLiveStatus({ verb: "Thinking" });
  __setQuestionActive(true);
  updateComposeAction();
  assert.equal(isBusy(), false, "a live question overrides the busy pane read");
  assert.equal(send[0].textContent, "Send");
  assert.equal(stop[0].hidden, true);
  // Answering the question (questionActive clears) brings Stop back while the
  // pane is still working.
  __setQuestionActive(false);
  updateComposeAction();
  assert.equal(isBusy(), true);
  assert.equal(stop[0].hidden, false);
  __setQuestionActive(false);
  clearDom();
});

test("compose bar: a message past the host's cap says so, with the number (XERK-227)", () => {
  // The hub answers 413 for a message past the RECEIVING HOST's cap, which is
  // 4k on an agent too old to paste and 100k on a current one — so the label
  // carries the limit the hub sent rather than leaving the operator to guess
  // how much to cut. It must never read like the hub is down.
  assert.equal(sendFailure(413, 4000), "Too long — max 4,000");
  assert.equal(sendFailure(413, 100000), "Too long — max 100,000");
  assert.equal(sendFailure(413), TOO_LONG, "an older hub sends no limit");
  assert.equal(sendFailure(413, 0), TOO_LONG);
  // Every OTHER refusal is worded by the hub and shown as a toast (XERK-264),
  // so the button says what happened and never a bare status number — which
  // named nothing the operator could act on and, on the send path, was then
  // thrown away by isTooLong anyway.
  assert.equal(sendFailure(500), "Send failed");
  assert.equal(sendFailure(404), "Send failed");
  assert.equal(sendFailure(429, undefined, "the host's command queue is full"), "Send failed");
  // isTooLong is what both compose bars test the thrown message against, so a
  // numbered label must still be recognised as the actionable failure.
  assert.ok(isTooLong("Too long — max 4,000"));
  assert.ok(isTooLong(TOO_LONG));
  assert.ok(!isTooLong("Send failed"));
  assert.ok(!isTooLong(undefined));
});

// ---- file attachments (XERK-234) -------------------------------------------

test("attachments: a chip shows the name, and what the file is doing", () => {
  const html = attachmentsHtml([
    { key: "a1", name: "shot.png", size: 2048, status: "ready", uploadId: "u1" },
    { key: "a2", name: "spec.pdf", size: 0, status: "uploading" },
    { key: "a3", name: "huge.bin", size: 0, status: "error", error: "too big — max 32 MB" },
  ]);
  assert.ok(html.includes("shot.png"));
  assert.ok(html.includes("2 KB"), "a ready file shows its size");
  assert.ok(html.includes("uploading…"), "one still on its way says so");
  assert.ok(html.includes("too big — max 32 MB"), "a failure shows the reason");
  assert.ok(html.includes("att-error"), "and is styled as one");
  // The ✕ carries the chip key the delegated remove handler reads.
  assert.ok(html.includes('data-att="a1"'));
  assert.equal(attachmentsHtml([]), "");
});

test("attachments: a chip's name and error are escaped, never injected", () => {
  const html = attachmentsHtml([
    { key: "a1", name: '<img src=x onerror=alert(1)>.png', size: 1, status: "ready" },
  ]);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("attachments: sizes read the way the android chip reads them", () => {
  assert.equal(fmtBytes(812), "812 B");
  assert.equal(fmtBytes(44 * 1024), "44 KB");
  assert.equal(fmtBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(fmtBytes(32 * 1024 * 1024), "32 MB");
});

test("attachments: nothing staged sends an empty list, not a hold", () => {
  __setAttachments([]);
  assert.deepEqual(readyUploadIds(), []);
});

test("attachments: every file ready sends their ids in order", () => {
  __setAttachments([
    { key: "a1", name: "a.png", size: 1, status: "ready", uploadId: "u1" },
    { key: "a2", name: "b.png", size: 1, status: "ready", uploadId: "u2" },
  ]);
  assert.deepEqual(readyUploadIds(), ["u1", "u2"]);
  __setAttachments([]);
});

test("attachments: a file still uploading or failed HOLDS the message", () => {
  // Sending anyway would land a message whose file is silently missing.
  __setAttachments([
    { key: "a1", name: "a.png", size: 1, status: "ready", uploadId: "u1" },
    { key: "a2", name: "b.png", size: 1, status: "uploading" },
  ]);
  assert.equal(readyUploadIds(), null);
  __setAttachments([{ key: "a1", name: "a.png", size: 1, status: "error", error: "nope" }]);
  assert.equal(readyUploadIds(), null);
  __setAttachments([]);
});

test("attachments: the clip button follows the HOST's capability, not the hub's", () => {
  // An agent that reports no uploadMaxBytes would DROP the uploads on an input
  // command without a word, so the composer must not offer the control at all.
  const clip = { hidden: false, disabled: false, title: "" };
  const strips = [{ innerHTML: "" }, { innerHTML: "" }];
  global.document = {
    querySelectorAll: (sel) => (sel === ".compose-attach" ? strips : []),
    getElementById: (id) => (id === "chatClip" ? clip : null),
  };
  __setAttachments([]);

  __setAgent({});                       // an agent predating attachments
  renderAttachments();
  assert.equal(clip.hidden, true);

  __setAgent({ uploadMaxBytes: 1 << 25 });
  renderAttachments();
  assert.equal(clip.hidden, false);

  // A pending question is answered THROUGH the compose box (POST .../answer,
  // which carries no files), so attaching is off while one is up — and says why.
  __setQuestionActive(true);
  renderAttachments();
  assert.equal(clip.disabled, true);
  assert.match(clip.title, /Answer the question first/);
  __setQuestionActive(false);
  renderAttachments();
  assert.equal(clip.disabled, false);

  // Both strips are painted from one read, so the chat's and the terminal's can
  // never disagree about what is attached.
  __setAttachments([{ key: "a1", name: "a.png", size: 1, status: "ready", uploadId: "u1" }]);
  renderAttachments();
  assert.ok(strips[0].innerHTML.includes("a.png"));
  assert.equal(strips[0].innerHTML, strips[1].innerHTML);

  __setAttachments([]);
  __setAgent(null);
  clearDom();
});

test("attachments: an expired staged file is an actionable refusal, not 'Send failed'", () => {
  // The hub 404s when a staged upload aged out of its relay; the operator can
  // fix that by re-attaching, so it gets its own wording like "too long" does.
  const msg = sendFailure(404, undefined, "an attachment expired before it was sent — re-attach it");
  assert.equal(msg, "Attachment expired — re-attach");
  assert.ok(isTooLong(msg), "both compose bars show it verbatim");
  // A plain 404 with no attachment in it has no special wording; its reason
  // rides the toast instead (XERK-264).
  assert.equal(sendFailure(404, undefined, "unknown agent"), "Send failed");
  assert.equal(sendFailure(404), "Send failed");
});

test("attachments: the per-message cap matches the hub's", () => {
  assert.equal(MAX_ATTACHMENTS, 10);
});

// --- local-model failover chip (XERK-246) ------------------------------------
// The control follows the HOST's reported capability, exactly like the 📎
// follows uploadMaxBytes: an agent reporting no `localModel` cannot fail a
// session over, so offering the switch would queue a command it silently drops.

test("model source: the switch is offered only when the host reports one", () => {
  __setModelSourcePending(null);
  __setSess({ id: "s1", modelSource: "subscription" });
  __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
  assert.equal(localModelOffered(), true);
  __setAgent({});                       // an agent predating the failover
  assert.equal(localModelOffered(), false);
  __setAgent({ localModel: { available: false } });
  assert.equal(localModelOffered(), false);
});

test("model source: a session already on local keeps a way back", () => {
  // The host's configuration can be removed under a running session; without
  // this it would be stranded on the local model with no visible switch.
  __setModelSourcePending(null);
  __setSess({ id: "s1", modelSource: "local" });
  __setAgent({});
  assert.equal(localModelOffered(), true);
  assert.equal(currentModelSource(), "local");
});

test("model source: defaults to subscription when the agent never says", () => {
  __setModelSourcePending(null);
  __setSess({ id: "s1" });              // no modelSource at all
  __setAgent({ localModel: { available: true } });
  assert.equal(currentModelSource(), "subscription");
});

test("model source: an in-flight switch paints the target, not the stale beat", () => {
  __setSess({ id: "s1", modelSource: "subscription" });
  __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
  __setModelSourcePending({ value: "local", at: Date.now(), sessionId: "s1" });
  assert.equal(currentModelSource(), "local");
  assert.equal(modelSourceLabel(), "gpt-oss:120b");
  // A stale memo must not pin the chip forever if the switch never lands.
  __setModelSourcePending({ value: "local", at: Date.now() - 120000, sessionId: "s1" });
  assert.equal(currentModelSource(), "subscription");
  __setModelSourcePending(null);
});

test("model source: the menu names the host's actual model", () => {
  __setModelSourcePending(null);
  __setSess({ id: "s1", modelSource: "subscription" });
  __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
  assert.deepEqual(modelSourceOpts().map((o) => o.value), ["subscription", "local"]);
  assert.equal(modelSourceOpts()[1].label, "gpt-oss:120b");
  assert.equal(modelSourceLabel(), "Subscription");
});

test("model source: a pending switch never leaks onto another session", () => {
  // Regression: the memo was module-global and survived opening a different
  // session, so a subscription session wore the 🏠 mark and its own switch
  // click was swallowed by the value === currentModelSource() early-return.
  __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
  __setSess({ id: "AAAAA", modelSource: "subscription" });
  __setModelSourcePending({ value: "local", at: Date.now(), sessionId: "AAAAA" });
  assert.equal(currentModelSource(), "local");        // its own session: honoured
  __setSess({ id: "BBBBB", modelSource: "subscription" });
  assert.equal(currentModelSource(), "subscription"); // a different one: ignored
  __setModelSourcePending(null);
});

test("model source: a local session's model chip is fixed, not a picker", () => {
  // Every row the picker could offer is a Claude alias the gateway refuses —
  // "Default" included, since it resolves to the login default — so offering
  // the menu can only break the session, with no row to switch back to.
  __setModelSourcePending(null);
  __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
  __setSess({ id: "s1", modelSource: "local" });
  assert.equal(currentModelSource(), "local");
  __setSess({ id: "s1", modelSource: "subscription" });
  assert.equal(currentModelSource(), "subscription");
});

test("model source: a memo with no session id is not honoured blindly", () => {
  // The read-site guard tolerated a session-less memo, so dropping the
  // sessionId from setSessionModelSource escaped every test. A memo must know
  // whose it is.
  __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
  __setSess({ id: "AAAAA", modelSource: "subscription" });
  __setModelSourcePending({ value: "local", at: Date.now() });   // no sessionId
  const painted = currentModelSource();
  __setModelSourcePending(null);
  assert.equal(painted, "subscription",
    "a memo that cannot prove which session it belongs to must not paint one");
});

test("model source: choosing one actually issues the switch request", () => {
  // Painting the memo is not the switch. Without the request the chip moves,
  // the heartbeat never agrees, and the memo ages out — a control that looks
  // like it worked and did nothing.
  const calls = [];
  const realFetch = global.fetch;
  // renderComposeOpts runs first and reaches for the composer element.
  const realDoc = global.document;
  global.document = { getElementById: () => null, querySelectorAll: () => [],
                      addEventListener() {} };
  global.fetch = (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
  try {
    __setAgent({ localModel: { available: true, model: "gpt-oss:120b" } });
    __setSess({ id: "AAAAA", modelSource: "subscription" });
    __setHostKey("hostA");
    __setModelSourcePending(null);
    setSessionModelSource("local");
  } finally {
    global.fetch = realFetch;
    if (realDoc === undefined) delete global.document; else global.document = realDoc;
  }
  assert.equal(calls.length, 1, "one POST issued");
  assert.match(calls[0].url, /\/sessions\/AAAAA\/model-source$/);
  assert.deepEqual(calls[0].body, { modelSource: "local" });
  __setModelSourcePending(null);
});
