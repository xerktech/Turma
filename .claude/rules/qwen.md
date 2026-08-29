---
paths:
  - "agent/hub-agent.py"
  - "agent/qwen_transcript.py"
  - "agent/qwen_session.py"
  - "agent/qwen/**"
  - "agent/tunnel-agent.js"
  - "agent/tests/test_qwen_transcript.py"
  - "agent/tests/test_qwen_session.py"
  - "agent/tests/test_qwen_ask_mcp.py"
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

## [Qwen C] (XERK-509) shipped: input, liveness, HITL, and session naming (pane-driven)

The drive/read layer over [Qwen B]'s launcher. A qwen session is an interactive TUI in tmux (the
Claude-shaped runtime, NOT dsh-headless), so — unlike dsh's [C] — input, liveness, tool-approval and
answers all ride the real PANE (hub-agent's existing parsers, made qwen-aware); there is NO control
socket. The ONE net-new module is the projection tail. Invariants a change must not undo:

- **Input & PR-nudge delivery are FREE — a qwen session uses the CLAUDE pane path unchanged.**
  `send_input`/`notify_session` add NO qwen arm (only dsh has one): `send_input` types into the qwen
  TUI via `_type_into_pane` (reusing `INPUT_MAX_CHARS`/`_store_uploads`), and `notify_session` finds
  no Claude inbox (qwen writes no `~/.claude/sessions/<pid>.json`) so it falls back to the pane. The
  `pendingInputs` compaction outbox is harmless (the projection carries no `compact_boundary`, so
  `_pending_scan` never resends). Never add a dsh-style qwen arm to these.
- **Liveness reuses the SAME `paneBusy` wire field, so sessionWorking/readyForReview's five mirrors
  are UNCHANGED** (do NOT add a qwen liveness signal to the mirrors). Qwen's busy hint differs from
  Claude's "esc to interrupt": while a turn runs the footer gains "Enter to steer · Ctrl+Q to queue"
  and the spinner ends "(… · esc to cancel)". Both ride `QWEN_PANE_BUSY_MARKERS`, UNIONED into
  `_busy_from_capture` (and tunnel-agent's `paneShowsBusy`) — qwen-agnostic strings needing no
  agentType, checked ahead of the operator-overridable `PANE_BUSY_MARKERS`. **The spinner token keeps
  its CLOSING PAREN (`esc to cancel)`)**: Claude's OWN permission-dialog footer says "Esc to cancel ·
  Tab to amend" (no paren) and must still read blocked/idle — dropping the paren makes every Claude
  approval read busy (a regression a test pins).
- **HITL is TWO inputs, both to full parity, KEPT not degraded** (Malcolm):
  - **(1) A tool-APPROVAL prompt is the panePrompt analogue.** `parse_pane_prompt` accepts qwen's
    cursor glyph `›` beside Claude's `❯`, and treats qwen's composer footer (`QWEN_PANE_FOOTER_RE`,
    "Ask permissions (shift + tab to cycle)") like Claude's mode footer — its presence below a
    numbered run means "not a dialog". `answer_pane_prompt` types the digit AND **Enter for a qwen
    session** (G0: `1`+Enter; Claude submits on the digit alone). Under the launcher's
    `approvalMode:"auto"` these prompts are largely suppressed; the parser is parity + future
    permission-mode work ([Qwen P]).
  - **(2) A STRUCTURED question renders the SAME multi-select card a Claude session shows** — NOT a
    yes/no approval. Qwen has NO native AskUserQuestion tool (G0), so `_qwen_settings` REGISTERS one
    via MCP: `mcpServers."turma-ask"` runs `python3 -SsE agent/qwen/ask_mcp.py`, a stdlib stdio
    JSON-RPC server exposing `ask_user_question({question, options[], multiSelect, header?})`. On a
    call it writes the EXACT `QUESTIONS_DIR/<sid>.req.json` shape `ask.py`/`_hook_question` use and
    BLOCKS for `<sid>.ans.json` — so the EXISTING `answer_question` path (the else-branch, dropping
    the .ans.json) answers it with **NO client change**. The session id / rendezvous dir / block
    timeout ride the server's own `env` block. `QWEN_QUESTION_BLOCK_TIMEOUT_SEC` (600) stays under
    `QUESTION_STALE_AFTER_SEC` so a still-blocking question isn't stale-dropped from the beat.
  - **Residual gap (host-proof only): the `mcpServers` settings key and that qwen surfaces an MCP
    tool to its deferred-tool model are UNVERIFIED** — qwen is not installed in CI. Unit-tested via
    the server's JSON-RPC contract (`test_qwen_ask_mcp.py`); confirm end-to-end on a real qwen host.
- **Session naming is generated by QWEN and ITS model, NEVER `claude -p`** (Malcolm) — a pure-qwen
  host may have no Claude login, so naming must not depend on one. `_start_summary` REFUSES a qwen
  session (as it does dsh). `_seed_qwen_summary` names in three tiers, weakest first, a later one
  overriding an earlier (before the `_summary_due` gate, like dsh):
  - Tier 1 — qwen's OWN generated title, captured by the tail's `title()`. **G0 found NO native title
    mechanism, so this is DORMANT**; a future qwen that writes one is honoured with no code change.
  - Tier 2 — a `qwen -p` ONE-SHOT (`_start_qwen_summary`) over the session's OWN OpenAI-compatible
    endpoint (the qwen `-p` analogue of `claude -p`), reusing `self.summaries`/`_poll_summaries`/
    `_finish_summary`. The endpoint key rides the subprocess ENV, never argv; `--safe-mode` + cwd
    `REGISTRY_DIR` keep it a clean, unguarded, repo-untouching title call. `_finish_summary` clears
    `summaryProvisional` when a name lands, finalizing over tier 3.
  - Tier 3 — the first user prompt, PROVISIONAL, applied at once so the card is never blank while the
    one-shot runs. Gated so tier 2 launches even after tier 3 sets a provisional name (`_summary_due`
    stops once `summary` is set, so the tier-2 launch checks the attempt/backoff budget directly).
- **The projection tail is the one net-new module (`agent/qwen_session.py`).** `QwenProjectionTail`
  reads qwen's native log (`~/.qwen/projects/<slug>/chats/<id>.jsonl`) through `QwenProjector` ([S1])
  and appends the Claude-JSONL projection to the pinned `<claudeSessionId>.jsonl`, incrementally, off
  the beat, never raising. **It LOCATES the native log by GLOB (`<id>.jsonl` across project dirs), not
  a computed slug** — the same discipline `_qwen_runtime_file` uses, load-bearing because the
  cwd→slug rule is uncertain (G0 recorded `/`→`-`; Claude's own rule is every non-alnum→`-`). Resume
  starts at the native log's EOF (qwen `--resume` appends in place). Wired in `_launch_qwen`
  (`_start_qwen_tail`), reattached on the resume-on-boot ADOPT path (the tail died with the manager
  while the TUI kept appending), and stopped in `_forget_session_caches`/`_teardown_qwen`.
- **Known gap: qwen's NATIVE log is not archived.** It lives under `~/.qwen/projects/`, outside the
  Claude `<tid>/` tree the raw archive walks, so only the PROJECTION (the top-level `<id>.jsonl`)
  archives — unlike dsh's `<tid>/dsh/` native log. Metrics-from-native-log is out of [Qwen C]'s scope.
- Tests: `test_qwen_session.py` (tail: glob discovery, resume-at-EOF, incremental, title), `test_qwen_ask_mcp.py`
  (the MCP round-trip + the rendezvous-file shape), `TestQwenSessionArms` in `test_hub_agent.py`
  (busy markers, the `›` approval parse, digit+Enter, ask-MCP registration, the three naming tiers,
  teardown), the qwen busy cases in `tunnel-agent.test.js`. Real-qwen legs are host-proof only (qwen
  is not installed in CI) — the same footing [D]/[E]/[J] shipped on for dsh.
