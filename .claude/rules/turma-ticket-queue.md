---
paths:
  - "turma/server.js"
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "turma/tests/server.test.js"
  - "turma/tests/board.test.js"
---

# The hub's ticket queue (XERK-296)

Split out of `.claude/rules/turma-board.md`, which it had grown to dominate. Read `CLAUDE.md` for
the rule this implements and `turma-board.md` for the board around it (auto-start, the Start button,
the ticket panel).

Read this before touching `findTicketHost`, the `/session` routes or the sweeps.

- **Every ticket spawn goes through it** — Start button and auto-start sweep alike, both via
  `findTicketHost(..., {requireFree:true})`. A host with a free slot is used at once; only a fleet
  with none queues. The agent-side session queue (XERK-14) keeps the cases where the host IS the
  decision: "+ New session", and a ticket session waiting on its clone.
- `drainTicketQueue()` runs on **every heartbeat** (the beat IS the capacity report, so a freed slot
  is claimed within a beat) and on the 15s sweep after `autoStartSweep`/`autoStopSweep`. **At most
  one dispatch per host per pass**, mirroring the agent's one-per-beat drain — the shared
  `~/.claude` login limits both. The dispatch rides the NEXT beat's reply.
- **`requireFree` filters the pool BEFORE the cloned-repo preference**, so a full cloned host never
  holds a ticket back from a free one that can clone on demand (the accepted cost is a clone the old
  ordering would have avoided). `hostHasFreeSlot` reads an absent `capacity` as **"can't tell"** and
  keeps that host dispatchable — the heartbeat contract's rule, and what keeps a mixed fleet routing
  — never as "full"; `hostAvailability` already ranks it below every host with real free slots.
- **Only capacity queues.** A hard refusal at POST time (no host reports the org, every host
  offline, a pinned agent that is gone) still answers with a status and `{error}`; `{full:true}` is
  what tells the two apart. A pinned host that is merely FULL is waited for, never routed around.
- An entry is `{siteKey, issueKey, source, at, reason, error, blockedSince, unknownSince,
  expiredAt}`.
  `reason` is why it is STILL waiting as of the last drain — `capacity` (clears itself) or `blocked`
  (the operator has to clear it, with the hub's wording in `error`) — and the card says which.
- **`ticketQueueAdmission` validates the key** (`isIssueKey` + `TICKET_KEY_MAX`, bounded
  `siteKey`). On the sweep path both fields come off an AGENT's `jira` block, and an entry is served
  on the top-level payload where **Android TYPES `issueKey`** and decodes atomically — an object or
  a 20k key from one host breaks every phone's fleet decode, hub-wide. **This check is that
  coercion; no `normalize*` covers this list.** It also keeps an unvalidated key off the
  `spawnTicket` command the sweep path never checked.
- **Three admission limits, and `ticketQueueAdmission` is the one place that decides between
  them** — an ordinary 250-ticket backlog reaches all three. `TICKET_QUEUE_PER_ORG_MAX` is the real
  line (the queue drains per org, so one org's backlog must never refuse another's Start);
  `TICKET_QUEUE_PER_ORG_AUTO_MAX` is the SWEEP's share of it, because an opted-in org refills its
  line every 15s and without a reserve the starvation just moved one level down onto the person;
  `TICKET_QUEUE_MAX` is the memory bound behind both.
  - **A refused key is not a full queue.** The sweep must SKIP an unqueueable row and keep going —
    reporting it as "full" truncated an org's auto-start at its first bad row, every sweep, forever,
    and blamed a queue that was empty. Only `fleet-full` ends a sweep; `org-full` ends that org's.
  - **A line about a STATE goes through `logQueueState`**, which throttles it. The sweep re-derives
    every verdict every 15s, so an unthrottled "this org is at its share" is a line about a
    condition that will still hold in 15 seconds — it buries the log in exactly the situation it
    exists to explain. Per-event lines (queued / dispatched / dropped) are not throttled.
- **A hold is not forever**, and `TICKET_QUEUE_MAX_WAIT_MS` is the backstop under all of them: an
  entry whose ticket no reporting org lists any more ages out (`TICKET_QUEUE_STALE_MS`, long enough
  to ride out a poll gap or host restart), and one nothing can route ages out
  (`TICKET_QUEUE_BLOCKED_MAX_MS`). Without these a permanently-blocked entry held its org's line
  open for the hub's lifetime.
  - **A routing failure HOLDS; it does not drop.** Dropping an auto entry there dropped it into the
    sweep's arms — an org whose hosts were all offline re-queued every 15s, churning the log, the
    payload and the board's chip for as long as it stayed down. The one exception is a ticket with
    **no triaged repo**, which the sweep cannot re-queue (it only ever queues a ticket that has
    one), so an auto entry leaves there without churn.
- **A spawn stranded on a host that dies before taking it is reclaimed** (`reclaimStrandedTicketSpawns`,
  XERK-303). The queue's guarantee ends at dispatch — the entry leaves it there — so an undelivered
  command on a dead host was work nothing re-routed, waiting out `PRUNE_AFTER_MS` (a week) with no
  board surface to be missing from. It runs on the 15s sweep **before `autoStartSweep`**, so a
  reclaimed MANUAL entry retakes its place as manual instead of being re-queued as auto and swept
  away with the org's switch.
  - **The gate is `!c.deliveredAt`, never the host being offline.** A host routinely goes silent
    BETWEEN delivery and ack — the very window this covers — and withdrawing there hands the ticket
    a second session on top of the one already starting. A delivered command is left alone: it
    re-delivers when the host returns (delivery is at-least-once) and runs then. Offline is only what
    makes an UNDELIVERED command hopeless enough to act on.
  - **Admission is checked BEFORE the withdrawal.** `enqueueTicketStart` can refuse (a full org
    line), and dropping a command that then fails to re-queue destroys the work outright rather than
    delaying it. Refused, the command stays put and the next sweep retries.
  - **`ticketSource` rides the command as hub-only bookkeeping**, stripped by `publicCommands`
    exactly like `deliveredAt` so it never becomes a client contract. The queue entry is gone by
    then, so it is the only record of what KIND of work a stranded spawn was; unstamped (queued
    before this shipped, restored across the deploy) reads as `auto`, the reading whose failure is a
    logged drop rather than a duplicate session.
  - A reclaimed AUTO ticket gets its `autoStarted` attempt **back** — the dispatch spent a retry on
    a command the agent never saw, and an offline host must not eat that ticket's backoff budget.
  - Tests: the `XERK-303:` block in `server.test.js`.
- **A direct dispatch RETIRES that ticket's entry** (`/session` when a host is free), and
  `rememberDispatch` records it. The entry and the dispatch are one intent: left in place it fired
  again on the next free slot, a second session hours later that nobody asked for.
- **A manual entry is never retired by fleet state.** It is one operator asking for one session,
  and its only honest ends are their cancel, its own dispatch, its ticket reaching Done, and the
  bounded waits above. Inferring the ask from the ticket's session count — the obvious fix for an
  entry that outlives its purpose — swallowed the click whenever a session it never asked for
  appeared (the sweep, another operator, another board), and a count that can DIP (an agent
  mid-restart, a `closedSessions` eviction) swallowed it with no new session at all. **A second
  session on a ticket is what the `+` button asks for**, so the queue cannot read the ask off a
  number the fleet owns; the max wait is what bounds it instead.
- **A terminal note counts against NO line and blocks nothing.** It is a message about work that
  ended, not work: excluded from the per-org count, from the fleet cap (counting it let dead notes
  429 a live click from an ANOTHER org — the refusal this ticket exists to remove), and from the
  sweep's "already queued" guard (`liveQueuedTicket`, or an auto ticket sat inert for the note's
  whole TTL before auto-start could retry it). Notes are bounded on their own by
  `TICKET_QUEUE_NOTES_MAX`, since nothing else counts them, and `sweepExpiredNotes` runs where they
  are MINTED (the drain) as well as on enqueue — applied only on enqueue the bound held at 2×.
  - **Eviction is OLDEST-first, and that ordering is the part with user impact**: past the bound the
    operator whose ticket gave up FIRST loses their note without dismissing it — the very signal the
    note exists to show. Accepted, because it needs >`TICKET_QUEUE_NOTES_MAX` simultaneous notes and
    unbounded growth is the worse trade; newest-first would drop the ones nobody has read yet.
  - **In practice the note is a message to a PERSON who clicked.** An auto entry that expires is
    re-queued by the next sweep (15s), so its note is replaced almost immediately — correct, since
    auto-start never gives up (XERK-109), and it means the visible expiry is effectively manual-only.
- **Giving up is VISIBLE.** When `TICKET_QUEUE_MAX_WAIT_MS` fires the entry does not vanish: it goes
  TERMINAL (`reason:"expired"`, `expiredAt`) and stays on the payload for `TICKET_QUEUE_EXPIRED_TTL_MS`
  as a note the card renders — "⌛ gave up waiting", the hub's reason as the tooltip, a ✕ to dismiss
  and a live Start beside it. A queued click that simply disappeared read exactly like someone else
  cancelling it, which is the going-quietly-missing failure this whole ticket is about. A terminal
  entry holds no place in its org's line, never dispatches, and is REPLACED (not returned) if the
  ticket is queued again.
- **Only `done` ends a manual entry on status.** A ticket moving to In Progress does NOT — the queue
  cannot tell "a human picked this up" from "the session I asked for is starting", and guessing
  wrong is what swallowed the click. So a click made while the fleet is full can still start a
  session on a ticket somebody has since moved, up to the max wait.
- **A cancel that lost the race is refused, not blessed.** The entry is equally gone whether it was
  cancelled or DISPATCHED a moment ago, so `dispatchedRecently` (`TICKET_DISPATCH_MEMO_MS`) makes
  the second a **409** — a 404 there told an operator their cancel worked while a session came up.
  Both clients treat 404 as satisfied intent and 409 as a refusal to show.
- **`publishTicketQueue` invalidates the cache synchronously but COALESCES the SSE frame** to the
  end of the turn: a sweep queues one ticket at a time, and a frame per entry cost every open board
  201 frames / 2.8 MB for one 200-ticket backlog.
- **`source` decides what may sweep an entry away.** Turning an org's Auto switch off drops its
  `auto` entries and NOTHING else: not its manual ones, not another org's, and no session (there is
  none to touch). A manual click on an auto-queued ticket **upgrades** it to `manual` so it survives
  that. The auto-only guards are the sweep's own — already-has-a-session and spawn-in-flight — and
  they must NOT be applied to a manual entry: a second session on a ticket is a thing an operator
  can ask for (it gets the -1/-2 branch), so dropping their click for the first one swallows it.
  Both sources drop on Done, and an auto entry also drops when its ticket leaves To Do.
- **Queuing spends no auto-start attempt**: `autoStarted`'s backoff is stamped at DISPATCH, since it
  exists for a spawn an agent ACKED that left no session (XERK-61/109). Sitting in line commits
  nothing, so a full org must not burn retries.
- **In-memory**, like the migration records: a hub restart drops the queue rather than replaying
  stale intent as a burst of sessions. Auto entries return on the next sweep; a manual one is lost
  and must be clicked again.
- Clients paint from the payload, with a short-lived local overlay for the round trip of a click
  only (`queueView` in `board.html` and `core/Board.kt`, retired the moment the hub agrees). The
  card replaces its Start button with the wait + a ✕ — a second press could only re-queue what is
  queued.
  - **`board.html` re-reads the whole payload on an SSE RECONNECT**, because the queue is the one
    piece of its state that is hub-MEMORY: a hub restart empties it with no event that socket could
    carry, and the 15s poll only runs while SSE is DOWN. Without the re-read the chip stuck forever,
    and since it REPLACES the start button that ticket could not be started at all. Android polls
    every 6s regardless, so it never had this.
- Tests: the `XERK-296:` cases in `server.test.js`, `board.test.js`, `BoardTest.kt`.
