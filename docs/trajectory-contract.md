# Session Trajectory JSON contract (XERK-713)

Foundation for the **Session Trajectory view** (epic XERK-712, parity with dsh
XERK-498). This note is the **source of truth** the backend parser (XERK-714)
and the web UI (XERK-717) build to in parallel: one normalized shape, one
renderer, three runtimes (`claude`, `qwen`, `dsh`).

It generalizes dsh's existing `archive.dshTrajectory()` output
(`turma/archive.js`) into a **superset** that also carries the conversation,
because Claude/Qwen trajectories are message-centric, not just tool-call-centric.

## The contract

Produced by the server (`turma/archive.js`), consumed by the UI. All of
`args` / `result` / `text` are **snippeted** to a bounded length.

```
{
  transcriptId,
  runtime: "claude" | "qwen" | "dsh",
  title,                       // session title, snippeted; null if unknown
  model,                       // last/dominant model id seen; null if unknown
  startedAt, endedAt,          // epoch ms; null if underivable
  durationMs,                  // endedAt - startedAt; null if either is null
  totals: {
    turns, toolCalls, errors,
    tokens: { input, output, cacheRead, cacheWrite }
  },
  turns: [ {
    turn,                      // 1-based ordinal
    startedAt, endedAt, durationMs,
    user:   { text } | null,   // user message text for this turn, snippeted
    output: [ { kind: "text" | "thinking", text } ],  // model output blocks, in order
    model,                     // model id for this turn; null if unknown
    calls:  [ {
      name,                    // tool name
      callId,                  // correlates call<->result; null if absent
      at,                      // epoch ms of the call; null if unknown
      ok,                      // true | false | null (null = no result seen yet)
      error,                   // bool: result was an error
      args,                    // snippeted stringified input
      result,                  // snippeted stringified result (present when known)
      durationMs               // result time - call time; null if underivable
    } ],
    tokens: { input, output, cacheRead, cacheWrite },
    reason                     // turn-end reason where derivable; else null
  } ],
  truncated,                   // bool: any of the caps below tripped
  turnsDropped, callsDropped   // counts shed by the caps
}
```

### Snippeting

- Define `TRAJ_SNIPPET = 400` (mirror dsh's `DSH_TRAJ_SNIPPET`). Every `text`,
  `args`, and `result` is cut to `TRAJ_SNIPPET` chars with a trailing `…`.
- Caps (mirror the dsh constants; the parser MAY reuse them):
  `TRAJ_TURNS_MAX` (turns kept, newest), `TRAJ_CALLS_MAX` (tool calls kept
  across turns). Tripping either — or a size-based read cap — sets `truncated`
  and bumps `turnsDropped` / `callsDropped`.

### Superset rule (one renderer, three runtimes)

- The shape stays a **superset dsh can also emit**. The dsh parser MAY keep
  emitting its current subset (no `user`, no `output`, tool-call-centric turns);
  **missing fields render as absent, not as errors**. A field the UI does not
  find is treated as `null` / `[]`, never a crash.
- Concretely, dsh already emits `transcriptId, title, model, startedAt, endedAt,
  durationMs, totals, turns[], truncated, turnsDropped, callsDropped`. This
  contract ADDS `runtime`, per-turn `user`, `output`, `model`, `reason`, per-call
  `result`, and `totals.toolCalls`. dsh's `totals.steps` / per-turn `steps` are
  dsh-only extras the superset tolerates.

## Input shapes the parser maps from

Two fixtures under `turma/tests/fixtures/trajectory/` capture the real,
trimmed + scrubbed inputs. Both are archived per-session `<sid>.jsonl` (the
raw layer, XERK-338): line-delimited JSON, one event per line.

### `claude.jsonl` — Claude raw `<sid>.jsonl`

Claude Code's own transcript. Relevant line `type`s: `user`, `assistant`
(plus control-plane noise this parser ignores: `custom-title`, `agent-name`,
`mode`, `permission-mode`, `attachment`, `bridge-session`, `atis-latch`,
`last-prompt`, `file-history-*`, `system`).

- `timestamp` is an ISO-8601 string per line (→ epoch ms).
- **assistant** line: `message: { role, model, content: [ block ], usage }`.
  - `content` blocks (one block per line here, but treat as an array):
    - `{ type:"text", text }` → `output[] { kind:"text", text }`
    - `{ type:"thinking", thinking, signature }` → `output[] { kind:"thinking",
      text:thinking }`. **On this fleet the plaintext `thinking` is empty and
      only the encrypted `signature` is stored** — emit the block with empty
      text; **never surface `signature`.**
    - `{ type:"tool_use", id, name, input }` → a `calls[]` entry keyed by `id`.
  - `message.usage`: `{ input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, ... }` →
    `tokens { input, output, cacheRead, cacheWrite }`.
- **user** line: `message.content` is a string, or an array of
  `{ type:"text", text }` (a real user turn) and/or
  `{ type:"tool_result", tool_use_id, content, is_error }` (tool output,
  correlated to a `tool_use` by `tool_use_id`; `is_error:true` → `error`/`!ok`).
  A user line that is ONLY `tool_result`s does not open a new turn.

### `qwen.jsonl` — Qwen **projected** `<sid>.jsonl`

The qwen session's on-disk transcript is already half-projected: a Claude-shaped
**envelope** (`type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`,
`provenance`, `cwd`, `version`, `gitBranch`) wrapping a **Gemini-shaped message
body**. `agent/qwen_transcript.py::_project` finishes the block-level projection
at read time; the trajectory parser SHOULD reuse that projection rather than
re-deriving it. Line `type`s: `user`, `assistant`, `tool_result` (plus `system`
`ui_telemetry`/snapshot noise the parser ignores).

- **assistant** line: adds `model`, `usageMetadata`, `contextWindowSize`, and
  `message: { role, parts: [ part ] }`.
  - `parts`:
    - `{ text }` → `output[] { kind:"text" }`
    - `{ text, thought:true }` → `output[] { kind:"thinking" }` (Qwen keeps
      thinking **plaintext**, unlike Claude)
    - `{ functionCall: { id, name, args } }` → a `calls[]` entry keyed by `id`.
  - `usageMetadata` (Gemini-shaped): `{ promptTokenCount, candidatesTokenCount,
    thoughtsTokenCount, totalTokenCount, cachedContentTokenCount }`. Map via
    `_map_usage`: `input=promptTokenCount`, `output=candidatesTokenCount`,
    `cacheRead=cachedContentTokenCount` (no distinct cacheWrite).
- **tool_result** line: `message.parts[] { functionResponse: { id, name,
  response } }` correlated by `id`, plus a corroborating
  `toolCallResult: { callId, status, resultDisplay, executionStatus }` where
  `status:"error"` marks the error state.

## Fixtures (`turma/tests/fixtures/trajectory/`)

Real archived transcripts from this host, **trimmed** (a small contiguous run of
turns; control-plane noise lines dropped; extra tool cycles dropped; every
string field capped) and **scrubbed** (tokens/JWTs/keys/emails redacted;
thinking `signature` blanked). Loadable + coverage-asserted by
`turma/tests/trajectory-fixtures.test.js`.

| Fixture | Runtime | Covers |
|---|---|---|
| `claude.jsonl` | claude raw | multi-turn (2 user turns), thinking blocks (encrypted → empty text), tool_use+tool_result pairs incl. **one error** result, `message.usage` on assistants |
| `qwen.jsonl` | qwen projected | multi-turn (3 user turns), thinking blocks (**plaintext** `thought`), functionCall+functionResponse pairs incl. **error** results, `usageMetadata` on assistants |

Between them the two encrypted/plaintext thinking cases and both usage shapes are
exercised, so the parser and renderer are built against reality, not a mock.

## Acceptance (this ticket)

- Contract documented, field names final (this note).
- Fixtures committed under `turma/tests/fixtures/trajectory/` and loadable by a
  test (`trajectory-fixtures.test.js`).

## Blocks / blocked by

- Blocks: the parser (XERK-714) and the web UI (XERK-717).
- Blocked by: none.
