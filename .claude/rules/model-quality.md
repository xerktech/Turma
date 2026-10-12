---
paths:
  - "turma/outcome-ledger.js"
  - "agent/hub-agent.py"
  - "turma/tests/outcome-ledger.test.js"
  - "turma/server.js"
  - "docs/model-quality-adr.md"
  - "turma/public/usage.html"
  - "android/app/src/main/java/com/xerktech/turma/**/ModelQuality.kt"
  - "android/app/src/main/java/com/xerktech/turma/ui/UsageModelQuality.kt"
---

# Model quality loop — the outcome ledger (XERK-1839, epic XERK-1844)

Decisions + the full plan (signals, attribution, shadow runs, routing): `docs/model-quality-adr.md`.
This file is the operative rules for what has shipped; the routing policy is `model-routing.md`.

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
  - Known over-count: a migration's killed source record reads undelivered.
- **Persistence = the permission ledger's two backends**: `/data/outcome-ledger.json` (non-HA),
  Postgres `outcome_session` (HA, upsert monotone on `updated_at`, rescanned on the ready edge and
  in `onLeaderPromoted`). Never `registerExternalStore` (whole-value writes). Flushed on drain.
- **Bounded against one host or org churning session ids**: a host keeps at most
  `OUTCOME_LEDGER_HOST_MAX_ROWS` (a quarter), and past `MAX_ROWS` the org holding the most rows
  loses its oldest first — plain oldest-first let one host evict every other org's evidence.
  Evicted keys are DELETEd from Postgres too, so the table is as bounded as the model.
- **A host reporting more sessions than its cap only fills the rows it has room for** (XERK-1853):
  past it a new row evicted one the host still reports, re-created next sweep — new `firstSeen`
  and Postgres upserts + deletes every 15s. Its newest sessions go unrecorded instead.
  - Room counts only rows the host STILL reports: counting its stale rows recorded none of its
    current work. Tests: the `XERK-1853:` cases in `outcome-ledger.test.js`.
- **Eviction never drops a row its host still reports while another will do** (XERK-1855):
  `evict(now, sweep)` takes the sweep's reported and created keys, and both the host pass and the
  fleet-wide pass drop unreported rows first, then rows created THIS sweep, then the oldest.
  - A row created and evicted in one sweep was never persisted: no upsert, no DELETE. Dropping a
    reported old row instead re-created it every sweep with a new `firstSeen`.
  - Orgs tied for the most rows: the one whose next victim ranks lowest loses — a first-found
    tie-break rotated a reported row between tied orgs forever.
  - A shadow row ranks as reported: `observeShadows` makes it, so `observe` never reports it, and
    evicting it re-created it every tick.
  - Load and rescan call `evict()` with no sweep — plain oldest-first.
- **The Postgres drain runs all upserts before all deletes**, so `onChange`/`onDelete` each cancel
  the key's queued opposite: a row deleted then re-created in one tick otherwise stayed deleted.
  - A failed DELETE batch re-queues only keys with no upsert queued since — an in-flight batch
    can't be cancelled, and re-queued whole it removed the re-created row on retry.
  - A pass loops until both queues are empty: ops queued during an in-flight batch drain too.
  - Tests: the `XERK-1855:` cases in `outcome-ledger.test.js`.
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
  - `qaPartial` (the scan began mid-transcript: a resume, a skipped >4 MiB backlog, or a restart
    with no usable snapshot) marks the list a floor; the ledger row gets a sticky `qa.incomplete`
    and is left out of the QA medians. A fresh launch pre-primes its scan state (`_launch_tmux`).
  - **A manager restart resumes the QA scan, it is not partial** (XERK-1857): the live-agents
    snapshot (`session-working.md`) also carries `qa` (this scan saw the whole transcript) and
    `qaCalls` (launches awaiting a result); `_restore_live_agents` folds its gap into
    `_scan_qa_entry`. Runs before its offset are already on the record. Only `qa: true` is
    trusted, so a partial scan's snapshot (or an older agent's) stays partial. Without this every
    self-update marked every live session incomplete, biasing the medians toward short sessions.
    Residual: a manager killed between the beat's publish and its record `save()` loses that beat's
    runs. Tests: `test_a_restart_resumes_the_qa_scan_from_the_snapshot` and siblings.
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
    shadow bad while the live row is not bad (the promotion rule's numerator, XERK-1848). The
    same evidence rides each group as `shadow: {pairs, candidateOnlyBad, …}` (what the XERK-1849
    card reads); a candidate with no live sessions gets a zero-session group carrying it.
  - Agent (`spawn_shadow` → `_advance_shadow_runs`): RUN session on the candidate from the merge's
    first parent, blind (comments after the live session started are dropped, no attachments, no
    fetch directive); `shadow-done` (or its end/timeout) commits leftovers and hands the HEAD to an
    Opus GRADE session; `shadow-grade` makes it terminal. A run with no change is graded bad
    without a grader. One session teardown per beat; the `turma-shadow/<id>` branch is dropped.
  - **Never a `ticket` block on either session** (and `_maybe_adopt_ticket` refuses a shadow), so
    no ticket sweep — auto-stop on Done, auto-merge, close-ticket, routing — acts on it. The
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
  - **These stop ACCIDENTAL publishing, not a shadow that deliberately tampers** (QA-reproduced:
    a `pushurl` written into `.git/config`, an interpreter clearing its env, a longer
    pushInsteadOf, a nested `claude` without `TURMA_SHADOW`, a stored `gh` token or SSH key). No
    same-uid layer closes that; the credential-level fix (no push credentials for a shadow) is
    XERK-1859. A live run session could also
    write its grader's `shadow-grade.json` (same class). Peeking at later git history is forbidden
    by the directive only (validity, not safety).
- The module must be in `turma/Dockerfile`'s `COPY` line (pinned by the image-copy test).
- Tests: `turma/tests/outcome-ledger.test.js`; the `XERK-1839:`/`XERK-1845:`/`XERK-1846:`/`XERK-1847:` cases in
  `server.test.js`; `TestQaRunScan`, `TestPrReworkFields`, `TestReworkSignalsReachTheWire`,
  `TestShadowRuns`; `TestShadowRun` (`test_guard.py`); the shadow cases in `test_session_cli.py`; `TestDefect*`.

## The report (XERK-1849): Usage page "Model quality" card, web + Android

- A card on `/usage` (`modelQualityCardHtml`) and Android's Usage screen (`ModelQualitySection`,
  ports in `core/ModelQuality.kt`) — its OWN fetch, never `/api/agents`, like the permission card.
- **Groups are fleet-wide whatever the header picks**; only the session drill-down follows it, and
  only when the filter resolves to EXACTLY one org (`TurmaOrg.get()` / `scope().singleOrNull()`),
  since the route serves rows for one named org. Several or none → "Pick one org…".
- **Bad rate = bad ÷ (good + bad)**; pending, no-change and undelivered say nothing about code
  quality. The Opus column is that class's Opus bad rate (the baseline), never a fleet average.
- **Rework renders one column per signal some group reported** (`MQ_REWORK` / Android
  `ModelQuality.REWORK`: qaRuns, qaFail, ciRounds, changesRequested): the cell is its `median`,
  `n` in the hover. A signal with no finite median is absent, never 0. A new signal needs a
  label on BOTH clients or it stays hidden.
- **Fields the later seams will serve, read when present** (absent = column hidden): per group
  `shadow: {pairs, candidateOnlyBad}` (XERK-1847), `promotion` string (XERK-1848, shown
  verbatim). A seam that names them differently must change both clients in the same PR.
- **Android reads the route field by field** (`parseModelQuality` over a raw `JsonElement`), not
  a typed decode: one wrong-typed field from a later seam drops to its default, as on the web,
  instead of blanking the card.
- **A pick change clears the old org's view AND error at once**, and a late answer for a scope
  since left is discarded (`mqStateOrg`/`mqFetchSeq`; Android `mqStateOrg`/`mqSeq`).
- Tests: the `XERK-1849:` cases in `usage.test.js`; android `ModelQualityTest`,
  `UsageModelQualityViewModelTest`, `ModelQualitySectionTest`.
