# Archive-sourced replay eval (XERK-445 Phase 0)

Tooling that turns the Turma hub's archived session history into a re-runnable
routing benchmark. Findings are in `docs/routing-eval-phase0.md`; the
build-vs-adopt review is in `docs/routing-prior-art.md`.

This is the archive-sourced sibling of `bench/`. The parent directory mines
tasks from **git history**; this one mines them from **real sessions**, and then
grades them with the parent's mechanical contract. Read `bench/METHOD.md` first
— the red-then-green rule, the delivery contract and the fairness constraints
all carry over unchanged.

## Getting a corpus

The tools read a tree of raw Claude Code transcripts laid out as the hub stores
them, `<repo>/<name>.jsonl.raw/<id>/<id>.jsonl`.

```bash
POD=$(kubectl -n ai get pod -l app=turma -o name | head -1 | cut -d/ -f2)
kubectl -n ai exec -i "$POD" -- sh -c \
  'cd /data/archive && tar czf - $(find . -path "*.jsonl.raw/*" -name "*.jsonl")' \
  > corpus.tar.gz
mkdir corpus && tar xzf corpus.tar.gz -C corpus
```

**Do not run the analysis inside the pod.** The hub is a single event loop and a
synchronous walk of that store stalls every dashboard, SSE tail and heartbeat
behind it — the cost model is spelled out in `.claude/rules/turma-archive.md`.
Copy the corpus out and work on it locally.

The corpus is unsanitized session data: credentials, internal hostnames and
client context. Keep it outside the repo. Only `scrub.py` output is committable.

## Tools

| | |
|---|---|
| `classify.py` | classifies every turn and reports the split, weighted by tokens |
| `curate.py` | builds replay tasks from sessions that landed a merge commit |
| `scrub.py` | redacts secrets and marks client-sensitive tasks `local-only` |

```bash
python3 bench/archive/classify.py --corpus corpus --json classify.json
python3 bench/archive/curate.py   --corpus corpus --repos-root ~/git \
    --out bench/archive/tasks-archive.json --report ledger.json
python3 bench/validate_tasks.py --repo ~/git/Turma \
    --tasks tasks-turma.json --workroot ./work
```

`validate_tasks.py` takes a single `--repo`, so split the task file per repo
before validating.

## Two things that will bite you

**A turn is a `requestId`, not a transcript entry.** Claude Code writes one
entry per content block, so one assistant message arrives as 2–3 entries sharing
a `requestId`. The input-side counters repeat the *same* value on each of them
while `output_tokens` grows to a cumulative total. Summing entries triple-counts
the prompt — it reported 21.1B tokens against a true 11.1B — and files the
text-only half of a split turn under "summarization", which mislabeled 39% of
the corpus. `_reduce_usage` takes the max of each counter, which is correct for
both shapes.

**Curated is not validated.** `curate.py` is deliberately over-inclusive; merge
commits bundle unrelated files and some sessions are research asks that no test
can grade. `validate_tasks.py` is the gate, and a task that has not passed it is
not a task. Files *added* by a merge are excluded from `revert_paths` because
the runner reverts with `git checkout <commit>^1 -- <paths>`, which errors on a
path that does not exist at the parent.

## Grading, and why it does not leak

The transcript contains the answer, so the two halves of a task come from
different places: the **intent** is the session's first user message, scrubbed,
taken before any work happened; the **grade** is the repo's own regression tests
at the merge commit that session produced. Nothing from the body of the
transcript reaches the replayed agent. No model judges anything.

## Sensitivity

`sensitivity()` marks a task `local-only` when it touches NCHFA, YPrime or
Tesoro work, checked on the raw text *before* scrubbing — redaction would hide
that the task concerns that work at all. A `local-only` task must never be sent
to a cloud endpoint. No such task has survived curation yet, so the mechanism is
in place but unexercised against real sensitive content.
