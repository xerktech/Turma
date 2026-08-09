# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Editing This File

Keep it merge-friendly and small — several PRs are usually open against it at once, and it is loaded
into every session's context.

- **HARD LIMIT: this file MUST stay under 150,000 characters.** Check with `wc -m CLAUDE.md` (`-m`,
  not `-c` — the file is full of multibyte glyphs). **CI enforces it**: the `CLAUDE.md size limit`
  step in `code-scan.yml` fails any PR at or over the limit, and `CLAUDE.md` is in that workflow's
  path filter so a docs-only PR still runs it. Past the limit Claude Code stops loading the file in
  full, so every session on the fleet silently loses the guidance it exists to carry. The ceiling
  does not move — when you approach it, **consolidate before adding**, and prefer replacing text
  over appending to it.
- One idea per line, wrapped at ~100 characters; nested bullets and headings, not run-on paragraphs —
  a single multi-kilobyte line conflicts every open PR.
- When adding to a component, add a **new bullet** rather than extending an existing one.
- **Document current behavior, not its history.** State the rule and the one-line reason it must not be
  undone — don't narrate the bug it replaced, retell the symptom, or make the same point twice. A
  decision that supersedes an old one **replaces** that text; it does not append beside it.
- Keep `Tests:` pointers to file + test-name; skip per-case descriptions.

## What This Repo Is

Turma is the source and CI for the Claude Code agent fleet used with the TrueNAS-based home lab: a
**one-container-per-host** agent image that scans a git root and multiplexes many worktree-backed Claude
Code Remote Control sessions, plus a central dashboard ("turma") that lists each host's repos,
spawns/kills those sessions, and monitors them.

It builds two images and pushes them to GHCR; the running stack comes from the sibling
**DockerOps** repo (`compose/turma-truenas.yaml`, via Portainer GitOps).

## Session Model

One agent container per host, multiplexing sessions across every repo it scans.

### Hosts and repos

- Mounted at a git root (`REPOS_ROOT`, e.g.
  `/mnt/data/Docker/git`), scanned one level deep for git repos. Alongside them it advertises a
  **repos-root pseudo-repo** (`ROOT_REPO_NAME`, shown as "⌂ Repos root").

### Spawning a session

- Pick a repo and spawn a **session**, backed by a randomly-named git worktree (dir keyed on the
  session `<id>`) under `REPOS_ROOT/.turma/worktrees`, checked out **detached HEAD** off the latest
  default branch (`origin/HEAD` → main → master), best-effort fetched. The composer can override the
  base.
- **The app creates no branch of its own.** The running agent creates and names its own branch when
  ready; that live branch (read from the worktree's git HEAD) shows on the session card, "detached"
  until then. A ticket session is told its branch NAME but still cuts it itself, so the worktree stays
  detached.
- The session runs its own `claude --remote-control` in its own tmux (`agent-<id>`) + loopback ttyd,
  with an optional initial task prompt and optional `--model`/`--permission-mode`.
- Many sessions run concurrently (up to `MAX_SESSIONS`), including several on one repo via separate
  worktrees. Each registers in claude.ai/code as `<host>-<repo>-<worktree-or-label>`.
- All spawn options are validated agent-side (allowlisted base refs, fixed model/permission enums), so
  nothing free-form reaches the shell. The worktree dir and `agent-<id>` tmux are the canonical
  internal keys; a label is presentational only.

### The session queue (XERK-14)

- A spawn that can't run RIGHT NOW is **queued, not refused** — an ordinary registry record with
  `status:"queued"` and no worktree/tmux/ttyd yet. `spawn()` splits into the record-build and
  `_provision_session()` (worktree + tmux + ttyd + naming), which a queued session later runs unchanged.
- Three orthogonal `queuedReason`s, each re-checked by the drainer: **capacity**, **awaiting-clone**
  (its repo is being cloned on demand), **root-busy** (another root session holds the one root slot).
- The queue/run decision is made BEFORE the record is appended, so counts exclude the session being
  added (else a root sees itself as root-busy and capacity is off by one). Prompt/base-ref stash as
  `_pendingPrompt`/`_pendingBaseRef` for `_provision_session` to consume.
- `_drain_queue()` runs every heartbeat: oldest-first, **at most one per beat** (provisioning launches
  claude against the one shared `~/.claude` login), head-of-line skipped not blocking. A failed
  on-demand clone fails the session; a clone job lost to a restart re-triggers from `awaitCloneOwner`.
- Capacity rides the heartbeat as **`capacity` = {maxSessions, running, queued, free, rootRunning}**
  (`_capacity_payload`); `free` never goes negative.
- Queued sessions are killable (Cancel), nothing to tear down. resume-on-boot skips them (the drainer
  picks them up), as do archival/usage/PR scans. Surfaced as `session.queuedReason`/`queuedAt`.
- **The queue applies to every spawn path; only TICKET spawns split across hosts.** An explicit "+ New
  session" queues on the host whose card was clicked.
- Tests: `TestSessionLifecycle`, `TestSpawnTicket` in `test_hub_agent.py`; `sessions.test.js`.

### Repos-root sessions

- Spawning against the repos-root pseudo-repo runs `claude` directly in `REPOS_ROOT` — spanning every
  repo — with **no worktree and no branch**, so the base-branch option doesn't apply. Kill/delete tear
  down only the processes; `REPOS_ROOT` is never touched.
- All root sessions share that one cwd (hence one claude project slug + Remote Control bridge pointer),
  so **at most one root session runs per host at a time** (enforced on spawn/start/resume). Killable and
  resumable like any session.
- That ONE project slug dir accumulates EVERY root session's transcript, so "this session's
  conversation" is a real question here and needs the pin below.

### Which transcript is a session's

- Every launch **pins claude's session id** — `--session-id <uuid4>` minted in `_launch_tmux`, or the
  `--resume` id for a rejoined one — persisted as `claudeSessionId`. Claude Code names the transcript
  after it, so a session's conversation is `<claudeSessionId>.jsonl` under its cwd's project slug,
  known by name from before its first byte.
- `_session_transcript_path()` is the one resolver every surface goes through (heartbeat signals + tail,
  `history`, subagent resolution, summary seeding, closed record's `transcriptId`, `--resume` target);
  the hub heartbeats the id so `tunnel-agent.js`'s live tail (`watch` → `sessionTranscript`) agrees.
  **Never go back to a newest-mtime rule** (XERK-6): a root session's dir holds every root session's
  transcript, so the newest is the PREVIOUS session's until the new claude writes.
- **A pinned session with no transcript on disk resolves to nothing.** Never add a newest-mtime fallback
  — an empty conversation before the first turn is the truth.
- A session launched by an agent predating the pin carries no id and keeps the newest-mtime rule.
- A watch is sent once (first watcher / control reconnect) and held, so `rearmMovedWatches` re-sends it
  when a watched session's `transcriptId` moves. Only "Restart (clear context)" moves it; without the
  re-arm that session's chat freezes on the pre-restart conversation.
- Two things stay slug-keyed, sharing one identity across a root session's neighbours: archival's
  `_running_slugs` exclusion and the summary/date an archived transcript inherits
  (`_session_meta_by_slug`).
- Tests: `TestRootSessionIsolation` in `test_hub_agent.py`, `sessionTranscript` in
  `tunnel-agent.test.js`, `server.test.js`.

### Kill, resume, delete

- **Killing** drops the registry record but KEEPS its worktree (uncommitted work survives),
  conversation and token-usage history (transcripts live under `~/.claude/projects`, keyed by worktree
  path), moving it to the Sessions page's **Ended sessions** list.
- On the way out, `_remember_closed` **snapshots onto the closed record** the `prUrls` this session
  opened and its `transcriptId` — `_forget_session_caches` drops both moments later, so the snapshot is
  the only thing keeping an ended session's PR chips reachable. The PR *status* stays in
  `pr_status_cache` (`refresh_pr_status` counts closed records referenced).
- The closed history is a **cache of what a kill knew, not the record that it happened**, capped at
  `CLOSED_PER_REPO` per repo. **Anything that must survive belongs on the durable side** — the
  transcripts under `~/.claude` (which `_resumable_report()` re-derives from, keeping a killed session in
  the Ended list across a restart), the hub's archive, and `~/.turma`.
- **`~/.turma`'s durability is the HOST's to provide, and no code here may assume it.** A container must
  bind-mount it or it is the image's writable layer, recreated on update; every ledger still reconciles
  from disk rather than trusting itself.
- Each repo's **"Resume"** picker lists **every prior Claude session for the repo** whose origin cwd is
  resumable on this host — `repo.resumable` from `_resumable_report()`: killed/deleted/pruned Turma
  sessions, repo-dir dev runs, and older ones aged out of `closed.json`.
- Resuming relaunches `claude --resume <transcript id>` **cwd'd at that transcript's origin path**,
  re-creating a deleted/pruned worktree there first: Claude scopes id lookup to a repo's live worktrees
  + repo dir, so the origin must exist for `--resume` to resolve (`resume_transcript`). A dev-machine
  session synced through the shared `~/.claude` has a foreign cwd and stays view-only.
- **Delete** (on a stopped session) also removes the worktree; since the app owns no branch, any the
  agent committed survives.

### Migrating a session to another agent (XERK-101)

- **Move a running session to another agent in the SAME org.** The conversation moves; committed work
  rides git; uncommitted work stays on the source (KILLED, so resumable).
- The hub can't touch a worktree and agents are outbound-only, so a migration is composed hub-side from
  agent commands + a hub-brokered relay of the **RAW transcript bytes** (what `claude --resume` needs and
  the archive lacks): `exportSession` packs the transcript (`+ subagents/`, truncated to its last
  complete line) and POSTs the gzip-tar to `POST /api/agents/<host>/migrations/<id>/blob`, queueing
  `importSession` on the target (recording `importCmdId`), which unpacks it under the origin cwd's slug
  and resumes via `_resume_at_cwd`; the target reporting up (`spawnCmdId` == `importCmdId`) makes
  `advanceMigrations` KILL the source and finish. Followed on the Sessions page via `migrations`.
- `_resume_at_cwd` is shared by `resume_transcript` and `import_session`. Hosts may mount `REPOS_ROOT` at
  DIFFERENT paths, so `import_session` first `_localize_migrated_cwd`s the source's worktree path onto
  THIS host's `REPOS_ROOT` (the `.turma/worktrees/<repo>/<dir>` tail is mount-independent) — both the
  unpack slug and the re-created worktree use that local cwd, and without the remap a cross-mount move
  wedges in `importing` forever. The tar extract guards against `..`/absolute members (untrusted — it
  crosses a host boundary).
- **A migrated session keeps its PR chips**, re-derived from the transcript rather than carried in the
  command: the per-beat scan PRIMES a resumed transcript's byte offset to EOF, so the `gh pr create`
  events sit past it. `_resume_at_cwd` calls `_seed_prs` once at launch to scan the whole transcript
  (same `_scan_pr_line` rule) and seed `session_pr_urls` + `prUrls` + `pr-sessions.json`, keyed by the
  PRESERVED transcript id. Shared by `resume_transcript`. Idempotent.
- Blob relay is agent-authed; `POST .../sessions/<id>/migrate {host}` validates same-org + online +
  repo-cloned + running/non-root/has-conversation, single-flight per session. State is in-memory; a hub
  restart mid-move aborts it, leaving the source intact. **The target must already have the repo
  cloned** (v1); clone-on-demand and dirty worktree files are follow-ups.
- Tests: `TestMigrateSession` (agent), `server.test.js`, the Move cases in
  `sessions.test.js`, `eligibleMoveTargets` in android `SessionsTest`.

## `agent/` — per-host headless agent image

Currently Claude Code; the name is agent-generic so it can host other agents later.

### `hub-agent.py` — session manager and heartbeat in one process

- Scans `REPOS_ROOT` for repos; owns a persisted session registry (`~/.turma/sessions.json`); executes
  hub-issued commands riding the heartbeat reply (at-least-once, `cmdId` de-dup); drives each session's
  worktree + tmux + ttyd; heartbeats the repo list, one record per session, and a container-log tail.
- On boot it auto-resumes sessions that were `running`:
  - `resume_on_boot` **adopts** a session whose claude tmux is still alive (tmux/ttyd outlive a manager
    restart) — skips the relaunch, only re-ensures the ttyd, so the native agent updates in place without
    stopping sessions. Falls back to `--resume` relaunch only when the tmux is gone.
  - ttyd is adopted by port when the persisted `ttydPid` is alive; `_kill_ttyd` reaps that pid so an
    adopted ttyd isn't leaked on stop/delete. Tests: `TestResumeOnBootAdopt`.

### Commands

- `spawn` / `kill` / `start` / `restart` / `delete` — session lifecycle. `resume` — a killed session
  back under its own id.
- `resumeTranscript` — resume ANY prior transcript by id; `_resumable_report()` heartbeats each repo's
  list. Tests: `TestResumableReport`, `TestResumeTranscript`, `TestTranscriptCwd`.
- `input` / `history` / `answerQuestion` — the chat composer + glasses client.
  - `input`/`send_input` puts the message into the pane and **guarantees it survives a compaction**
    (XERK-47), which can drop one queued mid-turn: every sent message goes on the record's
    `pendingInputs` outbox, and `_poll_pending_inputs` (every beat, no-op without one) makes it
    at-least-once:
    - compactions are counted by `_pending_scan` from the transcript's own `compact_boundary` **system
      entry**, never by scraping the pane; a message is **reaped on delivery** or **left in flight**
      while still in the folded live queue;
    - it is **re-sent** only when a NEW compaction happened since it was sent (`compactBase` rose) AND
      it's neither, AND the pane has settled to idle (`_pane_busy` False, not None) — that gate makes the
      resend **duplicate-safe**. Bounded by `PENDING_INPUT_MAX_ATTEMPTS`/`PENDING_INPUT_TTL_SEC`, one per
      beat; `delivered` matches by text alone, biased AGAINST a resend;
    - the outbox is internal (not heartbeated), cleared on restart-clear-context; text typed into the
      raw ttyd terminal bypasses `send_input` and isn't covered. Tests: `TestPendingScan`,
      `TestPollPendingInputs`, `TestSendInput`.
  - **PASTED, not typed** (`_type_into_pane`, XERK-227): `load-buffer -` + `paste-buffer -d -p` + Enter
    — `send-keys` is a tmux command argument, refused past ~16 KiB, which a pasted log exceeds (the raw
    terminal never had that limit). `-p` brackets only for an app that asked (Claude Code
    does), so **newlines survive as ONE message**; control bytes are stripped, else one ends the paste
    and the rest reads as KEYSTROKES. **Nothing truncates silently**: the fallback CHUNKS its send-keys,
    the agent REFUSES past `INPUT_MAX_CHARS` (100k) and heartbeats it as **`inputMaxChars`**, and the hub
    caps a message at the receiving host's figure (`inputCapFor`; **4k when unreported** — that agent
    predates the paste and clips the tail untold), 413ing with `limit` → "Too long — max N".
  - **File attachments ride this command** (XERK-234): the 📎 stages a file on the HUB (memory-only,
    TTL'd) and `input` carries the ids; `send_input` fetches each into `~/.turma/uploads/<sessionId>/`
    — never a worktree, where it would read as the uncommitted work `prune`/`delete` key on
    (`build_guard_settings` pre-approves `Read` there) — then prefixes the message with their PATHS,
    so the COMPOSED text is what lands on the outbox above. The name is sanitized on BOTH sides (it is
    joined onto a path); one that fails to transfer is NAMED, never dropped. **`uploadMaxBytes` is the
    cap AND the capability flag** (like `inputMaxChars`): an agent reporting none drops the uploads
    untold, so the hub refuses and the composers hide the 📎. Tests: `TestStoreUploads`/
    `TestSendInputUploads`, `uploads:`/`attachments:` in `server.test.js`/`chat.test.js`, `UploadsTest`.
- `interrupt` — a single Escape to the pane: cancels the in-flight generation/tool call, session and
  conversation intact. Deliberately NOT gated on `paneBusy`. Tests: `TestInterrupt`.
- **Operator messages are exempt from the `history` window** (XERK-186): the read stays bounded (last
  4 MiB + `HISTORY_MAX_MSGS`, capped inside `_history_entries`; callers must not re-slice), but on any
  cut every user-authored text turn in the whole transcript folds back in ahead of the window
  (id-deduped, `HISTORY_USER_MSGS` backstop) — tool traffic otherwise evicts them.
  Tests: `TestHistoryCommand`.
- `setSummary` — rename a session (see "Session activity summaries").
- `setModel` — switch a running session's model live, **for that session only** (XERK-33).
  - `set_model` drives Claude Code's /model picker — clear the input line (C-u), open it, parse rows +
    ❯ cursor (`parse_model_picker`), arrow to the target, press `s` ("use this session only"). Never
    `/model <name>`, whose argument form ALSO saves the pick as the host's login-wide default.
  - The arrows go **one press at a time, each verified by re-reading the ❯** (`_await_picker_step`), so
    a dropped/doubled key can't land `s` on the wrong row. The record updates only on the TUI's own "Set
    model to…" confirmation (`_await_model_confirmation`).
  - Gated on a **fresh** pane-busy read, but a busy pane **defers, never drops**: the pick lands as
    `sess["pendingModel"]` (persisted, heartbeated) and `_apply_pending_switches` applies it on the first
    idle beat. Backs out with Escape when the picker doesn't appear or has no row for the target (the
    bracketed `[1m]` aliases have none). Validation is `resolve_model` against the static aliases +
    probed list. Tests: `TestSetModelMode`, `TestParseModelPicker`.
- `setMode` — switch a running session's permission mode live, as a **closed loop**: press Shift+Tab,
  read the footer's mode marker back (`parse_pane_mode`), repeat until the target reads back or the cycle
  wraps to its start (a logged no-op).
  - Never a computed press count: the REAL cycle is account- AND model-dependent, and the record's
    "current" goes stale when the operator cycles by hand. Blind math survives only as
    `_set_mode_blind`, the fallback for a marker the parser can't read.
  - **What is stored is always what was read**, so the record can't lie about the mode. No busy gate:
    BTab types nothing into the input line and the TUI cycles modes mid-generation.
  - Tests: `TestParsePaneMode`.
- `clone` — see "GitHub block and cloning".
- `refreshJira` — the /board manual refresh: re-poll now instead of waiting out `JIRA_REFRESH_EVERY`.
  Re-checks `jira_configured()`, so an unconfigured host stays at zero Jira calls.
- `prune` — per-repo cleanup: removes worktrees merged into the latest default branch (skipping any
  backing a session or holding uncommitted changes) and local branches merged into it, summarised on
  the heartbeat.
- `jiraIssue` — fetch one issue on demand. `spawnTicket` — start a session to WORK a ticket.
  `setJiraRepo` — the operator's repo for a ticket, overriding the guess. `subagentHistory` — open a
  background subagent's transcript.

### Heartbeat

- **Repo list**, most-recently-active first (`lastActivity` = the later of the repo's newest commit and
  newest session activity); the repos-root pseudo-repo is pinned first, never ranked.
- **One record per session**: git state, per-session token usage, live signals, new PR links and PR
  status, plus a **container-log tail**.
- The build's **own version** (`agentVersion`, shown in the host header): `agent_version()` reads
  `TURMA_AGENT_VERSION` (baked at build time), else the `VERSION` file `native/install.sh` stamps beside
  `hub-agent.py`, else the repo-root `VERSION`, else `null`. Tests: `TestAgentVersion`.
- The **coding agent** it runs (`codingAgent` = `{name, version}`, the header's "Agent" row):
  `coding_agent()` splits `claude --version`'s `"<version> (<product>)"`, preferring the product name
  over the `CODING_AGENT_NAME` default — the NAME is reported because the image is agent-generic. The raw
  string still rides as `claudeVersion` for older hubs (`codingAgent()` in `index.html`). Tests:
  `TestCodingAgent`, `host-header.test.js`.
- The **login's real model list** (`models` = `{available, defaultLabel, at}`, XERK-33), probed from the
  CLI: `claude -p "/model"` prints "Current model: <label>" plus the alias list, parsed by
  `parse_model_probe` — so the hub's menus offer what this login can run, with no config to drift.
  - A detached one-shot on the models cadence (`MODELS_REFRESH_EVERY`, beat 0 covering boot;
    `MODELS_RETRY_EVERY` until first success), same shape as the summary/triage helpers (cwd=REGISTRY_DIR,
    no --settings, reaped by `_poll_models_probe`). A failed/unparseable probe **keeps the previous
    list**; `None` until the first success (hub falls back to its static menu).
  - `resolve_model(model, extra)` accepts probed aliases beyond the static four, charset-checked
    (`SPAWN_MODEL_RE`; the bracketed `[1m]` variants never reach a launch command line).
  - `modelActual` is the per-session counterpart: the incremental transcript scan (`_scan_entry_line` —
    ONE json parse feeding both the PR scan and `_scan_model_entry`) folds each assistant entry's
    `message.model` and the "Set model to X" stdout, newest winning. Persisted; seeded once from the
    transcript tail for older records (`_seed_model_actual`).
  - Tests: `TestParseModelProbe`, `TestModelsProbe`, `TestScanModelEntry`,
    `TestSessionReportModelActual`, `TestSeedModelActual`, `TestModelActualPayload`,
    `TestInternalToolSlugModelProbe`.
- The **shared Claude login's health** (`claudeAuth`, XERK-98) — `claude_auth_status()` reads
  `~/.claude/.credentials.json` (`CLAUDE_CREDS_PATH`) every beat:
  `{present, needsLogin, expiringSoon, expiresAt, refreshExpiresAt, subscriptionType, at}` (epoch ms).
  The **REFRESH token** is the signal, NOT the access token: it lapses only when claude hasn't
  refreshed inside its ~30-day window, i.e. when a human must `claude /login`. `needsLogin` =
  missing/unreadable file, no `claudeAiOauth`/access token, or a past refresh expiry; `expiringSoon` =
  within `CLAUDE_AUTH_WARN_MS` (3d). Unknown refresh expiry reads healthy; a MISSING login can't
  heartbeat, so it surfaces as the offline alert. Chip via `claudeAuthBadge` / `🔑` pill
  (`FleetScreen.kt`). Tests: `TestClaudeAuthStatus`.

#### Live-session signals

- `paneBusy` — a working/idle read, the **primary** activity signal (transcript freshness is the
  `null` fallback). `_pane_busy` captures the tmux pane and looks for Claude Code's "esc to
  interrupt" hint, accurate through a long silent tool call unlike transcript-mtime.
  `true`/`false`/`null`; markers overridable via `TURMA_PANE_BUSY_MARKERS`.
  - **Busy is read from three shapes, not the full hint alone** (XERK-130): a narrow pane ellipsizes it,
    so `_busy_from_capture` also accepts the mode line's truncated remnant (`PANE_BUSY_TRUNC_RE`) and the
    column-0 spinner line (`PANE_SPINNER_RE`, requiring the gerund's ellipsis so an idle pane's
    completed-turn line can't fake busy). Both glyph-anchored; mirrored in `tunnel-agent.js`'s
    `paneShowsBusy`. Tests: `TestPaneBusy`, `tunnel-agent.test.js`.
  - **Busy→idle flicker is suppressed at the source** (`_stable_pane_busy`, XERK-42): the spinner
    repaint's sub-frame gap reads idle mid-turn (20s of false idle + a bogus push). Busy is trusted
    instantly; idle re-confirms once after `TURMA_PANE_IDLE_CONFIRM_SEC` (0.2s, 0 disables), only on the
    busy→idle EDGE. Tests: `TestStablePaneBusy`.
- `modeActual` — the permission mode the TUI is REALLY in, off the footer's mode marker
  (glyph-anchored so quoted text can't match — `parse_pane_mode`, read beside the stable busy in
  `_pane_status`). `_session_payload` **reconciles the stored `permissionMode` to it** each beat (the
  operator can cycle modes by hand), and it feeds `setMode`'s closed loop. Tests: `TestParsePaneMode`,
  `TestSessionReportPaneBusy`, `TestModelActualPayload`.
- **Pending questions** — surfaced by `agent/hooks/ask.py`'s req/ans files, read by `session_report`,
  never by pane scraping. A transcript scan is the already-answered fallback.
- **`panePrompt`** — the TUI's OTHER blocking dialog (tool-permission request / plan approval): no hook
  intercepts it, it writes nothing to the transcript, and while it is up the pane shows neither the
  interrupt hint nor the mode footer, so `paneBusy` alone reads it as idle. `parse_pane_prompt` reads it
  off the mode marker's capture as `{prompt, options:[{number,label,selected}], detail}`.
  - Nothing keys on the wording. A line run is a dialog only with ALL of: options numbered 1..N (N≥2),
    exactly one carrying the `❯` cursor, a `?` line directly above, and **no mode footer below** — the
    footer rides the composer, which a dialog replaces. `detail` is the block above the question: blanks
    never close it, a rule does.
  - Answered by `answerPanePrompt` → `answer_pane_prompt`, typing the option digit — but it **re-reads the
    pane first** and drops the answer unless that number is on screen NOW (a stray digit prepends itself
    to the next message). Both `liveState`s check it ahead of the busy read. Tests:
    `TestParsePanePrompt`/`TestAnswerPanePrompt`, `pane-prompt` in `server.test.js`, `panePromptHtml` in
    `chat.test.js`.

#### PR status

- State (Open/Draft/Merged/Closed), CI rollup (passing/failing/pending) and mergeability
  (MERGEABLE/CONFLICTING/UNKNOWN) of every PR a session opened, on the `PR_STATUS_REFRESH_EVERY` cadence.
- The card's **single ✓/✗/● mark is merge READINESS, not CI** (`ready`, from `_merge_ready`): a conflict
  blocks on its own, and a ✓ requires an affirmative MERGEABLE — a just-opened PR's UNKNOWN is `pending`.
  Conflicts only matter while a PR could still land: MERGED/CLOSED reports CI alone; a PR with **no
  checks** keeps its no-mark unless it CONFLICTS. `checks`/`checkCounts` stay pure CI beside it; all
  four renderers (web ×3, android's `PrBadge`) read `ready`, falling back to the CI half for older agents.
- Cached by URL in `pr_status_cache`, attached as `session.prs`; kept after the session stops. **Durable
  across an agent restart** (XERK-15): a running session mirrors `session_pr_urls` onto its record
  (`prUrls`) and rehydrates the map on boot — and **for ENDED sessions and the pill too** (XERK-13),
  keyed by transcript id so it outlives the registry/closed record, via two ledgers beside the ticket one:
  - `pr-sessions.json` (`PR_LEDGER_PATH`, `transcriptId -> {urls, at}`): written by `_remember_prs` when
    the scan finds a URL, backfilled from closed history, read by the **resumable scan** (`_ledger_prs`)
    — the only channel left once a closed record ages out.
  - `pr-status.json` (`PR_STATUS_LEDGER_PATH`, `url -> status`): `refresh_pr_status` persists the cache
    and seeds it back at boot — an ended session is never re-polled, so without this its chip degrades
    to a bare link. Ledgered URLs count as `referenced`.
- **Which PRs are "a session's"** is decided by `_scan_pr_line`, deliberately narrow: a URL counts only
  when it comes back in a **creating call's own `tool_result`** (`PR_CREATE_RE`) — the one event that
  says this session OPENED it. `gh pr create`; `glab mr create` / `git push -o merge_request.create`
  (XERK-162); `az repos pr create` (XERK-226), whose JSON carries no link — `_azdo_created_pr_url` builds
  one from `repository.webUrl` + `pullRequestId` when the result printed no link itself. Call and result
  land in different beats, so pending tool_use ids carry across (capped); the scan parses whole lines.
  - Cost: a PR opened another way (a subagent, an MCP tool, the web UI) gets no chip. Widen only by
    teaching `_scan_pr_line` another creation event, never by scanning loose text.
- **A GitLab MR (XERK-162) and an ADO PR (XERK-226) answer everywhere a GitHub PR does**: `pr_status`/
  `_pr_comment_events` dispatch by URL to `mr_status`/`azdo_pr_status` and their `_*_comment_events`, in
  identical shapes, each URL polled only through the source that can answer it (`_pr_source_ok`;
  unreachable → bare link chip). ADO reuses the BOARD's PAT and has no CI rollup, so `checks` is the
  **CI-bearing branch POLICY evaluations only** (`AZDO_CI_POLICY_IDS`): reviewer/work-item policies would
  read a PR awaiting a human as "CI pending". `mergeable` is `mergeStatus`, conflicts alone. The image
  bundles `glab` and az's `azure-devops` extension.
- Tests: `TestPrStatus`, `TestMr*`, `TestAzdoPr*`, `TestRefreshPrStatus`, `TestPrLedger`; `prFooterChip`
  in `chat.test.js`, `sessions.test.js`.

#### PR comment delivery (XERK-49)

- **A reply asking for corrections on a session's PR is typed back into the session that opened it.**
  `_poll_pr_comments` runs on the PR cadence, for **running sessions only**, over their OWN PRs
  (`session_pr_urls`), through **`send_input`** — inheriting the compaction-survival outbox (XERK-47) and
  the queue mid-turn.
- `_pr_comment_events(url, self_login)` gathers **three channels** — conversation comments, review bodies
  and inline review-thread comments; a bare approve is dropped. One call covers all three on GitLab
  (notes) and ADO (threads), minus that tracker's own system notes. `_pr_ref` numbers it `#12` on
  GitHub, `!12` on GitLab and ADO (there `#12` is a WORK ITEM).
- **Baseline-on-first-sight, then deliver only new + not-self.** A PR's whole comment set is recorded
  silently the first beat it's seen (`prCommentBase`, capped `PR_COMMENTS_SEEN_MAX`); after that only NEW
  keys not the agent's own (`viewerDidAuthor`, else an identity compare) are typed in. Bounded at
  `PR_COMMENTS_MAX` PRs per beat; a fetch failure (→ None) leaves the baseline UNTOUCHED.
- **A conflicting PR is fixed by the session that opened it, unasked** (XERK-223): `_poll_pr_conflicts`
  types `_pr_conflict_message` (MERGE `origin/<base>`, never a rebase/force-push) off the `mergeable`
  `refresh_pr_status` just cached. `prConflicts` = `{url:{at,attempts}}` bounds the nudging per PR;
  MERGEABLE/closed clears and re-arms it, **UNKNOWN does neither** — that is what a just-pushed fix looks
  like, and clearing on it would grant unlimited retries.
- Disable with `TURMA_PR_COMMENTS=0` / `TURMA_PR_CONFLICTS=0`. Tests: `TestPrComment*`,
  `TestPollPrComments`, `TestPollPrConflicts`, `TestPrConflictMessage`.

### Expected-restart "updating" status (XERK-29)

- An agent update takes the host down like a crash, so the manager **announces an EXPECTED restart
  before it goes silent**: its SIGTERM/SIGINT handler (`_handle_shutdown`) POSTs
  `POST /api/agents/<host>/updating` (`_announce_updating`, agent-token authed, best-effort
  short-timeout). One signal covers both paths (both restart via SIGTERM to the manager).
- The native updater also leaves `~/.turma/updating.json` (`UPDATING_FLAG_PATH`, reason + target version)
  which the handler reads to enrich the announcement (`reason:"update"`). A container update leaves no
  file, announcing a generic `reason:"restart"`. Next boot clears a stale flag.
- Hub-side, the announce sets `a.updating = {at, until, reason, version}` with a `UPDATING_GRACE_MS`
  (5 min) deadline. `serializeAgent` surfaces `updating` **only while the host is silent** (`!online`)
  and within the grace window — a returned host is just `online` again, a stuck update falls to `offline`
  past `until`. The offline sweep suppresses the "host offline" alert while `updating` holds.
- The dashboard renders it as a distinct amber state (`agentState`/`hostCard`); Android/glasses predate
  the field and keep showing `offline`.
- Tests: `TestUpdatingAnnounce`, `test_turma_agent_update.sh`, `server.test.js`.

### Usage aggregates and the attribution ledger

- The heartbeat carries **persistent usage aggregates independent of the live registry**: a per-repo
  `repoUsage[]` and a merged host-level `usage`, computed on the slow usage cadence by re-parsing *every*
  known transcript under `~/.claude/projects` (`repo_usage_report()`). Each `repoUsage` entry carries a
  `remoteKey` (normalized git origin via `normalize_remote()`) so the hub can unify a repo across hosts.
- The per-model breakdown **excludes `<synthetic>`** (and any `<...>` model): Claude Code stamps entries
  it fabricates itself with that model and an all-zero usage block, so `_accumulate_usage` keeps them out
  of `acc.models`, else the usage page lists a phantom model that ran nothing. Their tokens still fold
  into the grand totals. Mirrors `_scan_model_entry`'s guard.
- A durable worktree→{repo, remote, slug} **attribution ledger** (`~/.turma/repo-usage.json`) keeps a
  transcript traceable to its repo after its session and worktree are gone, so **usage history survives
  kill/delete/prune**. Written at spawn via `_remember_usage`, backfilled from registry/closed history,
  reconciled each usage beat by `_reconcile_orphan_transcripts()`, pruned only when a transcript dir
  disappears. `repo_usage_report()` folds only slugs the ledger names, so reconciliation is what makes it
  cover *every transcript on disk*.
- Any orphan is adopted best-effort, in order:
  1. exact repo + git origin, when its worktree still exists;
  2. else the repo from the worktree-shaped project slug;
  3. else the repo from the transcript's own recorded `cwd` (`_repo_from_transcript_cwd` — Claude Code
     stamps the real un-slugified working dir, so its final segment names the repo);
  4. else the root bucket (`ROOT_REPO_NAME`) — there is no "(other)" bucket.
- **A derived name (case 2/3) only stands when it names a repo this host scans** (XERK-147): both
  heuristics are lossy, and unvalidated they mint phantom repos; a miss falls to case 4.
  `_sanitize_junk_repo_entries` retires persisted junk the same way each beat (a stored name stands
  only with a recorded git remote or a scanned repo; no-op when the repo scan is empty, so an
  unreadable `REPOS_ROOT` can't fold real history into root). The usage page renders `(root)` as
  **Root**, folding older agents' `(other)`/`?` in (`normRepo`/`repoLabel`, android `UsageViewModel`).
- **The `REPOS_ROOT` slug is never `internal`**: the check reads only the newest transcript, and a root
  session where the operator typed only `/model` reads exactly like the models probe (the sanitizer lifts
  such a tombstone).
- **No real session is excluded.** The one carve-out is the manager's OWN internal `claude -p` helpers
  (naming, triage, models probe), which run with `cwd=REGISTRY_DIR` yet write a transcript
  into the shared `~/.claude/projects` — else the reconciler adopts the agent's overhead as a phantom
  repo (XERK-27). `_is_internal_tool_slug` knows them by the registry dir's own slug, or a
  harness's temp slug by `INTERNAL_TOOL_PROMPT_SIGS`; the models probe's prompt is a slash command
  (which `_first_user_text` skips), so it goes by `_first_command_name` = `/model`. Such a slug is
  **tombstoned** (`{internal:true}`), skipped by `repo_usage_report`/`_archive_manifest`;
  `_sanitize_internal_tool_entries` retires entries earlier builds adopted.
- **This ledger is also the archive's input** (`_archive_manifest` enumerates ledger slugs), so
  reconciliation *intentionally* widens archival too — decouple them only if the two scopes should
  diverge.
- Tests: `TestReconcileOrphanTranscripts`, `TestSanitizeJunkRepoEntries`, android `UsageViewModelTest`.

### Jira block

- Optional. With user-scoped Jira Cloud creds (`JIRA_SITE`/`JIRA_EMAIL`/`JIRA_TOKEN`), the agent
  heartbeats the tickets assigned to that user, polled slow (`collect_jira`: active work plus a bounded
  window of recently-Done, two capped queries), shaped by `_shape_issue`.
- Unset creds = feature off (zero Jira HTTP, `available:False`); writes only the operator's own create
  (XERK-137) and transition (XERK-138).
- **On-demand issue detail.** Description/comment bodies are too big to heartbeat per ticket, so a
  `{type:"jiraIssue", issueKey}` command (allowlist-checked against the `PROJECT-123` grammar) makes
  `_stage_jira_issue` call `fetch_jira_issue`; the result rides the next beat as `jiraIssueResults`.
- **ADF flattening.** Jira returns rich text as ADF, which `adf_text`/`adf_plain` flatten agent-side.
  `_shape_issue_detail` adds description, the newest `JIRA_COMMENT_MAX` comments (+ `commentTotal`),
  people, and full labels, each capped.
- Every failure path stages a result carrying an `error` instead of raising. Tests: `TestAdfText`,
  `TestShapeIssueDetail`, `TestFetchJiraIssue`, `TestStageJiraIssue`.

### Azure DevOps block (XERK-43) — the board's second source

- **The board is source-agnostic; Azure DevOps is a drop-in second source emitting the SAME wire
  contract as Jira.** With a PAT in the env (`AZDO_URL` + `AZDO_TOKEN`, optional
  `AZDO_PROJECT`/`AZDO_USER`/`AZDO_API_VERSION`) the agent polls the work items assigned to the PAT's
  owner into the same `jira` heartbeat block. `source:"jira"|"azure"` rides the block for the few places
  UI copy varies.
- **An agent serves exactly ONE org** (a host is Jira or Azure, never both).
  `board_source()`/`board_configured()`/`collect_board()`/`fetch_board_issue()`/`board_site_key()`/
  `valid_issue_key()` are the source-dispatch shims every gate goes through; everything downstream is
  source-agnostic and reads `self.jira` unchanged.
- **Self-hosted is the point.** `AZDO_URL` is any base — `https://tfs.company.com/DefaultCollection` or
  `https://dev.azure.com/org`. PAT auth is Basic with empty username (`:PAT`). Reads WIQL, work items,
  states/fields; writes only the operator's own create and System.State PATCH.
- **siteKey keeps the org/collection PATH** (`normalize_azure_site` → `dev.azure.com/myorg`), unlike the
  Jira host-only key, else every cloud org merges into one board. Percent-encoded into
  `/api/jira/<siteKey>/...`. `board.js`/`Board.kt` `orgName` takes the last path segment for a slashed
  key, else strips `.atlassian.net`.
- **Work-item ids are bare integers**, so `AZDO_KEY_RE`/`valid_issue_key` and the hub's `isIssueKey`
  accept `^[0-9]+$` alongside `PROJECT-123`. Ticket sessions get a human branch base `<project>-<id>`
  (`ticket_branch_base`), not a bare number.
- **State → column.** Azure's per-type `stateCategory` metastate is read from the states API when
  reachable (`_azure_state_map`, cached per project+type), falling back to a static name map, then `todo`
  — mapping to todo/inprogress/done as Jira's `statusCategory` does. The raw name rides as `status`.
- **HTML, not ADF.** `collect_azure` (WIQL → batch GET) and `fetch_azure_issue` ($expand=all + comments)
  mirror the Jira collectors; `azure_html_to_text`/`azure_plain` (stdlib `HTMLParser`) is the ADF
  flattener's counterpart. A comments-endpoint failure degrades to no comments.
- Tests: `TestNormalizeAzureSite`, `TestAzureBase`, `TestCollectAzure`, `TestShapeAzureItem`,
  `TestAzureCategory`, `TestAzureHtmlToText`, `TestFetchAzureIssue`, `TestBoardSourceDispatch`,
  `TestSpawnTicket`; `server.test.js`; `board.test.js`,
  android `BoardTest.kt`.

### Jira repo triage (`repoGuess`)

- Each heartbeated ticket carries an optional **`repoGuess`** — which repo that ticket's work belongs in.
- Decided **agent-side** by the host's already-authenticated `claude` in headless print mode
  (`claude -p`, Haiku default), same detached-subprocess/reap shape as the session summaries, so there is
  **no external API, key, or cost env**. It runs there because this host is the only place the three
  inputs meet — Jira creds, scanned repos, the `gh` sweep.
- `_triage_candidates()` builds the choice list as the host's cloned repos (marked `[cloned]`, which the
  prompt says to prefer) **plus every repo its `gh` login can clone**. The reply is
  **allowlist-validated back against that list** by `_parse_triage`. The guess is purely presentational;
  no ticket text reaches a shell, path, or URL.

#### The triage ledger

- Decisions are cached in a persisted ledger (`~/.turma/jira-repos.json`, keyed `<siteKey>/<issueKey>`)
  so triage runs **once per ticket, not per beat**.
- Each entry holds two independent things, and **keeping them apart is what makes the cache safe**: the
  **decision** (repo/cloned/reason/`at` + `ticketFp`/`candFp` — the question it *answers*) and the
  **attempt run** (`attempts`/`retryAt` + `tryTicketFp`/`tryCandFp` — the question being *asked*).
- `_triage_stale()` re-triages when the ticket's text changes (`_ticket_fingerprint` — deliberately NOT
  `updated`, which moves on any field edit) or the candidate set does (`_candidates_fingerprint` — repo
  names + cloned-ness ONLY; `_triage_candidates` sorts the gh tail by name before truncating so an
  `updatedAt`-ordered cut can't move the surviving names). Cloning a repo re-triages; a **manual pin** is
  the exception (`_triage_due` skips it, no attempt spent).
- Two rules from the split, worth not undoing:
  - **Stale means "re-triage this", never "stop showing it"** — the old answer keeps rendering until a
    replacement lands, else one clone or gh sweep blanks every chip on the board.
  - **`attempts` is scoped to the question, not the ticket's lifetime** — a changed ticket/candidate set
    gets a fresh budget, else a lifetime counter permanently bans re-triage and freezes a wrong chip.

#### Triage scheduling and failure handling

- `_start_jira_triage` only updates its candidate repos from a **successful** gh sweep
  (`self.triage_gh_repos`): `refresh_github` blanks the block to `repos:[]` on any error,
  indistinguishable from "no repos", and triaging against it would re-run the whole board twice.
- Batched (`JIRA_TRIAGE_BATCH` tickets per call, **one job in flight**), attempted every beat. Failed
  attempts are **bounded-retry with backoff**
  (`JIRA_TRIAGE_MAX_ATTEMPTS`/`JIRA_TRIAGE_BACKOFF_SEC`, armed up-front so a restart mid-batch neither
  loops nor loses the retries owed).
- `_parse_triage` draws a sharp line between the model's two non-answers: an **explicit `null`** is a
  verdict → `repoGuess.repo = null` ("no repo fits"), while anything **unreadable** (an unparseable
  shape, an off-list repo name) is a **failed attempt** whose key is omitted, leaving the ticket
  undecided for retry. Conflating them paints a confident chip the model never asserted, left there for
  good since decisions aren't re-triaged; an untriaged ticket carries **no `repoGuess`** at all.
- `_apply_triage()` re-stamps the ledger onto tickets after every poll and merge (`collect_jira` builds
  fresh dicts, else chips blank each slow beat). Tuned by `JIRA_TRIAGE_MODEL` (default `haiku`) /
  `JIRA_TRIAGE_TIMEOUT_SEC`.
- Tests: `TestTriageCandidates`, `TestTriageFingerprints`, `TestParseTriage`, `TestJiraTriage`.

#### Manual repo override

- The operator can **set a ticket's repo by hand** from the detail panel: `setJiraRepo` →
  `set_jira_repo()`, writing a ledger entry flagged `manual`. A human's answer wins: `_triage_due` skips
  a manual entry; `_finish_jira_triage` drops a reply for a ticket pinned while its batch was in flight;
  `_prune_triage_ledger` evicts manual entries last (a pin cannot be regenerated).
- Three answers, deliberately distinct — which is why `auto` is a separate field, not an absent `repo`:
  `{repo:"<name>"}` pins that repo; `{repo:null}` is a manual **"no repo fits"**; `{auto:true}`
  **releases** the pin, re-triaging with a **fresh** attempt budget.
- **Un-cloned repos are offerable**. The name is **allowlist-checked
  host-side against that host's own candidates**, and the stored repo/cloned/`nameWithOwner` are read
  off the **candidate**, never the request. That list is heartbeated as **`jira.repoOptions`**
  (`_jira_payload`) via `_refresh_triage_candidates` — one list serving the model's prompt and the
  board's picker, so the picker offers exactly what `set_jira_repo` accepts.
- `_apply_triage` re-reads clone state from the **current** candidates rather than trusting the decision:
  a pin never re-triages, so a stored `cloned:false` would outlive a clone forever. A repo absent from
  the list keeps its stored state (the list blanks on a failed gh sweep).
- `POST /api/jira/<siteKey>/<issueKey>/repo` **fans out to every host reporting that org** — including
  OFFLINE ones — because the ledger is per-host while the board merges by `siteKey`, so a host that
  misses the pin can silently revert it. `set_jira_repo` is idempotent. This writes to the **agent's
  ledger, not Jira**. A repo the union offers but this host rejects is log-only (the panel self-corrects
  within `REPO_SETTLE_MS`); `cloned` is host-relative.
- A pin also decides **where a ticket session spawns** (`spawn_ticket` re-derives the repo from this
  host's ledger, where a pin outranks the model; still re-checks `scan_repos()`).
- Tests: `TestSetJiraRepo`, `repoPickerHtml`/`repoFieldHtml` in
  `board.test.js`, `server.test.js`.

### Jira ticket sessions

- The board's per-card **start button** spawns a session to work a ticket: a `{type:"spawnTicket",
  issueKey}` command → `spawn_ticket()`, agent-side for the same reason triage is. **The hub only
  ROUTES**, sending just the issue key; the rest is re-derived from LOCAL state — the repo from this
  host's triage ledger (still in `scan_repos()`), the ticket from a fresh `fetch_jira_issue`.
- The fetched ticket becomes the **initial prompt** (`build_ticket_prompt`: fields, description, the
  newest `TICKET_PROMPT_COMMENTS` comments, its attachments) — the session has no board creds of its
  own, so that text is all it sees, which the prompt says.
- **A ticket's own attachments come with it** (XERK-242): downloaded into the uploads tree on
  XERK-234's terms, paths named in the prompt (hence `ticket_detail=`, not `prompt=`). The rules not to
  undo are on `fetch_board_attachment`. Tests: `TestStoreTicketAttachments`.
- The ticket is carried on the record as `ticket` = `{key, siteKey, url, summary, branch}`, persisted,
  heartbeated, surviving kill/resume. **That record IS the ticket ↔ session link** — no hub-side ticket
  store; the board reverse-indexes the fleet payload.
- The record only answers **while it exists**, so a durable `transcriptId → ticket` ledger
  (`~/.turma/jira-sessions.json`, `TICKET_LEDGER_PATH`) answers afterwards. `_remember_ticket` writes it
  in `_launch_tmux`, where a session's conversation is named, so **every** launch records it (idempotent,
  no-op without a ticket; restart-clear-context adds its NEW transcript beside the old).
  `_backfill_ticket_ledger()` adopts older sessions from registry + closed history, keying a pre-pin
  closed record on its resolved `transcriptId`, bounded `TICKET_LEDGER_MAX` oldest-first on a first-seen
  `at`, and deliberately **not** pruned against on-disk transcripts (one archived off this host is still
  the answer). Tests: `TestTicketLedger`.
- A ticket-backed session is **named from its ticket** (`"PROJ-123 <summary>"`, via
  `clean_manual_summary`) instead of paying a `claude -p`. Refusals log and return like spawn's own; a
  failed fetch raises to `handle_commands`, which logs and acks. Nothing is ever written to Jira.
- Tests: `TestSpawnTicket`, `TestBuildTicketPrompt`.

#### Ticket branch naming

- The branch is **decided at spawn** (`_reserve_ticket_branch`) and injected into the session's appended
  system prompt (`TICKET_BRANCH_PROMPT`) — the -1/-2 suffix needs a branch scan the agent has no reason
  to do right.
- `next_ticket_branch` hands out the bare ticket key, else the first free `key-1`/`key-2`/…, filling a
  gap left by a deleted branch rather than counting how many existed.
- **"Taken" is the union of git and the registry**: `branch_names()` reads local heads + remote branches
  (after a short-bounded fetch), while a session that hasn't branched YET owns its name with git knowing
  nothing — so two sessions started back-to-back aren't both told `PROJ-123`.
- **The app still creates no branch**: the worktree stays `--detach`. This decides the NAME only; the
  agent still cuts it from the refreshed remote default. A resume re-tells the persisted name rather than
  reserving a fresh one.
- Tests: `TestNextTicketBranch`, `TestBranchNames`, `TestSpawnTicket`.

### GitHub block and cloning

- The agent heartbeats a `github` block: whether it has a usable `gh` login and, if so, that login's
  clonable repos (refreshed slow; the user's own repos, their orgs, and any extra `GH_CLONE_OWNERS`),
  plus any in-flight/recent `clones`. The availability flag is **`available`** and the hub passes the
  block through untouched, so every client must gate its clone UI on that exact key (XERK-126).
- A `clone` command `git clone`s a validated `owner/repo` (allowlist-checked before it reaches git)
  into `REPOS_ROOT` as a **detached subprocess** (reaped across later beats); the new repo then joins
  the scan. Private-repo auth rides the system git credential helper (`gh auth git-credential`).
- **Multiple git sources (XERK-155)** — `gitSources` heartbeats the EXTRA clone sources beside `github`
  (contract unchanged — gh-gated features read it): the board's ADO org (`AZDO_URL`/`AZDO_TOKEN`,
  `_apis/git/repositories`) and a GitLab host (`GITLAB_URL` + `GITLAB_TOKEN`,
  `/api/v4/projects?membership`; clones over SSH via the mounted `~/.ssh` — the token only LISTS).
  Listings are per-source keep-last-good; a clone command carries `{repo, source?}` and the agent
  resolves the URL from its OWN cached listing (free text stays the GitHub fallback). Triage candidates /
  `repoOptions` / ticket clone-on-demand consume the union, entries tagged `source`; the clone bar groups
  per source ("Clone a repo" when >1). Tests: `TestGitSources`, `clone.test.js`, `CloneTest.kt`.
- **Non-GitHub git creds (XERK-54)** — the image wires a SECOND system credential helper after gh:
  `store --file=/root/.git-credentials`. gh serves github.com; every other host falls through to
  `store`, reading cached git credentials from an **optional** bind mount. gh is first so github.com
  always gets a fresh token; an unmounted file is a no-op. The guard denies writing
  `~/.git-credentials`. **Native inherits the host's git config untouched.** Tests:
  `test_entrypoint.sh`, `test_denies_non_github_git_credential_writes` in `test_guard_settings.py`.
- **Azure DevOps auth (XERK-54, XERK-226)** — an ADO org already gives the agent a PAT for the board
  (`AZDO_TOKEN` + `AZDO_URL`), so everything else reuses it. At boot `entrypoint.sh` runs
  `hub-agent.py --wire-azure-git`, setting a URL-scoped `http.<azure_base>.extraHeader` (Basic `:<PAT>`,
  `azure_git_auth_config()`) for plain git — **`extraHeader`, not a credential helper /
  `http.proactiveAuth`**: self-hosted TFS/Server often issues no Basic challenge a helper can act on,
  and the image's git (2.39) predates `proactiveAuth` (2.46). Written `--system` as root before the
  privilege drop; **exports `AZURE_DEVOPS_EXT_PAT`** so `az repos` authenticates too. Non-fatal, logs
  the host never the token. Container-only. Tests: `TestAzureGitAuthConfig`, `test_entrypoint.sh`.

### `entrypoint.sh`

- Creds preflight, then launches the tunnel and `exec`s the session manager as PID 1 — the container
  stays up with zero sessions. See "Run-as identity" for the uid resolution it performs first.

### `native/` — non-Docker install (WSL/Linux)

- Installs the SAME `hub-agent.py`/`tunnel-agent.js`/`hooks/`/`tmux.conf` onto a host and reuses its
  tooling, instead of the container. See `agent/native/README.md`.
- `turma-agent` — the launcher: the runtime half of `entrypoint.sh` minus every container/privilege bit
  (runs as the invoking user). Sources the config, defaults `CLAUDE_PROJECTS_ROOT=$HOME/.claude/projects`
  (the one env decoupling from the container's hardcoded `/root`) and `DEVICE_NAME=$(hostname)`, idles on
  missing claude creds, reconciles + supervises the tunnel, execs the manager.
- The launcher puts **`$HOME/.local/bin` on PATH itself** (XERK-94): a systemd --user unit doesn't
  inherit the login shell's PATH, so claude at the prefix install.sh blesses (`npm config set prefix
  ~/.local`) is otherwise unreachable and every session dies on exec. A missing claude is a **loud,
  log-only** warning at start — install-time `have claude` checks run in the login shell and can't catch
  it.
- The config is **validated before it is sourced**, and a bad one **idles** rather than exiting:
  - The launcher `.`-sources the env file, so a non-assignment line RUNS (a YAML-style `JIRA_SITE: "x"`
    exits 127 and takes the launcher down under `set -e`). The check is anchored on the `=` directly
    after the name (`JIRA_TOKEN: "a=b"` carries an `=` in its VALUE); `export` stays legal.
  - **Idling, never `exit 1`.** To systemd an exit is indistinguishable from one worth restarting in 5s
    — the exit IS the loop. `--preflight` is the one exception (exits 1). Nothing is sourced then.
  - The report carries **line numbers and key names, never values** (`chmod 600`, holds
    `TURMA_TOKEN`/`JIRA_TOKEN`).
- The tunnel is **supervised** here, re-exec'd as `turma-agent --tunnel-supervisor` (a respawn loop):
  a native install is the only place its runtime can be MISSING — node is an apt prereq, not a baked
  layer. (The container's simpler loop is in `entrypoint.sh`, XERK-34; tests `test_entrypoint.sh`.)
  - The node check lives INSIDE the loop, so installing node heals the terminals (`terminalOnline`)
    within one `TUNNEL_RETRY_SEC`; fire-and-forget would make a missing node silent AND permanent.
  - The supervisor's pkill key is PREFIX-scoped like `tunnel-agent.js`'s; the launcher reaps the
    supervisor BEFORE the tunnel (else the old loop respawns the just-killed tunnel), and
    `turma-agentctl stop` reaps it too. PATH/config/supervisor tests: `test_turma_agent.sh`.
- The launcher exports **`TURMA_MANAGER_PID=$$`**, which `exec` makes the manager's own pid, so the
  tunnel's poke (`pokeHeartbeat`) signals the right process. Its PID-1 fallback is right only in the
  container. Tests: `pokeHeartbeat` in `tunnel-agent.test.js`.
- `install.sh` — idempotent installer (`--verify`/`--uninstall`): auto-installs prereqs (apt + npm +
  pinned static ttyd), lays files into a prefix keeping `hub-agent.py` and `hooks/` siblings, writes a
  `chmod 600` config, wires the service, writes `$PREFIX/VERSION`, then `try-restart`s it (`enable
  --now` does nothing to a running service).
  - **`have_sudo` asks** when it must, rather than probing `sudo -n` only (which makes a password-sudo
    host look sudo-less and skips every apt prereq under `curl … | bash`). Gated on `[ -t 2 ]`; cached.
  - It must never become `curl … | sudo bash`: the install belongs to the invoking user, only prereqs
    need root. Tests: `test_install_sudo.sh`, wired into `code-scan.yml`.
- `bootstrap.sh` — the `curl … | bash` front door for a host with no checkout: resolve the newest native
  tarball, verify its sha256, unpack to a temp dir, `exec` the `install.sh` inside it (not copied into
  `$PREFIX`, so `--verify`/`--uninstall` re-run through it). Resolves by the version in the **asset's
  filename**, never the release tag (a carried-forward build keeps its older name, so a tag-derived name
  would 404). Anonymous and parser-free (runs BEFORE install.sh apt-installs python3). Tests:
  `test_bootstrap.sh` (wired into `code-scan.yml`).
- Service: a systemd **user** unit with `KillMode=process` (a restart signals only the manager, leaving
  tmux/claude/ttyd/tunnel alive), plus a nohup `turma-agentctl` fallback for WSL without systemd. Both
  preserve running sessions via the adopt-on-boot path.
  - `turma-agentctl` keys its pidfiles on `XDG_RUNTIME_DIR` but falls back to `~/.turma` unless that dir
    exists and is **writable** — on a WSL-without-logind host the var points at a `/run/user/<uid>`
    logind never created, so a plain `${XDG_RUNTIME_DIR:-…}` orphans the old manager and spawns a
    second. Tests: `test_turma_agentctl.sh`.
- `turma-agent-update` — self-updater: reads the unified release stream, comparing the release
  `manifest.json`'s **agent-native component version** (never the tag), verifies the sha256, swaps files,
  restarts the manager. Falls back to the legacy `agent-native-v*` stream. Driven by a systemd timer or
  `--loop` poller. Tests: `test_turma_agent_update.sh`.
- **Auth on that read is an optimisation, never a precondition** (XERK-151): `all_tags`/`download_assets`
  try `gh`, then `$GH_TOKEN`, then **anonymously** — requiring auth pins a host with no GitHub login at
  its installed version forever. The asset endpoint + `Accept: application/octet-stream` serves a public
  release unauthenticated. It exports the **same `$HOME/.local/bin` PATH the launcher does** (XERK-94):
  its unit sets no PATH, so a `gh` installed there is invisible to the timer.
- Not installed natively: cloud CLIs (aws/az/terraform) + PowerShell + docker CLI + the Android
  toolchain; the container is for those.
- Container ⇄ native parity (XERK-34): the same runtime files run in both, so the session model,
  heartbeat, Jira/PR/usage/archive features are identical. Known deltas:
  - Heartbeat `startedAt` is docker's StartedAt where docker can answer, else the manager's OWN start
    time — never empty (`TestStartedAt`), keeping the restart-loop alert (keyed on `startedAt` CHANGING)
    and card Uptime working natively. The log tail stays container-only.
  - **native**: the bundled tmux.conf only takes effect at `/etc/tmux.conf`/`~/.tmux.conf`; a host with
    its own conf loses truecolor and the OSC 52 copy chain (hub-agent launches bare `tmux`).
- Nothing under `native/` edits the shared runtime files; the one enabling change is `resume_on_boot`'s
  adopt path.

### `tunnel-agent.js`

- The reverse tunnel; the hub's `{open,port}` selects which per-session ttyd to bridge, over one per-host
  control channel. That channel also carries the **live transcript tail**: on `{watch,worktreePath}` /
  `{unwatch}` it tails that session's newest transcript every ~1s and pushes `{tail,entries}` deltas
  back. It's a JS re-implementation of hub-agent.py's `transcript_tail`/`_entry_text`, parity-tested in
  `tunnel-agent.test.js`. Tailing runs only while a client watches.

#### Control-channel liveness

- **Both ends prove the channel rather than assume it**: the heartbeat is a fresh HTTP POST while the
  tunnel is one long-lived socket, so they die independently — a wedged tunnel reads as a healthy host
  (`online` with `terminalOnline:false`, every session "terminal offline").
- The hub beats every `CONTROL_PING_EVERY_MS` (30s) and drops a channel silent for `CONTROL_DEAD_AFTER_MS`
  (90s); the agent reconnects when nothing arrives for `TURMA_CONTROL_IDLE_TIMEOUT_MS` (90s).
- It sends **two pings, and needs both**: the **protocol ping** (`0x9`), auto-ponged by every agent, is
  liveness the hub gets from OLD agents for free (how it reaps a half-open channel to a host that died
  without a FIN); the **app-level `{ping}`** text frame is the only liveness a browser-style WebSocket's
  `onmessage` can observe. Older agents ignore the unknown key.
- **A dead hub does not necessarily close the socket.** Through Cloudflare the edge holds the agent's end
  open after the origin dies, so no `close` fires — silence, not a close event, is what the agent acts on.
- The agent's watchdog is armed **only once the hub has proven it app-pings**, so a new agent against an
  older hub keeps the old behaviour instead of reconnect-looping.
- `retire()` is idempotent per-socket and **never waits on `ws.close()`**: it schedules the reconnect
  itself. Supervision cannot cover any of this — the native supervisor only respawns on process **exit**,
  and a wedged socket never exits.
- Tests: `tunnel-agent.test.js` and `server.test.js`.

### Live working footer and agent list

- The control channel also carries the session's **live working footer** scraped from the tmux pane
  (`parsePaneLiveTurn` → `{turn,text,status}`): the in-progress assistant text plus
  `status = {verb, up/down token counters, elapsed, hint}`; an expanded agent-manager list adds
  `status.agents[]` (`parseAgentList`: `{sel,type,label}` rows).
- **`turn` text only ever moves forward** (`resolveLiveText`): activity summaries ("Running/Ran 1
  shell command…") strip off the REFLOWED tail (`stripActivityTail`); already-committed text is
  suppressed (`committedDupe`, skeleton compare — the pane renders markdown away); and UNCOMMITTED
  prose HOLDS through empty/tool-bullet frames until the tail owns it (at a block boundary the tool
  bullet paints before the entry lands — clearing into that gap blinks).
- A single-frame **busy→idle blip is held one poll** before the bar clears (`liveTurnDecision`,
  XERK-42): a spinner-repaint gap reads idle mid-turn: the first idle frame after busy is skipped,
  the second confirms. Busy is never held.
- **Clicking a subagent row opens that background agent's own transcript**: a
  `{type:"subagentHistory", sessionId, agentType, label}` command resolves the row to its
  `subagents/agent-<id>.jsonl` via the main transcript's Task `tool_use` + its result text
  (`agentId: <id>`) — `_resolve_subagent`/`_stage_subagent_history`, matching type + description
  (exact else prefix; trailing pane-ellipsis stripped, XERK-130). Results ride the next beat
  (`subagentHistoryResults`).
- Tests: `TestResolveSubagent`, `TestStageSubagentHistory`; `parseAgentList`, `liveTurnDecision`,
  `stripActivityTail` in `tunnel-agent.test.js`.

### Transcript entry blocks

- Each tail entry carries, alongside the flat `text`, a rich **`blocks[]`** array (`_entry_blocks` in
  hub-agent.py, mirrored by `entryBlocks` in tunnel-agent.js — same parity contract), preserving the
  thinking text, tool_use inputs and tool_result outputs that `_entry_text` flattens away so the chat UI
  can render + verbosity-filter each component.
- Turns that are ABOUT the session rather than someone talking are classified:
  - `[Request interrupted by user…]` marker turns → `{t:"interrupt"}`; `_entry_text` keeps the raw line.
  - The `!` shell passthrough's `<bash-input>`/`<bash-stdout>`/`<bash-stderr>` turns parse into the same
    command/command_output shapes as slash commands (name `!`), via `_parse_local_command`. stderr only
    wins when non-empty.
  - A `system`/`away_summary` entry → `{t:"away_summary"}`, a collapsed card, with the "(disable recaps
    in /config)" hint stripped (`_away_summary_text`); every other system subtype stays dropped.
  - `tool_reference` blocks inside a tool_result flatten to `[tool: <name>]` lines.
- **A known tool call carries its reviewable payload on the tool_use block** (`_tool_use_detail` /
  `toolUseDetail`): Edit → `edit {old,new,replaceAll?}` (a −/+ diff), Write → `content`, ExitPlanMode →
  `plan` (markdown, open by default), any tool's `description` → `desc`. An AskUserQuestion card is
  titled with its question text(s), not the input JSON.
  - **SendUserFile → `files[]`+`caption` (XERK-221)**: the agent embeds each delivered file — image/SVG
    as a base64 data URI (`kind:"image"`), a `render` HTML page as raw markup (`kind:"html"`), else a name
    chip (`kind:"file"`: attach/oversize past `SEND_FILE_MAX_BYTES`/missing/other, never opened).
    `renderToolFiles` shows images inline + HTML in a fully sandboxed iframe (open by default). Only
    image/html paths are read, bounded, so a delivery can't bloat the frame or leak bytes.
    py `_send_user_file_detail` ↔ js `sendUserFileDetail`.
- Two more turns-about-the-session become status markers: a `system`/`compact_boundary` entry →
  `{t:"compact_boundary", trigger, preTokens, postTokens}`, and a `pr-link` entry →
  `{t:"pr_link", url, number, repo}`. pr-link entries carry no uuid, so the feeds synthesize a stable id
  (`_entry_id`/`entryId`) — the client merge drops id-less entries. **A PR marks its FIRST sighting
  only**: Claude Code re-stamps a session's pr-links atop every user turn, so one PR yields ~6 entries
  differing only in `timestamp`. That id keys on the **URL alone** and `buildItems` dedups by URL over
  the whole conversation, which covers the archive/ended view too (no merge step); folding only
  *consecutive* repeats is not enough.
- Tests: `TestEntryBlocks` in `test_hub_agent.py`, the tool-detail/marker cases in
  `tunnel-agent.test.js` and `chat.test.js`.
- **Still-queued prompts ride beside the entries, not inside them**: a message typed mid-turn becomes a
  user entry only when dequeued, so the live tail and `/history` fold the transcript's `queue-operation`
  entries FIFO (`_fold_queue_op` / `foldQueueOp`, enqueue → dequeue → remove-by-content) and ship
  survivors as `queued[]` beside `entries`. A window opening mid-sequence errs toward hiding; older
  agents send no `queued`. Tooling payloads ride the same queue, so display filtering happens at REPORT
  time (`_queued_display` / `queuedDisplay`), never at fold time (which desyncs the dequeues).
- Blocks ride the live tail (tight caps), on-demand `history` and the archive push (both
  `BLOCK_CAPS_FULL`) — the one place inclusion widens: a tool_result-only turn, dropped by
  `_entry_text`, is kept when it has blocks; only `transcript_tail` stays text-only. Already-archived
  bytes are never re-parsed.

### Archive sync

- The agent **ships every INACTIVE session's transcript to the hub's durable archive** so history
  survives this host being wiped/offline. On the slow usage cadence `_archive_manifest()` enumerates
  ended transcripts (every ledger slug's `*.jsonl`, attributed via the usage ledger, minus any backing a
  running session); the hub replies with per-transcript byte cursors (`archiveHave`), and
  `_archive_deltas()` POSTs the missing append-only deltas (pre-parsed through `_entry_text`) to
  `POST /api/agents/<host>/archive/<transcriptId>`, bounded per chunk/beat. Tests: `TestArchiveSync`.

## `turma/` — central dashboard

Reached over the Cloudflare tunnel (the operator's public hub URL); port 8300 on the LAN.

### Shared site chrome (`turma/public/nav.js`)

- The header and phone bottom-nav are built by one module (`nav.js`, dual-exported for tests) and are
  **identical on every page** — pages hand-roll neither. Each mounts them with
  `<header class="site-header" id="siteHeader" data-page="…" data-sub="…">` + `<nav class="bottom-nav"
  id="bottomNav">` and one `<script src="/nav.js">`; `data-page` lights that page's tab in both navs.
- Page-specific content goes in the two slots the page fills — `#hdrSub` (static) and `#hdrMeta`
  (dynamic). An unfilled slot collapses (`.site-header .sub:empty`). The row **ends at the tabs**.
- Two more slots after the spacer are **filled by shared modules, not by any page**, and collapse when
  empty: **`#hdrNewTicket`** (`newticket.js`'s "New ticket" button + create modal; collapses until an org
  reports) and **`#hdrOrg`** (`org.js`'s fleet-wide org filter; collapses when no host reports a tracker
  org). Both live in the chrome so they're on every page at once.
- The header is full-bleed and `.site-header-in` caps its row at `--wrap` and centres it, so every page's
  chrome lands in the same column as a `.wrap` page's content. On `sessions.html` the two-pane
  `.sess-shell` below is capped at `--wrap` and centred too (XERK-28); the cap is inert below `--wrap`, so
  the phone layout is unchanged.
- Because that row is **centred**, `app.css` reserves the scrollbar gutter globally
  (`html { scrollbar-gutter: stable }`) — else the always-scrolling dashboard centres 15px narrower than
  the others (reserved on `sessions.html` too). The gap under the header is a **margin, not padding**, so
  it collapses with the first content's margin. Mounted synchronously at the bottom of `<body>`, after
  both placeholders exist, before the page's script reads the slots.
- **`TurmaNav.preserveScroll(container, paint)` is the one wrapper every recurring innerHTML repaint must
  go through** (XERK-35), else the ~1s beat throws the window scroll and any inner `overflow:auto` region
  back to the start every second. It snapshots the window scroll plus every scrolled descendant of
  `container`, runs `paint()`, then restores them synchronously. Scrolled nodes re-match by a stable `id`
  anchor if in scope (so a REORDERED list maps its scroll to the right row), else by structural
  child-index path. Callers: `board.html` (`.kanban-cols`/`.kc-list`), `index.html`
  (`#groups`/`.clone-list`), `usage.html` (`.table-scroll`).
  - Two recurring repaints keep their OWN bespoke logic and must NOT route through it: `chat.js`'s
    transcript `repaint` (stick-to-bottom vs hold-place + selection-guard), and `sessions.html`'s sidebar
    (its `scrollTop` restore is ordered against a focus/caret restore that can itself scroll). New
    recurring repaints without such a special case should use `preserveScroll`.
- Tests: `nav.test.js`.

### The org filter (`turma/public/org.js`, XERK-62)

- **One org-scoping control, in the header, obeyed by all four pages.** A host polls exactly ONE org,
  so an org **partitions the fleet** — one selection filters tickets, hosts, sessions, usage.
- **Multi-select (XERK-222): the value is a SET of full `siteKey`s**, never display org names; empty =
  every org. Menu rows are checkbox toggles that stay highlighted while selected and keep the menu
  open; "All orgs" clears and closes. Persisted in `turma-org` as JSON (a pre-multi bare
  siteKey or the legacy `turma-board-org` reads as a one-org selection), re-read on `storage` so two
  tabs agree. `getKeys()` is the effective selection, `get()` only when exactly one applies.
- Each page: `TurmaOrg.update(data)` each beat, `TurmaOrg.filter(data.agents)` to scope what it builds,
  `TurmaOrg.subscribe(...)` to repaint on a change, `TurmaOrg.sse(es)` to take the hub broadcasts off
  the page's existing socket.
- Scoping applies to the **agent list**, once; everything downstream follows. Deliberately NOT applied
  to `findSession`/`sessionHit` (an open session must not be torn off the stage when its org leaves
  the sidebar) nor to pending-command reconciliation, which runs against the WHOLE fleet. A host with
  **no tracker block belongs to no org**: it shows only under "All orgs".
- **A pick for an org nobody reports doesn't apply, but is kept** (`effectiveKeys`, per key): else an
  org whose last host was removed leaves every page filtered to nothing with no chip to clear it; it
  resumes when the host returns.
- The per-org **auto-start switch (XERK-41) rides the menu's org rows** — `org.js` owns its optimistic
  flip, POST and rollback.
- Repaints are **skipped when the markup is unchanged**, so the beat can't churn the DOM under an open
  menu. Clicks are delegated; a handled click is flagged **on the event** — the repaint detaches the
  clicked node, so a `contains()` click-away test would close the menu on the click that opened it.
- It reads board.js's org vocabulary, so **every page loads `board.js`** (order: board → nav → org).
- Tests: `turma/tests/org.test.js`; Android port: `data/OrgFilter.kt` + `ui/OrgControl.kt` +
  `core/Board.kt` (tested in `BoardTest.kt`).

### Fleet tree (host → repo → session)

- Each host row reads **`<hostname> - <org>`** — the org whose Jira it polls, from its `jira` block's
  `siteKey` via `TurmaBoard.orgName` (why the dashboard loads `board.js`).
- Each host has a **"Clone from GitHub" bar**: a dropdown of its `gh` login's repos (present ones
  disabled) plus a free-text `owner/repo` box, greyed out on hosts reporting no GitHub creds.
- Each host expands into a top **⌂ Repos root** entry (no worktree/branch, so its composer hides the
  base-branch field, and "+ New session" goes once a root session runs), then its repos by
  `lastActivity`.

### Per-repo controls

- **"+ New session"** — one click, an instant bare spawn on today's defaults.
- A **▾ caret** opens a "New session" composer: task prompt, label and spawn options (base branch,
  model, permission mode), last-used remembered per repo in `localStorage`.
- A **"Resume" picker** when the repo has resumable history (`repo.resumable`): any prior Claude session
  for the repo, resumed by transcript id via `POST /api/agents/<host>/transcripts/<transcriptId>/resume`,
  falling back to the last-5 killed `closedSessions` for older agents.
- An arm/confirm **"Prune"** sweeping that repo's worktrees + local branches merged into the latest
  default, leaving anything unmerged or dirty.

### Session cards

- Working/idle/waiting-on-question state, the worktree name, the agent's live branch (or "detached"),
  and per-session token usage parsed from that worktree's `~/.claude/projects` transcripts.
- Any **PR status** the session opened, as the merge-readiness pill from `session.prs`
  (`prBadgeHtml`, `.pr-badge` in `app.css`).
- Per-session **Attach / Restart (clear context) / Kill / Start / Delete**.

### Spawn/resume handoff

- **Starting or resuming a session hands off to the Sessions page and opens it there.** The id doesn't
  exist yet at POST time (the agent mints it), so `spawn()`/`resume_transcript()` echo the hub's
  queued-command id onto the record (reported as `session.spawnCmdId`), the POST's `{ok, cmdId}` reply is
  handed to `/sessions?spawn=<cmdId>`, and that page waits for the session reporting that `spawnCmdId` and
  selects it (`followSpawn`/`tryPendingSelect`). Resuming a **killed** session keeps its id, so that path
  deep-links `/sessions?session=<id>` directly.
- Both waits are one-shot, show a "Starting your session…" stage, expire after `SPAWN_FOLLOW_MS`, and
  cancel the moment the operator picks a session by hand.
- A third deep link, **`/sessions?ended=<transcriptId>`**, opens an ENDED session's read-only view (what
  the board's ticket chips use for anything not running), keyed on the transcript id and resolved through
  `findEndedByTranscript` → `openEndedSession`. It is **bounded** (`ENDED_FOLLOW_MS`) and cannot be folded
  into `?session=`, whose wait only resolves a **running** session.
- Tests: `sessions.test.js`, plus
  `TestSessionLifecycle`/`TestResumeTranscript`/`TestHandleCommands`.

### History page (`/history`)

- Charts persistent daily/all-time cost from the agents' `repoUsage`/`usage` aggregates — not the live
  session list, so killed/deleted/pruned work still counts. **By repo** unifies a repo's usage across
  every host it runs on (matched by `remoteKey`); **By host** shows per-host totals.

### Board page (`/board`)

- One cross-org Jira Kanban built from every agent's `jira` block (`turma/public/board.js`, dual-exported
  for tests). `mergeSites` collapses hosts sharing an org into one board keyed by `siteKey` (freshest
  block wins per site+user; different users on one site union, deduped by issue key). Columns are Jira's
  three status categories, each card's pill showing the org's status name.
- A fourth **In Review** column (XERK-23) sits between In Progress and Done. Jira has no cross-org
  category for review/testing (both `indeterminate` → `inprogress`), so `categoryOf` carves it out on the
  org-specific status NAME (`isReviewStatus`, word-boundary: review/testing/QA), only ever pulling FROM
  `inprogress`.
- Scoped by the **header's org filter**, not a strip of its own: `TurmaOrg.getKeys()` each render, passed
  to `boardHtml`.
- An org is **labelled by `orgName(siteKey)`** — the site host minus `.atlassian.net` (full host as
  tooltip), which the agent's **`BOARD_ORG_NAME`** overrides outright (`orgName(siteKey, override)`,
  stamped by `collect_board`, carried by `mergeSites`) since a self-hosted Azure collection otherwise
  derives to its COLLECTION. Labels are presentational and deliberately **not** part of the `siteKey`,
  which the hub keys/merges/routes on and which `/api/jira/<siteKey>/…` and the ticket-agent/auto-start
  ledgers are stored under — renaming it orphans all of those.
  Tests: `TestBoardOrgName`, `board.test.js`, android `BoardTest.kt`.
- Each org gets a **UNIQUE color** — no two share a `--s1..--s8` palette slot (`orgColorMap(allKeys,
  pins)`, XERK-48), computed over the whole org set: in sorted key order each takes its djb2-preferred
  slot if free, else linear-probes to the next free one. **Persistent where it can be** — an org keeps
  its color unless its preferred slot actually collides, and then only the *colliding* orgs move. Unique
  up to 8 orgs; overflow falls back to its preferred slot.
  - **Pinnable by hand** (XERK-145): the header org menu's color dot expands a swatch strip (8 slots +
    "auto" release). Hub-owned durable state like the auto-start opt-in — `POST /api/jira/<siteKey>/color`
    `{slot:1..8}`/`{auto:true}`, persisted in `/data/org-colors.json`, riding the fleet payload + an
    `orgColors` SSE event (web reads them via `TurmaOrg.orgColors()`). A pinned org gets EXACTLY its slot
    (two pinned to one slot share it — the operator's choice beats uniqueness) and auto orgs probe around
    the pins; a malformed pin is ignored.
  - It also **tints the CARD BACKGROUND on every surface** (XERK-142): board ticket, Sessions session
    and Dashboard host cards. Web sets `--org` (a `var(--sN)`) inline per card and `color-mix`es it
    **12% into `--surface`**; no org falls back to plain surface. Computed over the WHOLE fleet's org
    set, not the header-filtered view, so a card's colour is stable regardless of the filter.
  - Android ports all three identically (`core/Board.kt` `orgColorMap`, `FleetState.orgColors`,
    `TurmaCard(tint=)`). Tests: `board.test.js`/`org.test.js`/`sessions.test.js`/`server.test.js`,
    android `BoardTest.kt`.
- The board READS the tracker; it makes exactly **two** writes back to it — **creating a ticket**
  (XERK-137) and **changing a ticket's status** (XERK-138). Every other control writes a hub/agent
  ledger, never the board. Tests: `board.test.js`, the ticket-detail and jira-refresh
  endpoint cases in `server.test.js`.

#### Creating a ticket (XERK-137)

- The **"New ticket"** button opens a modal to create a ticket (title, description, labels) on an org's
  tracker — source-agnostic across Jira and Azure DevOps, hidden until an org reports. It lives in the
  **shared site header** (`newticket.js` → nav.js's `#hdrNewTicket` slot, XERK-150), not the board
  toolbar; fed the beat by `TurmaNewTicket.update(data)`, form HTML in `board.js`. It rides the
  command → staged result → poll pattern, against a ranked ONLINE host of the org (below):
  - `GET /api/jira/<siteKey>/create-meta` (`boardCreateMeta`) → the org's projects + existing
    labels/tags; `?project=<p>` → that project's creatable types, a cascade so no meta call fans across
    every project. Cached per host, 202-polled.
  - `POST /api/jira/<siteKey>/tickets` (`createTicket`) → the agent creates and stages
    `{cmdId, key, url, error, warning}`; polled at `GET .../tickets/<cmdId>` (`createResults`). All
    three caches are stripped from the fleet payload.
- The new ticket **self-assigns to the tracker user** (Jira `accountId` via `/myself`; Azure an
  identity ladder, below) so it lands on the board — best-effort, and reported. Agent dispatch:
  `create_board_issue`/`board_create_meta`/`board_issue_types` (`create_jira_issue` POSTs
  `/rest/api/3/issue`, plain-text→ADF via `_text_to_adf`; `create_azure_issue` POSTs a JSON-Patch work
  item, `;`-joined `System.Tags`). Jira labels split on whitespace+commas, Azure tags on commas.
- Android matches it (＋ in `ScreenHeader` → `CreateTicketSheet`): `source` on `JiraBlock`/`BoardSite`,
  endpoints in `net/HubApi.kt`, the label/meta/result ports in `core/Board.kt`.
- **An org's hosts are health-ranked (`jiraHostHealthy`: online, then `jira.available`) and a board
  write is OWNED by the host that took it** (XERK-241): the poll reads only that owner (`commandHost`)
  — judging a create by a SIBLING's liveness is what made four tickets. Giving up on a create
  **withdraws** it even when delivered: delivery is at-least-once and the agent's acked-set is
  in-memory, so one left queued re-RUNS on that host's return; `deliveredAt` decides only the WORDING
  (undelivered provably did nothing, delivered "may have been created"). A retry rejoins an unresolved identical create
  (`createInFlight`, over the WHOLE body); creates round-robin past gapped hosts, and the status
  single-flight spans the org's ONLINE hosts.
- **A refusal carries the tracker's own words; a create bends to the TYPE and IDENTITY** (XERK-151):
  `_http_error_detail` keeps the body urllib's `HTTPError` drops (else every refusal reads "HTTP Error
  400: Bad Request"); the description goes in the field the type HAS (`_azure_description_field`: the
  Agile/Scrum **Bug** has ReproSteps, not Description); assignment walks a **ladder** of spellings then
  unassigned, keeping the FIRST error and re-sending only after a 4xx (proof nothing was created). That
  ladder's best candidate is **HARVESTED, not guessed** — `_azure_mine_identities` reads
  `System.AssignedTo` off an item the board's `@Me` WIQL returns, ahead of the `AZDO_USER`/connection-
  data guesses; `_azure_identity_strings` spells each four ways (on-prem often takes one). Cached, empty
  included, so nothing assigned yet falls through until one lands; an unassigned success `warning`s with
  the tracker's own refusal, never "set `AZDO_USER`" — already a candidate.
- **Any new shared `/*.js` must be in `server.js`'s `STATIC_ASSETS`** (an allowlist, not a directory
  serve) AND loaded by each page after `org.js` — a missing entry 404s and takes the module, and every
  page's render, down. Guarded by `newticket.test.js`.
- Tests: `TestCreateAzureIssue`/`TestAzure*Identit*`/`TestHttpErrorDetail` in `test_hub_agent.py`;
  `server.test.js`; `createFormHtml` in `board.test.js`; android `BoardTest.kt`.

#### Repo chips

- Each card shows the **repo the agent triaged the ticket to** (`repoChipHtml`, from `repoGuess`) in
  three states: **cloned** on the reporting host is a plain actionable chip, one only in the org's `gh`
  listing is **dashed**, a declined ticket a muted italic **"no repo"** — and no `repoGuess` yet gets
  **no chip** ("not looked at yet" ≠ "no repo fits"). The rationale is the tooltip and the detail
  panel's Repo row (`repoFieldHtml`, reading `t.repoGuess` directly — the guess is on the heartbeat
  ticket, not the on-demand fetch), where it is **corrected by hand**.

#### Starting a session on a ticket

- Each card carries a **start button**: `POST /api/jira/<siteKey>/<issueKey>/session` → a `spawnTicket`
  command. **The hub's whole job here is ROUTING** — it sends just the issue key; `findTicketHost` picks
  the host by **splitting load across the org's agents**, and online is **required**, not preferred
  (unlike the read-only ticket GET). `ticketRepo` resolves the repo from the **freshest** reporting
  block; org is checked before repo; single-flight per ticket (a second session comes from the `+`
  button and the -1/-2 branch).
- The button's states are distinct (`ticketStartHtml`): a triaged ticket gets a live button whether or
  not the repo is cloned (an uncloned repo reads **"☐ Start (clone first)"** and clones on demand); a "no
  repo" verdict and an untriaged ticket get none. A failed start renders its reason beside a LIVE button.
- In-flight state clears on **evidence**, not a timer: a session reporting the spawn's `cmdId`, or the
  command clearing from the host's queue (which covers a spawn the agent REFUSED).
- The press is acknowledged **instantly and survives leaving the board** (XERK-18): the button acts on
  **`pointerdown`** (fired before any re-render — the board `innerHTML`-replaces every beat), `click`
  the keyboard path, both via `startFrom` whose pending guard no-ops a double-fire; `startSession` sets
  pending and repaints **synchronously, before the fetch** (`cmdId`/`host` fill in on reply); the POST
  is **`keepalive: true`** so it outlives the page. `sweepStarts`' verdict is `B.startSweepVerdict`
  (pure, unit-tested): a cmdId-less pending always holds, and "command gone" counts as acked only once
  the command was **seen present** (`sawCmd`) — the SSE poll may not yet have seen a just-queued one.
- Tests: `server.test.js`, `startSweepVerdict` in `board.test.js`.

##### Splitting ticket sessions across an org's agents (XERK-14)

- A ticket pinned to a host skips all of the below: the pin is authoritative, and a dead pinned host
  refuses rather than reroutes.
- `findTicketHost` chooses among the org's **ONLINE** hosts: **prefers one with the repo cloned**, and —
  within that group, or across all when none has it — picks the **most available**
  (`hostAvailability`). A momentarily-full host is still valid: the session **queues** there.
- `hostAvailability(a)` = `capacity.free` **minus `capacity.queued` and the spawn/spawnTicket commands
  still queued** since its last heartbeat — subtracting in-flight commands is what makes rapid clicks
  split. An agent predating `capacity` scores below one that reports it.
- **No host has the repo → clone on demand.** `findTicketHost` returns `{host, needsClone:true}` for the
  most-available host; `spawn_ticket` clones it (owner from its triage ledger's `nameWithOwner`) and
  queues behind the clone — never a refusal.
- The **multi-host-per-org limits still apply**: the triage/branch state is per-host, so a clone-on-demand
  routed to a host that didn't triage the ticket has no ledger entry to clone from.
- Tests: `server.test.js`.

##### Auto-starting To Do tickets (XERK-32)

- An org can be **opted in** so the hub auto-starts a session for every **To Do** ticket the moment it has
  a repo assigned (by triage OR a manual pin). Off by default.
- **The opt-in is HUB-ONLY (XERK-41)** — the "auto" switch on each org row of the header's org menu is
  the whole control. `POST /api/jira/<siteKey>/autostart` `{enabled}` → `setAutoStartOrg`, stored in
  `autostart-orgs.json` (`AUTOSTART_ORGS_FILE` on `/data`, keyed by siteKey, presence = enabled), riding
  the fleet payload as top-level `autoStartOrgs` plus an SSE event; `orgsWithAutoStart` is the enabled
  set. **No agent-side flag**, so toggling never needs an agent redeploy.
- **The decision and routing live on the HUB** (only it sees the whole fleet). `autoStartSweep()` (a 15s
  `setInterval`, boot-grace-gated) walks each org in `orgsWithAutoStart` and routes a `spawnTicket`
  through the **same `findTicketHost`** the button uses, for each To Do ticket with a `repoGuess.repo`.
- Never opens a **second** session for work already started. Three guards, increasing in strength:
  `startedTicketKeys()` — durable, a ticket carrying a session on ANY channel (`a.sessions`,
  `a.closedSessions`, a repo's `resumable` scan) is handled, a **killed** session counting; an in-flight
  `spawnTicket` on some org host, covering the window before it first heartbeats; and `autoStarted`, an
  in-memory per-ticket ATTEMPT record, the only thing stopping a spawn the agent **refuses** from
  re-queueing every sweep.
- **A queued `spawnTicket` is an ATTEMPT, not a start** (XERK-61), so auto-start **retries on a growing
  backoff and never gives up** (XERK-109): a doubling `AUTO_START_RETRY_MS` (1/2/4/8 min) HOLDING at
  `AUTO_START_RETRY_MAX_MS` (10 min) once `AUTO_START_BACKOFF_STEPS` (5) is reached, tracked in
  `autoStarted` as `{attempts, nextAt}`.
  - The agent **acks a refusal and a mid-spawn exception exactly like a success**, so a TRANSIENT failure
    leaves no session. **Never re-introduce an attempt CAP**: any hard give-up blacklists such a ticket
    for the hub's lifetime even after its condition clears. A **no-online-host** result likewise spends
    NO attempt, so it retries once a host returns.
  - The retry gate is **evidence, in the sweep's existing order**: a session on any channel ends the
    attempts and drops the record; an in-flight command concludes nothing; only a still-session-less
    ticket with nothing in flight, past its backoff, is retried. A queued session reports its `ticket`
    from the first beat, so a slow spawn is never mistaken for a failed one.
- Nothing is written to Jira.
- Tests: `server.test.js`, `autoStartOn` in `board.test.js` and android `BoardTest.kt`,
  `test_no_agent_side_auto_start_flag` in `TestSetJiraRepo`.

##### Auto-stopping Done tickets (XERK-45, XERK-161)

- The lifecycle **counterpart** to auto-start: moving a ticket to **Done** **kills** its session(s) —
  only a **human** moves it there, a deliberate "finished" signal. **Regardless of the per-org "auto"
  opt-in** (XERK-161), which governs ONLY auto-STARTING work.
- The hub **KILLS**, not interrupts: a kill ends it cleanly (Ended, resumable, worktree/conversation/PR
  chips intact) and frees the `MAX_SESSIONS` slot an interrupt would leave it holding.
- Decision and routing on the HUB. `autoStopSweep()` (15s `setInterval`, beside `autoStartSweep`)
  reads **every** reporting org's **Done** tickets from its freshest block, then scans the WHOLE fleet
  for sessions whose `ticket` names one, routing each `{type:"kill", sessionId}` to the owning host.
  Only **live** ones (`running`/`queued`) are stopped, and every session on the ticket is (a
  two-branch or restart-clear-context ticket has more than one). Guard: `autoStopped`, a
  `<host>\x00<sessionId>` once-per-hub-lifetime set (re-killing a dead session is a no-op). Tests:
  the `auto-stop:` cases in `server.test.js`.

#### Ticket ↔ session chips

- A ticket's sessions show as chips on its card, from `ticketSessionIndex` — a reverse index of the
  fleet payload's `session.ticket`, so **no hub-side ticket store exists to keep in sync**. It reads
  the **same three channels the Ended list merges**; the resumable one gets its ticket from the
  agent's ledger.
  - Deduped on `<host>::<transcriptId>`, the **registry-backed record winning** (only it knows the id,
    `createdAt`, and the rename); resumable is swept last. NOT deduped across hosts (the shared
    `~/.claude` syncs transcripts, so an id alone isn't fleet-unique), and a **restart-clear-context
    session legitimately chips twice**.
- **Where a chip links follows the run state, not the channel**: running → `?session=<id>` (live chat);
  anything else → `?ended=<transcriptId>`; no transcript → not a link. The Sessions page's `?session=`
  wait only resolves a **running** session (`sessionHit`) and never times out, so pointing a
  stopped/killed chip at it parks on "Opening session…" forever.
- The chip is **labelled with the BRANCH**, not the session name (the branch tells two sessions on one
  ticket apart); an operator's rename (`summaryManual`) leads once it exists, and the live git branch
  beats the reserved one. Its label ellipsises on **its own element** (`.kc-sess` is a flex container;
  `text-overflow` can't clip anonymous flex content — the same trap `.kc-repo` documents).
- The reverse link rides the session: the Sessions card meta shows the ticket key (a plain span — the
  card is a `<button>`), and the chat footer carries a linked `jira-chip` beside the PR chip
  (`ticketFooterChip`) pointing at Turma's OWN board — `/board?ticket=<key>&site=<siteKey>`, not out
  to Jira (XERK-16). `consumeDeepLink` (`board.html`) is one-shot: waits for the org to report, opens
  the panel on the first render resolving the key, strips the params; `site` is optional.

#### Ticket detail panel

- **Clicking a card expands it into a detail panel** (`detailHtml`) with the full description, comments,
  people, parent, and labels, painted instantly from the card's heartbeat fields then filled from
  `GET /api/jira/<siteKey>/<issueKey>` — routed to a host reporting that org (preferring online),
  serving a fresh cached copy or queueing a `jiraIssue` command and 202-ing for the client to poll
  (`ingestJiraIssues`, cached by `JIRA_ISSUE_FRESH_MS`/`_MAX_AGE_MS`/`_MAX`, stripped from `/api/agents`).
  An offline-only org serves its last copy flagged `stale`; a cached `error` is kept so a doomed fetch
  isn't re-queued. The fetched copy wins field-by-field; its text is plain, so the panel escapes before
  linkifying.

##### The row pickers — one pattern, four rows

The Repo / Agent / Model / Status rows each swap in place for a `<select>` on **"Change"**. All four
share the rules below; each row's subsection carries only its deltas.

- **Choosing an option IS the save** — every option is a complete answer, so picking one commits and
  closes; **Cancel** is the way out. No Save button: with one, closing the panel discarded the choice
  silently. Re-picking the showing value saves **nothing**; the value the handler compares against and
  the one the picker preselects from must not drift, or a real change reads as a re-pick and is
  dropped.
- A set value that has **left** the options is carried back under "Currently set" so it stays selected,
  else the browser falls back to its first option, turning an untouched panel into a silent release. The
  save paints **optimistically**; a failure rolls it back and says so on the row.
- Options merge **across the org's hosts** (`mergeSites`); the known limit is that the union can offer
  what one host lacks. "Change" needs a host of that org **online**, and the edit state lives in a page
  variable, not the DOM (the session card's ⋯ menu rule).
- `refreshOpenTicket` re-points the open panel at the rebuilt ticket each beat (`mergeSites` builds
  fresh objects) — holding the optimistic paint for `REPO_SETTLE_MS`, repainting only on a changed
  rendered field, never while the picker is open.

##### Changing the repo by hand

- A picker of the org's `jira.repoOptions` — cloned and un-cloned repos in separate `optgroup`s, plus
  "No repository fits" and "Let the agent decide", `POST`ing to `/api/jira/<siteKey>/<issueKey>/repo`;
  `repoPickerValue`/`repoPickerHtml` are the compare/preselect pair.
- Present even for an **untriaged** ticket, reading "Not triaged yet". **Only a manual pin preselects
  a repo**: an auto guess is the model's answer while the operator's setting is "let it decide", and
  preselecting it would misreport that as a pin.
- Options are collected next to `hosts` over EVERY agent, not in the winners loop (one block per
  (site, user), else the picker offers only whichever host polled Jira last); cloned wins the dedupe, and
  `_apply_triage` keeps rendering a carried-back pinned repo on purpose.

##### Pinning the agent (XERK-38) and model (XERK-123) by hand

Two more rows below Repo, both **panel-only** (no card chip) and both **hub-owned durable state, NOT an
agent-ledger fan-out** like the repo override — the hub is what routes a spawn, so each persists under
`/data` (`ticket-agents.json`/`TICKET_AGENTS_FILE`, `ticket-models.json`/`TICKET_MODELS_FILE`; keyed
`<siteKey>/<issueKey>`, bounded `*_MAX` oldest-first), NOT in the best-effort `state.json`. So
`POST /api/jira/<siteKey>/<issueKey>/agent`|`/model` answers an authoritative **200, not the /repo
route's 202-on-queue**, and each rides `/api/agents` as top-level `ticketAgents`/`ticketModels` plus an
SSE event of that name. Both feed the Start button AND the auto-start sweep.

- **Agent row** — which HOST this ticket's sessions spawn on, defaulting to "Auto — most available
  agent"; a picker of `mergeSites`' per-site `hostOptions` (every host reporting the org, online first,
  offline marked). `{host}` pins, `{auto:true}` releases, allowlist-checked against the fleet's hosts
  reporting that org, so an OFFLINE host is pinnable but a host of another org is not. `findTicketHost`
  honors it over the availability ranking; a pinned host that's offline (or gone) **refuses with the pin
  in the error, never silently reroutes** (the sweep treats that like any no-host result). A pinned host
  without the repo clones on demand and queues behind it.
- **Model row** — which MODEL the session runs, defaulting to "Default — the agent's default model";
  delivered on the `spawnTicket` command the hub already routes (`ticketModelPin` → the command's
  `model`). `{model}` pins, `{auto:true}` or `{model:"default"}` releases. The alias must be one the org
  **actually offers** (`orgModelAliases`: its hosts' probed `models.available`, non-bracketed, + the
  static family aliases) and the **agent still re-validates** it host-side (`spawn`'s `resolve_model`);
  an unpinned ticket omits `model`. The picker offers the curated menu (`modelChoices`/`prettyModel`);
  an un-probed org falls back to the static aliases, never an empty menu.
- Tests: `server.test.js`, `board.test.js` (`modelPinOf`/`modelPickerHtml`/`modelChoices`),
  `TestSpawnTicket`, `hostOptions`/`agentPinOf`/`modelPinOf` in android `BoardTest.kt`.

##### Changing the status by hand (XERK-138)

- The Status row is the **one detail control that writes BACK to Jira/Azure**. A picker of the statuses
  the ticket can move to, "keep current" first as the no-op.
- **The options are the board's own, fetched with the issue, not a fixed list.** The detail carries
  `statusOptions` (`[{id, name, category}]`): Jira's available **transitions** (labelled by the resulting
  status, valued by transition id — from `expand=transitions`), or Azure's **states** for the work-item
  type (id == the state name, less the current one). Empty → the row stays read-only.
- **The write is re-validated against a FRESH read.** `POST /api/jira/<siteKey>/<issueKey>/status
  {value}` is single-flight per ticket; the agent (`set_board_status`) re-reads the available options and
  applies only a `value` still on offer — the board's workflow, not the browser, decides what a ticket
  can move to — then Jira `POST .../transitions` or Azure `PATCH .../workitems/<id>` [System.State].
  `value` passes through the hub checked non-empty, not allowlisted there, since only the agent can see
  the live option set.
- **The outcome rides back keyed by the queued cmdId.** The agent stages `ticketStatusResults`
  (`{cmdId, ok, error, status, statusCategory}`) plus the re-fetched issue into `jiraIssueResults`; the
  hub caches it per cmdId (`statusResults`, stripped from `/api/agents`). The panel polls
  `GET .../status?cmdId` until `{ok}`/`{error}` then re-fetches the detail; the card's COLUMN catches up
  next poll.
- Tests: `TestSetBoardStatus`, `TestAzureStatusOptions`, `TestShapeIssueDetail`/`TestFetchJiraIssue`
  (`test_hub_agent.py`); `server.test.js`;
  `statusFieldHtml`/`statusPickerHtml` in `board.test.js`; `statusChangeable` in android `BoardTest.kt`.

##### Drag-and-drop status change (XERK-141)

- **Drag a card into another column to change its status** — the XERK-138 write path above, unchanged,
  reached by a gesture.
- **The drop POSTs the target COLUMN, not a transition** (`{category}` on the SAME `setTicketStatus`
  command the picker's `{value}` uses): a board card never loaded the ticket's transitions, so the client
  can't name one. `set_board_status` resolves the column against its FRESH options read via
  `_status_option_for_column`, the first option whose `_board_column(name, category)` matches (the Python
  mirror of `board.js` `categoryOf`, review carve-out included); no match refuses.
- **An optimistic `moves` override holds the card in its dropped column across repaints** until the
  board's own (slow) poll reports it there, else it snaps back each ~1s beat. `boardColumnOf` renders it
  through BOTH the in-flight `pending` state AND the `settled` state after it — honouring `pending` alone
  lets the card snap back until the next poll, then jump forward again. The sweep (`moveSweepVerdict`)
  clears it only once the poll has caught up (`categoryOf` == the dropped column) or a backstop; a
  failure reverts after a short TTL. On settle the client nudges `POST /api/jira/refresh`.
- Web: a pointer long-press drag with a floating ghost + column highlight in `board.html`; a real drag
  suppresses the click it would synthesize so a drop doesn't also open the panel. Android:
  `detectDragGesturesAfterLongPress` + a ghost card in `BoardScreen.kt`, same override.
- Tests: `TestBoardColumn` (`test_hub_agent.py`); `server.test.js`;
  `boardColumnOf`/`moveSweepVerdict`/`boardHtml` in `board.test.js` and android `BoardTest.kt`.

#### When a host's agent is too old for a write (XERK-151)

- An agent **acks** a command it doesn't implement (a poison command must not retry forever), so a host
  predating a board write feature reads as a slow one and the routes waiting on a staged result 202
  forever. **The ack IS the evidence**: these commands stage their result in the same `handle_commands`
  call, so it rides the SAME beat as the ack — an ack with no result means the agent didn't handle it.
- `awaitResult`/`resolveResultWaits` record and settle each queued command, writing
  `agent.unsupported[kind]`; the waiting routes refuse with `agentGapError` rather than queue —
  create-meta `200 {error}` (the shape both clients read), create/status `409` (Android reads it via
  `hubError()`).
- A gap **clears** on a result landing, `agentVersion` CHANGING, or `UNSUPPORTED_TTL_MS` (the backstop
  for an update that doesn't move the version). Conclude nothing from a queued command: unACKED is not
  untaken. `resultWaits` is stripped from the fleet payload, `unsupported` rides it.
  Tests: `server.test.js`.

#### Refresh button

- `POST /api/jira/refresh` fans a `refreshJira` out to every Jira-**`configured`** host, deduped so a
  mashed button costs one poll per host. `configured` (creds present) not `available` (a poll
  succeeded), because a failing host reports
  `available=false`/`siteKey=null` — exactly the host a retry is for; `siteKey` is the older-agent
  fallback.
- It resolves on real fleet state: holds until the command clears from the targeted hosts' records
  (`jiraRefreshPending`, covering a poll that FAILED leaving `fetchedAt` untouched), with
  `newestFetchedAt` as a second signal and a 45s timeout; "Refresh failed" only when EVERY targeted
  host errored (`jiraRefreshFailed`).

### Sessions page (`/sessions`)

- Opens a running session in a **native chat view by default** (`turma/public/chat.js`) instead of the
  raw ttyd terminal, streaming over the `/live/<host>/<id>` WebSocket (ws-token auth, seeded from the
  heartbeat's cached tail, scrollback from `GET .../history`, `/history`-poll fallback when the socket is
  down).
- It renders chat bubbles — **user right, agent left** — with collapsible tool-action cards (tool_use +
  its paired tool_result, error-styled) and collapsed thinking traces, the in-progress turn typing in via
  a typewriter reveal (ported from glasses `live.ts`/`transcript.ts`/`reveal.ts`).
  - The live turn is the tmux **pane scrape's "last ● bullet"**, NOT monotonic (XERK-19): it SWAPS
    blocks mid-turn, so every `turn` frame is CLASSIFIED by `applyTurn` before the reveal and the
    streaming bubble is only for in-progress **prose** — an empty frame or a tool-use bullet
    (`isToolBullet`, biased toward matching since a miss brings the flicker back) CLEARS it, the same
    prose block keeps the LONGER text and never shrinks (`reveal.shown`), a different one retypes from 0.
    Stands in for glasses `advanceReveal`'s entryId snap (the scrape has no id); `repaint`'s prefix check
    is a defensive clamp. Tests: `chat-selection.test.js`.
- Bubble prose is rendered by `renderProse` (`chat.js`): **fenced ` ``` ` blocks** become
  `<pre class="md-code">` (language chip from the info string), inline **` `code` ` spans** become
  `<code class="md-code-inline">` chips (`renderInline`), GFM **tables** become real `<table>`s, else
  linkified.
  - Passes nest outward-in — fence, table, inline, link — so a code body is never linkified, and the
    fence pass runs above the table pass. An inline span never crosses a line break; an **unterminated
    fence renders as code**. A code-carrying bubble takes a **definite** `width: min(760px, 100%)`
    (`:has()`-scoped), out of shrink-to-fit sizing so overflow lands on its own scroller, not a grid
    track.
  - **Images/SVGs render inline (XERK-221)**: `![alt](url)` → `<img>` (`linkify`, src `http(s)`+
    `data:image/*`); a line-start raw `<svg>` (`renderSvgAndText`) or all-SVG fence body → a sandboxed
    `data:image/svg+xml` `<img>` (`svgToImg`) — **never DOM-injected**, so embedded `<script>`/`onload`
    can't run (SendUserFile deliveries render the same way — the tool_use `files[]` above). Android
    deferred (`android/PARITY.md`). Tests: `linkify`/`renderProse` in `chat.test.js`.
- A per-session **verbosity control** (Concise/Normal/Verbose presets + per-type thinking/tool-calls/
  tool-outputs toggles, persisted in `localStorage`) filters which `blocks[]` show — client-side, over
  the received buffer.
- Typed prompts go to `POST .../input`; pending `AskUserQuestion`s answer via option chips / custom text
  to `POST .../answer`.
- The pending-question box renders Claude Code's full picker: each option a card with its `description`
  + collapsible **`preview`**, a `header` chip and an "n of N" counter, riding `questionOptionsRich`/
  `questionHeader`/`questionIndex`/`questionTotal`/`questionMulti` beside the backward-compat
  `questionOptions` labels, so glasses/android keep the flat list.
  - A **`multiSelect`** question renders checkboxes + a Submit that `POST`s `optionIndices`;
    `answer_question`/`ask.py` accept it. `optionCardHtml` builds each card; agent side
    `_question_options`/`_hook_question` + `TestHookQuestion`/`TestAnswerQuestion`/`test_ask.py`.
- The compose footer's agent-mode / model selectors are joined by a compact **PR status chip**
  (`prFooterChip`) when it has one.
- The **model selector is accurate** (XERK-33) — never a hardcoded menu, and never rewriting the shared
  login's default (see `setModel`):
  - the chip leads with the session's heartbeated `modelActual`, humanized by `prettyModel`
    ("claude-opus-4-8" → "Opus 4.8"), falling back to the picked alias, raw id in the tooltip;
  - the menu is `modelOpts` from the host's probed `models` block — curated to the aliases the /model
    picker can reach, "Default (<label>)" saying what it resolves to, the static four before a probe;
  - a just-picked switch holds its optimistic label until the agent confirms or `MODEL_SWITCH_SETTLE_MS`
    passes (`modelSwitchPending`); a DEFERRED pick (`session.pendingModel`) outranks the memo and shows
    an ellipsis. The mode chip shares the memo (`modeChipValue`/`modeSwitchPending`), retired when the
    heartbeat's `permissionMode` agrees;
  - `onPoll` carries the fresh host payload so the menu tracks the probe; the dashboard composer offers
    the same probed list (`modelChoices` in `index.html`).
  - Tests: `modelOpts`/`prettyModel` in `chat.test.js`, the malformed-model case in
    `server.test.js`.
- The raw ttyd terminal stays one **"Terminal ▸" toggle** away in the chat header (`#termPane` iframe).
  `GET /api/ws-token` also authenticates the web chat's `/live` socket. Tests: `chat.test.js`.

#### Working-status bar and agent list

- A pinned **working-status bar** below the transcript mirrors the terminal's bottom region from the live
  `status` frame: the spinner verb + ↑/↓ token counters + elapsed, and Claude Code's rotating
  tip/active-task hint. When background agents run it shows a clickable **agent list** (`agentsHtml`:
  `main` a plain marker, each subagent a button carrying its type + description).
- Clicking a subagent opens its transcript read-only in the right stage (`openSubagentView` →
  `GET /api/agents/<host>/sessions/<id>/subagents/history?type=&label=`, reusing the archive viewer +
  chat engine), with **Back** returning to the live session.
- Tests: `agentsHtml` in `chat.test.js`, the subagent-history cases in `server.test.js`.

#### Queued sessions

- A **"Queued" section** above the live lists: static cards with the wait reason (`queuedReasonText`)
  and an arm-then-confirm **Cancel**. A followed spawn (`?spawn=<cmdId>`) landing there words its stage
  **"Queued — <reason>"**, flipping to the live session once provisioned; the dashboard's card mirrors
  this. Tests: `sessions.test.js`.

#### Ready for review (XERK-224)

- The live sessions split three ways in reading order — **Ready for review** (stopped, waiting on YOU),
  **Active** (working), **Idle** (quiet).
- `readyForReview(s, live)` is **derived from the signals alone** — there is no "I've reviewed this"
  action. It qualifies on a pending question/pane prompt (blocked on a human, so the busy read doesn't
  matter; it leads the section), a PR that hasn't landed, or a **finished turn** (`lastRole=="assistant"`,
  no `lastHasToolUse`) — the only trace a research task that opened no PR leaves, and the case a PR-only
  rule was asked to stop missing.
- Every PR reaching MERGED/CLOSED demotes it: merging IS the review, so it drops to Idle, where work
  merged but not yet verified is parked. `prLanded` counts an unknown state as still live; an unreadable
  one must never drop work off the list.
- **That demotion is scoped in TIME, never absolute**: a landed PR stops being a reason to look but must
  not become a reason NOT to. A session is a CONVERSATION, not a pull request — hand the same one a new
  task and it finishes with no new PR to show, which an absolute demotion hid for good.
  `_poll_prs_landed` stamps `prsLandedTs` (last-activity when the sweep first sees every PR landed; a
  new PR clears it); `newWorkSincePrs` says the conversation moved past it, and the rule then falls
  through to the finished-turn signal. Both are **transcript timestamps** — the conversation's clock,
  not the mtime a synced `~/.claude` inflates. False when unanswerable (older agent included), erring
  toward parking over a wrong claim.
- FIVE mirrors must agree: `sessions.html`, `server.js`, `core/Sessions.kt` (`rankRunning` →
  `LiveGroups`), `glasses/src/sessions.ts` and veiller's FORK of it. The card says WHY it qualified,
  on `.dot.review`. Tests: `sessions.test.js`, `readyForReview` in `server.test.js`, `TestPrsLanded`,
  `SessionsTest`.

#### Ended sessions

- The sidebar's last section, **collapsed by default**. It merges the three channels an
  over-but-resumable session arrives on: **killed** (`a.closedSessions`), **stopped** (a
  non-running record still in `a.sessions`), and **resumable** (a transcript from each repo's `resumable`
  scan, no registry record behind it).
- The third channel makes the list **durable**: the first two read the capped `~/.turma` records, while
  `resumable` is re-derived every slow beat from the transcripts under `~/.claude/projects`.
- **Deduped on `<host>::<transcriptId>`**, a registry-backed record always winning; a kill that ages
  out of `closed.json` keeps listing, minus its PR chips. Sorted **most recently ended first** (`endedMs`,
  from `closedAt`/`stoppedAt`/`endedTs` — `resumableSession()` must copy `endedTs` onto the record, where
  `endedEntry` reads the key); an undated record sorts oldest.
- The resumable channel's **`endedTs` is the last message's own transcript timestamp**
  (`_last_activity_ts`), NOT the file mtime (XERK-73) — mtime is inflated to copy-time by a synced
  `~/.claude` or backup restore. `_archive_manifest` dates rows the same way; both fall back to mtime when
  no entry is timestamped. Tests: `TestLastActivityTs`, `TestResumableReport`.
- A **running** session is never also listed as ended: the agent re-cuts the cached scan against its live
  registry every beat (`_sorted_repo_entries`), and the page dedupes resumable rows against every reported
  session's `transcriptId` (why `_session_payload` reports it while running).
- **Clicking a row opens that session read-only on the stage** — the same `#transcriptPane` the
  archive/subagent views use: scrollable conversation + a verbosity control, **no terminal toggle and no
  compose box**. `resetEndedBar()` keeps the pane's shared PR/Resume bar from leaking into those views.
  The conversation is read from the hub's **archive** (`GET /api/archive/<transcriptId>`), so it works
  for an offline host; a just-killed session hasn't synced yet and says so.
- Its **PRs are chips on the stage bar and are LINKS there** (`prBadgeLinkHtml`); the sidebar copy stays
  an inert `<span>` (the card is a `<button>`).
- **Resume** sits on the row and stage bar, dispatching on how the session ended: killed → `.../resume`
  (same id), stopped → `.../start`, resumable → `.../transcripts/<id>/resume` with its origin cwd (the
  agent re-validates the path and re-creates the dir if a prune removed it). The list is DERIVED, so a
  resumed session drops out the beat the agent reports it running. The resumable path comes back under a
  **new id**, so it follows its queued command's `cmdId`. Resume needs the host **online**; reading doesn't.
- Tests: `sessions.test.js`, `TestRefreshPrStatus`, `TestSessionLifecycle`, `TestResumableReport`,
  `TestCardedSlugs`.

#### Session card ⋯ menu

- Each sidebar session card carries a **⋯ overflow menu** — a sibling of the card `<button>`, absolutely
  positioned over it (a nested button is invalid HTML). **Rename…** swaps the card for an inline field
  `POST`ing to `.../sessions/<id>/summary`, painted optimistically; **Kill** arms-then-confirms. Its
  state lives in page variables, not the DOM.

#### Send and Stop buttons

- **Send always sends, and ◼ Stop is its own button**, in both chat and terminal views. A message sent
  mid-turn QUEUES, so the button that talks must stay available while the agent works. The
  warning-coloured Stop appears beside Send only while a turn runs.
- Stop interrupts the turn (`chatComposeStop`/`termComposeStop` → `stop()` →
  `POST /api/agents/<host>/sessions/<id>/interrupt`). Unlike Kill it arms/confirms nothing and leaves the
  session on the stage. **Enter always sends**, like the button.
- The busy read driving Stop's visibility is `liveStatus` (the ~1s pane scrape), NOT the heartbeat's
  `paneBusy`. With the live socket down `liveStatus` stays null and Stop stays hidden (a Stop that can't
  see the turn is worse than no Stop).
- A clicked Stop **hides immediately** (`stopPendingAt`, `composeBusy()`); if the turn outlives
  `STOP_SUPPRESS_MS` the interrupt didn't take and Stop comes back. A failed POST paints "Stop failed"
  (`actionFailed`'s selector arg).
- **A pending `AskUserQuestion` hides Stop** (`composeBusy()` returns false while `questionActive`) — the
  answer is typed THROUGH the compose box, routed to `/answer` (`send()`'s `wasAnswer` path), and an
  accidental Stop would destroy the question (XERK-21). `updateQuestion` repaints the bar the instant a
  question appears/clears.
- `chat.js` paints every `.compose-action` + `.compose-stop` button from that one read, so the terminal's
  bar can't disagree with the chat's. Tests: `chat.test.js`,
  `termComposeAction`/`termComposeStop` in `sessions.test.js`.

#### The compose draft survives the view toggle (XERK-122)

- The chat and terminal panes have a compose box each, but a session has ONE draft: each toggle **moves**
  the text across (`carryDraft`), clearing the source, so the two can never disagree. It is carried
  **after** the pane swap — `focus()` on a still-`hidden` textarea is a silent no-op. Focus follows only a
  NON-EMPTY draft, so toggling with an empty box doesn't pop a soft keyboard.
- Android has no in-place toggle (the terminal is its own screen), so the draft lives outside both screens
  in `data/DraftStore.kt`, keyed per (host, session); `ChatViewModel` mirrors it into `ChatUiState.draft`
  and writes every change — incl. dictation and send-clears — back through it.
- Tests: `sessions.test.js`, android `DraftStoreTest.kt`.
- **A compose box auto-grows to its `scrollHeight`, but only while it is laid out** (XERK-149): a hidden
  textarea (`.chat-pane`/`.term-pane[hidden]`, or a phone's `display:none` `.stage`) reports
  `scrollHeight` 0, and an unguarded `growCompose`→`autoGrow` during the toggle's `carryDraft` pins an
  inline `height:0px`. `autoGrow`/`autoGrowTermInput` bail on `offsetParent === null`, keeping the last
  laid-out height; `carryDraft` re-grows it when shown. Tests: `autoGrowTermInput` in `sessions.test.js`.

#### Copying out of the terminal

- A copy made in the terminal view reaches the viewer's **real system clipboard** — three independent
  links, since the text has to survive the app, tmux AND xterm.js (XERK-7).
- Selecting at all needs a **modifier**, because the Claude TUI holds mouse tracking: **Shift**
  everywhere except macOS, where xterm.js honours **Alt** only when `macOptionClickForcesSelection` is on
  (defaults off) — `_launch_ttyd` passes it (cost: Mac's Alt+drag column-select). Once a selection exists
  ttyd copies it itself.
- **Every other copy — the app's own and tmux copy-mode's — travels as OSC 52**, needing all three of:
  `agent/tmux.conf` declaring an `Ms` capability (tmux emits OSC 52 only if the OUTER terminfo advertises
  it, and xterm-256color / tmux-256color lack it); `set-clipboard on` (the default `external` forwards
  **no** application OSC 52); and the hub injecting xterm.js's missing OSC 52 handler (`TERM_OSC52_JS`,
  in `proxyTerm`, via ttyd's `window.term`).
- The bridge is deliberately **write-only**: an OSC 52 READ request (`?`) is never answered (else any
  program in the pane reads the clipboard). An empty payload is dropped. It splits at the **first `;`**
  (an app sends `52;c;<b64>`, tmux `52;;<b64>`, both must land).
- Tests: `server.test.js`, `test_launch_ttyd_lets_a_mac_force_a_selection` in `test_hub_agent.py`.

### Durable archive

- The hub hosts a **durable, searchable archive of ended sessions** (`turma/archive.js`): agents push each
  inactive transcript in, landing as **organized files on `/data`** — one folder per repo, each renamed +
  dated `/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl` (+ a `.meta` sidecar),
  indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, Node-core, no npm), rebuildable from
  the files.
- The Sessions page gains a search box (`GET /api/search?q=` — hub-local full-text search, ranked,
  `<mark>`-highlighted, grouped by `remoteKey`, working for offline hosts) and an "Ended sessions"
  browser (`GET /api/archive`); a result opens read-only (`GET /api/archive/<transcriptId>`). Ingest is
  agent-token-authed; the manifest cursors ride the heartbeat reply. Tests: `archive.test.js`, `server.test.js`.

### `POST /api/trigger` — external automation

- Starts a session from a single JSON body — `{hostname, repo, prompt}` all **required**, plus optional
  `label`/`baseRef`/`model`/`permissionMode`. Validates host and repo (against the host's reported
  `repos[]`, incl. `(root)`) before queuing the same `{type:"spawn"}` command the composer uses.
- Unlike `POST /api/agents/<host>/sessions` (user-auth only, repo-in-URL, prompt optional), it's gated by
  `triggerAuthorized`: a dedicated **`TURMA_TRIGGER_TOKEN`** bearer token OR the ordinary user login;
  with the token env unset it accepts the user login but no token caller. Tests: the `/api/trigger` cases
  in `server.test.js`.

### Notifications

- The hub pushes edge-triggered alerts to the **Android client via FCM**, the sole transport: host
  offline/recovered, restart loop, per-session ready-for-review / question waiting, Claude login
  required/expiring/restored.
- **A session gets ONE alert per piece of work** (XERK-224): "is ready for review", fired when it enters
  the Sessions page's Ready-for-review group (`readyForReview`, the hub's mirror of the page's rule) and
  replacing the separate "finished its turn" and "created a PR" notices; retracted `review:<host>:<id>`
  when it leaves. Tags `mag` → Android's `CH_TURN` (renamed "Ready for review", id kept so the
  operator's channel settings survive).
  - Fires only on something NEW — a turn that just finished (`sa.reviewAt`) or a PR that just settled
    (`sa.prNotes`) — so a session already sitting there at boot is not re-announced. A pending question
    **suppresses** it: the question alert is already that session's buzz, and says more.
  - **A PR still waiting on CI HOLDS it** (XERK-153) — never fire on the URL being scraped. A new URL
    enters a per-session wait list (`alerts.sessions[id].prWait`) that `prAlertDecision` re-judges each
    beat; a settled verdict banks on `prNotes` and is spent by the one alert, whose body names each PR
    and its verdict. `prSeen` keeps its old meaning (already alerted), so an older hub's PRs don't
    re-fire on upgrade.
  - **But the hold is read off `session.prs`, never that list alone**, which only the per-beat
    `newPrUrls` scrape fills: a PR scraped before this hub booted, or announced once and then worked on
    again, leaves it empty while still open.
  - `prAlertDecision`'s doc comment is the verdict table; four rules there must not be undone. **A
    CONFLICTING open PR never alerts** (XERK-223) — it merges nowhere however green its CI is, so the hold
    outlasts the age-out and reaches this alert too; the session still LISTS under Ready for review, and
    XERK-223's nudge is what clears it. **`failing` stays quiet permanently** (the alert is for the work
    being ready, not every trip through red). **Absent `checks` is "not fetched yet", never "no CI"** — a
    just-opened PR reads like a CI-less one while GitHub registers its workflows, so `checks: null` holds
    `PR_NO_CI_GRACE_MS` first. An inconclusive wait **ages out and fires anyway**: it may delay an alert,
    never lose it. Tests: `prAlertDecision`/`readyForReview` in `server.test.js`.
- **Claude login alerts** (XERK-98) fire in `heartbeatAlerts` off the agent's `claudeAuth` block: two
  edge-triggered states, deduped under `next.alerts` and cleared on recovery — `needsLogin` → urgent
  `key`-tagged "Claude login required", `expiringSoon` → default-priority "Claude login expiring". The
  hard state supersedes the soft (`claudeExpiringAt` dropped when `needsLogin`), so a lapse-then-recover
  fires only "restored". `key` routes to Android `CH_HOST`. Tests: `server.test.js`.
- The Android client owns the delivery half: `POST_NOTIFICATIONS`, the Android-13+ runtime request in
  `MainActivity`, channels + rendering in `push/Notifications.kt`, `push/PushRegistrar.kt`.
- **`android/app/google-services.json` is committed** (XERK-37): the Firebase client config must be IN the
  repo or CI-built release APKs ship with Firebase inert and push does nothing. It holds only public
  identifiers (same as the committed release keystore); the gradle apply stays conditional so a fork that
  removes it still builds.
- Every alert funnels through one `notify()` (`turma/server.js`), fanning out via `turma/push.js` (FCM
  HTTP v1, service-account JWT minted with `node:crypto`, no npm — enabled by `FCM_SERVICE_ACCOUNT_JSON`)
  and carrying `tags`/`priority`/`click`/`route:{host,sessionId}` as message data, so the client picks a
  channel and deep-links a tap. A no-op with no device registered or FCM off. Devices register via
  `POST /api/devices` (user-authed, `/data/devices.json`), unregister via `DELETE /api/devices?token=`;
  dead tokens are pruned on send.
- **An addressed alert is retracted from the phone** (XERK-154): every session alert posts under a stable
  `notifKey` (`question:<host>:<id>`, `review:<host>:<id>`); `dismiss(notifKey)` sends a title-less
  `{action:"dismiss", notifKey}` FCM message (no-op with no device / FCM off), fired once per addressed
  edge: a question cleared, a session leaving Ready-for-review. App-side `Notifications.idFor` keys off
  `notifKey`, so alert kinds coexist instead of colliding on one per-session id. **Capability-gated** to
  devices declaring `features:["dismiss"]` — an older build renders a data-only message as a blank
  notification, so it keeps the stale alert; `DeviceRequest.features` is **required**, since
  `encodeDefaults=false` drops a defaulted value and the hub would retract nothing. Tests: `XERK-154` in `server.test.js`, `DeviceRequestTest.kt`.
- **Push health is VISIBLE, not just logged** (XERK-152): a hub without `FCM_SERVICE_ACCOUNT_JSON` silently
  delivers ZERO mobile notifications, so `buildAgentsCache` reports hub-wide **`pushEnabled` =
  `push.fcmEnabled()`** on `/api/agents` and the dashboard (`index.html` `#pushWarn`) + Android
  (`FleetScreen` `PushOffBanner`, `FleetState.pushEnabled`) banner "mobile push is off" on it — strict
  `=== false`, so an older hub never false-alarms. The key is deployment config, not in this repo.
  Tests: `push.test.js`, the `pushEnabled` case in `server.test.js`.

### Auth and the glasses surface

- UI, API, and the click-to-attach live terminal (`/term/<sessionId>/`, reverse-tunneled to that session's
  ttyd by port) sit behind single-user HTTP Basic auth (`TURMA_USER`/`TURMA_PASSWORD`). Agents
  authenticate heartbeats, tunnel WebSockets, and ttyd with one shared token (`TURMA_TOKEN` in the
  agent's env = `TURMA_AGENT_TOKEN` on the hub).
- The hub also serves the `glasses/` client: a CORS'd `/api/*` surface for that cross-origin WebView;
  per-session `input`/`history` endpoints; `GET /api/ws-token` for short-lived WebSocket auth; an
  `/audio` STT WebSocket (G2-mic PCM to the LiteLLM instance's transcription endpoint); and a
  `/live/<host>/<sessionId>` **live-transcript WebSocket** (ws-token auth) — the hub asks the host's
  tunnel-agent to `watch` the session, seeds it with the cached tail, fans the `{tail,entries}` deltas
  out, and `unwatch`es when the last viewer disconnects (re-arming on control reconnect).

## `glasses/` — Even Realities G2 smart-glasses client

- Vite + TypeScript, Vitest; an Even Hub plugin. An open session screen tails the hub's `/live`
  WebSocket (`live.ts`) with a **streaming typewriter reveal** (`reveal.ts`), else the 6s poll. See
  `glasses/README.md` for dev/packaging/QA.
- **Even phone companion (XERK-171):** the PHONE screen is a NATIVE Sessions + Board UI (`src/phone/`), not
  the hub's web pages. It renders from `App` state, drives it in-process (no iframe/postMessage) — a tap is
  `App.enterSession`, the org filter `App.setOrgFilter`. **ENTER syncs, LEAVE doesn't**: entering on one
  pulls the other in (`App.onEnterSession`); org filter scopes the list too. Board is Phase 2.

## `android/` — native Android client

- Kotlin + Jetpack Compose, MVVM. Full parity with the web dashboard + glasses client, plus phone-only
  **OS push notifications** (FCM) and **voice**. Mirrors the glasses pure-core/adapter-shell split:
  - `core/` — JVM-unit-tested reducers ported 1:1 from `glasses/src` (`Reveal` typewriter, `Transcript`
    grow-only merge, `Sessions` working/idle/waiting, `ChatItems` buildItems+verbosity).
  - `model/` — the wire shapes + shared `TurmaJson` decoder. `vm/` — the ViewModels.
  - `net/` — the `HubClient` (Retrofit/OkHttp/kotlinx.serialization), `LiveTail`+`FleetRepository`
    (WebSocket `/live` + SSE `/api/events` with a 6s `/api/agents` poll floor), and `Dictation` (16kHz
    PCM → the hub's `/audio` Whisper socket).
  - `ui/` — the Compose screens; see `android/PARITY.md` for the web page → screen map.
  - `push/` — the FCM service + `PushRegistrar` (registers via `POST /api/devices`; guarded so a build
    with no `google-services.json` still runs). Driven hub-side by `turma/push.js`.

### Web UI ⇄ Android parity (XERK-30)

- **The mobile web UI (`turma/public/`) is the source of truth; the Android app must match it.**
- **A PR that changes user-facing behavior in `turma/public/` must carry the matching change to
  `android/` in the same PR** — or, if out of scope, add a line to `android/PARITY.md` and say so in the
  PR; an unlisted, unmentioned divergence is what this rule exists to stop. "User-facing" = a control,
  screen, state, chip, interaction, or layout a person sees or touches; pure server/agent plumbing is
  exempt.
- When you touch one of these web files, check its Android counterpart:
  - `index.html` → `ui/FleetScreen.kt` + `ui/FleetDialogs.kt`
  - `sessions.html` + `chat.js` → `ui/SessionsScreen.kt` + `ui/ChatScreen.kt` + `vm/ChatViewModel.kt`
    (its ONE box filters the live lists AND appends archive matches — `core/Search.kt`, XERK-243)
  - `board.js` + `board.html` → `ui/BoardScreen.kt` + `core/Board.kt` + `vm/BoardViewModel.kt`
  - `usage.html` → `ui/UsageScreen.kt`
  - `nav.js` → `ui/MainScaffold.kt` + `ui/TurmaApp.kt`
  - `org.js` → `ui/OrgControl.kt` + `vm/OrgViewModel.kt` + `data/OrgFilter.kt`
- **Pure logic ports live in `core/` and are JVM-unit-tested against the web behavior** — the board
  category carve-out (`core/Board.kt` ↔ `board.js` `categoryOf`), the typewriter reveal (`core/Reveal.kt`
  ↔ `chat.js` `repaint`), the summary-tile reducers (`core/Fleet.kt` ↔ index.html
  `fleetTokens`/`mergeModels`). Port the *logic* there and keep the Compose screen a thin renderer.
- **Match features and structure, not pixels** — laid out platform-idiomatically (a Material dropdown for
  a `<select>`, an overflow menu for the ⋯ menu). A justified platform difference (native chat vs ttyd
  terminal, the Hub-URL login field, voice dictation) is recorded in `android/PARITY.md`, the **living
  gap tracker** — update it whenever you close a gap or knowingly open one.

### In-app update (XERK-11)

- A stopgap self-updater until the app ships on Google Play: checks the **public** `xerktech/turma`
  releases for a newer APK and, on a one-tap **Update**, hands it to the system package installer.
  `core.Update` is the pure, JVM-tested picker (`apkAssetVersion`, `compareVersions`, `latestApkUpdate`);
  `net.Updater` is the I/O; `ui.UpdateBanner` + `vm.UpdateViewModel` render it.
- It compares the version in the **asset FILENAME** (`turma-android-v<x.y.z>.apk`) against the installed
  `versionName`, never the release TAG, and scans every recent release's assets, not just "latest".
- **Anonymous + credential-isolated**: the updater uses its OWN `OkHttpClient` WITHOUT `HubClient`'s
  Basic-auth interceptor, so the hub password never reaches github.com. Checked on app start and each
  Dashboard visit, throttled ~15 min; **quiet on failure**.
- Install uses `REQUEST_INSTALL_PACKAGES` + a `FileProvider` (`@xml/file_paths`, authority
  `${applicationId}.updates`) over a `content://` URI. On API 26+ the OS gates on "install unknown apps";
  ungranted, the updater routes to that settings screen and the banner reads **Install**. The OS verifies
  the APK signature, so no sha is re-verified.
- **Stable signing key (XERK-26)**: in-place update works ONLY when every build shares one cert, so
  `release.yml` builds `assembleRelease` signed with a fixed keystore committed to the repo
  (`android/app/turma-release.keystore`, wired in `app/build.gradle.kts`'s `signingConfigs`). Never
  `assembleDebug` — each CI runner generates that key fresh, forcing an uninstall+reinstall on every
  update. The key is deliberately in the public repo; Play App Signing supersedes it on Play.
- Tests: `core/UpdateTest.kt`. Built with Gradle (wrapper generated in CI, not committed); PR-gated by
  `android-ci.yml` on `ubuntu-latest`, JDK 17 and Gradle pinned in-job to match `app/build.gradle.kts`.
  Setup + FCM wiring in `android/README.md`.

## `.github/workflows/`

GHCR image builds and PR gates — see Build & Deploy.

## Build & Deploy

### Unified releases

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all five components + a changelog**, cut by
  `.github/workflows/release.yml`. See `RELEASING.md` and `.github/scripts/README.md`. Never split back
  into per-component workflows — their independent `run_number` patches drift out of lockstep.
- The root **`VERSION`** file holds `MAJOR.MINOR` only. The **patch is derived from existing `v*` tags**
  (`max` on that line + 1), never committed. Bump `VERSION` only for a minor/major.
- The five components: `turma` image, `agent` image, glasses `.ehpk`, android `.apk`, native agent
  tarball. All version math (tag-derived patch, android `versionCode` packing, the strictly-greater guard)
  lives in the tested `.github/scripts`.

### What a release builds vs carries

- Only **changed** components build; **unchanged** ones are **carried** — their prior artifact is
  published at its own prior version, not rebuilt. Every release publishes all five.
- **Images**: carried → the manifest references the prior `:version` tag (no retag); a carried image's
  `:latest` is already correct, so Watchtower needs nothing.
- **Assets** (`.ehpk`/`.apk`/`.tar.gz`): a carried asset is copied forward under its **original name** (the
  filename must describe the bits — Even Hub / Android installs by the version baked inside). A built asset
  is named at the new version.
- A per-release **`manifest.json`** is the machine-readable source of truth for each component's version +
  where its bits live — read by the next release's `plan`, the native updater, and humans. The bundled
  Claude Code release is pinned via `CLAUDE_CODE_VERSION` but is **not** part of the version.
- Watchtower keeps `:latest` current; the DockerOps compose references
  `ghcr.io/xerktech/turma-agent:latest` — keep that ref in sync if renamed here.
- Trigger: `workflow_dispatch` (`dry_run` defaulting on) plus `push: main` for auto patch releases. A
  manual `minor`/`major` dispatch bumps `VERSION`, rolls intervening patches into `CHANGELOG.md`, and
  force-builds every component.
- The `push: main` trigger is **path-filtered to the four component source dirs**, restating `changes.js`'s
  `PREFIX_MAP` (a workflow trigger can't call into JS; a test asserts the two match). A docs-only merge
  cuts no release.

### Deployment (DockerOps, not here)

- `compose/turma-truenas.yaml` defines the `turma` service and a single per-host `agent-host` container:
  mounted at `REPOS_ROOT`, `MAX_SESSIONS`/`TTYD_PORT_BASE`, host mounts, the shared
  `TURMA_TOKEN`/`TURMA_AGENT_TOKEN`, the FCM push service-account (`FCM_SERVICE_ACCOUNT_JSON`), basic-auth.
  Its `mem_limit`/`cpus`/`pids_limit` are sized against `MAX_SESSIONS`. No pricing/cost env — usage is
  counted in tokens per model, so there is no rate table.
- Changing how it's RUN (or adding a host) is a DockerOps compose edit; image content edits land here.
- The hub's `/data` volume holds `state.json` AND the durable session archive, so it must be a
  persisted volume. Overridable via `ARCHIVE_DIR`/`ARCHIVE_DB`.
- The `turma` service also takes the LiteLLM env for **Whisper STT** (`LITELLM_URL` = that instance's
  `/v1` base, optional `LITELLM_API_KEY`; legacy `WHISPER_URL`/`WHISPER_API_KEY` override), and
  `NODE_NO_WARNINGS=1` to silence `node:sqlite`'s experimental warning.

### PR gates (pre-merge to main)

The build workflows run only post-merge; these run on `pull_request` → `main` and block the merge:

- `code-scan.yml` — Semgrep SAST over the JS/Python + Dockerfiles + secret patterns, hadolint on both
  Dockerfiles, ShellCheck on `entrypoint.sh`. Also unit-tests the release logic
  (`.github/scripts/tests`) and the native updater (`test_turma_agent_update.sh`).
- `turma-agent-image-scan.yml` / `turma-image-scan.yml` — build each image locally (no push) and
  Trivy-scan for CVEs + secrets (`ignore-unfixed`, HIGH/CRITICAL gate), path-filtered to their folder.
- `glasses-ci.yml` — path-filtered to `glasses/**`, runs typecheck + Vitest + production build in a
  throwaway `node:24-alpine` container.
- `android-ci.yml` — path-filtered to `android/**`, runs JVM unit tests + `assembleDebug`.

Because the images bundle third-party binaries, keep the pinned tool versions current — that's how most
CVEs are cleared. Non-actionable upstream base-image findings go in the root `.trivyignore` (a reviewed
triage list, each with a reason); anything unlisted still fails.

### The agent image's cloud CLIs

- The agent image bundles **terraform, `az` and `aws`** (pinned via
  `TERRAFORM_VERSION`/`AZURE_CLI_VERSION`/`AWS_CLI_VERSION` in `agent/Dockerfile`), so a session can manage
  infrastructure the way it manages GitHub through `gh`. They live in the `tooling` stage, so **every
  tier carries them and the CI scan covers them** — they are credential-bearing tools talking to cloud
  control planes. Cost: ~1.0 GB.
- **Creds are the host's, reused through optional bind mounts** like `~/.claude` and `~/.config/gh`; the
  image bakes no credential: `/root/.aws` (or `AWS_*` env) — `aws`; `/root/.azure` — `az`;
  `/root/.terraform.d` — terraform. **A host that mounts none is supported, not an error**;
  `entrypoint.sh`'s preflight only LOGS which stores it found, keying on a **login-marker file** never
  the store dir, because each CLI creates its own store just by RUNNING. The Dockerfile's build-time
  smoke test drops the stores it creates.
- `permissions.deny` protects those stores — see Safety guard. Tests: `test_entrypoint.sh`
  (cloud-creds cases), `test_guard_settings.py`.

### The agent image's Android toolchain

- The images bundle the docker CLI, `gh`, ttyd, npm, and — in the agent image — a **JDK 17 + Gradle +
  Android SDK** toolchain: `gradle`/`sdkmanager`/`avdmanager`/`adb`/`aapt2` on PATH, pinned via
  `GRADLE_VERSION`/`ANDROID_CMDLINE_TOOLS`/`ANDROID_PLATFORM`/`ANDROID_BUILD_TOOLS` in
  `agent/Dockerfile`.
- **The image is tiered** (`AGENT_BASE`):
  - `:latest` is the `android-build` tier (2.0 GB), no emulator or system image (those cost 4.4 GB and
    nothing in CI or `android/` needs them).
  - To RUN an app, `adb connect` to a device or an emulator on a KVM-capable host (`platform-tools` is in
    the tier); that path is hardware-accelerated, unlike the bundled AVD (needs `/dev/kvm` passed).
  - If you need an in-container AVD, `:emulator` (the `android` tier, 6.4 GB,
    `ANDROID_EMULATOR_TAG`/`ANDROID_EMULATOR_ABI`) is built on demand via `agent-emulator-image.yml`.

### Where jobs run

**Every workflow runs on GitHub-hosted `ubuntu-latest`**, including the image builds (their layer cache is
`type=gha`, GitHub-side, so it follows the job).

- Disk is the real constraint for the agent image, handled in-job: the scan writes **one** image copy
  (build straight to a docker-archive, `trivy --input`) instead of three, scans the slim `tooling` tier,
  and both agent jobs delete the runner's ~25 GB of unused preinstalled toolchains up front. That reclaim
  is only safe because those builds are hermetic — **don't copy it into `android-ci.yml`, which builds
  against the runner's own Android SDK.**
- Hosted bills **rounded UP per job**, so prefer fewer batched jobs.
- The self-hosted-box workarounds are **deleted, not disabled** — reintroducing any is a regression:
  "Reset workspace ownership" steps; per-job `DOCKER_CONFIG` scoping; `docker image prune` /
  `docker builder prune` cleanup; throwaway `node:24-alpine` containers for `npm view`; the
  `mingc/android-build-box` container. If a job genuinely needs self-hosted again, say which in a
  comment on its `runs-on` and bring back only the ones it needs.

Still true: no GitHub Advanced Security, so no code-scanning API — findings live in the job log and
`--exit-code` is the gate (no SARIF upload). Trivy is installed from its release tarball to
`$HOME/.local/bin` (the trivy-action pins a step to a tag upstream deleted).

## Conventions

### Credentials

- All credentials are inline in environment variables (no Docker secrets mechanism), set in
  DockerOps' `compose/turma-truenas.yaml`, never here.

### Run-as identity (host permission parity)

- The container writes into bind-mounted HOST dirs — the git root and the Claude login (`~/.claude`) — so
  the uid it runs as is the uid those files end up owned by on the host.
- `entrypoint.sh` resolves an identity BEFORE anything starts and `setpriv`s down to it: **`PUID`/`PGID`
  if set, else auto-detected from the owner of `REPOS_ROOT`**. A root-owned git root (TrueNAS) resolves
  to `0:0` and stays root; a user-owned one (WSL/desktop) drops to that uid, so nothing lands root-owned
  in the operator's repo or `~/.claude`. `PUID=0` forces always-root.
- Because it drops, the entrypoint also:
  - reuses an existing passwd/group entry for the id (the node base image ships `node` at `1000:1000`);
  - `chown`s `/root` non-recursively (its children are the host's own bind mounts), since **HOME stays
    `/root`**, which every mount target and `PROJECTS_ROOT`/`~/.turma` path depends on;
  - joins the group owning `/var/run/docker.sock` (the `docker` CLI still needs it);
  - **self-heals on boot**, `chown`ing leftover uid-0 paths under `REPOS_ROOT`/`~/.claude` to the resolved
    id.
- That heal only ever touches uid-0 paths, so a mis-set `PUID` can misplace root-owned files but never
  take the host user's own files away.
- Verified by building the entrypoint on the real base image against
  root-owned/user-owned/`PUID`-override/`PUID=0` roots.

### How a session runs

- Each session runs as that identity as an interactive `claude --remote-control`, defaulting to
  `--permission-mode auto`; the composer can pick `bypassPermissions`/`acceptEdits`/`plan`/`default`.
  `bypassPermissions` is refused **under root** unless `IS_SANDBOX` is set (in the compose env).
- Deliberately the interactive form, not `claude remote-control` server mode (whose terminal is a QR/status
  lobby with no conversation).
- Sessions are independent processes inside the one container, so a session ending doesn't restart the
  container — the manager marks it stopped. "Restart (clear context)" relaunches a single session's Claude
  in place.
- All of a host's sessions share the one mounted `~/.claude` login; distinct worktree paths give each its
  own project slug and Remote Control bridge pointer. `MAX_SESSIONS` caps concurrency; the manager staggers
  launches on boot.
- Agents connect purely outbound to the public `TURMA_URL` (the Cloudflare tunnel), so they work from any
  host/network.

### Safety guard

- Sessions run hands-off, so every launch passes `--settings` a generated file
  (`build_guard_settings()` → `~/.turma/guard-settings.json`) wiring a `PreToolUse` hook over Bash —
  `agent/hooks/guard.py`, stdlib-only at `/usr/local/bin/hooks/guard.py` — plus `permissions.deny`
  rules on host credential stores (`~/.ssh`, `~/.aws`, `~/.azure`, `~/.terraform.d`, `~/.claude`,
  `~/.config/gcloud`; shared by every session, so deny wins even under bypass).
- It hard-denies three narrow categories, each with a reason the agent self-corrects from:
  - **destructive** — `rm -rf` of `/`/home/system/`.git`, disk wipes, fork bombs, power changes, recursive
    `chmod`/`chown` of system roots, protected-branch history destruction, `DROP DATABASE|TABLE`;
  - **policy** — push to / delete `main`/`master`, or self-merging a PR/MR (`gh pr merge`,
    `glab mr merge`, an ADO complete/auto-complete — work lands via a PR a human merges);
  - **attribution** — AI self-attribution trailers in commit/PR messages.
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) is untouched; allowlist a command
  via `$TURMA_TOOL_GRANTS` (CSV of `Bash(<cmd>)`), attribution via `$TURMA_NO_ATTRIBUTION=0`.
- It classifies what the SHELL runs, **never the raw string** — `qa.md` §6.1 is the rule and its limits.
- Fails open on malformed input; an unwritable settings file still launches the session. Keep in sync
  with the twin hook outside this repo. Tests: `test_guard.py`, `test_guard_settings.py`.

### AskUserQuestion answer bridge

- The same generated `--settings` file wires a **second `PreToolUse` hook over `AskUserQuestion`** —
  `agent/hooks/ask.py`, stdlib-only, at `/usr/local/bin/hooks/ask.py` — the glasses answer bridge, since
  Claude's own picker is a TUI affordance the glasses client isn't attached to. For each question it
  writes `~/.turma/questions/<sessionId>.req.json` (keyed on the session id from
  `TURMA_SESSION_ID`/`TURMA_QUESTIONS_DIR`, prefixed onto the `claude` command in `_launch_tmux`) and
  **blocks**, polling for the answer file `answer_question()` drops.
- The answers are returned as a `PreToolUse` **deny** whose `permissionDecisionReason` is a
  `{kind:"askuserquestion_answers", answers}` JSON blob — deny-with-reason is the channel because a
  `PreToolUse` *allow* can't carry typed answer data; Claude reads the answers out of the tool_result.
- Because AskUserQuestion is serialized per session, req/ans files key on the session id alone. The
  hook's block timeout (`TURMA_QUESTION_TIMEOUT_SEC`, default 600s) sits under the settings-level
  `timeout`. It passes through silently when its env vars are absent. Kill/delete/restart clear pending
  req/ans files.
- Tests: `test_ask.py`, plus `TestHookQuestion`/`TestAnswerQuestion` and `test_guard_settings.py`.

### New-work branching policy

- A session's checkout is only as fresh as spawn (`default_base_ref`'s short-bounded `git fetch` falls
  back to a stale local ref; a repos-root session works on whatever branch the host last left checked
  out).
- So every launch (spawn AND resume) passes **`--append-system-prompt`** a fixed directive
  (`NEW_WORK_SYSTEM_PROMPT`, appended in `_launch_tmux`) telling the agent to refresh the base ITSELF when
  it starts new work: `git fetch origin`, resolve the default via `refs/remotes/origin/HEAD`, cut its
  branch from that **remote** ref rather than the current HEAD, carrying uncommitted work across and
  flagging a stale base when the fetch fails.
- It's `--append-system-prompt` because settings.json has no field carrying instructions, and a
  **directive rather than manager-side enforcement** because only the agent knows when "new work" begins.
- Tests: `TestSessionLifecycle`.

### Session activity summaries

- Each session gets a few-word "name" for its task, shown on the card: generated **agent-side** from the
  initial task prompt by the host's authenticated `claude -p` (Haiku default) — reusing the mounted
  login, so **no external API, key, or endpoint**. `_start_summary()` runs it detached (cwd `~/.turma`,
  no `--settings`, so it never loads the guard or explores the repo) and `_poll_summaries()` reaps it on
  later beats, cleaning the output (`clean_summary()`: first line, quotes/punctuation stripped, ~6 words)
  into a persisted `summary`. Always on; tuned only by
  `SESSION_SUMMARY_MODEL`/`SESSION_SUMMARY_TIMEOUT_SEC` (45). The claude.ai/code registered name
  (`rcName`) is still fixed at spawn.
- Tests: `TestCleanSummary`, `TestSetSummary`, `TestSessionSummaries`, `TestSummaryDue`,
  `TestSeedSummaries`, `server.test.js`, `sessions.test.js`.

#### Naming attempts

- The attempt fires at spawn from the initial task prompt, or — for a bare/quick-spawned session — from
  its **first user prompt read straight out of the transcript**: `_seed_summaries()` runs each beat and,
  for every running, still-unnamed session, pulls that prompt via `_first_user_text()` (skipping the
  header, `isMeta` caveat entries and `<command-…>` slash-command wrappers) and calls `_start_summary`.
  That read is **channel-agnostic** and the only path that names a bare session, whose first prompt is
  typed into the ttyd terminal and **never reaches `send_input`**; `send_input` still starts one
  immediately as a fast path for the FIRST attempt — retries belong here.
- Naming is **bounded-retry, not one-shot**: an attempt can come back with no name for reasons unrelated
  to the session (a nonzero exit, an empty reply, the timeout, a rate limit on the shared login), which a
  single attempt would make permanent. `_summary_attempts`/`_summary_due` gate every path
  on *unnamed + attempts left + past the backoff*: `SUMMARY_MAX_ATTEMPTS` (3) tries spaced by a growing
  `SUMMARY_RETRY_BACKOFF_SEC` (90s × attempt), in a persisted `summaryAttempts`/`summaryRetryAt` armed at
  launch, so a restart mid-attempt neither loops nor loses the retries owed. Backed off rather than
  per-beat because of the shared login; the legacy one-shot `summaryStarted` still reads as "one attempt
  spent", so a session an older agent failed to name picks up its remaining retries.
- A session with no prompt yet (`_first_user_text` finds nothing) stays unnamed, spends **no** attempt,
  and looks again next beat. Once exhausted it degrades to "no summary" (label/worktree fallback).

#### Manual rename

- **The operator can rename a session by hand**: the Sessions page's ⋯ menu →
  `POST /api/agents/<host>/sessions/<id>/summary` → a `setSummary` command → `set_summary()`, the typed
  name through `clean_manual_summary()` (first line, whitespace collapsed, capped to `SUMMARY_MAX_CHARS`
  — but NOT word-capped or stripped of quotes/punctuation) and persisted like the auto one.
- It sets `summaryManual`, which pins the card: `_summary_due` already declines to name a session that has
  any name, and the flag additionally stops a still-in-flight `claude -p` job from clobbering it in
  `_finish_summary`. A blank rename clears the name (back to the label/worktree fallback) and unpins —
  the only way back to auto-naming. Renaming works on a stopped session too.
