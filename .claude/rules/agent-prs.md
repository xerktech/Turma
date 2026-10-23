---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# PR status, comment delivery and conflict nudges

Split out of `.claude/rules/agent.md` to keep that file under the size ceiling. All in
`hub-agent.py`: what makes a PR a session's, how its state is polled across GitHub/GitLab/Azure
DevOps, and what gets typed back because of it.

## PR status

- State, CI rollup and mergeability of every PR a session opened, on `PR_STATUS_REFRESH_EVERY`.
- The card's **single ✓/✗/● mark is merge READINESS, not CI** (`ready`, from `_merge_ready`): a
  conflict blocks on its own; a ✓ requires an affirmative MERGEABLE (a just-opened PR's UNKNOWN is
  `pending`). MERGED/CLOSED reports CI alone; a PR with **no checks** keeps its no-mark unless it
  CONFLICTS. `checks`/`checkCounts` stay pure CI beside it; all four renderers read `ready`, falling
  back to the CI half for older agents.
- Cached by URL in `pr_status_cache`, attached as `session.prs`, kept after the session stops.
  **Durable across an agent restart** (XERK-15, via `prUrls` on the record) and **for ENDED
  sessions/the pill too** (XERK-13) via two transcript-keyed ledgers outliving the registry record:
  `pr-sessions.json` (`PR_LEDGER_PATH`, `_remember_prs`, the only channel once a closed record ages
  out) and `pr-status.json` (`PR_STATUS_LEDGER_PATH`, seeded back at boot so an ended session's chip
  doesn't degrade to a bare link).
- **Which PRs are "a session's"** is `_scan_pr_line`, deliberately narrow: a URL counts only from a
  **creating call's own `tool_result`** (`PR_CREATE_RE`) — `gh pr create`; `glab mr create`/`git push
  -o merge_request.create` (XERK-162); `az repos pr create` (XERK-226, no link in its JSON, so
  `_azdo_created_pr_url` builds one from `repository.webUrl`+`pullRequestId`).
  - **On-prem ADO Server has no vendor CLI** (`az`'s extension refuses self-hosted), so those hosts
    open PRs with a local REST wrapper (`ado pr-create`/`ado.py pr-create`, both built in);
    `TURMA_PR_CREATE_CMDS` registers any other so a host isn't chipless for lacking a vendor tool.
  - `_pr_create_pattern` treats every command as literal escaped words, anchored so one can't match
    the tail of `run-mkpr`/`pr-create.md`. An entry under `PR_CREATE_CMD_MIN` chars is **ignored** —
    attribution must not fail open on a 1-2 char token.
  - ADO URL regexes take **http as well as https** (on-prem is routinely plain HTTP on the LAN).
  - **`gh api …/repos/<o>/<r>/pulls` with a request body is a create too** (`_gh_api_pr_create`) —
    what a session falls back to when `gh pr create` hits a GitHub GraphQL error. Never one without
    a body flag or forced to GET: that LISTS every open PR. Its output is the PR object, whose body
    can quote other PRs, so `_gh_api_created_pr_url` takes `html_url`, else exactly one distinct URL
    that also stands ALONE on a line (`--jq .html_url`); a `--jq .body` naming one PR in prose chips none.
  - **A BACKGROUNDED create** (`run_in_background`, or moved there on timeout) answers only "running
    in background"; its URL is in `<task>.output`. The task id is held in `state["pr_bg"]` and the
    file is read (tail, `O_NOFOLLOW|O_NONBLOCK`, regular only) when that task's
    `<task-notification>` lands on a `user`/`queue-operation` entry — never an assistant quote.
    Lost across a manager restart between launch and notification (the restart primes to EOF).
  - A FAST task's notification can land BEFORE the launch's tool_result, so notifications for
    unknown task ids are remembered (`state["pr_bg_done"]`, bounded) for that result to claim.
  - A command that is BOTH (`gh pr create … || gh api …/pulls`) reads by the stricter api rule.
  - **A GitLab API write to `projects/<id>/merge_requests` is a create too**
    (`_gitlab_api_mr_create`): curl, a python/node heredoc script, or `glab api` — what a session
    uses when SSH is blocked or glab is missing. `/merge_requests/<iid>` never counts.
    - **The write must be bound to THAT request** — every looser rule chipped a foreign MR
      (a listing's `data = …`, `cut -d`, "list, then POST a note/Slack" within N chars) and a
      physical-line rule dropped multi-line creates (QA, four passes).
      - A script path must sit INSIDE a call (`_mr_api_enclosing_call`, a backward depth walk,
        so a call closed before the path is stepped over). `.post(` writes; urllib's
        `Request(`/`urlopen(` with `data=` or "POST" in their own args; `.get(`/`.put(`… never;
        anything else (`fetch(`, `.request(`, `gl(`) only with a "POST" string in its args.
      - **A helper's body is never followed** (`def api(path, data=None)`): helpers serve reads
        and writes alike, so following them chipped listings, and the def search cost paths ×
        uses × command length on the beat (QA). Such a create stays chipless, by design.
      - A path assigned at the start of its line (`url = …`) binds to a later call taking that
        variable as a whole argument (`url + "/3/notes"` does not).
      - curl/`glab api` need a flag in the path's segment (`_mr_api_segments`: a small lexer —
        `#` comments dropped, `\"`/`$'…'` honoured, quoted text can't pose as a flag; a heredoc
        body is dropped unless a shell runs it: `bash`/`sh`/`ssh <<EOF`, `cat > x.sh <<EOF`, judged
        from the ~120 chars before `<<`)
        with no GET override (`-G`/`-sG`/`-X GET`).
    - `-f` counts only under `glab api` (it is curl's `--fail`); every pattern is bounded — the
      scan runs on the beat and a lazy span from each `glab api` word was quadratic.
    - `_gitlab_api_created_mr_url` takes the one MR-shaped `web_url` (JSON or dict repr), else one
      MR URL ENDING its line; an array, two MRs, or a mid-sentence quote chips none. A CLI create
      in the same command keeps its non-MR link (`gitlab+cli`).
    - Cost: a URL built from a base var (`base + "/merge_requests"`), a script FILE, a helper
      function, python-gitlab, httpie, `fetch(url, optsVar)` are not seen — narrow on purpose.
- **A GitLab MR the scan missed is found by its BRANCH** (`_discover_branch_mrs`, after
  `refresh_pr_status` on the slow-refresh worker; staged, drained into `pend` by the beat).
  - Why: a push to an `altssh.` URL, `-o mr.create` or a script opens an MR no creating-call
    rule sees; the chip was missing and the open-PR poller nudged a session that had delivered.
  - Adopted only when ALL hold: origin is on GITLAB_URL (or its `altssh.` twin), the MR's
    `source_branch` is the worktree's branch (`--show-current`; not main/master/origin's
    default), not from a fork, its link is that project's MR on GITLAB_URL, opened after the
    session's `createdAt`, and its `sha` is an ancestor of the worktree's HEAD. Never loosen one:
    each stands between a same-named branch and a foreign MR on the card.
  - **The open-PR poller counts STAGED urls as open** (`_staged_discovered_prs`): it runs before
    the payload loop drains them, and without it nudged the very beat the MR landed (QA).
  - An empty lookup is asked again next pass (the MR is usually opened after the
    push); only a tip that already has its MR is skipped. `MR_DISCOVER_MAX` sessions a pass,
    least recently asked first. GitLab only. Tests: `TestDiscoverBranchMrs`.
  - A FAILED lookup ends the pass and backs THAT session off `MR_DISCOVER_FAIL_BACKOFF_SEC`: a hung
    GitLab otherwise held the shared worker a timeout per session every pass. Never a host-wide
    pause: `_gitlab_get` is None for a 404 too, so one unreadable project stalled every session (QA).
  - Residuals: a resumed/migrated session's fresh `createdAt` hides an MR its earlier life
    opened; an MR head already on the base (a sibling's merged, then rebased in) passes the
    ancestor gate.
- **A GitLab MR and an ADO PR answer everywhere a GitHub PR does**: dispatch by URL to
  `mr_status`/`azdo_pr_status`, each polled only through the source that can answer it
  (`_pr_source_ok`; unreachable → bare link). ADO reuses the board's PAT, no CI rollup: `checks` is
  the **CI-bearing branch POLICY evaluations only** (`AZDO_CI_POLICY_IDS`), else reviewer/work-item
  policies read a human-awaiting PR as "CI pending". `mergeable` is `mergeStatus`, conflicts alone.
  - **An MR's `mergeable` answers conflicts ONLY, like GitHub's**: `detailed_merge_status` buckets
    via `_MR_CONFLICT_STATUSES`/`_MR_UNVERIFIED_STATUSES`, every other KNOWN status → MERGEABLE.
  - `_mr_url_parts` matches GITLAB_URL by **host(:port), case-insensitively, ignoring scheme** — a
    byte-prefix compare misattributed MRs over a spelling mismatch.
  - **`MR_URL_RE` takes http as well as https** (XERK-741) — a self-hosted GitLab is routinely plain
    http on a LAN, and the https-only ATTRIBUTION regex dropped its chip in silence (the MR was never
    added to `prUrls`), which is why chips appeared "sometimes". The `/-/merge_requests/<n>` infix is
    the discriminator, so the scheme widening can't misattribute a GitHub/ADO URL. This matches the
    http support `_mr_url_parts`/`AZDO_PR_URL_RE` already carried. Client chip renderers key on that
    same path infix, not the scheme, so no client change.
  - **An ADO CI evaluation for an OLDER push reads pending** (`_azdo_eval_stale`, XERK-2200): its
    `context` says `isExpired`, or names another SOURCE commit than the PR's. Never the merge
    commit or `buildIsNotCurrent`: both move with the TARGET while a never-expiring policy stays
    approved, so a passing PR would read pending for good (QA). Absent fields = current; the
    field names are from ADO docs, not yet seen on a real org.
  - Every launch exports **`GITLAB_HOST`**: glab reads that var, never GITLAB_URL, so self-hosted
    `glab mr create` can't auth without it.
  - Chips label an MR/ADO PR **`!n`, not `#n`** (ADO's `#n` is a WORK ITEM) — every renderer mirrors
    `_pr_ref`.
- Tests: `TestPrStatus`, `TestMr*`, `TestAzdoPr*`, `TestRefreshPrStatus`, `TestPrLedger`.

## PR comment delivery (XERK-49) and conflict nudges (XERK-223)

- **A reply on a session's PR is delivered back to the session that opened it.** `_poll_pr_comments`
  runs on the PR cadence, **running sessions only**, over their own PRs, through `notify_session` —
  the session's inbox (XERK-340), falling back to `send_input`'s pane only for a session with none.
- `_pr_comment_events(url, self_login)` gathers **three channels** (conversation comments, review
  bodies, inline review-thread comments; a bare approve is dropped) — one call covers GitLab (notes)
  and ADO (threads) too, minus system notes. `_pr_ref` numbers `#12` (GitHub) vs `!12` (GitLab/ADO).
- **Baseline-on-first-sight, then deliver only new + not-self.** The whole comment set records
  silently the first beat a PR is seen (`prCommentBase`, capped `PR_COMMENTS_SEEN_MAX`), after that
  only NEW keys not the agent's own are typed in. Bounded `PR_COMMENTS_MAX` per beat; **a fetch
  failure leaves the baseline UNTOUCHED.**
- `_poll_pr_conflicts` types `_pr_conflict_message` (**MERGE `origin/<base>`, never a rebase/force-
  push**) off the just-cached `mergeable`. `prConflicts` bounds nudging per PR; MERGEABLE/closed
  re-arms it, **UNKNOWN does neither** — that's what a just-pushed fix looks like, and clearing on it
  would grant unlimited retries.
- Disable with `TURMA_PR_COMMENTS=0`/`TURMA_PR_CONFLICTS=0`. Tests: `TestPrComment*`,
  `TestPollPrComments`, `TestPollPrConflicts`, `TestPrConflictMessage`.
- `_poll_prs_landed` stamps `prsLandedTs` (last-activity when every PR first reads landed; a new PR
  clears it) so the hub can tell "merged and done" from "merged, then handed new work" — a
  **transcript timestamp**, not the mtime a synced `~/.claude` inflates. Tests: `TestPrsLanded`.

## PR auto-merge — the `mergePr` command (XERK-550)

- The hub decides a PR of an auto-merge-opted org is merge-ready and queues a **`{type:"mergePr",
  sessionId, url}`**; `merge_pr` runs **`gh pr merge <url> --squash --delete-branch`** (method +
  branch-delete env-overridable). Outcome staged on `merge_pr_results`
  (`{cmdId, url, ok, error, retryable}`), keyed by cmdId, so the hub stops retrying a merge `gh`
  refuses. The hub half (the two sweeps, the eligibility gate, the backoff):
  `.claude/rules/turma-automerge.md`.
- **The merge runs from a NEUTRAL, non-repo cwd (`REGISTRY_DIR`), NEVER the session worktree**
  (XERK-563). gh resolves owner/repo from the URL, so it needs no repo context — and `--delete-branch`
  from INSIDE a git worktree runs a local `git checkout <base>` for cleanup that collides with
  Turma's multi-worktree checkout (`fatal: 'main' is already used by worktree at ...`), failing the
  whole merge. From a non-repo cwd gh deletes the REMOTE branch via the API and skips the local step.
- **A TRANSIENT failure is flagged `retryable` so the hub RETRIES rather than gives up** (XERK-563,
  `_merge_error_retryable`): GitHub's optimistic-concurrency race (`Base branch was modified. Review
  and try the merge again.` — the base advanced between the readiness read and the merge, which
  auto-merge also provokes against itself), a `subprocess` timeout, and server 5xx. A conflict, a
  draft, a permission error or an unknown repo is NOT retryable — those never fix themselves. Only
  meaningful on a failure; a success is never retryable. The hub still bounds retries by
  `AUTO_MERGE_MAX_ATTEMPTS`.
- **The merge is PINNED to the head the hub judged ready** (`--match-head-commit`): the hub stamps
  the served `head` (`headRefOid`) on the `mergePr` command, and the agent's own cache is only the
  older-hub fallback — it may already hold a newer, still-pending head. PR status refreshes every `PR_STATUS_REFRESH_EVERY` beats and nothing
  invalidates it on a push, so without the pin a merge right after a push lands the new commit on
  the OLD commit's green. GitHub's moved-head refusal (`Head branch was modified`) is retryable.
  Tests: `test_the_merge_is_pinned_to_the_head_its_status_was_read_for`.
- **Runs as the MANAGER, off the beat.** `_merge_pr_async` spawns a worker thread — `gh pr merge` is
  a blocking network call and `handle_commands` is on the heartbeat loop (XERK-395). A failed
  `Thread.start()` (pids_limit) is caught and staged synchronously on the beat, which is safe.
- The merge is NOT inside a guarded session — the session guard forbids self-merging a PR (work is
  meant to land via a human, `agent-hooks.md`), and the operator's per-org auto-merge opt-in is the
  deliberate override of exactly that. Do not route the merge through a session.
- Results carry an OFF-BEAT writer, so they ride the heartbeat snapshotted under `_merge_pr_lock` and
  are cleared BY IDENTITY (like `spawn_failures`), never a blanket `.clear()`, or a result the worker
  appends mid-beat is lost.
- **GitHub only** — a GitLab MR / ADO PR stages a refusal (`ok:false`) so the hub gives up; widen by
  teaching `merge_pr` the source dispatch (`glab mr merge`/`az repos pr`), never by loosening the
  URL guard. Tests: `TestMergePr`.

## dsh and qwen sessions get the same PR chips, with NO runtime-specific PR code

(XERK-472 [H] / XERK-514 [Qwen H])

- **Everything above reads/writes a dsh or qwen session UNCHANGED — never add an `agentType` branch
  to the PR path.** `_scan_pr_line`, `_seed_prs`, `refresh_pr_status`, the GitLab/ADO dispatch and the
  comment/conflict pollers key on `session_pr_urls` + the transcript, never the runtime. Each
  runtime's transcript is its own S1/[Qwen S1] projection of its native log, so the SAME scan
  attributes the SAME `gh pr create`. Proven end to end by `TestDshPrAttribution`/
  `TestQwenPrAttribution` over the real projector + real corpus.
- **Load-bearing dependency: each projector's shell-tool name map** (`_TOOL_NAME_MAP` in
  `dsh_transcript.py`/`qwen_transcript.py`) — dsh's shell tool is `bash`, qwen's is
  `run_shell_command`, both must map to `"Bash"` or the call is unattributed and the PR is chipless.
  Same narrowness as Claude: a PR opened another way (`cordis_run`/`ralph`, raw GitLab API) gets no
  chip. **Widen only by teaching `_scan_pr_line` another creation event, never by loosening the
  Bash-name gate.**
- **Comment/conflict delivery differs by process model**: dsh (headless) routes through
  `notify_session` → `_dsh_notify`, its control socket (peer-framed, `DSH_ACK_TIMEOUT_SEC`-bounded,
  never raises); qwen (interactive TUI, writes no `~/.claude/sessions/<pid>.json`) falls back to
  `send_input`'s PANE path like a Claude session with no inbox — neither carries a new arm ([Qwen C]).
  Neither adds new beat-loop budget; `refresh_pr_status` stays the same inline offender for ALL
  runtimes (XERK-397's scope, not widened here).
- **Chips survive resume/migration for both** — `_seed_prs` reads the PROJECTED `<tid>.jsonl` (what
  migration packs as the top-level transcript), independent of each runtime's raw native-log sidecar
  (dsh's `<tid>/dsh/`, qwen's `<tid>/qwen/`). Tests: `TestDshPrAttribution`, `TestQwenPrAttribution`
  (drives the real qwen projector over `qwen_pr_corpus.json`).

## PR-comment poller off the beat (XERK-543)

Moved out of `CLAUDE.md`, which keeps the beat-budget rule (XERK-395) this serves.

- **The PR-COMMENT poller is a FETCH/DELIVER SPLIT** (XERK-543), not on the slow-refresh worker.
  Its `gh`/GitLab/ADO fetch (PR_COMMENTS_MAX per pass, same class as `refresh_pr_status`) runs on
  its OWN worker (`_fetch_pr_comments`, staged by `_stage_pr_comment_fetch`), which stages raw
  events (`_pr_comments_fetched`, REBOUND under `_pr_comments_lock` like `spawn_failures`); the beat
  only DRAINS that and DELIVERS (`_deliver_pr_comments` — the baseline/new-key logic, `prCommentBase`
  mutation, `save()`, `notify_session`). It could NOT ride the slow-refresh worker: that worker is
  the single lock-free writer of caches the beat READS, whereas delivery MUTATES session records,
  which is the beat's to own — so the network half moved off, the registry half stayed on. The
  synchronous `_poll_pr_comments` (fetch-then-deliver) is kept only as the behavioural-test entry
  point. One beat stale, accepted.
