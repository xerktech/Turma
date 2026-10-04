---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/hooks/permlog.py"
  - "agent/tests/test_permlog.py"
---

# The permission ledger — agent half (XERK-1563, epic XERK-1560)

What the agent records for every permission prompt a session hits, and how it reaches the hub. The
hub half (ingest bounds, the suggestedRule table, persistence, the Usage card) is
`.claude/rules/turma-permissions.md`. Code: `hub-agent.py` (`_permission_edges`, `_hook_fit`, the
hook-log tail) + `agent/hooks/permlog.py`.

## The three kinds — each has a different fix, so the row must say which

- **`dialog`** — the numbered TUI dialog (rule/manual prompt, plan approval, sandbox escape). Source:
  the `panePrompt` EDGES the beat already scrapes. `dialogKind` = `permission`/`plan`/`sandbox`/`other`
  (`classify_pane_dialog`; wording is the TUI's, so unknown = `other`).
  - **The kind comes from the PENDING CALL and the QUESTION line, never the detail.** The detail is
    the call's free text (a command, Claude's description, a path), so `terraform plan`, `ls sandbox/`
    or "Check network access" there would mislabel a tool prompt. Pending `ExitPlanMode` → `plan`;
    "Do you want to allow this connection?" → `sandbox`; any other "Do you want to …" → `permission`.
  - On None→dialog the row opens and attaches the PENDING CALL (`pending_tool_call`): of the newest
    assistant message (entries sharing `message.id`) with a `tool_use` lacking a `tool_result`, its
    OLDEST such call — Claude asks about parallel calls one at a time, in order. `head`/`digest` come
    from permlog.py's OWN functions (`_permlog_module`) so pane and hook rows aggregate together.
  - **A dialog is keyed on its whole face** (`_pane_dialog_identity`: question + detail + option
    labels), not its question: every tool prompt asks "Do you want to proceed?", and two prompts
    answered between beats never show "no dialog". A changed face closes the row and opens another.
  - **Except a REPAINT** (`_dialog_is_repaint`): the face moves with the pane's width (the ttyd
    attach resizes tmux, wrapping detail and labels) and with Tab-to-amend, not the call. A changed
    face whose pending call is still the open row's `toolUseId`, with the same `dialogKind`, keeps the
    row. The tail is read only on a face change.
  - **A row with no `toolUseId` of its own repaints on its FACE** (`_dialog_faces_match`): a delegated
    row (every sub-agent prompt shares the Task id), an overridden one (the id was cleared) or one
    with no pending call. Same `dialogKind`, and the faces are WINDOWS of one text (detail then
    question, all whitespace removed): uncut ones are equal; one at the line cap lost its top, so it
    is the other's tail. Labels are not compared (a wrap drops one). Without it a ttyd attach split
    such a prompt in two.
  - **The face is cut only by the line cap and `PANE_PROMPT_FACE_CHARS`** (8000; `detailFace` →
    `panePromptFace` → `face=`), never the wire's 800: at 800 a long command was cut at BOTH caps and
    two widths' windows need not overlap. It never rides the wire: session_report lifts it out of
    `panePrompt`, the beat pops it. So an 800-char `detail` with no face is WHOLE, never a cut.
  - **A face past `PANE_PROMPT_FACE_CHARS`** (14 lines of a ~570+-column pane) lost its bottom too: a
    middle window. It matches only under the same question and overlapping the other's text by
    `PANE_FACE_MIN_OVERLAP` (`_windows_overlap`, at most `PANE_FACE_MAX_PROBES` alignments a side).
    Two windows that do not overlap cannot be placed, so that redraw still opens a second row.
  - **Only a PRE-EXECUTION prompt (`permission`/`plan`) repaints on the call alone.** A running call
    raises any number of sandbox prompts under one `toolUseId` (`npm install`: the registry, then
    GitHub), so a `sandbox` face is a repaint only while its host equals the row's `head`.
  - `classify_pane_dialog` matches its phrases across any whitespace, so a wrap never changes the kind.
  - **A question picker is not a permission row**: no row opens while `signals.question` is set or
    the pending call is `AskUserQuestion` (its native picker after ask.py's wait) — no rule retires it.
  - On dialog→gone it closes: `waitedMs`, and `answer` = Turma's `answer_pane_prompt` number mapped
    through that option's label (`via:"turma"`), else the call's result (`tool_call_outcome`: a
    refusal's words → `deny`, any other result → `allow`, `via:"terminal"`), else `allow` if the pane
    went busy with no result yet (it is running), else `unknown`.
  - **"A refusal's words" are Claude Code's OWN, anchored at the result's start**
    (`_PERMISSION_DENIED_RESULT_RE`: "The user doesn't want to proceed…", "Permission for this … was
    denied", "Permission to use … has been denied", "User rejected"). Never a bare `denied`/`not
    allowed`: an APPROVED call that failed (`Permission denied`, `push … not allowed`) ran — an allow.
  - **`PermissionRequest` carries NO `tool_use_id`** (Claude Code 2.1.288: the binary builds it from
    `tool_name`/`tool_input`/`permission_suggestions` only, confirmed by a live hook dumping its stdin;
    `PermissionDenied` and `PreToolUse` do carry one). So its row merges into a dialog on the CALL
    (`_hook_fit`): tool + digest, else tool + head — never on a `toolUseId`, which it never has. Test
    fixtures must use that real shape, or they pin a merge production never takes.
  - A hook fires BEFORE its dialog is drawn, so one stamped past `openedAt` + `PERMISSION_HOOK_LATE_MS`
    is a later prompt's. A `sandbox` row takes no hook (not hookable). Newest hook first.
  - Merged into the open row, else the just-closed one, else HELD; a held hook is claimed by the next
    dialog whose call it fits (that row's transcript `toolUseId` does not stop it). One no dialog
    claims within `PERMISSION_HOOK_HOLD_SEC` (answered between two beats) is its own `r-` row.
  - **A dialog claims ONE hook row**: one already carrying `rulesMatched` never takes another, so a
    second request is held as its own prompt instead of vanishing into the first.
  - **A dialog raised inside a foreground sub-agent** has the parent's `Agent`/`Task` call as its
    pending call (`PERMISSION_DELEGATING_TOOLS`). A hook whose tool/digest differs from that call is
    the sub-agent's: it OVERRIDES tool/head/digest and CLEARS the delegation's `toolUseId` — one prompt,
    named by the real call, and no shared id the repaint rule could fold the next prompt under. A hook
    matching the call's own digest is the prompt to launch it, merged without override.
  - That ADOPTION (a delegated row, or one with no pending call) takes a hook only if it fired within
    `PERMISSION_HOOK_ADOPT_MS` (two beats) before the dialog's beat — an older held hook is an earlier
    prompt answered between beats, and stays its own row.
- **`classifier-denied`** — auto mode's soft block shows NO dialog: the model is told no and turns to
  the human in chat. Only the `PermissionDenied` hook sees it. A complete row on its own.
- **`ask-in-chat`** — the session ended its turn asking for permission in prose, judged once per
  turn on the agent's ended-turn edge (idle pane, nothing pending, last word the assistant's with no
  tool call); closed by the next operator `input` (`via:"turma"`). Sessions already sitting there on
  a manager's first beat are PRIMED, not re-filed.
  - **Where the wait classifier runs (XERK-1572) ITS verdict decides**: the turn waits in
    `_perm_ask_pending` and a `rubber-stamp` label opens the row (prompt = the session's asking
    sentence via the regex, else the classifier's `why`; `openedAt` = the edge); any other label
    opens none, even where the regex would have matched.
  - **The hub's own stall/loop nudge is not an answer**: it rides `input` with `source:"nudge"`,
    which skips `_permission_close_ask` — no pending ask is settled, no open row closed `via:"turma"`.
  - **The regex (`PERMISSION_ASK_RE`, `_permission_ask_prompt`) is the FALLBACK**: a dsh/qwen
    session, `TURMA_ATTENTION_HINTS=0`, a classifier that gave no verdict after its last attempt,
    and a turn answered (Turma `input` or the session moved on) before the verdict landed — that
    last one opens and closes the row at once, so a quick answer still counts.
  - **Answered OUTSIDE Turma** (the terminal, claude.ai) it closes `via:"terminal"` once the session
    moves past the asking turn: the pane went busy, a newer `user` entry, or a NEWER ended turn. An
    open row blocks every later ask of that session, so it must not wait for a Turma `input`. A
    trailing entry of another role (a `system` line) is not an answer.
- **A session that leaves `running`** without a kill/delete (exited, errored, stopped) closes its
  open rows on the next beat (`_permission_close_departed`), as kill/delete already did.
- **A manager restart re-files a live dialog.** `_perm_open` is in memory, so a dialog up across a
  restart is opened again under a new id; the prompt counts twice and its pre-restart wait is lost.
  The agent never closes the lost row. The HUB does (answer and wait unknown, `turma-permissions.md`):
  a lost dialog row when that session files a NEWER dialog row (the re-filed one), a lost ask on ANY
  newer row of its session, and any row still open after 24h (`OPEN_MAX_MS`).
- **A sandbox escape is not hookable at all** — the pane is its only source.
  - Its host comes ONLY from the TUI's `Host:` row, else its "don't ask again for <host>" option
    (`_pane_dialog_host`). Any other host-shaped word may be the call's text (`package.json` fits),
    and the head is pasted as an `allowedDomains` rule; no host means no rule.
- **Open question (record the answer here):** what the TUI shows for a classifier block. The first
  week of real data answers it; until then nothing assumes it shows a dialog.

## Agent-side wire discipline (XERK-395)

- **The hook-log tail runs on its OWN worker** (`_permission_fetch_worker_loop`, the
  `_fetch_pr_comments` shape) — never on the beat, never on the slow-refresh worker. Per-file cursor
  `(inode, offset)`, worker-owned; a changed inode drains the rotated `.1` first; the first pass of a
  process PRIMES every log ON DISK to EOF, a stopped session's included (it keeps its id and log, and
  a later Start would otherwise replay them as new prompts). Rows are staged in
  `_permission_rows_fetched`, REBOUND under `_permission_lock`; the beat drains and owns every row.
- **Known gap: priming drops what was logged while the manager was down.** A `PermissionDenied`
  written then is never read (its `c-<sid>-<toolUseId>` id would replay idempotently, but the
  `PermissionRequest`s beside it would double-count). Fix = persist cursors with the registry.
- **The DIR is session-writable too, so it is never read or swept THROUGH a link**
  (`_permissions_dir_planted`): a session swapping it for a link to `~/.claude/projects/<slug>` would
  have the hourly sweep delete other sessions' transcripts. The sweep opens the dir
  `O_DIRECTORY|O_NOFOLLOW`, stats/unlinks relative to that fd, and removes only permlog's own names
  (`<sid>.jsonl`, `<sid>.jsonl.1`, `_permission_log_sid`).
- **The log is session-written** (Bash walks past the `Edit` deny): every read is `O_NONBLOCK` +
  `O_NOFOLLOW` + regular-file only + bounded (`_read_permission_log`, guard.py's `_read_text`
  discipline), every line re-shaped (`parse_permission_log_lines`), over-long lines skipped.
- **A trailing partial already longer than `PERMISSION_LOG_LINE_MAX` is consumed as junk** — a
  newline-free read otherwise never moves the cursor, so one session's Bash write could blank
  another session's rows until the file rotates.
- **The pane edges read the transcript tail ONLY on an edge** — the same bounded tail read
  `session_report` already does every beat.
- **`permissionEvents`** rides the heartbeat oldest-first, at most `PERMISSION_EVENTS_MAX` (200) a
  beat, snapshotted under `_permission_lock`, cleared BY IDENTITY in `_clear_delivered_staged`, and
  NEVER shed by `_drop_on_demand_results` (a row is an event that exists nowhere else). The outbox
  is bounded (`PERMISSION_OUTBOX_MAX`, oldest dropped, logged). Rows are COPIES; an open row is sent
  again closed under the same `id`, and the hub upserts.

## Tests

`test_permlog.py` (event shapes — the REAL PermissionRequest one, bounds, fail-open incl.
FIFO/symlink, rotation, `-SsE`); `TestPermissionLedgerEdges` + `TestPermissionLogTail`
(`test_hub_agent.py`); the `test_guard_settings.py` pins (deny equality, every-hook-event `-SsE`, the
PreToolUse matcher list).
