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
    with no pending call. Same `dialogKind`, and question + detail equal with all whitespace removed;
    a face at parse_pane_prompt's line cap is the other's tail, at its char cap the other's head.
    Labels are not compared (a wrap drops one). Without it a ttyd attach split such a prompt in two.
  - **The face is UNCUT by chars** (`detailFace` → `panePromptFace` → `face=`): a long command cut at
    BOTH caps is a middle window, and two widths' windows need not overlap, so only the line cap may
    trim it. It never rides the wire: session_report lifts it out of `panePrompt`, the beat pops it.
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
- **`ask-in-chat`** — the session ended its turn asking for permission in prose. INTERIM: a cheap
  regex (`PERMISSION_ASK_RE`) on the last assistant message, once per turn, on the agent's
  ended-turn edge (idle pane, nothing pending, last word the assistant's with no tool call); closed by
  the next operator `input` (`via:"turma"`). Sessions already sitting there on a manager's first beat
  are PRIMED, not re-filed. Replaced by the wait classifier (a later XERK-1560 child).
  - **Answered OUTSIDE Turma** (the terminal, claude.ai) it closes `via:"terminal"` once the session
    moves past the asking turn: the pane went busy, a newer `user` entry, or a NEWER ended turn. An
    open row blocks every later ask of that session, so it must not wait for a Turma `input`. A
    trailing entry of another role (a `system` line) is not an answer.
- **A session that leaves `running`** without a kill/delete (exited, errored, stopped) closes its
  open rows on the next beat (`_permission_close_departed`), as kill/delete already did.
- **A manager restart re-files a live dialog.** `_perm_open` is in memory, so a dialog up across a
  restart is opened again under a new id. The HUB closes the orphan (`closeSuperseded`, answer and
  wait unknown — `turma-permissions.md`); the prompt still counts twice and its pre-restart wait is lost.
- **A sandbox escape is not hookable at all** — the pane is its only source.
- **Open question (record the answer here):** what the TUI shows for a classifier block. The first
  week of real data answers it; until then nothing assumes it shows a dialog.

## Agent-side wire discipline (XERK-395)

- **The hook-log tail runs on its OWN worker** (`_permission_fetch_worker_loop`, the
  `_fetch_pr_comments` shape) — never on the beat, never on the slow-refresh worker. Per-file cursor
  `(inode, offset)`, worker-owned; a changed inode drains the rotated `.1` first; the first pass of a
  process PRIMES every log ON DISK to EOF, a stopped session's included (it keeps its id and log, and
  a later Start would otherwise replay them as new prompts). Rows are staged in
  `_permission_rows_fetched`, REBOUND under `_permission_lock`; the beat drains and owns every row.
- **The log is session-written** (Bash walks past the `Edit` deny): every read is `O_NONBLOCK` +
  `O_NOFOLLOW` + regular-file only + bounded (`_read_permission_log`, guard.py's `_read_text`
  discipline), every line re-shaped (`parse_permission_log_lines`), over-long lines skipped.
- **The pane edges read the transcript tail ONLY on an edge** — the same bounded tail read
  `session_report` already does every beat.
- **`permissionEvents`** rides the heartbeat oldest-first, at most `PERMISSION_EVENTS_MAX` (200) a
  beat, snapshotted under `_permission_lock`, cleared BY IDENTITY in `_clear_delivered_staged`, and
  NEVER shed by `_drop_on_demand_results` (a row is an event that exists nowhere else). The outbox
  is bounded (`PERMISSION_OUTBOX_MAX`, oldest dropped, logged). Rows are COPIES; an open row is sent
  again closed under the same `id`, and the hub upserts.

## The permission judge (XERK-1566)

Prompts a human would always approve are judged by an LLM against the org's written policy — on
the MANAGER, never inside a hook, for **Bash only** (the grant is honoured by guard.py, whose
matcher is Bash; a classifier-blocked MCP/WebFetch call is retired by the ledger's allow rules).
Claude sessions only: dsh/qwen have no Claude hooks, and the judge stands a dsh/qwen request.

- **Hand-off**: permlog.py `--judge`, on a Bash PermissionDenied/PermissionRequest, writes
  `<sid>.<nonce>.judge.req.json` (the WHOLE command, ≤ `JUDGE_COMMAND_MAX`; the random nonce lets
  parallel calls not clobber each other) and polls `.judge.ans.json` for at most `JUDGE_WAIT_SEC`
  (75s, under the hook's 90s timeout). It waits only while `judge.alive` is fresh — the worker
  re-marks it before each request and model attempt (≤5s throttle) and REMOVES it with no
  policy, so a stood-down judge costs no wait and a long pass never ages it out.
  `allow` → `retry: true` (PermissionDenied) or `decision.behavior: allow` (PermissionRequest);
  stand / no answer / a malformed one → prints nothing. The names are mirrored in hub-agent.py
  (parity-tested).
- **A DEDICATED worker** (`_judge_worker_loop`, the `_input_worker_loop` shape; polls every 0.5s,
  at most `JUDGE_REQS_PER_PASS` a pass, oldest mtime first, at most `JUDGE_REQS_PER_SID` per
  session so one that plants request files cannot starve the rest). Each request reads the clock
  afresh (a pass of serial model calls runs minutes). No model call starts that could end past
  `ts + JUDGE_ANSWER_BY_SEC` (70s, under the hook's 75s wait) — that request stands — so an `allow`
  is one the hook read. Never the beat, never the slow-refresh worker — a request
  behind a gh sweep would blow the hook's deadline. Off with `TURMA_PERMISSION_JUDGE=0` (also drops
  `--judge` from the hook). `ManagerMixin` patches it off for the suite.
- **Requests are session-written**: read only via `_read_untrusted_json`, removed once read, name
  and every field re-validated; anything addressable but unusable (not Bash, not a running Claude
  session, too old, too long) is answered `stand` so its hook returns at once.
- **Order**: `judge_never_reason` FIRST (the never-list below) → `stand`, no model call. Else,
  with a policy, `claude -p --model haiku --tools "" --strict-mcp-config` (list argv, cwd
  `REGISTRY_DIR`, no `--settings`, stdin DEVNULL, `JUDGE_TIMEOUT_SEC` 20s, at most
  `JUDGE_ATTEMPTS`) over `JUDGE_INSTRUCTION` + the policy + the request JSON-encoded as untrusted
  data.
- **The judge gets NO tools and NO MCP servers** — its input is ADVERSARIAL (text a session wrote
  to win an approval) and no guard runs in that process, so an injected instruction must have
  nothing to call (verified: the init event lists `tools: []`, `mcp_servers: []`). `--tools` is
  variadic: the boolean `--strict-mcp-config` must sit between it and the prompt.
- **The never-list FAILS CLOSED by command FAMILY, never by flag spelling** (coordinator decision,
  2026-10-04: three review rounds each found one more spelling — `--mirr`, a quoted `'+feat'`, a
  glob refspec, REST `/merges`, GraphQL `mergePullRequest`, a curl to api.github.com). Stood whole:
  - ANY `git push` (also `send-pack`/`http-push`/`hub push`) — auto mode already allows pushing a
    session's own branch, so the judge never needs to approve one;
  - git ref rewrites: `branch` with any delete/move/copy/force option or prefix, `update-ref`,
    `symbolic-ref`, `tag -d/-f`, a `remote.*.push|mirror` / `alias.*` config, and any git
    subcommand not in `_JUDGE_GIT_KNOWN` (an alias defined elsewhere can be `push`);
  - ANY `gh|glab pr|mr merge`; ANY `gh api` with `-f/-F/--field/--raw-field/--input/-X/--method`
    (any long prefix, any short cluster) and EVERY `graphql` call; `gh repo sync|delete|…`,
    `release delete`, `workflow run`, any gh `delete`; `az repos pr update|complete`;
  - any curl/wget/http/httpie/xh/Invoke-WebRequest to github.com or api.github.com;
  - terraform/tofu apply/destroy/import/state-rm; mutating kubectl/oc (every namespace), helm,
    argocd; AWS/docker deletes, sudo, pipe-to-shell, Turma's/Claude's own state; the guard's
    own destructive/policy categories (`_guard_module`; one that cannot load stands everything).
- **Two layers, either stands.** `_JUDGE_NEVER` matches the RAW text case-insensitively, so a
  MENTION stands (`python -c "os.system('git push')"`). `_judge_family_reason` reads head +
  subcommand of every command guard.py's `_expand_both` unwraps (bash -c, eval, xargs, env, sudo,
  subshells, `$( )`), lower-cased, `.exe` dropped. A segment shlex cannot parse, a too-deep nest,
  or a program/family word that is a `$VAR` or substitution also stands. Pin every family + the
  spellings found in `NEVER_FAMILIES` (`test_the_never_list_stands_before_any_model_call`), and
  the family layer alone in `test_the_family_layer_stands_without_the_raw_text_layer`. Never
  narrow a family back to a list of dangerous flags.
- **`parse_judge_verdict` is STRICT**: exactly one JSON object (one ``` fence tolerated) with
  exactly `verdict` (allow|stand) + non-empty `reason`. Anything else retries, then stands.
- **On allow for a PermissionDenied**: the one-shot grant (`_write_grant`, `GRANTS_DIR/<sid>/
  <judge_grant_key>`, TTL `JUDGE_GRANT_TTL_SEC` 120s, random-tmp + rename, a symlinked session dir
  refused). A PermissionRequest needs none — the hook allows it itself. Grant contract + the
  accepted same-uid residual: `agent-hooks.md`. `_judge_sweep` drops expired grants, dirs of ended
  sessions and req/ans files a dead hook left.
- **Every judgement is a ledger row** — `kind: judged`, id `j-<sid>-<nonce>`, `verdict`,
  `judgeReason`, `answer` (allow; a stood classifier block `deny`; a stood dialog `unknown`), staged
  via `_emit_permission` (lock-guarded) for the beat to ship.
- **A judge-allowed prompt is NOT a human dialog in the ledger.** permlog.py writes the hand-off's
  nonce into its OWN ledger line (`judgeNonce`) before waiting; the worker records each `allow`
  (`_note_judge_allowed`, bounded). The beat's fold (`_judge_was_allowed`) then drops that
  PermissionRequest row instead of holding it into a `dialog`/`unknown` row, and a PermissionDenied's
  `classifier-denied` row reads `answer: allow` (re-sent by the worker under the same id if the beat
  sent the deny first; one lock spans each side's check and emit, so the allow lands last). The
  nonce only ever HIDES a row the judge itself allowed — never approves anything.
- **Policy text is hub-owned** (`turma-permissions.md`): `permissionPolicy` rides every heartbeat
  reply; `_ingest_permission_policy` keeps it in memory for the worker and renders
  `~/.turma/permission-policy.md` on change. A reply without one FORGETS it (judge stands down);
  an empty text is the operator's off switch for that org.

## Tests

`test_permlog.py` (event shapes — the REAL PermissionRequest one, bounds, fail-open incl.
FIFO/symlink, rotation, `-SsE`, the judge req/ans dance); `TestPermissionLedgerEdges` +
`TestPermissionLogTail` + `TestPermissionJudge` (`test_hub_agent.py`); the `test_guard_settings.py`
pins (deny equality, every-hook-event `-SsE`, the PreToolUse matcher list, `--judge` wiring).
