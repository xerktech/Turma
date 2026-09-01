---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
---

# The hub's memory bounds (XERK-273, XERK-258)

Split out of `CLAUDE.md`. Cross-component principles (container-limit derivation, the 413/503
contract, the XERK-287 gap) stay there. This file is the `turma/server.js` mechanics.

The hub is the fleet's sole control plane under `mem_limit: 256m`, with `restart: unless-stopped`
(a crash loop, not a safety net). Two bounds are needed; neither substitutes for the other.

## Two bounds

- **`server.maxConnections` bounds SOCKET COUNT** — each costs a read buffer/parser/req-res objects
  before any body byte arrives (~28 KiB/socket). Include upgraded WebSockets (SSE/tunnel/terminal) so
  the cap clears steady-state use; too low reads as a network fault (drops are rate-limited-logged).
  A refused connection is destroyed pre-parse, so it can't get a 503 — the client sees a reset.
- **The in-flight body budget bounds BYTES**, which no connection cap can (a cap safe against a
  32 MiB worst case would have to be ~4).

## In-flight body budget

- **A body is charged `BODY_PARSE_COST` (3x) its wire size** — the bill is the JS string plus the
  parsed object graph. Raw (Buffer) bodies keep 1x (migration relay, uploads: never parsed).
- **Only bytes that ARRIVED are charged; a declared `Content-Length` is checked, never charged** —
  reserving on the declaration wedges every route behind one silent/slow socket, including
  `/api/login` (body read before auth).
- **The per-request ceiling only ever TIGHTENS** (`min(sanity bound, limit/8)`); only the total
  budget widens with the container — that's what buys concurrency.

### Two lanes

- **Shared budget + ONE big-body lane at a time** (`bodyLaneFor`), so the hub's own advertised
  ceilings (`HEARTBEAT_MAX`) stay reachable even mid-traffic, not just on an idle hub. The migration
  bundle no longer uses this lane (spools to disk, XERK-263) — don't restore it as the rationale.
- **Re-judged on every top-up, never latched**: a shared-lane body promotes to big-lane if it stops
  fitting, else refused.
- **Lanes are accounted SEPARATELY** so one big body can't starve the control plane (a shared-budget
  collapse under one big body was a total outage).
- **A promoted body's charge MOVES lanes with it** (`migrateToBigLane`) — `release()` only knows the
  lane it ended in, so a charge must live entirely in its current lane.
- **`BODY_INFLIGHT_TOTAL_MAX` covers BOTH lanes as ONE ceiling** (not two added ceilings), and must
  exceed one max body's full parse cost: asserted in the suite as `BODY_INFLIGHT_MAX *
  BODY_PARSE_COST < BODY_INFLIGHT_TOTAL_MAX`.

### Reclaiming a stalled body

- **A body must keep making PROGRESS or its budget is reclaimed** — `BODY_MIN_PROGRESS_BYTES` per
  `BODY_IDLE_TIMEOUT_MS` (a minimum rate, ~3 KiB/s at defaults), armed only while held. A window reset
  by ANY byte is forgeable (a slow trickle holds budget indefinitely) — the floor must be a RATE, and
  gives way to what's left so a near-complete upload is never reclaimed.
- **Reclaim fires only under CONTENTION** (`budgetUnderPressure`, per lane: shared >50% spent, or
  always for the exclusive big lane) — a slow caller with room to spare is left alone.
- **`BIG_LANE_MAX_HOLD_MS` bounds occupancy regardless of behavior** — a body dribbling at the
  progress floor is indistinguishable from a legitimate slow migration, so only a hard time limit
  closes this.

### Refusing a body

- **Draining a refused body is capped by CONCURRENCY** (`DRAIN_CONCURRENCY_MAX`) — draining is
  unbuffered but not free (per-read allocation); past the cap the connection is closed instead
  (`endRefusedConnection`, after `finish`).
- **A refused body must be CLOSED, not paused** — Node dumps (reads) an unread body when the response
  finishes to keep the connection alive, so a pause still reads the whole thing into memory.

## Per-route ceilings

- **A route whose caller sends more than `BODY_MAX` must declare its own cap** (archive ingest:
  agents build deltas from an 8 MiB window since an ended session's first delta is its whole
  transcript — XERK-356).
- **A route costing more than `BODY_PARSE_COST` must declare that too** (`readBody`'s third arg).
  Two routes do: the archive ingest and the heartbeat.
  - `ARCHIVE_PARSE_COST` is 20 (accumulated body + parsed entries + re-serialized lines + append
    buffer, all charged at once); the ceiling is `min(2 MiB, MEMORY_LIMIT / 60)`.
    - **The ceiling rides the heartbeat reply** (`archiveChunkMax`), a fraction of THIS container's
      limit — an agent guessing it guesses wrong. A predating agent keeps a default under the old
      1 MiB cap.
    - **Read at the route, not the generic handler** — 413 vs 503 stay distinct, and refusals are
      RECORDED (`archiveRefusals`, bounded, oldest evicted) so `GET /api/archive/<id>` 404s can say
      `refused` instead of leaving the operator thinking it's merely late.
  - `HEARTBEAT_PARSE_COST` is **6** (XERK-376) — a beat measures ~5.5x its wire at peak RSS
    (`sanitizeHeartbeat` walks sessions/live-agents/usage/staged-history and holds the wire string,
    `JSON.parse`'s graph AND the sanitized copy at once), 6 for headroom. Charged 3x, the budget
    admitted ~2x what a 256 MiB container held and a couple of concurrent large-but-legal beats
    OOM-killed the hub on the route EVERY host beats.
    - **`HEARTBEAT_MAX` stays 32 MiB** — lowering it re-opens XERK-235's shape. So one honest max
      beat charges `32 x 6 = 192`, which EXCEEDS `BODY_INFLIGHT_TOTAL_MAX` (128). That inequality is
      the fix, but NOT because it changes how many big beats are admitted — the two-lane budget
      already admits at most one big beat and 503s a second at EITHER cost. It changes how much OTHER
      traffic co-resides: the big lane's occupancy counts against shared admission, so a 192-unit
      beat leaves ZERO shared room for any body to buffer beside it, where the old 90-unit (3x) charge
      left ~38 units and small "slop" bodies stacked their buffers onto the big beat's peak — the
      co-residence that crossed the ceiling (QA measured 3 concurrent 30 MiB beats at ~287 MiB on 3x —
      OOM — vs ~245 MiB honest, in a real 256 MiB budget).
    - **The accepted sizing trade** (the ticket's "sizing decision"): while a large beat is in flight
      the shared lane has no room, so other bodies briefly 503+retry, and one 192-unit beat leaves
      thin container headroom (one 30 MiB beat alone measures ~185 MiB real RSS). Rare + retryable on
      the liveness route, versus a fleet-wide OOM. Tests pin `worst > TOTAL_MAX` (nothing co-resides)
      and `worst < MEMORY_LIMIT` (the one beat still fits).

## Verifying a change here

- **The unit suite has never caught a defect here** — every one was found flooding a real
  `node:24-alpine` container at `-m 256m`, reading `docker inspect .State.OOMKilled` +
  `/sys/fs/cgroup/memory.peak`. Write bodies in slices so requests genuinely overlap.
- **`256 concurrent x 30 MiB declared` is the tightest row** (86-90% of the limit) — re-run 3-5x,
  since the OOM is probabilistic.
- Staged uploads are a SEPARATE budget to add on top (agent must report `uploadMaxBytes` or uploads
  409).
- **Point `ARCHIVE_DIR` at a REAL DISK**, never tmpfs — tmpfs charges every archived byte to the same
  cgroup, so a build that REFUSES pushes writes nothing and looks safe when it isn't (XERK-356).
- **Prove a new test fails without its fix** — disable `migrateToBigLane` and confirm the leak tests
  actually fail.
- Tests: the `budget:`, `drain:` and `connections:` cases in `server.test.js`.
