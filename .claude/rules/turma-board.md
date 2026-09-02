---
paths:
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "turma/public/newticket.js"
  - "turma/server.js"
  - "turma/tests/board.test.js"
  - "turma/tests/newticket.test.js"
  - "turma/tests/server.test.js"
---

# The board page (`/board`)

Scoped to the board client plus `turma/server.js`, which owns routing, ticket pins and the
auto-start/auto-stop sweeps. Read `.claude/rules/turma.md` for the rest of the dashboard and
`CLAUDE.md` for the cross-cutting contracts.

- One cross-org Jira Kanban built from every agent's `jira` block (`turma/public/board.js`,
  dual-exported for tests). `mergeSites` collapses hosts sharing an org into one board keyed by
  `siteKey` (freshest block wins per site+user; different users on one site union, deduped by issue
  key). Columns are Jira's three status categories; each card's pill shows the org's status name.
- A fourth **In Review** column (XERK-23) sits between In Progress and Done. Jira has no cross-org
  review/testing category (both `indeterminate` → `inprogress`), so `categoryOf` carves it out on
  the status NAME (`isReviewStatus`, word-boundary: review/testing/QA/**resolved**), only ever
  pulling FROM `inprogress`.
  - `resolved` covers **Azure DevOps** (XERK-250: Resolved = "fixed, not yet verified", reaches
    clients as `inprogress`); a Jira "Resolved" is normally `done`, which the carve-out can't pull
    from.
  - **The rule has FIVE mirrors** — see `CLAUDE.md`'s cross-cutting contracts for the list.
- **The columns are ALWAYS one horizontal row, at every width** (XERK-253, `.kanban-cols`): a flex
  strip that scrolls sideways. Never reintroduce a wrapping breakpoint — stacked columns stop
  reading as a Kanban.
- **A column is a FIXED 300px everywhere** — `flex: 0 0 300px`, no fluid re-sizing; horizontal
  scroll is the accepted cost, not a bug. Matches Android's `.width(300.dp)` — move one, move both.
  Guarded by `board.test.js` reading **every** `.kanban-cols` rule, not just the first (a later
  unscoped override wins the cascade).
- Scoped by the **header's org filter** (`TurmaOrg.getKeys()` each render → `boardHtml`), not a
  strip of its own.
- An org is **labelled by `orgName(siteKey)`** (host minus `.atlassian.net`), overridable by the
  agent's **`BOARD_ORG_NAME`** (self-hosted Azure otherwise derives to its collection). Labels are
  presentational, NOT part of `siteKey` — that's the routing/storage key; renaming it orphans
  everything keyed on it. Tests: `TestBoardOrgName`, `board.test.js`.
- Each org gets a **UNIQUE color**, no two sharing a `--s1..--s8` slot (`orgColorMap`, XERK-48,
  djb2-preferred slot + linear-probe, computed over the whole org set). Persistent where possible —
  only colliding orgs move. Overflow past 8 falls back to preferred slot.
  - **Pinnable by hand** (XERK-145): header org menu's color dot → swatch strip. `POST
    /api/jira/<siteKey>/color {slot:1..8}`/`{auto:true}`, persisted `/data/org-colors.json`, rides
    the fleet payload + `orgColors` SSE. A pinned slot can be shared (operator's choice beats
    uniqueness); a malformed pin is ignored.
  - **Tints the CARD BACKGROUND on every surface** (XERK-142: board ticket, Sessions session,
    Dashboard host). `color-mix`ed 12% into `--surface`, computed over the WHOLE fleet's org set so
    a card's color is stable regardless of the header filter.
- The board READS the tracker; it makes exactly **two** writes back — **creating a ticket**
  (XERK-137) and **changing status** (XERK-138). Every other control writes a hub/agent ledger, not
  the board.

### Creating a ticket (XERK-137)

- **"New ticket"** opens a modal (title, description, labels), source-agnostic across Jira/Azure,
  hidden until an org reports. Lives in the **shared site header** (`newticket.js` →
  `#hdrNewTicket`), not the board toolbar. Rides command → staged result → poll, against a ranked
  ONLINE host of the org:
  - `GET /api/jira/<siteKey>/create-meta` → projects + labels; `?project=<p>` → that project's
    creatable types (cascade, so no meta call fans across every project). Cached per host, 202-polled.
  - `POST /api/jira/<siteKey>/tickets` stages `{cmdId, key, url, error, warning}`; polled at
    `.../tickets/<cmdId>`. All three caches stripped from the fleet payload.
- **An org's hosts are health-ranked and a write is OWNED by the host that took it** (XERK-241): the
  poll reads only that owner — judging a create by a SIBLING's liveness made four tickets. Giving up
  on a create **withdraws** it even when delivered (delivery is at-least-once, the ack-set is
  in-memory, so one left queued re-runs on return; `deliveredAt` decides only the wording). A retry
  rejoins an unresolved identical create (`createInFlight`, whole body); creates round-robin past
  gapped hosts.
- Tests: `server.test.js`; `createFormHtml` in `board.test.js`.

### Repo chips

- Each card shows the **triaged repo** (`repoChipHtml`/`repoGuess`) in three states: cloned = plain
  chip, listed-only = **dashed**, declined = muted italic **"no repo"**; no guess yet = **no chip**.
  Detail: tooltip + panel's Repo row (`repoFieldHtml`, reads `t.repoGuess` directly).
- `.kc-repo` ellipsises on its own element (flex content can't be clipped by a parent).
- **Likely-duplicate chip** (XERK-484): a ticket the classifier flagged carries a warning-tinted
  `kc-dup` chip ("dup of <twin>") linking to the twin — `dedupeTwinUrl` prefers the twin's own
  board row when it is on this board, else rebuilds the tracker URL from the site's
  source+siteKey (Jira `/browse/<key>`, ADO `/_workitems/edit/<key>`); the panel's **Duplicate of**
  row (`detailHtml`, fed the site via `paintDetail`'s opts) spells it out with the classifier's
  rationale dimmed. `triage.dedupeOf` rides the **heartbeat ticket only** (the on-demand fetch
  comes straight from the tracker, which knows nothing of triage), so it is read off `t` directly,
  like `repoGuess`. No flag → no chip, no row. The hub's per-org sweep that queues the
  `createDuplicateLink` command to the Jira host is documented in
  `.claude/rules/agent-board.md` ("Writing back to the board").

### Starting a session on a ticket

- **Start button**: `POST /api/jira/<siteKey>/<issueKey>/session` → `spawnTicket`. **The hub's job
  is ROUTING** — sends just the issue key; `findTicketHost` picks the host, online **required**
  (unlike the read-only GET). `ticketRepo` resolves the repo from the freshest block.
- **The Start single-flight is ORG-WIDE, not per-host** (XERK-331, `committedTicketSpawn`). The guard
  runs AHEAD of the queue/refuse branches on the org's whole fleet, so a spawn stranded on a busy,
  offline or lower-ranked host can't let a second click route a duplicate onto a sibling (the D3
  double-start) or into a second queue entry. It reasons about DELIVERY as `reclaimStrandedTicketSpawns`
  (XERK-303) does — the exact COMPLEMENT of what that withdraws: a **delivered** command anywhere, or
  an **undelivered** one on an **online** host, blocks (reuse its cmdId); an **undelivered** one on an
  **offline** host does NOT (reclaim owns it — blocking would strand the ticket forever). It stays a
  double-CLICK guard, never "one session per ticket ever" — the `+` button and a fresh Start still work.
- Button states (`ticketStartHtml`): triaged = live button (uncloned reads "☐ Start (clone first)",
  clones on demand); "no repo"/untriaged = none. A failed start shows its reason beside a live button.
- In-flight state clears on **evidence, not a timer**: the spawn's `cmdId` reported, or the command
  clearing from the queue (covers an agent REFUSAL). A `{queued}` reply clears the pending outright
  and paints from `ticketQueue` (XERK-296).
- The press is acknowledged **instantly and survives leaving the board** (XERK-18): fires on
  `pointerdown` (before the beat's `innerHTML` replace), `click` for keyboard; `startSession` repaints
  **synchronously before the fetch**; POST is **`keepalive:true`** so it outlives the page.
  `sweepStarts` verdict (`startSweepVerdict`, pure/unit-tested): a cmdId-less pending always holds;
  "command gone" counts as acked only once **seen present** (`sawCmd`) — the SSE poll may not yet
  have seen a just-queued one.

#### Splitting ticket sessions across an org's agents (XERK-14)

- A host-pinned ticket skips all of the below — the pin is authoritative; a dead pinned host
  refuses rather than reroutes.
- `findTicketHost` picks among **ONLINE** hosts: prefers cloned-repo, then most-available
  (`hostAvailability`). Under `requireFree` (every ticket spawn) a **full host is not a target**:
  with none free the ticket queues hub-side, routed on a later pass.
- `hostAvailability(a)` = `capacity.free` **minus queued + in-flight spawn commands** since its last
  heartbeat — subtracting in-flight is what makes rapid clicks split. A host predating `capacity`
  scores below one that reports it.
- **No host has the repo → clone on demand** — `findTicketHost` returns `{host, needsClone:true}`;
  `spawn_ticket` clones and queues behind it, never a refusal.
- **Only a TRIAGED host is eligible, and the hub resolves a ticket exactly as the board does**
  (XERK-325) — full rule, and everything downstream of it, in `.claude/rules/board-ticket-view.md`
  (loads on the same files, plus the vendored board copies and Android's `Board.kt`).

#### The hub's ticket queue (XERK-296)

Waiting work is a queued TICKET on the hub; its host is chosen at dispatch. Rule in `CLAUDE.md`;
mechanics — admission, drain, expiries, caps — in `.claude/rules/turma-ticket-queue.md` (same
`paths:`).

#### Auto-starting To Do tickets (XERK-32)

- An org can **opt in** so the hub auto-starts every **To Do** ticket the moment it has a repo
  (triage or manual pin). Off by default.
- **Opt-in is HUB-ONLY** (XERK-41): the header org menu's "auto" switch. `POST
  /api/jira/<siteKey>/autostart {enabled}` → `setAutoStartOrg`, stored in `autostart-orgs.json`
  (`AUTOSTART_ORGS_FILE` on `/data`, keyed by siteKey, presence = enabled), rides the payload as
  `autoStartOrgs` + SSE. **No agent-side flag** — toggling needs no agent redeploy.
- **Decision + routing live on the HUB**. `autoStartSweep()` (15s, boot-grace-gated) walks each
  opted-in org's To Do tickets with a `repoGuess.repo` and **queues** them; `drainTicketQueue`
  routes through the **same `findTicketHost`** the button uses. The sweep decides WHICH, not WHERE.
- Never opens a **second** session for work already started — three guards, increasing strength:
  `startedTicketKeys()` (durable: any channel including a killed session counts as handled), an
  in-flight `spawnTicket` on some host, and `autoStarted` (in-memory attempt record — the only thing
  stopping a spawn the agent **refuses** from requeueing every sweep).
- **A queued `spawnTicket` is an ATTEMPT, not a start** (XERK-61), so auto-start **retries on
  growing backoff and never gives up** (XERK-109): `AUTO_START_RETRY_MS` doubles 1/2/4/8min, holds
  at `AUTO_START_RETRY_MAX_MS` (10min) past `AUTO_START_BACKOFF_STEPS` (5).
  - The agent **acks a refusal/mid-spawn exception exactly like a success**, so a transient failure
    leaves no session. **Never reintroduce an attempt CAP** — a hard give-up blacklists a ticket for
    the hub's lifetime even after the condition clears. No-online-host spends NO attempt.
  - Retry gate is **evidence, in the sweep's existing order**: any-channel session ends attempts; an
    in-flight command or queue slot concludes nothing; only a session-less, nothing-pending, past-
    backoff ticket re-queues.
- Nothing is written to Jira.

#### Auto-stopping Done tickets (XERK-45, XERK-161)

- Auto-start's counterpart: moving a ticket to **Done** **kills** its session(s) — only a **human**
  moves it there. **Independent of the per-org "auto" opt-in** (XERK-161), which governs only
  auto-STARTING.
- **KILLS, not interrupts** — clean end (resumable, worktree/PR chips intact), frees the
  `MAX_SESSIONS` slot an interrupt would hold.
- `autoStopSweep()` (15s) reads every org's Done tickets, scans the fleet for sessions naming one,
  kills each **live** one (`running`/`queued`) on its host. Guard: `autoStopped`
  (`<host>\x00<sessionId>`, once per hub lifetime).
- Tests: the `auto-stop:` cases in `server.test.js`.

### Ticket ↔ session chips

- A ticket's session chips come from `ticketSessionIndex` — a reverse index of the fleet payload's
  `session.ticket`, so **no hub-side ticket store exists to keep in sync**. Reads the same three
  channels the Ended list merges.
  - Deduped on `<host>::<transcriptId>` (registry record wins — only it knows id/createdAt/rename).
    NOT deduped across hosts (a shared `~/.claude` transcript id isn't fleet-unique); a
    restart-clear-context session legitimately chips twice.
- **A chip links by run state, not channel**: running → `?session=<id>`; else → `?ended=<id>`; no
  transcript → no link. `?session=`'s wait only resolves a **running** session, so a stopped/killed
  chip must use `?ended=` — the by-id wait is now bounded (`SELECT_FOLLOW_MS`, XERK-293) but only
  ever lands on the EMPTY stage with a "never came up" toast, never on the ended read-only view.
- Chip is **labelled with the BRANCH**, not the session name (tells two sessions on one ticket
  apart); a manual rename leads once it exists.
- Reverse link: Sessions card meta shows the ticket key; chat footer carries a linked `jira-chip`
  pointing at Turma's OWN board (`/board?ticket=<key>&site=<siteKey>`, not out to Jira — XERK-16).
  `consumeDeepLink` is one-shot: waits for the org, opens the panel, strips params.

### Ticket detail panel

- **Clicking a card expands it** (`detailHtml`): full description/comments/people/parent/labels,
  painted instantly from heartbeat fields then filled from `GET /api/jira/<siteKey>/<issueKey>`
  (`ingestJiraIssues`, cached by `JIRA_ISSUE_FRESH_MS`/`_MAX_AGE_MS`/`_MAX` and stripped from
  `/api/agents`; a `jiraIssue` command is queued and 202'd if stale). An offline-only org serves its
  last copy flagged `stale`; a cached
  `error` is kept so a doomed fetch isn't re-queued. Fetched copy wins field-by-field; panel escapes
  before linkifying.

#### The row pickers — one pattern, five rows

Repo / Agent / Model / Runtime / Status each swap in place for a `<select>` on "Change". Shared
rules; each subsection carries only its deltas.

- **Choosing an option IS the save** — no Save button (one silently discarded the choice on close).
  Re-picking the showing value saves **nothing**, so the compare value and the preselect value must
  not drift or a real change reads as a no-op.
- A value that has **left the options** is carried back under "Currently set" so it stays selected,
  else the browser falls back to its first option — a silent release. Saves **optimistically**; a
  failure rolls back and says so on the row.
- Options merge **across the org's hosts** (`mergeSites`) — the union can offer what one host lacks.
  "Change" needs an ONLINE host of that org; edit state lives in a page variable, not the DOM.
- `refreshOpenTicket` re-points the open panel each beat, holding the optimistic paint for
  `REPO_SETTLE_MS`, never repainting while the picker is open.

##### Repo row

- Picker of `jira.repoOptions` (cloned/uncloned in separate groups, plus "No repository fits"/"Let
  the agent decide") → `/api/jira/<siteKey>/<issueKey>/repo`. **202-on-queue** (agent owns the
  ledger), unlike Agent/Model below.
- Shown even for **untriaged** ("Not triaged yet"). **Only a manual pin preselects a repo** — an
  auto guess must not be misreported as a pin.
- Options collected over EVERY agent (not the winners loop), else the picker offers only whichever
  host polled last; cloned wins the dedupe.
- POST **fans out to every host of that org — including OFFLINE** (ledger is per-host, board merges
  by `siteKey`; a missed host would silently revert the pin). Tests:
  `repoPickerHtml`/`repoFieldHtml` in `board.test.js`.

##### Agent row (XERK-38) and Model row (XERK-123)

Both **panel-only, hub-owned durable state** (not the ledger fan-out the Repo row uses — the hub
routes the spawn) under `/data` (`ticket-agents.json`/`TICKET_AGENTS_FILE`,
`ticket-models.json`/`TICKET_MODELS_FILE`; keyed `<siteKey>/<issueKey>`, bounded `*_MAX`
oldest-first), NOT best-effort `state.json`. So `POST .../agent`|`/model` answers **200**
authoritatively, riding `/api/agents` as `ticketAgents`/`ticketModels` + SSE. Both feed the Start
button and the auto-start sweep.

- **Agent row** — which HOST spawns this ticket, default "Auto"; picker of `mergeSites`'
  `hostOptions` (online-first). `{host}` pins, `{auto:true}` releases, allowlist-checked against
  hosts of that org (offline pinnable, other-org not). `findTicketHost` honors it over availability
  ranking; a pinned-but-offline host **refuses with the pin named, never silently reroutes**.
- **Model row** — which MODEL runs, default "Default"; rides `spawnTicket`'s `model`
  (`ticketModelPin`). Alias must be one the org **actually offers** (`orgModelAliases`: its hosts'
  probed `models.available`, non-bracketed, + static aliases); agent re-validates;
  unpinned omits `model`. Menu falls back to static aliases if un-probed, never empty.
- Tests: `server.test.js`; `modelPinOf`/`modelPickerHtml`/`modelChoices` in `board.test.js`.

##### Runtime row (XERK-473 dsh, XERK-515 qwen)

- **Which RUNTIME runs the session** — Claude (default), dsh (XERK-460) or Qwen (XERK-504).
  Hub-owned durable like Model (`ticketRuntimes` → `spawnTicket`'s **`agentType`**), needs no online
  host to edit. `{runtime:"dsh"|"qwen"}` pins; `{runtime:"claude"}`/`{auto:true}` release (only
  non-default stored). dsh side: `.claude/rules/dsh.md` [I]; qwen twin ([Qwen I], XERK-515) lives
  HERE (the bullets below), not duplicated in `qwen.md`.
  - **KNOWN GAP with the per-host default (XERK-521): a `{runtime:"claude"}` release does NOT force
    claude when a host DEFAULTS to a non-claude runtime.** The pin is dropped, so `spawnTicket`
    carries no `agentType` and the claiming host applies its own `TURMA_DEFAULT_RUNTIME` (possibly
    dsh/qwen). A dsh/qwen pin overrides (stores + forwards `agentType`); only claude is
    release-not-pin. Closing it needs the picker to split "Auto — host default" from a pinned "Claude
    Code" across this file's four mirrors (`board.js` + vendored `board.cjs` + `Board.kt` + glasses)
    — a UX change deferred to a follow-up. Latent today (dsh/qwen behind their kill switches).
- **Offered only when the org offers it** (`site.dshAvailable`/`site.qwenAvailable` via
  `mergeSites`; `orgOffersDsh`/`orgOffersQwen` gate hub-side) — but an existing pin is always
  carried back so it can be released even after the last capable host leaves.
- **Dispatch filters the pool by runtime capability, per-runtime**: `findTicketHost` carries
  `wantRuntime` + `runtimeOfferedBy(a)`, checked ahead of capacity so "no host offers X" reads
  **blocked** (ages out) not **full** (clears itself); a pinned host lacking the runtime is
  reported, never routed around. Agent re-validates (`resolve_agent_type`).
- **The agent side is UNCHANGED for both runtimes** — `spawn_ticket` forwards `agentType`,
  `_launch_tmux` dispatches to the runtime launcher (already appends the ticket-branch directive),
  so NO new launch code. `QWEN_ENABLED` False means a qwen pin cannot reach launch in production
  yet. Collectors, tracker writes and `_board_column` are runtime-agnostic — the pin is orthogonal
  to a ticket's column.
- **Shipped on Android**: dsh row (XERK-477, `RuntimeSection`), qwen beside it (XERK-515,
  `qwenBySite` gated on `Runtime.QWEN_ENABLED`, `runtimeEditable(dshAvailable, qwenAvailable, pin)`
  — a signature every caller must pass). Vendored `board.cjs` stays byte-identical to `board.js`.
- Tests: `server.test.js` (`/runtime` route + dsh/qwen `findTicketHost`/spawnTicket cases);
  `runtimePinOf`/`runtimeFieldHtml`/`runtimePickerHtml`/`mergeSites` (both runtimes); Android
  `BoardTest.kt`.

##### Status row (XERK-138) — the one control that writes BACK to the tracker

- Picker of statuses the ticket can move to, "keep current" first.
- **Options are the board's own, fetched with the issue** (`statusOptions: [{id,name,category}]`):
  Jira transitions or Azure states, less the current one. Empty → read-only.
- **The write is re-validated against a FRESH read.** `POST .../status {value}` single-flight per
  ticket; agent applies only a still-on-offer `value`; hub checks non-empty only (it can't see the
  live option set).
- Outcome rides back keyed by `cmdId` (`statusResults`, stripped from `/api/agents`); panel polls
  until `{ok}`/`{error}` then re-fetches; card's COLUMN catches up next poll.
- Tests: `server.test.js`; `statusFieldHtml`/`statusPickerHtml` in `board.test.js`.

#### Drag-and-drop status change (XERK-141)

- Drag a card into another column — the XERK-138 write path above, reached by a gesture.
- **The drop POSTs the target COLUMN, not a transition** (`{category}` on the SAME
  `setTicketStatus` command) — a card never loaded the ticket's transitions. Agent resolves against
  a fresh read; no match refuses.
- **An optimistic `moves` override holds the dropped column across repaints** until the board's own
  poll confirms it, else it snaps back each beat. `boardColumnOf` honours BOTH `pending` and
  `settled` — `pending` alone snaps back then jumps forward again. `moveSweepVerdict` clears on
  match or a backstop TTL.
- Web: pointer long-press + ghost + column highlight, suppressing the synthesized click. Android:
  `detectDragGesturesAfterLongPress` + ghost, same override.
- Tests: `server.test.js`; `boardColumnOf`/`moveSweepVerdict`/`boardHtml` in `board.test.js`.

#### When a host's agent is too old for a write (XERK-151)

- An agent **acks** a command it doesn't implement (a poison command must not retry forever), so an
  older host reads as slow and the write's 202 poll never resolves. **The ack IS the evidence** —
  these commands stage their result in the SAME `handle_commands` call, so an ack with no result
  means unhandled.
- `awaitResult`/`resolveResultWaits` settle each queued command, writing `agent.unsupported[kind]`;
  waiting routes refuse with `agentGapError` — create-meta `200 {error}`, create/status `409`.
- A gap **clears** on a result landing, `agentVersion` changing, or `UNSUPPORTED_TTL_MS` (backstop
  for a version that doesn't move). Conclude nothing from a queued command. `resultWaits` is
  stripped from the payload; `unsupported` rides it. Tests: `server.test.js`.

### Refresh button

- `POST /api/jira/refresh` fans `refreshJira` to every **`configured`** host (not `available` — a
  failing host reports `available=false`, exactly the host a retry is for), deduped so a mashed
  button costs one poll per host.
- Resolves on real fleet state: holds until the command clears from targeted records
  (`jiraRefreshPending`, covers a poll that FAILED leaving `fetchedAt` untouched), `newestFetchedAt`
  as a second signal, 45s timeout; "Refresh failed" only when EVERY targeted host errored.
