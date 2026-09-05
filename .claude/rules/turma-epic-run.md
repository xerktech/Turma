---
paths:
  - turma/server.js
  - turma/tests/server.test.js
---

# Epic auto-orchestration run (XERK-635/636, epic XERK-633)

The hub's machinery for "work an epic's children in dependency order, start/close hands-off".
XERK-635 (B) is the HUB STATE — the durable run record, its dependency DAG, the manual-start route,
and the never-auto-start gate. XERK-636 (C) is the DRIVER that dispatches ready children. The board
UI (E) is a later subtask; do not add it here.

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
  routes. Body `{}` (or omitted) ARMS/re-arms; `{clear:true}`/`{cancel:true}` cancels.
- Validation: `400` bad key; `404` no host reports the org; **`404` when the key is not a real epic
  the fleet lists** (`isEpic !== true`) — a run is never armed for a phantom or a work ticket.
- `armEpicRun(siteKey, epicKey, rows)` rebuilds the DAG from the current board rows, derives state
  (`blocked` if a cycle; `done` if every child already Done; else `running`), persists, broadcasts.

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
