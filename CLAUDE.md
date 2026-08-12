# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Where the instructions live

This file is loaded into **every** session on every host. Component detail lives in
`.claude/rules/*.md`, each scoped with `paths:` frontmatter so it loads only when Claude touches
that component's files.

| File | Loads when Claude touches | Covers |
|------|---------------------------|--------|
| `CLAUDE.md` | **always** | repo purpose, session model, cross-cutting contracts, conventions, deploy |
| `.claude/rules/agent.md` | `agent/**` | `hub-agent.py` process model, commands, heartbeat, PR status, usage ledger, transcript blocks, archive, image |
| `.claude/rules/agent-board.md` | `agent/hub-agent.py` | Jira/ADO collectors, tracker writes, repo triage, ticket sessions |
| `.claude/rules/agent-usage.md` | `agent/hub-agent.py`, `agent/hooks/statusline.py` | token aggregates, attribution ledger, subscription limits + probe |
| `.claude/rules/agent-tunnel.md` | `agent/tunnel-agent.js` | reverse tunnel, control-channel liveness, live pane footer |
| `.claude/rules/agent-hooks.md` | `agent/hooks/**` | guard hook, AskUserQuestion bridge |
| `.claude/rules/agent-native.md` | `agent/native/**` | non-Docker install, launcher, updater |
| `.claude/rules/turma.md` | `turma/**` | chrome, org filter, dashboard, history, archive, notifications, auth |
| `.claude/rules/turma-board.md` | `turma/public/board.*`, `turma/server.js` | Kanban, ticket panel, routing, auto-start/stop |
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
    remedy, not raising the number and not deleting rationale. `agent-board.md`, `turma-board.md`
    and `turma-sessions.md` exist for exactly that reason.
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
- **The queue applies to every spawn path; only TICKET spawns split across hosts.** An explicit "+
  New session" queues on the host whose card was clicked.
- Tests: `TestSessionLifecycle`, `TestSpawnTicket` in `test_hub_agent.py`; `sessions.test.js`.

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
- Tests: `TestMigrateSession`, `server.test.js`, the Move cases in `sessions.test.js`,
  `eligibleMoveTargets` in android `SessionsTest`.

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
- **The heartbeat is the wire contract** between `hub-agent.py` and `turma/server.js` (and through
  it every client). A field older agents don't send must degrade, never break: clients gate on the
  capability flag the agent reports (`inputMaxChars`, `uploadMaxBytes`, `github.available`,
  `capacity`), and an absent flag means "that agent can't do it", not "unlimited".
  - **A full `/api/agents` decode is ATOMIC on Android**, so one host's wrong-typed field throws for
    the whole array — the poll fails silently while the app keeps its last snapshot and the tile
    still says "N / N online". Per-agent SSE events decode individually, so the bad host is simply
    missing from the list while SSE is healthy; with SSE down too, the raw decoder exception
    replaces the screen.
  - **A field becomes decode-fatal the moment a client TYPES it** — until then `ignoreUnknownKeys`
    skips it and any value is harmless. So typing one on `SessionInfo`/`AgentInfo` and adding its
    hub-side coercion are the SAME change; `normalizeRecord` is where it goes, and it runs on both
    the heartbeat ingest and the `state.json` restore (a restart is when a coercion ships, and the
    restore is the first thing it serves). Coerce to the "can't tell you" value every client already
    handles, never to a plausible default.
  - **The whole record is held to that shape by `turma/wire-shape.js`** (XERK-259), a table mirroring
    `Models.kt` — per-block `normalize*`s covered only what someone had got to, and `repoUsage:[null]`
    from one host stopped the phone signing in at all. A LIST's ELEMENTS are as fatal as its type,
    and `typeof [] === "object"`, so element tests go through `isPlainObject`.
    - It coerces **IN PLACE, touching only the keys it names**, which is what keeps it from being a
      whitelist: a sub-key a newer agent adds rides through untouched, where rebuilding an object
      drops it fleet-wide until the table catches up (`normalizeLimits`/`normalizeLocalModel` DO
      rebuild, so a new sub-key of theirs must be added to them).
    - **A block those two rebuild is in the table anyway** — a rebuild is only as good as its own
      gates, and `limits` shipped one gating its epoch fields on `Number.isFinite`, so a fractional
      `resetsAt` (Kotlin `Long` takes no fraction) went out raw. Nothing agent-authored is exempt.
    - Its own module because the restore runs at `server.js` module init: a `const` declared below
      that point is in its temporal dead zone, and the ReferenceError dies in the restore's own
      `catch {}`, leaving records half-coerced with nothing logged.
    - Typing a field in `Models.kt` without adding it there **fails the hub's suite** — the test
      parses `Models.kt` and walks it, so this pairing is enforced, not remembered.
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
  (`build_guard_settings()` → `~/.turma/guard-settings.json`) wiring a `PreToolUse` hook over Bash
  plus `permissions.deny` rules on host credential stores (`~/.ssh`, `~/.aws`, `~/.azure`,
  `~/.terraform.d`, `~/.claude`, `~/.config/gcloud`) — shared by every session, so deny wins even
  under bypass.
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
  container: mounted at `REPOS_ROOT`, `MAX_SESSIONS`/`TTYD_PORT_BASE`, host mounts, the shared
  `TURMA_TOKEN`/`TURMA_AGENT_TOKEN`, the FCM push service-account (`FCM_SERVICE_ACCOUNT_JSON`),
  basic-auth. Its `mem_limit`/`cpus`/`pids_limit` are sized against `MAX_SESSIONS`. No pricing/cost
  env — usage is counted in tokens per model, so there is no rate table.
- Changing how it's RUN (or adding a host) is a DockerOps compose edit; image content edits land
  here.
- The hub's `/data` volume holds `state.json` AND the durable session archive, so it must be a
  persisted volume. Overridable via `ARCHIVE_DIR`/`ARCHIVE_DB`.
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
