// Loader + coverage test for the Trajectory fixtures (XERK-713).
//
// Proves the committed fixtures under tests/fixtures/trajectory/ are valid
// line-delimited JSON and exhibit every shape the Trajectory contract
// (docs/trajectory-contract.md) requires, so the parser (XERK-714) and UI
// (XERK-717) are built against real transcripts. node:test, built-in — the
// zero-npm stance; no parser exists yet, this only reads the raw fixtures.

"use strict";

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const DIR = path.join(__dirname, "fixtures", "trajectory");

function load(name) {
  const full = path.join(DIR, name);
  const lines = fs.readFileSync(full, "utf8").split("\n").filter((l) => l.trim());
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new Error(`${name}:${i + 1} is not valid JSON: ${e.message}`);
    }
  });
}

// Classify a fixture into the coverage the contract cares about, spanning both
// the Claude raw shape (message.content blocks) and the Qwen projected shape
// (message.parts). Kept deliberately parser-agnostic: it mirrors the input
// shapes documented in docs/trajectory-contract.md, not any parser output.
function coverage(entries) {
  const c = {
    userTurns: 0, thinking: 0, thinkingWithText: 0, text: 0,
    toolUse: 0, toolResultOk: 0, toolResultErr: 0, usageMsgs: 0,
    useIds: new Set(), resIds: new Set(),
  };
  for (const e of entries) {
    const m = e.message;
    if (e.usageMetadata) c.usageMsgs++;
    if (m && m.usage) c.usageMsgs++;

    // Claude raw: a real user turn may carry a plain string content.
    if (m && e.type === "user" && typeof m.content === "string" && m.content.trim()) {
      c.userTurns++;
    }

    // Claude raw: message.content blocks.
    if (m && Array.isArray(m.content)) {
      const isToolResultOnly = m.content.every((b) => b && b.type === "tool_result");
      const hasText = m.content.some((b) => b && b.type === "text");
      if (e.type === "user" && hasText && !isToolResultOnly) c.userTurns++;
      for (const b of m.content) {
        if (b.type === "text") c.text++;
        else if (b.type === "thinking") {
          c.thinking++;
          if (b.thinking && b.thinking.trim()) c.thinkingWithText++;
        } else if (b.type === "tool_use") {
          c.toolUse++;
          if (b.id) c.useIds.add(b.id);
        } else if (b.type === "tool_result") {
          if (b.tool_use_id) c.resIds.add(b.tool_use_id);
          if (b.is_error) c.toolResultErr++;
          else c.toolResultOk++;
        }
      }
    }

    // Qwen projected: message.parts + toolCallResult.
    if (m && Array.isArray(m.parts)) {
      const hasUserText = e.type === "user" && m.parts.some((p) => p.text && !p.thought);
      if (hasUserText) c.userTurns++;
      for (const p of m.parts) {
        if (p.functionCall) {
          c.toolUse++;
          if (p.functionCall.id) c.useIds.add(p.functionCall.id);
        } else if (p.functionResponse) {
          if (p.functionResponse.id) c.resIds.add(p.functionResponse.id);
        } else if (p.thought) {
          c.thinking++;
          if (p.text && p.text.trim()) c.thinkingWithText++;
        } else if (typeof p.text === "string") c.text++;
      }
    }
    if (e.type === "tool_result" && e.toolCallResult) {
      if (e.toolCallResult.callId) c.resIds.add(e.toolCallResult.callId);
      if (e.toolCallResult.status === "error") c.toolResultErr++;
      else c.toolResultOk++;
    }
  }
  c.pairedCalls = [...c.useIds].filter((id) => c.resIds.has(id)).length;
  return c;
}

test("fixture directory has both runtime fixtures", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort();
  assert.deepEqual(files, ["claude.jsonl", "qwen.jsonl"]);
});

test("claude fixture: loadable + contract coverage", () => {
  const c = coverage(load("claude.jsonl"));
  assert.ok(c.userTurns >= 2, `multi-turn: userTurns=${c.userTurns}`);
  assert.ok(c.thinking >= 1, "has thinking blocks");
  assert.ok(c.toolUse >= 1, "has tool_use");
  assert.ok(c.pairedCalls >= 1, "tool_use correlates to a tool_result by id");
  assert.ok(c.toolResultErr >= 1, "has an error tool_result");
  assert.ok(c.usageMsgs >= 1, "has usage on assistant messages");
});

test("qwen fixture: loadable + contract coverage", () => {
  const c = coverage(load("qwen.jsonl"));
  assert.ok(c.userTurns >= 2, `multi-turn: userTurns=${c.userTurns}`);
  assert.ok(c.thinking >= 1, "has thinking blocks");
  // Qwen keeps thinking plaintext, unlike Claude's encrypted signature.
  assert.ok(c.thinkingWithText >= 1, "qwen thinking is plaintext");
  assert.ok(c.toolUse >= 1, "has functionCall");
  assert.ok(c.pairedCalls >= 1, "functionCall correlates to a functionResponse by id");
  assert.ok(c.toolResultErr >= 1, "has an error tool result");
  assert.ok(c.usageMsgs >= 1, "has usageMetadata on assistant messages");
});

test("fixtures carry no obvious secrets", () => {
  const secret = /sk-[A-Za-z0-9]{16}|ghp_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9]{20}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|AKIA[0-9A-Z]{16}/;
  for (const name of ["claude.jsonl", "qwen.jsonl"]) {
    const raw = fs.readFileSync(path.join(DIR, name), "utf8");
    assert.ok(!secret.test(raw), `${name} contains a secret-looking token`);
  }
});
