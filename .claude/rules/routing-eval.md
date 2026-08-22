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
- **Never believe a single red — re-run that task alone** (XERK-450). `turma/tests/server.test.js`'s
  "channel that pongs is kept past the dead-after window" fails ~1 run in 10 on an IDLE box; 9 of the
  25 validated tasks grade on that suite and it runs twice per task, so a full pass is ~70% likely to
  show at least one spurious "tests FAIL even with the real fix applied" — indistinguishable from a
  broken task. It cost two good tasks, reported as a real result. Contention worsens it but is NOT
  the cause: "validate serially" was written here once as the remedy and is wrong.
- **`tasks-validated.json` is the eval set (25 tasks), not `tasks-archive.json` (57 curated).** Only
  the validated file has been proven red-then-green; the pool file keeps the rejects so the gate's
  decisions stay auditable. Benchmark against the validated one.
- **The eval set is Turma-only until XERK-449.** Tenir validated 0/29 — it is an npm-workspaces
  monorepo with no `node_modules`, so derived `npx vitest` commands fail before reaching code. The
  harness does no install step, by design.
- **`sensitivity()` is checked on RAW text, before scrubbing.** Redaction would hide that a task
  concerns NCHFA/YPrime/Tesoro work at all. A `local-only` task must never reach a cloud endpoint.
  No such task has survived curation yet, so the mechanism is unexercised — do not describe it as
  proven.
- **Route per session or per phase, never per turn — MEASURED, not derived.** 97.9% of corpus
  tokens are cache reads (70.3% price-weighted). Prompt caches are **per-model and independent**:
  switching away does NOT invalidate the origin's cache, and returning within the TTL is charged
  nothing. In a growing conversation each turn creates cache for the DELTA only. The real penalty
  is that a model which skipped a turn must create cache for the turns it MISSED, so alternating
  makes both tiers pay for the gaps — measured at **1.83x cache-creation volume**.
  - At real Bedrock rates (opus-4-6 $5.50/$27.50, haiku-4-5 $1.10/$5.50 per Mtok — exactly 5x),
    moving half the turns to the cheap tier "should" save ~40%. **Per-turn alternating saves 8.2%;
    the SAME 50/50 split as one phase switch saves 36.3%** — 4.4x, decided purely by switch
    FREQUENCY. All-cheap saves 80%.
  - So **routing accuracy is worth far less than routing stability**. `stage_router` and
    `llm_classifier` are both per-turn decisions; a smarter per-turn classifier optimises the term
    that barely matters and adds a model call to do it.
  - **Do not restate this as "45x an average turn's output" or "an excursion must last ~9 turns"**
    — both were earlier derivations from the archive that measurement superseded. They assumed a
    switch re-creates the WHOLE context; it does not.
  - Subagent routing is the cache-safe split, and for a stronger reason than first stated: a
    subagent carries its own context, so delegating creates no gap in the parent's cache. 26% of turns.
