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
the rule this implements and `turma-board.md` for the board around it (auto-start, Start button,
ticket panel). Read this before touching `findTicketHost`, the `/session` routes or the sweeps.

- **Every ticket spawn goes through it** — Start button and auto-start sweep alike, both via
  `findTicketHost(..., {requireFree:true})`. A free-slot host is used at once; only a fully-busy
  fleet queues. The agent-side session queue (XERK-14, `agent-sessions.md`) covers the cases where
  the host IS the decision: "+ New session", a ticket session waiting on its clone.
- `drainTicketQueue()` runs on **every heartbeat** (a freed slot is claimed within a beat) and the
  15s sweep after `autoStartSweep`/`autoStopSweep`. **At most one dispatch per host per pass**
  (mirrors the agent's one-per-beat drain — the shared login limits both).
- **`requireFree` filters the pool BEFORE the cloned-repo preference**, so a full cloned host never
  blocks a free clone-on-demand host. `hostHasFreeSlot` reads an absent `capacity` as **"can't
  tell"** (dispatchable), never "full" — the heartbeat contract's rule.
- **Only capacity queues.** A hard refusal at POST time (no host reports the org, all offline, a
  pinned agent gone) still answers status + `{error}`; `{full:true}` is what tells the two apart. A
  pinned-but-full host is waited for, never routed around.
- Entry: `{siteKey, issueKey, source, at, reason, error, blockedSince, unknownSince, expiredAt}`.
  `reason` is why it's STILL waiting — `capacity` and `paused` (XERK-555: every host that could run
  it has its Claude 5-hour usage limit maxed) both self-clear; `blocked` needs the operator; `rate`
  is the org's auto-start window; wording in `error` for the two that carry one (`paused`, `blocked`).
- **`ticketQueueAdmission` validates the key** (`isIssueKey` + `TICKET_KEY_MAX`, bounded `siteKey`)
  — the sweep path's fields come straight off an agent's `jira` block, and Android TYPES `issueKey`
  atomically, so an object/20k key from one host would break every phone's decode fleet-wide. Also
  keeps an unvalidated key off `spawnTicket`.
- **Three admission limits, `ticketQueueAdmission` decides between them**: `TICKET_QUEUE_PER_ORG_MAX`
  is the real line (drains per org, so one org's backlog must not refuse another's Start);
  `TICKET_QUEUE_PER_ORG_AUTO_MAX` is the sweep's share of it (an opted-in org refills every 15s, so
  without a reserve the starvation moves onto the person); `TICKET_QUEUE_MAX` is the memory bound
  behind both.
  - **A refused key is not a full queue** — the sweep must SKIP an unqueueable row and keep going.
    Only `fleet-full` ends a sweep; `org-full` ends that org's.
  - **State lines go through `logQueueState`** (throttled — the sweep re-derives every verdict every
    15s, so unthrottled logging repeats a still-true condition). Per-event lines are not throttled.
- **A MANUAL entry never leaves the queue silently.** Every way the hub gives up — blocked timer,
  stale timer, max-wait — goes TERMINAL (`reason:"expired"`, on the payload), never a silent drop.
  An AUTO entry always just goes (the next sweep re-queues if it still qualifies) — a reclaimed
  spawn (XERK-303) can arrive with nobody watching, so a silent drop is the failure this queue
  exists to stop. `giveUp()` in `drainTicketQueue` is the one decision point.
- **A hold is not forever** — `TICKET_QUEUE_MAX_WAIT_MS` backstops all of them: an entry whose
  ticket no org lists any more ages out (`TICKET_QUEUE_STALE_MS`, long enough to ride out a poll
  gap/restart); one nothing can route ages out (`TICKET_QUEUE_BLOCKED_MAX_MS`).
  - **A routing failure HOLDS; it does not drop** — dropping an auto entry re-queues it into the
    sweep's arms, churning the log/payload/chip for as long as the org stays down. Exception: a
    ticket with **no triaged repo** (the sweep can't re-queue it) leaves without churn.
- **A spawn stranded on a host that dies before taking it is reclaimed**
  (`reclaimStrandedTicketSpawns`, XERK-303) — the queue's guarantee ends at dispatch, so an
  undelivered command on a dead host was unrouted work waiting out `PRUNE_AFTER_MS` (a week) with no
  board surface. Runs on the 15s sweep **ahead of `drainTicketQueue`**, same tick. Ordering vs.
  `autoStartSweep` is **not** load-bearing.
- **Three preconditions guard the withdrawal**, each the fix for a specific failure mode:
  - **`deliveredAt` is ABSENT** — never merely "the host is offline" (a host routinely goes silent
    between delivery and ack; withdrawing there duplicates the session). A delivered command is
    left alone — it re-delivers and runs when the host returns.
  - **The command carries `ticketSite`+`ticketSource`** (the queue entry is gone, so these are the
    only record). Must come from the COMMAND, not the host's live `jira.siteKey` (self-reported,
    XERK-268 proves the host not the org — a host whose Jira config moved could re-queue another
    org's ticket). An unstamped command is **not reclaimed at all**.
  - **A host is free to take it RIGHT NOW** (`findTicketHost(..., {requireFree:true})`) — withdrawing
    into a queue that can't move it is worse than leaving it on the dead host, which would have run
    when the host returned. Covers a single-host org, a fully-down org, a dead-pinned ticket, and a
    merely BUSY one (`full` is deliberately not enough here — it's a wait that clears itself for a
    ticket already queued, but destroys a week on a dead host for four hours + a give-up note for
    one that isn't).
  - **Passes `issueKey`, inheriting XERK-325's triage rule** (`board-ticket-view.md`) — an untriaged
    host can't satisfy the precondition, so reclaim never withdraws into a refusing host.
  - **A command a FRESHER dispatch already superseded is withdrawn but NOT re-queued** (XERK-540,
    `dispatchSupersedes`). `committedTicketSpawn` (XERK-331) deliberately lets a manual Start through
    while THIS command sits undelivered on the offline host, routing a fresh spawn to a live one; that
    fresh Start records its own cmdId in `ticketDispatchedAt`. Reclaim compares the memo's cmdId to the
    stranded command's: equal = still the newest dispatch (re-route it normally); different + within
    `TICKET_DISPATCH_MEMO_MS` = superseded, so re-queueing would hand `drainTicketQueue` a MANUAL entry
    that skips the in-flight guard and start a SECOND session for the one ticket. Withdrawing without
    re-queue also stops the dead host running it on return (a lasting double-start). Checked BEFORE the
    repo/free-host/backoff preconditions — the superseded command is cleaned up whether or not a host
    is free right now. `rememberDispatch` records the cmdId at every dispatch site (both Start paths +
    `drainTicketQueue`), so the newest always wins.
  - Residue accepted: once reclaimed, an ordinary queue entry can be beaten to the slot by an older
    one and can itself expire — both now leave a terminal note, which is what makes it acceptable.
  - Admission is checked BEFORE withdrawal — a full org line can still refuse the re-queue.
- **A command restored from `state.json` is stamped DELIVERED at boot**
  (`sanitizeRestoredCommands`) — `deliveredAt` can't be reconstructed (the 30s save debounce may
  have missed the stamp), and restoring as undelivered would re-route already-run work past the
  in-memory de-dup. Deliberately NOT in `normalizeRecord` (shared with the ingest path where the
  stamp is truth). Cost: a spawn genuinely lost to a restart becomes unreclaimable.
- **An AUTO rescue SPENDS a retry** like the sweep's own — refunding it let two flapping hosts
  reclaim from each other forever. Costs the normal path nothing (first backoff step 60s, host must
  be silent 75s to qualify).
- **Junk in a restored `commands` list is dropped at restore** (`sanitizeRestoredCommands`) — the
  only door is a corrupt/hand-edited `state.json`; nothing on the wire reaches the array.
  - **Both the CONTAINER's type and the ELEMENTS'** — a non-array `commands` is REWRITTEN to `[]`,
    same rule as `normalizeSessions`.
  - **`autoStartSweep`'s read matters most** — it runs in a bare `setInterval` with no
    `uncaughtException` handler, so a bad element there EXITS THE HUB and re-fires 15s after every
    restart.
  - **Do not rely on the heartbeat's ack filter** — it only guards a host that BEATS; an offline
    host holding a stranded spawn never will.
  - Tests: the `XERK-303:` block in `server.test.js`.
- **A direct dispatch RETIRES that ticket's entry** (`rememberDispatch`) — left in place it fires
  again on the next free slot.
- **A manual entry is never retired by fleet state** — only cancel, its own dispatch, Done, or the
  bounded waits end it. Inferring the ask from session COUNT swallowed the click whenever another
  session appeared (sweep/operator/another board) or a count DIPPED (restart, eviction). A second
  session on a ticket is what the `+` button asks for, so count can't stand in for intent.
- **A terminal note counts against NO line and blocks nothing** — excluded from the org count, the
  fleet cap, and the sweep's "already queued" guard. Bounded on its own by
  `TICKET_QUEUE_NOTES_MAX`; `sweepExpiredNotes` runs on drain and on enqueue.
  - **Eviction is OLDEST-first** — the operator who gave up FIRST loses their note first (accepted:
    unbounded growth is worse; newest-first would drop unread ones).
  - In practice a note is for a PERSON who clicked — an auto entry's note is replaced almost
    immediately by the next sweep (auto-start never gives up, XERK-109).
- **Giving up is VISIBLE** — `TICKET_QUEUE_MAX_WAIT_MS` firing goes TERMINAL and stays on the
  payload for `TICKET_QUEUE_EXPIRED_TTL_MS` as "⌛ gave up waiting" + reason + ✕ + a live Start. A
  terminal entry holds no place in its org's line and is REPLACED (not returned) if re-queued.
- **Only `done` ends a manual entry on status** — moving to In Progress does NOT (the queue can't
  tell "a human picked this up" from "the session I asked for is starting").
- **A cancel that lost the race is refused, not blessed** — `dispatchedRecently`
  (`TICKET_DISPATCH_MEMO_MS`) makes a too-late cancel a **409**, not a 404 (which reads as "worked").
- **`publishTicketQueue` invalidates the cache synchronously but COALESCES the SSE frame** to end of
  turn — a frame per queued entry cost 201 frames/2.8MB for one 200-ticket backlog.
- **`source` decides what may sweep an entry away.** Turning an org's Auto off drops its `auto`
  entries only. A manual click on an auto-queued ticket **upgrades** it to `manual`. The sweep's own
  guards (already-has-a-session, spawn-in-flight) must NOT apply to a manual entry — a second
  session is a thing an operator can ask for. Both sources drop on Done; auto also drops leaving To Do.
- **Queuing spends no auto-start attempt** — `autoStarted`'s backoff stamps at DISPATCH (it exists
  for an ACKED spawn that left no session), so sitting in line commits nothing.
- **In-memory** — a hub restart drops the queue rather than replaying stale intent as a burst.
  Auto entries return on the next sweep; a manual one must be clicked again.
- Clients paint from the payload with a short-lived local overlay for one click's round trip
  (`queueView`, retired the moment the hub agrees). Card replaces Start with wait+✕.
  - **`board.html` re-reads the whole payload on an SSE RECONNECT** — the queue is hub-MEMORY, so a
    restart empties it with no event the socket could carry, and the 15s poll only runs while SSE
    is down. Android polls every 6s regardless, so it never had this gap.
- Tests: the `XERK-296:` cases in `server.test.js`, `board.test.js`, `BoardTest.kt`.

## Repo importance tiers (XERK-487)

Per-repo tiers weight triage ordering and policy above raw ticket priority ("a bug in the
live-serving hub" over "a docs nit in an archived repo"). Hub-owned durable state, mirroring
`autoStartOrgs`/`orgColors`: `REPO_TIERS_FILE` on `/data`, its own SSE frame, rides `/api/agents`
as top-level `repoTiers`. `REPO_TIER_SEED` (env JSON `{repo: tier}`) is a one-shot boot seed for
repos the durable file lacks — operator edits always win.

- **Four tiers, a TOTAL ORDER**: `REPO_TIERS = [ignore, archive, active, live]`, rank = index
  (higher = more important). Keyed by the **same repo name `repoGuess`/`ticketRepo` yields**, so it
  joins cleanly to a ticket's triaged repo.
- **Unset = the DEFAULT middle tier `active`, never top** — the "can't tell" answer. It outranks an
  explicitly archived repo, is outranked by a live one, and **still routes** (only `ignore` is ever
  withheld). Silence must never promote a repo above one an operator marked live. Only NON-default
  tiers are stored; `setRepoTier(repo, "active")` deletes the key.
- **The read seams the rest of triage consumes**: `repoTier`/`repoTierRank` for [E]'s priority key
  (tier is a TIEBREAKER **below** priority+type — E sorts by those ahead of it) and [F]'s allow/deny;
  `isRepoIgnored` for the one policy this store owns outright.
- **`ignore`-tier repos never auto-start.** `autoStartSweep` skips them (never enqueued) and
  `drainTicketQueue` drops an AUTO entry whose repo was retiered to ignore mid-wait — no churn, like
  a ticket that lost its triaged repo. A MANUAL start is deliberate intent and is **not** tier-gated.
- **Auto-stream ordering**: the sweep sorts each org's ready tickets by `repoTierRank` desc (STABLE,
  so same-tier keeps board order) before enqueue, so higher-tier tickets take the scarce auto slots
  first. Until [E] lands this is the only ordering the auto stream has; E folds tier under
  priority+type without changing this seam.
- **The `/api/repos/<repo>/tier` route** (POST `{tier}` or `{auto:true}`) mirrors `/autostart`:
  user-authed, durable-authoritative on the 200, and the repo must be one the fleet reports (or
  already tiered) — no phantom repos, no unbounded key growth (`REPO_NAME_MAX`). A public/Android UI
  is deferred (optional per the ticket); config-seed + route operate it for now.
- Tests: the `XERK-487:` cases in `server.test.js`.
