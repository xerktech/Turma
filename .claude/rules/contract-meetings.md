---
paths:
  - "turma/server.js"
  - "agent/hub-agent.py"
  - "turma/tests/server.test.js"
  - "agent/tests/test_hub_agent.py"
---

# The Meetings wire contract (epic XERK-2503)

Tenir posts a finished meeting's captions to the hub; one agent host of the org proposes work
items from them; the operator approves each on a review page. Modelled on the Daily Brief
(`contract-daily-brief.md`): the hub has no model access, so it stores and asks. Every child
ticket builds to this file; change it here first.

## Tenir → hub: `POST /api/orgs/<siteKey>/meetings` (XERK-2508)

- Authed ONLY by the dedicated `TURMA_MEETINGS_TOKEN` bearer — never the trigger token (that one
  starts arbitrary sessions) and never the operator login. Unset env = 503 "not configured".
- Body: `{meetingId, title, platform, startedAt, endedAt, tenirUrl, participants[],
  segments[{speaker, text, startMs, endMs}]}`.
  - `meetingId` `^[A-Za-z0-9._:-]{1,128}$` (Tenir's own id); `title` ≤300; `platform` ≤40
    (`zoom`, `teams`, …); times epoch ms; `tenirUrl` an http(s) URL ≤500 or absent.
  - `participants` ≤100 names ≤100; `segments` 1..`MEETING_SEGMENTS_MAX` (10000), `speaker` ≤100,
    `text` ≤2000, `startMs`/`endMs` offsets in ms from `startedAt`.
  - Text is code points with control/bidi characters removed (`meetingText`); a segment with no
    text is dropped.
- Refusals in the hub's own words (XERK-264), checked in this order, none minting a store key:
  401 bad token → 404 an org no host is DECIDED into (`decidedOrgs`) → 413 body over
  `MEETING_BODY_MAX` (1 MiB) or too many segments → 400 a malformed field → 409 the store full
  → 429 too many meetings waiting (`MEETINGS_PENDING_ORG_MAX` 10 per org,
  `MEETINGS_PENDING_TOTAL_MAX` 20 fleet-wide: each pending row holds its transcript in the store).
- **Idempotent on `meetingId` per org**: a repeat answers 200 `{ok, meeting, duplicate:true}`
  and changes nothing (first copy wins), so Tenir retries freely, also after a hub restart.
- Answers `{ok, meeting}`: the row without its transcript.

## The proposal store (hub, XERK-2508)

- `/data/meeting-proposals.json` (`MEETING_PROPOSALS_FILE`), a `registerExternalStore`
  (HA-safe), siteKey → newest-first meetings, `MEETINGS_KEEP` (50) per org, `MEETINGS_ORGS_MAX`
  (100) orgs, null-prototype map. `sanitizeMeeting` is the ONE whitelist (route, ingest, restore,
  remote watch); field order fixed, so a live row is a coerce fixed point.
  - **Written with no debounce** (`debounceMs: 0`): a 200 promises Tenir the meeting is kept.
- Row: `{meetingId, status:"queued"|"running"|"ok"|"failed", title, platform, startedAt, endedAt,
  tenirUrl?, participants, receivedAt, model?, host?, runId?, generatedAt?, error?, items?}`.
  - `segments` are kept ONLY while `queued`/`running` and dropped once settled; a running row also
    keeps `cmdId, sentAt, attempt, tried`. None of those four, nor `segments`, is ever served.
  - **Eviction drops settled rows first**, oldest first; a pending row is evicted only when all
    are pending.
- A meeting arriving while another of the org is running waits `queued`; ONE run per org.
- An org no host is decided into loses its meetings 30 days after its newest one arrived.
- Serving it to clients (top-level `meetingProposals` + SSE, never `segments`) and the review
  fields on an item are XERK-2510's; add them to `sanitizeMeeting`'s whitelist there.

## Hub → agent: the `extractMeeting` command (XERK-2508 / XERK-2509)

- `{type:"extractMeeting", runId, siteKey, meetingId, model, runtime}`; `runId` hub-minted
  `^[0-9a-f]{1,32}$`, `model` concrete (`MEETINGS_AUTO_MODEL`, "sonnet" until XERK-2509's eval
  picks), `runtime` `claude|dsh|qwen`.
- **The command carries no transcript** (a command rides the host record and `state.json`). The
  agent pulls it: `GET /api/agents/<host>/meetings/<runId>/transcript` (agent-authed, `<host>`
  proved by the credential, XERK-268) answers `{runId, siteKey, meetingId, title, platform,
  startedAt, endedAt, participants, segments}` ONLY to the host the run was sent to, while that
  host is decided into `siteKey` and the run is `running`; anything else is 404.
- Host: the SAME pick as the Daily Brief (`pickCapabilityHost`): `jiraHostPool(siteKey, true)` ∩
  `meetings.available === true`, a host with `claudeAuth.needsLogin` last, runtime/models as
  `pickDailyBriefHost`.
- **No capable host = the row stays `queued`**, retried every tick; past `MEETING_QUEUE_MAX_MS`
  (24h) it settles `failed` ("no online host of this org could read the meeting").
- **Retry ONCE on another capable host** (same row, same runId, `attempt: 2`) when the host reports
  `failed`, sends an `ok` with no usable item list, goes offline / leaves the org, or has not
  answered in `MEETING_RUN_TIMEOUT_MS` (15 min). The old command is withdrawn.
- A running row's command is re-queued once per hub process (`meetingSent`), as the brief's.
- `meetingsTick` runs on the leader's `masterOrchestrationTick`; the POST also dispatches inline.

## Agent → hub: the heartbeat

- `meetings: {available, runtimes, models}`, coerced by `normalizeRunCapability` exactly like
  `dailyBrief` (absent = can't; unusable → null).
- `meetingResults: [{runId, siteKey, meetingId, status:"ok"|"failed", items?, model?, error?}]`,
  ≤5 rows a beat; outbox semantics (the agent clears a row once a beat carrying it was accepted).
  - Accepted only from the host asked, for that run, while it is still decided into `siteKey`
    (XERK-348) and the run is still `running`. A re-sent row after that changes nothing.
  - `ok` with `items: []` is a real answer ("nothing to propose"); `ok` with no `items` array fails.
- An item (XERK-2509's schema, re-whitelisted by the hub, ≤`MEETING_ITEMS_MAX` (30) per meeting):
  `{kind:"task"|"bug"|"followup"|"decision", title ≤200, description ≤4000, suggestedAssignee
  ≤100?, due ≤40?, quotes[{speaker ≤100, text ≤500, atMs}] ≤5, duplicateKeys[] ≤5 issue keys,
  repoGuess ≤200?}`. A title-less or unknown-kind item is dropped; the hub stamps `id` "p1".."pN".
- Both keys are in `HEARTBEAT_KNOWN_KEYS`; `meetingResults` is deleted from the payload before
  the record is stored.
- Tests: the `XERK-2508:` cases in `server.test.js`.
