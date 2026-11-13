---
paths:
  - "turma/server.js"
  - "turma/public/meetings.js"
  - "turma/tests/meetings.test.js"
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
  - Or a TENANT's token derived from it (XERK-2551, `turma-tenancy.md`): the URL names the PLAIN
    site and the token decides the tenant's org; a suffixed URL site is a 404.
- **The URL's org is a short LABEL Tenir's capture.json names (XERK-2638), or a site key.**
  `resolveMeetingOrg`, in the tenant gate before the route: a decided org's site key matches first
  (older configs), else a label `^[a-z0-9][a-z0-9_-]{0,39}$`, case-folded, of the token's tenant.
  - An org's label is the operator's (`meetingLabels`, `POST /api/orgs/<site>/meeting-label
    {label|null}`) else a slug of its name (`jira.orgName` cut to 120 chars first — it is
    agent-sent and unbounded — else the site as `board.js` `orgName` derives it).
  - An operator's label outranks a default: setting one is refused (409) only by another org's
    OWN label, and an org whose default it takes has none (`""`) until given one. Else a label
    two orgs' defaults share could never be mapped (QA).
  - `meetingLabels` lists EVERY decided org, `label:""` included (a name with no ASCII slug), so
    the operator can always give it one.
  - No org, or two (colliding defaults), answering a label = 404 in words naming it, and the label
    is noted in `meetingLabelMisses` (`<label>[@tenant]` → `{at, shared?}`, ≤20 per tenant, 200
    in all trimmed by `trimByTenant`, a repeat re-written at most every 10 min) for
    the Brief page to map. Tenir keeps retrying a 404, so mapping it delivers the meeting.
  - Tests: the `XERK-2638:` cases in `server.test.js` (tenant isolation pinned by mutation).
  - Why in Turma: the capture PC should hold no tracker hosts. Tenir needs no version gate: the
    label rides the same URL slot the site key did.
- Body: `{meetingId, title, platform, startedAt, endedAt, tenirUrl, participants[],
  segments[{speaker, text, startMs, endMs}]}`.
  - `meetingId` `^[A-Za-z0-9._:-]{1,128}$` (Tenir's own id); `title` ≤300; `platform` ≤40
    (`zoom`, `teams`, …); times epoch ms; `tenirUrl` an http(s) URL ≤500 with no quote, space,
    backslash, angle bracket, control, format (`\p{Cf}`, every bidi control) or default-ignorable
    character (it is rendered as a link),
    or absent.
  - `participants` ≤100 names ≤100; `segments` 1..`MEETING_SEGMENTS_MAX` (10000), `speaker` ≤100,
    `text` ≤2000, `startMs`/`endMs` offsets in ms from `startedAt`.
  - Text is code points with control/bidi characters removed (`meetingText`); a segment with no
    text is dropped.
  - A wrong-typed or over-long `title`/`platform`, or an `endedAt` over a day ahead, is a 400 —
    never silently cut or defaulted (XERK-2518). Segment/participant text is still capped.
- Refusals in the hub's own words (XERK-264), checked in this order, none minting a store key:
  401 bad token → 404 an org no host is DECIDED into (`decidedOrgs`) → 413 body over
  `MEETING_BODY_MAX` (1 MiB) or too many segments → 400 a malformed field → 409 the store full
  → 429 too many meetings waiting (`MEETINGS_PENDING_ORG_MAX` 10 per org,
  `MEETINGS_PENDING_TOTAL_MAX` 20 fleet-wide, or pending transcripts past
  `MEETINGS_PENDING_BYTES_MAX` 2 MiB fleet-wide, 1 MiB of it per org).
  - A fleet-wide budget refuses a tenant only at its FAIR SHARE (budget ÷ tenants with meetings
    waiting, itself included; XERK-2621), so one tenant's backlog never 429s another.
  - Admission alone grows the store to budget x H(N) for N tenants (shares shrink, nothing is
    evicted), so `MEETINGS_PENDING_HARD_FACTOR` x each budget is a hard ceiling for everyone,
    answered "queue … is full" (no count). Accepted: ~4 busy tenants together can fill it.
- A settled row's items fit `MEETING_ITEMS_BYTES_MAX` (64 KiB) of JSON: past it the hub shortens
  descriptions and quotes ("…") by the least that fits; only what cannot fit even then is dropped.
  - Why: the agent's parser allows far more (30 × 4000-char descriptions); a cut dropped items silently.
- **Why the byte budget**: the store is written whole on every change (and published whole to the
  peer under HA); at 20 × 1 MiB each write blocked the event loop ~1 s and pushed RSS past the
  512Mi pod limit (XERK-2508 QA). An hour of captions is ~60 KB. Do not raise it without moving
  transcripts out of the policy store.
- **Idempotent on `meetingId` per org**: a repeat answers 200 `{ok, meeting, duplicate:true}`
  and changes nothing (first copy wins), so Tenir retries freely, also after a hub restart.
- Answers `{ok, meeting}`: the row without its transcript.

## The proposal store (hub, XERK-2508)

- `/data/meeting-proposals.json` (`MEETING_PROPOSALS_FILE`), a `registerExternalStore`
  (HA-safe), siteKey → newest-first meetings, `MEETINGS_KEEP` (50) per org, `MEETINGS_ORGS_MAX`
  (100) orgs per tenant (`orgStoreFull`), null-prototype map. `sanitizeMeeting` is the ONE whitelist (route, ingest, restore,
  remote watch); field order fixed, so a live row is a coerce fixed point.
  - **Written with no debounce** (`debounceMs: 0`): a 200 promises Tenir the meeting is kept.
- Row: `{meetingId, status:"queued"|"running"|"ok"|"failed", title, platform, startedAt, endedAt,
  receivedAt, tenirUrl?, participants, daily?, model?, host?, runId?, generatedAt?, archivedAt?,
  items?, error?}`.
  - `segments` are kept ONLY while `queued`/`running` and dropped once settled; a running row also
    keeps `cmdId, sentAt, attempt, tried`. None of those four, nor `segments`, is ever served.
  - **Eviction drops settled rows first** — archived ones before the rest — oldest first; a
    pending row is evicted only when all are pending.
- A meeting arriving while another of the org is running waits `queued`; ONE run per org.
- An org no host is decided into loses its meetings 30 days after its newest one arrived.
- **Served** as top-level `meetingProposals` on `/api/agents` + its own `meetingProposals` SSE
  frame (whole map, coalesced per turn): each org's newest `MEETINGS_WIRE_TAIL` (20) rows through
  `meetingWire` — never `segments`/`cmdId`/`sentAt`/`attempt`/`tried`.

## The operator's review (hub, XERK-2510)

- `POST /api/orgs/<siteKey>/meetings/<meetingId>/items/<itemId>` — OPERATOR-authed (only the
  4-part POST is Tenir's token route). Body `{action:"approve"|"reject"|"reopen", title?, description?,
  project?, issueType?, start?}`; answers `{ok, meeting}` or a refusal in the hub's words:
  400 body/action/fields → 404 org no host is decided into / meeting / item → 409 meeting not
  `ok`, item already `creating`/`created`/`logged`, or rejecting a rejected one.
- **Approve queues the SAME `createTicket` the New-ticket modal does** (`queueCreateTicket`:
  single-flight, ranked board-write host of THAT org, gap refusal). The tracker write stays the
  operator's action — nothing creates a ticket from a model's output unasked.
- **A `decision` item never touches the board**: approve appends `{source:"meeting", text, label:
  <meeting title>}` to the decisions log, so every same-org session receives it on its reply.
  Approval-gated on purpose: the log reaches every session's context.
- `item.review` (whitelisted in `sanitizeMeetingReview`, measured OUTSIDE the items byte budget so a
  review never cuts an item): `{state:"creating"|"created"|"failed"|"rejected"|"logged", at,
  project?, issueType?, edited?, cmdId+host (creating), key+url? (created), error (failed),
  start?, session:"waiting"|"queued"|"failed" + sessionError? (created with start)}`.
  - **Never taken from an agent**: `ingestMeetingResults` drops a `review` off every result item.
- `settleMeetingReviews` (on `meetingsTick` and on a beat carrying `createTicketResults`): the
  owning host's `createResults[cmdId]` → `created` (and every org host is asked to `refreshJira`)
  or `failed`; that host offline/gapped → `failed` in the GET poll's honest words (XERK-241).
- **A `creating` review fails at `MEETING_CREATE_DEADLINE_MS`** (15 min) with no answer: a hub
  killed before the host took the command (debounced queue, unpersisted result caches) otherwise
  left it `creating` forever, refusing both Approve and Reject.
- `edited` is the page's own flag (or a changed title): the page always sends a description,
  so a text compare would misread an approve.
- Tenir's duplicate answer (`meetingTenirWire`) carries no `review`.
- A meeting decision's `label` (the meeting title) rides the heartbeat reply (`decisionsReplyFor`).
- **Approve + start** waits (`session:"waiting"`) until `ticketRepo` resolves the new ticket on the
  board, then `enqueueTicketStart(..., "manual")` — the Start button's queue. Past
  `MEETING_START_WAIT_MS` (2h) it gives up with "start it from the board".
- Tests: the `XERK-2510:` cases in `server.test.js` (a Jira org AND an ADO org).
- **Reopen** (XERK-2856): `action:"reopen"` on a `rejected`/`failed` item removes its `review`
  (pending again), and unarchives the meeting (it has pending work again). Else 409 "only a
  rejected or failed proposal can be reopened".
- **A create that may have gone through is never reopened** (XERK-2864): a failure the hub cannot
  prove ran nothing (deadline, or a delivered command on a silent host) carries
  `review.maybeCreated: true`, and Reopen answers 409. Reopen wiped the "check the board" warning,
  leaving a clean pending row one Approve from a duplicate ticket; Approve from the failed row,
  warning shown, still works. The web hides its Reopen button there.
  - Reject keeps the flag + error, and Reopen of such a rejection returns it to that warned
    `failed` review, never to pending (QA: reject-then-reopen was the bypass).

## Archive and the daily meeting (hub, XERK-2856)

- `POST /api/orgs/<site>/meetings/<mid>/archive {archived: bool}` — OPERATOR-authed (in
  `tenant-scope.js`; `isMeetingsIngest` is the 4-part POST only). Answers `{ok, meeting}`.
  - 400 body → 404 org no host is decided into / meeting → 409 a `queued`/`running` meeting.
  - `archivedAt` (epoch ms) on a SETTLED row only; re-archiving keeps the first; `false` deletes it.
- **`daily: {meetingAt, briefRunId?}`** is decided ONCE, at Tenir's POST (`meetingDailyOf`), never
  on restore or by Tenir's body (`meetingFromBody` drops a sent `daily`/`archivedAt`).
  - Only a STORED schedule counts, never `DAILY_BRIEF_DEFAULT_SCHEDULE`: every org runs on the
    default, so it tagged any 9am NY meeting daily (QA).
  - By time, only when that schedule is `enabled`: M = its meeting nearest `startedAt` (its zone
    and LOCAL weekdays); daily when `startedAt` ∈ [M − 20 min, M + 60 min]. An opt-out names no time.
  - By title, enabled or not: the title contains the stored `meetingTitle` (case-insensitive) —
    the operator's explicit pick.
  - `meetingAt` = M on a time match, else the meeting's `startedAt`.
  - `briefRunId` = the org's brief whose `meetingAt === M` (newest ok first, else newest), else
    the newest `ok` brief generated in the 24h before `startedAt`; absent when none.
- `meetingWire` serves `daily` and `archivedAt`; **neither Tenir answer does** (`meetingTenirWire`,
  used for the first answer and the duplicate): they are the operator's, not Tenir's.
- Tests: the `XERK-2856:` cases in `server.test.js` (window/weekday/zone, title, brief link,
  transcript, archive, reopen, wire whitelist).

## Hub → agent: the `extractMeeting` command (XERK-2508 / XERK-2509)

- `{type:"extractMeeting", runId, siteKey, meetingId, model, runtime}`; `runId` hub-minted
  `^[0-9a-f]{1,32}$`, `model` concrete (`MEETINGS_AUTO_MODEL` = "sonnet", the XERK-2509
  eval's pick, `docs/meeting-items-adr.md`), `runtime` `claude|dsh|qwen`.
- **Whose work: optional `focus` `{names[], role}`** (XERK-2514), the org's `meetingFocus` (hub
  store, `POST /api/orgs/<site>/meeting-focus {names, role}`, ≤5 names ≤100, role ≤300, control
  and format chars stripped; no names and no role clears it). Absent = everyone's work.
  - Why: a standup is everyone's status; without it every speaker's work became a proposal.
  - The agent (`normalize_meeting_focus`) appends it AFTER the meeting data as the reviewer's
    words, JSON-encoded, then drops any item still assigned to a name not in `names`
    (`meeting_focus_filter`). A null assignee and a decision stay.
  - A name matches when every word of one fits a word of the other (same, or one begins the
    other): "Malcolm H." and "Lee, Ann" match; "Malcolm Smith" doesn't. Strict equality dropped
    the operator's own items under a caption spelling (QA); "any word" let a second Malcolm in.
  - An older agent ignores the key (no filter, no failure), so no version gate.
  - Tests: `XERK-2514:` cases in `server.test.js`, `test_hub_agent.py` `TestMeetingWorker`.
- **The command carries no transcript** (a command rides the host record and `state.json`). The
  agent pulls it: `GET /api/agents/<host>/meetings/<runId>/transcript` (agent-authed, `<host>`
  proved by the credential, XERK-268) answers `{runId, siteKey, meetingId, title, platform,
  startedAt, endedAt, participants, segments}` ONLY on the asked host's path, while that host is
  decided into `siteKey` and the run is `running`; anything else is 404. The gate is
  `agentHostRefusal`, so (as on every `<host>` route) the operator login and, until
  `TURMA_AGENT_STRICT`, the master token pass it too.
  - A daily meeting whose linked brief is still stored and `ok` adds `daily: {meetingAt, day,
    week, next}` (the brief's texts, "" when a section is empty); absent otherwise (XERK-2856).
  - The agent (`normalize_meeting_daily`, `meeting_daily_instruction`) appends it AFTER the
    meeting data (after `focus`, under one closing line), JSON-encoded as the reviewer's context:
    an update on work the brief lists is not new unless it adds a commitment, blocker or decision;
    an item continuing a ticket the brief names mentions that key in its description.
    `duplicateKeys` stays search-filled. An older agent ignores `daily`: no version gate.
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
  - **The running → ok edge pushes "N proposals from <title>"** (XERK-2511,
    `notifyMeetingProposals`): once per meeting, since only that edge sends it; none for an empty
    list or a failure. Routed by the reporting host (its tenant's devices), `tags:"meetings"`,
    `notifKey: meeting:<site>:<id>`, `click: /brief?site=…#meetings` (Android opens Brief's
    Meetings pane; an older hub's `/meetings?site=…` lands there too, XERK-2623).
  - `ok` with `items: []` is a real answer ("nothing to propose"); `ok` with no `items` array fails.
- An item (XERK-2509's schema, re-whitelisted by the hub, ≤`MEETING_ITEMS_MAX` (30) per meeting):
  `{kind:"task"|"bug"|"followup"|"decision", title ≤200, description ≤4000, suggestedAssignee
  ≤100?, due ≤40?, quotes[{speaker ≤100, text ≤500, atMs}] ≤5, duplicateKeys[] ≤5 issue keys,
  repoGuess ≤200?}`. A title-less or unknown-kind item is dropped; the hub stamps `id` "p1".."pN".
  Item text is stored as plain text, markup included: every client renders it ESCAPED.
  A result's `model` counts only as `^[A-Za-z0-9._:-]{1,40}$`, else the row keeps the one sent.
  - The agent fills `duplicateKeys` from a READ-ONLY tracker search, never from the model, and
    offers `meetings.runtimes: ["claude"]` alone (agent half: `agent-meetings.md`).
- Both keys are in `HEARTBEAT_KNOWN_KEYS`; `meetingResults` is deleted from the payload before
  the record is stored.
- Tests: the `XERK-2508:` cases in `server.test.js`; agent: `TestMeetingWorker`.
