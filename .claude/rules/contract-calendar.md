---
paths:
  - "turma/server.js"
  - "turma/holidays.js"
  - "turma/tenant-scope.js"
  - "turma/public/meetings.js"
  - "turma/tests/server.test.js"
  - "turma/tests/holidays.test.js"
---

# The Calendar wire contract (epic XERK-2890)

A Teams-style meetings calendar built from Outlook and Tenir. Every child ticket builds to this
file; change it here first.

## Holidays (hub, XERK-2892)

- **Catalogs are computed by RULE, never a data file or a dependency** (`turma/holidays.js`):
  `fixed(month, day)`, `nth(month, weekday, n)`, `last(month, weekday)`, optional `since` year.
  - A country is one `CATALOGS` row; add a country by adding a row, nothing else.
  - `observed: "us"` moves a weekend date to Friday (Saturday) or Monday (Sunday). A Saturday
    1 January is observed 31 December of the PREVIOUS year, so a window evaluates year+1 too.
  - Only `US` (11 federal holidays) today.
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
