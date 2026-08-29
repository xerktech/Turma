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
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "turma/tests/board.test.js"
  - "glasses/src/vendor/board.cjs"
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
- **The safety guard is [Qwen F] (XERK-510), now SHIPPED and wired into `_qwen_settings`** —
  PreToolUse hooks + `permissions.deny` reusing the shared `guard.py`/`fileguard.py` deny policy
  (qwen's hook contract is Claude Code's, ported — G0 crit. 5). See the "[Qwen F]" section below.
  `approvalMode:"auto"` runs tools unattended, so a launcher WITHOUT the guard is unguarded — the
  load-bearing reason `QWEN_ENABLED` stays False, now liftable once [Qwen F] is host-verified.
  Permission-mode parity (Shift+Tab / setMode) is [Qwen P] (XERK-522).
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
    permission-mode work ([Qwen P]). **Pitfall: qwen draws a right-edge SCROLLBAR
    glyph (`█` + the block/vertical-bar family) on every line of a SCROLLED pane**
    (real capture `docs/qwen-g0/pane/03-tool-approval.txt`), so the question line
    ends in `█` not `?` and the "blank" separator lines strip to `█` not `""` —
    `parse_pane_prompt` strips that trailing column (`_PANE_SCROLLBAR_RE`) per line
    or a real approval dialog is missed. Pin pane parsers against the REAL captured
    frame, not a hand-cleaned copy (the cleaned copy hid this — a QA catch).
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
- **qwen's NATIVE log is archived by [Qwen E]** (XERK-512, below): the tail mirrors it under
  `<slug>/<sid>/qwen/`, so the native log rides the raw layer beside the projection. [Qwen C] itself
  ships without that mirror — only the PROJECTION (the top-level `<id>.jsonl`) archives here.
- Tests: `test_qwen_session.py` (tail: glob discovery, resume-at-EOF, incremental, title), `test_qwen_ask_mcp.py`
  (the MCP round-trip + the rendezvous-file shape), `TestQwenSessionArms` in `test_hub_agent.py`
  (busy markers, the `›` approval parse, digit+Enter, ask-MCP registration, the three naming tiers,
  teardown), the qwen busy cases in `tunnel-agent.test.js`. Real-qwen legs are host-proof only (qwen
  is not installed in CI) — the same footing [D]/[E]/[J] shipped on for dsh.

## [Qwen D] (XERK-511) shipped: busy / ready-for-review / summary semantics

The read-side of a qwen session's state — the dsh [D] (`.claude/rules/dsh.md`) analogue, but SIMPLER
because a qwen session has a REAL pane. The implementation already rode in on [Qwen C] (the pane-aware
liveness + the naming tiers); [Qwen D] is the read-side VERIFICATION that PINS these invariants:

- **`session_report` has NO qwen branch — a qwen session takes the CLAUDE pane path** (the `else` of
  the `agent_type == "dsh"` branch). paneBusy/modeActual/panePrompt come from `_pane_status`, NOT a
  socket cache (dsh needed the cache only because it was headless). `dsh_status` is ignored for a
  qwen session even if one is passed — the branch keys on exactly `"dsh"`. So `sessionWorking`,
  `liveState`, the readyForReview mirrors and the ready-for-review alert are UNCHANGED and CANNOT
  drift: the CLAUDE.md "Working = paneBusy OR live agents" contract holds verbatim for qwen (verified
  — `sessionWorking`/`readyForReview` in `server.js` read only the wire fields, no `agentType`).
- **Everything OTHER than liveness stays transcript-derived from the [Qwen S1] projection**:
  `lastRole`, `lastHasToolUse`, `transcriptAgeSec` and the PR scan read the projected
  `<claudeSessionId>.jsonl` with no change — which is what makes readyForReview's finished-turn
  branch work identically for a qwen session.
- **Naming override is scoped to the seeder's OWN provisional name** (`_seed_qwen_summary`): a
  `summaryManual` rename, or any non-provisional `summary` (a ticket session's `<key> <summary>`, a
  migrated name), is left ALONE — even when a native title or first prompt is available and no
  one-shot is spent — matching the Claude ticket-naming contract (`agent-board.md`). This is the same
  `if summaryManual: return` / `if current and not provisional: return` guard `_seed_dsh_summary`
  uses.
- Tests: `TestQwenLivenessInReport` in `test_hub_agent.py` (the pane path, dsh_status ignored,
  pane-sourced panePrompt, transcript-derived lastRole/lastHasToolUse — mirroring
  `TestDshLivenessInReport` but asserting `_pane_status` IS called), and the
  `test_seed_qwen_summary_never_clobbers_*` cases in `TestQwenSessionArms`.

## [Qwen E] (XERK-512) shipped: archive sync — projection (rendered) + native log (raw)

Retention, the qwen analogue of dsh [E] (XERK-469, `.claude/rules/dsh.md`). D3's obligation made
concrete for qwen: a qwen session archives BOTH layers with NO new archive code — only a store-dir
contract. The one difference from dsh is WHO writes the native log into the store.

- **The projection (`<slug>/<sid>.jsonl`) rides the RENDERED layer unchanged** — it is a top-level
  `*.jsonl` in the usage ledger's slug, enumerated by `_archive_manifest` like any transcript.
- **The native event log rides the RAW layer at `<slug>/<sid>/qwen/`** (`QWEN_STORE_DIRNAME`, a fixed
  `chat.jsonl`), which `_session_files` already walks as a raw sidecar — so `_archive_raw_deltas`
  ships it byte-for-byte with no special case, exactly as it does dsh's `<sid>/dsh/`.
- **The TAIL mirrors it, not the launcher** — the load-bearing reconciliation. A dsh session's driver
  writes its feed directly into `<sid>/dsh/`, but qwen owns its native log and writes it under its OWN
  home (`~/.qwen/projects/<slug>/chats/<id>.jsonl`), which the raw layer does not reach. So
  `QwenProjectionTail` — already reading that log off the beat to build the projection — copies its
  bytes into the store. The mirror is APPEND-ONLY and on its OWN cursor (the mirror file's size),
  independent of the projection cursor: the projection may start at EOF on resume to avoid doubling
  the transcript, but the mirror always copies the WHOLE native log, and a manager restart / adopt
  resumes the copy from the mirror's size — catching up every native byte written while the tail was
  dead (a superset of what the projection can safely re-read). A native log rewritten SHORTER than the
  mirror leaves the archived copy intact (the raw layer's shrunk-source rule).
- **Only the append-only event log rides raw** — any SQLite/index qwen rebuilds from the log must NOT
  be mirrored (the per-file cursor ships bytes past an offset, wrong for a page-mutating DB). The tail
  copies only the native `<id>.jsonl` stream.
- **A RUNNING qwen session is NOT un-excluded from the manifest** — unlike dsh. dsh un-excludes a live
  session so its in-dashboard Trajectory populates; qwen has a real ttyd TUI and NO Trajectory
  analogue, so its native log is retention/metrics only and archives once the session ENDS, like any
  Claude session. `_teardown_qwen` drops only the 0600 env file, never the store dir, so the retained
  log survives kill (it lives under `PROJECTS_ROOT`, not the worktree delete removes).
- **The native log is never double-counted in usage** — `<sid>/qwen/chat.jsonl` is neither a top-level
  `*.jsonl` nor under `subagents/`, so `_project_transcripts` skips it; the projection is the single
  counted copy. Do not teach the walk to read `<sid>/qwen/` (the same rule dsh's note draws).
- **No beat-loop budget regression** — the mirror runs on the tail's own daemon thread (never the
  beat, never raising), and archive sync stays on the sync worker (XERK-395). [Qwen E] adds no code to
  the beat or the archive functions, only the store-dir contract.
- Tests: `TestQwenArchiveSync` in `test_hub_agent.py` (manifest + both delta pushes over the real
  projector/corpus, mirroring `TestDshArchiveSync`) and the `test_mirror_*` cases in
  `test_qwen_session.py` (the tail's byte-for-byte copy, incremental append, resume-complete,
  restart catch-up, shorter-log-left-intact).

## [Qwen G] (XERK-513) shipped: usage aggregates + per-model attribution

D4's usage obligation for qwen, the dsh [G] (XERK-471) analogue — a qwen session's spend charts on
the Usage page and the dashboard token tiles IDENTICALLY to a Claude session, with no schema change
and no `agentType` branch in the aggregation, because [Qwen S1]'s projection already writes
`message.usage`/`message.model` in the shape the ledger reads. The full contract (why the token
aggregates + attribution ledger cost qwen nothing, why local/OpenAI-compat ids appear in the
per-model breakdown and may dominate, why the native log is never double-counted, and why the
subscription `limits`/probe/card stay Claude-only) lives in **`.claude/rules/agent-usage.md`**
("qwen sessions ride this half unchanged too"), whose `paths:` now loads for the qwen modules.

- **[Qwen G] added NO aggregation code.** The `_map_usage` all-zero-block hardening that dsh [G]
  needed was already folded into [Qwen S1] (`qwen_transcript.py`), so this ticket is the
  confirmation plus the end-to-end test.
- **The native log is never double-counted — including [Qwen E]'s raw mirror.** `_project_transcripts`
  counts only a slug's top-level `*.jsonl` (the projection) plus `subagents/**`. qwen's native log
  sits in neither place a usage walk reads: not in qwen's own home (`~/.qwen/projects/…`), and not in
  [Qwen E]'s raw archive mirror at `<slug>/<sid>/qwen/chat.jsonl` (a raw sidecar, like dsh's
  `<sid>/dsh/`). So the projection is the single counted copy — do not teach the walk to read
  `<sid>/qwen/`.
- Tests: `TestQwenUsageReportEndToEnd` (mirrors `TestDshUsageReportEndToEnd`) drives the REAL
  projector's output through `repo_usage_report`/`_aggregate_project` on disk, proving host + per-repo
  totals and the local/OpenAI-compat per-model breakdown; `TestQwenProjectionAccounting`/
  `TestQwenUsageMapping` cover the layer below. All in `test_qwen_transcript.py`.

## [Qwen F] (XERK-510) shipped: safety guard (PreToolUse shim + permissions.deny)

The dsh [F] discipline (`.claude/rules/dsh-guard.md`) applied to qwen — but qwen's PreToolUse-hook
model IS Claude's (G0 crit. 5), so it reuses the shared deny policy even more directly. The deny
POLICY is NOT duplicated: destructive/policy/attribution shell classification (`guard.py`) and the
"everything under ~/.claude except the two memory trees" predicate (`fileguard.py`) have ONE home,
shelled out to `python3 -SsE <hook>` exactly as Claude and dsh do. Invariants a change must not undo:

- **The one mismatch qwen adds is TOOL NAMES, so a thin SHIM bridges it** (`agent/qwen/guard/shim.py`).
  `guard.py` keys on `tool_name=="Bash"` and `fileguard.py` on `Write|Edit|…`; a qwen
  `run_shell_command`/`write_file` sails past both. The shim classifies a qwen tool (shell/write/read,
  the qwen twin of the dsh guard's `classify`), shells out to the SHARED hooks with the Claude tool
  shape they expect, AND matches the flat credential/config/runtime-code globs itself (realpath'd, so
  a symlink/`..` cannot dodge them). **The shim is the enforcement; it does NOT re-implement the deny
  policy** — only routing + the flat globs, exactly what the dsh guard already reimplements natively.
- **`build_qwen_guard_config()` reads the SAME rule set `build_guard_settings()` produces** (parsed
  with `_parse_perm_rule`, as the dsh builder does) and emits (a) the `hooks.PreToolUse` wiring and
  (b) the shim's data config (`~/.turma/qwen-guard.json`: hook paths + denyWrite/denyRead/allowRead).
  **Adding a store to `_GUARD_DENY_PATH_RULES` covers all three runtimes with NO qwen change** — the
  ticket's shared-list contract, pinned by `test_shim_config_is_the_shared_rule_set`. Built + written
  at the launch choke point (`_qwen_guard_config`, memoized like `_ensure_guard_settings`; primed
  off-beat by `_prime_qwen`, XERK-395), merged into `.qwen/settings.json` by `_qwen_settings`.
- **It FAILS CLOSED.** `guard.py`/`fileguard.py` fail OPEN on a malformed payload because Claude keeps
  `permissions.deny` as a backstop; qwen has none the shim can rely on, so the shim DENIES (deny JSON
  on stdout AND exit 2) on: an unreadable config, a hook it cannot spawn / that crashes (nonzero
  exit) / times out / returns unreadable output, a SHELL call with no configured guard script, an
  unparseable tool payload, or any unexpected error in the shim. A missing FILEGUARD degrades to the
  write-deny globs (defence in depth, like dsh), not a fail-closed — the globs still name the
  catastrophic ~/.claude subset. **G0 GOTCHA baked in: qwen's hook `timeout` is MILLISECONDS** — a
  too-small value silently disables the guard, so `QWEN_GUARD_HOOK_TIMEOUT_MS` (15000) comfortably
  exceeds the shim's own nested-subprocess budget (`QWEN_SHIM_HOOK_TIMEOUT_MS`, 5000).
- **Approval mode stays `auto` (NOT `yolo`, NOT `default`)** — the ticket's "not auto-yolo, not
  auto-reject". `default` would HANG on every tool-approval prompt (nothing auto-answers them until
  [Qwen P]); `yolo` risks skipping hooks. `auto` is the Claude `--permission-mode auto` analogue:
  hands-off, hooks fire. **LOAD-BEARING HOST-PROOF: G0 proved the deny hook fires under `default`;
  that it also fires under `auto` (the mode the launcher runs) is UNVERIFIED and is THE gate before
  `QWEN_ENABLED` is flipped.** If `auto` skips hooks on a real host, qwen must not be enabled until
  the mode question is resolved.
- **`permissions.deny` is UNVERIFIED defence in depth** — the G0 spike catalogued qwen's settings
  keys and found no `permissions` block, so whether qwen honours one is unknown; it is emitted
  (ticket-required, the Claude backstop analogue) but the shim does NOT depend on it, and if a real
  qwen REJECTS the unknown key the fix is a one-line removal (`_confirm_qwen_launch` catches a launch
  break). Host-proof, like the [Qwen C] `mcpServers` key.
- **The credential env file is read-denied** (`Read(~/.turma/qwen/*.env)`, holds `OPENAI_API_KEY`) —
  ticket point 5, defence in depth: 0600 already stops other uids and the session runs as the owning
  uid, so this only stops a casual read via the file-editing tools (Bash walks past it, XERK-309).
- **Residual gaps (stated, not papered over):**
  - **An unknown mutating tool NAME is ungated** (the qwen twin of dsh's ungated `cordis_run`/`ralph`):
    the shim only sees the tools the matcher lists (`_QWEN_GUARDED_TOOLS`) and classifies the rest as
    `other`→allow. Worse than dsh here — dsh pins `sandbox: workspace-write` (landlock) as the fs
    backstop, but qwen's `--sandbox` needs docker/podman (absent on native hosts), so there is NO fs
    confinement backstop. Widening the tool list, not a sandbox, is the honest fix if qwen grows a
    new fs tool.
  - **`_realpath_glob_prefix`** (XERK-503) resolves symlinks in each glob's literal prefix — a
    symlinked HOME *subdirectory* (`~/.aws` a bind mount, or WSL's Windows-side profile) no longer
    dodges its deny, matching how `fileguard.py` realpaths its `~/.claude` base. **Still open: a
    credential FILE itself symlinked** (`~/.kube/config` elsewhere, `~/.kube` real) — nothing to
    realpath in the prefix. Needs a nominal-path check ALONGSIDE realpath, in qwen/dsh/fileguard alike.
  - **The shim RE-READS `~/.turma/qwen-guard.json` every call, and a Bash redirect walks past its
    Edit-deny** (XERK-309) — so a `run_shell_command` that overwrites it could repoint `guardScript`
    and self-bypass. This is NOT net-new: `guard.py` equally allows `echo > guard.py` for the Claude
    guard (the guard defends against the MODEL, not a hostile same-uid shell), and deriving the
    script paths from the shim's own location does not close it either (Bash can overwrite guard.py
    directly). It is a weaker backstop than guard-settings.json's, which claude reads once at launch
    (restart-repairable) — the deny-rule comment in `_GUARD_DENY_PATH_RULES` states this.
- Tests: `test_qwen_guard.py` — `TestBuildQwenGuardConfig` pins the config (hook wiring, the
  ms-timeout ordering, the shared-rule-set derivation, the credential read-deny, no-ListAgents,
  missing-fileguard degrade) and `TestQwenGuardShimEndToEnd` drives the REAL shim over the REAL
  guard.py/fileguard.py with hostile inputs (destructive/policy/attribution shell, credential+
  ~/.claude writes, credential reads vs the uploads/roster carve-outs, symlink escape, and every
  fail-closed path). The `permissions.deny`-honoured and `auto`-fires-hooks legs are host-proof only.

## [Qwen H] (XERK-514) shipped: PR/MR chips, ledgers & attribution

D4's "PR chips work with no new code" for qwen, the dsh [H] (XERK-472) analogue — a qwen session that
opens a PR gets the same chips, ledgers, attribution and comment/conflict delivery as a Claude one,
with NO `agentType` branch on the PR path. The symmetry is [Qwen S1]'s: the projection needs no new
reader, so the whole PR web reads a qwen transcript unchanged. **[Qwen H] added NO PR code** — it is
verification plus the mirror test. The mechanics live in `.claude/rules/agent-prs.md` ("qwen
sessions" section); the invariants a change must not undo:

- **The load-bearing dependency is [Qwen S1]'s `run_shell_command`->`Bash` name map**: `_scan_pr_line`
  attributes only a `Bash` tool_use, and qwen's shell tool registers as `run_shell_command`, so the
  map is what makes `gh pr create` chip. Same narrowness as Claude/dsh (a PR opened via
  `cordis_run`/`ralph` or the raw GitLab API gets none). **Widen only by teaching `_scan_pr_line`
  another creation event, never by loosening the Bash-name gate.**
- **Comment/conflict nudges route through `notify_session` → the PANE — the ONE difference from dsh
  [H].** dsh is headless and nudges over its control socket (`_dsh_notify`); a qwen session is an
  interactive TUI that writes no `~/.claude/sessions/<pid>.json`, so `notify_session` finds no inbox
  and falls back to `send_input`'s pane path exactly as a Claude session with no inbox does. Neither
  `send_input` nor `notify_session` carries a qwen arm ([Qwen C]) — never add one. `refresh_pr_status`
  stays the same inline offender for ALL runtimes (XERK-397's scope, not widened here).
- **Chips survive a qwen resume/migration** via `_seed_prs` over the projected `<tid>.jsonl` (the
  top-level transcript migration packs), independent of the raw native-log sidecar `<tid>/qwen/`
  ([Qwen E]).
- Tests: `TestQwenPrAttribution` in `test_hub_agent.py` drives the REAL qwen projector over
  `agent/tests/qwen_pr_corpus.json` — a corpus carrying a `gh pr create`, cloned from the captured
  Qwen 0.22.2 event SHAPES (`qwen_pr_corpus_gen.mjs`) because [Qwen G0]'s two real sessions had their
  shell tool guard-denied and so carry no successful shell run. It proves attribution, the live
  per-beat scan, `_seed_prs` + the durable ledger, `refresh_pr_status` + GitLab/ADO dispatch, and the
  PANE-delivered comment/conflict nudges — the G1 no-mock lesson, mirroring `TestDshPrAttribution`.

## [Qwen I] (XERK-515) shipped: board integration — a ticket can run on qwen

A board ticket can be pinned to the qwen runtime, the dsh [I] (XERK-473) analogue — the runtime
choice is presentational plumbing over the SAME `spawnTicket` path (the `ticketRuntimes` pin now
accepts `"qwen"`), so the AGENT side is unchanged (`spawn_ticket` already forwards `agentType` to
`spawn()`, `resolve_agent_type` already validates qwen, `_launch_qwen` already appends the
ticket-branch directive — no new launch code). The mechanics — the `/runtime` route + `orgOffersQwen`
gate, the per-runtime `findTicketHost` capability filter, the board `qwenAvailable`/picker, and the
Android parity — live in **`.claude/rules/turma-board.md`**'s Runtime-row section (board-scoped,
where the dsh [I] board detail's twin belongs), whose `paths:` load for the board files this touched.

## [Qwen J] (XERK-517) shipped: background-agent rows + subagentHistory

Delegation lives in **`.claude/rules/qwen-delegation.md`**. qwen's `Agent` launch reshapes to
`Agent`/`async_launched`/`<task-notification>` — readers/usage/archive/migration unchanged.

## [Qwen K] (XERK-516) shipped: session migration + resume

Session migration + resume for a qwen session (the dsh [K] analogue) lives in
**`.claude/rules/qwen-migration.md`** — split out to keep this file under its size ceiling; its
`paths:` include `hub-agent.py`, so it co-loads with this file when the migration code is touched.
The load-bearing point: qwen is Claude-shaped, so its NATIVE LOG *is* the store `qwen --resume`
reloads from (no separate store like dsh's `DSH_SESSIONS_ROOT`) — a migration carries that log under
`.qwen-store/`, places it at the target cwd's slug and re-keys its per-row `cwd`.

## [Qwen P] (XERK-522) shipped: permission-mode parity

No mode name in qwen's footer → `_set_mode_blind`. Tests: `test_qwen_footer_returns_none`.
