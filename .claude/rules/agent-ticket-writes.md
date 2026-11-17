---
paths:
  - agent/hub-agent.py
  - agent/tests/test_hub_agent.py
---

# What a session wrote to its own ticket (XERK-3034, epic XERK-3032)

The ticket-update poller must not hand a session back its own comment or status change.
`_ticket_self_authored(sess, event)` answers that from the record's `ticketWrites` ledger.

- **Author identity is useless here**: host tracker creds, the session's CLI/MCP and the
  operator are usually one account. Never replace the ledger with an author check.
- **Two sources, one ledger** (`{u, t, kind, key, id?, fp?, fields?}`, `merge_ticket_writes`):
  - the manager's close-ticket evidence comment: `add_board_comment` returns the tracker's
    comment id; the WORKER stages it as `selfWrite`, the BEAT records it (`_apply_closed_tickets`);
  - the session's own writes, folded by `_scan_ticket_write_entry` inside `_scan_entry_line`.
- **`_scan_pr_line`'s discipline**: a structured `tool_use` (Bash or an MCP tool) on an
  assistant entry, recorded only from ITS OWN non-error `tool_result` on a user entry. Prose,
  a command that prints/greps one, another tool's output and a backgrounded call never count.
  - Bash shapes are read off shlex'd COMMAND words (`ticket_writes_from_bash`): the `jira` helper,
    `acli jira workitem`, `az boards work-item update`, curl to Jira/ADO comment/edit endpoints.
    A `bash -c '…'`-wrapped write is missed — that errs toward delivering the update, never hiding one.
- **A Bash call moved to the background on its 600 s timeout counts the COMMENTS already made**
  (XERK-3052): its result carries `backgroundTaskId` AND `timedOutAfterMs` (an explicit
  `run_in_background` has no `timedOutAfterMs` and still records nothing). The command still runs,
  so a comment counts only when the `jira` helper's `commented on K` line is a whole line of the
  output, each line claimed once, in command order (`_tw_landed`).
  - Read ONE source: `toolUseResult.stdout`, else the content. The content already repeats the
    stdout, so joining both let one line vouch for a later, not-yet-run write of the same key.
  - **Never edits, transitions or assigns**: a timed-out call's span is the full
    `TICKET_SELF_SPAN_MAX_MS`, so a field match there hides ANY human change to that field across
    the whole 10-minute run (QA, XERK-3052). Comments match by body, which a human's text lacks.
  - curl/acli/az/MCP print no such line, so a timed-out one stays unrecorded (delivered).
- **A timed-out call's not-yet-landed writes stay PENDING until its task ends** (XERK-3054,
  `_tw_hold_bg`): `twCalls["bg:<task id>"]` (so XERK-3052's hold covers them, aged from the
  timeout via `tp`) + `twBg[<task id>]` (full writes, indices already recorded, output path).
  - On the task's `<\task-notification>` (`user`/`queue-operation` only, `_scan_ticket_write_bg`)
    both are dropped and `<task id>.output` is read (the notification's path, else the timeout
    result's); `_tw_landed` over the whole output records only indices not recorded at the timeout.
  - Same comment-only rule as above; edits are held but never recorded. Lost across a manager
    restart (the scan primes to EOF): the miss delivers the update, the harmless direction.
  - **Both the hold and the match span the task's life, not 10 min** (`TICKET_BG_MAX_MS`, 1h
    from the timeout `tp`): the hold ages from `tp`, and a comment recorded at the notification
    keeps `tp`, which `_tw_gap` widens its window back to (comments only, matched by body).
    Tests: the `test_xerk3054_*` cases in `TestTicketWrites`/`TestTicketUpdates`.
  - No refusal check over the task output: a build's own `HTTP/1.1 404`/`{"errors"…}` line is
    not the helper's, and the success line already proves the comment ran.
  - Residual: the output is read as a 256 KiB tail; an earlier success line cut off shifts
    `_tw_landed`'s alignment, so a post-timeout comment may go unrecorded (delivered).
- **Matching errs toward DELIVERING** (a false match hides a human's update from the session):
  - key must be valid and equal, `at` finite — else False; never raises (`_ticket_self_authored`);
  - a comment: id when BOTH sides carry one (different ids = different comments), else the body
    fingerprint within `TICKET_SELF_COMMENT_WINDOW_MS`. `ticket_body_fingerprint` unescapes, drops
    tags, Markdown link targets, punctuation and case — ADF, Markdown and ADO HTML hash alike;
  - an edit/transition: an OVERLAPPING field (`_tw_field` vocabulary) within
    `TICKET_SELF_EDIT_WINDOW_MS`; a fieldless write matches nothing; a transition to a different
    target status (`to`) is not ours.
  - **Windows are measured from the call's whole span `[t0, t]`** (XERK-3051, `_tw_gap`): `t0` is
    the tool_use time, `t` the tool_result's. A `jira transition … && <long step>` writes Jira at
    the START; stamped at the result alone it was echoed back. Never widen the window instead —
    that hides a human's move made in it.
  - The span is capped at `TICKET_SELF_SPAN_MAX_MS` (Bash's own 600 s timeout): `t0` is when the
    call was EMITTED, so a permission wait or a hand-edited `t0` would otherwise widen it unbounded.
- **The Bash reader**: a `-`/stdin body is ITS OWN segment's heredoc (marker words, not
  `heredocs[0]`); redirections (`2>&1`, `> f`) are dropped with their target; `curl -G`, a write
  aimed at another board host or under a `JIRA_SITE=`/`AZDO_URL=` prefix, and a result that is a
  tracker refusal body or HTTP 4xx/5xx (curl exits 0) are not writes.
- **A body read from a FILE is fingerprinted from the file** (XERK-3042, `_TwFile`,
  `_tw_file_fingerprint`): `-F f`, `- < f`, `cat f |`, curl `-d @f`, acli `--body-file`, az
  `--discussion @f`. The command text never holds those words, so without it the session's own
  comment was echoed back as someone else's.
  - **Read at the call's TOOL_RESULT, never its tool_use** (`resolve_ticket_write_files`): a session
    writes the file and posts it in ONE command, so at tool_use time the file is absent or still
    holds the previous comment (whose fp would hide nothing real but miss this one).
  - `stat` says regular BEFORE any open (opening a FIFO releases its blocked writer), bounded read;
    a relative path resolves against the entry's own `cwd`, never through `$`, and never when ANY
    `cd`/`pushd`/`popd` appears before it, quoted scripts too (`{ cd x;`, `eval 'cd x'`).
  - A file changed or gone before the scan (or a restart re-seed) just yields no match: delivered.
  - A segment's stdin is its LAST heredoc, here-string or fd-0 `<` redirect, as bash reads it.
- **Beat cost**: a substring prefilter skips commands naming no tracker program; the heredoc scan
  finds each line's newline once (the regex form was quadratic: 2s on a 64 KiB `<<` line).
- **The ledger lives on the record, never re-derived per beat**: a restart primes the scan to EOF.
  Bounded `TICKET_WRITES_MAX` (newest kept), carried on the closed record and into `resume()` /
  resume-any (the manager's entries are in no transcript), then re-seeded from the whole transcript
  (`_seed_ticket_writes`, beside `_seed_prs`). Never on the wire.
  - **Calls still awaiting their result ride the record too** (`ticketWritesPending`, XERK-3053):
    `twCalls` was in memory only, so a command running across a manager restart lost its call and
    its result was never recorded. Written each beat it changes (`ticket_write_calls_persisted`),
    re-learned on the process's first scan (`seed_ticket_write_calls`, re-typed: the file is
    outside the process). A live-agent snapshot's restart gap is folded into this scan as well.
    Every launch drops them (`_launch_tmux`): a relaunched claude never answers the old calls.
    Residual: with no snapshot (back-scan path), a result written while the manager was down is lost.
  - Accepted residual: a MIGRATION re-seeds from the transcript only (the hub's `importSession`
    carries no ledger), so a manager close-ticket comment is forgotten on the target. Its miss
    re-delivers that one comment — the harmless direction.
- Tests: `TestTicketWrites` (incl. `test_xerk3053_*`), `test_xerk3034_*` in `TestCloseTicketRequest`.
