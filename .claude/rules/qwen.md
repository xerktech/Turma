---
paths:
  - "agent/hub-agent.py"
  - "agent/qwen_transcript.py"
  - "agent/tests/test_qwen_transcript.py"
  - "turma/server.js"
  - "turma/public/sessions.html"
  - "android/**"
---

# Qwen Code integration — runtime plumbing (XERK-504)

Qwen Code (`@qwen-code/qwen-code`) is a SECOND selectable per-session runtime alongside Claude Code,
the interactive-TUI analogue of dsh (`.claude/rules/dsh.md`). Its process model is Claude-shaped, not
dsh-headless: pinned session id, native JSONL on disk, tmux pane injection, `capture-pane` state
parsing, a PreToolUse hard-deny guard — proven against real Qwen Code in the G0 spike
(`docs/qwen-g0-spike.md`, XERK-505: **GO**, no new drive mechanism needed).

This file records the qwen invariants a later child must not undo. The runtime-SELECTION layer is
[Qwen A] (below); everything else — the launcher, the transcript/pane parsers, the guard — is later
children of XERK-504.

## [A] (XERK-506) shipped: runtime field + capability flag + composer option

The presentational runtime-selection plumbing, mirroring dsh [A] (XERK-465). It grants nothing about
the qwen process model. What landed, and the invariants a later child must not undo:

- **`agentType` gains `"qwen"`** — the enum is now `{"claude","dsh","qwen"}` (`AGENT_TYPES`),
  default `"claude"`, validated at spawn (`resolve_agent_type`) and carried on every
  record-rebuild path (spawn, `_remember_closed`, resume, resume-transcript, `_resume_at_cwd`,
  `receive_migration`) plus `_session_payload` — those paths pass `agentType` through as a string,
  so adding it to the enum is all they needed. An agent predating it reports nothing; the hub
  coerces the session field to `""` in `normalizeRecord`, which reads as claude.
- **`qwen` is the heartbeat capability block `{available}`**, mirroring dsh/localModel: backed by
  `qwen_configured()` (env gate `TURMA_QWEN`, OFF by default so every current host degrades),
  coerced strict-boolean by `normalizeQwen` (a `HEARTBEAT_KNOWN_KEYS` member), typed on Android
  (`AgentInfo.qwen: QwenInfo?`). Absent/false = "this host cannot do qwen", so the composer HIDES the
  runtime option rather than queue a spawn the host refuses. Both spawn routes 409 a `qwen` choice
  at a host with no capability (`checkSpawnAgentType`), and the agent re-validates
  (`resolve_agent_type`).
  - **[Qwen A] deliberately carries NO qwen model plumbing** — the block is `{available}` alone
    (unlike dsh's `{available,models,defaultModel,contextTokens}`). qwen's model list is a later
    child; do not widen `_qwen_payload`/`normalizeQwen`/`QwenInfo` here.
- **`QWEN_ENABLED` is an in-CODE fleet-wide kill switch**, the qwen twin of `DSH_ENABLED`: it gates
  `qwen_configured()` (agent), `qwenAvailable`/`normalizeQwen` (hub) and `Runtime.QWEN_ENABLED`
  (Android) — so no single component can re-enable qwen alone. It ships **False** because the
  LAUNCHER does not exist yet ([Qwen B]); with it off, `resolve_agent_type` refuses every
  `agentType="qwen"` spawn before any record carries one, so `_launch_qwen` is unreachable. Flip it
  True in all three components (and set `TURMA_QWEN`) when [Qwen B] lands.
- **`_launch_tmux` is the single launch choke point; its runtime dispatch gains a qwen arm**:
  `if sess.agentType == "qwen": self._launch_qwen(sess); return`. `_launch_qwen` is a stub that
  RAISES (the launcher is [Qwen B]); the dispatch line and choke point stay — do not hoist it to the
  callers. Because `resolve_agent_type` re-gates on `_launch_tmux`'s side and QWEN_ENABLED is off,
  the stub cannot be reached today.
- **The rebuild/resume guard is per-runtime, not dsh-only** (`agent_type_configured`): a persisted
  `"qwen"` re-gates on `qwen_configured()` and a `"dsh"` on `dsh_configured()`, so a qwen session
  resumes/migrates onto a qwen-only host instead of both hinging on `dsh_configured()` (the bug the
  original dsh-only guard would have had for qwen).
- **Composer only, no card badge** (mirrors dsh [A]): `sessions.html`'s Runtime `<select>` gains a
  "Qwen Code" option gated on `a.qwen.available`, sending `agentType:"qwen"` and — since [Qwen A] has
  no qwen model/permission UI — no model, modelSource or permissionMode (it hides both the model row
  and the permission row for qwen). Android mirrors just that composer row (`Runtime.composerRuntimes`
  / `spawnAgentType` / `spawnValue` / `hostQwen`, `SpawnDialog`'s `qwen` param). There is no qwen
  runtime chip on the session card.
- Tests: `TestSpawnOptionHelpers` (`test_qwen_configured_*`, `test_resolve_agent_type_qwen_gate`,
  `test_agent_type_configured_*`, `test_qwen_payload_*`) agent-side; the `normalizeQwen`/
  `QWEN_ENABLED`/spawn-route/known-key cases in `server.test.js`; the qwen composer case in
  `sessions.test.js`; `RuntimeTest`/`SpawnRequestTest`/`SpawnComposerTest`/`AgentDecodeTest` (android).

## [Qwen S1] (XERK-508) shipped: transcript projection (`agent/qwen_transcript.py`)

The read-side load-bearing piece, mirroring dsh [S1] (`.claude/rules/dsh.md`). `QwenProjector.feed(
event)` projects one Qwen native-log event into the 0+ Claude-Code JSONL entry dicts it maps to;
`project_log()` is the batch form. PURE, stdlib-only, its own file (parallel-safe). The launcher's
tail ([Qwen B], XERK-507) appends the projection to the pinned `<claudeSessionId>.jsonl`, and the
EXISTING `_entry_blocks`/`entryBlocks`, `_entry_text`, usage accountancy, PR scan and live tail read
it UNCHANGED — **NO new reader, NO JS translator**. The py/js parity IS that the projected JSONL
renders identically under both. Invariants a change must not undo:

- **Only the three Qwen SURFACE types project**: `user`, `assistant`, `tool_result`. Every `system`
  event (attribution/file-history/`ui_telemetry`/slash-command) is log-only → `[]`. The
  `ui_telemetry` `api_response`/`tool_call` rows are NOT the usage or tool-call source (those ride
  the `assistant` event), so nothing double-counts.
- **`run_shell_command` → `Bash` name map** (`_TOOL_NAME_MAP`) — a CORRECTNESS requirement, not
  cosmetics: `_scan_pr_line`'s PR attribution ([Qwen H]) and `_tool_use_detail`'s Bash card key on
  the tool_use `name` being `"Bash"`, and Qwen's shell tool registers as `run_shell_command` with
  `args.command`. Widen PR attribution only by teaching `_scan_pr_line` another creation event, never
  by loosening this map. Every other Qwen tool (`write_file`, `read_file`, `tool_search`, …) passes
  through under its own name (generic card).
- **Tool calls ride the `assistant` event's `message.parts` `functionCall` blocks** → one `tool_use`
  each; the redundant `ui_telemetry` `tool_call` row drops. Qwen flags reasoning as `{text,
  thought:true}` (NOT a block type) → `thinking`; plain `{text}` → text.
- **usage: Qwen's Gemini-shaped `usageMetadata` → Claude's DISJOINT counts** (`_map_usage`):
  `input = promptTokenCount − cachedContentTokenCount` (the two sum to the whole prompt like Claude's,
  clamped ≥0), `cache_read = cachedContentTokenCount`, `output = candidatesTokenCount` (which ALREADY
  includes `thoughtsTokenCount` — verified: prompt+candidates == total — so thoughts are NOT re-added,
  else the model's reasoning double-counts), `cache_creation = 0` (Qwen has none). A usage-less OR
  all-zero step projects NO `usage` key (never a fabricated zero — it poisons the per-model
  denominator; local-endpoint turns commonly report zero usage). `message.model` is the real model id.
- **Deterministic uuids** (uuid5 over session id + per-feed seq), so replaying the native log
  re-projects byte-identically without forking the file.
- **Verified against REAL Qwen output** ([Qwen G0]'s corpus, the G1 no-mock lesson): `qwen_corpus.json`
  (built by `qwen_corpus_gen.mjs` from `docs/qwen-g0/corpus/`), `qwen_projected.jsonl` and
  `qwen_expected_blocks.json` are the SAME artifacts the py test and the js `entryBlocks` test both
  assert against — pinning both readers to one expected result. Tests: `test_qwen_transcript.py`, the
  `Qwen projection` case in `tunnel-agent.test.js`.
