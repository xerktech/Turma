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

# Qwen Code runtime — invariants (XERK-504)

Qwen Code is a per-session runtime alongside Claude Code and dsh. Its process model is
**Claude-shaped, not dsh-headless**: pinned session id, native JSONL on disk, tmux pane injection,
`capture-pane` state parsing, a PreToolUse hard-deny guard.

**Background, the G0 findings, the host-unverified surfaces and accepted gaps are in
`docs/qwen-adr.md`** — read it for *why*; this file is the rules. It inherits dsh's D1-D5 decisions
wholesale (`docs/dsh-adr.md`), so each section below is the dsh analogue its ticket names; where qwen
diverges it is because the TUI process model differs, never because a decision was revisited.

## [Qwen A] (XERK-506) runtime field + capability flag + composer option

- **`agentType` gains `"qwen"`** — the enum is `{"claude","dsh","qwen"}` (`AGENT_TYPES`), default
  `"claude"`, validated at spawn (`resolve_agent_type`) and carried on every record-rebuild path plus
  `_session_payload` (they pass it through as a string, so the enum entry is all they needed). An
  agent predating it reports nothing; the hub coerces to `""` in `normalizeRecord`, reading as claude.
- **`qwen` is the heartbeat capability block `{available}`**, backed by `qwen_configured()` (env gate
  `TURMA_QWEN`, OFF by default), coerced strict-boolean by `normalizeQwen` (a `HEARTBEAT_KNOWN_KEYS`
  member), typed on Android (`AgentInfo.qwen: QwenInfo?`). Absent/false = "this host cannot do qwen",
  so the composer HIDES the option; both spawn routes 409 a `qwen` choice at a host with no
  capability (`checkSpawnAgentType`) and the agent re-validates.
  - **It carries NO qwen model plumbing** — `{available}` alone, unlike dsh's
    `{available,models,defaultModel,contextTokens}`. Do not widen
    `_qwen_payload`/`normalizeQwen`/`QwenInfo` here.
- **`QWEN_ENABLED` is an in-CODE fleet-wide kill switch**, the qwen twin of `DSH_ENABLED`: it gates
  `qwen_configured()` (agent),
  `qwenAvailable`/`normalizeQwen` (hub) and `Runtime.QWEN_ENABLED` (Android), so no single component
  can re-enable qwen alone. It ships **False**; with it off `resolve_agent_type` refuses every
  `agentType="qwen"` spawn, so `_launch_qwen` is unreachable in production. Flip it True in all three
  components (and set `TURMA_QWEN`) only once the guard is host-verified — see `docs/qwen-adr.md`.
  Tests patch it True (or patch `qwen_configured` directly).
- **`_launch_tmux` is the single launch choke point; its runtime dispatch gains a qwen arm.** Do not
  hoist it to the callers.
- **Composer only, no card badge**: the Runtime `<select>` gains "Qwen Code" gated on
  `a.qwen.available`, sending `agentType:"qwen"` and — since there is no qwen model/permission UI —
  no model, modelSource or permissionMode (it hides both rows). Android mirrors just that composer
  row. There is no qwen runtime chip on the session card.
- Tests: `TestSpawnOptionHelpers` (`test_resolve_agent_type_qwen_gate`) agent-side; the
  `normalizeQwen`/`QWEN_ENABLED`/spawn-route/known-key
  cases in `server.test.js`; the qwen composer case in `sessions.test.js`;
  `RuntimeTest`/`SpawnRequestTest`/`SpawnComposerTest`/`AgentDecodeTest` (android).

## [Qwen B] (XERK-507) the interactive-TUI launcher

Deliberately CLOSE to `_launch_tmux`, not the dsh driver.

- **qwen gets its OWN ttyd terminal — ttyd is NOT suppressed** (unlike dsh). `_launch_ttyd`
  early-returns only on `agentType=="dsh"`, so a qwen session serves ttyd exactly as Claude does and
  the chat header keeps "Terminal ▸". It is driven and observed through its real TUI pane, so it needs
  no Trajectory analogue.
- **The pinned id NAMES qwen's native transcript** (`qwen --session-id <uuid4>` fresh / `--resume
  <id>` in place — the same `<id>.jsonl`). Persisted as `claudeSessionId`; `_remember_ticket` runs
  here as for claude/dsh.
- **The model route is an OpenAI-compatible endpoint SOURCED from a 0600 env file**
  (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` + `--auth-type openai`), **never argv and never
  `tmux -e`** — `/proc/<pid>/cmdline` is world-readable. qwen has NO Claude-style subscription
  failover: this route is the whole model story. `QWEN_MODEL*` default to `LOCAL_MODEL_*` so a host
  already wired for a local endpoint needs only `TURMA_QWEN=1`. The key rides an ENV VAR NAME
  (`QWEN_MODEL_API_KEY_ENV`).
- **The new-work / ticket-branch / peers directive rides qwen's CONTEXT file, not
  `--append-system-prompt`** (qwen has none). `_write_qwen_worktree_config` writes the same directive
  text to `QWEN_CONTEXT_FILENAME` (default `TURMA_QWEN_CONTEXT.md` — **NOT** the conventional
  `QWEN.md`, so it can never clobber a repo's own tracked one, and **not dot-prefixed**, since some
  loaders skip hidden files). The initial prompt is delivered race-free via `-i`/`--prompt-interactive`
  (run-then-stay-interactive), not send-keys (that drive layer is [Qwen C]).
- **The per-worktree config (`.qwen/settings.json` + the context file) is git-EXCLUDED** via the
  repo's COMMON `info/exclude` (shared by every worktree) so it never reads as uncommitted work
  (prune/delete key on `git status`) nor gets committed; it is regenerated every launch. Settings pin
  `chatRecording:true` (REQUIRED for the on-disk transcript + resume), `disableAutoUpdate` (a pinned
  fleet must not let the binary drift under the parsers), `folderTrust:false`, and
  `approvalMode:"auto"` + `autoAccept:true` (hands-off, the `--permission-mode auto` analogue).
- **The safety guard ([Qwen F]) is wired into `_qwen_settings`.** `approvalMode:"auto"` runs tools
  unattended, so a launcher WITHOUT the guard is unguarded — the load-bearing reason `QWEN_ENABLED`
  stays False.
- **Config readiness is primed OFF THE BEAT** (`_ensure_qwen_ready` on a worker at startup): a `qwen
  --version` probe + model-route validation cached on `_qwen_ready`. `_launch_qwen` only READS the
  cached flag and refuses if unset — never the probe on the beat (XERK-395).
- **Launch is CONFIRMED before the session is recorded** (`_confirm_qwen_launch`) — a started tmux is
  not proof qwen came up. It waits for qwen's live-registry `<id>.runtime.json` with a LIVE pid (found
  by GLOB across project dirs, so the cwd→slug rule is not depended on), failing fast if the tmux
  process is gone. **A resume reuses the id, so the previous launch's registry lingers with a dead
  pid — checking the pid is live is what stops a stale file confirming a not-yet-up session.** A
  failed confirm tears down and RAISES, routing through `_set_error`/`_refuse_start` (XERK-265).
- **The rebuild/resume guard is per-runtime, not dsh-only** (`agent_type_configured`): a persisted
  `"qwen"` re-gates on `qwen_configured()` and `"dsh"` on `dsh_configured()`, so a qwen session
  resumes/migrates onto a qwen-only host.
- Tests: `TestLaunchQwen` (readiness gate, pinned id, 0600 env file with no credential on the command
  line, settings/context-file content, `-i` initial prompt, `--resume` in place, teardown-on-failed-
  confirm, `_confirm_qwen_launch`).

## [Qwen S1] (XERK-508) the projection (`agent/qwen_transcript.py`)

`QwenProjector.feed(event)` projects one Qwen native-log event into the 0+ Claude-JSONL entry dicts it
maps to; `project_log()` is the batch form. Pure, stdlib-only, its own file. The launcher's tail
appends to the pinned `<claudeSessionId>.jsonl`, and the EXISTING readers consume it UNCHANGED — **NO
new reader, NO JS translator.** The py/js parity IS that the projected JSONL renders identically
under both.

- **Only the three Qwen SURFACE types project**: `user`, `assistant`, `tool_result`. Every `system`
  event (attribution/file-history/`ui_telemetry`/slash-command) is log-only → `[]`. The `ui_telemetry`
  `api_response`/`tool_call` rows are NOT the usage or tool-call source (those ride `assistant`), so
  nothing double-counts.
- **`run_shell_command` → `Bash` name map** (`_TOOL_NAME_MAP`) — a CORRECTNESS requirement, not
  cosmetics: `_scan_pr_line`'s PR attribution and `_tool_use_detail`'s Bash card key on the tool_use
  `name` being `"Bash"`, and Qwen's shell tool registers as `run_shell_command` with `args.command`.
  **Widen PR attribution only by teaching `_scan_pr_line` another creation event, never by loosening
  this map.** Every other Qwen tool passes through under its own name (generic card).
- **Tool calls ride the `assistant` event's `message.parts` `functionCall` blocks** → one `tool_use`
  each; the redundant `ui_telemetry` `tool_call` row drops. Qwen flags reasoning as `{text,
  thought:true}` (NOT a block type) → `thinking`; plain `{text}` → text.
- **usage: Qwen's Gemini-shaped `usageMetadata` → Claude's DISJOINT counts** (`_map_usage`): `input =
  promptTokenCount − cachedContentTokenCount` (the two sum to the whole prompt like Claude's, clamped
  ≥0), `cache_read = cachedContentTokenCount`, `output = candidatesTokenCount` (which ALREADY includes
  `thoughtsTokenCount` — verified: prompt+candidates == total — so thoughts are NOT re-added, else the
  model's reasoning double-counts), `cache_creation = 0` (Qwen has none). A usage-less OR all-zero step
  projects NO `usage` key — never a fabricated zero, which poisons the per-model denominator
  (local-endpoint turns commonly report zero usage). `message.model` is the real model id.
- **Deterministic uuids** (uuid5 over session id + per-feed seq), so replaying the native log
  re-projects byte-identically without forking the file.
- **Verified against REAL Qwen output** (the no-mock lesson): `qwen_corpus.json` (built by
  `qwen_corpus_gen.mjs` from `docs/qwen-g0/corpus/`), `qwen_projected.jsonl` and
  `qwen_expected_blocks.json` are the SAME artifacts the py and js `entryBlocks` tests both assert
  against. Tests: `test_qwen_transcript.py`, the `Qwen projection` case in `tunnel-agent.test.js`.

## [Qwen C] (XERK-509) input, liveness, HITL, session naming — all pane-driven

Unlike dsh's [C], everything rides the real PANE through hub-agent's existing parsers; there is NO
control socket. The ONE net-new module is the projection tail.

- **Input & PR-nudge delivery are FREE — a qwen session uses the CLAUDE pane path unchanged.**
  `send_input`/`notify_session` add NO qwen arm (only dsh has one): `send_input` types into the TUI
  via `_type_into_pane` (reusing `INPUT_MAX_CHARS`/`_store_uploads`), and `notify_session` finds no
  Claude inbox (qwen writes no `~/.claude/sessions/<pid>.json`) so it falls back to the pane. The
  `pendingInputs` compaction outbox is harmless (the projection carries no `compact_boundary`, so
  `_pending_scan` never resends). **Never add a dsh-style qwen arm to these.**
- **Liveness reuses the SAME `paneBusy` wire field, so sessionWorking/readyForReview's mirrors are
  UNCHANGED** — do NOT add a qwen liveness signal to them. Qwen's busy hint differs from Claude's "esc
  to interrupt": while a turn runs the footer gains "Enter to steer · Ctrl+Q to queue" and the spinner
  ends "(… · esc to cancel)". Both ride `QWEN_PANE_BUSY_MARKERS`, UNIONED into `_busy_from_capture`
  (and tunnel-agent's `paneShowsBusy`) — qwen-agnostic strings needing no agentType, checked ahead of
  the operator-overridable `PANE_BUSY_MARKERS`. **The spinner token keeps its CLOSING PAREN (`esc to
  cancel)`)**: Claude's own permission-dialog footer says "Esc to cancel · Tab to amend" (no paren)
  and must still read blocked/idle — dropping the paren makes every Claude approval read busy (a
  regression a test pins).
- **HITL is TWO inputs, both to full parity, KEPT not degraded:**
  - **(1) A tool-APPROVAL prompt is the panePrompt analogue.** `parse_pane_prompt` accepts qwen's
    cursor glyph `›` beside Claude's `❯`, and treats qwen's composer footer (`QWEN_PANE_FOOTER_RE`,
    "Ask permissions (shift + tab to cycle)") like Claude's mode footer — its presence below a
    numbered run means "not a dialog". `answer_pane_prompt` types the digit AND **Enter for a qwen
    session** (Claude submits on the digit alone). Under `approvalMode:"auto"` these are largely
    suppressed; the parser is parity + future permission-mode work. **Pitfall: qwen draws a right-edge
    SCROLLBAR glyph (`█` + the block/vertical-bar family) on every line of a SCROLLED pane**, so the
    question line ends in `█` not `?` and the "blank" separator lines strip to `█` not `""` —
    `parse_pane_prompt` strips that trailing column (`_PANE_SCROLLBAR_RE`) per line or a real approval
    dialog is missed. **Pin pane parsers against the REAL captured frame**
    (`docs/qwen-g0/pane/03-tool-approval.txt`), not a hand-cleaned copy — the cleaned copy hid this.
  - **(2) A STRUCTURED question renders the SAME multi-select card a Claude session shows** — NOT a
    yes/no approval. Qwen has NO native AskUserQuestion tool, so `_qwen_settings` REGISTERS one via
    MCP: `mcpServers."turma-ask"` runs `python3 -SsE agent/qwen/ask_mcp.py`, a stdlib stdio JSON-RPC
    server exposing `ask_user_question({question, options[], multiSelect, header?})`. On a call it
    writes the EXACT `QUESTIONS_DIR/<sid>.req.json` shape `ask.py`/`_hook_question` use and BLOCKS for
    `<sid>.ans.json` — so the EXISTING `answer_question` path (the else-branch, dropping the
    .ans.json) answers it with **NO client change**. The session id / rendezvous dir / block timeout
    ride the server's own `env` block. `QWEN_QUESTION_BLOCK_TIMEOUT_SEC` (600) stays under
    `QUESTION_STALE_AFTER_SEC` so a still-blocking question isn't stale-dropped from the beat.
- **Session naming is generated by QWEN and ITS model, NEVER `claude -p`** — a pure-qwen host may have
  no Claude login, so naming must not depend on one. `_start_summary` REFUSES a qwen session (as it
  does dsh). `_seed_qwen_summary` names in three tiers, weakest first, a later one overriding an
  earlier (before the `_summary_due` gate, like dsh):
  - Tier 1 — qwen's OWN generated title, captured by the tail's `title()`. **G0 found NO native title
    mechanism, so this is DORMANT**; a future qwen that writes one is honoured with no code change.
  - Tier 2 — a `qwen -p` ONE-SHOT (`_start_qwen_summary`) over the session's own OpenAI-compatible
    endpoint, reusing `self.summaries`/`_poll_summaries`/`_finish_summary`. The endpoint key rides the
    subprocess ENV, never argv; `--safe-mode` + cwd `REGISTRY_DIR` keep it a clean, unguarded,
    repo-untouching title call. `_finish_summary` clears `summaryProvisional` when a name lands,
    finalizing over tier 3.
  - Tier 3 — the first user prompt, PROVISIONAL, applied at once so the card is never blank while the
    one-shot runs. Gated so tier 2 still launches after tier 3 sets a provisional name (`_summary_due`
    stops once `summary` is set, so the tier-2 launch checks the attempt/backoff budget directly).
- **The projection tail is the one net-new module (`agent/qwen_session.py`).** `QwenProjectionTail`
  reads qwen's native log (`~/.qwen/projects/<slug>/chats/<id>.jsonl`) through `QwenProjector` and
  appends the projection to the pinned `<claudeSessionId>.jsonl`, incrementally, off the beat, never
  raising. **It LOCATES the native log by GLOB (`<id>.jsonl` across project dirs), not a computed
  slug** — the same discipline `_qwen_runtime_file` uses, load-bearing because the cwd→slug rule is
  uncertain. Resume starts at the native log's EOF (qwen `--resume` appends in place). Wired in
  `_launch_qwen` (`_start_qwen_tail`), **reattached on the resume-on-boot ADOPT path** (the tail died
  with the manager while the TUI kept appending), stopped in `_forget_session_caches`/`_teardown_qwen`.
- Tests: `test_qwen_session.py` (glob discovery, resume-at-EOF, incremental, title),
  `test_qwen_ask_mcp.py` (MCP round-trip + rendezvous-file shape), `TestQwenSessionArms` (busy
  markers, the `›` approval parse, digit+Enter, ask-MCP registration, the three naming tiers,
  teardown), the qwen busy cases in `tunnel-agent.test.js`.

## [Qwen D] (XERK-511) busy / ready-for-review / summary semantics

The dsh [D] analogue but SIMPLER, because a qwen session has a REAL pane. The implementation rode in
on [Qwen C]; [Qwen D] is the read-side verification that PINS these:

- **`session_report` has NO qwen branch — a qwen session takes the CLAUDE pane path** (the `else` of
  the `agent_type == "dsh"` branch). paneBusy/modeActual/panePrompt come from `_pane_status`, not a
  socket cache (dsh needed the cache only because it was headless). `dsh_status` is ignored for a qwen
  session even if passed — the branch keys on exactly `"dsh"`. So `sessionWorking`, `liveState`, the
  readyForReview mirrors and the alert are UNCHANGED and CANNOT drift: the "Working = paneBusy OR live
  agents" contract holds verbatim for qwen.
- **Everything OTHER than liveness stays transcript-derived from the [Qwen S1] projection**:
  `lastRole`, `lastHasToolUse`, `transcriptAgeSec` and the PR scan read the projected
  `<claudeSessionId>.jsonl` with no change — which is what makes readyForReview's finished-turn branch
  work identically.
- **Naming override is scoped to the seeder's OWN provisional name** (`_seed_qwen_summary`): a
  `summaryManual` rename, or any non-provisional `summary` (a ticket session's `<key> <summary>`, a
  migrated name), is left ALONE — even when a native title or first prompt is available and no
  one-shot is spent — matching the Claude ticket-naming contract (`agent-board.md`). Same
  `if summaryManual: return` / `if current and not provisional: return` guard `_seed_dsh_summary` uses.
- Tests: `TestQwenLivenessInReport` (the pane path, dsh_status ignored, pane-sourced panePrompt,
  transcript-derived lastRole/lastHasToolUse — asserting `_pane_status` IS called), and the
  `test_seed_qwen_summary_never_clobbers_*` cases.

## [Qwen E] (XERK-512) archive sync — projection (rendered) + native log (raw)

BOTH layers with NO new archive code, only a store-dir contract. The one difference from dsh [E] is
WHO writes the native log into the store.

- **The projection (`<slug>/<sid>.jsonl`) rides the RENDERED layer unchanged** — a top-level `*.jsonl`
  in the usage ledger's slug, enumerated by `_archive_manifest` like any transcript.
- **The native event log rides the RAW layer at `<slug>/<sid>/qwen/`** (`QWEN_STORE_DIRNAME`, a fixed
  `chat.jsonl`), which `_session_files` already walks as a raw sidecar — so `_archive_raw_deltas`
  ships it byte-for-byte with no special case, exactly as it does dsh's `<sid>/dsh/`.
- **The TAIL mirrors it, not the launcher** — the load-bearing reconciliation. A dsh driver writes its
  feed directly into `<sid>/dsh/`, but qwen owns its native log and writes it under its OWN home,
  which the raw layer does not reach. So `QwenProjectionTail` — already reading that log off the beat
  — copies its bytes into the store. **The mirror is APPEND-ONLY and on its OWN cursor** (the mirror
  file's size), independent of the projection cursor: the projection may start at EOF on resume to
  avoid doubling the transcript, but the mirror always copies the WHOLE native log, and a manager
  restart/adopt resumes from the mirror's size — catching up every native byte written while the tail
  was dead (a superset of what the projection can safely re-read). A native log rewritten SHORTER than
  the mirror leaves the archived copy intact (the raw layer's shrunk-source rule).
- **Only the append-only event log rides raw** — any SQLite/index qwen rebuilds must NOT be mirrored
  (the per-file cursor ships bytes past an offset, wrong for a page-mutating DB).
- **A RUNNING qwen session is NOT un-excluded from the manifest** — unlike dsh, which un-excludes a
  live session so its Trajectory populates. qwen has a real ttyd TUI and no Trajectory analogue, so
  its native log is retention/metrics only and archives once the session ENDS, like any Claude
  session. `_teardown_qwen` drops only the 0600 env file, never the store dir, so the retained log
  survives kill (it lives under `PROJECTS_ROOT`, not the worktree delete removes).
- **The native log is never double-counted in usage** — `<sid>/qwen/chat.jsonl` is neither a top-level
  `*.jsonl` nor under `subagents/`, so `_project_transcripts` skips it; the projection is the single
  counted copy. **Do not teach the walk to read `<sid>/qwen/`.**
- **No beat-loop budget regression** — the mirror runs on the tail's own daemon thread (never the
  beat, never raising), and archive sync stays on the sync worker (XERK-395).
- Tests: `TestQwenArchiveSync` (manifest + both delta pushes over the real projector/corpus) and the
  `test_mirror_*` cases in `test_qwen_session.py` (byte-for-byte copy, incremental append,
  resume-complete, restart catch-up, shorter-log-left-intact).

## [Qwen F] (XERK-510) safety guard (PreToolUse shim + permissions.deny)

qwen's PreToolUse-hook model IS Claude's, so it reuses the shared deny policy directly. The deny
POLICY is NOT duplicated: destructive/policy/attribution shell classification (`guard.py`) and the
"everything under ~/.claude except the two memory trees" predicate (`fileguard.py`) have ONE home,
shelled out to `python3 -SsE <hook>` exactly as Claude and dsh do.

- **The one mismatch qwen adds is TOOL NAMES, so a thin SHIM bridges it** (`agent/qwen/guard/shim.py`).
  `guard.py` keys on `tool_name=="Bash"` and `fileguard.py` on `Write|Edit|…`; a qwen
  `run_shell_command`/`write_file` sails past both. The shim classifies a qwen tool
  (shell/write/read, the qwen twin of the dsh guard's `classify`), shells out to the SHARED hooks with
  the Claude tool shape they expect, AND matches the flat credential/config/runtime-code globs itself
  (realpath'd, so a symlink/`..` cannot dodge them). **The shim is the enforcement; it does NOT
  re-implement the deny policy** — only routing + the flat globs.
- **`build_qwen_guard_config()` reads the SAME rule set `build_guard_settings()` produces** (parsed
  with `_parse_perm_rule`, as the dsh builder does) and emits (a) the `hooks.PreToolUse` wiring and
  (b) the shim's data config (`~/.turma/qwen-guard.json`: hook paths + denyWrite/denyRead/allowRead).
  **Adding a store to `_GUARD_DENY_PATH_RULES` covers all three runtimes with NO qwen change** —
  pinned by `test_shim_config_is_the_shared_rule_set`. Built + written at the launch choke point
  (`_qwen_guard_config`, memoized like `_ensure_guard_settings`; primed off-beat by `_prime_qwen`),
  merged into `.qwen/settings.json` by `_qwen_settings`.
- **It FAILS CLOSED.** `guard.py`/`fileguard.py` fail OPEN on a malformed payload because Claude keeps
  `permissions.deny` as a backstop; qwen has none the shim can rely on, so the shim DENIES (deny JSON
  on stdout AND exit 2) on: an unreadable config, a hook it cannot spawn / that crashes (nonzero exit)
  / times out / returns unreadable output, a SHELL call with no configured guard script, an
  unparseable tool payload, or any unexpected error in the shim. A missing FILEGUARD degrades to the
  write-deny globs (defence in depth, like dsh), not a fail-closed — the globs still name the
  catastrophic ~/.claude subset. **G0 GOTCHA baked in: qwen's hook `timeout` is MILLISECONDS** — a
  too-small value silently disables the guard, so `QWEN_GUARD_HOOK_TIMEOUT_MS` (15000) comfortably
  exceeds the shim's own nested-subprocess budget (`QWEN_SHIM_HOOK_TIMEOUT_MS`, 5000).
- **Approval mode stays `auto` (NOT `yolo`, NOT `default`)** — "not auto-yolo, not auto-reject".
  `default` would HANG on every tool-approval prompt (nothing auto-answers them until [Qwen P]);
  `yolo` risks skipping hooks. `auto` is the Claude `--permission-mode auto` analogue: hands-off,
  hooks fire. **That hooks also fire under `auto` is host-UNVERIFIED and is THE gate before
  `QWEN_ENABLED` is flipped** — see `docs/qwen-adr.md`.
- **`permissions.deny` is UNVERIFIED defence in depth** — emitted as the Claude backstop analogue, but
  the shim does NOT depend on it; if a real qwen REJECTS the unknown key the fix is a one-line removal
  (`_confirm_qwen_launch` catches a launch break).
- **The credential env file is read-denied** (`Read(~/.turma/qwen/*.env)`, holds `OPENAI_API_KEY`) —
  defence in depth: 0600 already stops other uids and the session runs as the owning uid, so this only
  stops a casual read via the file-editing tools (Bash walks past it, XERK-309).
- **`_realpath_glob_prefix`** (XERK-503) resolves symlinks in each glob's literal prefix, so a
  symlinked HOME *subdirectory* (`~/.aws` a bind mount, or WSL's Windows-side profile) no longer
  dodges its own deny rule, matching how `fileguard.py` realpaths its `~/.claude` base. Three further
  residual gaps (the ungated unknown tool name; the shim's re-readable config; a credential FILE
  itself symlinked, still open after the prefix fix) are stated in `docs/qwen-adr.md` — accepted, not
  open bugs.
- Tests: `test_qwen_guard.py` — `TestBuildQwenGuardConfig` pins the config (hook wiring, ms-timeout
  ordering, shared-rule-set derivation, credential read-deny, no-ListAgents, missing-fileguard
  degrade); `TestQwenGuardShimEndToEnd` drives the REAL shim over the REAL guard.py/fileguard.py with
  hostile inputs (destructive/policy/attribution shell, credential + ~/.claude writes, credential
  reads vs the uploads/roster carve-outs, symlink escape, every fail-closed path).

## Children that added NO new code path

Each proves the "no new reader, no `agentType` branch" property for its own surface; mechanics live in
the file named, whose `paths:` load beside this one.

- **[Qwen G] (XERK-513) usage** — spend charts identically with no schema change and no `agentType`
  branch, because [Qwen S1] already writes `message.usage`/`message.model` in the ledger's shape.
  **[Qwen G] added NO aggregation code** (the `_map_usage` all-zero hardening was already folded into
  S1); it is the confirmation plus the end-to-end test. The native log is never double-counted —
  neither in qwen's own home nor via [Qwen E]'s raw mirror, since `_project_transcripts` counts only a
  slug's top-level `*.jsonl` plus `subagents/**`. Contract (incl. why subscription `limits`/probe/card
  stay Claude-only): `agent-usage.md`. Tests: `TestQwenUsageReportEndToEnd`,
  `TestQwenProjectionAccounting`/`TestQwenUsageMapping`.
- **[Qwen H] (XERK-514) PR/MR chips** — same chips, ledgers, attribution and delivery with NO
  `agentType` branch; **[Qwen H] added NO PR code.** Load-bearing dependency is S1's
  `run_shell_command`→`Bash` map. **Comment/conflict nudges route through the PANE — the ONE
  difference from dsh [H]**: qwen writes no `~/.claude/sessions/<pid>.json`, so `notify_session` finds
  no inbox and falls back to `send_input`'s pane path exactly as a Claude session with no inbox does.
  Neither `send_input` nor `notify_session` carries a qwen arm — never add one. `refresh_pr_status`
  stays the same inline offender for ALL runtimes (XERK-397). Chips survive resume/migration via
  `_seed_prs` over the projected `<tid>.jsonl`, independent of the raw sidecar. Mechanics:
  `agent-prs.md`. Tests: `TestQwenPrAttribution` drives the REAL projector over `qwen_pr_corpus.json`
  (cloned from captured Qwen 0.22.2 event SHAPES, because G0's two real sessions had their shell tool
  guard-denied and carry no successful shell run).
- **[Qwen I] (XERK-515) board** — a ticket can be pinned to qwen; the `ticketRuntimes` pin accepts
  `"qwen"` and the AGENT side is unchanged (`spawn_ticket` already forwards `agentType`,
  `resolve_agent_type` already validates it, `_launch_qwen` already appends the ticket-branch
  directive — no new launch code). The `/runtime` route + `orgOffersQwen` gate, the per-runtime
  `findTicketHost` capability filter, the board `qwenAvailable`/picker and the Android parity:
  `turma-board.md`.
- **[Qwen J] (XERK-517) delegation** — qwen's `Agent` launch reshapes to
  `Agent`/`async_launched`/`<task-notification>`; readers/usage/archive/migration unchanged.
  Mechanics: `qwen-delegation.md`.
- **[Qwen K] (XERK-516) migration + resume** — qwen is Claude-shaped, so its NATIVE LOG *is* the store
  `qwen --resume` reloads from (no separate store like dsh's `DSH_SESSIONS_ROOT`); a migration carries
  that log under `.qwen-store/`, places it at the target cwd's slug and re-keys its per-row `cwd`.
  Mechanics: `qwen-migration.md`.
- **[Qwen P] (XERK-522) permission-mode parity** — no mode name in qwen's footer → `_set_mode_blind`.
  Tests: `test_qwen_footer_returns_none`.
