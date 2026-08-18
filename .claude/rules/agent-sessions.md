---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# `hub-agent.py` — how a session actually runs

Split out of `CLAUDE.md` to keep that file under its size ceiling. What spans components — the
session model itself, which transcript is a session's, migration, and the refused-start contract —
stays there; this is the agent-side runtime detail behind it. `.claude/rules/agent.md` carries the
process model and the command table.

## How a session runs

- Each session runs as the entrypoint's resolved run-as identity
  (`.claude/rules/agent-image.md`) as an interactive `claude --remote-control`, defaulting to
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

## Repos-root sessions

- Run `claude` directly in `REPOS_ROOT` — spanning every repo — with **no worktree and no branch**,
  so the base-branch option doesn't apply. Kill/delete tear down only the processes; `REPOS_ROOT` is
  never touched.
- All root sessions share that one cwd (hence one claude project slug + Remote Control bridge
  pointer), so **at most one root session runs per host at a time** (enforced on
  spawn/start/resume).
- That ONE slug dir accumulates EVERY root session's transcript, which is why the transcript pin
  exists (`CLAUDE.md`, "Which transcript is a session's").

## The session queue (XERK-14)

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
  (`CLAUDE.md`), so a host takes one only when it can start it. One can still land here if a host
  fills between the hub's capacity read and its next beat — a race, not the normal path.
- Tests: `TestSessionLifecycle`, `TestSpawnTicket` in `test_hub_agent.py`; `sessions.test.js`.

## Kill, resume, delete

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

## New-work branching policy

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

## Local-model failover (XERK-246)

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
