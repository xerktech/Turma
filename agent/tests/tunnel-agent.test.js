// Unit tests for tunnel-agent.js's live transcript-tail helpers (node:test,
// built-in — matches agent-hub/tests' zero-npm-dependency stance). CI runs
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
process.env.HUB_TOKEN = "x";

const { projectSlug, transcriptTail, entryText, newestTranscript } = require("../tunnel-agent.js");

const ESC = String.fromCharCode(27); // ANSI escape, kept out of the source as a literal

function writeTranscript(worktreePath, name, entries) {
  const dir = path.join(PROJECTS_ROOT, projectSlug(worktreePath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return dir;
}

test("projectSlug maps every non-alphanumeric char to '-' (dotted worktree paths)", () => {
  assert.equal(projectSlug("/mnt/data/.agenthub/worktrees/abc"), "-mnt-data--agenthub-worktrees-abc");
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

test("transcriptTail: oldest-first, drops undisplayable turns, tolerates broken lines", () => {
  const wt = "/wt/a";
  writeTranscript(wt, "t.jsonl", [
    { uuid: "u1", type: "user", message: { content: "hello there" } },
    { uuid: "a1", type: "assistant", message: { content: [{ type: "text", text: `hi ${ESC}[31mred${ESC}[0m done` }, { type: "tool_use", name: "Bash" }] } },
    { uuid: "tr1", type: "user", message: { content: [{ type: "tool_result", content: "ignored" }] } },
    "{broken json",
    { uuid: "a2", type: "assistant", message: { content: [{ type: "text", text: "final answer" }] } },
    { uuid: "a3", type: "assistant", message: { content: "" } },
  ]);
  assert.deepEqual(transcriptTail(wt), [
    { id: "u1", role: "user", text: "hello there" },
    { id: "a1", role: "assistant", text: "hi red done[Bash]" },
    { id: "a2", role: "assistant", text: "final answer" },
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
