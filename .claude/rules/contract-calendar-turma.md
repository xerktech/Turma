---
paths:
  - "turma/server.js"
  - "turma/tenant-scope.js"
  - "turma/holidays.js"
  - "turma/recurrence.js"
  - "turma/tests/recurrence.test.js"
  - "turma/public/meetings.js"
  - "agent/hub-agent.py"
  - "agent/hooks/session_cli.py"
  - "turma/public/calendar*"
  - "turma/tests/server.test.js"
  - "turma/tests/holidays.test.js"
  - "turma/tests/calendar.test.js"
  - "turma/public/brief.html"
  - "turma/tenant-migration.js"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/test_session_cli.py"
  - "agent/tests/calendar_sync_fixture.json"
  - "android/app/src/main/java/**/Calendar*.kt"
---

# Turma-created calendar events (epic XERK-2967)

Split out of `contract-calendar.md` (size cap); that file holds the Outlook sync, the event
whitelist and the Tenir matcher this builds on.

## Turma-created events (hub, epic XERK-2967; store + routes XERK-2968)

Events made IN Turma, owned by the hub. Every child of the epic
(recurrence XERK-2969, matching + brief XERK-2970, web XERK-2971, Android XERK-2972) builds here.
- **Written to each org's Outlook by one host of that org** (epic XERK-2982): writer pick,
  `writeCalendarEvent`, `calendarWriteResults`, the `outlook` record field, read-back dedup and the
  field mapping → `contract-calendar-outlook-write.md`.
- **Store**: `/data/calendar-turma-events.json` (`CALENDAR_TURMA_EVENTS_FILE`),
  `registerExternalStore`, tenant id ("" = untenanted) → eventId → record. Keyed by TENANT, not
  host or org: one event may belong to several orgs of one tenant.
- **Id `turma:<16 hex>`**, minted by the hub: an Outlook GlobalAppointmentID never starts so.
  An id without the `turma:` prefix on these routes is a 400 "Outlook events are read-only";
  a `turma:` id the caller's tenants do not hold (malformed included) is a 404.
- **Record** (`sanitizeTurmaEvent`, the ONE whitelist: routes, boot restore, HA watch; field
  order fixed, a coerce FIXED POINT): `{id, orgs[], subject, start, end, startMs, endMs,
  timeZone, allDay, location, body, attendees[], joinUrl, isOnlineMeeting, sendInvites,
  responseRequested, allowForward, busy, categories, sensitivity, reminderMinutes, recurrence, exceptions,
  createdBy, createdAt, updatedAt, version, outlook}` (the three invitation flags: XERK-2989).
  - Text, `start`/`end` (ISO WITH offset), `body` (`CALENDAR_BODY_MAX`), `joinUrl` (https only),
    `categories`, `sensitivity` and attendee `name`/`email` follow `sanitizeCalendarEvent`'s rules.
  - A category name with `,` or `;` is a 400 (XERK-3013): Outlook's Categories is one
    separator-joined string, so the copy would split it. Both editors refuse `;` (`,` separates).
  - `orgs` 1..`CALENDAR_TURMA_ORGS_MAX` (20) org keys, all of the record's tenant; none = no record.
  - `timeZone` an IANA zone the hub's Intl knows (≤64, else "UTC"): the wall clock the creator
    meant, which a recurrence needs; `start`/`end` alone fix the instant.
  - Attendee `role` is `required|optional` only (the creator is the organizer); no stored
    `response` (served from the sending copy, XERK-2989).
  - `busy` free|tentative|busy|outOfOffice|workingElsewhere (default busy).
  - `reminderMinutes` (XERK-2988): null (none, the default and an older record's) or one of
    `CAL_TURMA_REMINDERS` (0, 5, 15, 30, 60, 120, 720, 1440, 10080); anything else is a 400.
    A NEW event defaults to none (web `REMINDER_DEFAULT`, Android `CAL_REMINDER_DEFAULT`): it
    fires in the writer host's Outlook, whose owner may be neither creator nor attendee;
    the three lists (hub, `calendar.js` `REMINDERS`, `CAL_REMINDERS`) move together, plus the
    agent's `CALENDAR_REMINDER_MINUTES`. An occurrence may override it like any client field.
  - `recurrence`: a rule (below) or `null` for a single event; `exceptions` its per-occurrence edits.
  - `createdBy`: the creating principal (`user:<id>`, or its kind for open/legacy/break-glass).
    Stored only, never served (`turmaEventWire` drops it): it named the creator's hub user id to
    every org viewer, a withheld private event's too, and no client reads it (XERK-2953).
  - `version` starts at 1 and every write bumps it.
- **Caps, refused with a 409 in the hub's words, never a silent drop**: ≤`CALENDAR_TURMA_EVENTS_MAX`
  (1500) events and ≤`CALENDAR_TURMA_BYTES_MAX` (2 MiB of JSON) per tenant — the Outlook
  store's budget class (a host's 1500 / 1.5 MiB).

## Turma-created events: routes and serving

- Operator-authed (`filtered` class: the handler scopes by org), JSON body ≤64 KiB
  (`CALENDAR_TURMA_BODY_MAX`; over it a 413 `{error, limit}`, over the hub's memory budget a 503):
  - `POST /api/calendar/events {orgs, subject, start, end, timeZone?, ...}` → `{ok, event}`.
  - `PATCH /api/calendar/events/<id> {version, orgs?, fields...}` → `{ok, event}`; a `version`
    other than the stored one is a 409 carrying the current `event` (optimistic concurrency).
  - `DELETE /api/calendar/events/<id>` → `{ok}`.
- **The caller must pass `principalMaySite` for EVERY org in the body AND every org on the stored
  event**, so nobody strips an org they cannot see. Today that check is the tenant boundary
  (`principalMaySite`), and a record's orgs are all one tenant's. An org no host is decided into, or one the
  caller may not see, is a 404 (never says which tenant holds it); `orgs: []` is a 400 (an event
  must belong to an org); an id the caller's tenants do not hold is a 404.
- Malformed fields are a 400 naming the field, never coerced into a different event: `start`/`end`
  must parse with an offset and be after 1970 (GET ranges are epoch ms > 0, `calMs`: an earlier
  event was stored but never served, so nobody could reach it; XERK-2953), `end ≥ start`, `orgs` must not repeat an org, a given `timeZone` must be a known zone, a given
  `joinUrl` https, `busy`/`sensitivity` from their enums.
- **Served on `GET /api/calendar`** beside the Outlook events, each ONCE (not per org):
  `{source:"turma", host:"", ...record, orgs, org: orgs[0], editable, meeting}`.
  - `orgs` served = the stored ones still decided in the record's tenant; none left = not served.
  - `org = orgs[0]` keeps older clients' colour; the `?org=` filter matches when ANY of `orgs` is in it.
  - `editable` = the caller passes the route check above; `meeting` = `calendarLinkCandidate`.
  - `meetings` (XERK-2970): its linked captures, exactly as on an Outlook event; their own
    Turma-only entries are dropped. No `matchOrg`: it counts for every org in `orgs`.
  - Beside a linked capture (`meetingWire`'s `calendarEvent`) it is `host: ""`, `org` = the
    capture's org; a private/confidential one is withheld there for EVERY viewer, its creator too
    (the meetings frame has no principal).
  - Only events of tenants the caller may see (`principalMaySite` on the record's orgs).
  - A private/confidential event is withheld exactly like an Outlook one for every viewer but its
    creator (`createdBy`), and only the creator may PATCH/DELETE it (409 otherwise; served
    `editable:false`): a client saving the blanked fields back wiped the event (XERK-2972 QA).
    - One no USER made (break-glass/legacy/open, moved in by the tenant migration) is owned by
      that tenant's user (`calTurmaOwner`), or nobody could ever change or delete it.
    - So is one whose creator `user:<id>` is gone or of another tenant (XERK-2978); untenanted,
      any admin-role principal owns it (not `legacy`). A disabled creator still counts as live.
    - "Gone" is judged only once the users store has loaded (`tenancyHydrated`, XERK-2993): an
      HA replica's `/data` is empty until then, so an absent creator reads as live, never orphaned.
    - Only the owner may make an event private/confidential: a non-owner hiding one locked every
      other viewer out, itself included, with no way back. Both refusals carry no `event`.
- **Clients send `recurrence` (the rule, or null) and an occurrence's `scope`** (XERK-2973): never a
  `recurrence` with `scope: occurrence`. The control ⇄ rule mapping is shared by vector file
  (`turma-meetings.md` "Repeat").
- **Clients send the body Android's `calDraftPayload` builds** (XERK-2972): every field whole
  (an edit that clears one clears it) — except an occurrence-scoped edit, which sends only the
  changed fields (`calScopedPayload` ↔ calendar.js `scopedBody`, `turma-meetings.md`), `start`/`end` with the offset of the picked `timeZone`,
  all-day ending at the midnight after its last day. Edit/Delete only on `editable:true`.
- **Every write broadcasts the coalesced `calendar` frame** under the tenant-level key
  `turma:events@<tenant>` (plain `turma:events` untenanted). The SSE scoper's `mayHost` passes it
  only to that tenant's viewers; clients refetch on any frame, so no client change is needed.
- **Lifecycle**: an org no host has been decided into for `CALENDAR_TURMA_ORG_GRACE_MS` (24h,
  tracked in memory, so a hub restart restarts it — the safe direction) is dropped from `orgs`
  by `calendarTick`; an event left with no org is deleted. The grace is why a host's brief
  drift out of its org (`decidedOrgOf` = "") never wipes that org's events; serving hides the
  org at once.
- Tenant purge drops the tenant's bucket; tenant migration moves an untenanted event whose every
  org is movable into the tenant, its orgs re-keyed. Tests: `tenant-migration.test.js`, the
  `XERK-2968:` cases in `server.test.js`.

## Recurring Turma events (XERK-2969, `turma/recurrence.js`)

- **A series is ONE record: its first instance (the anchor's start, end, `timeZone`) + a rule.**
  Rule (`ruleError` / `sanitizeRule`, the ONE whitelist; fixed key order, a coerce fixed point):
  `{freq: daily|weekly|monthly|yearly, interval 1..99, byDay?, byMonthDay?, byWeekday?, until? | count?}`.
  - `byDay` [SU..SA] for daily (a filter: weekdays = daily MO..FR) or weekly (default: the
    anchor's day). Weeks start Sunday, like the calendar view.
  - `byMonthDay` 1..31 or `byWeekday {n: 1..4 | -1 (last), day}` for monthly/yearly (default the
    anchor's day of month; yearly keeps the anchor's month). **A day past a month's end is its
    last day** (Outlook's rule): "the 31st" is Feb 28, Apr 30. Never RFC 5545's skip.
  - `until` a date, inclusive, in the event's zone; `count` 1..999; at most one. Neither = unbounded.
  - The anchor sets the time of day; occurrences are the rule's dates on or after it. A write whose
    rule names no occurrence at all is a 400; a recurring event lasts ≤31 days (else 400).
- **Expanded at SERVE time, over the requested range only, in the event's IANA `timeZone`** (Intl,
  no dependency): every occurrence keeps the anchor's WALL start and length, so DST never moves a
  9:00. A time a spring-forward skips reads an hour later (old offset), a repeated one is its first.
  - **Except the anchor itself** (XERK-3041): the first occurrence is the stored start/end, so a
    series started at the SECOND 1:30 of a fall-back day keeps that instant and its own key resolves.
  - **An anchor in or across a spring-forward gap keeps the wall time it was GIVEN** (XERK-3040):
    its instants cannot carry it (02:30 there IS 03:30; 01:00-02:30 reads 01:00-03:30), so the
    record stores a hub-internal `wall: {tod, len}` (ms; never served, absent when the instants
    carry it), which `recurrence.anchorWall` repeats. `recurrence.wallHint` derives it from a sent
    string naming a gap time AS that instant (the web sends a picked 02:30 as `02:30-05:00`, the
    old offset), else keeps the record's own hint while it still names the anchor's instants.
  - A plain reading of the same instant (`03:30-04:00`, a Z stamp) never drops the hint: a form
    resends what it shows. A re-time to other instants does. Android refuses a gap time outright.
  - A series move through the FIRST occurrence keeps the sent string (`moved` in the series
    PATCH) when it names the moved instant; a later occurrence's delta move writes a Z stamp.
  - Unbounded rules are fine: a call skips straight to the range and never walks more than
    `PERIODS_MAX` periods; the served range is already ≤100 days.
  - **A `count` series skips ahead too** (its occurrences before a period are counted in O(1)):
    walking it from its start on every GET and every exception check stalled the hub for tens of
    seconds (QA). The whitelist checks every exception key on every write's store echo — keep
    `occurrenceAt` O(1)-ish.
  - **All Turma occurrences in one answer stop at `CALENDAR_SERVE_MAX`**, and the answer then says
    `truncated: true` — never expand 1500 series × 100 days first and slice after.
- **An occurrence's id is `<seriesId>:<original start>`**, the original start as UTC ISO with
  seconds (`turma:ab…:2026-11-16T14:00:00Z`) — the Outlook reader's own convention, so clients treat
  both alike. Served as `{...series fields, id, seriesId, recurring:true, originalStart, exception,
  seriesStart, start, end, startMs, endMs}`; `seriesStart` (XERK-2973) is the series' first
  instant, the day an implicit rule day reads off; a single event carries `seriesId:""`, `recurring:false`. The series
  record itself is never served as an event, and `exceptions` never ride the wire.
- **`exceptions`: `{<original start>: {deleted:true} | {override fields}}`** on the series,
  ≤`CALENDAR_TURMA_EXCEPTIONS_MAX` (100; past it a 409 in words). Overrides are any client field but
  `timeZone`, re-derived through the record whitelist; `start`/`end` ride together.
  - **Kept only while the key is still an occurrence** (checked by the whitelist), so editing the
    rule — or re-timing the series — drops the ones it no longer lands on.
  - A moved occurrence is served where it moved to, also into or out of the asked range.
- **A private event's owner rule (XERK-2972) applies per occurrence too**: a write naming an
  occurrence made private alone is refused (409) to anyone but the owner, like a private series;
  an occurrence of a private series is never `editable` to others, even one made public.
- **A non-owner's series-level write never drops a private occurrence** (XERK-2977): a
  re-time, rule edit, `following` split or series/following DELETE that would lose or change an
  override its owner made private is a 409 in words (`calTurmaDropsPrivate`), even through a
  public occurrence or the series id. Writes that keep it (a subject, a rule it still lands on)
  pass. Why: the per-id rule alone let any viewer delete the owner's private meeting.
- **Orgs are series-level**: an occurrence cannot change orgs or zone (400), so one series is one
  org set. An occurrence edit that resends the series' OWN orgs/zone unchanged is accepted (the
  web form sends every field).
- **The capture matcher and the Daily Brief read a series by its OCCURRENCES** (XERK-2970 readers):
  a capture links to `<seriesId>:<original start>`, never the series id, and the brief lists
  each occurrence in its window. `calendarCandidateIndex(t, captures)` expands a series ONLY in the
  windows of the captures being matched (each capture ± `CALENDAR_LINK_TOLERANCE_MS`, its own org):
  a fixed window for every series stalled the loop ~0.4 s per call and starved later series of a
  shared budget (QA). Every caller passes its captures. Windows merge per org, and the whole index
  spends ≤`CALENDAR_CANDIDATE_WORK_MAX` walks NEWEST capture first (`cut: true` past it): a cut
  costs the oldest captures a re-match, never a series; an existing link still resolves by id, and
  a relink LEAVES a row whose window was not walked (`index.covers`) untouched — else its
  ambiguous flag was wiped with nothing decided (QA).
  - **A series in several orgs is walked ONCE over any span** (`calSpanTake`): per org it spent the
    budget twice on coinciding windows, and one heavy org cut another org's older captures (XERK-2953).
- **`recurrence.wallOf` caches a zone's offset per 15-minute UTC bucket**, validated at both ends
  (some zones move at 00:01): Intl was the whole cost of expansion (~0.15 ms a call). A bucket
  holding a transition is computed exactly each call. Checked against Intl at every minute around
  every transition 1975–2040 in every zone (once); `recurrence.test.js` pins the 00:01 movers. `calendarEventLookup` resolves an
  occurrence id on `get` (never listed); a deleted occurrence no longer resolves.
- **An edit keeps a stored org no host is decided into** (it is not served, so no client can
  resend it); the 24h grace in `calendarTurmaTick` decides it. An occurrence edit resending the
  SERVED subset of the series' orgs is "unchanged"; a duplicated org never is.
- **Writes (the XERK-2968 routes) take a `scope`** — PATCH in the body, DELETE as `?scope=`:
  - `occurrence` (the default for an occurrence id): PATCH merges its override (a start alone keeps
    its length); DELETE marks it deleted. A deleted occurrence is a 404 after.
  - `series` (the default, and the only scope, for a series id): PATCH edits the record, `recurrence`
    included (`null` makes it single). Through an occurrence id a start/end moves the series by the
    same delta. DELETE removes the whole series.
  - `following`: the series ends the day before this occurrence (`until`; a `count` becomes the
    occurrences before it) and PATCH creates a NEW series at it carrying the edit and the
    exceptions from it on → `{ok, event: <new series>, previous: <old series>}`. DELETE only ends
    the old one. From the first occurrence it is `series`.
  - **When every occurrence before it is deleted, the old series is DELETED** (no `previous`; a
    DELETE answers `{ok}`): it served nothing yet counted toward the tenant's caps (XERK-2953).
    `calTurmaDropsPrivate` still applies, as to a series delete.
    Every removal goes through `calTurmaRemove`, so its Outlook copies are deleted too (XERK-2985).
  - A `recurrence` SENT with it is the series' rule as the client edited it (XERK-2973): the hub
    re-anchors it like the kept one — the day pin below, and on a count series a sent `count` is
    the WHOLE run's (clients say "in the whole series"): the new series gets what is left, a 400
    in words when nothing is.
  - A monthly/yearly rule with an implicit day gets `byMonthDay` = the old anchor's day on the new
    series: split at Apr 30 of "the 31st", it must stay on the 31st, not move to the 30th. Not
    when the edit moves the occurrence to another DATE (the local date, not the day number, never on
    whether `start`/`timeZone` were sent — edit forms resend them): the new start names the day.
  - **An EXPLICIT day moves with an occurrence moved to another date** (`recurrence.reanchorDays`,
    XERK-2953) when the rule's day fields are the series' own (unsent or resent unchanged): "the
    31st" moved to Jul 30 is the 30th; byDay shifts by the weekday delta (MO,WE moved a day is
    TU,TH); byWeekday takes the new date's nth (a 5th = last). Why: kept as is, the new series'
    first instance was not one of its own occurrences. A day the client changed is kept as sent;
    one equal to the series' implicit day (`withAnchorDays`) counts as unchanged.
  - **A `following` start equal to the occurrence's DISPLAYED start is no re-time** (XERK-2991):
    the new series anchors on the ORIGINAL slot (cadence kept) and a moved occurrence keeps its
    move. An end equal to the displayed one is unchanged; another end (or one sent alone) is a new
    LENGTH at the original slot, the moved occurrence taking it too. Only a different start
    re-times. Why: the web editor resends the start with a changed end, which shifted the cadence.
  - **Moves and lengths carried onto another slot are WALL-clock deltas in the event's zone**
    (`following` length, `series` move through an occurrence): a ms delta across DST ended an
    all-day series at 23:00.
  - **A `series` move to another date re-anchors the same way** (`calTurmaMovedRule`): through an
    occurrence id, "following" from the first occurrence, or the series' own start.
  - **Every N > 1 weeks, a move carrying the days across different week boundaries is a 400**
    in words (weeks start Sunday): FR,SA every 2 weeks moved Sat -> Sun is no one week's days.
    A time-zone change that keeps the instants gets the same refusal worded for the zone
    (`CAL_TURMA_ZONE_WEEK_REFUSAL`, XERK-2993): nothing was "moved".
  - `version` is the SERIES' (one version per series; every scope bumps it). Occurrence PATCH
    answers the occurrence, series PATCH the series record.
- Tests: the `XERK-2991:` case in `server.test.js` (moved occurrence resent unchanged).
- Tests: `recurrence.test.js` (DST both ways and east of +12, month-end, nth/last weekday,
  until/count, range cut, bounds); the `XERK-2969:` cases in `server.test.js` (ids, moved/deleted
  occurrences, rule edit dropping exceptions, the following split, the serve cap); the `XERK-2953:`
  cases (dead old half, explicit-day re-anchor, the serve cap's early stop, one walk per span).
  The `XERK-3040:` cases (`recurrence.test.js`, `server.test.js`) pin the DST-gap anchor.
