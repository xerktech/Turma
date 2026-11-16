---
paths:
  - "turma/server.js"
  - "turma/ics.js"
  - "turma/tenant-scope.js"
  - "turma/public/calendar.js"
  - "turma/tests/ics.test.js"
  - "turma/tests/calendar.test.js"
  - "turma/tests/tenancy.test.js"
---

# The subscribable calendar feed (XERK-2992)

A secret iCal link Google/Apple/Outlook subscribe to, serving exactly the calendar its owner's
`GET /api/calendar` would: every org's Outlook events, Turma events and Tenir entries.

## The link

- **One link per principal** (`calendarFeeds`, `/data/calendar-feeds.json`, 0600, no debounce):
  owner (`user:<id>`, `breakglass`, `open`) → `{hash, at, epoch}`. A `legacy` cookie owns none (409).
- **Stored as a SHA-256 only and shown ONCE** at mint; a new mint revokes the old link. Never
  store or log the token: it is a read credential to the whole calendar.
- **Resolved from the user store on EVERY fetch** (`calendarFeedPrincipal`): a deleted, disabled,
  role-less or must-change-password user's link answers nothing, and so does one whose
  `sessionEpoch` moved since mint (a password reset ends the link like its sessions).
  - No tenant purge is registered: the store holds no tenant data, and a gone user's link is dead
    on read. A new field that names tenant data would need a purge + migration step.
- `GET|POST|DELETE /api/calendar/feed` (`signed-in`) = status / mint `{token, path}` / revoke.

## The feed route

- `GET /feeds/calendar/<token>.ics[?org=<site>]` is `public` in the route table and exempt from
  the human gate (`isCalendarFeed`): Google fetches with no session, the token IS the credential.
- **Every refusal is the same 404** (unknown token, dead owner, an org not decided or not the
  owner's): the body never tells a guesser which. The tenant-migration gate 503s a tenant user.
- `?org=` is one SCOPED org key (what the clients hold). **Per-org colour = one subscription per
  org**: Google draws a subscribed calendar in one colour and ignores per-event colour, so the UI
  offers a link per org with its dot. Do not add RFC 7986 `COLOR` expecting Google to read it.
- **The window sits a week inside the default sync window** (`CALENDAR_FEED_PAST/FUTURE_MS`) so a
  fetch is covered by the hosts' regular syncs and never queues an on-demand `syncCalendar`.

## The serializer (`turma/ics.js`, pure)

- One VEVENT per served event, recurring occurrences included (no RRULE): the hub's own rules
  (month-end, moved/deleted occurrences) are exactly what a subscriber sees.
- Timed events in UTC (`…Z`, no VTIMEZONE); all-day as `VALUE=DATE` from the ISO's wall date,
  end exclusive. UIDs are a hash of source + host + id: stable across fetches, leaking no id or
  tenant. Lines fold at 75 octets on UTF-8 boundaries; TEXT escapes `\ ; , newline`.
- A private event is served withheld (as `/api/calendar` does) with `CLASS:PRIVATE`.
- Google refreshes a subscription on its own schedule (hours); `REFRESH-INTERVAL` only helps
  Apple/Outlook. Say so in the UI rather than promising live sync.

## Clients

- Web: calendar ⚙ → "Subscribe in Google Calendar" (`feedSettingsHtml`). Android: none yet
  (`android/PARITY-open.md`).
- Tests: `ics.test.js`; `XERK-2992:` in `server.test.js`, `tenancy.test.js`, `calendar.test.js`.
