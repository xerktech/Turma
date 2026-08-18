# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Where the instructions live

This file is loaded into **every** session on every host. Component detail lives in
`.claude/rules/*.md`, each scoped with `paths:` frontmatter so it loads only when Claude touches
that component's files.

| File | Loads when Claude touches | Covers |
|------|---------------------------|--------|
| `CLAUDE.md` | **always** | repo purpose, session model, cross-cutting contracts, conventions, deploy |
| `.claude/rules/agent.md` | `agent/**` | `hub-agent.py` process model, commands, heartbeat, live-session signals, summaries, transcript blocks, archive |
| `.claude/rules/agent-workflows.md` | `agent/hub-agent.py` | workflow runs: run-dir layout, resolving a `workflow` row, journal/label reads |
| `.claude/rules/agent-board.md` | `agent/hub-agent.py` | Jira/ADO collectors, tracker writes, repo triage, ticket sessions |
| `.claude/rules/agent-usage.md` | `agent/hub-agent.py`, `agent/hooks/statusline.py` | token aggregates, attribution ledger, subscription limits + probe |
| `.claude/rules/agent-prs.md` | `agent/hub-agent.py` | PR/MR status + ledgers, `_scan_pr_line` attribution, GitLab/ADO dispatch, comment + conflict replies |
| `.claude/rules/agent-tunnel.md` | `agent/tunnel-agent.js` | reverse tunnel, control-channel liveness, live pane footer |
| `.claude/rules/agent-hooks.md` | `agent/hooks/**` | guard hook, AskUserQuestion bridge |
| `.claude/rules/agent-image.md` | `agent/entrypoint.sh`, `agent/Dockerfile` | container boot, start-time Claude Code check, bundled toolchains |
| `.claude/rules/agent-native.md` | `agent/native/**` | non-Docker install, launcher, updater |
| `.claude/rules/turma.md` | `turma/**` | chrome, org filter, dashboard, history, archive, notifications, auth |
| `.claude/rules/turma-limits.md` | `turma/server.js` | connection cap, in-flight body budget, lanes, reclaim, drain |
| `.claude/rules/turma-board.md` | `turma/public/board.*`, `turma/server.js` | Kanban, ticket panel, routing, auto-start/stop |
| `.claude/rules/turma-ticket-queue.md` | `turma/public/board.*`, `turma/server.js` | the hub's ticket queue: admission, drain, expiries, caps |
| `.claude/rules/turma-sessions.md` | `turma/public/sessions.html`, `chat.js` + their tests | the Sessions page, chat engine, live tail, composer, terminal |
| `.claude/rules/android.md` | `android/**` | Kotlin client, page→screen map, in-app update |
| `.claude/rules/glasses.md` | `glasses/**` | G2 client |
| `.claude/rules/release.md` | `.github/**`, `VERSION`, Dockerfiles | releases, PR gates, image tiers |

### Editing these files

- **Every one of them MUST stay under 40,000 characters** — Claude Code's own threshold, above which
  it prints `⚠ Large CLAUDE.md will impact performance (Xk chars > 40.0k)` at startup and adherence
  drops. **CI enforces it** (`Instruction file size limits` in `code-scan.yml`, path-filtered to
  `CLAUDE.md` and `.claude/rules/**` so a docs-only PR still runs it). Check locally with `wc -m
  <file>` (`-m`, not `-c` — these files are full of multibyte glyphs).
  - There is **no hard truncation limit**: Claude Code loads a CLAUDE.md in full at any length. The
    cost of a large file is context tokens and weaker adherence, which is what the ceiling protects.
    A ceiling stated as a truncation cliff was wrong; do not restore that framing.
  - **When a file approaches the ceiling, split it by path into another rules file** — that is the
    remedy, not raising the number and not deleting rationale. `agent-board.md`, `agent-prs.md`,
    `turma-board.md` and `turma-sessions.md` exist for exactly that reason.
- **Put a fact in the narrowest file that always sees it.** Component detail → that component's
  rules file. A rule spanning two components → "Cross-cutting contracts" below, since a
  `paths:`-scoped file does not load when Claude works on the other side of the contract.
- `paths:` matches the files Claude **reads**, so scope a rule to the sources it governs (and their
  tests), not to a directory that happens to contain them.
- One idea per line, wrapped at ~100 characters; nested bullets and headings, not run-on paragraphs
  — a single multi-kilobyte line conflicts every open PR.
- When adding to a component, add a **new bullet** rather than extending an existing one.
- **Document current behavior, not its history.** State the rule and the one-line reason it must not
  be undone — don't narrate the bug it replaced, retell the symptom, or make the same point twice. A
  decision that supersedes an old one **replaces** that text; it does not append beside it.
- **Cut narration, keep invariants.** Anything derivable by reading the code (call sequences, field
  lists, feature tours) does not belong here. What belongs: pitfalls, rationale, and rules that a
  reasonable change would otherwise undo. Keep `Tests:` pointers to file + test-name.

## What This Repo Is

Turma is the source and CI for the Claude Code agent fleet used with the TrueNAS-based home lab: a
**one-container-per-host** agent image that scans a git root and multiplexes many worktree-backed
Claude Code Remote Control sessions, plus a central dashboard ("turma") that lists each host's
repos, spawns/kills those sessions, and monitors them.

It builds two images and pushes them to GHCR; the running stack comes from the sibling **DockerOps**
repo (`compose/turma-truenas.yaml`, via Portainer GitOps).

## Session Model

One agent container per host, multiplexing sessions across every repo it scans.

### Hosts, repos, spawning

- Mounted at a git root (`REPOS_ROOT`), scanned one level deep for git repos, plus a **repos-root
  pseudo-repo** (`ROOT_REPO_NAME`, "⌂ Repos root").
- A **session** is backed by a randomly-named git worktree (dir keyed on the session `<id>`) under
  `REPOS_ROOT/.turma/worktrees`, checked out **detached HEAD** off the latest default branch
  (`origin/HEAD` → main → master), best-effort fetched; the composer can override the base.
- **The app creates no branch of its own.** The running agent creates and names its own branch when
  ready; that live branch (read from the worktree's git HEAD) shows on the session card, "detached"
  until then. A ticket session is told its branch NAME but still cuts it itself, so the worktree
  stays detached.
- Each session runs its own `claude --remote-control` in its own tmux (`agent-<id>`) + loopback
  ttyd. Many run concurrently (up to `MAX_SESSIONS`), several per repo via separate worktrees, each
  registering in claude.ai/code as `<host>-<repo>-<worktree-or-label>`.
- All spawn options are validated agent-side (allowlisted base refs, fixed model/permission enums),
  so nothing free-form reaches the shell. The worktree dir and `agent-<id>` tmux are the canonical
  internal keys; a label is presentational only.

### The session queue (XERK-14)

- A spawn that can't run RIGHT NOW is **queued, not refused** — an ordinary registry record with
  `status:"queued"` and no worktree/tmux/ttyd yet. `spawn()` splits into the record-build and
  `_provision_session()`, which a queued session later runs unchanged. Prompt/base-ref stash as
  `_pendingPrompt`/`_pendingBaseRef` for it to consume.
- Three orthogonal `queuedReason`s, each re-checked by the drainer: **capacity**,
  **awaiting-clone**, **root-busy**. Surfaced as `session.queuedReason`/`queuedAt`.
- The queue/run decision is made BEFORE the record is appended, so counts exclude the session being
  added (else a root sees itself as root-busy and capacity is off by one).
- `_drain_queue()` runs every heartbeat, oldest-first, **at most one per beat** (provisioning
  launches claude against the one shared `~/.claude` login), head-of-line skipped not blocking. A
  failed on-demand clone fails the session; a clone job lost to a restart re-triggers from
  `awaitCloneOwner`.
- Capacity rides the heartbeat as `capacity` = {maxSessions, running, queued, free, rootRunning}
  (`_capacity_payload`); `free` never goes negative.
- Queued sessions are killable (nothing to tear down); resume-on-boot skips them (the drainer picks
  them up), as do archival/usage/PR scans.
- **The agent queue is for spawns whose HOST is already the decision** — an explicit "+ New session"
  on the host whose card was clicked, and a ticket session waiting on its repo to finish cloning.
  **A ticket spawn waiting for a SLOT is not one of those**: it waits in the hub's ticket queue
  (below), so a host takes one only when it can start it. One can still land here if a host fills
  between the hub's capacity read and its next beat — a race, not the normal path.
- Tests: `TestSessionLifecycle`, `TestSpawnTicket` in `test_hub_agent.py`; `sessions.test.js`.

### The hub's ticket queue (XERK-296)

- **Work waiting for a slot is a QUEUED TICKET on the hub, never a created session on a host**, and
  **its host is chosen at DISPATCH** — so whichever of an org's agents frees a slot first takes the
  oldest waiting ticket. A queued ticket has no session id, no worktree and no host.
- It rides `/api/agents` as top-level `ticketQueue` + its own SSE event, the ONLY place a waiting
  ticket exists; `DELETE /api/jira/<siteKey>/<issueKey>/session` cancels one and can never touch a
  running session. Mechanics and the routing rules are in `.claude/rules/turma-ticket-queue.md`.

### Repos-root sessions

- Run `claude` directly in `REPOS_ROOT` — spanning every repo — with **no worktree and no branch**,
  so the base-branch option doesn't apply. Kill/delete tear down only the processes; `REPOS_ROOT` is
  never touched.
- All root sessions share that one cwd (hence one claude project slug + Remote Control bridge
  pointer), so **at most one root session runs per host at a time** (enforced on
  spawn/start/resume).
- That ONE slug dir accumulates EVERY root session's transcript, which is why the pin below exists.

### Which transcript is a session's

- Every launch **pins claude's session id** — `--session-id <uuid4>` minted in `_launch_tmux`, or
  the `--resume` id for a rejoined one — persisted as `claudeSessionId`, so a session's conversation
  is `<claudeSessionId>.jsonl` under its cwd's project slug, known by name before its first byte.
- `_session_transcript_path()` is the one resolver every surface goes through; the hub heartbeats
  the id so `tunnel-agent.js`'s live tail agrees. **Never go back to a newest-mtime rule** (XERK-6):
  a root session's dir holds every root session's transcript, so the newest is the PREVIOUS
  session's until the new claude writes.
- **A pinned session with no transcript on disk resolves to nothing.** Never add a newest-mtime
  fallback — an empty conversation before the first turn is the truth. A session launched by an
  agent predating the pin carries no id and keeps the newest-mtime rule.
- A watch is sent once and held, so `rearmMovedWatches` re-sends it when a watched session's
  `transcriptId` moves. Only "Restart (clear context)" moves it; without the re-arm that session's
  chat freezes on the pre-restart conversation.
- Two things stay slug-keyed, sharing one identity across a root session's neighbours: archival's
  `_running_slugs` exclusion and the summary/date an archived transcript inherits
  (`_session_meta_by_slug`).
- Tests: `TestRootSessionIsolation`, `sessionTranscript` in `tunnel-agent.test.js`,
  `server.test.js`.

### Kill, resume, delete

- **Killing** drops the registry record but KEEPS its worktree (uncommitted work survives),
  conversation and token-usage history, moving it to the Sessions page's **Ended sessions** list.
- `_remember_closed` **snapshots onto the closed record** the `prUrls` this session opened and its
  `transcriptId`; `_forget_session_caches` drops both moments later, so that snapshot is the only
  thing keeping an ended session's PR chips reachable.
- The closed history is a **cache of what a kill knew, not the record that it happened**, capped at
  `CLOSED_PER_REPO` per repo. **Anything that must survive belongs on the durable side** — the
  transcripts under `~/.claude` (which `_resumable_report()` re-derives from), the hub's archive,
  and `~/.turma`.
- **`~/.turma`'s durability is the HOST's to provide, and no code here may assume it.** A container
  must bind-mount it or it is the image's writable layer, recreated on update; every ledger still
  reconciles from disk rather than trusting itself.
- Resuming relaunches `claude --resume <transcript id>` **cwd'd at that transcript's origin path**,
  re-creating a deleted/pruned worktree there first: Claude scopes id lookup to a repo's live
  worktrees + repo dir, so the origin must exist for `--resume` to resolve. A dev-machine session
  synced through the shared `~/.claude` has a foreign cwd and stays view-only.
- **Delete** (on a stopped session) also removes the worktree; since the app owns no branch, any the
  agent committed survives.

### Migrating a session to another agent (XERK-101)

- **Move a running session to another agent in the SAME org.** The conversation moves; committed
  work rides git; uncommitted work stays on the source (KILLED, so resumable).
- The hub can't touch a worktree and agents are outbound-only, so a migration is composed hub-side
  from agent commands + a hub-brokered relay of the **RAW transcript bytes** (what `claude --resume`
  needs and the archive lacks): `exportSession` packs the transcript (+ `subagents/`, truncated to
  its last complete line) and POSTs the gzip-tar to `POST /api/agents/<host>/migrations/<id>/blob`,
  queueing `importSession` on the target (recording `importCmdId`); the target reporting up
  (`spawnCmdId` == `importCmdId`) makes `advanceMigrations` KILL the source and finish.
- Hosts may mount `REPOS_ROOT` at DIFFERENT paths, so `import_session` first
  `_localize_migrated_cwd`s the source's worktree path onto THIS host's `REPOS_ROOT` (the
  `.turma/worktrees/<repo>/<dir>` tail is mount-independent) — both the unpack slug and the
  re-created worktree use that local cwd, and without the remap a cross-mount move wedges in
  `importing` forever.
- The tar extract guards against `..`/absolute members — untrusted, it crosses a host boundary.
- **A migrated session keeps its PR chips**, re-derived from the transcript rather than carried in
  the command: the per-beat scan PRIMES a resumed transcript's byte offset to EOF, so `gh pr create`
  events sit past it. `_resume_at_cwd` (shared with `resume_transcript`) calls `_seed_prs` once at
  launch to scan the whole transcript, keyed by the PRESERVED transcript id. Idempotent.
- Blob relay is agent-authed; `POST .../sessions/<id>/migrate {host}` validates same-org + online +
  repo-cloned + running/non-root/has-conversation, single-flight per session. State is in-memory; a
  hub restart mid-move aborts it, leaving the source intact. **The target must already have the repo
  cloned** (v1).
- **The bundle NEVER rides in the hub's heap** (XERK-263): the relay spools it to `MIGRATE_SPOOL_DIR`
  (`/data/migrations`) and streams it back out, so a 65 MiB move costs a hub capped at 256 MiB a
  buffer rather than a quarter of its memory. The record keeps only the path/size; every settle,
  timeout and failure unlinks it, and boot sweeps the dir (nothing there outlives a restart usefully).
  `MIGRATE_INFLIGHT_MAX` bounds the disk that burst can hold — refused where a move STARTS, since the
  agent's upload is best-effort with no retry and refusing THAT strands the migration.
- Tests: `TestMigrateSession`, `server.test.js`, the Move cases in `sessions.test.js`,
  `eligibleMoveTargets` in android `SessionsTest`.

### A refused session start is REPORTED, never just logged (XERK-265)

- **A command is ACKed whether the agent ran it or declined it**, so a refusal the agent only
  `log()`s is indistinguishable from a slow spawn: the move sat in `importing` until
  `MIGRATE_TIMEOUT_MS` and failed with no reason, and the Sessions page spun out `SPAWN_FOLLOW_MS`.
- Every refusal in `_resume_at_cwd`, `import_session` and `export_session` therefore goes through
  **`_refuse_start`**, staging `{cmdId, migrationId, error}` onto the beat's **`spawnFailures`** with
  the same held-across-a-failed-POST lifecycle as `ticketStatusResults`. The `error` is
  operator-facing — it is what the UI and the migration record show.
- Hub-side `ingestSpawnFailures` caches it per cmdId as **`spawnRefusals`** (served with the record,
  NOT stripped like the other caches — the client following that spawn is who needs it) and stamps
  `m.refusal`, which `advanceMigrations` applies **after** its handoff check, so a success always
  wins the tie. Absent = "that agent can't tell", i.e. the old timeout wait, on both halves. The
  Sessions page mirrors that order: the session lookup runs first and clears `pendingSpawn`.
- **Both handles are checked against what the HUB knows, never taken on the agent's word** — the
  migrationId against that move's own src/target, the cmdId against the queue that host was actually
  given. All agents share one token, so unchecked either one lets any host fail another host's move
  or end its spawn wait with arbitrary text.
- **The reason is length-capped at both ends** (agent `SPAWN_FAILURE_REASON_MAX`, hub
  `SPAWN_FAILURE_ERROR_MAX`). It interpolates exception text, and `spawnRefusals` is the first
  served cache that `agentRecordSize` COUNTS while the ceiling check runs BEFORE the ingest: one
  unbounded reason lands, pushes the record past `AGENT_RECORD_MAX`, and then 413s every later beat
  from that host — including the ones that would have swept it (XERK-235's failure class).
- A refusal with neither handle stays a log line: the id being rejected IS the correlation.
- **Every refusal on a session-creating path is expected to go through it**, including `resume()`'s
  — the prune handshake (`_claim_worktree`, XERK-256) is the one this exists for, and it is ordinary
  timing rather than operator error. A new refusal that only `log()`s re-opens the bug.

## Cross-cutting contracts

Rules spanning more than one component, so no `paths:`-scoped file can carry them alone.

- **Web UI ⇄ Android parity (XERK-30).** The mobile web UI (`turma/public/`) is the source of truth;
  the Android app must match it. **A PR that changes user-facing behavior in `turma/public/` must
  carry the matching change to `android/` in the same PR** — or, if out of scope, add a line to
  `android/PARITY.md` and say so in the PR. An unlisted, unmentioned divergence is what this rule
  exists to stop. "User-facing" = a control, screen, state, chip, interaction, or layout a person
  sees or touches; pure server/agent plumbing is exempt. Page → screen map in
  `.claude/rules/android.md`.
- **`readyForReview` has FIVE mirrors that must agree**: `turma/public/sessions.html`,
  `turma/server.js`, `android/…/core/Sessions.kt`, `glasses/src/sessions.ts`, and veiller's fork of
  it. Changing the rule means changing all five.
- **"Working" is `paneBusy` OR live background agents** (XERK-245), in every mirror of the read
  (those five plus `turma/public/index.html`). A session that delegates work ENDS ITS OWN TURN: the
  pane drops the interrupt hint, so `paneBusy` says False while an agent it launched keeps going —
  which read idle everywhere AND qualified as ready-for-review, buzzing the operator mid-run. The
  session's `agents[]` is the second input; it sits BEHIND the offline and no-transcript gates,
  exactly like `paneBusy`, and an absent field means "that agent can't tell", never "no agents".
  **It comes from the TRANSCRIPT** (`_scan_agent_entry`: `agentId:` on launch, `<task-notification>`
  on stop), never from the TUI's footer rows — those are forgeable pane content and linger ~24s past
  completion, so they cannot answer "is one running right now".
- **`turma/public/board.js` has FIVE mirrors of its column rule** (`categoryOf` /
  `REVIEW_STATUS_RE`), and changing it means changing all five: the source, its **two
  byte-identical vendored copies** (`glasses/src/vendor/board.cjs`, `veiller/src/ui/vendor/
  board.cjs` — each asserted by that client's own `vendor.test.ts`, and `veiller-ci` is
  path-filtered on the SOURCE so a one-sided edit fails there, not here), and the two ports,
  `_board_column` in `hub-agent.py` and `categoryOf` in android's `core/Board.kt`. The agent
  resolves a dropped column against its OWN read, so a drift silently refuses valid drops. Tests:
  `TestBoardColumn`, `board.test.js`, `BoardTest.kt`.
- **`hub-agent.py` ↔ `tunnel-agent.js` are a parity contract** for everything both parse:
  `_entry_blocks`/`entryBlocks`, `_entry_text`, `transcript_tail`, `_busy_from_capture`/
  `paneShowsBusy`, `_fold_queue_op`/`foldQueueOp`, `_send_user_file_detail`/`sendUserFileDetail`.
  Both live in `agent/`; parity-tested in `tunnel-agent.test.js`.
  - **`device_name`/`deviceName` + `_usable_hostname`/`usableHostname` are on that list too.** They
    must resolve the SAME name: `openChannel` keys `controlChannels` by it, so a tunnel and a
    manager under different names is a host whose commands work while its terminal, live tail and
    heartbeat poke are dead — and a ghost card `DELETE` cannot reach. `entrypoint.sh` exports an
    operator-set `DEVICE_NAME` to both processes unvalidated, so an env-path divergence is the one
    that bites. Tests: `TestDeviceName`, `usableHostname`/`deviceName` in `tunnel-agent.test.js`.
- **The heartbeat is the wire contract** between `hub-agent.py` and `turma/server.js` (and through
  it every client). A field older agents don't send must degrade, never break: clients gate on the
  capability flag the agent reports (`inputMaxChars`, `uploadMaxBytes`, `github.available`,
  `capacity`), and an absent flag means "that agent can't do it", not "unlimited".
  - **A full `/api/agents` decode is ATOMIC on Android**, so one host's wrong-typed field throws for
    the whole array — the poll fails silently while the app keeps its last snapshot and the tile
    still says "N / N online". Per-agent SSE events decode individually, so the bad host is simply
    missing from the list while SSE is healthy; with SSE down too, the raw decoder exception
    replaces the screen. **Most of the payload is served raw**, so this is a live hazard, not a
    solved one: grep `normalize`/`sanitize` in `turma/server.js` for what is actually covered rather
    than trusting a list here, which has been wrong repeatedly.
  - **A field becomes decode-fatal the moment a client TYPES it** — until then `ignoreUnknownKeys`
    skips it and any value is harmless. So typing one on `SessionInfo`/`AgentInfo` and adding its
    hub-side coercion are the SAME change; `normalizeRecord` is where it goes, and it runs on both
    the heartbeat ingest and the `state.json` restore (a restart is when a coercion ships, and the
    restore is the first thing it serves). Coerce to the "can't tell you" value every client already
    handles, never to a plausible default. A `normalize*` is a WHITELIST — a sub-key a newer agent
    adds is dropped fleet-wide unless it is added there too.
- **A hub refusal must reach the operator, in the hub's own words** (XERK-264). The hub refuses
  commands with a status and a JSON `{error}` body (409 org mismatch / unsupported agent, 503 host
  offline, 404 stale attachment, 413 too long, 429 queue full); a client that reads the body and
  ignores `res.status` shows a refused kill/rename/spawn as one that worked.
  - Web: `post()`/`del()` (both pages) resolve **null on a refusal, having already toasted**
    `TurmaNav.refusalText`, and callers roll back whatever they painted optimistically on that null.
    `TurmaNav.toast` (nav.js, `.toast` in app.css) is the ONE failure surface — nothing announces
    success through it, so a toast on screen always means a command did not run.
  - Android: `hubErrorMessage` reads the `{error}` off an `HttpException` **or** a typed `Response`;
    `FleetViewModel.run`/`ChatViewModel.report` word the snackbar from it and drop the optimistic
    pending row. `/history` refusals are `HistoryResult.Failed`, never `Pending` — polling can't fix
    a refusal, and folding them together burned 60s and then said nothing.
  - Both fall back to "the hub answered HTTP `<n>`", worded identically on purpose.
- **An agent's HOST is proved by its credential, never by what it types** (XERK-268). Every
  agent-authed surface names the host it acts as — the `<host>` segment, the heartbeat's `device`,
  the tunnel's `?name=` — and each agent runs on its OWN token,
  `<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>`, which the hub re-derives against the host
  that was named. **The token NAMES its host on purpose**: an HMAC can't be inverted, so a bare
  digest could only be checked once the host was known, and `/api/heartbeat` — whose host is buried
  in a 32 MiB body — would have had to admit any bearer before reading it.
  - **Scoping a route to a host is not a security check on its own.** Under one fleet-shared token
    `<host>` was self-asserted, so `m.srcHost !== host` refused a caller naming ITSELF and passed one
    naming the victim; `device` was the same, so any token-holder could beat as another host and be
    handed the commands queued for it. Both halves — the scope AND the binding — or neither is worth
    stating. Never write a comment claiming a `<host>` compare keeps one agent out of another's data
    without checking the credential is bound.
  - That is also why a **per-relay one-time secret is not the fix** and must not be re-proposed: it
    would ride on exactly the commands an impersonated heartbeat hands out.
  - The master still authenticates as `legacy` so a fleet mid-rollover keeps beating;
    **`TURMA_AGENT_STRICT` retires it**, and the hub warns at boot until it is set. Detail in
    `.claude/rules/turma.md`; the agent needs no code change, only the right `TURMA_TOKEN`.
- **The hub's memory ceilings are FRACTIONS OF ITS CONTAINER LIMIT, never fixed numbers**
  (XERK-258, XERK-273). It runs at `mem_limit: 256m`, so a flat constant larger than that can never
  refuse anything before the OOM killer fires — which is how a flat 128 MiB upload ceiling and an
  unbounded socket count each killed the fleet's whole control plane, `restart: unless-stopped`
  looping the outage. `containerMemoryLimit()` reads the cgroup; everything derives from it and is
  logged at boot. Raising `mem_limit` in DockerOps widens them with no code change. The mechanics
  are in `.claude/rules/turma-limits.md`; what spans components is here:
  - **413 and 503 mean opposite things and must not be collapsed**: 413 is "your body is too big,
    send less", 503 is "the hub is momentarily full, send it again". Every `readRawBody` caller has
    to draw the distinction itself — both did answer a flat 413 once. On a 503 the migration relay
    HOLDS the migration in `exporting`, and `_migration_upload` retries (5xx only, never 4xx);
    nothing else would, and a lost bundle strands the move.
  - **An OVERSIZE body is deliberately NOT refused on its declaration.** Refusing early makes Node
    close the connection under a request still being written, and a client that writes before
    reading — python urllib, which is what `hub-agent.py` posts with — loses the response and sees a
    socket error. That is exactly XERK-235's offline loop, so this is an agent-facing contract, not
    a hub detail: test agent refusals with urllib, never with fetch.
  - **Known gap (XERK-287): held UPLOADS are a budget of their own, outside the in-flight ceiling**,
    so the true worst case is `in-flight + uploads` — 192 MiB of a 256 MiB container — and the flood
    row OOMs once attachments are staged beside it. Closing it is a sizing decision with
    user-visible cost (the upload relay, `HEARTBEAT_MAX`, or `mem_limit`), not a code fix.
- **A carried-forward feature needs its Android port or a `PARITY.md` line**; `android/PARITY.md` is
  the living gap tracker, updated whenever a gap closes or knowingly opens.

## Conventions

### Credentials

- All credentials are inline in environment variables (no Docker secrets mechanism), set in
  DockerOps' `compose/turma-truenas.yaml`, never here.

### Run-as identity (host permission parity)

- The container writes into bind-mounted HOST dirs — the git root and the Claude login (`~/.claude`)
  — so the uid it runs as is the uid those files end up owned by on the host.
- `entrypoint.sh` resolves an identity BEFORE anything starts and `setpriv`s down to it: **`PUID`/
  `PGID` if set, else auto-detected from the owner of `REPOS_ROOT`**. A root-owned git root
  (TrueNAS) resolves to `0:0`; a user-owned one (WSL/desktop) drops to that uid, so nothing lands
  root-owned in the operator's repo or `~/.claude`. `PUID=0` forces always-root.
- Because it drops, the entrypoint also reuses an existing passwd/group entry for the id (the node
  base image ships `node` at `1000:1000`); `chown`s `/root` **non-recursively** (its children are
  the host's own bind mounts) since **HOME stays `/root`**, which every mount target and
  `PROJECTS_ROOT`/`~/.turma` path depends on; joins the group owning `/var/run/docker.sock`; and
  **self-heals on boot**, `chown`ing leftover uid-0 paths under `REPOS_ROOT`/`~/.claude`.
- That heal only ever touches uid-0 paths, so a mis-set `PUID` can misplace root-owned files but
  never take the host user's own files away.
- Verified by building the entrypoint on the real base image against root-owned / user-owned /
  `PUID`-override / `PUID=0` roots (`test_entrypoint.sh`).

### How a session runs

- Each session runs as that identity as an interactive `claude --remote-control`, defaulting to
  `--permission-mode auto`; the composer can pick
  `bypassPermissions`/`acceptEdits`/`plan`/`default`. `bypassPermissions` is refused **under root**
  unless `IS_SANDBOX` is set (in the compose env).
- Deliberately the interactive form, **not** `claude remote-control` server mode, whose terminal is
  a QR/status lobby with no conversation.
- Sessions are independent processes inside the one container, so a session ending doesn't restart
  the container — the manager marks it stopped. "Restart (clear context)" relaunches a single
  session's Claude in place.
- All of a host's sessions share the one mounted `~/.claude` login; distinct worktree paths give
  each its own project slug and Remote Control bridge pointer. `MAX_SESSIONS` caps concurrency; the
  manager staggers launches on boot.
- Agents connect purely outbound to the public `TURMA_URL` (the Cloudflare tunnel), so they work
  from any host/network.

### New-work branching policy

- A session's checkout is only as fresh as spawn (`default_base_ref`'s short-bounded `git fetch`
  falls back to a stale local ref; a repos-root session works on whatever branch the host last left
  checked out).
- So every launch (spawn AND resume) passes **`--append-system-prompt`** a fixed directive
  (`NEW_WORK_SYSTEM_PROMPT`) telling the agent to refresh the base ITSELF when it starts new work:
  `git fetch origin`, resolve the default via `refs/remotes/origin/HEAD`, cut its branch from that
  **remote** ref rather than the current HEAD, carrying uncommitted work across and flagging a stale
  base when the fetch fails.
- It's `--append-system-prompt` because settings.json has no field carrying instructions, and a
  **directive rather than manager-side enforcement** because only the agent knows when "new work"
  begins. Tests: `TestSessionLifecycle`.

### Local-model failover (XERK-246)

- **Running out of Claude usage stops every session on a host at once**, which is what this exists to
  stop. A session's `modelSource` is `subscription` (the mounted `~/.claude` login) or `local` (this
  host's self-hosted model), settable at spawn and switchable on a running session.
- `local` is the **same `claude` binary** with `ANTHROPIC_BASE_URL` and friends repointed at a
  gateway serving the Anthropic Messages API. Never a second coding agent: a separate harness loses
  the transcript format every surface parses, `--resume`, Remote Control, the AskUserQuestion bridge
  and **the `--settings` safety guard**. `docs/local-model-failover.md` has the six-harness bake-off
  that settled this, including why `opencode.json` was deleted rather than fixed.
- The switch **relaunches with `--resume <that session's transcript id>`**, never `restart` — failing
  over is the moment you least want to clear the context. Read off the record on EVERY launch, so a
  resume/restart of a failed-over session stays failed over instead of silently returning to the
  exhausted subscription.
- `LOCAL_MODEL_CONTEXT` must match what the server really serves: Claude Code assumes 200k for a
  model it doesn't recognise and would compact far too late, truncating server-side instead. The
  default tracks the cue LLM's per-slot window, which DockerOps sizes — when that moves, this moves.
- **It is a fallback, not a peer** — the local model solved 4/8 of the bench Claude would be expected
  to clear. The UI marks a `local` session so nobody has to wonder which model wrote a turn.
- **Automatic delegation to the local model is deliberately NOT shipped**; the token arithmetic
  doesn't obviously work (diagnosis dominates, and Claude must diagnose before it can delegate). See
  the doc before building it.

### Safety guard

- Sessions run hands-off, so every launch passes `--settings` a generated file
  (`build_guard_settings()` → `~/.turma/guard-settings.json`) wiring `PreToolUse` hooks over Bash
  and the file-editing tools, plus `permissions.deny` rules on host credential stores (`~/.ssh`,
  `~/.aws`, `~/.azure`, `~/.terraform.d`, `~/.claude`, `~/.config/gcloud`) — shared by every
  session, so deny wins even under bypass.
- **`~/.claude` is guarded by `hooks/fileguard.py`, not by a pattern**: the rule is "everything
  under it except the two agent-memory trees", and a glob list cannot express that — deny beats
  allow, and **a deny matching a DIRECTORY takes its whole subtree**, so `Edit(~/.claude/*)` is the
  blanket rule. Patterns still cover the catastrophic subset as defence in depth. See
  `.claude/rules/agent-hooks.md`.
- It hard-denies three narrow categories, each with a reason the agent self-corrects from:
  **destructive** (`rm -rf` of `/`/home/system/`.git`, disk wipes, fork bombs, power changes,
  recursive `chmod`/`chown` of system roots, protected-branch history destruction, `DROP
  DATABASE|TABLE`); **policy** (push to / delete `main`/`master`, or self-merging a PR/MR — work
  lands via a PR a human merges); **attribution** (AI self-attribution trailers in commit/PR
  messages).
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) is untouched. Allowlist a
  command via `$TURMA_TOOL_GRANTS` (CSV of `Bash(<cmd>)`), attribution via
  `$TURMA_NO_ATTRIBUTION=0`.
- It classifies what the SHELL runs, **never the raw string** — `qa.md` §6.1 is the rule and its
  limits. Implementation detail in `.claude/rules/agent.md`.

## Deployment (DockerOps, not here)

- `compose/turma-truenas.yaml` defines the `turma` service and a single per-host `agent-host`
  container: mounted at `REPOS_ROOT`, `MAX_SESSIONS`/`TTYD_PORT_BASE`, host mounts, that host's OWN
  `TURMA_TOKEN` (`node turma/server.js --agent-token <device>` against the hub's master
  `TURMA_AGENT_TOKEN`; `TURMA_AGENT_STRICT` on the hub once every host has one — see XERK-268 in the
  contracts above), the FCM push service-account (`FCM_SERVICE_ACCOUNT_JSON`),
  basic-auth. Its `mem_limit`/`cpus`/`pids_limit` are sized against `MAX_SESSIONS`. No pricing/cost
  env — usage is counted in tokens per model, so there is no rate table.
- Changing how it's RUN (or adding a host) is a DockerOps compose edit; image content edits land
  here.
- The hub's `/data` volume holds `state.json` AND the durable session archive, so it must be a
  persisted volume. Overridable via `ARCHIVE_DIR`/`ARCHIVE_DB`.
  - It also carries the migration spool (`MIGRATE_SPOOL_DIR`), which is transient by design and
    shares that volume's SPACE with the archive — hence `MIGRATE_INFLIGHT_MAX`. No compose change:
    both default under `/data`.
- Local-model failover is per host: `LOCAL_MODEL_BASE_URL` / `LOCAL_MODEL_API_KEY` /
  `LOCAL_MODEL_NAME` / `LOCAL_MODEL_CONTEXT` on the `agent-host` service. Unset = feature off, and
  the agent reports `localModel.available:false` so clients hide the control.
- The `turma` service also takes the LiteLLM env for **Whisper STT** (`LITELLM_URL` = that
  instance's `/v1` base, optional `LITELLM_API_KEY`; legacy `WHISPER_URL`/`WHISPER_API_KEY`
  override), and `NODE_NO_WARNINGS=1` to silence `node:sqlite`'s experimental warning.
- Watchtower keeps `:latest` current; the DockerOps compose references
  `ghcr.io/xerktech/turma-agent:latest` — keep that ref in sync if renamed here.

## Releases and CI, in one line each

Full detail in `.claude/rules/release.md`.

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all five components + a changelog**, cut by
  `.github/workflows/release.yml`. Never split back into per-component workflows.
- The root **`VERSION`** file holds `MAJOR.MINOR` only; **the patch is derived from existing `v*`
  tags and never committed**. Bump `VERSION` only for a minor/major.
- Only **changed** components build; unchanged ones are **carried** at their prior version. Every
  release publishes all five.
- PR gates that block a merge: `code-scan.yml` (Semgrep, hadolint, ShellCheck, unit tests, the
  instruction-file size limits), the two image scans, `glasses-ci.yml`, `android-ci.yml`.
- **Every workflow runs on GitHub-hosted `ubuntu-latest`.** The self-hosted-box workarounds were
  deleted, not disabled — reintroducing any is a regression.
