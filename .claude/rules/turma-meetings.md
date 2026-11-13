---
paths:
  - "turma/public/meetings.js"
  - "turma/public/brief.html"
  - "turma/tests/meetings.test.js"
  - "turma/tests/brief.test.js"
---

# The meetings triage (Brief page, XERK-2510, XERK-2623, XERK-2857)

The web surface of the Meetings epic (XERK-2503). The wire, the review/archive routes and the
`daily` pairing are in `contract-meetings.md`; this file is the triage's own rules.

## Layout

- **One pane, not tabs** (XERK-2857, operator's pick from mockups): `brief.html` mounts
  `meetings.js` once on `#meetingList`; it paints a rail + main pane + per-org settings drawer.
  - `#brief`, `#meetings` and `/meetings` (302 → `/brief<query>#meetings`) all land on it.
  - Nav label stays "Brief".
- Rail: one group per org (the header org pick scopes it), collapsible; the collapsed set is per
  viewer in `localStorage` (`turma-meetings-collapsed`), every access guarded.
  - Entries bucketed Upcoming / Today / Yesterday / This week / Earlier, newest first.
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
- Tests: `turma/tests/meetings.test.js`, `turma/tests/brief.test.js` (the `XERK-2857` cases).
