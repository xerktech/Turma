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

const { projectSlug, transcriptTail, entryText, entryBlocks, newestTranscript, pokeHeartbeat, BLOCK_CAPS_LIVE } = require("../tunnel-agent.js");

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
  assert.deepEqual(transcriptTail(wt), [
    { id: "u1", role: "user", text: "hello there", blocks: [{ t: "text", text: "hello there" }] },
    { id: "a1", role: "assistant", text: "hi red done[Bash]", blocks: [{ t: "text", text: "hi red done" }, { t: "tool_use", name: "Bash", input: "" }] },
    { id: "tr1", role: "user", text: "", blocks: [{ t: "tool_result", text: "ignored" }] },
    { id: "a2", role: "assistant", text: "final answer", blocks: [{ t: "text", text: "final answer" }] },
  ]);
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

  const tail = transcriptTail(wt);
  assert.equal(tail.length, 30); // TAIL_MSGS
  assert.equal(tail[0].id, "m10"); // last 30 of 40
  assert.equal(tail[29].id, "m39");
  assert.ok(!tail.some((e) => e.id === "old"));
});

test("transcriptTail: no transcript -> []", () => {
  assert.deepEqual(transcriptTail("/wt/does-not-exist"), []);
  assert.equal(newestTranscript("/wt/does-not-exist"), null);
});

test("transcriptTail: with a cache, an unchanged file is not re-parsed", () => {
  const wt = "/wt/cache";
  const dir = writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "one" } },
  ]);
  const p = path.join(dir, "t.jsonl");
  const cache = { path: null, mtimeMs: 0, size: 0, result: [] };

  const first = transcriptTail(wt, cache);
  assert.deepEqual(first, [{ id: "u1", role: "user", text: "one", blocks: [{ t: "text", text: "one" }] }]);
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
  assert.deepEqual(reparsed, [
    { id: "u1", role: "user", text: "one", blocks: [{ t: "text", text: "one" }] },
    { id: "a1", role: "assistant", text: "two", blocks: [{ t: "text", text: "two" }] },
  ]);
});

test("pokeHeartbeat signals the session-manager process (PID 1) with SIGUSR1", () => {
  // Stub process.kill so the test never actually signals anything — just
  // capture what pokeHeartbeat would send.
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => calls.push([pid, sig]);
  try {
    pokeHeartbeat();
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(calls, [[1, "SIGUSR1"]]);
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
