---
paths:
  - "agent/hub-agent.py"
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
