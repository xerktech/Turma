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
    `{resolution, note, requestedAt}`, note ≤2000 chars. **Only WRITTEN here** — its reader is the
    close-ticket child (XERK-1569).
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

## Real-host spike (not yet run)

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
