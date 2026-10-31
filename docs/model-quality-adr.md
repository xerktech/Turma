# Model quality loop — ADR (XERK-1839)

Status: accepted (operator, 2026-10-11). Supersedes the XERK-1827 delivery-only ladder as the
basis for putting ticket work on a cheaper model.

## Problem

The XERK-1827 ladder escalates only when a session delivered NOTHING. A cheap model's
plausible-but-wrong PR that passes CI counts as delivered, and its defects surface weeks later,
when nobody remembers which session or model wrote the code. The bench (`bench/run_policy.py`)
grades known past fixes, not new tickets. The operator trusts Opus; a cheaper default needs
evidence from real work that it does not ship worse code.

## Decisions

1. **Provenance is hub-owned, never written into git.** Some orgs require commits authored by the
   user with no model attribution, so nothing about the model goes in a commit, trailer, author
   or PR body. The hub joins ticket → session → model → PR → merge commit itself.
2. **Evidence and policy pool across orgs, never across tenants.** "Sonnet is good at bug work"
   is learned from every org's tickets of one TENANT and applied to that tenant's orgs. Aggregates
   are counts per (work class, model); per-session ROWS stay org-scoped on any org-filtered
   surface. No routing prior is shared between tenants (XERK-2550, `docs/multi-tenant-adr.md`).
3. **QA and review always run on Opus**, whatever model did the work. A grader no stronger than
   the author shares its blind spots; QA is ~9% of sessions, so it is cheap insurance.
4. **A cheaper model earns a work class in shadow before it touches a real PR**, and is demoted
   automatically when live outcomes regress.
5. **Savings that cannot cost quality ship first**: trimming the fixed per-turn context
   (~12% measured) and keeping read-only search sub-agents cheap.

## Work class

- The class of a ticket is its tracker type, lowercased: Jira `issuetype.name`, ADO
  `System.WorkItemType` (`bug`, `task`, `story`, …). Missing → `other`. Epics are never work.
- Class is deliberately coarse: it must accrue enough tickets per (class, model) to compare.
  Finer classes (labels, repo, size) are a later refinement, not a starting point.

## The outcome ledger (hub)

- Durable hub store, the permission/usage-ledger pattern: a `/data` file, Postgres under HA.
- One row per ticket SESSION, keyed `<siteKey>/<issueKey>/<sessionId>`:
  `org, host, repo, issueKey, class, model, runtime, kind (live|shadow), startedAt, endedAt`,
  `prs[] {url, state, mergedAt, mergeSha}`, `reopenedAfterDone`, and the signals below.
- Rows are built from what the heartbeat already carries (sessions, `closedSessions`, PR status,
  board rows) — the ledger is a durable FOLD of beats, so a closed session evicted from the
  agent's `closedSessions` is not forgotten.
- Signals and their source:

| signal | source | meaning |
|---|---|---|
| PR merged / closed unmerged | agent PR status | closed unmerged = bad |
| ticket reopened after Done | board status transitions | bad |
| merge commit SHA | agent PR status (`mergeCommit`) | needed for attribution |
| QA passes + verdicts | agent transcript (qa / qa-delta results) | rework cost |
| CI red→green rounds | agent PR checks transitions | rework cost |
| changes requested | PR `reviewDecision` | rework cost |
| defect attributed | attribution worker (below) | bad, delayed |
| revert of the merge | attribution worker | bad, delayed |

- **Outcome of a row**: `bad` if any bad signal; `good` if merged and the defect window
  (`MODEL_QUALITY_WINDOW_DAYS`, default 90) has elapsed clean; else `pending`. Rework signals are
  reported, not part of good/bad.
- Served as `/api/model-quality`: per (class, model) counts of good/bad/pending, rework medians,
  and the shadow pairs. Unauthenticated `/metrics` gets counts only.

## Defect attribution (agent worker, off the beat)

- SZZ: for each newly merged commit on a repo's default branch that is a FIX (its ticket's class
  is `bug`, or it reverts a commit), blame the lines it deleted or changed on its parent. The
  commits that last touched them are the suspected introducers.
- Each introducer maps to its PR through the forge (`commits/<sha>/pulls`), and the hub maps the
  PR to its ledger row. A commit with no ledger row (human work, direct push) is UNATTRIBUTED and
  excluded from every model statistic — it is never counted against "the user".
- Back-filled over existing history once, which gives the Opus baseline defect rate now.
- Known noise: SZZ over-attributes (refactors, whitespace); ignore whitespace-only and
  test-only lines. It is a rate signal, compared between models on the same noise.

## Shadow runs

- After a live ticket's PR merges, the hub may dispatch a SHADOW session for the same ticket on a
  candidate model, on a host decided into the ticket's org (it needs that org's repo access),
  based on the merged PR's PARENT commit.
- A shadow session can never publish: no push, no PR, no tracker write, enforced by the safety
  guard on a session flag — not by the prompt.
- An Opus grader then scores the shadow change: the merged PR's tests applied to it, a QA pass,
  and a design comparison against what merged. The result is a PAIRED row (same ticket, two
  models), so far fewer tickets are needed than for an unpaired comparison.
- Sampled (`MODEL_SHADOW_RATE`, default 0.25 of merged live tickets) and capped per day
  (`MODEL_SHADOW_DAILY_MAX`), so its cost is bounded and visible.
- Shadow rows never feed the live defect rate (they never merge).
- Shipped in XERK-1847; operative rules in `.claude/rules/model-quality.md`. The grader runs as a
  second Turma session on Opus in its own worktree at the shadow's commit, and reports through the
  session CLI (`shadow-grade`), so no model call is made by the hub.

## Routing policy

- `MODEL_POLICY=off|observe|on` (default `observe`: record, shadow, report; route nothing).
- Promotion of model M for class C, evaluated per tenant (XERK-2550):
  - at least `MODEL_PROMOTE_MIN_PAIRS` (default 40) graded shadow pairs for (C, M), and
  - M-only failures (Opus good, M bad) are ≤ 5% of pairs, with a 95% Wilson upper bound ≤ 10%.
- A promoted (C, M) starts unpinned tickets of class C on M. The operator's model pin always wins.
- Every non-Opus session must pass Opus QA AND an Opus code review of its diff before opening a
  PR; the hub's directive says so and the PR summary records both verdicts.
- Tripwire: live (C, M) bad rate whose Wilson lower bound exceeds the Opus baseline for C demotes
  (C, M) back to Opus and notifies the operator. Demotion is sticky until new shadow evidence.
- The XERK-1827 ladder is retired when the policy ships; its delivery-only signal is subsumed.
- Shipped in XERK-1848; operative rules in `.claude/rules/model-routing.md`. The tripwire's live
  rate counts bad over bad + good + merged-in-window on both sides, since `good` needs the whole
  defect window to elapse.

## Delivery

An epic, one child per seam, each its own PR:

1. ledger + class + `/api/model-quality` (XERK-1839)
2. agent signals: merge SHA, QA verdicts, CI rounds, changes requested (XERK-1845)
3. defect attribution worker + back-fill (XERK-1846)
4. shadow runs + Opus grader (XERK-1847)
5. routing policy, Opus review gate, tripwire, ladder retirement (XERK-1848)
6. quality report page, web + Android (XERK-1849)
7. trim the fixed per-turn context; root `CLAUDE.md` is at the 40k cap (XERK-1850)
8. pin QA / review sub-agents to Opus fleet-wide (XERK-1851)

## Open questions

- Whether a coarse class is predictive enough; revisit once each class has 40 pairs.
- Grader agreement: spot-check a sample of shadow grades by hand before the first promotion.
