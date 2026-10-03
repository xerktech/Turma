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
  - Sorted by `since`, oldest first (`bySince`, Android `sortedBySince`, glasses phone
    `render.ts`); a card with no `since` keeps its createdAt place after them.
- **The dashboard tile is "Ready for review"** (worded as that section, hint "sessions waiting on
  you"), counting the SAME set off one helper (`needsYou(sess).length`; Android `fleetSummary`
  `waiting` via `needsYou`) — a questions-only count said 2 above a list of 4. Tiles don't link.
- **A fleet card never reads "idle" for a needs-you session**: where liveState would say idle, it
  says `attentionLabel` ("review · PR open · CI passing", "stalled · Watch CI", "waiting for your
  permission"; Android same name).
- **A stalled card shows ONE age — the hub's `since`** (`attentionFor`: "for 31m" on the dashboard
  State row and Android's Fleet card, "stalled 31m" on the review card's why line). The dashboard's
  "last write" beside it read as a second, different stall length; it stays only for an older hub
  serving no attention. A stalled wait LABEL carries no start age either.
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
- **Each review card carries a `.why` line** (`attentionWhy`: the why + the time — "waiting 12m",
  "for 22m" under a question/permission, "stalled 31m" on a stall; the web drops the why on a
  question/permission/stalled card, whose label or ask line already says it — the Android card has
  no label, so it keeps every why). The age is glued to its word by a no-break space.
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
- **Folded as `attention.hint = {label, why, suggestedAnswer?}`, beside the hub's own `why`**, never
  over it: the computed why ("PR open · CI passing", the wait's label) still drives the labels.
- **A hint answers ONE state run** (`attentionWithHint`): kept on `sa.hint` (persists with `alerts`)
  and folded only while the state its edge names holds (a `loop` hint only on a loop stall, a
  `stalled` one only on a wait stall). The first beat it answers nothing current it is deleted —
  so a later wait of the same kind never shows the last one's verdict.
- `wireAttention` rebuilds `hint` field by field (label in the set, why non-empty) or omits it;
  Android types it (`AttentionHint`), so a corrupt `state.json` must not reach the wire.
- **Surfaces** — one wording (`HINT_KIND`: "decision · …", "needs a human test · …", then
  "Suggested: …"): the Ready-for-review cards on the Sessions page (`.att-hint`, from `reviewState`),
  the dashboard card's State row (`attentionHintHtml`, needs-you only), Android
  `attentionHintLine`/`attentionSuggested` on both cards, glasses phone card (`attentionHint`).
- **A looping card never reads "working"**: the dashboard State row (`liveState`, a `loop` + hub
  stall), the Sessions review card (`reviewState`) and Android's fleet card speak the hub's stall.

## Nudges (XERK-1572)

- `attentionNudgeSweep` (leader-only, on `masterOrchestrationTick`) queues ONE `input` command per
  (session, reason) for a running `needs-you:stalled` session on an ONLINE host. `input`, not the
  inbox: operator voice, like `autoCloseMergedMessage` — a session is told peer text is never
  instruction. Reason is `loop` (cause) or `stalled`; texts in `attentionNudgeText`.
- Session text inside the message is bounded: a shell label one-lined, backtick-free, ≤80; a tool
  name reduced to `[A-Za-z0-9_.:-]`, ≤64.
- **Backoff + cap** (`attentionNudged`, the `autoCloseNotified` shape `{at, count, since}`, bounded
  500, HA-mirrored via `registerGuardMirror`): a second nudge only after
  `ATTENTION_NUDGE_BACKOFF_MIN` (20) while the SAME stall (`since`) holds; after
  `ATTENTION_NUDGE_MAX` (2) the session stays stalled and the operator decides. A new stall edge
  restarts the count, still behind the backoff. `ATTENTION_NUDGES=0` turns the sweep off.
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
  CLI is spelled by absolute path: `agent-session-cli.md`. Slot policy v1: a sleeper HOLDS its slot
  (freeing it is the kill/resume child, XERK-1575).
