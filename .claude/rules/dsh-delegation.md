---
paths:
  - "agent/dsh_transcript.py"
  - "agent/dsh_session.py"
  - "agent/dsh-session-driver/**"
  - "agent/tests/test_dsh_transcript.py"
  - "agent/tests/test_dsh_session.py"
---

# Background-agent / workflow rows + subagentHistory for dsh (XERK-474 [J])

Decision + philosophy: `.claude/rules/dsh.md` ([J], XERK-304 contract, no new field). Here: the
mechanics — the launcher SYNTHESIZES Claude-Code on-disk shapes so every existing reader works
UNCHANGED. Three streams feed it; the split is the whole design.

- **dsh's delegation model differs from Claude's** (verified against 0.1.1-rc.2 `.d.ts`):
  - **`subagent` tool** spawns ONE child; foreground blocks the turn, `continuable`/
    `run_in_background` are background modes. Lifecycle rides `subagent/start`/`subagent/end` —
    **ctx-bus events, NOT session-log entries** — each with a `runId` + child `SessionId`. The
    child's LABEL is in the child log's `subagent/descriptor`, not the start event.
  - **`workflow` tool** is FOREGROUND yet appends DURABLE `tool-workflow/{run-start,agent-start,
    agent-end,run-end}` into the PARENT log — the run record is already captured, no ctx-bus
    forward needed. Each workflow agent is a subagent `SessionId`; `agent-start` carries
    `{seq,label,phase?,childId}`, `agent-end` `{seq,outcome}` (no childId — `seq` is the join).
  - Every child session (subagent OR workflow agent) persists as its OWN log keyed by child id, a
    SIBLING of the parent — never parent/child nesting.

- **Synthesizing launch/stop** (`dsh_transcript.py`'s [S1] projector): the driver forwards subagent
  ctx-bus edges into the parent log as `turma/subagent-start`/`turma/subagent-end`; workflow's own
  `tool-workflow/*` are already there. The projector maps:
  - `turma/subagent-start` → an `Agent` tool_use + tool_result carrying `agentId: <childId>` and
    `toolUseResult{status:"async_launched", agentId, agentType:"subagent", description:<label>}` —
    the same TWO entries a Claude background launch writes, so the live-agent scan registers the row
    and `_resolve_subagent` maps a click to `subagents/agent-<childId>.jsonl`.
  - `tool-workflow/run-start` → a `Workflow` launch `toolUseResult{status:"async_launched",
    taskType:"local_workflow", workflowName, runId, taskId}`. **The run id carries the reader's `wf_`
    prefix** (`workflow_run_id`, `VALID_WORKFLOW_RUN_ID_RE`/`_resolve_workflow_run` require it) — dsh
    mints a bare UUID, so both the projection and the tail's run
    dir go through that one helper. taskId == runId.
  - `turma/subagent-end`/`tool-workflow/run-end` → a `<task-notification>` retiring the row (`<task-id>`
    = childId / `wf_<runId>`). All dsh stop reasons map to a Claude terminal status.
  - **Every embedded id is held to the reader's ASCII grammar** (`_VALID_ID_RE`, matching
    `VALID_WORKFLOW_AGENT_ID_RE`), written verbatim into the `agentId:`/`<task-id>` text the scan
    matches — NOT `str.isalnum` (Unicode-aware, passes chars the readers reject). dsh mints UUIDs, so
    this never rejects a real id.
  - **The raw `subagent`/`workflow` tool-call + result are DROPPED** — one launch card, not two.
    Keyed on the DEFAULT tool names; a host renaming them sees the raw card too (cosmetic only).
  - **Marking a foreground subagent `async_launched` is deliberate** — the turn is busy the whole
    time anyway ([D] liveness), and it buys a clickable drill-in row while the child runs (better
    than Claude, where a sync subagent isn't clickable). The end edge retires it; a restart primes
    offsets to EOF (empty, never phantom).

- **Synthesizing per-agent transcripts + run records** (`dsh_session.py`'s tail): `DshWorkflowRuns`
  folds the parent log's `tool-workflow/*` into the run RECORD (`workflows/wf_<runId>.json`,
  `workflowProgress[]`) and `journal.jsonl`, in the shapes `_workflow_run_record`/`_workflow_agents`/
  `_workflow_finished_agents` parse. Each captured child native log is projected by a FRESH
  `DshProjector` into `subagents/agent-<id>.jsonl` (ordinary subagent) or
  `subagents/workflows/wf_<runId>/agent-<id>.jsonl` (workflow agent). **The record is written as the
  run PROGRESSES** (unlike Claude Code, which writes only at the end), so a live picker shows real
  states.

- **A workflow agent also reaches the tail through the subagent seam, so its `turma/subagent-*` is
  suppressed** — three nets, independent of event order:
  - driver skips the forward for a childId already seen on `tool-workflow/agent-start`, and forwards
    a tick late (`setImmediate`) so agent-start lands first;
  - tail drops a `turma/subagent-*` edge whose child the accumulator knows is a workflow agent
    (`_is_workflow_child_edge`);
  - **the RECLAIM** (`_reclaim_if_workflow_child`): if a child was already launched top-level when its
    `agent-start` arrives (reversed order), the tail retires it at once via `<task-notification>` —
    without this it would LINGER, since its own `subagent-end` is suppressed by net two.
  - **`_emitted_launches` is bounded by DROP-ON-END**, not an arbitrary cap: an id is removed on its
    `subagent-end`; `EMITTED_LAUNCHES_MAX` is a pure backstop for a lost end.
  A child filed flat before its `agent-start` arrives is MOVED under the run dir on the next pump.

- **Where the extra streams live.** Driver writes each descendant's native log to
  `<store>/subagents/<childId>.jsonl` (sibling of the parent's `events.jsonl` under `<tid>/dsh/`,
  [E]) and forwards subagent edges into `events.jsonl` itself. PROJECTED transcripts + run records
  land under `<tid>/subagents/` and `<tid>/workflows/` (the Claude layout), so `_project_transcripts`
  counts delegated tokens (D4) and `_pack_bytes` migrates them ([K]) with NO change, while native
  `<tid>/dsh/**` rides the raw layer as before. **A failure filing a child/record must never cost the
  parent transcript.**

- **Residual gaps:**
  - **Verified by UNIT TEST, not real dsh** — event shapes come from dsh's `.d.ts`; the seam is
    proven through hub-agent's own readers (matching [D]/[E]). `ctx.on('subagent/start', …,
    {global:true})` scope is the thing live dsh must confirm; subagent-vs-agent-start ORDERING is no
    longer load-bearing (the reclaim net retires a late-claimed child regardless of order).
  - **A WORKER-THREAD workflow agent's per-agent transcript is not captured** — its `session/event`s
    never reach the driver's global handler. The run RECORD still works (built from durable parent
    events); only the drill-in transcript is empty. Fix needs the worker to forward child events, or
    reading dsh's own zstd child logs (no stdlib zstd).
  - **The subagent row's LABEL is best-effort** — filled from the descriptor when seen before the
    start edge, else the childId; row label and tool_use description share ONE value, so
    `_resolve_subagent` always matches.
- Tests: `TestDshSubagentProjection`/`TestDshWorkflowProjection`/`TestDshWorkflowRuns`
  (`test_dsh_transcript.py`), `DshDelegationTailTest` (`test_dsh_session.py`), the `scanAgentEntry`
  XERK-474 cases (`tunnel-agent.test.js`).
