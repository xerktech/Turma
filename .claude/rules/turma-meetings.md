---
paths:
  - "turma/public/meetings.html"
  - "turma/tests/meetings.test.js"
---

# The Meetings page (`/meetings`, XERK-2510)

The web surface of the Meetings epic (XERK-2503). The wire and the review route are in
`contract-meetings.md`; this file is the page's own rules.

- `/meetings` (nav `meetings`, after Brief) serves `meetings.html`, scoped by the header org pick;
  one block per org with meetings, one card per meeting, its proposals inside.
- **Nothing reaches the board unasked**: every create is the operator's Approve. A `decision`
  item offers "Log decision" (decisions log), never a ticket.
- **Approve needs a project + issue type, from the New-ticket routes** (`GET .../create-meta`,
  202-polled): the org's "New tickets go to" project (a lone project preselected, a pick kept per
  viewer in `localStorage`, guarded), the type by kind (`defaultType`: bug → a "Bug" type, else
  "Task"). Edit overrides title, description and type.
- **The default description carries where it came from** (`ticketDescription`): the proposal,
  the meeting title + date, each quote with its offset, the Tenir link — built client-side so the
  operator sees exactly what is sent when editing.
- A quote links to that moment as a media fragment on the meeting's link (`#t=<seconds>`);
  every link is rebuilt only from an http(s) URL (`safeUrl`), never served text.
- **Every served string is escaped** — model text, quotes, speaker, host, error, org name.
- A refusal shows in the hub's words, inline on the item and as the shared toast (XERK-264).
- Drafts live in `edits`; a repaint waits while a field has focus or a pointer is down (the
  Brief page's rule, `turma-daily-brief.md`). Buttons go `aria-disabled` while busy; `busy` is
  the guard.
- Live via the `meetingProposals` SSE frame (whole map); a snapshot fetch merges (XERK-444 clock).
- Web-only for now (`android/PARITY.md`).
- Tests: `turma/tests/meetings.test.js`.
