---
paths:
  - "turma/server.js"
  - "turma/tenant-scope.js"
  - "turma/holidays.js"
  - "turma/public/meetings.js"
  - "agent/hub-agent.py"
  - "agent/hooks/session_cli.py"
  - "turma/public/calendar*"
  - "turma/tests/server.test.js"
  - "turma/tests/holidays.test.js"
  - "agent/tests/test_hub_agent.py"
  - "android/app/src/main/java/**/Calendar*.kt"
---

# The Calendar wire contract (epic XERK-2890)

A Teams-style meetings calendar built from each host's classic Outlook (read by the session CLI's
reader, `agent-session-cli.md`) and Tenir. The hub stores each host's events and serves them; the
agent reads Outlook off its beat. Every child ticket builds to this file; change it here first.
Hub half: XERK-2891. Agent half: XERK-2895 (below).

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
  `attendees` ≤100 `{name ≤100, email ≤200 (email-shaped or ""), role
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

## Org assignment (served as `org` on each event, "" = unassigned)

A host's calendar is one person's Outlook and may span orgs. Decided at serve time, in order:
1. The host's per-series override (`seriesOrgs[seriesId || id]`), even "" (pinned unassigned).
2. Domain rules: the org whose `domains` contain the ORGANIZER's email domain; else the one org
   matching any attendee's domain, only when exactly one org matches (two = ambiguous, skipped).
3. The host's `defaultOrg`.
4. "" — clients draw it in a neutral color.
- Only orgs of the HOST's tenant count (org key tenant == host key tenant), and only orgs some
  host is decided into; a rule or setting naming another tenant's org is refused at the route.
- A domain is lowercase `^[a-z0-9.-]{1,253}$` with a dot; `sub.a.com` matches rule `a.com`.

## Settings (hub store, operator-authed, tenant-scoped)

- Two `registerExternalStore`s: `/data/calendar-org-rules.json` (`CALENDAR_ORG_RULES_FILE`,
  siteKey → `{domains[]}`, a `TENANT_ORG_STORES` member) and `/data/calendar-host-settings.json`
  (`CALENDAR_HOST_SETTINGS_FILE`, hostKey → `{defaultOrg?, showPrivate?, seriesOrgs{}}`).
  Split so each is keyed like its tenant's other stores (org key vs host key).
- `POST /api/orgs/<site>/calendar-rules {domains: [..]}` (org route: 404 an org no host is
  decided into; ≤50 domains; `[]` clears).
- `POST /api/agents/<host>/calendar/settings {defaultOrg?, showPrivate?, series?: {id, org}}`
  (host route, `principalMayDriveHost`); `defaultOrg`/`series.org` null clears, else must be a
  decided org of the host's tenant (404). ≤500 series overrides per host (oldest dropped).
- They answer `{ok, rules}` / `{ok, settings}` and broadcast a `calendar` frame for the host(s) affected.

## The event store

- `/data/calendar-events.json` (`CALENDAR_EVENTS_FILE`), `registerExternalStore`, hostKey →
  `{syncedAt, windowFrom, windowUntil, ranges[[from, until]] ≤8, lastError?, lastErrorAt?,
  events[]}`. The host key carries the tenant (XERK-2533), so the store needs no tenant field.
- **Budget**: ~1 KB/event; default window −8w..+26w (`CALENDAR_PAST_MS` / `CALENDAR_FUTURE_MS`).
  Per host ≤`CALENDAR_HOST_EVENTS_MAX` (1500) and ≤`CALENDAR_HOST_BYTES_MAX` (1.5 MiB); per
  tenant ≤`CALENDAR_TENANT_BYTES_MAX` (4 MiB); hosts are bounded by `AGENTS_MAX`. Eviction: OLDEST PAST event
  first (by end), then the furthest future; a tenant over budget trims its biggest host first.
  - Why Postgres is not used: the store is written whole and stays under ~10 MiB fleet-wide at
    these caps, the meetings store's budget class. Raise the caps only by moving it to Postgres.
- **Keeps the last good sync per host**: an offline host's calendar is still served (`online:false`
  beside it). A host removed from the registry loses its calendar 30 days after its last sync.
- Tenant purge + migration step for `calendarEvents`, `calendarHostSettings` (a host's plain
  org values follow it into the tenant) and `calendarOrgRules`. Tests: `tenant-migration.test.js`.

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
  the ASSIGNED org ("" selects unassigned). ≤`CALENDAR_SERVE_MAX` (5000) events, earliest first.
  `pending: true` = a `syncCalendar` was queued for this range.
- **Not on `/api/agents`**: too big for the snapshot. A coalesced `calendar` SSE frame (one per
  turn) announces which hosts changed: `{<hostKey>: {syncedAt, windowFrom, windowUntil}}`, scoped
  per host like the agent list; clients refetch the range they show.
- Tests: the `XERK-2891:` cases in `server.test.js`.

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
- Served on `/api/agents` (the meetings settings drawer reads it there) + SSE:
  - `holidaySettings`: every decided org's effective settings (`bySite`-scoped), its own frame.
  - `holidayCatalog`: country → `{name, holidays: [{id, name}]}`, hub-wide (no tenant data).
- `GET /api/holidays?from=YYYY-MM-DD&until=YYYY-MM-DD` (`filtered`), inclusive, ≤400 days →
  `[{id, date, name, country, actualDate?, offFor: [siteKey]}]`, oldest first.
  - `date` is the OBSERVED day (the day off); `actualDate` rides only when a weekend moved it.
  - Countries = the union the caller's visible decided orgs follow; `offFor` names only those
    orgs (`principalMaySite`), so another tenant's org never appears.
- Tests: `holidays.test.js` (rules over several years), the `XERK-2892:` cases in
  `server.test.js` (round-trip, SSE, tenant isolation pinned by mutation, purge).
