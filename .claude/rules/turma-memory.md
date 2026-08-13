---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
---

# The hub's memory ceilings (XERK-258)

Split out of `.claude/rules/turma.md` to keep that file (which loads for ALL of `turma/**`) under
the size ceiling. Everything here is `turma/server.js`: what bounds the memory a request body, a
staged upload or a cached history delivery may occupy, and why each number is what it is.

Read `CLAUDE.md`'s cross-cutting contracts for the 413-vs-503 half of this, which spans the hub and
the agent and so cannot live in a `paths:`-scoped file.

- **Every memory ceiling is DERIVED from the container's memory limit** (`detectMemoryLimit`: cgroup
  v2 then v1, `HUB_MEM_LIMIT_BYTES` to override), never a flat constant. The hub is deployed with a
  `mem_limit` far below the sum of the constants it used to carry — a 32 MiB per-beat cap with no
  concurrency bound, and a 128 MiB pending-upload ceiling, inside 256m. **A ceiling above the limit
  the kernel kills on is not a ceiling**, and the kill takes every host's control plane with it.
- **NEVER RESERVE AGAINST A LENGTH A CLIENT MERELY CLAIMS.** `bodyBudget` reserves only bytes that
  have ACTUALLY ARRIVED (`note(len)`, per chunk). Reserving off `Content-Length` first — to refuse an
  over-budget POST without paying to receive it — was an **unauthenticated remote DoS**: `POST
  /api/login` reads a body before checking credentials, so 65 idle sockets that declared a body and
  sent nothing filled the ledger and 503'd every heartbeat and login, at no cost to the sender.
  - The declared length may still be **consulted**, because picking a status holds nothing:
    `declaredOverCap` answers 413 on the headers, and `budget.peek` answers 503 on them. That early
    refusal is what stops a flood of large declared bodies from streaming megabytes into the bin —
    the sockets, not the bytes, are what OOMs at that scale.
- **A per-request cap cannot bound concurrency, so there are two ceilings plus an escape:**
  - `BODY_INFLIGHT_MAX` over **charged** bytes, sized at ONE at-cap body so a second cannot join it.
    Each body's first `BODY_MAX` is free, so one host's multi-MiB `/history` delivery can't 503 the
    whole fleet's ordinary beats.
  - `BODY_INFLIGHT_TOTAL_MAX` over **every** in-flight byte (`BODY_INFLIGHT_CAPACITY`: usable memory
    x `BODY_HOLD_SHARE` / `BODY_HOLD_FACTOR`). The free floor needs its own ceiling or it is a hole
    the size of the first bug: many small bodies OOM-killed the hub exactly as two 30 MiB beats did.
  - **A read alone in flight escapes to its own route cap** (`MIGRATE_BLOB_MAX` is 65 MiB, over the
    budget at the deployed limit, and refusing a lone request the hub is sized for would be an outage
    of our own making) — but only while `retainedBytes()` + it fits `BODY_INFLIGHT_ESCAPE_MAX` (half
    the container). Staged uploads and migration bundles are RAM too, and blobs plus one escaping body
    was an OOM with every individual limit respected.
  - **Retained bytes gate that escape and nothing else.** Charging them to the ceilings outright
    refused ordinary heartbeats fleet-wide for as long as an attachment sat in a composer — a staged
    upload lives 20 minutes.
- **Every refusal is TERMINAL** (`refuse`): stop reading, flush the status, cut the socket. Both
  alternatives are worse — draining a body per refusal OOM-killed the hub under a flood, and pausing
  instead is no better because cgroup v2 counts kernel socket buffers against the container.
- **So a mid-upload refusal may not be RECEIVED, and nothing may depend on it being received.** The
  hub answers while the body is still arriving, node tears down a socket whose response finished
  before its request did, and a client that writes everything before reading a byte (python's urllib
  — how the agent posts) sees a broken pipe instead. Two consequences, both load-bearing:
  - **The caps are ADVERTISED, and the clients pre-check.** The beat reply carries
    `heartbeatMaxBytes`, and the agent sheds staged results before it posts (`_fit_to_hub_cap`); the
    composer checks `uploadMaxBytes` before it uploads. **Prevention, not diagnosis** — a rationed
    "be patient so the 413 lands" scheme was tried and made the ration itself the attack (four idle
    sockets exhausted it, and then no 413 was receivable at all, which IS the retry-forever loop).
  - **What is advertised must be what is ADMISSIBLE** (`effectiveCap`, `heartbeatAcceptMax`). A cap
    above `BODY_INFLIGHT_ESCAPE_MAX` would be advertised, enforced, and then refused with 503
    ("retry") for a permanently impossible request — measured at `-m 32m`: 32 MiB advertised, a
    20 MiB beat 503'd forever with zero bytes held. Every cap a client is told goes through there.
  - **`HEARTBEAT_MAX` is the documented ceiling; `heartbeatAcceptMax()` is what this container can
    afford to PARSE.** Every ceiling is derived the same way and **through the numbers, never by eye**
    (`BODY_HOLD_FACTOR`, `BODY_HOLD_SHARE`, `HUB_BASELINE_BYTES`, `BODY_ONE_BODY_SHARE`):
    - A JSON body costs ~**5x** its size to hold (string, then object graph, then `sanitizeHeartbeat`
      re-serializing unknown keys). Fractions chosen by eye instead of divided by that let four beats
      at exactly the ADVERTISED size OOM-kill a 64 MiB container — while the same beats sent
      sequentially were fine, which is why eyeballing survived a round of testing.
    - The interpreter's own ~20-40 MiB is **subtracted before any share is taken**. A share of the
      whole container assumes the container is all ours: nearly true at 1 GiB, nearly false at 64 MiB,
      where a 64 MiB hub survived a concurrent burst and then died on the sequence after it.
    - One body may take most of the in-flight capacity (`BODY_ONE_BODY_SHARE`) but **never all of it**,
      or an ordinary beat is refused while a big delivery is in flight — a fleet-wide outage rather
      than a bounded one.
    - Retained upload blobs get their own eighth, sized by measurement rather than preference:
      at-cap beats alone peaked at 150 MiB of 256, a full pool alone at 146, and the two TOGETHER at
      249 — additive, 97% of the container. That per-file cap is an operator's convenience and the
      control plane is the whole fleet's; the fleet wins.
    - Measured at the deployed 256m after all of it: a concurrent burst followed by a sequential run
      peaks at 131 MiB, and the full adversarial mix (a filled upload pool plus repeated 8-way at-cap
      bursts) at 173 MiB, with ordinary beats still served throughout. 64m/96m/128m survive the same
      shapes at 36/65/65 MiB, where 64m and 96m were OOM-killed by four at-cap beats before.

- **The on-demand history caches are bounded in BYTES too** (`sweepHistoryBytes`,
  `HISTORY_TOTAL_MAX_BYTES`, fleet-wide, oldest delivery evicted first). Two consequences worth
  knowing: the budget is **shared across hosts**, so an operator's open history view can go stale
  because a DIFFERENT host delivered (re-opening re-fetches it); and the delivery that just landed is
  **never swept**, or one larger than the whole ceiling would be evicted on arrival, leaving the view
  permanently unloadable and re-queueing a `history` command on every open. `HISTORY_MAX_SESSIONS`
  cannot see size, `AGENT_CACHE_KEYS` strips these caches before `AGENT_RECORD_MAX` measures a
  record, and `retainedBytes` deliberately leaves them out — so they were invisible to every ceiling
  and seven sequential 25 MiB deliveries from ONE authorized host OOM-killed the hub.
- **A route that answers WITHOUT reading the body must close the connection** (`json()` adds
  `Connection: close` when `res.req` is incomplete). Node destroys such a socket once the reply is
  out, so a `keep-alive` header hands the client a doomed pooled socket and its NEXT request dies
  with ECONNRESET.
- `readBody` decodes through a `StringDecoder`, not `data += chunk`: a UTF-8 sequence split across
  chunks became replacement bytes, silently corrupting transcript text hundreds of times in a
  multi-MiB beat.
- **Watch for 32-bit truncation in these constants**: JS bitwise operators are 32-bit, so `64 << 30`
  is `0` — a clamp written that way turned every derived ceiling into zero.
- Tests: the `XERK-258` cases in `server.test.js` (each pinned by mutation — removing the budget, the
  decoder or the derivation fails them), plus the 413/503 split in `test_hub_agent.py`.

