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
