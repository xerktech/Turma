---
paths:
  - "agent/qwen_transcript.py"
  - "agent/qwen_session.py"
  - "agent/tests/test_qwen_transcript.py"
  - "agent/tests/test_qwen_session.py"
---

# Background-agent / subagentHistory for qwen (XERK-517 [Qwen J])

The decision lives in `.claude/rules/qwen.md` ([Qwen J] pointer); this is the mechanics, scoped to
the delegation files. The projection philosophy (S1) applied to DELEGATION: a qwen session that
spawns sub-agents shows the picker + per-agent transcripts IDENTICALLY to Claude, so instead of
teaching any reader about qwen, the projector RESHAPES qwen's own near-Claude launch into the exact
Claude-Code on-disk shapes and every existing reader (`_scan_agent_entry`, `_resolve_subagent`, the
usage/archive walks) works UNCHANGED — the XERK-304 contract, no new field.

- **Qwen's delegation is a near-Claude `Agent` launch, so this is a RESHAPE, not a synthesis** (the
  dsh [J] difference — dsh had to synthesize launch/stop from ctx-bus edges; qwen already writes
  them). Verified against REAL Qwen 0.22.x on-disk captures (`~/.qwen/projects/<slug>/…`), the
  no-mock lesson:
  - The delegation tool registers as **`agent`** (lowercase) with args `{description, subagent_type,
    prompt}` — Claude's `Agent` tool ported. `_TOOL_NAME_MAP` maps `agent`→`Agent` so
    `_scan_agent_entry`/`_resolve_subagent` (which key on `Agent`/`Task`) recognize it.
  - The launch tool_result carries a **`toolCallResult.resultDisplay` of type `task_execution`**
    (`{subagentName, taskDescription, status}`) — NOT Claude's `toolUseResult{status:
    "async_launched"}`. `_subagent_launch` detects that shape and the projector reshapes the entry:
    a background launch gets a Claude `toolUseResult{status:"async_launched", agentId, agentType,
    description}` + a clean `"…agentId: <id>"` result text; the agentId is the `task_id:` Qwen prints
    into the output (else reconstructed as `<subagentName>-<callId>`, which is exactly how Qwen names
    the on-disk child file `agent-<id>.jsonl`).
  - The **STOP edge is FREE**: Qwen writes an EXACT Claude `<task-notification>` (`<task-id>` +
    `<status>`) as a plain user turn, which the projector's `_user_message` passes through and
    `_scan_agent_entry`/`_parse_task_notification` retires the row on — no synthesis.
  - **The agentId is held to the reader's ASCII grammar** (`_VALID_AGENT_ID_RE`, matching
    `VALID_WORKFLOW_AGENT_ID_RE`/`_AGENT_ID_RE`): it names a live-agent id and a file and is written
    verbatim into the `agentId:` text the scan matches, so an XML/newline/traversal id is refused
    (the result then projects as a plain card, never an unresolvable row). Qwen mints
    `<type>-call_<hex>`, so this never rejects a real id.

- **A FOREGROUND (synchronous) subagent is RESOLVABLE but never a live row.** `resultDisplay.status`
  is `"background"` for an in-flight launch (retired later by the `<task-notification>`) and a
  terminal state (e.g. `"completed"`) for one that ran inline. A completed one gets NO notification,
  so marking it `async_launched` would strand a permanent phantom live row (the reason `_async_launch`
  excludes a sync subagent). It is left off the live set but stays clickable — the real result is
  kept and a reconstructed `agentId: <id>` line is prepended so `_resolve_subagent` opens its child.

- **The child transcript is projected by the TAIL, not the projector** (`agent/qwen_session.py`).
  Qwen writes each subagent's OWN native log at `<slug>/subagents/<parentSessionId>/agent-<id>.jsonl`
  (+ a `.meta.json`) — a SIBLING of `<slug>/chats/`, so the dir is resolved off the parent native
  log path the tail already located by glob, never a recomputed slug. `_sync_children` projects each
  through a FRESH `QwenProjector(childId)` (the child's events carry the PARENT's sessionId, so the
  projector is seeded on the CHILD id — unique uuids, no collision) into the Claude layout
  `<transcript stem>/subagents/agent-<id>.jsonl` that `_resolve_subagent`/`_subagents_dir` derive —
  incrementally on a per-child offset, contained in its own try/except (a delegation failure must
  never cost the main transcript). A symlinked child log is refused (`islink` beside `isfile`).

- **`_pump` runs child sync EVERY pump, past the parent's "no new data" early-return** — the load-
  bearing qwen difference from dsh. A BACKGROUND subagent grows its own child log while the parent
  turn is idle, so the parent chat log gains nothing meanwhile; dsh's driver writes parent + child
  edges together, so its single early-return was harmless. `_pump` splits into `_pump_parent`
  (guarded, may no-op) then always `_sync_children`.

- **Usage + archive + migration count/carry the delegated tokens with NO change.** The projected
  child at `<slug>/<sid>/subagents/agent-<id>.jsonl` is exactly the layout `_project_transcripts`
  (XERK-302) walks — its spend folds into the totals AND the delegated `subagent` slice — the raw
  layer `_session_files` ships, and migration `_pack_transcript` packs (`<id>/subagents/**`). The
  subagent's own model turns live ONLY in the child log; the parent transcript stays clean (Qwen's
  `ui_telemetry` subagent rows are `system` events [S1] already drops), so nothing double-counts.

- **Residual gaps (state them; do not paper over).**
  - **WORKFLOWS are not projected.** Qwen has an internal workflow primitive (`workflow_run`
    telemetry, the `workflow` chunk), but it writes NO Claude-shaped `local_workflow` launch record
    or `subagents/workflows/<runId>/` run dir on disk that any capture exercised, so there is no
    clean mapping to synthesize — a `workflow`-orchestrated run's rows are NOT surfaced. Close it
    only against a real captured workflow-run corpus, never blind.
  - **The `.meta.json` sidecar is not mirrored.** `_resolve_subagent` needs only the `Agent`
    tool_use + the `agentId:` text (both present), so ordinary-subagent resolution is unaffected; the
    meta is unused outside the (unprojected) workflow path.
  - Verified through hub-agent's REAL readers over a corpus captured from a real Qwen background
    delegation on disk (`qwen_delegation_corpus.json` + `qwen_delegation_child.json`, sanitized only
    for paths). The launch/stop/resolve/count chain is CI-covered; a live end-to-end qwen delegation
    (the model actually calling `agent`, `run_in_background`, `list_agents`/`send_message`) is
    host-proof, the footing every qwen child ships on.

- Tests: `TestQwenSubagentDelegation` (`test_qwen_transcript.py` — name map, async_launched reshape,
  live register+retire through the real scan, `_resolve_subagent`, the sync-subagent no-phantom rule,
  the delegated-token slice, grammar-failing id) and `QwenDelegationTailTest` (`test_qwen_session.py`
  — the tail projects a real child log into the Claude layout and it resolves, incremental, no-op
  without a subagents dir, symlink refused).
