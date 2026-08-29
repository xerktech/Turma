---
paths:
  - "agent/qwen_transcript.py"
  - "agent/qwen_session.py"
  - "agent/tests/test_qwen_transcript.py"
  - "agent/tests/test_qwen_session.py"
---

# Background-agent / subagentHistory for qwen (XERK-517 [Qwen J])

Decision: `.claude/rules/qwen.md` ([Qwen J]). Here: the mechanics. A qwen session that spawns
sub-agents shows the picker + per-agent transcripts IDENTICALLY to Claude — the projector RESHAPES
qwen's near-Claude launch into the exact Claude-Code on-disk shapes, so every existing reader
(`_scan_agent_entry`, `_resolve_subagent`, usage/archive walks) works UNCHANGED, no new field
(XERK-304).

- **A RESHAPE, not a synthesis** (the dsh [J] difference — dsh must synthesize launch/stop from
  ctx-bus edges; qwen already writes them). Verified against REAL Qwen 0.22.x on-disk captures:
  - Delegation tool registers as **`agent`** (lowercase) with `{description, subagent_type, prompt}`.
    `_TOOL_NAME_MAP` maps `agent`→`Agent` so `_scan_agent_entry`/`_resolve_subagent` recognize it.
  - Launch tool_result carries `toolCallResult.resultDisplay` type `task_execution`
    (`{subagentName, taskDescription, status}`) — NOT Claude's `toolUseResult{status:
    "async_launched"}`. `_subagent_launch` detects this and the projector reshapes it into a Claude
    `toolUseResult{status:"async_launched", agentId, agentType, description}` + a clean
    `"…agentId: <id>"` text; the agentId is Qwen's printed `task_id:` (else `<subagentName>-<callId>`,
    matching the on-disk child file `agent-<id>.jsonl`).
  - **STOP edge is FREE**: Qwen writes an EXACT Claude `<task-notification>` as a plain user turn —
    `_user_message` passes it through, `_scan_agent_entry`/`_parse_task_notification` retire the row.
    No synthesis needed.
  - **agentId held to the reader's ASCII grammar** (`_VALID_AGENT_ID_RE`), written verbatim into the
    `agentId:` text the scan matches — NOT Unicode-aware `isalnum`, so an XML/newline/traversal id is
    refused (projects as a plain card, never an unresolvable row). Qwen mints `<type>-call_<hex>`, so
    this never rejects a real id.

- **A FOREGROUND (synchronous) subagent is RESOLVABLE but never a live row.**
  `resultDisplay.status` is `"background"` in-flight, a terminal state (`"completed"`) if run inline.
  A completed one gets NO notification, so marking it `async_launched` would strand a permanent
  phantom (why `_async_launch` excludes it). Left off the live set but stays clickable — result kept,
  a reconstructed `agentId: <id>` line prepended so `_resolve_subagent` opens its child.

- **The child transcript is projected by the TAIL, not the projector** (`qwen_session.py`). Qwen
  writes each subagent's OWN native log at `<slug>/subagents/<parentSessionId>/agent-<id>.jsonl` (+
  `.meta.json`), a SIBLING of `<slug>/chats/`, resolved off the parent's already-glob-located native
  log path — never a recomputed slug. `_sync_children` projects each through a FRESH
  `QwenProjector(childId)` (seeded on the CHILD id, since child events carry the PARENT's sessionId)
  into `<transcript stem>/subagents/agent-<id>.jsonl` — incrementally, per-child offset, own
  try/except (a delegation failure must never cost the main transcript). A symlinked child log is
  refused.

- **`_pump` runs child sync EVERY pump, past the parent's "no new data" early-return** — the
  load-bearing qwen difference from dsh: a BACKGROUND subagent grows its own child log while the
  parent turn is idle, so the parent log alone would show nothing. `_pump` splits into
  `_pump_parent` (guarded, may no-op) then always `_sync_children`.

- **Usage + archive + migration count/carry delegated tokens with NO change** — the child at
  `<slug>/<sid>/subagents/agent-<id>.jsonl` is exactly the layout `_project_transcripts` (XERK-302)
  walks, the raw layer ships, and migration packs (`<id>/subagents/**`). The parent transcript stays
  clean (Qwen's `ui_telemetry` subagent rows are `system` events S1 already drops), so nothing
  double-counts.

- **Residual gaps:**
  - **WORKFLOWS are not projected** — Qwen's internal workflow primitive writes no Claude-shaped
    `local_workflow` launch record or `subagents/workflows/<runId>/` dir that any capture exercised.
    Close only against a real captured workflow-run corpus, never blind.
  - **The `.meta.json` sidecar is not mirrored** — unused outside the (unprojected) workflow path;
    ordinary-subagent resolution needs only the `Agent` tool_use + `agentId:` text.
  - Verified through hub-agent's REAL readers over a corpus captured from a real Qwen background
    delegation (`qwen_delegation_corpus.json` + `qwen_delegation_child.json`). Launch/stop/resolve/
    count is CI-covered; a live end-to-end delegation is host-proof.
- Tests: `TestQwenSubagentDelegation` (`test_qwen_transcript.py` — name map, async_launched reshape,
  live register+retire, `_resolve_subagent`, sync-subagent no-phantom rule, delegated-token slice,
  grammar-failing id) and `QwenDelegationTailTest` (`test_qwen_session.py` — tail projects a real
  child log into the Claude layout and it resolves, incremental, no-op without a subagents dir,
  symlink refused).
