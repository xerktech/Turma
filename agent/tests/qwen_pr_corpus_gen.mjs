#!/usr/bin/env node
/**
 * Build a Qwen native-log corpus that carries a `gh pr create` flow, for the
 * XERK-514 [Qwen H] PR-attribution tests (`TestQwenPrAttribution`, the qwen
 * analogue of dsh's `TestDshPrAttribution`).
 *
 * WHY THIS IS SEPARATE FROM `qwen_corpus.json`. The shared projector corpus is
 * two REAL captured Qwen Code 0.22.2 sessions ([Qwen G0], `docs/qwen-g0/corpus/`),
 * and in BOTH of them the shell tool was guard-denied by the spike's PreToolUse
 * hook — so neither carries a successful `run_shell_command`, let alone a
 * `gh pr create`. Rather than pollute those real captures with a synthesised turn
 * (and disturb the exact-count projection-shape tests that assert against them),
 * PR attribution gets its own corpus here.
 *
 * WHY IT IS STILL FAITHFUL (the G1 no-mock lesson). Every event in this corpus is
 * a REAL captured Qwen row — this script READS `session-B-hard-deny.jsonl`, takes
 * its genuine `user`, `assistant`(`functionCall`) and `tool_result`
 * (`functionResponse`) envelopes verbatim, and mutates ONLY the two fields the PR
 * path turns on: the shell command (`echo hi && whoami` -> `gh pr create …`) and
 * the tool result (a hard-deny error -> a success carrying the PR URL, in the
 * exact `Command:/Directory:/Output:/…/Exit Code:` wrapper Qwen's shell tool
 * really emits — see the successful-shape reference below). This is the same
 * technique dsh's `dsh_corpus_gen.mjs` uses (real message constructors, chosen
 * content); the SHAPES are real, only the content exercises the create path.
 *
 * The success wrapper is modelled on the real error wrapper Qwen wrote for a shell
 * command that RAN in `session-A-write-and-deny.jsonl`
 * (`response.error = "Command: cat /etc/shadow\nDirectory: (root)\nOutput: …\n…\n
 * Exit Code: 1\n…"`), lifted to `response.output` with `Exit Code: 0` and a
 * `success` `toolCallResult` — the shape Qwen writes for a shell command that
 * exits 0 (verified against the real `write_file` success in session-A, whose
 * `functionResponse.response` is `{output: …}` with a `status:"success"`
 * `toolCallResult`).
 *
 *   node agent/tests/qwen_pr_corpus_gen.mjs > agent/tests/qwen_pr_corpus.json
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..', 'docs', 'qwen-g0', 'corpus', 'session-B-hard-deny.jsonl')

// The PR the corpus's `gh pr create` opens — the SAME URL TestDshPrAttribution
// uses, so the two mirrored suites assert an identical, recognisable target.
const PR_URL = 'https://github.com/xerktech/Turma/pull/999'
const PR_CMD =
  'gh pr create --title "Fix" --body "Opens the PR for the fix." --base main'

const rows = readFileSync(SRC, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

// Pull the first real event of each surface type out of the capture. These are
// genuine Qwen 0.22.2 envelopes (uuid/parentUuid chain, sessionId, cwd, version,
// timestamp, usageMetadata) — we only rewrite the tool command and result.
const realUser = rows.find((r) => r.type === 'user')
const realAsst = rows.find(
  (r) =>
    r.type === 'assistant' &&
    ((r.message && r.message.parts) || []).some((p) => p.functionCall),
)
const realResult = rows.find((r) => r.type === 'tool_result')
if (!realUser || !realAsst || !realResult) {
  throw new Error('capture is missing a user/assistant-call/tool_result row')
}

const clone = (o) => JSON.parse(JSON.stringify(o))
const callId = 'call_pr_create_0001'

// 1. A user prompt asking to open the PR — the real user envelope, new text.
const user = clone(realUser)
user.message.parts = [{ text: 'Open a PR for the fix.' }]

// 2. The assistant turn that RUNS `gh pr create` through Qwen's shell tool. The
//    real assistant envelope (reasoning `{thought:true}` + text + the
//    `functionCall` block, with real `usageMetadata`/`model`) — we retarget the
//    functionCall at the PR command. The tool name stays `run_shell_command`,
//    Qwen's real shell-tool name, which the projector maps to `Bash`
//    (`_TOOL_NAME_MAP`) — the load-bearing dependency [Qwen H] rests on.
const asst = clone(realAsst)
asst.message.parts = [
  { text: 'The fix is ready; I will open the PR now.', thought: true },
  { text: "I'll open the PR." },
  {
    functionCall: {
      id: callId,
      name: 'run_shell_command',
      args: { command: PR_CMD, description: 'Open the pull request' },
    },
  },
]

// 3. The tool result carrying the PR URL — the real tool_result envelope, its
//    `functionResponse` lifted from the hard-deny ERROR to a SUCCESS whose
//    `output` carries the PR link in Qwen's real shell wrapper, and its
//    `toolCallResult` flipped to success (so the projector marks it non-error).
const result = clone(realResult)
const output =
  `Command: ${PR_CMD}\n` +
  `Directory: (root)\n` +
  `Output: ${PR_URL}\n` +
  `Error: (none)\n` +
  `Exit Code: 0\n` +
  `Signal: (none)\n` +
  `Process Group PGID: 3682945`
result.message.parts = [
  { functionResponse: { id: callId, name: 'run_shell_command', response: { output } } },
]
result.toolCallResult = {
  callId,
  status: 'success',
  resultDisplay: output,
  executionStatus: 'success',
}

// 4. A plain closing assistant turn — the real envelope, new text, no tools.
const closing = clone(realAsst)
closing.message.parts = [{ text: `Done — the PR is open: ${PR_URL}` }]

process.stdout.write(JSON.stringify([user, asst, result, closing], null, 2) + '\n')
