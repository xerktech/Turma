# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Editing This File

Keep it merge-friendly. One idea per line, wrapped at ~100 characters, nested bullets and headings
instead of run-on paragraphs. Several PRs are usually open against this file at once; a single
multi-kilobyte line makes every one of them conflict. When adding to a component, add a new bullet
rather than extending an existing one.

## What This Repo Is

Turma is the source and CI for the Claude Code agent fleet used with the TrueNAS-based home lab:

- A **one-container-per-host** agent image that scans a git root and multiplexes many
  worktree-backed Claude Code Remote Control sessions.
- A central dashboard ("turma") that lists each host's repos, spawns/kills those sessions, and
  monitors them.

It builds two images and pushes them to GHCR; the running stack is deployed from the sibling
**DockerOps** repo (`compose/turma-truenas.yaml`, deployed via Portainer GitOps).

## Session Model (post-redesign)

This replaced the old model of one fixed-repo container per session.

### Hosts and repos

- One agent container per physical host, mounted at a git root (`REPOS_ROOT`, e.g.
  `/mnt/data/Docker/git`).
- The container scans the root one level deep for git repos and reports them.
- Alongside the scanned repos it advertises a **repos-root pseudo-repo** (`ROOT_REPO_NAME`, shown as
  "⌂ Repos root") — see "Repos-root sessions" below.

### Spawning a session

- From the hub UI you pick a repo and spawn a **session**, which the container backs with a
  randomly-named git worktree (dir keyed on the session `<id>`) under `REPOS_ROOT/.turma/worktrees`.
- The worktree is checked out in **detached HEAD**, forked off the latest default branch
  (`origin/HEAD` → main → master), best-effort fetched so new work starts from current upstream. An
  operator can override the base in the composer.
- **The app creates no branch of its own.** The running agent creates and names its own branch when
  its work is ready, and that live branch (read from the worktree's git HEAD) shows on the session
  card; until then the card reads "detached".
- A session spawned from a Jira ticket is told the exact branch NAME to use (`PROJ-123`, `-1`, `-2`),
  but still cuts it itself — the worktree stays detached and this invariant holds. See "Ticket branch
  naming" under the agent.
- The session runs its own `claude --remote-control` in its own tmux (`agent-<id>`) + loopback ttyd,
  with an optional initial task prompt delivered as claude's positional prompt, and an optional
  `--model`/`--permission-mode` from the composer.
- Many sessions run concurrently (up to `MAX_SESSIONS`), including several on one repo via separate
  worktrees. Each registers in claude.ai/code as `<host>-<repo>-<worktree-or-label>`.
- All spawn options are validated agent-side (allowlisted base refs, fixed model/permission enums),
  so nothing free-form reaches the shell. The random worktree dir and `agent-<id>` tmux stay the
  canonical internal keys; a label is presentational only.

### The session queue (XERK-14)

- A spawn that can't run RIGHT NOW is **queued, not refused**. It lands as an ordinary registry record
  with `status:"queued"` and no worktree/tmux/ttyd yet; `spawn()` splits into the record-build and
  `_provision_session()` (worktree + tmux + ttyd + naming), and a queued session runs through the
  SAME `_provision_session` when it's allowed to — nothing about a session that waited is second-class.
- Three orthogonal reasons a spawn queues (`queuedReason`), each re-checked by the drainer before it
  provisions: **capacity** (host at `MAX_SESSIONS`), **awaiting-clone** (its repo is being cloned to
  this host on demand), **root-busy** (another root session holds the one root slot).
- The queue/run decision is made BEFORE the record is appended to the registry, so the counts don't
  include the session being added (a root would otherwise see itself as root-busy; a capacity check
  would be off by one). The prompt/base-ref are stashed as `_pendingPrompt`/`_pendingBaseRef` so a
  queued session (whose repo may not exist yet) carries them across the wait; `_provision_session`
  consumes them.
- `_drain_queue()` runs every heartbeat: oldest-first, **at most one per beat** (provisioning launches
  claude against the one shared `~/.claude` login — the contention `resume_on_boot` staggers), head-of-
  line skipped not blocking (a session still waiting on its clone doesn't hold up a capacity-only one).
  A failed on-demand clone fails the session rather than waiting forever; a clone job lost to a
  manager restart mid-flight is re-triggered from the stored `awaitCloneOwner`.
- Capacity rides the heartbeat as **`capacity` = {maxSessions, running, queued, free, rootRunning}**
  (`_capacity_payload`) — it never used to reach the wire, which is what left the hub unable to tell a
  full host from an empty one and made a refused spawn look identical to a served one. `free` never
  goes negative (the cap can be lowered under a host already over it).
- Queued sessions are killable (Cancel) like any other — no worktree/tmux to tear down. resume-on-boot
  skips them (they stay queued and the drainer picks them up); archival/usage/PR scans skip them (no
  transcript to write). Surfaced on the heartbeat as `session.queuedReason`/`queuedAt`.
- **The queue applies to every spawn path; only TICKET spawns split across hosts.** An explicit
  "+ New session" is clicked on a specific host card, so it queues on THAT host — you named the
  machine. See "Splitting ticket sessions across an org's agents" under the hub.
- Tests: `TestSessionLifecycle` (`test_spawn_at_max_sessions_queues_instead_of_refusing`,
  `test_drain_queue_*`, `test_capacity_payload_*`) and `TestSpawnTicket`
  (`test_uncloned_repo_with_an_owner_clones_on_demand_and_queues`) in `agent/tests/test_hub_agent.py`;
  the Queued-section cases in `turma/tests/sessions.test.js`.

### Repos-root sessions

- Spawning against the repos-root pseudo-repo runs `claude` directly in `REPOS_ROOT` — spanning every
  repo — with **no worktree and no branch**, so the base-branch option doesn't apply and no worktree
  is ever added or removed for it. Kill/delete just tear down the processes; `REPOS_ROOT` and its
  repos are never touched.
- All root sessions share that one cwd (hence one claude project slug + Remote Control bridge
  pointer), so **at most one root session runs per host at a time** (enforced on spawn/start/resume).
- It's still killable/resumable like any session; its transcript persists under `REPOS_ROOT`'s
  project slug.
- Because they share it, that ONE project slug dir accumulates EVERY root session's transcript —
  which is what makes "this session's conversation" a real question here and a tautology everywhere
  else. See "Which transcript is a session's" below; a root session is the only thing that
  distinguishes the two rules, and it is why the pin exists at all.

### Which transcript is a session's

- Every launch **pins claude's session id** — `--session-id <uuid4>` minted in `_launch_tmux` for a
  fresh conversation, or the `--resume` id for a rejoined one — and persists it on the record as
  `claudeSessionId`. Claude Code names the transcript after that id, so a session's conversation is
  `<claudeSessionId>.jsonl` under its cwd's project slug, known by name from before its first byte.
- `_session_transcript_path()` is the one resolver every surface goes through (heartbeat signals +
  tail, `history`, subagent resolution, summary seeding, the closed record's `transcriptId`, and the
  `--resume` target), and the hub heartbeats the id so `tunnel-agent.js`'s live tail (`watch` →
  `sessionTranscript`, the mirrored JS copy) points at the same file.
- This **replaced a newest-mtime rule** ("whichever `*.jsonl` in the project dir was written last"),
  which is exact when the dir holds one session's transcripts — a worktree session, whose cwd is its
  own — and wrong for a root session, whose dir holds every root session ever run. There, the newest
  was the PREVIOUS root session's until the new claude wrote its first entry, so a fresh root session
  opened onto the last one's whole chat, was named from its first prompt, and on resume *relaunched
  it* (XERK-6).
- **A pinned session with no transcript on disk has not spoken, and resolves to nothing.** Never add a
  newest-mtime fallback for that case: falling back is the bug, and it reads as an empty conversation
  exactly once — before the first turn — which is the truth.
- A session launched by an agent predating the pin carries no id and keeps the newest-mtime rule,
  which is all it ever had; the payload likewise only pays for the stopped-only listdir for those.
- Naming the transcript means the hub must say when the name CHANGES: a watch is sent once (first
  watcher / control reconnect) and held for its lifetime, so `rearmMovedWatches` re-sends it when a
  watched session's heartbeat `transcriptId` moves. Only "Restart (clear context)" moves it, and
  without the re-arm that session's chat freezes on the pre-restart conversation — the agent keeps
  tailing a file nothing will write to again, and the `/history` poll that would correct it only runs
  while the socket is DOWN. The newest-mtime rule needed no such signal (it rolled over by itself),
  so this is the cost of the pin, not an accident of it.
- Still slug-keyed, and so still sharing one identity across a root session's neighbours: archival's
  running-session exclusion (`_running_slugs`) and the summary/date an archived or resumable
  transcript inherits (`_session_meta_by_slug`). Both are now fixable the same way, per transcript
  rather than per slug.
- Tests: `TestRootSessionIsolation` in `agent/tests/test_hub_agent.py` (which runs the real
  A-converses-ends-B-spawns sequence), the `sessionTranscript` cases in
  `agent/tests/tunnel-agent.test.js`, and the live-WS watch cases in `turma/tests/server.test.js`.

### Kill, resume, delete

- Sessions are spawned/killed/started/restarted/deleted from the hub.
- **Killing** a session removes it from the hub's ACTIVE list (registry record dropped) but KEEPS its
  worktree on disk (uncommitted work survives), its conversation, and its token-usage history.
  Transcripts live under `~/.claude/projects`, keyed by worktree path, separate from the worktree
  files.
- It is not gone from the UI, though: it moves to the Sessions page's **Ended sessions** list (see
  that page's bullet), from which it can be read and resumed.
- On the way out, `_remember_closed` **snapshots onto the closed record** the two things the live
  caches are about to forget — the `prUrls` this session opened, and its `transcriptId`. Both are
  keyed by session id in caches `_forget_session_caches` drops moments later, so the snapshot is the
  only thing that keeps an ended session's PR chips reachable. The PR *status* stays in
  `pr_status_cache` (`refresh_pr_status` counts closed records as referenced, so killing a session
  can't evict the state its ended card shows; it is not re-polled, same rule as a stopped session).
- The closed history is a **cache of what a kill knew, not the record that it happened**. It buys the
  PR links and the original session id (so `resume` hands it straight back), from the instant of the
  kill rather than a slow beat later. It is not the history: `closed.json` keeps only
  `CLOSED_PER_REPO` per repo, so the 6th kill in a repo evicts the oldest however durably it is
  stored. **Anything that must still be there afterwards belongs on the durable side** — the
  transcripts under the `~/.claude` mount (which `_resumable_report()` re-derives from, and which is
  what keeps a killed session in the hub's Ended list across a restart), the hub's own archive, and
  the ledgers `~/.turma` keeps beside it.
- **`~/.turma`'s durability is the HOST's to provide, and no code here may assume it.** A native
  install puts it in the invoking user's `$HOME`; a container must bind-mount it or it is the image's
  writable layer, which an agent update recreates. The deployed stack mounts it (DockerOps
  `compose/turma-truenas.yaml` → `/mnt/data/Docker/Turma-agent`), and the examples under
  `examples/compose/` declare their own volume — but that is a deployment promise, so every ledger in
  there still reconciles from disk rather than trusting itself. It went unmounted on the real stack
  for a long while, which silently reverted a board repo pin and a ticket's session list on every
  Watchtower image update.
- Each repo's **"Resume"** picker lists **every prior Claude session for the repo** whose origin cwd
  is resumable on this host — `repo.resumable` from `_resumable_report()`: killed/deleted/pruned
  Turma sessions, repo-dir "terminal"/dev runs on the host, and older ones aged out of
  `~/.turma/closed.json`, not just the last-5 killed.
- Resuming relaunches `claude --resume <transcript id>` **cwd'd at that transcript's own origin
  path**, re-creating a deleted/pruned worktree at the exact path first: Claude scopes id lookup to a
  repo's *live* git worktrees + repo dir, so the origin must exist for `--resume` to resolve
  (`resume_transcript`).
- A dev-machine session synced through the shared `~/.claude` has a foreign cwd and stays view-only,
  resumable only where it ran.
- **Delete** (on an already-stopped session) additionally removes the worktree. Since the app owns no
  branch, any branch the agent committed to survives untouched in the repo, so only uncommitted
  worktree files are lost.

## Repository Structure

Top level: `agent/`, `turma/`, `glasses/`, `android/`, `.github/workflows/`. Each is detailed below.

## `agent/` — per-host headless agent image

Currently Claude Code; the name is agent-generic so it can host other agents later.

### `hub-agent.py` — session manager and heartbeat in one process

- Scans `REPOS_ROOT` for repos.
- Owns a persisted session registry (`~/.turma/sessions.json`).
- Executes hub-issued commands that ride back on the heartbeat reply (at-least-once, with `cmdId`
  de-dup) — see "Commands" below.
- Drives each session's worktree + tmux + ttyd.
- Heartbeats the repo list, one record per session, and a container-log tail — see "Heartbeat" below.
- On boot it auto-resumes sessions that were `running`.
  - `resume_on_boot` **adopts** a session whose claude tmux is still alive (tmux/ttyd are their own
    daemons, so they outlive a restart of just this manager) — it skips the relaunch and only
    re-ensures the ttyd, leaving the running claude (mid-turn included) untouched. This is what lets
    the native agent update itself in place without stopping sessions. It falls back to the old
    `--resume` relaunch only when the tmux is gone (container restart, reboot, crash).
  - ttyd is adopted by port when our persisted `ttydPid` is still alive; `_kill_ttyd` reaps that pid
    so an adopted ttyd isn't leaked on stop/delete.
  - Tests: `TestResumeOnBootAdopt`.

### Commands

- `spawn` / `kill` / `start` / `restart` / `delete` — session lifecycle.
- `resume` — resume a killed session (keeps its id).
- `resumeTranscript` — resume ANY prior transcript by id; see the resume notes in the Session model
  above. `_resumable_report()` heartbeats each repo's resumable list.
  - Tests: `TestResumableReport`, `TestResumeTranscript`, `TestTranscriptCwd`.
- `input` / `history` / `answerQuestion` — for the glasses client.
  - `input`/`send_input` types the message into the session's tmux pane, and **guarantees it survives
    a compaction** (XERK-47). A message the operator sends is queued by Claude Code when a turn is in
    flight; an auto-compaction (context ~95%) can drop that queued message — or one typed as it began —
    instead of consuming it, so it never becomes a user turn and silently vanishes. `send_input`
    records every sent message on the session record's `pendingInputs` outbox, and `_poll_pending_inputs`
    (every beat, a no-op unless a session has an outbox) gives it an at-least-once guarantee:
    - a compaction is detected authoritatively from the transcript's own `compact_boundary` **system
      entry** (written when a compaction completes; `compactMetadata.trigger` = auto/manual) counted by
      `_pending_scan`, NOT by scraping the pane for an undocumented "Compacting…" string;
    - a message is **reaped on delivery** — once it appears as a genuine user turn (`_pending_scan`'s
      `delivered`), or **left in flight** while it's still in the folded live queue (`queued`);
    - it is **re-sent** only when a NEW compaction has happened since it was sent (`compactBase` count
      rose) AND it's neither delivered nor queued AND the pane has settled to idle (`_pane_busy` False,
      not None) — the pane-idle + not-queued gate is what makes the resend **duplicate-safe** (if the
      queue survived the compaction the message is still queued, so it waits rather than double-sending);
    - bounded: `PENDING_INPUT_MAX_ATTEMPTS` resends (each needing a fresh compaction), one resend per
      beat, and an entry that never lands and never sees a compaction ages out at `PENDING_INPUT_TTL_SEC`.
    - `delivered` matches by text with no timestamp/offset filter, biased AGAINST a resend: re-sending
      the exact text of an older turn reads as already-delivered (a missed resend, never a duplicate).
    - The outbox is internal (not on the heartbeat payload) and is cleared on restart-clear-context (a
      pre-restart message is contextually gone with the old conversation). The raw ttyd terminal bypasses
      `send_input`, so a message typed straight into it isn't covered — the compose-box/glasses path is.
    - Tests: `TestPendingScan`, `TestPollPendingInputs`, and the outbox cases in `TestSendInput`.
- `interrupt` — stop the turn a running session has in flight.
  - `interrupt()` sends a single Escape to its tmux pane, exactly the key an operator at the live
    terminal would press, so claude cancels the current generation/tool call and drops back to its
    prompt with the session and conversation intact.
  - The gentle counterpart to kill/restart. Deliberately NOT gated on `paneBusy`, whose read is up to
    a beat stale by the time the operator clicks, while Escape into an idle pane is harmless.
  - Tests: `TestInterrupt`.
- `setSummary` — rename a session; see "Session activity summaries" under Conventions.
- `setModel` — switch a running session's model live, **for that session only** (XERK-33).
  - `set_model` drives Claude Code's /model picker — clear the input line (C-u), open it, parse its
    rows + ❯ cursor from a pane capture (`parse_model_picker`), arrow to the target, press `s`
    ("use this session only") — instead of typing `/model <name>`: the argument form ALSO saves the
    pick as the login-wide default for new sessions, and every session on a host shares that one
    login, so switching one session silently changed what "Default" meant everywhere.
  - Gated on a **fresh** pane-busy read (unlike `interrupt`, this types into the pane, and typed
    mid-turn the command would only queue as a prompt); refused log-only when busy.
  - Backs out with Escape when the picker doesn't appear or has no row for the target (the
    bracketed `[1m]` aliases have none). Either way the transcript's own confirmation — not the
    stored intent — is what the chip renders, via `modelActual` below.
  - Validation is `resolve_model` against the static aliases plus the probed available list.
  - Tests: `TestSetModelMode`, `TestParseModelPicker` in `agent/tests/test_hub_agent.py`.
- `clone` — see "GitHub block and cloning" below.
- `refreshJira` — the /board page's manual refresh: re-poll Jira now instead of waiting out the slow
  `JIRA_REFRESH_EVERY` cadence. Re-checks `jira_configured()`, so an unconfigured host stays at zero
  Jira calls even if commanded.
- `prune` — per-repo cleanup: removes worktrees whose commits are merged into the latest default
  branch (skipping any still backing a session or holding uncommitted changes), then deletes local
  branches merged into it, reporting a summary that rides the heartbeat.
- `jiraIssue` — fetch one issue on demand; see "Jira block" below.
- `spawnTicket` — start a session to WORK a Jira ticket; see "Jira ticket sessions" below.
- `setJiraRepo` — the operator's own repo for a ticket, overriding the guess; see "Manual repo
  override" below.
- `subagentHistory` — open a background subagent's own transcript; see "Live working footer and agent
  list" below.

### Heartbeat

- **Repo list**, ordered most-recently-active first: each repo's `lastActivity` is the later of its
  newest commit and its newest session activity. The repos-root pseudo-repo is pinned first and never
  ranked.
- **One record per session**: git state, per-session token usage, live-session signals (below), new
  PR links, and PR status (below).
- A **container-log tail**.
- The build's **own version** (`agentVersion`, shown in the dashboard's host header): `agent_version()`
  reads the `TURMA_AGENT_VERSION` the image bakes at build time (release.yml passes the release
  version as a build-arg), else the `VERSION` file `native/install.sh` stamps beside `hub-agent.py`,
  else the repo-root `VERSION` for a dev checkout — and reports `null` rather than a guess when
  nothing stamped it. Tests: `TestAgentVersion`.
- The **coding agent** it runs for its sessions (`codingAgent` = `{name, version}`, the dashboard host
  header's "Agent" row; the build's own version sits beside it as "Turma"): `coding_agent()` splits
  `claude --version`'s `"<version> (<product>)"` reply, preferring the product name it names over the
  `CODING_AGENT_NAME` default, so the name stays right if the product renames itself.
  - The NAME is reported rather than left for the hub to assume, because the image is agent-generic
    (Claude Code today, another CLI later) and only the agent knows which one it execs.
  - The raw string still rides as `claudeVersion` for hubs predating the field — the two update
    independently, so a new agent must not blank an old hub's header. The hub parses that legacy
    string the same way (`codingAgent()` in `index.html`), which is what stops it rendering as
    "Claude Code 2.1.211 (Claude Code)" under a label that already said Claude Code.
  - Tests: `TestCodingAgent`, `turma/tests/host-header.test.js`.
- The **login's real model list** (`models` = `{available, defaultLabel, at}`, XERK-33), probed from
  the CLI itself: `claude -p "/model"` prints "Current model: <label>" plus the account's whole
  alias list, which `parse_model_probe` parses — so the hub's model menus offer what this login can
  actually run, and "Default" can say what it resolves to, with no rate-table-style config to drift.
  - The probe is a detached one-shot on the models cadence (`MODELS_REFRESH_EVERY`, beat 0 covering
    boot; `MODELS_RETRY_EVERY` until the first success), same shape as the summary/triage helpers:
    cwd=REGISTRY_DIR, no --settings, reaped by `_poll_models_probe` with a kill-on-timeout.
  - A failed or unparseable probe **keeps the previous list** — an attempt's failure is never
    evidence the login lost models. `None` until the first success; the hub falls back to its
    static menu then (and for agents predating the field).
  - `resolve_model(model, extra)` accepts the probed aliases beyond the static four, still
    charset-checked (`SPAWN_MODEL_RE` — the bracketed `[1m]` variants never reach a launch command
    line, where the brackets are a shell glob).
  - `modelActual` on each session record is the probe's per-session counterpart: the incremental
    transcript scan (`_scan_entry_line` — ONE json parse feeding both the PR scan and
    `_scan_model_entry`) folds each assistant entry's `message.model` and the "Set model to X"
    stdout a live /model switch writes, so the heartbeat names the model REALLY answering, id or
    label, newest signal winning. Persisted; seeded once from the transcript tail for records
    predating the field (`_seed_model_actual`).
  - Tests: `TestParseModelProbe`, `TestModelsProbe`, `TestScanModelEntry`,
    `TestSessionReportModelActual`, `TestSeedModelActual`, `TestModelActualPayload`, and the
    model-probe cases in `TestInternalToolSlugModelProbe`.

#### Live-session signals

- `paneBusy` — a working/idle read, and the **primary** activity signal.
  - `_pane_busy` captures the session's tmux pane and looks for Claude Code's "esc to interrupt"
    hint, which the TUI shows for exactly as long as the model is actively generating or running a
    tool, and which drops the instant the turn ends. So it stays accurate through a long silent tool
    call and flips idle immediately, unlike the transcript-mtime window.
  - `true`/`false`/`null`-unknown; marker set overridable via `TURMA_PANE_BUSY_MARKERS`.
  - All three surfaces fall back to transcript freshness only when it's `null` — i.e. an older agent,
    or an uncapturable/gone pane.
  - **Busy→idle flicker is suppressed at the source** (`_stable_pane_busy`, XERK-42): the TUI
    repaints its spinner by clearing+rewriting the "esc to interrupt" line, so a single capture can
    land in that sub-frame gap and read idle while the model is still working — and since paneBusy is
    sampled once per `TURMA_INTERVAL` (20s) beat, that one miss shows the session idle for a whole
    interval on EVERY status surface and fires a bogus "finished its turn" push. So a busy read is
    trusted instantly (status lights up promptly; nothing fakes busy while idle) while an idle read
    is re-confirmed once, after `TURMA_PANE_IDLE_CONFIRM_SEC` (0.2s, 0 disables), only on the
    busy→idle EDGE — a genuinely ended turn confirms in a frame, a redraw gap doesn't. The last
    stable read rides the per-session `sess_state`; `None` (capture failed) passes through untouched.
    Stabilizing the SOURCE is why every component (fleet dots, cards, glasses glyph, Android list,
    the hub's turn-finished alert) gets the fix with no client-render change. The live-footer scrape
    guards its own copy of this with a one-poll hold (`liveTurnDecision` in `tunnel-agent.js`; see the
    Live working footer bullet). Tests: `TestStablePaneBusy` in `agent/tests/test_hub_agent.py`.
- **Transcript freshness** — now the fallback, not the primary signal.
- **Pending questions** — a pending `AskUserQuestion` is surfaced by the `agent/hooks/ask.py`
  PreToolUse bridge (see the Safety guard note under Conventions), which drops a
  `<sessionId>.req.json` under `~/.turma/questions/` while the tool call blocks. `session_report`
  reads it from there and the answer rides back as `<sessionId>.ans.json`, so there is no tmux-pane
  scraping. A transcript scan is a fallback for the already-answered case.

#### PR status

- The state (Open/Draft/Merged/Closed), CI-check rollup (passing/failing/pending), and GitHub's own
  mergeability (`mergeable`: MERGEABLE/CONFLICTING/UNKNOWN) of every PR a session opened.
- Fetched via `gh pr view` (`pr_status`/`_summarize_pr`/`_check_class`) on the
  `PR_STATUS_REFRESH_EVERY` cadence — faster than the github block, so a card's merge/CI state stays
  live.
- The card's **single ✓/✗/● mark is merge READINESS, not CI** (`ready`, from `_merge_ready`): green
  CI is only half of "can this land", and a PR whose branch conflicts with its base merges nowhere
  however clean its checks are. So a conflict blocks on its own, and a ✓ requires GitHub to have
  affirmatively said MERGEABLE — mergeability is computed lazily server-side, so the UNKNOWN a
  just-opened PR reports is `pending` (unproven ≠ proven) and resolves on the next refresh.
  - Conflicts are only asked about while a PR could still land: a MERGED/CLOSED one reports CI alone.
    A PR with **no checks at all** keeps its no-mark unless it CONFLICTS — absent CI is not evidence
    of anything, but a conflict is, which is what keeps a no-CI repo from painting a false green.
  - `checks`/`checkCounts` stay pure CI beside it (their name, their meaning), so the chip's tooltip
    can say WHY it's blocked rather than only that it is. All four renderers (`index.html`,
    `sessions.html`, `chat.js`, android's `PrBadge`) read `ready` and fall back to the CI half when an
    agent predating the field reports none.
  - Tests: `TestPrStatus` (the readiness cases) in `agent/tests/test_hub_agent.py`, plus the
    `prFooterChip` cases in `turma/tests/chat.test.js`.
- Cached by URL in `pr_status_cache` and attached as `session.prs`; kept even after the session
  stops, and None until it opens a PR.
- **The link set is durable across an agent restart** (XERK-15): a running session mirrors its
  `session_pr_urls` onto its own registry record (`sess["prUrls"]`, saved as it grows in
  `_session_payload`) and rehydrates the in-memory map from there on boot — the same durability a
  killed session's PRs get off `closed.json`. Without it a restart blanked a running card's chips
  (the map starts empty and the transcript scan primes to EOF, so it never replays old links) until
  the session happened to open another PR. Tests: `test_prs_survive_agent_restart` in
  `TestRefreshPrStatus`.
- **XERK-13 extends that durability to ENDED sessions and to the status pill**, keyed by transcript
  id so it outlives the registry/closed record the XERK-15 mirror rides on. Two durable ledgers
  beside the ticket one:
  - `pr-sessions.json` (`PR_LEDGER_PATH`, `transcriptId -> {urls, at}`): written whenever the scan
    finds a URL (`_remember_prs` from `_session_payload`, and on kill from `_remember_closed`) and
    backfilled from closed history. Its consumer is the **resumable scan** — the ONLY channel still
    reporting a session once its closed record ages out of `closed.json` past `CLOSED_PER_REPO`, and
    it carries no PRs of its own — which now attaches `prs` from the ledger (`_ledger_prs`), exactly
    as it attaches `ticket`. `resumableSession` in `sessions.html` carries them onto the Ended-list
    row; a live closed record still wins the dedupe and shows its own re-polled status. On boot the
    ledger also `setdefault`-backfills `session_pr_urls` for any live session the XERK-15 rehydration
    missed (a pre-mirror registry record) — XERK-15's copy stays authoritative where it has one.
  - `pr-status.json` (`PR_STATUS_LEDGER_PATH`, `url -> status`): `refresh_pr_status` persists the
    status cache and `pr_status_cache` seeds from it at boot. XERK-15 left the cache re-derived (bare
    link, then a status poll refills it) — fine for a RUNNING session, but an ended one is never
    re-polled, so without this its chip degrades to a bare link on restart for good. Ledgered URLs
    count as `referenced` in the refresh so an aged-out session's status isn't evicted.
  - Tests: `TestPrLedger` in `agent/tests/test_hub_agent.py` (incl. a scan→restart end-to-end), the
    `carries_the_prs` case in `TestResumableReport`, and the resumable-PR-chip case in
    `turma/tests/sessions.test.js`.
- **Which PRs are "a session's"** is decided by `_scan_pr_line`, and the rule is deliberately narrow:
  a URL counts only when it comes back in a **`gh pr create` call's own `tool_result`** — the one
  event in a transcript that says this session OPENED that PR.
  - The scan used to regex any `…/pull/<n>` URL out of the appended transcript bytes, which also
    caught every PR a session merely READ — `gh pr list`/`view`/`checks` output, a link the operator
    pasted, the model quoting another session's PR — and hung a chip (and fired a "created a PR"
    alert) on a card for work that session never did. Replayed over the 127 real transcripts on the
    dev box, the narrow rule kept all 50 real links and dropped 43 false ones.
  - The call and its result are separate entries and routinely land in different beats, so the
    pending `gh pr create` tool_use ids carry across beats in the session's scan state (capped).
  - The scan therefore parses whole JSONL lines rather than raw bytes: the byte offset stops at the
    last newline, so a half-written entry is re-read whole next beat instead of being lost.
  - Cost of the narrowness: a PR opened some other way (a subagent's own transcript, an MCP GitHub
    tool, the web UI) gets no chip. Widen by teaching `_scan_pr_line` another creation event — never
    by going back to scanning loose text.
- Tests: `agent/tests/test_hub_agent.py` (`TestPrStatus`, `TestRefreshPrStatus`, `TestSessionReport`).

### Expected-restart "updating" status (XERK-29)

- An agent update takes the host down in a way a plain outage can't be told from: the container is
  recreated (or the native manager restarted), heartbeats stop, and the dashboard greyed the host to
  `offline` while its sessions read "terminal offline" — indistinguishable from a crash.
- So the manager **announces an EXPECTED restart before it goes silent**: its SIGTERM/SIGINT handler
  (`_handle_shutdown`) POSTs `POST /api/agents/<host>/updating` (`_announce_updating`, agent-token
  authed, best-effort with a short timeout — it's the shutdown path and must not block the exit).
- One signal covers both update paths, because both restart via a SIGTERM to the manager: a container
  recreate on a Watchtower image update (SIGTERM to PID 1), and the native updater's
  `systemctl restart` (SIGTERM to the manager, sessions kept alive by `KillMode=process`).
- The native updater additionally leaves `~/.turma/updating.json` (`UPDATING_FLAG_PATH`, reason +
  target version) just before it restarts; the SIGTERM handler reads it to enrich the announcement
  with the version (`reason:"update"`). A container update leaves no file, so it announces a generic
  `reason:"restart"`. The next boot clears any stale flag (a SIGKILL that skipped the handler).
- Hub-side, the announce sets `a.updating = {at, until, reason, version}` with a `UPDATING_GRACE_MS`
  (5 min) deadline. `serializeAgent` surfaces `updating` **only while the host is actually silent**
  (`!online`) and **within the grace window** — a returned host is just `online` again (its heartbeat
  rebuilds the record without the flag), and a stuck update falls through to `offline` past `until`.
- The offline sweep suppresses the "host offline" alert while `updating` holds, so an expected restart
  doesn't page; a genuinely stuck update still alerts once the window lapses.
- The dashboard renders `updating` as a distinct amber state (`agentState`/`hostCard`): not the greyed
  `offline` look, an "expected brief downtime" tooltip, and no "Remove host" affordance. The status is
  purely a hub-render of the agent's signal; no client acts on it beyond display. Android/glasses
  predate the field and keep showing `offline` — a cosmetic gap, not a regression.
- Tests: `TestUpdatingAnnounce` in `agent/tests/test_hub_agent.py`, the updating-hint case in
  `agent/tests/test_turma_agent_update.sh`, and the `/updating` case in `turma/tests/server.test.js`.

### Usage aggregates and the attribution ledger

- The heartbeat carries **persistent usage aggregates independent of the live registry**: a per-repo
  `repoUsage[]` and a merged host-level `usage`, computed on the slow usage cadence by re-parsing
  *every* known transcript under `~/.claude/projects` (`repo_usage_report()`).
- Each `repoUsage` entry carries a `remoteKey` (normalized git origin via `normalize_remote()`) so
  the hub can unify the same repo across hosts.
- A durable worktree→{repo, remote, slug} **attribution ledger** (`~/.turma/repo-usage.json`) is what
  keeps a transcript traceable to its repo after its session — and even its worktree — is gone, so
  **usage history survives kill/delete/prune** rather than vanishing with the session card. It is:
  - written at spawn via `_remember_usage`,
  - backfilled from the registry/closed history,
  - reconciled against the transcripts actually on disk each usage beat by
    `_reconcile_orphan_transcripts()`,
  - and pruned only when a transcript dir disappears.
- Because `repo_usage_report()` only folds slugs the ledger names, that reconciliation is what makes
  "every known transcript" mean *every transcript sitting in `~/.claude/projects`*, rather than only
  the sessions still in the live registry or the last-5 closed history.
- Any orphan (a session that aged out of `closed.json`, or one predating `_remember_usage`) is
  adopted with best-effort attribution, in order:
  1. exact repo + git origin, when its worktree still exists;
  2. else the repo recovered from the worktree-shaped project slug (which also names sibling-tool
     sessions);
  3. else the repo read from the transcript's own recorded `cwd` (`_repo_from_transcript_cwd` —
     Claude Code stamps the real, un-slugified working dir on entries, so its final path segment
     names the repo, including the operator's own dev-machine sessions synced through the shared
     `~/.claude` login);
  4. else bucketed under `OTHER_REPO_NAME` (`(other)`), only when no `cwd` is recorded.
- **No real session is excluded** — every session transcript on the box counts toward the host total.
- **The one carve-out is the manager's OWN internal `claude -p` helpers** (session naming, Jira
  triage, and the models probe), which run with `cwd=REGISTRY_DIR` yet still write a transcript into the shared
  `~/.claude/projects` — so the reconciler used to adopt the agent's own overhead as a phantom repo on
  the usage page: `.turma` (from `/root/.turma`) in production, and a cluster of `hub-agent-mgr-*`
  entries when a test/verify harness boots the manager against a `mkdtemp` `REGISTRY_DIR` (XERK-27).
  `_is_internal_tool_slug` recognizes them — by the registry dir's own slug (no transcript read,
  catches production) or, for a harness's foreign temp slug, by the `INTERNAL_TOOL_PROMPT_SIGS`
  signature of the transcript's first prompt (path- and process-independent). The models probe's
  prompt IS a slash command, which `_first_user_text` skips, so its transcript is recognized by its
  first command instead (`_first_command_name` = `/model`, only when no genuine user text exists —
  see the models-probe bullet). Such a slug is
  **tombstoned** in the ledger (`{internal:true}`), which `repo_usage_report` and `_archive_manifest`
  skip, so it never re-evaluates and never surfaces on usage OR in the archive.
  `_sanitize_internal_tool_entries` retires entries earlier builds already adopted; a real coding
  session at a repo cwd is untouched, and a genuine ad-hoc run (e.g. an operator's `claude` in
  `/root`) still counts as itself.
- **This ledger is also the archive's input** (`_archive_manifest` enumerates ledger slugs), so
  reconciliation *intentionally* widens archival too: every ended session on the box, including
  synced dev-machine history, is shipped to and full-text-indexed in the hub's durable archive, not
  just Turma-managed ones. That coupling is deliberate (total history + search); decouple the two
  inputs only if archival scope should ever diverge from usage scope.
- Tests: `agent/tests/test_hub_agent.py` (`TestReconcileOrphanTranscripts`, including the
  internal-tool tombstone/signature/sanitize cases).

### Jira block

- Optional. With user-scoped Jira Cloud creds in its env (`JIRA_SITE`/`JIRA_EMAIL`/`JIRA_TOKEN`), the
  agent heartbeats the tickets assigned to that user, polled on a slow cadence (`collect_jira`:
  active work plus a bounded window of recently-Done, two capped queries) and shaped to the compact
  card fields the hub's /board renders (`_shape_issue`).
- Unset creds = feature off (zero Jira HTTP, `available:False`).
- Read-only by construction — the only endpoints ever called are issue search and issue GET.
- **On-demand issue detail.** Description and comment bodies are far too big to heartbeat for every
  ticket, so the board's expanded ticket view fetches one issue on demand:
  - A `{type:"jiraIssue", issueKey}` command (allowlist-checked against Jira's `PROJECT-123` key
    grammar before it reaches a URL) makes `_stage_jira_issue` call `fetch_jira_issue`.
  - The result rides the next beat as `jiraIssueResults` — the same {command → staged result → next
    beat} path as session `history`, and poked, so a click resolves in about a round-trip rather than
    a whole `INTERVAL`.
- **ADF flattening.** Jira returns rich text as ADF (Atlassian Document Format — a nested node tree,
  not HTML/markdown), which `adf_text`/`adf_plain` flatten to plain text agent-side rather than
  shipping the tree for the browser to re-walk.
- `_shape_issue_detail` adds description, the newest `JIRA_COMMENT_MAX` comments (+ `commentTotal`,
  so the UI can say what it dropped), people, and full labels, each capped.
- Every failure path (bad key, unconfigured host, HTTP error) stages a result carrying an `error`
  instead of raising — the board is waiting on that key.
- Tests: `agent/tests/test_hub_agent.py` (`TestAdfText`, `TestShapeIssueDetail`, `TestFetchJiraIssue`,
  `TestStageJiraIssue`).

### Azure DevOps block (XERK-43) — the board's second source

- **The board is source-agnostic; Azure DevOps is a drop-in second source that emits the SAME wire
  contract as Jira.** With a PAT in the env (`AZDO_URL` + `AZDO_TOKEN`, optional
  `AZDO_PROJECT`/`AZDO_USER`/`AZDO_API_VERSION`) the agent polls the work items assigned to that PAT's
  owner and reports them in the very same `jira` heartbeat block, ticket shape and detail shape — so
  the hub, `board.js`, `index.html`, and the Android/glasses clients render an Azure org exactly like a
  Jira one with (almost) no changes on their side. `source:"jira"|"azure"` rides the block for the few
  places that vary UI copy.
- **An agent serves exactly ONE org**, so a host is a Jira host or an Azure host, never both.
  `board_source()`/`board_configured()`/`collect_board()`/`fetch_board_issue()`/`board_site_key()`/
  `valid_issue_key()` are the source-dispatch shims that replaced the bare `jira_configured()` gates;
  everything downstream (triage, `spawn_ticket`, `set_jira_repo`, the heartbeat block, PR/session
  machinery) is source-agnostic and reads `self.jira` unchanged.
- **Self-hosted is the point.** `AZDO_URL` is any base — `https://tfs.company.com/DefaultCollection`
  (Azure DevOps Server / TFS) or `https://dev.azure.com/org` (Services) — the same REST surface. PAT
  auth is Basic with an empty username (`:PAT`). Read-only: only WIQL search + work-item GET.
- **siteKey keeps the org/collection PATH** (`normalize_azure_site` → `dev.azure.com/myorg`), unlike
  the Jira host-only key, because the host alone would merge every unrelated cloud org into one board.
  It's percent-encoded into the `/api/jira/<siteKey>/...` routes (client `encodeURIComponent`, hub
  `decodeURIComponent`), so a slash in the key is transparent. `board.js`/`Board.kt` `orgName` now
  takes the last path segment for a slashed key (org display), else strips `.atlassian.net`.
- **Work-item ids are bare integers**, so `AZDO_KEY_RE`/`valid_issue_key` and the hub's `isIssueKey`
  accept `^[0-9]+$` alongside Jira's `PROJECT-123`. Ticket sessions get a human-scannable branch base
  `<project>-<id>` (`ticket_branch_base`), not a bare number.
- **State → column.** Azure's per-type state metadata (`stateCategory` metastate) is read from the
  states API when reachable (`_azure_state_map`, cached per project+type — handles custom processes),
  falling back to a static name map, then `todo` — mapping to the board's todo/inprogress/done exactly
  as Jira's `statusCategory` does. The raw state name still rides as `status`, so the board's In Review
  column (name-matched) catches Azure review states unchanged.
- **HTML, not ADF.** `collect_azure` (WIQL → batch work-items GET) and `fetch_azure_issue` (work item
  `$expand=all` + the comments endpoint) mirror `collect_jira`/`fetch_jira_issue`; the ADF flattener's
  counterpart is `azure_html_to_text`/`azure_plain` (a stdlib `HTMLParser` pass). A comments-endpoint
  failure degrades to no comments rather than losing the detail.
- Tests: `agent/tests/test_hub_agent.py` (`TestNormalizeAzureSite`, `TestAzureBase`, `TestCollectAzure`,
  `TestShapeAzureItem`, `TestAzureCategory`, `TestAzureHtmlToText`, `TestFetchAzureIssue`,
  `TestBoardSourceDispatch`, plus the Azure cases in `TestSpawnTicket`); the numeric-issue-key cases in
  `turma/tests/server.test.js`; the `orgName` Azure cases in `turma/tests/board.test.js` and
  `android/.../BoardTest.kt`.

### Jira repo triage (`repoGuess`)

- Each heartbeated ticket carries an optional **`repoGuess`** — which repo that ticket's work belongs
  in.
- Decided **agent-side** by the container's already-authenticated `claude` in headless print mode
  (`claude -p`, Haiku by default), reusing the same mounted login (and the same
  detached-subprocess/reap-on-later-beats shape) as the session summaries, so there is **no external
  API, key, or cost env**.
- It runs on the agent rather than the hub because this host is the only place the three inputs meet —
  the Jira creds (hence the tickets), the scanned repos, and the `gh` sweep. That colocation *is* the
  "same org" rule: only the host holding an org's Jira creds ever classifies that org's tickets, so a
  ticket can only be matched to a repo that host can reach.
- `_triage_candidates()` builds the choice list as the host's cloned repos (marked `[cloned]`, which
  the prompt tells the model to prefer) **plus every repo its `gh` login can clone**, so an un-cloned
  org repo is still selectable.
- The reply is **allowlist-validated back against that list** by `_parse_triage` (a hallucinated repo
  name is dropped to "no repo", never rendered). The guess is purely presentational — nothing acts on
  it, and no ticket text reaches a shell (argv list), a path, or a URL.

#### The triage ledger

- Decisions are cached in a persisted ledger (`~/.turma/jira-repos.json`, keyed
  `<siteKey>/<issueKey>`) so triage runs **once per ticket, not per beat**.
- Each entry holds two independent things, and **keeping them apart is what makes the cache safe**:
  - the **decision** — repo/cloned/reason/`at`, plus the `ticketFp`/`candFp` recording the question it
    *answers*;
  - the **attempt run** — `attempts`/`retryAt`, plus `tryTicketFp`/`tryCandFp` recording the question
    currently being *asked*.
- `_triage_stale()` marks a decision for re-triage when the ticket's own text changes
  (`_ticket_fingerprint` — deliberately NOT `updated`, which moves on any field edit) or the
  candidate set does (`_candidates_fingerprint` — repo names + cloned-ness ONLY; the gh block's
  `updatedAt`/`description` churn on their own cadence, and `_triage_candidates` sorts the gh tail by
  name before truncating so that an `updatedAt`-ordered cut can't make the surviving name set move
  either).
- Cloning a repo *does* re-triage, so a newly-cloned repo can win a ticket it fits better.
- A **manual pin** (see "Manual repo override" below) is the exception to all of it: `_triage_due`
  skips it, so it is never re-triaged and never spends an attempt.
- Two rules follow from the split and are worth not undoing:
  - **Stale means "re-triage this", never "stop showing it"** — the old answer keeps rendering until a
    replacement lands, because a whole-board invalidation (one clone, one gh sweep) would otherwise
    blank every chip at once.
  - **`attempts` is scoped to the question, not the ticket's lifetime** — a changed ticket or
    candidate set gets a fresh budget, since a lifetime counter would let three invalidations spread
    over months permanently ban a ticket from ever being re-triaged, freezing a now-wrong chip
    forever.

#### Triage scheduling and failure handling

- `_start_jira_triage` only updates its candidate repos from a **successful** gh sweep
  (`self.triage_gh_repos`): `refresh_github` blanks the block to `repos:[]` on any error, which on
  that field alone is indistinguishable from "the org has no repos", and triaging against it would
  restale every ticket and re-run the whole board through the model twice — once when gh stumbles and
  again when it recovers.
- Work is batched (`JIRA_TRIAGE_BATCH` tickets per call, **one job in flight at a time** — a backlog
  trickles out a batch per beat rather than forking N models against the one shared login).
- It is attempted every beat rather than on the slow Jira cadence, so a freshly-polled board
  classifies in minutes instead of an hour of 10-minute beats; a settled board costs one fingerprint
  check.
- Failed attempts are **bounded-retry with backoff** (`JIRA_TRIAGE_MAX_ATTEMPTS`/
  `JIRA_TRIAGE_BACKOFF_SEC`, armed up-front so a manager restart mid-batch neither loops nor loses
  the retries owed) for the same reason the summaries are: an unusable reply is a property of the
  attempt, not the ticket.
- `_parse_triage` draws a sharp line between the model's two kinds of non-answer:
  - an **explicit `null`** is a verdict (it was asked for) and becomes `repoGuess.repo = null` ("no
    repo fits");
  - anything **unreadable** — a value shape it can't parse, or a repo name that isn't on the
    candidate list (off-list is definitionally invented) — is a **failed attempt** whose key is
    omitted, leaving the ticket undecided for the retry.
  - Conflating those is the trap: recording a garbled reply as "no repo fits" would paint a confident
    chip asserting something the model never said and, since decisions are never re-triaged, leave it
    there for good.
- A ticket not yet triaged carries **no `repoGuess` at all**, which the board renders as no chip
  (absence ≠ "no repo fits").
- `_apply_triage()` re-stamps the ledger onto the tickets after every poll and every merge
  (`collect_jira` builds fresh dicts, so without it the chips would blank on each slow beat).
- Tuned only by `JIRA_TRIAGE_MODEL` (default `haiku`) / `JIRA_TRIAGE_TIMEOUT_SEC`.
- Tests: `agent/tests/test_hub_agent.py` (`TestTriageCandidates`, `TestTriageFingerprints`,
  `TestParseTriage`, `TestJiraTriage`).

#### Manual repo override

- The operator can **set a ticket's repo by hand** from the board's ticket detail panel, overriding
  the guess: `setJiraRepo` → `set_jira_repo()`, which writes a ledger entry flagged `manual`.
- It takes the same posture against the model that a hand-typed session rename takes against the
  auto-summarizer, and for the same reason — a human's answer is the better one, so nothing may
  quietly overwrite it:
  - `_triage_due` skips a manual entry entirely (never re-triaged, no attempt spent), which is what
    makes the pin a pin;
  - `_finish_jira_triage` drops a reply for a ticket pinned while its batch was in flight — that
    batch was built before the override existed, so it answers a question no longer being asked;
  - `_prune_triage_ledger` evicts manual entries last: an auto decision it drops is recomputed next
    beat, but a pin is the one thing in the ledger that cannot be regenerated.
- Three answers, deliberately distinct — the middle one is the whole reason `auto` is a separate
  field rather than an absent `repo`:
  - `{repo:"<name>"}` pins that repo;
  - `{repo:null}` is a manual **"no repo fits"** — an assertion, and a decision;
  - `{auto:true}` **releases** the pin (drops the entry), so the ticket re-triages from scratch with
    a **fresh** attempt budget. Reusing a spent budget could leave a released ticket permanently
    unguessed.
- **Un-cloned repos are offerable**, not just cloned ones: a ticket can belong to a repo this host
  hasn't cloned, and saying so is a real answer (the board renders it dashed, as it does an un-cloned
  guess).
- The name is **allowlist-checked host-side against that host's own candidates**, exactly like the
  model's reply, and the stored repo/cloned/`nameWithOwner` are read off the **candidate**, never off
  the request. The operator is likelier right than the model, but the request still arrives over
  HTTP, and a name this host can't offer is one its own picker never showed.
- The candidate list is heartbeated as **`jira.repoOptions`** (`_jira_payload`, names + clone state
  only — the descriptions would be dead weight every beat). It is deliberately **one list serving
  both** the model's prompt and the board's picker, via `_refresh_triage_candidates`: the picker
  exists to offer exactly what `set_jira_repo` accepts, so the two must not drift.
- `_apply_triage` re-reads clone state from the **current** candidates rather than trusting what the
  decision recorded. Cloning a repo re-triages an auto guess (its `candFp` moves) but a pin never
  re-triages, so a stored `cloned:false` would outlive the clone forever and leave the chip dashed
  for good. A repo absent from the list right now keeps its stored state — the list blanks on a
  failed gh sweep, and absence there isn't evidence a repo stopped being cloned.
- `POST /api/jira/<siteKey>/<issueKey>/repo` **fans out to every host reporting that org** — including
  OFFLINE ones, unlike `POST /api/jira/refresh`. The ledger is per-host while the board merges hosts
  by `siteKey` (freshest block wins), so a host that misses the pin comes back reporting the model's
  old guess and can silently revert it. Commands are queued and at-least-once and `set_jira_repo` is
  idempotent, so landing late beats never landing. The board still gates its **Change** control on an
  ONLINE host — that's a UI judgement about feedback, not a reason to let the fleet diverge.
- This writes to the **agent's ledger, not to Jira** — the board stays pull-only with respect to Jira
  itself.
- A pin also decides **where a ticket session spawns**, for free and without either side knowing about
  the other: `spawn_ticket` re-derives the repo from this host's own ledger (see "Jira ticket
  sessions"), where a pin outranks the model. It still re-checks `scan_repos()`, so pinning an
  un-cloned repo names the ticket's home without pretending a session can start there yet.
- **Known limits, all of them multi-host-per-org** (the deployment is one host per org — the host
  holding that org's Jira creds — so none of these bite it today):
  - The hub 202s on QUEUE, and a host whose candidates lack the repo refuses it **log-only**. The
    picker offers the union of the org's hosts' options, so on a multi-host org it can offer a repo
    one host will reject; the board can't report that. The panel self-corrects within
    `REPO_SETTLE_MS` (it re-reads the ticket each beat and stops holding the optimistic paint), so
    the failure mode is a pin that visibly reverts rather than a lie that persists.
  - `cloned` is host-relative and each host records its own, so two hosts can report different
    `repoGuess.cloned` for one pin and the chip's dashed-ness follows whichever block wins the merge.
  - Widening the allowlist to the fleet's option list (rather than each host's own) would fix both,
    at the cost of the property that a host only ever records repos it can actually see.
- Tests: `agent/tests/test_hub_agent.py` (`TestSetJiraRepo`), the `repoPickerHtml`/`repoFieldHtml`
  cases in `turma/tests/board.test.js`, and the `/repo` endpoint cases in `turma/tests/server.test.js`.

### Jira ticket sessions

- The board's per-card **start button** spawns a session to work a ticket: a `{type:"spawnTicket",
  issueKey}` command → `spawn_ticket()`.
- It runs agent-side for the same reason the triage does — this host is the only place the Jira creds
  (hence the ticket's full text), the triage ledger (hence its repo), and the repos themselves meet.
- **The hub sends only the issue key.** Everything else is re-derived from LOCAL state: the repo from
  this host's own triage ledger (and it must still be in `scan_repos()`), the ticket from a fresh
  `fetch_jira_issue`. So a board a beat or two stale can't spawn against a repo the ticket has since
  been re-triaged away from. The hub's job is purely ROUTING (see the /board bullet).
- The fetched ticket becomes the **initial prompt** (`build_ticket_prompt`: fields, description, the
  newest `TICKET_PROMPT_COMMENTS` comments), because the session has no Jira creds of its own — that
  text is all it will ever see of the ticket, which the prompt says plainly while pointing at the URL.
- The ticket is carried on the session record as `ticket` = `{key, siteKey, url, summary, branch}`,
  persisted, heartbeated, and surviving kill/resume. **That record IS the ticket ↔ session link** —
  there is no hub-side ticket store, and the board reverse-indexes the fleet payload it already polls.
- The record only answers **while it exists**, so a durable `transcriptId → ticket` ledger
  (`~/.turma/jira-sessions.json`, `TICKET_LEDGER_PATH`) answers afterwards. It is the exact
  counterpart of the usage attribution ledger, for the same reason: a killed session's ticket rides its
  closed record, but `closed.json` keeps only `CLOSED_PER_REPO` per repo, and past that the only
  channel still reporting the session is the `resumable` scan — re-derived from the transcripts on
  disk, which know nothing of Jira. Keying on the transcript id (what that scan reports, and what the
  Ended list dedupes on) is what re-attaches the two.
  - Written in `_launch_tmux` at the one line that names a session's conversation, so **every** launch
    records it (`_remember_ticket`, idempotent, no-op without a ticket). A restart-clear-context adds
    its NEW transcript beside the old rather than replacing it: both worked the ticket, and both stay
    separately resumable.
  - `_backfill_ticket_ledger()` adopts sessions predating it from the registry + closed history (the
    two records carrying both a ticket and a transcript id), keying a pre-pin closed record on its
    resolved `transcriptId` — so it doesn't start empty on the very update that makes it durable.
  - Bounded by `TICKET_LEDGER_MAX` oldest-first on a first-seen `at`. Deliberately **not** pruned
    against the transcripts on disk, unlike the usage ledger: a transcript archived off this host is
    still the answer to "which session worked PROJ-123".
  - Tests: `TestTicketLedger`, plus the end-to-end case in `TestSpawnTicket`.
- A ticket-backed session is **named from its ticket** (`"PROJ-123 <summary>"`, via
  `clean_manual_summary`) instead of paying a `claude -p` to derive a worse name from a ticket-sized
  prompt.
- Refusals log and return like spawn's own (no record to hang an error on yet); each case is one the
  board's button already prevents. A failed fetch raises to `handle_commands`, which logs and acks —
  a session working a ticket it can't see would be worse than no session.
- Nothing is ever written to Jira: the board stays pull-only, and the link lives in Turma only.
- Tests: `agent/tests/test_hub_agent.py` (`TestSpawnTicket`, `TestBuildTicketPrompt`).

#### Ticket branch naming

- The branch is **decided at spawn** (`_reserve_ticket_branch`) and injected into that session's
  appended system prompt (`TICKET_BRANCH_PROMPT`) as an exact instruction — the name has to be
  derivable from the ticket by a human scanning branches, and the -1/-2 suffix needs a branch scan the
  agent has no particular reason to do correctly.
- `next_ticket_branch` hands out the bare ticket key, else the first free `key-1`/`key-2`/… It fills a
  gap left by a deleted branch rather than counting how many ever existed.
- **"Taken" is the union of git and the registry**, and it needs both: `branch_names()` reads local
  heads plus remote branches (after a short-bounded fetch, so a branch pushed from another host or
  merged-and-pruned locally still counts), while a session that hasn't branched YET owns its name with
  git knowing nothing — so two sessions started back-to-back on one ticket must not both be told
  `PROJ-123`.
- **The app still creates no branch**: the worktree stays `--detach` and the invariant holds. This
  decides the NAME deterministically; the agent still cuts it, from the refreshed remote default per
  the ordinary policy the directive extends.
- A resume re-tells the persisted name rather than reserving a fresh one — otherwise a session would
  be handed `-1` against its own first branch.
- Tests: `TestNextTicketBranch`, `TestBranchNames`, plus the reserve/resume cases in `TestSpawnTicket`.

### GitHub block and cloning

- The agent heartbeats a `github` block: whether the container has a usable `gh` login and, if so,
  that login's clonable repos (refreshed on a slow cadence; sweeps the authenticated user's own
  repos, the orgs they belong to, and any extra `GH_CLONE_OWNERS`), plus any in-flight/recent
  `clones`.
- A `clone` command `git clone`s a validated `owner/repo` (from the hub's dropdown or free-typed,
  allowlist-checked before it reaches git) into `REPOS_ROOT` as a **detached subprocess** (reaped
  across later beats so a slow clone never blocks the heartbeat), after which the new repo joins the
  scan and becomes spawnable.
- Private-repo auth rides the image's system git credential helper (`gh auth git-credential`).

### `entrypoint.sh`

- Creds preflight, then launches the tunnel and `exec`s the session manager as PID 1 — the container
  stays up with zero sessions.
- See "Run-as identity" under Conventions for the uid resolution it performs first.

### `native/` — non-Docker install (WSL/Linux)

- A package that installs the SAME `hub-agent.py`/`tunnel-agent.js`/`hooks/`/`tmux.conf` onto a host
  and reuses its built-in tooling, instead of the container — for a WSL box that already has git,
  node, python, and a logged-in Claude. See `agent/native/README.md`.
- `turma-agent` — the launcher: the runtime half of `entrypoint.sh` minus every container/privilege
  bit (no setpriv/uid-gid/chown/docker-group/HOME forcing; runs as the invoking user). Sources the
  config, defaults `CLAUDE_PROJECTS_ROOT=$HOME/.claude/projects` (the one env that decouples from the
  container's hardcoded `/root`) and `DEVICE_NAME=$(hostname)`, idles on missing claude creds,
  reconciles + supervises the tunnel, execs the manager.
- The config is **validated before it is sourced**, and a bad one **idles** rather than exiting.
  - The launcher `.`-sources the env file, so a non-assignment line does not fail — it RUNS. A
    YAML-style `JIRA_SITE: "x"` becomes the command `JIRA_SITE:`, exits 127, and under `set -e` takes
    the launcher down before it execs the manager.
  - The two readers of that file **disagree** about such a line, which is what made this pathological:
    systemd's `EnvironmentFile` parser only warns ("Ignoring invalid environment assignment"), while
    our `.` dies. `Restart=always` then rebuilt the unit every `RestartSec` forever — spaced just wide
    enough to stay under systemd's start-rate limit, so it never reached the `failed` state that would
    have made it visible. Each pass reaped the tunnel, so every session read **"terminal offline"**
    (same symptom as a missing node, different cause), with one `command not found` per interval in
    the journal as the only evidence.
  - So the check is anchored on the `=` directly after the name: `JIRA_TOKEN: "a=b"` carries an `=` in
    its VALUE and slips past any looser test. `export` stays legal — not the documented format, but
    sourcing has always taken it, and the guard must not fail a config that works today.
  - **Idling, never `exit 1`.** A launcher that refuses to start is indistinguishable, to systemd, from
    one worth restarting in five seconds — the exit IS the loop. Idling self-heals (fix the file,
    restart) and states the fault once, where it will be read. `--preflight` is the one exception
    (`install.sh --verify` must answer and leave), and it exits 1.
  - Nothing is sourced in that state: a half-applied config points the manager at the wrong hub, or
    none, which is worse than not running.
  - The report carries **line numbers and key names, never values** — the file is `chmod 600` and holds
    `TURMA_TOKEN`/`JIRA_TOKEN` while the banner goes to the journal, a different audience with
    different permissions. A malformed secret is still a secret. (systemd's own warning does echo the
    value; that is not a licence to leak it twice.)
  - Tests: `agent/tests/test_turma_agent.sh` (invalid line idles + starts neither tunnel nor manager,
    no value leak, `--preflight` exits without hanging, a valid config still loads).
- The tunnel is **supervised** here: it is re-exec'd as
  `turma-agent --tunnel-supervisor` (a respawn loop, not a bare background node), because a native
  install is the only place its runtime can be MISSING — node is an apt prereq, not a baked layer.
  (The container gained its own, simpler respawn loop in `entrypoint.sh` with XERK-34 — no node
  check, since node is a baked layer there; see the parity bullet below.)
  - Fire-and-forget made that failure silent AND permanent: the manager kept heartbeating, so the
    host read ONLINE while every session on it read **"terminal offline"** (the hub's
    `terminalOnline` is just "is this host's control channel connected right now"), with one
    `node: command not found` in the journal to say why. Nothing retried, because nothing watched.
  - The node check lives INSIDE the loop, so installing node on a host that came up without it heals
    the terminals within one `TUNNEL_RETRY_SEC` — no restart, and no operator who has to know one
    was owed.
  - The supervisor's pkill key is PREFIX-scoped like the `tunnel-agent.js` one, and the launcher
    reaps the supervisor BEFORE the tunnel (the reverse order lets the old loop respawn the tunnel
    that was just killed). `turma-agentctl stop` reaps it too — the tunnel-agent.js key doesn't
    match it, and left alive it would respawn what the stop tore down.
  - Tests: `agent/tests/test_turma_agent.sh` (respawn, missing-node heal, no duplicate supervisor).
- The launcher exports **`TURMA_MANAGER_PID=$$`**, which `exec` makes the manager's own pid, so the
  tunnel's poke (`pokeHeartbeat`, cutting a heartbeat sleep short so a queued command lands in about
  a round-trip) signals the right process. It falls back to PID 1 — right ONLY in the container,
  where entrypoint.sh `exec`s the manager as PID 1. Natively PID 1 is systemd, and poking it raised
  EPERM on every command, silently costing each one a full beat. Tests: the `pokeHeartbeat` cases in
  `agent/tests/tunnel-agent.test.js`.
- `install.sh` — idempotent installer (`--verify`/`--uninstall`): auto-installs prereqs (apt + npm +
  pinned static ttyd), lays files into a prefix keeping `hub-agent.py` and `hooks/` siblings, writes a
  `chmod 600` config, wires the service, writes `$PREFIX/VERSION`.
  - It `try-restart`s the service after wiring it: `enable --now` starts a STOPPED service but does
    nothing to a running one, so a re-run left the old process serving the files it just replaced —
    a no-op on exactly the host that needed it (a first install that landed without node, or the
    documented way to update a checkout).
  - **`have_sudo` asks** when it must, rather than probing `sudo -n` only: a `-n`-only probe makes an
    ordinary password-sudo host look sudo-less, so under the README's `curl … | bash` quickstart every
    apt prereq — node included — was skipped behind one warning while the install still "succeeded".
    sudo prompts on `/dev/tty`, not stdin, so the pipe never stopped it asking; only the probe did.
  - It is gated on `[ -t 2 ]` so an unattended run (CI, cron, a piped log) still fails fast rather
    than hanging on a password nobody will type, and the answer is cached so a DECLINED prompt isn't
    re-asked once per prerequisite.
  - The README's quickstart primes it with `sudo -v` so the prompt lands up front. It must never
    become `curl … | sudo bash`: the install belongs to the invoking user (their `$HOME`, their
    systemd USER unit), and only the prereqs need root — which is the same reason `turma-agent` has
    no privilege-drop machinery at all.
  - Tests: `agent/tests/test_install_sudo.sh` (the piped-quickstart prompt, the unattended no-hang,
    NOPASSWD, a declined password), wired into `code-scan.yml`.
- `bootstrap.sh` — the README's `curl … | bash` front door: the way IN for a host with no checkout.
  Resolves the newest native tarball, verifies its sha256, unpacks to a temp dir, and `exec`s the
  `install.sh` inside it with every arg passed through (`bash -s -- --autostart`). Duplicates none of
  install.sh; `install.sh` isn't copied into `$PREFIX`, so `--verify`/`--uninstall` on a bootstrapped
  host re-run through it (both act on the existing `$PREFIX`, not the tarball they arrive in).
  - It resolves by the version in the **asset's own filename**, never the release tag — a release
    carries an unchanged native build forward under its original older name, so the newest tag can
    hold an older tarball and a tag-derived name would 404. Matching asset names also covers the
    legacy `agent-native-v*` stream with no tag-scheme branch to keep in sync.
  - Anonymous (public repo — no `gh`/token, unlike the updater) and parser-free: it runs BEFORE
    install.sh apt-installs python3, so the release stream is read with grep/sed, not JSON.
  - Tests: `agent/tests/test_bootstrap.sh` (wired into `code-scan.yml` beside the updater's).
- Service: a systemd **user** unit with `KillMode=process` (so a restart signals only the manager,
  leaving tmux/claude/ttyd/tunnel alive), plus a nohup `turma-agentctl` fallback for WSL without
  systemd. Both preserve running sessions across a restart via the adopt-on-boot path above.
- `turma-agent-update` — self-updater: reads the unified release stream via `gh`, comparing the
  release `manifest.json`'s **agent-native component version** (never the release tag — a release can
  carry an unchanged older native build under a newer tag), verifies the sha256, swaps files, restarts
  the manager (which re-adopts live sessions) — so an update never stops active sessions, the UI just
  reconnects. Falls back to the legacy `agent-native-v*` stream when no unified release exists. Driven
  by a systemd timer or a `--loop` poller. Tests: `agent/tests/test_turma_agent_update.sh`.
- Not installed natively: cloud CLIs (aws/az/terraform) + PowerShell + docker CLI + the Android
  toolchain; the container is for those.
- Container ⇄ native parity (the XERK-34 audit): the same `hub-agent.py`/`tunnel-agent.js`/`hooks/`
  run in both, so the session model, heartbeat, Jira/PR/usage/archive features are identical. The
  known deltas, beyond the tooling line above and the README's "Known limitations":
  - Heartbeat `startedAt` is docker's StartedAt where docker can answer, else the manager's OWN
    start time — never empty (`TestStartedAt`). The fallback is what keeps the hub's restart-loop
    alert (keyed on `startedAt` CHANGING) and the card's Uptime working for native hosts, where a
    crash-looping manager under `Restart=always` used to be invisible to notifications. The log
    tail stays container-only (no native `docker logs`; nothing reads the journal).
  - **native**: the bundled tmux.conf only takes effect at `/etc/tmux.conf`/`~/.tmux.conf`; a host
    with its own conf loses truecolor and the OSC 52 copy chain (install.sh warns; hub-agent launches
    bare `tmux`, so `$PREFIX/tmux.conf` itself is never read, and agent sessions share the user's own
    tmux server/config).
  - The tunnel is supervised on BOTH sides now: natively by `--tunnel-supervisor` (which also
    handles a missing node), in the container by a respawn loop in `entrypoint.sh` (node is baked,
    so it only guards process death — an uncaught exception used to strand every terminal as
    "offline" under a green host until a container restart). Tested by the relaunch case in
    `agent/tests/test_entrypoint.sh`.
- Additive: nothing under `native/` edits the shared runtime files; the one enabling change is
  `resume_on_boot`'s adopt path (above), which is backward-compatible with the container.
- The native tarball is one component of the unified `release.yml` (see Unified releases); the updater
  consumes it from that stream.

### `tunnel-agent.js`

- The reverse tunnel; the hub's `{open,port}` selects which per-session ttyd to bridge, over one
  per-host control channel.
- That channel also carries the **live transcript tail**: on the hub's `{watch,worktreePath}` /
  `{unwatch}` it tails just that session's newest transcript every ~1s and pushes `{tail,entries}`
  deltas straight back on the same control channel.
- It's a JS re-implementation of hub-agent.py's `transcript_tail`/`_entry_text`, kept parity-tested in
  `agent/tests/tunnel-agent.test.js`.
- Tailing runs only while a client is watching, so idle sessions cost nothing.

#### Control-channel liveness

- **Both ends prove the channel rather than assume it**, because a heartbeat says nothing about it: the
  heartbeat is a fresh HTTP POST while the tunnel is one long-lived socket, so they die independently.
  A wedged tunnel therefore reads as a perfectly healthy host — `online` (green, heartbeating) with
  `terminalOnline:false`, i.e. every session on it saying **"terminal offline"** and no attach possible.
- The hub beats every `CONTROL_PING_EVERY_MS` (30s) and drops a channel silent for
  `CONTROL_DEAD_AFTER_MS` (90s, 3 missed beats); the agent reconnects when nothing arrives for
  `TURMA_CONTROL_IDLE_TIMEOUT_MS` (90s).
- It sends **two pings, and needs both**:
  - the **protocol ping** (`0x9`) beats Cloudflare's idle timeout, and is what every agent auto-pongs —
    Node's built-in WebSocket answers it internally, so the returning `0xa` is liveness the hub gets
    from OLD agents for free. That is how the hub reaps a half-open channel to a host that died without
    a FIN, which it would otherwise report as `terminalOnline` while each Attach hung to
    `openChannel`'s timeout.
  - the **app-level `{ping}`** text frame is the same beat in a form the AGENT can see: that same
    internal handling means a browser-style WebSocket exposes **no ping event and no ping method**, so
    the protocol ping is invisible to it and it cannot send one either. This frame is the only liveness
    signal its `onmessage` can observe. An agent predating it ignores the unknown key.
- **A dead hub does not necessarily close the socket.** Reached through Cloudflare, the edge holds the
  agent's end open after the origin dies, so no `close` fires and the reconnect never runs — the
  channel wedges **forever** while the manager keeps the host green. This is what stranded the whole
  fleet's terminals on a hub restart, and why silence (not a close event) is what the agent acts on.
- The agent's watchdog is armed **only once the hub has proven it app-pings**, so a new agent against a
  hub predating the ping keeps the old behaviour instead of reconnect-looping every idle timeout.
- `retire()` is idempotent per-socket and **never waits on `ws.close()`**: closing a half-open socket
  waits for a peer close frame that is never coming, so the `close` event it would rely on may never
  fire. It schedules the reconnect itself and lets the doomed socket be reaped whenever.
- Supervision does not cover this and cannot: the native tunnel supervisor only respawns on process
  **exit**, and a wedged socket never exits.
- Tests: the control-channel cases in `agent/tests/tunnel-agent.test.js` (which drive the real script
  as a child process against a fake hub that goes silent — the bug is in the socket lifecycle, so a
  mocked-WebSocket unit test would have passed all along) and in `turma/tests/server.test.js`.

### Live working footer and agent list

- The same control channel also carries the session's **live working footer** scraped from the tmux
  pane (`parsePaneLiveTurn` → `{turn,text,status}`): the in-progress assistant text plus
  `status = {verb, up/down token counters, elapsed, hint}`.
- When Claude's agent-manager list is expanded below the input box, the footer also carries
  `status.agents[]` (`parseAgentList`: one `{sel,type,label}` row per live agent, i.e. `main` + each
  background subagent), so the hub pins the working indicator and lists the live agents.
- A single-frame **busy→idle blip is held one poll** before the bar clears (`liveTurnDecision`,
  XERK-42): the same spinner-repaint gap that flickers `paneBusy` can make one 1s capture read
  "not generating" mid-turn, which would blink the pinned working bar (and the chat's Stop button)
  off. When the previous poll was generating and this one isn't, the frame is skipped for one tick
  (the last frame stays on screen); if the next poll is still idle the turn really ended and the bar
  clears — the committed transcript tail owns the finished message either way, so the ~1s hold is
  invisible. Busy is never held. This is the live counterpart of `_stable_pane_busy`'s re-capture
  (the 1s cadence lets a poll-hold stand in for a delayed re-capture). Tests: the `liveTurnDecision`
  cases in `agent/tests/tunnel-agent.test.js`.
- **Clicking a subagent row opens that background agent's own transcript**: a
  `{type:"subagentHistory", sessionId, agentType, label}` command resolves the row to its
  `subagents/agent-<id>.jsonl` file via the main transcript's Task `tool_use` + that call's result
  text (`agentId: <id>`) — `_resolve_subagent`/`_stage_subagent_history`, matching type +
  description (exact, else a prefix so a pane-truncated label still resolves).
- The result rides the next beat as `subagentHistoryResults`, the same {command → staged result →
  next beat} path as session `history`.
- Tests: `agent/tests/test_hub_agent.py` (`TestResolveSubagent`, `TestStageSubagentHistory`) and the
  `parseAgentList` cases in `agent/tests/tunnel-agent.test.js`.

### Transcript entry blocks

- Each tail entry carries, alongside the backward-compat flat `text`, a rich **`blocks[]`** array
  (`_entry_blocks` in hub-agent.py, mirrored by `entryBlocks` in tunnel-agent.js — same parity
  contract).
- Blocks PRESERVE the thinking text, tool_use inputs and tool_result outputs that `_entry_text`
  flattens away, so the hub's native chat UI can render + verbosity-filter each component.
- Turns that are ABOUT the session rather than someone talking are classified, not rendered verbatim
  (each backed by real transcript shapes found on the fleet):
  - `[Request interrupted by user…]` marker turns (Esc / the hub's Stop) become `{t:"interrupt"}` —
    a centred status marker in chat, not a user bubble; `_entry_text` keeps the raw bracket line.
  - The `!` shell passthrough's `<bash-input>`/`<bash-stdout>`/`<bash-stderr>` turns parse into the
    SAME command/command_output shapes the slash commands use (name `!`), via `_parse_local_command`.
    Output tags routinely arrive together with one stream empty, so stderr only wins when non-empty.
  - A `system`/`away_summary` entry (the "while you were away" recap) becomes `{t:"away_summary"}` —
    an assistant-side collapsed card, with the "(disable recaps in /config)" TUI hint stripped; every
    other system subtype is TUI bookkeeping and stays dropped (`_away_summary_text`).
  - `tool_reference` blocks inside a tool_result (ToolSearch naming the tools it loaded) flatten to
    `[tool: <name>]` lines instead of vanishing and leaving the result card empty.
- **Still-queued prompts ride beside the entries, not inside them**: a message typed mid-turn only
  becomes a user entry when Claude Code dequeues it, so the live tail and `/history` fold the
  transcript's `queue-operation` entries FIFO (`_fold_queue_op` / `foldQueueOp`, enqueue → dequeue →
  remove-by-content) and ship the survivors as `queued[]` beside `entries` — the chat renders them as
  dimmed "queued" user bubbles under the live turn, exactly the list the TUI shows under its input
  box, replaced wholesale each frame so a consumed prompt swaps for its real user turn with no
  duplicate. A window opening mid-sequence errs toward hiding (an unmatched dequeue no-ops), never
  toward inventing a phantom queued prompt. Older agents send no `queued` and the hub/chat treat it
  as absent, not empty.
- Tooling payloads ride the same queue — a background task finishing mid-turn enqueues its whole
  `<task-notification>` XML — so display filtering happens at REPORT time (`_queued_display` /
  `queuedDisplay`), never at fold time, which would desync the positional dequeues.
- They ride the live tail (tight per-block caps) and on-demand `history`
  (`_entry_blocks(entry, BLOCK_CAPS_FULL)`, looser caps for "Show more").
- They are the one place inclusion widens: a tool_result-only turn, dropped by `_entry_text`, is kept
  when it has blocks.
- The heartbeat preview (`transcript_tail`) and durable archive (`_archive_deltas`) stay text-only
  (`_entry_text`).

### Archive sync

- The agent **ships every INACTIVE session's transcript to the hub's durable archive** so history
  survives this host being wiped/offline.
- On the slow usage cadence `_archive_manifest()` enumerates ended transcripts (every ledger slug's
  `*.jsonl`, attributed to a repo via the usage ledger, excluding any slug backing a running session)
  and reports a small scalar manifest.
- The hub replies with per-transcript byte cursors (`archiveHave`), and `_archive_deltas()` POSTs the
  missing append-only byte-range deltas (pre-parsed through `_entry_text`, so only displayable text
  travels) to `POST /api/agents/<host>/archive/<transcriptId>`, bounded per chunk/beat so a big
  backfill trickles in.
- Tests: `agent/tests/test_hub_agent.py` (`TestArchiveSync`).

## `turma/` — central dashboard

The central dashboard for the per-host agent containers: reached over the Cloudflare tunnel
(the operator's public hub URL); port 8300 on the LAN.

### Shared site chrome (`turma/public/nav.js`)

- The header and the phone bottom-nav are built by one module (`nav.js`, dual-exported for tests like
  `chat.js`/`board.js`) and are **identical on every page** — pages hand-roll neither.
- Each page mounts them with `<header class="site-header" id="siteHeader" data-page="…" data-sub="…">`
  + `<nav class="bottom-nav" id="bottomNav">` and one `<script src="/nav.js">`; `data-page` lights that
  page's tab in BOTH navs, so a tab list and a bottom bar can't disagree.
- Everything page-specific goes in the two slots the page's own script fills — `#hdrSub` (static
  descriptor) and `#hdrMeta` (dynamic). An unfilled slot collapses (`.site-header .sub:empty`), so
  pages using fewer slots still ship the same DOM.
- The row **ends at the tabs**: there is no right-hand slot. One existed to carry an "updated \<time\>"
  stamp on dashboard/sessions, which was dropped as noise (the fleet polls constantly, so the stamp
  only ever said "seconds ago" while re-rendering every beat).
- The header is full-bleed and `.site-header-in` caps its row at `--wrap` and centres it, so every
  page's chrome lands in the same 1180px column as a `.wrap` page's content. On `sessions.html` the
  two-pane `.sess-shell` below is capped at the same `--wrap` and centred too (XERK-28), so the whole
  page reads like dashboard/board/usage — chrome and content in one centred column — rather than the
  shell filling the window edge to edge while the header stayed capped. Its earlier full-bleed shell
  was the odd page out; the cap is inert below `--wrap`, so the phone layout is unchanged. Letting the
  page release `--wrap` on the HEADER instead (the older regression) stretched the wordmark and tabs to
  the window edges and looked nothing like the others; the `.app-header` bar it used to override with
  is gone.
- Because that row is **centred**, the viewport it centres in must not depend on whether a page
  scrolls, so `app.css` reserves the scrollbar gutter globally (`html { scrollbar-gutter: stable }`).
  The dashboard always overflows and the other pages often don't, so without it the dashboard centred
  in a 15px-narrower window and its header sat 7.5px left of every other page's.
- That gutter is reserved on `sessions.html` too, which never scrolls (`html { overflow: hidden }`) —
  the 15px it gives up is exactly what keeps its header on the same pixels as the rest. The strip is
  invisible (the shell's right edge is page-coloured), and real phones use overlay scrollbars, for
  which the property is a no-op.
- The gap under the header is a **margin, not padding**, so it still collapses with the first content
  element's own margin exactly as the old in-`.wrap` header did — with padding it doesn't collapse and
  every `.wrap` page's content sits 2px low.
- It's mounted synchronously at the bottom of `<body>` — after both placeholders exist, before the
  page's own script reads the slots.
- **`TurmaNav.preserveScroll(container, paint)` is the one wrapper every recurring innerHTML repaint
  must go through** (XERK-35). Each page repaints by replacing a container's `innerHTML` on every
  SSE/poll beat (~1s), which silently threw the user's scroll back to the start every second — the
  page's own window scroll AND any inner `overflow:auto` region (the phone board's horizontal column
  strip was the loudest case; the fleet tree, a clone-repo list, a usage table all did it too). It
  snapshots the window scroll plus every scrolled descendant of `container`, runs `paint()`, then
  restores them synchronously in the same frame. Scrolled nodes are re-matched across the swap by a
  stable `id` anchor if one is in scope (so a list the beat REORDERS — host cards by activity — maps
  its scroll to the right row), else by structural child-index path (fine for a fixed set like the
  board's four columns); only nodes actually scrolled off zero are captured, so a settled page costs
  one cheap walk.
  - Callers: `board.html` render (`.kanban-cols`/`.kc-list`), `index.html` render (`#groups` fleet
    tree + its `.clone-list`), `usage.html` render (`.wrap` → the `.table-scroll` tables + page
    scroll). It SUBSUMED each page's older per-site snapshot code (the board's
    `captureBoardScroll`, index's `captureCloneScroll`, usage's bare `window.scrollY` save).
  - Two recurring repaints keep their OWN bespoke logic on purpose and must NOT be routed through it:
    `chat.js`'s transcript `repaint` (stick-to-bottom vs. hold-place, plus a selection-guard), and
    `sessions.html`'s sidebar (its `scrollTop` restore is ordered against a focus/caret restore that
    can itself scroll the sidebar — `preserveScroll` has no focus half). New recurring repaints that
    don't have such a special case should use `preserveScroll`.
- Tests: `turma/tests/nav.test.js`, which asserts the invariants drift broke (one active tab, same
  header DOM across pages), that no page re-grows its own copy, and the `preserveScroll`
  capture/restore contract (window-scroll clamp recovery, structural-path and id-anchor matching).

### Fleet tree (host → repo → session)

- Each host row reads **`<hostname> - <org>`** — the org whose Jira that host polls, from its `jira`
  block's `siteKey` via `TurmaBoard.orgName` (which is why the dashboard loads `board.js`). A host
  with no Jira creds reports no `siteKey` and shows its name alone.
- Each host has a **"Clone from GitHub" bar**: a dropdown of the host's `gh` login's repos
  (already-present ones disabled) plus a free-text `owner/repo` box, which clones a repo into the
  repos root so it joins the tree. It's greyed out with a note on hosts reporting no GitHub creds.
- Each host expands into a top **⌂ Repos root** entry — a session directly at the repos root, no
  worktree or branch, so its composer hides the base-branch field, and "+ New session" disappears
  once one root session is running.
- Below that come the host's scanned repos, ordered most-recently-active first (by the agent's
  `lastActivity`, the later of each repo's newest commit and newest session activity) rather than
  alphabetically.

### Per-repo controls

- **"+ New session"** — one click, instant bare spawn with today's defaults.
- A **▾ caret** opens a progressive-disclosure "New session" composer: an optional initial task
  prompt, a human-friendly label, and spawn options (base branch — the fork point, defaulting to the
  repo's latest default branch — model, permission mode). Last-used options are remembered per repo
  in `localStorage`.
- A **"Resume" picker**, when the repo has resumable history: **any prior Claude session for the
  repo** (from `repo.resumable`) — killed/deleted/pruned Turma sessions, repo-dir "terminal"/dev runs
  on the host, and older ones. Each is resumed by transcript id via
  `POST /api/agents/<host>/transcripts/<transcriptId>/resume`, falling back to the last-5 killed
  `closedSessions` for older agents.
- An arm/confirm **"Prune"** button that sweeps that repo's finished work: worktrees whose commits
  are merged into the latest default branch, and local branches merged into it, leaving anything
  unmerged or dirty.

### Session cards

- Working/idle/waiting-on-question state, the worktree name, and the agent's live branch (or
  "detached" until it branches).
- Per-session token usage parsed from that worktree's `~/.claude/projects` transcripts.
- Any **PR status** the session opened — a GitHub-style pill (state colour + `#number` + a ✓/✗/●
  merge-readiness mark, CI *and* conflicts; see "PR status" under the agent) from the agent's
  `session.prs`; `prBadgeHtml` builds it, with shared `.pr-badge` CSS in `app.css`.
- Per-session **Attach / Restart (clear context) / Kill / Start / Delete**.

### Spawn/resume handoff

- **Starting or resuming a session hands off to the Sessions page and opens it there** — you asked for
  a session to work in, so you land in it.
- The id doesn't exist yet at POST time (the agent mints it), so `spawn()`/`resume_transcript()` echo
  the hub's queued-command id onto the record they create (reported as `session.spawnCmdId`), the
  spawn/resume POST's `{ok, cmdId}` reply is handed to `/sessions?spawn=<cmdId>`, and that page waits
  for the session reporting that `spawnCmdId` and selects it (`followSpawn`/`tryPendingSelect` in
  `sessions.html`). The page's own composer follows its spawn in place rather than navigating.
- Resuming a **killed** session keeps its id, so that path deep-links `/sessions?session=<id>`
  directly — the same param the Attach button has always used.
- Both waits are one-shot, show a "Starting your session…" stage while the session comes up, expire
  after `SPAWN_FOLLOW_MS`, and are cancelled the moment the operator picks a session by hand, so a
  slow spawn can never yank the stage out from under them.
- A third deep link, **`/sessions?ended=<transcriptId>`**, opens an ENDED session's read-only view —
  what the board's ticket chips use for anything not running. It keys on the transcript id because
  that is the one handle all three ended channels share (a resumable row's entry `id` is a synthesised
  `t:<transcriptId>`, a killed one's is the session's own), resolving it through
  `findEndedByTranscript` and handing off to `openEndedSession`. It is **bounded** (`ENDED_FOLLOW_MS`),
  unlike the by-id wait: the board only ever chips a transcript it saw in the same fleet payload, so
  not finding one means the host dropped out between the click and the load. It cannot be folded into
  `?session=`, whose wait only ever resolves a **running** session.
- Tests: the select-on-arrival cases in `turma/tests/sessions.test.js`, plus
  `TestSessionLifecycle`/`TestResumeTranscript`/`TestHandleCommands` in
  `agent/tests/test_hub_agent.py`.

### History page (`/history`)

- Charts persistent daily/all-time cost from the agents' `repoUsage`/`usage` aggregates — not the live
  session list, so killed/deleted/pruned work still counts.
- **By repo** view unifies each repo's usage across every host it runs on (matched by `remoteKey`).
- **By host** view shows per-host totals.

### Board page (`/board`)

- One cross-org Jira Kanban built from every agent's `jira` block (`turma/public/board.js`,
  dual-exported for tests like `chat.js`).
- `mergeSites` collapses the hosts sharing an org into one board keyed by `siteKey` (freshest block
  wins per site+user; different users on one site union, deduped by issue key).
- Columns are Jira's three universal status categories, and each card's pill shows the org's own
  status name.
- A fourth **In Review** column (XERK-23) sits between In Progress and Done. Jira has no cross-org
  category for review/testing (both are `indeterminate` → `inprogress`), so `categoryOf` carves it
  out by matching the org-specific status NAME (`isReviewStatus`, word-boundary: review/testing/QA)
  and only ever pulls FROM `inprogress` — a Done/To Do ticket keeps its category whatever its name.
  Purely a board.js/CSS change; the agent still heartbeats the same three-category `statusCategory`.
- The org filter chips are **labelled by `orgName(siteKey)`** — the site host minus its
  `.atlassian.net` suffix, since the org is the only part of it a human reads (the full host stays as
  the chip's tooltip). Presentational only: the chip still filters on, and the board stays keyed on,
  the whole `siteKey`. A non-`atlassian.net` site keeps its whole host, which is its name there.
- Pull-only: nothing on this page writes to Jira.
- Tests: `turma/tests/board.test.js`, plus the ticket-detail and jira-refresh endpoint cases in
  `server.test.js`.

#### Repo chips

- Each card shows the **repo the agent triaged the ticket to** (`repoChipHtml`, from the ticket's
  `repoGuess` — see the triage section in the agent bullet; the hub only renders it, there is no
  hub-side model call), in three deliberately distinct states:
  - a repo **cloned** on the reporting host reads as a plain, actionable chip;
  - one that only exists in the org's `gh` listing is **dashed** (a real answer, but you'd clone it
    first);
  - a ticket the model declined (a pure design/ops ticket) shows a muted italic **"no repo"**.
- A ticket with no `repoGuess` yet gets **no chip** — "not looked at yet" is not the same claim as "no
  repo fits", and it resolves within a beat or two.
- The model's rationale rides as the chip's tooltip and is spelled out in the detail panel's Repo row
  (`repoFieldHtml`), which reads `t.repoGuess` directly rather than through the panel's usual `v()`
  field-preference helper, because the guess only ever exists on the heartbeat ticket — the on-demand
  issue fetch comes straight from Jira, which knows nothing about repos.
- The Repo row is also where the guess is **corrected by hand** — see the detail panel's own bullet.

#### Starting a session on a ticket

- Each card carries a **start button** that spawns a session to work that ticket:
  `POST /api/jira/<siteKey>/<issueKey>/session` → a `spawnTicket` command (see the agent bullet).
- **The hub's whole job here is ROUTING**, since it's the only party that sees the whole fleet. It
  sends just the issue key; the agent re-derives repo, ticket text and branch from its own state.
- `findTicketHost` picks that host by **splitting load across the org's agents** — see "Splitting
  ticket sessions across an org's agents" below.
- Online is **required**, not preferred (unlike the read-only ticket GET, which happily serves an
  offline host's cache): a spawn queued onto a sleeping host lands whenever it wakes, which is a
  surprise, not a feature.
- `ticketRepo` resolves the repo from the **freshest** reporting block — the same rule `mergeSites`
  renders by, so the hub resolves against the copy the operator actually clicked.
- Org is checked before repo: an org nobody reports has no ticket to be untriaged, and answering "no
  triaged repo yet" would send the operator hunting a triage problem they don't have.
- Single-flight per ticket, like the `jiraIssue` fetch: a double-click must not start two sessions.
  A second session on a ticket is supported — that's what the `+` button and the -1/-2 branch are for.
- The button's states are deliberately distinct (`ticketStartHtml`): a triaged ticket gets a live
  button whether or not any host has the repo cloned (an uncloned repo reads **"☐ Start (clone first)"**
  and clones on demand — see the splitting bullet), a "no repo" verdict and an untriaged ticket get
  none at all. A failed start renders its reason beside a LIVE button (every failure is fleet-state, so
  the operator needs both the reason and the retry).
- In-flight state clears on **evidence**, not a timer: a session reporting the spawn's `cmdId`, or the
  command clearing from the host's queue — which is what covers a spawn the agent REFUSED, whose ack is
  the only signal a board that never sees a session would get.
- The press is acknowledged **instantly and survives leaving the board**, which is what XERK-18 was
  about — three separate defects behind one report ("click start, then click elsewhere, and the session
  won't start; and nothing acknowledges the press for ~5s"):
  - **The click was swallowed.** The board `innerHTML`-replaces every beat, so a press straddling a beat
    had its button destroyed between mousedown and mouseup and the browser synthesized no `click` — the
    press vanished, nothing queued. The start button now acts on **`pointerdown`** (fired on the press,
    before any re-render can move the target), with the `click` handler kept only as the keyboard path (a
    real `<button>` turns Enter/Space into a click no re-render can swallow). `startFrom` is the one entry
    both go through; the pending guard makes a double-fire a no-op.
  - **No acknowledgement for ~5s.** The `⏳ starting…` paint waited on the POST round-trip. `startSession`
    now sets the pending state and repaints **synchronously, before the fetch** — the button is `⏳` the
    instant it's pressed. `cmdId`/`host` fill in when the POST replies.
  - **The optimistic paint was swept instantly against a stale cache.** `sweepStarts` read "command absent
    from my cache" as "the host acked it", but on the SSE-fallback poll the cache hasn't yet seen the
    just-queued command — so the first render after the click deleted the pending and the `⏳` never
    showed. The verdict is now `B.startSweepVerdict` (pure, in `board.js`, unit-tested): a cmdId-less
    pending always holds (its own fetch resolves it), and "command gone" only counts as acked once the
    command was actually **seen present** (`sawCmd`) — a `saw`-then-gone rule mirroring the manual
    refresh's.
  - The POST uses **`keepalive: true`** so it outlives the page: navigating away (or the spawn handoff)
    otherwise aborts the request in flight and the session never starts — the ticket's headline symptom.
- Tests: the ticket-session cases in `turma/tests/server.test.js` and `board.test.js` (the latter's
  `startSweepVerdict` cases cover the stale-cache and never-seen paths).

##### Splitting ticket sessions across an org's agents (XERK-14)

- A ticket the operator pinned to a host (the detail panel's Agent row — see "Pinning the agent by
  hand") skips all of the below: the pin is authoritative, and a dead pinned host refuses rather than
  reroutes.
- `findTicketHost` chooses among the org's **ONLINE** hosts: it **prefers one with the repo cloned**,
  and — within that group, or across all of them when NONE has it — picks the **most available**
  (`hostAvailability`), so N sessions on one org spread across its hosts instead of stacking on the
  first match. A momentarily-full host is still a valid target: the session simply **queues** there
  (see "The session queue"), so routing never fails for lack of a free slot.
- `hostAvailability(a)` = the host's reported `capacity.free` **minus its `capacity.queued` and the
  spawn/spawnTicket commands still sitting in its queue** since its last heartbeat. Subtracting the
  in-flight commands is what makes rapid clicks split: without it, four tickets clicked between two
  beats would all read the same stale `free` and pile onto one host. An agent predating the `capacity`
  block reports no ceiling and scores below any host that does (but stays eligible for a mixed fleet).
- **No host has the repo → clone on demand.** `findTicketHost` returns `{host, needsClone:true}` for
  the most-available host; the agent's `spawn_ticket` then clones the repo (owner from its triage
  ledger's `nameWithOwner`) and queues the session behind the clone. This replaced the old
  `409 no online host has <repo> cloned` refusal and the board's disabled "clone it first" button.
- The known **multi-host-per-org limits still apply**: the triage/branch state is per-host, so a
  clone-on-demand routed to a host that didn't triage the ticket has no ledger entry to clone from —
  fine on the one-host-per-org deployment (the org's host is the one that triaged AND spawns), noted
  as a limit for the aspirational two-agents case this ticket is about.
- Tests: the `most available one wins` / `pending lowers availability` / `clones on demand` cases in
  `turma/tests/server.test.js`.

##### Auto-starting To Do tickets (XERK-32)

- An org can be **opted in** so the hub auto-starts a session for every **To Do** ticket the moment it
  has a repo assigned — by the model's triage OR a manual pin. Off by default.
- **The PRIMARY control is a hub setting the operator flips from the board (XERK-41)** — the "auto"
  switch on each org chip. `POST /api/jira/<siteKey>/autostart` `{enabled}` → `setAutoStartOrg`, a
  hub-owned, durable per-org opt-in stored in `autostart-orgs.json` (`AUTOSTART_ORGS_FILE` on `/data`,
  keyed by siteKey, presence = enabled). It's hub-owned for the same reason the ticket→agent pins are:
  the decision and routing are the hub's job. The map rides the fleet payload as top-level
  `autoStartOrgs` (`{siteKey:true}`) plus an `autoStartOrgs` SSE event, so open boards reflect a toggle
  live. This replaced the old requirement to redeploy an agent to change the opt-in.
- The agent's config env **`TICKET_AUTO_START` (`hub-agent.py`) stays as a legacy OR-fallback** — an
  org configured the old way keeps auto-starting. It's advertised on the heartbeat as the
  **top-level, board-agnostic `ticketAutoStart`** (named TICKET_* not JIRA_*, kept OUT of the `jira`
  block, so a future non-Jira board carries it unchanged). An **online** host reporting it forces its
  org on, which the board shows as the switch **on and locked** (`autoStartState.envForced`) — clear
  the env to control that org from the hub.
- It is a **per-org** setting: an agent holds exactly one board's creds, so it serves exactly one org.
  `orgsWithAutoStart` **unions** the two sources — every siteKey enabled in `autoStartOrgs`, plus any
  siteKey an ONLINE host reports the env flag for. The env source needs onlineness (an offline host's
  stale flag drives nothing); the hub toggle doesn't (it's durable hub state, and the sweep gates the
  actual spawn on a live host via `findTicketHost` anyway).
- **The decision and routing live on the HUB**, not the agent, for the same reason the manual Start
  button does: only the hub sees the whole fleet, so only it can spread an org's sessions across ALL
  its agents. `autoStartSweep()` (a 15s `setInterval`, boot-grace-gated like the offline sweep) walks
  each org where **an ONLINE host reports `autoStart`**, and for each freshest-block To Do ticket with
  a `repoGuess.repo`, routes a `spawnTicket` through the **same `findTicketHost`** the button uses. So
  "one of two agents in an org has the flag on" still fans work across BOTH — the flag-bearer only
  advertises intent; it need not be the host that runs the session.
- The point is to never open a **second** session for work already started (by a click, a prior
  auto-start, or anything else). Three guards, increasing in strength:
  - `startedTicketKeys()` — the durable one: a ticket carrying a session on ANY channel
    (`a.sessions`, `a.closedSessions`, or a repo's `resumable` scan, which outlives a restart) is
    already handled, however it was started. A **killed** session counts — a deliberate kill is not
    resurrected.
  - an in-flight `spawnTicket` on some org host, for the window before that session first heartbeats.
  - `autoStarted` — an in-memory once-per-hub-lifetime set, the only thing that stops a spawn the
    agent legitimately **refuses** (leaving no session to see) from being re-queued every sweep. A
    no-online-host result is left UNrecorded so it retries when a host returns.
- Reuses the queue end to end: an auto-started session that can't run now just **queues** on its host
  (see "The session queue"), exactly as a clicked one does. Nothing is written to Jira.
- Tests: the `auto-start:` cases in `turma/tests/server.test.js` (incl. the hub-toggle sweep and the
  `/autostart` endpoint), the `autoStartState` cases in `turma/tests/board.test.js` and android's
  `BoardTest.kt`, and the `autoStart` payload cases in `TestSetJiraRepo`
  (`agent/tests/test_hub_agent.py`).

##### Auto-stopping Done tickets (XERK-45)

- The lifecycle **counterpart** to auto-start: the SAME per-org "auto" opt-in that starts a To Do
  ticket's session **kills** a session once its ticket reaches **Done**. Turning "auto" on for an org
  now means the board drives that org's whole session lifecycle — both halves — which is why the org
  chip's tooltip reads "start To Do tickets, stop Done sessions" rather than naming only the start.
- A ticket only reaches Done by a **human** moving it (the board is pull-only — no session writes to
  Jira), so it's a deliberate "this work is finished" signal, even more intentional than the To Do
  state auto-start reacts to.
- The hub **KILLS** the session, not interrupts it: a kill ends it cleanly — it moves to the Ended
  list with its worktree, conversation and PR chips intact and still resumable, and frees the
  `MAX_SESSIONS` slot the auto-started session took (symmetric with auto-start consuming one). An
  interrupt would only cancel the in-flight turn and leave the session running idle, still holding the
  slot with nothing to do.
- The DECISION and ROUTING live on the HUB for the same reason auto-start's do: only it sees the whole
  fleet. `autoStopSweep()` (same 15s `setInterval`, boot-grace-gated, beside `autoStartSweep`) reads
  each opted-in org's **Done** tickets from its freshest jira block (the copy the board renders), then
  scans the WHOLE fleet for sessions whose `ticket` names one — a session can live on ANY of the org's
  hosts, so it routes each `{type:"kill", sessionId}` to the host that owns the session.
- Only **live** sessions are stopped (`status` `running`/`queued`): a `stopped`/`error` session
  already ended, a killed one is gone from `a.sessions`, and a `queued` session for an already-Done
  ticket is cancelled (its Cancel path) rather than run pointlessly. Every live session on the ticket
  is killed — a two-branch (`-1`/`-2`) or restart-clear-context ticket has more than one.
- Guard: `autoStopped`, an in-memory `<host>\x00<sessionId>` once-per-hub-lifetime set. A kill drops
  the record within a beat or two but it's still reported in that window, so the set stops a duplicate
  kill riding every sweep. It needs no durability — unlike `autoStarted` (which stops a *refused*
  spawn re-queuing forever), a re-issued kill of an already-dead session is a harmless agent-side
  no-op, and a still-live session re-derives into the sweep on its own.
- The Android client shows the identical "auto" toggle and behaviour; the reworded text is a
  desktop-only hover tooltip (Compose has no equivalent), so there's no parity gap.
- Tests: the `auto-stop:` cases in `turma/tests/server.test.js`.

#### Ticket ↔ session chips

- A ticket's sessions show as chips on its card, from `ticketSessionIndex` — a reverse index of the
  fleet payload's `session.ticket`, so **no hub-side ticket store exists to keep in sync**.
- It reads the **same three channels the Sessions page's Ended list merges** (`a.sessions`,
  `a.closedSessions`, each repo's `resumable`), because an operator asking "which session worked
  PROJ-123" draws no distinction between them. Reading only `a.sessions` meant a ticket forgot its work
  the instant that work was killed — the kill drops the registry record, and `_closed_payload` didn't
  carry `ticket` at all. The resumable channel gets its ticket from the agent's ledger (above) and is
  what covers a session aged out of `closed.json`.
  - Deduped on `<host>::<transcriptId>` with the **registry-backed record winning** (only it knows the
    session's id, `createdAt`, and that it was renamed); resumable is swept in its own pass over the
    whole fleet, after every record is seen, so a record reported by a later host can't lose to an
    earlier host's scan entry. Not deduped across hosts — the shared `~/.claude` login syncs
    transcripts, so an id alone isn't fleet-unique and two hosts reporting one really are two rows.
  - A **restart-clear-context session legitimately chips twice**: its pre-restart conversation is a
    different transcript, still on disk and separately resumable. The Ended list shows the same.
- **Where a chip links follows the run state, not the channel**: running → `?session=<id>` (the live
  chat); anything else → `?ended=<transcriptId>` (the read-only view); no transcript at all → not a
  link, since there is no conversation to open. The Sessions page's `?session=` wait only ever resolves
  a **running** session (`sessionHit`) and never times out, so pointing a stopped/killed chip at it
  parks the stage on "Opening session…" forever — a bug that predated the ended channels, since a
  `stopped` registry session has never been openable live.
- The chip is **labelled with the BRANCH**, not the session name: a ticket-spawned session is named
  from its ticket, so its name only repeats the key and summary already on the card, while the branch
  is the one thing that tells two sessions on one ticket apart. An operator's rename (`summaryManual`)
  means that name, so it leads once it exists. The live git branch beats the reserved one — the
  reservation is what the agent was TOLD, git is what it did.
- The chip's label ellipsises on **its own element**: `.kc-sess` is a flex container, and
  `text-overflow` can't clip anonymous flex content — it hard-cuts mid-letter (the same trap `.kc-repo`
  documents).
- The reverse link rides the session: the Sessions page's card meta shows the ticket key (a plain span
  — the card is a `<button>` and can't hold a link), and the chat footer carries a linked `jira-chip`
  beside the PR chip (`ticketFooterChip`).
  - The chip links to that ticket on Turma's OWN board — `/board?ticket=<key>&site=<siteKey>`, which
    the board deep-links open — not out to Jira (XERK-16). From inside a session the board is the more
    useful hop: it's where the ticket's repo triage, its other sessions, and its controls live, and its
    card links on to the live Jira issue in turn.
  - The board's `consumeDeepLink` (in `board.html`) is one-shot: it waits for the ticket's org to
    report, opens the detail panel on the first render that resolves the key, and strips the query
    params so closing the panel or reloading doesn't reopen it. `site` is optional (any org carrying
    the key wins without it).

#### Ticket detail panel

- **Clicking a card expands it into a detail panel** (`detailHtml`) with the full description,
  comments, people, parent, and labels.
- The panel opens instantly painted from the card's own heartbeat fields, then fills in from
  `GET /api/jira/<siteKey>/<issueKey>`, which routes to a host reporting that org (preferring an
  online one), serves a fresh cached copy, or queues a `jiraIssue` command and 202s so the client
  polls until the host's next beat delivers it (`ingestJiraIssues`, cached per issue by
  `JIRA_ISSUE_FRESH_MS`/`_MAX_AGE_MS`/`_MAX` and stripped from `/api/agents` like the history cache).
- An org whose only host is offline serves its last copy flagged `stale`, and a cached `error` is kept
  so a doomed fetch isn't re-queued on every poll.
- The fetched copy wins field-by-field over the card's older heartbeat values.
- Agent-side text is already plain (see the ADF note in the agent bullet), so the panel escapes first
  and linkifies after — a bare URL in a description is usually the point of it.

##### Changing the repo by hand

- The panel's **Repo row carries a "Change" control** that swaps the row in place for a picker of the
  org's `jira.repoOptions` — cloned and un-cloned repos in separate `optgroup`s, plus "No repository
  fits" and "Let the agent decide". It's the same field the row was already reporting, and the
  operator is answering the question it just asked. It `POST`s to
  `/api/jira/<siteKey>/<issueKey>/repo` (see the agent's "Manual repo override" bullet for the whole
  path).
- **Choosing an option IS the save** — the dropdown is the setting, and every option on it is a
  complete answer, so picking one commits it and closes the picker. There is no Save button: the
  picker used to need one, and closing the panel (the ordinary way to leave a ticket) then discarded
  the choice silently and snapped the row back to the model's guess, so a pin only ever landed for
  someone who knew to press it. A control that reads as committing on pick has to commit on pick.
- Re-picking the value already showing saves **nothing** (it isn't a change, and a fleet-wide command
  restating the current answer is noise) but still closes the picker, which is what a pick means.
  `repoPickerValue` is what the handler compares against, and it is the same function
  `repoPickerHtml` preselects from — they must not drift, or a real change reads as a re-pick and gets
  dropped, which is the bug this control just came out of. **Cancel** stays as the way out for someone
  who opened the picker by mistake; clicking away does the same, since nothing changed.
- The row is present even for an **untriaged** ticket, reading "Not triaged yet": the card draws no
  chip for one (absence isn't a verdict), but the panel is where an override is made, and a ticket
  nobody has classified is exactly the one worth pinning. It states which state it's in rather than
  vanishing, so it still never reports "not looked at yet" as "nothing fits".
- **Only a manual pin preselects a repo** in the picker. An auto guess of "Turma" is the model's
  answer, and the operator's current setting is "let it decide" — preselecting Turma would misreport
  that as a pin they'd made, and quietly turn a Save they meant as "leave it alone" into one.
- Options are merged **across the org's hosts** (`mergeSites`, cloned winning the dedupe): `cloned` is
  host-relative, the override fans out to every host anyway, and "someone here has it" is the useful
  claim. They're collected next to `hosts`, over EVERY agent — not in the winners loop, whose blocks
  are one per (site, user), and an org's hosts commonly all poll as the same user, so the picker
  would otherwise offer only whichever host polled Jira last.
- A pinned repo that has **left** the options (deleted, off the candidate cap's tail, a blanked `gh`
  sweep) is carried back in under "Currently set" so it can stay selected. With nothing selected the
  browser falls back to its first option — "Let the agent decide" — which misreports the pin and turns
  an untouched Save into a silent release of it. `_apply_triage` keeps rendering such a repo on
  purpose, so the picker has to tell the same story the row does.
- The save is painted **optimistically** — the pin only becomes real on the agent's next beat, and the
  board would otherwise sit showing the old guess for a full interval after a Save that worked. A
  failed request rolls the paint back and says so on the row it failed to change.
- `refreshOpenTicket` re-points the open panel at the rebuilt ticket each beat (`mergeSites` builds
  fresh objects, so the panel would otherwise render its opening snapshot forever). It holds the
  optimistic paint for `REPO_SETTLE_MS` — the command legitimately hasn't landed yet — and after that
  the heartbeat wins, which is what stops the panel insisting on a pin the agent silently refused. It
  repaints only when a rendered field actually changed (the panel is innerHTML-replaced, and an
  unconditional repaint would throw away the scroll position of anyone reading a long description),
  and never while the picker is open.
- "Change" only appears when a host of that org is **online**: the command rides the heartbeat, so an
  offline org's ticket stays readable but not re-assignable.
- The edit state lives in a page variable, not the DOM — the same rule the session card's ⋯ menu
  follows.

##### Pinning the agent by hand (XERK-38)

- Below the Repo row sits an **Agent row**: which HOST this ticket's sessions spawn on, defaulting to
  "Auto — most available agent" (findTicketHost's ordinary pick). Its "Change" swaps in a picker of
  the org's reporting hosts; **a pick IS the save**, same contract as the repo picker beside it.
- Deliberately **panel-only** — the card gets no chip. Auto routing is the overwhelmingly common
  case and there is no model guess worth surfacing at a glance; the row exists for the rare
  multi-agent-org override, so it lives with the other rare controls.
- **The pin is hub-owned, not an agent-ledger fan-out** like the repo override: it is a ROUTING
  input, routing happens on the hub (the only party that sees the fleet), and it persists in the
  hub's own `/data/ticket-agents.json` (`TICKET_AGENTS_FILE`, keyed `<siteKey>/<issueKey>`, bounded
  by `TICKET_AGENTS_MAX` oldest-first) — durable across hub restarts, which is the ticket's whole
  point, and NOT in the best-effort `state.json` whose loss is documented as harmless.
- So `POST /api/jira/<siteKey>/<issueKey>/agent` (`{host}` to pin, `{auto:true}` to release) answers
  an authoritative **200, not the /repo route's 202-on-queue**: nothing rides a heartbeat. The host
  is allowlist-checked against the fleet's hosts reporting that org; an OFFLINE host is pinnable (a
  pin is a persistent choice about future spawns), but a host of another org — or a stranger — is
  not.
- `findTicketHost` honors a pin over the availability ranking for **both** the board's Start button
  and the auto-start sweep. A pinned host that's offline (or gone from the org) **refuses with the
  pin in the error, never silently reroutes** — routing elsewhere would contradict the one thing the
  pin asserts. The auto-start sweep treats that refusal like any no-host result: unrecorded, so it
  retries once the pinned host returns.
- The map rides the `/api/agents` payload as top-level `ticketAgents` (plus a `ticketAgents` SSE
  event for open boards); the picker's options are `mergeSites`' per-site `hostOptions` — every host
  reporting the org, online first, offline included and marked. A pinned host that left the fleet is
  carried back into the picker "Currently set" so the browser can't misreport the pin as Auto (the
  same trap the repo picker documents).
- A pinned host without the repo still works: it clones on demand and queues behind the clone,
  exactly like an auto-routed host (with the same per-host triage-ledger limits the splitting bullet
  notes).
- Tests: the ticket-agent-pin cases in `turma/tests/server.test.js` and `board.test.js`, plus the
  hostOptions/agentPinOf cases in `android/app/src/test/.../BoardTest.kt`.

#### Refresh button

- Re-polls on demand rather than waiting out each agent's slow cadence: `POST /api/jira/refresh` fans
  a `refreshJira` out to every Jira-configured host, deduped so a mashed button costs one poll per
  host.
- It fans out because the board is a *merge* of every host's block — refreshing one org would leave
  the rest stale under a button reading "Refresh".
- It targets the block's `configured` flag (creds present) rather than `available` (a poll succeeded),
  because a host whose polls are FAILING reports `available=false`/`siteKey=null` — indistinguishable
  from a host with no Jira at all, and yet exactly the host a retry is for. `siteKey` is the fallback
  for agents predating the flag.
- It resolves on real fleet state, not a guessed delay: it holds until the queued command clears from
  the targeted hosts' records (`jiraRefreshPending` — which also covers a poll that FAILED, whose
  fail-open keeps the old tickets and leaves `fetchedAt` untouched, so a freshness check alone would
  hang to the timeout), with the freshness watermark (`newestFetchedAt`) as a second signal for when
  an ack beats the first render, and a 45s timeout for a host that never beats.
- It reports "Refresh failed" only when EVERY targeted host errored (`jiraRefreshFailed`) — one
  permanently broken host must not label a refresh that updated the rest of the fleet as a failure.

### Sessions page (`/sessions`)

- Opens a running session in a **native chat view by default** (`turma/public/chat.js`) instead of the
  raw ttyd terminal.
- It streams that session's live transcript over the existing `/live/<host>/<id>` WebSocket (ws-token
  auth, seeded from the heartbeat's cached tail, initial scrollback from `GET .../history`,
  `/history`-poll fallback when the socket is down).
- It renders chat bubbles — **user right, agent left** — with collapsible tool-action cards (tool_use
  input + its paired tool_result output, error-styled) and collapsed thinking traces, the in-progress
  turn typing in via a typewriter reveal (ported from the glasses `live.ts`/`transcript.ts`/
  `reveal.ts`).
  - The live turn is the tmux **pane scrape's "last ● bullet"**, which — unlike glasses' transcript
    tail — is NOT a monotonic stream: mid-generation it SWAPS between unrelated blocks (prose → a
    `Bash(…)`/`Read(…)` tool bullet → the next tool → the next prose). So `repaint` reveals the delta
    only when the new capture **continues the exact slice already shown** (`liveTurn.startsWith`
    revealed prefix) and **snaps** `reveal.shown` to the new length otherwise. A length-only clamp
    (XERK-19's predecessor) caught only swaps to SHORTER text; a swap to longer or same-length-but-
    different text kept re-typing from a stale offset — the "last line deletes and restreams over and
    over" (XERK-19). This stands in for glasses `advanceReveal`'s entryId-change snap, which the pane
    scrape has no id for. Tests: the swap/continuation cases in `turma/tests/chat-selection.test.js`.
- Bubble prose is rendered by `renderProse` (`chat.js`), which lifts markdown out of the transcript's
  plain text: **fenced ` ``` ` blocks** become `<pre class="md-code">` (language chip from the info
  string), inline **` `code` ` spans** become `<code class="md-code-inline">` chips (`renderInline`),
  GFM **tables** become real `<table>`s, and everything else is linkified.
  - The passes nest outward-in — fence, then table, then inline, then link — so each only ever sees
    text the outer ones didn't claim, and a code body is never linkified at any level.
  - An inline span never crosses a line break: transcript prose is full of lone backticks, and a
    stray one would otherwise swallow whole paragraphs (and any table in them) into a span.
  - The fence pass runs above the table pass, so a pipe row inside a code block isn't read as a table,
    and a code body is only ever `esc()`'d — never linkified.
  - An **unterminated fence renders as code**: mid-stream the typewriter hasn't revealed the closer
    yet, and the partial body must not flash as prose first.
  - A non-wrapping `pre` has the min-content width of its longest line, which a shrink-to-fit bubble
    won't size below — so a code-carrying bubble is given a **definite** `width: min(760px, 100%)`
    (scoped by `:has()`), taking it out of shrink-to-fit sizing so the overflow lands on the block's
    own scroller. Not a grid track: that would tear inline `code`/links onto their own lines.
  - Tests: the `renderProse` cases in `turma/tests/chat.test.js`.
- A per-session **verbosity control** (Concise/Normal/Verbose presets + per-type thinking/tool-calls/
  tool-outputs toggles, persisted in `localStorage`) filters which `blocks[]` components show — a pure
  client-side filter over the already-received buffer.
- Typed prompts go to `POST .../input`; pending `AskUserQuestion`s answer via option chips / custom
  text to `POST .../answer`.
- The pending-question box renders Claude Code's full picker, not just labels: each option is a card with
  its `description` and a collapsible **`preview`** (the rendered mockup/code the TUI shows), plus a
  `header` chip and an "n of N" progress counter for a multi-question call.
  - These ride new heartbeat fields (`questionOptionsRich`/`questionHeader`/`questionIndex`/
    `questionTotal`/`questionMulti`) alongside the backward-compat `questionOptions` labels, so older
    clients (glasses/android) keep rendering the flat pick list unchanged.
  - A **`multiSelect`** question renders checkboxes + a Submit button that `POST`s `optionIndices` (a
    list); `answer_question`/`ask.py` accept that list and feed the model the multi-pick shape.
  - `optionCardHtml` (unit-tested in `chat.test.js`) builds each card; the agent side is
    `_question_options`/`_hook_question` + `TestHookQuestion`/`TestAnswerQuestion`/`test_ask.py`.
- The compose footer's live agent-mode / model selectors are joined by a compact **PR status chip**
  (the session's latest PR, `prFooterChip` in `chat.js`, unit-tested in `chat.test.js`) when it has
  one.
- The **model selector is accurate** (XERK-33) — it used to read "Default" and offer a hardcoded
  guess of a menu, and its switch quietly rewrote the shared login's default (see `setModel` under
  the agent's Commands):
  - the chip leads with the session's heartbeated `modelActual` — the model really answering —
    rendered human by `prettyModel` ("claude-opus-4-8" → "Opus 4.8"; a confirmation label like
    "Sonnet 5" passes through), falling back to the picked alias, with the raw id in the tooltip;
  - the menu is built by `modelOpts` from the host's probed `models` block — curated to the aliases
    the /model picker can reach (a menu entry the agent's session-only switch can't perform would
    be a button that does nothing), "Default (<label>)" saying what default resolves to, the static
    four when a host hasn't probed;
  - a just-picked switch holds its optimistic label until the agent confirms or
    `MODEL_SWITCH_SETTLE_MS` passes (`modelSwitchPending`) — without it the chip flashes back to
    the old model for the beat or two before the confirmation lands, which reads as a failed
    switch;
  - `onPoll` carries the fresh host payload so the menu tracks the probe, and the dashboard
    composer offers the same probed list (`modelChoices` in `index.html`, remembered-pick kept like
    the base-branch select).
  - Tests: the `modelOpts`/`prettyModel` cases in `chat.test.js`, the malformed-model endpoint case
    in `server.test.js`, and the agent tests under the models-probe bullet.
- The raw ttyd terminal stays one **"Terminal ▸" toggle** away in the chat header for debugging (the
  old `#termPane` iframe, unchanged).
- `GET /api/ws-token` (formerly only the glasses client) now also authenticates the web chat's `/live`
  socket.
- Core merge/grouping logic is unit-tested in `turma/tests/chat.test.js`.

#### Working-status bar and agent list

- A pinned **working-status bar** below the transcript mirrors the terminal's bottom region from the
  live `status` frame: the spinner verb + ↑/↓ token counters + elapsed, and Claude Code's rotating
  tip/active-task hint.
- When background agents are running it also shows a clickable **agent list** (`agentsHtml` in
  `chat.js`: `main` as a plain marker, each subagent as a button carrying its type + description).
- Clicking a subagent opens its transcript read-only in the right stage (`openSubagentView` in
  `sessions.html` → `GET /api/agents/<host>/sessions/<id>/subagents/history?type=&label=`, reusing
  the archive viewer + chat engine), with **Back** returning to the live session rather than the
  list.
- Tests: the `agentsHtml` cases in `turma/tests/chat.test.js` and the subagent-history endpoint cases
  in `turma/tests/server.test.js`.

#### Queued sessions

- A **"Queued" section** above Active lists sessions the agent hasn't provisioned yet
  (`status:"queued"` — see "The session queue" under the agent). Its cards are static (no pane to
  attach to), showing the wait reason (`queuedReasonText`) and a **Cancel** (arm-then-confirm kill).
- A followed spawn (`?spawn=<cmdId>`) that lands in the queue words its stage **"Queued — <reason>"**
  rather than "Starting…", and flips to the live session the moment it provisions. The dashboard's
  session card mirrors this (a queued card offers Cancel and a State line explaining the wait).
- Tests: the Queued-section cases in `turma/tests/sessions.test.js`.

#### Ended sessions

- The sidebar's third section (below Active/Idle/Queued), **collapsed by default** — it's history, and
  it only grows. Replaced the old "Stopped" list, which showed only half the story.
- It merges the three channels an over-but-resumable session arrives on, because the operator draws no
  distinction between them — all are "a session I'm done with, for now":
  - **killed** — dropped from the registry into the agent's closed history (`a.closedSessions`);
  - **stopped** — its claude exited on its own, so a non-running record stays in `a.sessions`;
  - **resumable** — a transcript from each repo's `resumable` scan, with no registry record of any
    kind behind it.
- The third channel is what makes the list **durable**, and it is the point of the merge. The first
  two are read out of `~/.turma`, whose durability is the host's to provide (see the Kill/resume
  bullet): a container that doesn't bind-mount it has `sessions.json` and `closed.json` on the image's
  writable layer, so an agent update empties the list. Even where it IS mounted, `closed.json` is
  capped at `CLOSED_PER_REPO`, so it was never the whole history on any host. `resumable` is
  re-derived every slow beat from the transcripts under `~/.claude/projects` (a bind mount) plus each
  transcript's own recorded cwd, so it survives the wipe and carries every prior session, not the
  newest few.
- The channels are **deduped on `<host>::<transcriptId>`**, and a registry-backed record always wins:
  a killed session is reported through both its closed record AND (once the slow scan catches up)
  `resumable`, and only the record knows the PRs it opened, when it was really killed, and that
  `resume` can have it back under its original id. So a kill that ages out of `closed.json` keeps
  listing — it just loses its PR chips, which is the honest degradation (there is no record left to
  have snapshotted them onto).
- Sorted **most recently ended first** (`endedMs`, from `closedAt`/`stoppedAt`/`endedTs` — note
  `resumableSession()` must copy `endedTs` onto the record it shapes, since that is where `endedEntry`
  reads the sort key from). The one you just killed is the one you're most likely to want back. An
  undated record (an older agent) sorts oldest rather than to an arbitrary spot.
- A **running** session is never also listed as ended. The agent re-cuts the cached scan against its
  live registry every beat (see `_sorted_repo_entries`), and the page independently dedupes resumable
  rows against every reported session's `transcriptId` — which is why `_session_payload` reports that
  id for running sessions too, even though they're read live and never opened from the archive.
- **Clicking a row opens that session read-only on the stage** — deliberately the same
  `#transcriptPane` the archive/subagent views use, which is exactly the surface an ended session
  should get: scrollable conversation + a verbosity control, and **no terminal toggle and no compose
  box**, because there is no live pty to attach to and nothing to type at. `resetEndedBar()` is what
  keeps the pane's shared PR/Resume bar from leaking into those other two views.
- The conversation is read from the hub's **archive** (`GET /api/archive/<transcriptId>`, via the
  `transcriptId` the agent now reports), so it works even for an offline host. A just-killed session
  legitimately hasn't synced yet (archive push is on the slow usage cadence) and says so rather than
  reading as history lost.
- Its **PRs are chips on the stage bar and are LINKS there** (`prBadgeLinkHtml`) — the sidebar copy
  stays an inert `<span>` because the card is a `<button>`. A PR is often the whole reason to open an
  ended session.
- **Resume** sits on both the row and the stage bar, and dispatches on how the session ended: killed →
  `.../resume` (re-registers it under the same id), stopped → `.../start`, resumable →
  `.../transcripts/<id>/resume` with its origin cwd (the agent re-validates the path and re-creates
  the dir if a prune removed it). It then hands off to the live session like a spawn does. Nothing
  removes it from the list — the list is DERIVED, so it drops out on the beat the agent reports it
  running.
- The resumable path is the one that comes back under a **new id** (the agent mints it), so it follows
  its queued command's `cmdId` like a spawn, and its row spinner clears on the repo's session count
  growing rather than on a by-id match that would never land.
- Resume needs the host **online** (it rides the heartbeat); reading the conversation does not, so the
  card stays clickable on a dead host while its Resume is disabled.
- Tests: the Ended-sessions cases in `turma/tests/sessions.test.js` (including the agent-restart and
  dedupe cases), plus `TestRefreshPrStatus` / `TestSessionLifecycle` / `TestResumableReport` /
  `TestCardedSlugs` in `agent/tests/test_hub_agent.py`.

#### Session card ⋯ menu

- Each sidebar session card carries a **⋯ overflow menu** in its top-right — a sibling of the card
  `<button>`, absolutely positioned over it, because a nested button is invalid HTML.
- **Rename…** swaps the card for an inline field that `POST`s the typed name to
  `.../sessions/<id>/summary`, painted optimistically since the rename only lands on the agent's next
  heartbeat (see "Session activity summaries" under Conventions).
- **Kill** arms-then-confirms in place like the chat/terminal bars.
- The menu's open/armed/typing state lives in page variables, not the DOM, because every beat
  re-renders the list.

#### Send and Stop buttons

- **Send always sends, and ◼ Stop is its own button**, in both the chat and terminal views. A message
  sent mid-turn QUEUES (Claude Code holds it until the turn ends, and the chat renders it as a dimmed
  "queued" bubble — see "Transcript entry blocks" under the agent), so the button that talks must stay
  available while the agent works — on a phone it is the ONLY way to send, and the old design (one
  button morphing into Stop mid-turn) made queueing impossible there. The warning-coloured Stop
  appears beside Send only while a turn is running, still in the compose row rather than parked in the
  header away from where the operator is typing.
- Stop interrupts the turn the session has in flight (`chatComposeStop`/`termComposeStop` → `stop()`
  in `chat.js` → `POST /api/agents/<host>/sessions/<id>/interrupt` → an `interrupt` command → the
  agent's Escape into the pane; see the agent bullet).
- Unlike Kill, Stop arms nothing and confirms nothing (it destroys no work — a turn stopped by mistake
  can just be re-asked) and leaves the session on the stage.
- **Enter in the text box always sends**, exactly like the button: queuing a message mid-turn is
  normal. Only Send's tooltip changes with the turn (idle "send" vs busy "queues and runs when this
  turn ends").
- The busy read driving Stop's visibility is `chat.js`'s `liveStatus` — the ~1s pane scrape pushed as
  `turn` frames — NOT the heartbeat's `paneBusy`, which is a beat or more behind a button the operator
  is watching. With the live socket down no frames arrive, `liveStatus` stays null, and Stop stays
  hidden: a Stop that can't see the turn is worse than no Stop.
- A clicked Stop **hides immediately** (`stopPendingAt`, `composeBusy()`), without waiting for the
  pane to stop reporting the turn — the interrupt only lands on the agent's next heartbeat, and the
  operator shouldn't have to watch a dead Stop to learn it worked. If the turn outlives the
  `STOP_SUPPRESS_MS` window the interrupt didn't take, and Stop legitimately comes back. A failed
  interrupt POST paints "Stop failed" on the Stop button (`actionFailed`'s selector arg).
- **A pending `AskUserQuestion` hides Stop** (`composeBusy()` returns false while `questionActive`,
  overriding the busy pane read the blocking tool call keeps up) — the answer is typed THROUGH the
  compose box, routed to `/answer` as a custom answer (`send()`'s `wasAnswer` path), and an accidental
  Stop would interrupt the turn and destroy the question (XERK-21). `updateQuestion` repaints the bar
  the instant a question appears or clears rather than waiting for the next live frame.
- `chat.js` paints every `.compose-action` and `.compose-stop` button on the page from that one read,
  so the terminal's bar (its engine stays warm underneath the toggle) can't disagree with the chat's.
- Tests: the compose-bar cases in `turma/tests/chat.test.js` and the
  `termComposeAction`/`termComposeStop` cases in `turma/tests/sessions.test.js`.

#### Copying out of the terminal

- A copy made in the terminal view reaches the viewer's **real system clipboard**. That took three
  independent fixes: the text has to survive the app, tmux AND xterm.js, and each dropped it (XERK-7).
- Selecting at all needs a **modifier**, because the Claude TUI holds mouse tracking (tmux's `mouse`
  is off, so the app's request passes straight out) and xterm.js hands it every drag.
  - That modifier is **Shift** everywhere except macOS, where xterm.js ignores Shift and honours
    **Alt** — but only when `macOptionClickForcesSelection` is on, and it defaults off. So a Mac
    operator could not select terminal text at all, hence could not copy any of it. `_launch_ttyd`
    passes the option; the cost is Mac's Alt+drag column-select, the same trade every terminal makes.
  - Once a selection EXISTS ttyd copies it itself (`document.execCommand` on `onSelectionChange`), so
    that path needs nothing from us and is not what the ticket was about.
- **Every other copy — the app's own and tmux copy-mode's — travels as OSC 52**, and all three links
  in that chain were broken:
  - tmux only emits OSC 52 if the OUTER terminfo advertises an `Ms` ("set clipboard") capability, and
    neither xterm-256color nor tmux-256color carries one here, so tmux dropped every copy on the floor
    instead of forwarding it. `agent/tmux.conf` declares `Ms` on the same "we launch the outer
    terminal, so we know it's xterm.js" ground as the RGB override beside it.
  - `set-clipboard`'s default `external` forwards **no** application OSC 52 at all (the man page's
    "ignore attempts by applications" means ignore, not pass through) — so the app's own copy died
    here even with `Ms`. `on` forwards it and keeps a tmux buffer, so one copy pastes both inside tmux
    and outside the browser.
  - xterm.js **parses** OSC 52 but ships no handler for it, so the sequence arrived in the tab and
    nothing happened. ttyd exposes its instance as `window.term`, so the hub injects the missing
    handler (`TERM_OSC52_JS`, beside the font + touch-scroll shims in `proxyTerm`).
- The bridge is deliberately **write-only**: an OSC 52 READ request (`?`) is never answered, since
  replying would hand any program running in the pane whatever the operator last copied. An empty
  payload is dropped rather than written, so tmux copying an empty selection can't wipe the clipboard.
- It splits the payload at the **first `;`** rather than matching a selection name: an app sends
  `52;c;<b64>` but tmux sends an empty selection (`52;;<b64>`), and both must land.
- Tests: the OSC 52 bridge cases in `turma/tests/server.test.js` (which run the injected string itself
  against a fake `window.term`) and `test_launch_ttyd_lets_a_mac_force_a_selection` in
  `agent/tests/test_hub_agent.py`.

### Durable archive

- The hub hosts a **durable, searchable archive of ended sessions** (`turma/archive.js`): agents push
  each inactive transcript in (see the agent bullet).
- The hub lands it as **organized files on the `/data` volume — one folder per repo, each renamed +
  dated `/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl`** (plus a `.meta`
  sidecar).
- Files are indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, Node-core, no npm),
  rebuildable from the files.
- The Sessions page gains a search box (`GET /api/search?q=` — instant hub-local full-text search,
  ranked, `<mark>`-highlighted, grouped by `remoteKey`, working even for offline hosts) and an "Ended
  sessions" browser (`GET /api/archive`); clicking a result/row opens that session's full transcript
  read-only in the right stage (`GET /api/archive/<transcriptId>`).
- The ingest endpoint is agent-token-authed like the heartbeat; the manifest cursors ride the
  heartbeat reply.
- Tests: `turma/tests/archive.test.js`, plus the ingest/search/browse cases in `server.test.js`.

### `POST /api/trigger` — external automation

- A purpose-built endpoint for external automation (CI, webhooks, scripts): it starts a session from
  a single JSON body —
  `{hostname, repo, prompt}` all **required**, plus optional `label`/`baseRef`/`model`/
  `permissionMode`.
- Validates the host and repo (against the host's reported `repos[]`, including the `(root)`
  pseudo-repo) before queuing the same `{type:"spawn"}` command the composer uses.
- Unlike the browser-oriented `POST /api/agents/<host>/sessions` (user-auth only, repo-in-URL, prompt
  optional), it's gated by `triggerAuthorized`: a dedicated **`TURMA_TRIGGER_TOKEN`** bearer token OR
  the ordinary user login (so a logged-in operator/curl works too). When the token env is unset the
  endpoint still accepts the user login but no token caller — it never opens on its own.
- Tests: the `/api/trigger` cases in `server.test.js`.

### Notifications

- Session commands are queued on the hub and drained via the heartbeat reply.
- The hub pushes edge-triggered alerts to the **Android client via FCM** — the sole notification
  transport (XERK-10 removed the former self-hosted ntfy path): host offline/recovered, restart loop,
  per-session turn finished / question waiting / PR created. (The old daily-cost-threshold alert went
  with cost accounting — usage is token-only now.)
- **`android/app/google-services.json` is committed** (XERK-37): the Firebase client config must be
  IN the repo for the CI-built release APKs (the ones the in-app updater installs) to carry it —
  gitignored, every released build had Firebase inert, no device ever registered, and push silently
  did nothing in production. It holds only public identifiers (same reasoning as the committed
  release keystore); the gradle apply stays conditional so a fork that removes it still builds.
- Every alert funnels through one `notify()` (`turma/server.js`), which fans out to every registered
  device via `turma/push.js` (HTTP v1, service-account JWT minted with `node:crypto`, no npm — enabled
  by `FCM_SERVICE_ACCOUNT_JSON`, a no-op that pushes nothing when unset), carrying
  `tags`/`priority`/`click`/`route:{host,sessionId}` as message data so the client picks a
  notification channel and deep-links a tap. `notify()` is a plain no-op when no device is registered
  or FCM is unconfigured — there is no other sink.
- Devices register via `POST /api/devices` (user-authed, persisted to `/data/devices.json`),
  unregister via `DELETE /api/devices?token=`, and dead tokens (404 UNREGISTERED) are pruned on send.
- The Android client owns the delivery half: `POST_NOTIFICATIONS` in the manifest, the Android-13+
  runtime request in `MainActivity`, the notification channels + rendering in `push/Notifications.kt`
  (channel chosen from `tags`, tap deep-linked from `host`/`sessionId`), and token
  registration/rotation in `push/PushRegistrar.kt` — all guarded so a build without
  `google-services.json` still runs. See the `android/` section.
- Tests: `turma/tests/push.test.js`, plus the alert and device-registry cases in `server.test.js`.

### Auth and the glasses surface

- UI, API, and the click-to-attach live terminal (`/term/<sessionId>/`, reverse-tunneled to that
  session's ttyd by port) sit behind single-user HTTP Basic auth (`TURMA_USER`/`TURMA_PASSWORD` on the
  hub service).
- Agents authenticate heartbeats, tunnel WebSockets, and ttyd with one shared token (`TURMA_TOKEN` in
  the agent's env = `TURMA_AGENT_TOKEN` on the hub). All are set inline in DockerOps'
  `compose/turma-truenas.yaml`.
- The hub also serves the `glasses/` client's needs:
  - a CORS'd `/api/*` surface for that cross-origin WebView;
  - per-session `input`/`history` endpoints;
  - `GET /api/ws-token` for short-lived WebSocket auth;
  - an `/audio` STT WebSocket (transcribes G2-mic PCM via the LiteLLM instance's OpenAI-compatible
    transcription endpoint — configured by `LITELLM_URL`; `WHISPER_*` env vars override only if the
    STT server lives elsewhere);
  - a `/live/<host>/<sessionId>` **live-transcript WebSocket** (ws-token auth) that streams a watched
    session's tail in near-real-time: the hub asks the host's tunnel-agent to `watch` the session
    (over the control channel), seeds the socket with the last heartbeat's cached tail, fans the
    agent's `{tail,entries}` deltas back out, and `unwatch`es when the last viewer disconnects
    (re-arming watches when a control channel reconnects).

## `glasses/` — Even Realities G2 smart-glasses client

- Vite + TypeScript, Vitest; an Even Hub plugin.
- Sessions list, scrollable transcript, `AskUserQuestion` answering, spawn/kill/resume, and G2-mic
  dictation transcribed via the hub's `/audio` endpoint.
- While the session screen is open it opens the hub's `/live` WebSocket (`live.ts`) for near-real-time
  transcript updates, and renders growing text with a **streaming typewriter reveal** (`reveal.ts`):
  small deltas type in as they would in the console, while a large chunk that lands at once snaps in
  immediately (no artificial delay).
- Falls back to the 6s poll unchanged if the live socket can't connect.
- See `glasses/README.md` for dev/simulator/packaging/on-hardware-QA details.

## `android/` — native Android client

- Kotlin + Jetpack Compose, MVVM. Full parity with the web dashboard + glasses client, plus
  phone-only features: **OS push notifications** (FCM) and **voice** for starting sessions and
  mid-session prompts.
- Mirrors the glasses pure-core/adapter-shell split:
  - `core/` — JVM-unit-tested reducers ported 1:1 from `glasses/src` (`Reveal` typewriter,
    `Transcript` grow-only merge, `Sessions` working/idle/waiting, `ChatItems` buildItems+verbosity).
  - `model/` — the wire shapes + shared `TurmaJson` decoder.
  - `net/` — the `HubClient` (Retrofit/OkHttp/kotlinx.serialization), `LiveTail`+`FleetRepository`
    (WebSocket `/live` + SSE `/api/events` with a 6s `/api/agents` poll floor), and `Dictation`
    (16kHz PCM → the hub's `/audio` Whisper socket).
  - `vm/` — the ViewModels.
  - `ui/` — the Compose screens (fleet tree, native chat with reveal/tool-cards/thinking/verbosity/
    ttyd-terminal toggle, spawn composer, actions, clone, prune, resume, question sheet,
    history/usage charts, archive search).
  - `push/` — the FCM service + `PushRegistrar` (registers the device via `POST /api/devices`; guarded
    so a build with no `google-services.json` still runs).
- Push is driven hub-side by `turma/push.js` (see the turma section).

### Web UI ⇄ Android parity (XERK-30)

- **The mobile web UI (`turma/public/`) is the source of truth for what the client does; the Android
  app must match it.** The web is where a feature lands first (it's the fastest surface to change),
  so the app is always the follower — never the other way round.
- **A PR that changes user-facing behavior in `turma/public/` must carry the matching change to
  `android/` in the same PR** (or, if genuinely out of scope, add a line to `android/PARITY.md` and
  say so in the PR description — an unlisted, unmentioned divergence is the thing this rule exists to
  stop). "User-facing" = a control, a screen, a state, a chip, an interaction, a layout that a person
  sees or touches; pure server/agent plumbing with no client surface is exempt.
- Concretely, when you touch one of these web files, check its Android counterpart:
  - `index.html` → `ui/FleetScreen.kt` + `ui/FleetDialogs.kt` (dashboard/fleet tree, summary tiles)
  - `sessions.html` + `chat.js` → `ui/SessionsScreen.kt` + `ui/ChatScreen.kt` + `vm/ChatViewModel.kt`
    (+ `ui/ArchiveScreen.kt` for the full-history search the web puts in the Sessions sidebar)
  - `board.js` + `board.html` → `ui/BoardScreen.kt` + `core/Board.kt` + `vm/BoardViewModel.kt`
  - `usage.html` → `ui/UsageScreen.kt`
  - `nav.js` → `ui/MainScaffold.kt` + `ui/TurmaApp.kt` (nav tabs, Sign out, shared header)
- **Pure logic ports live in `core/` and are JVM-unit-tested against the web behavior** — the board
  category carve-out (`core/Board.kt` ↔ `board.js` `categoryOf`), the typewriter reveal
  (`core/Reveal.kt` ↔ `chat.js` `repaint`), the summary-tile reducers (`core/Fleet.kt` ↔ index.html
  `fleetTokens`/`mergeModels`). Port the *logic* there so a test pins it to the web, and keep the
  Compose screen a thin renderer. This is the same pure-core/adapter-shell split the section above
  describes, applied specifically to keep parity checkable.
- **Match features and structure, not pixels.** Compose is not CSS; the goal is that every control,
  state and interaction the mobile web exposes is present and behaves the same, laid out in the
  platform-idiomatic way (a Material dropdown for a `<select>`, an overflow menu for the ⋯ menu). A
  justified platform difference (the app's native chat vs the web's ttyd terminal, the Hub-URL field
  on login, voice dictation) is fine — record it in `android/PARITY.md` rather than leaving it to look
  like an accidental gap.
- `android/PARITY.md` is the **living gap tracker**: the web→Android feature map, what's done, and the
  known-open items. Update it whenever you close a gap or knowingly open one.

### In-app update (XERK-11)

- A stopgap self-updater until the app ships on Google Play: checks the **public** `xerktech/turma`
  GitHub releases for a newer Android APK and, on a one-tap **Update**, downloads it and hands it to
  the system package installer.
- Split like the rest: `core.Update` is the pure, JVM-tested picker (`apkAssetVersion`,
  `compareVersions`, `latestApkUpdate`); `net.Updater` is the I/O (fetch/download/install +
  `State` StateFlow); `ui.UpdateBanner` + `vm.UpdateViewModel` render it on the Dashboard.
- It compares the version in the **asset FILENAME** (`turma-android-v<x.y.z>.apk`) against the
  installed `versionName`, never the release TAG — every release carries an unchanged component's APK
  forward under its original name (`manifest.js`), so the filename is the component's real version and
  the tag runs ahead of a carried one. Same reasoning as the native agent updater. It scans every
  recent release's assets (not just the "latest" release) so a carried-forward APK can't hide a build.
- **Anonymous + credential-isolated**: the repo is public, so the check is anonymous HTTPS with no
  token or hub credential (like `agent/native/bootstrap.sh`), and the updater uses its OWN
  `OkHttpClient` WITHOUT `HubClient`'s Basic-auth interceptor, so the hub password never reaches
  github.com.
- Checked on app start and each Dashboard visit, throttled ~15 min; **quiet on failure** (offline /
  rate-limit) — the banner only surfaces on a real update, and "Later" hides that version for the
  session (not persisted — "regular checking" means it resurfaces next launch).
- Install uses `REQUEST_INSTALL_PACKAGES` + a `FileProvider` (`@xml/file_paths`, authority
  `${applicationId}.updates`) over a `content://` URI. On API 26+ the OS gates on "install unknown
  apps"; ungranted, the updater routes to that settings screen and the banner reads **Install** to
  retry. The OS verifies the APK signature on install (the real integrity gate for updating an
  installed app), so — unlike the native updater's file-swap — no sha is re-verified here.
- **Stable signing key (XERK-26)**: that in-place update works ONLY when every build shares one signing
  cert, so `release.yml` builds `assembleRelease` signed with a fixed keystore committed to the repo
  (`android/app/turma-release.keystore`, wired in `app/build.gradle.kts`'s `signingConfigs`).
  It shipped `assembleDebug` before — signed with the debug key each ephemeral CI runner generates
  fresh, so no two releases matched and every update forced an uninstall+reinstall
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The key is deliberately in the public repo (its job is to be
  identical everywhere; the updater only installs official HTTPS releases); Play App Signing supersedes
  it on Play. Moving onto the first stable-key build still needs one last uninstall — the old install's
  random debug cert matches no stable key.
- Tests: `core/UpdateTest.kt` (the pure picker/compare cases).
- Built with Gradle (wrapper generated in CI, not committed); PR-gated by
  `.github/workflows/android-ci.yml` on `ubuntu-latest`, against that runner's preinstalled JDK +
  Android SDK with JDK 17 and Gradle pinned in-job to match `app/build.gradle.kts`.
- Setup + FCM wiring in `android/README.md`.

## `.github/workflows/`

GHCR image builds and PR gates — see Build & Deploy below.

## Build & Deploy

### Unified releases

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all five components + a changelog**, cut by
  `.github/workflows/release.yml`. See `RELEASING.md` for the operator story and
  `.github/scripts/README.md` for the logic. This replaced five per-component release/build workflows
  whose independent `run_number` patches drifted out of lockstep.
- The root **`VERSION`** file holds `MAJOR.MINOR` only. The **patch is derived from the existing `v*`
  tags** (`max` on that line + 1), never committed — so the auto-patch path is read-only against the
  repo and can't re-trigger itself. Bump `VERSION` only for a minor/major.
- The five components: `turma` image, `agent` image, glasses `.ehpk`, android `.apk`, native agent
  tarball. All version math (tag-derived patch, android `versionCode` packing, the strictly-greater
  guard) lives in the tested `.github/scripts` — not in YAML or Kotlin.

### What a release builds vs carries

- Only **changed** components build; **unchanged** ones are **carried** — their prior artifact is
  published in the new release at its own prior version, not rebuilt. A glasses-only merge builds the
  new `.ehpk` at the release version and copies the previous `turma-android-v*.apk` (etc.) onto the
  release unchanged. So every release publishes all five components; a carried one just reads its
  older version.
- **Images**: built when changed; when carried, the manifest references the prior `:version` tag (no
  retag — `:0.3.9` pointing at `0.3.4` bits would be the same lie as renaming a carried asset). A
  carried image's `:latest` is already correct, so Watchtower needs nothing.
- **Assets** (`.ehpk`/`.apk`/`.tar.gz`): a carried asset is copied forward under its **original name**
  (the filename must describe the bits — Even Hub / Android version installs by the version baked
  inside the file). A built asset is named at the new version.
- A per-release **`manifest.json`** (attached to every release) is the machine-readable source of
  truth for each component's version + where its bits live — read by the next release's `plan`, the
  native updater, and humans. The release notes render a rebuilt/carried table from it.
- The bundled Claude Code release is pinned into the agent image via `CLAUDE_CODE_VERSION` (contents
  can't drift) but is **not** part of the version — resolved only to feed the build-arg.
- Watchtower keeps `:latest` current on the host; the DockerOps `compose/turma-truenas.yaml`
  references `ghcr.io/xerktech/turma-agent:latest` — keep that ref in sync if renamed here.
- Trigger: `workflow_dispatch` (with `dry_run` defaulting on) plus `push: main` for auto patch
  releases. A manual `minor`/`major` dispatch bumps `VERSION`, rolls the intervening patches into
  `CHANGELOG.md`, and force-builds every component.
- The `push: main` trigger is **path-filtered to the four component source dirs**, restating
  `changes.js`'s `PREFIX_MAP` because a workflow trigger can't call into JS; a test asserts the two
  match. A docs-only merge deliberately cuts no release — every component would be carried, so the
  tag would publish nothing new.
- `.github/workflows/agent-emulator-image.yml` builds the opt-in `:emulator` agent tier on demand —
  not a release component (nothing consumes it), so it carries no unified version.

### Deployment (DockerOps, not here)

- `compose/turma-truenas.yaml` defines the `turma` service and a single per-host `agent-host`
  container: mounted at `REPOS_ROOT`, `MAX_SESSIONS`/`TTYD_PORT_BASE`, host mounts, the shared
  `TURMA_TOKEN`/`TURMA_AGENT_TOKEN`, the FCM push service-account (`FCM_SERVICE_ACCOUNT_JSON`),
  basic-auth.
- No pricing/cost env — usage is counted in tokens per model name, so there is no rate table to
  configure.
- Because one container now hosts many concurrent Claude sessions, its `mem_limit`/`cpus`/
  `pids_limit` are sized against `MAX_SESSIONS` rather than a single session.
- Editing image content here + pushing rebuilds the image; changing how it's run (or adding another
  host) means editing that compose file in DockerOps.
- The hub's `/data` volume (already home to `state.json`) also holds the **durable session archive**
  (`/data/archive/` — organized transcript files + a `node:sqlite` FTS index), which grows with
  history and must be a persisted volume, not ephemeral. Its location is overridable via
  `ARCHIVE_DIR`/`ARCHIVE_DB`.
- The `turma` service also takes the LiteLLM env that drives **Whisper STT** (`LITELLM_URL` = that
  instance's `/v1` base, optional `LITELLM_API_KEY`); STT derives its endpoint from `LITELLM_URL`
  unless the legacy `WHISPER_URL`/`WHISPER_API_KEY` are set to point elsewhere. Optionally set
  `NODE_NO_WARNINGS=1` to silence `node:sqlite`'s experimental warning.

### PR gates (pre-merge to main)

The build workflows above run only post-merge; these run on `pull_request` → `main` (open + each
push) and block the merge on findings:

- `code-scan.yml` — Semgrep SAST over the JS/Python + Dockerfiles + secret patterns, hadolint on both
  Dockerfiles, ShellCheck on `entrypoint.sh`.
- `turma-agent-image-scan.yml` / `turma-image-scan.yml` — build each image locally (no push) and
  Trivy-scan it for CVEs + secrets (`ignore-unfixed`, HIGH/CRITICAL gate), path-filtered to their
  folder like the build workflows.
- `glasses-ci.yml` — path-filtered to `glasses/**`, runs that package's typecheck + Vitest suite +
  production build inside a throwaway `node:24-alpine` container.
- `android-ci.yml` — path-filtered to `android/**`, runs the client's JVM unit tests +
  `assembleDebug` inside a Docker Hub Android-SDK container.

Every component is built and published post-merge by the single `release.yml` (see Unified releases);
these gates just block a bad merge. `code-scan.yml` also unit-tests the release logic
(`.github/scripts/tests`) and the native updater (`agent/tests/test_turma_agent_update.sh`).

Because the images bundle third-party binaries, keep the pinned tool versions current — that's how
most CVEs are cleared. Genuinely non-actionable upstream base-image findings go in the root
`.trivyignore` (a reviewed triage list, each with a reason); anything unlisted still fails the scan.

### The agent image's cloud CLIs

- The agent image bundles **terraform, `az` and `aws`** (pinned via `TERRAFORM_VERSION`/
  `AZURE_CLI_VERSION`/`AWS_CLI_VERSION` in `agent/Dockerfile`), so a session can manage
  infrastructure the same way it already manages GitHub through `gh`.
- They live in the `tooling` stage, so **every tier carries them and the CI scan covers them** — they
  are credential-bearing tools that talk to cloud control planes, which is the surface the Trivy gate
  exists for, unlike the build toolchains it skips. Cost: ~1.0 GB on every tier (az 628 MB + aws
  240 MB + terraform 96 MB — az and aws each vendor their own CPython).
- **Creds are the host's, reused through optional bind mounts** exactly like `~/.claude` and
  `~/.config/gh`; the image logs in as nobody and bakes no credential:
  - `/root/.aws` (or `AWS_*` env creds) — `aws`
  - `/root/.azure` — `az`
  - `/root/.terraform.d` — terraform, for a Terraform Cloud backend
- **A host that mounts none is a supported configuration, not an error.** `entrypoint.sh`'s preflight
  only LOGS which stores it found and never idles the container the way the claude preflight does — a
  missing `~/.azure` says nothing about whether the host can run sessions.
- It keys on a **login-marker file** (`~/.aws/credentials`, `~/.azure/msal_token_cache.json`,
  `~/.terraform.d/credentials.tfrc.json`), never on the store directory, because each CLI creates its
  own store just by RUNNING: `az version` alone writes a whole `~/.azure`, empty `azureProfile.json`
  included. The Dockerfile's build-time smoke test drops the stores it creates for the same reason —
  a baked store is one that exists on every host that mounts none.
- The preflight is a file check rather than `aws sts get-caller-identity`/`az account show`: those are
  slow (the aws one is a network round trip) and would tax boot on every host to report what the
  mount's absence already says. An expired token is the CLI's problem to report in-session.
- The guard's `permissions.deny` protects `~/.azure` and `~/.terraform.d` alongside `~/.aws`/`~/.ssh`
  — these stores are shared by every session on the box, so an agent editing one breaks the others.
- Tests: `agent/tests/test_entrypoint.sh` (the cloud-creds cases), `test_guard_settings.py`.

### The agent image's Android toolchain

- The images bundle the docker CLI, `gh`, ttyd, npm, and — in the agent image — a **JDK 17 + Gradle +
  Android SDK** toolchain, so agents can build and JVM-unit-test Android apps like `android/` out of
  the box: `gradle`/`sdkmanager`/`avdmanager`/`adb`/`aapt2` on PATH, pinned via `GRADLE_VERSION`/
  `ANDROID_CMDLINE_TOOLS`/`ANDROID_PLATFORM`/`ANDROID_BUILD_TOOLS` in `agent/Dockerfile`.
- **The image is tiered** (`AGENT_BASE`, documented at the top of that Dockerfile):
  - `:latest` is the `android-build` tier (2.0 GB) and carries no emulator or system image, because
    those cost 4.4 GB against a 0.6 GB build toolchain and nothing in CI or `android/` needs them —
    the client has 33 JVM unit tests and **zero** instrumented tests, and `android-ci.yml` runs
    `assembleDebug` + `testDebugUnitTest`.
  - To RUN an app, `adb connect` to a device or an emulator on a KVM-capable host (`platform-tools` is
    in the tier); that path is hardware-accelerated, unlike the bundled AVD, which needs the DockerOps
    compose to pass `/dev/kvm` (no stack does) and otherwise falls back to slow software rendering.
  - If you genuinely need an in-container AVD, `:emulator` (the `android` tier, 6.4 GB,
    `ANDROID_EMULATOR_TAG`/`ANDROID_EMULATOR_ABI`) is built on demand via `workflow_dispatch` on
    `agent-emulator-image.yml`.

### Where jobs run

**Every workflow runs on GitHub-hosted `ubuntu-latest`.** The home-lab box is 3 runners on one
t3.xlarge — a *concurrency cap of 3* at ~1.3 throttled vCPU each — against hosted's 20 concurrent
jobs at 4 dedicated vCPU, so self-hosting mostly bought queue time (PR gates were measured waiting
26 minutes to do 48 seconds of work).

- The image builds moved too. Their layer cache is `type=gha` — **GitHub-side, so it follows the job
  to a hosted runner**; the box's warm local docker cache was never what primed them. Adding
  self-hosted back for "the layer cache" would be reasoning from a cache these jobs don't use.
- Disk is the real constraint for the agent image, and it's handled in-job: the scan writes **one**
  image copy (build straight to a docker-archive, `trivy --input`) instead of three, scans the slim
  `tooling` tier, and both agent jobs delete the runner's ~25 GB of unused preinstalled toolchains up
  front. That reclaim is only safe because those builds are hermetic — **don't copy it into
  `android-ci.yml`, which builds against the runner's own Android SDK.**
- Hosted bills **rounded UP per job**, so prefer fewer batched jobs over many trivial ones. Public
  repos are free; private ones draw on the 2000 min/mo Free-plan pool.
- If a job ever genuinely needs self-hosted again (a >14 GB build, or home-lab network reach), say
  which in a comment on its `runs-on` — and bring back only the workarounds that job needs.

These are the constraints that went away with the box, and the steps they justified are **deleted,
not disabled** — reintroducing any of them is a regression:

- "Reset workspace ownership" steps — the box's workspace persisted and docker steps left root-owned
  files. A hosted runner is a fresh VM per job.
- Per-job `DOCKER_CONFIG` scoping — the box ran 3 runners as one user, so a concurrent job's
  `docker logout` wiped an in-flight job's ghcr.io credentials mid-push.
- `docker image prune` / `docker builder prune` cleanup — the box's disk was shared, finite, and
  outlived the job.
- Throwaway `node:24-alpine` containers for `npm view` — hosted has node/npm on PATH.
- The `mingc/android-build-box` container — the box couldn't pull ghcr.io and had no sudo, so a
  Docker Hub image was how the Android jobs got a JDK + SDK. Hosted preinstalls both; see
  `android-ci.yml`.

Still true, and unrelated to where jobs run: there's no GitHub Advanced Security, so there is no
code-scanning API — findings live in the job log and `--exit-code` is the gate (no SARIF upload).
Trivy is still installed from its release tarball to `$HOME/.local/bin` (the trivy-action pins an
internal step to a tag upstream deleted).

## Conventions

### Credentials

- All credentials are inline in environment variables (no Docker secrets mechanism) — this matches the
  DockerOps convention.
- The live secrets (`TURMA_TOKEN`, `TURMA_AGENT_TOKEN`, basic-auth, `FCM_SERVICE_ACCOUNT_JSON`) are
  set in DockerOps' `compose/turma-truenas.yaml`, not in this repo.

### Run-as identity (host permission parity)

- The container writes into bind-mounted HOST dirs — the git root (worktree checkouts, every file a
  session edits) and the Claude login (`~/.claude` transcripts/settings) — so the uid it runs as is
  the uid those files end up owned by on the host.
- `entrypoint.sh` therefore resolves an identity BEFORE anything starts and `setpriv`s down to it:
  **`PUID`/`PGID` if set, else auto-detected from the owner of `REPOS_ROOT`** — by definition the host
  user whose repos these are.
  - A root-owned git root (the TrueNAS stack) resolves to `0:0` and the container stays root exactly
    as before.
  - A user-owned git root (WSL/desktop, e.g. `/home/<user>/git`) resolves to that uid and the
    container drops to it, so nothing lands root-owned in the operator's own repo or `~/.claude`.
  - `PUID=0` forces the old always-root behaviour.
- Because it drops, the entrypoint also:
  - reuses an existing passwd/group entry for the id rather than creating one — the node base image
    already ships `node` at `1000:1000`, exactly where a desktop host user lands;
  - `chown`s `/root` (non-recursively — its children are the host's own bind mounts, already correctly
    owned host-side), since **HOME stays `/root`**, which every mount target and
    `PROJECTS_ROOT`/`~/.turma` path depends on;
  - joins the group owning `/var/run/docker.sock`, which root got for free and the `docker` CLI
    (device-name probe, log tail, hub-initiated restart) still needs;
  - **self-heals on boot**, `chown`ing any leftover `-uid 0` paths under `REPOS_ROOT`/`~/.claude` to
    the resolved id — files written by the pre-drop image are root-owned and the operator can no
    longer chown what they no longer own, so this is the only thing that clears them.
- That heal only ever touches uid-0 paths, so a mis-set `PUID` can misplace root-owned files but can
  never take the host user's own files away.
- Verified by building the entrypoint on the real base image and exercising root-owned/user-owned/
  `PUID`-override/`PUID=0` roots.

### How a session runs

- Each session runs as that identity (root on hosts whose git root is root-owned) as an interactive
  `claude --remote-control`.
- It defaults to `--permission-mode auto` (Claude Code's classifier-gated hands-off mode); the
  composer can instead pick `bypassPermissions`/`acceptEdits`/`plan`/`default`.
- `bypassPermissions` is refused **under root** unless `IS_SANDBOX` is set — set in the compose env. A
  host that drops to a non-root uid doesn't need it, but it's harmless left in place (and still
  required on the root-owned TrueNAS stack).
- It's deliberately the interactive form, not `claude remote-control` server mode: server mode's
  terminal is a QR/status lobby with no conversation, so the Turma's live terminal would have nothing
  to show or type into.
- Sessions are independent processes inside the one host container, so a session ending no longer
  restarts the container — the manager just marks it stopped. "Restart (clear context)" relaunches a
  single session's Claude in place.
- All of a host's sessions share the one mounted `~/.claude` login; distinct worktree paths give each
  its own project slug and Remote Control bridge pointer, so concurrent sessions don't collide.
  `MAX_SESSIONS` caps concurrency (shared-login contention + resources), and the manager staggers
  session launches slightly on boot.
- Agents connect purely outbound to the public `TURMA_URL` (the Cloudflare tunnel), so they work from
  any host/network, not just the hub's.

### Safety guard

- Because sessions run hands-off (`auto` by default, or `bypassPermissions`), every launch also passes
  `--settings` a generated file (`build_guard_settings()` in `hub-agent.py`, written once to
  `~/.turma/guard-settings.json`).
- That file wires a `PreToolUse` hook — `agent/hooks/guard.py`, stdlib-only, shipped to
  `/usr/local/bin/hooks/guard.py` — over Bash, plus `permissions.deny` rules protecting the host
  credential stores (`~/.ssh`, `~/.aws`, `~/.claude`, `~/.config/gcloud`; deny wins even under
  bypass).
- The guard inspects each Bash command and hard-denies only three narrow categories, each with a
  reason the agent self-corrects from:
  - **destructive** — whole-repo/host destruction: `rm -rf` of `/`/home/system/`.git`, disk wipes,
    fork bombs, power changes, recursive `chmod`/`chown` of system roots, protected-branch history
    destruction, `DROP DATABASE|TABLE`;
  - **policy** — push to / delete `main`/`master`, or `gh pr merge` (work lands via a PR a human
    merges);
  - **attribution** — AI self-attribution trailers in commit/PR messages.
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) is untouched.
- A specific destructive command can be allowlisted via `$TURMA_TOOL_GRANTS` (CSV of `Bash(<cmd>)`);
  attribution blocking toggles via `$TURMA_NO_ATTRIBUTION=0`.
- The guard fails open on malformed input, and if the settings file can't be written the session still
  launches (without the guard).
- Adapted from an equivalent guard hook maintained outside this repo; if you have that copy, keep
  the two in rough sync.
- Tests: `agent/tests/test_guard.py`, `test_guard_settings.py`.

### AskUserQuestion answer bridge

- The same generated `--settings` file wires a **second `PreToolUse` hook over `AskUserQuestion`** —
  `agent/hooks/ask.py`, stdlib-only, shipped to `/usr/local/bin/hooks/ask.py` — the glasses answer
  bridge.
- Claude's own `AskUserQuestion` picker is a TUI affordance the glasses client isn't attached to, so
  instead of scraping the tmux pane and typing a digit back (the old, unreliable path), the hook
  intercepts the tool call: for each question it writes `~/.turma/questions/<sessionId>.req.json`
  (keyed on the session id passed via `TURMA_SESSION_ID`/`TURMA_QUESTIONS_DIR` env, prefixed onto the
  `claude` command in `_launch_tmux`) and **blocks**, polling for the answer file the agent's
  `answer_question()` drops when the glasses answer arrives on the heartbeat.
- The collected answers are returned as a `PreToolUse` **deny** whose `permissionDecisionReason` is a
  `{kind:"askuserquestion_answers", answers}` JSON blob — deny-with-reason is the channel because a
  `PreToolUse` *allow* can't carry typed answer data, and Claude reads the answers out of the
  tool_result and proceeds.
- Because AskUserQuestion is serialized per session, req/ans files key on the session id alone (no id
  coordination).
- The hook's block timeout (`TURMA_QUESTION_TIMEOUT_SEC`, default 600s) sits under the settings-level
  `timeout` so it self-times-out (denying with a no-answer marker) rather than being killed mid-write.
- It passes through silently when its env vars are absent (the one-shot summary `claude`, or an
  operator running `claude` by hand).
- Kill/delete/restart clear any pending req/ans files so a dead question can't surface as a phantom.
- Tests: `agent/tests/test_ask.py`, plus the bridge cases in `test_hub_agent.py` (`TestHookQuestion`,
  `TestAnswerQuestion`) and `test_guard_settings.py`.

### New-work branching policy

- A session's checkout is only as fresh as the moment it started: a worktree is detached at
  `origin/<default>` as of SPAWN (`default_base_ref`, whose short-bounded `git fetch` falls back to a
  stale local ref when the remote is slow/offline), and a repos-root session works in the repo dirs
  themselves, on whatever branch the host last left checked out.
- So every launch (spawn AND resume) also passes **`--append-system-prompt`** a fixed directive —
  `NEW_WORK_SYSTEM_PROMPT` in `hub-agent.py`, appended in `_launch_tmux` — telling the agent to
  refresh the base ITSELF when it starts new work: `git fetch origin`, resolve the default via
  `refs/remotes/origin/HEAD`, and cut its branch from that **remote** ref rather than the current
  HEAD, carrying any uncommitted work across and flagging a stale base (rather than stalling) when the
  fetch fails.
- It's `--append-system-prompt` because settings.json has no field that carries instructions.
- It's a **directive rather than manager-side enforcement** because only the agent knows when "new
  work" begins, whether a fetch failure is worth retrying, and which of several repos it's about to
  touch.
- Tests: the branching-policy cases in `agent/tests/test_hub_agent.py` (`TestSessionLifecycle`).

### Session activity summaries

- Each session gets a few-word "name" describing its task (e.g. "Adding Compose Flag"), shown
  prominently on the session card.
- It's generated **agent-side**, once at spawn, from the session's initial task prompt by the
  container's already-authenticated `claude` in headless print mode (`claude -p`, Haiku by default) —
  reusing the mounted `~/.claude` login, so there's **no external API, key, or endpoint**.
- `_start_summary()` launches it as a detached subprocess (cwd = `~/.turma`, not the worktree, and no
  `--settings`, so it never loads the session guard or explores the repo).
- `_poll_summaries()` reaps it on later beats (never blocking the heartbeat), cleans the output
  (`clean_summary()`: first line, strip quotes/punctuation, cap to ~6 words), and stores it on the
  session record as `summary` (persisted; survives beats, restart, and resume).
- The hub just renders `s.summary` — no hub-side model call.
- Always on (no feature flag); tuned only by the optional `SESSION_SUMMARY_MODEL` (default `haiku`)
  and `SESSION_SUMMARY_TIMEOUT_SEC` (45) env vars.
- The claude.ai/code registered name (`rcName`) is still fixed at spawn — only the on-card summary is
  populated.
- Tests: `agent/tests/test_hub_agent.py` (`TestCleanSummary`, `TestCleanManualSummary`,
  `TestSetSummary`, `TestSessionSummaries`, `TestSummaryDue`, `TestFirstUserText`,
  `TestSeedSummaries`), the summary-endpoint cases in `turma/tests/server.test.js`, and the ⋯-menu
  cases in `turma/tests/sessions.test.js`.

#### Seeding from the transcript

- The naming attempt fires at spawn from the initial prompt, or — when a session is bare/quick-spawned
  with no initial prompt (the one-click spawn, the repos-root pseudo-repo) — from its **first user
  prompt read straight out of the transcript**.
- `_seed_summaries()` runs each beat: for every running, still-unnamed session it pulls the first
  genuine human prompt via `_first_user_text()` (skipping the transcript header, `isMeta` caveat
  entries, and `<command-…>` slash-command wrappers) and triggers `_start_summary`.
- The transcript read is the **channel-agnostic** naming path and the reason bare sessions now
  actually get named: a bare session's first prompt is almost always typed into the live ttyd
  terminal, which writes to the tmux pane and **never reaches `send_input`**, so the earlier
  `send_input`-only trigger missed the most common flow entirely — but every input channel (terminal,
  glasses/compose-bar `input`, resume) lands the prompt in the transcript, where `_seed_summaries`
  finds it.
- `send_input` still fires `_start_summary` immediately when a prompt does arrive that way — a fast
  path for the FIRST attempt only. Retries belong to `_seed_summaries`, which reads from the top of
  the transcript and so still names a session from its first prompt however many turns later a retry
  runs.

#### Bounded-retry naming

- Naming is **bounded-retry, not one-shot**: an attempt can come back with no name for reasons that
  have nothing to do with the session (a nonzero `claude -p` exit, an empty reply, the timeout, or a
  rate limit from the one login every session shares), and the original single attempt made those
  transient failures permanent — an arbitrary, patternless subset of cards showed the raw session id
  for life.
- `_summary_attempts`/`_summary_due` gate every path on *unnamed + attempts left + past the backoff*:
  up to `SUMMARY_MAX_ATTEMPTS` (3) tries spaced by a growing `SUMMARY_RETRY_BACKOFF_SEC` (90s ×
  attempt), counted in a persisted `summaryAttempts`/`summaryRetryAt` on the session record (armed at
  launch, so a manager restart mid-attempt neither loops nor loses the retries still owed).
- Retries are bounded and backed off rather than per-beat precisely because of that shared login — a
  few spaced tries cost little; re-summarizing every beat would eat the working sessions' rate limits.
- The legacy one-shot `summaryStarted` boolean is still written and is read as "one attempt spent"
  (not as a permanent gate), so sessions an older agent failed to name pick up their remaining
  retries.
- A session with no prompt yet (`_first_user_text` finds nothing) stays unnamed, spends **no** attempt,
  and looks again next beat. Once the attempts are exhausted it degrades silently to "no summary" and
  falls back to the label/worktree on the card.

#### Manual rename

- **The operator can also rename a session by hand**: the Sessions page's per-card ⋯ menu →
  `POST /api/agents/<host>/sessions/<id>/summary` → a `setSummary` command → `set_summary()`.
- The typed name goes through `clean_manual_summary()` (first line, whitespace collapsed, capped to
  `SUMMARY_MAX_CHARS` — but NOT word-capped or stripped of quotes/punctuation the way a model's chatty
  reply is; what a human typed is the name they meant) and is persisted like the auto one, surviving
  beats/restart/resume.
- It sets `summaryManual`, which pins the card: `_summary_due` already declines to name a session that
  has any name, and the flag additionally stops a still-in-flight `claude -p` job from clobbering it
  in `_finish_summary`.
- A blank rename clears the name (back to the label/worktree fallback) and unpins, which is the only
  way back to auto-naming.
- Renaming is presentational, so it works on a stopped session too.
