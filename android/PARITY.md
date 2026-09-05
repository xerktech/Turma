# Android ⇄ Web UI parity (XERK-30)

The **mobile web UI (`turma/public/`) is the target**; this app must match it. See the
"Web UI ⇄ Android parity" rule in the repo `CLAUDE.md` for the workflow (web change → Android change
in the same PR, or a line here). This file is the living gap tracker.

Match **features and structure, not pixels** — every control/state/interaction the mobile web exposes
should be present and behave the same, in the platform-idiomatic form. Justified platform differences
are recorded under "Deliberate differences" below, not left to look like gaps.

## Web page → Android counterpart

| Web (`turma/public/`)         | Android                                                            |
|-------------------------------|-------------------------------------------------------------------|
| `index.html` (Dashboard)      | `ui/FleetScreen.kt`, `ui/FleetDialogs.kt`                          |
| `sessions.html` + `chat.js`   | `ui/SessionsScreen.kt`, `ui/ChatScreen.kt`, `vm/ChatViewModel.kt` |
| Sessions sidebar full-search  | `ui/SessionsScreen.kt`'s search box + "In history" section          |
| `board.html` + `board.js`     | `ui/BoardScreen.kt`, `core/Board.kt`, `vm/BoardViewModel.kt`       |
| `usage.html`                  | `ui/UsageScreen.kt`                                                |
| `nav.js` (header/bottom-nav)  | `ui/MainScaffold.kt`, `ui/TurmaApp.kt`                             |
| `org.js` (header org filter)  | `ui/OrgControl.kt`, `vm/OrgViewModel.kt`, `data/OrgFilter.kt`      |
| `login.html`                  | `ui/LoginScreen.kt`                                                |

## Deliberate differences (parity by intent, not omission)

- **Native chat instead of the ttyd terminal by default.** The web opens a native chat and keeps the
  raw terminal one toggle away; Android does the same, with the terminal as a separate screen.
- **Hub-URL field on Login.** The web is same-origin; a phone app must point at any hub, so Login has
  an extra Hub-URL field.
- **Voice dictation** into the spawn/compose fields — a phone-only addition.
- **Wide board column area on large screens (XERK-606).** The web board widens ONLY its Kanban
  column area past the shared reading width (`--wrap-board`, header/toolbar/footer stay centred at
  `--wrap`) so more of the fixed-300px columns show without horizontal scroll on a desktop monitor.
  No Android analog: the phone board is already a horizontally scroll-snapping strip of 300dp
  columns sized to the device, with no separate centred header column to hold in place. Web-only
  responsive/desktop layout; nothing for the phone to match.
- **On-screen-keyboard composer docking** — same behaviour, platform-idiomatic mechanism on each
  side. Web (`sessions.html`) pins its app-shell height to `window.visualViewport` so the composer
  docks just above the keyboard on tablets/foldables where `100dvh` over-shrinks. Android drives it
  through window insets: `ChatScreen`'s Scaffold carries `Modifier.imePadding()`, and `MainScaffold`
  calls `consumeWindowInsets(pad)` beside its `padding(pad)` so the wide (tablet) layout's nested
  chat doesn't re-apply the bottom-nav band on top of the IME inset (that double-inset left a
  nav-bar-height gap below the composer). Not a gap in parity — both dock the composer on the
  keyboard.
- **No hover tooltips on the two compose-bar model chips** (XERK-246); a phone has no hover, so the
  web's `title=` text goes to the accessibility layer or nowhere.
  - The **"run against"** chip: nowhere. Its tooltip only names the self-hosted model, which is
    already the chip's own text.
  - The **fixed-model** chip on a local session: it carries the web's wording as a
    `contentDescription` instead. That tooltip is not redundant — it explains why the chip is inert
    and names the way out — so dropping it entirely would leave a dead-looking control beside two
    live ones with no account of itself.
- **Ticket-detail fields tap-to-change** (XERK-138 follow-up). The web detail panel shows each editable
  field's value beside a separate "Change" link/control that swaps in a `<select>`. Android instead
  renders the value itself as the control — a pill with a trailing ▾ (`SelectableValue` in
  `BoardScreen.kt`) that opens the dropdown on tap — for the Status, Repo, Agent and Model rows. One
  tappable chip reads better on a phone than a value plus a separate button; a pick is still the save,
  same as the web.
- **In-app updater** (`ui/UpdateBanner.kt`) — a sideload stopgap until Play (XERK-11), no web analog.
- **Chat text-size control** (XERK-144) — a phone-only addition, no web analog. The chat settings menu
  (the top-bar ⚙/Tune button that holds verbosity) also picks a chat text size, scaling every bubble/
  thinking/tool font in `ui/TranscriptView.kt`. Unlike verbosity (per-session) it is ONE fleet-wide
  preference, stored in `data/TextSizePref.kt` and read by every transcript renderer through
  `LocalTextSize`. A phone screen and the range of eyesight reading it vary far more than a desktop
  browser (which has OS/browser zoom); the web can revisit this later.
- **Chat verbosity defaults to Concise** (XERK-40), where the web defaults to Normal — a phone screen
  fits far less, so tool cards/outputs are opt-in there. A per-session pick still persists as on web.
- **One "+" per repo, opening the composer** (XERK-69). The web dashboard has two spawn controls per
  repo — a "+ New session" quick bare-spawn and a ▾ caret to the option composer. Android collapses
  these to a single "+" that opens the `SpawnDialog` (prompt/label/base/model/mode); the separate
  quick-spawn (was the ⚙/Tune icon) is gone. A phone header has room for one action, and the composer
  covers the bare case by leaving every field blank.
- **New-ticket pill: text-only, no icon** (XERK-150). Both put the "New ticket" create action in the
  shared header as a rounded, LABELED accent pill (web `newticket.js` → `#hdrNewTicket`; Android
  `NewTicketAction` in the shared `ScreenHeader`) — the label is what makes it obvious, so an icon-only
  control was not enough. The web pill carries a ＋ beside the label; Android's is text-only, both to keep
  it as small as possible in the narrow phone header and because a ＋ there would collide with the "New
  session" ＋ the Sessions/Dashboard headers already carry. Same modal (`CreateTicketSheet`), same
  behavior.
- **Neither client expands a clipped block any more** (XERK-347, superseding XERK-77's split). The
  agent reads at ONE fidelity now — the live tail and `/history` share `BLOCK_CAPS` — so the web's
  "Show more…" button and Android's automatic re-fetch behind it (`maybeUpgradeTruncated`) both had
  nothing left to fetch, and both are gone. A block still over its cap carries the same static
  "… clipped to fit" mark on both — though Android's shows only once a thinking trace or tool card
  is expanded, since it collapses cards the web opens by default. A SendUserFile preview the agent
  dropped to fit the reply carries "… preview dropped to fit" on its name chip on both, so it reads
  differently from a file that never rendered. Both clients still poll `/history` while the live
  socket is down, and still page older entries through it.

## Done (this pass — first installment)

- **Repo on the Sessions-tab session card (XERK-125).** The live card's meta row read
  `host · branch`, so the one fact telling several open sessions apart — which repo each works — was
  missing (the web card, and Android's own queued/ended rows, all carry it). It now reads
  `host · repo · branch` — the same three facts in the same order as the session header this card
  opens (`sessionHeaderMeta`) — with the repo from `core/Sessions.kt` `sessionRepoLabel`: a repos-root
  session says "repos root" rather than the agent's `(root)` sentinel, and drops the branch it has no
  worktree for, as the Dashboard card does. Tested in `SessionsTest`.
- **Board "In Review" column.** `core/Board.kt` now carries the 4th category and the review/testing
  status-name carve-out from `inprogress` (was 3 columns → review tickets mis-bucketed). Columns sort
  newest-`updated` first. Ports `board.js` `categoryOf`/`ticketSort`. Tested in `BoardTest`.
- **Drag-and-drop status change (XERK-141).** Long-press a ticket card and drag it onto another column
  to change its status — the platform-idiomatic form of the web's tap-and-hold drag. The drop POSTs the
  target COLUMN (the agent resolves it to a real transition/state), and an optimistic `moves` override
  (`BoardViewModel`) holds the card in its dropped column until the board's own poll catches up, exactly
  as web `board.html` does. Ports `board.js` `boardColumnOf`/`moveSweepVerdict` into `core/Board.kt`
  (`MoveState` + the two fns, tested in `BoardTest`); the gesture is `detectDragGesturesAfterLongPress`
  with a floating ghost card in `ui/BoardScreen.kt`. The pure logic is unit-tested and the app compiles
  (`assembleDebug`); the gesture itself has no instrumented test (no emulator in CI, like every other
  Compose interaction here).
- **Drag edge auto-scroll (XERK-179).** While a card is dragged, holding it near the board's left/right
  edge scrolls the column strip under the finger, so an off-screen column is reachable — the XERK-141
  port had skipped web `board.html`'s `edgeScroll` and a phone-width board couldn't drop past the
  visible columns. A per-frame loop in `ui/BoardScreen.kt` (scrolls while the finger holds still, where
  the web steps per pointermove) drives `core/Board.kt` `edgeScrollStep` (48dp zones, speed ramping
  with depth), re-resolving the drop column as the columns move. Tested in `BoardTest`.
- **On-demand ticket detail loads (XERK-83).** The detail sheet fetched once and returned null on the
  hub's 202-while-fetching, so a first click spun "Loading details…" forever; it also decoded the
  `{issue, fetchedAt}` envelope's top level straight into `JiraIssueDetail`, blanking every field on a
  200. Now `BoardViewModel.fetchIssue` polls with backoff to a 45s deadline and unwraps the nested
  `issue` (`JiraIssueEnvelope`), surfacing a terminal failure as an error message — a port of
  board.html `fetchDetail`. `core/Board.kt` `classifyIssueResponse`/`IssueFetch` tested in `BoardTest`.
- **Sign out.** A ⋮ overflow on the shared `ScreenHeader` (every top-level screen) that unregisters
  push, clears credentials, and returns to Login — the web has Sign out in its nav on every page.
- **Move a session to another agent (XERK-101).** The session card ⋯ menu gains "Move to another
  agent…" opening a target-host picker (online, same-org hosts that have the repo), which posts the
  `/migrate` command — a port of web sessions.html `moveMenu`/`moveTo`. `core.eligibleMoveTargets`
  mirrors the web target filter (tested in `SessionsTest`). One deliberate difference: the web stage
  auto-follows the moved session onto its new host (`advanceMigrationFollow`); Android just lets it
  reappear in the session list on its new host (no stage to follow on a phone), so the "Moving…" card
  hint and the follow are web-only. Its refusals — including the 503 when too many moves are in
  flight (XERK-263) — reach the operator in the hub's own words through `hubErrorMessage`, like
  every other command (XERK-264).
- **One Sessions search box, doing both halves (XERK-243).** The web sidebar's single box searches the
  archive only, hiding the live lists while a query is up. Android's box filters the live/queued/ended
  lists as you type AND, past two characters, appends an "In history" section of archive full-text
  matches below them — so one bar answers "which session is this?" whether the session is running or
  ended years ago. Superseded the previous split (a Search action in the Sessions header opening a
  separate `ui/ArchiveScreen.kt`, plus an on-page "Filter these sessions" field), which crowded the
  header; that screen is gone and its search lives in `ui/SessionsScreen.kt` + `core/Search.kt`. The
  web can adopt the merged box later; nothing was removed from it here. Also dropped with the screen:
  its browse-all-archived list (`GET /api/archive`) — the Ended sessions section already lists the
  fleet's ended work, and search reaches the rest.
- **Dashboard summary tiles.** The six tiles (Hosts online / Running / Waiting on you / Tokens
  today·week·all-time + dominant model) atop the Fleet screen, from `core/Fleet.kt` (a pure port of
  index.html's reducers). Tested in `FleetTest`.
- **Question option preview.** The collapsible preview mockup the TUI shows (`chat.js` `q-prev-wrap`)
  now renders on each option card.
- **Split compose bar (XERK-33).** Send now ALWAYS sends (mid-turn it queues); a separate
  warning-coloured Stop appears beside it while a turn runs, suppressed during a pending question. Was
  a single button that morphed into Stop — on a phone (no Enter key) that made mid-turn queueing
  impossible. `ui/ChatScreen.kt`. The terminal screen's input bar carries the same split (XERK-177,
  web `termComposeStop`); with no live tail of its own its busy read is the heartbeat's `paneBusy`.
  `ui/TerminalScreen.kt`.
- **Host "updating" status (XERK-29).** A host in an announced update restart shows an "updating →
  <version>" pill instead of the outage-looking "offline". `model/Models.kt` + `ui/FleetScreen.kt`.
- **Kill from the chat/terminal header + New session from the Sessions page (XERK-44).** A shared
  arm/confirm `KillAction` (`ui/CommonUi.kt`) sits in both the `ChatScreen` and `TerminalScreen` top
  bars (web `chatKill`/`termKill`): first tap arms "Confirm kill", a second within 3.5s kills the
  session you're in and leaves the view. The Sessions header gains a "+" that opens a two-step
  `NewSessionPickerDialog` (online host → repo, the pure `spawnTargets` port of the web's `#spawn`
  sidebar) feeding the existing `SpawnDialog`. `vm/ChatViewModel.kt` `kill()`;
  `spawnTargets` tested in `SessionsFlattenTest`.
- **Per-org auto-start switch (XERK-41).** Flips the hub-only per-org auto-start opt-in
  (`POST /api/jira/<site>/autostart`). Ports `board.js` `autoStartOn` into `core/Board.kt` (tested in
  `BoardTest`); `model/Models.kt`, `net/FleetRepository.kt` (payload + `autoStartOrgs` SSE),
  `net/HubApi.kt`. It rode the board's org chips until XERK-62 moved it onto the header control's
  org rows, following the web.
- **Per-org auto-MERGE switch (XERK-550 / closed by XERK-564).** The header org menu carries a second
  switch beside auto-start that flips the hub's hands-off auto-merge opt-in
  (`POST /api/jira/<site>/automerge`; the hub then merges a merge-ready PR of an auto-start-eligible
  ticket, closes the ticket, and frees the slot). `autoMergeOrgs` is typed in `model/Models.kt` +
  ingested in `net/FleetRepository.kt` (payload + `autoMergeOrgs` SSE), `autoMergeOn` ports the read
  into `core/Board.kt` (tested in `BoardTest`), and `ui/OrgControl.kt`/`vm/OrgViewModel.kt` render a
  second toggle (+ its POST via `net/HubApi.kt`) beside auto-start — reading its OWN INDEPENDENT map,
  never auto-start's. Web source: `turma/public/org.js` (`setAutoMerge`, the `data-org-merge` chip).
  Both toggles are compact `auto`/`merge` PILLS (dot + label, filled in the org's color when on),
  mirroring the web's `org-chip-auto`/`org-chip-merge` — a Material `Switch` per toggle overflowed the
  phone menu row and truncated the org name (XERK-564); the pill keeps both toggles and a readable
  name on one line. Emulator-verified.
- **Fleet-wide org filter (XERK-62).** The board's org chip strip is gone; one org control lives in
  the shared `ScreenHeader` and so is on all four top-level screens, scoping each of them from the one
  persisted pick — Dashboard hosts + tiles, Sessions lists + new-session host picker, Board tickets,
  Usage series (both groupings). A host polls exactly one org, so scoping the agent list scopes
  everything built from it; a host with NO tracker block belongs to no org and shows only under "All
  orgs". A pick for an org nobody reports any more doesn't apply but is KEPT, so it resumes when that
  host comes back, and each screen's empty state distinguishes "nothing reported" from "the filter
  narrowed this to nothing" and points at the header. Ports `turma/public/org.js`: `siteKeyOf` /
  `filterAgents` / `effectiveOrgs` / `scopedAgents` / `storedOrg` / `ageStr` in `core/Board.kt` (tested
  in `BoardTest`), the pick hoisted to `data/OrgFilter.kt` + `AppContainer` (migrating the old
  board-only preference forward, as the web migrates `turma-board-org` → `turma-org`), the control in
  `ui/OrgControl.kt` + `vm/OrgViewModel.kt`, call sites in `ui/FleetScreen.kt`, `ui/SessionsScreen.kt`,
  `ui/BoardScreen.kt`, `ui/UsageScreen.kt`. Platform form: a Material dropdown of rows (dot, org name,
  ticket count, offline/synced note, `Switch` for auto-start) rather than the web's button + popover of
  divided pills.
- **Multi-org selection (XERK-222).** The org filter selects a SET of orgs, not one: each menu row is a
  toggle that stays checked (leading ✓) while selected, the menu stays open across toggles, and "All
  orgs" clears the selection and closes. The button shows one dot per selected org and a "N orgs"
  count past one. `data/OrgFilter.kt` persists a string set (`orgFilterSet`, migrating the older
  single-key prefs to a one-org selection); `core/Board.kt`'s `filterAgents` / `effectiveOrgs` /
  `scopedAgents` / `filterSites` take the set (each key self-heals independently). Matches the web's
  checkbox menu rows and JSON-array `turma-org` value.
- **Ended-session read-only chat review (XERK-70).** Tapping an ended-session card body (not just its
  Resume button) now opens the conversation read-only, the web ended-session stage's counterpart
  (`#transcriptPane` in `sessions.html` → `openEndedSession`). `EndedSessionView` in
  `ui/SessionsScreen.kt` fetches the archived transcript by id (`GET /api/archive/<transcriptId>`, the
  existing `ArchiveViewModel.openTranscript`) and renders it through the same `buildItems`/`ChatItemView`
  engine the live chat uses — with a PR-chip + Resume bar and a verbosity control, but deliberately no
  compose box and no terminal (no live pty). Resume is gated on the host being online; PR chips link out
  to GitHub. It slots into the adaptive `SessionsRoute` beside the live `ChatScreen` (wide two-pane +
  narrow full-screen, Back clears it). Needed two `ClosedSessionInfo` fields the agent already emits but
  Android didn't decode — `transcriptId` and `prs` (`model/Models.kt`); a record lacking `transcriptId`
  (older agent) stays Resume-only and says "no conversation recorded". Decode covered by `AgentDecodeTest`.
  (The stopped + `repo.resumable` ended channels and the live-list exclusion landed later — XERK-78.)
- **Selectable/copyable transcript text (XERK-64).** The web chat relies on native browser text
  selection to copy session text (and defers repaints to keep a live selection intact). Compose `Text`
  isn't selectable by default, so the transcript `LazyColumn` in `ui/ChatScreen.kt` and the
  archived/ended transcript viewer in `ui/ArchiveScreen.kt` are now wrapped in a `SelectionContainer`:
  long-press selects, the system copy toolbar copies, and taps still toggle the tool/thinking cards.

- **Live working-status bar (XERK-75).** The chat footer now renders the full web
  `#chatStatus` (chat.js `updateLiveStatus`/`agentsHtml`): a spinner + gerund verb,
  right-aligned elapsed + ↑/↓ token counters, Claude Code's rotating tip / active-task
  hint lines (one clipped row each), and the live agent-manager list — "main" a plain
  marker, each background subagent a tappable row that opens its transcript read-only
  (new `GET .../subagents/history` endpoint, `SubagentViewModel` + `SubagentView`,
  reusing the ended-review `buildItems`/`ChatItemView` engine; Back returns to the
  parent chat, the web's `subagentReturn`). Was a single verb+hint line that, in
  practice, never showed: `TurnStatus.up/down/elapsed` were typed `Long` but the wire
  sends display strings ("1.2k"/"12s"/""), so `decodeFromString<TailFrame>` threw and
  `LiveTail` dropped the whole turn frame — fixed to `String`, plus a new `agents[]`
  field. `model/Models.kt`, `net/HubApi.kt`, `net/HubClient.kt`, `vm/ChatViewModel.kt`,
  `vm/SubagentViewModel.kt`, `ui/ChatScreen.kt`, `ui/SessionsScreen.kt`; decode locked
  in `AgentDecodeTest`.
  - **The bar is no longer turn-scoped (XERK-245).** Delegating ENDS the session's own
    turn, so gating it on `status` hid the agent list exactly when it mattered. The rows
    now ride the frame (`TailFrame.agents` → `LiveEvent.Turn.agents` → `ChatState.liveAgents`),
    and with no status behind them `BackgroundAgentsBar` renders the web's "Background
    agents…" row. A `main`-only list raises nothing. Session cards say which is running
    via `liveStateLabel(state, live)`, matching the web's `agentWorkLabel`.

## Done (XERK-78 installment — the P0 sweep)

- **Board per-card Start button + ticket↔session chips + optimistic sweep.** Each ticket card now
  carries the web's 4-state start control (`ticketStartControl` in `core/Board.kt` ← board.js
  `ticketStartHtml`): no button without a triaged repo, "⏳ starting…" while a spawn is in flight,
  "☐ Start session" / "☐ Start (clone first)" (an uncloned repo is a LIVE start — the hub clones on
  demand, XERK-14; the detail sheet's stale cloned-only gate is gone), compacting to "+" once the
  ticket has sessions, a failed start's reason parked beside a live retry button. Session chips
  (`ticketSessionIndex`/`ticketSessionLabel`/`ticketSessionState` ← board.js) read the same three
  channels the Ended list merges, deduped on host+transcriptId (record wins), branch-first label;
  a running chip opens the live chat, anything else the read-only ended review (new `ended/` route).
  The pending paint is synchronous-before-POST and resolves on EVIDENCE via the `startSweepVerdict`
  port (`BoardViewModel.starts` swept each fleet beat, incl. the `sawCmd` staleness rule). Tested in
  `BoardTest`.
- **Board ticket card fields.** Type + age (`ageStr`) on the top row; status pill, priority pill with
  high/low tinting (`prioClass`), due/overdue chip (`overdueOf`) on the meta row. Tested in `BoardTest`.
- **Sessions ended list: all three channels (`collectSessions` ← sessions.html `collect`).** Android
  read only `a.closedSessions`; it now merges stopped (non-running registry records, which also LEAVE
  the live list), killed, and each repo's `resumable` scan (the durable channel), deduped on
  `<host>::<transcriptId>` with the record winning, sorted newest-ended first (`endedTs`, XERK-73).
  Resume dispatches per channel: killed → `resume`, stopped → `start`, resumable → `resumeTranscript`
  at its origin cwd. `EndedSessionView` now keys on the transcript id alone (web
  `findEndedByTranscript`) and resolves the entry — and its Resume — from the fleet each beat.
  `ResumableInfo` was re-shaped to the real wire (`endedTs`/`repo`/`root`/`ticket`/`prs`; the old
  `ts`/`source` fields decoded nothing). Tested in `SessionsFlattenTest` + `AgentDecodeTest`.
- **Sessions queued section.** `status:"queued"` records get their own FIFO section above Active
  (was: mis-bucketed under "Stopped" with live-card actions): reason (`queuedReasonText`) + queued-since,
  inline arm/confirm Cancel, no attach (no pane yet).
- **Chat stick-to-bottom + jump-to-latest pill.** Auto-scroll follows the tail only while the reader
  is AT the tail (was: unconditional scroll-to-end on every new item, fighting the reader); scrolling
  up unpins, a "↓ Jump to latest" pill re-pins, and a growing live turn keeps the tail
  in view while pinned (web chat.js `stickBottom`/`#chatJump`).
- **Dashboard session card detail.** Status badge (queued/error + the optimistic "stopping"), id,
  worktree/branch (or "repos root (no worktree)"), work-risk line (`core/Sessions.kt workLine` ←
  index.html, tested in `SessionsTest`), RC name, state/queued-reason + since, question preview,
  error message, created/stopped/activity + model list, all-time tokens + output (was: today only).
- **Dashboard queued/stopping + Cancel + optimistic pending.** A queued card's only action is an
  arm/confirm Cancel; the actions dialog branches on queued and arms/confirms Kill/Restart/Delete
  (delete warns on dirty files). Every session action paints its busy state synchronously before the
  POST and clears on the completion signal it actually has (`FleetViewModel.reconcilePending` ←
  index.html, tested in `FleetPendingTest`): kill/delete → session gone, start → running, resume →
  reappears, restart → `restartCount` bump, TTL backstop.
- **Usage 30-day stacked daily chart + persisted legend toggles.** `UsageInfo.days` now decodes (it
  was silently dropped at the model layer, so no client code could ever chart it);
  `UsageViewModel.compute` merges per-day buckets per repo (across hosts) and per host
  (`dateWindow`/`niceMax` ports tested in `UsageViewModelTest`). The screen draws one stacked bar per
  UTC day for the selected grouping, with a legend that is the filter — per-series + group toggles,
  persisted (the web's `turma-hidden-sessions`), rescoping chart and rows; paint is assigned by stable
  order so toggling never repaints survivors. The grouping tab pick persists too (`turma-usage-mode`).
- **Subscription-limit card name (XERK-541).** Both surfaces title a card by the subscription's
  `label` when it reports one (`LimitCard.label`), falling back to the hosts on it when it does not.
  Justified platform difference: the WEB card shows only the name and reveals the agents on it via a
  hover tooltip on the heading; a phone has no hover, so ANDROID shows the name alone (no host list)
  on a named card, and still lists hosts on an unnamed one. Fold logic parity-tested in
  `UsageViewModelTest`.

## Done (XERK-126 — the clone bar)

- **Repo cloning worked on web but was dead on Android.** `GithubInfo` decoded the availability flag
  as `ok`; the agent's `collect_github()` has always named it **`available`** and sends no `ok` key,
  so it defaulted to false on EVERY host and the bar rendered its "no GitHub credentials" note —
  the one thing the operator saw. Renamed to the wire key; a pinned real-payload decode test guards it.
- **The rest of the bar caught up with `cloneBar`/`cloneBody`** (the old P1 line): collapsible header
  naming the gh login, search box, multi-select list with the `🔒` private marker and an "already here"
  row for repos the host has, free-text `owner/repo`, a "Clone N" button firing one POST per spec, and
  the agent's clone-job rows (cloning / ✓ cloned / ⚠ failed + reason) — which stay visible while the
  panel is collapsed, since they are the answer to "did my clone work". Offline hosts browse but
  can't fire. Pure reducers in `core/Clone.kt` (`cloneCandidates`/`cloneSpecs`/`cloneRepoName`/
  `cloneJobRow`), tested in `CloneTest`.
- Still open here: the web's optimistic clone row (a spec fired but not yet echoed by the agent) —
  Android shows a "clone queued" snackbar instead, and the real job row lands a beat later. P2.

## Done (XERK-137 — New ticket)

- **Create a ticket from the board.** The board header gains a **＋ New ticket** action (shown once an
  org reports) opening a `ModalBottomSheet` create form (`CreateTicketSheet` in `ui/BoardScreen.kt`) —
  the Android port of the web `board.html` modal, source-agnostic across Jira and Azure DevOps. An
  org/project/type cascade (project + type metadata fetched on demand with the same 202-poll as the
  detail sheet — `BoardViewModel.fetchCreateMeta`), a title/description/labels form worded per source
  (labels vs tags), then a submit that POSTs and polls the outcome (`submitCreate`), ending on a
  "Ticket created" confirmation with an open-in-tracker link. The created ticket self-assigns to the
  tracker user (hub-side) so it lands on the board on the next poll.
- Wire + logic: `source` added to `JiraBlock`/`BoardSite` (`mergeSites` defaults it to jira); the
  create models + envelopes in `model/Models.kt`; three Retrofit endpoints in `net/HubApi.kt`
  (`createMeta`/`createTicket`/`createResult`). Pure ports in `core/Board.kt` — `createLabelWord`,
  `splitLabels` (Jira on whitespace+commas, Azure on commas), and the `classifyCreateMeta`/
  `classifyCreateResult` 202-poll classifiers — JVM-tested in `BoardTest` against the board.js behaviour.

## Done (XERK-169 — markdown in chat bubbles)

- **Prose objects (tables, code, inline code, links) now render in the chat.** The bubble and thinking
  trace rendered raw text — a GFM table showed its pipes, a fenced block its backticks, a URL was
  inert — while the web runs both through `chat.js renderProse`. Ported that pipeline to a pure,
  JVM-tested parser `core/Prose.kt` (`parseProse` → fenced code lifted out first, then GFM tables, then
  inline code spans + links, mirroring `renderProse`/`renderTables`/`renderInline`/`linkify` line for
  line; locked to chat.test.js's vectors in `core/ProseTest.kt`). `ui/TranscriptView.kt` renders the
  typed tree natively: paragraphs with inline-code chips (mono, tinted) and tappable links
  (`LinkAnnotation.Url` → external browser), fenced blocks as a bordered mono box that scrolls
  horizontally, and tables as a bordered equal-column grid (header emphasis, zebra rows, per-column
  alignment). A bubble carrying a table/code block widens to full width (the web's `:has(.md-code)`
  widening). Applies everywhere `ChatItemView` renders — live chat, archive, and ended views.
- **Mobile-idiomatic table difference:** the web scrolls a wide table horizontally inside the bubble;
  Android uses equal-weight columns that fill the bubble width and wrap long cells, which reads better
  on a phone than a sideways-scrolling grid.

## Done (XERK-234 — file attachments in the composer)

- **Attach images and documents to a message.** Both sides stage each picked file to the hub
  immediately (`POST .../sessions/<id>/uploads`, raw bytes) and send the ids with the message, so Send
  is instant and an over-cap file is refused while there is still a chip to remove. The chips (name +
  size / "uploading…" / the failure) sit above the input box, each with a ✕; Send lights up for
  attachments alone; a file still uploading holds the message rather than sending it with the file
  missing. The control is hidden entirely on a host whose agent doesn't report `uploadMaxBytes`, and
  disabled while an AskUserQuestion is pending (the draft then answers it, and an answer carries no
  files). Pure half ported to `core/Uploads.kt`, locked to the hub/agent sanitiser in
  `core/UploadsTest.kt`.
- **Web-only entry points:** drag-and-drop onto the transcript and paste-a-screenshot. Both are
  desktop pointer/clipboard gestures with no phone equivalent — Android's picker
  (`OpenMultipleDocuments`) covers the same ground, and the system share sheet is the phone's idiom for
  the drop case. Sharing INTO the app is not wired up (no `ACTION_SEND` intent filter yet) — a
  reasonable follow-up, tracked below.

## Done (XERK-246 — local-model failover controls)

- **Switch a running session between the subscription and the host's self-hosted model.** A third
  compose-bar chip beside model and mode ("run: subscription" / "run: <model>") POSTing
  `.../sessions/<id>/model-source`; the agent relaunches with `--resume`, so the conversation,
  worktree and branch carry over. The chip paints from a memo until the heartbeat agrees — the
  relaunch takes several beats, and without it the value springs back and reads as a dead control —
  and the memo ages out (`ModelSource.SWITCH_SETTLE_MS`) so a switch that never lands can't pin it
  on a lie. A refused switch (the hub 409s a host with no local model) drops the memo at once and
  says why.
- **Start NEW work on the local model**: a "Run against" row in the spawn composer, the web's
  `sessions.html` field. Without it you could fail existing sessions over from the phone but not
  begin anything once usage was gone — which is exactly when you need to.
- Both follow the **host's** `localModel.available`, exactly as the 📎 follows `uploadMaxBytes`; an
  agent reporting nothing cannot do it, so the control is hidden rather than offered and refused.
  The compose-bar chip is also shown when the session is already `local`, so one whose host later
  lost its configuration keeps a visible way back.
- **The Claude model picker is hidden on a live local session** (a static chip states the model
  instead), matching the web's `cc-model-fixed`: every alias it could offer — "default" included,
  since that resolves to the shared login's default — is one the self-hosted endpoint refuses. The
  **spawn composer keeps its Model row**, also matching the web (`sessions.html` renders and sends
  it whatever the source): the agent drops `--model` for a local session itself, and the alias is
  what that session goes back to if it is later switched to the subscription, so discarding it
  would give an Android-spawned session a different model from a web-spawned one.
- **XERK-489 — the endpoint's DISCOVERED models are a live dropdown, per session.** Where the host
  reports a `localModel.models` list, the chat bar's fixed local-model chip becomes a menu (each
  "id · 128k") posting the chosen endpoint id to `.../sessions/<id>/model`, and the spawn composer
  reveals a "Self-hosted model" dropdown under "Run against: local" carrying `localModel` on the
  spawn. With no discovered list (an older agent, or the discovery worker's first pass not yet
  landed) it falls back to the fixed label. `core/ModelSource.kt` gains
  `localModels`/`localOptions`/`currentLocalModel`/`servedContextFor`/`currentLocalContext`/`fmtCtx`/
  `localModelLabel` (`ModelSourceTest.kt`); `LocalModelInfo` gains `models`/`defaultModel` and
  `SessionInfo` gains `localModelName`/`localModelContext` (`AgentDecodeTest.kt`); the chip and
  composer are pinned in `ChatModelChipsTest.kt` / `SpawnComposerTest.kt`.
  - **Deferred (web-only for now): the ADVANCED context-window override.** The web chat footer and
    spawn composer let an operator SHRINK a local session's `CLAUDE_CODE_MAX_CONTEXT_TOKENS` below
    the served window (a number field, clamped agent-side). Android auto-applies the model's served
    window (the common LiteLLM case) but has no shrink field yet. The wire + agent plumbing already
    carries it (`/model {context}`, spawn `localContext`), so this is a UI-only follow-up; a phone
    rarely needs to hand-tune a context window.
  - **XERK-489 Phase 4 — the context-fullness meter is ported.** A thin bar + "N% context"
    (`ContextMeterBar` in `CommonUi.kt`, pure `core/ContextMeter.kt`) rides the session card
    (`FleetScreen`) and the chat bar (`ChatScreen`), matching the web's card (`index.html`) + compose
    footer (`chat.js`): warn ~85%, danger near the ~95% auto-compaction. `SessionInfo` gains
    `lastTurnContextTokens` (numerator) + `contextWindowTokens` (denominator — EXACT for a local
    session, Claude Code's 200k assumption "~" for a subscription one), both coerced hub-side.
    Tests: `ContextMeterTest.kt`, the meter case in `AgentDecodeTest.kt`.
- The memo lives in `AppContainer.modelSwitches`, not the chat ViewModel, for the same reason
  `drafts` does — the VM is scoped to the chat's nav entry, so a memo kept there died the moment
  you walked back to the session list, mid-switch, which is when it is doing its job.
- Pure half in `core/ModelSource.kt` (`ModelSourceTest.kt`), the state reads in `ChatUiStateTest.kt`;
  the wire block is locked in `AgentDecodeTest.kt`, including the all-nulls shape an unconfigured
  host reports and the null `modelSourceAt` every unmoved session carries.
- **Still open:** the 🏠 mark on live and ended session CARDS (see below) — inside a session the
  compose-bar chip already names the model. The chip's missing tooltip is a deliberate difference,
  recorded above.

## Done (XERK-481 — triage data model + heartbeat contract)

- **Type the field + capability flag** so `/api/agents` keeps decoding once agents report the triage
  assessment (XERK-480's foundation, landing before B/E): `AgentInfo.triage: TriageInfo?` (the
  `{available}` capability block, mirroring `qwen`) and `JiraTicket.triage: TicketTriage?` (the
  per-ticket assessment: `priority`/`priorityName`/`type`/`value`/`actionable`/`dedupeOf`/`reason`/
  `at`/`source`, every field nullable). Both are the "typed on Android in the same change" half of
  the wire contract — a field is only decode-fatal once a client types it, and `/api/agents` decodes
  atomically here. The hub coerces both (`normalizeTriage`, `sanitizeTicketTriage` inside
  `normalizeJira`), so an absent/malformed block reads as "not assessed"/"can't triage", never a
  fabricated priority. No UI yet — a data-model-only ticket; the board rendering is a later child.
- Pinned by `model/AgentDecodeTest.kt` (`the triage flag and per-ticket assessment decode`).

## Done (XERK-465 — dsh runtime selection + capability flag)

- **Type the field + capability flag** so `/api/agents` keeps decoding once agents report them:
  `SessionInfo.agentType` ("claude"|"dsh", "" for a pre-dsh agent, coerced hub-side) and
  `AgentInfo.dsh: DshInfo?` (the `{available}` capability block, mirroring `localModel`). Both are
  the "typed on Android in the same change" half of the wire contract — a field is only
  decode-fatal once a client types it.
- **A "Runtime" row in the spawn composer**, gated on the target host's `dsh.available` exactly as
  "Run against" is gated on `localModel.available` — a host that doesn't offer dsh renders no row,
  so nobody picks a runtime the host would only refuse (the hub 409s it). Defaults to Claude Code;
  only a real "dsh" pick reaches the wire (`SpawnRequest.agentType`), so a bare spawn is unchanged.
  A host that stops offering dsh while the composer is open resets a picked dsh back to claude
  (`LaunchedEffect`), the same reset the local-model row has.
- Pure half in `core/Runtime.kt` (`RuntimeTest.kt`); the composer call site in
  `ui/SpawnComposerTest.kt`; the wire body in `vm/SpawnRequestTest.kt`.

## Done (XERK-503/504 — unified Runtime picker; dsh model list; dsh chat footer)

- **The spawn composer collapses to ONE Runtime picker** (`ui/FleetDialogs.kt` `SpawnDialog`),
  matching web `sessions.html`: "Claude Code" / "Claude Code Local" (host reports `localModel`) /
  "dsh" (host reports `dsh`), shown only when there is more than one runtime. **"Run against" is
  gone** — its subscription/local choice IS the runtime now. The one choice maps onto the unchanged
  `agentType`/`modelSource` wire fields at spawn (`Runtime.composerRuntimes`/`spawnAgentType`/
  `spawnModelSource`); no field from another runtime leaks. The Model row adapts per runtime (Claude
  aliases / the discovered local list / the discovered dsh list), and dsh shows an "approvals managed
  by dsh" note instead of the permission dropdown (dsh's policy is `ask`/`never`, not Claude's modes).
- **`DshInfo` now types `models`/`defaultModel`/`contextTokens`** (`model/Models.kt`, reusing
  `LocalModelOption`), coerced hub-side by `normalizeDsh`, so a dsh session offers the endpoint's
  DISCOVERED models (the fix for the pi-ai "no configured model" lock) instead of Claude aliases.
  `core/Runtime.kt` gained the dsh model helpers mirroring `ModelSource`'s local ones
  (`dshModels`/`dshOptions`/`currentDshModel`/`dshModelLabel`/`dshModelPickable`).
- **The chat footer reflects a dsh session's runtime** (`ui/ChatScreen.kt` `ChatFooter`,
  `vm/ChatViewModel.kt` `ChatUiState.dsh`): a read-only "⚙ dsh" chip (a dsh conversation can't switch
  to a Claude runtime live), a live dropdown of the host's discovered dsh models (switched via the
  same `/model` POST, which the agent turns into a dsh-process relaunch — `_switch_dsh_model`), and
  NO permission-mode chip. The Claude source chip is relabeled "Claude Code" / "Claude Code Local"
  (was "Subscription"/"Other") to match the composer (`ModelSource.label`/`options`).
- Tests: `RuntimeTest`/`ModelSourceTest` (pure), `SpawnComposerTest` (the unified picker end to end),
  `ChatModelChipsTest` (the dsh footer + relabel), `AgentDecodeTest` (the dsh model list decodes),
  and the target-host wiring in `FleetSpawnLocalModelTest`/`SessionsPaneSpawnTest`. Full
  `testDebugUnitTest` green (450 tests).

## Done (XERK-477 — board runtime row; runtime badge on cards removed)

- **The `⚙ dsh` session-card runtime badge is GONE, on every surface.** The web dropped it
  (`runtimeMarkHtml` / `.runtime-mark` removed from `sessions.html`), so Android dropped it too:
  `RuntimeBadge` is removed from `ui/CommonUi.kt` and no longer rendered on the live session cards or
  the ended rows in `ui/SessionsScreen.kt`. The glasses analogues (the phone companion's `ph-runtime`
  chip and the G2 row's `·dsh` suffix) are gone as well. `Runtime.isDsh` stays as the shared runtime
  predicate; the Trajectory viewer and composer still tell a dsh session apart.
- **`EndedSession`/`ClosedSessionInfo.agentType` stay typed** — the hub serves them and they decode
  cleanly; they are simply no longer read for a card badge. Tests: the closed-`agentType` decode in
  `model/AgentDecodeTest.kt`, the `Runtime.isDsh` cases in `core/RuntimeTest.kt`.
- **The board ticket "Runtime" row** (web `board.js` `runtimePinOf`/`runtimeFieldHtml`/
  `runtimePickerHtml`, XERK-473) — the fifth tap-to-change row in the ticket detail sheet
  (`RuntimeSection` in `ui/BoardScreen.kt`), beside Status/Repo/Agent/Model, pinning which runtime a
  ticket's session spawns on. Hub-owned durable state: it reads the `ticketRuntimes` map off the
  fleet payload (typed as `AgentsResponse.ticketRuntimes` → `FleetState.ticketRuntimes`, refreshed by
  the poll and the `ticketRuntimes` SSE event) and writes with `POST
  /api/jira/<siteKey>/<issueKey>/runtime` (`vm.setTicketRuntime`), authoritative on a 200 like the
  Model pin. A non-default runtime is offered only when the org has a capable host — "dsh"
  (`BoardSite.dshAvailable`) and, since XERK-515, "qwen" (`BoardSite.qwenAvailable`), each OR'd over
  every host's `dsh.available`/`qwen.available` in `mergeSites` — with an existing pin always
  releasable (`Runtime` row `runtimeEditable`). Pure ports
  (`runtimePinOf`/`prettyRuntime`/`runtimeEditable`) in `core/Board.kt`, tested in
  `core/BoardTest.kt`; the `ticketRuntimes` decode in `model/AgentDecodeTest.kt`.

## Done (XERK-498 — dsh Trajectory replaces the terminal, no empty page)

- **A dsh session is HEADLESS (no ttyd), so its chat header shows a Trajectory action, not Terminal.**
  Before this the header always showed Terminal and tapping it opened an empty `/term` WebView — the
  reported bug. `ui/ChatScreen.kt` now gates the header action on `Runtime.isDsh(session.agentType)`
  (web `sessions.html` hides "Terminal ▸" / shows "Trajectory ▸"): a dsh session gets an Analytics
  icon that routes to `Routes.trajectory(host, transcriptId)`; a claude session keeps Terminal.
- **`ui/TrajectoryScreen.kt` is the Android port of web `renderTrajectory`** — a read-only render of
  the dsh D3 native event log from `GET /api/dsh/<transcriptId>/trajectory` (`net/HubApi.dshTrajectory`,
  a `Response<DshTrajectory>` so a 404 is handled apart), driven by `vm/TrajectoryViewModel`. It shows
  the header (title/model/turn+tool-call+error counts/token totals/duration) and turns newest-first,
  each with its tool calls (✓/✗/• + args + duration), mirroring the web. A 404 reads as "not synced
  yet — ↻ Refresh in a moment" (the ordinary case for a just-opened running dsh session), kept apart
  from a real error.
- **Wire model** (`model/Models.kt`): `DshTrajectory` + `TrajTotals`/`TrajTokens`/`TrajTurn`/
  `TrajTurnTokens`/`TrajCall`. Timestamps decode as `Double?` (dsh's own epoch-ms, can be fractional),
  token counts as `Long` (floored hub-side). Not part of the atomic `/api/agents` decode, so a
  wrong-typed field breaks only this screen.
- Route `trajectory/{host}/{tid}` in `ui/TurmaApp.kt`, wired through the chat route and `SessionsRoute`
  (`onTrajectory`). `TerminalScreen` is unchanged (a claude session still uses it); the dsh session
  simply never navigates there now.
- Tests: `vm/TrajectoryViewModelTest` (200/404/500/blank-id outcomes over MockWebServer),
  `ui/DshChatActionTest` (a dsh session shows Trajectory not Terminal, carries the transcript id; a
  claude session keeps Terminal — the wiring the `core/`-tested `Runtime.isDsh` gate does not cover),
  `ui/TrajectoryFormatTest` (the `trajMs`/`trajNum` formatters).
- Still open: the **glasses** client (`hub-client.ts`) exposes the terminal for a dsh session — the
  same suppression + Trajectory render, tracked under P2 above.

## Done (XERK-488 — client triage parity: Triage lane, verdicts, org policy)

- **Android has FULL triage parity** with the web (XERK-485/486): all four surfaces ported.
  - **Triage lane** — `core/Board.kt` mirrors `board.js` `triageLaneOf`/`triageActionOf` (pure,
    tested in `core/BoardTest.kt`); `ui/BoardScreen.kt` renders the lane FIRST in the column strip
    (`listOf("triage" to "Triage") + BOARD_CATEGORIES`), holds untriaged + held To Do cards, and is
    **never a drop target** (the drag target resolver does `takeIf { c -> c != "triage" }`, like
    web `board.html`'s drop guard).
  - **Verdict chip + Triage row** — `TriageSection`/`TriagePicker` in the detail sheet mirror
    `triageFieldHtml`/`triagePickerHtml`: Auto / Approve / Hold / Reject, a pick IS the save
    (`vm.setTicketTriage` → `POST /api/jira/<site>/<key>/triage`), "Auto" is the release; the card
    chip renders the `TriageActionPin` (`model/Models.kt`) read off the fleet payload's
    `ticketTriageActions`.
  - **Per-ticket approve/hold/reject** rides the same durable hub state as the pins — works with
    the org's hosts offline; the fleet payload + SSE keep the verdict fresh.
  - **Org triage policy sheet** — `TriagePolicySheet` (header "Triage policy" button, like the web
    board bar): the five knobs (minPriority / excluded types / repo allow / repo deny / rateMax)
    via `vm.saveTriagePolicy` → `POST /api/jira/<site>/triage-policy`; `null` clears a knob.
- **Glasses + Veiller fork: PASSIVE read only** — both decode `ticketTriageActions` from
  `/api/agents` (new `AppState` field, refreshed by poll) and pass `triageActions` into the
  re-vendored `board.cjs` `boardHtml`, so the Triage lane + verdict chips render exactly as on
  web/Android. No verdict/policy controls on the phones (they set no hub state). `board.cjs` was
  re-vendored byte-identical from `turma/public/board.js` in `glasses/src/vendor/` and the Veiller
  fork's `miniapps/turma/src/ui/vendor/` (both vendor tests pin byte-identity); `board.css` on both
  phones gained the `.kanban-triage`/`.kc-triage*`/`.kc-queued*`/`.kc-dup` rules.
- **Platform-form notes (parity by intent, not omission):** Android's lane is the first item of
  the same horizontal `LazyRow` strip (no separate scroll surface); the verdict picker is a
  dropdown dialog in the detail sheet rather than the web's in-place inline swap (sheet rows do not
  reflow); the policy editor is a full sheet vs the web's header-bar menu — same wire calls, same
  semantics, different gesture chrome.
- Tests: `core/BoardTest.kt` (lane/chip pure functions), `ui/BoardTriageTest.kt` (4 Robolectric
  cases: lane placement incl. held card, chip rendering, verdict save over MockWebServer, policy
  editor); glasses `phone/render.test.ts` (untriaged + held in-lane); Veiller
  `ui/phone/render.test.ts` (same pair). All suites green.

## Open (subsequent installments), by screen and priority

Many of these need Android's wire model (`model/Models.kt`) to decode fields the web already renders;
those are marked `[MODEL]`.

### Dashboard (`index.html` → `FleetScreen`/`FleetDialogs`)
- ~~P0 Session card detail~~ / ~~P0 queued/stopping + Cancel + optimistic pending~~ — done (XERK-78,
  see Done above). Still open from that pass: the spawn "ghost card" (a pending spawn shows only as
  the composer's toast today) — P2.
- P1 `[MODEL]` Host meta (memory, uptime/last-seen, repos-root, session counts), container-log toggle.
- P1 Host collapse persistence; Jira org label beside hostname; Remove-host for offline hosts.
- P1 Token binding (XERK-578, WEB ONLY for now): the host header shows a `⚠ shared token` chip on a
  host still on the fleet master (from the served `tokenBound`; a bound host shows no chip), and
  offers a **Roll token** button on a live, unbound host reporting the `tokenRoll` capability (rolls it onto its derived token, XERK-268/284). Both
  new fields ride `/api/agents`; Android does not type them yet, so `ignoreUnknownKeys` skips them
  (no decode risk). Mirror as a `FleetScreen` chip + a `FleetViewModel.rollToken` → `HubApi`
  `@POST("api/agents/{host}/roll-token")` trio (the same shape as `restartAgent`). A host can also
  self-enroll with no app at all (`turma-agentctl enroll` / `TURMA_AGENT_SELF_ENROLL=1`), so this is
  a convenience, not the only path.
- ~~P1 Clone bar: collapse + search + multi-select + `🔒` private marker + clone-job status rows.~~
  Done (XERK-126, see Done below).
- P1 `[MODEL]` Repo blocks: branch/dirty meta, remote link, orphan repos, prune-note, empty state.
  - The prune-note now also covers a prune IN FLIGHT (XERK-256): the agent sweeps on a worker thread
    and reports `prunes[].status` as `queued`/`running` with a progress summary, which the web uses
    both for the note and to keep the Prune button spinning for the whole sweep (minutes on a big
    repo). Android's `prune()` fires and forgets, so its button releases immediately and the
    operator has no sign the sweep is still going. Decode `prunes[]` and mirror `repoBlock`'s rule:
    busy while `status` is `queued` or `running`.
- P1 Composer base-branch dropdown + per-repo option persistence.

### Sessions + Chat (`sessions.html` + `chat.js` → `SessionsScreen`/`ChatScreen`)
- **P1 Restore an archived session onto another agent (XERK-441).** The web archive viewer's bar has
  a "Restore…" button with a host picker: `POST /api/archive/<transcriptId>/restore {host}` packs the
  session's archived raw files hub-side and drives the same `importSession` a move does, so a session
  whose host has been REMOVED can be resumed elsewhere. Android's history/archive view has no such
  control, so on a phone an archived session is still read-only. The hub does all the work — the port
  is a button, an eligible-host list (online + has the repo, deliberately NOT org-scoped: an archived
  session has no agent left to compare an org against), and following the returned `migrationId`
  through the `migrations` payload exactly as the existing Move flow does. XERK-453 added a soft
  cross-org WARNING to the web picker (a `⚠ <org>` badge + a `confirm()` when the target's decided
  `org` differs from the archived row's served `siteKey`) — a heads-up, never a block; the port
  should carry it when the restore control is built.
- **P2 Say when a start was REFUSED (XERK-265, XERK-276).** Agents now report a declined resume/import
  on the heartbeat, and the hub serves it per cmdId as `agent.spawnRefusals[cmdId] = {error, at}`. The
  web ends its spawn-follow wait and toasts the reason ("Couldn't start session: the host is at
  MAX_SESSIONS (4)"); XERK-276 extended that to the KILLED-resume path too — the dashboard now carries
  the resume command's cmdId through the deep link (`/sessions?session=<id>&spawn=<cmdId>`) so a
  refused resume ends the by-id wait with the reason instead of spinning "Opening session…" forever.
  Android's Resume is fire-and-forget ("resume queued") and follows no cmdId, so a refusal there is
  still silent — the row simply never reappears, for BOTH the spawn and the killed-resume paths. The
  cheapest port is to keep the cmdId a resume POST answers with and surface a matching refusal as a
  snackbar.
- **P2 Local-model mark on session CARDS (XERK-246 remainder).** The two controls are done (see Done
  above); what's left is the web's 🏠 + warn-colour mark on live and ended session cards, so a
  glance at the list says which sessions are on the weaker model without opening each one. Read
  `session.modelSource == "local"`, titled with `modelSourceAt`. Both fields already decode onto
  `SessionInfo`.
- **P2 dsh Trajectory view, and no terminal for dsh (XERK-498).** Android half DONE (see Done below).
  Still open: **glasses** (`hub-client.ts`) likewise still exposes the terminal for a dsh session —
  the same suppression, plus ideally the same Trajectory render.
- **P3 host-wide "dsh web ↗" link in the dsh chat header (XERK-501).** The web shows a link to the
  host's single host-wide `dsh web` viewer for a dsh session whose host reports a reachable
  `dsh.web.url` (`AgentInfo.dsh.web = {running, port, url}`, hub-whitelisted; absent/`url:null` on a
  loopback-only host, so the link hides). Android's `DshInfo` does not yet type a `web` field (which
  is decode-SAFE — `ignoreUnknownKeys` skips it until typed); to reach parity, type `DshInfo.web:
  DshWebInfo?` and add an equivalent link/affordance on the dsh session/chat screen.
- **P3 per-host default runtime pre-select in the spawn composer (XERK-521).** A host reports its
  EFFECTIVE default runtime as top-level `AgentInfo.defaultRuntime` (`{claude,dsh,qwen}`, absent on
  an older agent → treat as claude; hub-coerced), and the web composer PRE-SELECTS it in the Runtime
  dropdown so a bare "+ New session" shows which runtime it will run on. The unpinned-spawn BEHAVIOUR
  is entirely agent-side (the claiming host applies its own default), so a session Android spawns
  without touching the runtime already runs on the host default with no app change — this gap is only
  the visual pre-select. `AgentInfo` does not type `defaultRuntime` yet (decode-SAFE —
  `ignoreUnknownKeys` skips it until typed); to reach parity, type `AgentInfo.defaultRuntime: String?`
  and default `SpawnDialog`'s runtime choice to it (falling back to claude when absent or not on
  offer), mirroring `sessions.html`'s `hostDefault`/`selRuntime`. **AND — the load-bearing half — an
  explicit "Claude Code"/"Claude Code Local" pick must SEND `agentType:"claude"` when the host default
  is non-claude** (the web does this in `startSession`): a claude/local spawn normally OMITS
  `agentType`, but an omitted `agentType` resolves to the host default agent-side, so on a
  non-claude-default host omitting it silently runs the default runtime. Build the pre-select WITHOUT
  this and Android reintroduces the exact XERK-521 defect an explicit claude pick is supposed to beat.
- **P2 To-do checklist card + the dsh "Deep diving…" verb (Enable DSH To-Dos).** The web renders a
  `TodoWrite` / dsh `todo_write` tool call as a CHECKLIST (state glyph per row + a `1 in progress ·
  6 pending` count on the summary) instead of raw-JSON input — `renderTodoCard` in `chat.js`, fed by
  the `todos` the agent attaches to the block (`toolUseDetail`). `core/ChatItems.kt` currently
  renders it as a plain tool card; the port is a checklist branch reading the same `todos`. Also:
  a generating dsh turn frame now carries a working `status` (`{verb:"Deep diving", noStop:true}` +
  an elapsed clock past 15s) so the web chat shows the verb; `noStop` keeps Stop hidden (a dsh turn
  has no pane-Escape interrupt). Android's chat working bar should read the same `status.verb`/
  `elapsed` and suppress its Stop control on `status.noStop`. Glasses gets the checklist free (the
  vendored `chat.cjs`/`chat.css`); its live bar should honour `noStop` too.
- **P2 Phone `chat.css` class coverage (XERK-488 follow-up).** Both phones' `chat.css` is a curated
  extraction of `turma/public/app.css` taken when it was at v0.6.45, with phone overrides appended.
  The re-vendored `chat.cjs` (this installment on the Veiller fork; earlier on glasses) is the
  v1.1.67 engine and renders ~50 chat-feature classes the stale extraction never had (attachment
  chips, the TodoWrite checklist card, the `noStop` live-bar state, …), so those elements fall back
  to unstyled/default rendering. Pre-existing on glasses (the extraction went stale); surfaced on
  Veiller by the XERK-488 re-vendor. Fix = re-extract the missing rules from the current
  `app.css` into BOTH phones' `chat.css` (keeping the phone-override append) and re-run their
  builds; the `board.css` half is already at parity (this PR's re-vendor).
- ~~P2 dsh runtime badge on session CARDS (XERK-465 remainder).~~ Removed: the `⚙ dsh` session-card
  chip was dropped from every surface (web, Android, glasses) — see the Done section below.
- ~~P2 board ticket "Runtime" row (XERK-473 → XERK-477).~~ Done (XERK-477, see Done below): the board
  ticket detail sheet's fifth tap-to-change row, pinning which runtime a ticket's session spawns on.
- ~~P0 Jump-to-latest pill + stick-bottom scroll.~~ Done (XERK-78, see Done above).
- ~~P0 Ended sessions: stopped + `repo.resumable` channels + live-list exclusion.~~ Done (XERK-78,
  see Done above; the read-only review itself was XERK-70).
- ~~P0 Per-card ⋯ menu: Rename (inline) + arm/confirm Kill.~~ Done (XERK-71): each live session card
  carries a `MoreVert` menu (`SessionCardMenu`) — Rename swaps the card for an inline seeded field
  (`SessionRenameCard`, painted optimistically until the agent reports the name back or a TTL passes),
  Kill arms "Confirm kill" then confirms. `vm/FleetViewModel.kt` `setSummary`; `net/HubApi.kt`
  `setSummary`/`SummaryRequest`.
- P1 Sidebar sections: Ready for review / Active / Idle split done (XERK-73 + XERK-224,
  `rankRunning` → `LiveGroups`); the dedicated Queued section done (XERK-78; the old Stopped group
  folded into Ended). Still open: a state line + question preview on each live card (the dashboard card
  has both; the sessions-list card shows only the dot). Because there is no state line, a
  Ready-for-review card carries the accent dot where the web card also spells out *why* it qualified
  ("PR awaiting review" / "finished · awaiting review").
- ~~P1 SendUserFile inline previews (XERK-221).~~ **Done**: the app now has an image pipeline (Coil +
  `SvgDecoder`, wired via `TurmaApplication : ImageLoaderFactory`). `SendFile`/`files[]`/`caption` are on
  `ToolUseBlock` (decoded) → `ChatItem.Tool` (`ChatItemsTest`), and `TranscriptView` renders each file:
  an image/SVG via Coil `AsyncImage` (data: URIs decoded to a `ByteBuffer` the SVG/bitmap decoders
  accept; remote URLs pass through), an HTML page in a **JS-disabled, navigation-blocked, null-origin
  WebView** (the `sandbox` iframe's analogue), else a name chip — open by default, caption below, matching
  the web's `renderToolFiles`.
- P1 Inline images in **PROSE** (the OTHER half of XERK-221) — still deferred. A markdown `![alt](url)`
  and a raw/fenced `<svg>` in an agent's *text* render as pictures on the web (`chat.js`
  `linkify`/`svgToImg`/`renderSvgAndText`); Android still shows `![alt](url)` as a link (stray `!`) and
  SVG source as text/code. Needs a `Span.Image`/`ProseBlock.Image` node in `core/Prose.kt` mirroring the
  web parse, plus splitting a paragraph around an inline image in `ProseBlocks`. The image renderer
  (Coil `AsyncImage`) is already in place from the SendUserFile work above, so this is parser + layout
  only.
- P2 **Share INTO the app as an attachment (XERK-234 follow-up).** Attaching from the picker is done
  (see "Done" above); the phone-idiomatic counterpart of the web's drag-and-drop is the system share
  sheet, which needs an `ACTION_SEND`/`ACTION_SEND_MULTIPLE` intent filter routing the Uri(s) into the
  open session's `ChatViewModel.attach`. No new wire work — the upload path is already there.
- P1 Verbosity NORMAL: tool card collapsed (output on expand) to match web; persist per-card open.
- ~~P2 Live status bar: token counters + elapsed + spinner + hint lines + subagent list.~~
  Done (XERK-75) — see "Done" below.
- P2 `[MODEL]` Compose bar: Jira ticket chip; filter modes to `permissionModes`;
  optimistic model/mode update. (All PR chips: done — XERK-46.)
- ~~P2 New-session composer in the Sessions list (web can spawn from here).~~ Done (XERK-44): a "+"
  in the Sessions header → host/repo picker → `SpawnDialog`.
- P3 Deep links (`?session=`/`?ended=`), streaming caret, in-place terminal toggle.
- P1 `[MODEL]` **Accurate model selector (XERK-33).** The footer model chip offers a hardcoded menu
  and shows `model` ("default"); the web now heartbeats the login's REAL model list per host
  (`agent.models`) and the model actually answering per session (`session.modelActual`), and switching
  uses "this session only". Port: decode `models`/`modelActual`, populate the chip from the real list,
  show the actual model.
- P1 **Classify bookkeeping turns + queued prompts (#256, chat-view-classification).** The chat should
  render, as the web now does: `[Request interrupted by user]` as a centred status marker; `!` shell
  passthrough (`<bash-input>`/`<bash-stdout>`/`<bash-stderr>`) as command/command_output cards (name
  "!", stderr wins only when non-empty); the `system/away_summary` recap as a collapsed assistant
  card; and queued (not-yet-sent) prompts as dimmed bubbles. Logic belongs in `core/ChatItems.kt`
  (JVM-tested against the web shapes) — the biggest new chat gap.
- P1 **Rich tool-call payloads + transcript markers (chat-transcript-fidelity).** The web chat now
  renders, from new block fields the agent emits: an Edit call's actual change as a −/+ diff
  (`block.edit {old,new,replaceAll}`), a Write's file body (`block.content`), an ExitPlanMode plan as
  markdown open-by-default (`block.plan`), any tool's human `description` beside the arg
  (`block.desc`), AskUserQuestion cards titled with the question text, plus two status markers:
  `compact_boundary` ("Context compacted (auto) — 123.4k → 5.9k tokens") and `pr_link` ("Opened PR
  #N", linked, one marker per URL at its first sighting — Claude Code re-stamps pr-links every turn,
  so a port that renders them per-entry shows the same PR ~6 times). Android decodes these to
  `UnknownBlock`/ignored keys today (safe degrade); port the fields onto `model/Models.kt`'s
  `ToolUseBlock` + new marker blocks, build items in `core/ChatItems.kt`, render in `ChatScreen`.
- P1 **Blocking TUI dialogs (`session.panePrompt`).** The agent now reports the tool-permission /
  plan-approval dialog scraped off the pane, and the web renders it in the pending-question box with
  numbered picks that `POST .../sessions/<id>/pane-prompt {optionNumber}`; both web `liveState`s also
  treat it as "waiting for your answer" so the card isn't labelled idle while it blocks. Android
  decodes the field away today, so such a session still reads idle with no way to answer. Port:
  `panePrompt` onto the session model, the waiting state in `core/Sessions.kt`, and the picker in
  `ChatScreen`/`ChatViewModel` beside the existing question sheet.
### Usage
- P2 **Table-view state persistence (XERK-31).** The web keeps the usage table open + the page put
  across SSE re-renders. Moot until Android grows a usage table view (see the Usage P1 above).

### Board (`board.js` → `BoardScreen`/`core/Board`)
- Azure DevOps org support (XERK-43) is at parity for free: the agent reports Azure work items in the
  SAME `jira` heartbeat block, ticket shape and detail shape as Jira (with `source:"azure"`), so the
  board renders them unchanged. The only client-side change was `orgName` — now takes the last path
  segment of an Azure siteKey (`dev.azure.com/myorg` → `myorg`); ported to `core/Board.kt` and tested
  in `BoardTest`. The detail sheet's "Open in Jira" label is source-aware on the web (derived from the
  ticket URL); Android's equivalent label is not yet source-aware — see P1 below.
- ~~P0 Per-card Start button (4 states incl. clone-first) + session chips + optimistic sweep.~~
  ~~P0 Ticket cards: type, age, status pill, priority pill, due/overdue.~~ Both done (XERK-78, see
  Done above).
- P1 `[MODEL]` Detail sheet full field grid + "Open in Jira" + error state. (Web's link label is now
  source-aware — "Open in Azure DevOps" for an Azure ticket, XERK-43; Android still says "Jira".)
- P1 Repo picker: cloned/not-cloned optgroups, "Currently set" orphan, `nameWithOwner`, save-error.
- P1 Agent picker (XERK-38, shipped): inline save-error on the row (Android toasts like the repo
  picker's; the web paints "Couldn't save" on the row itself).
- P2 Likely-duplicate chip (XERK-484): the web card's `kc-dup` chip (links to the `triage.dedupeOf`
  twin) and the detail panel's "Duplicate of" row — not ported to Android yet; `TicketTriage`
  already decodes `dedupeOf`, so only the chip + row need drawing (the Jira Duplicate link itself is
  hub/agent-side, not a client surface).
- P2 Mobile scroll-snapping columns with peek; deep-link (`?ticket=&site=`); refresh outcome/landing.
- P3 Card org-chip placement; empty-column + truncation notes. (The org chips themselves are gone —
  XERK-62 — and their "offline · synced N ago" note now rides the header control's org rows.)
- P3 Org control: no cross-tab sync (the web follows a `storage` event when a second tab re-scopes;
  a phone has one instance) and no "Currently set" carry-back for a stored-but-unreported org — the
  pick is kept and resumes, it just isn't listed while nothing reports it, same as the web.

### Usage (`usage.html` → `UsageScreen`)
- ~~P0 30-day stacked daily chart.~~ ~~P0 Legend with per-series + per-group toggles, persisted,
  rescoping.~~ Both done (XERK-78, see Done above); series colors are the categorical palette now.
- P1 Move "By model" out of the grouping tabs into a standalone "Tokens by model" card (Today / Last
  7 days / All-time). Add a collapsible table view with the in/out and cache splits.
- **`fmtTokens` must agree digit for digit on both platforms**, and there are three copies of it:
  `turma/public/usage.html`, `turma/public/index.html` and `ui/UsageScreen.kt`. The same fleet
  figures head the Usage page, the dashboard tiles and both Android screens, so a formatter that
  disagrees shows one number in the browser and another on the phone with nothing to say which is
  right. Two traps, both of which the obvious implementation falls into: rounding a float (Java's
  `%.1f` rounds the shortest decimal HALF_UP, JS `toFixed` rounds the binary double — they part
  company on every `.x5` boundary, ~1% of values), and Java's `format` following the **device
  locale** (`1,2k` in de_DE, `١٫٢k` in ar_EG). Both sides now do integer arithmetic and build the
  string by hand. The web copies must also never return a non-numeric input verbatim — `tokenCell`
  interpolates the result into `innerHTML` — and their "can't state a figure" sentinel is **`–`,
  never `0`**, since `0` asserts a measurement an idle fleet would show too. Agreement holds up to
  2^53: past that `JSON.parse` cannot hold the count exactly and the two can differ by a tenth
  (`9007411349999999` → `9007411.3B` on the phone, `9007411.4B` in the browser). Only BigInt
  parsing would close that, and no real fleet reaches it. Tests: `fmtTokens` cases in
  `turma/tests/usage.test.js` and `turma/tests/dashboard-livestate.test.js` ↔ `ui/FmtTokensTest.kt`,
  sharing vectors. The same locale trap lives in every `String.format`/`.format` on a user-facing
  figure — `Locale.US` explicitly, or the phone disagrees with the browser about one value.
- The **headline totals** (Today / This week / All-time, with the all-time cache split under them)
  are at parity. Android had them first and the web page did not; `fleetTotals`/`renderTotals` in
  `usage.html` are the port of `UsageViewModel.compute`'s window sums, tested against the SAME
  vectors (`turma/tests/usage.test.js` ↔ `UsageViewModelTest`). Both prefer a host's aggregate
  `usage` block and fall back to summing its `repoUsage` only when it reports none — never both,
  which would double-count. Platform difference: Android puts the row above the grouping tabs, the
  web above the limits section, since its grouping bar sits lower.
- The **cache split** (`N cached · N written · N% hit`) is at parity, laid out platform-idiomatically:
  the web hangs it under every token figure in the table view and by-model card, Android under each
  `UsageRow` and the headline stat row, since Android has no table view yet (the P1 above). The
  `CacheSummary` reducer is `UsageViewModel`'s, tested against the same vectors as the web's
  `cacheHitRate` (`UsageViewModelTest` ↔ `turma/tests/usage.test.js`).
- The **subscription limits section** (XERK-247, XERK-301) is at parity: one card per SUBSCRIPTION
  reporting the 5h/7d
  windows, each with the percentage used, a headroom-coloured bar, the countdown to reset, and the
  "captured <age> ago" stamp that goes amber once stale. `limitCards`/`limitView`/`fmtDuration` are
  ports of the web's `limitGroups`/`limitWindowView`/`fmtDuration`, tested case for case
  (`UsageViewModelTest` ↔ `turma/tests/usage.test.js`). Platform difference: the web lays the cards
  out in a wrapping flex row, Android stacks them at the top of the usage list.
- The **sub-agent split** (XERK-302) is at parity in substance: both surfaces name the delegated
  share of Today / Last 7 days / All-time, take it against only the hosts that report a split, and
  show nothing at all when none does. Platform difference: the web is a "Delegated to sub-agents"
  card with a row per window (delegated tokens beside the share), Android is one `SubagentLine` under
  the headline stats carrying the three shares and the all-time token figure — the same condensation
  as the cache split above, and for the same reason (no table view yet).
- P2 Per-day tooltip; the web's texture channel for series 9+ (Android reuses hues past 8).

### Nav / Login
- P3 Optional header descriptor/meta slot (e.g. Sessions running/waiting counts).
- **Native Authentik SSO is IMPLEMENTED on Android (XERK-591).** `LoginScreen.kt` shows a "Sign in
  with SSO" button beside the Hub-URL + break-glass credential fields. It opens the hub's existing
  `/auth/oidc/login` in a **Chrome Custom Tab** (system browser, so passkeys/WebAuthn work — a plain
  WebView breaks them) with a PKCE `mobile` challenge; the hub deep-links a single-use code back to
  `turma://oidc-callback`, which the app redeems (with its verifier) at `/api/oidc/mobile/exchange`
  for the SAME opaque `hub_session` token the web cookie carries. Thereafter requests authenticate as
  `Cookie: hub_session=<token>` (`HubClient`), NOT Basic. `core/Oidc.kt` (PKCE + deep-link parse) +
  `net/OidcController.kt` (probe/exchange) + `Config` (session token, pending verifier). The `turma://`
  redirect is hub↔app only — never sent to the IdP — so it needs no Authentik change.
  - **The SSO-outcome messages have Android analogues now**: `?error=forbidden` (signed in but not in
    an access group, XERK-594) and a failed exchange surface on the login screen via
    `OidcController.ui.error`, worded from `login.html`'s `OIDC_ERRORS`.
  - **Group-based access (XERK-594) stays hub-side** in the OIDC callback and gates only the session
    that flow issues. The break-glass username/password path is unchanged and deliberately not
    group-gated (the IdP-independent local credential).
  - **OIDC sessions are the hub's shorter `OIDC_SESSION_TTL_MS`** (default 8h): a 401 on an SSO token
    drops it (`HubClient` → `Config.clearSession`), and `TurmaApp` returns to the login screen to
    re-authenticate. A break-glass password login keeps the 30-day session.
  - Tests: `core/OidcTest` (PKCE golden vector, deep-link parse), `net/OidcControllerTest` (probe /
    exchange / cookie auth / forbidden / 401-drop over MockWebServer).
