---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/hooks/permlog.py"
  - "agent/tests/test_permlog.py"
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
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
  - **A manager restart mid-classification does not lose the ask**: the first beat primes, EXCEPT
    a turn whose persisted `attentionHint` is the same `review|<ts>` edge and not yet `done` — that
    one goes back into `_perm_ask_pending`, so the re-staged verdict still files it.
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
  at most `JUDGE_REQS_PER_PASS` a pass, at most `JUDGE_REQS_PER_SID` per session so one that
  plants request files cannot starve the rest). Each request reads the clock
  afresh (a pass of serial model calls runs minutes). No model call starts that could end past
  `ts + JUDGE_ANSWER_BY_SEC` (70s, under the hook's 75s wait) — that request stands — so an `allow`
  is one the hook read. Never the beat, never the slow-refresh worker — a request
  behind a gh sweep would blow the hook's deadline. Off with `TURMA_PERMISSION_JUDGE=0` (also drops
  `--judge` from the hook). `ManagerMixin` patches it off for the suite.
- **Requests are session-written**: read only via `_read_untrusted_json`, removed once read, name
  and every field re-validated; anything addressable but unusable (not Bash, not a running Claude
  session, too old, too long) is answered `stand` so its hook returns at once.
  - **Picked oldest-first by when the WORKER first saw the file** (`_judge_seen`), never its mtime —
    `touch -d` would let a session jump the queue.
  - **A session can plant requests under ANOTHER running session's sid** (the sid is only the
    filename). So model calls are capped per sid (`JUDGE_CALLS_PER_SID_MIN` a rolling minute;
    past it a request stands). An allow then grants the named session one exact command the model
    approved under its policy — the same-uid residual in `agent-hooks.md`, not a new one.
- **Order**: `judge_never_reason` FIRST (plain gate + never-list below) → `stand`, no model call. Else,
  with a policy, `claude -p --model haiku --tools "" --strict-mcp-config` (list argv, cwd
  `REGISTRY_DIR`, no `--settings`, stdin DEVNULL, `JUDGE_TIMEOUT_SEC` 20s, at most
  `JUDGE_ATTEMPTS`) over `JUDGE_INSTRUCTION` + the policy + the request JSON-encoded as untrusted
  data.
- **The judge gets NO tools and NO MCP servers** — its input is ADVERSARIAL (text a session wrote
  to win an approval) and no guard runs in that process, so an injected instruction must have
  nothing to call (verified: the init event lists `tools: []`, `mcp_servers: []`). `--tools` is
  variadic: the boolean `--strict-mcp-config` must sit between it and the prompt.
- **Only plain commands reach the model** (coordinator decision 2, 2026-10-04): a deny list in
  front of the model can never be complete against bash (globbed program names `/usr/bin/g[i]t`,
  `hash -p`, `ln -s` aliases, flags between a noun and its verb, globbed verbs `merg*`). So
  `_judge_plain_reason` (`_judge_lex`, a strict lexer) runs first and STANDS anything not plain:
  - (a) only simple commands joined by `;` `&&` `||` `|` or a newline — no subshell, group,
    function, `&` job, `|&`, process substitution, here-string, any `$` (in a word or a double
    quote), backtick, or a heredoc body that expands (a quoted-delimiter body is data);
  - (b) each program word plain (basename `[A-Za-z0-9._+-]+`, unquoted, unescaped, unglobbed),
    not a shell/interpreter/runner/feeder/keyword (`_JUDGE_PLAIN_RUNNERS`: env, sudo, xargs,
    `find -exec`, hash, alias, ln, npx, nohup, timeout, watch…), not a name an earlier word of the
    same command named (written then run); no `PATH`/`GIT_*`/`*_COMMAND`-style assignment; no
    cp/mv/tee/chmod/redirect into a bin dir or naming a family program;
  - (b′) rule (b) reaches PAST the program word — a program run from an argument stands too,
    since its payload is a word the lexer never reads as a command: an argv executor + its verb
    (`_JUDGE_ARGV_EXECUTORS`: ssh always; docker/podman exec|run, uv/poetry/pipenv/pdm/hatch run,
    npm/pnpm/yarn exec|dlx|x, bundle exec, nix run, gcloud/vagrant ssh…; `npm`/`cargo`/`go run`
    of a project script stays judgeable); any unquoted argument or `=`-value that is a shell,
    runner or interpreter (`--entrypoint=sh`, `rsync -e ssh`); a quoted command line with a
    shell/runner token, or a runner/executor/interpreter in a command position (`_judge_runs_another`);
  - (d) no word (or `=`/`,`/`:` part, leading dashes off, case-folded) in `_JUDGE_NEVER_WORDS`
    (push, merge, delete, rebase, reset, apply, destroy, import, sync, patch, replace, scale,
    rollout, upgrade, uninstall, graphql, update-ref, symbolic-ref, mirror, force…), no GitHub
    host outside a `git` command, `install` beside helm, `run` beside a non-gh family program or a
    gh/glab workflow/ci noun — so (e) no family program ever reaches the model with one.
  - Pinned: `PLAIN_GATE_PROBES` + `JUDGEABLE` (`test_only_plain_commands_reach_the_model`; npm ci,
    pytest -q, docker build, cargo test pass). Residual: a script's contents (`npm test`, `./x`
    written by an EARLIER call) are not on the command line; the model sees only its name.
  - (b″) shell-handing options stand outright, disguised or not (`_judge_shell_option_reason`,
    XERK-1595): tar `--to-command`/`--checkpoint-action`/`-I`/`-F`…, make `--eval`/`-E`/`SHELL=`,
    zip `-TT`/`--unzip-command`, a GNU sed `e` command or `s///e`, and a git config key git runs
    (`core.sshCommand`/`fsmonitor`/`editor`/`pager`, `credential.*helper`, `*.textconv`,
    `filter.*`, `include.*`…) via `-c`, `--config-env` or `git config`. Long names match any
    GNU abbreviation (`--to-com`).
  - (b‴) a quoted word with whitespace that also holds an inner quote, a backslash, a `$`/backtick,
    a glob or a brace list stands (`_JUDGE_PAYLOAD_DISGUISE_RE`): an UNKNOWN shell-handing option
    could turn `g""it pu""sh` back into a push the raw never-list cannot see. Shell operators alone
    do not stand (they hide no word), so `-m 'feat(x): a; b'` stays judgeable; `-m "don't"` stands.
- **The never-list FAILS CLOSED by command FAMILY, never by flag spelling** (coordinator decision,
  2026-10-04: three review rounds each found one more spelling — `--mirr`, a quoted `'+feat'`, a
  glob refspec, REST `/merges`, GraphQL `mergePullRequest`, a curl to api.github.com). Stood whole:
  - ANY `git push` (also `send-pack`/`http-push`/`hub push`) — auto mode already allows pushing a
    session's own branch, so the judge never needs to approve one;
  - git ref rewrites: `branch` with any delete/move/copy/force option or prefix, `update-ref`,
    `symbolic-ref`, `tag -d/-f`, a `remote.*.push|mirror` / `alias.*` config, and any git
    subcommand not in `_JUDGE_GIT_KNOWN` (an alias defined elsewhere can be `push`); local ones
    too — `checkout -B`, `switch -C`, `worktree add -B`, a fetch/pull refspec with `:` or a
    leading `+`, `replace` (`_judge_git_ref_rewrite`); `hub` against git's + hub's known set;
  - ANY `gh|glab pr|mr merge`; ANY `gh api` with `-f/-F/--field/--raw-field/--input/-X/--method`
    (any long prefix, any short cluster) and EVERY `graphql` call; `gh repo sync|delete|…`,
    `release delete`, `workflow run`, any gh `delete`; `az repos pr update|complete`;
  - ANY gh/glab whose first word is not in `_JUDGE_GH_KNOWN`/`_JUDGE_GLAB_KNOWN`: an alias
    (`gh m 12`), an extension, `copilot`/`agent-task`/glab `duo`, and `alias`/`extension`
    themselves — `guard.decide` cannot resolve an alias either, so a grant would allow it;
  - any curl/wget/http/httpie/xh/Invoke-WebRequest to github.com or api.github.com, AND any whose
    destination the judge cannot read: from a file or stdin (`curl -K/--config`, `--url @f`,
    `wget -i/-e/--config`, `aria2c -i`) or no argv token that could be a host at all (a
    `.curlrc` supplies it) — `_judge_http_reason`;
  - any HTTP request whose HOST the client would rewrite: every token is matched after
    `_judge_fold` (percent-decode, NFKC, the U+3002/FF0E/FF61/FE52 dots → `.`, lower-case), so
    `api%2Egithub%2Ecom` and `api。github。com` are github.com (the raw-text layer matches the
    folded text too); a host still carrying `%`, non-ASCII, `\` or a curl glob (`{}`/`[]` other
    than an IPv6 literal) stands; so does a curl `--connect-to`/`--resolve`/`--doh-url` reroute
    and `-H @file` (a `Host:` header from a file). curl's value options (`-w`, `-H`, `-d`…) are
    skipped, so `-w '%{http_code}'` is not a host;
  - any family command FED its arguments from stdin or a file (`_judge_feeder_reason`): guard.py
    unwraps `printf 'push origin main' | xargs git` to a bare `git`, the subcommand still in
    stdin. `parallel`/`sem`/`rush` always stand (they read whole command lines); `xargs` and
    `find`/`fd` with an exec action stand when a word they run is a family program, a shell,
    `env`/`sudo`-style runner, an interpreter or a `$VAR`, or xargs' program word is its `-I`
    replace-string;
  - terraform/tofu apply/destroy/import/state-rm; mutating kubectl/oc (every namespace), helm,
    argocd; AWS/docker deletes, sudo, pipe-to-shell, Turma's/Claude's own state; the guard's
    own destructive/policy categories (`_guard_module`; one that cannot load stands everything).
- **Behind the plain gate, two more layers, either stands.** `_JUDGE_NEVER` matches the RAW text case-insensitively, so a
  MENTION stands (`python -c "os.system('git push')"`). `_judge_family_reason` reads head +
  subcommand of every command guard.py's `_expand_both` unwraps (bash -c, eval, xargs, env, sudo,
  subshells, `$( )`), lower-cased, `.exe` dropped. A segment shlex cannot parse, a too-deep nest,
  or a program/family word that is a `$VAR` or substitution also stands. Pin every family + the
  spellings found in `NEVER_FAMILIES` (`test_the_never_list_stands_before_any_model_call`), and
  the family layer alone (gate + raw off) in `test_the_family_layer_stands_without_the_raw_text_layer`. Never
  narrow a family back to a list of dangerous flags.
- **`parse_judge_verdict` is STRICT**: exactly one JSON object (one ``` fence tolerated) with
  exactly `verdict` (allow|stand) + non-empty `reason`. Anything else retries, then stands.
- **On allow for a PermissionDenied**: the one-shot grant (`_write_grant`, `GRANTS_DIR/<sid>/
  <judge_grant_key>`, TTL `JUDGE_GRANT_TTL_SEC` 120s, random-tmp + rename). A PermissionRequest
  needs none — the hook allows it itself. Grant contract + the accepted same-uid residual:
  `agent-hooks.md`. `_judge_sweep` drops expired grants, dirs of ended sessions and req/ans files
  a dead hook left.
- **GRANTS_DIR and PERMISSIONS_DIR are session-writable, so the manager never follows a link in
  them** (`_RealDir`): `ln -s ~ ~/.turma/grants` passes the guard and once turned the sweep into
  an `rm -rf ~`. Each dir is opened `O_DIRECTORY|O_NOFOLLOW` and walked fd-relative (path + lstat
  on Windows); a link at GRANTS_DIR or a sid dir is UNLINKED (the entry, never its target); the
  sweep touches only `VALID_PERMISSION_SID_RE` dirs and `_JUDGE_GRANT_FILE_RE` names in them, and
  NEVER recurses (no rmtree). `_write_grant` writes through the same handles or not at all.
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
FIFO/symlink, rotation, `-SI`, the judge req/ans dance); `TestPermissionLedgerEdges` +
`TestPermissionLogTail` + `TestPermissionJudge` (`test_hub_agent.py`: incl. the symlinked
grants/permissions dir cases, pick order, the per-sid call cap, and the REAL `run_forever` loop
feeding `permissionPolicy` from both replies); the `test_guard_settings.py`
pins (deny equality, every-hook-event `-SI`, the PreToolUse matcher list, `--judge` wiring).

## The judge's one-shot grant (guard.py)

- **The judge's one-shot grant is guard.py's ONLY `allow`** (XERK-1566, `consume_grant`). Consulted
  only AFTER `decide()` allowed the command (every hard deny wins), only for Bash, inside main()'s
  fail-CLOSED try. `~/.turma/grants/<TURMA_SESSION_ID>/<sha256(command)>` must be a regular file
  (`O_NONBLOCK|O_NOFOLLOW`, bounded; the session dir not a symlink) naming this session + exact
  command, unexpired (`exp` at most `GRANT_TTL_MAX_SEC` out). Unlinked BEFORE allowing, so one
  grant allows one call. Honoured ONLY by a guard launched with `--grants`, which
  `build_guard_settings` adds while the judge is on — the switch rides each launch's settings, since
  a session's env comes from the long-lived tmux server, not the manager. A session launched before
  `TURMA_PERMISSION_JUDGE=0` keeps the flag until relaunched (the judge then writes no grant).
  - **Accepted residual: the grant dir is same-uid and Bash can write it.** A model that learns the
    protocol can self-grant one command past the auto-mode classifier — or drop a judge answer that
    makes permlog.py allow a PermissionRequest dialog — the same class as `echo >
    ~/.turma/qwen-guard.json`. Mitigations, none sealing it: `Edit(~/.turma/grants/**)` and
    `Edit(~/.turma/permission-policy.md)` denies (file tools only, in the equality pin); the grant
    path/protocol is never named in any reason or prompt a model reads; every judgement is a ledger
    row (`kind: judged`); the hard denies still win; the never-list stands any command naming
    `.turma/grants`. Never describe the judge as un-forgeable. A session can also plant a request
    under ANOTHER running session's sid (capped per sid, `agent-permissions.md`); the manager
    never follows a link in the grant dir it sweeps.
  - **Before any model call the judge stands non-plain commands and never-list FAMILIES** (any push,
    ref rewrite, PR merge, non-read `gh api`, prod mutators), matched AFTER guard.py's `_expand_both`
    unwrapping, so a change to that unwrapping changes what the judge sees. Rules + tests: the
    never-list and plain-command sections above. Never describe the gate as complete.
  - **Real-host spike NOT run** (no agent host here): does `PermissionDenied`'s `retry: true`
    re-enter `PreToolUse` on the retried call, with the grant honoured? And what does the TUI show
    for a classifier block? If the retry never reaches guard.py, the grant goes unconsumed, expires
    (120s) and is swept; the classifier blocks again — nothing runs that did not before. The
    fallback is then the PermissionRequest path alone plus the ledger's allow rules. Record the
    answers here. Tests: `TestJudgeGrants` (`test_guard.py`).
