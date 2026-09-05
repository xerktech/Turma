# CLAUDE.md

Guidance for Claude Code working in this repository.

## Where the instructions live

This file loads into **every** session. Component detail lives in `.claude/rules/*.md`, each scoped
with `paths:` frontmatter so it loads only when Claude touches that component's files.

| File | Loads when Claude touches | Covers |
|------|---------------------------|--------|
| `CLAUDE.md` | **always** | repo purpose, session model, cross-cutting contracts, conventions, deploy |
| `agent.md` | `agent/hub-agent.py` | process model, commands, heartbeat, live-session signals, summaries, transcript blocks |
| `agent-input.md` | `agent/hub-agent.py` | `send_input`'s pane path + compaction outbox, `notify_session`'s inbox |
| `agent-sessions.md` | `agent/hub-agent.py` | session launch, repos-root sessions, queue, kill/resume/delete, new-work directive, local-model failover |
| `session-transcript.md` | `agent/hub-agent.py`, `agent/tunnel-agent.js`, `turma/server.js`, `turma/public/sessions.html` | which transcript is a session's: id pinning, `_session_transcript_path`, root-session isolation |
| `session-migration.md` | `agent/hub-agent.py`, `turma/server.js`, `sessions.html`, android `Sessions.kt` | migrating a session between agents (XERK-101); a refused start is REPORTED (XERK-265) |
| `agent-workflows.md` | `agent/hub-agent.py` | workflow runs: run-dir layout, resolving a `workflow` row, journal/label reads |
| `agent-archive.md` | `agent/hub-agent.py` | archive sync: manifest, rendered + raw delta pushes, payload shed, off-beat sync worker |
| `agent-board.md` | `agent/hub-agent.py` | Jira/ADO collectors, tracker writes, repo triage, ticket sessions |
| `agent-usage.md` | `agent/hub-agent.py`, `hooks/statusline.py` | token aggregates, attribution ledger, subscription limits + probe |
| `agent-prs.md` | `agent/hub-agent.py` | PR/MR status + ledgers, `_scan_pr_line`, GitLab/ADO dispatch, comment + conflict replies |
| `agent-tunnel.md` | `agent/tunnel-agent.js` | reverse tunnel, control-channel liveness, live pane footer |
| `agent-hooks.md` | `agent/hooks/**` | safety-guard policy, guard + file-guard hooks, AskUserQuestion bridge |
| `agent-native.md` | `agent/native/**` | non-Docker install, launcher, updater |
| `turma.md` | `turma/**` | chrome, org filter, dashboard, notifications, auth |
| `turma-archive.md` | `turma/archive.js` | durable archive: layers, size ceilings, how the total is measured |
| `turma-limits.md` | `turma/server.js` | connection cap, in-flight body budget, lanes, reclaim, drain |
| `turma-oidc.md` | `turma/server.js` | OIDC relying-party core: code+PKCE, discovery, JWKS RS256, session cookie, RP-logout |
| `turma-break-glass.md` | `turma/server.js`, `turma/public/login.html` | IdP-independent break-glass local login; invariants a mandatory-OIDC change must keep |
| `turma-usage.md` | `turma/public/usage.html`, `usage-ledger.js` | token chart, durable ledger, sub-agent split, limit cards, ingest coercions |
| `turma-board.md` | `turma/public/board.*` | Kanban, ticket panel, routing, auto-start/stop |
| `turma-triage.md` | `turma/public/board.*`, `turma/server.js` | Triage lane, per-ticket verdicts, org triage policy, auto-start gate |
| `turma-ticket-queue.md` | `turma/server.js`, `board.*` | hub ticket queue: admission, drain, expiries, caps |
| `turma-epic-run.md` | `turma/server.js` | epic auto-orchestration: durable run store, dependency DAG, manual-start route, never-auto-start gate (XERK-635); auto-close chaining + epic-completion write (XERK-637) |
| `board-ticket-view.md` | `server.js`, `hub-agent.py`, `board.js` + vendored copies, `Board.kt` | routing a ticket to a capable host; hub resolving a ticket as the board does |
| `turma-sessions.md` | `turma/public/sessions.html`, `chat.js` | Sessions page, chat engine, live tail, composer, terminal |
| `android.md` | `android/**` | Kotlin client, page→screen map, in-app update |
| `glasses.md` | `glasses/**` | G2 client |
| `release.md` | `.github/**`, `VERSION`, `turma/Dockerfile` | releases, PR gates, hub image |
| `routing-eval.md` | `bench/archive/**` | archive-sourced replay eval: requestId turn unit, curation gates |
| `dsh.md` | dsh-specific `agent/**` files | dsh runtime invariants (XERK-460); rationale in `docs/dsh-adr.md` |
| `dsh-input.md` | `agent/dsh_session.py` | driving a dsh session: socket, driver, input |
| `dsh-delegation.md` | `agent/dsh_transcript.py` | dsh delegation: bg-agent/workflow rows + `subagentHistory` |
| `dsh-guard.md` | `agent/dsh/guard/**` | dsh safety guard: deny policy on dsh's pipeline |
| `qwen.md` | qwen-specific `agent/**` files | Qwen runtime invariants (XERK-504); rationale in `docs/qwen-adr.md` |
| `qwen-migration.md` | `agent/hub-agent.py` | qwen migration + resume: native log as the resumable store |
| `qwen-delegation.md` | `agent/qwen_transcript.py` | qwen delegation rows + `subagentHistory` |
| `qwen-peer.md` | `agent/hub-agent.py`, `agent/qwen/peer_*.py` | qwen peer roster + cross-session messaging ([Qwen L]) |

### Editing these files

- **Every one MUST stay under 40,000 characters** — Claude Code's own threshold, above which adherence
  drops. **CI enforces it** (`Instruction file size limits` in `code-scan.yml`). Check with `wc -m`
  (`-m`, not `-c` — these files are full of multibyte glyphs). There is **no truncation cliff**;
  the cost is context tokens and weaker adherence. Do not restore a "truncation limit" claim.
- **When a file nears the ceiling, split it by path** — never raise the number.
- **Put a fact in the narrowest file that always sees it.** Component detail → that component's rules
  file. A rule spanning two components → "Cross-cutting contracts" below, since a `paths:`-scoped file
  does not load on the other side of the contract.
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

Moved to keep this file under its ceiling; all three span hub + agent (+ `tunnel-agent.js`), so a
`paths:`-scoped file legitimately carries them:
- **Which transcript is a session's** (id pinning, `_session_transcript_path`, root-session
  isolation) → `.claude/rules/session-transcript.md`.
- **Migrating a session to another agent** (XERK-101) and **a refused session start is REPORTED**
  (XERK-265) → `.claude/rules/session-migration.md`.

## Cross-cutting contracts

Rules spanning more than one component, so no `paths:`-scoped file can carry them alone.

- **Web UI ⇄ Android parity (XERK-30).** `turma/public/` is the source of truth; Android must match.
  **A PR changing user-facing behavior in `turma/public/` must carry the matching `android/` change in
  the same PR** — or add a line to `android/PARITY.md` and say so in the PR. "User-facing" = a
  control, screen, state, chip, interaction or layout a person sees or touches; pure server/agent
  plumbing is exempt. Page → screen map in `android.md`. `PARITY.md` is the living gap tracker.
- **A background-agent row's `subagentHistory` reply means "a list" by the PRESENCE of `agents`, the
  empty list included** (XERK-304). A `Workflow` row is N agents with no conversation of its own, so
  it answers with that run's agent picker; a second request naming one of those ids returns a
  transcript. Empty = "started nothing yet"; **absent = the row did not resolve** — word those
  differently, never collapse them. Spans `hub-agent.py`, `server.js`, `sessions.html`, `android/`.
- **Token usage OUTLIVES the host that spent it** (XERK-338). The hub keeps a durable per-host ledger
  on `/data` — a per-UTC-day high-water mark, since a report can only under-state a past day — and
  serves a removed host's spend as top-level **`retiredUsage`** on `/api/agents`; a live host that
  lost transcripts is served its recorded history raised by its own report.
  - **`retired` is HUB-OWNED and coerced off every heartbeat** (`normalizeRetired`). Android TYPES it
    and a full `/api/agents` decode is atomic there, so an agent asserting `retired:"yes"` empties
    every OTHER host from every phone's fleet list, and it persists into `state.json`. **Typing a
    field on `AgentInfo` and adding its hub-side coercion are the SAME change.**
  - **`retiredUsage` is read by the surfaces that COUNT SPEND and no other** — the Usage page/screen
    and the dashboard's three TOKEN TILES (`fleetSummary(agents, retired)`), which say
    `incl. removed hosts` when they do. Entries are agent-SHAPED so those surfaces chart them with
    existing code, but they carry no sessions, repos or commands — anything treating one as a HOST
    (cards, online count, session ceiling) invents a host that does not exist.
  - **Retired spend is org-scoped off the LIVE fleet's orgs**, on every surface: org.js builds its key
    set from `data.agents` and applies it to whatever list it is handed; android's
    `scopedRetired(retired, live, stored)` mirrors that. **Never scope the retired list against
    ITSELF** (`scopedAgents(retiredUsage, org)`) — that adds other orgs' removed spend to a scoped
    total, and nothing in the types catches it (both sides are `List<AgentInfo>`).
  - **Removing a host is not a purge**: `DELETE /api/agents/<host>` keeps the spend; `?usage=purge` is
    the deliberate second step. Never make a removal imply one.
  - The archive does NOT already hold this — it stores displayable entries, no token counts, never
    sees a live session, and excludes background-agent transcripts. Mechanics: `turma-usage.md`.
- **The peer roster IS the org boundary for cross-session messaging** (XERK-348). Claude Code's own
  control is per-MACHINE and a Turma org spans hosts, so the agent denies `ListAgents` (removing the
  tool, so a session cannot ENUMERATE anyone) and the hub's **`orgPeers`** puts same-org sessions on
  every heartbeat reply, which the agent renders to `~/.turma/peers.tsv`.
  - **The roster removes DISCOVERY, not delivery.** `SendMessage` resolves any string and an `rcName`
    is `<host>-<repo>-<TICKET-KEY>`, so a session can still guess one. Never write this up as "a
    session can only name what the hub sent" — it hides the residual risk.
  - **The org is the one the hub BOUND the host to, never the one the host claims** (`orgBound`,
    trust-on-first-use). `jira.siteKey` is agent-asserted, so gating on it lets any host's token join
    any org and read its roster. The binding is hub-owned; mechanics in `turma.md`.
  - **Drift is declaring a DIFFERENT org, never failing to declare one** — a host whose tracker goes
    quiet keeps its binding and its peers.
  - **The hub SERVES its decided org as `org`, and the migrate route + every Move menu key on it**
    (XERK-349). `decidedOrgOf` = the bound org, or "" for an actively-drifted host or a never-bound
    one; `serializeAgent` stamps it after the spread (like `key`), `normalizeOrg` strips any an agent
    forges. A migration needs a shared NON-EMPTY decided org on BOTH sides (`sameDecidedOrg`). What it
    CLOSES: two hosts that both declare NO org no longer pool (the org-less hole — a bound-to-acme host
    declaring nothing now reads "acme", not the same "" a bound-to-rival one does). What it FIXES: the
    over-refusal where two same-org hosts, one momentarily quiet, wrongly 409'd. What it does NOT do:
    an actively-drifting host is refused (decided ""), but that quarantine is **self-healing, one beat
    deep** — the SAME as the reverted drift-refusal, not better — since silence is not drift (XERK-348)
    and the binding never moved, so a drifted-then-quiet host is `boundOrgOf` again; permanent drift
    quarantine would need drift history the record lacks and would undo the over-refusal fix. Clients
    mirror the served `org` (older-hub fallback to `jira.siteKey`), so hub and menus agree — the piece
    the two reverted `orgBound` attempts lacked (it was stripped from the payload). Cost: a no-Jira
    fleet cannot migrate. **Do not re-key this on the claimed `jira.siteKey`** — that reopens the holes.
  - **Every roster cell is capped on the wire** (`PEER_CELL_MAX`), not just the free-text one —
    nothing else bounds `rcName`, and the spawn route takes a 100k `label`.
  - **Both sides fail NARROW.** No `peers` on a reply forgets the roster; a silent hub expires it;
    either way the agent falls back to its OWN host's sessions, same-org by construction. Never add a
    path that keeps a wide roster nothing vouches for.
  - **It is a strong soft boundary, not an airtight one.** `crossSessionInbound` has no per-sender
    filter, so an off-org session sharing the Claude login can still DELIVER into a session — it just
    can't discover one. **One Claude login per org is the only hard boundary**, a per-host deployment
    decision. Don't describe this contract as sealing it.
- **Nothing on the agent's BEAT LOOP may have a worst case at or above the hub's `OFFLINE_AFTER_MS`**
  (XERK-395). The hub calls a host offline after 75s of silence; what sets the gap between beats is
  the AGENT's own timeouts and retry counts, so neither side's scoped file sees both halves.
  - **A try/except does not satisfy this** — it catches exceptions, never TIME. Nor does a deadline
    alone, while one in-flight push can overshoot it by a full timeout.
  - Inline may cost `INTERVAL` plus the beat's own POSTs (`HEARTBEAT_TIMEOUT_SEC`, twice on a cycle
    that executed commands) — 40s of the 75s. Anything else with a network or disk worst case belongs
    on a worker, as archive sync and `prune` (XERK-256) were moved.
  - The slow-cadence cache refreshes are OFF the beat too (XERK-397): `refresh_github`,
    `refresh_jira`, `refresh_pr_status` run on ONE shared **slow-refresh worker** — the beat only
    STAGES which are due (`_stage_slow_refresh`) and reads the caches it publishes. That worker is the
    SINGLE writer of `self.github`/`self.git_sources`/`self.jira`/`self.pr_status_cache`, which is
    what keeps the beat's reads of them lock-free: each refresh REBINDS its top-level cache object, or
    key-mutates `pr_status_cache` in a way a beat `.get()` tolerates, and the beat never ITERATES a
    dict the worker grows or shrinks. The manual `refreshJira` command stages the same worker, never
    polls inline. A migration `export_session` (with its ≈96s `_migration_upload` retry) runs on its
    OWN thread (`_export_session_async`); its refusal still reaches the hub because the
    `spawn_failures` append is lock-guarded and `post()` clears only the entries THIS payload
    delivered, by identity, so a refusal appended mid-beat is never lost.
  - **The PR-COMMENT poller is a FETCH/DELIVER SPLIT** (XERK-543), not on the slow-refresh worker.
    Its `gh`/GitLab/ADO fetch (PR_COMMENTS_MAX per pass, same class as `refresh_pr_status`) runs on
    its OWN worker (`_fetch_pr_comments`, staged by `_stage_pr_comment_fetch`), which stages raw
    events (`_pr_comments_fetched`, REBOUND under `_pr_comments_lock` like `spawn_failures`); the beat
    only DRAINS that and DELIVERS (`_deliver_pr_comments` — the baseline/new-key logic, `prCommentBase`
    mutation, `save()`, `notify_session`). It could NOT ride the slow-refresh worker: that worker is
    the single lock-free writer of caches the beat READS, whereas delivery MUTATES session records,
    which is the beat's to own — so the network half moved off, the registry half stayed on. The
    synchronous `_poll_pr_comments` (fetch-then-deliver) is kept only as the behavioural-test entry
    point. One beat stale, accepted.
  - Tests: `TestBeatLoopBudget`, `TestSlowRefreshWorker`, `TestPrCommentFetchWorker`,
    `TestArchiveSyncWorker`.
- **`readyForReview` has FOUR mirrors that must agree**: `turma/public/sessions.html`,
  `turma/server.js`, `android/…/core/Sessions.kt`, `glasses/src/sessions.ts`. Changing the rule means
  changing all four.
- **"Working" is `paneBusy` OR live background agents** (XERK-245), in every mirror of the read (those
  four plus `turma/public/index.html`). A session that delegates work ENDS ITS OWN TURN: the pane
  drops the interrupt hint, so `paneBusy` says False while an agent it launched keeps going — which
  reads idle everywhere AND qualifies as ready-for-review. The session's `agents[]` is the second
  input; it sits BEHIND the offline and no-transcript gates like `paneBusy`, and an absent field means
  "that agent can't tell", never "no agents". **It comes from the TRANSCRIPT** (`_scan_agent_entry`:
  `agentId:` on launch, `<task-notification>` on stop), **never from the TUI's footer rows** — those
  are forgeable pane content and linger ~24s past completion.
- **`turma/public/board.js` has FOUR mirrors of its column rule** (`categoryOf` / `REVIEW_STATUS_RE`):
  the source, its **byte-identical vendored copy** (`glasses/src/vendor/board.cjs`, asserted by
  `vendor.test.ts`), and the two ports — `_board_column` in `hub-agent.py` and `categoryOf` in
  android's `core/Board.kt`. The agent resolves a dropped column against its OWN read, so drift
  silently refuses valid drops. Tests: `TestBoardColumn`, `board.test.js`, `BoardTest.kt`.
- **The Triage lane + verdict chip ride the SAME mirrors** — `triageLaneOf`/`triageChipHtml` in
  `board.js` reach the glasses + Veiller-fork vendored `board.cjs` (byte-identity pinned by their
  vendor tests, a third mirror beyond the column rule's four) and Android's `Board.kt` port. The
  verdicts themselves are HUB-OWNED wire state (`ticketTriageActions` on `/api/agents`, set via
  `POST /api/jira/<site>/<key>/triage`), so glasses/Veiller render them PASSIVELY with no verdict
  or policy controls; the lane is a board view that never writes to the tracker. Change the lane
  or chip → re-vendor and re-port in the same PR. Mechanics: `.claude/rules/turma-triage.md`.
- **`hub-agent.py` ↔ `tunnel-agent.js` are a parity contract** for everything both parse:
  `_entry_blocks`/`entryBlocks`, `_entry_text`, `transcript_tail`, `_busy_from_capture`/
  `paneShowsBusy`, `_fold_queue_op`/`foldQueueOp`, `_send_user_file_detail`/`sendUserFileDetail`.
  Parity-tested in `tunnel-agent.test.js`.
  - **`device_name`/`deviceName` + `_usable_hostname`/`usableHostname` are on that list too.** They
    must resolve the SAME name: `openChannel` keys `controlChannels` by it, so a tunnel and a manager
    under different names is a host whose commands work while its terminal, live tail and heartbeat
    poke are dead — and a ghost card `DELETE` cannot reach. The native launcher exports an
    operator-set `DEVICE_NAME` to both processes unvalidated, so an env-path divergence is the one
    that bites. Tests: `TestDeviceName`, `usableHostname`/`deviceName` in `tunnel-agent.test.js`.
- **The heartbeat is the wire contract** between `hub-agent.py` and `turma/server.js` (and through it
  every client). A field older agents don't send must degrade, never break: clients gate on the
  capability flag the agent reports (`inputMaxChars`, `uploadMaxBytes`, `github.available`,
  `capacity`), and an absent flag means "that agent can't do it", not "unlimited".
  - **A full `/api/agents` decode is ATOMIC on Android**, so one host's wrong-typed field throws for
    the whole array — the poll fails silently while the app keeps its last snapshot and the tile still
    says "N / N online". Per-agent SSE events decode individually, so the bad host is simply missing
    while SSE is healthy; with SSE down too, the decoder exception replaces the screen. **Most of the
    payload is served raw**, so this is a live hazard: grep `normalize`/`sanitize` in `server.js` for
    what is actually covered rather than trusting a list here, which has been wrong repeatedly.
  - **A field becomes decode-fatal the moment a client TYPES it** — until then `ignoreUnknownKeys`
    skips it. `normalizeRecord` is where a coercion goes, and it runs on both the heartbeat ingest and
    the `state.json` restore (a restart is when a coercion ships, and the restore is the first thing
    it serves). Coerce to the "can't tell you" value every client already handles, never to a
    plausible default. **A `normalize*` is a WHITELIST** — a sub-key a newer agent adds is dropped
    fleet-wide unless added there too.
- **A hub refusal must reach the operator, in the hub's own words** (XERK-264). The hub refuses with a
  status and a JSON `{error}` body (409 org mismatch / unsupported agent, 503 host offline, 404 stale
  attachment, 413 too long, 429 queue full); a client that reads the body and ignores `res.status`
  shows a refused kill/rename/spawn as one that worked.
  - Web: `post()`/`del()` resolve **null on a refusal, having already toasted**
    `TurmaNav.refusalText`, and callers roll back whatever they painted optimistically.
    `TurmaNav.toast` is the ONE failure surface — nothing announces success through it, so a toast
    always means a command did not run.
  - Android: `hubErrorMessage` reads `{error}` off an `HttpException` or a typed `Response`;
    `FleetViewModel.run`/`ChatViewModel.report` word the snackbar from it and drop the optimistic
    pending row. **`/history` refusals are `HistoryResult.Failed`, never `Pending`** — polling can't
    fix a refusal.
  - Glasses (XERK-270): `hub-client.ts`'s `refusal()` reads the body BEFORE it throws, so the
    `HttpError` carries the hub's words, and `app.ts`'s `failureFlash` puts them on the display. Both
    halves or neither. `FLASH_HUB_UNREACHABLE` is only for a failure with **no status** — a dead
    socket or fetch timeout. A one-line header clips a long refusal (`headerLine`); the session screen
    wraps it whole.
  - All three fall back to "the hub answered HTTP `<n>`", worded identically on purpose.
- **An agent's HOST is proved by its credential, never by what it types** (XERK-268). Every
  agent-authed surface names the host it acts as — the `<host>` segment, the heartbeat's `device`, the
  tunnel's `?name=` — and each agent runs on its OWN token,
  `<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>`, which the hub re-derives against the host
  that was named. **The token NAMES its host on purpose**: an HMAC can't be inverted, so a bare digest
  could only be checked once the host was known, and `/api/heartbeat` — whose host is buried in a
  32 MiB body — would have had to admit any bearer before reading it.
  - **Scoping a route to a host is not a security check on its own.** Under one fleet-shared token
    `<host>` was self-asserted, so `m.srcHost !== host` refused a caller naming ITSELF and passed one
    naming the victim. Both halves — the scope AND the binding — or neither is worth stating. Never
    write a comment claiming a `<host>` compare keeps one agent out of another's data without
    checking the credential is bound.
  - That is also why a **per-relay one-time secret is not the fix** and must not be re-proposed: it
    would ride on exactly the commands an impersonated heartbeat hands out.
  - The master still authenticates as `legacy` so a fleet mid-rollover keeps beating;
    **`TURMA_AGENT_STRICT` retires it**, and the hub warns at boot until it is set. Detail in
    `turma.md`; the agent needs no code change, only the right `TURMA_TOKEN`.
  - **Onboarding onto that derived token is ONE action, not a per-host ritual** (XERK-578), spanning
    hub + agent + native. The hub re-derives `hostAgentToken(host)` and delivers it two ways:
    - **Roll (design A):** `POST /api/agents/<host>/roll-token` (operator-authed) queues a `setToken`
      command over the existing tunnel; the agent (`set_token`) writes it to its env file atomically
      and does a session-preserving restart. Deterministic, so a re-roll is idempotent.
    - **Enroll (design B):** `GET /api/agent/token` (AGENT-authed) returns ONLY the token for the
      identity the request proved — a derived-token caller gets its own (never another host's); a
      MASTER caller names its own `?device=` and gets that, which is exactly master-mintable. Driven
      by `turma-agentctl enroll` or opt-in `TURMA_AGENT_SELF_ENROLL=1` on start.
    - **`resolveEnrollToken` is the endpoint's decision** (exported, unit-tested strict + non-strict).
      Both self-close under `TURMA_AGENT_STRICT` — the master is no longer a credential, so neither
      can be driven by a master holder; during rollover they hand out only what a master holder could
      already mint, so no new exposure. **Never re-key the endpoint on a caller-named device for a
      PROVED caller** — that reopens the cross-host escalation the whole thing guards.
    - **DEVICE_NAME mismatch is impossible-by-construction AND checked**: the hub mints for the name
      the agent beats as, and the agent (`token_device_name`) refuses to persist a token whose name
      half isn't its own `DEVICE_NAME` — never a silent invalidation. Env write is a single-key atomic
      rewrite (`rewrite_env_var`, preserves operator edits); the launcher exports `TURMA_AGENT_ENV` so
      the manager knows which file to roll.
    - **`tokenBound` is now SERVED** (was stripped) as the onboarding signal, replacing the "curl
      twice to verify" step. The dashboard flags ONLY a host still on the master (`⚠ shared token`);
      a bound host shows no chip (a positive chip on every host is noise). Still HUB-DERIVED
      (forge-proof, re-stamped in `serializeAgent`), and served ONLY when the hub has a master
      (absent = no per-host tokens here). `tokenRoll` is the agent capability that gates the Roll
      button. Android types NEITHER yet (`ignoreUnknownKeys` skips them — safe); web-only, in
      `PARITY.md`. Native/agent detail in `agent-native.md`.
- **The hub's memory ceilings are FRACTIONS OF ITS CONTAINER LIMIT, never fixed numbers** (XERK-258,
  XERK-273). It runs at `mem_limit: 512m` (raised from 256m for XERK-287), so a flat constant larger
  than that can never refuse anything before the OOM killer fires. `containerMemoryLimit()` reads the cgroup; everything derives
  from it and is logged at boot. Raising `mem_limit` widens them with no code change. Mechanics:
  `turma-limits.md`. What spans components:
  - **413 and 503 mean opposite things and must not be collapsed**: 413 is "your body is too big,
    send less", 503 is "the hub is momentarily full, send it again". Every `readRawBody` caller must
    draw the distinction itself. On a 503 the migration relay HOLDS the migration in `exporting` and
    `_migration_upload` retries (5xx only, never 4xx); nothing else would, and a lost bundle strands
    the move.
  - **An OVERSIZE body is deliberately NOT refused on its declaration.** Refusing early makes Node
    close the connection under a request still being written, and a client that writes before reading
    — python urllib, which is what `hub-agent.py` posts with — loses the response and sees a socket
    error (XERK-235's offline loop). **Test agent refusals with urllib, never with fetch.**
  - **XERK-287 (closed by the raise): uploads are a budget SEPARATE from the in-flight ceiling**, so
    the hub's worst-case heap is `in-flight + uploads` = ¾ of the container — 192 MiB at 256m, which
    OOM'd. `mem_limit` was raised to **512m** (co-peak 384 + baseline, ~68 MiB margin) rather than
    shrink either budget (the raise widens every derived ceiling with no code change). **The
    chunked-body / socket-error halves (findings 2/3) need NO code**: the k8s NGINX ingress fronting
    the hub buffers every request body (`proxy_request_buffering on`) and forwards it DECLARED-LENGTH,
    so the hub's declared-length pre-check always fires and an oversize body always gets a readable 413
    — the direct-tunnel topology those findings (and XERK-235) assumed is gone. The one residual is an
    in-cluster agent posting to the Service directly, bypassing nginx. Mechanics + evidence:
    `turma-limits.md`.

## Conventions

- All credentials are inline in environment variables (no Docker secrets): the agent's in its per-host
  `agent/native/turma-agent.env`, the hub's in its ArgoCD deployment — never here.
- Native install, run-as identity, updater → `agent-native.md`. Session runtime, new-work branching
  directive, local-model failover → `agent-sessions.md`. Safety guard and the `--settings` file every
  launch passes → `agent-hooks.md`.

## Deployment (mostly not here)

- **The agent runs NATIVELY on each host** — tarball + systemd, installed and self-updated by
  `agent/native/`. Per-host config in `agent/native/turma-agent.env`: `REPOS_ROOT`,
  `MAX_SESSIONS`/`TTYD_PORT_BASE`, that host's OWN `TURMA_TOKEN` (`node turma/server.js --agent-token
  <device>`; set `TURMA_AGENT_STRICT` on the hub once every host has one), and the push
  service-account. No pricing/cost env — usage is counted in tokens per model.
- **The HUB runs on `k8x` from xerktech/ArgoCD (`ai/turma/`), and a release DEPLOYS it** (XERK-425):
  the last step of `build-turma-image` rewrites that manifest's image tag, and the Application is
  `automated`, so merging hub code to main puts it in production. Needs the `ARGOCD_DEPLOY_KEY` secret
  (a write deploy key, not a PAT) and fails loudly without it. Detail: `release.md`.
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
- The four components: `turma` image, native agent tarball, glasses `.ehpk`, android `.apk`.
- The root **`VERSION`** holds `MAJOR.MINOR` only; **the patch is derived from existing `v*` tags and
  never committed**. Bump `VERSION` only for a minor/major.
- Only **changed** components build; unchanged ones are **carried** at their prior version. Every
  release publishes all four.
- PR gates that block a merge: `code-scan.yml` (Semgrep, hadolint, ShellCheck, unit tests, the
  instruction-file size limits), `turma-image-scan.yml`, `glasses-ci.yml`, `android-ci.yml`.
- **Every workflow runs on GitHub-hosted `ubuntu-latest`.** The self-hosted-box workarounds were
  deleted, not disabled — reintroducing any is a regression.
