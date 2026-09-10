---
paths:
  - "turma/archive.js"
  - "turma/tests/fixtures/trajectory/**"
  - "turma/tests/trajectory-fixtures.test.js"
  - "docs/trajectory-contract.md"
  - "agent/qwen_transcript.py"
---

# Session Trajectory (epic XERK-712)

- **The contract is `docs/trajectory-contract.md`** — the source of truth for the
  normalized Trajectory JSON the server emits and the UI consumes. Read it before
  changing the parser, the shape, or the fixtures. Field names there are final.
- **One shape, one renderer, three runtimes** (`claude` / `qwen` / `dsh`). The
  contract is a **superset of dsh's `dshTrajectory()` output** — dsh may keep
  emitting its subset; missing fields render as absent, never as errors. Do not
  fork a second shape per runtime.
- **The Claude+Qwen reducer is `claudeTrajectory()`** in `turma/archive.js`
  (XERK-714), parallel to `dshTrajectory()`. ONE fold serves both: a top-level
  raw `<sid>.jsonl` is the Claude raw transcript AND the Qwen projected one, and
  the fold branches per LINE on `message.content` (Claude blocks) vs
  `message.parts` (Qwen), never on runtime. `runtime` is set from which shape
  appeared. It bounds every axis (`TRAJ_READ_MAX`/`TURNS_MAX`/`CALLS_MAX`/
  `SNIPPET`, mirrors of the dsh constants) and returns structured JSON only.
- **Dedupe usage on `message.id`** — Claude splits one assistant message across
  lines that REPEAT the same id and the same `message.usage`, so summing per line
  triples the tokens. Qwen lines carry no repeated id, so they never dedupe.
- `TRAJ_SNIPPET = 400` bounds every `text` / `args` / `result` (mirror
  `DSH_TRAJ_SNIPPET`).
- **Fixtures are real, trimmed + scrubbed transcripts** under
  `turma/tests/fixtures/trajectory/`; `trajectory-fixtures.test.js` asserts their
  coverage. `claude.jsonl` is a raw Claude `<sid>.jsonl`; `qwen.jsonl` is a Qwen
  **projected** `<sid>.jsonl` (Claude-shaped envelope + Gemini `parts` body).
  Regenerate them by re-trimming real archived transcripts — never hand-edit a
  block into an invalid shape, and never commit un-scrubbed secrets or a thinking
  `signature`.
- **Claude extended-thinking is stored encrypted on this fleet** — the `thinking`
  text is empty, only `signature` is present; emit the block with empty text and
  never surface `signature`. Qwen keeps thinking plaintext (`parts[].thought`).
- **Qwen mapping reuses `agent/qwen_transcript.py::_project`** — do not re-derive
  the parts→blocks / `usageMetadata`→usage projection independently.
