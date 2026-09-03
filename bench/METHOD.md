# Coding-agent bench — method

What this measures: **which agentic coding harness gets the most real work done
against our self-hosted model**, holding the model, the prompt, the time cap and
the starting tree identical across harnesses.

It exists because the August 2026 model eval (`docs/opencode-model-eval-2026-08.md`)
compared *models* but always ran them under OpenCode — the harness itself was
never a variable. Its bench was also never committed, so none of it could be
re-run. This directory is the re-runnable replacement.

## Where the tasks come from

Every task is a **real merged commit from this repo** that shipped a fix (or a
feature) *together with* its regression tests. To build the task, the harness:

1. checks the fix commit out into a fresh detached worktree;
2. reverts **only the implementation files** (`revert_paths`) to the parent
   commit, leaving the tests at their fixed revision;
3. commits that state as `bench: broken baseline`.

The agent therefore starts from a clean tree whose tests are red, and anything
it commits is unambiguously its own work.

`validate_tasks.py` gates every task mechanically: with the fix reverted the
tests **must** fail, and with the fix restored they **must** pass. A candidate
that does not show that transition is dropped rather than shipped as a task
nobody can pass. All 8 current tasks pass this gate.

## What the agent is told

The `prompt` in `tasks.json` is the problem **in a user's voice** — the symptom
as it would be reported, with no file paths, no solution sketch, and no hint
that regression tests for it already exist. Prompts were written from the
commit messages' problem statements, deliberately dropping their solution
sections.

`run_bench.py` appends one identical `DELIVERY_CONTRACT` to every prompt for
every harness (work unattended, never end on a question, verify with the repo's
own tests, finish on a branch + commit, do not push). It lives in the runner,
not in `tasks.json`, so no harness can be measured against different wording.

## Optional dependency bootstrap (XERK-449)

Most tasks grade with a dependency-free suite, and that is deliberate: no install
step runs by default, so every harness starts from the same pristine tree and the
comparison stays fair. But a task mined from a monorepo (Tenir's npm workspaces,
its `api` Python project) needs its dependencies present before its suite can
resolve at all. Three optional per-task keys cover that, all off unless set:

| key | meaning |
|---|---|
| `setup_cmd` | argv run once in the worktree root, AFTER the broken-baseline commit and BEFORE the red/green check (validate) or the harness (run_bench). Its artifacts — `node_modules`, `.venv` — are never in the tree the agent diffs against. |
| `setup_timeout` | seconds `setup_cmd` may take (default 900). |
| `test_cwd` | directory the `test_cmd` runs in, relative to the worktree — the workspace (`mobile`) or nested project (`api`) a monorepo suite grades from. Absent → the root, as before. |

**A bootstrap failure is reported distinctly from a test failure.** `validate_tasks.py`
prints `SETUP` (not `FAIL`) and holds it out of the gate; `run_bench.py` records
`setup_failed` and keeps that run out of the pass rates. A missing dependency is an
environment gap, not an unsolvable task — conflating the two is exactly what made all
29 Tenir candidates read as "not solvable as specified" before this existed.

Keep `setup_cmd` off for any task whose suite is already dependency-free, so the
harness-comparison runs stay comparable.

## Scoring

Mechanical only — no model judges anything:

| metric | meaning |
|---|---|
| **solved** | the task's own `test_cmd` exits 0 after the run |
| **committed** | at least one commit exists past the baseline (the delivery contract) |
| **abandoned** | returned in under 25 s having neither solved nor committed |
| **seconds** | wall clock for the harness invocation |

`solved` is the headline number. `committed` is reported separately because a
harness can solve a task and still fail to deliver it — the failure mode the
August eval measured at 0/8 for gpt-oss under OpenCode.

**Aider commits its own edits by default.** That is a genuine capability, so it
runs in that default configuration, but its `committed` count is marked `*` in
the summary: it reflects the tool, not the model choosing to honor the contract.

## Fairness constraints

- One model for everyone: `gpt-oss:120b`, served by the Tenir Ollama box through
  the LiteLLM gateway. Set `TURMA_LOCAL_BASE_URL` / `TURMA_LOCAL_API_KEY`.
- Credentials are never written to a config file. Each `configs/*` file
  references the environment (`{env:...}`, `$VAR`, `env_key`), and the runner
  strips any ambient `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY`
  so a stray cloud login cannot silently benchmark a frontier model instead.
- Every run gets its own pristine worktree, removed afterwards.
- Same `--cap` for all harnesses; a run that hits it is recorded as `timed_out`.
- Each harness runs in the configuration its own docs recommend for unattended
  use, rather than one forced into a shared shape.

## Concurrency

The GPU serves one resident model and llama.cpp gets little batching gain on
this MoE, so aggregate throughput is roughly flat with concurrency — `--jobs 2`
(default) or 3 is the useful range. Higher just taxes latency, including the
Tenir cue loop that shares the box.

## Running it

```bash
export TURMA_LOCAL_BASE_URL=https://lite.xerktech.com/v1
export TURMA_LOCAL_API_KEY=...            # LiteLLM virtual key

python3 bench/validate_tasks.py --repo /path/to/Turma          # gate the tasks
python3 bench/run_bench.py     --repo /path/to/Turma           # full matrix
python3 bench/run_bench.py     --repo /path/to/Turma \
    --harness opencode aider --attempts 2 --jobs 3             # a subset
```

Per-run transcripts land in `--runs` (default `/root/turma-bench/runs`) and the
full records in `--out`. Neither is committed; results that matter get written
up in `docs/`.

## Known limits

- 8 tasks is a small n; treat single-run differences of one task as noise. Use
  `--attempts 2+` before concluding anything from a gap that size.
- The archive-sourced eval set (`bench/archive/tasks-validated.json`) now spans
  two repos — 25 Turma + 22 Tenir (XERK-449) — adding TypeScript and an
  npm-workspaces monorepo shape. The 8 tasks in this directory's `tasks.json`
  are still Turma-only and dependency-free, and remain the harness-comparison
  set precisely because they need no bootstrap.
- Test-writing tasks were deliberately excluded: scoring them honestly needs
  mutation validation, which this harness does not do.
