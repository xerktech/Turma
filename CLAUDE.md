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
- The session runs its own `claude --remote-control` in its own tmux (`agent-<id>`) + loopback ttyd,
  with an optional initial task prompt delivered as claude's positional prompt, and an optional
  `--model`/`--permission-mode` from the composer.
- Many sessions run concurrently (up to `MAX_SESSIONS`), including several on one repo via separate
  worktrees. Each registers in claude.ai/code as `<host>-<repo>-<worktree-or-label>`.
- All spawn options are validated agent-side (allowlisted base refs, fixed model/permission enums),
  so nothing free-form reaches the shell. The random worktree dir and `agent-<id>` tmux stay the
  canonical internal keys; a label is presentational only.

### Repos-root sessions

- Spawning against the repos-root pseudo-repo runs `claude` directly in `REPOS_ROOT` — spanning every
  repo — with **no worktree and no branch**, so the base-branch option doesn't apply and no worktree
  is ever added or removed for it. Kill/delete just tear down the processes; `REPOS_ROOT` and its
  repos are never touched.
- All root sessions share that one cwd (hence one claude project slug + Remote Control bridge
  pointer), so **at most one root session runs per host at a time** (enforced on spawn/start/resume).
- It's still killable/resumable like any session; its transcript persists under `REPOS_ROOT`'s
  project slug.

### Kill, resume, delete

- Sessions are spawned/killed/started/restarted/deleted from the hub.
- **Killing** a session removes it from the hub (registry record dropped) but KEEPS its worktree on
  disk (uncommitted work survives), its conversation, and its token-usage history. Transcripts live
  under `~/.claude/projects`, keyed by worktree path, separate from the worktree files.
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

### Commands

- `spawn` / `kill` / `start` / `restart` / `delete` — session lifecycle.
- `resume` — resume a killed session (keeps its id).
- `resumeTranscript` — resume ANY prior transcript by id; see the resume notes in the Session model
  above. `_resumable_report()` heartbeats each repo's resumable list.
  - Tests: `TestResumableReport`, `TestResumeTranscript`, `TestTranscriptCwd`.
- `input` / `history` / `answerQuestion` — for the glasses client.
- `interrupt` — stop the turn a running session has in flight.
  - `interrupt()` sends a single Escape to its tmux pane, exactly the key an operator at the live
    terminal would press, so claude cancels the current generation/tool call and drops back to its
    prompt with the session and conversation intact.
  - The gentle counterpart to kill/restart. Deliberately NOT gated on `paneBusy`, whose read is up to
    a beat stale by the time the operator clicks, while Escape into an idle pane is harmless.
  - Tests: `TestInterrupt`.
- `setSummary` — rename a session; see "Session activity summaries" under Conventions.
- `clone` — see "GitHub block and cloning" below.
- `refreshJira` — the /board page's manual refresh: re-poll Jira now instead of waiting out the slow
  `JIRA_REFRESH_EVERY` cadence. Re-checks `jira_configured()`, so an unconfigured host stays at zero
  Jira calls even if commanded.
- `prune` — per-repo cleanup: removes worktrees whose commits are merged into the latest default
  branch (skipping any still backing a session or holding uncommitted changes), then deletes local
  branches merged into it, reporting a summary that rides the heartbeat.
- `jiraIssue` — fetch one issue on demand; see "Jira block" below.
- `subagentHistory` — open a background subagent's own transcript; see "Live working footer and agent
  list" below.

### Heartbeat

- **Repo list**, ordered most-recently-active first: each repo's `lastActivity` is the later of its
  newest commit and its newest session activity. The repos-root pseudo-repo is pinned first and never
  ranked.
- **One record per session**: git state, per-session token usage, live-session signals (below), new
  PR links, and PR status (below).
- A **container-log tail**.

#### Live-session signals

- `paneBusy` — a working/idle read, and the **primary** activity signal.
  - `_pane_busy` captures the session's tmux pane and looks for Claude Code's "esc to interrupt"
    hint, which the TUI shows for exactly as long as the model is actively generating or running a
    tool, and which drops the instant the turn ends. So it stays accurate through a long silent tool
    call and flips idle immediately, unlike the transcript-mtime window.
  - `true`/`false`/`null`-unknown; marker set overridable via `TURMA_PANE_BUSY_MARKERS`.
  - All three surfaces fall back to transcript freshness only when it's `null` — i.e. an older agent,
    or an uncapturable/gone pane.
- **Transcript freshness** — now the fallback, not the primary signal.
- **Pending questions** — a pending `AskUserQuestion` is surfaced by the `agent/hooks/ask.py`
  PreToolUse bridge (see the Safety guard note under Conventions), which drops a
  `<sessionId>.req.json` under `~/.turma/questions/` while the tool call blocks. `session_report`
  reads it from there and the answer rides back as `<sessionId>.ans.json`, so there is no tmux-pane
  scraping. A transcript scan is a fallback for the already-answered case.

#### PR status

- The state (Open/Draft/Merged/Closed) + CI-check rollup (passing/failing/pending) of every PR a
  session opened.
- Fetched via `gh pr view` (`pr_status`/`_summarize_pr`/`_check_class`) on the
  `PR_STATUS_REFRESH_EVERY` cadence — faster than the github block, so a card's merge/CI state stays
  live.
- Cached by URL in `pr_status_cache` and attached as `session.prs`; kept even after the session
  stops, and None until it opens a PR.
- Tests: `agent/tests/test_hub_agent.py` (`TestPrStatus`, `TestRefreshPrStatus`).

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
- **Nothing is excluded** — every transcript on the box counts toward the host total.
- **This ledger is also the archive's input** (`_archive_manifest` enumerates ledger slugs), so
  reconciliation *intentionally* widens archival too: every ended session on the box, including
  synced dev-machine history, is shipped to and full-text-indexed in the hub's durable archive, not
  just Turma-managed ones. That coupling is deliberate (total history + search); decouple the two
  inputs only if archival scope should ever diverge from usage scope.
- Tests: `agent/tests/test_hub_agent.py` (`TestReconcileOrphanTranscripts`).

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

### `tunnel-agent.js`

- The reverse tunnel; the hub's `{open,port}` selects which per-session ttyd to bridge, over one
  per-host control channel.
- That channel also carries the **live transcript tail**: on the hub's `{watch,worktreePath}` /
  `{unwatch}` it tails just that session's newest transcript every ~1s and pushes `{tail,entries}`
  deltas straight back on the same control channel.
- It's a JS re-implementation of hub-agent.py's `transcript_tail`/`_entry_text`, kept parity-tested in
  `agent/tests/tunnel-agent.test.js`.
- Tailing runs only while a client is watching, so idle sessions cost nothing.

### Live working footer and agent list

- The same control channel also carries the session's **live working footer** scraped from the tmux
  pane (`parsePaneLiveTurn` → `{turn,text,status}`): the in-progress assistant text plus
  `status = {verb, up/down token counters, elapsed, hint}`.
- When Claude's agent-manager list is expanded below the input box, the footer also carries
  `status.agents[]` (`parseAgentList`: one `{sel,type,label}` row per live agent, i.e. `main` + each
  background subagent), so the hub pins the working indicator and lists the live agents.
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

The central dashboard for the per-host agent containers: https://turma.xerktech.com via the
Cloudflare tunnel; port 8300 on the LAN.

### Fleet tree (host → repo → session)

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
- Any **PR status** the session opened — a GitHub-style pill (state colour + `#number` + a ✓/✗/● CI
  check mark) from the agent's `session.prs`; `prBadgeHtml` builds it, with shared `.pr-badge` CSS in
  `app.css`.
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
- A per-session **verbosity control** (Concise/Normal/Verbose presets + per-type thinking/tool-calls/
  tool-outputs toggles, persisted in `localStorage`) filters which `blocks[]` components show — a pure
  client-side filter over the already-received buffer.
- Typed prompts go to `POST .../input`; pending `AskUserQuestion`s answer via option chips / custom
  text to `POST .../answer`.
- The compose footer's live agent-mode / model selectors are joined by a compact **PR status chip**
  (the session's latest PR, `prFooterChip` in `chat.js`, unit-tested in `chat.test.js`) when it has
  one.
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

#### Session card ⋯ menu

- Each sidebar session card carries a **⋯ overflow menu** in its top-right — a sibling of the card
  `<button>`, absolutely positioned over it, because a nested button is invalid HTML.
- **Rename…** swaps the card for an inline field that `POST`s the typed name to
  `.../sessions/<id>/summary`, painted optimistically since the rename only lands on the agent's next
  heartbeat (see "Session activity summaries" under Conventions).
- **Kill** arms-then-confirms in place like the chat/terminal bars.
- The menu's open/armed/typing state lives in page variables, not the DOM, because every beat
  re-renders the list.

#### Stop button

- Both the chat header and the terminal header carry a **◼ Stop** button that interrupts the turn the
  attached session has in flight (`stopCurrentSession` →
  `POST /api/agents/<host>/sessions/<id>/interrupt` → an `interrupt` command → the agent's Escape into
  the pane; see the agent bullet).
- Unlike the Kill beside it, Stop arms nothing and confirms nothing (it destroys no work — a turn
  stopped by mistake can just be re-asked) and leaves the session on the stage.
- The button acks locally for ~1.5s because the interrupt only lands on the agent's next heartbeat, so
  the pane's working/idle read won't reflect it for a beat or two.

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
- The hub pushes edge-triggered alerts to the self-hosted ntfy on topic `agents`: host
  offline/recovered, restart loop, daily cost threshold (from the host-level `usage.today.cost` so
  ended sessions still count, falling back to summing live sessions for older agents), per-session
  turn finished / question waiting / PR created.
- Every alert funnels through one `notify()` (`turma/server.js`).
- Alongside ntfy it **also fans out to registered mobile devices via FCM** (`turma/push.js`: HTTP v1,
  service-account JWT minted with `node:crypto`, no npm — enabled by `FCM_SERVICE_ACCOUNT_JSON`,
  no-op when unset like ntfy), carrying `tags`/`priority`/`click`/`route:{host,sessionId}` as message
  data so the Android client picks a notification channel and deep-links a tap.
- Devices register via `POST /api/devices` (user-authed, persisted to `/data/devices.json`),
  unregister via `DELETE /api/devices?token=`, and dead tokens are pruned on send.
- Tests: `turma/tests/push.test.js`, plus the device-registry cases in `server.test.js`.

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
- Built with Gradle (wrapper generated in CI, not committed); PR-gated by
  `.github/workflows/android-ci.yml` on the self-hosted runners inside a Docker Hub Android-SDK image.
- Setup + FCM wiring in `android/README.md`.

## `.github/workflows/`

GHCR image builds and PR gates — see Build & Deploy below.

## Build & Deploy

### Unified versioning

- The repo-wide `MAJOR.MINOR` lives in the root **`VERSION`** file (currently `0.1`).
- Every build pipeline appends its GitHub Actions `run_number` as the patch, yielding one full
  version per build (`VERSION.run_number`, e.g. `0.1.42`).
- Bump `VERSION` when you cut a new minor/major; the run number moves on its own.
- All the pipelines (agent image, turma image, glasses release, android release) read the same file,
  so their versions stay in lockstep.

### Image builds

- `.github/workflows/turma-agent-image.yml` builds `ghcr.io/xerktech/turma-agent` on any change under
  `agent/**`. Its version tag is the unified `VERSION.run_number` semver.
  - The bundled Claude Code release is still pinned into the build via the `CLAUDE_CODE_VERSION`
    build-arg (so the image contents can't drift), but it is **not** part of the version — it's
    resolved only to feed that build-arg and never appears in a tag or label.
- `.github/workflows/turma-image.yml` builds `ghcr.io/xerktech/turma` on any change under `turma/**`,
  tagged with the same `VERSION.run_number` semver.
- These push `:latest` (images) / a `VERSION.run_number` versioned tag / `:sha-<sha>` (images), a
  `glasses-v<VERSION.run_number>` release tag, or an `android-v<VERSION.run_number>` release tag (the
  APK — `android-release.yml`, post-merge on `android/**`, a debug-signed sideload APK built in the
  same Docker Hub Android-SDK container as the CI gate).
- Watchtower keeps `:latest` current on the host.
- The DockerOps `compose/turma-truenas.yaml` references `ghcr.io/xerktech/turma-agent:latest` — keep
  that image ref in sync if you ever rename it here.

### Deployment (DockerOps, not here)

- `compose/turma-truenas.yaml` defines the `turma` service and a single per-host `agent-host`
  container: mounted at `REPOS_ROOT`, `MAX_SESSIONS`/`TTYD_PORT_BASE`, host mounts, the shared
  `TURMA_TOKEN`/`TURMA_AGENT_TOKEN`, ntfy publisher creds, basic-auth.
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
  `assembleDebug` inside a Docker Hub Android-SDK container (the release counterpart is
  `android-release.yml`).

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
    `turma-agent-image.yml`.

### Self-hosted runner constraints

**All workflows run on the home-lab self-hosted runners** (`runs-on: [self-hosted, linux]`).
Constraints that shape the jobs (established in the sibling SwitchBoard repo):

- Every job starts with a "Reset workspace ownership" step — Docker steps leave root-owned files on
  the persistent runner.
- No passwordless sudo, so CLI tools (hadolint, Trivy) are installed to `$HOME/.local/bin` +
  `$GITHUB_PATH` rather than via their Docker/ghcr actions.
- The runner can't authenticate to ghcr.io for pulls (Docker Hub pulls and authenticated ghcr
  **pushes** work).
- There's no GitHub Advanced Security, so there is no code-scanning API — findings live in the job log
  and `--exit-code` is the gate (no SARIF upload).
- `npm` isn't on the runner, so the Claude Code version lookup runs in a throwaway `node:24-alpine`
  container.

## Conventions

### Credentials

- All credentials are inline in environment variables (no Docker secrets mechanism) — this matches the
  DockerOps convention.
- The live secrets (`TURMA_TOKEN`, `TURMA_AGENT_TOKEN`, basic-auth, ntfy) are set in DockerOps'
  `compose/turma-truenas.yaml`, not in this repo.

### Run-as identity (host permission parity)

- The container writes into bind-mounted HOST dirs — the git root (worktree checkouts, every file a
  session edits) and the Claude login (`~/.claude` transcripts/settings) — so the uid it runs as is
  the uid those files end up owned by on the host.
- `entrypoint.sh` therefore resolves an identity BEFORE anything starts and `setpriv`s down to it:
  **`PUID`/`PGID` if set, else auto-detected from the owner of `REPOS_ROOT`** — by definition the host
  user whose repos these are.
  - A root-owned git root (the TrueNAS stack) resolves to `0:0` and the container stays root exactly
    as before.
  - A user-owned git root (WSL/desktop, e.g. maxai's `/home/mhabeeb/git`) resolves to that uid and the
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
- Ported from the sibling SwitchBoard repo (`worker/hooks/guard.py`); keep the two in rough sync.
- Tests: `agent/tests/test_guard.py`, `test_guard_settings.py`.

### AskUserQuestion answer bridge

- The same generated `--settings` file wires a **second `PreToolUse` hook over `AskUserQuestion`** —
  `agent/hooks/ask.py`, stdlib-only, shipped to `/usr/local/bin/hooks/ask.py` — the glasses answer
  bridge (modeled on the sibling ClaudeHUD broker's `claude-hook.mjs`).
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
