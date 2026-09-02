---
paths:
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "turma/server.js"
  - "turma/tests/board.test.js"
  - "turma/tests/server.test.js"
---

# Triage: the auto-start gate and its UI

The operator-facing half of the triage epic (XERK-485 [E], XERK-486 [F], XERK-487 [G]): what keeps
a ticket OUT of the auto-start stream, how an operator overrides it per ticket or per org, and
where all of that renders. The agent-side classifier that produces the `triage` block
(XERK-481) is documented in `.claude/rules/agent-board.md`; the board's columns/moves/pin
machinery is in `.claude/rules/turma-board.md`.

## Wire state (hub-owned, durable, rides the fleet payload)

- **`ticketTriageActions`** (`TRIAGE_ACTIONS_FILE`, `/data/triage-actions.json`):
  `"<siteKey>/<issueKey>" -> {action: "approve"|"hold"|"reject", at}`. Bounded
  (`TRIAGE_ACTIONS_MAX`, 500; oldest `at` evicted). The operator's per-ticket verdict on the
  auto stream.
- **`triagePolicies`** (`TRIAGE_POLICIES_FILE`, `/data/triage-policies.json`):
  `siteKey -> {minPriority?, excludeTypes?, repoAllow?, repoDeny?, rateMax?}` — the per-org knobs
  shaping WHAT an enabled org auto-starts. The `/autostart` on/off switch is still the master
  gate; the policy only adds constraints (an org with no policy object is unrestricted).
- Both are hub-owned exactly like the agent/model/runtime pins: **no agent-side flag, no tracker
  write**, so a verdict or policy takes effect with the org's hosts fully offline. Both ride the
  `/api/agents` payload and SSE. Malformed entries read as "no verdict" / "no policy" — degrade,
  never block a ticket.

## Per-ticket verdict — `POST /api/jira/<site>/<key>/triage`

- Body `{action:"approve"|"hold"|"reject"}` to set, `{clear:true}`/`{action:null}` to release back
  to the triage model + org policy. `400` on a bad key or action, `404` when no host reports the
  org, `200` authoritative (like the pin routes).
- Semantics in the sweep/drain:
  - **`approve`** forces eligibility past BOTH the triage gate and the org policy — but NOT past
    the ignore-tier / missing-repo filter; an approved ticket with no repo still won't start.
  - **`hold`** parks the card in the Triage lane; it never auto-starts until released.
  - **`reject`** drops it from the auto stream (a manual Start still works).
- Only AUTO entries consult the verdict; a manual click is deliberate intent and always drains.

## Org triage policy — `POST /api/jira/<site>/triage-policy`

- Body is a patch of the five knobs; `null` clears one. `minPriority` auto-starts that band and
  higher (P0 > P1 > P2 > P3); `excludeTypes` are triage types never auto-started; `repoDeny`
  beats `repoAllow` (a non-empty allow list restricts to it); `rateMax` (int 1..50) overrides
  `TICKET_QUEUE_RATE_MAX` for that org's window — the window length itself stays shared.
  `sanitizeTriagePolicy` coerces; `400` when a knob is malformed.

## The lane and the chip (board UI)

- The **Triage lane is the FIRST board column** — `CATEGORIES` begins `["triage","Triage"]`,
  before To Do. It is a VIEW over the To Do column, not a tracker category: `triageLaneOf`
  returns `"triage"` for a To Do ticket that is untriaged (no `triage` block) or `hold`;
  `categoryOf` and the column-rule mirrors are untouched, and `board.html` refuses drops ON the
  lane (it maps to no tracker status). A card in the lane is still a todo ticket — a session can
  start on it, and dragging it to a real column works (a live `moves` override always wins).
- **Verdict chip** (`triageChipHtml`): `.kc-triage.kc-triage-<action>` on the card — approve
  green, hold amber, reject red. The detail panel's **Triage row** (`triageFieldHtml` +
  `triagePickerHtml`, `data-triage-select`) follows the row-picker pattern: "Change" swaps the
  row for the picker, choosing an option IS the save, "Auto" is the release.

## Gate ordering (autoStartSweep → drainTicketQueue)

A To Do ticket is swept into the auto stream only when ALL of these pass; each drop is logged as
a throttled state line (`held`/`triaged`/`policy`/`p0preempt`), and a gated ticket spends **no
attempt** (no retry budget burned, exactly like a repo-less ticket):

1. **Repo present and not ignore-tier** (`repoGuess` or a manual pin; `isRepoIgnored`). Applies
   even to an `approve`.
2. **Retriage gate** (`triageGateReason`): no `triage` block → "untriaged"; `actionable !== true`
   → "not actionable"; `dedupeOf` set → "duplicate". An explicit `approve` overrides it.
3. **Operator verdict**: `hold`/`reject` drops the auto entry with no churn.
4. **Org policy** (`triagePolicyReason`); the first violated knob is reported. `approve` bypasses.
5. **Host routing** (`findTicketHost`; capacity clears `blockedSince`, a routing failure HOLDS up
   to 30 min) and the **rate window** (`autoStartRateLive >= autoStartRateMax` holds with reason
   "rate", self-clearing; a manual click is never held).

## Pausing on a maxed subscription (XERK-544 pace line, XERK-548 5-hour cap, XERK-555 manual)

- **A host whose Claude subscription has hit a LIMIT pauses**, for either of two triggers
  (`subscriptionLimitsPaused` = the OR of both, the one predicate the auto set + tests go through):
  - **7-day pace line** (XERK-544, `limitsPastPace`): `sevenDay.usedPct/100 >=` the fraction of the
    fixed 7-day window elapsed at now — XERK-536's `sevenDayPacing`, informational until this became
    its consumer. Resumes as the window elapses (the line moves ahead of the fill) or resets.
  - **5-hour cap** (XERK-548, `limitsFiveHourMaxed`): `fiveHour.usedPct >= FIVE_HOUR_PAUSE_PCT` (90).
    Resumes when the 5-hour window RESETS — detected without waiting for the next probe by treating a
    `resetsAt` that has PASSED as already-rolled-over (its used-% is then a stale high-water mark for
    a window that no longer exists).
- **AUTO pauses on EITHER trigger; a MANUAL Start pauses ONLY on the 5-hour cap** (XERK-555). The
  5-hour cap is a "will run out mid-window" wall — starting a fresh ticket into a near-exhausted
  window spends the headroom the running sessions need to finish it — so a deliberate manual click is
  held there too. The weekly pace line is a soft ration and never blocks a manual click. It never
  disables auto mode.
- It self-clears (auto-resume) for both — nothing is persisted, it is re-derived every read from live
  `limits` + `now`. A paused MANUAL start is not lost: it QUEUES (the POST route treats `paused` like
  `full`) and HOLDS in the hub queue until the window resets, bounded only by `TICKET_QUEUE_MAX_WAIT_MS`.
- **The filter lives in `findTicketHost`; the PATH decides WHICH triggers count, not whether the
  filter runs.** `pausedSubscriptions(now, {fiveHourOnly})` builds the set — the full OR for auto
  (`opts.auto`, threaded from `drainTicketQueue` / the reclaim precondition as `e.source === "auto"`),
  the 5-hour cap alone for a manual Start (no `auto`). Checked ahead of capacity like the runtime
  filter, so "every host that could run it is maxed" reads **paused** (`!anyUnpaused`, its own
  self-clearing return flag), not full — a freed slot would not un-pause it, only the window
  recovering. The pin branch reports the same, never routes around it.
- **`paused` is a SELF-CLEARING queue hold, distinct from `blocked`** (which only the operator can
  clear). `drainTicketQueue` holds it like `capacity` (waits to the max wait, never the 30-min blocked
  timer) but keeps its error so the card says WHY. Reason string `"paused"`, rendered
  "⏳ queued · usage paused" on web/glasses (`board.js` `queuedLabel`/`queuedTip`, re-vendored
  `board.cjs`) and Android (`Board.kt` `Queued.paused`, `BoardScreen.kt`). This also changed the AUTO
  pause hold from `blocked` to `paused` — more correct (the pause is self-clearing) and less churny
  (no 30-min drop + re-sweep cycle).
- **Only a host that would SPEND the pool is paused**: `!wantRuntime && (a.defaultRuntime||"claude")
  === "claude"`. A qwen/dsh pin, or a qwen/dsh-default host, spends no Claude subscription and is
  never paused (dsh/qwen have no window — `agent-usage.md`).
- **Per-SUBSCRIPTION, not per-host** (`pausedSubscriptions`): grouped by `subscription.key` (a
  keyless host keyed on itself) like the Usage page's `limitGroups`, the freshest non-stale reading
  decides — so a sibling with a good probe pauses one whose probe is missing/stale, and two hosts on
  SEPARATE accounts pause independently.
- **Staleness = "can't tell", never a pause** (`LIMIT_MAX_AGE_SEC`, hub mirror of usage.html's
  card-drop age): an ancient `capturedAt`, an absent/expired window, or a missing `usedPct` read as
  not-paused for that trigger.
- **The UI is a HUB-DERIVED per-agent `autoPaused` flag** on `/api/agents` (true for EITHER trigger),
  stripped from any agent-forged heartbeat value in `serializeAgent` and recomputed there (emitted
  only when true, so absent = not paused). Rendered as a dashboard host-header chip beside the
  login/board chips (`autoPausedBadge` in `index.html`; `FleetScreen.kt` Pill on Android). **No bypass
  control** by design. Not a board/glasses surface — the fleet dashboard has no glasses mirror.
- Tests: the `XERK-544:`/`XERK-548:`/`XERK-555:` cases in `server.test.js` (`limitsPastPace`/
  `limitsFiveHourMaxed`/`subscriptionLimitsPaused`/`pausedSubscriptions` incl. the `fiveHourOnly`
  narrowing, the auto-vs-manual `findTicketHost` with the manual 5-hour gate + unpaused-sibling
  routing, the manual queue-and-hold-then-run-on-reset, the 5-hour reset auto-resume, the qwen
  exemptions, the served flag + forged-flag strip, the paused-hold drain), `board.test.js` +
  `BoardTest.kt` (the `paused` queued reason), `dashboard-tiles.test.js` (the chip), android
  `AgentDecodeTest`.

Drain order is the stable sort on `triageSortKey` = `[priorityRank, typeWeight, -repoTierRank]`:
band → type → repo tier (XERK-487 [G] tiebreak) → board order. **A P0 may exceed the org's auto
share** (`TICKET_QUEUE_PER_ORG_AUTO_MAX`) — the fleet cap is its only bound (logged `p0preempt`).

## Mirrors that must agree

- **Web**: `turma/public/board.js` — `triageLaneOf`, `triageActionOf`, `triageChipHtml`,
  `triageFieldHtml`, `triagePickerHtml`, `triagePickerValue`; `board.html` carries the
  `.kanban-triage` / `.kc-triage` / `.kc-triage-*` / `.kc-queued*` styles.
- **Android**: full parity (lane, chip, verdict picker, policy editor) —
  `android/…/ui/BoardScreen.kt` (+ `BoardTriageTest`).
- **Glasses and the Veiller fork: PASSIVE read only** — they decode `ticketTriageActions` from
  `/api/agents` and pass it as `triageActions` into the vendored `board.cjs` `boardHtml`, so the
  lane + chips render exactly as on web/Android; they offer NO verdict/policy controls. So a
  change to `triageLaneOf`/`triageChipHtml` in `board.js` means re-vendoring `board.cjs` in
  `glasses/src/vendor/` and the Veiller fork's `miniapps/turma/src/ui/vendor/` in the same PR —
  both vendor tests pin byte-identity against `turma/public/board.js`.

## Tests

- `board.test.js`: `triageLaneOf`/`triageActionOf` placement, the lane-gathering `boardHtml` case,
  chip/field/picker units, "a live drag beats the Triage lane".
- `server.test.js`: the `/triage` and `/triage-policy` routes, `triageGateReason`,
  `triageSortKey`/drain order, the policy knobs + P0 preemption, hold/reject drops, and the
  `priority-writeback` sweep cases (XERK-483).
