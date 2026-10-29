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
  - **`"auto"` resolves to `"haiku"`, whatever the input size** (XERK-2393 eval: Haiku beat Sonnet
    overall and on 40+-ticket days at 1/13 the cost; `docs/daily-brief-adr.md`).
  - Sent only to an online host DECIDED into `siteKey` that reports `dailyBrief.available === true`
    (an older agent would ack and never answer). ONE run in flight per org.
- The agent renders off its beat (XERK-395: never inline), with a locked-down model run, and
  collects its own org-scoped tickets for the windows (XERK-2392); the hub sends no ticket data.
- The model run is `DAILY_BRIEF_INSTRUCTION + daily_brief_input(data)`, and its reply must pass
  `parse_daily_brief` (XERK-2393, `agent-daily-brief.md`); retry, else `failed`. That brief maps
  onto the result row as below, each joined with a single space, in this order:
  - `day` = `sinceYesterday` + `stillOpen`;
  - `week` = `thisWeek`;
  - `next` = each `upNext[].text`, or "Nothing is queued next." when the list is empty.
  - Each part ends in sentence punctuation (the agent adds "." when missing), or an
    unpunctuated `upNext` list reads aloud as one run-on sentence (XERK-2394 QA, 2 of 4 real runs).
  - `parse_daily_brief` refuses a brief whose joined `day` or `next` would pass 2000 chars
    (`DAILY_BRIEF_WIRE_TEXT_MAX`), so the hub never cuts a script mid-sentence. Chars are
    Unicode CODE POINTS on both sides: the hub must count `[...s].length`, never `s.length`
    (UTF-16 units), or an emoji-bearing script passes here and is cut there.

## Agent → hub: the heartbeat

- `dailyBrief: {available: bool, runtimes: [..], models: [..]}` capability block;
  `normalizeDailyBrief` coerces it (absent stays absent = "can't"; unusable → null; the two lists
  keep only known names). Today the agent offers `runtimes: ["claude"]` alone (XERK-2394): dsh has
  no one-shot and `qwen -p` none shown to run tool-less, so a command naming either is answered
  `failed` with that reason — the hub should pick a host listing the runtime instead.
- `dailyBriefResults: [{runId, siteKey, status:"ok"|"failed", day, week, next, model, error?}]`.
  - Caps (the hub truncates/drops past them): ≤5 rows per beat; `day`/`week`/`next` ≤2000 chars
    each, plain text for reading aloud; `model` ≤40; `error` ≤300; `failed` rows carry no text.
  - The agent clears a row only once a beat carrying it was accepted (outbox semantics).
  - Every text is cleaned by the same fixed-point cleaner on both sides
    (`clean_daily_brief_text`; the hub's ingest must pass `agent/tests/daily_brief_clean_vectors.json`
    too). Add a vector there, never to one side only.
  - A command re-delivered with the same `runId` runs once; an unusable command that still names a
    valid `runId` + `siteKey` is answered `failed`, one that does not is only logged.
  - A queued run replaced by a newer one for the same org is answered `failed` ("replaced by run …").
- Both keys are in `HEARTBEAT_KNOWN_KEYS`. `dailyBriefResults` is deleted from the payload before
  the record is stored; the ingest (XERK-2395) accepts a row only from the host the hub asked, for
  that run, while the host is still decided into `siteKey` (XERK-348).
