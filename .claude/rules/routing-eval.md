---
paths:
  - "bench/archive/**"
  - "docs/routing-eval-phase0.md"
  - "docs/routing-prior-art.md"
---

# Archive-sourced routing eval (XERK-445)

`bench/archive/` turns the hub's archived sessions into a replay benchmark. Findings:
`docs/routing-eval-phase0.md`; build-vs-adopt review: `docs/routing-prior-art.md`. `bench/METHOD.md`
still governs how a task is graded — this directory changes where tasks come from, not the contract.

- **A turn is a `requestId` group, never a transcript entry.** One assistant message writes 2-3
  entries sharing a `requestId`; input counters repeat per entry, `output_tokens` is cumulative on
  the last. Summing entries triple-counts the prompt (measured 21.1B vs true 11.1B) and mislabels
  39% of the corpus. `_reduce_usage` takes the max of each counter.
- **Cost analysis must read the RAW archive layer** — the rendered layer is a projection with no
  model and no token counts.
- **Never run the corpus walk inside the hub pod** — a synchronous `/data/archive` walk stalls every
  dashboard/SSE/heartbeat behind it (`turma-archive.md`). Copy the corpus out; analyze locally.
- **60% of archived transcripts have no assistant turn at all** (933/1,628 — created, never run).
  Per-session stats over file count understate by >half; substantive corpus is 695.
- **`curate.py` is deliberately over-inclusive; `validate_tasks.py` is the gate.** A task that hasn't
  passed red-then-green is not a task.
- **Files ADDED by a merge cannot be in `revert_paths`** — the runner reverts with `git checkout
  <commit>^1 -- <paths>`, which errors on a path absent from the parent; a pure-addition fix can't be
  a red baseline at all.
- **The prompt must not name a file the task reverts, nor its grading test** — `curate.py`'s
  `_leaks_answer` is a hard gate (a pasted Jira spec or a QA invocation naming test files leaks the
  answer; a first cut shipped 14/30 named-reverted-file leaks, a fix still missed "QA branch X"
  phrasing). Also rejects a prompt echoing ≥3 identifiers the merge ADDS. **Never relax this to hit a
  task count.**
- **Never believe a single red — re-run that task alone** (XERK-450). `server.test.js`'s dead-channel
  test fails ~1/10 runs on an idle box; ~70% of a full pass shows a spurious fail indistinguishable
  from a broken task. Contention worsens it but is NOT the cause — "validate serially" is wrong.
- **`tasks-validated.json` is the eval set (25 tasks), not `tasks-archive.json` (57 curated)** — only
  the validated file is proven red-then-green.
- **The eval set is Turma-only until XERK-449** — Tenir validated 0/29 (npm-workspaces monorepo, no
  `node_modules`; the harness does no install step by design).
- **`sensitivity()` is checked on RAW text, before scrubbing** — redaction would hide that a task
  touches sensitive client work at all. A `local-only` task must never reach a cloud endpoint; none
  has survived curation yet, so this path is unexercised — do not call it proven.
- **Route per session or per phase, never per turn — MEASURED, not derived.** 97.9% of corpus tokens
  are cache reads (70.3% price-weighted). Prompt caches are per-model, independent: switching away
  doesn't invalidate the origin's cache, returning within TTL is free. Each turn creates cache for
  its DELTA only; a model that skipped turns must create cache for what it missed, so alternating
  makes both tiers pay for the gaps — measured **1.83x cache-creation volume**.
  - At real Bedrock rates (5x price spread), moving half the turns to the cheap tier "should" save
    ~40%. **Per-turn alternating saves 8.2%; the same 50/50 split as one phase switch saves 36.3%**
    (4.4x) — decided purely by switch FREQUENCY. All-cheap saves 80%.
  - **Routing accuracy is worth far less than routing stability.** `stage_router`/`llm_classifier`
    are per-turn decisions; a smarter per-turn classifier optimises the term that barely matters.
  - Do not restate this as "45x an average turn's output" or "an excursion must last ~9 turns" —
    earlier derivations superseded by measurement (they assumed a switch re-creates the WHOLE
    context; it doesn't).
  - Subagent routing is the cache-safe split (26% of turns) — a subagent carries its own context, so
    delegating creates no gap in the parent's cache.
