---
paths:
  - turma/server.js
  - turma/tests/server.test.js
---

# Epic auto-orchestration run (XERK-635/636/637, epic XERK-633)

The hub's machinery for "work an epic's children in dependency order, start/close hands-off".
XERK-635 (B) is the HUB STATE — the durable run record, its dependency DAG, the manual-start route,
and the never-auto-start gate. XERK-636 (C) is the DRIVER that dispatches ready children. XERK-637
(D) ADVANCES + COMPLETES the run — auto-merge/close a run's children and write the epic Done. The
board UI (E) is a later subtask; do not add it here.

Depends on XERK-634, which put `blocks`/`blockedBy`/`epicKey`/`isEpic` on every ticket
(`normalizeJira` coerces them). This subtask consumes those fields; it collects nothing itself.

## The durable store (`epicRuns`)

- **Hub-owned durable state, the exact shape/lifecycle of `autoStartOrgs` / `triagePolicies`**: a
  `/data` JSON file (`EPIC_RUNS_FILE`, NOT `state.json`), its own SSE frame (`sseBroadcast("epicRuns",
  …)`), and a top-level key on `/api/agents`. Keyed `"<siteKey>/<epicKey>"` (`epicRunKey`).
- **It MUST persist.** An in-memory-only run would replay stale intent as a BURST of child starts
  after every hub restart — the same reason the ticket queue is in-memory but this is not.
- **Run record**: `{epicKey, siteKey, state, children[], waves[][], cycle?[], startedAt, updatedAt}`.
  `state ∈ {running, blocked, done}` (`EPIC_RUN_STATES`); `waves` is the topological layering;
  `cycle` is present only when a dependency loop stalls children. `startedAt` is preserved across
  re-arms.
- **Loaded with a per-field whitelist at boot** (`sanitizeEpicRunRecord`), so a hand-edited or
  older-build file can't put an unexpected shape into memory or onto the wire; a malformed record is
  DROPPED, not restored. Its bounds are INLINE LITERALS (64 key / 200 site), never the
  `TICKET_KEY_MAX` / `TICKET_SITE_MAX` consts — it runs at module-init where those consts are in
  their TDZ (the sibling-normalizer rule). Bounded: `EPIC_RUNS_MAX` runs (oldest `updatedAt` evicted,
  never the just-armed one), `EPIC_RUN_CHILDREN_MAX` per list — both ride the payload/SSE.
- **Older clients degrade**: `epicRuns` is a NEW top-level payload key, so an older web/Android build
  ignores it. Nothing is per-agent, so `normalizeRecord` is untouched.

## The DAG (`buildEpicWaves`)

- Pure, testable: `(childRows) -> {waves: [[key]], cycle: [key]}`. `childRows` are the epic's
  children (each a ticket row with `key` + `blockedBy`).
- **Only blockers WITHIN the child set order the waves.** An external blocker (a key outside the
  epic) is a READINESS concern for the driver (C), not a wave-ordering one; self-blocks are dropped.
- Kahn layering, **input order kept stable within a wave** (deterministic for tests): a diamond
  A→{B,C}→D yields `[[A],[B,C],[D]]`.
- **A cycle is ANNOTATED, never a silent deadlock**: children that can never be placed land in
  `cycle`, and `armEpicRun` sets `state:"blocked"`. The acyclic remainder still lays out in `waves`.
- `epicChildRows(siteKey, epicKey, rows)` resolves the children from `fleetTicketRows()` — the
  board's own resolved view (XERK-634 `epicKey`), never a raw walk of `agents`.

## The manual-start route — `POST /api/jira/<site>/<epicKey>/epic-run`

- **The SOLE trigger for the whole run.** Operator-authed, 200-authoritative like the pin/triage
  routes. Body `{}` (or omitted) ARMS/re-arms; `{clear:true}`/`{cancel:true}` cancels;
  `{pause:true}`/`{resume:true}` holds/continues an armed run (XERK-641, below).
- Validation: `400` bad key; `404` no host reports the org; **`404` when the key is not a real epic
  the fleet lists** (`isEpic !== true`) — a run is never armed for a phantom or a work ticket;
  **`404` on pause/resume when no run is armed** (`setEpicRunPaused` returns null) — never a silent arm.
- `armEpicRun(siteKey, epicKey, rows)` rebuilds the DAG from the current board rows, derives state
  (`blocked` if a cycle; `done` if every child already Done; else `running`), persists, broadcasts.

## Pause / resume — the operator hold (XERK-641)

- **`paused` is a boolean flag on the run record, ORTHOGONAL to `state`** (running/blocked/done are
  DAG progress; `paused` is operator intent). Set by `setEpicRunPaused(siteKey, epicKey, bool)` off
  the route; persisted, SSE-broadcast, and coerced by `sanitizeEpicRunRecord` (STRICT `=== true`
  only) so a hold survives a restart. Omitted when false. Older clients ignore the new key.
- **A paused run is FULLY INERT to the automation** — the kill-switch a Cancel is too destructive
  for. It preserves the DAG + children + progress (unlike `clearEpicRun`), so Resume continues from
  exactly where it held. Three sweeps skip it, and they MUST stay in agreement:
  - `epicRunDriveSweep` — `continue`s a paused run, dispatching NOTHING and advancing NOTHING.
  - `epicRunChildSession` — returns null for a paused run's children, so `autoMergeSweep` /
    `autoCloseSweep` leave already-running child sessions ALONE (not merged, closed, or killed).
  - `epicRunCompleteSweep` — `continue`s a paused run, so it never writes the epic Done while held.
  - `anyArmedEpicRun` EXCLUDES paused runs (`state !== "done" && !paused`) — a paused run is not a
    reason to run the XERK-550 sweeps, and its children are skipped anyway.
- **A re-arm PRESERVES the hold** (like `startedAt`): arming is "rebuild the plan", not "resume it"
  — only `{resume:true}` lifts a pause. So a paused-then-re-armed run stays held.
- This is the "already-running sessions are left alone, just don't start more" contract: pause stops
  NEW child starts and freezes the run's own merge/close, while in-flight child sessions keep running
  untouched until Resume. Board UI + Android render a `paused` chip and a Pause/Resume control (Pause
  on a running/blocked run, Resume on a paused one; a `done` run offers neither).

## The driver — `epicRunDriveSweep` (XERK-636)

- **The sibling of `autoStartSweep` / `drainTicketQueue`**: on the 15s sweep, just BEFORE
  `drainTicketQueue` (so a child queued here dispatches in the same tick), it walks every run that is
  not `done` and queues the READY children the fleet isn't already handling. Epics + children are
  excluded from `autoStartSweep` (XERK-635), so the two streams never contend for one ticket.
- **It adds NO launch code, NO routing of its own, and NO second pause path.** Every one of those is
  inherited by going through the SAME hub ticket queue (XERK-296) + `findTicketHost` the Start button
  and auto-start use: parallelism (multiple ready children routed to available hosts, one-per-host-
  per-drain-pass), capacity/queue backpressure, and the subscription pause (XERK-544/548/555).
- **Children are queued as `enqueueTicketStart(..., "manual")`** — arming a run is a deliberate
  operator commitment to finish the epic, so a ready child queue-and-holds exactly like a manual
  Start (XERK-555): paused ONLY by the 5-hour cap, never the weekly pace ration. Do NOT switch this
  to `"auto"` — `drainTicketQueue`'s auto branch would DROP an epic child whenever the org's
  `autoStartOrgs` switch is off (a run is independent of that switch) and re-gate it on triage policy.
- **A manual entry SKIPS `drainTicketQueue`'s own auto guards, so the driver owns the whole double-
  start defence itself**: `startedTicketKeys` (a session on any channel), `spawnTicketInFlight` (a
  spawn riding a queue), `committedTicketSpawn` (one committed to a host), and `liveQueuedTicket` (a
  live place in line) — any one means the child is already coming up, whether the sweep or a board
  click put it there. Also skips a child that isn't To Do, or has no triaged / ignore-tier repo
  (silently — re-checked next sweep, never a churny blocked note).
- **It carries its OWN growing backoff (`epicChildAttempts`), the twin of auto-start's `autoStarted`
  (XERK-61/109) — the driver is a manual-source path, so `drainTicketQueue` never stamps `autoStarted`
  for it.** The hub ACKS a `spawnTicket` whether the agent ran it or refused it, so a child dispatched
  to a host that acks-without-a-session (an uncloneable repo, a per-host triage disagreement, a
  mid-spawn error) reads un-started on the very next sweep; without the backoff the driver would
  re-dispatch it every 15s forever. Stamped at enqueue (only reached when the child is NOT already
  started/queued/in-flight), gated on `now < nextAt`, grown 1/2/4/8/10min capped, CLEARED the moment a
  session appears or the child leaves To Do; queue-full spends no attempt (capacity is the queue's
  concern, not the agent's). Also closes the ack-before-session-visible double-start window — a
  just-dispatched child is backoff-held for the beat or two before its session first heartbeats.
  Bounded by `EPIC_CHILD_ATTEMPTS_MAX` (oldest-first eviction, a re-stamp on next attempt).
- **Readiness = all-blockers-Done** (`epicChildBlockersDone`): an in-epic blocker (a key in
  `run.children`) is AUTHORITATIVE and must be a confirmed Done row — a poll gap hiding it HOLDS the
  child, never races ahead. A VISIBLE external blocker holds only while it's not Done; an unresolvable
  external blocker (no host reports it) is treated as satisfied, so an invisible cross-project ticket
  can't deadlock the run. This is the driver's readiness concern; `buildEpicWaves` only ORDERS by
  in-set blockers.
- **The driver re-derives run STATE as children complete** (`advanceEpicRunState`): a `running` run
  whose every child has reached Done becomes `done` (and drives nothing more); a cycle-`blocked` run
  is LEFT blocked (only a re-arm rebuilds the DAG — its acyclic children still drive while blocked,
  since a cyclic child never becomes ready). Persists + broadcasts like `armEpicRun`, only on change.

## The never-auto-start gate

- **An epic AND its children are excluded from the org auto-start stream** (`autoStartSweep`): an
  epic is never a work ticket, and a child is started by its epic run in dependency order, not the
  org stream. `isEpicOrEpicChild(t)` (reads XERK-634 `isEpic`/`epicKey`) is the one predicate.
- Applied in TWO places that MUST agree — the `autoStartSweep` candidate filter (dropped silently,
  spending no attempt, exactly like a repo-less ticket) AND `autoStartContentGate` (returns
  `{kind:"epic"}`). The XERK-550 cross-check test pins the sweep and the content gate to the same
  set, so a change to one without the other fails it. Excluding a child from the content gate also
  keeps it out of the org AUTO-MERGE stream (`autoMergeSession`) — correct: the epic run owns a
  child's whole lifecycle, close included.

## Advancing + completing the run (XERK-637 [D])

D advances an ARMED run and completes it. It reads B's run record and reacts to the LIVE board's Done
edges — it NEVER recomputes the DAG (that is C's readiness job, XERK-636); B's `waves`/`children` are
static and the only thing that changes is a child's board Done-ness.

- **A child of an armed, non-terminal run rides the SAME XERK-550 sweeps.** `epicRunChildSession`
  returns the `{siteKey,key,row,repo}` shape `autoMergeSession` does, and both `autoMergeSweep` +
  `autoCloseSweep` act on `autoMergeSession(s) || epicRunChildSession(s)`. The two are DISJOINT by
  construction (autoMergeSession nulls on any epic child via the content gate), so the OR is safe.
- **Arming the run is the hands-off opt-in — it OVERRIDES the org auto-merge toggle AND the bug-only
  floor.** An epic's children are tasks/stories, not just bugs, and the operator armed the run
  deliberately (operator-confirmed for XERK-637). So `epicRunChildSession` requires neither
  `autoMergeOrgs[site]` nor `AUTO_MERGE_ISSUE_TYPES` — only membership in an armed run's `children`
  and a non-Done row. This is why XERK-635 excludes epic children from the ORG stream: the run owns
  their whole lifecycle (merge + close), and an UNARMED epic's child stays fully excluded (regression-
  pinned).
  - **This IS the run-scoped bug-floor bypass XERK-642 names** — the lifting of `AUTO_MERGE_ISSUE_TYPES`
    for a run's children was already delivered by D (XERK-637); XERK-642 is the ticket that pins it as
    a deliberate exception to turma-board.md's "never widen past bugs" floor and pins both directions in
    one place (`XERK-642:` in `server.test.js`). The scope key is HUB-OWNED run membership
    (`run.children.includes(t.key)`), never the agent-asserted `epicKey` alone — a ticket merely
    claiming epic membership is NOT enough (a child not in `run.children`, or with no armed run, keeps
    the bug floor). Do NOT re-implement this inside `autoMergeSession`: the disjoint-function + OR
    keeps every other XERK-550 gate (readiness, per-repo serialization, retry classification, backoff)
    shared and unduplicated.
- **Both sweeps early-return unless `orgsWithAutoMerge().size || anyArmedEpicRun()`** — an armed run
  is the second reason to run them. `anyArmedEpicRun` = any run whose `state !== "done"`.
- **Chaining is C's, not D's.** The Done edge D produces (auto-close) or a human move is what C's
  driver re-evaluates to start the next wave. D adds NO wave-start code.
- **Epic completion (`epicRunCompleteSweep`, on the 15s interval after `autoCloseSweep`)**: once every
  `run.children` is Done on the board (reusing C's `epicRunAllChildrenDone`), write the EPIC to Done
  (XERK-138 write-back via `pickBoardWriteHost`) and ensure the run is terminal (`state:"done"`). The
  epic is an ORGANIZER — this is the ONLY step that transitions it, and the never-auto-start gate
  keeps it off every spawn path.
  - **The epic-Done WRITE is keyed off the BOARD + a once-guard, NOT the run's `state` — load-bearing
    next to C's `advanceEpicRunState`.** C sets a completed run's `state:"done"` in the SAME tick
    (`epicRunDriveSweep` runs before this sweep), and `armEpicRun` sets it for a run ARMED
    already-complete (which C then skips) — either would suppress the write if it gated on `state`. So
    D fires when `!epicIsDone(epic) && !epicDoneWritten.has(tkey)`. **C owns the run-STATE lifecycle;
    D owns the epic-Done tracker WRITE** — C never writes the epic, D's `state:"done"` set is only a
    fallback (a no-op once C ran, but it still completes a CYCLE-blocked run whose children a human all
    moved Done, which C deliberately leaves blocked).
  - **Orphan guard (autoCloseSweep's):** queue the epic-Done write BEFORE going terminal — if no
    board-cred host can take it (`agentGapError`), stand down and retry, never mark the run done behind
    an unmade write.
  - **Once-per-run:** `epicDoneWritten` (in-memory, this lifetime) + the epic row's own board Done
    (durable, survives a restart that empties the Set). A rare double-write in the restart window is a
    harmless no-op — the agent re-validates the transition against a fresh read, exactly like
    `autoClosed`.
  - A run with NO children never auto-completes (`epicRunAllChildrenDone` returns false for an empty
    list — an empty run was armed against nothing).

## Tests

- The `XERK-635:` cases in `server.test.js`: `buildEpicWaves` (diamond, external-blocker/self-block,
  cycle annotation), `isEpicOrEpicChild`, the sweep exclusion, the content-gate agreement, the route
  (arm/DAG/payload, cycle→blocked, bad-key/phantom-org/non-epic refusals, `{clear:true}`), and the
  restart restore (malformed record dropped).
- The `XERK-636:` cases in `server.test.js`: parallel-wave dispatch (only ready children go, then a
  completed blocker releases the next wave concurrently across two hosts), capacity backpressure (a
  flat wave queues, one-per-host-per-pass), the 5-hour paused-hold-then-resume (asserted via
  `pausedSubscriptions`), the double-start guards (existing session, repeated passes, sweep + manual
  click reusing the in-flight cmdId), the acked-no-session backoff (no 15s re-dispatch), the run
  advancing to `done`, and `epicChildBlockersDone`.
- The `XERK-641:` cases in `server.test.js`: pause halts new dispatch + resume restarts it, a paused
  run's running child is not auto-merged/closed (then is on resume), pause preserves the DAG + a
  missing run is null + a re-arm keeps the hold, `sanitizeEpicRunRecord` coerces `paused` strictly,
  and a paused run never auto-completes its epic. Web: the `XERK-641` cases in `board.test.js`
  (paused view/sig, the `kc-epic-paused` chip, Resume/Pause button visibility). Android:
  `epicRunView surfaces the run's paused hold` in `BoardTest.kt`.
- The `XERK-637:` cases in `server.test.js`: an armed child auto-merges past the opt-in + bug floor,
  auto-closes (Done + kill) past the opt-in, an UNARMED epic child stays excluded, a child added
  after arming (not in `run.children`) stays excluded, chain-advance (auto-close unblocks dependents
  without completing the epic), epic-Done-written-once + run terminal, mixed auto/human completion,
  the gapped-host stand-down, and a run armed already-complete still writing the epic Done (with the
  board stopping a post-restart re-fire).
