---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
---

# The hub's memory bounds (XERK-273, XERK-258)

Split out of `CLAUDE.md`. Cross-component principles (container-limit derivation, the 413/503
contract, the XERK-287 gap) stay there. This file is the `turma/server.js` mechanics.

The hub is the fleet's sole control plane under `mem_limit: 512m` (raised from 256m for XERK-287),
with `restart: unless-stopped`
(a crash loop, not a safety net). Two bounds are needed; neither substitutes for the other.

## Two bounds

- **`server.maxConnections` bounds SOCKET COUNT** — each costs a read buffer/parser/req-res objects
  before any body byte arrives (~28 KiB/socket). Include upgraded WebSockets (SSE/tunnel/terminal) so
  the cap clears steady-state use; too low reads as a network fault (drops are rate-limited-logged).
  A refused connection is destroyed pre-parse, so it can't get a 503 — the client sees a reset.
- **The in-flight body budget bounds BYTES**, which no connection cap can (a cap safe against a
  32 MiB worst case would have to be ~4).

## WebSocket frame ceiling (XERK-357)

- **`wsParser` caps a frame's DECLARED length at `WS_FRAME_MAX`** — a fraction of the container
  (`min(16 MiB, MEMORY_LIMIT/16)`), not a fixed number, like every ceiling here. Without it the
  parser's `Buffer.concat` accumulator grows to the declared size: one 300 MiB frame took the hub
  RSS 58→327 MiB in 4s, OOM + `unless-stopped` loop. All four WS surfaces reach it — `/agent/control`
  and `/agent/data` (agent-authed), `/live/*` and `/audio` (logged-in browser) — so it was exempt
  from every XERK-258 ceiling.
- **The refusal is decided on the ≤10-byte length HEADER, before the payload is buffered** — that is
  the whole point; catching it after `buf` grew to the declared size defeats it. `wsParser(onFrame,
  {max, onOverflow})`: over `max` → the parser goes DEAD (drops its buffer, ignores every later
  chunk — the stream is unrecoverable, no next frame boundary) and calls `onOverflow(len)`. The
  parser can't reach the socket, so the CALLER closes it and logs — a WS peer gets no 413, so the
  close code + log line are the only trace (the 413-vs-close asymmetry).
- **The partial frame is NOT charged against the HTTP in-flight budget** (`chargeBody`) — that
  budget's shape (two lanes, 3x parse cost, stalled-request reclaim) is a request/response stream's,
  wrong for a raw, never-parsed, long-lived frame. At most ONE partial frame per socket (bounded by
  `WS_FRAME_MAX`) and socket count is bounded by `MAX_CONNECTIONS`, so the two ceilings bound the
  parser the way the connection cap bounds per-socket read buffers.
  - **KNOWN residual, the XERK-287 shape**: the aggregate worst case is
    `MAX_CONNECTIONS × WS_FRAME_MAX`, a budget separate from and ADDED to the in-flight ceiling.
    Reaching it needs `MAX_CONNECTIONS` authenticated sockets each holding a near-max partial frame —
    far narrower than the single unbounded frame this closes; shrinking it further is a sizing
    decision, not a code fix.
- **The parity mirror does NOT apply**: `tunnel-agent.js` uses Node's built-in WebSocket client (which
  bounds frames itself), so the hand-rolled parser — and this ceiling — live only in `server.js`.
- Tests: the `XERK-357` / `wsParser refuses…` cases in `server.test.js` (header-only overflow,
  dead-after-overflow, exact-ceiling boundary).

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

## The XERK-287 co-peak, and why the ingress closes findings 2/3

- **The staged-upload relay is a budget SEPARATE from the in-flight ceiling** (`UPLOAD_TOTAL_MAX_BYTES`
  = `min(128 MiB, MEMORY_LIMIT/4)`, held for MINUTES not one request), so the hub's true worst-case
  heap is `BODY_INFLIGHT_TOTAL_MAX + UPLOAD_TOTAL_MAX_BYTES` = ¾ of the container. At 256m that was
  128 + 64 = 192 MiB and OOM'd. **Closed by raising `mem_limit` to 512m** (ArgoCD `ai/turma/
  deployment.yaml`) — co-peak 256 + 128 = 384 MiB + ~60 baseline ≈ 444, ~68 MiB margin — NOT by
  shrinking either budget (the two rejected levers were halving the upload relay and halving
  `HEARTBEAT_MAX`, both with user-visible cost). The parse-cost model means held memory ≈ the budget,
  so the raise is safe by design; the 256m OOM was the ~6 MiB margin being eaten by transient churn.
- **The chunked-body and socket-error halves (findings 2/3) are neutralized by the DEPLOYMENT
  topology, and need no hub code.** In k8s the hub is fronted by an NGINX Inc ingress with
  `proxy_request_buffering on` (its default, unoverridden): nginx buffers each request body IN FULL,
  then forwards it upstream DECLARED-LENGTH and relays the hub's response back.
  - So the hub's declared-length pre-check (`readBody`, the `Content-Length > budget` refusal) always
    fires — a client sending **chunked** cannot bypass it, because nginx re-frames chunked → declared
    before the hub sees a byte. **Do NOT add an "undeclared-body concurrency cap"** — it would guard a
    path that does not exist through the ingress and could refuse legitimate beats.
  - And an oversize body always gets a **readable 413**, never XERK-235's bare socket error: nginx has
    the whole body buffered, so the hub's drain-slack socket cut never strands the agent's urllib POST.
    Verified against the real prod URL: 0.5–8 MiB bodies, declared AND chunked, via python-urllib →
    every one a clean `HTTP 413 {"limit":…}`, zero socket errors (8 MiB = 4× the cap, 4× past the
    drain window). The direct client↔hub topology XERK-235/finding 3 assumed was the OLD DockerOps
    cloudflared→hub path; the k8s migration put nginx in front.
  - **Residual:** an IN-CLUSTER agent posts to the Service directly (`http://turma.ai.svc…`), bypassing
    nginx. Finding 2 still never applies (urllib always sets Content-Length); finding 3 is a bounded
    residual for that trusted host. The `readBody` urllib caveat below still holds for that direct path.
  - **cloudflared's framing is irrelevant** to what the hub sees — it is upstream of nginx, which
    normalizes. The ticket's "measure cloudflared" question was moot once nginx was in the path.

## The queued-command cap (XERK-261)

- **`queueCommand` bounds `a.commands` so a HUB-SIDE write can never grow a record past
  `AGENT_RECORD_MAX`.** Every append re-serializes and SSE-broadcasts the whole record, and the queue
  drains only when the host BEATS — so a flood of commands at an OFFLINE host (an operator hammering a
  control; the repro was 1316 queued `model-source` commands) grew the record until its next beat
  413'd, locking the host out permanently (the drain needs the beat the 413 refuses). Records live 7
  days, so the lockout is durable.
- **Two bounds, oldest dropped first** (a queue already thousands deep for an offline host is stale by
  the time it returns, so oldest-drop loses nothing; dropping keeps every caller's cmdId return
  contract, where a 429-refuse would not): `AGENT_COMMAND_QUEUE_MAX` (count, 256, `positiveEnv`) holds
  the common small-command flood with a length check; then a BYTE trim (`agentRecordSize` >
  `AGENT_RECORD_MAX`) covers fat payloads (a spawn `label` is up to 100k) AND a record already near
  the ceiling that one command would tip over. The byte loop always leaves the just-enqueued command.
- **The single `agentRecordSize` measure doubles as the `recordBytes` update** — an offline host never
  re-measures on its own beat, so without it its accruing queue is invisible to `registryBytes` until
  it returns. `queueCommand` is low-frequency (operator actions, ≤one ticket dispatch per host per
  beat), so one serialization per call is cheap on a normal (<0.3 MiB) record.
- **The trim log is throttled** (`logCommandTrim`, one line/min) — the flood that trips it is exactly
  the traffic that would flood the log, same discipline as `logRegistryFull`.
- Tests: the `queued-command cap` cases in `server.test.js`.

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
