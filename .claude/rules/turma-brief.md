---
paths:
  - "turma/server.js"
  - "turma/public/brief.html"
  - "turma/tests/server.test.js"
  - "android/app/src/main/java/com/xerktech/turma/ui/BriefScreen.kt"
  - "android/app/src/main/java/com/xerktech/turma/core/Brief.kt"
  - "android/app/src/main/java/com/xerktech/turma/vm/BriefViewModel.kt"
---

# The per-org brief (XERK-1573, epic XERK-1560)

What the operator would otherwise open every session to learn, one card per org: what finished,
what waits on them and why, what waits on time, what is stalled, what starts next and why, what a
session closed as stale, and the subscription spend. **v1 is STRUCTURED — no model.** The narrative
paragraph and the per-org decisions log are XERK-1574.

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
- `brief.html` (nav `brief`): every org a host is decided into (the served `org`) plus any org with
  a kept brief, so an org with none yet still offers **Brief now**. Refusals toast the hub's words.
- Android `BriefScreen` (bottom-nav `Brief`) renders the same off `FleetState.briefs`; `core/Brief.kt`
  ports the org list (`briefOrgs`, `briefLiveOrgs`), the row meta line (`briefItemMeta`),
  `briefPrUrl`, `briefSpendWindow` and `briefDur`. Deliberate
  differences in `android/PARITY.md`.
- Tests: the `XERK-1573:` cases in `server.test.js` (composition + decided-org scoping, bounds +
  keep + the headline-only wire, the push dedupe/retract + a newcomer past the cut, a merged PR
  reported once, a merged PR + its Done ticket counting ONE row, hold/reject + offline-host exclusion, the cadence + retention, the route, the
  sanitizer + restart restore); `nav.test.js`;
  `test_full_issue` (`resolved`) in `test_hub_agent.py`; android `BriefTest`, `AgentDecodeTest`.
