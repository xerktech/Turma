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

# The Calendar wire contract (epic XERK-2890)

A Teams-style meetings calendar built from each host's classic Outlook (read by the session CLI's
reader, `agent-session-cli.md`) and Tenir. The hub stores each host's events and serves them; the
agent reads Outlook off its beat. Every child ticket builds to this file; change it here first.
Hub half: XERK-2891. Agent half: XERK-2895 (below).
- **The client halves live in their own files**: web calendar view, event panel and notes-review
  links in `turma-meetings.md`; Android in `android.md` ("The Calendar view") and
  `android/PARITY.md`. This file is the wire they both read.
- **No feature flag**: the calendar is on for every org (XERK-2901). Its only gates are the host
  (WSL/Windows with classic Outlook) and `calendar.available` on the beat.

## Agent → hub: the `calendarSync` heartbeat outbox

- **Delivery is a results OUTBOX on the heartbeat** (`calendarSync`, like `dailyBriefResults`),
  not a field re-sent every beat and not a route of its own.
  - Why: the beat already proves the host (XERK-268) and the agent stays outbound-only; a sync is
    sent ONCE and cleared when a beat carrying it was accepted, so an offline hub costs no retry
    code. A whole window re-sent every 20s beat would cost the heartbeat's 6x parse each time.
  - ≤`CALENDAR_SYNC_ROWS_MAX` (2) rows a beat; `calendarSync` is deleted from the payload before
    the record is stored (never on `/api/agents`).
- Row: `{windowFrom, windowUntil, syncedAt, events[]}` — a read that worked — or
  `{windowFrom, windowUntil, syncedAt, error}` — one that did not ("Outlook is not open", ≤300).
  - Times are epoch ms; `windowUntil > windowFrom`, span ≤ `CALENDAR_SPAN_MAX_MS` (40 weeks).
  - **The host is the beat's own key**, never a field of the row (a `host` sent is ignored).
- **A sync is AUTHORITATIVE for its window**: every stored event of that host whose start lies in
  `[windowFrom, windowUntil)` and is absent from the row is DELETED. That is how a meeting
  canceled-and-removed, or a moved occurrence (its id stays, its start changes), disappears from
  where it was. Events of the row are upserted by `id` (first copy of a repeated id wins).
  - `canceled: true` events STAY (clients strike them through); only absence deletes.
  - Outside the window nothing is touched, so a narrow on-demand sync never drops other weeks.
- A failed row records `lastError` + `lastErrorAt` on the host and KEEPS its last good events.
  A good row clears `lastError`.
- **Size refusals are recorded in the hub's own words, never a 413 of the beat** (a refused beat
  rolls the host back and reads offline, XERK-298): a row over `CALENDAR_SYNC_EVENTS_MAX` (1500)
  events or `CALENDAR_SYNC_BYTES_MAX` (2 MiB of JSON), or a malformed window, leaves the stored
  events untouched and sets `lastError` saying what the cap is. The beat is accepted.

## The agent's sync worker (XERK-2895, `hub-agent.py`)

- **Off the beat**: `_calendar_worker_loop` runs the reads; the beat's `_calendar_tick` is a time
  compare that wakes it every `CALENDAR_SYNC_EVERY_SEC` (`TURMA_CALENDAR_SYNC_MIN`, 15) or on a
  `syncCalendar` (`_stage_calendar_sync` only stores the window; a newer one replaces it).
- **The reader is the session CLI's** (`session_cli_module().read_calendar_windows`), loaded by path:
  one Outlook reader, one PowerShell script, on WSL and native Windows alike.
- **Week chunks, each a COMPLETE window**: `calendar_weeks` cuts at UTC Mondays, read
  `CALENDAR_WEEKS_PER_READ` per PowerShell run. A week that reached the reader's
  `CALENDAR_SYNC_WINDOW_MAX` is an ERROR row, never a short events row — a truncated authoritative
  window would delete real events on the hub. Never lift the cap by sending a partial week.
  - A week with ANY unreadable item (Outlook threw on it, or it has no id) is an error row too:
    the item is absent from the read, so the hub would delete it.
  - A pass stages its error rows AFTER its good rows: a good row clears `lastError`, so an
    earlier error would otherwise be wiped. A week sent as an error row keeps no hash.
- **Only changed weeks** on the schedule (`_cal_hashes`, whole grid weeks only); a hub command
  sends every week it covers. Adjacent weeks merge into one row (`calendar_sync_rows`) under
  `CALENDAR_ROW_EVENTS_MAX` / `CALENDAR_ROW_BYTES_MAX`; a beat carries a second row only within
  `CALENDAR_BEAT_BYTES_MAX`, so the outbox never makes a beat a hub with a small body cap refuses.
- **An Outlook failure is one error row in Outlook's words** for the rest of the window, re-sent on
  the schedule when the text changes or the pass sends any good row (which clears `lastError`),
  always on a command. It forgets every hash, so the
  recovery re-sends every week and those good rows clear the hub's `lastError`.
  - A command window that reads cleanly but does not COVER the whole failed range proves nothing
    about the weeks it skipped: the last error row is re-sent after its good rows and kept
    (XERK-2907); reading the range's start shrinks it to the unread rest. Only a covering command
    or a clean scheduled pass clears it. A range starts at its failed READ group, so the failing
    week can sit later inside it: partial overlap must never clear.
  - A command window that FAILS widens the stored range to include itself, never replaces it;
    only a scheduled pass (it re-read every week before its failure) replaces the range.
- Outbox past `CALENDAR_OUTBOX_MAX` drops the oldest AND forgets every hash (never believe the hub
  has a dropped row).
- **A host that is neither WSL nor Windows reports `calendar: {available: false}`**, logs "no Outlook
  here" once at start, and answers a stray `syncCalendar` with that error once.
- Tests: `TestCalendarSync` in `test_hub_agent.py`; `CalendarSyncReaderTest` in
  `test_session_cli.py` (the real script under `pwsh`, and `calendar_sync_fixture.json`, a reply
  recorded from it with a recurring occurrence, a moved exception, a canceled and a private event).

## The event (`sanitizeCalendarEvent`, the ONE whitelist)

- The session CLI's normalized fields: `subject` ≤300, `start`/`end` ISO 8601 WITH offset ≤40
  (Outlook's local wall time; the hub derives `startMs`/`endMs` and drops an event whose start
  does not parse or whose end precedes it), `allDay`, `location` ≤300, `organizer` ≤100,
  `busy` (free|tentative|busy|outOfOffice|workingElsewhere|unknown), `myResponse`
  (none|organizer|tentative|accepted|declined|notResponded|unknown), `canceled`, `recurring`,
  `attendees` ≤100 `{name ≤100, email ≤200 (email-shaped with no `"`/`<`/`>`/backtick/space/control/bidi/zero-width char, else ""), role
  (organizer|required|optional|resource|unknown), response}`, `joinUrl` (`https://` ≤500, else "").
- PLUS: `id` (required, ≤300, no control chars: the Outlook GlobalAppointmentID, and for a
  recurring occurrence or exception `<GlobalAppointmentID>:<original start ISO>`), `seriesId`
  ≤300 (the GlobalAppointmentID; "" for a single event), `lastModified` ISO ≤40, `body` plain
  text ≤`CALENDAR_BODY_MAX` (4000 code points), `categories` ≤20 × ≤100, `sensitivity`
  (normal|personal|private|confidential), `isOnlineMeeting`, `organizerEmail` ≤200.
- Text is code points with control/bidi/format characters removed (`meetingText`); a wrong-typed
  field becomes its "can't tell" value ("" / false / [] / "unknown"), never a guess.
- Field order is fixed, so a stored event is a coerce FIXED POINT (the HA watch echo dedups).
- Used by the ingest, the boot restore and the HA watch (`calendarEventsCoerce`). Rendered text is
  sender-written: every client renders it ESCAPED.
- **A private/confidential event is served with subject, body, location and attendees withheld**
  (`subject: "Private event"`, `private: true`) unless that host's `showPrivate` setting is on.
  Withheld at SERVE time; the store keeps them so the opt-in needs no resync.

## Org assignment (served as `org` on each event)

- **An Outlook event's org is its HOST's decided org (`decidedOrgOf`), always** (XERK-2964,
  operator rule): the agent that read it is tied to one org, so the org is known and LOCKED.
  "" only for a host in no decided org (drifted or never bound).
  - No per-series pick, email-domain rule or host default org. Never re-add one: XERK-2929 had
    all three and the operator removed them. Clients show the org as text, never a picker.
  - The settings route refuses a `defaultOrg`/`series` body (400, in words); an older store's
    `defaultOrg`/`seriesOrgs` are dropped on load; `/data/calendar-org-rules.json` is no longer read.
- `matchOrg` (XERK-2898) equals `org`; the capture matcher counts an event for that org.
- **A host's decided org moving (drift, recovery) re-runs the matcher and sends a `calendar`
  frame at once** (`calendarOnBeat`): it moves every one of its events, and waiting for a sync that
  changes events left links depending on history (QA). Test: `XERK-2964: a host leaving the org…`.

## Settings (hub store, operator-authed, tenant-scoped)

- `/data/calendar-host-settings.json` (`CALENDAR_HOST_SETTINGS_FILE`, a `registerExternalStore`),
  hostKey → `{showPrivate?}`.
- `POST /api/agents/<host>/calendar/settings {showPrivate: bool}` (host route,
  `principalMayDriveHost`); answers `{ok, settings}` and broadcasts a `calendar` frame for the host.
- Each `/api/calendar` `hosts[]` row carries `org` (decided, every event's) and `showPrivate`.
  Web: the calendar gear (host rows); Android mirrors it.

## The event store

- `/data/calendar-events.json` (`CALENDAR_EVENTS_FILE`), `registerExternalStore`, hostKey →
  `{syncedAt, windowFrom, windowUntil, ranges[[from, until]] ≤8, lastError?, lastErrorAt?,
  events[]}`. The host key carries the tenant (XERK-2533), so the store needs no tenant field.
- **Budget**: ~1 KB/event without its body; default window −8w..+26w (`CALENDAR_PAST_MS` /
  `CALENDAR_FUTURE_MS`). Per host ≤`CALENDAR_HOST_EVENTS_MAX` (1500) and ≤`CALENDAR_HOST_BYTES_MAX`
  (1.5 MiB); per tenant ≤`CALENDAR_TENANT_BYTES_MAX` (4 MiB); hosts are bounded by `AGENTS_MAX`.
- **Over budget, bodies go before meetings** (XERK-2905): the event furthest from now loses its
  body first. A Teams invite carries 1.5-3 KB of body, so a full window of them would otherwise
  evict whole meetings. A shed body is served as `""`. Tests: `server.test.js` "XERK-2905".
- A host over the 1500-event cap evicts down to it BEFORE shedding bodies (those meetings go anyway).
- A tenant over budget sheds bodies across ALL its hosts first, so one host's meetings never go
  while another keeps its bodies.
- A sibling host whose bodies or meetings the tenant trim took gets its own `calendar` frame.
- Only then are events evicted: OLDEST PAST first (by end), then the furthest future; a tenant
  trims its biggest host first.
- **Evicting events sets that host's `lastError`** (host or tenant budget) ("the hub kept N of M events…"); shed
  bodies alone are not an error. The next sync that fits clears it.
  - Why Postgres is not used: the store is written whole and stays under ~10 MiB fleet-wide at
    these caps, the meetings store's budget class. Raise the caps only by moving it to Postgres.
- **Keeps the last good sync per host**: an offline host's calendar is still served (`online:false`
  beside it). A host removed from the registry loses its calendar 30 days after its last sync.
- Tenant purge + migration step for `calendarEvents` and `calendarHostSettings`.
  Tests: `tenant-migration.test.js`.

## Hub → agent: the `syncCalendar` command

- `{type:"syncCalendar", from, until}` epoch ms, span ≤ 40 weeks. Queued only to an online host
  reporting `calendar: {available: true}` (`normalizeCalendarCapability`, strict boolean; absent
  = older agent, which would ack and never answer). At most one undelivered per host (a newer one
  replaces it).
- **Queued on reconnect**: a beat after `OFFLINE_AFTER_MS` of silence (or a host's first beat)
  queues the default window at once. Also when `GET /api/calendar` asks a range no stored range of
  that host covers (throttled per host, `CALENDAR_ONDEMAND_MIN_MS` 60s).

## Served

- `GET /api/calendar?from=&until=[&org=a,b]` (filtered route): `until - from` ≤ 100 days.
  Answers `{from, until, hosts: [{host, device, online, syncedAt, windowFrom, windowUntil,
  ranges, lastError?, lastErrorAt?, pending?}], events: [{host, org, ...event}]}` — only hosts the
  caller may drive (`principalMayDriveHost`), only events overlapping the range, `org` filter on
  the event's `org`. ≤`CALENDAR_SERVE_MAX` (5000) events, earliest first.
  `pending: true` = a `syncCalendar` was queued for this range.
- **Not on `/api/agents`**: too big for the snapshot. A coalesced `calendar` SSE frame (one per
  turn) announces which hosts changed: `{<hostKey>: {syncedAt, windowFrom, windowUntil, changedAt}}`,
  scoped per host like the agent list; clients refetch the range they show.
  - `changedAt` (ms) keeps two changes from deduping as one identical whole-map frame.
- **A host's online flip sends that frame too** (XERK-2901): `online` rides only the GET answer, so
  without it an open page never re-read and never showed the stale-host notice. The leader's
  offline sweep sends it once per offline run (`calendarOfflineEdge`); the reconnect beat sends it
  before the resync lands (`calendarOnBeat`), else the next sweep does (a host whose calendar
  went unavailable). Test: `XERK-2901:` in `server.test.js`.
- Tests: the `XERK-2891:` cases in `server.test.js`.
- Linked captures and Turma-only entries ride the same answer (below, XERK-2896); the `org`
  filter applies to both, so `events` is no longer Outlook-only.

## Tenir captures ⇄ events (hub, XERK-2896)

- **The link is the meeting row's `calendarEventId`** (`contract-meetings.md` row), never a field
  of the event store: an Outlook id is a GlobalAppointmentID, so one id on two hosts of a tenant is
  one meeting (the newest-synced host's copy is served), and the link survives a host rename.
  - `calendarBy`: `auto` (the matcher) | `operator`; `operator` with no id = "never link".
  - `calendarAmbiguous: true` = the matcher found a tie; nothing linked, flagged for the operator.
- **Matching** (`calendarBestMatch`), on Tenir's POST and again when a sync CHANGES a host's stored
  events or its decided org moves (`scheduleCalendarRelink` → `relinkTenantMeetings`).
  - Relinks run at most once per `CALENDAR_RELINK_MIN_MS` (10s) per tenant, the rest deferred to
    one trailing timer; an error-only or unchanged sync schedules none. Why: one host re-sending
    syncs every beat blocked the shared event loop ~0.55 s a beat at the caps (QA).
  - ≤`CALENDAR_LINK_SCAN_MAX` (200) candidates are scored per capture.
  - Candidates: events of hosts of the MEETING's tenant only, whose `org` is the meeting's org;
    never `canceled`.
  - And the tenant's Turma events whose `orgs` contains the meeting's org (XERK-2970): one event
    in orgs A and B links captures of either. The link is the same `calendarEventId` (a `turma:` id).
  - **Only real meetings** (`calendarLinkCandidate`): someone other than the organizer invited
    (a resource does not count) or a join link/online meeting; not all-day, ≤12h, not declined, `busy` not free/outOfOffice/workingElsewhere. Why:
    a capture inside Focus time / Lunch / WFH linked to that block and never left (QA).
  - A candidate must overlap [startedAt, endedAt] with `CALENDAR_LINK_TOLERANCE_MS` (15 min)
    either side. Score: time ≤0.6 (overlap of the shorter span + start proximity), title words
    ≤0.25 (`inferredTitle`, else a non-generic title), join-URL platform +0.1 / −0.2 on a
    mismatch, participants ≤0.2 (the meeting-focus name rule), a `daily` capture +0.15 for an
    event starting within 20 min of its `meetingAt` (the XERK-2856 pairing links its occurrence).
  - Best ≥ `CALENDAR_LINK_MIN_SCORE` (0.35) wins; a runner-up within `CALENDAR_LINK_MARGIN`
    (0.05) = ambiguous. Tests pin the weights' outcomes, not the numbers.
- **A link holds while its event is stored**, even `canceled` or moved (the capture is what
  happened). An auto link to a still-overlapping event yields only to another event scoring over
  it by the margin (a late invite); one whose event left the store (sync, `calendarTick`) or
  now counts for another org rematches. An operator's choice is never touched by the matcher.
  - A Turma event deleted, or the meeting's org dropped from its `orgs`, has left the store for
    that org: an auto link rematches; an operator link is kept and served `calendarEventMissing`
    (never the event as another org's copy: `meetingCalendarEventWire`, `calendarTenirView`).
  - **Every Turma event write (create, edit, delete, org loss in `calendarTurmaTick`) schedules
    `scheduleCalendarRelink` for its tenant**, like a changed Outlook sync.
- `POST /api/orgs/<site>/meetings/<mid>/calendar` (OPERATOR-authed, `org` class):
  `{eventId}` link | `{eventId: null}` unlink for good | `{auto: true}` back to the matcher.
  Exactly one shape (`auto` with `eventId`, or `auto: false`, is a 400).
  400 body → 404 org no host is decided into / meeting / an id the org's TENANT holds neither on a
  host nor as a Turma event; a Turma id is refused (404) unless the org is in its `orgs`.
  - Outlook ids starting `turma:` are dropped at sync (`sanitizeCalendarEvent`): the prefix is
    the hub's, so a Turma event can never shadow an Outlook copy.
  Answers `{ok, meeting}` (meetingWire, with `calendarEvent`).
- **Served on `GET /api/calendar`**: every Outlook event carries `source: "outlook"` and
  `meetings: [{site, meetingId, title}]` (linked captures of orgs the caller may see).
  - And `matchOrg` (XERK-2898): the org the matcher counts it for — equal to `org` since
    XERK-2936. The web panel's relink candidates and daily-brief org read it; absent = an older hub.
  - And `meeting` (XERK-2936): `calendarLinkCandidate(ev)`, judged BEFORE a private event's
    attendees/link are withheld. Clients list an upcoming meeting only when it is true (web
    `isRealMeeting`, Android `calRealMeeting`), never re-deriving it from redacted fields;
    absent = an older hub, where they fall back to attendees/link. Typed on Android (`Boolean?`).
- **Impromptu captures are Turma-only entries**, derived at serve time (no store), never written
  to Outlook: a capture with no stored link →
  `{source:"tenir", host:"", org: site, id:"tenir:<meetingId>", site, meetingId, subject
  (inferredTitle || title), start, end (UTC ISO), startMs, endMs, allDay:false, platform,
  participants, status, summary?, tenirUrl?, ambiguous?, calendarEventMissing?}`.
  - A late invite merges by itself: the next sync links the capture, the entry disappears and the
    event's `meetings` names it. Only the org's kept rows (`MEETINGS_KEEP`) appear.
  - **A linked capture whose event this answer does not serve** (moved out of the range, or the
    event's served org fails the `org` filter) is served as the same entry with `calendarEventId`
    (+ `moved: true` when the event no longer overlaps it), so it never vanishes from its own day.
- Tests: the `XERK-2896:` cases in `server.test.js` (tolerance, tie-break, late calendar, late
  invite, moved/canceled, personal blocks, unserved linked events, private withholding,
  throttle, two orgs, operator route, tenant isolation).

## Holidays (hub, XERK-2892)

- **Catalogs are computed by RULE, never a data file or a dependency** (`turma/holidays.js`):
  `fixed(month, day)`, `nth(month, weekday, n)`, `last(month, weekday)`, optional `since` year.
  - A country is one `CATALOGS` row; add a country by adding a row, nothing else.
  - `observed: "us"` moves a weekend date to Friday (Saturday) or Monday (Sunday). A Saturday
    1 January is observed 31 December of the PREVIOUS year, so a window evaluates year+1 too.
  - Only `US` (11 federal holidays) today.
  - Years 1978–2999 only (`YEAR_MIN`): before 1978 the Monday-holiday and Veterans Day laws
    differ, so the rules would answer wrongly. Lower it only with era rules added.
- **A holiday `id` is stable across years** (`us-thanksgiving`): an org's days off are kept by id
  and apply every year. Never rename an id — it silently un-marks that day for every org.
- Store: `/data/holiday-settings.json` (`HOLIDAY_SETTINGS_FILE`), a `registerExternalStore`,
  siteKey → `{countries: [code], off: [holidayId]}`, null-prototype, `defineProperty` writes.
  - `holidaySettingsValue` is the ONE whitelist (route, restore, remote watch): every code and id
    must be in the catalog, repeats dropped, so the coerce is a fixed point.
  - An org with nothing stored follows `HOLIDAY_DEFAULT_COUNTRIES` (`["US"]`) with NO day off.
    `{countries: []}` stores "follows none".
  - 100 orgs per tenant (`orgStoreFull`/`makeRoomForOrg`, 300 in all), siteKey ≤200; tenant-purged
    and tenant-migrated via `TENANT_ORG_STORES`.
- `PUT /api/orgs/<siteKey>/holidays {countries?, off?}` — operator-authed (`org` class), merged
  over the stored (else default) settings and validated whole. 404 an org no host is decided into
  (before the body, so it mints nothing) → 400 unknown code/id → 409 store full. Answers
  `{ok, settings}`.
- Served on `/api/agents` + SSE (no client edits it yet: the settings UI is XERK-2929):
  - `holidaySettings`: every decided org's effective settings (`bySite`-scoped), its own frame.
  - `holidayCatalog`: country → `{name, holidays: [{id, name}]}`, hub-wide (no tenant data).
- `GET /api/holidays?from=YYYY-MM-DD&until=YYYY-MM-DD` (`filtered`), inclusive, ≤400 days →
  `[{id, date, name, country, actualDate?, offFor: [siteKey]}]`, oldest first.
  - `date` is the OBSERVED day (the day off); `actualDate` rides only when a weekend moved it.
  - Countries = the union the caller's visible decided orgs follow; `offFor` names only those
    orgs (`principalMaySite`), so another tenant's org never appears.
- Tests: `holidays.test.js` (rules over several years), the `XERK-2892:` cases in
  `server.test.js` (round-trip, SSE, tenant isolation pinned by mutation, purge).

## Turma-created events (hub, epic XERK-2967; store + routes XERK-2968)

Events made IN Turma, owned by the hub, never written to Outlook. Every child of the epic
(recurrence XERK-2969, matching + brief XERK-2970, web XERK-2971, Android XERK-2972) builds here.
- **Store**: `/data/calendar-turma-events.json` (`CALENDAR_TURMA_EVENTS_FILE`),
  `registerExternalStore`, tenant id ("" = untenanted) → eventId → record. Keyed by TENANT, not
  host or org: one event may belong to several orgs of one tenant.
- **Id `turma:<16 hex>`**, minted by the hub: an Outlook GlobalAppointmentID never starts so.
  Any other id on these routes is a 400 "Outlook events are read-only".
- **Record** (`sanitizeTurmaEvent`, the ONE whitelist: routes, boot restore, HA watch; field
  order fixed, a coerce FIXED POINT): `{id, orgs[], subject, start, end, startMs, endMs,
  timeZone, allDay, location, body, attendees[], joinUrl, isOnlineMeeting, busy, categories,
  sensitivity, recurrence, exceptions, createdBy, createdAt, updatedAt, version}`.
  - Text, `start`/`end` (ISO WITH offset), `body` (`CALENDAR_BODY_MAX`), `joinUrl` (https only),
    `categories`, `sensitivity` and attendee `name`/`email` follow `sanitizeCalendarEvent`'s rules.
  - `orgs` 1..`CALENDAR_TURMA_ORGS_MAX` (20) org keys, all of the record's tenant; none = no record.
  - `timeZone` an IANA zone the hub's Intl knows (≤64, else "UTC"): the wall clock the creator
    meant, which a recurrence needs; `start`/`end` alone fix the instant.
  - Attendee `role` is `required|optional` only (the creator is the organizer); no `response`.
  - `busy` free|tentative|busy|outOfOffice|workingElsewhere (default busy).
  - `recurrence`: a rule (below) or `null` for a single event; `exceptions` its per-occurrence edits.
  - `createdBy`: the creating principal (`user:<id>`, or its kind for open/legacy/break-glass).
  - `version` starts at 1 and every write bumps it.
- **Caps, refused with a 409 in the hub's words, never a silent drop**: ≤`CALENDAR_TURMA_EVENTS_MAX`
  (1500) events and ≤`CALENDAR_TURMA_BYTES_MAX` (2 MiB of JSON) per tenant — the Outlook
  store's budget class (a host's 1500 / 1.5 MiB).

## Turma-created events: routes and serving

- Operator-authed (`filtered` class: the handler scopes by org), JSON body ≤64 KiB:
  - `POST /api/calendar/events {orgs, subject, start, end, timeZone?, ...}` → `{ok, event}`.
  - `PATCH /api/calendar/events/<id> {version, orgs?, fields...}` → `{ok, event}`; a `version`
    other than the stored one is a 409 carrying the current `event` (optimistic concurrency).
  - `DELETE /api/calendar/events/<id>` → `{ok}`.
- **The caller must pass `principalMaySite` for EVERY org in the body AND every org on the stored
  event**, so nobody strips an org they cannot see. An org no host is decided into, or one the
  caller may not see, is a 404 (never says which tenant holds it); `orgs: []` is a 400 (an event
  must belong to an org); an id the caller's tenants do not hold is a 404.
- Malformed fields are a 400 naming the field, never coerced into a different event: `start`/`end`
  must parse with an offset, `end ≥ start`, a given `timeZone` must be a known zone, a given
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
    - Only the owner may make an event private/confidential: a non-owner hiding one locked every
      other viewer out, itself included, with no way back. Both refusals carry no `event`.
- **Clients send the body Android's `calDraftPayload` builds** (XERK-2972): every field whole
  (an edit that clears one clears it), `start`/`end` with the offset of the picked `timeZone`,
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
  start, end, startMs, endMs}`; a single event carries `seriesId:""`, `recurring:false`. The series
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
  - A monthly/yearly rule with an implicit day gets `byMonthDay` = the old anchor's day on the new
    series: split at Apr 30 of "the 31st", it must stay on the 31st, not move to the 30th. Not
    when the edit moves the occurrence to another DATE (the local date, not the day number, never on
    whether `start`/`timeZone` were sent — edit forms resend them): the new start names the day.
  - `version` is the SERIES' (one version per series; every scope bumps it). Occurrence PATCH
    answers the occurrence, series PATCH the series record.
- Tests: `recurrence.test.js` (DST both ways and east of +12, month-end, nth/last weekday,
  until/count, range cut, bounds); the `XERK-2969:` cases in `server.test.js` (ids, moved/deleted
  occurrences, rule edit dropping exceptions, the following split, the serve cap).
