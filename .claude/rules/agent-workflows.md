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
<slug>/<transcript-id>/workflows/<runId>.json        <- the RUN RECORD, a SIBLING
<slug>/<transcript-id>/workflows/scripts/<name>-<runId>.js
```

A child `workflow()` run writes its agents FLAT into the parent's run dir, sharing its journal —
the walk in `_workflow_agent_files` is belt-and-braces, not a requirement. The sibling tree above
is the run RECORD, never a nested agent dir.

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
- **A row is named from the RUN RECORD, and that is what makes the picker usable.** Its
  `workflowProgress[]` carries the script's own `label:` (`review:bugs`, `essay:compilers`) plus a
  per-agent `state`, `index` and `startedAt`. **Nothing else on disk has the label** —
  `agent-<id>.meta.json` is only `{"agentType":"workflow-subagent","spawnDepth":1}` — so a fan-out
  over one prompt template renders every row IDENTICALLY without it, which is a picker you cannot
  pick from. An earlier claim that the label "is persisted nowhere" was wrong; do not restore it.
- **The record is written only when the run COMPLETES**, measured at ~80s on a two-agent run. So
  for the whole time an operator is watching a live run, rows fall back to prompt text and status
  comes from the journal — the labels arrive once nobody needs them. A recorded `state:"running"`
  is therefore near-unreachable in practice. This is the honest limit of the naming fix; do not
  describe it as naming rows live.
- **Covering an agent from the record also means NOT reading its transcript.** `handle_commands`
  runs synchronously in the heartbeat loop, so a large fan-out's per-agent head reads are beat
  latency — measured at ~1s for 200 agents with 1 MiB prompts, and ~5.7s to fold a 514 MiB journal.
  Both sit inside `INTERVAL`, but they multiply on slow storage, and the record avoids them.
- **The fallbacks are for a run whose record is missing OR incomplete**: a meta `description` (an
  ordinary subagent carries one), then the agent's FIRST PROMPT, then the id; order then falls back
  to each transcript's first timestamp.
- **The journal is folded per-AGENT, for whatever the record does not cover — not skipped whenever a
  record exists.** A record covering some agents used to suppress it for the rest, so a partly
  recorded run served status-less rows beside status-carrying ones while the journal knew every
  answer. The fold stays lazy, so the normal fully-covered case never pays for it.
- **The record is packed into a MIGRATION bundle** (`_pack_transcript`), because it is the only
  place the labels exist: without it a moved session's picker silently reverts to prompt text on the
  target alone.
- **`json.load` on it can raise `RecursionError`, which is not a `ValueError`.** Letting it escape
  leaves `handle_commands`' blanket catch to keep the beat alive while staging NOTHING, so the
  client polls to its timeout instead of being told the row is unavailable.
- **A recorded `state` is passed through as the run wrote it** — "failed" and "skipped" are worth
  seeing, and flattening them to done/running hides an agent that never produced anything.
- **`startedAt` is normalised to ISO.** The record times agents in epoch ms while the rest of this
  wire is ISO, and a field that is a string on one path and a number on the other is the shape that
  breaks a typed client's decode.
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

