---
paths:
  - "agent/hooks/session_cli.py"
  - "agent/hub-agent.py"
  - "agent/tests/test_session_cli.py"
---

# The session CLI — a session handing its manager structured intent (XERK-1564, epic XERK-1560)

A running session asks the manager for something (wake me later, close my ticket) by running
`python3 -SsE "$TURMA_SESSION_CLI" <subcommand> …`, which writes ONE rendezvous file the manager
reads. `agent.md` is at its size ceiling; this file carries the contract.

## Why a file, never a transcript marker

- A marker in the transcript is forgeable by any quoted line (a PR comment, a pasted log), and
  reading it would add a parser to the `hub-agent.py` ⇄ `tunnel-agent.js` parity list.
- A file read through the hardened reader is the existing precedent: `ask.py`'s req/ans files, the
  epic builder's `TURMA_EPIC_PLAN.json` (`_read_untrusted_json`).

## The CLI (`agent/hooks/session_cli.py`)

- **Lives under `agent/hooks/`** because only `agent/hooks/*.py` is globbed by the native install,
  the updater and release staging on BOTH OSes; `bin/` is an explicit list and the Windows zip is
  `.ps1`-only. Do not move it.
- Stdlib only, run with `-SsE` (the hook security flags, `agent-hooks.md`).
- Subcommands, each writing `~/.turma/session-requests/<TURMA_SESSION_ID>/<subcommand>.json`:
  - `wake <duration> <reason…>` → `{wakeAt (epoch ms), reason, requestedAt}`. Durations are
    `20m`/`2h`/`1h30m`-style (`s`/`m`/`h`/`d`), above zero, at most 7 days; reason ≤200 chars.
  - `close-ticket <done|not-reproducible|already-fixed> --note "<evidence>"` →
    `{resolution, note, requestedAt}`, note ≤2000 chars. Read by the close-ticket worker below.
- Exit 0 + one confirmation line on success; **2** on a refusal (usage, a bound, no
  `TURMA_SESSION_ID`, an id that is not a plain name), saying why and writing nothing; 1 on an
  I/O error.
- **The write is atomic**: a DOT-PREFIXED temp file in the same dir (`O_EXCL|O_NOFOLLOW`, 0600),
  then `os.replace`. A reader never sees half a request; a failed write leaves the previous one.
- `REQUESTS_DIR` is derived from `~`, exactly as the manager's `REGISTRY_DIR` is — not taken from
  the environment, so the two cannot disagree.

## Launch env

- Every Claude launch exports `TURMA_SESSION_CLI=<absolute path>` beside `TURMA_SESSION_ID`/
  `TURMA_QUESTIONS_DIR` — in the POSIX env prefix and in the Windows `extra_env` dict.
- Not yet exported to dsh/qwen sessions (`_launch_dsh`/`_launch_qwen` build their own env); a
  follow-up. The directive that teaches the CLI must not teach it to a dsh/qwen session until then.

## Guard bookkeeping

- **Allow**: `build_guard_settings` adds `Bash(python3 -SsE <absolute hooks dir>/session_cli.py:*)`
  (`session_cli_allow_rule`, computed beside `guard_script_path`) right after
  `_GUARD_ALLOW_PATH_RULES`, so the call never prompts. Narrow on purpose — never a bare `python3`
  allow, which would admit any code.
- **Deny**: `_GUARD_DENY_PATH_RULES` has `Edit(~/.turma/session-requests/**)` (pinned in
  `EXPECTED_DENY_RULES`; oracle case `test_the_session_request_dir_is_refused`). File-edit tools
  only: Bash still writes the dir — that is how the CLI works, and the documented `~/.turma`
  residual — which is why the manager trusts nothing in it.

## The reader rule

- **Every file under `session-requests/` is read ONLY via `_read_untrusted_json`**
  (`O_NONBLOCK|O_NOFOLLOW`, regular file, size-bounded by `SESSION_REQUEST_MAX_BYTES`): a session
  can plant a FIFO or symlink at the name, and a plain `open()` of a FIFO wedges the beat thread.
- The session id is joined onto a path only through `session_request_dir`, which accepts a plain
  name only (`SESSION_REQUEST_SID_RE`, the same pattern the CLI applies).

## Wake delivery (agent side; no UI yet)

- `session_report._finish` reads `wake.json` (`read_wake_request`): `wakeAt` must be a positive
  integer below 2^53, else no request; the reason is flattened to one line and capped.
- `_session_payload` (`_ingest_wake_request`) persists it on the registry record as `wakeAt`/
  `wakeReason`, so a manager restart keeps it, and serves the RECORD's value on the session's
  `session` block. Absent = no wake pending. The hub coerces both by name in `coerceLiveSignals`
  (`wakeAt` a positive safe integer, `wakeReason` a string capped at 200); nothing renders them yet.
- **On the beat, a time compare only** (`_deliver_due_wakes`): a RUNNING session whose
  `now ≥ wakeAt` gets `_stage_input(sid, "Wake-up: <reason>. Check it and continue.")` — the
  operator path, delivered off the beat by the input worker and kept through a compaction by the
  `pendingInputs` outbox. Then the fields are cleared and `wake.json` removed — unless the session
  has since written a DIFFERENT request, which stands. `_wake_fired` stops a file that could not be
  removed from firing twice.
- **After ingest the RECORD is authoritative, not the file.** A beat with no `wake.json` keeps the
  record's `wakeAt`, so deleting the file does not cancel. A newer `wake` supersedes; nothing
  cancels (no `wake cancel` subcommand yet).
- **Kill / delete / clear-context restart** (and the dead-session sweep's fresh relaunch) clear the
  whole request dir via `_clear_session_requests` beside `_clear_question_files` — a request made by
  a conversation dies with it. A symlinked dir is unlinked, never followed. A model switch or
  model-source switch (same conversation, `--resume`) keeps it.
- Tests: `test_session_cli.py`; `TestWakeRequest` in `test_hub_agent.py`; the guard pins in
  `test_guard_settings.py`; the `XERK-1564` case in `server.test.js`.

## Close-ticket delivery (XERK-1569)

- **A WORKER reads it, never the beat**: the two tracker writes are network (XERK-395).
  `_stage_close_ticket_work` wakes `_close_ticket_worker_loop` on every full beat (never raises; a
  failed `Thread.start` retries next beat); `_process_close_ticket_requests` walks a registry
  snapshot and writes nothing to it. The beat's `_apply_closed_tickets` drains `_close_ticket_landed`
  (rebound under `_close_ticket_lock`), stamps `ticket.outcome` (REBINDS the ticket dict, which the
  worker reads) + the ledger, `save()`s, and stages `ticket_outcome_results`. The PR-comment split.
- **Served only for a RUNNING session with `ticket.key`, NOT dsh/qwen** (no CLI there), on this
  host's board. The tracker half (comment, Done mapping, `ticket.outcome`): `agent-board.md`.
- `read_close_ticket_request`: `_read_untrusted_json` (None = no request: missing/FIFO/symlink/
  oversize); a parsed file breaking the contract (resolution outside `CLOSE_TICKET_KINDS`, note
  empty/non-string/over `CLOSE_TICKET_NOTE_MAX`) is `{error}` → staged `refused: …` and dropped.
- **One bounded retry**: `CLOSE_TICKET_ATTEMPTS` (2), the second `CLOSE_TICKET_RETRY_SEC` later. A
  failure stages `ok:false, final:false` and LEAVES the file; the retry skips a comment that already
  landed (`_close_ticket_tries[sid].commented`). A final outcome drops the file unless the session
  has since written a DIFFERENT request (identity = kind/note/requestedAt). Progress is worker-owned
  and in-memory: a manager restart re-tries a file still there, which can re-post its comment.
- Kill/delete/restart clears the dir (`_clear_session_requests`) — an unread request dies with it.
- **Taught by three directives**, each "session CLI first, the host's tracker CLI/MCP else":
  `TICKET_CLOSE_STALE_CLAUSE` (bug prompt + `TICKET_CLOSE_PROMPT` in `_session_directive`) and the
  hub's `autoCloseMergedMessage`. All spell `"$TURMA_SESSION_CLI"` — see the open question below.
- Tests: `TestCloseTicketRequest`, `TestTicketClosingDirectives`; hub `XERK-1569` cases.

## Real-host spike (not yet run)

- **close-ticket (XERK-1569)**: on a scratch bug ticket, `close-ticket not-reproducible --note "…"`
  → comment + Done within a minute, the auto-stop kill within a Jira poll (`JIRA_REFRESH_EVERY`),
  "closed: not reproducible" beside the chip on the board. Not yet run; record the answer here.

- In a worktree session run `python3 -SsE "$TURMA_SESSION_CLI" wake 2m test`: the request file
  appears, no permission prompt, and two minutes later the pane receives the wake-up input.
- **Open question it must answer**: the allow rule names the ABSOLUTE path, and Claude Code matches
  Bash rules on the command text, so the `"$TURMA_SESSION_CLI"` spelling may not match it. If it
  prompts, the directive that teaches sessions the CLI (a later child) must give the absolute path
  (`session_cli_path()`), not the variable. Record the answer here.
- **Windows interpreter (not yet answered)**: the rule and the taught command hard-code `python3`,
  but the Windows launcher runs `python`, and a python.org/winget install has no `python3.exe` —
  `python3` there is the Microsoft Store stub. The directive child must spell the interpreter that
  works there, or export it (e.g. `TURMA_SESSION_PYTHON=sys.executable`) and build the allow rule
  from it, as `build_guard_settings` does for the hooks.
