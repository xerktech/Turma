// Unit tests for tunnel-agent.js's live transcript-tail helpers (node:test,
// built-in — matches turma/tests' zero-npm-dependency stance). CI runs
// them in a throwaway node:24-alpine container: `node --test agent/tests/`.
//
// These helpers are a JS re-implementation of hub-agent.py's transcript_tail /
// _entry_text / _project_slug; the parity assertions below are the guard that
// they stay byte-for-byte compatible with the Python the heartbeat uses.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

// Isolated projects root + a stable device name so requiring the module never
// shells out to `docker`/reads /host files. Must be set BEFORE the require.
const PROJECTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-tail-"));
process.env.CLAUDE_PROJECTS_ROOT = PROJECTS_ROOT;
process.env.DEVICE_NAME = "testhost";
process.env.TURMA_TOKEN = "x";

const { projectSlug, transcriptTail, entryText, entryBlocks, entryRole, entryToolSource, newestTranscript, sessionTranscript, pokeHeartbeat, parseTaskNotification, parseLocalCommand, awaySummaryText, foldQueueOp, entryId, BLOCK_CAPS_LIVE } = require("../tunnel-agent.js");

const ESC = String.fromCharCode(27); // ANSI escape, kept out of the source as a literal

function writeTranscript(worktreePath, name, entries) {
  const dir = path.join(PROJECTS_ROOT, projectSlug(worktreePath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return dir;
}

test("projectSlug maps every non-alphanumeric char to '-' (dotted worktree paths)", () => {
  assert.equal(projectSlug("/mnt/data/.turma/worktrees/abc"), "-mnt-data--turma-worktrees-abc");
});

test("entryText: string content, ANSI-stripped list content, tool_use, drops", () => {
  assert.equal(entryText({ type: "user", message: { content: "plain" } }), "plain");
  assert.equal(
    entryText({
      type: "assistant",
      message: { content: [{ type: "text", text: `hi ${ESC}[31mred${ESC}[0m` }, { type: "tool_use", name: "Bash" }, { type: "thinking", thinking: "x" }] },
    }),
    "hi red[Bash]"
  );
  assert.equal(entryText({ type: "system", message: { content: "nope" } }), null); // wrong type
  assert.equal(entryText({ type: "assistant", message: { content: "" } }), null); // empty
  assert.equal(entryText({ type: "user", message: { content: [{ type: "tool_result", content: "r" }] } }), null); // tool_result only
});

test("entryBlocks: string content -> one text block", () => {
  assert.deepEqual(entryBlocks({ type: "user", message: { content: "hi" } }, BLOCK_CAPS_LIVE), [{ t: "text", text: "hi" }]);
});

test("entryBlocks: preserves thinking, tool_use input, tool_result output that entryText drops", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: `pon${ESC}[0mder` },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la", timeout: 5 } },
      ],
    },
  };
  assert.deepEqual(entryBlocks(entry, BLOCK_CAPS_LIVE), [
    { t: "thinking", text: "ponder" },
    { t: "text", text: "answer" },
    { t: "tool_use", name: "Bash", input: "ls -la", id: "toolu_1" },
  ]);
});

test("entryBlocks: tool_result pairs via forId, flags isError, flattens list content", () => {
  const entry = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "boom" }], is_error: true },
      ],
    },
  };
  assert.deepEqual(entryBlocks(entry, BLOCK_CAPS_LIVE), [
    { t: "tool_result", text: "boom", forId: "toolu_1", isError: true },
  ]);
});

test("entryBlocks: tool_use with unknown input falls back to compact JSON", () => {
  const blocks = entryBlocks({ type: "assistant", message: { content: [{ type: "tool_use", name: "X", input: { a: 1, b: "z" } }] } }, BLOCK_CAPS_LIVE);
  assert.deepEqual(blocks, [{ t: "tool_use", name: "X", input: '{"a":1,"b":"z"}' }]);
});

test("entryBlocks: SendUserFile embeds image/SVG/HTML files, degrades the rest (XERK-221)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suf-"));
  fs.writeFileSync(path.join(dir, "a.svg"), "<svg><rect/></svg>");
  fs.writeFileSync(path.join(dir, "p.html"), "<h1>Hi</h1>");
  const inp = {
    files: [path.join(dir, "a.svg"), path.join(dir, "p.html"),
            path.join(dir, "gone.png"), path.join(dir, "notes.txt")],
    display: "render", caption: "the set",
  };
  const [b] = entryBlocks(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "SendUserFile", input: inp }] } },
    BLOCK_CAPS_LIVE);
  assert.equal(b.caption, "the set");
  assert.deepEqual(b.files, [
    { name: "a.svg", kind: "image", src: "data:image/svg+xml;base64," + Buffer.from("<svg><rect/></svg>").toString("base64") },
    { name: "p.html", kind: "html", html: "<h1>Hi</h1>" },
    { name: "gone.png", kind: "file" }, // missing → chip
    { name: "notes.txt", kind: "file" }, // non-renderable type → chip (never opened)
  ]);
  // display:"attach" turns an HTML file into a download chip (not an iframe).
  const [b2] = entryBlocks(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "SendUserFile",
      input: { files: [path.join(dir, "p.html")], display: "attach" } }] } }, BLOCK_CAPS_LIVE);
  assert.deepEqual(b2.files, [{ name: "p.html", kind: "file" }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("entryBlocks: over-cap text/result get truncated:true and are clipped", () => {
  const big = "x".repeat(BLOCK_CAPS_LIVE.text + 500);
  const [tb] = entryBlocks({ type: "assistant", message: { content: big } }, BLOCK_CAPS_LIVE);
  assert.equal(tb.text.length, BLOCK_CAPS_LIVE.text);
  assert.equal(tb.truncated, true);

  const bigOut = "y".repeat(BLOCK_CAPS_LIVE.result + 500);
  const [rb] = entryBlocks({ type: "user", message: { content: [{ type: "tool_result", content: bigOut }] } }, BLOCK_CAPS_LIVE);
  assert.equal(rb.text.length, BLOCK_CAPS_LIVE.result);
  assert.equal(rb.truncated, true);
});

test("entryBlocks: wrong type / no message -> null; empty content -> []", () => {
  assert.equal(entryBlocks({ type: "system", message: { content: "x" } }, BLOCK_CAPS_LIVE), null);
  assert.equal(entryBlocks({ type: "user" }, BLOCK_CAPS_LIVE), null);
  assert.deepEqual(entryBlocks({ type: "assistant", message: { content: "" } }, BLOCK_CAPS_LIVE), []);
});

// Mirror of test_hub_agent.py TestTaskNotification — keep in lockstep.
const TASK_NOTIFICATION =
  "<task-notification>\n<task-id>af9e62627de15eaf4</task-id>\n" +
  "<tool-use-id>toolu_01Cv</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n" +
  "<status>completed</status>\n<summary>Agent \"Confirm merge semantics\" finished</summary>\n" +
  "<note>A task-notification fires each time this agent stops.</note>\n" +
  "<result>The --settings file is merged as a higher-precedence layer.</result>\n" +
  "</task-notification>";

test("parseTaskNotification: extracts summary/status/result, ignores non-notifications", () => {
  assert.deepEqual(parseTaskNotification(TASK_NOTIFICATION), {
    summary: 'Agent "Confirm merge semantics" finished',
    status: "completed",
    result: "The --settings file is merged as a higher-precedence layer.",
  });
  assert.equal(parseTaskNotification("just a normal prompt"), null);
  assert.equal(parseTaskNotification("talk about <task-notification> inline"), null);
  assert.equal(parseTaskNotification(""), null);
});

test("entryBlocks: task-notification -> one task_notification block (string + list content)", () => {
  const want = [{
    t: "task_notification",
    summary: 'Agent "Confirm merge semantics" finished',
    status: "completed",
    result: "The --settings file is merged as a higher-precedence layer.",
  }];
  assert.deepEqual(entryBlocks({ type: "user", message: { content: TASK_NOTIFICATION } }, BLOCK_CAPS_LIVE), want);
  assert.deepEqual(
    entryBlocks({ type: "user", message: { content: [{ type: "text", text: TASK_NOTIFICATION }] } }, BLOCK_CAPS_LIVE),
    want);
  // entryText flattens it to summary + result (the text-only tail form).
  assert.equal(
    entryText({ type: "user", message: { content: TASK_NOTIFICATION } }),
    'Agent "Confirm merge semantics" finished\n\nThe --settings file is merged as a higher-precedence layer.');
});

test("entryBlocks: background-command task-notification has no result; long result truncates", () => {
  const bg = "<task-notification>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>";
  assert.deepEqual(entryBlocks({ type: "user", message: { content: bg } }, BLOCK_CAPS_LIVE),
    [{ t: "task_notification", summary: "Background command finished", status: "completed" }]);
  const big = "z".repeat(BLOCK_CAPS_LIVE.result + 500);
  const [block] = entryBlocks(
    { type: "user", message: { content: `<task-notification>\n<summary>done</summary>\n<result>${big}</result>\n</task-notification>` } },
    BLOCK_CAPS_LIVE);
  assert.equal(block.result.length, BLOCK_CAPS_LIVE.result);
  assert.equal(block.truncated, true);
});

// Mirror of test_hub_agent.py TestLocalCommand / TestCompactSummary — keep in lockstep.
const COMMAND_CAVEAT =
  "<local-command-caveat>Caveat: The messages below were generated by the user while " +
  "running local commands. DO NOT respond to these messages or otherwise consider them " +
  "in your response unless the user explicitly asks you to.</local-command-caveat>";
const COMMAND_INVOCATION =
  "<command-name>/compact</command-name>\n" +
  "            <command-message>compact</command-message>\n" +
  "            <command-args>summaries appear as user text</command-args>";
const COMMAND_STDOUT = "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>";

test("parseLocalCommand: caveat / invocation / stdout / stderr, ignores non-commands", () => {
  assert.deepEqual(parseLocalCommand(COMMAND_CAVEAT), { kind: "caveat" });
  assert.deepEqual(parseLocalCommand(COMMAND_INVOCATION),
    { kind: "command", name: "/compact", args: "summaries appear as user text" });
  assert.deepEqual(parseLocalCommand("<command-name>/clear</command-name>\n<command-args></command-args>"),
    { kind: "command", name: "/clear", args: "" });
  assert.deepEqual(parseLocalCommand(COMMAND_STDOUT),
    { kind: "output", text: "Compacted (ctrl+o to see full summary)", isError: false });
  assert.deepEqual(parseLocalCommand("<local-command-stderr>Error: No messages</local-command-stderr>"),
    { kind: "output", text: "Error: No messages", isError: true });
  // stderr wins when a turn carries both.
  assert.deepEqual(
    parseLocalCommand("<local-command-stdout></local-command-stdout><local-command-stderr>boom</local-command-stderr>"),
    { kind: "output", text: "boom", isError: true });
  assert.equal(parseLocalCommand("just a normal prompt"), null);
  assert.equal(parseLocalCommand("talk about <command-name> inline"), null);
  assert.equal(parseLocalCommand("why does <local-command-caveat>x</local-command-caveat> show up?"), null);
  assert.equal(parseLocalCommand(""), null);
});

test("entryBlocks: slash-command turns -> command / command_output blocks, caveat dropped", () => {
  const want = [{ t: "command", name: "/compact", args: "summaries appear as user text" }];
  assert.deepEqual(entryBlocks({ type: "user", message: { content: COMMAND_INVOCATION } }, BLOCK_CAPS_LIVE), want);
  assert.deepEqual(
    entryBlocks({ type: "user", message: { content: [{ type: "text", text: COMMAND_INVOCATION }] } }, BLOCK_CAPS_LIVE),
    want);
  assert.deepEqual(entryBlocks({ type: "user", message: { content: COMMAND_STDOUT } }, BLOCK_CAPS_LIVE),
    [{ t: "command_output", text: "Compacted (ctrl+o to see full summary)" }]);
  assert.deepEqual(
    entryBlocks({ type: "user", message: { content: "<local-command-stderr>No messages</local-command-stderr>" } }, BLOCK_CAPS_LIVE),
    [{ t: "command_output", text: "No messages", isError: true }]);
  // The caveat and an empty output contribute nothing.
  assert.deepEqual(entryBlocks({ type: "user", isMeta: true, message: { content: COMMAND_CAVEAT } }, BLOCK_CAPS_LIVE), []);
  assert.deepEqual(entryBlocks({ type: "user", message: { content: "<local-command-stdout></local-command-stdout>" } }, BLOCK_CAPS_LIVE), []);
  // entryText flattens to the invocation line / the raw output; the caveat drops.
  assert.equal(entryText({ type: "user", message: { content: COMMAND_INVOCATION } }),
    "/compact summaries appear as user text");
  assert.equal(entryText({ type: "user", message: { content: COMMAND_STDOUT } }),
    "Compacted (ctrl+o to see full summary)");
  assert.equal(entryText({ type: "user", isMeta: true, message: { content: COMMAND_CAVEAT } }), null);
});

// Mirror of test_hub_agent.py TestBashPassthrough — keep in lockstep.
test("parseLocalCommand: `!` bash passthrough turns -> command / output shapes", () => {
  assert.deepEqual(parseLocalCommand("<bash-input> git status</bash-input>"),
    { kind: "command", name: "!", args: "git status" });
  assert.deepEqual(parseLocalCommand("<bash-stdout>2 files changed</bash-stdout>"),
    { kind: "output", text: "2 files changed", isError: false });
  assert.deepEqual(parseLocalCommand("<bash-stderr>fatal: not a repo</bash-stderr>"),
    { kind: "output", text: "fatal: not a repo", isError: true });
  // Both tags with one empty: the empty stream must not win by matching first.
  assert.deepEqual(parseLocalCommand("<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>"),
    { kind: "output", text: "ok", isError: false });
  assert.deepEqual(parseLocalCommand("<bash-stdout></bash-stdout><bash-stderr>boom</bash-stderr>"),
    { kind: "output", text: "boom", isError: true });
  assert.equal(parseLocalCommand("talk about <bash-input> inline"), null);
  // The blocks + text feeds treat it exactly like a slash command.
  assert.deepEqual(
    entryBlocks({ type: "user", message: { content: "<bash-input> ls -la</bash-input>" } }, BLOCK_CAPS_LIVE),
    [{ t: "command", name: "!", args: "ls -la" }]);
  assert.equal(entryText({ type: "user", message: { content: "<bash-input> ls</bash-input>" } }), "! ls");
});

// Mirror of test_hub_agent.py TestInterruptMarker — keep in lockstep.
test("entryBlocks: an interrupt marker is a status block, not a user bubble", () => {
  for (const text of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
    for (const content of [text, [{ type: "text", text }]]) {
      assert.deepEqual(entryBlocks({ type: "user", message: { content } }, BLOCK_CAPS_LIVE),
        [{ t: "interrupt", text }]);
    }
  }
  // The text feed keeps the raw bracket line.
  assert.equal(entryText({ type: "user", message: { content: "[Request interrupted by user]" } }),
    "[Request interrupted by user]");
  // Prose that merely mentions one stays prose.
  const prose = "the log said [Request interrupted by user] at 3pm";
  assert.deepEqual(entryBlocks({ type: "user", message: { content: prose } }, BLOCK_CAPS_LIVE),
    [{ t: "text", text: prose }]);
});

// Mirror of test_hub_agent.py TestAwaySummary — keep in lockstep.
test("entryBlocks/entryText/entryRole: the away recap surfaces; other system entries drop", () => {
  const entry = { type: "system", subtype: "away_summary",
    content: "Fixed the bug and opened a PR. (disable recaps in /config)" };
  assert.deepEqual(entryBlocks(entry, BLOCK_CAPS_LIVE),
    [{ t: "away_summary", text: "Fixed the bug and opened a PR." }]);
  assert.equal(entryText(entry), "Fixed the bug and opened a PR.");
  assert.equal(entryRole(entry), "assistant");
  assert.equal(awaySummaryText(entry), "Fixed the bug and opened a PR.");
  for (const subtype of ["turn_duration", "bridge_status", "stop_hook_summary", undefined]) {
    const other = { type: "system", subtype, content: "x" };
    assert.equal(entryBlocks(other, BLOCK_CAPS_LIVE), null);
    assert.equal(entryText(other), null);
  }
  // An empty recap (hint only) drops.
  assert.equal(entryBlocks({ type: "system", subtype: "away_summary",
    content: " (disable recaps in /config)" }, BLOCK_CAPS_LIVE), null);
});

// Mirror of test_hub_agent.py TestEntryBlocks' tool-detail cases — keep in lockstep.
test("entryBlocks: known tool calls carry their reviewable payload (edit/content/plan/desc)", () => {
  const [edit] = entryBlocks({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_e", name: "Edit", input: {
      file_path: "/repo/a.py", old_string: "x = 1", new_string: "x = 2", replace_all: true } },
  ] } }, BLOCK_CAPS_LIVE);
  assert.deepEqual(edit, { t: "tool_use", name: "Edit", input: "/repo/a.py", id: "toolu_e",
    edit: { old: "x = 1", new: "x = 2", replaceAll: true } });

  const big = "z".repeat(BLOCK_CAPS_LIVE.result + 100);
  const [clippedEdit] = entryBlocks({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Edit", input: { file_path: "/a", old_string: "x", new_string: big } },
  ] } }, BLOCK_CAPS_LIVE);
  assert.equal(clippedEdit.edit.new.length, BLOCK_CAPS_LIVE.result);
  assert.equal(clippedEdit.truncated, true);

  const [write] = entryBlocks({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Write", input: { file_path: "/repo/new.txt", content: "hello\nworld" } },
  ] } }, BLOCK_CAPS_LIVE);
  assert.equal(write.input, "/repo/new.txt");
  assert.equal(write.content, "hello\nworld");

  const [plan] = entryBlocks({ type: "assistant", message: { content: [
    { type: "tool_use", name: "ExitPlanMode", input: { plan: "## Plan\n1. do it", allowedPrompts: [] } },
  ] } }, BLOCK_CAPS_LIVE);
  assert.equal(plan.plan, "## Plan\n1. do it");

  const [bash] = entryBlocks({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Bash", input: { command: "ls", description: "List files" } },
  ] } }, BLOCK_CAPS_LIVE);
  assert.equal(bash.input, "ls");
  assert.equal(bash.desc, "List files");

  const [ask] = entryBlocks({ type: "assistant", message: { content: [
    { type: "tool_use", name: "AskUserQuestion", input: {
      questions: [{ question: "Ship it?", options: [{ label: "yes" }] }, { question: "Which env?" }] } },
  ] } }, BLOCK_CAPS_LIVE);
  assert.equal(ask.input, "Ship it? · Which env?");
});

// Mirror of test_hub_agent.py TestEntryBlocks' marker cases — keep in lockstep.
test("entryBlocks: compact_boundary and pr-link entries become status marker blocks", () => {
  assert.deepEqual(entryBlocks({ type: "system", subtype: "compact_boundary", uuid: "u1",
    content: "Conversation compacted",
    compactMetadata: { trigger: "auto", preTokens: 123380, postTokens: 5920 } }, BLOCK_CAPS_LIVE),
    [{ t: "compact_boundary", trigger: "auto", preTokens: 123380, postTokens: 5920 }]);
  const pr = { type: "pr-link", prNumber: 230, prUrl: "https://github.com/o/r/pull/230",
    prRepository: "o/r", timestamp: "2026-07-17T04:25:18.299Z" };
  assert.deepEqual(entryBlocks(pr, BLOCK_CAPS_LIVE),
    [{ t: "pr_link", url: "https://github.com/o/r/pull/230", number: 230, repo: "o/r" }]);
  // pr-link entries carry no uuid: the tail synthesizes a stable id so the
  // chat's id-keyed merge doesn't drop them. It keys on the URL ALONE, so the
  // same PR re-stamped in a later turn's preamble collapses onto one entry.
  assert.equal(entryId(pr), "pr-link:https://github.com/o/r/pull/230");
  assert.equal(entryId({ ...pr, timestamp: "2026-07-17T09:00:00.000Z" }), entryId(pr),
    "a re-stamp of the same PR must share the first one's id");
  assert.notEqual(entryId({ ...pr, prUrl: "https://github.com/o/r/pull/231" }), entryId(pr));
  assert.equal(entryId({ type: "user", uuid: "u9" }), "u9");
  assert.equal(entryBlocks({ type: "pr-link" }, BLOCK_CAPS_LIVE), null);
});

// Mirror of test_hub_agent.py TestToolReferenceResult — keep in lockstep.
test("entryBlocks: tool_reference blocks in a tool_result flatten to named lines", () => {
  const entry = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1",
    content: [{ type: "text", text: "loaded:" }, { type: "tool_reference", tool_name: "WebFetch" }] }] } };
  assert.deepEqual(entryBlocks(entry, BLOCK_CAPS_LIVE),
    [{ t: "tool_result", text: "loaded:\n[tool: WebFetch]", forId: "t1" }]);
});

// Mirror of test_hub_agent.py TestQueuedPrompts — keep in lockstep.
test("foldQueueOp: FIFO enqueue/dequeue/remove; unmatched ops are no-ops", () => {
  const q = [];
  foldQueueOp({ operation: "enqueue", content: "first" }, q);
  foldQueueOp({ operation: "enqueue", content: "second" }, q);
  foldQueueOp({ operation: "enqueue", content: "third" }, q);
  foldQueueOp({ operation: "dequeue" }, q);
  foldQueueOp({ operation: "remove", content: "third" }, q);
  assert.deepEqual(q, ["second"]);
  const empty = [];
  foldQueueOp({ operation: "dequeue" }, empty);
  foldQueueOp({ operation: "remove", content: "ghost" }, empty);
  foldQueueOp({ operation: "enqueue", content: "  " }, empty);
  assert.deepEqual(empty, []);
});

test("transcriptTail: still-queued prompts ride beside the entries", () => {
  const wt = "/wt/queued";
  writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "start work" } },
    { type: "queue-operation", operation: "enqueue", content: "also do X" },
    { type: "queue-operation", operation: "enqueue", content: "and Y" },
    { type: "queue-operation", operation: "dequeue" },
    // the dequeued prompt lands as its real user turn — no duplicate
    { uuid: "u2", type: "user", message: { content: "also do X" } },
  ]);
  const tail = transcriptTail(wt);
  assert.deepEqual(tail.entries.map((e) => e.id), ["u1", "u2"]);
  assert.deepEqual(tail.queued, ["and Y"]);
});

test("transcriptTail: a queued task-notification keeps its FIFO slot but never displays", () => {
  const wt = "/wt/queued-tn";
  writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "start" } },
    { type: "queue-operation", operation: "enqueue",
      content: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" },
    { type: "queue-operation", operation: "enqueue", content: "real prompt" },
    { type: "queue-operation", operation: "dequeue" }, // pops the notification
  ]);
  assert.deepEqual(transcriptTail(wt).queued, ["real prompt"]);
});

test("entryBlocks: command args omitted when empty; long output truncates", () => {
  assert.deepEqual(
    entryBlocks({ type: "user", message: { content: "<command-name>/clear</command-name>\n<command-args></command-args>" } }, BLOCK_CAPS_LIVE),
    [{ t: "command", name: "/clear" }]);
  const big = "z".repeat(BLOCK_CAPS_LIVE.result + 500);
  const [block] = entryBlocks(
    { type: "user", message: { content: `<local-command-stdout>${big}</local-command-stdout>` } }, BLOCK_CAPS_LIVE);
  assert.equal(block.text.length, BLOCK_CAPS_LIVE.result);
  assert.equal(block.truncated, true);
});

test("entryRole/entryBlocks: a compact summary is the assistant's, not the user's", () => {
  const summary = "This session is being continued from a previous conversation…";
  const entry = { type: "user", isCompactSummary: true, message: { role: "user", content: summary } };
  assert.equal(entryRole(entry), "assistant");
  assert.equal(entryRole({ type: "user", message: { content: "hi" } }), "user");
  assert.equal(entryRole({ type: "assistant", message: { content: "hi" } }), "assistant");
  assert.deepEqual(entryBlocks(entry, BLOCK_CAPS_LIVE), [{ t: "compact_summary", text: summary }]);
  // The same text on an ordinary user turn stays a plain text block.
  assert.deepEqual(entryBlocks({ type: "user", message: { content: summary } }, BLOCK_CAPS_LIVE),
    [{ t: "text", text: summary }]);
  // The text feed keeps the prose; only the role moved.
  assert.equal(entryText(entry), summary);
});

test("entryToolSource/entryBlocks: a skill body is its Skill call's result, not a user turn", () => {
  const body = "Base directory for this skill: /repos/x/.claude/skills/verify\n\n# Verifying Turma changes";
  const entry = {
    type: "user", isMeta: true, sourceToolUseID: "toolu_01ABC",
    message: { role: "user", content: [{ type: "text", text: body }] },
  };
  assert.equal(entryToolSource(entry), "toolu_01ABC");
  assert.equal(entryToolSource({ type: "user", message: { content: "hi" } }), null);
  // An assistant turn is never tool-authored, whatever it carries.
  assert.equal(entryToolSource({ type: "assistant", sourceToolUseID: "toolu_01ABC", message: {} }), null);
  assert.deepEqual(entryBlocks(entry, BLOCK_CAPS_LIVE),
    [{ t: "tool_result", text: body, forId: "toolu_01ABC" }]);
  // The same body typed by a human is the operator talking: still a text block.
  assert.deepEqual(entryBlocks({ type: "user", message: { content: [{ type: "text", text: body }] } }, BLOCK_CAPS_LIVE),
    [{ t: "text", text: body }]);
  // The text feed carries no tool results, so it drops the wall.
  assert.equal(entryText(entry), null);
});

test("entryBlocks: a long skill body is capped and truncated", () => {
  const big = "z".repeat(BLOCK_CAPS_LIVE.result + 500);
  const [block] = entryBlocks({
    type: "user", sourceToolUseID: "toolu_01ABC",
    message: { content: [{ type: "text", text: big }] },
  }, BLOCK_CAPS_LIVE);
  assert.equal(block.t, "tool_result");
  assert.equal(block.text.length, BLOCK_CAPS_LIVE.result);
  assert.equal(block.truncated, true);
});

test("transcriptTail: a compact summary rides under the assistant role", () => {
  writeTranscript("/w/compact", "a.jsonl", [
    { uuid: "u1", type: "user", message: { content: "hi" } },
    { uuid: "u2", type: "user", isCompactSummary: true, message: { content: "the summary" } },
  ]);
  const tail = transcriptTail("/w/compact").entries;
  assert.deepEqual(tail.map((e) => [e.id, e.role]), [["u1", "user"], ["u2", "assistant"]]);
  assert.deepEqual(tail[1].blocks, [{ t: "compact_summary", text: "the summary" }]);
});

test("transcriptTail: oldest-first, rich blocks, tolerates broken lines", () => {
  const wt = "/wt/a";
  writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "hello there" } },
    { uuid: "a1", type: "assistant", message: { content: [{ type: "text", text: `hi ${ESC}[31mred${ESC}[0m done` }, { type: "tool_use", name: "Bash" }] } },
    { uuid: "tr1", type: "user", message: { content: [{ type: "tool_result", content: "ignored" }] } },
    "{broken json",
    { uuid: "a2", type: "assistant", message: { content: [{ type: "text", text: "final answer" }] } },
    { uuid: "a3", type: "assistant", message: { content: "" } },
  ]);
  // text stays the backward-compat flat string; blocks is the additive rich
  // feed. The tool_result-only turn (tr1) now surfaces via blocks (rich-path
  // widening) with text:"" — a3 (empty, no blocks) is still dropped.
  assert.deepEqual(transcriptTail(wt), { entries: [
    { id: "u1", role: "user", text: "hello there", blocks: [{ t: "text", text: "hello there" }] },
    { id: "a1", role: "assistant", text: "hi red done[Bash]", blocks: [{ t: "text", text: "hi red done" }, { t: "tool_use", name: "Bash", input: "" }] },
    { id: "tr1", role: "user", text: "", blocks: [{ t: "tool_result", text: "ignored" }] },
    { id: "a2", role: "assistant", text: "final answer", blocks: [{ t: "text", text: "final answer" }] },
  ], queued: [] });
});

test("transcriptTail: picks the newest transcript, caps at 30 messages", () => {
  const wt = "/wt/b";
  writeTranscript(wt, "old.jsonl", [{ uuid: "old", type: "assistant", message: { content: "stale" } }]);
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ uuid: `m${i}`, type: "assistant", message: { content: `msg${i}` } });
  const dir = writeTranscript(wt, "new.jsonl", many);
  // Make new.jsonl unambiguously newer.
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(dir, "new.jsonl"), now, now);
  fs.utimesSync(path.join(dir, "old.jsonl"), now - 100, now - 100);

  const tail = transcriptTail(wt).entries;
  assert.equal(tail.length, 30); // TAIL_MSGS
  assert.equal(tail[0].id, "m10"); // last 30 of 40
  assert.equal(tail[29].id, "m39");
  assert.ok(!tail.some((e) => e.id === "old"));
});

test("transcriptTail: no transcript -> []", () => {
  assert.deepEqual(transcriptTail("/wt/does-not-exist"), { entries: [], queued: [] });
  assert.equal(newestTranscript("/wt/does-not-exist"), null);
});

// XERK-6: every repos-root session shares REPOS_ROOT as its cwd, so one project
// dir holds every root session's transcript and "the newest one here" is not the
// same question as "this session's". The hub names the id; these are the rules
// for using it. Mirrors _session_transcript_path in hub-agent.py.
test("sessionTranscript: the named transcript wins over a newer neighbour", () => {
  const wt = "/wt/root-shared";
  const dir = writeTranscript(wt, "sess-a.jsonl", [
    { uuid: "a1", type: "user", message: { content: "session A work" } },
  ]);
  writeTranscript(wt, "sess-b.jsonl", [
    { uuid: "b1", type: "user", message: { content: "session B work" } },
  ]);
  // A is the newest on disk; B is the session we're watching.
  fs.utimesSync(path.join(dir, "sess-b.jsonl"), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(dir, "sess-a.jsonl"), new Date(9000), new Date(9000));

  assert.equal(sessionTranscript(wt, "sess-b"), path.join(dir, "sess-b.jsonl"));
  assert.deepEqual(transcriptTail(wt, null, "sess-b").entries.map((e) => e.text), ["session B work"]);
  // Without an id — a hub predating the pin — newest-mtime is all there is.
  assert.equal(sessionTranscript(wt, null), path.join(dir, "sess-a.jsonl"));
  assert.deepEqual(transcriptTail(wt, null).entries.map((e) => e.text), ["session A work"]);
});

test("sessionTranscript: a named-but-absent transcript is empty, never a neighbour's", () => {
  // A root session that hasn't spoken yet. Falling back to newest here is the
  // bug itself: it would tail the previous root session's conversation.
  const wt = "/wt/root-unspoken";
  writeTranscript(wt, "sess-a.jsonl", [
    { uuid: "a1", type: "user", message: { content: "session A work" } },
  ]);
  assert.equal(sessionTranscript(wt, "sess-new"), null);
  assert.deepEqual(transcriptTail(wt, null, "sess-new"), { entries: [], queued: [] });
});

test("sessionTranscript: a traversing id names nothing", () => {
  const wt = "/wt/root-shared";
  assert.equal(sessionTranscript(wt, "../../etc/passwd"), null);
  assert.equal(sessionTranscript(wt, "a/b"), null);
});

test("transcriptTail: with a cache, an unchanged file is not re-parsed", () => {
  const wt = "/wt/cache";
  const dir = writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "one" } },
  ]);
  const p = path.join(dir, "t.jsonl");
  const cache = { path: null, mtimeMs: 0, size: 0, result: { entries: [], queued: [] } };

  const first = transcriptTail(wt, cache);
  assert.deepEqual(first, { entries: [{ id: "u1", role: "user", text: "one", blocks: [{ t: "text", text: "one" }] }], queued: [] });
  assert.equal(cache.path, p); // primed

  // File untouched: the cache must skip the read+parse and hand back the EXACT
  // prior result object (a re-parse would build an equal-but-distinct array).
  const cached = transcriptTail(wt, cache);
  assert.equal(cached, first); // same reference -> no read+parse happened

  // A real change (mtime advances, new content) busts the cache and re-parses.
  writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "one" } },
    { uuid: "a1", type: "assistant", message: { content: "two" } },
  ]);
  const later = Date.now() / 1000 + 5;
  fs.utimesSync(p, later, later);
  const reparsed = transcriptTail(wt, cache);
  assert.deepEqual(reparsed, { entries: [
    { id: "u1", role: "user", text: "one", blocks: [{ t: "text", text: "one" }] },
    { id: "a1", role: "assistant", text: "two", blocks: [{ t: "text", text: "two" }] },
  ], queued: [] });
});

// Stub process.kill so these never actually signal anything — just capture what
// pokeHeartbeat would send.
function capturePoke(env) {
  const calls = [];
  const realKill = process.kill;
  const realEnv = process.env.TURMA_MANAGER_PID;
  process.kill = (pid, sig) => calls.push([pid, sig]);
  if (env === undefined) delete process.env.TURMA_MANAGER_PID;
  else process.env.TURMA_MANAGER_PID = env;
  try {
    pokeHeartbeat();
  } finally {
    process.kill = realKill;
    if (realEnv === undefined) delete process.env.TURMA_MANAGER_PID;
    else process.env.TURMA_MANAGER_PID = realEnv;
  }
  return calls;
}

test("pokeHeartbeat signals the manager pid the launcher named", () => {
  // The native launcher exports its own $$, which exec makes the manager's.
  assert.deepEqual(capturePoke("4242"), [[4242, "SIGUSR1"]]);
});

test("pokeHeartbeat falls back to PID 1 (the container's exec'd manager)", () => {
  assert.deepEqual(capturePoke(undefined), [[1, "SIGUSR1"]]);
  // A garbage/empty value must not signal pid 0 — that is "every process in our
  // group", not "no one".
  assert.deepEqual(capturePoke(""), [[1, "SIGUSR1"]]);
  assert.deepEqual(capturePoke("nonsense"), [[1, "SIGUSR1"]]);
});

test("pokeHeartbeat swallows a failing signal (best-effort)", () => {
  const realKill = process.kill;
  process.kill = () => {
    throw new Error("no such process");
  };
  try {
    assert.doesNotThrow(() => pokeHeartbeat());
  } finally {
    process.kill = realKill;
  }
});

// --- live TUI pane parsing (real-time assistant streaming) ------------------
// parsePaneLiveTurn extracts the in-progress assistant turn from a `tmux
// capture-pane` snapshot. Fixtures mirror real Claude Code v2.1.x TUI output.
const RULE = "─".repeat(100); // the input box's ─ border

test("parsePaneLiveTurn: extracts the streaming assistant text while generating", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "╭─ Claude ─╮",
    "│ Welcome │",
    "╰────────╯",
    "",
    "❯ Write a short haiku about the ocean",
    "● Haiku",
    "  Salt breath meets the shore,",
    "  gulls trace the tide's silver seam,",
    "  blue swallowing sky.",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "Haiku Salt breath meets the shore, gulls trace the tide's silver seam, blue swallowing sky.");
});

test("parsePaneLiveTurn: thinking (no assistant text yet) -> generating, empty text", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Write a haiku",
    "· Honking…",
    "  tmux detected",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents",
  ].join("\n");
  assert.deepEqual(parsePaneLiveTurn(pane), {
    generating: true, text: "", status: { verb: "Honking", up: "", down: "", elapsed: "" },
  });
});

test("parsePaneLiveTurn: completed turn (no 'esc to interrupt') -> not generating", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Write a haiku",
    "● Haiku",
    "  Salt breath meets the shore,",
    "✻ Worked for 4s",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on · ← for agents",
  ].join("\n");
  assert.deepEqual(parsePaneLiveTurn(pane), { generating: false, text: "", status: null });
});

// XERK-130: a pane once viewed from a narrow client (a phone) stays ~54
// columns wide, and at that width the TUI ellipsizes the footer's
// "· esc to interrupt" to "· esc to inte…" — the full-string gate read every
// such working session as "not generating", so the live working bar (and the
// heartbeat's paneBusy, fixed in hub-agent.py the same way) never showed.
// Fixtures are verbatim captures from live sessions.
const NARROW_RULE = "─".repeat(54);

test("parsePaneLiveTurn: a narrow pane's truncated interrupt hint still reads generating", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ write a haiku about turtles",
    "● Cat",
    "  Sunbeam on the floor,",
    NARROW_RULE,
    "❯ ",
    NARROW_RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to inte…",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "Cat Sunbeam on the floor,");
});

test("parsePaneLiveTurn: the column-0 spinner line alone reads generating (hint fully elided)", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  // Scrunched further, or scrolled: no "esc to i…" remnant survives, but the
  // spinner line is on screen. "still thinking" has no token counter.
  const pane = [
    "· Perusing… (54m 38s · still thinking)",
    "  ⎿  Tip: Use /clear to start fresh when switching",
    NARROW_RULE,
    "❯ ",
    NARROW_RULE,
    "  ⏵⏵ bypass permissions on",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.status.verb, "Perusing");
});

test("parsePaneLiveTurn: truncated-hint anchor tolerates varying footer segments", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  // A "· PR #98" chip can sit between the mode marker and the hint, and
  // "(shift+tab to cycle)" comes and goes.
  assert.equal(parsePaneLiveTurn("  ⏵⏵ auto mode on · PR #98 · esc to inte…").generating, true);
  assert.equal(parsePaneLiveTurn("  ⏵⏵ bypass permissions on · esc to i…").generating, true);
  // An IDLE footer can be width-cut too; its remnant never starts with "e".
  assert.equal(parsePaneLiveTurn("  ⏵⏵ auto mode on · PR #98 · ← for ag…").generating, false);
});

test("parsePaneLiveTurn: an idle narrow pane (completed-turn line, no hint) stays not generating", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  // "✻ Brewed for 9s" is a spinner GLYPH at column 0 but no gerund ellipsis —
  // it stays on the idle screen and must not fake busy forever.
  const pane = [
    "  the cat sleeps through it.",
    "",
    "✻ Brewed for 9s",
    NARROW_RULE,
    "❯ ",
    NARROW_RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  assert.deepEqual(parsePaneLiveTurn(pane), { generating: false, text: "", status: null });
});

// Claude Code ≥2.1 paints its collapsed tool-activity summary as prose-shaped
// lines inside the assistant ● block ("Running 1 shell command…", "Ran 1 shell
// command", "Reading 1 file, listing 1 directory, running 1 shell command…").
// Left in the streamed text they mutate the block's tail every repaint and the
// chat clients retype the whole bubble from 0 over and over. Fixture lines are
// verbatim captures from Claude Code v2.1.209.
test("parsePaneLiveTurn: an in-flight shell command's activity line is stripped from the prose", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Now write one paragraph about clouds, and while writing it run this in the foreground",
    "",
    "● Clouds are among the most familiar and yet most quietly dramatic features of the sky.",
    "",
    "  Now running the foreground command:",
    "",
    "  Running 1 shell command…",
    "  ⎿  $ python3 -c 'import time; time.sleep(50)' (3s)",
    "     (ctrl+b ctrl+b (twice) to run in background)",
    "",
    "✶ Boogieing… (14s · ↓ 577 tokens)",
    "  ⎿  Tip: Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ← for agents",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text,
    "Clouds are among the most familiar and yet most quietly dramatic features of the sky. Now running the foreground command:");
});

test("parsePaneLiveTurn: a completed command's past-tense summary is stripped too", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  // The same block flips "Running 1 shell command…" -> "Ran 1 shell command"
  // when the call finishes; without the strip that flip alone re-typed the
  // whole bubble (Running->Ran is not a prefix relation either way).
  const pane = [
    "❯ Say one short sentence about the weather, then run this exact command",
    "",
    "● It's a calm, clear day with mild temperatures.",
    "",
    "  Ran 1 shell command",
    "",
    "✢ Tempering… (2s · ↓ 93 tokens)",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ← for agents",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "It's a calm, clear day with mild temperatures.");
});

test("parsePaneLiveTurn: an activity-only ● bullet yields no prose (tool renders as a card)", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  // With no prose yet in the turn, the activity summary gets its own bullet —
  // including the comma-joined multi-tool form. It must not stream as prose.
  const pane = [
    "❯ Read the file /etc/hostname, then list the files in /tmp, then say done",
    "",
    "● Reading 1 file, listing 1 directory, running 1 shell command…",
    "  ⎿  $ ls -la /tmp",
    "",
    "✶ Boogieing… (4s · ↓ 187 tokens)",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ← for agents",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "");
});

test("parsePaneLiveTurn: a narrow pane wrapping an activity clause mid-word still strips it", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  // The strip runs on the REFLOWED text, so a phone-width pane hard-wrapping
  // the clause across physical lines can't hide it from a per-line matcher.
  const pane = [
    "❯ run the release check",
    "● Kicking off the release check now.",
    "",
    "  Running 1 shell",
    "  command…",
    NARROW_RULE,
    "❯ ",
    NARROW_RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to inte…",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "Kicking off the release check now.");
});

test("stripActivityTail: diff-stat and elapsed garnish (shapes from a live session)", () => {
  const { stripActivityTail } = require("../tunnel-agent.js");
  // Claude Code also phrases activity with diff stats and appends its own
  // elapsed: "Making 1 scratchpad edit +3 -2, running 1 shell command · 26s…".
  assert.equal(stripActivityTail(
    "Let me fix the payload and assertions and re-run: Making 1 scratchpad edit +3 -2, running 1 shell command · 26s…"),
    "Let me fix the payload and assertions and re-run:");
  assert.equal(stripActivityTail("Making 1 scratchpad edit +3 -2, running 1 shell command..."), "");
  assert.equal(stripActivityTail("Running 1 shell command · 12m 19s…"), "");
});

test("committedDupe: prefix-plus-garnish suppresses phrasings the clause grammar misses", () => {
  const { committedDupe } = require("../tunnel-agent.js");
  const prose = "All five failures are my assertion strings, not the behavior — the heading is " +
    "uppercased by CSS text-transform. Let me fix the payload and assertions and re-run:";
  const entries = [{ id: "1", role: "assistant", text: prose }];
  // A re-paint of the committed prose plus a NOVEL activity phrasing (nothing
  // the clause grammar knows) is still that entry plus short garnish.
  assert.equal(committedDupe(prose + " Reticulating 1 spline backwards · 3s…", entries), true);
  // But a genuinely new block that opens with the old text and has outgrown
  // the garnish cap streams normally.
  const excess = " Now, on to something genuinely new: " +
    "the next phase needs a full rewrite of the assertions, the payload builder, " +
    "and the fabricated host record, which I will do in three separate steps.";
  assert.equal(committedDupe(prose + excess, entries), false);
});

test("stripActivityTail: clause vocabulary and ordinary prose", () => {
  const { stripActivityTail } = require("../tunnel-agent.js");
  // Stacked clauses strip iteratively; pluralized counts match.
  assert.equal(stripActivityTail("Done. Ran 1 shell command Running 2 shell commands…"), "Done.");
  assert.equal(stripActivityTail("Read 1 file, listed 1 directory, ran 1 shell command"), "");
  // Ordinary prose tails survive: no count, lowercase verb, or trailing
  // punctuation all fail the clause shape.
  assert.equal(stripActivityTail("The tide rises and falls."), "The tide rises and falls.");
  assert.equal(stripActivityTail("I ate 3 apples"), "I ate 3 apples");
  assert.equal(stripActivityTail("Ran 1 shell command."), "Ran 1 shell command.");
});

// committedDupe: while a tool call runs, the TUI keeps the finished prose on
// screen and alternates how it paints the block area, so the scrape re-delivers
// already-committed prose every other poll — forwarded verbatim, the chat
// bubble clears and re-types the same text over and over beside its committed
// copy. The watcher suppresses a live text a recent assistant entry already
// ends with. Shapes below mirror a live repro (Claude Code v2.1.209).
test("committedDupe: prose already committed behind a tool entry is a dupe", () => {
  const { committedDupe } = require("../tunnel-agent.js");
  const entries = [
    { id: "1", role: "user", text: "Write about volcanoes then run a command" },
    { id: "2", role: "assistant", text: "Volcanoes are vents in the crust.\n\nNow running the sleep command in the foreground and waiting for it to finish." },
    { id: "3", role: "assistant", text: "[Bash]" },
  ];
  // The pane re-paints the committed prose (reflowed to spaces) while [Bash]
  // is the newest assistant entry — the scan must look past the tool entry.
  assert.equal(committedDupe(
    "Volcanoes are vents in the crust. Now running the sleep command in the foreground and waiting for it to finish.",
    entries), true);
  // The pane block can be the TAIL of the entry (earlier paragraphs scrolled
  // out of the block) — endsWith, not equality.
  assert.equal(committedDupe(
    "Now running the sleep command in the foreground and waiting for it to finish.",
    entries), true);
});

test("committedDupe: markdown renders away in the pane but still matches", () => {
  const { committedDupe } = require("../tunnel-agent.js");
  // The transcript keeps the raw syntax; the pane renders it (no ** or `),
  // so the compare runs on an alphanumeric skeleton.
  const entries = [
    { id: "1", role: "assistant", text: "On your **current** build, power the strap fully **off** — the `G2` should stop cycling." },
  ];
  assert.equal(committedDupe(
    "On your current build, power the strap fully off — the G2 should stop cycling.",
    entries), true);
});

test("committedDupe: genuinely new streaming prose is not suppressed", () => {
  const { committedDupe } = require("../tunnel-agent.js");
  const entries = [
    { id: "1", role: "assistant", text: "The command finished. Here are two sentences about glaciers." },
  ];
  // A new block mid-stream (not any committed entry's tail) passes through...
  assert.equal(committedDupe("Glaciers are rivers of ice that carve valleys", entries), false);
  // ...and a SHORT new block that merely repeats the old entry's last words
  // needs full equality, so it passes through too.
  assert.equal(committedDupe("about glaciers.", entries), false);
  // Empty live text is never a dupe (nothing to suppress).
  assert.equal(committedDupe("", entries), false);
  assert.equal(committedDupe("anything", null), false);
});

test("committedDupe: only recent assistant entries count", () => {
  const { committedDupe } = require("../tunnel-agent.js");
  // A user turn quoting the same words must not suppress the assistant echoing
  // them back as new prose.
  assert.equal(committedDupe("please repeat this exact sentence back to me now",
    [{ id: "1", role: "user", text: "please repeat this exact sentence back to me now" }]), false);
  // An entry buried past the scan window no longer suppresses.
  const old = { id: "0", role: "assistant", text: "A very old paragraph about the weather patterns of the north." };
  const filler = Array.from({ length: 9 }, (_, i) => ({ id: "f" + i, role: "assistant", text: "[Bash]" }));
  assert.equal(committedDupe("A very old paragraph about the weather patterns of the north.",
    [old, ...filler]), false);
});

// resolveLiveText: within one turn the pane's last ● bullet swaps between
// streaming prose, tool/activity bullets and nothing, and at a block boundary
// the tool bullet paints BEFORE the prose's transcript entry lands — forwarded
// verbatim, the bubble blinked out into that gap and "reappeared" once the
// entry committed. The resolver holds uncommitted prose across those gaps and
// releases it the moment the tail owns it.
test("resolveLiveText: uncommitted prose is held through empty and tool-bullet frames", () => {
  const { resolveLiveText } = require("../tunnel-agent.js");
  const prose = "The rebase went clean — only the fix commit remains on the branch.";
  const entries = [{ id: "1", role: "assistant", text: "Kotlin compiles clean. Now commit." }];
  // Streaming frame emits, then the paint-gap frames keep it up.
  assert.equal(resolveLiveText(true, prose, "", entries), prose);
  assert.equal(resolveLiveText(true, "", prose, entries), prose);
  assert.equal(resolveLiveText(true, "Bash(git push origin XERK-210)", prose, entries), prose);
});

test("resolveLiveText: the held prose releases the moment the transcript commits it", () => {
  const { resolveLiveText } = require("../tunnel-agent.js");
  const prose = "The rebase went clean — only the fix commit remains on the branch.";
  const committed = [{ id: "2", role: "assistant", text: prose }];
  // Empty frame + committed entry -> hand off to the committed bubble.
  assert.equal(resolveLiveText(true, "", prose, committed), "");
  // A TUI re-paint of the now-committed prose stays suppressed too.
  assert.equal(resolveLiveText(true, prose, "", committed), "");
});

test("resolveLiveText: same block grows and never shrinks; a new block replaces the held one", () => {
  const { resolveLiveText } = require("../tunnel-agent.js");
  const entries = [];
  assert.equal(resolveLiveText(true, "The rebase went clean — only", "The rebase went", entries),
    "The rebase went clean — only");
  // A shorter re-capture of the same block keeps the longer held text.
  assert.equal(resolveLiveText(true, "The rebase went", "The rebase went clean — only", entries),
    "The rebase went clean — only");
  // A genuinely different prose block replaces a held one that never committed.
  assert.equal(resolveLiveText(true, "Now watching CI to green.", "The rebase went clean", entries),
    "Now watching CI to green.");
});

test("resolveLiveText: idle clears regardless of held state", () => {
  const { resolveLiveText } = require("../tunnel-agent.js");
  assert.equal(resolveLiveText(false, "anything", "held prose", []), "");
  assert.equal(resolveLiveText(true, "", "", []), "");
});

// liveTurnDecision holds a single busy->idle blip for one poll so a mid-repaint
// capture can't flicker the pinned working bar off (the live counterpart of
// hub-agent.py's _stable_pane_busy for the heartbeat's paneBusy).
test("liveTurnDecision: busy is emitted instantly and clears any pending hold", () => {
  const { liveTurnDecision } = require("../tunnel-agent.js");
  // From idle...
  assert.deepEqual(liveTurnDecision(false, false, true), { emit: true, gen: true, pending: false });
  // ...and it also cancels a hold that was in flight (the blip recovered).
  assert.deepEqual(liveTurnDecision(true, true, true), { emit: true, gen: true, pending: false });
});

test("liveTurnDecision: first idle frame after busy is held, not emitted", () => {
  const { liveTurnDecision } = require("../tunnel-agent.js");
  const d = liveTurnDecision(true, false, false);
  assert.equal(d.emit, false);        // skip the frame, keep the last one on screen
  assert.equal(d.gen, true);          // still consider it generating...
  assert.equal(d.pending, true);      // ...pending one confirming poll
});

test("liveTurnDecision: a second idle frame confirms and clears", () => {
  const { liveTurnDecision } = require("../tunnel-agent.js");
  // Held last poll (pending), still idle -> genuinely ended, so emit the clear.
  assert.deepEqual(liveTurnDecision(true, true, false), { emit: true, gen: false, pending: false });
});

test("liveTurnDecision: steady idle emits without holding", () => {
  const { liveTurnDecision } = require("../tunnel-agent.js");
  // Never was generating -> nothing to flicker off, so no hold.
  assert.deepEqual(liveTurnDecision(false, false, false), { emit: true, gen: false, pending: false });
});

test("parsePaneLiveTurn: ignores the right-aligned effort indicator, empty pane", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  assert.deepEqual(parsePaneLiveTurn(""), { generating: false, text: "", status: null });
  // The "● high · /effort" indicator is right-aligned (leading spaces), so a
  // pane that only has it — and no real turn — yields no assistant text.
  const pane = [
    "                                          ● high · /effort",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents",
  ].join("\n");
  assert.deepEqual(parsePaneLiveTurn(pane), { generating: true, text: "", status: null });
});

// Regression: the working-status line's verb + token counters must NOT bleed
// into the streamed assistant text — even when the spinner is on an animation
// glyph (✳ here) the old fixed break-set (●❯✻✽·*) didn't cover, which is what
// made the verb + tokens flicker in and out of the message as it animated.
test("parsePaneLiveTurn: status line (uncovered spinner glyph) stays out of the text + is parsed", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Explain recursion",
    "● Recursion is when a function calls itself.",
    "  It needs a base case to stop.",
    "✳ Cogitating… (12s · ↑ 1.2k tokens · ↓ 340 · esc to interrupt)",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "Recursion is when a function calls itself. It needs a base case to stop.");
  // None of the status glyph / verb / token text leaked into the message.
  assert.ok(!/Cogitating|tokens|1\.2k|✳/.test(r.text), "status line must not appear in the assistant text");
  assert.deepEqual(r.status, { verb: "Cogitating", up: "1.2k", down: "340", elapsed: "12s" });
});

test("parsePaneStatus: extracts verb + up/down token counters + elapsed", () => {
  const { parsePaneStatus } = require("../tunnel-agent.js");
  assert.deepEqual(parsePaneStatus("✻ Herding… (esc to interrupt · ↑ 3.5k tokens · ↓ 512)"),
    { verb: "Herding", up: "3.5k", down: "512", elapsed: "" });
  // Bare gerund with no detail yet -> just the verb.
  assert.deepEqual(parsePaneStatus("· Honking…"),
    { verb: "Honking", up: "", down: "", elapsed: "" });
  // A single count with no arrows folds into `up`.
  assert.deepEqual(parsePaneStatus("✽ Noodling… (8s · 1.2k tokens)"),
    { verb: "Noodling", up: "1.2k", down: "", elapsed: "8s" });
});

test("isStatusLine: recognizes spinner/verb/token lines glyph-agnostically, not prose", () => {
  const { isStatusLine } = require("../tunnel-agent.js");
  assert.ok(isStatusLine("✳ Cogitating… (↑ 1.2k tokens · ↓ 340)"));
  assert.ok(isStatusLine("∗ Ruminating…"));
  assert.ok(isStatusLine("  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents"));
  assert.ok(!isStatusLine("● Recursion is when a function calls itself."));
  assert.ok(!isStatusLine("  It needs a base case to stop."));
  assert.ok(!isStatusLine("✻ Worked for 4s"));
});

test("isHintLine: recognizes the corner-glyph tip/task footer, not prose", () => {
  const { isHintLine } = require("../tunnel-agent.js");
  assert.ok(isHintLine("  ⌊ Tip: Use /btw to ask a quick side question"));
  assert.ok(isHintLine("└ Updating the parser"));
  assert.ok(isHintLine("Tip: press esc to interrupt"));
  assert.ok(!isHintLine("● Recursion is when a function calls itself."));
  assert.ok(!isHintLine("  It needs a base case to stop."));
});

test("isChecklistLine: recognizes to-do items (connector or bare), not tool results", () => {
  const { isChecklistLine } = require("../tunnel-agent.js");
  assert.ok(isChecklistLine("  └ ✓ Add agent-side Jira repo triage machinery"));
  assert.ok(isChecklistLine("    ✓ Wire triage into the heartbeat"));
  assert.ok(isChecklistLine("    ■ Test agent triage + board rendering"));
  assert.ok(isChecklistLine("    □ Update CLAUDE.md"));
  // A `⎿`-connected tool-result line has prose after the glyph, not a checkbox.
  assert.ok(!isChecklistLine("  ⎿ Running tests..."));
  assert.ok(!isChecklistLine("  ⌊ Tip: Use /btw to ask a quick side question"));
  assert.ok(!isChecklistLine("● Recursion is when a function calls itself."));
});

// Regression for the reported bug: a multi-line active-task checklist under the
// spinner must come through WHOLE as status.hint (newline-joined), not just its
// first item. Only the first item carries the corner connector; the rest are
// bare checkbox lines the old single-line hint capture dropped.
test("parsePaneLiveTurn: full active-task checklist -> multi-line status.hint", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Do the triage work",
    "● Working through the plan.",
    "· Testing triage and rendering… (13m 46s · ↓ 53.2k tokens · esc to interrupt)",
    "  └ ✓ Add agent-side Jira repo triage machinery",
    "    ✓ Wire triage into the heartbeat",
    "    ✓ Render the repo chip on the board",
    "    ■ Test agent triage + board rendering",
    "    □ Update CLAUDE.md",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "Working through the plan.");
  assert.equal(r.status.hint, [
    "✓ Add agent-side Jira repo triage machinery",
    "✓ Wire triage into the heartbeat",
    "✓ Render the repo chip on the board",
    "■ Test agent triage + board rendering",
    "□ Update CLAUDE.md",
  ].join("\n"));
  // The checklist must not bleed into the streamed assistant text.
  assert.ok(!/CLAUDE\.md|heartbeat/.test(r.text));
});

// A `⎿` tool-result line sitting between the assistant text and the checklist
// footer must not be swept into the hint (its glyph is followed by prose).
test("parsePaneLiveTurn: tool-result line above the checklist stays out of the hint", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Do the work",
    "● Let me run the tests.",
    "  ⎿ Running tests...",
    "· Testing… (12s · ↓ 1.0k tokens · esc to interrupt)",
    "  └ ✓ First task",
    "    □ Second task",
    RULE,
    "❯ ",
    RULE,
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.status.hint, ["✓ First task", "□ Second task"].join("\n"));
  assert.ok(!/Running tests/.test(r.status.hint));
});

// Regression for the second working-footer line (the "⌊ Tip: …" / active-task
// hint Claude Code paints under the spinner): it must be pulled out as
// status.hint and kept out of the streamed text — regardless of whether it sits
// above or below the spinner line in the pane.
for (const [where, order] of [
  ["above", ["● Recursion is a function calling itself.",
             "  ⌊ Tip: Use /btw to ask a quick side question",
             "✳ Slithering… (38s · ↓ 1.0k tokens · esc to interrupt)"]],
  ["below", ["● Recursion is a function calling itself.",
             "✳ Slithering… (38s · ↓ 1.0k tokens · esc to interrupt)",
             "  ⌊ Tip: Use /btw to ask a quick side question"]],
]) {
  test(`parsePaneLiveTurn: contextual hint line (${where} the spinner) -> status.hint, not text`, () => {
    const { parsePaneLiveTurn } = require("../tunnel-agent.js");
    const pane = ["❯ Explain recursion", ...order, RULE, "❯ ", RULE,
      "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents"].join("\n");
    const r = parsePaneLiveTurn(pane);
    assert.equal(r.text, "Recursion is a function calling itself.");
    assert.ok(!/Tip|btw/.test(r.text), "the hint line must not leak into the assistant text");
    assert.deepEqual(r.status,
      { verb: "Slithering", up: "", down: "1.0k", elapsed: "38s",
        hint: "Tip: Use /btw to ask a quick side question" });
  });
}

test("parseAgentList: rows -> {sel,type,label}; main has no label", () => {
  const { parseAgentList } = require("../tunnel-agent.js");
  const rows = [
    "◉ main",
    "○ Explore   Explore Jira agent-side code",
    "○ Explore   Explore board page hub-side",
  ];
  assert.deepEqual(parseAgentList(rows), [
    { sel: true, type: "main", label: "" },
    { sel: false, type: "Explore", label: "Explore Jira agent-side code" },
    { sel: false, type: "Explore", label: "Explore board page hub-side" },
  ]);
});

test("parseAgentList: alternate radio glyphs + multi-word types, ignores non-rows", () => {
  const { parseAgentList } = require("../tunnel-agent.js");
  const rows = [
    "  ⏵⏵ auto mode on · esc to interrupt · ← for agents · ↓ to manage",
    "",
    "● main",
    "◯ general-purpose   Migrate the config loader",
  ];
  // The mode line and blank line carry no radio glyph, so they're not rows.
  assert.deepEqual(parseAgentList(rows), [
    { sel: true, type: "main", label: "" },
    { sel: false, type: "general-purpose", label: "Migrate the config loader" },
  ]);
});

// parsePaneLiveTurn surfaces the agent-manager list (below the input box) as
// status.agents, and it must never bleed into the streamed assistant text.
test("parsePaneLiveTurn: agent-manager list -> status.agents, not text", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ Explore the codebase",
    "● Kicking off two explorers.",
    "✳ Zesting… (45s · ↓ 2.3k tokens · esc to interrupt)",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents · ↓ to manage",
    "",
    "◉ main",
    "○ Explore   Explore Jira agent-side code",
    "○ Explore   Explore board page hub-side",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.equal(r.generating, true);
  assert.equal(r.text, "Kicking off two explorers.");
  assert.ok(!/Explore Jira|main|board page/.test(r.text), "agent list must not leak into the text");
  assert.deepEqual(r.status.agents, [
    { sel: true, type: "main", label: "" },
    { sel: false, type: "Explore", label: "Explore Jira agent-side code" },
    { sel: false, type: "Explore", label: "Explore board page hub-side" },
  ]);
});

// No agent list expanded -> status has no `agents` key at all (so the UI shows
// nothing rather than an empty list).
test("parsePaneLiveTurn: no agent-manager list -> status without agents key", () => {
  const { parsePaneLiveTurn } = require("../tunnel-agent.js");
  const pane = [
    "❯ hi",
    "✳ Zesting… (2s · esc to interrupt)",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ auto mode on · esc to interrupt · ← for agents · ↓ to manage",
  ].join("\n");
  const r = parsePaneLiveTurn(pane);
  assert.ok(r.status && !("agents" in r.status), "no expanded list -> no agents key");
});

// ---- control-channel liveness ----------------------------------------------
// The regression these guard: a hub that dies without closing the socket (the
// real case — Cloudflare holds our end open after the origin restarts) fires no
// 'close', so the reconnect never runs and the channel wedges forever. Every
// session then reads "terminal offline" while the host still heartbeats green.
//
// These drive the REAL script as a child process against a fake hub, because
// the bug lives in the socket lifecycle, not in a pure helper: a unit test of a
// mocked WebSocket would have happily passed all along.

const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const AGENT_JS = path.join(__dirname, "..", "tunnel-agent.js");

function wsEncode(op, payload) {
  const p = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0x80 | op, p.length]), p]);
}

// A hub that accepts control channels and records each one. `onConnect` decides
// how that connection behaves (ping it, or stay mute).
function fakeHub(onConnect) {
  const sockets = [];
  const srv = http.createServer();
  srv.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on("error", () => {});
    sockets.push(socket);
    onConnect(socket, sockets.length);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, sockets, port: srv.address().port }));
  });
}

function startAgent(port, extraEnv) {
  const child = spawn(process.execPath, [AGENT_JS], {
    env: {
      ...process.env,
      TURMA_URL: `http://127.0.0.1:${port}`,
      TURMA_TOKEN: "x",
      DEVICE_NAME: "testhost",
      CLAUDE_PROJECTS_ROOT: PROJECTS_ROOT,
      TURMA_CONTROL_IDLE_TIMEOUT_MS: "300",
      TURMA_CONTROL_WATCHDOG_EVERY_MS: "50",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

const waitFor = (fn, ms) =>
  new Promise((resolve) => {
    const t = setInterval(() => {
      if (fn()) {
        clearInterval(t);
        clearTimeout(k);
        resolve(true);
      }
    }, 20);
    const k = setTimeout(() => {
      clearInterval(t);
      resolve(false);
    }, ms);
  });

// The bug, end to end: hub pings, then goes silent WITHOUT closing the socket.
// The agent must notice the silence on its own and dial a fresh channel.
test("control channel: a hub that goes silent without closing is reconnected", async () => {
  const hub = await fakeHub((socket, n) => {
    // Only the first connection gets a ping — enough to arm the watchdog — then
    // that socket goes mute forever, exactly as a half-open channel does.
    if (n === 1) socket.write(wsEncode(0x1, JSON.stringify({ ping: Date.now() })));
  });
  const child = startAgent(hub.port);
  try {
    assert.ok(await waitFor(() => hub.sockets.length >= 1, 5000), "agent never connected");
    assert.ok(
      await waitFor(() => hub.sockets.length >= 2, 5000),
      "agent never reconnected after the hub went silent (the wedged-tunnel bug)"
    );
  } finally {
    child.kill();
    hub.srv.close();
  }
});

// Compat: a hub predating the app-level ping sends nothing to observe. The
// watchdog must stay disarmed there rather than tearing down a healthy channel
// every idle timeout — a new agent must not reconnect-loop against an old hub.
test("control channel: a hub that never app-pings is left alone (no reconnect loop)", async () => {
  const hub = await fakeHub(() => {}); // never pings, never closes
  const child = startAgent(hub.port);
  try {
    assert.ok(await waitFor(() => hub.sockets.length >= 1, 5000), "agent never connected");
    // Well past several idle timeouts: still exactly one channel.
    const looped = await waitFor(() => hub.sockets.length >= 2, 1200);
    assert.ok(!looped, "agent reconnect-looped against a hub that does not app-ping");
  } finally {
    child.kill();
    hub.srv.close();
  }
});
