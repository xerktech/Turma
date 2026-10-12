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
- **Shadow runs (XERK-1847), only under `MODEL_POLICY=observe|on`** (default observe):
  - **Hub samples, leader-only** (`modelShadowSweep` after `outcomeLedgerSweep`): a live claude
    row whose PR MERGED with a `mergeCommit`, merged within `MODEL_SHADOW_MAX_AGE_DAYS` (7).
    Sampling is a deterministic hash of the row key (`MODEL_SHADOW_RATE`, 0.25) and the decision
    is persisted on the row (`shadow`), so nothing is asked twice. `MODEL_SHADOW_DAILY_MAX` (10,
    rolling 24h) leaves the rest undecided for a later day.
  - Model: of `MODEL_SHADOW_MODELS` (sonnet,haiku), never the live family, fewest pairs for the
    class. Host: online, DECIDED into the org, `modelShadow.available`, repo cloned (a shadow
    never clones), a free slot, claude default runtime, subscription not paused.
  - `spawnShadow` carries a hub-minted `sh-<hex>` id; `observeShadows` takes a host's
    `shadowRuns` report only for an id dispatched to THAT host in THAT org. A grade is final.
  - **Shadow rows never feed the live groups or `/metrics`**; `aggregate().pairs` serves per
    (class, candidate model) `pairs/graded/shadowGood/shadowBad/mOnlyFail/failed`, `mOnlyFail` =
    shadow bad while the live row is not bad (the promotion rule's numerator, XERK-1848).
  - Agent (`spawn_shadow` → `_advance_shadow_runs`): RUN session on the candidate from the merge's
    first parent, blind (comments after the live session started are dropped, no attachments, no
    fetch directive); `shadow-done` (or its end/timeout) commits leftovers and hands the HEAD to an
    Opus GRADE session; `shadow-grade` makes it terminal. A run with no change is graded bad
    without a grader. One session teardown per beat; the `turma-shadow/<id>` branch is dropped.
  - **Never a `ticket` block on either session** (and `_maybe_adopt_ticket` refuses a shadow), so
    no ticket sweep — auto-stop on Done, auto-merge, close-ticket, the ladder — acts on it. The
    hub raises no alert for a `shadow` session and lists it in no peer roster.
  - **No-publish is two layers.** The launch env (`SHADOW_ENV`) carries an EMPTY
    `url.<dead path>.pushInsteadOf` via `GIT_CONFIG_COUNT/KEY_0/VALUE_0`, which rewrites EVERY
    push URL (remote, path, file, https, ssh) for any git a child runs — a hook, `rebase -x`, an
    interpreter's subprocess — while fetch works; plus blanked tracker tokens, a non-token
    `GH_TOKEN`, `--strict-mcp-config` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`. On top, the guard
    (`TURMA_SHADOW`, `shadow_reason`, `agent-hooks.md`) fails closed per family and refuses any
    command naming the `GIT_CONFIG*`/`GIT_SSH`/`GIT_EDITOR` env. A text guard alone cannot close
    git's own command runners — never drop the env layer.
  - **A shadow is never resumed, migrated or paused** (`resume`, `_resume_at_cwd`,
    `export_session`, `_sleeper_unpausable`, hub `sleeperPausable`): relaunched it would carry none
    of its launch protections. The closed record keeps `shadow`, and every shadow session and
    transcript id is persisted (`_sessions` in `shadow-runs.json`) so a record that lost the flag
    is still refused. An operator-killed shadow's closed record + worktree are reaped.
  - Residual: a same-uid session can start a nested `claude` without `TURMA_SHADOW`, or strip the
    push block from an interpreter's own env (the ~/.turma class); an HTTP API write from an
    interpreter is unseen by the Bash guard where a credential survives (a stored `gh` token, an
    SSH key for a raw API). A live run session could also
    write its grader's `shadow-grade.json` (same class). Peeking at later git history is forbidden
    by the directive only (validity, not safety).
- The module must be in `turma/Dockerfile`'s `COPY` line (pinned by the image-copy test).
- Tests: `turma/tests/outcome-ledger.test.js`; the `XERK-1839:`/`XERK-1845:`/`XERK-1847:` cases in
  `server.test.js`; `TestQaRunScan`, `TestPrReworkFields`, `TestReworkSignalsReachTheWire`,
  `TestShadowRuns`; `TestShadowRun` (`test_guard.py`); the shadow cases in `test_session_cli.py`.
