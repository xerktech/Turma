#!/usr/bin/env node
/**
 * Generate a REAL dsh session-event corpus for the XERK-464 translator tests,
 * using dsh's OWN message constructors (@deepseek-ai/dsh-llm 0.1.1-rc.2) so the
 * message/content/usage shapes are dsh's, not this repo's guess — the G1 lesson
 * was that a mock hid a wrong API, so the fixture is built from the real code.
 *
 * It wraps each real message in the documented SessionEvent envelope
 * {type, seq, time, data} (verbatim from dsh-session/types.ts — the trivial,
 * unambiguous part) and prints the event log as JSON to stdout. The Python
 * translator test consumes this file; regenerate it by running this script
 * against the cached dsh packages (see DSH_PKGS below).
 *
 *   node dsh_corpus_gen.mjs > dsh_corpus.json
 *
 * Kept out of CI's hot path: the checked-in dsh_corpus.json is the fixture; this
 * script documents (and can reproduce) how it was built from real dsh code.
 */
import { createRequire } from 'node:module'

// The dsh packages the G1 work installed (npx cache). Overridable so the script
// still runs where they were unpacked elsewhere.
const DSH_PKGS =
  process.env.DSH_PKGS ||
  '/root/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-llm'
const require = createRequire(import.meta.url)
const { createUserMessage, createAssistantMessage, createToolResultMessage } =
  require(DSH_PKGS)

// A deterministic clock so the corpus (and the uuids the translator derives from
// seq) is byte-stable across regenerations.
let seq = 0
const T0 = 1_756_150_000_000 // fixed epoch ms
function ev(type, data) {
  seq += 1
  return { type, seq, time: T0 + seq * 1000, data }
}

const events = []

// 1. turn/start — a log-only boundary; must project to nothing.
events.push(ev('turn/start', { turn: 1 }))
events.push(ev('step/start', { turn: 1, step: 1 }))

// 2. user/message — a real human prompt.
events.push(
  ev('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Open a PR for the fix, then summarize.' }],
  })),
)

// 3. request/header — log-only route metadata; projects to nothing.
events.push(ev('request/header', { header: { config: {} }, reason: 'initial' }))

// 4. assistant/message with reasoning + text + a tool-call (gh pr create), plus
//    real token usage and a model-bearing source. This is the load-bearing case:
//    the tool call must project to a tool_use block (PR attribution, D4), the
//    usage/model must reach the ledger (D4), and reasoning must become thinking.
const asstMsg = createAssistantMessage({
  source: { provider: 'dsh-llm-pi-ai', model: 'bedrock/claude-haiku' },
  content: [
    { type: 'reasoning', text: 'The change is small; I will open a PR.' },
    { type: 'text', text: "I'll open the PR now." },
    {
      type: 'tool-call',
      id: 'call_abc123',
      name: 'Bash',
      arguments: JSON.stringify({
        command: 'gh pr create --title "Fix" --body "..."',
        description: 'Open the PR',
      }),
    },
  ],
})
events.push(
  ev('assistant/message', {
    turn: 1,
    step: 1,
    message: asstMsg,
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheWriteTokens: 800,
      reasoningTokens: 90,
    },
  }),
)

// 5. tool/call — redundant with the assistant tool-call block above; MUST project
//    to nothing so the tool_use is not duplicated.
events.push(ev('tool/call', {
  turn: 1, step: 1, callId: 'call_abc123', name: 'Bash',
  arguments: JSON.stringify({ command: 'gh pr create --title "Fix" --body "..."' }),
}))

// 6. tool/result — the PR url comes back in the tool result (this is the line the
//    PR-chip scan reads). Real ToolResultMessage via the constructor.
events.push(
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: 'call_abc123',
      content: [{ type: 'text', text: 'https://github.com/xerktech/Turma/pull/999' }],
      isError: false,
    }),
    error: undefined,
  }),
)

events.push(ev('step/end', { turn: 1, step: 1 }))

// 7. assistant/message — plain text follow-up with usage, no tools.
events.push(
  ev('assistant/message', {
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      source: { provider: 'dsh-llm-pi-ai', model: 'bedrock/claude-haiku' },
      content: [{ type: 'text', text: 'Done — PR #999 is open.' }],
    }),
    usage: { inputTokens: 60, outputTokens: 12 },
  }),
)
events.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

// 8. A second turn the user CANCELS — projects the interrupt marker.
events.push(ev('turn/start', { turn: 2 }))
events.push(
  ev('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Also refactor everything' }],
  })),
)
events.push(ev('turn/end', {
  turn: 2,
  reason: { kind: 'aborted', reason: { kind: 'user' } },
}))

// 9. A tool result flagged as an error — is_error must ride through.
events.push(
  ev('tool/result', {
    turn: 3,
    step: 1,
    message: createToolResultMessage({
      callId: 'call_err',
      content: [{ type: 'text', text: 'command not found: frobnicate' }],
      isError: true,
    }),
  }),
)

process.stdout.write(JSON.stringify(events, null, 2) + '\n')
