---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# `agent/` — per-host headless agent image

Currently Claude Code; agent-generic name so it can host other agents later. Read `CLAUDE.md` first.
Session runtime (queue, kill/resume, launch flags, local-model failover): `agent-sessions.md`.
Safety-guard policy: `agent-hooks.md`.

## `hub-agent.py` — session manager and heartbeat in one process

- Scans `REPOS_ROOT`; owns a persisted registry (`~/.turma/sessions.json`); executes hub commands
  riding the heartbeat reply (at-least-once, `cmdId` de-dup); drives each session's worktree + tmux
  + ttyd; heartbeats repos, one record per session, and a container-log tail.
- `resume_on_boot` **adopts** a session whose claude tmux is still alive (tmux/ttyd outlive a
  manager restart) — only re-ensures the ttyd, so the native agent updates in place without stopping
  sessions. `--resume` relaunch is the fallback when the tmux is gone. ttyd adopted by port when the
  persisted `ttydPid` is alive; `_kill_ttyd` reaps that pid so an adopted ttyd isn't leaked. Tests:
  `TestResumeOnBootAdopt`.

## Commands

Lifecycle (`spawn`/`kill`/`start`/`restart`/`delete`/`resume`/`resumeTranscript`) per the session
model. Tests: `TestResumableReport`, `TestResumeTranscript`, `TestTranscriptCwd`.

- `interrupt` — one Escape to the pane. **NOT** gated on `paneBusy`. Tests: `TestInterrupt`.
- `prune` — removes worktrees merged into the latest default (skipping any backing a session or
  holding uncommitted changes) and local branches merged into it.
  - **Runs on a WORKER THREAD, never the beat** (XERK-256, a multi-minute git sweep held the
    heartbeat and read the host offline). `prune_repo` only QUEUES; `_run_prune` works. **ONE
    worker, FIFO across repos** — a repo already queued/running is not stacked.
  - `self.prunes` is worker-written/beat-read under `_prune_lock`; only a FINISHED record carries
    `finishedMono` (starts the linger clock, else a sweep ages out from under itself).
  - **Removability is re-read at removal time, never from the listing** (minutes stale): live set,
    dirty check, `HEAD`. A failed read reads as unmerged.
  - **Removal is a two-sided handshake, not a check** (`_claim_for_removal`/`_claim_worktree`, both
    under `_prune_lock`): `worktree remove` takes 10-37s with the dir present throughout, so a
    resume landing mid-removal must not see `isdir` and skip `_worktree_add`. The registry append
    happens INSIDE the lock.
  - `self.closed` stays the BEAT's to mutate; the worker only appends to `_prune_swept`.
  - Git bounded by `PRUNE_GIT_TIMEOUT_SEC`, not `run()`'s 15s. Dirty check uses **`run_out`, not
    `run`** — `run` collapses failure into empty output, misreading a timed-out `git status` as
    CLEAN. Tests: `TestPruneRepo`, `dashboard-prune.test.js`.
- `refreshJira` — /board manual refresh (bypasses `JIRA_REFRESH_EVERY`), re-checks
  `jira_configured()`.
- `input`/`history`/`answerQuestion` — chat composer + glasses client (below).

### `input` / `send_input`, `notify_session`

Two delivery paths — pane vs. the session's own inbox — and which one a message takes: `agent-input.md`.

### `history`

- **Operator messages are exempt from the window** (XERK-186): bounded read (last 4 MiB +
  `HISTORY_MAX_MSGS`, capped in `_history_entries` — callers must not re-slice), but every
  user-authored turn folds back in ahead of the window on any cut (id-deduped,
  `HISTORY_USER_MSGS` backstop); tool traffic otherwise evicts. Tests: `TestHistoryCommand`.

### `setModelSource` — failover to the self-hosted model (XERK-246)

- Moves a RUNNING session between the subscription and this host's local model, keeping its
  conversation (env-repointing, not a second coding agent — why: `agent-sessions.md`,
  `docs/local-model-failover.md`).
- `local_model_configured()` gates on **both** endpoint and key, charset-checked model name.
  Half-configured reads as "no".
- Settings go to a **0600 file (`write_local_model_env`) the launch line SOURCES**, never a
  command-line prefix / `tmux -e` (`/proc/<pid>/cmdline` is world-readable). Per-session, so kept
  out of the shared guard settings file. `set -a` around the source is load-bearing or claude never
  sees the exported vars.
- Blanks `ANTHROPIC_API_KEY` (outranks `ANTHROPIC_AUTH_TOKEN`, would bill the account being failed
  away from) and sets `ANTHROPIC_SMALL_FAST_MODEL` too, or background calls 403 invisibly.
- **`--model` is suppressed for a local session** — it overrides `ANTHROPIC_MODEL`, so a failed-over
  session carrying a Claude alias would 403 every turn. `set_model` refuses one for the same reason.
- Credential file is `Read`-denied in `_GUARD_DENY_PATH_RULES`.
- **Every record-rebuild path carries `modelSource`** — spawn, provision, queue drain, start,
  restart, resume, resume-any, migration in, resume-on-boot. Resume-any matches by transcript id
  then by worktree, newest first. Migration RE-VALIDATES against the target's config.
- `set_model_source` **reverts the record if the relaunch throws**; `_launch_tmux` likewise demotes
  `local`→`subscription` (and says so) when the host's local config has gone. Tests:
  `TestLocalModelConfig`, `TestLocalModelFailover`.

### `setModel` — live model switch, for that session only (XERK-33)

- Drives Claude Code's `/model` picker (`parse_model_picker`). **Never `/model <name>`** — its
  argument form ALSO saves the pick as the login-wide default.
- Arrows **one press at a time, each verified by re-reading the ❯** (`_await_picker_step`). Record
  updates only on the TUI's own confirmation (`_await_model_confirmation`).
- A busy pane **defers, never drops**: lands as `pendingModel`, applied on the first idle beat by
  `_apply_pending_switches`. Backs out with Escape if the picker has no row for the target. Tests:
  `TestSetModelMode`, `TestParseModelPicker`.

### `setMode` — live permission-mode switch

- A **closed loop**: Shift+Tab, read the footer marker back, repeat until it reads target or wraps
  (logged no-op). **Never a computed press count** — cycle length is account/model-dependent and
  drifts if the operator cycles by hand. `_set_mode_blind` is the fallback for an unreadable marker.
- **What is stored is always what was read.** No busy gate — BTab types nothing into the input.
  Tests: `TestParsePaneMode`.

## Heartbeat

- Repo list most-recently-active first; repos-root pseudo-repo **pinned first, never ranked**.
- `agentVersion` falls back `TURMA_AGENT_VERSION` → `native/install.sh`'s stamped `VERSION` →
  repo-root `VERSION` → `null`. Tests: `TestAgentVersion`.
- `codingAgent` = `{name, version}` from `claude --version`, **preferring the product name** over
  `CODING_AGENT_NAME` (agent-generic image). Raw string still rides as `claudeVersion` for older
  hubs. Tests: `TestCodingAgent`, `host-header.test.js`.

### The login's real model list (XERK-33)

- `models` = `{available, defaultLabel, at}`, probed via `claude -p "/model"` so menus offer what
  the login can run with no config to drift.
- Detached one-shot on `MODELS_REFRESH_EVERY`/`MODELS_RETRY_EVERY` (cwd=`REGISTRY_DIR`, no
  `--settings`). A failed/unparseable probe **keeps the previous list**; `None` until first success.
- `resolve_model` accepts probed aliases beyond the static four, charset-checked (`SPAWN_MODEL_RE`);
  bracketed `[1m]` variants never reach a launch command line.
- `modelActual` folded by `_scan_entry_line` (**one json parse feeding both the PR scan and
  `_scan_model_entry`**) from `message.model` + "Set model to X", newest wins. Tests:
  `TestParseModelProbe`, `TestModelsProbe`, `TestScanModelEntry`, `TestSessionReportModelActual`,
  `TestSeedModelActual`, `TestModelActualPayload`, `TestInternalToolSlugModelProbe`.

### Claude login health (`claudeAuth`, XERK-98)

- `claude_auth_status()` reads `~/.claude/.credentials.json` (`CLAUDE_CREDS_PATH`) every beat.
- **The REFRESH token is the signal, not the access token**: lapses only past its ~30-day window.
  `needsLogin` = missing/unreadable/no oauth/past expiry; `expiringSoon` = within
  `CLAUDE_AUTH_WARN_MS` (3d). Unknown expiry reads **healthy**. Tests: `TestClaudeAuthStatus`.

### Live-session signals

- `paneBusy` is the **primary** signal (transcript freshness is only the `null` fallback):
  `_pane_busy` looks for "esc to interrupt", accurate through a long silent tool call unlike
  mtime. Overridable via `TURMA_PANE_BUSY_MARKERS`.
  - **Read from three shapes, not the hint alone** (XERK-130): a narrow pane ellipsizes it, so
    `_busy_from_capture` also accepts the truncated remnant (`PANE_BUSY_TRUNC_RE`) and the column-0
    spinner (`PANE_SPINNER_RE`, requires the gerund's ellipsis so a completed turn can't fake busy).
    Both glyph-anchored. Tests: `TestPaneBusy`.
  - **Busy→idle flicker suppressed at the source** (`_stable_pane_busy`, XERK-42): busy trusted
    instantly; idle re-confirms once after `TURMA_PANE_IDLE_CONFIRM_SEC` (0.2s, 0 disables), only
    on the busy→idle EDGE. Tests: `TestStablePaneBusy`.
- **`agents` is the other half of the activity read** (XERK-245): background agents in flight,
  folded by `_scan_agent_entry` from the transcript's two edges — launch's structured
  `toolUseResult` (`status:"async_launched"`, started) and a `<task-notification>` with a terminal
  `<status>` (stopped).
  - Exists because **`paneBusy` cannot see delegated work**: launching a background agent ENDS the
    main turn with no interrupt hint. **Do not widen the busy read to cover it** — `paneBusy` means
    the session's OWN turn, which the Stop button and idle gate key on.
  - **The TUI's footer list is NOT the source, and must not become one again** — pane CONTENT,
    forgeable by quoted text, and the rows linger ~24s after finishing (can't tell running from
    just-finished). Same reason pending questions come from the `ask.py` bridge, never scraping.
  - **Never scan loose `agentId:` TEXT** — it appears in tool OUTPUT (grep/cat/Read, a fixture,
    another session's scratch); an id from elsewhere never receives its notification, a phantom
    that never clears. Only the structured field counts, and a SYNCHRONOUS subagent (already
    finished when it lands) is correctly excluded.
  - **`status:"async_launched"` is the whole gate — do NOT also require `isAsync`.** Written by
    exactly `Agent`/`Task`/`Workflow`; `isAsync` is absent on `Workflow`, whose background runs are
    the LONGEST-lived work on a host — requiring it left them reading idle for their whole
    duration. A workflow reports `type:"workflow"` + `workflowName`; same stop edge.
  - **The tool is named `Agent` now, `Task` in older transcripts — match both.** No `subagent_type`
    on a background launch, so the row's type falls back to `agent` (wildcard match on description).
  - **A `workflow` row resolves to a RUN, not a conversation** (XERK-304, no transcript of its own):
    `agent-workflows.md`.
  - **A stop already seen beats a later-read launch** (`stoppedAgents`) — the queued copy can sit at
    an earlier file offset than the launch it refers to.
  - **An ASSISTANT turn is never a notification carrier** — real ones ride `queue-operation`/`user`,
    so a session merely quoting one cannot retire a running agent.
  - **Failure direction is EMPTY.** An unseen launch (offsets primed to EOF on restart) reports no
    agents — the pre-feature behaviour — rather than a phantom that strands work silently. Bounded
    by `LIVE_AGENTS_MAX`.
  - Reported on **every** `session_report` exit path (`_finish`). Mirrors
    `scanAgentEntry`/`liveAgentsReport` in `tunnel-agent.js`. Tests: `TestLiveAgentsScan`.
- `modeActual` — the TUI's REAL mode off the footer marker (glyph-anchored). `_session_payload`
  **reconciles stored `permissionMode` to it** each beat. Tests: `TestSessionReportPaneBusy`,
  `TestModelActualPayload`.
- **Pending questions** come from `agent/hooks/ask.py`'s req/ans files, **never pane scraping**; a
  transcript scan is the already-answered fallback.
- **`panePrompt`** — the TUI's OTHER blocking dialog. No hook intercepts it, nothing in the
  transcript, and while up the pane shows neither the interrupt hint nor mode footer, so `paneBusy`
  alone reads **idle**. `parse_pane_prompt` reads `{prompt, options:[{number,label,selected}],
  detail}` off the mode marker's capture.
  - **Nothing keys on wording.** A dialog needs ALL of: options 1..N (N≥2), exactly one `❯`, a `?`
    line directly above, **no mode footer below** (the footer rides the composer a dialog
    replaces). `detail` closes on a rule, not on blanks.
  - `answer_pane_prompt` **re-reads the pane first** and drops the answer unless that number is on
    screen NOW. Both `liveState`s check the prompt ahead of the busy read. Tests:
    `TestParsePanePrompt`, `TestAnswerPanePrompt`, `pane-prompt` in `server.test.js`,
    `panePromptHtml` in `chat.test.js`.

## PR status, comment delivery and conflict nudges

`agent-prs.md` — merge-readiness/CI rollup, the two transcript-keyed ledgers, `_scan_pr_line`
attribution, GitLab/ADO dispatch, comment/conflict replies.

## Expected-restart "updating" status (XERK-29)

- `_handle_shutdown` (SIGTERM/SIGINT) **announces an EXPECTED restart before the silence**: `POST
  /api/agents/<host>/updating` (best-effort short-timeout), covering both update and crash-restart.
  Hub sets `a.updating` with a `UPDATING_GRACE_MS` deadline, surfaced only while the host is silent.
- The native updater leaves `~/.turma/updating.json` (`UPDATING_FLAG_PATH`), read to enrich the
  reason (`"update"` vs.
  `"restart"`); next boot clears a stale flag. Tests: `TestUpdatingAnnounce`.

## Usage aggregates, ledger and subscription limits

`agent-usage.md` (`hub-agent.py` + `hooks/statusline.py`) — per-repo/host token aggregates, the
worktree→repo attribution ledger, the subscription-limit snapshot + probe.

## Board sources, triage and ticket sessions

`agent-board.md` — Jira/Azure DevOps collectors, the two tracker writes, repo triage, ticket sessions.

## Session activity summaries

- Each session gets a few-word name, generated agent-side by the host's authenticated `claude -p`
  (`SESSION_SUMMARY_MODEL`, Haiku default, no external API/key/endpoint, `SESSION_SUMMARY_TIMEOUT_SEC`
  bound). `_start_summary()` runs detached (cwd `~/.turma`,
  no `--settings`); `_poll_summaries()` reaps via `clean_summary()`.
- Fires at spawn from the initial prompt, or for a bare/quick spawn from the **first user prompt
  read straight out of the transcript** (`_seed_summaries()`/`_first_user_text()`, skipping header,
  `isMeta`, `<command-…>`) — the only path that names a bare session, whose first prompt never
  reaches `send_input`.
- **Bounded-retry, not one-shot**: `_summary_attempts`/`_summary_due` gate on unnamed + attempts
  left + past backoff (`SUMMARY_MAX_ATTEMPTS`, `SUMMARY_RETRY_BACKOFF_SEC`), armed at launch so a
  restart mid-attempt neither loops nor loses retries owed.
- No prompt yet → stays unnamed, spends no attempt. Exhausted → degrades to label/worktree.
- **Manual rename** (`setSummary`→`set_summary()`→`clean_manual_summary()`): first line,
  whitespace-collapsed, capped at `SUMMARY_MAX_CHARS`, sets `summaryManual` (pins the card, stops an
  in-flight `claude -p` clobbering it). A blank rename clears + unpins. Works on a stopped session.
  Tests: `TestCleanSummary`, `TestSetSummary`, `TestSessionSummaries`, `TestSummaryDue`,
  `TestSeedSummaries`.

## GitHub block and cloning

- `github` block reports a usable `gh` login + its clonable repos + `GH_CLONE_OWNERS`, plus
  in-flight/recent `clones`. **`available` is the gate key every client must use** (XERK-126).
- `clone` runs an allowlist-checked `owner/repo` as a detached subprocess. Private-repo auth via
  `gh auth git-credential`.
  - **`--progress` is not optional** — without it stdout is a near-empty line and a working clone
    reads as broken.
  - `_clones_payload.progress` is **one line, capped both ends** (`CLONE_PROGRESS_MAX`); split on
    `\r` as well as `\n` (git updates in place). `_clone_log_tail` carries failure detail only.
  - Every `clones[]` field is Android-typed, coerced in `normalizeClones` (a full `/api/agents`
    decode is atomic there). Tests: `TestClone`, `normalizeClones` in `server.test.js`,
    `clone.test.js`, `CloneTest.kt`.
- **Multiple git sources (XERK-155)** — `gitSources` heartbeats ADO + a GitLab host
  (`GITLAB_URL`/`GITLAB_TOKEN`) beside `github`
  (contract unchanged). GitLab clones over SSH via the mounted `~/.ssh` (the token only LISTS).
  Per-source keep-last-good listings; agent resolves URL from its own cache. Tests:
  `TestGitSources`, `clone.test.js`, `CloneTest.kt`.
- **Non-GitHub git creds (XERK-54)** — a SECOND system credential helper (`store
  --file=/root/.git-credentials`) after gh, reading an optional bind mount. gh first so github.com
  always gets a fresh token. Guard denies writing `~/.git-credentials`. Native inherits the host's
  git config untouched. Tests: `test_denies_non_github_git_credential_writes`.
- **Azure DevOps git auth (XERK-54, XERK-226)** — reuses the board PAT via a URL-scoped
  `http.<azure_base>.extraHeader` (`--wire-azure-git`, also exports `AZURE_DEVOPS_EXT_PAT` for `az
  repos`) — not a credential helper, since self-hosted TFS/Server often issues no Basic challenge one
  can act on. Wired by the old container entrypoint
  only; native (no `az`) leaves this dormant. Tests: `TestAzureGitAuthConfig`.

## `tunnel-agent.js`

`agent-tunnel.md` — reverse tunnel, control-channel liveness, live working footer. JS
re-implementation of `hub-agent.py`'s parsers; parity contract in `CLAUDE.md`.

## Transcript entry blocks

- Each tail entry carries a rich **`blocks[]`** beside the flat `text` (`_entry_blocks`/
  `entryBlocks`), preserving thinking text, tool_use inputs and tool_result outputs that
  `_entry_text` flattens away.
- Turns ABOUT the session are classified: interrupt marker; `!` shell passthrough →
  command/command_output shapes (name `!`, stderr wins only when non-empty); `away_summary` with
  its config hint stripped (every other system subtype dropped); `tool_reference` in a tool_result
  → `[tool: <name>]`.
- **A known tool call carries its reviewable payload on the tool_use block** (`_tool_use_detail`/
  `toolUseDetail`): Edit→`edit`, Write→`content`, ExitPlanMode→`plan`, TodoWrite/dsh
  `todo_write`→`todos` (one branch for both runtimes), any tool's `description`→`desc`.
  AskUserQuestion titled by its question text, not the input JSON.
  - **SendUserFile → `files[]`+`caption`** (XERK-221, oversize past `SEND_FILE_MAX_BYTES` → name-only
    chip): image/SVG as base64 data URI, a `render` page
    as raw markup, else a name chip (never opened). Only image/html paths are read and bounded.
- `compact_boundary` and `pr-link` markers; pr-link entries carry no uuid so the feeds synthesize a
  stable id from the URL alone, deduped over the whole conversation (Claude re-stamps pr-links atop
  every user turn, so one PR yields ~6 entries — folding only consecutive repeats is not enough).
- **Still-queued prompts ride beside entries, not inside them**: both feeds fold
  `queue-operation` FIFO (`_fold_queue_op`/`foldQueueOp`) and ship survivors as `queued[]`. Display
  filtering happens at REPORT time (`_queued_display`/`queuedDisplay`), never at fold time.
- Blocks ride the live tail, `history` and the archive push at ONE fidelity (`BLOCK_CAPS`, mirrored
  in `tunnel-agent.js`) — a tool_result-only turn is kept when it has blocks; only
  `transcript_tail` stays text-only.
  - **Never give the live path tighter caps again** (XERK-347) — a frame is bounded by the ~128 KB
    window it is parsed from; text caps at `INPUT_MAX_CHARS`, shown WHOLE.
  - **`history` is bounded in WIRE BYTES, never chars** (`HISTORY_MAX_BYTES`/
    `HISTORY_STAGED_MAX_BYTES`, dropping the OLDEST) — `json.dumps` is ensure_ascii, so a CJK char
    is six bytes and a char budget under-states it 6x.
  - **A 413 on the beat DROPS those staged results** — held until a POST succeeds, so a refused
    body would otherwise re-send verbatim forever (XERK-235).
- Tests: `TestEntryBlocks`, tool-detail/marker cases in `tunnel-agent.test.js`.

## Archive sync

`agent-archive.md` (scoped to `hub-agent.py` + its tests) — same coverage as the root table's row.

## Hooks

`agent-hooks.md` (scoped to `agent/hooks/**`). `build_guard_settings()` writes
`~/.turma/guard-settings.json`, passed to every launch as `--settings`, wiring both hooks plus
`permissions.deny`. Policy in that same file.

## `native/` — the install

`agent-native.md` (scoped to `agent/native/**`). Nothing under `native/` edits the shared runtime
files; the one enabling change is `resume_on_boot`'s adopt path.
