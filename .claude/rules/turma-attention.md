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
  > working > sleeping > waiting > stalled > review > idle. A stopped session is `idle`.
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
- **`needs-you:test` is RESERVED** for the wait classifier (XERK-1572). Nothing produces it yet; the
  enum, the wire validator and the clients' chip map already accept it, so that child only adds the
  producer.

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

- **Dashboard "Needs you"** (`index.html` `needsYou`/`needsYouHtml`, Android `FleetScreen`
  `NeedsYouCard` + `core/Sessions.kt` `needsYou`): running sessions whose served state is
  `needs-you:*`, oldest `since` first — chip, name, age, host · repo · why; a row opens the session.
  Read off the served attention, never re-derived, so it matches the phone's alerts.
- **Sessions page Ready for review** is sorted by `since`, oldest first (`bySince`, Android
  `sortedBySince`, glasses phone `render.ts`); a card with no `since` keeps its createdAt place after
  them. The section is still DECIDED by each client's own `readyForReview` mirror. Each review card
  carries a `.why` line (`attentionWhy`: the why, minus a question's text the card already quotes, +
  "waiting 12m").
- Waiting cards read "⏳ waiting · …" (`backgroundWaitLabel`, Android `liveStateLabel`).

## The stalled alert

- **The SECOND exception to the one-alert-per-piece-of-work rule** (spend is the first): it says
  the work is STUCK, not ready. `notifKey stalled:<host>:<id>`, tag `hourglass` (Android routes it to
  General alerts), fired once per EDGE into `needs-you:stalled`, retracted on leaving it (XERK-154).
- **Precedence question > stalled > review**: a stalled session never also takes the review alert
  (`!stalled` on that gate), and a pending question makes the state `needs-you:question`, so the
  stalled alert neither fires nor stays (its dismiss fires on the edge).
- Fires only on an OBSERVED edge (a previous `sa.attn` in another state, not a recovery beat) — a
  session already stalled when the hub first judges it is not announced, as review isn't.
- Tests: the `XERK-1571:` cases in `server.test.js`; `attention:` in `sessions.test.js`; the Needs
  you case in `dashboard-tiles.test.js`; the wake case in `dashboard-livestate.test.js`; glasses
  `sessions.test.ts` + `phone/render.test.ts`; android `SessionsTest`, `SessionsFlattenTest`,
  `AgentDecodeTest`.

## The wake directive

- `_session_directive` appends `WAKE_SYSTEM_PROMPT` for a CLAUDE session only: "do not sleep in a
  shell: run `python3 -SsE <cli> wake <N>m <what to check>` and end the turn". Mechanics + why the
  CLI is spelled by absolute path: `agent-session-cli.md`. Slot policy v1: a sleeper HOLDS its slot
  (freeing it is the kill/resume child, XERK-1575).
