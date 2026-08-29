---
paths:
  - "turma/server.js"
  - "agent/hub-agent.py"
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "glasses/src/vendor/board.cjs"
  - "android/app/src/main/java/com/xerktech/turma/core/Board.kt"
  - "turma/tests/server.test.js"
  - "turma/tests/board.test.js"
  - "android/app/src/test/java/com/xerktech/turma/core/BoardTest.kt"
---

# One view of a ticket: routing, and the hub agreeing with the board (XERK-325)

Split out of `.claude/rules/turma-board.md`. Read that file for the board around this (card, Start
button, detail panel) and `.claude/rules/turma-ticket-queue.md` for the queue a ticket waits in.

**Scoped to the CLIENTS as well as the hub on purpose** — this rule has mirrors on both sides of the
wire, and a hub-only `paths:` file would be absent exactly when the drifting half is edited.

A ticket's repo, status and existence must read the same to the hub as to the card. They have
diverged silently **eight times** over this feature's life, each divergence either withholding work
or destroying it — the fixture list below exists because a green suite passed every time until the
specific fixture that caught it was added.

- **Only a TRIAGED host is eligible at all** (`hostTriagedTicket`), filtered ahead of capacity and
  cloned-repo preference. Triage is per-host (own ledger, own model run, own candidates) while
  `ticketRepo` publishes the FRESHEST host's answer fleet-wide, so the pool routinely holds hosts
  with no decision for a ticket the board already chips; routing to one is a spawn that cannot run.
  - **Agreement with the published repo is part of the test**, not just having a decision — a host
    that answered a DIFFERENT repo would spawn against that one instead.
  - **ONLINE-first is the rule everywhere a tracker block is resolved across hosts** — hub-side one
    function, `blockOutranks` (`ticketRepo`, `fleetTicketRows`, both sweeps; a new site with its own
    tie-break copy is a defect, guarded by test); client-side `mergeSites` + its two vendored copies
    + Android's `Board.kt`. All rank an online host's block above any offline one, freshness only
    breaking ties within a tier. Hosts poll independently (~10min apart), so an offline host holding
    the freshest block is ordinary — resolving it wrong either stalls a runnable ticket (hub) or
    shows a repo Start will never spawn against (card).
  - **Agreeing with the board is TWO things — grouping AND tie-break — broken independently
    multiple times.** `fleetTicketRows` groups by (siteKey, **user**), keeps that group's best
    block, then unions the winners. Skipping the grouping (unioning raw hosts) resurrects a
    same-user pair's losing block, reviving a dropped ticket for auto-start. Only `fleetTicketRows`
    and `hostTriagedTicket` may read a block's `tickets`; a test pins that as a tripwire, not a proof
    — its own comment lists what still escapes it.
  - **`ticketRepo` reads the resolved ROW; it does not rank blocks itself** — ranking there was
    subtly wrong twice (ignored the newer-`updated` override; showed untriaged when the winning
    block had no `repoGuess`).
  - **A strictly newer `updated` beats block rank** for a key two groups both report — compared as a
    STRING (both mirrors). `Date.parse` is the plausible "fix" and is wrong twice: treats `+0000`/`Z`
    as unequal, and an absent `updated` → NaN → every comparison false.
  - **Four known ways the row and a block rank can disagree, each needing its own fixture**: a
    winning copy UNTRIAGED; triaged DIFFERENTLY; their intersection (untriaged wins on `updated`
    over a triaged older one); and NO `updated` at all (dropping the `|| ""` fallback makes
    `String(null)` sort above every ISO date). **Assume a fifth** — write the fixture where row and
    block-rank disagree before trusting a green suite on a resolver change.
  - **`fetchedAt` compares with plain `>`/`<` in every mirror, both group-pick and winner-sort** —
    `board.js` once mixed `localeCompare` and `>` and disagreed with itself.
  - **`ticketRepo` feeds THREE routes** (Start POST, `drainTicketQueue`, `autoStartSweep`), each
    needing its own behavioural test — a divergent resolver wired into the sweeps once passed the
    whole suite while auto-starting a ticket the board showed untriaged. Pass the caller's `rows`
    where one exists (rebuilding per queued entry cost a full queue 45x its drain time).
  - **This diverged three times because a site re-derived the view itself** instead of calling the
    shared resolver. Costs, all silent and user-visible: `autoStartSweep` queued a ticket no card
    showed (no chip, no reason, no ✕) while never starting the visible ones; `autoStopSweep`
    **killed a running session** over a Done status only an offline host saw, while the card still
    showed To Do — the most damaging, since it destroys rather than withholds, and bypasses the
    auto-start opt-in; `fleetTicketRows` fed the drainer's Done check, so a manual Start vanished
    silently; both sweeps resolving an org to ONE block missed an org's second Jira user entirely.
  - **The board's ticket LIST goes with the winning block**, not just the repo chip — a ticket only
    an offline host's fresher block carries stops being shown (hub still resolves it; `lastFetched`
    is the staleness cue). An online host's ERRORED poll shows an empty board, visibly.
  - **`fetchedAt` is the MAX across winner blocks, never the winner's own** — with online-first
    ranking the chosen block can be older, understating freshness. Both `board.js` and `Board.kt`
    take the max.
  - **`blocked`, never `full`** — a freed slot doesn't grant a triage decision.
  - **`full` means full of the hosts that AGREE** — the triage filter runs BEFORE capacity
    precisely so the two refusals stay distinguishable (else a full agreeing host reads `blocked`
    and ages out instead of waiting for its slot).
  - **A PIN to an untriaged host is checked AFTER that host's capacity check** — untriaged is
    usually a transient few-minute gap (a queued entry dispatches once triage lands); refusing there
    would throw away the click for the common case. `full` is what makes the POST queue rather than
    lose it.
- **A refused spawn ends the card's wait with the agent's reason** (`spawnRefusals` by cmdId,
  XERK-265). `startSweepVerdict` checks it before the `sawCmd`/timeout heuristics — a silent
  "clear" there is indistinguishable from a spawn that WORKED. Absent = "can't tell" (old timing
  rules apply).
