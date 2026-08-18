---
paths:
  - "turma/server.js"
  - "agent/hub-agent.py"
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "glasses/src/vendor/board.cjs"
  - "veiller/src/ui/vendor/board.cjs"
  - "android/app/src/main/java/com/xerktech/turma/core/Board.kt"
  - "turma/tests/server.test.js"
  - "turma/tests/board.test.js"
  - "android/app/src/test/java/com/xerktech/turma/core/BoardTest.kt"
---

# One view of a ticket: routing, and the hub agreeing with the board (XERK-325)

Split out of `.claude/rules/turma-board.md`, which it had grown past the size ceiling. Read that
file for the board around this (the card, the Start button, the detail panel) and
`.claude/rules/turma-ticket-queue.md` for the queue a ticket waits in.

**Scoped to the CLIENTS as well as the hub on purpose.** This is one rule with mirrors on both
sides of the wire, and a `paths:` file that loaded only for `turma/server.js` would be absent
exactly when someone edits the half that drifts.

The short version, and the reason this file exists: a ticket's repo, its status and its very
existence must read the same to the hub as to the card. They diverged in eight places over the life
of one ticket, every divergence silent, and each one either withheld work or destroyed it.

- **Only a host that has TRIAGED the ticket is eligible at all** (XERK-325, `hostTriagedTicket`),
  filtered ahead of the capacity and cloned-repo preferences. Triage is per-host — its own ledger,
  its own model run, its own candidate repos — while `ticketRepo` publishes the FRESHEST host's
  answer fleet-wide, so the pool routinely holds hosts with no decision for a ticket the board
  already chips. `spawn_ticket` re-derives from the local ledger and refuses those, so routing to
  one is a spawn that cannot run: the click did nothing and said nothing, on that host only.
  - **Agreement with the published repo is part of the test**, not merely having some decision: a
    host that answered a different repo would spawn against THAT one, giving the operator a session
    on a repo the card never showed. Candidate sets differ per host (cloned repos + that host's `gh`
    reach), so hosts legitimately disagree.
  - **ONLINE-first is the rule everywhere a tracker block is resolved ACROSS HOSTS.** Hub-side that
    is now ONE function, `blockOutranks` — `ticketRepo`, `fleetTicketRows`, `autoStartSweep` and
    `autoStopSweep` all call it, and a new site with its own copy of the tie-break is the defect
    (guarded by a test). Client-side it is `mergeSites` in `board.js`, its two vendored copies, and
    android's `core/Board.kt`. All of them rank an online
    host's block above any offline one, freshness deciding only within a tier. The hub and the card
    must resolve a ticket the same way — routing reaches only an online host that AGREES with the
    repo, so an offline host winning on freshness either stalls a ticket an online host could run
    (hub side) or puts a repo on the chip that Start will never spawn against (card side), which is
    the "a session on a repo the card never showed" hazard from the other direction. Hosts poll the
    tracker independently (~10 min apart here), so an offline host holding the newest block is
    ordinary. The offline tier stays as the fallback, or a wholly-offline org resolves no repo at
    all — the board goes blank and the sweep drops the ticket instead of holding it.
    - Ticket dedupe is by the ticket's own `updated`, which two hosts polling one tracker report
      IDENTICALLY, so **ties are the norm and the block order is what really decides a card's
      fields**. That is why the merge order, not the dedupe, carries this rule.
    - The queue tip mirrors it: a capacity hold says an agent **that can run it**, never "one of the
      org's agents" — a free host that answered a different repo will never take the ticket.
    - **Agreeing with the board is TWO things — the grouping AND the tie-break — and each has broken
      on its own.** `fleetTicketRows` is the hub's port of `mergeSites` and the only ticket-row view:
      group by (siteKey, **user**) keeping that group's best block, then UNION the winners, one row
      per key. A host polls as `assignee = currentUser()`, so an org whose hosts authenticate as
      different Jira users reports different lists and the board unions them; collapsing an org to
      one block loses the other user's tickets entirely. Unioning across raw HOSTS instead — the
      grouping skipped — resurrects the losing block of a same-user pair, so a ticket the board has
      dropped comes back and gets auto-started. Only TWO functions may read a block's `tickets` —
      `fleetTicketRows` and `hostTriagedTicket` (a per-host question, no ranking) — and a third is a
      new ranking site. A test pins that, because a behavioural test only catches one once some
      fleet shape happens to exercise it; it is a tripwire for the honest edit, not a proof, and
      says so — its own comment carries the measured list of what still escapes it, which is the
      part to update rather than the pattern.
    - **`ticketRepo` reads the resolved ROW, it does not rank blocks of its own.** Ranking there was
      subtly different and so wrong twice: it ignored the newer-`updated` override, so a card showing
      RepoA dispatched against RepoB; and where the winning copy carried no `repoGuess`, the card
      showed the ticket untriaged while the hub started it off a losing block's guess.
    - **A strictly newer `updated` beats block rank** for a key two groups both report — `mergeSites`'
      rule, compared as a STRING like both client mirrors. It fires only mid-poll, since the two
      copies normally carry the tracker's identical value, which is exactly why it needs its own
      test rather than riding on the others. `Date.parse` is the plausible "compare timestamps
      properly" edit and is wrong twice over: it calls `+0000` and `Z` equal, and on an absent
      `updated` it yields NaN, so every comparison goes false and the override stops firing.
    - **The row and a block rank disagree in THREE ways, and each needs its own fixture.** They were
      found one at a time, each after the previous was fixed, and every one of them passed the whole
      suite until its test existed: a winning copy that is UNTRIAGED (invent no repo), a winning copy
      triaged DIFFERENTLY (don't reach for the other one), and their intersection — an untriaged copy
      winning on `updated` over a triaged older one. A fourth is more likely than not; when the next
      resolver change lands, write the fixture where the two answers differ before trusting a green
      suite.
    - **`fetchedAt` is compared with plain `>`/`<` in every mirror, both in the group pick AND in
      the winner sort.** `board.js` once used `localeCompare` in its sort and `>` in its pick, so it
      disagreed with itself; "fixing" the hub to localeCompare only moved the divergence off the
      two-user shape onto the common same-user one. They differ only on a `fetchedAt` spelling no
      real agent emits (one `now_iso()` fleet-wide) — the point is that no one has to remember which
      half uses which.
    - **`ticketRepo` feeds THREE routes** — the Start POST, `drainTicketQueue` and `autoStartSweep` —
      and each needs its own behavioural test. A divergent resolver wired into the two sweeps passed
      the whole suite while auto-starting a ticket the board showed untriaged; only the POST was
      pinned. Pass it the caller's `rows` where one exists: rebuilding the map per queued entry cost
      a full queue 45x its drain time, synchronously, on every heartbeat.
    - **Do not count the mirrors and call it done — this diverged three times that way**, each time
      because a site re-derived the view itself instead of calling the shared resolver. What each
      omission cost, all of it silent and all of it user-visible:
      - `autoStartSweep` queued tickets present only in an offline host's fresher block — which no
        card shows, so the entry has no chip, no reason and no ✕, and it holds one of the org's auto
        slots until the blocked timer drops it — while never starting the To Do tickets on screen.
      - `autoStopSweep` **KILLED a running session** over a Done status only an offline host
        reported, while the card still showed the ticket in To Do. The most damaging of the set,
        because it destroys work rather than withholding it, and it is ungated by the auto-start
        opt-in so it reaches orgs that opted into nothing.
      - `fleetTicketRows` feeds the drainer's Done check, so a manual Start click was answered
        `{queued:true, position:1}` and discarded within one beat — the drop is a log line and the
        entry just vanishes from the payload.
      - Both sweeps resolving an org to ONE block missed everything belonging to an org's second
        Jira user: their To Do tickets were never auto-started, and auto-stop never ended a session
        for a Done the board plainly displayed.
    - **The board's ticket LIST goes with the block**, not just the repo chip: where an org's hosts
      poll as one user, the winning block supplies the whole list, so a ticket only the offline
      host's fresher block carried stops being shown (the hub still resolves it, and `lastFetched`
      is the staleness cue). If the online host's poll ERRORED its list is empty and the board shows
      nothing — visibly, since the block's `error` reaches the card.
    - **`fetchedAt` is the exception: it is the MAX across the winner blocks, never the winner's
      own.** Those were the same value only while the sort was freshest-first; with online winning,
      the chosen block can be the older one and its stamp understates how current the board is.
      Both `board.js` and `Board.kt` take the max.
  - **It is a `blocked` hold, never `full`.** A freed slot does not give a host a triage decision,
    so reporting it as capacity promises a wait that clears itself; the blocked timer bounds it and
    the reason says what is actually wrong.
  - **`full` still means full — but of the hosts that AGREE**, and the wording says so. The pool is
    the hosts that triaged this ticket to this repo, so reporting the ORG as full while a host that
    answered a different repo sits idle sends the operator to look at capacity they do not have a
    problem with. The triage filter runs BEFORE the capacity one precisely so the two refusals stay
    distinguishable; filtering after it would collapse a full agreeing host into `blocked` and age
    the ticket out instead of waiting for the slot it needs.
  - **A PIN to an untriaged host is checked AFTER that host's capacity check**, and not because
    either reason clears itself — neither does. `full` is what makes the POST queue the click rather
    than lose it, and being untriaged is usually the minutes-long gap before a triage batch returns,
    which a queued entry dispatches on its own; the permanent case ages out with the queue's visible
    "gave up" note. Refusing there would throw away the click for the common transient case.
  - The common case is a RACE, not a permanent split: a new ticket is untriaged on a host for the
    minutes its batch takes, and the drainer re-checks every beat. The permanent case is a decided
    `repo: null` — `_triage_stale` never re-triages that — which is what makes the symptom look
    host-specific rather than intermittent.
- **A refused spawn ends the card's wait with the agent's reason** (`spawnRefusals` by cmdId, the
  XERK-265 channel). `startSweepVerdict` checks it after the landed-session test and before the
  `sawCmd`/timeout heuristics: those only guess at what a drained command meant, and a silent
  "clear" is byte-for-byte what a spawn that WORKED looks like — which is what left the operator
  pressing Start again. An absent entry still means "can't tell", so older hubs and agents keep the
  old timing rules.
