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
| `login.html`                  | `ui/LoginScreen.kt`                                                |

## Deliberate differences (parity by intent, not omission)

- **Native chat instead of the ttyd terminal by default.** The web opens a native chat and keeps the
  raw terminal one toggle away; Android does the same, with the terminal as a separate screen.
- **Hub-URL field on Login.** The web is same-origin; a phone app must point at any hub, so Login has
  an extra Hub-URL field.
- **Voice dictation** into the spawn/compose fields — a phone-only addition.
- **In-app updater** (`ui/UpdateBanner.kt`) — a sideload stopgap until Play (XERK-11), no web analog.

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
- P0 Per-card ⋯ menu: Rename (inline) + arm/confirm Kill; Kill in the chat header.
- P1 Sidebar sections: Queued / Active / Idle / Ended split with state line + question preview.
- P1 Verbosity NORMAL: tool card collapsed (output on expand) to match web; persist per-card open.
- P2 Live status bar: token counters + elapsed + spinner + hint lines + subagent list.
- P2 `[MODEL]` Compose bar: all PR chips + Jira ticket chip; filter modes to `permissionModes`;
  optimistic model/mode update.
- P2 New-session composer in the Sessions list (web can spawn from here).
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
- P0 `[MODEL]` Per-card Start button (4 states incl. clone-first) + session chips + optimistic sweep.
- P0 Ticket cards: type, age, status pill, priority pill, due/overdue.
- P1 `[MODEL]` Detail sheet full field grid + "Open in Jira" + error state.
- P1 Repo picker: cloned/not-cloned optgroups, "Currently set" orphan, `nameWithOwner`, save-error.
- P1 Agent picker (XERK-38, shipped): inline save-error on the row (Android toasts like the repo
  picker's; the web paints "Couldn't save" on the row itself).
- P2 Mobile scroll-snapping columns with peek; deep-link (`?ticket=&site=`); refresh outcome/landing.
- P3 Org-chip "offline · synced N ago"; card org-chip placement; empty-column + truncation notes.

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
