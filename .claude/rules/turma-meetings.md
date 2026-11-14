---
paths:
  - "turma/public/meetings.js"
  - "turma/public/brief.html"
  - "turma/tests/meetings.test.js"
  - "turma/tests/brief.test.js"
  - "turma/public/calendar.js"
  - "turma/tests/calendar.test.js"
---

# The Meetings page: triage + calendar (XERK-2510, XERK-2623, XERK-2857, XERK-2893, XERK-2897)

The web surface of the Meetings epic (XERK-2503). The wire, the review/archive routes and the
`daily` pairing are in `contract-meetings.md`; this file is the triage's own rules.

## Layout

- **One pane, not tabs** (XERK-2857, operator's pick from mockups): `brief.html` mounts
  `meetings.js` once on `#meetingList`; it paints a rail + main pane + per-org settings drawer.
  - Served at `/meetings`; `#brief`, `#meetings` and `/brief` (302 → `/meetings<query>`) all land
    on it.
  - Nav label is "Meetings" (XERK-2893); the Daily Brief inside it keeps its own name.
- Rail: one group per org (the header org pick scopes it), collapsible; the collapsed set is per
  viewer in `localStorage` (`turma-meetings-collapsed`), every access guarded.
  - Entries bucketed Upcoming / Today / Yesterday / This week / Earlier, newest first — except
    Upcoming, soonest first (XERK-2899).
  - Filters Needs review (default) / All / Archived; search over meeting + proposal titles.
- **The daily meeting is ONE entry per `meetingAt`** (`entriesOf`): a meeting's `daily.meetingAt`
  keys it, its `daily.briefRunId` pulls that brief in; other briefs key by their own `meetingAt`.
  - The upcoming one comes from the hub's schedule `next` (`hooks.nextOf`), never computed here.
  - A brief with no captured meeting is still an entry. A hub without `daily` degrades to a
    plain meeting entry + a brief entry.
  - "Current" = today's or upcoming daily entries (else the newest); Run now lives there.
- Needs review = pending proposals, a meeting still being read, a current daily entry, OR the
  selected entry. **The selection is sticky**: an entry whose last proposal was answered never
  vanishes from under the pointer (an SSE frame included); only our own review/archive moves the
  selection on (`advanceFrom`), and then it drops out.
- An entry re-keyed under the viewer (a title-matched daily meeting claims a brief-only
  `d:<M>`) keeps the selection: the entry now carrying its brief/meeting, else the nearest in its
  org (`pickSelected`) — never another org's first entry (QA).
- Narrow (<760px): one pane at a time (`show-main`), a Back button.

## The calendar in the notes review (XERK-2899)

- **Upcoming calendar meetings are rail entries** (`c:<eventId>`), read through the page's
  `upcomingOf` hook = `TurmaCalendar.upcoming(site)`: meetings.js still fetches nothing itself.
  - Listed: the org's timed Outlook events ending after now and starting within 7 days
    (`UPCOMING_MS`), not canceled/declined/free/OOO/working-elsewhere, not all-day, not captured.
  - The calendar keeps reading those weeks while hidden (`upcomingWanted`; `refetch` keeps them);
    `onData` re-renders the triage when a read lands.
  - **An event alone never needs review**: pending 0, never `current`, so Needs review shows it only
    while selected (the sticky selection); counts and `pendingCount` ignore it.
  - Org-colored (`--org`, `safeColor`), time + a Join link (`safeHttps`) beside the button — a link
    can't nest in the rail's `<button>`.
  - The daily meeting's occurrence (start within 20 min of a daily entry) joins that entry
    (`e.event`), never a second entry.
- **A linked capture is named by its Outlook subject** (`meetingTitle`: subject, else
  `inferredTitle`, else Tenir's title; never a private event's "Private event"), with the event's
  time and invitees (`calendarEvent.attendees`) under its meta.
- **Impromptu** = no `calendarEventId` and no `calendarEvent`: labeled in the rail and the pane.
- **Open in calendar** (`hooks.openCalendar` → `TurmaCalendar.reveal`) moves to the week and opens
  the event's panel: matched by the capture (`meetings[]` or its Tenir-only entry) before the id.
  A weekend event in Work week shows Week until a mode pick or weekday reveal (`revealWeek`,
  unsaved); any
  navigation drops a reveal still waiting on its week.
- **Open in notes review** (the calendar panel, `notesTarget` → `TurmaMeetings.reveal`) selects the
  capture or upcoming entry, switching Archived ⇄ All, clearing a hiding search, opening its org.
  A target not listed yet resolves on a later paint (≤30s).
- Tests: the `XERK-2899` cases in `meetings.test.js` and `calendar.test.js`.

## Proposals

- **Nothing reaches the board unasked**: every create is the operator's Approve. A `decision`
  item offers "Log decision" (decisions log), never a ticket.
- Reviewed (created / logged / rejected) proposals leave the list — never greyed in place — and
  count in the progress bar; "show reviewed (n)" lists them. Rejected/failed offer Reopen;
  a `maybeCreated` failure offers Reject only and still awaits review (XERK-2864, XERK-2865).
- Keyboard: A approve, S approve + session (not on a decision), E edit, R reject, J/K move —
  never with a modifier, a key's auto-repeat, focus in a field/contenteditable/dialog, or the
  drawer open (`onKey`).
- **The cursor follows its place, not its key** (`followCursor`, render AND keypress): the hub's
  SSE frame lands BEFORE the POST answer, and clearing the cursor made the next A act on the
  FIRST proposal — a ticket for the wrong one (QA). It moves to the next still listed, else the
  one before. Tests: `meetings.test.js` "SSE frame beats the POST answer".
- **Approve needs a project + issue type, from the New-ticket routes** (`GET .../create-meta`,
  202-polled): the org's "New tickets go to" project (a lone project preselected, a pick kept per
  viewer in `localStorage`, guarded), the type by kind (`defaultType`: bug → a "Bug" type, else
  "Task"). Edit overrides title, description and type. Fetched only for the selected entry's org
  and the open drawer's.
- **The default description is the proposal only** (`ticketDescription`, XERK-2514): no meeting
  title, date, quote or Tenir link. The ticket lands in the org's tracker where colleagues read
  it; captions stay in Turma. Android's `meetingTicketDescription` sends the same.
- A quote links to that moment as a media fragment on the meeting's link (`#t=<seconds>`);
  every link is rebuilt only from an http(s) URL (`safeUrl`), never served text.

## Invariants (each from a QA finding)

- **Every served string is escaped** — model text, quotes, speaker, host, error, org name, site
  key, search echo, archive refusal.
- **Every lookup by site goes through `own()`**; a write to a per-site map is `defineProperty`
  (an org may be named `__proto__`, XERK-1451).
- A refusal shows in the hub's words, inline and as the shared toast (XERK-264) — review, reopen,
  archive, label, whose work.
- Drafts live in `edits`; **a repaint waits while a field has focus or a pointer is down**, the
  press released on pointerup/pointercancel/contextmenu and the WINDOW's blur only (never a
  capture blur). The search's own paint is forced and gives focus + caret back.
- Buttons go `aria-disabled` while busy, never `disabled`; `busy` / `archBusy` / `labelBusy` /
  `focusBusy` are the guard. Busy from the first await (XERK-2511: a Reject must not overtake an
  Approve that is still loading its types).
- **`meetings.js` has NO snapshot or stream of its own**: `brief.html` owns `/api/agents` + SSE
  and hands every change to `update(data, force)`. It is in `HASHED_ASSETS`.
- The brief block and schedule editor are `brief.html`'s (`turma-daily-brief.md`), passed as
  mount hooks; `invalidate()` after the page patches controls in place, `hold()` owes a repaint.

## Settings drawer (⚙ per org)

- New tickets go to; Whose work (XERK-2514: names as captions spell them + role, Save / Clear,
  `meetingFocus`); Tenir label (XERK-2638: Save, Reset for an operator's, `meetingLabels`); the
  Daily brief schedule (live orgs only) with "Daily meeting title contains" (`meetingTitle`).
- Labels Tenir sent that no org has: ONE banner on top, a row per label with an org pick.
- Android port of the triage is its own ticket (`android/PARITY.md`, Brief section).
- **A settled meeting shows its written summary above the proposals** (XERK-2894, `summaryHtml`;
  Android `meetingSummaryParagraphs` in `MeetingPart`): plain text, escaped, paragraphs on blank
  lines; and is named `meetingTitle` everywhere (head, rail, search; XERK-2899 above).
- Tests: `turma/tests/meetings.test.js`, `turma/tests/brief.test.js` (the `XERK-2857` cases).

## The Calendar view (`calendar.js`, XERK-2897)

- **Two views, one page**: `brief.html` shows a Calendar / Notes review switch; the pick is per
  viewer in `localStorage` (`turma-meetings-view`, guarded), Calendar by default. A `?site=` link
  (the proposals push) opens Notes review. The hidden view's keys are inert (`offsetParent`).
- **`calendar.js` reads its own routes** (`/api/calendar` per Monday–Sunday week, prefetching the
  weeks either side; `/api/holidays` for the same days). The org pick is part of the cache key
  (`<orgs>|<week>`); a read keeps the pick it started with.
- **What re-reads it** (each a QA finding): `calendar`, `holidaySettings` AND `meetingProposals`
  frames (a Tenir-only capture is announced only by the last), coalesced 1s (`calendarSoon`); a
  stream reconnect; a 60s poll while the stream is down.
  - `refetch()` re-reads only the shown weeks + neighbours and DROPS every other cached week: a
    frame re-reading every week ever browsed grew without bound (and re-queued host syncs).
  - A failed read is retried every 20s while shown and at once on showing; it never sticks.
  - A host whose stored `ranges` miss the week, or `pending`, reads "Syncing …" and is re-read
    every 20s; the hub queues the sync itself on that GET. Offline / `lastError` hosts get a stale
    notice; the calendar still renders the hub's copy.
  - `lastError` is quoted as is, never labelled "Outlook" (the hub's budget errors ride it too),
    and an offline host shows it as well.
- **Week math is local wall time via `Date` setters** (`addDays`, `weekStart`), never `+ 86400000`:
  a DST week has a 23/25h day. Event rows use wall minutes (`wallMinutes`). Tests pin both DST
  edges and the year boundary.
- **Teams decisions** (researched on Microsoft's "Manage your calendar in Teams" / new-calendar
  docs; recorded so a later change doesn't drift):
  - Work week (Mon–Fri) is the default; Week is Mon–Sun; ‹ › move a week; Today; the range label
    opens a mini-month (month ‹ ›, year « »). Narrow (<760px): Day / 3 days, arrows + swipe.
  - 30-min rows (24px), working hours 8–17 shaded white, the grid opens scrolled to 8:00, a red
    now-line with a dot on today, today's header in the accent with a top bar.
  - Events: a 22% tint of the org color with a 4px solid left bar (unassigned = neutral);
    overlaps share the width and widen into free columns to the right (`layoutDay`).
  - Tentative / not responded = hatched; free / declined = outlined; canceled = "Canceled: " +
    strikethrough (kept, as Teams keeps them); past = dimmed; Tenir-only (`source:"tenir"`) = a
    caption glyph. All-day and ≥24h events ride the all-day band, one chip per day (Teams draws a
    spanning bar; not worth the layout here).
  - Holidays sit in the all-day band; a day off for an org in view (`offFor` ∩ header pick) is
    hatched grey with "Day off · <org>".
- **Read-only grid**: nothing drags, creates or edits. A click opens the detail panel (XERK-2898).
- Keyboard: events are buttons in day order; ↑/↓ within a day, ←/→ to the nearest event of the
  next day, Esc closes the picker / panel. Every event carries an aria-label sentence.
- **Esc listens on the document** (so it works after a click elsewhere) and yields to a SHOWN
  modal (`MODAL_OPEN`) or an Esc already `defaultPrevented`. Never test a modal's mere presence:
  `#createPanel[aria-modal]` stays in the DOM while hidden (QA).
- Every served string is escaped (subject, location, organizer, device, error, holiday, org);
  a join link is rebuilt only from an `https://` URL (`safeHttps`); an org color is inlined only
  as `var(--sN)` (`safeColor`).
- Android: XERK-2900 (`android/PARITY.md`). Tests: `turma/tests/calendar.test.js`, the
  `XERK-2897` cases in `brief.test.js`.

## The event detail panel (XERK-2898)

- **The panel paints apart from the grid**: `calendar.js` mounts `.cal-main` + an `aside.cal-detail`
  holding `.cal-dinfo` (its own) and `.cal-dmt` (meetings.js's). A grid repaint (frame, clock)
  never swaps the panel's controls; the info part holds its paint while a field in it is focused
  or a press is down, like meetings.js.
- **A capture is reviewed with meetings.js's own controls, never a fork**: `TurmaMeetings.showPanel
  (el, {site, meetingIds, dailyAt})` paints `meetingHtml` (+ the names, `people`) into `.cal-dmt`
  and wires the same click/input/change handlers there. Busy, escaping, `edits`, refusals all
  carry over; `showPanel(el, null)` when the panel closes or the calendar is hidden.
  - **The keys follow the panel while it shows a meeting** (`panelOn`, `activeOrder`): A/S/E/R/J/K
    walk its proposals (the hidden notes view's stay inert otherwise), and `followCursor` runs on
    the panel's order — the SSE-frame-beats-POST rule holds there too.
  - A review in the panel never moves the notes view's selection: `fromPanel` is decided at the
    PRESS, never at the answer (the panel may have closed by then, QA). Its cursor is put aside
    while a panel shows a meeting and restored after.
  - The panel's aside is NOT `role=dialog`: meetings.js ignores keys from inside a dialog.
- **An event counts for the org the hub's matcher reads** (`eventOrg` = the served `matchOrg`;
  an older hub: assigned org, else the host's): for the daily brief and relink candidates (QA:
  another org's unassigned event was offered; a series pinned to no org must not count).
- `advanceFrom` resets the NOTES cursor: while a panel is open that is `panel.listCur`, never the
  live `curItem` (QA: a notes answer landing mid-panel made the next R hit the wrong proposal).
- One org's captures per panel (the first linked capture's site); a daily event (an Outlook event
  within 20 min of an org's daily `meetingAt`) shows that entry's brief via `hooks.briefHtml`.
  `brief.html` listens for the brief's buttons on `#calendarView` too.
- "Moved from …" is read off the occurrence id (`<GlobalAppointmentID>:<original start>`,
  `originalStart`), or a Tenir entry's `moved`; Canceled from `canceled`.
- **Relink** posts `POST .../meetings/<mid>/calendar` (`relink`): candidates are same-day,
  uncanceled, timed Outlook events of the capture's org or unassigned; Unlink = `{eventId:null}`;
  "Match automatically" only when the row's `calendarBy` is `operator`. The answer's row goes to
  `TurmaMeetings.patch`; a Tenir entry that a link (or "Match automatically") merged into an event
  follows it there on the next read.
  - **A key in an HTML attribute never carries a NUL** (`evDomKey`): the parser turns it into
    U+FFFD, and the picker silently did nothing (QA). Test markup that went through a parser.
- **Badges** (`badgeOf`): proposals still pending (`TurmaMeetings.meetingState`, archived = 0) or a
  spinner while the captions are read; said in the event's aria-label too.
- A Tenir entry the snapshot no longer carries shows the entry's own participants/summary/link.
- The panel keeps XERK-2899's "Open in notes review" (`openNotes`, in `.cal-dinfo`) and paints no
  "Open in calendar" in its own capture part (`inPanelPaint`): `calTargets` indexes the notes view's
  paint and a panel push would collide with it.
- Tests: the `XERK-2898` cases in `calendar.test.js` and `meetings.test.js` (incl. an end-to-end
  calendar→panel→review run with both modules in one sandbox).
