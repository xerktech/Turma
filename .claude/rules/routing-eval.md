---
paths:
  - "bench/archive/**"
  - "docs/routing-eval-phase0.md"
  - "docs/routing-prior-art.md"
---

# Archive-sourced routing eval (XERK-445)

Tooling in `bench/archive/` turns the hub's archived sessions into a replay benchmark. Findings
are in `docs/routing-eval-phase0.md`; the build-vs-adopt review in `docs/routing-prior-art.md`.
`bench/METHOD.md` still governs how a task is graded — this directory changes where tasks come
from, not the contract.

- **A turn is a `requestId` group, never a transcript entry.** Claude Code writes one entry per
  content block, so one assistant message arrives as 2-3 entries sharing a `requestId`. The three
  input-side counters repeat the SAME value on each; `output_tokens` grows to a cumulative total on
  the last. Summing entries triple-counts the prompt — measured 21.1B tokens against a true 11.1B —
  and files the text-only half of a split turn under "summarization", which mislabeled 39% of the
  corpus. `_reduce_usage` takes the max of each counter, correct for both shapes.
- **Cost analysis must read the RAW archive layer.** The rendered layer is a projection
  (`{uuid, role, ts, text, blocks[]}`) carrying no model and no token counts.
- **Never run the corpus walk inside the hub pod.** The hub is one event loop and a synchronous
  walk of `/data/archive` stalls every dashboard, SSE tail and heartbeat behind it
  (`.claude/rules/turma-archive.md` sizes the cost). Copy the corpus out; analyze locally.
- **60% of archived transcripts have no assistant turn at all** (933 of 1,628 — sessions created
  and never run). Per-session statistics taken over the file count are understated by more than
  half; the substantive corpus is 695.
- **`curate.py` is deliberately over-inclusive and `validate_tasks.py` is the gate.** A task that
  has not passed red-then-green is not a task. Merge commits bundle unrelated files, and some
  sessions are research asks no test can grade.
- **Files ADDED by a merge cannot be in `revert_paths`.** The runner reverts with
  `git checkout <commit>^1 -- <paths>`, which errors on a path absent from the parent; a fix that
  is pure addition cannot be expressed as a red baseline at all.
- **The eval set is Turma-only until XERK-449.** Tenir validated 1/29 — it is an npm-workspaces
  monorepo with no `node_modules`, so derived `npx vitest` commands fail before reaching code. The
  harness does no install step, by design.
- **`sensitivity()` is checked on RAW text, before scrubbing.** Redaction would hide that a task
  concerns NCHFA/YPrime/Tesoro work at all. A `local-only` task must never reach a cloud endpoint.
  No such task has survived curation yet, so the mechanism is unexercised — do not describe it as
  proven.
- **Route per session or per phase, never per turn.** 97.9% of corpus tokens are cache reads (70.3%
  price-weighted), so switching tier mid-conversation re-ingests the whole context at cache-creation
  price: ~45x an average turn's entire output at median context, ~114x at p90. A router that
  switches even once every 45 turns has spent everything a *free* weak tier could have saved.
  Switchyard's own calibrated profile agrees (`classify_trigger = "user_turn"`, holding the target
  across the tool calls between). Subagent routing is the cache-safe split — delegated work carries
  its own context — and is 26% of turns.
