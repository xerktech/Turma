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
  - Cost: a PR opened another way (subagent, MCP, web UI) gets no chip. **Widen only by teaching
    `_scan_pr_line` another creation event, never by scanning loose text.**
- **A GitLab MR and an ADO PR answer everywhere a GitHub PR does**: dispatch by URL to
  `mr_status`/`azdo_pr_status`, each polled only through the source that can answer it
  (`_pr_source_ok`; unreachable → bare link). ADO reuses the board's PAT, no CI rollup: `checks` is
  the **CI-bearing branch POLICY evaluations only** (`AZDO_CI_POLICY_IDS`), else reviewer/work-item
  policies read a human-awaiting PR as "CI pending". `mergeable` is `mergeStatus`, conflicts alone.
  - **An MR's `mergeable` answers conflicts ONLY, like GitHub's**: `detailed_merge_status` buckets
    via `_MR_CONFLICT_STATUSES`/`_MR_UNVERIFIED_STATUSES`, every other KNOWN status → MERGEABLE.
  - `_mr_url_parts` matches GITLAB_URL by **host(:port), case-insensitively, ignoring scheme** — a
    byte-prefix compare misattributed MRs over a spelling mismatch.
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
  branch-delete env-overridable). Outcome staged on `merge_pr_results` (`{cmdId, url, ok, error}`),
  keyed by cmdId, so the hub stops retrying a merge `gh` refuses. The hub half (the two sweeps, the
  eligibility gate, the backoff): `.claude/rules/turma-board.md`.
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
