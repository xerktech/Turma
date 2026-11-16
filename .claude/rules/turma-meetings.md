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
- **"Assign to" is pre-filled with the mapped speaker** (XERK-2517, `assignHtml`): shown only on a
  proposal whose item carries `assignee`; options that name, Me, Unassigned; the pick is per
  proposal in `assignPicks` and rides Approve as `assignee`. A pick other than Me hides Approve +
  start (S answers "approve it without a session"). Never paint the tracker id. No mapping = the
  plain "Owner:" line and the old Approve. Android: a `PARITY.md` gap.
  - `assign` is in `FOCUS_ATTRS`: the pick repaints, and without it keyboard focus fell to
    `<body>` mid-ArrowDown (QA).
  - A created proposal shows the review's `warning` (a refused assignee, unattached files).
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
- **A control that saves on change and holds no draft is exempt from the focus hold** (the
  day-off boxes, XERK-2929): held, it showed a stale read until
  blur. Its busy state is `aria-disabled` too, and focus is restored by its data key.
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
- **A meeting's full transcript is its own collapsed section AFTER every proposal** (XERK-2941,
  `transcriptHtml`; ONE per meeting, never per item — the operator's pick;
  Android `TranscriptSection` in `BriefScreen.kt`): read from the hub ONCE on first open
  (`transcripts` cache; a failed read retries on the next open, a missing one never), never on the
  snapshot. Consecutive lines of one speaker are one turn, ONE dense line each (time, name, words
  inline — the operator's pick over separate rows); a turn's time links to that moment in
  Tenir (`momentUrl`). Every caption is escaped. Tests: `XERK-2941` in `meetings.test.js`,
  `MeetingsScreenTest`, `MeetingsTest`.
- **A settled meeting shows its written summary above the proposals** (XERK-2894, `summaryHtml`;
  Android `meetingSummaryParagraphs` in `MeetingPart`): plain text, escaped, paragraphs on blank
  lines; and is named `meetingTitle` everywhere (head, rail, search; XERK-2899 above).
- Tests: `turma/tests/meetings.test.js`, `turma/tests/brief.test.js` (the `XERK-2857` cases).

## The Calendar view (`calendar.js`, XERK-2897)

- **Two views, one page**: `brief.html` shows a Calendar / Notes review switch; the pick is per
  viewer in `localStorage` (`turma-meetings-view`, guarded), Calendar by default. A `?site=` link
  (the proposals push) opens Notes review. The hidden view's keys are inert (`offsetParent`).
- **`calendar.js` reads its own routes** (`/api/calendar` per Sunday–Saturday week, prefetching the
  weeks either side; `/api/holidays` for the same days). The org pick is part of the cache key
  (`<orgs>|<week>`); a read keeps the pick it started with.
- **What re-reads it** (each a QA finding): `calendar`, `holidaySettings` AND `meetingProposals`
  frames (a Tenir-only capture is announced only by the last), coalesced 1s (`calendarSoon`); a
  stream reconnect; a 60s poll while the stream is down.
  - An `agent` frame whose `online` FLIPS (XERK-2921): a host going offline sends no calendar
    frame. Only a flip, never every beat (one read per beat per host otherwise).
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
- **An end in the SECOND pass of the repeated fall-back hour moves down by that hour** (XERK-2930):
  on the wall clock 1:30 EDT – 1:30 EST reads zero long. Only an end inside the repeated hour moves
  (offset an hour earlier differs); an end past it (9:00 EST) keeps its row, and `end < top` alone
  misses equal/later wall ends. The grid stays wall-clock so 9:00 is row 18. Labels name both
  zones (`calendar.js`/`meetings.js` `fmtSpan`, Android `calSpan`/`calSpanLong`).
- **Teams decisions** (researched on Microsoft's "Manage your calendar in Teams" / new-calendar
  docs; recorded so a later change doesn't drift):
  - Work week (Mon–Fri) is the default; Week is Mon–Sun; ‹ › move a week; Today; the range label
    opens a mini-month (month ‹ ›, year « »). Narrow (<760px): Day / 3 days, arrows + swipe.
  - **The calendar fills the page** (XERK-2937): a flex chain down to `.cal-scroll`, never a
    `100vh - N` guess (a wrapped notice broke it). The Calendar view alone widens to `--wrap-board`.
    Every top/height goes through `slots()`, never px: `--slot` is sized by CSS on the
    `container-type: size` pane, so JS cannot know it.
  - **Zoom = how many hours fill the pane** (XERK-2954): `--hours` on `.cal-body` (steps `ZOOMS`
    24…4, default 10 = 8 AM–6 PM), `--slot: max(10px, 100cqh / (hours × 2))`. − / + in the bar
    (`aria-disabled` at the ends), Ctrl/⌘+wheel over the grid (a trackpad pinch); kept per viewer
    (`turma-calendar-zoom`). A zoom holds the pane's middle minute (`zoomAnchor`).
    - **Any other pane-height change holds the TOP minute** (`holdTop`/`topMin`, run by `refit`
      after every paint and on resize; the operator's scroll moves it): rows follow the pane, so
      the loading notice leaving opened the day at 7:34, not 8:00 (QA). Android does the same.
    - **Scroll math reads the drawn row height back** (`pxPerMin` = `scrollHeight / 1440`), never
      `SLOT_PX` — that is only the no-cqh fallback (10h). A fake scroller in tests has no height.
  - 30-min rows, working hours 9–17 shaded white, the grid opens with 8:00 at the top, a red
    now-line with a dot on today, today's header in the accent with a top bar.
  - Events: a 22% tint of the org color with a 4px solid left bar. The hub gives every event its
    host's org (XERK-2964; the panel shows it as text, never a picker); neutral only for a host in no org;
    overlaps share the width and widen into free columns to the right (`layoutDay`).
  - Tentative / not responded = hatched; free / declined = outlined; canceled = "Canceled: " +
    strikethrough (kept, as Teams keeps them); past = dimmed; Tenir-only (`source:"tenir"`) = a
    caption glyph. All-day and ≥24h events ride the all-day band, one chip per day (Teams draws a
    spanning bar; not worth the layout here).
  - Holidays sit in the all-day band; a day off for an org in view (`offFor` ∩ header pick) is
    hatched grey with "Day off · <org>".
- **Outlook events are read-only; Turma events are made here** (XERK-2971). A click on an event
  opens the detail panel (XERK-2898); nothing drags an event.
- Keyboard: events are buttons in day order; ↑/↓ within a day, ←/→ to the nearest event of the
  next day, Esc closes the picker / panel. Every event carries an aria-label sentence.
- **Esc listens on the document** (so it works after a click elsewhere) and yields to a SHOWN
  modal (`MODAL_OPEN`) or an Esc already `defaultPrevented`. Never test a modal's mere presence:
  `#createPanel[aria-modal]` stays in the DOM while hidden (QA).
- Every served string is escaped (subject, location, organizer, device, error, holiday, org);
  a join link is rebuilt only from an `https://` URL (`safeHttps`); an org color is inlined only
  as `var(--sN)` (`safeColor`).
- Android ports it in `ui/CalendarScreen.kt` (XERK-2900, `android.md`). Tests: `turma/tests/calendar.test.js`, the
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
- **The panel wears its event's org tint** (XERK-2939): `--org` set on the aside from the event's
  ASSIGNED org (`safeColor`, the grid block's own); unassigned = plain.
  - **The tint is EXACTLY the session card's** (operator's rule): web 12% `color-mix` like
    `.kanban-card`/`sessions.html`; Android `orgCardColor`, the one `TurmaCard` uses.
  - **Every text token is pulled halfway to ink inside the panel** (`--muted`, `--*-text`, read
    from `--cal-*` captured on `.cal`; Android `calOnTint` over primary/onSurfaceVariant/status,
    and `MeetingPart(textOn=)` for the capture's own status lines). On the plain token, muted fell
    to 2.4:1, critical to 3.2:1 and the decision chip to 2.8:1 on a light tint (QA). A new text
    colour in the panel needs the same treatment. Tests: `CalendarPanelTintTest`.
- **A Turma-made event's panel wears its block's blue → purple instead** (XERK-3023, `.cal-detail.turma`,
  set in `paintDetail`): white text, every panel text token re-pointed light. The gradient is the
  block's own (`.cal-ev.turma`), pinned equal by test. Tests: `XERK-3023:` in `calendar.test.js`.
- **An event counts for the org the hub's matcher reads** (`eventOrg` = the served `matchOrg`;
  an older hub: assigned org, else the host's): for the daily brief and relink candidates (QA:
  another org's unassigned event was offered).
- `advanceFrom` resets the NOTES cursor: while a panel is open that is `panel.listCur`, never the
  live `curItem` (QA: a notes answer landing mid-panel made the next R hit the wrong proposal).
- One org's captures per panel (the first linked capture's site); a daily event (an Outlook event
  within 20 min of an org's daily `meetingAt`) shows that entry's brief via `hooks.briefHtml`.
  `brief.html` listens for the brief's buttons on `#calendarView` too.
- "Moved from …" is read off the occurrence id (`<GlobalAppointmentID>:<original start>`,
  `originalStart`), or a Tenir entry's `moved`; Canceled from `canceled`.
- **Relink** posts `POST .../meetings/<mid>/calendar` (`relink`): candidates are same-day,
  uncanceled, timed Outlook events of the capture's org; Unlink = `{eventId:null}`;
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

## Turma-made events (XERK-2971)

- Wire: `contract-calendar-turma.md`. The web half is all in `calendar.js`.
- **Create**: "+ New event" in the bar, or a click/drag on an empty grid slot (30-min rows,
  `slotMinAt`); a TOUCH that moved >10px is a swipe, never a create. The header's org pick
  (∩ pickable orgs) pre-fills the orgs; a lone org is picked for you.
- **The editor is a `.td-backdrop` modal** (`role=dialog aria-modal`, so `trapModalTab` traps
  Tab and the calendar's own Esc yields): Esc / ✕ / Cancel / backdrop close it, full screen under
  760px. Field values live in `ed.f` (read on input), so a repaint never loses a draft; repaints go
  through `focusKeyIn`/`restoreFocusIn`.
- **Validation mirrors the hub before it refuses** (`validateForm`): ≥1 pickable org (≤20), the
  hub's `CAL_EMAIL_RE` (`EMAIL_RE`, keep the two in step), https join link, code-point lengths,
  end ≥ start. A typed attendee commits on Enter / comma / Save.
- **Times are the creator's wall clock in the picked zone** (`wallToIso`, default the browser's):
  the ISO carries that zone's offset; a skipped DST time lands on a real instant. All-day = local
  midnight to the midnight after the last day (end date shown inclusive).
- **Edit/Delete only when `source === "turma" && editable === true`**; Outlook panels are
  unchanged. Delete asks first. A PATCH carries `version`; a 409 shows the hub's words and
  RELOADS the form from the `event` it sends (the draft is dropped, as the hub says to redo it).
- No optimistic paint: every write refetches, and the hub's `calendar` frame re-reads too. A saved
  event that leaves every filtered org closes its panel; a Turma event gone from its own shown week
  (deleted elsewhere) closes it on the next read.
- **Look** (operator's pick): every Turma event fills with the Turma icon's blue → purple
  (`favicon.svg`'s lit "T", white text); its left bar is its org color, split top-to-bottom into
  each org's color for a multi-org event (`orgBarHtml`, `safeColor` slots only). It renders ONCE
  (keyed `"" + id`); the hub's `?org=` filter already matches any of its orgs.
- **A multi-org event counts for EVERY org it is in** (`evOrgs`): the notes review's `upcoming`
  and relink candidates, not just `org` (= `orgs[0]`).
- **A typed field's `change` never repaints or writes** (QA): it fires on blur, and a repaint then
  detaches the button the mouse is pressing, so the browser drops the click (Save did nothing).
  It also fires when a repaint removes the focused attendee input, carrying the text a comma just
  committed. `input` owns typed drafts; only checkboxes (their change follows their own click)
  repaint. Unit tests can't see this ordering: drive a real mouse (`fill()` hides it).
- A skipped DST time takes the offset BEFORE the switch, a repeated one its first pass, east of UTC
  too (`wallToIso` tries the offsets a day either side).
- **Repeat (XERK-2973)**: a Teams-style preset menu named for the start day, Custom (interval +
  unit + days / month mode), Ends never / on date / after N, and a one-line summary.
  - Rule ⇄ control is calendar.js's repeat block; Android's `core/CalendarRepeat.kt` is its port.
    Both read `turma/tests/fixtures/calendar-repeat-vectors.json`: add a vector there, never to one side.
  - An implicit day stays implicit (`byMonthDay`/`byWeekday` sent only when the rule named one or
    the mode asks for the nth weekday), so moving the series moves its day, as the hub intends.
  - Typed repeat fields (interval, until, count) update the summary IN PLACE, never by repaint
    (the change-on-blur rule above); selects and day boxes repaint.
- **An occurrence of a Turma series asks which events** (`isTurmaOccurrence`, `scopeAsk`): Edit and
  Delete each offer This event / This and following / All events and send `scope` (PATCH body,
  DELETE `?scope=`) to the OCCURRENCE id; the series' `version` rides along.
  - **A scoped edit sends ONLY the fields that changed** (`scopedBody`, Android `calScopedPayload`;
    start/end together; nothing changed = nothing sent). Never resend the whole form there (QA):
    a resent rule re-grew a count and dropped the hub's month-end day on "This and following", a
    resent start dragged the series, and "This event" pinned every field into its override.
  - Every scoped editor reads the repeat off the series' first day (`seriesStart` → `f.seriesDate`,
    `repDay`), never the opened occurrence's (a clamped Apr 30 or a moved Wednesday). A date MOVE
    re-anchors it as the hub does: "following" on the new day, "All events" shifted by the move.
    A "following" until may not end before the split (`splitDay`).
  - A rule sent for "following" is the SERIES' rule as changed; the hub re-anchors it at the split
    (implicit month day pinned; a count series' count is the whole run's, and the editor says
    "in the whole series", `wholeCount`) — `contract-calendar-turma.md`.
  - "This event" disables the orgs and zone (with a note) and sends no `recurrence`: the hub refuses
    an occurrence's own rule, orgs or zone.
- **Invitations (XERK-2989)**: one "Send invitations from Outlook" switch, its two options only
  when on, disabled for "This event"; the panel's Invitations row names the sending org and
  tallies the served answers (`invitesText`; Android `calInvitesText`). Wire:
  `contract-calendar-outlook-write.md`.
- **Every repeating event wears `RECUR_SVG`** (Outlook's circling arrows) beside its title and in
  the panel's Repeats row; a Turma series' row reads its summary (`evAnchorYmd`: the original day).
- Tests: the `XERK-2971:` and `XERK-2973:` cases in `calendar.test.js`; Android `CalendarRepeatTest`.
