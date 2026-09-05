---
paths:
  - turma/server.js
  - turma/tests/server.test.js
---

# Epic auto-orchestration run (XERK-635, epic XERK-633)

The hub's core state for "work an epic's children in dependency order, start/close hands-off". This
subtask (B) is the HUB STATE ONLY — the durable run record, its dependency DAG, the manual-start
route, and the never-auto-start gate. The driver that actually starts children (C) and the board UI
(E) are later subtasks; do not add them here.

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
- **Both sweeps early-return unless `orgsWithAutoMerge().size || anyArmedEpicRun()`** — an armed run
  is the second reason to run them. `anyArmedEpicRun` = any run whose `state !== "done"`.
- **Chaining is C's, not D's.** The Done edge D produces (auto-close) or a human move is what C's
  driver re-evaluates to start the next wave. D adds NO wave-start code.
- **Epic completion (`epicRunCompleteSweep`, on the 15s interval after `autoCloseSweep`)**: once every
  `run.children` is Done on the board, write the EPIC to Done (XERK-138 write-back via
  `pickBoardWriteHost`) and retire the run (`state:"done"`). The epic is an ORGANIZER — this is the
  ONLY step that transitions it, and the never-auto-start gate keeps it off every spawn path.
  - **The write is keyed off the BOARD + a once-guard, NOT the run's `state`** — `armEpicRun` sets
    `state:"done"` for a run ARMED already-complete but never writes the epic, and a human may move the
    epic Done out of band. So the write fires when `!isDone(epic) && !epicDoneWritten.has(tkey)`, and
    `state` is set from "did we get here", so the organizer is never stranded In Progress.
  - **Orphan guard (autoCloseSweep's):** queue the epic-Done write BEFORE going terminal — if no
    board-cred host can take it (`agentGapError`), stand down and retry, never mark the run done behind
    an unmade write.
  - **Once-per-run:** `epicDoneWritten` (in-memory, this lifetime) + the epic row's own board Done
    (durable, survives a restart that empties the Set). A rare double-write in the restart window is a
    harmless no-op — the agent re-validates the transition against a fresh read, exactly like
    `autoClosed`.
  - A run with NO children never auto-completes (an empty `children.every` is vacuously true, but an
    empty run was armed against nothing).

## Tests

- The `XERK-635:` cases in `server.test.js`: `buildEpicWaves` (diamond, external-blocker/self-block,
  cycle annotation), `isEpicOrEpicChild`, the sweep exclusion, the content-gate agreement, the route
  (arm/DAG/payload, cycle→blocked, bad-key/phantom-org/non-epic refusals, `{clear:true}`), and the
  restart restore (malformed record dropped).
- The `XERK-637:` cases in `server.test.js`: an armed child auto-merges past the opt-in + bug floor,
  auto-closes (Done + kill) past the opt-in, an UNARMED epic child stays excluded, chain-advance
  (auto-close unblocks dependents without completing the epic), epic-Done-written-once + run terminal,
  mixed auto/human completion, the gapped-host stand-down, and a run armed already-complete still
  writing the epic Done (with the board stopping a post-restart re-fire).
