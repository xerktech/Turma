---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Workflow runs: resolving a `workflow` row to its agents (XERK-304)

A `Workflow` launch is N agents and writes NO transcript of its own, so a clicked `workflow` row in
a session's background-agent list resolves to a RUN — a picker of agents — rather than to one
conversation. The row itself is registered by `_async_launch`/`_scan_agent_entry` (see
`.claude/rules/agent.md`); everything below is about turning it back into something to read.

The layout Claude Code writes, one level deeper than an ordinary background agent's:

```
<slug>/<transcript-id>/subagents/workflows/<runId>/agent-<x>.jsonl
                                                   agent-<x>.meta.json
                                                   journal.jsonl
```

- **`agents` PRESENT — the empty list included — is what tells every client it got a list.**
  `_stage_subagent_history` answers a `workflow` row with `agents`, and only a second request
  naming one of those ids returns a transcript. A started run with nothing written yet is an empty
  list; an unresolved row carries no `agents` key at all. Collapsing the two loses the difference
  between "nothing running yet" and "this row is broken".
- **The run dir is named after the launch record's `runId`, NOT its `taskId`.** They are different
  handles on the same launch (`wf_86e01141-7bc` against `we1gtmfyd`), and `_async_launch` keys the
  ROW on taskId — so reading taskId as the directory name resolves nothing, which is the bug
  XERK-304 was filed for. The record's absolute `transcriptDir` is deliberately ignored too: it is
  untrusted input on a path join, and it is stale for a session MIGRATED to a host mounting
  `REPOS_ROOT` elsewhere, where the run id still resolves because the dir is rebuilt under this
  transcript's own tree.
- **A workflow agent's name comes from its FIRST PROMPT.** Its `agent-<id>.meta.json` is only
  `{"agentType":"workflow-subagent","spawnDepth":1}` — no description — and the script's own
  `label:` option is persisted nowhere, so the prompt is the one thing on disk saying what it was
  asked to do. A meta `description` still wins when present.
- **Run status comes from `journal.jsonl`, and "unreadable" must return None, not an empty set.**
  An empty set claims every agent is still RUNNING, which is what an EACCES, an IO error, or an
  ordinary walk/read race would otherwise paint on a run that finished hours ago — permanently,
  since nothing re-checks. `_read_tail_lines` swallows `OSError` and answers `[]`, so readability
  has to be established separately from emptiness.
- **The journal is streamed WHOLE — never through a tail window.** A `result` line carries the
  agent's return value, so a few dozen agents push the journal past any fixed tail, and the
  records a tail drops are the OLDEST — which the launch-order sort puts at the TOP of the picker,
  reading as "still running" forever. Memory stays bounded by folding each line as it completes,
  so `JOURNAL_READ_MAX` is a runaway backstop rather than a working limit and belongs far above
  any real journal — reading forward, whatever it drops is the NEWEST.
- **What stops a returned journal record from retiring another agent is JSON ESCAPING, not the
  head bound.** Inside a JSON string the nested record's quotes are backslash-escaped, so the
  unescaped `"agentId":"…"` pattern cannot occur there — at any length. The head bound is a COST
  limit; the correctness half is the ANCHOR on `JOURNAL_RESULT_RE`, which covers the one case
  escaping does not: a corrupt or half-written line that is not valid JSON and carries a raw
  record inside it. Do not restate the head bound as the safety mechanism — it isn't, and a test
  written against that claim passes with the bound removed.
- **The label read is bounded by BYTES, and truncation costs a NAME, not a row.** A prompt past
  `WORKFLOW_LABEL_MAX_BYTES` leaves the line unparseable and the label empty, and both clients
  fall back to the agent id. Raise the bound before treating that fallback as the fix — it is the
  accepted trade against an unbounded read on a memory-limited container, not a feature.
- **A symlinked `agent-<id>.jsonl` is refused** (`islink` beside `isfile`, which follows): a link
  in a run dir would otherwise be a phantom agent whose "transcript" is whatever it points at.
  `os.walk` already declines to descend directory symlinks; this is the file half of that rule.
- **The agent id from a clicked row names a FILE, so it is never joined onto a path**: it is
  pattern-checked and then matched against the run's own walk (`_workflow_agent_path`). The hub
  checks it again before queueing. Tests: `TestResolveWorkflowRun`, `TestStageSubagentHistory`.
- The client half — the picker, its empty-vs-unresolved wording and the three-rung Back — is in
  `.claude/rules/turma-sessions.md`.

