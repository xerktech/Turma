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
  follow-up. So the wake directive below is withheld from a dsh/qwen session until then.

## The wake directive (XERK-1571)

- `_session_directive` appends `WAKE_SYSTEM_PROMPT` (`wake_directive()`) for a CLAUDE session:
  "do not sleep in a shell: run `python3 -SsE <cli> wake <N>m <what to check>` and end the turn".
- **It names the CLI by its ABSOLUTE path** (`session_cli_path()`), never
  `"$TURMA_SESSION_CLI"`: the allow rule matches command TEXT, so only the absolute spelling is
  known to match `session_cli_allow_rule` (`TestSessionDirective` pins the prefix). That settles
  the spike's spelling question for a SHELL-SAFE path; the Windows interpreter one stays open.
- **A path that needs shell quoting is NOT taught** (`wake_directive` returns ""): quoted in the
  command but raw in the rule, the two never match and every wake would prompt. That withholds it
  on every Windows agent (backslashes) and any POSIX install path with a space — part of the open
  Windows spike below.

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
  (`wakeAt` a positive safe integer, `wakeReason` a string capped at 200). A `wakeAt` still ahead
  is the session SLEEPING (`turma-attention.md`, XERK-1571).
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

## Pausing a sleeper for its slot (XERK-1575; hub half `turma-attention.md`)

- **`pauseSleeper` (command) → `pause_sleeper`**: the same `kill` an operator click runs (worktree,
  branch, ticket, transcript kept) with `paused={wakeAt, wakeReason, pausedAt}` stamped on the
  closed record and served as `closedSessions[].paused` (`_paused_wire`). Runs in
  `handle_commands`, like every kill — never staged from the beat.
- **The agent re-checks before it kills** (`_sleeper_unpausable`): running, an int `wakeAt` at
  least `PAUSE_SLEEPER_MIN_AHEAD_MS` away, and the LAST beat's signals quiet (`_note_quiet` →
  `self._quiet[sid] = (pane, work)`): `paneBusy is False`, no panePrompt, no question, no live
  `agents`, no `loop`. A failed probe drops the entry — can't tell = refuse. Refusals are logged.
- **`TURMA_PAUSE_SLEEPERS=0`** refuses every pause and reports `pauseSleepers: {available:false}`.
- **A paused record is exempt from `CLOSED_PER_REPO`** (up to `PAUSED_KEEP_MAX`, newest kept) and
  from the prune's closed-record sweep (`_poll_prunes`): evicted, it could never be woken; a
  pruned worktree is re-added by `resume`.
- **Resume carries the wake back** (`_carry_paused_wake`, in `resume()`), keeping the session id,
  ticket and `rcName`. Default: the record gets `wakeAt`/`wakeReason` + `wakeResumedAt`, and
  `_deliver_due_wakes` stages `wake_text` through the operator input path only once
  `WAKE_RESUME_SETTLE_MS` has passed AND the last beat read an idle composer — never a timed paste
  into a booting TUI. A wake still ahead (an early operator Resume) is simply asleep again.
- **`TURMA_RESUME_WAKE_PROMPT=1` rides a DUE wake on the launch instead** (`claude --resume <id> --
  <text>`, `_launch_tmux`'s positional prompt). OFF until a real pane proves `--resume` submits it.
- The resume's `resumeRelaunch` stamp applies: a doomed `--resume` relaunches fresh, and that fresh
  launch clears the wake with the rest of the request dir (a conversation's wake dies with it).
- Tests: `TestSleeperSlot`.
- **Real-host spike (not yet run)**: on a scratch session, `wake 30m x`, queue a ticket at
  capacity, confirm the pause, then the resume at wake with the wake text landing once; and
  whether `claude --resume <id> -- <text>` submits `<text>` as the first turn (if it does, flip
  `TURMA_RESUME_WAKE_PROMPT` on). Record the answers here.

## The wait classifier + loop signal (XERK-1572)

Not the CLI, but the other half of "why is this session waiting": hub half in `turma-attention.md`.

- **The classifier is a `claude -p` Haiku one-shot on the `_start_summary` posture** (cwd
  `REGISTRY_DIR`, no `--settings`, stdin closed, prompt an argv element, `TURMA_ATTENTION_HINT_MODEL`,
  `TURMA_ATTENTION_HINT_TIMEOUT_SEC`), its prompt signature in `INTERNAL_TOOL_PROMPT_SIGS` so its
  transcripts never surface as a repo.
- **It runs with NO tool and NO MCP server** (`ATTENTION_HINT_LOCKDOWN` = `--tools=` +
  `--strict-mcp-config`): its DATA is the session's own text, which repo content and tool output can
  steer, and no guard hook is wired. `--tools=` (equals form) because a variadic `--tools ""` swallows
  the prompt after it. Verified on the installed CLI: the init event lists `tools: []`, `mcp: []`.
- **It also loads USER settings only** (`--setting-sources=user`, third in `ATTENTION_HINT_LOCKDOWN`):
  its cwd `~/.turma` is session-writable (Bash always; Edit/Write too, the deny rules name only
  specific files), and without it a planted `~/.turma/.claude/settings.json` ran its hooks AS THE
  MANAGER on every ended turn, and a planted `CLAUDE.md` (cwd or any ancestor) steered the verdicts on
  OTHER sessions' cards. Verified on CLI 2.1.288: hooks fire and CLAUDE.md is obeyed without the flag,
  neither with it. Never drop it; `_start_summary`/`_start_jira_triage` still lack it (follow-up).
- **Output goes to a FILE and the child leads its own process group** (`start_new_session`), killed
  whole on a timeout and reaped with a bound — a pipe read waits for EOF unbounded, so a grandchild
  holding stdout would wedge the one worker. Only the job's OWN answer (same edge + `stagedAt`) frees
  `_attn_job`; a late answer from a watchdog-dropped job does not.
- `TURMA_ATTENTION_HINTS=0` turns the classifier off; dsh/qwen skip it (no Claude login assumed,
  like naming).
- **Only a NEW edge is classified** (`attention_edge`, a pure read of the beat's signals: question |
  permission | loop | stalled | review, with an anchor). `_attention_edge` notes it on the record
  as `attentionHint {edge, kind, edgeTs, attempts}`; the RECORD is the ledger, so an edge it already
  holds (a restart, a flicker back) is never asked again — but re-entering one it ANSWERED re-ships
  the cached verdict (same `<sid>:<edgeTs>` key): the hub drops its copy the beat the state leaves.
- **The current edge rides the live signals as `attentionEdgeTs`** (that record's `edgeTs`, every
  beat the session is on it): the hub folds a verdict only for the edge it answers, so a second
  dialog or question of the same kind never shows the first one's verdict.
- **A sleeping session is no edge** (`wakeAt` in the future): the hub reads `sleeping` ahead of
  review/stalled. `ATTENTION_WAIT_STALL_MIN` is read agent-side under the hub's env name and must
  MATCH the hub's — a mismatch asks about a stall the hub does not read (its hint is dropped).
- **Runs on its OWN worker, never the beat** (`_attention_hint_worker_loop`, XERK-395): the beat only
  stages ONE job (the oldest due edge, `_attn_job` = one in flight, freed if unanswered past the
  timeout) and drains `_attn_results` (REBOUND under `_attn_lock`). The input is built from signals
  the beat already read (question/dialog text + `session_report`'s `tail`) — no read of its own.
- **Bounded retries armed up-front**: `ATTENTION_HINT_MAX_ATTEMPTS` (2), backoff
  `ATTENTION_HINT_RETRY_BACKOFF_SEC` × attempts, persisted on the record before the job runs.
- **Strict parse** (`parse_attention_hint`): one JSON object (a code fence tolerated), label from the
  fixed set, `why` a non-empty string, `suggestedAnswer` a string if present; anything else is no
  verdict, never a repaired one. A verdict for an edge the session has left is dropped.
- **A `needs-human-test` verdict never carries `suggestedAnswer`** (prompt rule + parse drop + hub
  drop): a suggested reply there could only claim a hand test nobody ran.
- **The edge description is kept whole in the input**; only the tail is cut (from its front) to fit
  `ATTENTION_HINT_INPUT_MAX`, so long tail rows never push the question/dialog/loop line out.
- **The wire**: `attentionHints` rows `{key:"<sid>:<edgeTs>", …}`, ≤`ATTENTION_HINTS_MAX` a beat,
  cleared BY IDENTITY in `_clear_delivered_staged`, never shed; the outbox is bounded.
- **The loop signal needs no model**: `_scan_loop_entry` (in `_scan_entry_line`) counts consecutive
  tool results with `is_error` for the same (tool, sha1 of the sorted input); a success or a
  different call resets it; sidechains ignored; pending calls ≤64, count capped. `session_report`
  reports `loop: {repeats, tool, since}` from `LOOP_REPEATS_MIN` (4), else null. A restart primes
  offsets to EOF, so a loop is re-counted from new calls (failure direction: none reported).
- **`loop` is reported only while the turn runs** (`paneBusy` not False): a session that ended its
  turn after a loop is the operator's wait (review, classified). **A new prompt** (user text, not a
  tool result, meta, compaction or `<task-notification>`) **re-arms the run**: count to 0, `since`
  kept, so the same failure resumed after a nudge is the same stall to the hub's two-nudge cap.
- Tests: `TestAttentionHints`, `TestLoopSignal`, `TestSessionReportLoop`.
- **Real-host spike (not yet run)**: the classifier against the real login on a few archived prompts
  (assert schema conformance, not text), and a looping transcript + a stalled shell through `verify`.

## Close-ticket delivery (XERK-1569)

- **A WORKER reads it, never the beat**: the two tracker writes are network (XERK-395).
  `_stage_close_ticket_work` wakes `_close_ticket_worker_loop` on every full beat (never raises; a
  failed `Thread.start` retries next beat); `_process_close_ticket_requests` walks a registry
  snapshot and writes nothing to it. The beat's `_apply_closed_tickets` drains `_close_ticket_landed`
  (rebound under `_close_ticket_lock`), stamps `ticket.outcome` (REBINDS the ticket dict, which the
  worker reads) + the ledger, `save()`s, and stages `ticket_outcome_results`. The PR-comment split.
- **Served only for a RUNNING session, NOT dsh/qwen** (no CLI there), on this host's board. The
  tracker half (comment, Done mapping, `ticket.outcome`): `agent-board.md`.
- **A request from a session with NO ticket key is REFUSED, never skipped** ("this session has no
  ticket"): the CLI promised a message if the manager cannot close it, so silence would leave a
  bare or not-yet-adopted session believing the close is under way. The file is consumed.
- `read_close_ticket_request`: `_read_untrusted_json` (None = no request: missing/FIFO/symlink/
  oversize); a parsed file breaking the contract (resolution outside `CLOSE_TICKET_KINDS`, note
  empty/non-string/over `CLOSE_TICKET_NOTE_MAX`) is `{error}` → staged `refused: …` and dropped.
- **One bounded retry**: `CLOSE_TICKET_ATTEMPTS` (2), the second `CLOSE_TICKET_RETRY_SEC` later. A
  failure stages `ok:false, final:false` and LEAVES the file; the retry skips a comment that already
  landed (`_close_ticket_tries[sid].commented`). A final outcome drops the file unless the session
  has since written a DIFFERENT request (identity = kind/note/requestedAt). Progress is worker-owned
  and in-memory: a manager restart re-tries a file still there, which can re-post its comment.
- **A FINAL failure or refusal is messaged to the session** (`notify_session`, on the beat): the CLI
  returns before the tracker is touched, so this is what lets the "tracker CLI/MCP else" fallback
  run. Its reply says so ("…and message you if it cannot close the ticket").
- Kill/delete/restart clears the dir (`_clear_session_requests`) — an unread request dies with it.
- **Start drops close-ticket.json** (`_drop_close_ticket_request`, beside `_reopened_ticket`): a
  request left from before the stop (a non-final failure, or a crash first) must not re-close the
  ticket the operator just brought back. Only that file — a wake request still stands.
- **Residual: a session can close a SIBLING's ticket.** The worker trusts the `<sid>` dir name, and
  Bash (the `~/.turma` residual above) can write any sibling's dir, so a session can make the
  manager comment on and close another same-host session's ticket with the host's tracker creds.
  Accepted: same host, same org/board (siteKey-gated), and Done is reversible with the comment as
  the audit trail. A sid stamped in the file would not help — the forger writes it too.
- **An ADOPTED ticket is refused** (`ticket.adopted` / `ticketAdopted`, via `_served_ticket`): its
  block came from the session's own branch name (`_maybe_adopt_ticket`), so any collected ticket is
  one branch away, and its close gets every session on it killed org-wide by the hub's auto-stop.
  The XERK-1440 provenance reason. The refusal reaches the session, which uses its tracker tool.
  So `_session_directive` teaches an adopted block `TICKET_CLOSE_ADOPTED_PROMPT` (tracker tool
  only), never the CLI the reader then refuses.
- **A session killed before the beat applies a success** has its newest `self.closed` record (and
  its ledger entry) stamped instead, so the board still says why the ticket closed.
- **Taught by three directives**, each "session CLI first, the host's tracker CLI/MCP else":
  `TICKET_CLOSE_STALE_CLAUSE` (bug prompt + `TICKET_CLOSE_PROMPT` in `_session_directive`) and the
  hub's `autoCloseMergedMessage`. All spell `"$TURMA_SESSION_CLI"` — see the open question below.
  Each is gated on runtime: a dsh/qwen session gets tracker-tool wording only (`session_cli=False`
  agent-side; `autoCloseMergedMessage(urls, s.agentType, cli)` hub-side).
- **The hub names the CLI only for a host reporting `closeTicket: {available: true}`** (heartbeat
  capability, `normalizeCloseTicket`). The hub deploys on merge, agents update later: an agent with
  the XERK-1564 CLI but no reader would accept the request and never act. Absent = tracker wording.
- Tests: `TestCloseTicketRequest`, `TestTicketClosingDirectives`; hub `XERK-1569` cases.

## Real-host spike (not yet run)

- **close-ticket (XERK-1569)**: on a scratch bug ticket, `close-ticket not-reproducible --note "…"`
  → comment + Done within a minute, the auto-stop kill within a Jira poll (`JIRA_REFRESH_EVERY`),
  the chip reading "not reproducible" on the board and a "Closed by" panel row naming the session
  with its note. Not yet run; record the answer here.

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
- **XERK-1569 inherits both questions**: `TICKET_CLOSE_STALE_CLAUSE`, `TICKET_CLOSE_PROMPT` and the
  hub's `autoCloseMergedMessage` all teach `python3 -SsE "$TURMA_SESSION_CLI"`; the spike's answer
  must update all three (a failed or prompted command degrades to the tracker-CLI/MCP fallback).
