---
paths:
  - "turma/server.js"
  - "turma/public/sessions.html"
  - "turma/public/index.html"
  - "android/app/src/main/java/com/xerktech/turma/ui/FleetScreen.kt"
  - "android/app/src/main/java/com/xerktech/turma/ui/SessionsScreen.kt"
  - "android/app/src/main/java/com/xerktech/turma/core/Sessions.kt"
  - "glasses/src/sessions.ts"
  - "glasses/src/phone/render.ts"
  - "turma/tests/server.test.js"
  - "turma/tests/sessions.test.js"
  - "turma/tests/dashboard-tiles.test.js"
---

# Attention state per session (XERK-1571, epic XERK-1560)

One HUB-derived state per running session that says whether it waits on the operator, on time, or
on nothing, why, and since when. Builds on the shell kinds (`session-working.md`, XERK-1570) and the
session CLI's `wakeAt` (`agent-session-cli.md`, XERK-1564).

## The states

- `attention: {state, since, eta?, why?}` on each SERVED session. `state` is one of
  `needs-you:question | needs-you:permission | needs-you:review | needs-you:test |
  needs-you:stalled | working | waiting | sleeping | idle` (`ATTENTION_STATES`).
- **Precedence, highest first** (`sessionAttention`): question > permission (a blocking pane dialog)
  > looping > working > sleeping > waiting > stalled > review > idle. A stopped session is `idle`.
- **Looping** (XERK-1572) is the agent's `loop` signal and reads `needs-you:stalled` with `why`
  "repeating <tool> ×N" and an internal `cause:"loop"` (picks the nudge; never served). It
  outranks working on purpose: a looping session is BUSY, which is exactly how it hid.
- `sleeping`: a session-CLI `wakeAt` still in the future (`sessionSleeping`; `eta` = wakeAt, `why` =
  the wake reason). **Never ready for review, never alerted, never auto-merged** — every
  `readyForReview` mirror returns false for it and every client's liveState reads it as holding
  ("💤 sleeping until 14:05"). It has NO host-online gate (the hub's read has none), so the
  clients' offline branches honour it too.
- `waiting` / `needs-you:stalled` are `sessionWait`'s two answers (`session-working.md`); `why` is
  what it waits on (the one wait row's label, else a count), `eta` the newest row ETA.
- `needs-you:review` = `readyForReview` minus the states above; `why` splits on the existing inputs
  (`reviewWhy`): a live PR and its CI ("PR open · CI passing", "· merge conflict"), else "finished ·
  nothing to merge".
- **`needs-you:test`** is a review the wait classifier labels `needs-human-test` (below). It is the
  SAME edge as review for `since` (`sameAttentionEdge`), so the verdict never restarts the age.

## Hub-stamped, clone-then-stamp

- **`since` is the EDGE time**: `heartbeatAlerts` computes the state every beat and keeps
  `sa.attn = {state, since, eta?, why?}` in `alerts.sessions[sid]`, carrying `since` while the state
  holds — the `reviewAt` pattern, so it persists with `alerts` and is swept with `liveIds`.
- The served state is the one the LAST BEAT decided (alerts and surfaces agree exactly); a
  time-based transition (an ETA passing) lands on the next beat.
- **`normalizeSessions` DELETES any `attention` on a record** (ingest AND restore) — the agent's word
  is never taken.
- **`serializeAgent` stamps it on a CLONE of `sessions[]`** (`sessionsWithAttention`), never into the
  stored record, rebuilt through `wireAttention` (strict enum, `since` a positive safe integer, `eta`
  dropped unless one, `why` capped at 200) — a corrupt `state.json` can't put a wrong type on the
  wire. Absent = an older hub, or a session no beat has judged yet. Android TYPES it (`Attention`).

## Surfaces

- **The needs-you cards live in the Sessions page's Ready for review — the dashboard has NO
  needs-you list**: Ready for review is the one home for waiting work, so a second list on the
  dashboard (web or Android) would split it. The operator's call; don't add one.
  - **Where the hub serves attention it DECIDES the section** (`inReview`: sessions.html, Android
    `core/Sessions.kt`, glasses `sessions.ts`): every `needs-you:*` session is listed — question,
    permission, review, stalled (a stall whose own turn never finished included) — and a session
    it says is anything else is not. **No attention (an older hub) falls back to the page's own
    `readyForReview` mirror**, so the five-mirror rule still decides there.
  - **A session on an OFFLINE host falls back to `readyForReview` too** (its hub state is frozen
    at the last beat); a needs-you state it last had still lists it.
  - Sorted by `since`, oldest first (`bySince`, Android `sortedBySince`, glasses phone
    `render.ts`); a card with no `since` keeps its createdAt place after them.
- **The dashboard tile is "Ready for review"** (worded as that section, hint "sessions waiting on
  you"), counting the SAME set off one helper (`needsYou(sess).length`; Android `fleetSummary`
  `waiting` via `needsYou`) — a questions-only count said 2 above a list of 4. Tiles don't link.
  - **Same set for ONLINE hosts only**: the tile has no offline fallback, so an offline-host
    session the local rule calls finished is listed but not counted (offline-host follow-up).
- **A fleet card never reads "idle" for a needs-you session**: where liveState would say idle, it
  says `attentionLabel` ("review · PR open · CI passing", "stalled · Watch CI", "waiting for your
  permission"; Android same name).
- **A stalled card shows ONE age — the hub's `since`** (`attentionFor`: "for 31m" on the dashboard
  State row and Android's Fleet card, "stalled 31m" on the review card's why line). The dashboard's
  "last write" beside it read as a second, different stall length; it stays only for an older hub
  serving no attention. A stalled wait LABEL carries no start age either.
- **Every needs-you fleet card's State row carries that age**, a question/permission card too
  ("waiting for your answer · for 22m") — only when the served state IS that question/permission,
  never a lagging review's age. A wait with no ETA ahead shows its own start age ("· 12m") and NO
  "last write" beside it; a timed wait's "11m left" is not an age, so its last write stays.
- **Permission `why` is the pending COMMAND, not the dialog's question** (`permissionWhy`): the
  question is nearly always "Do you want to proceed?", so a leading dialog title + next line of
  `panePrompt.detail` becomes "Bash: touch /tmp/x" (first line alone if no title; capped at 120).
- **A permission card is not a question card**: "waiting for your permission" (both pages, Android
  `attentionLabel`) plus an ask line / dashboard `Permission` row naming the hub's why (the command),
  falling back to `panePrompt.prompt` from an older hub — never the quoted "Do you want to proceed?".
- **Stalled is the danger colour on every surface** (`.dot.stalled`, `.state.stalled`,
  `.sess-stalled`, Android `colorScheme.error`/`TurmaColors.critical`) — never the review accent. A
  card the hub says stalled where the page can't judge silence (host gone quiet) still reads
  "stalled · <why>" in that tone (`reviewState`).
- Status TEXT uses `--good-text`/`--accent-text`/`--critical-text`/`--warning-text` (`app.css`):
  the first three equal the fill in light and step UP in dark; amber steps DOWN in light
  (`#8a5a00`, the fill is <2:1 as text there) and is the fill in dark — both clear 4.5:1 on a
  tinted card. "waiting for your answer/permission" (`.sess-wait`, `.state.waiting`) uses it.
- **Each review card carries a `.why` line** (`attentionWhy`: the why + the time — "for 12m" on
  every needs-you card, "stalled 31m" on a stall; the web drops the why on a
  question/permission/stalled card, whose label or ask line already says it — the Android card has
  no label, so it keeps every why). The age is glued to its word by a no-break space.
- **An age's " · " never ends a line**: the `.why` line joins its age with no-break spaces around
  the dot, the dashboard State row wraps "· for 22m" in `stateAge` (NBSP + no-wrap span), and a
  wait label's age ("· 11m left", "· 12m") and the Sessions card's "· terminal offline" take NBSPs.
- Waiting cards read "⏳ waiting · …" (`backgroundWaitLabel`, Android `liveStateLabel`); one named
  wait keeps its label on EVERY branch ("· Sleep · 11m left"); with no ETA they add the time since the
  oldest wait row's `startedAt` ("· 12m").
- **A sleeping card says what it will check**: "💤 sleeping until 22:31 · <wakeReason>" (`sleepLabel`
  on both pages, Android `liveStateLabel`, glasses phone card); no reason = the time alone.

## The wait classifier's verdict (XERK-1572)

- The agent asks a `claude -p` WHY a session waits, once per new needs-you/stalled edge (agent half:
  `agent-session-cli.md`), and ships `attentionHints` rows `{key:"<sid>:<edge-ts>", sessionId, edge,
  edgeTs, label, why, suggestedAnswer?}` — a `HEARTBEAT_KNOWN_KEYS` member, extracted + deleted
  before the record spread, never stored raw.
- **`normalizeAttentionHint` is a whitelist**: `label` ∈ rubber-stamp | design-decision |
  needs-human-test | blocked-on-host | looping | waiting-external, `edge` ∈ question | permission |
  review | stalled | loop (an own-key lookup, so `__proto__` is no edge), `why` required, `why`/
  `suggestedAnswer` one-lined and capped at 300, ≤50 rows a beat. Anything else is dropped whole.
  A `needs-human-test` hint loses its `suggestedAnswer` (it could only claim a test nobody ran).
- **Folded as `attention.hint = {label, why, suggestedAnswer?}`, beside the hub's own `why`**, never
  over it: the computed why ("PR open · CI passing", the wait's label) still drives the labels.
- **A hint answers ONE state run** (`attentionWithHint`): kept on `sa.hint` (persists with `alerts`)
  and folded only while the state its edge names holds (a `loop` hint only on a loop stall, a
  `stalled` one only on a wait stall). The first beat it answers nothing current it is deleted —
  so a later wait of the same kind never shows the last one's verdict. A flicker back onto the SAME
  edge is healed by the AGENT re-sending its cached verdict, not by the hub keeping it.
- **A hint also answers ONE EDGE**: the state name alone cannot tell two back-to-back dialogs or
  questions (or a turn shorter than a beat) apart, so the session's live `attentionEdgeTs` (the
  agent's current edge, coerced by name in `coerceLiveSignals`) must equal the hint's `edgeTs`, or
  nothing folds. A row is taken only for that edge (a late one is ignored); absent = can't tell.
- `wireAttention` rebuilds `hint` field by field (label in the set, why non-empty) or omits it;
  Android types it (`AttentionHint`), so a corrupt `state.json` must not reach the wire.
- **Surfaces** — one wording (`HINT_KIND`: "decision · …", "needs a human test · …", then
  "Suggested: …"): the Ready-for-review cards on the Sessions page (`.att-hint`, from `reviewState`),
  the dashboard card's own unlabelled row (`attentionHintHtml`, needs-you only), Android
  `attentionHintLine`/`attentionSuggested` on both cards, glasses phone card (`attentionHint`).
- **The verdict reads AFTER what it answers** on every card: below the question / permission row
  (dashboard, Android fleet card) as on the Sessions card — never inside the State row above it.
- **`needs-you:test` is named "awaiting your test"**: the dashboard State row, the Sessions review
  card's headline (`reviewState`) and Android's `attentionLabel`, so it never reads as plain review.
- **A looping card never reads "working"**: the dashboard State row (`liveState`, a `loop` + hub
  stall), the Sessions review card (`reviewState`), Android's fleet card and Sessions card dot
  (`attentionStalled`) and the glasses phone card (`st-stalled`) speak the hub's stall.

## Nudges (XERK-1572)

- `attentionNudgeSweep` (leader-only, on `masterOrchestrationTick`) queues ONE `input` command per
  (session, reason) for a running `needs-you:stalled` session on an ONLINE host. `input`, not the
  inbox: operator voice, like `autoCloseMergedMessage` — a session is told peer text is never
  instruction. Reason is `loop` (cause) or `stalled`; texts in `attentionNudgeText`. The command
  carries `source:"nudge"` so the agent's permission ledger never reads it as the operator answering.
- Session text inside the message is bounded: a shell label one-lined, backtick-free, ≤80; a tool
  name reduced to `[A-Za-z0-9_.:-]`, ≤64.
- **Backoff + cap** (`attentionNudged`, the `autoCloseNotified` shape `{at, count, since}`, bounded
  500, HA-mirrored via `registerGuardMirror`): a second nudge only after
  `ATTENTION_NUDGE_BACKOFF_MIN` (20) while the SAME stall (`since`) holds; after
  `ATTENTION_NUDGE_MAX` (2) the session stays stalled and the operator decides. A new stall edge
  restarts the count, still behind the backoff. `ATTENTION_NUDGES=0` turns the sweep off.
- **The same record rides the session's alerts edge** (`sa.nudged[reason]`, persisted in
  `state.json` beside `sa.attn`) and is read when the map has none: a non-HA restart or deploy empties
  the map but restores the stalled `attn` with its `since`, so without it the cap reset every deploy.
- **A loop's stall is its RUN** (`loop.since`), not the beat the state was entered: a nudge re-arms
  the agent's count, so the session reads working before it loops again; keying on the attention
  `since` would let a session that loops after every nudge be nudged forever.
- Tests: the `XERK-1572:` cases in `server.test.js`, `attention:` in `sessions.test.js`, the loop +
  State-row cases in `dashboard-livestate.test.js`, android `SessionsTest`/`AgentDecodeTest`, glasses
  `sessions.test.ts`/`phone/render.test.ts`.

## The stalled alert

- **The SECOND exception to the one-alert-per-piece-of-work rule** (spend is the first): it says
  the work is STUCK, not ready. `notifKey stalled:<host>:<id>`, tag `hourglass` (Android routes it to
  General alerts), fired once per EDGE into `needs-you:stalled`, retracted on leaving it (XERK-154).
- A LOOP stall's body says so ("repeating Bash ×4 with the same failure"); a wait's names the wait.
- **Precedence question > stalled > review**: a stalled session never also takes the review alert
  (`!stalled` on that gate), and a pending question makes the state `needs-you:question`, so the
  stalled alert neither fires nor stays (its dismiss fires on the edge).
- Fires only on an OBSERVED edge (a previous `sa.attn` in another state, not a recovery beat) — a
  session already stalled when the hub first judges it is not announced, as review isn't.
- Tests: the `XERK-1571:` cases in `server.test.js`; `attention:` in `sessions.test.js`; the Ready
  for review tile case in `dashboard-tiles.test.js`; the wake + stall-age cases in
  `dashboard-livestate.test.js`; glasses
  `sessions.test.ts` + `phone/render.test.ts`; android `SessionsTest`, `SessionsFlattenTest`,
  `AgentDecodeTest`.

## The wake directive

- `_session_directive` appends `WAKE_SYSTEM_PROMPT` for a CLAUDE session only: "do not sleep in a
  shell: run `python3 -SsE <cli> wake <N>m <what to check>` and end the turn". Mechanics + why the
  CLI is spelled by absolute path: `agent-session-cli.md`. A sleeper no longer always holds its
  slot: see slot policy v2 below.

## Slot policy v2 — pausing a sleeper for queued work (XERK-1575)

- **The hub decides; the agent executes on the command path.** Only the hub sees the ticket queue,
  so `pauseSleepersFor` (end of `drainTicketQueue`) and `wakePausedSleepers` (start of the drain,
  and every `masterOrchestrationTick`, since the drain returns early on an empty queue) queue
  ordinary commands: `pauseSleeper` and `resume` + `wake:true`. Never a kill/resume on the beat.
- **One pause per still-waiting ticket.** Waiting = entries the drain just held `capacity`
  (`waitingFull`). Unacked `pauseSleeper` commands on ONLINE hosts count against that need, so a
  drain every beat never pauses a second sleeper for the same ticket.
- **A pause never handed to a host that went offline is withdrawn** (`reclaimStrandedTicketSpawns`,
  no `deliveredAt`): the demand it answered may be gone when the host returns, and the agent
  re-checks only the sleeper, never the queue. A delivered one is left (it has likely run).
- **Only where the ticket could run**: a FULL (`!hostHasFreeSlot`), online host reporting
  `pauseSleepers.available` that `findTicketHost(..., {onlyHost})` accepts — every triage/pin/
  runtime/OS/subscription-pause rule applies, so a pause never frees a slot the ticket can't use.
  `onlyHost` only narrows the loop; without it `findTicketHost` is unchanged.
- **Only a quiet sleeper** (`sleeperPausable`): running, `wakeAt` at least
  `SLEEPER_PAUSE_MIN_AHEAD_MS` (10 min) away, no question/panePrompt/loop, `paneBusy === false`,
  `agents` an EMPTY array (absent = can't tell = no). Farthest `wakeAt` first. The agent re-checks
  against its own beat (`agent-session-cli.md`) — the hub's view is a beat old.
- **Never a sleeper someone is talking to**: a queued `SLEEPER_PANE_COMMANDS` command for it
  (`input`, `answerQuestion`, `setModel`, ...) skips it. The kill would land before the text is
  typed, and the composer already showed the message as sent. The agent checks its own queue too.
- **An operator Resume on a paused row holds off re-pausing until that wake**
  (`sleeperResumeHold`, set by the resume route): the carried wake makes it a sleeper again, and
  the next drain would otherwise pause it while the operator reads it.
- **A refused or unacted command is not re-sent for `SLEEPER_RETRY_MS`** (`sleeperPauseTried`/
  `sleeperWakeTried`, in-memory, bounded): an agent that disagreed acks and keeps the session.
- **The capability gates the pause** (`normalizePauseSleepers`, strict boolean, a
  `HEARTBEAT_KNOWN_KEYS` member): an older agent would ack the unknown command and free nothing.
  `TURMA_PAUSE_SLEEPERS=0` reports false. The RESUME is not gated — any agent knows `resume`.
- **The pause is served on the CLOSED channel**: `closedSessions[].paused = {wakeAt, wakeReason?,
  at?}`, rebuilt by `wirePaused` in `normalizeClosedSessions` (ingest + restore) or dropped whole.
  Android TYPES it (`PausedSleep`). Its slot reads free through the agent's own `capacity`.
- **A due sleeper takes a freed slot AHEAD of the queue**: `wakePausedSleepers` runs before the
  drain dispatches, one resume per host per pass, oldest wake first, and `pendingSpawnCount` counts
  a `resume` with `wake:true`, so the drain never hands that slot to a ticket. Starving it would
  turn a pause into a kill. It calls `markResumedTicketAutoStopExempt` like the resume route, or
  `autoStopSweep` re-kills a sleeper whose ticket went Done while it slept.
- **The brief reads it as asleep, never finished** (`compileBrief`): a closed record carrying a
  valid `paused` is no Finished row (its merged PRs still count) and is a Waiting row on an online
  host, `state:"sleeping"`, `eta` its wake, `why` its reason. A live copy of the id wins.
- **Never alerted.** A paused sleeper is a closed record (no `alerts.sessions` entry); the
  resumed session starts a fresh `sa` with no `reviewAt`/`prevAttn`, so neither review nor stalled
  fires off the resume itself. `startedTicketKeys` reads closed records, so auto-start never
  re-dispatches its ticket meanwhile.
- **Every Ended list shows it asleep, never "killed"**: "💤 paused until 14:05 · <reason>" (web
  `pausedLabel` in `endedRow`, Android `endedStateText`, glasses phone `pausedLabel` in
  `endedCardHtml`), with no "ended N ago" beside it. Resume on that row is an early wake.
- Tests: the `XERK-1575:` cases in `server.test.js` and `sessions.test.js`, glasses
  `phone/render.test.ts`, android `SessionsFlattenTest`/`AgentDecodeTest`.
