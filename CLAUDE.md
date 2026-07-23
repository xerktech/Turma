# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Editing This File

Keep it merge-friendly and small — several PRs are usually open against it at once, and it is loaded
into every session's context.

- **Stay well under 150k characters** (Claude Code's hard limit). Check with `wc -c CLAUDE.md`; when
  you approach it, consolidate before adding.
- One idea per line, wrapped at ~100 characters; nested bullets and headings, not run-on paragraphs —
  a single multi-kilobyte line conflicts every open PR.
- When adding to a component, add a **new bullet** rather than extending an existing one.
- **Document current behavior, not its history.** State the rule and the one-line reason it must not be
  undone — don't narrate the bug it replaced, retell the symptom, or make the same point twice. A
  decision that supersedes an old one **replaces** that text; it does not append beside it.
- Keep `Tests:` pointers to file + test-name; skip per-case descriptions.

## What This Repo Is

Turma is the source and CI for the Claude Code agent fleet used with the TrueNAS-based home lab:

- A **one-container-per-host** agent image that scans a git root and multiplexes many
  worktree-backed Claude Code Remote Control sessions.
- A central dashboard ("turma") that lists each host's repos, spawns/kills those sessions, and
  monitors them.

It builds two images and pushes them to GHCR; the running stack is deployed from the sibling
**DockerOps** repo (`compose/turma-truenas.yaml`, deployed via Portainer GitOps).

## Session Model (post-redesign)

Replaced the old model of one fixed-repo container per session.

### Hosts and repos

- One agent container per physical host, mounted at a git root (`REPOS_ROOT`, e.g.
  `/mnt/data/Docker/git`), scanned one level deep for git repos.
- Alongside the scanned repos it advertises a **repos-root pseudo-repo** (`ROOT_REPO_NAME`, shown as
  "⌂ Repos root") — see "Repos-root sessions" below.

### Spawning a session

- Pick a repo and spawn a **session**, backed by a randomly-named git worktree (dir keyed on the
  session `<id>`) under `REPOS_ROOT/.turma/worktrees`.
- The worktree is checked out **detached HEAD**, forked off the latest default branch (`origin/HEAD` →
  main → master), best-effort fetched. An operator can override the base in the composer.
- **The app creates no branch of its own.** The running agent creates and names its own branch when
  ready; that live branch (read from the worktree's git HEAD) shows on the session card, "detached"
  until then.
- A ticket session is told the exact branch NAME (`PROJ-123`, `-1`, `-2`) but still cuts it itself —
  the worktree stays detached and the invariant holds. See "Ticket branch naming".
- The session runs its own `claude --remote-control` in its own tmux (`agent-<id>`) + loopback ttyd,
  with an optional initial task prompt (claude's positional prompt) and optional
  `--model`/`--permission-mode`.
- Many sessions run concurrently (up to `MAX_SESSIONS`), including several on one repo via separate
  worktrees. Each registers in claude.ai/code as `<host>-<repo>-<worktree-or-label>`.
- All spawn options are validated agent-side (allowlisted base refs, fixed model/permission enums), so
  nothing free-form reaches the shell. The worktree dir and `agent-<id>` tmux are the canonical
  internal keys; a label is presentational only.

### The session queue (XERK-14)

- A spawn that can't run RIGHT NOW is **queued, not refused** — an ordinary registry record with
  `status:"queued"` and no worktree/tmux/ttyd yet. `spawn()` splits into the record-build and
  `_provision_session()` (worktree + tmux + ttyd + naming); a queued session runs through the SAME
  `_provision_session` when allowed.
- Three orthogonal `queuedReason`s, each re-checked by the drainer: **capacity** (host at
  `MAX_SESSIONS`), **awaiting-clone** (its repo is being cloned on demand), **root-busy** (another root
  session holds the one root slot).
- The queue/run decision is made BEFORE the record is appended, so counts exclude the session being
  added (else a root sees itself as root-busy; capacity is off by one). Prompt/base-ref stash as
  `_pendingPrompt`/`_pendingBaseRef` and `_provision_session` consumes them.
- `_drain_queue()` runs every heartbeat: oldest-first, **at most one per beat** (provisioning launches
  claude against the one shared `~/.claude` login), head-of-line skipped not blocking. A failed
  on-demand clone fails the session; a clone job lost to a restart mid-flight re-triggers from
  `awaitCloneOwner`.
- Capacity rides the heartbeat as **`capacity` = {maxSessions, running, queued, free, rootRunning}**
  (`_capacity_payload`), so the hub can tell a full host from an empty one. `free` never goes negative.
- Queued sessions are killable (Cancel) — no worktree/tmux to tear down. resume-on-boot skips them
  (the drainer picks them up); archival/usage/PR scans skip them. Surfaced as
  `session.queuedReason`/`queuedAt`.
- **The queue applies to every spawn path; only TICKET spawns split across hosts.** An explicit "+ New
  session" queues on the host whose card was clicked. See "Splitting ticket sessions across an org's
  agents".
- Tests: `TestSessionLifecycle`, `TestSpawnTicket` in `agent/tests/test_hub_agent.py`; the
  Queued-section cases in `turma/tests/sessions.test.js`.

### Repos-root sessions

- Spawning against the repos-root pseudo-repo runs `claude` directly in `REPOS_ROOT` — spanning every
  repo — with **no worktree and no branch**, so the base-branch option doesn't apply. Kill/delete tear
  down only the processes; `REPOS_ROOT` is never touched.
- All root sessions share that one cwd (hence one claude project slug + Remote Control bridge pointer),
  so **at most one root session runs per host at a time** (enforced on spawn/start/resume).
- Killable/resumable like any session; its transcript persists under `REPOS_ROOT`'s project slug.
- Because they share it, that ONE project slug dir accumulates EVERY root session's transcript — which
  is what makes "this session's conversation" a real question here (a tautology elsewhere) and why the
  pin below exists. See "Which transcript is a session's".

### Which transcript is a session's

- Every launch **pins claude's session id** — `--session-id <uuid4>` minted in `_launch_tmux` for a
  fresh conversation, or the `--resume` id for a rejoined one — persisted as `claudeSessionId`. Claude
  Code names the transcript after it, so a session's conversation is `<claudeSessionId>.jsonl` under its
  cwd's project slug, known by name from before its first byte.
- `_session_transcript_path()` is the one resolver every surface goes through (heartbeat signals + tail,
  `history`, subagent resolution, summary seeding, closed record's `transcriptId`, `--resume` target);
  the hub heartbeats the id so `tunnel-agent.js`'s live tail (`watch` → `sessionTranscript`) points at
  the same file.
- Replaced a **newest-mtime rule**, which is exact for a worktree session (its dir holds one
  transcript) but wrong for a root session (its dir holds every root session's): the newest was the
  PREVIOUS root session's until the new claude wrote, so a fresh root session opened onto the last one's
  chat and on resume *relaunched it* (XERK-6).
- **A pinned session with no transcript on disk has not spoken, and resolves to nothing.** Never add a
  newest-mtime fallback for that case — it reads as an empty conversation exactly once, before the
  first turn, which is the truth.
- A session launched by an agent predating the pin carries no id and keeps the newest-mtime rule.
- Naming the transcript means the hub must say when the name CHANGES: a watch is sent once (first
  watcher / control reconnect) and held, so `rearmMovedWatches` re-sends it when a watched session's
  `transcriptId` moves. Only "Restart (clear context)" moves it; without the re-arm that session's chat
  freezes on the pre-restart conversation.
- Still slug-keyed, so still sharing one identity across a root session's neighbours: archival's
  running-session exclusion (`_running_slugs`) and the summary/date an archived transcript inherits
  (`_session_meta_by_slug`), both now fixable per transcript rather than per slug.
- Tests: `TestRootSessionIsolation` in `agent/tests/test_hub_agent.py`, the `sessionTranscript` cases
  in `agent/tests/tunnel-agent.test.js`, the live-WS watch cases in `turma/tests/server.test.js`.

### Kill, resume, delete

- Sessions are spawned/killed/started/restarted/deleted from the hub.
- **Killing** drops the registry record (removing it from the ACTIVE list) but KEEPS its worktree
  (uncommitted work survives), conversation, and token-usage history. Transcripts live under
  `~/.claude/projects`, keyed by worktree path, separate from the worktree files.
- It moves to the Sessions page's **Ended sessions** list, from which it can be read and resumed.
- On the way out, `_remember_closed` **snapshots onto the closed record** the `prUrls` this session
  opened and its `transcriptId` — both keyed by session id in caches `_forget_session_caches` drops
  moments later, so the snapshot is the only thing that keeps an ended session's PR chips reachable. The
  PR *status* stays in `pr_status_cache` (`refresh_pr_status` counts closed records as referenced; not
  re-polled, same as a stopped session).
- The closed history is a **cache of what a kill knew, not the record that it happened**: it buys the PR
  links and original session id (so `resume` hands it straight back) from the instant of the kill.
  `closed.json` keeps only `CLOSED_PER_REPO` per repo, so the 6th kill evicts the oldest. **Anything
  that must survive belongs on the durable side** — the transcripts under `~/.claude` (which
  `_resumable_report()` re-derives from, keeping a killed session in the Ended list across a restart),
  the hub's archive, and the ledgers in `~/.turma`.
- **`~/.turma`'s durability is the HOST's to provide, and no code here may assume it.** A native install
  puts it in `$HOME`; a container must bind-mount it or it is the image's writable layer, recreated on
  update. The deployed stack mounts it (DockerOps → `/mnt/data/Docker/Turma-agent`); every ledger still
  reconciles from disk rather than trusting itself. It went unmounted for a long while, silently
  reverting a board repo pin and a ticket's session list on every image update.
- Each repo's **"Resume"** picker lists **every prior Claude session for the repo** whose origin cwd is
  resumable on this host — `repo.resumable` from `_resumable_report()`: killed/deleted/pruned Turma
  sessions, repo-dir dev runs, and older ones aged out of `closed.json`.
- Resuming relaunches `claude --resume <transcript id>` **cwd'd at that transcript's origin path**,
  re-creating a deleted/pruned worktree there first: Claude scopes id lookup to a repo's live worktrees
  + repo dir, so the origin must exist for `--resume` to resolve (`resume_transcript`).
- A dev-machine session synced through the shared `~/.claude` has a foreign cwd and stays view-only,
  resumable only where it ran.
- **Delete** (on a stopped session) also removes the worktree. Since the app owns no branch, any branch
  the agent committed survives; only uncommitted worktree files are lost.

## Repository Structure

Top level: `agent/`, `turma/`, `glasses/`, `android/`, `.github/workflows/`. Each is detailed below.

## `agent/` — per-host headless agent image

Currently Claude Code; the name is agent-generic so it can host other agents later.

### `hub-agent.py` — session manager and heartbeat in one process

- Scans `REPOS_ROOT` for repos.
- Owns a persisted session registry (`~/.turma/sessions.json`).
- Executes hub-issued commands riding the heartbeat reply (at-least-once, `cmdId` de-dup) — see
  "Commands".
- Drives each session's worktree + tmux + ttyd.
- Heartbeats the repo list, one record per session, and a container-log tail — see "Heartbeat".
- On boot it auto-resumes sessions that were `running`:
  - `resume_on_boot` **adopts** a session whose claude tmux is still alive (tmux/ttyd are their own
    daemons, outliving a manager restart) — skips the relaunch and only re-ensures the ttyd, leaving the
    running claude untouched. This lets the native agent update in place without stopping sessions. Falls
    back to `--resume` relaunch only when the tmux is gone (container restart, reboot, crash).
  - ttyd is adopted by port when the persisted `ttydPid` is alive; `_kill_ttyd` reaps that pid so an
    adopted ttyd isn't leaked on stop/delete.
  - Tests: `TestResumeOnBootAdopt`.

### Commands

- `spawn` / `kill` / `start` / `restart` / `delete` — session lifecycle.
- `resume` — resume a killed session (keeps its id).
- `resumeTranscript` — resume ANY prior transcript by id (see the Session model's resume notes).
  `_resumable_report()` heartbeats each repo's resumable list. Tests: `TestResumableReport`,
  `TestResumeTranscript`, `TestTranscriptCwd`.
- `input` / `history` / `answerQuestion` — for the glasses client.
  - `input`/`send_input` types the message into the session's tmux pane and **guarantees it survives a
    compaction** (XERK-47): an auto-compaction (context ~95%) can drop a message queued mid-turn instead
    of consuming it. `send_input` records every sent message on the record's `pendingInputs` outbox, and
    `_poll_pending_inputs` (every beat, no-op unless a session has an outbox) makes it at-least-once:
    - a compaction is detected from the transcript's own `compact_boundary` **system entry**
      (`compactMetadata.trigger` = auto/manual) counted by `_pending_scan`, not by scraping the pane;
    - a message is **reaped on delivery** (`_pending_scan`'s `delivered` — it appeared as a real user
      turn) or **left in flight** while still in the folded live queue (`queued`);
    - it is **re-sent** only when a NEW compaction happened since it was sent (`compactBase` rose) AND
      it's neither delivered nor queued AND the pane has settled to idle (`_pane_busy` False, not None) —
      the pane-idle + not-queued gate makes the resend **duplicate-safe** (a surviving queued message
      waits rather than double-sending);
    - bounded: `PENDING_INPUT_MAX_ATTEMPTS` resends (each needing a fresh compaction), one per beat,
      aged out at `PENDING_INPUT_TTL_SEC`;
    - `delivered` matches by text with no timestamp filter, biased AGAINST a resend (re-sending an older
      turn's exact text reads as already-delivered — a missed resend, never a duplicate).
    - The outbox is internal (not heartbeated), cleared on restart-clear-context. The raw ttyd terminal
      bypasses `send_input`, so a message typed straight into it isn't covered.
    - Tests: `TestPendingScan`, `TestPollPendingInputs`, and the outbox cases in `TestSendInput`.
- `interrupt` — `interrupt()` sends a single Escape to the tmux pane (the key an operator would press),
  cancelling the in-flight generation/tool call with session and conversation intact. The gentle
  counterpart to kill/restart; deliberately NOT gated on `paneBusy` (Escape into an idle pane is
  harmless). Tests: `TestInterrupt`.
- `setSummary` — rename a session; see "Session activity summaries".
- `setModel` — switch a running session's model live, **for that session only** (XERK-33).
  - `set_model` drives Claude Code's /model picker — clear the input line (C-u), open it, parse rows +
    ❯ cursor (`parse_model_picker`), arrow to the target, press `s` ("use this session only") — instead
    of `/model <name>`, whose argument form ALSO saves the pick as the login-wide default (shared by
    every session on a host).
  - The arrows go **one press at a time, each verified by re-reading the ❯** (`_await_picker_step`), so
    a dropped/doubled key can't land `s` on the wrong row. The record updates only on the TUI's own "Set
    model to…" confirmation (`_await_model_confirmation`); unconfirmed, it keeps the old value and
    `modelActual` settles the chip.
  - Gated on a **fresh** pane-busy read (it types into the pane), but a busy pane **defers, never
    drops**: the pick lands as `sess["pendingModel"]` (persisted, heartbeated) and
    `_apply_pending_switches` applies it on the first idle beat, re-deferring if a new turn started.
  - Backs out with Escape when the picker doesn't appear or has no row for the target (the bracketed
    `[1m]` aliases have none). Validation is `resolve_model` against the static aliases + probed list.
  - Tests: `TestSetModelMode`, `TestParseModelPicker` in `agent/tests/test_hub_agent.py`.
- `setMode` — switch a running session's permission mode live, as a **closed loop**: press Shift+Tab,
  read the footer's mode marker back (`parse_pane_mode`), repeat until the target reads back or the cycle
  wraps to its start (target not in this session's cycle — a logged no-op).
  - Not a computed press count: the REAL cycle is account- AND model-dependent (auto joins/drops per
    account and model) and the record's "current" goes stale when the operator cycles by hand. Blind math
    survives only as `_set_mode_blind`, the fallback for a marker the parser can't read.
  - **What is stored is always what was read**, so the record can't lie about the mode.
  - No busy gate: BTab types nothing into the input line and the TUI cycles modes mid-generation.
  - Tests: the set_mode cases in `TestSetModelMode` (`_ModePane` simulator), `TestParsePaneMode`.
- `clone` — see "GitHub block and cloning".
- `refreshJira` — the /board manual refresh: re-poll Jira now instead of waiting out
  `JIRA_REFRESH_EVERY`. Re-checks `jira_configured()`, so an unconfigured host stays at zero Jira calls.
- `prune` — per-repo cleanup: removes worktrees merged into the latest default branch (skipping any
  backing a session or holding uncommitted changes), deletes local branches merged into it, reporting a
  summary on the heartbeat.
- `jiraIssue` — fetch one issue on demand; see "Jira block".
- `spawnTicket` — start a session to WORK a Jira ticket; see "Jira ticket sessions".
- `setJiraRepo` — the operator's own repo for a ticket, overriding the guess; see "Manual repo
  override".
- `subagentHistory` — open a background subagent's own transcript; see "Live working footer and agent
  list".

### Heartbeat

- **Repo list**, ordered most-recently-active first: each repo's `lastActivity` is the later of its
  newest commit and newest session activity. The repos-root pseudo-repo is pinned first, never ranked.
- **One record per session**: git state, per-session token usage, live-session signals (below), new PR
  links, and PR status (below).
- A **container-log tail**.
- The build's **own version** (`agentVersion`, shown in the host header): `agent_version()` reads the
  `TURMA_AGENT_VERSION` the image bakes at build time (release.yml passes it as a build-arg), else the
  `VERSION` file `native/install.sh` stamps beside `hub-agent.py`, else the repo-root `VERSION`, else
  `null`. Tests: `TestAgentVersion`.
- The **coding agent** it runs (`codingAgent` = `{name, version}`, the header's "Agent" row; the build's
  own version sits beside it as "Turma"): `coding_agent()` splits `claude --version`'s
  `"<version> (<product>)"`, preferring the product name over the `CODING_AGENT_NAME` default.
  - The NAME is reported because the image is agent-generic — only the agent knows which CLI it execs.
  - The raw string still rides as `claudeVersion` for hubs predating the field; the hub parses it the
    same way (`codingAgent()` in `index.html`). Tests: `TestCodingAgent`,
    `turma/tests/host-header.test.js`.
- The **login's real model list** (`models` = `{available, defaultLabel, at}`, XERK-33), probed from the
  CLI: `claude -p "/model"` prints "Current model: <label>" plus the account's alias list, which
  `parse_model_probe` parses — so the hub's model menus offer what this login can run, with no rate-table
  config to drift.
  - The probe is a detached one-shot on the models cadence (`MODELS_REFRESH_EVERY`, beat 0 covering boot;
    `MODELS_RETRY_EVERY` until first success), same shape as the summary/triage helpers (cwd=REGISTRY_DIR,
    no --settings, reaped by `_poll_models_probe` with kill-on-timeout).
  - A failed/unparseable probe **keeps the previous list**. `None` until the first success (hub falls
    back to its static menu then, and for older agents).
  - `resolve_model(model, extra)` accepts probed aliases beyond the static four, charset-checked
    (`SPAWN_MODEL_RE`; the bracketed `[1m]` variants never reach a launch command line).
  - `modelActual` per session is the probe's per-session counterpart: the incremental transcript scan
    (`_scan_entry_line` — ONE json parse feeding both the PR scan and `_scan_model_entry`) folds each
    assistant entry's `message.model` and the "Set model to X" stdout, newest winning. Persisted; seeded
    once from the transcript tail for older records (`_seed_model_actual`).
  - Tests: `TestParseModelProbe`, `TestModelsProbe`, `TestScanModelEntry`, `TestSessionReportModelActual`,
    `TestSeedModelActual`, `TestModelActualPayload`, `TestInternalToolSlugModelProbe`.

#### Live-session signals

- `paneBusy` — a working/idle read, the **primary** activity signal. `_pane_busy` captures the tmux pane
  and looks for Claude Code's "esc to interrupt" hint, shown exactly while the model is generating or
  running a tool and dropped the instant the turn ends — accurate through a long silent tool call, unlike
  transcript-mtime.
  - `true`/`false`/`null`-unknown; marker set overridable via `TURMA_PANE_BUSY_MARKERS`. All surfaces
    fall back to transcript freshness only when `null` (older agent, or uncapturable pane).
  - **Busy→idle flicker is suppressed at the source** (`_stable_pane_busy`, XERK-42): the TUI repaints
    its spinner by clearing+rewriting the "esc to interrupt" line, so a single capture can land in that
    sub-frame gap and read idle mid-turn — which, sampled once per `TURMA_INTERVAL` (20s) beat, shows the
    session idle for a whole interval and fires a bogus push. So a busy read is trusted instantly while an
    idle read is re-confirmed once after `TURMA_PANE_IDLE_CONFIRM_SEC` (0.2s, 0 disables), only on the
    busy→idle EDGE. The last stable read rides `sess_state`; `None` passes through untouched. Stabilizing
    the SOURCE fixes every surface with no client change. The live-footer scrape guards its own copy with
    a one-poll hold (`liveTurnDecision` in `tunnel-agent.js`). Tests: `TestStablePaneBusy`.
- `modeActual` — the permission mode the TUI is REALLY in, off the footer's mode marker ("⏸ manual mode
  on" / "⏵⏵ accept edits on" / "⏸ plan mode on" / "⏵⏵ auto mode on" / "⏵⏵ bypass permissions on";
  glyph-anchored so quoted text can't match — `parse_pane_mode`, read beside the stable busy in
  `_pane_status`).
  - `_session_payload` **reconciles the stored `permissionMode` to it** each beat (the operator can cycle
    modes by hand, which no command reports), and it feeds `setMode`'s closed loop.
  - Tests: `TestParsePaneMode`, the modeActual cases in `TestSessionReportPaneBusy`/`TestModelActualPayload`.
- **Transcript freshness** — the fallback, not the primary signal.
- **Pending questions** — a pending `AskUserQuestion` is surfaced by the `agent/hooks/ask.py` PreToolUse
  bridge (see "AskUserQuestion answer bridge"), which drops a `<sessionId>.req.json` under
  `~/.turma/questions/` while the call blocks. `session_report` reads it and the answer rides back as
  `<sessionId>.ans.json` — no pane scraping. A transcript scan is the already-answered fallback.

#### PR status

- The state (Open/Draft/Merged/Closed), CI-check rollup (passing/failing/pending), and GitHub's
  mergeability (`mergeable`: MERGEABLE/CONFLICTING/UNKNOWN) of every PR a session opened. Fetched via
  `gh pr view` (`pr_status`/`_summarize_pr`/`_check_class`) on the `PR_STATUS_REFRESH_EVERY` cadence,
  faster than the github block.
- The card's **single ✓/✗/● mark is merge READINESS, not CI** (`ready`, from `_merge_ready`): a PR whose
  branch conflicts merges nowhere however clean its checks. A conflict blocks on its own, and a ✓ requires
  GitHub to have affirmatively said MERGEABLE — the UNKNOWN a just-opened PR reports is `pending` and
  resolves next refresh.
  - Conflicts are only asked about while a PR could still land: a MERGED/CLOSED one reports CI alone. A
    PR with **no checks** keeps its no-mark unless it CONFLICTS.
  - `checks`/`checkCounts` stay pure CI beside it, so the tooltip can say WHY it's blocked. All four
    renderers (`index.html`, `sessions.html`, `chat.js`, android's `PrBadge`) read `ready` and fall back
    to the CI half for older agents.
  - Tests: `TestPrStatus` (readiness) in `agent/tests/test_hub_agent.py`, the `prFooterChip` cases in
    `turma/tests/chat.test.js`.
- Cached by URL in `pr_status_cache`, attached as `session.prs`; kept after the session stops, None until
  it opens a PR.
- **The link set is durable across an agent restart** (XERK-15): a running session mirrors
  `session_pr_urls` onto its record (`sess["prUrls"]`, saved as it grows in `_session_payload`) and
  rehydrates the in-memory map on boot — the same durability a killed session's PRs get off `closed.json`.
  Tests: `test_prs_survive_agent_restart` in `TestRefreshPrStatus`.
- **XERK-13 extends that durability to ENDED sessions and to the status pill**, keyed by transcript id so
  it outlives the registry/closed record. Two durable ledgers beside the ticket one:
  - `pr-sessions.json` (`PR_LEDGER_PATH`, `transcriptId -> {urls, at}`): written whenever the scan finds
    a URL (`_remember_prs`, and on kill from `_remember_closed`), backfilled from closed history. Its
    consumer is the **resumable scan** — the only channel still reporting a session once its closed record
    ages out of `closed.json`, carrying no PRs of its own — which attaches `prs` from the ledger
    (`_ledger_prs`), as it attaches `ticket`. On boot it also `setdefault`-backfills `session_pr_urls`
    for a pre-mirror live record (XERK-15's copy stays authoritative where it has one).
  - `pr-status.json` (`PR_STATUS_LEDGER_PATH`, `url -> status`): `refresh_pr_status` persists the status
    cache and `pr_status_cache` seeds from it at boot — an ended session is never re-polled, so without
    this its chip degrades to a bare link on restart. Ledgered URLs count as `referenced` so an aged-out
    session's status isn't evicted.
  - Tests: `TestPrLedger`, the `carries_the_prs` case in `TestResumableReport`, the resumable-PR-chip
    case in `turma/tests/sessions.test.js`.
- **Which PRs are "a session's"** is decided by `_scan_pr_line`, deliberately narrow: a URL counts only
  when it comes back in a **`gh pr create` call's own `tool_result`** — the one event that says this
  session OPENED that PR. (The old rule regexed any `…/pull/<n>` out of transcript bytes and caught every
  PR a session merely READ.)
  - The call and its result are separate entries, routinely in different beats, so pending `gh pr create`
    tool_use ids carry across beats in the scan state (capped).
  - The scan parses whole JSONL lines (the byte offset stops at the last newline), so a half-written entry
    is re-read whole next beat.
  - Cost: a PR opened another way (a subagent's transcript, an MCP GitHub tool, the web UI) gets no chip.
    Widen by teaching `_scan_pr_line` another creation event — never by scanning loose text again.
- Tests: `agent/tests/test_hub_agent.py` (`TestPrStatus`, `TestRefreshPrStatus`, `TestSessionReport`).

#### PR comment delivery (XERK-49)

- **A reply asking for corrections on a session's PR is typed back into the session that opened it**, so
  the agent continues in place. `_poll_pr_comments` runs on the PR cadence
  (`PR_COMMENTS_REFRESH_EVERY`), for **running sessions only**, over their OWN PRs (`session_pr_urls`).
- Delivery goes through **`send_input`**, inheriting the whole compose path: the compaction-survival
  outbox (XERK-47) and Claude Code's queue if a turn is in flight — exactly as if the operator typed it.
- `_pr_comment_events(url, self_login)` gathers **three channels** (a correction routinely arrives as an
  inline diff-line note): conversation comments and review bodies from one
  `gh pr view --json comments,reviews`, plus inline review-thread comments from
  `gh api repos/<o>/<r>/pulls/<n>/comments`. A bare approve (no body) is dropped. Each event normalizes
  to `{key, author, body, kind, loc, is_self}`, keyed on GitHub's stable id.
- **Baseline-on-first-sight, then deliver only new + not-self.** A PR's whole current comment set is
  recorded silently the first beat it's seen (`prCommentBase`, per-PR seen-key set, capped
  `PR_COMMENTS_SEEN_MAX`), so the session never re-litigates history. After that only keys that are NEW
  *and* not the agent's own (`is_self` via `viewerDidAuthor`, else a login compare against `github.login`)
  are typed in; the session's own comments still fold into the seen-set.
- Best-effort and bounded: skipped without a gh login, capped at `PR_COMMENTS_MAX` PRs per beat, wrapped
  on the heartbeat path, and a fetch failure (`_pr_comment_events` → None) leaves the baseline UNTOUCHED.
  Disable with `TURMA_PR_COMMENTS=0`.
- Known limits: only the session that OPENED the PR receives it, only while running; the raw ttyd
  terminal bypasses `send_input`, but this poller calls it directly.
- Tests: `TestPrCommentEvents`, `TestPrCommentMessage`, `TestPollPrComments`.

### Expected-restart "updating" status (XERK-29)

- An agent update takes the host down like a crash — the container is recreated (or the native manager
  restarted), heartbeats stop, and the dashboard greyed it to `offline` with sessions reading "terminal
  offline". So the manager **announces an EXPECTED restart before it goes silent**: its SIGTERM/SIGINT
  handler (`_handle_shutdown`) POSTs `POST /api/agents/<host>/updating` (`_announce_updating`, agent-token
  authed, best-effort short-timeout).
- One signal covers both paths (both restart via SIGTERM to the manager): a container recreate on a
  Watchtower update (SIGTERM to PID 1) and the native updater's `systemctl restart` (SIGTERM to the
  manager, sessions kept alive by `KillMode=process`).
- The native updater also leaves `~/.turma/updating.json` (`UPDATING_FLAG_PATH`, reason + target version);
  the handler reads it to enrich the announcement (`reason:"update"`). A container update leaves no file,
  announcing a generic `reason:"restart"`. Next boot clears a stale flag.
- Hub-side, the announce sets `a.updating = {at, until, reason, version}` with a `UPDATING_GRACE_MS`
  (5 min) deadline. `serializeAgent` surfaces `updating` **only while the host is silent** (`!online`)
  and within the grace window — a returned host is just `online` again, a stuck update falls to `offline`
  past `until`. The offline sweep suppresses the "host offline" alert while `updating` holds.
- The dashboard renders it as a distinct amber state (`agentState`/`hostCard`): "expected brief downtime"
  tooltip, no "Remove host". Android/glasses predate the field and keep showing `offline` (cosmetic).
- Tests: `TestUpdatingAnnounce`, the updating-hint case in `agent/tests/test_turma_agent_update.sh`, the
  `/updating` case in `turma/tests/server.test.js`.

### Usage aggregates and the attribution ledger

- The heartbeat carries **persistent usage aggregates independent of the live registry**: a per-repo
  `repoUsage[]` and a merged host-level `usage`, computed on the slow usage cadence by re-parsing *every*
  known transcript under `~/.claude/projects` (`repo_usage_report()`). Each `repoUsage` entry carries a
  `remoteKey` (normalized git origin via `normalize_remote()`) so the hub can unify a repo across hosts.
- A durable worktree→{repo, remote, slug} **attribution ledger** (`~/.turma/repo-usage.json`) keeps a
  transcript traceable to its repo after its session and worktree are gone, so **usage history survives
  kill/delete/prune**. It is written at spawn via `_remember_usage`, backfilled from registry/closed
  history, reconciled against on-disk transcripts each usage beat by `_reconcile_orphan_transcripts()`,
  and pruned only when a transcript dir disappears.
- `repo_usage_report()` folds only slugs the ledger names, so reconciliation is what makes "every known
  transcript" mean *every transcript on disk* rather than only live/closed ones.
- Any orphan (aged out of `closed.json`, or predating `_remember_usage`) is adopted best-effort, in order:
  1. exact repo + git origin, when its worktree still exists;
  2. else the repo from the worktree-shaped project slug (also names sibling-tool sessions);
  3. else the repo from the transcript's own recorded `cwd` (`_repo_from_transcript_cwd` — Claude Code
     stamps the real un-slugified working dir, so its final segment names the repo, incl. dev-machine
     sessions synced through the shared `~/.claude`);
  4. else `OTHER_REPO_NAME` (`(other)`), only when no `cwd` is recorded.
- **No real session is excluded.** The one carve-out is the manager's OWN internal `claude -p` helpers
  (session naming, Jira triage, models probe), which run with `cwd=REGISTRY_DIR` yet write a transcript
  into the shared `~/.claude/projects` — else the reconciler adopts the agent's overhead as a phantom
  repo (`.turma` in production, `hub-agent-mgr-*` under a `mkdtemp` `REGISTRY_DIR`, XERK-27).
  `_is_internal_tool_slug` recognizes them by the registry dir's own slug (no read; catches production)
  or, for a harness's temp slug, by the `INTERNAL_TOOL_PROMPT_SIGS` signature of the first prompt. The
  models probe's prompt is a slash command (which `_first_user_text` skips), so it's recognized by
  `_first_command_name` = `/model`. Such a slug is **tombstoned** (`{internal:true}`), which
  `repo_usage_report`/`_archive_manifest` skip. `_sanitize_internal_tool_entries` retires entries earlier
  builds adopted; a real coding session at a repo cwd is untouched.
- **This ledger is also the archive's input** (`_archive_manifest` enumerates ledger slugs), so
  reconciliation *intentionally* widens archival too: every ended session on the box, incl. synced
  dev-machine history, is shipped to and indexed in the hub's archive. Decouple the two inputs only if
  archival scope should diverge from usage scope.
- Tests: `TestReconcileOrphanTranscripts` (incl. the internal-tool tombstone/signature/sanitize cases).

### Jira block

- Optional. With user-scoped Jira Cloud creds (`JIRA_SITE`/`JIRA_EMAIL`/`JIRA_TOKEN`), the agent
  heartbeats the tickets assigned to that user, polled slow (`collect_jira`: active work plus a bounded
  window of recently-Done, two capped queries), shaped to the card fields /board renders (`_shape_issue`).
- Unset creds = feature off (zero Jira HTTP, `available:False`). Read-only by construction — only issue
  search and issue GET.
- **On-demand issue detail.** Description/comment bodies are too big to heartbeat per ticket, so the
  board's expanded view fetches one issue on demand: a `{type:"jiraIssue", issueKey}` command
  (allowlist-checked against the `PROJECT-123` grammar) makes `_stage_jira_issue` call `fetch_jira_issue`;
  the result rides the next beat as `jiraIssueResults` (poked, so a click resolves in ~a round-trip).
- **ADF flattening.** Jira returns rich text as ADF (a nested node tree), which `adf_text`/`adf_plain`
  flatten to plain text agent-side. `_shape_issue_detail` adds description, the newest `JIRA_COMMENT_MAX`
  comments (+ `commentTotal`), people, and full labels, each capped.
- Every failure path (bad key, unconfigured host, HTTP error) stages a result carrying an `error` instead
  of raising. Tests: `TestAdfText`, `TestShapeIssueDetail`, `TestFetchJiraIssue`, `TestStageJiraIssue`.

### Azure DevOps block (XERK-43) — the board's second source

- **The board is source-agnostic; Azure DevOps is a drop-in second source emitting the SAME wire
  contract as Jira.** With a PAT in the env (`AZDO_URL` + `AZDO_TOKEN`, optional
  `AZDO_PROJECT`/`AZDO_USER`/`AZDO_API_VERSION`) the agent polls the work items assigned to the PAT's
  owner and reports them in the same `jira` heartbeat block, ticket and detail shape — so the hub,
  `board.js`, `index.html`, and the clients render an Azure org like a Jira one. `source:"jira"|"azure"`
  rides the block for the few places UI copy varies.
- **An agent serves exactly ONE org** (a host is Jira or Azure, never both).
  `board_source()`/`board_configured()`/`collect_board()`/`fetch_board_issue()`/`board_site_key()`/
  `valid_issue_key()` are the source-dispatch shims that replaced the bare `jira_configured()` gates;
  everything downstream is source-agnostic and reads `self.jira` unchanged.
- **Self-hosted is the point.** `AZDO_URL` is any base — `https://tfs.company.com/DefaultCollection`
  (Server/TFS) or `https://dev.azure.com/org` (Services). PAT auth is Basic with empty username (`:PAT`).
  Read-only: WIQL search + work-item GET.
- **siteKey keeps the org/collection PATH** (`normalize_azure_site` → `dev.azure.com/myorg`), unlike the
  Jira host-only key (else every cloud org merges into one board). It's percent-encoded into
  `/api/jira/<siteKey>/...` (client `encodeURIComponent`, hub `decodeURIComponent`). `board.js`/`Board.kt`
  `orgName` takes the last path segment for a slashed key, else strips `.atlassian.net`.
- **Work-item ids are bare integers**, so `AZDO_KEY_RE`/`valid_issue_key` and the hub's `isIssueKey`
  accept `^[0-9]+$` alongside `PROJECT-123`. Ticket sessions get a human branch base `<project>-<id>`
  (`ticket_branch_base`), not a bare number.
- **State → column.** Azure's per-type `stateCategory` metastate is read from the states API when
  reachable (`_azure_state_map`, cached per project+type), falling back to a static name map, then `todo`
  — mapping to todo/inprogress/done as Jira's `statusCategory` does. The raw state name rides as `status`,
  so the In Review column catches Azure review states.
- **HTML, not ADF.** `collect_azure` (WIQL → batch GET) and `fetch_azure_issue` ($expand=all + comments)
  mirror the Jira collectors; `azure_html_to_text`/`azure_plain` (stdlib `HTMLParser`) is the ADF
  flattener's counterpart. A comments-endpoint failure degrades to no comments.
- Tests: `TestNormalizeAzureSite`, `TestAzureBase`, `TestCollectAzure`, `TestShapeAzureItem`,
  `TestAzureCategory`, `TestAzureHtmlToText`, `TestFetchAzureIssue`, `TestBoardSourceDispatch`, the Azure
  cases in `TestSpawnTicket`; numeric-issue-key cases in `turma/tests/server.test.js`; the `orgName` Azure
  cases in `turma/tests/board.test.js` and `android/.../BoardTest.kt`.

### Jira repo triage (`repoGuess`)

- Each heartbeated ticket carries an optional **`repoGuess`** — which repo that ticket's work belongs in.
- Decided **agent-side** by the container's already-authenticated `claude` in headless print mode
  (`claude -p`, Haiku default), reusing the mounted login and the same detached-subprocess/reap shape as
  the session summaries, so there is **no external API, key, or cost env**.
- It runs on the agent because this host is the only place the three inputs meet — the Jira creds (hence
  the tickets), the scanned repos, and the `gh` sweep. That colocation *is* the "same org" rule.
- `_triage_candidates()` builds the choice list as the host's cloned repos (marked `[cloned]`, which the
  prompt tells the model to prefer) **plus every repo its `gh` login can clone**. The reply is
  **allowlist-validated back against that list** by `_parse_triage` (a hallucinated name drops to "no
  repo"). The guess is purely presentational; no ticket text reaches a shell, path, or URL.

#### The triage ledger

- Decisions are cached in a persisted ledger (`~/.turma/jira-repos.json`, keyed `<siteKey>/<issueKey>`)
  so triage runs **once per ticket, not per beat**.
- Each entry holds two independent things, and **keeping them apart is what makes the cache safe**: the
  **decision** (repo/cloned/reason/`at`, plus the `ticketFp`/`candFp` recording the question it *answers*)
  and the **attempt run** (`attempts`/`retryAt`, plus `tryTicketFp`/`tryCandFp` recording the question
  being *asked*).
- `_triage_stale()` re-triages when the ticket's text changes (`_ticket_fingerprint` — deliberately NOT
  `updated`, which moves on any field edit) or the candidate set does (`_candidates_fingerprint` — repo
  names + cloned-ness ONLY; `_triage_candidates` sorts the gh tail by name before truncating so an
  `updatedAt`-ordered cut can't move the surviving name set).
- Cloning a repo re-triages, so a newly-cloned repo can win a ticket it fits better. A **manual pin** is
  the exception: `_triage_due` skips it (never re-triaged, no attempt spent).
- Two rules from the split, worth not undoing:
  - **Stale means "re-triage this", never "stop showing it"** — the old answer keeps rendering until a
    replacement lands, else a whole-board invalidation (one clone, one gh sweep) blanks every chip.
  - **`attempts` is scoped to the question, not the ticket's lifetime** — a changed ticket/candidate set
    gets a fresh budget, else a lifetime counter could permanently ban re-triage and freeze a wrong chip.

#### Triage scheduling and failure handling

- `_start_jira_triage` only updates its candidate repos from a **successful** gh sweep
  (`self.triage_gh_repos`): `refresh_github` blanks the block to `repos:[]` on any error,
  indistinguishable from "no repos", and triaging against it would restale every ticket and re-run the
  whole board twice (when gh stumbles and when it recovers).
- Batched (`JIRA_TRIAGE_BATCH` tickets per call, **one job in flight** — a backlog trickles out a batch
  per beat). Attempted every beat (not the slow Jira cadence), so a freshly-polled board classifies in
  minutes; a settled board costs one fingerprint check.
- Failed attempts are **bounded-retry with backoff** (`JIRA_TRIAGE_MAX_ATTEMPTS`/`JIRA_TRIAGE_BACKOFF_SEC`,
  armed up-front so a restart mid-batch neither loops nor loses the retries owed).
- `_parse_triage` draws a sharp line between the model's two non-answers:
  - an **explicit `null`** is a verdict → `repoGuess.repo = null` ("no repo fits");
  - anything **unreadable** — an unparseable shape, or an off-list repo name — is a **failed attempt**
    whose key is omitted, leaving the ticket undecided for retry. Conflating them would paint a confident
    chip the model never asserted, left there for good since decisions aren't re-triaged.
- A ticket not yet triaged carries **no `repoGuess`** (board renders no chip; absence ≠ "no repo fits").
- `_apply_triage()` re-stamps the ledger onto tickets after every poll and merge (`collect_jira` builds
  fresh dicts, else chips blank each slow beat). Tuned by `JIRA_TRIAGE_MODEL` (default `haiku`) /
  `JIRA_TRIAGE_TIMEOUT_SEC`.
- Tests: `TestTriageCandidates`, `TestTriageFingerprints`, `TestParseTriage`, `TestJiraTriage`.

#### Manual repo override

- The operator can **set a ticket's repo by hand** from the detail panel: `setJiraRepo` →
  `set_jira_repo()`, writing a ledger entry flagged `manual`. It takes the same posture against the model
  a hand-typed session rename takes against the auto-summarizer — a human's answer wins, so nothing
  quietly overwrites it:
  - `_triage_due` skips a manual entry (never re-triaged, no attempt spent);
  - `_finish_jira_triage` drops a reply for a ticket pinned while its batch was in flight (that batch
    answers a question no longer asked);
  - `_prune_triage_ledger` evicts manual entries last (an auto decision is recomputed next beat; a pin
    is the one thing that cannot be regenerated).
- Three answers, deliberately distinct — the middle is why `auto` is a separate field, not an absent
  `repo`: `{repo:"<name>"}` pins that repo; `{repo:null}` is a manual **"no repo fits"** (an assertion);
  `{auto:true}` **releases** the pin (drops the entry), re-triaging from scratch with a **fresh** attempt
  budget (reusing a spent one could leave a released ticket permanently unguessed).
- **Un-cloned repos are offerable** (a ticket can belong to a repo this host hasn't cloned; the board
  renders it dashed). The name is **allowlist-checked host-side against that host's own candidates**, and
  the stored repo/cloned/`nameWithOwner` are read off the **candidate**, never the request.
- The candidate list is heartbeated as **`jira.repoOptions`** (`_jira_payload`, names + clone state only)
  — one list serving both the model's prompt and the board's picker, via `_refresh_triage_candidates`, so
  the picker offers exactly what `set_jira_repo` accepts.
- `_apply_triage` re-reads clone state from the **current** candidates rather than trusting the decision:
  a pin never re-triages, so a stored `cloned:false` would outlive a clone forever. A repo absent from
  the list now keeps its stored state (the list blanks on a failed gh sweep).
- `POST /api/jira/<siteKey>/<issueKey>/repo` **fans out to every host reporting that org** — including
  OFFLINE ones (unlike `POST /api/jira/refresh`) — because the ledger is per-host while the board merges
  by `siteKey`, so a host that misses the pin can silently revert it. Commands are queued/at-least-once
  and `set_jira_repo` idempotent. The board still gates its **Change** control on an ONLINE host (a UI
  feedback judgement). This writes to the **agent's ledger, not to Jira**.
- A pin also decides **where a ticket session spawns** (`spawn_ticket` re-derives the repo from this
  host's ledger, where a pin outranks the model; still re-checks `scan_repos()`).
- **Known limits, all multi-host-per-org** (the deployment is one host per org, so none bite today): the
  picker offers the union of the org's hosts' options, so it can offer a repo one host rejects (log-only)
  — the panel self-corrects within `REPO_SETTLE_MS`; `cloned` is host-relative so two hosts can report
  different `repoGuess.cloned`. Widening the allowlist to the fleet's option list would fix both, at the
  cost of a host only recording repos it can see.
- Tests: `TestSetJiraRepo`, the `repoPickerHtml`/`repoFieldHtml` cases in `turma/tests/board.test.js`,
  the `/repo` endpoint cases in `turma/tests/server.test.js`.

### Jira ticket sessions

- The board's per-card **start button** spawns a session to work a ticket: a `{type:"spawnTicket",
  issueKey}` command → `spawn_ticket()`. It runs agent-side for the same reason triage does.
- **The hub sends only the issue key.** Everything else is re-derived from LOCAL state: the repo from
  this host's triage ledger (still in `scan_repos()`), the ticket from a fresh `fetch_jira_issue`. So a
  stale board can't spawn against a re-triaged-away repo. The hub's job is purely ROUTING.
- The fetched ticket becomes the **initial prompt** (`build_ticket_prompt`: fields, description, the
  newest `TICKET_PROMPT_COMMENTS` comments) — the session has no Jira creds of its own, so that text is
  all it sees, which the prompt says while pointing at the URL.
- The ticket is carried on the record as `ticket` = `{key, siteKey, url, summary, branch}`, persisted,
  heartbeated, surviving kill/resume. **That record IS the ticket ↔ session link** — no hub-side ticket
  store; the board reverse-indexes the fleet payload.
- The record only answers **while it exists**, so a durable `transcriptId → ticket` ledger
  (`~/.turma/jira-sessions.json`, `TICKET_LEDGER_PATH`) answers afterwards — the exact counterpart of
  the usage ledger, keyed on the transcript id (what the `resumable` scan reports and the Ended list
  dedupes on).
  - Written in `_launch_tmux` where a session's conversation is named, so **every** launch records it
    (`_remember_ticket`, idempotent, no-op without a ticket). A restart-clear-context adds its NEW
    transcript beside the old (both worked the ticket, both stay separately resumable).
  - `_backfill_ticket_ledger()` adopts sessions predating it from registry + closed history, keying a
    pre-pin closed record on its resolved `transcriptId`.
  - Bounded by `TICKET_LEDGER_MAX` oldest-first on a first-seen `at`. Deliberately **not** pruned against
    on-disk transcripts (a transcript archived off this host is still the answer).
  - Tests: `TestTicketLedger`, the end-to-end case in `TestSpawnTicket`.
- A ticket-backed session is **named from its ticket** (`"PROJ-123 <summary>"`, via `clean_manual_summary`)
  instead of paying a `claude -p` on a ticket-sized prompt.
- Refusals log and return like spawn's own (each case the board's button already prevents). A failed fetch
  raises to `handle_commands`, which logs and acks. Nothing is ever written to Jira.
- Tests: `TestSpawnTicket`, `TestBuildTicketPrompt`.

#### Ticket branch naming

- The branch is **decided at spawn** (`_reserve_ticket_branch`) and injected into the session's appended
  system prompt (`TICKET_BRANCH_PROMPT`) — the name must be human-scannable and the -1/-2 suffix needs a
  branch scan the agent has no reason to do right.
- `next_ticket_branch` hands out the bare ticket key, else the first free `key-1`/`key-2`/…, filling a
  gap left by a deleted branch rather than counting how many existed.
- **"Taken" is the union of git and the registry**: `branch_names()` reads local heads + remote branches
  (after a short-bounded fetch), while a session that hasn't branched YET owns its name with git knowing
  nothing — so two sessions started back-to-back on one ticket aren't both told `PROJ-123`.
- **The app still creates no branch**: the worktree stays `--detach`. This decides the NAME
  deterministically; the agent still cuts it from the refreshed remote default. A resume re-tells the
  persisted name rather than reserving a fresh one.
- Tests: `TestNextTicketBranch`, `TestBranchNames`, the reserve/resume cases in `TestSpawnTicket`.

### GitHub block and cloning

- The agent heartbeats a `github` block: whether it has a usable `gh` login and, if so, that login's
  clonable repos (refreshed slow; the authenticated user's own repos, their orgs, and any extra
  `GH_CLONE_OWNERS`), plus any in-flight/recent `clones`.
- A `clone` command `git clone`s a validated `owner/repo` (allowlist-checked before it reaches git) into
  `REPOS_ROOT` as a **detached subprocess** (reaped across later beats), after which the new repo joins
  the scan. Private-repo auth rides the system git credential helper (`gh auth git-credential`).
- **Non-GitHub git creds (XERK-54)** — the image wires a SECOND system credential helper after gh:
  `store --file=/root/.git-credentials`, tried in order for every host. gh serves github.com (fresh
  token); every other host (GitLab, Bitbucket, Azure DevOps, self-hosted) falls through to `store`,
  which reads the host's own cached git credentials from an **optional** bind mount at
  `/root/.git-credentials`. gh is first so github.com always gets a fresh token even if the store file
  also carries a (staler) github.com line; an unmounted file is an empty helper = a no-op, so a
  GitHub-only host is unaffected. The `entrypoint.sh` preflight reports the mount (non-fatal, presence
  only, like the cloud creds). The guard denies writing it (`~/.git-credentials`), a store shared by
  every session like `~/.aws`. **Native inherits the host's git config untouched, so a host already
  using `credential.helper store` works with no change.** Tests: the git-creds cases in
  `agent/tests/test_entrypoint.sh`, `test_denies_non_github_git_credential_writes` in
  `test_guard_settings.py`.
- **Azure DevOps git auth (XERK-54)** — an ADO org already gives the agent a PAT for the board
  (`AZDO_TOKEN` + `AZDO_URL`), so plain git reuses it instead of any mount: at boot `entrypoint.sh`
  runs `hub-agent.py --wire-azure-git`, which sets a URL-scoped `http.<azure_base>.extraHeader =
  Authorization: Basic <base64(":<PAT>")>` (`azure_git_auth_config()`), scoped to the ADO base so no
  other host receives it. Uses **`extraHeader`, not a credential helper / `http.proactiveAuth`**:
  self-hosted TFS/Server often issues no Basic challenge a helper can act on (why such hosts set
  `proactiveAuth=basic`), and the image's git (Debian bookworm, 2.39) predates `proactiveAuth` (2.46) —
  `extraHeader` (git 2.4+) forces the header proactively and works on the shipped git. Written
  `--system` as root before the privilege drop; non-fatal, logs the host never the token. The
  container-only counterpart of github.com going through gh (native relies on the host's own git
  config). Tests: `TestAzureGitAuthConfig` in `test_hub_agent.py`, the AZDO cases in
  `test_entrypoint.sh`.

### `entrypoint.sh`

- Creds preflight, then launches the tunnel and `exec`s the session manager as PID 1 — the container
  stays up with zero sessions. See "Run-as identity" for the uid resolution it performs first.

### `native/` — non-Docker install (WSL/Linux)

- Installs the SAME `hub-agent.py`/`tunnel-agent.js`/`hooks/`/`tmux.conf` onto a host and reuses its
  tooling, instead of the container — for a WSL box that already has git, node, python, and a logged-in
  Claude. See `agent/native/README.md`.
- `turma-agent` — the launcher: the runtime half of `entrypoint.sh` minus every container/privilege bit
  (runs as the invoking user). Sources the config, defaults `CLAUDE_PROJECTS_ROOT=$HOME/.claude/projects`
  (the one env decoupling from the container's hardcoded `/root`) and `DEVICE_NAME=$(hostname)`, idles on
  missing claude creds, reconciles + supervises the tunnel, execs the manager.
- The launcher puts **`$HOME/.local/bin` on PATH itself** (XERK-94): a systemd --user unit doesn't
  inherit the login shell's PATH, so claude at the prefix install.sh blesses (`npm config set prefix
  ~/.local`) was unreachable — the unit stayed active while the models probe and every session died
  on exec. A missing claude is a **loud, log-only** warning at start (the dir is on PATH, so a later
  install heals with no restart); install-time `have claude` checks pass in the login shell and
  cannot catch this. Tests: the PATH/warning cases in `agent/tests/test_turma_agent.sh`.
- The config is **validated before it is sourced**, and a bad one **idles** rather than exiting:
  - The launcher `.`-sources the env file, so a non-assignment line RUNS. A YAML-style `JIRA_SITE: "x"`
    becomes the command `JIRA_SITE:`, exits 127, and under `set -e` takes the launcher down. systemd's
    `EnvironmentFile` only warns, so under `Restart=always` this loops forever below systemd's
    start-rate limit — invisible, each pass reaping the tunnel so every session reads **"terminal
    offline"**.
  - The check is anchored on the `=` directly after the name (`JIRA_TOKEN: "a=b"` carries an `=` in its
    VALUE); `export` stays legal.
  - **Idling, never `exit 1`.** An exit is indistinguishable, to systemd, from one worth restarting in 5s
    — the exit IS the loop. Idling self-heals and states the fault once. `--preflight` is the one
    exception (exits 1). Nothing is sourced in that state.
  - The report carries **line numbers and key names, never values** (the file is `chmod 600` and holds
    `TURMA_TOKEN`/`JIRA_TOKEN`; the banner goes to the journal).
  - Tests: `agent/tests/test_turma_agent.sh` (invalid line idles + starts nothing, no value leak,
    `--preflight` exits, a valid config loads).
- The tunnel is **supervised** here, re-exec'd as `turma-agent --tunnel-supervisor` (a respawn loop),
  because a native install is the only place its runtime can be MISSING — node is an apt prereq, not a
  baked layer. (The container gained its own simpler respawn loop in `entrypoint.sh`, XERK-34 — no node
  check.)
  - Fire-and-forget made a missing node silent AND permanent: the manager kept heartbeating (host ONLINE)
    while every session read **"terminal offline"** (`terminalOnline` = "is the control channel connected
    now"). The node check lives INSIDE the loop, so installing node heals the terminals within one
    `TUNNEL_RETRY_SEC`.
  - The supervisor's pkill key is PREFIX-scoped like `tunnel-agent.js`'s; the launcher reaps the
    supervisor BEFORE the tunnel (else the old loop respawns the just-killed tunnel), and
    `turma-agentctl stop` reaps it too.
  - Tests: `agent/tests/test_turma_agent.sh` (respawn, missing-node heal, no duplicate supervisor).
- The launcher exports **`TURMA_MANAGER_PID=$$`**, which `exec` makes the manager's own pid, so the
  tunnel's poke (`pokeHeartbeat`, cutting a heartbeat sleep short) signals the right process. It falls
  back to PID 1 — right only in the container; natively PID 1 is systemd and poking it raised EPERM,
  costing each command a full beat. Tests: the `pokeHeartbeat` cases in `agent/tests/tunnel-agent.test.js`.
- `install.sh` — idempotent installer (`--verify`/`--uninstall`): auto-installs prereqs (apt + npm +
  pinned static ttyd), lays files into a prefix keeping `hub-agent.py` and `hooks/` siblings, writes a
  `chmod 600` config, wires the service, writes `$PREFIX/VERSION`.
  - It `try-restart`s the service after wiring it (`enable --now` does nothing to a running one, so a
    re-run would serve the old files).
  - **`have_sudo` asks** when it must, rather than probing `sudo -n` only (a `-n`-only probe makes a
    password-sudo host look sudo-less, so under `curl … | bash` every apt prereq was skipped). sudo
    prompts on `/dev/tty`, so the pipe never stops it. Gated on `[ -t 2 ]` so an unattended run fails fast
    rather than hanging; the answer is cached.
  - The README's quickstart primes it with `sudo -v`. It must never become `curl … | sudo bash`: the
    install belongs to the invoking user, only prereqs need root (same reason `turma-agent` has no
    privilege-drop machinery).
  - Tests: `agent/tests/test_install_sudo.sh`, wired into `code-scan.yml`.
- `bootstrap.sh` — the README's `curl … | bash` front door for a host with no checkout. Resolves the
  newest native tarball, verifies its sha256, unpacks to a temp dir, and `exec`s the `install.sh` inside
  it (`bash -s -- --autostart`). `install.sh` isn't copied into `$PREFIX`, so `--verify`/`--uninstall` on
  a bootstrapped host re-run through it.
  - Resolves by the version in the **asset's filename**, never the release tag (a release carries an
    unchanged native build forward under its older name, so a tag-derived name would 404). Anonymous
    (public repo) and parser-free (runs BEFORE install.sh apt-installs python3 — grep/sed, not JSON).
  - Tests: `agent/tests/test_bootstrap.sh` (wired into `code-scan.yml`).
- Service: a systemd **user** unit with `KillMode=process` (a restart signals only the manager, leaving
  tmux/claude/ttyd/tunnel alive), plus a nohup `turma-agentctl` fallback for WSL without systemd. Both
  preserve running sessions via the adopt-on-boot path.
- `turma-agent-update` — self-updater: reads the unified release stream via `gh`, comparing the release
  `manifest.json`'s **agent-native component version** (never the tag), verifies the sha256, swaps files,
  restarts the manager (re-adopting live sessions). Falls back to the legacy `agent-native-v*` stream.
  Driven by a systemd timer or `--loop` poller. Tests: `agent/tests/test_turma_agent_update.sh`.
- Not installed natively: cloud CLIs (aws/az/terraform) + PowerShell + docker CLI + the Android
  toolchain; the container is for those.
- Container ⇄ native parity (the XERK-34 audit): the same runtime files run in both, so the session model,
  heartbeat, Jira/PR/usage/archive features are identical. Known deltas beyond the tooling line and the
  README's "Known limitations":
  - Heartbeat `startedAt` is docker's StartedAt where docker can answer, else the manager's OWN start
    time — never empty (`TestStartedAt`). The fallback keeps the restart-loop alert (keyed on `startedAt`
    CHANGING) and card Uptime working natively. The log tail stays container-only.
  - **native**: the bundled tmux.conf only takes effect at `/etc/tmux.conf`/`~/.tmux.conf`; a host with
    its own conf loses truecolor and the OSC 52 copy chain (hub-agent launches bare `tmux`, so
    `$PREFIX/tmux.conf` is never read).
  - The tunnel is supervised on BOTH sides (natively by `--tunnel-supervisor`, in the container by the
    `entrypoint.sh` respawn loop). Tested by the relaunch case in `agent/tests/test_entrypoint.sh`.
- Additive: nothing under `native/` edits the shared runtime files; the one enabling change is
  `resume_on_boot`'s adopt path (backward-compatible with the container). The native tarball is one
  component of the unified `release.yml`.

### `tunnel-agent.js`

- The reverse tunnel; the hub's `{open,port}` selects which per-session ttyd to bridge, over one per-host
  control channel.
- That channel also carries the **live transcript tail**: on `{watch,worktreePath}` / `{unwatch}` it
  tails that session's newest transcript every ~1s and pushes `{tail,entries}` deltas back. It's a JS
  re-implementation of hub-agent.py's `transcript_tail`/`_entry_text`, parity-tested in
  `agent/tests/tunnel-agent.test.js`. Tailing runs only while a client watches.

#### Control-channel liveness

- **Both ends prove the channel rather than assume it**: the heartbeat is a fresh HTTP POST while the
  tunnel is one long-lived socket, so they die independently. A wedged tunnel reads as a healthy host —
  `online` with `terminalOnline:false`, every session saying **"terminal offline"** and no attach.
- The hub beats every `CONTROL_PING_EVERY_MS` (30s) and drops a channel silent for `CONTROL_DEAD_AFTER_MS`
  (90s, 3 missed); the agent reconnects when nothing arrives for `TURMA_CONTROL_IDLE_TIMEOUT_MS` (90s).
- It sends **two pings, and needs both**:
  - the **protocol ping** (`0x9`) beats Cloudflare's idle timeout and is auto-ponged by every agent
    (Node answers internally), so the returning `0xa` is liveness the hub gets from OLD agents for free —
    how it reaps a half-open channel to a host that died without a FIN.
  - the **app-level `{ping}`** text frame is the same beat in a form the AGENT can see: a browser-style
    WebSocket exposes no ping event or method, so the protocol ping is invisible to it. This frame is the
    only liveness its `onmessage` can observe. Older agents ignore the unknown key.
- **A dead hub does not necessarily close the socket.** Through Cloudflare, the edge holds the agent's end
  open after the origin dies, so no `close` fires and the reconnect never runs — the channel wedges
  forever while the manager keeps the host green. So silence (not a close event) is what the agent acts on.
- The agent's watchdog is armed **only once the hub has proven it app-pings**, so a new agent against an
  older hub keeps the old behaviour instead of reconnect-looping.
- `retire()` is idempotent per-socket and **never waits on `ws.close()`** (a half-open socket's `close`
  may never fire): it schedules the reconnect itself and lets the doomed socket be reaped whenever.
- Supervision cannot cover this: the native supervisor only respawns on process **exit**, and a wedged
  socket never exits.
- Tests: the control-channel cases in `agent/tests/tunnel-agent.test.js` (which drive the real script
  against a fake hub that goes silent) and in `turma/tests/server.test.js`.

### Live working footer and agent list

- The control channel also carries the session's **live working footer** scraped from the tmux pane
  (`parsePaneLiveTurn` → `{turn,text,status}`): the in-progress assistant text plus
  `status = {verb, up/down token counters, elapsed, hint}`.
- When Claude's agent-manager list is expanded below the input box, the footer also carries
  `status.agents[]` (`parseAgentList`: one `{sel,type,label}` row per live agent, i.e. `main` + each
  subagent), so the hub pins the working indicator and lists the live agents.
- A single-frame **busy→idle blip is held one poll** before the bar clears (`liveTurnDecision`, XERK-42):
  the same spinner-repaint gap that flickers `paneBusy` can make one 1s capture read "not generating"
  mid-turn, blinking the pinned bar off. When the previous poll was generating and this one isn't, the
  frame is skipped one tick; if the next poll is still idle the turn really ended. Busy is never held. The
  live counterpart of `_stable_pane_busy`'s re-capture. Tests: the `liveTurnDecision` cases in
  `agent/tests/tunnel-agent.test.js`.
- **Clicking a subagent row opens that background agent's own transcript**: a
  `{type:"subagentHistory", sessionId, agentType, label}` command resolves the row to its
  `subagents/agent-<id>.jsonl` via the main transcript's Task `tool_use` + its result text
  (`agentId: <id>`) — `_resolve_subagent`/`_stage_subagent_history`, matching type + description (exact,
  else a prefix). The result rides the next beat as `subagentHistoryResults`.
- Tests: `TestResolveSubagent`, `TestStageSubagentHistory`, the `parseAgentList` cases in
  `agent/tests/tunnel-agent.test.js`.

### Transcript entry blocks

- Each tail entry carries, alongside the flat `text`, a rich **`blocks[]`** array (`_entry_blocks` in
  hub-agent.py, mirrored by `entryBlocks` in tunnel-agent.js — same parity contract). Blocks PRESERVE the
  thinking text, tool_use inputs and tool_result outputs that `_entry_text` flattens away, so the chat UI
  can render + verbosity-filter each component.
- Turns that are ABOUT the session rather than someone talking are classified (each backed by real
  transcript shapes on the fleet):
  - `[Request interrupted by user…]` marker turns (Esc / Stop) → `{t:"interrupt"}`, a centred status
    marker; `_entry_text` keeps the raw line.
  - The `!` shell passthrough's `<bash-input>`/`<bash-stdout>`/`<bash-stderr>` turns parse into the same
    command/command_output shapes as slash commands (name `!`), via `_parse_local_command`. stderr only
    wins when non-empty.
  - A `system`/`away_summary` entry (the "while you were away" recap) → `{t:"away_summary"}`, an
    assistant-side collapsed card, with the "(disable recaps in /config)" hint stripped
    (`_away_summary_text`); every other system subtype stays dropped.
  - `tool_reference` blocks inside a tool_result (ToolSearch naming loaded tools) flatten to
    `[tool: <name>]` lines instead of leaving the card empty.
- **Still-queued prompts ride beside the entries, not inside them**: a message typed mid-turn only
  becomes a user entry when dequeued, so the live tail and `/history` fold the transcript's
  `queue-operation` entries FIFO (`_fold_queue_op` / `foldQueueOp`, enqueue → dequeue → remove-by-content)
  and ship survivors as `queued[]` beside `entries` — the chat renders them as dimmed "queued" bubbles,
  replaced wholesale each frame. A window opening mid-sequence errs toward hiding (an unmatched dequeue
  no-ops). Older agents send no `queued`; the hub/chat treat it as absent.
- Tooling payloads ride the same queue (a background task finishing mid-turn enqueues its whole
  `<task-notification>` XML), so display filtering happens at REPORT time (`_queued_display` /
  `queuedDisplay`), never at fold time (which would desync the positional dequeues).
- Blocks ride the live tail (tight per-block caps) and on-demand `history`
  (`_entry_blocks(entry, BLOCK_CAPS_FULL)`, looser). They are the one place inclusion widens: a
  tool_result-only turn, dropped by `_entry_text`, is kept when it has blocks. The heartbeat preview
  (`transcript_tail`) and archive (`_archive_deltas`) stay text-only.

### Archive sync

- The agent **ships every INACTIVE session's transcript to the hub's durable archive** so history
  survives this host being wiped/offline. On the slow usage cadence `_archive_manifest()` enumerates
  ended transcripts (every ledger slug's `*.jsonl`, attributed via the usage ledger, excluding any slug
  backing a running session) and reports a small scalar manifest.
- The hub replies with per-transcript byte cursors (`archiveHave`), and `_archive_deltas()` POSTs the
  missing append-only byte-range deltas (pre-parsed through `_entry_text`) to
  `POST /api/agents/<host>/archive/<transcriptId>`, bounded per chunk/beat. Tests: `TestArchiveSync`.

## `turma/` — central dashboard

Reached over the Cloudflare tunnel (the operator's public hub URL); port 8300 on the LAN.

### Shared site chrome (`turma/public/nav.js`)

- The header and phone bottom-nav are built by one module (`nav.js`, dual-exported for tests) and are
  **identical on every page** — pages hand-roll neither. Each mounts them with
  `<header class="site-header" id="siteHeader" data-page="…" data-sub="…">` + `<nav class="bottom-nav"
  id="bottomNav">` and one `<script src="/nav.js">`; `data-page` lights that page's tab in BOTH navs.
- Page-specific content goes in the two slots the page fills — `#hdrSub` (static descriptor) and
  `#hdrMeta` (dynamic). An unfilled slot collapses (`.site-header .sub:empty`). The row **ends at the
  tabs**: no right-hand slot (one carried an "updated <time>" stamp, dropped as noise).
- A third slot, **`#hdrOrg`, is filled by nobody** — `org.js` mounts the fleet-wide org filter into it
  (see "The org filter"). It sits after the spacer, before the tabs, and collapses when no host reports
  a tracker org.
- The header is full-bleed and `.site-header-in` caps its row at `--wrap` and centres it, so every page's
  chrome lands in the same 1180px column as a `.wrap` page's content. On `sessions.html` the two-pane
  `.sess-shell` below is capped at the same `--wrap` and centred too (XERK-28), so the whole page reads
  like the others; the cap is inert below `--wrap`, so the phone layout is unchanged.
- Because that row is **centred**, the viewport must not depend on whether a page scrolls, so `app.css`
  reserves the scrollbar gutter globally (`html { scrollbar-gutter: stable }`) — else the always-scrolling
  dashboard centres 15px narrower than the others. It's reserved on `sessions.html` too (which never
  scrolls, `html { overflow: hidden }`); the strip is invisible and phones use overlay scrollbars (no-op).
- The gap under the header is a **margin, not padding**, so it collapses with the first content element's
  margin exactly as the old in-`.wrap` header did.
- It's mounted synchronously at the bottom of `<body>`, after both placeholders exist, before the page's
  script reads the slots.
- **`TurmaNav.preserveScroll(container, paint)` is the one wrapper every recurring innerHTML repaint must
  go through** (XERK-35). Each page repaints by replacing a container's `innerHTML` every SSE/poll beat
  (~1s), which threw scroll back to the start every second (the page's window scroll AND any inner
  `overflow:auto` region). It snapshots the window scroll plus every scrolled descendant of `container`,
  runs `paint()`, then restores them synchronously. Scrolled nodes are re-matched by a stable `id` anchor
  if in scope (so a REORDERED list maps its scroll to the right row), else by structural child-index path;
  only nodes scrolled off zero are captured.
  - Callers: `board.html` (`.kanban-cols`/`.kc-list`), `index.html` (`#groups` + its `.clone-list`),
    `usage.html` (`.wrap` → `.table-scroll` tables + page scroll). SUBSUMED each page's older per-site
    snapshot code (`captureBoardScroll`, `captureCloneScroll`, the bare `window.scrollY` save).
  - Two recurring repaints keep their OWN bespoke logic and must NOT route through it: `chat.js`'s
    transcript `repaint` (stick-to-bottom vs hold-place + selection-guard), and `sessions.html`'s sidebar
    (its `scrollTop` restore is ordered against a focus/caret restore that can itself scroll). New
    recurring repaints without such a special case should use `preserveScroll`.
- Tests: `turma/tests/nav.test.js`.

### The org filter (`turma/public/org.js`, XERK-62)

- **One org-scoping control, in the header, obeyed by all four pages.** A host polls exactly ONE org
  (agent-side rule), so an org **partitions the fleet** — the same pick that filters tickets filters
  hosts, sessions and usage. It was a chip strip on the board alone, which is why "which org am I
  looking at" was a question only the Kanban could answer.
- The value is a **full `siteKey`** (what the hub keys and routes on), never the display org name;
  `""` is every org. Persisted as `turma-org` (migrated once from the board's `turma-board-org`, so an
  existing filter carries over) and re-read on the `storage` event, so two open tabs agree.
- Each page: `TurmaOrg.update(data)` each beat, `TurmaOrg.filter(data.agents)` to scope what it builds,
  `TurmaOrg.subscribe(...)` to repaint on a change, `TurmaOrg.sse(es)` to take the hub's `autoStartOrgs`
  broadcast off the page's existing socket rather than opening a second one.
- Scoping is applied to the **agent list**, once, and everything downstream follows. Deliberately NOT
  applied to `findSession`/`sessionHit` (they read `cache` directly) — an open session must not be torn
  off the stage because its org left the sidebar — nor to pending-command reconciliation, which runs
  against the WHOLE fleet or a command fired before a re-scope hangs forever.
- A host with **no tracker block belongs to no org**: it shows under "All orgs" and under none of the
  named ones. That is the truth about it, not a bug to fold away.
- **A pick for an org nobody reports doesn't apply, but is kept** (`effectiveKey`): otherwise an org
  whose last host was removed leaves every page filtered to nothing with no chip left to clear it — the
  one way an operator could lock themselves out of the fleet. Keeping it means it resumes when that host
  returns. Empty states say which case they're in and point at the header.
- The per-org **auto-start switch (XERK-41) rides the menu's org rows** — `org.js` owns its optimistic
  flip, POST and rollback.
- Repaints are **skipped when the markup is unchanged**, so the beat can't churn the DOM under an open
  menu. Clicks are delegated, and a handled click is flagged **on the event** — the repaint detaches the
  clicked node, so the click-away handler's `slot.contains(e.target)` is false and the menu closed
  itself on the click that opened it.
- It reads board.js's org vocabulary, so **every page loads `board.js`**, ordered board.js → nav.js →
  org.js (the vocabulary first, then the `#hdrOrg` slot org.js mounts into).
- Tests: `turma/tests/org.test.js`; Android's port is `data/OrgFilter.kt` + `ui/OrgControl.kt` +
  `core/Board.kt`'s `siteKeyOf`/`filterAgents`/`effectiveOrg`/`scopedAgents`, tested in `BoardTest.kt`.

### Fleet tree (host → repo → session)

- Each host row reads **`<hostname> - <org>`** — the org whose Jira that host polls, from its `jira`
  block's `siteKey` via `TurmaBoard.orgName` (why the dashboard loads `board.js`). A host with no Jira
  creds shows its name alone.
- Each host has a **"Clone from GitHub" bar**: a dropdown of the host's `gh` login's repos (present ones
  disabled) plus a free-text `owner/repo` box, cloning into the repos root so it joins the tree. Greyed
  out on hosts reporting no GitHub creds.
- Each host expands into a top **⌂ Repos root** entry (no worktree/branch, so its composer hides the
  base-branch field, and "+ New session" disappears once one root session runs), then the host's scanned
  repos ordered most-recently-active first (by the agent's `lastActivity`).

### Per-repo controls

- **"+ New session"** — one click, instant bare spawn with today's defaults.
- A **▾ caret** opens a progressive-disclosure "New session" composer: optional task prompt, label, and
  spawn options (base branch defaulting to the repo's latest default, model, permission mode). Last-used
  options are remembered per repo in `localStorage`.
- A **"Resume" picker** when the repo has resumable history (`repo.resumable`): any prior Claude session
  for the repo, resumed by transcript id via `POST /api/agents/<host>/transcripts/<transcriptId>/resume`,
  falling back to the last-5 killed `closedSessions` for older agents.
- An arm/confirm **"Prune"** button that sweeps that repo's worktrees + local branches merged into the
  latest default, leaving anything unmerged or dirty.

### Session cards

- Working/idle/waiting-on-question state, the worktree name, and the agent's live branch (or "detached").
- Per-session token usage parsed from that worktree's `~/.claude/projects` transcripts.
- Any **PR status** the session opened — a GitHub-style pill (state colour + `#number` + ✓/✗/●
  merge-readiness mark; see "PR status") from `session.prs`; `prBadgeHtml` builds it, shared `.pr-badge`
  CSS in `app.css`.
- Per-session **Attach / Restart (clear context) / Kill / Start / Delete**.

### Spawn/resume handoff

- **Starting or resuming a session hands off to the Sessions page and opens it there.** The id doesn't
  exist yet at POST time (the agent mints it), so `spawn()`/`resume_transcript()` echo the hub's
  queued-command id onto the record (reported as `session.spawnCmdId`), the POST's `{ok, cmdId}` reply is
  handed to `/sessions?spawn=<cmdId>`, and that page waits for the session reporting that `spawnCmdId` and
  selects it (`followSpawn`/`tryPendingSelect`). The page's own composer follows its spawn in place.
- Resuming a **killed** session keeps its id, so that path deep-links `/sessions?session=<id>` directly.
- Both waits are one-shot, show a "Starting your session…" stage, expire after `SPAWN_FOLLOW_MS`, and
  cancel the moment the operator picks a session by hand.
- A third deep link, **`/sessions?ended=<transcriptId>`**, opens an ENDED session's read-only view (what
  the board's ticket chips use for anything not running). It keys on the transcript id (the one handle all
  three ended channels share), resolving through `findEndedByTranscript` → `openEndedSession`. It is
  **bounded** (`ENDED_FOLLOW_MS`), unlike the by-id wait, and cannot be folded into `?session=` (whose
  wait only resolves a **running** session).
- Tests: the select-on-arrival cases in `turma/tests/sessions.test.js`, plus
  `TestSessionLifecycle`/`TestResumeTranscript`/`TestHandleCommands`.

### History page (`/history`)

- Charts persistent daily/all-time cost from the agents' `repoUsage`/`usage` aggregates — not the live
  session list, so killed/deleted/pruned work still counts.
- **By repo** unifies each repo's usage across every host it runs on (matched by `remoteKey`); **By host**
  shows per-host totals.

### Board page (`/board`)

- One cross-org Jira Kanban built from every agent's `jira` block (`turma/public/board.js`, dual-exported
  for tests). `mergeSites` collapses hosts sharing an org into one board keyed by `siteKey` (freshest
  block wins per site+user; different users on one site union, deduped by issue key).
- Columns are Jira's three universal status categories, each card's pill showing the org's own status
  name.
- A fourth **In Review** column (XERK-23) sits between In Progress and Done. Jira has no cross-org category
  for review/testing (both `indeterminate` → `inprogress`), so `categoryOf` carves it out by matching the
  org-specific status NAME (`isReviewStatus`, word-boundary: review/testing/QA) and only ever pulls FROM
  `inprogress`. Purely a board.js/CSS change.
- The board is scoped by the **header's org filter**, not a strip of its own — see "The org filter". It
  reads `TurmaOrg.get()` each render and passes it to `boardHtml` as before.
- An org is **labelled by `orgName(siteKey)`** — the site host minus `.atlassian.net` (the full host
  stays as tooltip). Presentational only; everything stays keyed on the whole `siteKey`.
- The agent's **`BOARD_ORG_NAME`** overrides that label outright (`orgName(siteKey, override)`, stamped
  onto the block by `collect_board` so it is source-agnostic, carried by `mergeSites` off the freshest
  block). A self-hosted Azure collection otherwise derives to its COLLECTION
  (`tfs.co/tfs/DefaultCollection` → "defaultcollection"), a deployment detail rather than the org.
  Deliberately **not** part of the `siteKey`, which is what the hub keys/merges/routes on and what the
  `/api/jira/<siteKey>/…` paths and the ticket-agent/auto-start ledgers are stored under — so the label
  is safe to change later, and renaming the siteKey would orphan all of those. Also read by the
  dashboard's host rows. Tests: `TestBoardOrgName`, the `orgName`/`mergeSites` override cases in
  `turma/tests/board.test.js` and `android/.../BoardTest.kt`.
- Each org gets a **UNIQUE color** — no two share a `--s1..--s8` palette slot (`orgColorMap`, XERK-48).
  Uniqueness couples the orgs, so it's computed over the whole org set: each takes its djb2-preferred slot
  if free, else linear-probes to the next free one, keys processed in sorted order (deterministic). It is
  **persistent where it can be** — an org keeps its color unless its preferred slot actually collides, and
  then only the *colliding* orgs move. Unique up to 8 orgs; overflow falls back to its preferred (possibly
  shared) slot. The Android port (`core/Board.kt` `orgColorMap` → `ChartSeries`) uses the identical
  assignment, pinned by locked test vectors on each side.
- Pull-only: nothing on this page writes to Jira. Tests: `turma/tests/board.test.js`, the ticket-detail
  and jira-refresh endpoint cases in `server.test.js`.

#### Repo chips

- Each card shows the **repo the agent triaged the ticket to** (`repoChipHtml`, from `repoGuess`; the hub
  only renders it), in three distinct states:
  - a repo **cloned** on the reporting host reads as a plain, actionable chip;
  - one only in the org's `gh` listing is **dashed** (a real answer, but you'd clone it first);
  - a ticket the model declined (a pure design/ops ticket) shows a muted italic **"no repo"**.
- A ticket with no `repoGuess` yet gets **no chip** ("not looked at yet" ≠ "no repo fits"; resolves in a
  beat or two).
- The model's rationale rides as the chip's tooltip and the detail panel's Repo row (`repoFieldHtml`,
  which reads `t.repoGuess` directly — the guess only exists on the heartbeat ticket, not the on-demand
  Jira fetch). The Repo row is also where the guess is **corrected by hand** — see the detail panel.

#### Starting a session on a ticket

- Each card carries a **start button**: `POST /api/jira/<siteKey>/<issueKey>/session` → a `spawnTicket`
  command. **The hub's whole job here is ROUTING** — it sends just the issue key; the agent re-derives
  repo, ticket text and branch. `findTicketHost` picks the host by **splitting load across the org's
  agents** — see "Splitting ticket sessions across an org's agents".
- Online is **required**, not preferred (unlike the read-only ticket GET): a spawn queued onto a sleeping
  host lands whenever it wakes, a surprise not a feature.
- `ticketRepo` resolves the repo from the **freshest** reporting block (the same rule `mergeSites` renders
  by). Org is checked before repo (an org nobody reports has no ticket to be untriaged).
- Single-flight per ticket (a double-click must not start two sessions; a second session is supported via
  the `+` button and the -1/-2 branch).
- The button's states are distinct (`ticketStartHtml`): a triaged ticket gets a live button whether or
  not the repo is cloned (an uncloned repo reads **"☐ Start (clone first)"** and clones on demand); a "no
  repo" verdict and an untriaged ticket get none. A failed start renders its reason beside a LIVE button.
- In-flight state clears on **evidence**, not a timer: a session reporting the spawn's `cmdId`, or the
  command clearing from the host's queue (which covers a spawn the agent REFUSED).
- The press is acknowledged **instantly and survives leaving the board** (XERK-18, three defects):
  - **The click was swallowed** — the board `innerHTML`-replaces every beat, so a press straddling a beat
    lost its button between mousedown and mouseup. The start button now acts on **`pointerdown`** (fired
    before any re-render), with `click` kept as the keyboard path; `startFrom` is the one entry both go
    through, and the pending guard makes a double-fire a no-op.
  - **No acknowledgement for ~5s** — the `⏳ starting…` paint waited on the POST. `startSession` now sets
    the pending state and repaints **synchronously, before the fetch**; `cmdId`/`host` fill in on reply.
  - **The optimistic paint was swept against a stale cache** — `sweepStarts` read "command absent" as
    "acked", but the SSE-fallback poll hasn't seen the just-queued command. The verdict is now
    `B.startSweepVerdict` (pure, unit-tested): a cmdId-less pending always holds, and "command gone" only
    counts as acked once the command was **seen present** (`sawCmd`).
  - The POST uses **`keepalive: true`** so it outlives the page (navigating away otherwise aborts it).
- Tests: the ticket-session cases in `turma/tests/server.test.js` and `board.test.js` (the latter's
  `startSweepVerdict` cases cover the stale-cache and never-seen paths).

##### Splitting ticket sessions across an org's agents (XERK-14)

- A ticket the operator pinned to a host (see "Pinning the agent by hand") skips all of the below: the
  pin is authoritative, and a dead pinned host refuses rather than reroutes.
- `findTicketHost` chooses among the org's **ONLINE** hosts: **prefers one with the repo cloned**, and —
  within that group, or across all when none has it — picks the **most available** (`hostAvailability`),
  so N sessions on one org spread across its hosts. A momentarily-full host is still valid: the session
  **queues** there.
- `hostAvailability(a)` = the host's `capacity.free` **minus its `capacity.queued` and the
  spawn/spawnTicket commands still in its queue** since its last heartbeat — subtracting in-flight
  commands is what makes rapid clicks split. An agent predating `capacity` reports no ceiling and scores
  below any host that does.
- **No host has the repo → clone on demand.** `findTicketHost` returns `{host, needsClone:true}` for the
  most-available host; `spawn_ticket` then clones the repo (owner from its triage ledger's
  `nameWithOwner`) and queues behind the clone. Replaced the old `409 no online host has <repo> cloned`.
- The **multi-host-per-org limits still apply**: the triage/branch state is per-host, so a clone-on-demand
  routed to a host that didn't triage the ticket has no ledger entry to clone from — fine on the
  one-host-per-org deployment.
- Tests: the `most available one wins` / `pending lowers availability` / `clones on demand` cases in
  `turma/tests/server.test.js`.

##### Auto-starting To Do tickets (XERK-32)

- An org can be **opted in** so the hub auto-starts a session for every **To Do** ticket the moment it has
  a repo assigned (by triage OR a manual pin). Off by default.
- **The opt-in is HUB-ONLY (XERK-41)** — the "auto" switch on each org row of the header's org menu is
  the whole control (it rode the board's org chips until XERK-62 moved it there).
  `POST /api/jira/<siteKey>/autostart` `{enabled}` → `setAutoStartOrg`, a hub-owned durable per-org opt-in
  stored in `autostart-orgs.json` (`AUTOSTART_ORGS_FILE` on `/data`, keyed by siteKey, presence =
  enabled). It rides the fleet payload as top-level `autoStartOrgs` (`{siteKey:true}`) plus an
  `autoStartOrgs` SSE event. (Replaced the original agent env `TICKET_AUTO_START`, removed with XERK-41 —
  no agent flag, so toggling never needs an agent redeploy.)
- Per-org: `orgsWithAutoStart` is the set of enabled siteKeys. No onlineness gate on the opt-in itself;
  the sweep gates the actual spawn on a live host via `findTicketHost`.
- **The decision and routing live on the HUB** (only it sees the whole fleet, so only it can spread an
  org's sessions across all its agents). `autoStartSweep()` (a 15s `setInterval`, boot-grace-gated) walks
  each org in `orgsWithAutoStart`, and for each freshest-block To Do ticket with a `repoGuess.repo` routes
  a `spawnTicket` through the **same `findTicketHost`** the button uses.
- Never opens a **second** session for work already started. Three guards, increasing in strength:
  - `startedTicketKeys()` — durable: a ticket carrying a session on ANY channel (`a.sessions`,
    `a.closedSessions`, or a repo's `resumable` scan) is already handled, however started. A **killed**
    session counts (a deliberate kill is not resurrected).
  - an in-flight `spawnTicket` on some org host, for the window before that session first heartbeats.
  - `autoStarted` — an in-memory per-ticket ATTEMPT record, the only thing that stops a spawn the agent
    legitimately **refuses** (leaving no session to see) from being re-queued every sweep.
- **A queued `spawnTicket` is an ATTEMPT, not a start** (XERK-61), so auto-start is **bounded retry**:
  `AUTO_START_MAX_ATTEMPTS` (4) tries spaced by a doubling `AUTO_START_RETRY_MS` (1/2/4 min, capped at
  `AUTO_START_RETRY_MAX_MS`), tracked in `autoStarted` as `{attempts, nextAt}` keyed like the rest.
  - The agent **acks a refusal and a mid-spawn exception exactly like a success** (`handle_commands` logs
    and acks; no outcome rides back), so recording "queued once" as done made a TRANSIENT failure (a timed-out
    Jira fetch, a repo not yet triaged on *that* host) permanent for the hub's lifetime.
  - The retry gate is **evidence, in the sweep's existing order**: a session on any channel ends the attempts
    for good and drops the record (so the map holds only tickets currently failing); an in-flight command
    means the agent hasn't taken it yet, so nothing is concluded; only a still-session-less ticket with
    nothing in flight, past its backoff, is retried. A queued/awaiting-clone session reports its `ticket`
    from the first beat, so a slow spawn is never mistaken for a failed one.
  - A **no-online-host** result spends NO attempt (that failure isn't the ticket's), so it keeps its full
    budget for when a host returns. An exhausted budget logs once and stops.
- Reuses the queue end to end. Nothing is written to Jira.
- Tests: the `auto-start:` cases in `turma/tests/server.test.js`, the `autoStartOn` cases in
  `turma/tests/board.test.js` and android's `BoardTest.kt`, and `test_no_agent_side_auto_start_flag` in
  `TestSetJiraRepo`.

##### Auto-stopping Done tickets (XERK-45)

- The lifecycle **counterpart** to auto-start: the SAME per-org "auto" opt-in **kills** a session once its
  ticket reaches **Done** (the switch's tooltip reads "start To Do tickets, stop Done sessions"). A
  ticket only reaches Done by a **human** moving it (the board is pull-only), so it's a deliberate
  "finished" signal.
- The hub **KILLS**, not interrupts: a kill ends it cleanly (moves to Ended with worktree/conversation/PR
  chips intact and resumable) and frees the `MAX_SESSIONS` slot (symmetric with auto-start consuming one).
  An interrupt would leave it running idle, still holding the slot.
- Decision and routing on the HUB. `autoStopSweep()` (same 15s `setInterval`, beside `autoStartSweep`)
  reads each opted-in org's **Done** tickets from its freshest jira block, then scans the WHOLE fleet for
  sessions whose `ticket` names one, routing each `{type:"kill", sessionId}` to the owning host.
- Only **live** sessions are stopped (`status` `running`/`queued`): a `stopped`/`error`/killed one already
  ended, a `queued` one is cancelled rather than run pointlessly. Every live session on the ticket is
  killed (a two-branch or restart-clear-context ticket has more than one).
- Guard: `autoStopped`, an in-memory `<host>\x00<sessionId>` once-per-hub-lifetime set (a kill drops the
  record within a beat or two but is still reported in that window). Needs no durability — a re-issued
  kill of an already-dead session is a harmless agent-side no-op.
- The Android client shows the identical "auto" toggle and behaviour (the reworded text is a desktop-only
  hover tooltip). Tests: the `auto-stop:` cases in `turma/tests/server.test.js`.

#### Ticket ↔ session chips

- A ticket's sessions show as chips on its card, from `ticketSessionIndex` — a reverse index of the fleet
  payload's `session.ticket`, so **no hub-side ticket store exists to keep in sync**.
- It reads the **same three channels the Ended list merges** (`a.sessions`, `a.closedSessions`, each
  repo's `resumable`), because an operator asking "which session worked PROJ-123" draws no distinction.
  (Reading only `a.sessions` forgot a ticket's work the instant it was killed.) The resumable channel gets
  its ticket from the agent's ledger and covers a session aged out of `closed.json`.
  - Deduped on `<host>::<transcriptId>` with the **registry-backed record winning** (only it knows the
    session's id, `createdAt`, and that it was renamed); resumable is swept in its own pass after every
    record is seen. Not deduped across hosts (the shared `~/.claude` syncs transcripts, so an id alone
    isn't fleet-unique).
  - A **restart-clear-context session legitimately chips twice** (its pre-restart conversation is a
    separate transcript, separately resumable).
- **Where a chip links follows the run state, not the channel**: running → `?session=<id>` (live chat);
  anything else → `?ended=<transcriptId>` (read-only view); no transcript → not a link. The Sessions
  page's `?session=` wait only resolves a **running** session (`sessionHit`) and never times out, so
  pointing a stopped/killed chip at it parks on "Opening session…" forever.
- The chip is **labelled with the BRANCH**, not the session name (a ticket-spawned session's name only
  repeats the key + summary; the branch tells two sessions on one ticket apart). An operator's rename
  (`summaryManual`) leads once it exists. The live git branch beats the reserved one.
- The chip's label ellipsises on **its own element** (`.kc-sess` is a flex container; `text-overflow`
  can't clip anonymous flex content — the same trap `.kc-repo` documents).
- The reverse link rides the session: the Sessions card meta shows the ticket key (a plain span — the
  card is a `<button>`), and the chat footer carries a linked `jira-chip` beside the PR chip
  (`ticketFooterChip`).
  - The chip links to that ticket on Turma's OWN board — `/board?ticket=<key>&site=<siteKey>` — not out
    to Jira (XERK-16): from inside a session the board is the more useful hop (repo triage, other
    sessions, controls), and its card links on to the live Jira issue.
  - The board's `consumeDeepLink` (in `board.html`) is one-shot: waits for the ticket's org to report,
    opens the panel on the first render that resolves the key, and strips the query params. `site` is
    optional.

#### Ticket detail panel

- **Clicking a card expands it into a detail panel** (`detailHtml`) with the full description, comments,
  people, parent, and labels.
- It opens instantly painted from the card's heartbeat fields, then fills from
  `GET /api/jira/<siteKey>/<issueKey>`, which routes to a host reporting that org (preferring online),
  serves a fresh cached copy, or queues a `jiraIssue` command and 202s so the client polls
  (`ingestJiraIssues`, cached by `JIRA_ISSUE_FRESH_MS`/`_MAX_AGE_MS`/`_MAX`, stripped from `/api/agents`).
  An org whose only host is offline serves its last copy flagged `stale`; a cached `error` is kept so a
  doomed fetch isn't re-queued.
- The fetched copy wins field-by-field over the card's older values. Agent-side text is already plain, so
  the panel escapes first and linkifies after.

##### Changing the repo by hand

- The Repo row carries a **"Change"** control that swaps the row in place for a picker of the org's
  `jira.repoOptions` — cloned and un-cloned repos in separate `optgroup`s, plus "No repository fits" and
  "Let the agent decide". It `POST`s to `/api/jira/<siteKey>/<issueKey>/repo` (see "Manual repo override").
- **Choosing an option IS the save** — the dropdown is the setting, every option is a complete answer, so
  picking one commits it and closes the picker. There is no Save button: with one, closing the panel
  discarded the choice silently and snapped back to the model's guess.
- Re-picking the value already showing saves **nothing** but still closes the picker. `repoPickerValue`
  is what the handler compares against, and the same function `repoPickerHtml` preselects from — they must
  not drift, or a real change reads as a re-pick and gets dropped. **Cancel** (and clicking away) is the
  way out for someone who opened it by mistake.
- The row is present even for an **untriaged** ticket, reading "Not triaged yet" (the card draws no chip,
  but the panel is where an override is made, and an unclassified ticket is exactly the one worth pinning).
- **Only a manual pin preselects a repo.** An auto guess of "Turma" is the model's answer while the
  operator's setting is "let it decide" — preselecting it would misreport that as a pin and turn a "leave
  it alone" Save into one.
- Options are merged **across the org's hosts** (`mergeSites`, cloned winning the dedupe): `cloned` is
  host-relative, the override fans out to every host anyway. Collected next to `hosts` over EVERY agent,
  not in the winners loop (whose blocks are one per (site, user), so the picker would otherwise offer only
  whichever host polled Jira last).
- A pinned repo that has **left** the options (deleted, off the cap's tail, a blanked `gh` sweep) is
  carried back in under "Currently set" so it stays selected — else the browser falls back to its first
  option ("Let the agent decide"), misreporting the pin and turning an untouched Save into a silent
  release. `_apply_triage` keeps rendering such a repo on purpose.
- The save is painted **optimistically** (the pin only becomes real next beat); a failed request rolls the
  paint back and says so on the row.
- `refreshOpenTicket` re-points the open panel at the rebuilt ticket each beat (`mergeSites` builds fresh
  objects). It holds the optimistic paint for `REPO_SETTLE_MS`, after which the heartbeat wins (stopping
  the panel insisting on a pin the agent refused). It repaints only when a rendered field changed (else it
  throws away the scroll position of anyone reading a long description), and never while the picker is
  open.
- "Change" only appears when a host of that org is **online** (the command rides the heartbeat). The edit
  state lives in a page variable, not the DOM (the same rule the session card's ⋯ menu follows).

##### Pinning the agent by hand (XERK-38)

- Below the Repo row sits an **Agent row**: which HOST this ticket's sessions spawn on, defaulting to
  "Auto — most available agent". Its "Change" swaps in a picker of the org's reporting hosts; **a pick IS
  the save**, same contract as the repo picker.
- Deliberately **panel-only** — the card gets no chip. Auto routing is the common case with no model guess
  worth surfacing; the row exists for the rare multi-agent-org override.
- **The pin is hub-owned, not an agent-ledger fan-out** like the repo override: it is a ROUTING input,
  routing happens on the hub, and it persists in the hub's own `/data/ticket-agents.json`
  (`TICKET_AGENTS_FILE`, keyed `<siteKey>/<issueKey>`, bounded by `TICKET_AGENTS_MAX` oldest-first) —
  durable across hub restarts, and NOT in the best-effort `state.json`.
- So `POST /api/jira/<siteKey>/<issueKey>/agent` (`{host}` to pin, `{auto:true}` to release) answers an
  authoritative **200, not the /repo route's 202-on-queue**. The host is allowlist-checked against the
  fleet's hosts reporting that org; an OFFLINE host is pinnable (a persistent choice about future spawns),
  a host of another org is not.
- `findTicketHost` honors a pin over the availability ranking for **both** the Start button and the
  auto-start sweep. A pinned host that's offline (or gone) **refuses with the pin in the error, never
  silently reroutes**; the sweep treats that like any no-host result (unrecorded, retries when it returns).
- The map rides `/api/agents` as top-level `ticketAgents` (plus a `ticketAgents` SSE event); the picker's
  options are `mergeSites`' per-site `hostOptions` (every host reporting the org, online first, offline
  marked). A pinned host that left the fleet is carried back into "Currently set".
- A pinned host without the repo still works: clones on demand and queues behind the clone.
- Tests: the ticket-agent-pin cases in `turma/tests/server.test.js` and `board.test.js`, the
  hostOptions/agentPinOf cases in `android/app/src/test/.../BoardTest.kt`.

#### Refresh button

- `POST /api/jira/refresh` fans a `refreshJira` out to every Jira-configured host, deduped so a mashed
  button costs one poll per host. It fans out because the board is a *merge* of every host's block.
- It targets the block's `configured` flag (creds present) rather than `available` (a poll succeeded),
  because a failing host reports `available=false`/`siteKey=null` — exactly the host a retry is for.
  `siteKey` is the fallback for older agents.
- It resolves on real fleet state: holds until the queued command clears from the targeted hosts'
  records (`jiraRefreshPending` — which covers a poll that FAILED, whose fail-open leaves `fetchedAt`
  untouched), with `newestFetchedAt` as a second signal and a 45s timeout. It reports "Refresh failed"
  only when EVERY targeted host errored (`jiraRefreshFailed`).

### Sessions page (`/sessions`)

- Opens a running session in a **native chat view by default** (`turma/public/chat.js`) instead of the
  raw ttyd terminal. It streams the live transcript over the `/live/<host>/<id>` WebSocket (ws-token
  auth, seeded from the heartbeat's cached tail, initial scrollback from `GET .../history`, `/history`-poll
  fallback when the socket is down).
- It renders chat bubbles — **user right, agent left** — with collapsible tool-action cards (tool_use
  input + its paired tool_result, error-styled) and collapsed thinking traces, the in-progress turn
  typing in via a typewriter reveal (ported from the glasses `live.ts`/`transcript.ts`/`reveal.ts`).
  - The live turn is the tmux **pane scrape's "last ● bullet"**, which — unlike glasses' transcript tail —
    is NOT monotonic: mid-generation it SWAPS between unrelated blocks (prose → a `Bash(…)`/`Read(…)` tool
    bullet → the next prose), which reads as the final line deleting and re-appearing (XERK-19).
  - Every `turn` frame is CLASSIFIED by `applyTurn` before the reveal — the streaming bubble is only for
    in-progress **prose**:
    - an empty frame or a **tool-use bullet** (`isToolBullet`: an identifier immediately followed by `(`)
      clears the bubble; that tool renders as a committed tool-card. A false positive skips ONE block's
      live preview (safe); a missed bullet brings the flicker back, so the detector leans toward matching.
    - the **same prose block** grown or re-captured keeps the LONGER text and never shrinks (`reveal.shown`
      holds; only the genuine delta types in), so a partial re-capture can't re-type from a stale offset.
    - a **genuinely different prose block** retypes from 0.
  - Stands in for glasses `advanceReveal`'s entryId-change snap, which the pane scrape has no id for.
    `repaint`'s prefix check (`liveTurn.startsWith` the revealed slice, else snap `reveal.shown`) survives
    as a defensive clamp. Tests: the classifier/swap/continuation cases in `chat-selection.test.js`.
- Bubble prose is rendered by `renderProse` (`chat.js`): **fenced ` ``` ` blocks** become
  `<pre class="md-code">` (language chip from the info string), inline **` `code` ` spans** become
  `<code class="md-code-inline">` chips (`renderInline`), GFM **tables** become real `<table>`s, else
  linkified.
  - Passes nest outward-in — fence, table, inline, link — so each only sees text the outer ones didn't
    claim, and a code body is never linkified.
  - An inline span never crosses a line break (transcript prose is full of lone backticks). The fence pass
    runs above the table pass (a pipe row inside code isn't a table). An **unterminated fence renders as
    code** (mid-stream the closer isn't revealed yet, and the body must not flash as prose first).
  - A code-carrying bubble is given a **definite** `width: min(760px, 100%)` (scoped by `:has()`), taking
    it out of shrink-to-fit sizing so overflow lands on the block's own scroller (not a grid track, which
    would tear inline `code`/links onto their own lines).
  - Tests: the `renderProse` cases in `turma/tests/chat.test.js`.
- A per-session **verbosity control** (Concise/Normal/Verbose presets + per-type thinking/tool-calls/
  tool-outputs toggles, persisted in `localStorage`) filters which `blocks[]` show — a pure client-side
  filter over the received buffer.
- Typed prompts go to `POST .../input`; pending `AskUserQuestion`s answer via option chips / custom text
  to `POST .../answer`.
- The pending-question box renders Claude Code's full picker: each option is a card with its
  `description` and a collapsible **`preview`**, plus a `header` chip and an "n of N" counter for a
  multi-question call.
  - These ride new heartbeat fields (`questionOptionsRich`/`questionHeader`/`questionIndex`/
    `questionTotal`/`questionMulti`) alongside the backward-compat `questionOptions` labels, so
    glasses/android keep rendering the flat list.
  - A **`multiSelect`** question renders checkboxes + a Submit that `POST`s `optionIndices` (a list);
    `answer_question`/`ask.py` accept it. `optionCardHtml` builds each card; the agent side is
    `_question_options`/`_hook_question` + `TestHookQuestion`/`TestAnswerQuestion`/`test_ask.py`.
- The compose footer's live agent-mode / model selectors are joined by a compact **PR status chip** (the
  latest PR, `prFooterChip` in `chat.js`) when it has one.
- The **model selector is accurate** (XERK-33) — it used to read "Default", offer a hardcoded menu, and
  rewrite the shared login's default (see `setModel`):
  - the chip leads with the session's heartbeated `modelActual`, rendered human by `prettyModel`
    ("claude-opus-4-8" → "Opus 4.8"; a confirmation label like "Sonnet 5" passes through), falling back
    to the picked alias, raw id in the tooltip;
  - the menu is built by `modelOpts` from the host's probed `models` block — curated to the aliases the
    /model picker can reach, "Default (<label>)" saying what it resolves to, the static four when a host
    hasn't probed;
  - a just-picked switch holds its optimistic label until the agent confirms or `MODEL_SWITCH_SETTLE_MS`
    passes (`modelSwitchPending`). A pick the agent DEFERRED (heartbeated as `session.pendingModel`)
    outranks the memo and renders with an ellipsis ("Sonnet…"); the mode chip has the same memo
    (`modeChipValue`/`modeSwitchPending`), retired when the heartbeat's `permissionMode` agrees;
  - `onPoll` carries the fresh host payload so the menu tracks the probe, and the dashboard composer
    offers the same probed list (`modelChoices` in `index.html`).
  - Tests: the `modelOpts`/`prettyModel` cases in `chat.test.js`, the malformed-model endpoint case in
    `server.test.js`, and the agent tests under the models-probe bullet.
- The raw ttyd terminal stays one **"Terminal ▸" toggle** away in the chat header (the old `#termPane`
  iframe). `GET /api/ws-token` now also authenticates the web chat's `/live` socket. Core merge/grouping
  logic is unit-tested in `turma/tests/chat.test.js`.

#### Working-status bar and agent list

- A pinned **working-status bar** below the transcript mirrors the terminal's bottom region from the live
  `status` frame: the spinner verb + ↑/↓ token counters + elapsed, and Claude Code's rotating
  tip/active-task hint.
- When background agents are running it shows a clickable **agent list** (`agentsHtml` in `chat.js`:
  `main` as a plain marker, each subagent as a button carrying its type + description).
- Clicking a subagent opens its transcript read-only in the right stage (`openSubagentView` in
  `sessions.html` → `GET /api/agents/<host>/sessions/<id>/subagents/history?type=&label=`, reusing the
  archive viewer + chat engine), with **Back** returning to the live session.
- Tests: the `agentsHtml` cases in `chat.test.js` and the subagent-history endpoint cases in
  `server.test.js`.

#### Queued sessions

- A **"Queued" section** above Active lists sessions the agent hasn't provisioned yet (`status:"queued"`).
  Its cards are static (no pane to attach to), showing the wait reason (`queuedReasonText`) and a
  **Cancel** (arm-then-confirm kill).
- A followed spawn (`?spawn=<cmdId>`) that lands in the queue words its stage **"Queued — <reason>"** and
  flips to the live session the moment it provisions. The dashboard's session card mirrors this. Tests:
  the Queued-section cases in `turma/tests/sessions.test.js`.

#### Ended sessions

- The sidebar's third section (below Active/Idle/Queued), **collapsed by default** — history, and it only
  grows. Replaced the old "Stopped" list. It merges the three channels an over-but-resumable session
  arrives on:
  - **killed** — dropped from the registry into the agent's closed history (`a.closedSessions`);
  - **stopped** — its claude exited on its own, so a non-running record stays in `a.sessions`;
  - **resumable** — a transcript from each repo's `resumable` scan, with no registry record behind it.
- The third channel is what makes the list **durable**. The first two read out of `~/.turma` (the host's
  to provide) and `closed.json` is capped at `CLOSED_PER_REPO`, so neither is the whole history.
  `resumable` is re-derived every slow beat from the transcripts under `~/.claude/projects` (a bind mount)
  plus each transcript's recorded cwd, carrying every prior session.
- **Deduped on `<host>::<transcriptId>`**, a registry-backed record always winning (only it knows the
  session's PRs, when it was killed, and that `resume` can have it back under its id). A kill that ages out
  of `closed.json` keeps listing — it just loses its PR chips (there is no record left to snapshot them
  onto).
- Sorted **most recently ended first** (`endedMs`, from `closedAt`/`stoppedAt`/`endedTs` — note
  `resumableSession()` must copy `endedTs` onto the record, where `endedEntry` reads the key). An undated
  record (older agent) sorts oldest.
- The resumable channel's **`endedTs` is the last message's own transcript timestamp**
  (`_last_activity_ts`), NOT the file mtime (XERK-73). mtime is inflated to copy-time by a synced
  `~/.claude` or a backup restore, so a week-old conversation sorted to the top of Ended though nothing
  was said; the entries keep their real UTC timestamps, which is the accurate sort/display key.
  `_archive_manifest` dates its rows the same way. Both fall back to mtime for a transcript with no
  timestamped entry. Tests: `TestLastActivityTs`, the `endedTs` cases in `TestResumableReport`.
- A **running** session is never also listed as ended: the agent re-cuts the cached scan against its live
  registry every beat (`_sorted_repo_entries`), and the page dedupes resumable rows against every reported
  session's `transcriptId` (why `_session_payload` reports it for running sessions too).
- **Clicking a row opens that session read-only on the stage** — the same `#transcriptPane` the
  archive/subagent views use: scrollable conversation + a verbosity control, **no terminal toggle and no
  compose box** (no live pty). `resetEndedBar()` keeps the pane's shared PR/Resume bar from leaking into
  those views.
- The conversation is read from the hub's **archive** (`GET /api/archive/<transcriptId>`), so it works for
  an offline host. A just-killed session legitimately hasn't synced yet (archive push is on the slow
  cadence) and says so.
- Its **PRs are chips on the stage bar and are LINKS there** (`prBadgeLinkHtml`); the sidebar copy stays
  an inert `<span>` (the card is a `<button>`).
- **Resume** sits on the row and stage bar, dispatching on how the session ended: killed → `.../resume`
  (re-registers under the same id), stopped → `.../start`, resumable → `.../transcripts/<id>/resume` with
  its origin cwd (the agent re-validates the path and re-creates the dir if a prune removed it). It hands
  off to the live session like a spawn. The list is DERIVED, so a resumed session drops out on the beat the
  agent reports it running.
- The resumable path comes back under a **new id**, so it follows its queued command's `cmdId` and its
  row spinner clears on the repo's session count growing. Resume needs the host **online**; reading the
  conversation does not (the card stays clickable on a dead host, Resume disabled).
- Tests: the Ended-sessions cases in `turma/tests/sessions.test.js`, plus `TestRefreshPrStatus` /
  `TestSessionLifecycle` / `TestResumableReport` / `TestCardedSlugs`.

#### Session card ⋯ menu

- Each sidebar session card carries a **⋯ overflow menu** — a sibling of the card `<button>`, absolutely
  positioned over it (a nested button is invalid HTML).
- **Rename…** swaps the card for an inline field that `POST`s to `.../sessions/<id>/summary`, painted
  optimistically (the rename lands on the next heartbeat). **Kill** arms-then-confirms in place. The
  menu's open/armed/typing state lives in page variables, not the DOM.

#### Send and Stop buttons

- **Send always sends, and ◼ Stop is its own button**, in both chat and terminal views. A message sent
  mid-turn QUEUES (rendered as a dimmed "queued" bubble), so the button that talks must stay available
  while the agent works — on a phone it's the ONLY way to send. The warning-coloured Stop appears beside
  Send only while a turn runs, in the compose row.
- Stop interrupts the turn (`chatComposeStop`/`termComposeStop` → `stop()` → `POST
  /api/agents/<host>/sessions/<id>/interrupt` → the agent's Escape). Unlike Kill it arms/confirms nothing
  (a turn stopped by mistake can be re-asked) and leaves the session on the stage.
- **Enter always sends**, like the button. Only Send's tooltip changes with the turn (idle "send" vs busy
  "queues and runs when this turn ends").
- The busy read driving Stop's visibility is `chat.js`'s `liveStatus` (the ~1s pane scrape), NOT the
  heartbeat's `paneBusy` (a beat behind). With the live socket down no frames arrive, `liveStatus` stays
  null, and Stop stays hidden (a Stop that can't see the turn is worse than no Stop).
- A clicked Stop **hides immediately** (`stopPendingAt`, `composeBusy()`); if the turn outlives
  `STOP_SUPPRESS_MS` the interrupt didn't take and Stop comes back. A failed interrupt POST paints "Stop
  failed" (`actionFailed`'s selector arg).
- **A pending `AskUserQuestion` hides Stop** (`composeBusy()` returns false while `questionActive`) — the
  answer is typed THROUGH the compose box, routed to `/answer` (`send()`'s `wasAnswer` path), and an
  accidental Stop would destroy the question (XERK-21). `updateQuestion` repaints the bar the instant a
  question appears or clears.
- `chat.js` paints every `.compose-action` and `.compose-stop` button from that one read, so the
  terminal's bar can't disagree with the chat's. Tests: the compose-bar cases in `chat.test.js` and the
  `termComposeAction`/`termComposeStop` cases in `sessions.test.js`.

#### Copying out of the terminal

- A copy made in the terminal view reaches the viewer's **real system clipboard** — three independent
  fixes, since the text has to survive the app, tmux AND xterm.js (XERK-7).
- Selecting at all needs a **modifier**, because the Claude TUI holds mouse tracking and xterm.js hands it
  every drag. That modifier is **Shift** everywhere except macOS, where xterm.js honours **Alt** only when
  `macOptionClickForcesSelection` is on (defaults off) — `_launch_ttyd` passes it (cost: Mac's Alt+drag
  column-select). Once a selection EXISTS ttyd copies it itself (`document.execCommand` on
  `onSelectionChange`).
- **Every other copy — the app's own and tmux copy-mode's — travels as OSC 52**, and all three links were
  broken:
  - tmux only emits OSC 52 if the OUTER terminfo advertises an `Ms` capability, which xterm-256color /
    tmux-256color lack here — `agent/tmux.conf` declares `Ms` (we launch the outer terminal, so we know
    it's xterm.js).
  - `set-clipboard`'s default `external` forwards **no** application OSC 52; `on` forwards it and keeps a
    tmux buffer.
  - xterm.js parses OSC 52 but ships no handler — ttyd exposes its instance as `window.term`, so the hub
    injects the missing handler (`TERM_OSC52_JS`, in `proxyTerm`).
- The bridge is deliberately **write-only**: an OSC 52 READ request (`?`) is never answered (else any
  program in the pane reads the clipboard). An empty payload is dropped. It splits the payload at the
  **first `;`** (an app sends `52;c;<b64>`, tmux sends `52;;<b64>`, both must land).
- Tests: the OSC 52 bridge cases in `server.test.js` and
  `test_launch_ttyd_lets_a_mac_force_a_selection` in `agent/tests/test_hub_agent.py`.

### Durable archive

- The hub hosts a **durable, searchable archive of ended sessions** (`turma/archive.js`): agents push each
  inactive transcript in. The hub lands it as **organized files on `/data`** — one folder per repo, each
  renamed + dated `/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl` (+ a `.meta`
  sidecar).
- Files are indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, Node-core, no npm),
  rebuildable from the files.
- The Sessions page gains a search box (`GET /api/search?q=` — instant hub-local full-text search, ranked,
  `<mark>`-highlighted, grouped by `remoteKey`, working for offline hosts) and an "Ended sessions" browser
  (`GET /api/archive`); clicking a result/row opens the full transcript read-only
  (`GET /api/archive/<transcriptId>`).
- The ingest endpoint is agent-token-authed; the manifest cursors ride the heartbeat reply. Tests:
  `turma/tests/archive.test.js`, the ingest/search/browse cases in `server.test.js`.

### `POST /api/trigger` — external automation

- Starts a session from a single JSON body — `{hostname, repo, prompt}` all **required**, plus optional
  `label`/`baseRef`/`model`/`permissionMode`. Validates host and repo (against the host's reported
  `repos[]`, incl. `(root)`) before queuing the same `{type:"spawn"}` command the composer uses.
- Unlike `POST /api/agents/<host>/sessions` (user-auth only, repo-in-URL, prompt optional), it's gated by
  `triggerAuthorized`: a dedicated **`TURMA_TRIGGER_TOKEN`** bearer token OR the ordinary user login. When
  the token env is unset the endpoint accepts the user login but no token caller. Tests: the `/api/trigger`
  cases in `server.test.js`.

### Notifications

- Session commands are queued on the hub and drained via the heartbeat reply.
- The hub pushes edge-triggered alerts to the **Android client via FCM** — the sole notification transport
  (XERK-10 removed the ntfy path): host offline/recovered, restart loop, per-session turn finished /
  question waiting / PR created.
- **`android/app/google-services.json` is committed** (XERK-37): the Firebase client config must be IN the
  repo for the CI-built release APKs to carry it — gitignored, every released build had Firebase inert and
  push did nothing. It holds only public identifiers (same as the committed release keystore); the gradle
  apply stays conditional so a fork that removes it still builds.
- Every alert funnels through one `notify()` (`turma/server.js`), which fans out to every registered
  device via `turma/push.js` (HTTP v1, service-account JWT minted with `node:crypto`, no npm — enabled by
  `FCM_SERVICE_ACCOUNT_JSON`), carrying `tags`/`priority`/`click`/`route:{host,sessionId}` as message data
  so the client picks a channel and deep-links a tap. `notify()` is a no-op when no device is registered or
  FCM is unconfigured.
- Devices register via `POST /api/devices` (user-authed, persisted to `/data/devices.json`), unregister
  via `DELETE /api/devices?token=`; dead tokens (404 UNREGISTERED) are pruned on send.
- The Android client owns the delivery half: `POST_NOTIFICATIONS`, the Android-13+ runtime request in
  `MainActivity`, channels + rendering in `push/Notifications.kt`, token registration/rotation in
  `push/PushRegistrar.kt` — all guarded so a build without `google-services.json` still runs.
- Tests: `turma/tests/push.test.js`, the alert and device-registry cases in `server.test.js`.

### Auth and the glasses surface

- UI, API, and the click-to-attach live terminal (`/term/<sessionId>/`, reverse-tunneled to that session's
  ttyd by port) sit behind single-user HTTP Basic auth (`TURMA_USER`/`TURMA_PASSWORD`).
- Agents authenticate heartbeats, tunnel WebSockets, and ttyd with one shared token (`TURMA_TOKEN` in the
  agent's env = `TURMA_AGENT_TOKEN` on the hub). All set inline in DockerOps'
  `compose/turma-truenas.yaml`.
- The hub also serves the `glasses/` client's needs:
  - a CORS'd `/api/*` surface for that cross-origin WebView;
  - per-session `input`/`history` endpoints;
  - `GET /api/ws-token` for short-lived WebSocket auth;
  - an `/audio` STT WebSocket (transcribes G2-mic PCM via the LiteLLM instance's OpenAI-compatible
    transcription endpoint — `LITELLM_URL`; `WHISPER_*` override only if the STT server lives elsewhere);
  - a `/live/<host>/<sessionId>` **live-transcript WebSocket** (ws-token auth): the hub asks the host's
    tunnel-agent to `watch` the session, seeds the socket with the last heartbeat's cached tail, fans the
    agent's `{tail,entries}` deltas out, and `unwatch`es when the last viewer disconnects (re-arming on
    control reconnect).

## `glasses/` — Even Realities G2 smart-glasses client

- Vite + TypeScript, Vitest; an Even Hub plugin.
- Sessions list, scrollable transcript, `AskUserQuestion` answering, spawn/kill/resume, and G2-mic
  dictation transcribed via the hub's `/audio` endpoint.
- While the session screen is open it opens the hub's `/live` WebSocket (`live.ts`) and renders growing
  text with a **streaming typewriter reveal** (`reveal.ts`): small deltas type in, a large chunk snaps in
  immediately. Falls back to the 6s poll if the live socket can't connect.
- See `glasses/README.md` for dev/simulator/packaging/QA details.

## `android/` — native Android client

- Kotlin + Jetpack Compose, MVVM. Full parity with the web dashboard + glasses client, plus phone-only
  features: **OS push notifications** (FCM) and **voice** for starting sessions and mid-session prompts.
- Mirrors the glasses pure-core/adapter-shell split:
  - `core/` — JVM-unit-tested reducers ported 1:1 from `glasses/src` (`Reveal` typewriter, `Transcript`
    grow-only merge, `Sessions` working/idle/waiting, `ChatItems` buildItems+verbosity).
  - `model/` — the wire shapes + shared `TurmaJson` decoder.
  - `net/` — the `HubClient` (Retrofit/OkHttp/kotlinx.serialization), `LiveTail`+`FleetRepository`
    (WebSocket `/live` + SSE `/api/events` with a 6s `/api/agents` poll floor), and `Dictation` (16kHz
    PCM → the hub's `/audio` Whisper socket).
  - `vm/` — the ViewModels.
  - `ui/` — the Compose screens (fleet tree, native chat with reveal/tool-cards/thinking/verbosity/
    ttyd-terminal toggle, spawn composer, actions, clone, prune, resume, question sheet, history/usage
    charts, archive search).
  - `push/` — the FCM service + `PushRegistrar` (registers via `POST /api/devices`; guarded so a build
    with no `google-services.json` still runs).
- Push is driven hub-side by `turma/push.js`.

### Web UI ⇄ Android parity (XERK-30)

- **The mobile web UI (`turma/public/`) is the source of truth; the Android app must match it.** The web
  is where a feature lands first, so the app is always the follower.
- **A PR that changes user-facing behavior in `turma/public/` must carry the matching change to
  `android/` in the same PR** (or, if out of scope, add a line to `android/PARITY.md` and say so in the PR
  — an unlisted, unmentioned divergence is what this rule exists to stop). "User-facing" = a control,
  screen, state, chip, interaction, or layout a person sees or touches; pure server/agent plumbing is
  exempt.
- When you touch one of these web files, check its Android counterpart:
  - `index.html` → `ui/FleetScreen.kt` + `ui/FleetDialogs.kt`
  - `sessions.html` + `chat.js` → `ui/SessionsScreen.kt` + `ui/ChatScreen.kt` + `vm/ChatViewModel.kt`
    (+ `ui/ArchiveScreen.kt` for the full-history search)
  - `board.js` + `board.html` → `ui/BoardScreen.kt` + `core/Board.kt` + `vm/BoardViewModel.kt`
  - `usage.html` → `ui/UsageScreen.kt`
  - `nav.js` → `ui/MainScaffold.kt` + `ui/TurmaApp.kt`
  - `org.js` → `ui/OrgControl.kt` + `vm/OrgViewModel.kt` + `data/OrgFilter.kt`
- **Pure logic ports live in `core/` and are JVM-unit-tested against the web behavior** — the board
  category carve-out (`core/Board.kt` ↔ `board.js` `categoryOf`), the typewriter reveal (`core/Reveal.kt`
  ↔ `chat.js` `repaint`), the summary-tile reducers (`core/Fleet.kt` ↔ index.html
  `fleetTokens`/`mergeModels`). Port the *logic* there and keep the Compose screen a thin renderer.
- **Match features and structure, not pixels.** Every control, state and interaction the mobile web
  exposes is present and behaves the same, laid out platform-idiomatically (a Material dropdown for a
  `<select>`, an overflow menu for the ⋯ menu). A justified platform difference (native chat vs ttyd
  terminal, the Hub-URL login field, voice dictation) is recorded in `android/PARITY.md`.
- `android/PARITY.md` is the **living gap tracker** — update it whenever you close a gap or knowingly open
  one.

### In-app update (XERK-11)

- A stopgap self-updater until the app ships on Google Play: checks the **public** `xerktech/turma`
  releases for a newer APK and, on a one-tap **Update**, downloads it and hands it to the system package
  installer.
- Split like the rest: `core.Update` is the pure, JVM-tested picker (`apkAssetVersion`, `compareVersions`,
  `latestApkUpdate`); `net.Updater` is the I/O (fetch/download/install + `State` StateFlow);
  `ui.UpdateBanner` + `vm.UpdateViewModel` render it on the Dashboard.
- It compares the version in the **asset FILENAME** (`turma-android-v<x.y.z>.apk`) against the installed
  `versionName`, never the release TAG (a release carries an unchanged APK forward under its original name,
  `manifest.js`). It scans every recent release's assets, not just "latest".
- **Anonymous + credential-isolated**: the repo is public, so the check is anonymous HTTPS (like
  `bootstrap.sh`), and the updater uses its OWN `OkHttpClient` WITHOUT `HubClient`'s Basic-auth
  interceptor, so the hub password never reaches github.com.
- Checked on app start and each Dashboard visit, throttled ~15 min; **quiet on failure** — the banner only
  surfaces on a real update, and "Later" hides that version for the session (resurfaces next launch).
- Install uses `REQUEST_INSTALL_PACKAGES` + a `FileProvider` (`@xml/file_paths`, authority
  `${applicationId}.updates`) over a `content://` URI. On API 26+ the OS gates on "install unknown apps";
  ungranted, the updater routes to that settings screen and the banner reads **Install**. The OS verifies
  the APK signature on install, so no sha is re-verified here.
- **Stable signing key (XERK-26)**: in-place update works ONLY when every build shares one cert, so
  `release.yml` builds `assembleRelease` signed with a fixed keystore committed to the repo
  (`android/app/turma-release.keystore`, wired in `app/build.gradle.kts`'s `signingConfigs`). It shipped
  `assembleDebug` before — the debug key each CI runner generates fresh, so every update forced an
  uninstall+reinstall (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The key is deliberately in the public repo
  (its job is to be identical everywhere); Play App Signing supersedes it on Play. Moving onto the first
  stable-key build still needs one last uninstall.
- Tests: `core/UpdateTest.kt`.
- Built with Gradle (wrapper generated in CI, not committed); PR-gated by `android-ci.yml` on
  `ubuntu-latest` against its preinstalled JDK + Android SDK, JDK 17 and Gradle pinned in-job to match
  `app/build.gradle.kts`. Setup + FCM wiring in `android/README.md`.

## `.github/workflows/`

GHCR image builds and PR gates — see Build & Deploy.

## Build & Deploy

### Unified releases

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all five components + a changelog**, cut by
  `.github/workflows/release.yml`. See `RELEASING.md` and `.github/scripts/README.md`. Replaced five
  per-component workflows whose independent `run_number` patches drifted out of lockstep.
- The root **`VERSION`** file holds `MAJOR.MINOR` only. The **patch is derived from existing `v*` tags**
  (`max` on that line + 1), never committed. Bump `VERSION` only for a minor/major.
- The five components: `turma` image, `agent` image, glasses `.ehpk`, android `.apk`, native agent
  tarball. All version math (tag-derived patch, android `versionCode` packing, the strictly-greater guard)
  lives in the tested `.github/scripts`.

### What a release builds vs carries

- Only **changed** components build; **unchanged** ones are **carried** — their prior artifact is
  published at its own prior version, not rebuilt. So every release publishes all five; a carried one just
  reads its older version.
- **Images**: built when changed; carried → the manifest references the prior `:version` tag (no retag). A
  carried image's `:latest` is already correct, so Watchtower needs nothing.
- **Assets** (`.ehpk`/`.apk`/`.tar.gz`): a carried asset is copied forward under its **original name** (the
  filename must describe the bits — Even Hub / Android installs by the version baked inside). A built asset
  is named at the new version.
- A per-release **`manifest.json`** is the machine-readable source of truth for each component's version +
  where its bits live — read by the next release's `plan`, the native updater, and humans.
- The bundled Claude Code release is pinned via `CLAUDE_CODE_VERSION` but is **not** part of the version
  (resolved only to feed the build-arg).
- Watchtower keeps `:latest` current; the DockerOps compose references
  `ghcr.io/xerktech/turma-agent:latest` — keep that ref in sync if renamed here.
- Trigger: `workflow_dispatch` (`dry_run` defaulting on) plus `push: main` for auto patch releases. A
  manual `minor`/`major` dispatch bumps `VERSION`, rolls intervening patches into `CHANGELOG.md`, and
  force-builds every component.
- The `push: main` trigger is **path-filtered to the four component source dirs**, restating `changes.js`'s
  `PREFIX_MAP` (a workflow trigger can't call into JS; a test asserts the two match). A docs-only merge
  cuts no release.
- `agent-emulator-image.yml` builds the opt-in `:emulator` agent tier on demand — not a release component,
  so no unified version.

### Deployment (DockerOps, not here)

- `compose/turma-truenas.yaml` defines the `turma` service and a single per-host `agent-host` container:
  mounted at `REPOS_ROOT`, `MAX_SESSIONS`/`TTYD_PORT_BASE`, host mounts, the shared
  `TURMA_TOKEN`/`TURMA_AGENT_TOKEN`, the FCM push service-account (`FCM_SERVICE_ACCOUNT_JSON`), basic-auth.
- No pricing/cost env — usage is counted in tokens per model name, so there is no rate table.
- Because one container hosts many concurrent sessions, its `mem_limit`/`cpus`/`pids_limit` are sized
  against `MAX_SESSIONS`.
- Editing image content here + pushing rebuilds the image; changing how it's run (or adding a host) means
  editing that compose file in DockerOps.
- The hub's `/data` volume (home to `state.json`) also holds the **durable session archive**
  (`/data/archive/` — files + a `node:sqlite` FTS index), which must be a persisted volume. Overridable
  via `ARCHIVE_DIR`/`ARCHIVE_DB`.
- The `turma` service also takes the LiteLLM env for **Whisper STT** (`LITELLM_URL` = that instance's
  `/v1` base, optional `LITELLM_API_KEY`; legacy `WHISPER_URL`/`WHISPER_API_KEY` override). Optionally set
  `NODE_NO_WARNINGS=1` to silence `node:sqlite`'s experimental warning.

### PR gates (pre-merge to main)

The build workflows run only post-merge; these run on `pull_request` → `main` and block the merge:

- `code-scan.yml` — Semgrep SAST over the JS/Python + Dockerfiles + secret patterns, hadolint on both
  Dockerfiles, ShellCheck on `entrypoint.sh`.
- `turma-agent-image-scan.yml` / `turma-image-scan.yml` — build each image locally (no push) and
  Trivy-scan for CVEs + secrets (`ignore-unfixed`, HIGH/CRITICAL gate), path-filtered to their folder.
- `glasses-ci.yml` — path-filtered to `glasses/**`, runs typecheck + Vitest + production build in a
  throwaway `node:24-alpine` container.
- `android-ci.yml` — path-filtered to `android/**`, runs JVM unit tests + `assembleDebug`.

`code-scan.yml` also unit-tests the release logic (`.github/scripts/tests`) and the native updater
(`agent/tests/test_turma_agent_update.sh`).

Because the images bundle third-party binaries, keep the pinned tool versions current — that's how most
CVEs are cleared. Non-actionable upstream base-image findings go in the root `.trivyignore` (a reviewed
triage list, each with a reason); anything unlisted still fails.

### The agent image's cloud CLIs

- The agent image bundles **terraform, `az` and `aws`** (pinned via
  `TERRAFORM_VERSION`/`AZURE_CLI_VERSION`/`AWS_CLI_VERSION` in `agent/Dockerfile`), so a session can manage
  infrastructure the way it manages GitHub through `gh`.
- They live in the `tooling` stage, so **every tier carries them and the CI scan covers them** — they are
  credential-bearing tools talking to cloud control planes, the surface the Trivy gate exists for. Cost:
  ~1.0 GB (az 628 MB + aws 240 MB + terraform 96 MB).
- **Creds are the host's, reused through optional bind mounts** like `~/.claude` and `~/.config/gh`; the
  image logs in as nobody and bakes no credential: `/root/.aws` (or `AWS_*` env) — `aws`; `/root/.azure` —
  `az`; `/root/.terraform.d` — terraform (Terraform Cloud backend).
- **A host that mounts none is supported, not an error.** `entrypoint.sh`'s preflight only LOGS which
  stores it found and never idles the container.
- It keys on a **login-marker file** (`~/.aws/credentials`, `~/.azure/msal_token_cache.json`,
  `~/.terraform.d/credentials.tfrc.json`), never the store directory, because each CLI creates its own
  store just by RUNNING (`az version` writes a whole `~/.azure`). The Dockerfile's build-time smoke test
  drops the stores it creates. A file check, not `aws sts get-caller-identity`/`az account show` (slow;
  the mount's absence already says it). An expired token is the CLI's problem in-session.
- The guard's `permissions.deny` protects `~/.azure` and `~/.terraform.d` alongside `~/.aws`/`~/.ssh`
  (shared by every session, so editing one breaks the others). Tests:
  `agent/tests/test_entrypoint.sh` (cloud-creds cases), `test_guard_settings.py`.

### The agent image's Android toolchain

- The images bundle the docker CLI, `gh`, ttyd, npm, and — in the agent image — a **JDK 17 + Gradle +
  Android SDK** toolchain, so agents can build and JVM-unit-test Android apps: `gradle`/`sdkmanager`/
  `avdmanager`/`adb`/`aapt2` on PATH, pinned via `GRADLE_VERSION`/`ANDROID_CMDLINE_TOOLS`/
  `ANDROID_PLATFORM`/`ANDROID_BUILD_TOOLS` in `agent/Dockerfile`.
- **The image is tiered** (`AGENT_BASE`):
  - `:latest` is the `android-build` tier (2.0 GB), no emulator or system image (those cost 4.4 GB and
    nothing in CI or `android/` needs them — 33 JVM unit tests, zero instrumented; `android-ci.yml` runs
    `assembleDebug` + `testDebugUnitTest`).
  - To RUN an app, `adb connect` to a device or an emulator on a KVM-capable host (`platform-tools` is in
    the tier); that path is hardware-accelerated, unlike the bundled AVD (needs `/dev/kvm` passed, which
    no stack does).
  - If you need an in-container AVD, `:emulator` (the `android` tier, 6.4 GB,
    `ANDROID_EMULATOR_TAG`/`ANDROID_EMULATOR_ABI`) is built on demand via `agent-emulator-image.yml`.

### Where jobs run

**Every workflow runs on GitHub-hosted `ubuntu-latest`.** The home-lab box was 3 runners on one t3.xlarge
(~1.3 throttled vCPU each) against hosted's 20 concurrent jobs at 4 dedicated vCPU, so self-hosting mostly
bought queue time (PR gates were measured waiting 26 minutes to do 48 seconds of work).

- The image builds moved too. Their layer cache is `type=gha` — GitHub-side, so it follows the job to a
  hosted runner; the box's warm local docker cache was never what primed them.
- Disk is the real constraint for the agent image, handled in-job: the scan writes **one** image copy
  (build straight to a docker-archive, `trivy --input`) instead of three, scans the slim `tooling` tier,
  and both agent jobs delete the runner's ~25 GB of unused preinstalled toolchains up front. That reclaim
  is only safe because those builds are hermetic — **don't copy it into `android-ci.yml`, which builds
  against the runner's own Android SDK.**
- Hosted bills **rounded UP per job**, so prefer fewer batched jobs. Public repos are free; private ones
  draw on the 2000 min/mo pool.
- If a job genuinely needs self-hosted again (a >14 GB build, home-lab network reach), say which in a
  comment on its `runs-on` and bring back only the workarounds that job needs.

These constraints went away with the box, and the steps they justified are **deleted, not disabled** —
reintroducing any is a regression:

- "Reset workspace ownership" steps (the box's workspace persisted; a hosted runner is a fresh VM per job).
- Per-job `DOCKER_CONFIG` scoping (the box ran 3 runners as one user, so a concurrent `docker logout`
  wiped an in-flight push's ghcr.io credentials).
- `docker image prune` / `docker builder prune` cleanup (the box's disk was shared and outlived the job).
- Throwaway `node:24-alpine` containers for `npm view` (hosted has node/npm on PATH).
- The `mingc/android-build-box` container (the box couldn't pull ghcr.io and had no sudo; hosted
  preinstalls JDK + SDK).

Still true and unrelated: no GitHub Advanced Security, so no code-scanning API — findings live in the job
log and `--exit-code` is the gate (no SARIF upload). Trivy is installed from its release tarball to
`$HOME/.local/bin` (the trivy-action pins a step to a tag upstream deleted).

## Conventions

### Credentials

- All credentials are inline in environment variables (no Docker secrets mechanism) — matches DockerOps.
- The live secrets (`TURMA_TOKEN`, `TURMA_AGENT_TOKEN`, basic-auth, `FCM_SERVICE_ACCOUNT_JSON`) are set in
  DockerOps' `compose/turma-truenas.yaml`, not here.

### Run-as identity (host permission parity)

- The container writes into bind-mounted HOST dirs — the git root and the Claude login (`~/.claude`) — so
  the uid it runs as is the uid those files end up owned by on the host.
- `entrypoint.sh` resolves an identity BEFORE anything starts and `setpriv`s down to it: **`PUID`/`PGID`
  if set, else auto-detected from the owner of `REPOS_ROOT`** — the host user whose repos these are.
  - A root-owned git root (TrueNAS) resolves to `0:0` and the container stays root.
  - A user-owned git root (WSL/desktop) resolves to that uid and drops to it, so nothing lands root-owned
    in the operator's repo or `~/.claude`. `PUID=0` forces the old always-root behaviour.
- Because it drops, the entrypoint also:
  - reuses an existing passwd/group entry for the id (the node base image ships `node` at `1000:1000`,
    where a desktop host user lands);
  - `chown`s `/root` non-recursively (its children are the host's own bind mounts), since **HOME stays
    `/root`**, which every mount target and `PROJECTS_ROOT`/`~/.turma` path depends on;
  - joins the group owning `/var/run/docker.sock` (the `docker` CLI still needs it);
  - **self-heals on boot**, `chown`ing leftover uid-0 paths under `REPOS_ROOT`/`~/.claude` to the resolved
    id (files written by the pre-drop image are root-owned and the operator can no longer chown them).
- That heal only ever touches uid-0 paths, so a mis-set `PUID` can misplace root-owned files but never
  take the host user's own files away.
- Verified by building the entrypoint on the real base image against root-owned/user-owned/`PUID`-override/
  `PUID=0` roots.

### How a session runs

- Each session runs as that identity as an interactive `claude --remote-control`. It defaults to
  `--permission-mode auto` (Claude Code's classifier-gated hands-off mode); the composer can pick
  `bypassPermissions`/`acceptEdits`/`plan`/`default`.
- `bypassPermissions` is refused **under root** unless `IS_SANDBOX` is set (in the compose env). A host
  that drops to a non-root uid doesn't need it.
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

- Because sessions run hands-off, every launch passes `--settings` a generated file
  (`build_guard_settings()`, written once to `~/.turma/guard-settings.json`).
- That file wires a `PreToolUse` hook — `agent/hooks/guard.py`, stdlib-only, shipped to
  `/usr/local/bin/hooks/guard.py` — over Bash, plus `permissions.deny` rules protecting the host credential
  stores (`~/.ssh`, `~/.aws`, `~/.claude`, `~/.config/gcloud`; deny wins even under bypass).
- The guard hard-denies only three narrow categories, each with a reason the agent self-corrects from:
  - **destructive** — whole-repo/host destruction: `rm -rf` of `/`/home/system/`.git`, disk wipes, fork
    bombs, power changes, recursive `chmod`/`chown` of system roots, protected-branch history destruction,
    `DROP DATABASE|TABLE`;
  - **policy** — push to / delete `main`/`master`, or `gh pr merge` (work lands via a PR a human merges);
  - **attribution** — AI self-attribution trailers in commit/PR messages.
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) is untouched. A specific command
  can be allowlisted via `$TURMA_TOOL_GRANTS` (CSV of `Bash(<cmd>)`); attribution toggles via
  `$TURMA_NO_ATTRIBUTION=0`.
- The guard fails open on malformed input, and if the settings file can't be written the session still
  launches (without the guard). Adapted from an equivalent hook maintained outside this repo; keep the two
  in rough sync. Tests: `agent/tests/test_guard.py`, `test_guard_settings.py`.

### AskUserQuestion answer bridge

- The same generated `--settings` file wires a **second `PreToolUse` hook over `AskUserQuestion`** —
  `agent/hooks/ask.py`, stdlib-only, at `/usr/local/bin/hooks/ask.py` — the glasses answer bridge.
- Claude's own picker is a TUI affordance the glasses client isn't attached to, so the hook intercepts the
  call: for each question it writes `~/.turma/questions/<sessionId>.req.json` (keyed on the session id from
  `TURMA_SESSION_ID`/`TURMA_QUESTIONS_DIR`, prefixed onto the `claude` command in `_launch_tmux`) and
  **blocks**, polling for the answer file `answer_question()` drops when the glasses answer arrives.
- The answers are returned as a `PreToolUse` **deny** whose `permissionDecisionReason` is a
  `{kind:"askuserquestion_answers", answers}` JSON blob — deny-with-reason is the channel because a
  `PreToolUse` *allow* can't carry typed answer data; Claude reads the answers out of the tool_result.
- Because AskUserQuestion is serialized per session, req/ans files key on the session id alone. The hook's
  block timeout (`TURMA_QUESTION_TIMEOUT_SEC`, default 600s) sits under the settings-level `timeout`. It
  passes through silently when its env vars are absent. Kill/delete/restart clear pending req/ans files.
- Tests: `agent/tests/test_ask.py`, plus `TestHookQuestion`/`TestAnswerQuestion` and
  `test_guard_settings.py`.

### New-work branching policy

- A session's checkout is only as fresh as spawn: a worktree is detached at `origin/<default>` as of spawn
  (`default_base_ref`, whose short-bounded `git fetch` falls back to a stale local ref), and a repos-root
  session works on whatever branch the host last left checked out.
- So every launch (spawn AND resume) passes **`--append-system-prompt`** a fixed directive
  (`NEW_WORK_SYSTEM_PROMPT`, appended in `_launch_tmux`) telling the agent to refresh the base ITSELF when
  it starts new work: `git fetch origin`, resolve the default via `refs/remotes/origin/HEAD`, cut its
  branch from that **remote** ref rather than the current HEAD, carrying uncommitted work across and
  flagging a stale base when the fetch fails.
- It's `--append-system-prompt` because settings.json has no field carrying instructions. It's a
  **directive rather than manager-side enforcement** because only the agent knows when "new work" begins,
  whether a fetch failure is worth retrying, and which repo it's about to touch.
- Tests: the branching-policy cases in `TestSessionLifecycle`.

### Session activity summaries

- Each session gets a few-word "name" describing its task (e.g. "Adding Compose Flag"), shown on the card.
- Generated **agent-side**, once at spawn, from the initial task prompt by the container's authenticated
  `claude` in headless print mode (`claude -p`, Haiku default) — reusing the mounted login, so **no
  external API, key, or endpoint**.
- `_start_summary()` launches it as a detached subprocess (cwd = `~/.turma`, no `--settings`, so it never
  loads the guard or explores the repo). `_poll_summaries()` reaps it on later beats, cleans the output
  (`clean_summary()`: first line, strip quotes/punctuation, cap to ~6 words), and stores it as `summary`
  (persisted). The hub just renders `s.summary`.
- Always on; tuned only by `SESSION_SUMMARY_MODEL` (default `haiku`) and `SESSION_SUMMARY_TIMEOUT_SEC` (45).
  The claude.ai/code registered name (`rcName`) is still fixed at spawn — only the on-card summary is
  populated.
- Tests: `TestCleanSummary`, `TestCleanManualSummary`, `TestSetSummary`, `TestSessionSummaries`,
  `TestSummaryDue`, `TestFirstUserText`, `TestSeedSummaries`, the summary-endpoint cases in
  `server.test.js`, and the ⋯-menu cases in `sessions.test.js`.

#### Seeding from the transcript

- The naming attempt fires at spawn from the initial prompt, or — when a session is bare/quick-spawned with
  no initial prompt — from its **first user prompt read straight out of the transcript**.
- `_seed_summaries()` runs each beat: for every running, still-unnamed session it pulls the first genuine
  human prompt via `_first_user_text()` (skipping the header, `isMeta` caveat entries, and `<command-…>`
  slash-command wrappers) and triggers `_start_summary`.
- The transcript read is the **channel-agnostic** naming path and why bare sessions now get named: a bare
  session's first prompt is typed into the live ttyd terminal, which **never reaches `send_input`**, so the
  earlier `send_input`-only trigger missed the most common flow — but every channel lands the prompt in the
  transcript.
- `send_input` still fires `_start_summary` immediately when a prompt arrives that way — a fast path for
  the FIRST attempt. Retries belong to `_seed_summaries`, which reads from the top of the transcript.

#### Bounded-retry naming

- Naming is **bounded-retry, not one-shot**: an attempt can come back with no name for reasons unrelated to
  the session (a nonzero `claude -p` exit, an empty reply, the timeout, or a rate limit from the shared
  login), and the original single attempt made those transient failures permanent.
- `_summary_attempts`/`_summary_due` gate every path on *unnamed + attempts left + past the backoff*: up to
  `SUMMARY_MAX_ATTEMPTS` (3) tries spaced by a growing `SUMMARY_RETRY_BACKOFF_SEC` (90s × attempt), counted
  in a persisted `summaryAttempts`/`summaryRetryAt` (armed at launch, so a restart mid-attempt neither
  loops nor loses the retries owed). Bounded and backed off rather than per-beat precisely because of the
  shared login.
- The legacy one-shot `summaryStarted` boolean is still written and read as "one attempt spent", so
  sessions an older agent failed to name pick up their remaining retries.
- A session with no prompt yet (`_first_user_text` finds nothing) stays unnamed, spends **no** attempt, and
  looks again next beat. Once exhausted it degrades silently to "no summary" (label/worktree fallback).

#### Manual rename

- **The operator can rename a session by hand**: the Sessions page's ⋯ menu →
  `POST /api/agents/<host>/sessions/<id>/summary` → a `setSummary` command → `set_summary()`.
- The typed name goes through `clean_manual_summary()` (first line, whitespace collapsed, capped to
  `SUMMARY_MAX_CHARS` — but NOT word-capped or stripped of quotes/punctuation; what a human typed is the
  name they meant) and is persisted like the auto one.
- It sets `summaryManual`, which pins the card: `_summary_due` already declines to name a session that has
  any name, and the flag additionally stops a still-in-flight `claude -p` job from clobbering it in
  `_finish_summary`.
- A blank rename clears the name (back to the label/worktree fallback) and unpins — the only way back to
  auto-naming. Renaming is presentational, so it works on a stopped session too.
