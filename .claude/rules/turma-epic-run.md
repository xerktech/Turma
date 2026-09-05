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

## Tests

- The `XERK-635:` cases in `server.test.js`: `buildEpicWaves` (diamond, external-blocker/self-block,
  cycle annotation), `isEpicOrEpicChild`, the sweep exclusion, the content-gate agreement, the route
  (arm/DAG/payload, cycle→blocked, bad-key/phantom-org/non-epic refusals, `{clear:true}`), and the
  restart restore (malformed record dropped).
