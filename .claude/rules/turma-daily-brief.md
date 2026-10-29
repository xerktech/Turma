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
- Run now and Save show a refusal in the hub's words, inline and as the shared toast (XERK-264).
- Every served string is escaped (model text, host, model, error, org name, site key).
- Live via the `dailyBriefs` / `dailyBriefSchedules` SSE frames (whole maps); a snapshot fetch
  merges, never replaces (XERK-444 clocks).
- Web-only for now (`android/PARITY.md`).
- Tests: `turma/tests/brief.test.js`; the `/brief` case in `server.test.js` (XERK-2386 test).
