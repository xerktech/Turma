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
- **Each stored source occurrence gets ONE hidden Turma record** (`calBlockReconcile`), carrying
  hub-internal `blockOf: {host, event}` (never served, never client-set), found by that pair
  (`calBlockIndex`), never by id.
  - A NEW block's id is `calBlockId(host, eventId)`; an existing one KEEPS its id when its host key
    moves (the tenant migration re-keys `blockOf.host`): the Outlook copies are stamped with the
    id, and a new id would orphan them and write a second copy.
  - subject = alias, `busy: outOfOffice`, no attendees/body/location, `sendInvites: false`:
    the writer's copy is a plain `Save()` with no recipients — **a block never mails anyone**.
    Never let a block record carry attendees or `sendInvites`.
  - Times in UTC (`calBlockTimes`). An all-day source keeps its DATE, written as UTC midnights:
    Outlook gives only an offset, and no IANA zone names +05:30 & co. (an instant-based copy
    landed a day early there, QA).
  - Orgs = the rule's orgs of the host's tenant, never the source's own org; an org no host is in
    stays on the record while it has it, so `calendarTurmaTick`'s 24h grace decides it.
- **The record follows its source**: re-timed/renamed in place (same id, next version); gone from
  the host's store (deleted, moved out, aged out) → removed, every copy tombstoned.
  - A stray second record for one (host, event) is removed too (`calBlockIndex` dups).
  An event that has ENDED gets no NEW block (a past series must not flood the caps).
- **A host in no decided org is left alone** (a brief drift must not delete every block).
- Reconciled on: the rule route, every applied `calendarSync` row, a host's decided-org change
  (`calendarOnBeat`), and every `calendarTick` (`calBlockTick`: every host with a rule or a block).
- **Blocks have their OWN cap** (`CAL_BLOCK_RECORDS_MAX`, 1500 a tenant) and never count toward
  the user's Turma-event caps (`turmaEventCapError` skips them): hidden records that 409'd a
  user's event left nothing visible to delete (QA). The store coerce slices at both caps together.
  - Past the cap a NEW block is skipped, and the source is served `blocks.full` so its panel says
    "Not written", never silent. Logged once per full run.
- **One reconcile is ONE persist/broadcast/relink**: per-record `calTurmaStore` calls were O(n²)
  (seconds of event loop at 1000 blocks, QA). Writes go through `calOutlookAfterWrite` directly.
  - Its tombstones are batched too (`calTombstoneBatch`: one persist, one flush per host): a
    persist per tombstone made clearing 1500 blocks take seconds (QA).
  - The "full" note is per HOST (`calBlockFull`): per tenant, any other host's reconcile cleared it.

## Hidden everywhere else

- `blockOf` records are skipped by `calendarTurmaView` (serving), `calendarCandidateIndex` +
  `calendarEventLookup` (capture links), `dailyBriefCalendar`, and `calTurmaFind` (the Turma
  PATCH/DELETE routes 404 them). Their Outlook copies are hidden on read by the stamp, like every
  Turma copy — "never pulled back into Turma". A new reader of `calendarTurmaEvents` must skip them.

## Route and wire

- `PUT /api/agents/<host>/calendar/blocks {eventId, orgs, alias?}` (`host` class): 404 a host the
  caller may not drive / an event the host does not hold (or a Turma copy); 409 a host in no org;
  orgs ADDED to the rule are checked by `turmaEventOrgsError` (decided, the caller's, one tenant);
  an org the rule already has may be one no host is in now, so the rest stays editable. Never the
  source's own org (400). `orgs: []` clears the rule. Answers `{ok, blocks}`.
- `GET /api/calendar` serves an Outlook event a rule covers with `blocks: {orgs, alias, series,
  outlook?, full?}`; `outlook` is `calOutlookWire` of the block record (absent before one exists).
- Web: the panel's "Block other calendars" (`blocksHtml`, checkboxes + alias, Save); the source
  keeps its org tint and gains a right bar of the blocked orgs' colors (`blockBarHtml`, palette
  slots only). Android: a `PARITY-open.md` gap.
- Tests: `XERK-3057:` in `server.test.js`, `calendar.test.js`; the block case in `tenant-migration.test.js`.
