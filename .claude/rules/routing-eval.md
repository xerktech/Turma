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
- **The prompt must not name a file the task reverts, nor the test that grades it.** `curate.py`'s
  `_leaks_answer` is a hard gate: this corpus's first user messages are often a pasted Jira ticket
  carrying an implementation spec, or a QA invocation naming the files under test. A first cut
  shipped 30 tasks of which 14 named a reverted file and 11 named their grading test; a second cut
  still shipped two, because the QA pattern anchored on `QA the|this` and missed `QA branch X` and
  `Final QA pass on X`. It also rejects a prompt echoing >=3 identifiers the merge ADDS, which is
  what a ticket carrying an implementation spec looks like. Never relax this to hit a task count.
- **`tasks-validated.json` is the eval set (24 tasks), not `tasks-archive.json` (58 curated).** Only
  the validated file has been proven red-then-green; the pool file keeps the rejects so the gate's
  decisions stay auditable. Benchmark against the validated one.
- **The eval set is Turma-only until XERK-449.** Tenir validated 0/29 — it is an npm-workspaces
  monorepo with no `node_modules`, so derived `npx vitest` commands fail before reaching code. The
  harness does no install step, by design.
- **`sensitivity()` is checked on RAW text, before scrubbing.** Redaction would hide that a task
  concerns NCHFA/YPrime/Tesoro work at all. A `local-only` task must never reach a cloud endpoint.
  No such task has survived curation yet, so the mechanism is unexercised — do not describe it as
  proven.
- **Route per session or per phase, never per turn.** 97.9% of corpus tokens are cache reads (70.3%
  price-weighted), so switching tier mid-conversation re-ingests the context at cache-creation
  price — 187,484 price units at median context against the 20,506 a free weak tier saves per turn.
  **An excursion must last ~9 turns to pay for the trip back** (9.1 at p50, 10.4 at p90); per-turn
  routing pays that fare every turn. Do not restate this as "45x an average turn's output" — that
  earlier figure compared the switch against output ALONE and overstated the margin fivefold.
  Prefix-keyed caching makes 9 an upper bound; treat it as an order of magnitude, not a threshold.
  Switchyard's own calibrated profile agrees (`classify_trigger = "user_turn"`, holding the target
  across the tool calls between). Subagent routing is the cache-safe split — delegated work carries
  its own context — and is 26% of turns.
