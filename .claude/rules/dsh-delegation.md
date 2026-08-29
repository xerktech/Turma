---
paths:
  - "agent/dsh_transcript.py"
  - "agent/dsh_session.py"
  - "agent/dsh-session-driver/**"
  - "agent/tests/test_dsh_transcript.py"
  - "agent/tests/test_dsh_session.py"
---

# Background-agent / workflow rows + subagentHistory for dsh (XERK-474 [J])

The decision + the D3/S1 projection philosophy applied to delegation are in `.claude/rules/dsh.md`
([J], the XERK-304 contract, no new field) — this file is the mechanics, scoped to the delegation
files: how the launcher SYNTHESIZES the Claude-Code on-disk shapes so every existing reader works
UNCHANGED. Three streams feed it; the split is the whole design.

- **dsh's delegation model is NOT Claude's, and the differences drive the mapping** (verified against
  0.1.1-rc.2 `.d.ts`):
  - The **`subagent` tool** (default name) spawns ONE child; foreground blocks the turn, `continuable`
    / `run_in_background` are the background modes. Its lifecycle rides `subagent/start`/`subagent/end`
    — **ctx-bus events, NOT session-log entries** (they carry the live parent `Agent`), each with a
    `runId` + the child's `SessionId` (`info.id`). The child's LABEL is in the child log's
    `subagent/descriptor`, not the start event.
  - The **`workflow` tool** (default name) is **FOREGROUND** (blocks the turn) yet appends DURABLE
    `tool-workflow/{run-start,agent-start,agent-end,run-end}` events into the PARENT session log — so
    the run record is already captured, no ctx-bus forward needed. Each workflow agent is a subagent
    `SessionId`; `agent-start` carries `{seq,label,phase?,childId}`, `agent-end` `{seq,outcome}` — NO
    childId, so `seq` is the only join between the two.
  - Every child session (subagent OR workflow agent) is persisted by dsh as its OWN log keyed by the
    child id, a SIBLING of the parent under one project dir — never a parent/child nesting.

- **Synthesizing the launch/stop (`agent/dsh_transcript.py`, the [S1] projector).** The driver
  forwards the subagent ctx-bus edges into the parent log as `turma/subagent-start`/`turma/subagent-end`;
  the workflow's own `tool-workflow/*` are already there. The projector maps:
  - `turma/subagent-start` → an `Agent` tool_use + a tool_result carrying `agentId: <childId>` and a
    `toolUseResult{status:"async_launched", agentId, agentType:"subagent", description:<label>}` —
    exactly the TWO entries a Claude background launch writes, so the live-agent scan registers the row
    and `_resolve_subagent` maps a click to `subagents/agent-<childId>.jsonl`.
  - `tool-workflow/run-start` → a `Workflow` launch `toolUseResult{status:"async_launched",
    taskType:"local_workflow", workflowName, runId, taskId}`. **The run id carries the reader's `wf_`
    prefix** (`workflow_run_id`): `VALID_WORKFLOW_RUN_ID_RE`/`_resolve_workflow_run` require it and dsh
    mints a bare UUID, so the projection AND the run dir the tail writes both go through that one
    helper. taskId == runId — `_async_launch` keys the row on taskId, the resolver on runId.
  - `turma/subagent-end` / `tool-workflow/run-end` → a `<task-notification>` retiring the row (the
    `<task-id>` is the childId / `wf_<runId>`). All dsh stop reasons map to a Claude terminal status.
  - **Every embedded id is held to the reader's ASCII grammar** (`_VALID_ID_RE`, matching
    `VALID_WORKFLOW_AGENT_ID_RE`): a childId/runId names a live-agent id and a file, and is written
    verbatim into the `agentId:`/`<task-id>` text the scan matches — so an XML/newline/traversal id is
    refused (NOT `str.isalnum`, which is Unicode-aware and passes chars the readers reject). dsh mints
    UUIDs, so this never rejects a real id.
  - **The raw `subagent`/`workflow` tool-call + its result are DROPPED** — the synthesized launch
    replaces them, so the operator sees one launch card, not two. Keyed on the DEFAULT tool names; a
    host that renames them sees the raw card too (cosmetic, never a broken read).
  - **Marking a foreground subagent `async_launched` is deliberate and harmless**: the turn is busy
    the whole time anyway ([D] liveness), so "working" is unchanged, and it BUYS the operator a
    clickable drill-in row while the child runs — better than Claude, where a sync subagent isn't
    clickable. The end edge retires it; an agent-restart primes offsets to EOF (empty, never phantom).

- **Synthesizing the per-agent transcripts + run records (`agent/dsh_session.py`'s tail).**
  `DshWorkflowRuns` folds the parent log's `tool-workflow/*` into the run RECORD
  (`workflows/wf_<runId>.json`, `workflowProgress[]` — the script's own labels + live states) and the
  `journal.jsonl`, in the exact shapes `_workflow_run_record`/`_workflow_agents`/`_workflow_finished_agents`
  parse. Each captured child native log is projected by a FRESH `DshProjector` into its destination —
  `subagents/agent-<id>.jsonl` for an ordinary subagent, `subagents/workflows/wf_<runId>/agent-<id>.jsonl`
  for a workflow agent. **The record is written as the run PROGRESSES** (dsh appends the events live),
  unlike Claude Code which writes its record only at the end — so a live dsh run's picker carries real
  states.

- **A workflow agent reaches the tail through the subagent seam TOO, so its `turma/subagent-*` is
  suppressed** — it belongs to the run picker, never a top-level `Agent` row. Three nets, and the
  third is what makes suppression INDEPENDENT of event order rather than a restatement of it:
  - the driver skips the forward for a childId it has already seen on a `tool-workflow/agent-start`,
    AND writes the forward a tick late (`setImmediate`) so that agent-start lands FIRST in the file;
  - the tail drops a `turma/subagent-*` edge whose child the accumulator already knows is a workflow
    agent (`_is_workflow_child_edge`);
  - **the RECLAIM** (`_reclaim_if_workflow_child`): if a child was ALREADY launched top-level when its
    `tool-workflow/agent-start` arrives (the reversed order the first two nets miss), the tail emits a
    `<task-notification>` retiring it at once. Without this the phantom would LINGER — its own
    `turma/subagent-end` is a workflow edge and would be suppressed by net two — so the reclaim, not
    the file-order bet, is what guarantees no permanent top-level row for a workflow agent.
  - **`_emitted_launches` is bounded by DROP-ON-END, not by an arbitrary cap**: an ordinary subagent's
    id is removed when its `turma/subagent-end` retires it, so the set holds only in-flight launches;
    the `EMITTED_LAUNCHES_MAX` count is a pure backstop for a subagent whose end was LOST.
  A child filed flat before its `agent-start` arrives (the same race, on the transcript side) is
  MOVED under the run dir on the next pump.

- **Where the two extra streams live, and why.** The driver writes each descendant session's native
  log to `<store>/subagents/<childId>.jsonl` (a sibling of the parent's `events.jsonl` under
  `<tid>/dsh/`, XERK-469 [E]) and forwards the subagent edges into `events.jsonl` itself. The PROJECTED
  transcripts + run records land under `<tid>/subagents/` and `<tid>/workflows/` — the Claude layout —
  so `_project_transcripts` counts a dsh session's delegated tokens (D4) and `_pack_bytes` migrates
  them ([K]) with NO change, while the native `<tid>/dsh/**` rides the raw archive layer as before.
  The delegation work is CONTAINED off the main transcript: a failure filing a child or a record must
  never cost the parent transcript, which is what every other surface reads.

- **Residual gaps (state them; do not paper over).**
  - **Verified by UNIT TEST, not against real dsh** — no launcher runs a dsh subagent/workflow end to
    end yet, so the event shapes come from dsh's `.d.ts` and the seam is proven through hub-agent's own
    readers, matching how [D]/[E] shipped. The `ctx.on('subagent/start', …, {global:true})` scope is
    the thing live dsh must confirm; the subagent-vs-agent-start ORDERING is no longer load-bearing
    (the reclaim net above retires a late-claimed workflow child whatever the order).
  - **A WORKER-THREAD workflow agent's per-agent transcript is not captured**: it runs in its own ctx,
    so its `session/event`s never reach the driver's global handler. The run RECORD (labels + states)
    still works — it is built from the durable PARENT events — so the picker shows the rows; only the
    drill-in transcript is empty for such an agent. Closing it needs the worker to forward child events
    (a dsh-side change) or reading dsh's own zstd child logs (no stdlib zstd).
  - **The subagent row's LABEL is best-effort**: the driver fills it from the child's descriptor when
    seen before the start edge, else the childId — resolution stays correct either way (the row label
    and the tool_use description come from ONE value, so `_resolve_subagent` always matches).
- Tests: `TestDshSubagentProjection`/`TestDshWorkflowProjection`/`TestDshWorkflowRuns`
  (`test_dsh_transcript.py`), `DshDelegationTailTest` (`test_dsh_session.py`), the `scanAgentEntry`
  XERK-474 cases (`tunnel-agent.test.js`).
