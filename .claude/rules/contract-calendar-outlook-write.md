---
paths:
  - "turma/server.js"
  - "turma/tenant-scope.js"
  - "turma/recurrence.js"
  - "turma/public/calendar*"
  - "turma/public/meetings.js"
  - "turma/tests/server.test.js"
  - "turma/tests/calendar.test.js"
  - "agent/hub-agent.py"
  - "agent/hooks/session_cli.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/test_session_cli.py"
  - "agent/tests/calendar_sync_fixture.json"
  - "agent/tests/calendar_write_fixture.json"
  - "android/app/src/main/java/**/Calendar*.kt"
---

# Turma events written to Outlook (epic XERK-2982; contract XERK-2983)

A Turma-created event (`contract-calendar-turma.md`) is written as an appointment
into the classic Outlook of ONE host per org in its `orgs`. Turma stays the source of truth; the
Outlook copy is a projection the hub keeps in step. Every child builds to this file; change it here
first. Children: agent writer XERK-2984, hub queue/state/dedup XERK-2985, recurrence XERK-2986,
client write state XERK-2987, reminders XERK-2988, invitations XERK-2989.

## The writer per org (hub)

- **An org's copy is written by ONE host**, because an Outlook event's org is its host's decided
  org (XERK-2964): a candidate is a host of the record's TENANT with `decidedOrgOf(a) === org`,
  online, reporting `calendar: {available: true, write: true}`.
  - `write` is a new strict boolean in `normalizeCalendarCapability` (absent = an older agent,
    which would ack and never answer: never a writer).
  - A host is decided into one org, so (host, turmaId) names at most one org's copy.
- **Sticky**: the host in `outlook[org].host` keeps the copy while it is a candidate or merely
  offline. A NEW pick (no holder, or re-homing) takes the candidate with no `calendar` `lastError`,
  then the smallest host key — deterministic, so two hub passes never pick two hosts.
- **Re-homing**: the holder goes away when it is removed from the registry, decided into another
  org (or none), stops reporting `write`, or has been offline `CALENDAR_WRITE_REHOME_MS` (2h; a
  beat's blip must not move a copy). Only then: a new holder gets an `upsert`, and the old copy
  becomes a TOMBSTONE for the old host.
  - Org loss is judged on `decidedOrgOf` held for the same 2h (a brief drift re-homes nothing).

## Tombstones: deleting a copy a record no longer names

- `/data/calendar-outlook-tombstones.json`, `registerExternalStore`, hostKey →
  `[{turmaId, org, outlookId, at}]`. Written when a copy is orphaned: the record deleted, its org
  dropped from `orgs` (also by the 24h org grace), or the copy re-homed.
- Each is sent as a `delete` command when that host is next online and reports `write`; removed
  on an ok row (or "not found", which is ok), which also drops that host's stored stamped copy:
  left, it named nothing and was served as an Outlook event until the next sync (QA). Kept `CALENDAR_HOST_RETAIN_MS` (30 days) at most,
  ≤`CALENDAR_TOMBSTONES_MAX` (1500) per host, oldest dropped first.
- A host key carries its tenant, so the store needs no tenant field; tenant purge drops a host's
  entries with the tenant (migration re-keys them like the event store).

## Hub → agent: the `writeCalendarEvent` command

- `{type:"writeCalendarEvent", op: "upsert"|"delete", turmaId, org, version, outlookId, event}`.
  - `org` is the PLAIN site (unscoped like every agent-bound siteKey, `turma-tenancy.md`).
  - `version` is the record's `version` at queue time; `outlookId` the copy's id or "" (none yet).
  - `event` (upsert only): the record's fields the mapping below needs, private ones already
    withheld (below), `recurrence` + `exceptions` included. Never `createdBy` or `orgs`.
- **At most one UNDELIVERED per (host, turmaId)**: a newer one replaces it in place (the
  `queueCalendarSync` splice). A delete replaces an undelivered upsert and vice versa.
- Queued only to a host reporting `calendar.write === true`; queued at the record write (create,
  PATCH of any scope, DELETE), on re-homing, on a repair (below) and on the holder's reconnect beat
  for every entry still `pending`/`failed`.
- **A sent-but-unanswered write is re-queued after `CALENDAR_WRITE_RESULT_MS` (10 min)**: an
  agent restart or a dropped outbox loses the row. Safe because the agent's upsert is idempotent.
- A `failed` entry retries hourly and on any record write; never a tight loop on a permanent error.

## Agent: the write (XERK-2984)

- Off the beat (XERK-395), on the calendar worker; one PowerShell run per batch of commands.
- **Find before create**: by `outlookId` (`GetItemFromID`), else by the stamp (a DASL filter on
  the `TurmaId` named property), else create. So a re-sent upsert never makes a second copy.
- **Stamp**: a `UserProperties` text property `TurmaId` = the turma id, added at create, re-checked
  at every upsert. **Never Categories**: they are visible and user-editable.
- **Only the sending copy sends** (XERK-2989, below); every other write is `Save()` only, and its
  delete is `Delete()` with no cancellation.
- `outlookId` = the item's `EntryID` (what `GetItemFromID` takes). The stamp is the fallback when
  a move between stores changes it.
- **An item counts as the copy only when its stamp IS the turmaId**, however it was found: a stale or
  wrong `outlookId` naming the user's own appointment never edits or deletes it.
- **No event text is ever part of the script**: the batch rides STDIN as base64 of UTF-8 JSON
  (`_CALENDAR_WRITE_PS`), typed and capped first by `prepare_calendar_write` (session CLI).
- **Times reach Outlook as INSTANTS** (StartUTC/EndUTC, after the Windows zone is set), never wall
  times: the repeated hour of a fall-back names two instants, and the drift check would then
  rewrite that copy forever. IANA → Windows is `windows_zone`: CLDR windowsZones + the tzdata
  `backward` links CLDR can place (Intl may say `Asia/Kolkata`, CLDR keeps `Asia/Calcutta`). A zone
  it lacks (a few links, `Factory`) is a failed row.
- An `outlookId` hit outside the default calendar (the user deleted it to Deleted Items) is no copy.
- **A command the CLI refuses never started PowerShell**, so it says nothing about Outlook: it
  never sets `calendar.write`, and one unreadable command never fails the rest of its batch.
- **Single events only** until XERK-2986: a non-null `recurrence` is a failed row in words, never a
  copy of the first instance. A non-sending copy carries no recipients.
- **After a write the worker owes a forced sync of the weeks it touched** (from the saved item's
  `StartUTC`, so a delete re-syncs the week its copy left); wider than 40 weeks → the default window.
- **`calendar.write` is true only while Outlook answered the last read or write**
  (`_cal_outlook_ok`; false before the first one): a closed Outlook stops the host being a writer.

## Agent → hub: the `calendarWriteResults` outbox

- A heartbeat results OUTBOX like `calendarSync`/`dailyBriefResults`: sent once, cleared when a
  beat carrying it was accepted; a `HEARTBEAT_KNOWN_KEYS` member deleted before the record is
  stored (never on `/api/agents`). ≤`CALENDAR_WRITE_ROWS_MAX` (50) rows a beat; past
  `CALENDAR_WRITE_OUTBOX_MAX` the oldest drop (the hub's result timeout re-sends them).
- Row: `{turmaId, org, version, op, ok, outlookId?, lastModified?, error?}`.
  - `outlookId` ≤300 and `lastModified` (the saved item's, ISO ≤40) on an ok upsert.
  - `error` in Outlook's own words, ≤300 code points, on `ok: false`.
- Accepted only from the host the entry (or tombstone) names, for that org; another host's row
  changes nothing. `org` must be PLAIN: a tenant-suffixed one is dropped.
- A private record's copy is withheld exactly like the served view, `categories` included.
- A row whose `version` is older than the entry's leaves the state as it is, but records an ok
  row's `outlookId` (the copy exists; a newer upsert is already queued).

## The record extension (`outlook` on the Turma record)

- `outlook: {<org>: {host, outlookId, version, state, error?, lastModified?, recreatedAt?, at}}`,
  after `version` in `sanitizeTurmaEvent`'s field order, so the coerce stays a FIXED POINT.
  - `state`: `pending` (owed or sent, no answer for this version) | `written` (an ok row for the
    record's version) | `failed` (`error` set).
  - An org the record does not name keeps NO entry: dropping it turns its copy into a tombstone
    at once (served state is per served org, so a `deleting` state would never be shown).
  - `at` = the last state change; `recreatedAt` = the last repair that re-created a missing copy.
- Hub-owned: route bodies cannot set it (dropped like `createdBy`), and a PATCH keeps it.
- **Served** on `GET /api/calendar` per Turma event as `outlook: {<org>: {state, noHost?, error?,
  recreatedAt?, at}}`, only for orgs in the served `orgs`; never `host` or `outlookId`. Clients
  (XERK-2987) show it per org; absent = an older hub. Android types it with defaults.
  - `noHost: true` = no host holds the copy (none of that org reports `write`); the entry stays
    `pending` until one does. Clients say "No Outlook host for this org", never "Writing…".
  - Clients render it per org on the event panel ("In Outlook" / "Writing…" / "Failed: <error>"),
    and mark the block when a copy is failed, or pending with a host; `noHost` does not mark it.
  - No retry route: a failed copy retries hourly and on the next edit, so clients offer no Retry.
- Byte caps (`CALENDAR_TURMA_BYTES_MAX`) do NOT count it (`calTurmaBytes`): it grows as copies are
  written, which must never turn a same-size edit into a 409. Its shape bounds it (≤20 short entries).

## Read-back dedup (hub ingest + serve)

- The reader reports `turmaId` on each event: the `TurmaId` property, kept only if it matches
  `^turma:[0-9a-f]{16}$`, else "". A new field of `sanitizeCalendarEvent` (fixed order, at the end).
- **The synced copy is STORED like any Outlook event** — so the authoritative-window delete, the
  budgets and eviction are unchanged.
- **It is hidden wherever Outlook events are read**: serving, the capture matcher's candidates and
  the Daily Brief skip an event whose `turmaId` names a live Turma record OR a tombstone of the
  host's own tenant. The Turma record (its occurrences) is served in its place.
  - Another tenant's id hides nothing: a stamp is never trusted across tenants.
  - A stamp naming nothing (a record gone and its tombstone settled) is served as Outlook.
- Recurring copies: every occurrence carries the series' stamp, so every one is hidden.

## Conflict policy: Turma wins

- **Drift**: on ingest, a stored copy whose `lastModified` is newer than the entry's, or whose
  `subject`, `startMs`, `endMs`, `allDay`, `location`, `busy` or `sensitivity` differ from what
  the record maps to (the withheld values for a private record), is re-written: an upsert at the
  record's version, state `pending`. Body, attendees and categories are not compared (Outlook
  reformats a body; the sending copy's recipients are its own).
  - **The sending copy's `lastModified` is not compared** (XERK-2989): every attendee answer
    Outlook tracks on it moves it, so each response would re-write the copy.
- **Missing**: a `written` single event whose start lies in a good sync row's window with no
  stamped event in that row was deleted by the user in Outlook. It is re-created (upsert with
  `outlookId: ""`) and `recreatedAt` is stamped, so the client can say "re-created in Outlook".
  A series: missing when the window holds an expected occurrence and no stamped one.
- **A row read at or before the copy's last change (`syncedAt <= at`) judges nothing**: it cannot
  show that write, so it read as missing/drifted and re-created a copy that existed (QA).
- **At most one repair per entry per `CALENDAR_WRITE_REPAIR_MIN_MS` (10 min)**, so an Outlook
  rule that keeps changing the copy cannot loop the hub and the agent.
- The authoritative window only says what Outlook holds; the hub never deletes a Turma record
  because its copy is missing.

## Field mapping (Turma record → AppointmentItem)

| Turma | Outlook |
|-------|---------|
| `subject` | `Subject` |
| `start`/`end` + `timeZone` | `StartTimeZone`/`EndTimeZone` = the IANA zone's Windows zone, then `StartInStartTimeZone`/`EndInEndTimeZone` = the wall times. A zone with no Windows id is a failed row in words. |
| `allDay` | `AllDayEvent` (end = the midnight after the last day, as stored) |
| `location` | `Location` |
| `body` | `Body` (plain text); a `joinUrl` is appended as its own last line `Join: <url>` |
| `busy` | `BusyStatus`: free 0, tentative 1, busy 2, outOfOffice 3, workingElsewhere 4 |
| `sensitivity` | `Sensitivity`: normal 0, personal 1, private 2, confidential 3 |
| `categories` | `Categories`, joined by the locale's list separator |
| `attendees` | the sending copy only: `Recipients` synced to them (`Type` olRequired 1 / olOptional 2), `MeetingStatus` olMeeting |
| `sendInvites`, `responseRequested`, `allowForward` | the sending copy only: `Send()`, `ResponseRequested`, `PidNameMeetingDoNotForward` |
| `recurrence` + `exceptions` | `GetRecurrencePattern()` + per-occurrence edit/delete (XERK-2986) |
| `isOnlineMeeting`, `createdBy`, `orgs`, `version` | not written |
| — | `ReminderSet = false` until XERK-2988 defines reminders |

- **A private/confidential record is written withheld**: `Subject` "Private event", no body,
  location or attendees, its `Sensitivity` and busy kept. The holder's mailbox owner is any user of
  that org, not the event's owner, so writing the real fields would leak them.
- Times round-trip: the reader's `start`/`end` of the copy must equal the record's instants (the
  drift check above relies on it).

## Hub mechanics (XERK-2985, `server.js` "Turma events written to Outlook")

- **One reconcile, `calOutlookReconcile`**, run at every record write (`calTurmaStore`, series
  DELETE, `calendarTurmaTick`'s org loss, via `calOutlookAfterWrite`), on a writer's reconnect
  beat (its tenant) and on the leader's `calendarOutlookTick` (≤ once a minute). Never add a
  second path that queues writes on its own.
- **Sent/repair/org-loss times are in memory** (`calWriteSent`, bounded): a restart re-sends every
  pending write once — safe only because the agent's upsert finds before it creates.
- At most `CALENDAR_WRITE_INFLIGHT_MAX` (50) undelivered writes per host; the rest wait a pass, so
  a reconnect with 1500 owed copies never floods `queueCommand` (it re-measures the record each call).
- Queued only to an ONLINE writer; an offline holder keeps its entry `pending` until it beats.
- Re-picking a host that holds a tombstone for the event takes the tombstone back and reuses its
  `outlookId`, so (host, turmaId) never has both a delete and an upsert owed.
- The command's `org` and a result's `org` are converted by hand (`baseOfSite` / `scopeSite`):
  the beat's `scopeSiteKeys` walk only rewrites fields named `siteKey`.
- Drift is compared for single events only; a series is checked for a MISSING occurrence
  (XERK-2986 owns writing series and comparing their occurrences).

## Invitations (XERK-2989)

- Record fields `sendInvites` (default false), `responseRequested`, `allowForward` (default true),
  after `isOnlineMeeting`. The event's, never an occurrence's: an occurrence PATCH changing one is a
  400 in words (resending the series' value is fine), and overrides never carry them.
- **Only `orgs[0]`'s copy sends** (operator decision): the command's `event.sendInvites` is true for
  that org alone, so an event in N orgs reaches an attendee once. The others are plain appointments.
  - Its holder's mailbox is the ORGANIZER the attendees see, not necessarily the event's creator.
  - `orgs[0]` changing (org dropped, 24h grace) cancels from the old copy (its tombstone delete)
    and sends afresh from the new one: attendees get a cancellation and a new invitation.
- **A private/confidential event sends nothing**: its attendees are withheld from every copy.
- Agent (`_CALENDAR_WRITE_PS`): the sending copy is `MeetingStatus` olMeeting with its recipients
  synced (the mailbox owner's own recipient kept); `Send()` runs only when `sentKey` (a hash of every
  sent field, `prepare_calendar_write`) differs from the copy's `TurmaSent` property, so a re-sent,
  re-delivered or repair upsert never mails the attendees again. A failed `Send()` clears the stamp
  and fails the row in Outlook's words (retried like any failed write).
  - A sent copy's delete, or an upsert no longer sending, is a CANCELLATION (`MeetingStatus` 5,
    `Send()`) then `Delete()`; the no-longer-sending upsert then writes a fresh plain copy.
  - Forwarding: `PidNameMeetingDoNotForward` (MS-OXOCAL 2.2.1.51, PS_PUBLIC_STRINGS `DoNotForward`)
    via `PropertyAccessor`; set TRUE only when forwarding is off (a failure then fails the row).
  - Unverified on a real Outlook (CI drives a fake object model): removed recipients' cancellation
    on `Send()`, and `PropertyAccessor` typing the named boolean. Spike them on a host.
- **Responses**: the reader already reports each recipient's `response`; `GET /api/calendar` serves
  them on the Turma event's `attendees[].response` from the SENDING copy's synced read-back (its
  holder's stored event stamped with the record's id; `calTurmaResponses`). `none` reads
  `notResponded` when responses were requested; `organizer`/`unknown` never ride. Single events only.
  Clients show them per attendee and tally them on an "Invitations" row.
- **Teams link: the pasted `joinUrl` stays.** The Teams Meeting add-in exposes no COM/object-model
  API; creating a Teams meeting means pressing its ribbon button in a displayed Inspector — UI
  automation on the user's desktop, which the off-beat writer must never do. Revisit only if
  Microsoft ships an object-model or Graph-free API for it.
- An agent predating XERK-2989 ignores `sendInvites` and writes a plain copy (no invitations, no
  responses); agents self-update, so no capability gate.

## Tests

- Hub: the `XERK-2985:` cases in `server.test.js`; agent: `TestCalendarWrite` (`test_hub_agent.py`,
  the `xerk2984` cases) and `CalendarWriteTest` (`test_session_cli.py`: the real script under `pwsh`
  against a fake Outlook object model, and `calendar_write_fixture.json`, a reply recorded from it);
  the reader's `turmaId` in `CalendarSyncReaderTest`. `XERK-2986:` cases for recurrence.
- Invitations: `XERK-2989:` in `server.test.js` and `calendar.test.js`; the `xerk2989` cases in
  `CalendarWriteTest`; Android `CalendarEventsTest`.
