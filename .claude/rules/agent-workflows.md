---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Workflow runs: resolving a `workflow` row to its agents (XERK-304)

A `Workflow` launch is N agents and writes NO transcript of its own, so a clicked `workflow` row in a
session's background-agent list resolves to a RUN — a picker of agents — rather than one
conversation. The row is registered by `_async_launch`/`_scan_agent_entry` (`agent.md`); below is
turning it back into something to read. Layout, one level deeper than an ordinary background agent:

```
<slug>/<transcript-id>/subagents/workflows/<runId>/agent-<x>.jsonl
                                                   agent-<x>.meta.json
                                                   journal.jsonl
<slug>/<transcript-id>/workflows/<runId>.json        <- the RUN RECORD, a SIBLING
<slug>/<transcript-id>/workflows/scripts/<name>-<runId>.js
```

A child `workflow()` run writes its agents FLAT into the parent's run dir, sharing its journal (the
walk in `_workflow_agent_files` is belt-and-braces). The sibling tree above is the run RECORD, never
a nested agent dir.

- **`agents` PRESENT — the empty list included — is what tells a client it got a list.**
  `_stage_subagent_history` answers a `workflow` row with `agents`; only a second request naming one
  of those ids returns a transcript. A started run with nothing written yet is an empty list; an
  unresolved row carries no `agents` key at all — collapsing the two loses "nothing running" vs
  "this row is broken".
- **A clicked row resolves from the IN-MEMORY scan index first, NOT the transcript window** (XERK-333).
  `_resolve_subagent`/`_resolve_workflow_run` read only the last 8 MiB of the main transcript, so a
  launch that has scrolled further back (a long-running workflow — the LONGEST-lived work on a host)
  is still LISTED (`liveAgents` spans the whole file) but no longer resolvable BY THEM: the row stays
  clickable and opens "unavailable". So `_scan_agent_entry` carries each launch's on-disk handle as
  `resolveId` on its `liveAgents` entry (a subagent's agentId, a workflow run's runId — NOT the
  taskId the row is keyed on), and `_live_agent_resolve_id` maps a clicked type+label back to it;
  `_stage_subagent_history` uses `_workflow_run_dir`/`_subagent_transcript_path` on that handle and
  falls to the windowed `_resolve_*` scan only for a row the index doesn't know (a pane-scraped
  `status.agents` row from an older agent, or a launch predating a manager restart's EOF-primed
  offsets). **Do not "simplify" by dropping the index and widening the 8 MiB window — that just
  moves the cliff, and a full-transcript scan per click is what the window exists to avoid.** The
  wire stays `[{type,label}]` (`live_agents_report` unchanged); `resolveId` is agent-internal, so the
  `tunnel-agent.js` mirror does not carry it (it never resolves). Tests: the `_past_the_window_`
  cases in `TestStageSubagentHistory`, `TestLiveAgentResolveId`, `TestWorkflowRunDir`.
- **The run dir is named after the launch record's `runId`, NOT its `taskId`** — different handles
  on the same launch (`wf_86e01141-7bc` vs `we1gtmfyd`), and `_async_launch` keys the ROW on taskId
  (XERK-304's bug). The record's absolute `transcriptDir` is ignored too: untrusted input on a path
  join, and stale after a MIGRATED session — the run id still resolves under this transcript's own
  rebuilt tree.
- **A row is named from the RUN RECORD** — its `workflowProgress[]` carries the script's own
  `label:` (`review:bugs`, `essay:compilers`) plus per-agent `state`/`index`/`startedAt`. **Nothing
  else on disk has the label** (`agent-<id>.meta.json` is only `{"agentType":"workflow-subagent",
  "spawnDepth":1}`), so without it a fan-out over one prompt template renders every row identically.
- **The record is written only when the run COMPLETES** (~80s on a two-agent run) — so for the
  WHOLE time an operator watches a live run, rows fall back to prompt text/journal status; a recorded
  `state:"running"` is near-unreachable in practice. This is the honest limit; do not describe it as
  naming rows live.
- **Covering an agent from the record also means NOT reading its transcript.** `handle_commands`
  runs synchronously in the heartbeat loop, so per-agent head reads on a large fan-out are beat
  latency (measured ~1s/200 agents at 1 MiB prompts, ~5.7s to fold a 514 MiB journal) — both fit
  `INTERVAL` but multiply on slow storage; the record avoids them.
- **Fallbacks, in order, for a run whose record is missing/incomplete**: a meta `description`, then
  the agent's FIRST PROMPT, then the id; ordering falls back to each transcript's first timestamp.
- **The journal folds per-AGENT for whatever the record does not cover — never skipped just because
  a record exists** (a partly-recorded run needs both). Stays lazy, so the fully-covered case never
  pays for it.
- **The record is packed into a MIGRATION bundle** (`_pack_transcript`) since it's the only place
  labels exist — without it a moved session's picker reverts to prompt text on the target. It can
  never cost the move itself: nothing prunes the tree, so a long-lived session accumulates one record
  per run. The bundle is built WITH them, rebuilt WITHOUT them if the finished blob exceeds
  `MIGRATION_BLOB_MAX` or the tree is unreadable — a working move beats prettier labels.
  - **The drop is scoped by the error's own FILENAME; an unattributable error refuses the move**
    (data loss must never be silent). Measuring the tree size against a constant was the rejected
    first attempt — only the FINISHED bundle size can answer, since any records tree can push a
    near-ceiling transcript over it; `WORKFLOW_PACK_MAX_BYTES` is a cheap pre-filter only.
- **The journal fold is LAZY and MEMOISED — two separate properties.** Lazy: a fully recorded run
  never reads it. Memoised: a run with many uncovered agents reads it ONCE, not once per row
  (including a fold that answers None) — a multi-second read inside the synchronous beat loop.
- **`json.load` on it can raise `RecursionError`, not a `ValueError`** — letting it escape leaves
  `handle_commands`' blanket catch staging NOTHING, so the client polls to timeout instead of being
  told the row is unavailable.
- **A recorded `state` passes through as written** — "failed"/"skipped" matter; flattening to
  done/running hides an agent that produced nothing.
- **`startedAt` is normalised to ISO** — the record times agents in epoch ms while the rest of the
  wire is ISO; a field typed differently on two paths breaks a typed client's decode.
- **Run status comes from `journal.jsonl`; "unreadable" must return None, not an empty set** — an
  empty set claims every agent is still RUNNING, which is what an EACCES/IO-error/walk race would
  otherwise paint on a run that finished hours ago, permanently (nothing re-checks).
  `_read_tail_lines` swallows `OSError` and answers `[]`, so readability is established separately
  from emptiness.
- **The journal is streamed WHOLE — never through a tail window.** A `result` line carries the
  agent's return value, so a tail drops the OLDEST records, which sort to the TOP of the picker and
  read "still running" forever. Memory stays bounded by folding each line as it completes;
  `JOURNAL_READ_MAX` is a runaway backstop, not a working limit.
- **What stops a returned journal record from retiring another agent is JSON ESCAPING, not a head
  bound.** A nested record's quotes are backslash-escaped inside a JSON string, so the unescaped
  `"agentId":"…"` pattern can't occur there at any length; the correctness half is the ANCHOR on
  `JOURNAL_RESULT_RE`, covering a corrupt/half-written line that carries a raw record. Do not treat
  the head bound as the safety mechanism.
- **The label read is bounded by BYTES; truncation costs a NAME, not a row.** A prompt past
  `WORKFLOW_LABEL_MAX_BYTES` leaves the label empty and both clients fall back to the agent id —
  raise the bound rather than treat that fallback as broken.
- **A symlinked `agent-<id>.jsonl` is refused** (`islink` beside `isfile`) — else a link in a run dir
  is a phantom agent. `os.walk` already declines directory symlinks; this is the file half.
- **The agent id from a clicked row names a FILE, never joined onto a path** — pattern-checked, then
  matched against the run's own walk (`_workflow_agent_path`); the hub checks it again before
  queueing. Tests: `TestResolveWorkflowRun`, `TestStageSubagentHistory`.
- The client half — the picker, its empty-vs-unresolved wording, the three-rung Back — is in
  `.claude/rules/turma-sessions.md`.
