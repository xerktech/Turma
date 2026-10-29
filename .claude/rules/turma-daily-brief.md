---
paths:
  - "turma/public/brief.html"
  - "turma/tests/brief.test.js"
---

# The Daily Brief page (`/brief`, XERK-2396)

The web surface of the Daily Brief (epic XERK-2390). The wire it reads is
`contract-daily-brief.md`; this file is the page's own rules.

- `/brief` (nav `brief`, after Board) serves `brief.html`. The URL was the retired org brief's
  (XERK-2386), so an old bookmark lands here.
- Scoped by the header org pick (`TurmaOrg.getKeys()`); one card per org that a host is decided
  into (agents' served `org`) or that still has briefs.
- **Three sections, not four**: the wire's `day` already joins "Since yesterday" + "Still open",
  and `next` already reads "Nothing is queued next." for an empty list. Never split or special-case
  them here.
- The shown brief is the newest `ok` row; a newer `running`/`failed` row is the status line above
  it, so a run in flight never hides the last brief. Every other row is "Earlier briefs"
  (`headline`, or `error` for a failed one).
- **The next run comes from the hub** (`GET .../daily-brief/schedule`'s `next`), never computed
  here: DST and the lead window are `nextDailyBriefRun`'s. Refetched when an org's schedule
  changes (`nextFor` keyed on the schedule JSON) and once its `runAt` has passed.
- The schedule editor hides behind the gear beside the org name (operator's call), for live orgs
  only (the routes 404 any other).
  - Edits are a per-org draft (`drafts`), so an SSE repaint never loses one; Save PUTs the whole
    schedule and the hub validates it. A refusal keeps the draft and shows the hub's words.
  - **A repaint waits while a form field has focus** (`editing()`, flushed on `focusout`): a
    swap closes a native `<select>` popup and drops a half-typed time.
  - **A repaint also waits out a pointer press in the list** (`pointerDown`, released on window
    `pointerup`/`pointercancel`): a swap between mousedown and mouseup dispatches no click, so the
    first Save after a select/checkbox change was lost (QA). Same trap as the dashboard's.
  - The press is released on `contextmenu` and the WINDOW's `blur` too, so a lost pointerup
    never holds every paint. **Never a capture `blur`**: it fires for the field the press itself
    blurs and swapped the list mid-press (QA).
  - Save and Run now go `aria-disabled` while busy/running, never `disabled`: a disabled button
    drops keyboard focus to `<body>`. So `schedBusy` / `runBusy` + `orgRunning` are the ONLY
    thing refusing a second press — never drop those guards.
  - The gear and Discard paint with `force` at the click; every repaint gives focus back to the
    button/field it was on. `force` never overrides a pointer press.
  - **Busy state and a save's error go straight onto the controls** (`patchSave`/`patchRun`),
    never only through a repaint. A forced repaint on the hub's answer dropped a half-typed time;
    a held one left Save "Saving…" and disabled, swallowing the next click (QA, both).
- **A failed next-run lookup backs off** (`NEXT_RETRY_MS`): retried at once, every repaint re-asked
  it — ~230 requests/s per tab against a dead hub (QA).
- Run now and Save show a refusal in the hub's words, inline and as the shared toast (XERK-264).
  - A Run now refusal stands only while the org's newest `runId` is the one it was answered
    against: a stale "try again in 59s" otherwise hid a run started elsewhere.
- **Every lookup by site goes through `own()`**: an org named `__proto__` read `Object.prototype`
  as its schedule and threw (XERK-1451).
- Every served string is escaped (model text, host, model, error, org name, site key).
- Live via the `dailyBriefs` / `dailyBriefSchedules` SSE frames (whole maps); a snapshot fetch
  merges, never replaces (XERK-444 clocks).
- Android's Brief tab (XERK-2397) is its counterpart, minus schedule editing (web-only,
  `android/PARITY.md`); a change to what a reader sees here goes to `BriefScreen.kt` too.
- Tests: `turma/tests/brief.test.js`; the `/brief` case in `server.test.js` (XERK-2386 test).
