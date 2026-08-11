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

Scoped to the board client plus `turma/server.js`, which owns the routing, ticket pins and the
auto-start/auto-stop sweeps. Read `.claude/rules/turma.md` for the rest of the dashboard and
`CLAUDE.md` for the cross-cutting contracts.

- One cross-org Jira Kanban built from every agent's `jira` block (`turma/public/board.js`,
  dual-exported for tests). `mergeSites` collapses hosts sharing an org into one board keyed by
  `siteKey` (freshest block wins per site+user; different users on one site union, deduped by issue
  key). Columns are Jira's three status categories, each card's pill showing the org's status name.
- A fourth **In Review** column (XERK-23) sits between In Progress and Done. Jira has no cross-org
  category for review/testing (both `indeterminate` → `inprogress`), so `categoryOf` carves it out
  on the org-specific status NAME (`isReviewStatus`, word-boundary: review/testing/QA/**resolved**),
  only ever pulling FROM `inprogress`.
  - `resolved` is there for **Azure DevOps** (XERK-250), whose state set is New/Active/Resolved/
    Closed/Removed: `Resolved` means "fixed, not yet verified" and reaches clients as `inprogress`,
    so the name is the only thing that can place it. A Jira "Resolved" is normally a `done` status,
    which the carve-out cannot pull from.
  - **The rule has FIVE mirrors** — see `CLAUDE.md`'s cross-cutting contracts for the list.
- **The columns are ALWAYS one horizontal row, at every width** (XERK-253, `.kanban-cols` in
  `app.css`): a flex strip that scrolls sideways once four readable columns stop fitting. Never
  re-introduce a breakpoint that wraps them underneath each other — stacked columns stop reading as
  a Kanban, and the position of a column would then depend on the viewport. Android's `BoardScreen`
  has always been a scrolling `Row`, so this is also what keeps the two surfaces the same shape.
- Scoped by the **header's org filter**, not a strip of its own: `TurmaOrg.getKeys()` each render,
  passed to `boardHtml`.
- An org is **labelled by `orgName(siteKey)`** — the site host minus `.atlassian.net` (full host as
  tooltip), which the agent's **`BOARD_ORG_NAME`** overrides outright (`orgName(siteKey, override)`,
  carried by `mergeSites`) since a self-hosted Azure collection otherwise derives to its COLLECTION.
  Labels are presentational and deliberately **not** part of the `siteKey`, which the hub
  keys/merges/routes on and which `/api/jira/<siteKey>/…` and the ticket-agent/auto-start ledgers
  are stored under — renaming it orphans all of those. Tests: `TestBoardOrgName`, `board.test.js`.
- Each org gets a **UNIQUE color** — no two share a `--s1..--s8` palette slot (`orgColorMap(allKeys,
  pins)`, XERK-48), computed over the whole org set: in sorted key order each takes its
  djb2-preferred slot if free, else linear-probes to the next free one. **Persistent where it can
  be** — an org keeps its color unless its preferred slot actually collides, and then only the
  *colliding* orgs move. Unique up to 8 orgs; overflow falls back to its preferred slot.
  - **Pinnable by hand** (XERK-145): the header org menu's color dot expands a swatch strip (8 slots
    + "auto" release). Hub-owned durable state like the auto-start opt-in — `POST
    /api/jira/<siteKey>/color` `{slot:1..8}`/`{auto:true}`, persisted in `/data/org-colors.json`,
    riding the fleet payload + an `orgColors` SSE event (web reads them via `TurmaOrg.orgColors()`).
    A pinned org gets EXACTLY its slot (two pinned to one slot share it — the operator's choice
    beats uniqueness) and auto orgs probe around the pins; a malformed pin is ignored.
  - It also **tints the CARD BACKGROUND on every surface** (XERK-142): board ticket, Sessions
    session and Dashboard host cards. Web sets `--org` (a `var(--sN)`) inline per card and
    `color-mix`es it **12% into `--surface`**; no org falls back to plain surface. Computed over the
    WHOLE fleet's org set, not the header-filtered view, so a card's colour is stable regardless of
    the filter.
- The board READS the tracker; it makes exactly **two** writes back to it — **creating a ticket**
  (XERK-137) and **changing a ticket's status** (XERK-138). Every other control writes a hub/agent
  ledger, never the board.

### Creating a ticket (XERK-137)

- The **"New ticket"** button opens a modal to create a ticket (title, description, labels) on an
  org's tracker — source-agnostic across Jira and Azure DevOps, hidden until an org reports. It
  lives in the **shared site header** (`newticket.js` → nav.js's `#hdrNewTicket` slot, XERK-150),
  not the board toolbar; fed the beat by `TurmaNewTicket.update(data)`, form HTML in `board.js`. It
  rides the command → staged result → poll pattern, against a ranked ONLINE host of the org:
  - `GET /api/jira/<siteKey>/create-meta` (`boardCreateMeta`) → the org's projects + existing
    labels/tags; `?project=<p>` → that project's creatable types, a cascade so no meta call fans
    across every project. Cached per host, 202-polled.
  - `POST /api/jira/<siteKey>/tickets` (`createTicket`) → the agent creates and stages `{cmdId, key,
    url, error, warning}`; polled at `GET .../tickets/<cmdId>` (`createResults`). All three caches
    are stripped from the fleet payload.
- **An org's hosts are health-ranked (`jiraHostHealthy`: online, then `jira.available`) and a board
  write is OWNED by the host that took it** (XERK-241): the poll reads only that owner
  (`commandHost`) — judging a create by a SIBLING's liveness is what made four tickets. Giving up on
  a create **withdraws** it even when delivered: delivery is at-least-once and the agent's acked-set
  is in-memory, so one left queued re-RUNS on that host's return; `deliveredAt` decides only the
  WORDING (undelivered provably did nothing, delivered "may have been created"). A retry rejoins an
  unresolved identical create (`createInFlight`, over the WHOLE body); creates round-robin past
  gapped hosts, and the status single-flight spans the org's ONLINE hosts.
- Tests: `server.test.js`; `createFormHtml` in `board.test.js`.

### Repo chips

- Each card shows the **repo the agent triaged the ticket to** (`repoChipHtml`, from `repoGuess`) in
  three states: **cloned** on the reporting host is a plain actionable chip, one only in the org's
  `gh` listing is **dashed**, a declined ticket a muted italic **"no repo"** — and no `repoGuess`
  yet gets **no chip** ("not looked at yet" ≠ "no repo fits"). The rationale is the tooltip and the
  detail panel's Repo row (`repoFieldHtml`, reading `t.repoGuess` directly — the guess is on the
  heartbeat ticket, not the on-demand fetch).
- `.kc-repo` ellipsises on **its own element** — `text-overflow` can't clip anonymous flex content.

### Starting a session on a ticket

- Each card carries a **start button**: `POST /api/jira/<siteKey>/<issueKey>/session` → a
  `spawnTicket` command. **The hub's whole job here is ROUTING** — it sends just the issue key;
  `findTicketHost` picks the host, and online is **required**, not preferred (unlike the read-only
  ticket GET). `ticketRepo` resolves the repo from the **freshest** reporting block; org is checked
  before repo (`isIssueKey` validates the key); single-flight per ticket (a second session comes
  from the `+` button and the -1/-2 branch).
- The button's states are distinct (`ticketStartHtml`): a triaged ticket gets a live button whether
  or not the repo is cloned (an uncloned repo reads **"☐ Start (clone first)"** and clones on
  demand); a "no repo" verdict and an untriaged ticket get none. A failed start renders its reason
  beside a LIVE button.
- In-flight state clears on **evidence**, not a timer: a session reporting the spawn's `cmdId`, or
  the command clearing from the host's queue (which covers a spawn the agent REFUSED).
- The press is acknowledged **instantly and survives leaving the board** (XERK-18): the button acts
  on **`pointerdown`** (fired before any re-render — the board `innerHTML`-replaces every beat),
  `click` the keyboard path, both via `startFrom` whose pending guard no-ops a double-fire;
  `startSession` sets pending and repaints **synchronously, before the fetch**; the POST is
  **`keepalive: true`** so it outlives the page. `sweepStarts`' verdict is `B.startSweepVerdict`
  (pure, unit-tested): a cmdId-less pending always holds, and "command gone" counts as acked only
  once the command was **seen present** (`sawCmd`) — the SSE poll may not yet have seen a
  just-queued one.

#### Splitting ticket sessions across an org's agents (XERK-14)

- A ticket pinned to a host skips all of the below: the pin is authoritative, and a dead pinned host
  refuses rather than reroutes.
- `findTicketHost` chooses among the org's **ONLINE** hosts: **prefers one with the repo cloned**,
  and — within that group, or across all when none has it — picks the **most available**
  (`hostAvailability`). A momentarily-full host is still valid: the session **queues** there.
- `hostAvailability(a)` = `capacity.free` **minus `capacity.queued` and the spawn/spawnTicket
  commands still queued** since its last heartbeat — subtracting in-flight commands is what makes
  rapid clicks split. An agent predating `capacity` scores below one that reports it.
- **No host has the repo → clone on demand.** `findTicketHost` returns `{host, needsClone:true}` for
  the most-available host; `spawn_ticket` clones it and queues behind the clone — never a refusal.
- The **multi-host-per-org limits still apply**: the triage/branch state is per-host, so a
  clone-on-demand routed to a host that didn't triage the ticket has no ledger entry to clone from.

#### Auto-starting To Do tickets (XERK-32)

- An org can be **opted in** so the hub auto-starts a session for every **To Do** ticket the moment
  it has a repo assigned (by triage OR a manual pin). Off by default.
- **The opt-in is HUB-ONLY (XERK-41)** — the "auto" switch on each org row of the header's org menu
  is the whole control. `POST /api/jira/<siteKey>/autostart` `{enabled}` → `setAutoStartOrg`, stored
  in `autostart-orgs.json` (`AUTOSTART_ORGS_FILE` on `/data`, keyed by siteKey, presence = enabled),
  riding the fleet payload as top-level `autoStartOrgs` plus an SSE event. **No agent-side flag**,
  so toggling never needs an agent redeploy.
- **The decision and routing live on the HUB** (only it sees the whole fleet). `autoStartSweep()` (a
  15s `setInterval`, boot-grace-gated) walks each org in `orgsWithAutoStart` and routes a
  `spawnTicket` through the **same `findTicketHost`** the button uses, for each To Do ticket with a
  `repoGuess.repo`.
- Never opens a **second** session for work already started. Three guards, increasing in strength:
  `startedTicketKeys()` — durable, a ticket carrying a session on ANY channel (`a.sessions`,
  `a.closedSessions`, a repo's `resumable` scan) is handled, a **killed** session counting; an
  in-flight `spawnTicket` on some org host, covering the window before it first heartbeats; and
  `autoStarted`, an in-memory per-ticket ATTEMPT record, the only thing stopping a spawn the agent
  **refuses** from re-queueing every sweep.
- **A queued `spawnTicket` is an ATTEMPT, not a start** (XERK-61), so auto-start **retries on a
  growing backoff and never gives up** (XERK-109): a doubling `AUTO_START_RETRY_MS` (1/2/4/8 min)
  HOLDING at `AUTO_START_RETRY_MAX_MS` (10 min) once `AUTO_START_BACKOFF_STEPS` (5) is reached,
  tracked in `autoStarted` as `{attempts, nextAt}`.
  - The agent **acks a refusal and a mid-spawn exception exactly like a success**, so a TRANSIENT
    failure leaves no session. **Never re-introduce an attempt CAP**: any hard give-up blacklists
    such a ticket for the hub's lifetime even after its condition clears. A **no-online-host**
    result likewise spends NO attempt, so it retries once a host returns.
  - The retry gate is **evidence, in the sweep's existing order**: a session on any channel ends the
    attempts and drops the record; an in-flight command concludes nothing; only a still-session-less
    ticket with nothing in flight, past its backoff, is retried. A queued session reports its
    `ticket` from the first beat, so a slow spawn is never mistaken for a failed one.
- Nothing is written to Jira.

#### Auto-stopping Done tickets (XERK-45, XERK-161)

- The lifecycle **counterpart** to auto-start: moving a ticket to **Done** **kills** its session(s)
  — only a **human** moves it there, a deliberate "finished" signal. **Regardless of the per-org
  "auto" opt-in** (XERK-161), which governs ONLY auto-STARTING work.
- The hub **KILLS**, not interrupts: a kill ends it cleanly (Ended, resumable,
  worktree/conversation/PR chips intact) and frees the `MAX_SESSIONS` slot an interrupt would leave
  it holding.
- `autoStopSweep()` (15s `setInterval`) reads **every** reporting org's **Done** tickets from its
  freshest block, then scans the WHOLE fleet for sessions whose `ticket` names one, routing each
  `{type:"kill", sessionId}` to the owning host. Only **live** ones (`running`/`queued`) are
  stopped, and every session on the ticket is (a two-branch or restart-clear-context ticket has more
  than one). Guard: `autoStopped`, a `<host>\x00<sessionId>` once-per-hub-lifetime set.
- Tests: the `auto-stop:` cases in `server.test.js`.

### Ticket ↔ session chips

- A ticket's sessions show as chips on its card, from `ticketSessionIndex` — a reverse index of the
  fleet payload's `session.ticket`, so **no hub-side ticket store exists to keep in sync**. It reads
  the **same three channels the Ended list merges**; the resumable one gets its ticket from the
  agent's ledger.
  - Deduped on `<host>::<transcriptId>`, the **registry-backed record winning** (only it knows the
    id, `createdAt`, and the rename); resumable is swept last. NOT deduped across hosts (the shared
    `~/.claude` syncs transcripts, so an id alone isn't fleet-unique), and a **restart-clear-context
    session legitimately chips twice**.
- **Where a chip links follows the run state, not the channel**: running → `?session=<id>` (live
  chat); anything else → `?ended=<transcriptId>`; no transcript → not a link. The Sessions page's
  `?session=` wait only resolves a **running** session (`sessionHit`) and never times out, so
  pointing a stopped/killed chip at it parks on "Opening session…" forever.
- The chip is **labelled with the BRANCH**, not the session name (the branch tells two sessions on
  one ticket apart); an operator's rename (`summaryManual`) leads once it exists, and the live git
  branch beats the reserved one. Its label ellipsises on **its own element** (`.kc-sess` is a flex
  container).
- The reverse link rides the session: the Sessions card meta shows the ticket key (a plain span —
  the card is a `<button>`), and the chat footer carries a linked `jira-chip` beside the PR chip
  (`ticketFooterChip`) pointing at Turma's OWN board — `/board?ticket=<key>&site=<siteKey>`, not out
  to Jira (XERK-16). `consumeDeepLink` (`board.html`) is one-shot: waits for the org to report,
  opens the panel on the first render resolving the key, strips the params; `site` is optional.

### Ticket detail panel

- **Clicking a card expands it into a detail panel** (`detailHtml`) with the full description,
  comments, people, parent, and labels, painted instantly from the card's heartbeat fields then
  filled from `GET /api/jira/<siteKey>/<issueKey>` — routed to a host reporting that org (preferring
  online), serving a fresh cached copy or queueing a `jiraIssue` command and 202-ing for the client
  to poll (`ingestJiraIssues`, cached by `JIRA_ISSUE_FRESH_MS`/`_MAX_AGE_MS`/`_MAX`, stripped from
  `/api/agents`). An offline-only org serves its last copy flagged `stale`; a cached `error` is kept
  so a doomed fetch isn't re-queued. The fetched copy wins field-by-field; its text is plain, so the
  panel escapes before linkifying.

#### The row pickers — one pattern, four rows

The Repo / Agent / Model / Status rows each swap in place for a `<select>` on **"Change"**. All four
share the rules below; each row's subsection carries only its deltas.

- **Choosing an option IS the save** — every option is a complete answer, so picking one commits and
  closes; **Cancel** is the way out. No Save button: with one, closing the panel discarded the
  choice silently. Re-picking the showing value saves **nothing**; the value the handler compares
  against and the one the picker preselects from must not drift, or a real change reads as a re-pick
  and is dropped.
- A set value that has **left** the options is carried back under "Currently set" so it stays
  selected, else the browser falls back to its first option, turning an untouched panel into a
  silent release. The save paints **optimistically**; a failure rolls it back and says so on the
  row.
- Options merge **across the org's hosts** (`mergeSites`); the known limit is that the union can
  offer what one host lacks. "Change" needs a host of that org **online**, and the edit state lives
  in a page variable, not the DOM.
- `refreshOpenTicket` re-points the open panel at the rebuilt ticket each beat (`mergeSites` builds
  fresh objects) — holding the optimistic paint for `REPO_SETTLE_MS`, repainting only on a changed
  rendered field, never while the picker is open.

##### Repo row

- A picker of the org's `jira.repoOptions` — cloned and un-cloned repos in separate `optgroup`s,
  plus "No repository fits" and "Let the agent decide", POSTing to
  `/api/jira/<siteKey>/<issueKey>/repo`; `repoPickerValue`/`repoPickerHtml` are the
  compare/preselect pair. It answers **202-on-queue** (the agent owns the ledger), unlike the
  Agent/Model rows below.
- Present even for an **untriaged** ticket, reading "Not triaged yet". **Only a manual pin
  preselects a repo**: an auto guess is the model's answer while the operator's setting is "let it
  decide", and preselecting it would misreport that as a pin.
- Options are collected next to `hosts` over EVERY agent, not in the winners loop (one block per
  (site, user), else the picker offers only whichever host polled Jira last); cloned wins the
  dedupe.
- The POST **fans out to every host reporting that org — including OFFLINE ones** — because the
  ledger is per-host while the board merges by `siteKey`, so a host that misses the pin can silently
  revert it. `cloned` is host-relative. Tests: `repoPickerHtml`/`repoFieldHtml` in `board.test.js`.

##### Agent row (XERK-38) and Model row (XERK-123)

Both **panel-only** (no card chip) and both **hub-owned durable state, NOT an agent-ledger fan-out**
like the repo override — the hub is what routes a spawn, so each persists under `/data`
(`ticket-agents.json`/`TICKET_AGENTS_FILE`, `ticket-models.json`/`TICKET_MODELS_FILE`; keyed
`<siteKey>/<issueKey>`, bounded `*_MAX` oldest-first), NOT in the best-effort `state.json`. So `POST
/api/jira/<siteKey>/<issueKey>/agent`|`/model` answers an authoritative **200**, and each rides
`/api/agents` as top-level `ticketAgents`/`ticketModels` plus an SSE event of that name. Both feed
the Start button AND the auto-start sweep.

- **Agent row** — which HOST this ticket's sessions spawn on, defaulting to "Auto — most available
  agent"; a picker of `mergeSites`' per-site `hostOptions` (every host reporting the org, online
  first, offline marked). `{host}` pins, `{auto:true}` releases, allowlist-checked against the
  fleet's hosts reporting that org, so an OFFLINE host is pinnable but a host of another org is not.
  `findTicketHost` honors it over the availability ranking; a pinned host that's offline (or gone)
  **refuses with the pin in the error, never silently reroutes**. A pinned host without the repo
  clones on demand and queues behind it.
- **Model row** — which MODEL the session runs, defaulting to "Default — the agent's default model";
  delivered on the `spawnTicket` command the hub already routes (`ticketModelPin` → the command's
  `model`). `{model}` pins, `{auto:true}` or `{model:"default"}` releases. The alias must be one the
  org **actually offers** (`orgModelAliases`: its hosts' probed `models.available`, non-bracketed, +
  the static family aliases) and the **agent still re-validates** it host-side; an unpinned ticket
  omits `model`. The picker offers the curated menu (`modelChoices`/`prettyModel`); an un-probed org
  falls back to the static aliases, never an empty menu.
- Tests: `server.test.js`; `modelPinOf`/`modelPickerHtml`/`modelChoices` in `board.test.js`.

##### Status row (XERK-138) — the one detail control that writes BACK to the tracker

- A picker of the statuses the ticket can move to, "keep current" first as the no-op.
- **The options are the board's own, fetched with the issue, not a fixed list.** The detail carries
  `statusOptions` (`[{id, name, category}]`): Jira's available **transitions** (labelled by the
  resulting status, valued by transition id), or Azure's **states** for the work-item type (id ==
  the state name, less the current one). Empty → the row stays read-only.
- **The write is re-validated against a FRESH read.** `POST /api/jira/<siteKey>/<issueKey>/status
  {value}` is single-flight per ticket; the agent applies only a `value` still on offer. `value`
  passes through the hub checked non-empty, not allowlisted there, since only the agent can see the
  live option set.
- **The outcome rides back keyed by the queued cmdId** (`statusResults`, stripped from
  `/api/agents`). The panel polls `GET .../status?cmdId` until `{ok}`/`{error}` then re-fetches the
  detail; the card's COLUMN catches up next poll.
- Tests: `server.test.js`; `statusFieldHtml`/`statusPickerHtml` in `board.test.js`.

#### Drag-and-drop status change (XERK-141)

- **Drag a card into another column to change its status** — the XERK-138 write path above,
  unchanged, reached by a gesture.
- **The drop POSTs the target COLUMN, not a transition** (`{category}` on the SAME `setTicketStatus`
  command the picker's `{value}` uses): a board card never loaded the ticket's transitions, so the
  client can't name one. The agent resolves it against a fresh options read; no match refuses.
- **An optimistic `moves` override holds the card in its dropped column across repaints** until the
  board's own (slow) poll reports it there, else it snaps back each ~1s beat. `boardColumnOf`
  renders it through BOTH the in-flight `pending` state AND the `settled` state after it — honouring
  `pending` alone lets the card snap back until the next poll, then jump forward again. The sweep
  (`moveSweepVerdict`) clears it only once the poll has caught up (`categoryOf` == the dropped
  column) or a backstop; a failure reverts after a short TTL. On settle the client nudges `POST
  /api/jira/refresh`.
- Web: a pointer long-press drag with a floating ghost + column highlight in `board.html`; a real
  drag suppresses the click it would synthesize so a drop doesn't also open the panel. Android uses
  `detectDragGesturesAfterLongPress` + a ghost card in `BoardScreen.kt`, same override.
- Tests: `server.test.js`; `boardColumnOf`/`moveSweepVerdict`/`boardHtml` in `board.test.js`.

#### When a host's agent is too old for a write (XERK-151)

- An agent **acks** a command it doesn't implement (a poison command must not retry forever), so a
  host predating a board write feature reads as a slow one and the routes waiting on a staged result
  202 forever. **The ack IS the evidence**: these commands stage their result in the same
  `handle_commands` call, so it rides the SAME beat as the ack — an ack with no result means the
  agent didn't handle it.
- `awaitResult`/`resolveResultWaits` record and settle each queued command, writing
  `agent.unsupported[kind]`; the waiting routes refuse with `agentGapError` rather than queue —
  create-meta `200 {error}` (the shape both clients read), create/status `409`.
- A gap **clears** on a result landing, `agentVersion` CHANGING, or `UNSUPPORTED_TTL_MS` (the
  backstop for an update that doesn't move the version). Conclude nothing from a queued command:
  unACKED is not untaken. `resultWaits` is stripped from the fleet payload, `unsupported` rides it.
  Tests: `server.test.js`.

### Refresh button

- `POST /api/jira/refresh` fans a `refreshJira` out to every Jira-**`configured`** host, deduped so
  a mashed button costs one poll per host. `configured` (creds present) not `available` (a poll
  succeeded), because a failing host reports `available=false`/`siteKey=null` — exactly the host a
  retry is for; `siteKey` is the older-agent fallback.
- It resolves on real fleet state: holds until the command clears from the targeted hosts' records
  (`jiraRefreshPending`, covering a poll that FAILED leaving `fetchedAt` untouched), with
  `newestFetchedAt` as a second signal and a 45s timeout; "Refresh failed" only when EVERY targeted
  host errored (`jiraRefreshFailed`).

