---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# PR status, comment delivery and conflict nudges

Split out of `.claude/rules/agent.md` to keep that file (which loads for ALL of `agent/**`) under
the size ceiling. Everything here lives in `hub-agent.py`: what makes a PR a session's, how its
state is polled across GitHub/GitLab/Azure DevOps, and what gets typed back in because of it.

## PR status

- State, CI rollup and mergeability of every PR a session opened, on `PR_STATUS_REFRESH_EVERY`.
- The card's **single ✓/✗/● mark is merge READINESS, not CI** (`ready`, from `_merge_ready`): a
  conflict blocks on its own, and a ✓ requires an affirmative MERGEABLE — a just-opened PR's UNKNOWN
  is `pending`. Conflicts only matter while a PR could still land: MERGED/CLOSED reports CI alone; a
  PR with **no checks** keeps its no-mark unless it CONFLICTS. `checks`/`checkCounts` stay pure CI
  beside it; all four renderers (web ×3, android's `PrBadge`) read `ready`, falling back to the CI
  half for older agents.
- Cached by URL in `pr_status_cache`, attached as `session.prs`, kept after the session stops.
  **Durable across an agent restart** (XERK-15) via `prUrls` on the record, and **for ENDED sessions
  and the pill too** (XERK-13) via two transcript-keyed ledgers that outlive the registry record:
  - `pr-sessions.json` (`PR_LEDGER_PATH`) — written by `_remember_prs`, backfilled from closed
    history, read by the resumable scan (`_ledger_prs`); the only channel left once a closed record
    ages out.
  - `pr-status.json` (`PR_STATUS_LEDGER_PATH`) — persisted by `refresh_pr_status` and seeded back at
    boot; an ended session is never re-polled, so without this its chip degrades to a bare link.
    Ledgered URLs count as `referenced`.
- **Which PRs are "a session's"** is `_scan_pr_line`, deliberately narrow: a URL counts only when it
  comes back in a **creating call's own `tool_result`** (`PR_CREATE_RE`) — the one event that says
  this session OPENED it. `gh pr create`; `glab mr create` / `git push -o merge_request.create`
  (XERK-162); `az repos pr create` (XERK-226), whose JSON carries no link, so `_azdo_created_pr_url`
  builds one from `repository.webUrl` + `pullRequestId`. Call and result land in different beats, so
  pending tool_use ids carry across (capped); the scan parses whole lines.
  - **An on-prem Azure DevOps Server host has no vendor CLI to name here** — the `azure-devops` az
    extension refuses a self-hosted collection outright, so those hosts open PRs with a local REST
    wrapper. `ado pr-create` **and `ado.py pr-create`** are built in (a host that loses the wrapper
    from PATH runs it as `python3 …/ado.py`, the same PR opened the same way);
    **`TURMA_PR_CREATE_CMDS`** (CSV of command prefixes) registers any other, so a host isn't
    chipless because its tool isn't a vendor's.
  - `_pr_create_pattern` treats every command — built-in and configured alike — as literal escaped
    words, anchored against `-` (and `.` trailing) so one can't match the tail of `run-mkpr` or a
    `pr-create.md` filename. An entry whose longest word is under `PR_CREATE_CMD_MIN` chars is
    **ignored**: attribution must not fail OPEN, and a 1–2 char token matches half the commands a
    session runs (measuring the JOINED length lets `a b` through).
  - The ADO URL regexes take **http as well as https** — an on-prem collection is routinely served
    over plain http on the LAN, and a scheme-only mismatch drops the chip in silence.
  - Cost: a PR opened another way (subagent, MCP tool, web UI) gets no chip. **Widen only by
    teaching `_scan_pr_line` another creation event, never by scanning loose text.**
- **A GitLab MR and an ADO PR answer everywhere a GitHub PR does**: `pr_status`/`_pr_comment_events`
  dispatch by URL to `mr_status`/`azdo_pr_status`, identical shapes, each URL polled only through
  the source that can answer it (`_pr_source_ok`; unreachable → bare link chip). ADO reuses the
  BOARD's PAT and has no CI rollup, so `checks` is the **CI-bearing branch POLICY evaluations only**
  (`AZDO_CI_POLICY_IDS`) — reviewer/work-item policies would read a PR awaiting a human as "CI
  pending". `mergeable` is `mergeStatus`, conflicts alone. The image bundles `glab` and az's
  `azure-devops` extension (Services only — see the wrapper note above); the native install ships
  `glab` too (`ensure_glab`) — without it a session improvises with the raw GitLab API, the one
  MR-creation path the scan can't attribute.
  - **An MR's `mergeable` answers conflicts ONLY, like GitHub's**: `detailed_merge_status` buckets
    via `_MR_CONFLICT_STATUSES`/`_MR_UNVERIFIED_STATUSES`, every other KNOWN status → MERGEABLE —
    mapping only `"mergeable"` parked every healthy MR (not_approved, ci_still_running …) at ●.
  - `_mr_url_parts` matches GITLAB_URL by **host(:port), case-insensitively, ignoring scheme** — a
    byte-prefix compare left attributed MRs as bare link chips over a trivial spelling mismatch.
  - Every session launch exports **`GITLAB_HOST`** (from `gitlab_base()`, operator's own wins):
    glab reads that var, never GITLAB_URL, so self-hosted `glab mr create` can't auth without it.
  - Chips label an MR/ADO PR **`!n`, not `#n`** (in ADO `#n` is a WORK ITEM) — every renderer
    (web ×3, android `PrBadge`, glasses `phone/render.ts` + vendored chat.cjs) mirrors `_pr_ref`.
- Tests: `TestPrStatus`, `TestMr*`, `TestAzdoPr*`, `TestRefreshPrStatus`, `TestPrLedger`.

## PR comment delivery (XERK-49) and conflict nudges (XERK-223)

- **A reply asking for corrections on a session's PR is delivered back to the session that opened
  it.** `_poll_pr_comments` runs on the PR cadence, **running sessions only**, over their OWN PRs
  (`session_pr_urls`), through `notify_session` — the session's inbox (XERK-340), falling back to
  `send_input`'s pane and outbox only for a session that has none. Same for the conflict nudge.
- `_pr_comment_events(url, self_login)` gathers **three channels** — conversation comments, review
  bodies, inline review-thread comments; a bare approve is dropped. One call covers all three on
  GitLab (notes) and ADO (threads), minus that tracker's own system notes. `_pr_ref` numbers it
  `#12` on GitHub, `!12` on GitLab and ADO (there `#12` is a WORK ITEM).
- **Baseline-on-first-sight, then deliver only new + not-self.** The whole comment set is recorded
  silently the first beat a PR is seen (`prCommentBase`, capped `PR_COMMENTS_SEEN_MAX`); after that
  only NEW keys not the agent's own (`viewerDidAuthor`, else an identity compare) are typed in.
  Bounded `PR_COMMENTS_MAX` per beat; **a fetch failure (→ None) leaves the baseline UNTOUCHED.**
- `_poll_pr_conflicts` types `_pr_conflict_message` (**MERGE `origin/<base>`, never a
  rebase/force-push**) off the `mergeable` just cached. `prConflicts` bounds the nudging per PR;
  MERGEABLE/closed clears and re-arms it, **UNKNOWN does neither** — that is what a just-pushed fix
  looks like, and clearing on it would grant unlimited retries.
- Disable with `TURMA_PR_COMMENTS=0` / `TURMA_PR_CONFLICTS=0`. Tests: `TestPrComment*`,
  `TestPollPrComments`, `TestPollPrConflicts`, `TestPrConflictMessage`.
- `_poll_prs_landed` stamps `prsLandedTs` (last-activity when the sweep first sees every PR landed;
  a new PR clears it) so the hub can tell "merged and done" from "merged, then handed new work". It
  and `newWorkSincePrs` are **transcript timestamps** — the conversation's clock, not the mtime a
  synced `~/.claude` inflates. Tests: `TestPrsLanded`.
