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
| Sessions sidebar full-search  | `ui/ArchiveScreen.kt` (reached via the Sessions search action)     |
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
- **In-app updater** (`ui/UpdateBanner.kt`) — a sideload stopgap until Play (XERK-11), no web analog.
- **Chat verbosity defaults to Concise** (XERK-40), where the web defaults to Normal — a phone screen
  fits far less, so tool cards/outputs are opt-in there. A per-session pick still persists as on web.
- **One "+" per repo, opening the composer** (XERK-69). The web dashboard has two spawn controls per
  repo — a "+ New session" quick bare-spawn and a ▾ caret to the option composer. Android collapses
  these to a single "+" that opens the `SpawnDialog` (prompt/label/base/model/mode); the separate
  quick-spawn (was the ⚙/Tune icon) is gone. A phone header has room for one action, and the composer
  covers the bare case by leaving every field blank.

## Done (this pass — first installment)

- **Board "In Review" column.** `core/Board.kt` now carries the 4th category and the review/testing
  status-name carve-out from `inprogress` (was 3 columns → review tickets mis-bucketed). Columns sort
  newest-`updated` first. Ports `board.js` `categoryOf`/`ticketSort`. Tested in `BoardTest`.
- **Typewriter reveal snap on live-turn block swaps.** `core/Reveal.kt` `liveRevealBase` +
  `ChatViewModel` — the non-monotonic pane scrape no longer re-streams the last line from a stale
  offset (the web `chat.js` `startsWith` check, XERK-19). Tested in `RevealTest`.
- **Sign out.** A ⋮ overflow on the shared `ScreenHeader` (every top-level screen) that unregisters
  push, clears credentials, and returns to Login — the web has Sign out in its nav on every page.
- **Full-history archive search reachable.** `ui/ArchiveScreen.kt` was fully built but orphaned; it's
  now a route reached from a search action on the Sessions header (the web puts this search in the
  Sessions sidebar). The live Sessions box is relabeled "Filter these sessions" to distinguish it.
- **Dashboard summary tiles.** The six tiles (Hosts online / Running / Waiting on you / Tokens
  today·week·all-time + dominant model) atop the Fleet screen, from `core/Fleet.kt` (a pure port of
  index.html's reducers). Tested in `FleetTest`.
- **Question option preview.** The collapsible preview mockup the TUI shows (`chat.js` `q-prev-wrap`)
  now renders on each option card.
- **Split compose bar (XERK-33).** Send now ALWAYS sends (mid-turn it queues); a separate
  warning-coloured Stop appears beside it while a turn runs, suppressed during a pending question. Was
  a single button that morphed into Stop — on a phone (no Enter key) that made mid-turn queueing
  impossible. `ui/ChatScreen.kt`.
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
- **Fleet-wide org filter (XERK-62).** The board's org chip strip is gone; one org control lives in
  the shared `ScreenHeader` and so is on all four top-level screens, scoping each of them from the one
  persisted pick — Dashboard hosts + tiles, Sessions lists + new-session host picker, Board tickets,
  Usage series (both groupings). A host polls exactly one org, so scoping the agent list scopes
  everything built from it; a host with NO tracker block belongs to no org and shows only under "All
  orgs". A pick for an org nobody reports any more doesn't apply but is KEPT, so it resumes when that
  host comes back, and each screen's empty state distinguishes "nothing reported" from "the filter
  narrowed this to nothing" and points at the header. Ports `turma/public/org.js`: `siteKeyOf` /
  `filterAgents` / `effectiveOrg` / `scopedAgents` / `storedOrg` / `ageStr` in `core/Board.kt` (tested
  in `BoardTest`), the pick hoisted to `data/OrgFilter.kt` + `AppContainer` (migrating the old
  board-only preference forward, as the web migrates `turma-board-org` → `turma-org`), the control in
  `ui/OrgControl.kt` + `vm/OrgViewModel.kt`, call sites in `ui/FleetScreen.kt`, `ui/SessionsScreen.kt`,
  `ui/BoardScreen.kt`, `ui/UsageScreen.kt`. Platform form: a Material dropdown of rows (dot, org name,
  ticket count, offline/synced note, `Switch` for auto-start) rather than the web's button + popover of
  divided pills.
- **Selectable/copyable transcript text (XERK-64).** The web chat relies on native browser text
  selection to copy session text (and defers repaints to keep a live selection intact). Compose `Text`
  isn't selectable by default, so the transcript `LazyColumn` in `ui/ChatScreen.kt` and the
  archived/ended transcript viewer in `ui/ArchiveScreen.kt` are now wrapped in a `SelectionContainer`:
  long-press selects, the system copy toolbar copies, and taps still toggle the tool/thinking cards.

## Open (subsequent installments), by screen and priority

Many of these need Android's wire model (`model/Models.kt`) to decode fields the web already renders;
those are marked `[MODEL]`.

### Dashboard (`index.html` → `FleetScreen`/`FleetDialogs`)
- P0 `[MODEL]` Session card detail: status badge (incl. `queued`/`stopping`), id, worktree/branch,
  work-risk line, RC name, queued reason, error, created/activity, token totals + output.
- P0 `[MODEL]` `queued`/`stopping` states + Cancel button + optimistic pending feedback on actions.
- P1 `[MODEL]` Host meta (memory, uptime/last-seen, repos-root, session counts), container-log toggle.
- P1 Host collapse persistence; Jira org label beside hostname; Remove-host for offline hosts.
- P1 Clone bar: collapse + search + multi-select + `🔒` private marker + clone-job status rows.
- P1 `[MODEL]` Repo blocks: branch/dirty meta, remote link, orphan repos, prune-note, empty state.
- P1 Composer base-branch dropdown + per-repo option persistence.

### Sessions + Chat (`sessions.html` + `chat.js` → `SessionsScreen`/`ChatScreen`)
- P0 Jump-to-latest pill + stick-bottom scroll (stop auto-scroll fighting the reader).
- P0 Ended sessions: read-only transcript view (archive fetch) with PR chips + Resume, not just a
  live-relaunch; include stopped + `repo.resumable` channels; exclude non-running from the live list.
- P0 Per-card ⋯ menu: Rename (inline) + arm/confirm Kill. (Kill in the chat/terminal header is done —
  XERK-44; the per-list-card ⋯ menu with Rename is still open.)
- P1 Sidebar sections: Active / Idle split done (XERK-73) — `rankRunning` ranks running sessions
  attention-first / freshest-first into Active (waiting+working) and Idle, plus a Stopped group for
  non-running registry records. Still open: a dedicated Queued section, and a state line + question
  preview on each card.
- P1 Verbosity NORMAL: tool card collapsed (output on expand) to match web; persist per-card open.
- P2 Live status bar: token counters + elapsed + spinner + hint lines + subagent list.
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
- P3 **Terminal compose Stop.** XERK-33 also split the terminal compose bar; Android's
  `ui/TerminalScreen.kt` bar still only sends (it's a separate WebView screen with no live busy read).

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
- P0 `[MODEL]` Per-card Start button (4 states incl. clone-first) + session chips + optimistic sweep.
- P0 Ticket cards: type, age, status pill, priority pill, due/overdue.
- P1 `[MODEL]` Detail sheet full field grid + "Open in Jira" + error state. (Web's link label is now
  source-aware — "Open in Azure DevOps" for an Azure ticket, XERK-43; Android still says "Jira".)
- P1 Repo picker: cloned/not-cloned optgroups, "Currently set" orphan, `nameWithOwner`, save-error.
- P1 Agent picker (XERK-38, shipped): inline save-error on the row (Android toasts like the repo
  picker's; the web paints "Couldn't save" on the row itself).
- P2 Mobile scroll-snapping columns with peek; deep-link (`?ticket=&site=`); refresh outcome/landing.
- P3 Card org-chip placement; empty-column + truncation notes. (The org chips themselves are gone —
  XERK-62 — and their "offline · synced N ago" note now rides the header control's org rows.)
- P3 Org control: no cross-tab sync (the web follows a `storage` event when a second tab re-scopes;
  a phone has one instance) and no "Currently set" carry-back for a stored-but-unreported org — the
  pick is kept and resumes, it just isn't listed while nothing reports it, same as the web.

### Usage (`usage.html` → `UsageScreen`)
- P0 `[MODEL surface]` 30-day stacked daily chart (per-day buckets exist server-side but are dropped
  in `UsageViewModel.compute`).
- P0 Legend with per-series + per-group toggles, persisted, rescoping chart/table/models.
- P1 Move "By model" out of the grouping tabs into a standalone "Tokens by model" card (Today / Last
  7 days / All-time). Add a collapsible table view with in/out split.
- P2 Per-day tooltip; categorical per-series colors.

### Nav / Login
- P1 Login: distinguish 401 (bad credentials) from unreachable-host, matching the web's messages.
- P3 Optional header descriptor/meta slot (e.g. Sessions running/waiting counts).
