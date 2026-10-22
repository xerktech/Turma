---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
  - "turma/public/org.js"
  - "turma/tests/org.test.js"
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Auto-merging + auto-closing (XERK-550, XERK-563, XERK-705)

Split out of `.claude/rules/turma-board.md`. Auto-start/auto-stop live there; epic-run merging in
`turma-epic-run.md`.

- **Removes the review/merge/close bottleneck for the class an org already auto-starts.** Opt-in
  **PER ORG** via a SECOND hub-only toggle (`autoMergeOrgs`, `AUTOMERGE_ORGS_FILE`, its own SSE +
  payload key), the sibling of `autoStartOrgs` in the header org menu. **OFF by default** — it MERGES
  to the default branch with no human review, so it is a deliberate per-project trust decision.
  Independent of the auto-start switch (either can be on without the other).
- **The eligibility gate is the SAME content gate auto-start uses** (`autoStartContentGate`: repo
  present + not ignore-tier, triage actionable/not-held/not-duplicate/not-rejected, org policy), so
  the class that auto-merges is exactly the class the auto stream would START. It is a SEPARATE
  composition from `autoStartSweep`'s inline gates (their per-drop log lines differ); a cross-check
  test pins the two agree.
  - **No issue-type floor (XERK-1440)**: any tracker Issue Type the content gate passes auto-merges
    — the org's triage auto-start settings (board → Triage policy, `excludeTypes`) ARE the knob for
    what merges hands-off. Narrow the policy to narrow auto-merge; there is no second bug-only gate.
    Epics + epic children never ride this stream (the content gate excludes them) — Jira, and ADO
    Epics/Features + their direct children (XERK-1444, `agent-board.md`); an armed epic run merges
    its own children via `epicRunChildSession` (`.claude/rules/turma-epic-run.md`).
    - A session spawned FROM a ticket (board Start, auto-start, queue) merges whoever started it —
      do not describe it as "only sessions the hub started". It is independent of the auto-START
      switch (`autoMergeOrgs`, never `autoStartOrgs`).
    - **A bare "new session" that the agent later ADOPTED onto a ticket never auto-merges**
      (`ticket.adopted`, `ticketAdopted()`), in the org stream AND an epic run, even when that
      ticket would qualify: the operator started it by hand and reviews its PR. An older agent
      never sends the flag, so its adopted sessions still merge until it updates.
  - **The ticket's org must be its host's DECIDED org** (`ticketOrgBound` = `decidedOrgOf(a) ===
    siteKey`, XERK-1445), in the org stream AND an epic run. `ticket.siteKey` is agent-asserted: a
    host bound to an org with auto-merge off could otherwise name another org's ticket and get its
    PR merged under that org's opt-in. Never re-key this on the claimed siteKey.
  - **A Done ticket is excluded** (`statusCategory === "done"`): moving to Done is the abandon/stop
    gesture (autoStopSweep kills the session), and autoStopSweep only QUEUES that kill, so the
    session still reads running for a beat — the column, not the run state, stands the merge down.
- Two sweeps on the 15s timer, both no-op unless an org opted in:
  - **`autoMergeSweep`** — for a **running, idle** eligible session (not `sessionWorking`, not blocked
    on a `question`/`panePrompt`), queue a **`mergePr`** command to the SESSION's host (it holds `gh`
    auth + the branch) for each PR reading `ready === "ready"` (green CI + `MERGEABLE` + no conflict,
    the flag the agent already computes). Backoff per PR url (`autoMergeState`: `{at, attempts,
    gaveUp}`); a merge `gh` refuses (`mergePrResults` `ok:false` — branch protection, review
    required, a fresh conflict) is marked `gaveUp` and never retried; a silent failure retries to a
    cap then gives up. The merge runs OFF the agent's beat (`_merge_pr_async`, a worker thread) — a
    blocking network call from `handle_commands` would risk the XERK-395 budget.
    - **A TRANSIENT gh failure (`mergePrResults` `retryable:true`) is NOT gaveUp** (XERK-563): the
      base-branch-modified race, a timeout, a 5xx. Only a PERMANENT refusal (`retryable` absent/false,
      the older-agent default too) gives up; a transient one rides the normal backoff up to
      `AUTO_MERGE_MAX_ATTEMPTS`. The agent classifies it (`_merge_error_retryable`); the hub reads the
      flag off the result.
    - **At most ONE merge per base repo in flight at a time, fleet-wide** (`prRepoKey`,
      `inflightRepos`/`dispatchedRepos`, XERK-563): a squash-merge moves the base, so a second
      concurrent merge to the same repo hits `Base branch was modified` and burns an attempt.
      Serializing lands several ready PRs to one repo one-per-sweep instead of racing them.
  - **`autoCloseSweep` — MESSAGE the session to self-close; never write Done or kill (XERK-705).**
    Once EVERY PR a session opened has **landed** and at least one actually **MERGED** (a purely-CLOSED
    PR never triggers it), the hub does NOT close the ticket and does NOT kill the session — a merged
    PR is one step, not proof the whole ticket is done (the session may have a follow-up PR, tests, a
    migration). It queues an **`input`** command (`AUTO_CLOSE_MERGED_MESSAGE`, the operator path so it
    rides the agent's `pendingInputs` outbox through a compaction) telling the running session to
    mark **its own ticket Done** once the work is truly complete. That Done edge then drives everything
    the hub used to force: `autoStopSweep` (XERK-45, opt-in-independent) kills the session and frees
    the slot, and for an epic-run child the driver advances the wave / completes the epic (below). So
    the sweep needs NO board-cred host to act, and no ticket ever closes behind live work.
    - **BOTH eligibility streams behave identically** — the ORG auto-merge stream (`autoMergeSession`)
      AND epic-run children (`epicRunChildSession`). **Each ticket self-closes**; the epic run no
      longer force-closes its children (the earlier XERK-637 direct Done+kill is gone). Arming a run
      still gets its child auto-MERGED and messaged; the child, like any session, decides when its
      work is done. **TRADE-OFF:** a session (org or epic child) that neither continues nor self-marks
      Done holds its slot, and for an epic stalls the wave — the deliberate cost of not closing behind
      live work.
    - **Re-fires per NEW merged PR, not per sweep**: `autoCloseNotified`
      (`<host>\x00<sessionId>` → `{at, urls:Set}`, bounded `AUTO_CLOSE_NOTIFY_MAX` oldest-first)
      remembers which merged urls a session was told about. A repeat sweep over the same merged set
      sends nothing; a FOLLOW-UP PR merging (a new url, all landed again) sends the message again —
      "until the ticket is marked Done and the session auto-closes." The `epicRunCompleteSweep`
      epic-Done write is unchanged (an epic has no session to message).
    - **The notified urls also ride the session's alerts edge** (`sa.closeNotified`, persisted in
      `state.json`) and are read when the map has none (XERK-2194, the `sa.nudged` pattern): a
      non-HA restart empties the map, and without it every all-landed session was messaged again.
      A sweep re-seats the edge from the map when a session-less beat swept it. HA failover is
      covered by the guard mirror. Test: `XERK-2194:` in `server.test.js`.
    - **The message is "verify it DEPLOYED and WORKS, then Done" (`autoCloseMergedMessage`), never
      "merged, so Done"** — a merge is not the finish line. It names only the NEWLY-merged url(s) and
      tells a failing session to open the follow-up on a FRESH branch off the updated default branch:
      the squash + `--delete-branch` merge means re-pushing the old branch re-proposes squashed commits.
    - **Multi-PR is the designed loop**: merge sweep skips landed PRs and merges each new one; close
      re-fires per new merged url; a Done ticket stands both down. Tests: `auto-close:`/`auto-merge +
      auto-close run through MULTIPLE PRs` in `server.test.js`.
- **The hub, not the session, watches a PR's CI and merge** (`prEventSweep`, after
  `autoCloseSweep` on the leader tick). Sessions are told not to poll either
  (`PR_SUMMARY_SYSTEM_PROMPT`); the hub types ONE `input` (`source:"nudge"`) when an OPEN PR's
  `checks` settles `passing`/`failing`, and when a PR reads MERGED.
  - **A merge `autoCloseSweep` will message is left to it**: an auto-merge/epic-run session whose
    PRs have ALL landed gets only the verify-then-Done message, never both. A merge short of that
    still gets the light "merged" one.
  - **Announced state rides `sa.prEvents`** (url → `{ci, merged}`, persisted with `alerts`, swept
    with the session), so a restart or failover re-sends nothing. A session with no `prEvents` yet
    is BASELINED silently — a hub upgrade must not announce every PR already green.
  - A settled verdict is NEW when it differs from the last rollup seen OR the PR's `head` moved:
    the agent polls about once a minute, so a short run goes settled -> settled with no pending.
    A DRAFT counts as open. A CI-less PR (`checks:null`) says nothing.
  - A head that moved with no rollup yet resets `ci` (GitHub lists no checks until they register),
    or the new run settling the same way reads as already announced (QA). GitLab sends the MR's
    `sha` and ADO `lastMergeSourceCommit` as `head` (XERK-2198), so all three forges re-announce.
  - **Every agent-sent field is type-checked** (`prEventDiff`, `prLanded`), and each session runs in
    its own try/catch: an object `state` threw in `String()` on the leader tick and exited the hub
    (QA). Session ids are read with `Object.hasOwn` (`__proto__`).
  - Only a strict URL shape (`PR_EVENT_URL_RE`: no `#`, `?`, `;`, quotes) is interpolated.
  - A beat with no `prs` array changes nothing, and a PR missing from a beat keeps its record (cap
    50 per session), so a flickering list never re-announces a merge.
  - Running sessions on online hosts only, never a shadow run. `PR_EVENT_MESSAGES=0` turns it off.
    Tests: the `PR events:` cases in `server.test.js`.
- **GitHub only for now** — the agent's `merge_pr` refuses a GitLab MR / ADO PR (staged `ok:false`)
  so the hub gives up rather than retrying. Merge method is `--squash --delete-branch`,
  env-overridable (`TURMA_AUTOMERGE_METHOD`/`_DELETE_BRANCH`).
- **Web ⇄ Android parity gap**: the org-menu auto-merge switch shipped on WEB only; Android ignores
  the `autoMergeOrgs` payload key (safe — unknown key) and has no switch yet. Tracked in
  `android/PARITY.md`; the hub route works from web regardless.
- Tests: the `XERK-550:`/`XERK-705:`/`automerge route:` cases in `server.test.js`, `TestMergePr` in
  `test_hub_agent.py`, the auto-merge switch case in `org.test.js`.

