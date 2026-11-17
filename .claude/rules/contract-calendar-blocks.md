---
paths:
  - "turma/server.js"
  - "turma/tenant-scope.js"
  - "turma/public/calendar*"
  - "turma/public/brief.html"
  - "turma/tests/server.test.js"
  - "turma/tests/calendar.test.js"
  - "agent/hooks/session_cli.py"
  - "android/app/src/main/java/**/Calendar*.kt"
---

# Calendar blocks: an Outlook event blocks other orgs' calendars (XERK-3057)

An Outlook event of org A pushes an alias appointment ("Meeting alias", default "Blocked") into
the Outlook of each org B, C… the operator checks, and keeps it in step with the source.
Built entirely on the Turma-event writer (`contract-calendar-outlook-write.md`); no agent change.

## The rule and the record

- **The rule lives on the source HOST's settings** (`calendarHostSettings[host].blocks`, inline
  literals in `sanitizeCalendarHostSettings`): source key → `{orgs, alias, by, at}`, ≤200 a host.
  - Keyed by the event's `seriesId` when it has one, so a recurring event's rule covers its whole
    series; else its `id`. Purge, retention and migration ride the settings store (the migration
    re-keys the rule's orgs).
- **Each stored source occurrence gets ONE hidden Turma record** (`calBlockReconcile`), id
  `calBlockId(host, eventId)` (a sha256 → `turma:<16 hex>`, stable), carrying hub-internal
  `blockOf: {host, event}` (never served, never client-set).
  - subject = alias, `busy: outOfOffice`, no attendees/body/location, `sendInvites: false`:
    the writer's copy is a plain `Save()` with no recipients — **a block never mails anyone**.
    Never let a block record carry attendees or `sendInvites`.
  - Timed: `timeZone` UTC (the instants are what count). All-day: the offset's `Etc/GMT±N` zone
    (`calBlockZone`) so the day reads the same; a non-whole-hour offset falls back to UTC.
  - Orgs = the rule's orgs of the host's tenant, never the source's own org; an org no host is in
    stays on the record while it has it, so `calendarTurmaTick`'s 24h grace decides it.
- **The record follows its source**: re-timed/renamed in place (same id, next version); gone from
  the host's store (deleted, moved out, aged out) → `calTurmaRemove`, which tombstones every copy.
  An event that has ENDED gets no NEW block (a past series must not flood the caps).
- **A host in no decided org is left alone** (a brief drift must not delete every block).
- Reconciled on: the rule route, every applied `calendarSync` row, a host's decided-org change
  (`calendarOnBeat`), and every `calendarTick` (`calBlockTick`: every host with a rule or a block).
- Over the tenant's Turma caps a block is skipped and logged once, never a refusal of the sync.

## Hidden everywhere else

- `blockOf` records are skipped by `calendarTurmaView` (serving), `calendarCandidateIndex` +
  `calendarEventLookup` (capture links), `dailyBriefCalendar`, and `calTurmaFind` (the Turma
  PATCH/DELETE routes 404 them). Their Outlook copies are hidden on read by the stamp, like every
  Turma copy — "never pulled back into Turma". A new reader of `calendarTurmaEvents` must skip them.

## Route and wire

- `PUT /api/agents/<host>/calendar/blocks {eventId, orgs, alias?}` (`host` class): 404 a host the
  caller may not drive / an event the host does not hold (or a Turma copy); 409 a host in no org;
  orgs checked by `turmaEventOrgsError` (decided, the caller's, one tenant) and never the source's
  own (400). `orgs: []` clears the rule. Answers `{ok, blocks}`.
- `GET /api/calendar` serves an Outlook event a rule covers with `blocks: {orgs, alias, series,
  outlook?}`; `outlook` is `calOutlookWire` of the block record (absent before one exists).
- Web: the panel's "Block other calendars" (`blocksHtml`, checkboxes + alias, Save); the source
  keeps its org tint and gains a right bar of the blocked orgs' colors (`blockBarHtml`, palette
  slots only). Android: a `PARITY-open.md` gap.
- Tests: `XERK-3057:` in `server.test.js` and `calendar.test.js`.
