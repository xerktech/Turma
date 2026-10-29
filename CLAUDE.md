# CLAUDE.md

Guidance for Claude Code working in this repository.

## Where the instructions live

This file loads into **every** session, so it holds only what every session needs. Everything else
lives in `.claude/rules/*.md`, each loaded automatically when Claude reads a file its `paths:`
frontmatter matches. `ls .claude/rules` (and each file's heading) is the map; the families are:

- `agent*` — `agent/hub-agent.py` and its subsystems (sessions, input, board, PRs, usage, archive
  sync, hooks, permissions, native install, token onboarding, session CLI).
- `session-*` — session transcript, working state, migration (span hub + agent + clients).
- `contract-*` — rules whose halves live in different components (see "Cross-cutting contracts").
- `guard-*` — safety-guard parser invariants, one per topic; `guard-protected.md` for root-owned hooks.
- `turma*` — the hub and web UI; `turma-ha-*` for the HA deployment.
- `dsh*`, `qwen*` — the alternate runtimes; rationale in `docs/dsh-adr.md`, `docs/qwen-adr.md`.
- `windows-*`, `agent-native-windows.md` — the native Windows agent (`docs/windows-agent-adr.md`).
- `android.md`, `chat-prose.md`, `ui-review.md`, `release.md`, the rest by name.

### Editing these files

- **Every one MUST stay under 40,000 characters** — Claude Code's own threshold, above which adherence
  drops. **CI enforces it** (`Instruction file size limits` in `code-scan.yml`). Check with `wc -m`
  (`-m`, not `-c` — these files are full of multibyte glyphs). There is **no truncation cliff**;
  the cost is context tokens and weaker adherence. Do not restore a "truncation limit" claim.
- **When a file nears the ceiling, split it by path** — never raise the number.
- **Put a fact in the narrowest file that always sees it.** Component detail → that component's rules
  file. A rule spanning components → a `contract-*.md` (or `session-*.md`) whose `paths:` list
  EVERY side's files, so it loads whichever half is touched, plus one pointer line in this file.
- **Root CLAUDE.md is a fixed cost on every turn of every session** — add a line here only when no
  `paths:` set could carry it.
- **Settled decision NARRATIVE belongs in `docs/`, not here** — rationale, alternatives considered,
  spike history, open questions. `docs/dsh-adr.md` and `docs/qwen-adr.md` are the pattern. Rules files
  carry the operative rule and point there for *why*.
- `paths:` matches the files Claude **reads**, so scope a rule to the sources it governs and their
  tests, not a directory that merely contains them.
- One idea per line, ~100 chars; nested bullets, not run-on paragraphs. Add a **new bullet** rather
  than extending an existing one.
- **Document current behavior, not its history.** State the rule and a short reason it must not be
  undone. A decision that supersedes an old one **replaces** that text. Keep `Tests:` pointers.

## What This Repo Is

Source and CI for the Claude Code agent fleet: a **one-native-agent-per-host** process that scans a
git root and multiplexes many worktree-backed Claude Code Remote Control sessions, plus a central
dashboard ("turma") that lists each host's repos, spawns/kills those sessions, and monitors them.

The agent runs **natively** on each host (systemd + tarball, `agent-native.md`); no agent container.
One image is built — the hub — pushed to GHCR and run on `k8x` from **xerktech/ArgoCD** (`ai/turma/`).

## Session Model

One native agent per host, multiplexing sessions across every repo it scans. Agent-side runtime
(launch flags, repos-root sessions, queue, kill/resume/delete) is in `agent-sessions.md`.

### Hosts, repos, spawning

- Mounted at a git root (`REPOS_ROOT`), scanned one level deep, plus a **repos-root pseudo-repo**
  (`ROOT_REPO_NAME`, "⌂ Repos root").
- A **session** is a randomly-named git worktree under `REPOS_ROOT/.turma/worktrees`, checked out
  **detached HEAD** off the latest default branch (`origin/HEAD` → main → master), best-effort
  fetched; the composer can override the base.
- **The app creates no branch of its own.** The running agent names its own branch when ready; that
  live branch (read from the worktree's git HEAD) shows on the card, "detached" until then. A ticket
  session is told its branch NAME but still cuts it itself, so the worktree stays detached.
- Each session runs `claude --remote-control` in its own tmux (`agent-<id>`) + loopback ttyd, up to
  `MAX_SESSIONS`, registering as `<host>-<repo>-<worktree-or-label>`.
- All spawn options are validated agent-side (allowlisted base refs, fixed model/permission enums),
  so nothing free-form reaches the shell. The worktree dir and `agent-<id>` tmux are the canonical
  keys; a label is presentational.

### The hub's ticket queue (XERK-296)

- **Work waiting for a slot is a QUEUED TICKET on the hub, never a created session on a host**, and
  **its host is chosen at DISPATCH** — whichever agent frees a slot first takes the oldest ticket. A
  queued ticket has no session id, worktree or host.
- It rides `/api/agents` as top-level `ticketQueue` + its own SSE event, the ONLY place a waiting
  ticket exists; `DELETE /api/jira/<siteKey>/<issueKey>/session` cancels one and can never touch a
  running session. Mechanics: `turma-ticket-queue.md`.

### Which transcript is a session's · migration · refused-start

All three span hub + agent (+ `tunnel-agent.js`), so a `paths:`-scoped file carries them:
- **Which transcript is a session's** (id pinning, `_session_transcript_path`, root-session
  isolation) → `.claude/rules/session-transcript.md`.
- **Migrating a session to another agent** (XERK-101) and **a refused session start is REPORTED**
  (XERK-265) → `.claude/rules/session-migration.md`.

## Cross-cutting contracts

Each spans components; the rule lives in the named file, which loads when any side is touched.

- **Web UI ⇄ Android parity** (XERK-30): a PR changing user-facing behavior in `turma/public/`
  carries the matching `android/` change or a line in `android/PARITY.md` → `contract-clients.md`.
- **A hub refusal reaches the operator in the hub's own words** (XERK-264) → `contract-clients.md`.
- **The heartbeat is the wire contract**; a field a client TYPES needs its hub-side coercion in the
  same change → `contract-wire.md`. Also there: retired-host usage (XERK-338), `subagentHistory`
  list-vs-absent (XERK-304), the three `readyForReview` mirrors.
- **The peer roster is the org boundary** (XERK-348), the **beat-loop time budget** (XERK-395), an
  agent's **host proved by its credential** (XERK-268), and **hub memory ceilings as fractions of
  the container limit** (XERK-258) → `contract-agent-hub.md`.
- **Ported mirrors**: `board.js` column rule + Triage lane, `hub-agent.py` ↔ `tunnel-agent.js`
  parsers and device naming → `contract-mirrors.md`.
- **"Working" is `paneBusy` OR live background WORK** (XERK-245, XERK-1570) → `session-working.md`.

## Conventions

- All credentials are inline in environment variables (no Docker secrets): the agent's in its per-host
  `agent/native/turma-agent.env`, the hub's in its ArgoCD deployment — never here.
- Native install, run-as identity, updater → `agent-native.md`. Session runtime, new-work branching
  directive → `agent-sessions.md`. Safety guard and the `--settings` file every
  launch passes → `agent-hooks.md`.

## Deployment (mostly not here)

- **The agent runs NATIVELY on each host** — tarball + systemd, installed and self-updated by
  `agent/native/`. Per-host config in `agent/native/turma-agent.env`: `REPOS_ROOT`,
  `MAX_SESSIONS`/`TTYD_PORT_BASE`, that host's OWN `TURMA_TOKEN` (`node turma/server.js --agent-token
  <device>`; set `TURMA_AGENT_STRICT` on the hub once every host has one), and the push
  service-account. No pricing/cost env — usage is counted in tokens per model.
- **The HUB runs on `k8x` from xerktech/ArgoCD (`ai/turma/`), and a release DEPLOYS it** (XERK-425):
  the `deploy-argocd` job pins that manifest's image digest, and the Application is `automated`, so
  merging hub code to main puts it in production. Needs `ARGOCD_DEPLOY_KEY` in the main-only
  `argocd-deploy` Environment and fails loudly without it. Detail: `release.md`.
- Adding a host is a native install; the hub is the only container this repo ships.
- The hub's `/data` volume holds `state.json` AND the durable archive, so it must be persisted
  (`ARCHIVE_DIR`/`ARCHIVE_DB` override).
  - The archive holds **two layers**: the rendered entries every surface reads, and a byte-for-byte
    copy of each session's own files (XERK-338) — roughly 5-10x the bytes, and the only place anything
    Turma does not render survives the host.
  - **Three things share that volume's SPACE**, each bounded separately: the archive (both layers, one
    ceiling) by `ARCHIVE_TOTAL_MAX_BYTES` (`turma-archive.md`), the migration spool by
    `MIGRATE_INFLIGHT_MAX`, and `state.json` by nothing — which is why the other two have ceilings.
  - `ARCHIVE_TRANSCRIPT_MAX_BYTES` bounds one transcript's rendered entries and
    `ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES` its raw copy, rather than the store. Neither counts `index.db`,
    which lives on the same volume at ~3x the first-fill archive; it is reclaimed across fill/wipe
    cycles (XERK-332, `maybeReclaimIndex`) so it no longer grows without bound — size the volume for
    that ~3x overhead.
- Local-model failover is per host: `LOCAL_MODEL_BASE_URL` / `LOCAL_MODEL_API_KEY` / `LOCAL_MODEL_NAME`
  / `LOCAL_MODEL_CONTEXT` in the
  agent's env. Unset = off, and the agent reports `localModel.available:false` so clients hide it.
- The hub also takes the LiteLLM env for **Whisper STT** (`LITELLM_URL` = that instance's `/v1` base,
  optional `LITELLM_API_KEY`; legacy `WHISPER_URL`/`WHISPER_API_KEY` override), and `NODE_NO_WARNINGS=1`.

## Releases and CI, in one line each

Full detail in `release.md`.

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all four components + a changelog**, cut by
  `.github/workflows/release.yml`. Never split back into per-component workflows.
- The four components: `turma` image, native agent tarball (`agent-native`), the no-WSL Windows agent
  zip (`agent-windows`, XERK-666), android `.apk`. The two agent builds share ONE
  runtime; `changes.js`'s `AGENT_RULES` decides which build(s) a change feeds.
- The root **`VERSION`** holds `MAJOR.MINOR` only; **the patch is derived from existing `v*` tags and
  never committed**. Bump `VERSION` only for a minor/major.
- Only **changed** components build; unchanged ones are **carried** at their prior version. Every
  release publishes all four.
- PR gates that block a merge: `code-scan.yml` (Semgrep, hadolint, ShellCheck, PSScriptAnalyzer, unit
  tests, the instruction-file size limits), `turma-image-scan.yml`, `android-ci.yml`.
- **Every workflow runs on GitHub-hosted `ubuntu-latest`.** The self-hosted-box workarounds were
  deleted, not disabled — reintroducing any is a regression.
