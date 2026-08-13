---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
---

# The hub's memory bounds (XERK-273, XERK-258)

Split out of `CLAUDE.md` to keep that file under its size ceiling. What spans components stays
there — the container-limit principle, the 413/503 wire contract with the agent, and the XERK-287
gap. This file is the mechanics, all of it in `turma/server.js`.

The hub is the fleet's whole control plane, every agent shares one master secret, and
`restart: unless-stopped` turns a crash into a repeating outage. It ran at `mem_limit: 256m` with
nothing bounding either concurrent sockets or concurrent body bytes, and could be OOM-killed two
ways that neither bound covers alone.

## Two bounds, neither substituting for the other

- **`server.maxConnections` bounds the socket count, which no byte budget can**: each socket costs a
  read buffer, parser and req/res objects before a body byte arrives. Measured, that is ~28 KiB per
  socket — 1024 idle-bodied connections peak at 49 MiB and 4096 at 135 MiB, where the hub survives
  the OOM killer but stops answering. So sockets alone turn fatal past ~8000, **not** at the ~1024
  the ticket first attributed to them; there the bill was the bodies.
  - It counts the upgraded WebSockets too, so the number must clear steady-state SSE/tunnel/terminal
    use with room to spare — set it too low and the UI breaks looking like a network fault, which is
    why drops are logged (rate-limited; a flood is thousands per second).
  - A refused connection is destroyed by Node before any parsing, so it cannot be answered with a
    503. The client sees a reset, and the `drop` log is the only diagnosable trace.
- **The in-flight budget bounds bytes, which no connection cap can**: a cap safe against a
  worst-case 32 MiB body would have to be ~4.

## The in-flight body budget

- **A body is charged `BODY_PARSE_COST` (3x) its wire size, not its wire size.** The bill is the JS
  string plus the object graph `JSON.parse` builds beside it; charging wire bytes admitted two
  30 MiB beats against a 64 MiB budget and OOM-killed the hub anyway. Raw (Buffer) bodies keep 1x —
  the migration relay and attachment uploads never decode or parse what they hold.
- **Only bytes that ARRIVED are ever charged; a declared `Content-Length` is CHECKED, never
  charged.** Reserving on the declaration wedged every POST route into 503 from one silent socket —
  no bandwidth, no credentials (`/api/login` reads a body before any auth gate), renewable. A claim
  that is never held is never denied to anyone else. The check still has to exist: Node delivers
  whatever accumulated in one `data` event, so a body refused on its first chunk has already been
  buffered that far.
- **The per-request ceiling only ever TIGHTENS** (`min(sanity bound, limit/8)`); only the total
  budget widens with the container, because that is what buys concurrency. Deriving the per-request
  one purely from the limit hands a hub on a big host an 8 GB single-body ceiling.

### Two lanes

- **The shared budget, and ONE big body at a time** (`bodyLaneFor`). The big lane is what makes the
  hub's own advertised ceilings reachable: keyed instead on the hub being bit-for-bit idle,
  `HEARTBEAT_MAX` promised a 32 MiB beat that no concurrent moment accepted, and one trickling
  request refused a real 65 MiB migration bundle with 3 KB in flight — back when the relay buffered
  one. A ceiling only reachable on a perfectly idle hub is not a ceiling.
  - **The migration bundle no longer reaches this budget at all**: it spools to disk (XERK-263), so
    what the lane actually carries is large HEARTBEATS. Don't restore the bundle as its rationale.
- **The lane is re-judged on every top-up, not latched.** A shared-lane body that stops fitting is
  promoted to the big lane if free, else refused. Deciding once and charging blindly is how two
  30 MiB beats grew past the ceiling together with the budget nominally in force.
- **The lanes are accounted SEPARATELY**, and that is the point of having them. Billed to the shared
  budget, merely OCCUPYING the big lane was a TOTAL outage — the big body's own charge exceeds the
  budget, so a 200-byte heartbeat and the operator's own login were refused behind it, one
  authenticated socket holding the control plane down for ~29 kbit/s. Kept apart, a big body delays
  only bodies that themselves need the lane.
- **A promoted body's charge MOVES lanes with it** (`migrateToBigLane`). A read admitted to the
  shared lane and later promoted owns one lane but was billed to two, and `release()` can only name
  the lane it ENDED in — so one legitimate 22 MiB heartbeat leaked the whole shared budget
  permanently, and every non-trivial body was refused for the life of the process. A charge must
  live entirely in the lane its read currently occupies; then release is right by construction.
- **`BODY_INFLIGHT_TOTAL_MAX` covers BOTH lanes, and must exceed one max-size body's full parse
  cost.** One ceiling, not two: two independent ones have to be ADDED to know the worst case and
  nobody does that arithmetic when tuning one. Making the lanes genuinely independent silently moved
  the true worst case to `shared + a whole big body`, and the 256-concurrent flood began OOM-killing
  a hub that had survived it for four commits. The headroom above one max body is what ordinary
  traffic runs in while the exclusive lane is held, so the inequality is load-bearing in both
  directions — `BODY_INFLIGHT_MAX * BODY_PARSE_COST < BODY_INFLIGHT_TOTAL_MAX`, asserted in the
  suite.

### Reclaiming a body that stops arriving

- **A body holding budget must keep making PROGRESS or it is taken back** —
  `BODY_MIN_PROGRESS_BYTES` per `BODY_IDLE_TIMEOUT_MS`, i.e. a minimum RATE (~3 KiB/s at the
  defaults), armed only while a charge is held. The budget bounds how much may be held; only this
  bounds how long.
  - A window reset by ANY byte is not a liveness check, it is one an attacker forges: one byte every
    15s held the big lane indefinitely — refusing every POST including the operator's login — for
    ~0.5 bit/s, since renewing never had to re-stream. Reclaiming only silence is not enough; a
    dribble is neither silent nor slow.
  - The floor gives way to what the body has LEFT, so a nearly-complete upload is never reclaimed
    over its last bytes. Not exploitable: holding a big charge needs a large remainder.
- **Reclaim fires only under CONTENTION** (`budgetUnderPressure`), judged PER LANE: the shared
  budget over half spent, or — for a big-lane body — always, since that lane is exclusive. With room
  to spare a slow caller is left alone; dropping it would be a pure false positive, since a small
  request over a bad link holds a few hundred KB of a 64 MiB budget and monopolizes nothing.
- **`BIG_LANE_MAX_HOLD_MS` bounds how long one body may occupy the lane, however well it behaves.**
  The progress floor cannot close this: a body dribbling AT the floor is byte-for-byte
  indistinguishable from a legitimate slow migration at the same rate, so no rate threshold
  separates them. This is the orthogonal bound — not "are you progressing" but "you have had it long
  enough" — sized well above the largest body that reaches this budget, at any sane rate.

### Refusing a body

- **Draining a refused body is capped by CONCURRENCY** (`DRAIN_CONCURRENCY_MAX`), and past the cap
  the refusal closes the connection (`endRefusedConnection`, after `finish` so the status reaches
  the wire first). Draining is unbuffered but not free — Node allocates per read, and 256 sockets
  streaming past a refusal OOM-killed the hub with nothing buffered. The cap is a COUNT, not a byte
  budget: the cost is concurrent read churn. Under it, the one oversize beat a real fleet produces
  still drains and still gets its 413.
- **A refused body must be CLOSED, not merely paused.** Node DUMPS an unread body when the response
  finishes, to keep the connection alive — it resumes the paused stream and reads the whole thing.
  Discarded bytes are still read into memory.

## Verifying a change here

- The unit suite has never caught any defect in this code. Every one was found by flooding a real
  `node:24-alpine` container at `-m 256m` and reading `docker inspect .State.OOMKilled` plus
  `/sys/fs/cgroup/memory.peak`. Write the bodies in slices so the requests genuinely overlap; a
  sequential harness detects almost nothing.
- **`256 concurrent x 30 MiB declared` is the tightest row** and sits at 86-90% of the limit, so
  re-run it on any change here — 3-5 times, because the OOM is probabilistic.
- Staged uploads are a separate budget that must be added to whatever the bodies hold; stage them
  (the agent must report `uploadMaxBytes` or uploads 409) before concluding a shape is safe.
- **Prove a new test fails without its fix.** Both leak tests here were checked against a build with
  `migrateToBigLane` disabled; a test that passes either way pins nothing.
- Tests: the `budget:`, `drain:` and `connections:` cases in `server.test.js`.
