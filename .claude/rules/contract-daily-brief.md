---
paths:
  - "turma/server.js"
  - "agent/hub-agent.py"
  - "turma/tests/server.test.js"
  - "agent/tests/test_hub_agent.py"
---

# The Daily Brief wire contract (epic XERK-2390)

A per-org standup summary written on an agent host shortly before each org's daily meeting. The
hub has no model access, so it schedules and asks; one agent host of the org renders. Every child
ticket builds to this file; change it here first.

## The schedule (hub, XERK-2391)

- Store: `/data/daily-brief-schedules.json` (`DAILY_BRIEF_SCHEDULES_FILE`), a
  `registerExternalStore`, siteKey → `{enabled, time "HH:MM", timeZone, weekdays [0-6],
  leadMinutes 1-30 (default 5), model "auto"|"haiku"|"sonnet" (default "auto"), updatedAt}`.
  - `validateDailyBriefSchedule` is the ONE whitelist (route, restore, remote watch); the zone is
    stored as Intl spells it (which may rewrite an alias: `Asia/Kolkata` reads back
    `Asia/Calcutta` on node 24) and weekdays deduped + sorted, so the coerce
    is a fixed point (HA's watch echo dedups). Null-prototype map (XERK-1451).
  - Offset zones (`+05:30`) are refused: a named zone carries the DST rules.
  - At most 100 orgs, siteKey ≤200 chars. **The route refuses what the coerce would drop** (400
    long key, 409 full): the file store echoes `persist()` through the coerce synchronously even
    HA-off, so a dropped key answered 200 with nothing stored. A full store first forgets orgs
    no host is decided into.
- `GET|PUT /api/orgs/<siteKey>/daily-brief/schedule`, operator-authed. PUT merges the body over
  the stored schedule (a toggle sends `{enabled}` alone) and validates the result whole.
  - 400 in the hub's own words (XERK-264); 404 for an org no host is DECIDED into
    (`decidedOrgs`), checked first so a refusal mints no store key.
  - Answers `{ok, schedule|null, next: {runAt, meetingAt}|null}`.
- Served as top-level `dailyBriefSchedules` on `/api/agents` and its own `dailyBriefSchedules` SSE
  frame (the whole map).

## Time rules (pure, `server.js`)

- `nextDailyBriefRun(schedule, now)` → `{runAt, meetingAt}` (`runAt = meetingAt - lead`, first
  `runAt > now`), null when disabled or invalid. Weekdays are the MEETING's local weekday.
  - A spring-forward gap time fires at the instant the old offset names (clock reads +1h); a
    fall-back repeated time is its FIRST occurrence. So each meeting date maps to ONE instant and
    the scheduler keys "already ran" on `meetingAt` — never on the wall time.
  - Offset probes sit ±36h from the wall time: ±12h missed the pre-transition offset east of
    +12h (Auckland, Chatham). Historical date-line skips (Apia 2011-12-30) are not handled.
  - The scheduler must treat a run as DUE when `runAt <= now < meetingAt` and `meetingAt` has not
    run — `nextDailyBriefRun(now)` already points past it, so a hub booting or failing over inside
    the lead window would otherwise skip that day's brief.
- `dailyBriefWindow(schedule, now, lastRunAt)` → `{dayFrom, weekFrom, until: now, meetingAt}`.
  - DAY opens at the previous SCHEDULED meeting (Monday's covers the weekend), or at `lastRunAt`
    when earlier (a missed brief loses nothing); never before WEEK, which is `now - 7d`.
  - Ignores `enabled`, so "Run now" works for a disabled org.
- Tests: the `XERK-2391:` cases in `server.test.js`.

## Hub → agent: the `renderDailyBrief` command

- `{type:"renderDailyBrief", siteKey, runId, dayFrom, weekFrom, until, meetingAt, model, runtime}`.
  - `runId`: hub-minted `^[0-9a-f]{1,32}$`. Times: epoch ms. `model`: concrete (`"haiku"` or
    `"sonnet"`) — the hub resolves `"auto"` before sending. `runtime`: `"claude"|"dsh"|"qwen"`.
  - Sent only to an online host DECIDED into `siteKey` that reports `dailyBrief.available === true`
    (an older agent would ack and never answer). ONE run in flight per org.
- The agent renders off its beat (XERK-395: never inline), with a locked-down model run, and
  collects its own org-scoped tickets for the windows (XERK-2392); the hub sends no ticket data.

## Agent → hub: the heartbeat

- `dailyBrief: {available: bool}` capability block; `normalizeDailyBrief` coerces it (absent stays
  absent = "can't"; unusable → null).
- `dailyBriefResults: [{runId, siteKey, status:"ok"|"failed", day, week, open, next, model,
  error?}]` — `open` is the "Still open" section.
  - Caps (the hub truncates/drops past them): ≤5 rows per beat; `day`/`week`/`open`/`next` ≤2000
    code points each, plain text for reading aloud; `model` ≤40; `error` ≤300; `failed` rows
    carry no text.
  - The hub re-cleans every section with `cleanBriefNarrative` (fixed point, markup and controls
    out, cut on a word with "…"). Its vectors are `agent/tests/brief_clean_vectors.json`; the
    agent's cleaner must pass the same file.
  - The agent clears a row only once a beat carrying it was accepted (outbox semantics).
- Both keys are in `HEARTBEAT_KNOWN_KEYS`. `dailyBriefResults` is deleted from the payload before
  the record is stored; the ingest accepts a row only from the host the hub asked, for that run,
  while the host is still decided into `siteKey` (XERK-348) and the run is still `running`.
  - An `ok` row with no readable section counts as a failure.

## The scheduler, dispatch and brief store (hub, XERK-2395)

- Store: `/data/daily-briefs.json` (`DAILY_BRIEFS_FILE`), a `registerExternalStore`, siteKey →
  newest-first briefs, 30 kept. `sanitizeDailyBrief` is the ONE whitelist; every write goes
  through `putDailyBrief` (the file store re-installs the coerced map, so never hold a row
  across a write).
  - Row: `{runId, status:"running"|"ok"|"failed", trigger:"scheduled"|"manual", meetingAt,
    dayFrom, weekFrom, until, startedAt, model, host?, generatedAt?, day?, week?, open?, next?,
    error?}`; a running row also keeps `cmdId, sentAt, attempt, tried` (never served).
- **The row is minted at DISPATCH, so the store is the scheduler's durable memory.** The newest
  `scheduled` row's `meetingAt` is "already fired"; a restart or failover re-reads it and never
  fires a meeting twice. A Run now is no fire. Never key "fired" on in-memory state.
  - **Written with no debounce** (`debounceMs: 0`): at the stores' 5s a hub killed right after
    a fire lost the row and fired the meeting again on reboot (QA-reproduced).
  - **Eviction never drops an org's newest `scheduled` row**: 30 Run-nows pushed it out and the
    meeting re-fired.
  - A fire that found no capable host (a `failed` row with no `host`) is NOT a fire: the tick
    re-tries it on that same row while the meeting is still due.
- `dailyBriefTick` (leader-only, `masterOrchestrationTick`, so boot-grace too): DUE = runAt has
  come and the meeting is under `DAILY_BRIEF_LATE_MS` (30 min) behind (`dailyBriefDue`); later
  is skipped. A late run's window is taken as of its runAt, so DAY still opens at the previous
  meeting. No decided host, no fire.
- **One run in flight per org**: a schedule waits while a row is `running`; Run now answers 409.
- Host: `jiraHostPool(siteKey, true)` ∩ `dailyBrief.available`, a host with
  `claudeAuth.needsLogin` last. `runtime` = the host's `defaultRuntime`. `"auto"` sends
  `DAILY_BRIEF_AUTO_MODEL` (haiku, the XERK-2393 default).
- **Retry ONCE on another capable host** — same row, same runId, `attempt: 2` — when the host
  reports `failed`, sends an empty `ok`, goes offline/leaves the org, or has not answered in
  `DAILY_BRIEF_RUN_TIMEOUT_MS` (10 min). The old command is withdrawn (no-op once acked). No
  other host → the row settles `failed` with the reason.
- A scheduled fire with no capable host mints ONE `failed` row saying why (above).
- The cleaner's regexes stop at the next opener (`<[^<>\n]*>`), so bracket-heavy text is linear:
  the quadratic form blocked the leader ~300ms per section. A port must keep that.
- The served map is null-prototype, so an org named `__proto__` is served (XERK-1451).
- `POST /api/orgs/<siteKey>/daily-brief/run` (operator-authed) = Run now, ignores `enabled`, no
  schedule needed (DAY = last 24h). 404 an org no host is decided into, 409 running / no capable
  host (mints nothing), 429 within 60s of the last Run now. Answers `{ok, brief}`.
- Served as top-level `dailyBriefs` on `/api/agents` + its own `dailyBriefs` SSE frame: per org
  the newest row AND the newest `ok` in full, every other one `headline` (the day's first
  sentence) instead of the sections.
- An org no host is decided into loses its briefs 30 days after its newest run. No push.
- Tests: the `XERK-2395:` cases in `server.test.js`.
