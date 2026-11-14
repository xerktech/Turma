---
paths:
  - "turma/public/brief.html"
  - "turma/tests/brief.test.js"
---

<!-- The page's triage layout (rail, entries, drawer) is meetings.js: `turma-meetings.md`. -->
# The Daily Brief page (`/brief`, XERK-2396, XERK-2857)

The web surface of the Daily Brief (epic XERK-2390). The wire it reads is
`contract-daily-brief.md`; this file is the brief's own rules on the page.

- `/brief` (nav `brief`, after Board) serves `brief.html`. The URL was the retired org brief's
  (XERK-2386), so an old bookmark lands here.
- **The page is one triage painted by `meetings.js`** (XERK-2857); `brief.html` owns the snapshot,
  the SSE and the brief's state, and hands the triage hooks: `briefHtml(site, entry)` (the brief
  block of a daily entry), `scheduleHtml(site)` (the drawer's editor), `nextOf`, `focusKey` /
  `restoreFocus`, `now`. `renderBriefs` only syncs the next-run lookups and calls `update`.
- **Three sections, not four**: the wire's `day` already joins "Since yesterday" + "Still open",
  and `next` already reads "Nothing is queued next." for an empty list. Never split or special-case
  them here.
- A daily entry shows the newest `ok` row for its meetingAt; a newer `running`/`failed` row is the
  status line above it, so a run in flight never hides the last brief. A current entry reads the
  org's newest row for "Writing…" (a run lands wherever its meetingAt says).
  - Earlier briefs are their own rail entries (All filter), not a list in the card.
- **The next run comes from the hub** (`GET .../daily-brief/schedule`'s `next`), never computed
  here: DST and the lead window are `nextDailyBriefRun`'s. Refetched when an org's schedule
  changes (`nextFor` keyed on the schedule JSON) and once its `runAt` has passed.
- **A failed next-run lookup backs off** (`NEXT_RETRY_MS`): retried at once, every repaint re-asked
  it — ~230 requests/s per tab against a dead hub (QA).
- The schedule editor is in the org's settings drawer (⚙ on the rail), live orgs only (the routes
  404 any other). It carries "Daily meeting title contains" (`meetingTitle`, XERK-2856); an older
  hub ignores the field.
  - Edits are a per-org draft (`drafts`), so a repaint never loses one; Save PUTs the whole
    schedule and the hub validates it. A refusal keeps the draft and shows the hub's words.
  - **Repaints wait while a field has focus or a pointer is pressed** — meetings.js's hold, which
    covers this page's controls: a swap closes a native `<select>`, drops a half-typed time, or
    eats the click between mousedown and mouseup (QA). A checkbox/select change owes a repaint
    (`TurmaMeetings.hold()`), painted once focus leaves.
  - Save and Run now go `aria-disabled` while busy/running, never `disabled`: a disabled button
    drops keyboard focus to `<body>`. So `schedBusy` / `runBusy` + `orgRunning` are the ONLY
    thing refusing a second press — never drop those guards.
  - Discard paints with `force`; every repaint gives focus back to the button/field it was on.
  - **Busy state and a save's error go straight onto the controls** (`patchSave`/`patchRun`, then
    `TurmaMeetings.invalidate()`), never only through a repaint: a forced repaint on the hub's
    answer dropped a half-typed time; a held one left Save "Saving…" and swallowed the next click.
- Run now and Save show a refusal in the hub's words, inline and as the shared toast (XERK-264).
  - A Run now refusal stands only while the org's newest `runId` is the one it was answered
    against: a stale "try again in 59s" otherwise hid a run started elsewhere.
- **Every lookup by site goes through `own()`**, and a write defines the key: an org named
  `__proto__` read `Object.prototype` as its schedule and threw (XERK-1451).
- Every served string is escaped (model text, host, model, error, org name, site key, title).
- Live via the `dailyBriefs` / `dailyBriefSchedules` / `meetingProposals` / label / focus SSE
  frames (whole maps); a snapshot fetch merges, never replaces (XERK-444 clocks, one per map).
- Android's Brief tab (XERK-2858) is its counterpart, triage and two-pane wide layout included
  (`android/PARITY.md`); a change to what a reader sees here goes to `BriefScreen.kt` too.
- Tests: `turma/tests/brief.test.js`; the `/brief` case in `server.test.js` (XERK-2386 test).
