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
  (Android) — so no single component can re-enable qwen alone. It ships **False**; with it off,
  `resolve_agent_type` refuses every `agentType="qwen"` spawn before any record carries one, so
  `_launch_qwen` is unreachable in production. It stays False through [Qwen B] (the launcher) on
  purpose: enabling qwen fleet-wide is only safe once the **SAFETY GUARD ([Qwen F], XERK-510)** and
  the **transcript projection ([Qwen S1], XERK-508)** land — a launcher alone would run an UNGUARDED
  runtime whose chat surface is blank (no `<id>.jsonl` under `~/.claude` until the projector writes
  one). Flip it True in all three components (and set `TURMA_QWEN`) at that milestone, NOT when the
  launcher alone lands; tests patch it True (or patch `qwen_configured` directly).
- **`_launch_tmux` is the single launch choke point; its runtime dispatch gains a qwen arm**:
  `if sess.agentType == "qwen": self._launch_qwen(sess); return`. The dispatch line and choke point
  stay — do not hoist it to the callers. Because `resolve_agent_type` re-gates on `_launch_tmux`'s
  side and QWEN_ENABLED is off, `_launch_qwen` cannot be reached in production today.

## [Qwen B] (XERK-507) shipped: the interactive-TUI launcher

`_launch_qwen` replaces [A]'s raising stub. Qwen is an interactive TUI (the Claude-shaped runtime,
NOT dsh-headless), so the launcher is deliberately CLOSE to `_launch_tmux`, not the dsh driver. What
landed, and the invariants a later child must not undo:

- **qwen gets its OWN ttyd terminal — ttyd is NOT suppressed** (unlike dsh, XERK-498). `_launch_ttyd`
  early-returns only on `agentType=="dsh"`, so a qwen session's caller serves ttyd exactly as for a
  Claude session and the chat header keeps "Terminal ▸". A qwen session is driven and observed
  through its real TUI pane, so it needs no Trajectory/`dsh web` analogue.
- **The pinned id NAMES qwen's native transcript** (`qwen --session-id <uuid4>` fresh /
  `--resume <id>` in place — the same `<id>.jsonl`, verified in the G0 spike). Persisted as
  `claudeSessionId` like every other launch; `_remember_ticket` runs here as it does for claude/dsh.
- **The model route is an OpenAI-compatible endpoint SOURCED from a 0600 env file**
  (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` + `--auth-type openai`), never argv and never
  `tmux -e` — `/proc/<pid>/cmdline` is world-readable, the local-model-credential discipline. qwen
  has NO Claude-style subscription failover: this route is the WHOLE model story (like dsh's D5).
  `QWEN_MODEL*` default to the failover's `LOCAL_MODEL_*` so a host already wired for a local
  endpoint needs only `TURMA_QWEN=1`. The API key rides an ENV VAR NAME (`QWEN_MODEL_API_KEY_ENV`).
- **The new-work / ticket-branch / peers directive rides qwen's CONTEXT file, not
  `--append-system-prompt`** (qwen has none). `_write_qwen_worktree_config` writes the SAME directive
  text (`NEW_WORK_SYSTEM_PROMPT` + `TICKET_BRANCH_PROMPT` + `PEERS_SYSTEM_PROMPT`) to a
  TURMA-SPECIFIC context file (`QWEN_CONTEXT_FILENAME`, default `TURMA_QWEN_CONTEXT.md` — NOT the
  conventional `QWEN.md`, so it can never clobber a repo's OWN tracked `QWEN.md`; and NOT dot-prefixed,
  since some loaders skip hidden files and the G0 spike proved a plain name). `context.fileName`
  points qwen at it; the project's own `QWEN.md` is then not auto-loaded (accepted trade). The initial
  prompt is delivered race-free via `-i`/`--prompt-interactive` (run-then-stay-interactive — the
  claude positional-prompt analogue), not send-keys (that drive layer is [Qwen C]).
- **The per-worktree config (`.qwen/settings.json` + the context file) is git-EXCLUDED** (the repo's
  COMMON `info/exclude`, shared by every worktree — `git rev-parse --git-path info/exclude`) so it
  never reads as uncommitted work (prune/delete key on `git status`) nor gets committed by the
  session; it is regenerated on every launch. settings pin `chatRecording:true`
  (REQUIRED for the on-disk transcript + resume), `disableAutoUpdate` (a pinned fleet must not let
  the binary drift under the parsers — the G0 auto-update trap), `folderTrust:false`, and
  `approvalMode:"auto"` + `autoAccept:true` (hands-off, the claude `--permission-mode auto` analogue).
- **The safety guard is NOT wired here — that is [Qwen F] (XERK-510)**, PreToolUse hooks +
  `permissions.deny` reusing the shared `guard.py`/`fileguard.py` deny policy (qwen's hook contract
  is Claude Code's, ported — G0 crit. 5). `approvalMode:"auto"` runs tools unattended, so a launcher
  WITHOUT [Qwen F] is unguarded — which is the load-bearing reason `QWEN_ENABLED` stays False past
  [Qwen B]. Permission-mode parity (Shift+Tab / setMode) is [Qwen P] (XERK-522).
- **Config readiness is primed OFF THE BEAT** (`_ensure_qwen_ready` on a worker at startup when
  `qwen_configured()`): a `qwen --version` probe + model-route validation, cached on `_qwen_ready`.
  `_launch_qwen` only READS the cached flag and refuses if unset — it never runs the probe on the
  beat (XERK-395), exactly as `_launch_dsh` reads `_dsh_profile_ready` without running the setup.
- **Launch is CONFIRMED before the session is recorded** (`_confirm_qwen_launch`, the XERK-492 "a
  bound thing is not a live thing" lesson): a started tmux is not proof qwen came up. It waits for
  qwen's live-registry `<id>.runtime.json` to appear with a LIVE pid (found by the pinned id across
  project dirs, so the exact cwd→slug rule is not depended on), failing fast if the tmux process is
  gone. A resume reuses the id, so the PREVIOUS launch's registry (a dead pid) lingers — checking
  the pid is live is what stops a stale file confirming a not-yet-up session. A failed confirm tears
  down and RAISES, routing through the caller's `_set_error`/`_refuse_start` (XERK-265) with a reason.
- **The chat/summary/history/PR surfaces stay blank for a qwen session until [Qwen S1]** (XERK-508):
  they read `~/.claude/projects/<slug>/<id>.jsonl`, but qwen writes its native log under
  `~/.qwen/projects/`. The launcher does NOT read qwen's native transcript; the projection into
  Claude JSONL is [S1]. The TERMINAL (ttyd) is fully live meanwhile. Liveness/naming ([D]/[C]) and
  the guard ([F]) are the other children between here and a fleet-enable.
- Tests: `TestLaunchQwen` in `test_hub_agent.py` (readiness gate, the launch wiring — pinned id,
  0600 env file with no credential on the command line, settings/context-file content, `-i` initial
  prompt, `--resume` in place, the teardown-on-failed-confirm — and `_confirm_qwen_launch`).
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
