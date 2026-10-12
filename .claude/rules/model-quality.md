---
paths:
  - "turma/outcome-ledger.js"
  - "agent/hub-agent.py"
  - "turma/tests/outcome-ledger.test.js"
  - "turma/server.js"
  - "docs/model-quality-adr.md"
---

# Model quality loop — the outcome ledger (XERK-1839, epic XERK-1844)

Decisions + the full plan (signals, attribution, shadow runs, routing): `docs/model-quality-adr.md`.
This file is the operative rules for what has shipped.

- **Model provenance is hub-owned, never written into git.** Some orgs require user-authored
  commits with no model attribution; never add a model trailer/author/PR-body line for this.
- **Evidence is FLEET-WIDE.** `aggregate()` groups per (work class, model) across every org —
  "sonnet is good at bug work" is learned and applied everywhere. Per-session ROWS are served only
  for an org the caller names (`/api/model-quality?org=<site>&rows=1`). Never org-scope the groups.
- **The hub observes; nothing is agent-sent.** `outcomeLedgerSweep` (leader, on
  `masterOrchestrationTick`) folds `sessions` + `closedSessions` + `fleetTicketRows()` into rows
  keyed by the JSON tuple `[site, issue, host, sid]`, so a session the agent's closed cache
  evicts is not lost. **Never a `/`-joined key**: an ADO site key is `dev.azure.com/<org>`.
  - Only a host DECIDED into the session's `ticket.siteKey` (`decidedOrgOf`) contributes — the
    siteKey is agent-asserted.
  - A paused sleeper is skipped (waiting, not ended); a `queued` record has no work yet.
- **Work class = the tracker's issue type**, lowercased (`workClass`), "other" when unknown. Coarse
  on purpose so each (class, model) collects enough tickets to compare.
- **Model = the family that ANSWERED** (`modelActual`), else the spawn alias, else "default"
  (`modelFamily`). Once a real model is seen (`modelKnown`) an alias never overwrites it.
- **Outcome is DERIVED at read time** (`outcomeOf`), never stored: reopened → bad; merged →
  pending until `MODEL_QUALITY_WINDOW_DAYS` (90) passes, then good; every PR closed unmerged → bad;
  a stale close (not-reproducible / already-fixed) → no-change; ended with nothing → undelivered.
  - **MERGED is terminal** in `mergePrs`: a stale later read never moves it back.
  - **Reopen marks only rows that started BEFORE the Done** — a later session is the reopened work.
    `doneAt` is the tracker's `resolved` time when the board row has one, else the sighting —
    sighting-time alone marked a session begun while the board lagged as the cause.
  - Known over-count: a migration's killed source record reads undelivered (same as the ladder).
- **Persistence = the permission ledger's two backends**: `/data/outcome-ledger.json` (non-HA),
  Postgres `outcome_session` (HA, upsert monotone on `updated_at`, rescanned on the ready edge and
  in `onLeaderPromoted`). Never `registerExternalStore` (whole-value writes). Flushed on drain.
- **Bounded against one host or org churning session ids**: a host keeps at most
  `OUTCOME_LEDGER_HOST_MAX_ROWS` (a quarter), and past `MAX_ROWS` the org holding the most rows
  loses its oldest first — plain oldest-first let one host evict every other org's evidence.
  Evicted keys are DELETEd from Postgres too, so the table is as bounded as the model.
- **Under HA a sweep folds nothing until a rescan loaded the table** (`backend.loaded`): a
  promoted leader's stale snapshot would otherwise win the newer-wins upsert.
- **`/metrics` carries per (class, model, outcome) gauges only** — no host, ticket or session.
  Labels are BOUNDED: a model outside opus/sonnet/haiku/default reads `other`, and only the 20
  largest classes keep their name (both are agent/tracker strings on an unauthenticated route).
- **Rework signals ride the agent's existing reports** (XERK-1845), reported beside the outcome,
  never part of good/bad: `aggregate()` serves each group's `rework.<signal> = {median, n}` over
  the rows that reported it.
  - Per PR (`session.prs`): `mergeCommit` + `mergedAt` (merged only), `ciRounds` (red→green,
    observed at the PR-refresh cadence, so a floor), `changesRequested` (GitHub exact from its
    review list; GitLab/ADO edges into a changes-requested state). Agent: `_pr_merge_fields`,
    `_carry_pr_rework`, carried in `pr-status.json` across restarts.
  - Per session: `qaRuns: [{agent, verdict}]` off the transcript (`_scan_qa_entry`): a qa/qa-delta
    `Agent` launch, its verdict from the sync tool_result or the background hand-back
    (`<agent-message from=<agentId>>`, the id only from the structured launch record). Kept on the
    registry record; `[]` = known zero, ABSENT = an older agent ("can't tell", not counted).
  - `qaPartial` (the scan began mid-transcript: a manager restart, upgrade or resume) marks the
    list a floor; the ledger row gets a sticky `qa.incomplete` and is left out of the QA medians.
    A fresh launch pre-primes its scan state (`_launch_tmux`) so it is never partial.
  - Every counter only RISES in the ledger (a closed record can carry less); an agent's
    `mergedAt` earlier than the sighting replaces it, even past MERGED.
  - `closedSessions[]` carries `modelActual` + `qaRuns`, so a session first seen closed is not
    credited to its spawn alias. `wireQaRuns` uses inline literals (reached from the restore).
  - A hand-back counts only as a WHOLE frame (`QA_AGENT_MESSAGE_RE` anchored), a refused/errored
    launch (`is_error`) is no run, and the report's own verdict LINE beats a quoted one.
  - Known: a mid-session `/model` switch still credits the whole session to the LAST model; a
    RESUMED qa agent's later report is not re-delivered as a hand-back, so its first verdict sticks.
- **Defect attribution is SZZ on the agent, the join on the hub** (XERK-1846). Agent: a
  `defect-scan` thread every `TURMA_DEFECT_SCAN_EVERY` (1800s; `TURMA_DEFECT_SCAN=0` off) fetches
  each repo's default branch and walks new first-parent commits from a per-repo cursor
  (`defect-scan.json`); the first scan back-fills `MODEL_QUALITY_WINDOW_DAYS`.
  - A FIX is a revert or a commit whose subject's ticket key classes `bug` (board cache, else the
    tracker; a tracker error stops BEFORE that commit so it is retried, never skipped). A revert's
    `This reverts commit <sha>` line counts only line-anchored and only when the sha is an ancestor;
    for a merge commit the merged branch's messages are read too (a revert PR merged with a merge).
  - Commits are listed as `%H %ct` only and each message read separately: a `%x1e`-delimited log
    let a commit message forge a whole record (QA).
  - Its first-parent diff (`-w`, `-M` — a rename blamed the whole file) is blamed `-w`; test paths
    and pure additions blame nothing; `--- ` is a path only in a file's header (a deleted `-- `
    comment line is not). Boundary/shallow-graft commits are never introducers.
  - Each blamed commit is mapped to the first-parent commit that LANDED it (`_defect_landing`):
    itself for a squash, else its PR's merge commit — the ledger's `mergeCommit`. That is the
    topologically first `--ancestry-path` descendant on the first-parent set: `--topo-order` (dates
    can be skewed), never `--first-parent` (git then finds only a branch's TIP commit).
    One it cannot place stands as itself; its forge lookup falls back to the blamed commit.
  - A revert line must be git's own (`This reverts commit <sha>.` alone on its line); a branch
    that reverts a commit and then reverts that revert reverts nothing (judged by chain parity).
    A SQUASH message naming any commit off the default branch carried such a chain flattened
    into one message, so it names no revert target at all (its parity cannot be read).
  - A commit git cannot read or diff (root, graft, timeout) is logged and SKIPPED, never retried
    forever: one commit must not stop a repo's scan.
  - Introducers map to MERGED PRs via the forge (GitHub `commits/<sha>/pulls`, GitLab
    `merge_requests`); ADO has none, so the hub also joins on the PR's `mergeCommit`.
  - Reports are HELD (500, 30 days) and re-sent as a rotating page each beat (`defectReports`), so
    no ack is needed — the hub folds idempotently. Never make it a deliver-once outbox: the fold
    runs on the HA leader's sweep, not on the replica the beat reached.
  - Hub: `normalizeDefectReports` coerces them onto the record (never served); `outcomeLedgerSweep`
    calls `attributeDefects` with the host's DECIDED org — only that org's rows can be marked.
  - A row is marked (`defects[]` → outcome bad, reason `defect`/`reverted`) only when the fix landed
    after its PR merged and inside the window, and never by its own PR. No row = unattributed,
    excluded from every model statistic.
  - Known: ticket keys are Jira-style or ADO `AB#1` in the SUBJECT (a merge commit's branch name
    counts); a rebase-merged PR's commits land as themselves, so they join only through the forge.
- The module must be in `turma/Dockerfile`'s `COPY` line (pinned by the image-copy test).
- Tests: `turma/tests/outcome-ledger.test.js`; the `XERK-1839:`/`XERK-1845:` cases in
  `server.test.js`; `TestQaRunScan`, `TestPrReworkFields`, `TestReworkSignalsReachTheWire`, `TestDefect*`;
  the `XERK-1846:` cases.
