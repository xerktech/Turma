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
    stored in its canonical Intl spelling and weekdays deduped + sorted, so the coerce is a fixed
    point (HA's watch echo dedups). Null-prototype map (XERK-1451).
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
- `dailyBriefResults: [{runId, siteKey, status:"ok"|"failed", day, week, next, model, error?}]`.
  - Caps (the hub truncates/drops past them): ≤5 rows per beat; `day`/`week`/`next` ≤2000 chars
    each, plain text for reading aloud; `model` ≤40; `error` ≤300; `failed` rows carry no text.
  - The agent clears a row only once a beat carrying it was accepted (outbox semantics).
- Both keys are in `HEARTBEAT_KNOWN_KEYS`. `dailyBriefResults` is deleted from the payload before
  the record is stored; the ingest (XERK-2395) accepts a row only from the host the hub asked, for
  that run, while the host is still decided into `siteKey` (XERK-348).
