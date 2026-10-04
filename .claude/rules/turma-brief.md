---
paths:
  - "turma/server.js"
  - "turma/public/brief.html"
  - "turma/tests/server.test.js"
  - "turma/tests/brief-page.test.js"
  - "android/app/src/main/java/com/xerktech/turma/model/Models.kt"
  - "android/app/src/main/java/com/xerktech/turma/net/FleetRepository.kt"
  - "android/app/src/main/java/com/xerktech/turma/ui/BriefScreen.kt"
  - "android/app/src/main/java/com/xerktech/turma/core/Brief.kt"
  - "android/app/src/main/java/com/xerktech/turma/vm/BriefViewModel.kt"
---

# The per-org brief (XERK-1573, epic XERK-1560)

What the operator would otherwise open every session to learn, one card per org: what finished,
what waits on them and why, what waits on time, what is stalled, what starts next and why, what a
session closed as stale, and the subscription spend. **The brief itself is STRUCTURED — no model.**
v2 (XERK-1574, below) adds a model-written summary on top and the per-org decisions log.

## One hub sweep, per-org records

- **ONE leader sweep iterating orgs, never a session per org** (an epic decision). `briefTick` runs
  on `masterOrchestrationTick` (leader-only, boot-grace-gated) and calls `briefSweep(siteKey)` for
  each org whose newest brief is `BRIEF_INTERVAL_MIN` (default 240) old — or, with none stored, one
  interval after this hub BOOTED. The boot anchor is deliberate: the store persists, so a restart
  keeps the cadence, and a fresh hub does not push a brief for every org on its first tick.
- **The orgs are the DECIDED orgs** (`briefOrgs` = every non-empty `decidedOrgOf`), and every host
  read inside a brief is `decidedOrgOf(a) === siteKey` — never the claimed `jira.siteKey`, so a
  drifted host's sessions are in no org's brief (the XERK-348 boundary).
- **`compileBrief` reads hub data only** and writes nothing:
  - **finished** — Done rows whose `resolved` (agent `resolutiondate` / ADO `ClosedDate`; an older
    agent's row falls back to `updated`) is in the period, MERGED PRs on the org's sessions no
    earlier brief reported (a PR carries no merge time), and sessions whose `closedAt` is in the
    period. Each row carries `since` (resolved / `closedAt`; a PR has none) so the row says when;
  - **one piece of work is ONE finished row** — an ended session is dropped when its merged PR is a
    row here (by session or by URL), its ticket's Done row is (that row takes the session's host),
    or its ticket is in closedStale. Listing it too made "Finished 7" of five things. A kept session
    row carries `transcriptId`, so both clients open it read-only (`?ended=` / `Routes.ended`);
  - **a merged PR whose ticket's Done row is here FOLDS into that row** as `prUrl` (the hands-off
    flow: the session merges, the ticket goes Done) — two rows doubled Finished and the push's
    "N finished". It still enters `prsReported`, so no later brief reports it; a PR whose ticket is
    not Done stays its own row. Web links "merged PR"; Android opens it on a tap of the row;
  - **a stale-closed ticket is never a finished row** — XERK-1569 closes it to a Done-category status
    (Won't Do, Cannot Reproduce), so its row reads done + resolved in the period. closedStale is its
    one row; outflow still counts it (it left the board);
  - **an org's FIRST brief has no PR memory** — it lists every merged PR its running sessions still
    show, however old (also after the 30-day drop or a lost `/data`). One-time per org, accepted;
  - **"already reported" is `prsReported`, never the `finished` rows** — those keep 10 and drop with
    their brief, so a merged PR cut from the list (or on a session outliving `BRIEFS_KEEP` briefs)
    was finished again. The newest brief alone carries it forward (≤500 URLs, the ones a session
    still carries kept first); `briefSweep` strips it off the older ones;
  - **needsYou / stalled / waiting** — the hub's own attention stamp (`wireAttention` of
    `alerts.sessions[sid].attn`, XERK-1571), ONLINE hosts only (an offline host's state is frozen);
    needs-you and stalled oldest `since` first, waiting by ETA. `suggestedAnswer` arrives with
    XERK-1572's classifier; the brief carries `why` today;
  - **nextUp** — the org's hub-queue line (`ticketQueueOrder`, "queued (<reason>)"), then — only with
    auto-start on — `autoStartCandidates` past the sweep's own gates (started, hold/reject, triage
    gate, org policy, spawn in flight), each with `briefNextReason` (the `triageSortKey` terms: P0
    preempts / oldest first, created age, type, non-default tier). **`autoStartCandidates` is the
    sweep's OWN candidate list**, so the brief cannot name an order the sweep does not follow;
  - nextUp is the ORDER, not a start promise: a ticket in its retry backoff (`autoStarted`) stays
    listed with "retrying in <d>", and the usage pause and org rate window (applied at dispatch)
    are not reflected;
  - **closedStale** — `ticket.outcome` of kind `not-reproducible`/`already-fixed` in the period
    (a `done` close is finished work, not a stale close);
  - **spend** — per subscription the org spends, that subscription's freshest non-stale `limits`
    FLEET-WIDE (`freshestLimitsBySub`, the reading `pausedSubscriptions` judges, so the % and the
    paused chip never come from two snapshots; a window whose `resetsAt` passed is dropped), and
    whether `pausedSubscriptions` pauses it (XERK-544/548).
    Each window carries its `*ResetsAt`; both clients word it off NOW ("resets in 52m", "has
    reset since" once it passed — the brief is a snapshot);
  - **counts** — every section's UNCAPPED total plus intake/outflow (rows `created`/resolved in the
    period). The rows are what hosts poll (assignee-scoped, recent Done only). Both clients label
    outflow **"Resolved"**, never "Closed" — that read as the "Closed as stale" section's number.

## The store — a LOW-churn registerExternalStore

- `/data/briefs.json` (`BRIEFS_FILE`), siteKey → newest-first briefs, `BRIEFS_KEEP` (10). A few
  writes per org per day, so `registerExternalStore` (the `epicRuns` shape) IS the right store — the
  "never for high-churn data" rule does not bite.
- **`sanitizeBrief` is the one whitelist** — on compose, restore and a remote watch alike; inline
  literal bounds (module-init TDZ), 10 rows per section, strings capped, `since <= at`. A record for
  another org, or with no usable `at`, is dropped. The map is null-prototype (XERK-1451). A sanitized
  brief is a coerce fixed point, so HA's own-write echo dedups.
- **Two hub-internal keys never reach the wire** — `prsReported` and `needsYouSig` (`briefWire`
  strips them on `/api/agents`, the SSE frame and the route). `briefWire` also serves each EARLIER
  brief as its headline only (empty sections + spend, counts kept): both clients show only its
  counts, and full rows for ten briefs per org cost every 6s Android poll.
- Served as top-level **`briefs`** on `/api/agents` + its own **`briefs`** SSE frame (every
  org, through `briefWire`). Clients scope it by the header org pick like every org surface. **Android TYPES it**
  (`OrgBrief`/`BriefItem`/`BriefCounts`/`BriefSpend`, every field defaulted) — a new field is a
  `sanitizeBrief` line AND a Kotlin field in the same change (decode atomicity).

## On demand + the push

- **`POST /api/orgs/<site>/brief`** (operator-authed) compiles now and answers `{ok, brief}`; a site
  no host is decided into is a 404 that mints no store key. It resets the cadence like any brief.
- **The needs-you set is a digest of the FULL set** (`needsYouSig`, sha1 of host/session/state,
  computed before the 10-row cut; "" = empty). A sig off the stored lists missed a newcomer cut from
  them. A brief stored before the digest falls back to digesting its lists the same way.
- **One FCM push per brief, ONLY when the needs-you set changed** (needs-you + stalled rows, by
  host/session/state) since the org's previous brief — `notifKey brief:<site>`, so a new one
  REPLACES the last; a set that empties RETRACTS it (`dismiss`). An empty set with no previous brief
  says nothing. It carries the headline counts and the first "next" key. Tag `clipboard` (Android
  General alerts). It is an org digest, outside the one-alert-per-session rule
  (`turma-notifications.md`).
- **The push carries no deep link yet**: no `click`/route, so a tap opens the app's default screen,
  not Brief (Android deep-links only host/session/url extras). A Brief route is a follow-up.

## Surfaces

- **An org no host is decided into keeps its briefs `BRIEF_RETAIN_MS` (30 days)** past its newest,
  then `briefTick` drops the key (a quiet host may return); until then both clients show it with
  "no host in this org" IN PLACE of Brief now, which the route would 404.
- **The Brief tab sits between Dashboard and Sessions** (operator review): `nav.js` `PAGES` (web
  header + phone bottom nav) and Android's `TopDest` declare the same order; `nav.test.js` and
  `BottomNavTabTest` pin it.
- **Every brief duration is ONE rule** — the hub's `briefDur` (the nextUp reasons' ages and
  backoffs), `brief.html` `dur`, Android `briefDur`: minutes below the hour, hours to two days, then
  days. Never `fmtDur` (it says "61m" beside a row the page words "1h").
- `brief.html` (nav `brief`): every org a host is decided into (the served `org`) plus any org with
  a kept brief, so an org with none yet still offers **Brief now**. Refusals toast the hub's words.
- Android `BriefScreen` (bottom-nav `Brief`) renders the same off `FleetState.briefs`; `core/Brief.kt`
  ports the org list (`briefOrgs`, `briefLiveOrgs`), the row meta line (`briefItemMeta`),
  `briefPrUrl`, `briefSpendWindow` and `briefDur`. Deliberate
  differences in `android/PARITY.md`.
- Tests: the `XERK-1573:` cases in `server.test.js` (composition + decided-org scoping, bounds +
  keep + the headline-only wire, the push dedupe/retract + a newcomer past the cut, a merged PR
  reported once, a merged PR + its Done ticket counting ONE row, the `briefDur` page parity, hold/reject + offline-host exclusion, the cadence + retention, the route, the
  sanitizer + restart restore); `nav.test.js`;
  `test_full_issue` (`resolved`) in `test_hub_agent.py`; android `BriefTest`, `AgentDecodeTest`.

## v2: the narrative (XERK-1574)

- **The hub has no model access, so an org HOST writes it.** `briefSweep` ends in
  `requestBriefNarrative`: ONE online host of the org (`jiraHostPool`, so declared AND bound)
  reporting `briefRender.available` gets `{type:"renderBrief", siteKey, briefAt, brief}`. The input
  is `briefNarrativeInput` — the served brief minus ids/links — never a transcript. Agent side
  (worker, lockdown, bounds): `agent-session-cli.md`.
- **One request per org in flight** (`briefRenders`, in memory): a newer brief drops the older
  undelivered command. A row is taken only from the host ASKED, for the brief ASKED about, while
  that host is still decided into the org (`ingestBriefNarratives`) — a host cannot write another
  org's summary, or one nobody asked for. A hub restart/failover mid-render just loses it.
- **A restart can waste one Haiku run per org**: a `renderBrief` already in a host's persisted
  queue still runs, but `briefRenders` is gone, so its row is dropped. Accepted, not a leak.
- **`sanitizeBrief` whitelists it**: `cleanBriefNarrative` (fences, tags, link syntax,
  `* \` ~ | < > [ ]`, list bullets and control/bidi chars stripped, whitespace collapsed, cut at
  1200 on a word with "…"). A FIXED POINT, so a sanitized brief stays one (HA echo dedup). Empty =
  absent, never "". `narrativeAt` rides only with a narrative.
- **Control/bidi chars and non-newline whitespace become spaces BEFORE the per-line bullet strip**
  — else a leading one hides a bullet from the first pass (not a fixed point). After that only
  explicit ASCII classes, so the agent's `clean_brief_narrative` gives the same answer.
- **A standalone heading line is DROPPED, never joined into the next sentence** ("Summary for acme
  Two pieces…"): a `#`-heading or an only-`*`-emphasis line (≤80, judged before the markup strip),
  or a cleaned line ending `:` of ≤40. Still a fixed point: the output has no `*`, never STARTS
  with a heading mark, and a kept `:` line is longer than 40. Lengths count code points (`[...t]`) to match Python's `len` —
  the 20000 prefix and the 1200 cut too, so both sides cut an emoji-heavy text at one place.
  A bold phrase inside a sentence is kept. Shared vectors in both test files — change them together.
- **`#` is markup ONLY as a line-leading heading mark** — stripped there with the bullets
  (`#{1,6}` + space), kept anywhere else, so "PR #215" / "issue #3" survive and the summary names
  the PR the Waiting row does.
- **Strictly additive**: no capable host, a failed render, or an older agent = the brief stands as
  v1. `briefWire` strips it from earlier briefs (headline-only). The push does not carry it (it
  lands after the push fires).
- **Both clients show it ABOVE the sections, labelled "Summary · written by a model from the
  sections below"** (web `narrativeHtml`, Android `BriefBody`).
- **Clamped to 4 lines with Show more / Show less** (web line-clamp + `fitNarratives`, Kotlin
  `BRIEF_NARRATIVE_LINES`) — a ~1200-char paragraph otherwise pushes the counts and Needs you below
  a phone's fold. The toggle shows ONLY when the text overflows the clamp. Web caps it at 70ch.

## v2: the decisions log (XERK-1574)

- **Store**: `/data/decisions.json` (`DECISIONS_FILE`), siteKey → oldest-first entries, 200 kept
  (`DECISIONS_KEEP`, oldest evicted). Appended ONLY by operator actions — human rate, so a
  `registerExternalStore` is right; HA rewrites ≤200 short rows per org per answer, not per beat.
  `sanitizeDecision` is the one whitelist (`source` question|permission|note; `question` ≤300,
  `answer` ≤200, `text` ≤500; inline literals; null-proto map; a coerce fixed point).
- **No lone surrogate leaves the whitelist**: a cap through an emoji drops the stranded high half,
  any other becomes U+FFFD (`permissionWhy`'s clip too). The agent writes UTF-8, which cannot
  encode one; `_decision_cell` also replaces them, so one bad row never wedges the file.
- **Writers, always under the DECIDED org (`decidedOrgOf`), never the claimed siteKey**:
  - the answer route → `{question, answer}` = the session's served `question` + the picked
    `questionOptions` labels (an index past them is dropped; "option N" only for a missing
    label) + `, plus a typed answer` for free text
    (`(a typed answer)` alone with no pick) — never its words: the log reaches every same-org
    session, and text typed for one must not;
  - the pane-prompt route → `permissionDecisionQuestion`: `permissionWhy` (the subject), + the
    picked option's label;
  - the dialog's question rides after the subject ONLY when it is not boilerplate —
    `GENERIC_DIALOG_Q_RE` drops "Do you want to …?" / "Would you like to proceed?", which only pad
    the line; with no subject (no `detail`) the question is all there is, generic or not.
  - `POST /api/orgs/<site>/decisions {text}` (operator-authed, 400 empty / 413 >500 / 404 an org no
    host is decided into, minting no key).
  - Nothing is logged for a drifted/unbound host, an unknown session, or no pending question. It is
    logged at the ANSWER, so an answer the agent later drops as stale is still recorded.
- **Delivery**: top-level `decisions` on `/api/agents` + its `decisions` SSE frame (each org's
  newest 20, `decisionsWire`), and on EVERY heartbeat reply as `decisions:{org, entries}` (the
  decided org's newest 30; `org:""` + none for a host in no decided org, which removes its file).
- **A count is `decisionCounts`, never the served list's length** — the tail is capped at 20 of
  200 kept. Top-level on `/api/agents` + its own SSE frame (sent just before `decisions`); clients
  show `max(count, served)` so an older hub's absent count degrades to the tail.
- **`briefTick` drops an org's log** `BRIEF_RETAIN_MS` past its newest entry once no host is in it.
- **Android TYPES both** (`OrgDecision`, `OrgBrief.narrative`, every field defaulted) — a new field
  is a `sanitizeDecision`/`sanitizeBrief` line AND a Kotlin field in the same change.
- **Surfaces**: web `decisionsHtml` (newest 10, newest first, the note box for a live org; a draft
  survives repaints via `drafts` + a focus restore); Android `OrgDecisionsCard` read-only (composer
  web-only, `android/PARITY.md`).
  - **Its OWN card, after the org's brief card** (both clients) — the log is the org's, not part
    of one brief's period, so it never sits among Spend / Earlier briefs. No rows + no note box = no
    card. Test: the "own card AFTER the brief's" case in `brief-page.test.js`.
  - A row's meta names its session (`label`, clipped to 60 chars) — the only tie back for an
    answer with no ticket. Web `DECISION_LABEL_MAX` = Kotlin `BRIEF_DECISION_LABEL_MAX`.
  - **Each meta piece is unbreakable** (web `.bit`, Android a `FlowRow` of one-line `Text`s): the
    line wraps only between pieces, and a piece wider than the row ends in "…".
  - **The typed-answer marker is not a choice**: `answerHtml` / `briefDecisionAnswer` split off
    `, plus a typed answer` (or a lone `(a typed answer)`) and show it muted, never bold.
  - A row's kind is a noun — `question` / `permission` / `note` (`DECISION_KIND` = Kotlin
    `BRIEF_DECISION_KIND`).
- Tests: the `XERK-1574:` cases in `server.test.js`, `brief-page.test.js`, android `BriefTest`,
  `AgentDecodeTest`.
