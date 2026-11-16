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
| Meetings page (triage + brief) | `ui/BriefScreen.kt`, `core/MeetingsTriage.kt`, `core/DailyBrief.kt` |
| `nav.js` (header/bottom-nav)  | `ui/MainScaffold.kt`, `ui/TurmaApp.kt`                             |
| `org.js` (header org filter)  | `ui/OrgControl.kt`, `vm/OrgViewModel.kt`, `data/OrgFilter.kt`      |
| `login.html`                  | `ui/LoginScreen.kt`                                                |

## Deliberate differences (parity by intent, not omission)

- **Native chat instead of the ttyd terminal by default.** The web opens a native chat and keeps the
  raw terminal one toggle away; Android does the same, with the terminal as a separate screen.
- **Hub-URL field on Login.** The web is same-origin; a phone app must point at any hub, so Login has
  an extra Hub-URL field.
- **Voice dictation** into the spawn/compose fields — a phone-only addition.
- **Insights is WEB-ONLY (operator decision, XERK-2386).** The web's Insights page (`/insights`)
  holds the per-org decisions log, the permission-prompts ledger and model quality (shadow runs);
  Android has none of them, and the web nav's Insights tab has no Android bottom-nav counterpart.
- **No org brief on either client (XERK-2386).** The brief page, its "Brief now" and its push alert
  are retired on the web and Android alike; Android ignores a `briefs` key an older hub still sends.
- **Manual Refresh button on the Dashboard.** The web dashboard has no explicit refresh control (it
  auto-polls + SSE); the phone keeps a header Refresh button for a deliberate re-poll. It now shows a
  spinner while the awaited `/api/agents` poll runs (a short visible floor so a fast poll still reads
  as an action), matching the board button's in-flight treatment (`FleetViewModel.refresh`).
- **Wide board column area on large screens (XERK-606).** The web board widens ONLY its Kanban
  column area past the shared reading width (`--wrap-board`, header/toolbar/footer stay centred at
  `--wrap`) so more of the fixed-300px columns show without horizontal scroll on a desktop monitor.
  No Android analog: the phone board is already a horizontally scroll-snapping strip of 300dp
  columns sized to the device, with no separate centred header column to hold in place. Web-only
  responsive/desktop layout; nothing for the phone to match.
- **Meetings page toolbar spacing (XERK-2962).** The web Meetings page's Calendar / Notes review
  chips sit as close under the site header as the board's toolbar. Pixel spacing only; the phone's
  Meetings tab lays its own view switch out platform-idiomatically, so nothing changes there.
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
- **Session-card PR chips: share line 1 with the state text, then wrap to full-width rows.** On web
  the chips share the state line with the state text ("idle"), packed to its right (the state keeps
  `flex:1 1 auto` and grows, so line 1's chips land at the right edge), then WRAP to their own
  full-width rows below. The state-row reclaims BOTH corners — `margin-right` for the ⋯/Resume corner
  padding and `margin-left` for the status-dot gutter — so a wrapped chip row runs edge to edge at a
  ~10px inset on both sides; `justify-content:flex-end` right-aligns the wrapped rows, and the sidebar
  is trimmed (366px) so four chips span that full reclaimed width — the row runs edge to edge, leftmost
  chip in the reclaimed gutter, rightmost at the ⋯-padding inset. `display:contents` on `.pr-list`
  folds the chips into the state-row's single wrap flow; the state keeps a matching `margin-left` so
  its text stays aligned with the title/meta. This lifts the old ~3-per-row cap (XERK-736). Android is unaffected: `SessionsScreen.kt` already
  renders the PRs in their own start-packed `FlowRow` below the state text — an accepted,
  pre-existing platform-idiomatic difference, not a new gap. No Android change; web
  (`sessions.html`) only.
- **Chat COMPOSE footer arrangement.** Web (`chat.js` `renderComposeOpts`) now lays the footer as a
  controls row — context meter + ticket chip on the left, mode/runtime/model chips on the right —
  over a full-width PR-chip row beneath it. Android's `ChatScreen.kt` `ChatFooter` keeps its vertical
  stack: one chip `FlowRow` (mode/model/run + the PR badges, which already wrap) with the
  `ContextMeterBar` on its own line below. Both avoid the old overlap; a phone is too narrow for a
  left/right-split top row to buy anything, and Android's compose bar has no ticket chip. Accepted
  platform-idiomatic difference — no Android change; web (`sessions.html` + `chat.js`) only.
- **In-app updater** (`ui/UpdateBanner.kt`) — a sideload stopgap until Play (XERK-11), no web analog.
- **Chat text-size control** (XERK-144) — a phone-only addition, no web analog. The chat settings menu
  (the top-bar ⚙/Tune button that holds verbosity) also picks a chat text size, scaling every bubble/
  thinking/tool font in `ui/TranscriptView.kt`. Unlike verbosity (per-session) it is ONE fleet-wide
  preference, stored in `data/TextSizePref.kt` and read by every transcript renderer through
  `LocalTextSize`. A phone screen and the range of eyesight reading it vary far more than a desktop
  browser (which has OS/browser zoom); the web can revisit this later.
- **Chat verbosity defaults to Concise** (XERK-40), where the web defaults to Normal — a phone screen
  fits far less, so tool cards/outputs are opt-in there. A per-session pick still persists as on web.
- **A block-less entry's trailing tool markers render as hideable tool rows on Android; the web shows
  them literally** (XERK-861). For an entry with no rich blocks (an older agent / the text-only
  heartbeat seed), the agent flattener leaves a trailing run of `[ToolName]` markers on the text.
  `core/ChatItems.kt`'s `degradedBlocks` splits that run into NAME-ONLY tool_use rows the verbosity
  filter hides under Concise / shows under Normal; bracketed prose is left intact. The web `chat.js`
  synthesizes such an entry as ONE text block and renders the markers **verbatim in every verbosity**
  (no `degradedBlocks` exists there on `main`). Both preserve prose — the old Android strip deleted it
  (the XERK-861 bug); this is a documented **improvement** over that, not web parity. Parity is
  restored when the in-flight chat markdown-fidelity work lands the same split in `chat.js`; until
  then Android leads. Tracked here per XERK-30.
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
- **Session Trajectory view is WEB-ONLY (epic XERK-712).** The generalized Trajectory pane — a
  read-only turns / tool-calls / tokens render for Claude and Qwen sessions (not just dsh), toggled
  beside "Terminal ▸" (XERK-717) and served by `GET /api/archive/<transcriptId>/trajectory`
  (XERK-715) — ships on the WEB only; no Android. This includes the read-only stage's
  Trajectory toggle (XERK-718): the web ended/killed-session and archived-transcript views now
  offer the same archive-served Trajectory (full tokens/model/timings for an ended session, works
  for an offline host), also web-only. Android carries only the earlier dsh-specific Trajectory
  screen (`ui/TrajectoryScreen.kt`, XERK-498) over `GET /api/dsh/<id>/trajectory`, opened from a
  dsh chat, and is NOT being generalized to Claude/Qwen nor to the ended-session view here.
  Recorded web-only like the archive Restore picker (XERK-453); a later ticket can port the shared
  view to the phone if a need appears. Shape/renderer invariants: `.claude/rules/trajectory.md`.
- **Read-only transcript bottom pin (XERK-2956, XERK-2953)**: the web keeps the pin when the pin's
  own late scroll event lands after an image grew the pane (`stPinTop`). No Android change:
  `ReadOnlyTranscript` decides the pin only when a scroll settles, so it has no such event.
  The XERK-720 additions — an absolute wall-clock timestamp on the head/turn/call and an
  expand-to-full toggle for any ellipsis-snippeted field — are part of this same web-only pane, so
  no Android change; a future port carries them with it. So is XERK-734: each turn header is
  a collapse toggle that folds/unfolds that whole turn's body.

- **Sessions card subtitle refresh (XERK-735).** The web card's second line (`cardMeta` in
  `sessions.html`) was reordered to `repo · related ticket · pc name · session id` and clamped to one
  line with an ellipsis + hover-reveal `title`, and its ticket key became a LINK to that ticket's
  detail on the board (`/board?ticket=&site=`, same in-app hop as the chat footer chip). Android's
  ACTIVE, QUEUED and ENDED rows all match the new order, each one line with ellipsis
  (`SessionsScreen.kt`); the active row dropped its old `pc · repo · branch` FlowRow (XERK-125) for
  the same `repo · ticket · pc · id`. One web-only part remains: the ticket key is NOT a tappable
  board deep-link on Android's session cards — the board is a top-level tab with no ticket-detail
  route, so that needs new cross-screen nav plumbing; a later ticket can add it.
  - The in-session stage-bar header (web `.term-bar .t-title`) now stacks the identity/meta line
    BELOW the title instead of letting it wrap off the first line (`app.css`). Android's chat header
    (`sessionHeaderMeta`) is already a separate line under the title, so no change was needed there.

- **New-session repo list flows to fill the width (XERK-739).** The web `#spawn` sidebar picker laid
  each host's repos ONE CARD PER LINE; they now wrap (`.repo-btns` flex-wrap), several per row, an
  open composer taking the whole row. Web-only: Android's equivalent is the modal
  `NewSessionPickerDialog` (host → repo), a full-width dialog list, not a wrappable sidebar column, so
  the flow layout does not map. A later ticket can lay its repo rows out multi-column if a need
  appears.

- **Dark categorical slot s4 is `#2E9E2E` on Android, `#008300` on the web (operator call).** Every
  other dark slot (`ChartSeries`, `ui/theme/Color.kt`) equals the web's dark `--s1..--s8`
  (`app.css`); s4 is kept at Android's lighter green on purpose, so do not "fix" either side.

## Meetings tab — meetings triage with the Daily brief folded in (XERK-2858)

- **At parity with the web's two-pane triage (XERK-2857)**: one list of every org's meetings,
  orgs collapsible (remembered per phone), bucketed Upcoming / Today / Yesterday / This week /
  Earlier, Needs review / All / Archived chips and a search over meeting and proposal titles.
  - Each org's daily meeting is ONE entry per scheduled `meetingAt`: its brief read aloud on top
    (Run now on the upcoming one), every capture's proposals below (`core/MeetingsTriage.kt`).
  - An entry: pending proposals first, reviewed ones behind "Show reviewed (n)", Reopen on a
    rejected one, "x of n reviewed", Archive / Unarchive meeting, and Next once all are reviewed.
  - The org's ⚙ panel: New-tickets project, Whose work (one name per line), Tenir label, and the
    Daily brief schedule with "Daily meeting title contains". Unmapped Tenir labels: one banner.
- **Wide (tablet / unfolded foldable, Expanded width) is the web's two panes** (XERK-2878): the
  list beside the open entry, nothing picked = the first entry shown (the web's `pickSelected`),
  the open entry marked in the list; ⚙ settings open in the entry pane (web: a drawer).
- Platform differences: a phone shows one pane at a time (list, entry or settings; Back returns),
  as the web does under 760px. No keyboard shortcuts (A/S/E/R/J/K). The project pick is kept per
  phone. A failed create stays in the pending list with Approve to retry it. A long refusal
  toast is cut at two lines (a platform limit on toasts).
- **Gap: no "Assign to" picker yet** (XERK-2517). The web pre-fills a proposal's assignee with
  the tracker user its speaker maps to (`item.assignee`); the phone sends no `assignee`, so its
  Approve still assigns the ticket to the operator, as before (the hub records no assignee edit
  for it). Decode-safe: `assignee` and the review's new fields (`warning`, `assigneeRefused`…)
  are untyped here, so a created proposal's warning is not shown on the phone yet either. Port: a picker in `ItemRow`, the body field in
  `core/Meetings.kt`, Approve + start hidden when the pick is not "Me".
- `dailyBriefs`, `dailyBriefSchedules`, `meetingLabels`, `meetingLabelMisses` and `meetingFocus`
  decode per org (`LenientSiteMapSerializer`), so a malformed entry drops alone.
- **The Calendar view (XERK-2897/2898/2899 → Android XERK-2900)**: a Calendar / Notes review switch
  (kept per phone; a meetings push opens Notes review) over the same `/api/calendar` +
  `/api/holidays` reads (`ui/CalendarScreen.kt`, `core/Calendar.kt`, `vm/CalendarViewModel.kt`).
  - Phone: Day / 3 days under the week's day strip, ‹ › and swipe; a tablet or foldable (the
    calendar ≥600dp wide, Medium included): Work week / Week, the detail beside it from 840dp. The
    range label opens a date picker (the web: a mini-month). Today, the all-day band with holidays
    and day-off hatching, org-tinted blocks side by side, tentative hatched, free outlined,
    canceled struck, past dimmed, the Tenir glyph, review badges, stale-host notices.
  - The event detail: full screen on a phone (Back closes it), beside the grid when wide; the
    capture is reviewed with the notes review's own `MeetingPart`; relink / unlink / Match
    automatically; the daily meeting's brief; Open in notes review.
  - Notes review: upcoming calendar meetings (org bar, Join), a linked capture named by its
    Outlook subject with its time + invitees, Impromptu, Open in calendar.
  - Android's swipe slides the days with the finger and settles with an animation; in Day / 3 days
    it moves ONE day (XERK-2980), while ‹ › still page by what is shown. The web's narrow swipe
    still jumps a page (a touch gesture the operator asked for on the phone only).
  - Platform differences: no keyboard walking (←/→/↑/↓, Esc) and no A/S/E/R/J/K in the panel;
    the date picker is Material's, not the web's mini-month.
  - The grid fills the screen on both (XERK-2937); the web widens the Calendar view to the
    board's 1640px column.
  - Zoom (XERK-2954): both size the rows so N hours fill the pane (4–24, default 10 = 8 AM–6 PM),
    kept per viewer. Web: − / + in the bar and Ctrl/⌘+wheel; Android: pinch, plus TalkBack's
    "Zoom in" / "Zoom out" actions in place of the buttons.
  - On for every org, no feature flag (XERK-2901). A host going offline or back re-reads the
    open week on both clients (the hub's `calendar` frame), so the stale-host notice is live.
  - **Turma-made events (XERK-2971 web, XERK-2972 Android)**: both clients create, edit and
    delete them and draw them in the Turma blue → purple with the org-colour bar (split for
    several orgs on the web; a "+N" mark on Android). Details in the next bullet.
  - XERK-2943 (web) needs no Android change: a wide web window now narrows the week while the
    detail panel is open, which Android already does by placing the detail beside the grid. The web
    also hides a block's time line by the block's drawn height (`SHORT_DP` against the zoomed row
    height on Android).
- **Turma-created events (epic XERK-2967 → Android XERK-2972)**: ＋ (FAB) or a tap on an empty
  slot opens a full-screen editor (title, required / optional attendees, start / end, all-day, time
  zone, location, online + join link, details, show as, categories, private, orgs ≥1, Repeat)
  → `POST|PATCH|DELETE /api/calendar/events`.
  - A touch that moved is never a create, as on the web (its 10px pointerup check). Platform
    difference: Android also ignores a long press on an empty slot, and its grid scrolls the last
    hour clear of the FAB (the web's New event is a toolbar button that covers nothing); a phone
    in landscape shows New event in the toolbar, as the web does.
  - Repeat (XERK-2973) is the web's control: the same presets, custom interval / unit / days /
    month mode, end never / on date / after N, and summary (`core/CalendarRepeat.kt`, both clients
    read `turma/tests/fixtures/calendar-repeat-vectors.json`). An occurrence's Edit / Delete asks
    This event / This and following / All events; This event locks orgs, zone and rule.
  - Platform difference: the scope prompt is a dialog, the web's is inline in the panel.
  - Both editors refuse a start / end the zone kept local mean time at (an offset with seconds,
    e.g. Europe/Brussels 1890, Africa/Monrovia before 1972): an ISO offset carries whole minutes
    (XERK-2953; web `keepsLmt`, Android `calDraftErrors`).
  - An event of several orgs is ONE block with a "+N" mark, its detail naming every org; the hub's
    `?org=` filter matches any of them. Edit / Delete only on a Turma event served `editable:true`
    with a `version` (absent = an older hub, read-only); Outlook events are unchanged.
  - Each org's Outlook copy (XERK-2987): the detail names it per org ("In Outlook" / "Writing…" /
    "Failed: <Outlook's words>" / "No Outlook host for this org"), and the block wears "!" (failed)
    or "…" (writing). No Retry on either client (the hub has no retry route; the next edit retries).
    An older hub's event (no `outlook`) keeps "Made in Turma — not on Outlook".
  - A 409 (changed since opened) shows the hub's words and reloads the editor from the event it
    carries. Both clients send the same body (`core/CalendarEvents.kt` `calDraftPayload` ↔ the
    web editor's save).
  - Platform differences: attendees are typed (`Name <email>`, comma-separated), not picked; the
    time zone is a text field (an IANA id) defaulting to the phone's.
- **Calendar settings (XERK-2929)**: an org's ⚙ settings edit its days off (a tick per catalog
  country and per holiday, each saved at once); the calendar's ⚙ lists each host's org (text) +
  Show private events. An Outlook event's Org row is text: its host's org, locked (XERK-2964).
  `holidaySettings` and `holidayCatalog` decode per entry.
  - Platform difference: a refused save toasts (and the calendar's rows show it inline); the
    settings panel's refusal is the toast alone, as its other sections (one failure surface).

## Where the rest of the tracker lives

This file holds the map, the deliberate differences and the Meetings tab. The rest is split so
each file stays under 40,000 characters (the size gate in `code-scan.yml`):

- `PARITY-open.md` — the open gaps, by screen and priority. Add a new gap there.
- `PARITY-done-1.md` — closed gaps: the first installment through XERK-246.
- `PARITY-done-2.md` — closed gaps: XERK-481 onward. Add a newly closed installment there (start
  `PARITY-done-3.md` when it nears the limit).

