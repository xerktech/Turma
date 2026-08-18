---
paths:
  - "agent/**"
---

# `agent/` — per-host headless agent image

Currently Claude Code; the name is agent-generic so it can host other agents later. Read `CLAUDE.md`
first — session model, cross-cutting contracts and safety-guard policy live there.

## `hub-agent.py` — session manager and heartbeat in one process

- Scans `REPOS_ROOT`; owns a persisted registry (`~/.turma/sessions.json`); executes hub commands
  riding the heartbeat reply (at-least-once, `cmdId` de-dup); drives each session's worktree + tmux
  + ttyd; heartbeats repos, one record per session, and a container-log tail.
- `resume_on_boot` **adopts** a session whose claude tmux is still alive (tmux/ttyd outlive a
  manager restart) — only re-ensures the ttyd, so the native agent updates in place without stopping
  sessions. `--resume` relaunch is the fallback when the tmux is gone. ttyd is adopted by port when
  the persisted `ttydPid` is alive; `_kill_ttyd` reaps that pid so an adopted ttyd isn't leaked.
  Tests: `TestResumeOnBootAdopt`.

## Commands

Lifecycle (`spawn`/`kill`/`start`/`restart`/`delete`/`resume`/`resumeTranscript`) behaves as the
session model describes. Tests: `TestResumableReport`, `TestResumeTranscript`, `TestTranscriptCwd`.

- `interrupt` — one Escape to the pane. Deliberately **NOT** gated on `paneBusy`. Tests:
  `TestInterrupt`.
- `prune` — removes worktrees merged into the latest default branch (**skipping any backing a
  session or holding uncommitted changes**) and local branches merged into it.
  - **It runs on a WORKER THREAD, never the beat** (XERK-256): a sweep is minutes of git (31
    `worktree remove`s at 10-37s each on a ZFS pool), and inline it held the heartbeat throughout,
    so the hub rendered the host offline for the whole prune. `prune_repo` only QUEUES; `_run_prune`
    works. **ONE worker, FIFO across repos** — parallel sweeps put several removals on the same
    spindle, which is what makes each slow; a repo already queued/running is not stacked.
  - `self.prunes` is worker-written and beat-read, so **every touch holds `_prune_lock`**, and the
    payload carries `queued`/`running` + progress so the dashboard shows the sweep instead of a dark
    host. **Only a FINISHED record carries `finishedMono`**, which starts the linger clock — else a
    sweep ages out from under itself.
  - **Every input to "is this removable" is re-read at removal time, never taken from the listing**,
    which is minutes old by then. The live set, the dirty check and **`HEAD`** — a session can be
    given work, COMMIT it and be killed mid-sweep, which keeps the worktree and drops it from the
    live set, so the listing's HEAD still says merged and the removal destroys commits reachable
    from no ref. A failed read reads as unmerged.
  - **The removal is a two-sided handshake, not a check** (`_claim_for_removal` / `_claim_worktree`,
    both reading and writing under `_prune_lock`): `worktree remove` takes 10-37s and the dir exists
    for most of it, so a resume landing mid-removal sees `isdir` True, skips `_worktree_add` and
    launches claude into a directory about to be unlinked. The registry append happens INSIDE the
    lock — a check merely preceding it loses the race it exists to close.
  - **`self.closed` stays the BEAT's to mutate** — the worker only appends paths to `_prune_swept`
    for `_poll_prunes` to fold in.
  - Git here is bounded by `PRUNE_GIT_TIMEOUT_SEC`, not `run()`'s 15s (reaping a removal mid-flight
    made a removable worktree "kept" every sweep); the fetch stays short so one dead remote can't
    hold the queue. The dirty check uses **`run_out`, not `run`** — `run` collapses failure into
    empty output, so a timed-out `git status --porcelain` read as CLEAN. Tests: `TestPruneRepo`,
    `dashboard-prune.test.js`.
- `refreshJira` — the /board manual refresh: re-poll now instead of waiting out
  `JIRA_REFRESH_EVERY`. Re-checks `jira_configured()`, so an unconfigured host stays at zero Jira
  calls.
- `input` / `history` / `answerQuestion` — the chat composer + glasses client (below).

### `input` / `send_input`

- **Guarantees the message survives a compaction** (XERK-47), which can drop one queued mid-turn:
  every sent message goes on the record's `pendingInputs` outbox, made at-least-once by
  `_poll_pending_inputs`.
  - Compactions are counted by `_pending_scan` from the transcript's own `compact_boundary` **system
    entry**, never by scraping the pane.
  - A message is **re-sent** only when a NEW compaction happened since it was sent (`compactBase`
    rose) AND it is neither delivered nor still in the folded live queue AND the pane has settled to
    idle (`_pane_busy` False, not None). That three-way gate is what makes the resend
    **duplicate-safe**; `delivered` matches by text alone, biased AGAINST a resend. Bounded by
    `PENDING_INPUT_MAX_ATTEMPTS`/`PENDING_INPUT_TTL_SEC`, one per beat.
  - The outbox is internal (not heartbeated), cleared on restart-clear-context; text typed into the
    raw ttyd terminal bypasses `send_input` and isn't covered.
  - Tests: `TestPendingScan`, `TestPollPendingInputs`, `TestSendInput`.
- **PASTED, not typed** (`_type_into_pane`, XERK-227): `send-keys` is a tmux command argument,
  refused past ~16 KiB, which a pasted log exceeds. `-p` brackets only for an app that asked (Claude
  Code does) so **newlines survive as ONE message**; control bytes are stripped, else one ends the
  paste and the rest reads as KEYSTROKES.
- **Nothing truncates silently**: the fallback CHUNKS its send-keys; the agent REFUSES past
  `INPUT_MAX_CHARS` (100k) and heartbeats it as **`inputMaxChars`**; the hub caps at the receiving
  host's figure (`inputCapFor`, **4k when unreported** — that agent predates the paste and clips the
  tail untold), 413ing with `limit`.
- **File attachments ride this command** (XERK-234): `send_input` fetches each hub-staged upload
  into `~/.turma/uploads/<sessionId>/` — **never a worktree**, where it would read as the
  uncommitted work `prune`/`delete` key on (`build_guard_settings` pre-approves `Read` there) — then
  prefixes the message with their PATHS, so the COMPOSED text is what lands on the outbox. The name
  is sanitized on BOTH sides (it is joined onto a path); one that fails to transfer is NAMED, never
  dropped. **`uploadMaxBytes` is the cap AND the capability flag** (like `inputMaxChars`): an agent
  reporting none drops uploads untold, so the hub refuses and the composers hide the 📎. Tests:
  `TestStoreUploads`, `TestSendInputUploads`, `UploadsTest`.

### `history`

- **Operator messages are exempt from the window** (XERK-186): the read stays bounded (last 4 MiB +
  `HISTORY_MAX_MSGS`, capped inside `_history_entries` — **callers must not re-slice**), but on any
  cut every user-authored text turn in the whole transcript folds back in ahead of the window
  (id-deduped, `HISTORY_USER_MSGS` backstop); tool traffic otherwise evicts them. Tests:
  `TestHistoryCommand`.

### `setModelSource` — failover to the self-hosted model (XERK-246)

- Moves a RUNNING session between the `~/.claude` subscription and this host's local model, keeping
  its conversation. See `CLAUDE.md`'s "Local-model failover" for why this is env-repointing rather
  than a second coding agent, and `docs/local-model-failover.md` for the bake-off behind it.
- `local_model_configured()` is the single gate — **both** endpoint and key, plus a charset-checked
  model name (it is interpolated into a launch command line). Half-configured reads as "no": a
  session launched at an endpoint with no key dies on its first request.
- The settings go to a **0600 file (`write_local_model_env`) that the launch line SOURCES**, never a
  command-line prefix and never `tmux -e`: both put the gateway credential into a process's argv,
  where `/proc/<pid>/cmdline` is world-readable (0444). Only the path is ever visible. Kept out of
  the shared guard settings file because the choice is PER SESSION — one session can fail over while
  its neighbours stay put. `set -a` around the source is load-bearing: without it the settings are
  defined but not exported, and claude (a child process) never sees them, so the session runs on the
  subscription while the UI still marks it local.
- It blanks `ANTHROPIC_API_KEY`, which outranks `ANTHROPIC_AUTH_TOKEN` and would bill the very
  account the failover exists to stop depending on, and sets `ANTHROPIC_SMALL_FAST_MODEL` too, or
  every background call asks the gateway for the login's default alias and 403s invisibly.
- **`--model` is suppressed for a local session** at that one launch choke point. It OVERRIDES
  `ANTHROPIC_MODEL`, so a failed-over session carrying a Claude alias 403s on every turn while the
  record still reads running/local. `set_model` refuses one for the same reason.
- The credential file is **`Read`-denied** in `_GUARD_DENY_PATH_RULES`: 0600 stops other uids, not
  the sessions themselves, which run as the uid that owns it.
- **Every path that rebuilds a session record carries `modelSource`** — spawn, provision, queue
  drain, start, restart, resume, resume-any, migration in, resume-on-boot. Resume-any matches the
  closed record by transcript id and then by **worktree, newest first** (restart-clear-context moves
  a transcript id, and `self.closed` is append-ordered). A migration RE-VALIDATES against the
  target's own configuration.
- `set_model_source` **reverts the record if the relaunch throws** — a record claiming `local` for a
  session still on the exhausted subscription is worse than a visible error. `_launch_tmux` likewise
  demotes a `local` session to `subscription` (and says so) when the host's configuration has gone,
  rather than launching against the subscription while the UI still says local.
- Tests: `TestLocalModelConfig`, `TestLocalModelFailover`.

### `setModel` — live model switch, for that session only (XERK-33)

- `set_model` drives Claude Code's /model picker (`parse_model_picker`). **Never `/model <name>`**,
  whose argument form ALSO saves the pick as the host's login-wide default.
- Arrows go **one press at a time, each verified by re-reading the ❯** (`_await_picker_step`), so a
  dropped/doubled key can't land `s` on the wrong row. The record updates only on the TUI's own "Set
  model to…" confirmation (`_await_model_confirmation`).
- A busy pane **defers, never drops**: the pick lands as `pendingModel` (persisted, heartbeated) and
  `_apply_pending_switches` applies it on the first idle beat. Backs out with Escape when the picker
  has no row for the target (the bracketed `[1m]` aliases have none). Tests: `TestSetModelMode`,
  `TestParseModelPicker`.

### `setMode` — live permission-mode switch

- A **closed loop**: Shift+Tab, read the footer marker back (`parse_pane_mode`), repeat until the
  target reads back or the cycle wraps (a logged no-op). **Never a computed press count** — the real
  cycle is account- and model-dependent, and the record's "current" goes stale when the operator
  cycles by hand. Blind math survives only as `_set_mode_blind`, for a marker the parser can't read.
- **What is stored is always what was read**, so the record can't lie. No busy gate: BTab types
  nothing into the input line and the TUI cycles mid-generation. Tests: `TestParsePaneMode`.

## Heartbeat

- Repo list is most-recently-active first (`lastActivity`); the repos-root pseudo-repo is **pinned
  first, never ranked**.
- `agentVersion` (`agent_version()`) falls back `TURMA_AGENT_VERSION` → the `VERSION` file
  `native/install.sh` stamps beside `hub-agent.py` → repo-root `VERSION` → `null`. Tests:
  `TestAgentVersion`.
- `codingAgent` = `{name, version}` from `claude --version` (`coding_agent()`), **preferring the
  product name** over the `CODING_AGENT_NAME` default — the NAME is reported because the image is
  agent-generic. The raw string still rides as `claudeVersion` for older hubs. Tests:
  `TestCodingAgent`, `host-header.test.js`.

### The login's real model list (XERK-33)

- `models` = `{available, defaultLabel, at}`, probed with `claude -p "/model"` and
  `parse_model_probe`, so the hub's menus offer what this login can run **with no config to drift**.
- A detached one-shot on `MODELS_REFRESH_EVERY`/`MODELS_RETRY_EVERY`, same shape as the
  summary/triage helpers (cwd=`REGISTRY_DIR`, **no `--settings`**, reaped by `_poll_models_probe`).
  A failed/unparseable probe **keeps the previous list**; `None` until first success (hub falls back
  to its static menu).
- `resolve_model(model, extra)` accepts probed aliases beyond the static four, charset-checked
  (`SPAWN_MODEL_RE`); the bracketed `[1m]` variants never reach a launch command line.
- `modelActual` is the per-session counterpart, folded by `_scan_entry_line` — **ONE json parse
  feeding both the PR scan and `_scan_model_entry`** — from each assistant entry's `message.model`
  plus "Set model to X", newest winning. Seeded once for older records (`_seed_model_actual`).
- Tests: `TestParseModelProbe`, `TestModelsProbe`, `TestScanModelEntry`,
  `TestSessionReportModelActual`, `TestSeedModelActual`, `TestModelActualPayload`,
  `TestInternalToolSlugModelProbe`.

### Claude login health (`claudeAuth`, XERK-98)

- `claude_auth_status()` reads `~/.claude/.credentials.json` (`CLAUDE_CREDS_PATH`) every beat.
- **The REFRESH token is the signal, NOT the access token**: it lapses only when claude hasn't
  refreshed inside its ~30-day window, i.e. when a human must `claude /login`. `needsLogin` =
  missing/unreadable file, no `claudeAiOauth`/access token, or a past refresh expiry; `expiringSoon`
  = within `CLAUDE_AUTH_WARN_MS` (3d). Unknown refresh expiry reads **healthy**; a MISSING login
  can't heartbeat, so it surfaces as the offline alert. Tests: `TestClaudeAuthStatus`.

### Live-session signals

- `paneBusy` is the **primary** activity signal (transcript freshness is only the `null` fallback):
  `_pane_busy` looks for the "esc to interrupt" hint, accurate through a long silent tool call
  unlike transcript-mtime. Markers overridable via `TURMA_PANE_BUSY_MARKERS`.
  - **Busy is read from three shapes, not the full hint alone** (XERK-130): a narrow pane ellipsizes
    it, so `_busy_from_capture` also accepts the mode line's truncated remnant
    (`PANE_BUSY_TRUNC_RE`) and the column-0 spinner (`PANE_SPINNER_RE`, **requiring the gerund's
    ellipsis** so an idle pane's completed-turn line can't fake busy). Both glyph-anchored. Tests:
    `TestPaneBusy`.
  - **Busy→idle flicker is suppressed at the source** (`_stable_pane_busy`, XERK-42): a spinner
    repaint's sub-frame gap reads idle mid-turn. Busy is trusted instantly; idle re-confirms once
    after `TURMA_PANE_IDLE_CONFIRM_SEC` (0.2s, 0 disables), **only on the busy→idle EDGE**. Tests:
    `TestStablePaneBusy`.
- **`agents` is the other half of the activity read** (XERK-245): the background agents in flight,
  folded by `_scan_agent_entry` into the per-session `state` from the transcript's own two edges —
  the launch entry's **structured `toolUseResult`** (`status:"async_launched"` — **started**), and a
  `<task-notification>` carrying `<task-id>X</task-id>` with a terminal `<status>` (**stopped**).
  - It exists because **`paneBusy` cannot see delegated work**: launching a background agent ENDS
    the main turn, and the pane then says "Waiting for N background agent to finish" — no interrupt
    hint, and no ellipsis for `PANE_SPINNER_RE`. **Do not widen the busy read to cover it**;
    `paneBusy` means the session's OWN turn is running, which is what the chat's Stop button and
    `_poll_pending_inputs`' idle gate key on.
  - **The TUI's footer list is NOT the source and must not become one again.** It was, twice, and
    failed twice: those rows are pane CONTENT, so a quoted footer plus a composer-less full-screen
    view (`/status`, `/model`, ctrl+o) forged them — a session named after a sentence, reading
    "working" forever and held out of Ready for review; and, measured on a live TUI, **the rows
    linger ~24s after an agent finishes**, so no single capture can tell running from just-finished.
    Same reason pending questions come from the `ask.py` bridge and never from scraping.
  - **Never scan loose `agentId:` TEXT.** That string is in the OUTPUT of any tool that reads a
    transcript (`grep`/`cat`/`Read`, a QA fixture, another session's scratch), and an id from
    another session can never receive its notification here — a phantom that NEVER clears, worse
    than the pane rows. The structured field cannot be produced by a tool printing text, and it also
    excludes a SYNCHRONOUS subagent result, which is already finished when it lands.
  - **`status:"async_launched"` is the whole gate — do NOT also require `isAsync`.** Across the
    corpus that status is written by exactly three tools (`Agent`, `Task`, `Workflow`) and by
    nothing else, so it is sufficient; `isAsync` is absent on `Workflow`, whose background runs
    (`code-review`, `deep-research`) are the LONGEST-lived work on a host — requiring it left those
    sessions reading idle for their whole duration. A workflow reports `type:"workflow"` +
    `workflowName`; its stop edge is the same notification.
  - **The tool is named `Agent` now and `Task` in older transcripts — match both.** Keying on `Task`
    alone left every real launch unnamed (and `_resolve_subagent` had the same bug, so no clicked
    row resolved). A background launch carries no `subagent_type`, so the row's type falls back to
    `agent` and `_resolve_subagent` treats that as a wildcard, matching on the description.
  - **A `workflow` row resolves to a RUN, not a conversation** (XERK-304) — a workflow writes no
    transcript of its own, so the row opens that run's agent picker. Mechanics, the layout on disk
    and the traps in reading it are in `.claude/rules/agent-workflows.md`.
  - **A stop already seen beats a later-read launch** (`stoppedAgents`): the queued copy of a
    notification can sit at an EARLIER file offset than the launch it refers to.
  - **An ASSISTANT turn is never a notification carrier** (real ones ride `queue-operation`/`user`),
    so a session merely QUOTING one — this feature's own fixtures, say — cannot retire a running
    agent and make its id permanently un-registerable.
  - **Failure direction is EMPTY.** A launch this scan never saw — an agent restart primes the byte
    offsets to EOF — reports no agents, i.e. the behaviour that predates the feature. A phantom
    instead strands work silently. Bounded by `LIVE_AGENTS_MAX`.
  - Reported on **every** `session_report` exit path (in `_finish`), so a beat that appended nothing
    still reports agents still in flight. Mirrors `scanAgentEntry`/`liveAgentsReport` in
    `tunnel-agent.js`. Tests: `TestLiveAgentsScan`.
- `modeActual` — the mode the TUI is REALLY in, off the footer marker (glyph-anchored so quoted text
  can't match; read beside the stable busy in `_pane_status`). `_session_payload` **reconciles the
  stored `permissionMode` to it** each beat, since the operator can cycle by hand. Tests:
  `TestSessionReportPaneBusy`, `TestModelActualPayload`.
- **Pending questions** come from `agent/hooks/ask.py`'s req/ans files, read by `session_report` and
  **never by pane scraping**; a transcript scan is the already-answered fallback.
- **`panePrompt`** — the TUI's OTHER blocking dialog (tool-permission / plan approval). No hook
  intercepts it and it writes nothing to the transcript, and while it is up the pane shows neither
  the interrupt hint nor the mode footer, so `paneBusy` alone reads it as **idle**.
  `parse_pane_prompt` reads it off the mode marker's capture as `{prompt,
  options:[{number,label,selected}], detail}`.
  - **Nothing keys on the wording.** A line run is a dialog only with ALL of: options numbered 1..N
    (N≥2), exactly one carrying `❯`, a `?` line directly above, and **no mode footer below** (the
    footer rides the composer, which a dialog replaces). `detail` is the block above the question:
    blanks never close it, a rule does.
  - Answered by `answerPanePrompt` → `answer_pane_prompt`, which **re-reads the pane first** and
    drops the answer unless that number is on screen NOW — a stray digit prepends itself to the next
    message. Both `liveState`s check the prompt ahead of the busy read. Tests:
    `TestParsePanePrompt`, `TestAnswerPanePrompt`, `pane-prompt` in `server.test.js`,
    `panePromptHtml` in `chat.test.js`.

## PR status, comment delivery and conflict nudges

See `.claude/rules/agent-prs.md` — merge-readiness and CI rollup, the two transcript-keyed ledgers,
`_scan_pr_line` attribution, the GitLab/ADO dispatch, and the comment/conflict replies typed back
into a session. All of it lives in `hub-agent.py`.

## Expected-restart "updating" status (XERK-29)

- An agent update takes the host down like a crash, so `_handle_shutdown` (SIGTERM/SIGINT)
  **announces an EXPECTED restart before the silence**: `POST /api/agents/<host>/updating`
  (`_announce_updating`, agent-token authed, best-effort short-timeout). One signal covers both
  paths. Hub-side it sets `a.updating` with a `UPDATING_GRACE_MS` deadline, which `serializeAgent`
  surfaces **only while the host is silent**; the dashboard renders it as a distinct amber state
  (`agentState`/`hostCard`).
- The native updater leaves `~/.turma/updating.json` (`UPDATING_FLAG_PATH`) which the handler reads
  to enrich the announcement (`reason:"update"`); a container update leaves no file and announces
  `reason:"restart"`. Next boot clears a stale flag. Tests: `TestUpdatingAnnounce`.

## Usage aggregates, ledger and subscription limits

See `.claude/rules/agent-usage.md` — the per-repo/host token aggregates, the worktree→repo
attribution ledger that outlives a session, and the subscription-limit snapshot plus the probe that
captures it. All of it lives in `hub-agent.py` and `hooks/statusline.py`.

## Board sources, triage and ticket sessions

See `.claude/rules/agent-board.md` — the Jira/Azure DevOps collectors, the two tracker writes, repo
triage and ticket-backed sessions. All of it lives in `hub-agent.py`.

## Session activity summaries

- Each session gets a few-word "name", generated **agent-side** by the host's authenticated `claude
  -p` (Haiku default) — reusing the mounted login, so **no external API, key, or endpoint**.
  `_start_summary()` runs it detached (cwd `~/.turma`, **no `--settings`**, so it never loads the
  guard or explores the repo); `_poll_summaries()` reaps it through `clean_summary()`. Tuned by
  `SESSION_SUMMARY_MODEL`/`SESSION_SUMMARY_TIMEOUT_SEC`. `rcName` is still fixed at spawn.
- The attempt fires at spawn from the initial prompt, or — for a bare/quick-spawned session — from
  its **first user prompt read straight out of the transcript**: `_seed_summaries()` pulls it via
  `_first_user_text()` (skipping the header, `isMeta` caveat entries and `<command-…>` wrappers).
  That read is **channel-agnostic and the only path that names a bare session**, whose first prompt
  is typed into the ttyd terminal and **never reaches `send_input`**. `send_input` still starts one
  immediately as a fast path for the FIRST attempt — retries belong in the seeder.
- Naming is **bounded-retry, not one-shot**: an attempt can come back empty for reasons unrelated to
  the session (nonzero exit, empty reply, timeout, rate limit on the shared login), which one
  attempt would make permanent. `_summary_attempts`/`_summary_due` gate every path on *unnamed +
  attempts left + past the backoff* (`SUMMARY_MAX_ATTEMPTS`, `SUMMARY_RETRY_BACKOFF_SEC`, persisted
  as `summaryAttempts`/`summaryRetryAt`) and **armed at launch** so a restart mid-attempt neither
  loops nor loses the retries owed. The legacy one-shot `summaryStarted` still reads as "one attempt
  spent".
- A session with no prompt yet stays unnamed, spends **no** attempt, and looks again next beat. Once
  exhausted it degrades to the label/worktree fallback.
- **Manual rename**: `setSummary` → `set_summary()` through `clean_manual_summary()` (first line,
  whitespace collapsed, capped to `SUMMARY_MAX_CHARS` — but **NOT** word-capped or stripped of
  quotes/punctuation). It sets `summaryManual`, which pins the card and stops a still-in-flight
  `claude -p` from clobbering it in `_finish_summary`. A blank rename clears the name and unpins —
  the only way back to auto-naming. Works on a stopped session too.
- Tests: `TestCleanSummary`, `TestSetSummary`, `TestSessionSummaries`, `TestSummaryDue`,
  `TestSeedSummaries`.

## GitHub block and cloning

- The `github` block reports whether the host has a usable `gh` login and that login's clonable
  repos (the user's own, their orgs, any extra `GH_CLONE_OWNERS`), plus in-flight/recent `clones`.
  The availability flag is **`available`** and the hub passes the block through untouched, so
  **every client must gate its clone UI on that exact key** (XERK-126).
- A `clone` command `git clone`s a validated `owner/repo` (**allowlist-checked before it reaches
  git**) into `REPOS_ROOT` as a detached subprocess, reaped across later beats. Private-repo auth
  rides the system git credential helper (`gh auth git-credential`).
- **Multiple git sources (XERK-155)** — `gitSources` heartbeats the EXTRA sources beside `github`
  (contract unchanged, so gh-gated features keep reading it): the board's ADO org
  (`_apis/git/repositories`) and a GitLab host (`GITLAB_URL` + `GITLAB_TOKEN`,
  `/api/v4/projects?membership`; **clones over SSH via the mounted `~/.ssh` — the token only
  LISTS**). Listings are per-source keep-last-good; a clone command carries `{repo, source?}` and
  the agent resolves the URL from its OWN cached listing (free text stays the GitHub fallback).
  Triage candidates / `repoOptions` / clone-on-demand consume the union, tagged `source`. Tests:
  `TestGitSources`, `clone.test.js`, `CloneTest.kt`.
- **Non-GitHub git creds (XERK-54)** — the image wires a SECOND system credential helper after gh:
  `store --file=/root/.git-credentials`. gh serves github.com; every other host falls through to
  `store`, reading an **optional** bind mount. **gh is first** so github.com always gets a fresh
  token; an unmounted file is a no-op. The guard denies writing `~/.git-credentials`. **Native
  inherits the host's git config untouched.** Tests: `test_entrypoint.sh`,
  `test_denies_non_github_git_credential_writes`.
- **Azure DevOps git auth (XERK-54, XERK-226)** — reuses the board PAT. At boot `entrypoint.sh` runs
  `hub-agent.py --wire-azure-git`, setting a URL-scoped `http.<azure_base>.extraHeader`
  (`azure_git_auth_config()`) — **`extraHeader`, not a credential helper / `http.proactiveAuth`**:
  self-hosted TFS/Server often issues no Basic challenge a helper can act on, and the image's git
  (2.39) predates `proactiveAuth` (2.46). Written `--system` as root before the privilege drop;
  **exports `AZURE_DEVOPS_EXT_PAT`** so `az repos` authenticates too. Non-fatal; logs the host never
  the token. Container-only. Tests: `TestAzureGitAuthConfig`, `test_entrypoint.sh`.

## `tunnel-agent.js`

See `.claude/rules/agent-tunnel.md` — the reverse tunnel, control-channel liveness and the live
working footer. It is a JS re-implementation of `hub-agent.py`'s parsers; the parity contract is in
`CLAUDE.md`.

## Transcript entry blocks

- Each tail entry carries a rich **`blocks[]`** beside the flat `text` (`_entry_blocks` /
  `entryBlocks`), preserving the thinking text, tool_use inputs and tool_result outputs that
  `_entry_text` flattens away, so the chat UI can render + verbosity-filter each component.
- Turns that are ABOUT the session rather than someone talking are classified: `[Request interrupted
  by user…]` → `{t:"interrupt"}` (`_entry_text` keeps the raw line); the `!` shell passthrough's
  `<bash-*>` turns → the same command/command_output shapes as slash commands (name `!`, via
  `_parse_local_command`; **stderr only wins when non-empty**); `system`/ `away_summary` →
  `{t:"away_summary"}` with the "(disable recaps in /config)" hint stripped (`_away_summary_text`)
  (**every other system subtype stays dropped**); `tool_reference` inside a tool_result → `[tool:
  <name>]`.
- **A known tool call carries its reviewable payload on the tool_use block** (`_tool_use_detail` /
  `toolUseDetail`): Edit → `edit`, Write → `content`, ExitPlanMode → `plan`, any tool's
  `description` → `desc`. An AskUserQuestion card is titled with its question text(s), not the input
  JSON.
  - **SendUserFile → `files[]`+`caption`** (XERK-221): image/SVG as a base64 data URI
    (`kind:"image"`), a `render` HTML page as raw markup (`kind:"html"`), else a name chip
    (`kind:"file"` — attach/oversize past `SEND_FILE_MAX_BYTES`/missing/other, **never opened**).
    Only image/html paths are read, bounded, so a delivery can't bloat the frame or leak bytes.
- Two more markers: `system`/`compact_boundary` → `{t:"compact_boundary", trigger, preTokens,
  postTokens}`, and a `pr-link` entry → `{t:"pr_link", url, number, repo}`. pr-link entries carry no
  uuid, so the feeds synthesize a stable id (`_entry_id`/`entryId`) — the client merge drops id-less
  entries. **A PR marks its FIRST sighting only**: Claude Code re-stamps pr-links atop every user
  turn, so one PR yields ~6 entries differing only in `timestamp`. That id keys on the **URL alone**
  and the client dedups by URL over the whole conversation; folding only *consecutive* repeats is
  not enough.
- **Still-queued prompts ride beside the entries, not inside them**: a message typed mid-turn
  becomes a user entry only when dequeued, so both feeds fold the transcript's `queue-operation`
  entries FIFO (`_fold_queue_op` / `foldQueueOp`: enqueue → dequeue → remove-by-content) and ship
  survivors as `queued[]`. A window opening mid-sequence errs toward hiding; older agents send no
  `queued`. Tooling payloads ride the same queue, so **display filtering happens at REPORT time**
  (`_queued_display` / `queuedDisplay`), never at fold time, which desyncs the dequeues.
- Blocks ride the live tail (tight caps), on-demand `history` and the archive push (both
  `BLOCK_CAPS_FULL`) — the one place inclusion widens: a tool_result-only turn, dropped by
  `_entry_text`, is kept when it has blocks. Only `transcript_tail` stays text-only.
  Already-archived bytes are never re-parsed.
- Tests: `TestEntryBlocks`, the tool-detail/marker cases in `tunnel-agent.test.js`.

## Archive sync

- The agent **ships every INACTIVE session's transcript to the hub's durable archive** so history
  survives this host being wiped/offline. `_archive_manifest()` enumerates ended transcripts (every
  ledger slug's `*.jsonl`, minus any backing a running session); the hub replies with per-transcript
  byte cursors (`archiveHave`), and `_archive_deltas()` POSTs the missing append-only deltas
  (pre-parsed through `_entry_text`), bounded per chunk/beat.
- Rows are dated by `_last_activity_ts` — the last message's own transcript timestamp, **NOT the
  file mtime** (XERK-73), which a synced `~/.claude` or backup restore inflates to copy-time. Falls
  back to mtime only when no entry is timestamped. Tests: `TestArchiveSync`, `TestLastActivityTs`,
  `TestResumableReport`.

## Hooks

See `.claude/rules/agent-hooks.md` (scoped to `agent/hooks/**`). `build_guard_settings()` writes
`~/.turma/guard-settings.json`, passed to every launch as `--settings`, wiring both hooks plus the
`permissions.deny` credential-store rules. Policy is in `CLAUDE.md`.

## `entrypoint.sh` and the bundled toolchains

See `.claude/rules/agent-image.md` (scoped to `agent/entrypoint.sh` + `agent/Dockerfile`) — the boot
sequence, the start-time Claude Code check, and the cloud/Android toolchains the image bundles.

## `native/` — non-Docker install

See `.claude/rules/agent-native.md` (scoped to `agent/native/**`). **Nothing under `native/` edits
the shared runtime files**; the one enabling change is `resume_on_boot`'s adopt path.
