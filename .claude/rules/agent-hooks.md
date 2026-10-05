---
paths:
  - "agent/hooks/**"
  - "agent/hub-agent.py"
---

# `agent/hooks/` — the guard and AskUserQuestion hooks

`agent/hooks/guard.py` and `agent/hooks/ask.py` are stdlib-only, land at `/usr/local/bin/hooks/`,
wired by `hub-agent.py`'s `build_guard_settings()` into the `--settings` file every session launches
with. Policy (what's denied and why) plus the implementation contract behind it.

## Policy — what the guard denies, and why

- Every launch passes `--settings` a generated file (`build_guard_settings()` →
  `~/.turma/guard-settings.json`) wiring `PreToolUse` hooks over Bash and the file-editing tools,
  plus `permissions.deny` on host credential stores (`~/.ssh`, `~/.aws`, `~/.azure`,
  `~/.terraform.d`, `~/.claude`, `~/.config/gcloud`) — deny wins even under bypass.
- **`_GUARD_DENY_TOOL_RULES` denies `ListAgents`** (XERK-348), which REMOVES the tool (no schema to
  call) — what makes `PEERS_FILE` a session's only address book and therefore the org boundary.
  **`SendMessage` must stay**: it resolves a bare roster name with no prior listing, and subagent/
  agent-team messaging rides the same tool. The `test_guard_settings.py` equality pin covers PATH
  rules only — a tool rule needs its own assertion.
  - `Edit(~/.turma/peers.tsv)` is denied beside the other `~/.turma` files (a session must not edit
    its own address book); Bash walks past it (XERK-309), file-edit tools only, like its neighbours.
  - **`Read(~/.turma/peers.tsv)` is ALLOWED** — without it, reading the roster costs a permission
    prompt with `ListAgents` denied and no way to get that approval, leaving no address book at all.
  - The session CLI (`hooks/session_cli.py`, XERK-1564) adds one generated Bash allow and the
    `Edit(~/.turma/session-requests/**)` deny — contract in `agent-session-cli.md`.
- **`crossSessionInbound: accept`** (XERK-339) is a fix, not a convenience: Claude Code's default
  HOLDS a peer message whenever sender/receiver permission-mode classes differ, opening an approval
  dialog nothing here can answer (not an AskUserQuestion; owns the input line the composer types
  into; invisible to `_busy_from_capture`/`_pane_prompt`), then expires and drops the message
  (verified on a real pane). Sits on `--settings` so it scopes to this agent's sessions only; a
  project's own settings can still say `refuse`, which outranks it.
- **The same file carries FLEET FLOORS** (XERK-1565), which MERGE with the operator's own settings
  (lists merge across scopes; `--settings` sits above project settings), never replace them:
  - `sandbox.network.allowedDomains` = `SANDBOX_DOMAIN_FLOOR`; `TURMA_SANDBOX_DOMAINS` (CSV)
    REPLACES it when non-blank; `none` empties it (blank keeps the floor). Same for
    `TURMA_TOOL_ALLOW` below.
  - Residual: the domain floor removes the PROMPT and adds no containment. GitHub (any public
    issue), `*.atlassian.net` (anyone can create a site) and the registries are multi-tenant sinks,
    and sandboxed reads are open bar `Read()` denies (none on `~/.config/gh`, `~/.claude`), so a
    sandboxed command can send any readable file there unprompted. `*.googleapis.com` stays OFF
    (storage.googleapis.com takes a signed-URL upload to anyone's bucket); off-floor still prompts.
  - `permissions.allow` gains `TOOL_ALLOW_FLOOR` (narrow `Bash(<cmd>:*)` PR/CI-read/test rules,
    which skip auto mode's classifier) after `_GUARD_ALLOW_PATH_RULES` and the session-CLI rule,
    before the operator's;
    `TURMA_TOOL_ALLOW` (CSV) REPLACES it. Not `TURMA_TOOL_GRANTS`, which is a hook-time
    destructive exemption and never written here.
  - **The floor has NO git rule (no push, fetch or switch) and must not regain one.** The guard
    refuses a push only when a LITERAL refspec token names main/master (`_is_protected_ref`): it
    skips flag tokens and never expands a glob refspec. Floored, a `--mirror` push from a fresh
    detached worktree force-rewound remote main and deleted remote branches unprompted (reproduced
    on scratch repos), as do `--all` and `refs/heads/*`; a fetch of `HEAD:main` (or
    `--update-head-ok`) moved local main for an `--all` push; a switch onto main set up a `HEAD`
    push. Auto mode already lets a session fetch and push its own non-default branch, so a git
    command TYPED DIRECTLY stays with the classifier. Keep git out of `TURMA_TOOL_ALLOW` too.
  - Residual: the test-runner rules (`./gradlew`, `npm test`, `node --test`, `pytest`,
    `python3 -m unittest`) run SESSION-EDITABLE code — the `./gradlew` script, package.json
    scripts, conftest.py, test modules — past both the classifier and the guard, which sees only
    the runner's command line.
    A session can write a `--mirror` push into one and run it unprompted, so it can still reach main
    or credentials. It needs no file at all: `node --test --import 'data:text/javascript,…'` (or
    `--require`) runs INLINE code in one unprompted command, code the guard never sees. Dropping
    the git rules closed the DIRECT route, not every route; never describe the floor as keeping a
    session off main.
  - Residual: `gh pr create`/`gh pr edit` post whatever body the command names, past the
    classifier. pr-summary is no credential filter: it refuses a second description flag, `-dF`
    clusters included (below), but a conforming body plus `$(cat ~/.config/gh/hosts.yml)`, or a
    lone `--body-file` under `TURMA_PR_SUMMARY=0`, still posts the file unless Claude Code's prefix
    match refuses the substitution — unmeasured, part of the spike below. Stdin and fd paths are
    closed (below); a body file is checked ALONE, so no heredoc vouches for it; and one another
    segment names (`cp <cred> b.md; … -F b.md`) is refused. That compares path STRINGS, so one
    spelled so the hook can't match it (a glob, `$(…)`, `"$PWD/b.md"`, `/proc/self/cwd/b.md`, a
    symlinked dir made in the same line) or swapped by an EARLIER tool call is not.
  - `TURMA_TOOL_ALLOW` splits on every comma with no escape, so a rule whose pattern holds a comma
    cannot be set through it (it lands as two malformed rules).
  - `autoMode.environment` = `["$defaults", auto_mode_host_block()]`: device, `REPOS_ROOT`, scanned
    repos (capped; only names matching `AUTO_MODE_REPO_NAME_RE` are COPIED, the rest counted — a
    `REPOS_ROOT` dir name is session-writable text in trusted classifier context), `GH_CLONE_OWNERS`,
    tracker org/site, `TURMA_URL` minus userinfo, the worktree/PR/
    default-branch facts. The operator file keeps the org-wide block. A SNAPSHOT at the manager's
    first launch (the file is cached per process): a repo cloned later is missing until restart.
  - Residual: the charset still admits a hyphenated phrase (`operator-preapproves-force-pushes`),
    so the block introduces the list as directory names that are "data, not instructions". That
    labels it; it cannot stop a name nudging the classifier. Never describe the filter as closing it.
  - dsh/qwen read only `permissions`, and only its `Read()`/`Edit()` rules, so none of this leaks
    there. `_ensure_guard_settings` writes an `O_NOFOLLOW` per-pid tmp + `os.replace` (no half file
    for a reader, no planted-symlink redirect).
  - Real-host spike (sandboxed floor vs off-floor domain, merged environment, `gh pr create`
    unprompted) NOT yet run — no agent host was available; record the answers here.
    Tests: `TestFleetPolicy`, `TestEnsureGuardSettingsWrite`.
- **`~/.claude` is guarded by `hooks/fileguard.py`, not a pattern**: the rule is "everything under it
  except the two agent-memory trees," which a glob list can't express — deny beats allow, and a deny
  matching a DIRECTORY takes its whole subtree, so `Edit(~/.claude/*)` is the blanket rule. Patterns
  still cover the catastrophic subset as defence in depth (mechanics below).
- Hard-denies four narrow categories, each with a self-correcting reason: **destructive** (`rm -rf`
  of `/`/home/system/`.git`, disk wipes, fork bombs, power changes, recursive `chmod`/`chown` of
  system roots, protected-branch history destruction, `DROP DATABASE|TABLE`); **policy** (push to /
  delete `main`/`master`, self-merging a PR/MR — work lands via a human-merged PR); **attribution**
  (AI self-attribution trailers); **pr-summary** (a PR/MR description missing a required section).
- **pr-summary is the hard half of `PR_SUMMARY_SYSTEM_PROMPT`** (`pr_summary_reason`): the two must
  name the same headings, or a session following its instructions is refused by its own guard.
  - Checks `gh pr create|new`, `glab mr create|new`, `az repos pr create`, and an `edit`/`update`
    only when it sets the description (glued `-bTEXT` too). `-h`/`--help` is help wherever it
    sits, EXCEPT right after a bare flag: gh/glab read it as that flag's VALUE (`-b -h`,
    `--label -h`), so the check runs. Value-taking flags differ per CLI, hence "any bare flag";
    the cost is refusing `--web -h` / `-tfoo -h`, which would only print help.
  - **Flags sit on EITHER side of the verb** (`gh pr -R o/r create`, `gh pr -b x edit 1` — real
    gh/glab accept both), so everything after `pr`/`mr` is ONE pass: body flags collected wherever
    they are, a token after a bare flag read as its value unless it is a verb with no later verb.
    Each earlier attempt to special-case "flags before the verb" left a bypass.
  - **The body checked is the ONE source gh sends** (XERK-1565) — never the plain command text, so a
    title or comment alone does not satisfy it. `--body-file` resolves against event `cwd`, moved
    by a leading `cd`.
    - A regular FILE nothing in the command writes is checked ALONE: a heredoc gh never reads
      vouched for `--body-file hosts.yml <<EOF …` (sibling heredoc too) when it was unioned in.
    - STDIN (`-F -`) is checked against EVERY heredoc in the command, each on its own: which one
      is the PR's is not mapped, so a good sibling can't vouch for a bad one, and two
      `gh pr edit N -F - <<EOF` with good bodies still pass.
    - An inline body, or a file a heredoc writer in the command fills (`cat > f <<EOF; gh pr
      create -F f`), is checked as that value + every heredoc (`--body "$(cat <<EOF …)"`). No
      source at all checks "" → refused.
    - **A writer-filled file that EXISTS must also pass ALONE.** `written` keeps no order or
      condition (groups and `$(…)` expand first), so an appending (`>>`, `tee -a`), `false &&`-gated
      or later writer left `.env`/`hosts.yml` in what gh read. Cost: a stale non-conforming
      leftover is refused — remove it in an earlier step or use a new path. Never drop this check.
    - **Do not narrow heredocs to "the one feeding the PR command"** for those: matching by owner
      line or redirect target refused 26% of real compliant PR commands (`git push && gh pr create
      …`, `cd x && …`, `cat > "$S/b.md"`, `\`-continued).
    - **The accepted residual is an UNRELATED real heredoc in the same command** (`cat > n.txt
      <<EOF …` then `gh pr create -b junk`) — it takes a model gaming its own guard. `<<` inside
      quotes, after `#`, `<<<` and `\<<` are not heredocs to the XERK-1256 lexer, so they don't
      count. Measured by swapping a compliant body into all 483 real heredoc PR commands: 0 refused.
    - **`_split_heredocs` yields `(owner, body, quoted)`** — a shape change there crashes this check,
      and the guard then fails CLOSED on every heredoc-bodied PR (shipped once, in v2.1.50).
  - A body it can't see (`--fill`, the editor, `$(cat file)`) is refused, saying how to pass it.
  - **More than one description flag is refused** (XERK-1565): the check reads the UNION of every
    source while gh sends only the LAST, so `--body-file ok.md --body-file ~/.config/gh/hosts.yml`
    passed on ok.md's sections and posted the token file. Heredocs are not flags, so `--body
    "$(cat <<EOF …)"` and `-F - <<EOF` stay one source.
  - **A STDIN description must be the PR command's OWN heredoc** (XERK-1565, `_stdin_redirects`):
    gh reads whatever fd 0 ends up as, so `-F - <<EOF … < hosts.yml` (also `0<`, `<<<`, `<&`, a
    pipe, or a sibling's heredoc: `-F - < f; gh pr view 1 <<EOF`) posted the file on the heredoc's
    sections.
    `-` or a path resolving to `/dev/stdin` needs exactly one heredoc on that segment.
  - **A description FILE fails CLOSED** (XERK-1565, `_pr_description_file`) — never enumerate bad
    paths; four rounds of that each left one (`/dev/stderr 2<f`, `//dev/fd/3 3<f`, a symlink).
    - Accepted ONLY: stdin as above; a REGULAR file outside `/dev` and `/proc`; or a path a
      heredoc-only `cat > f <<EOF` / `tee f <<EOF` in the command writes (`_note_paths`).
    - Refused: every other `/dev`/`/proc` name, a non-regular or unreadable path, a missing file
      nothing writes, and a file another segment names any other way (`ln -sf /dev/stdin f`,
      `cp hosts.yml f`, `cat hosts.yml <<EOF > f`) — each with its own reason. Only a pure reader,
      printer or remover (`rm`, `cat`, `test`, `echo`, … `_PR_PATH_READERS`) or `git add` may name
      it; its output redirects count.
    - Symlinks resolve one component at a time and NEVER through `/dev`/`/proc`: `realpath` follows
      the HOOK's own `/proc/self/fd` links, which name different fds in gh. A leading `//` is `/`.
    - With a file flag, an input redirect on ANY fd (`<`, `N<`, `<&`, `<<<`) is refused, and a
      redirect BEFORE the command word (`< f gh pr create -F -`) is the PR command's
      (`_drop_leading_redirects`).
  - **A shorthand CLUSTER is a description flag too** (`_shorthand_value`): pflag reads `-dF x` as
    `-d -F x`, so `--body-file ok.md -dF hosts.yml` (also `-dFhosts.yml`, `-wF`, glab `-yd`) is
    two sources. ANY letter of a single-dash token counts (gh `b`/`F`, glab `d`): a glued value
    holding one (`-Rbob/r`) over-refuses; stopping at a misjudged value-taking letter would leak.
  - **Every file read is `O_NONBLOCK` + regular-file only** (`_read_regular`): a FIFO at the body or
    template path hung the hook, and Claude Code lets a timed-out hook's command THROUGH.
  - Headings match with `(?!\w)`, not `\b` — a template heading ending `?`/`:`/`)` never matched.
  - Not covered (accepted): `gh api …/pulls`, `hub pull-request`, `git push -o
    merge_request.create`; `-R other/repo` is checked against the LOCAL checkout's template.
  - **A repo's own PR template wins**: its headings are required instead (ones worded `optional`/
    `if applicable` excepted); a headingless template checks nothing; an EMPTY or unreadable one
    (FIFO) is no template, so the standard applies — failing open there disabled the check. Turma ships one, so Turma's
    sessions are held to its headings, not the `**Summary:**` line.
  - Off with `$TURMA_PR_SUMMARY=0`. Replayed against 32k real Bash commands: refuses only PR
    creates/body edits, 0 others. Tests: `TestPrSummary`, the hook-entrypoint toggle case (its cwd
    must be OUTSIDE this repo, or Turma's own template switches it to template mode).
- **Destructive includes the agent's tmux server** (XERK-1077): `kill-server`, killing tmux by name
  or PID, and `kill-session`/`-window`/`-pane` of anything that could resolve to an `agent-*` session
  are denied unless tmux names some OTHER server (`-L`/`-S`). Protected: the default server and the
  agent's own `-L turma` (`_AGENT_TMUX_SOCKET`, = `TMUX_SOCKET` in hub-agent.py).
  - Sessions now run on `-L turma` with `$TMUX` unset (XERK-1078, `agent-sessions.md`), which removes
    the class; the net stays as defence in depth, and the default server stays protected because
    sessions an older agent started remain there across an in-place update.
  - tmux resolves `-t` by exact name, then unique PREFIX, then glob, so `-t ag` / `agent*` reach
    `agent-<id>`; a missing or unknowable target (`$var`, loop value) is the current session.
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) untouched. Allowlist a command
  via `$TURMA_TOOL_GRANTS` (CSV `Bash(<cmd>)`), attribution via `$TURMA_NO_ATTRIBUTION=0`.
- Classifies what the SHELL runs, **never the raw string** — `qa.md` §6.1 is the rule and its limits.

## Implementation contract

- **Guard** (`hooks/guard.py`) — `PreToolUse` over Bash, plus the `permissions.deny` credential-store
  rules (same shell-not-string classification as Policy).
  - **Fails open on a malformed EVENT, closed on a classifier crash** (XERK-1080): a traceback
    exits 1, which Claude Code treats as non-blocking, so failing open ran the command unchecked.
  - **Groups are extracted BEFORE operator splitting** (`_balanced_groups`, XERK-1083) — splitting
    first cut `$(true; rm -rf /)` / `(cd x; rm -rf /)` in half and allowed them.
    - It is a small lexer, not a paren count: `'…'`/`$'…'`, `"…"`, `[[ … ]]`, `case … esac` and
      `#` comments each hid a bypass or caused a false deny when miscounted. Scans the RAW line
      (pre-normalisation rewrites it); unclosed groups yield nothing.
    - **A misread must fail CLOSED**: no lexer short of bash is exact, and a misread context
      swallows the group's `)`. So the scan reports SUSPECT (context open at the end, or a `)`
      closing nothing outside `case`) and the split fragments are then also classified
      edge-stripped (`_stray_group_fragments`). Never drop that fallback to fix a false deny.
    - Exhausting `_MAX_EXPAND_DEPTH` DENIES (`_TOO_DEEP`) — returning nothing let a 7-deep group
      through, since a group body is only reachable by recursing.
  - **Heredocs are split by a lexer** (`_split_heredocs`, XERK-1256): only a `<<` outside quotes,
    comments, `<<<` and arithmetic opens one; the delimiter word is de-quoted whole.
    - An UNQUOTED delimiter's body is scanned for groups (`_balanced_groups(heredoc=True)`) — bash
      expands `$(…)`/backticks there. A quoted one stays data unless a shell owns it.
    - Pre-normalisation runs on the heredoc-free text, so body prose cannot shift quoting.
  - **The splitter knows comments, backticks and `case` patterns** (`_split_on_operators`):
    `# don't` desynced its quotes; a pattern's `|` is no pipe and a plain pattern is dropped.
  - **Braces inside quotes are text** (`_expand_braces`); `bash -c`/`eval` re-expand a quoted script.
  - **A single-quoted `$(…)` is classified as if it ran** — `git commit -m '$(…)'` is a known false
    deny. Scoping "text where nothing runs it" was tried and backed out (XERK-1256, now XERK-1541): pipes,
    `printf -v`, redirects into `.git/config`, `--trailer` (+ git's option abbreviation) and
    shlex-vs-bash word differences each leaked a proved bypass. Don't retry without a bash parser.
    - So quoted assignment values are read whole (`_VAR_ASSIGN_RE`): `x='rm -rf /'; eval $x`.
  - **`#` after `)` is never a comment** (`_is_comment`): `$(x)#; rm …` continues the word, so bash
    runs the rest; a subshell's `)#` read as text only classifies more.
  - **An opaque substitution glued to a word is also read as EMPTY** (`glued_empty`): `$(true)rm`
    runs `rm`. A standalone one stays the placeholder — an empty word reads as the root.
  - **An escaped substitution is literal where it sits** (`_sub_substs`, XERK-1543): replacing
    `\$(…)` left its `\` to escape the next `\"`, closing the string and running its tail.
    - The skip triggers `_expand_both`'s raw reading, which unescapes `\$(`/`` \` `` first
      (the next parse's view: `bash -c "\`printf rm\` -rf /"`). Never skip without it.
    - Accepted cost: 1 of 34.6k replayed commands (an `ssh '… sh -c "…\$(…)…"'` beside
      python parens) now misreads into `_TOO_DEEP`. Nested backticks: XERK-1605.
  - **A variable a producer filled holds that producer's OUTPUT** (XERK-1549): an assignment
    value is read whole (quoted runs, nested `$(…)`), and `printf -v x FMT ARGS` binds the
    rendered text (`_render_printf`: escapes, `\c`, precision, width, `*`, `%b`, `%c`; out of
    repeat passes it KEEPS the leftover args — dropping them hid a 9th `/etc`). `_produced_text` stores
    what the substitution PRINTS, never its `$(…)` text — inlining that re-classified it at
    every `$x` and a long line took minutes, past the hook timeout, which fails OPEN.
  - **A spliced value's quotes stay LITERAL** (`_quote_literal`, by the `_quote_states` at the
    use): bash never re-reads quotes an expansion made, and splicing raw let
    `x='"'; echo "$x"; rm -rf /` unbalance the line and hide the `rm`. Never inline a value
    unescaped. `"${a[@]}"` closes the quote around the elements (one word each).
    - Inside `'…'` (a script `eval`/`bash -c`/`trap` parses later) the value is a WORD there:
      quotes, `#` and operators all escaped. Bare keeps `;&|` live — `eval $x` re-parses them.
    - Each escape is right for ONE re-parse depth (`eval 'eval echo $x …'` makes `x=';'` code
      again), so `_expand_both` also classifies the line with values spliced RAW whenever one
      needed escaping, and denies if either reading does. Don't add escape layers instead.
    - `_quote_states` reads a `#` comment as `#` to line end, in its one pass: `# don't`
      opened a "quote"; a per-comment re-scan was 10x slower and capped (fail-open).
  - **A `#` inside `${…}` is text** (XERK-1585): `${y:- #}; rm -rf /` runs the `rm`. The
    splitter tracks `${`/`$(` nesting; the default splice escapes its `#`.
    - `_VAR_USE_RE`'s `[^}]*` stops at a QUOTED or nested `}` (`${a:-'}' #}`); `rep` leaves
      such a match raw (`_brace_end`) rather than splice a short one.
    - Whether a `$` is live (`_live_dollar`: `\${`, `$${`) holds for ONE parse — an unquoted
      heredoc or `bash -c "…"` strips a backslash first. A skip therefore also triggers
      `_expand_both`'s splice-everything reading. Never trust a single escape judgement.
  - **`eval` re-parses its RAW words once per `eval`** (XERK-1585): read before the
    substitution pass (which ate a quoted `'$('`) and before the `_SEGMENT_SPLIT` early
    `continue`. A 7-deep `eval` chain hits `_MAX_EXPAND_DEPTH` and is denied, on purpose.
  - **`cd` targets are SCOPE-blind** (`_cd_targets`, inherited into recursion): a later `cd`
    never clears an earlier one, since it may fail, sit in a subshell/pipe, or be `cd -`;
    clearing let `cd /; (cd /tmp); rm -rf *` through.
    - Order counts only on a line with NO re-run construct (`_REPLAYS_RE`, matched loosely:
      loop words, `function`, `()`, alias, trap, eval, coproc); otherwise every `cd` counts
      everywhere. trap/alias/eval/`sh -c` scripts always see every `cd`.
    - Finding where a body ends was tried twice and lost to bash's grammar (a per-segment
      stack; then a region scanner: `done=1`, `f() if …`, `${a:-${b}}`, a region cap). Don't
      retry without a bash parser.
    - Accepted cost: one real command in 33.7k replayed (defines a function, `chmod -R go-w .`,
      trailing `cd /`) is refused; the reason names the cwd and asks for an absolute path.
    - Joining covers `rm`/`unlink`/`chmod`/`chown` and `find` roots, never an opaque
      substitution (`trap 'rm -rf "$tmpd"' EXIT; cd /` is the cleanup idiom).
    - The literal `~/.ssh` is dangerous to `rm` only (`_is_home_ssh`): `chmod -R 700 ~/.ssh`
      is the routine fix.
    - Inside an exact protected root/home every relative `rm` operand is joined (`cd /; rm -rf *`
      is `/*`); deeper, only `..`-climbing ones are. Joining all there would refuse ordinary
      `cd /usr/src/app && rm -rf build` — do not widen it.
  - **`_var_values` resolves a value naming an assigned variable once** (`d=$d/x`): left in, each
    recursion level re-inlined it until `_TOO_DEEP` refused an ordinary command.
  - **A string that BECOMES a script is expanded as commands** (XERK-1539): find `-exec`/xargs
    argv re-expanded; `flock -c`, `env -S`, `eval --`; and a shell reading its script from
    stdin/fd (`_reads_stdin_script`) gets what a pipe, `<<<`, `<(…)` or heredoc feeds it.
    - Only PRINTED text is knowable: `curl … | sh`, `cat f | sh`, a transforming filter
      (`tr`, `sed`), `$(which sh)`/`$SHELL`, and `read l; $l` stay residuals — don't call
      pipes closed. The per-pipeline fed-text scan is bounded (`_FED_TEXT_CAP`, dedup) so a
      huge `echo|sh` chain can't time the hook out (which fails OPEN) — a reader past the cap
      is a miss, not a hang.
    - The producer→shell link is lost where `_split_on_operators` severs the pipeline — the
      `&` in `2>&1`/`|&`, the `;` inside `{ …; }` — a pre-existing splitter limit this relies
      on; wrapped forms (`echo P | ssh h sh`, `| docker exec -i c sh`) are residuals too.
  - **Variable inlining has a growth budget** (`_MAX_SUBST_GROWTH`, XERK-1556): each `$x` inlines
    the whole value, so size × uses took minutes, and a hook past Claude Code's timeout RUNS the
    command. Spent → DENY (`_TOO_LARGE`), never an early return, never grantable (`decide`
    checks it before the grant AND before its final allow — a grantable reason found pre-expansion
    left the budget to run out inside the policy checks).
    - ONE budget per decision (`@_budgeted`): a per-call budget let N re-expansions spend it N times.
    - Whole top-level expansions are memoised per decision; substitutions are NOT — identical bodies
      at N places are N times the work, and memoising them let 1000 heredocs through uncharged.
    - The exec-wrapper suffix pass charges the words it emits (n args → n²/2).
    - Emitted WORK is charged too, not just growth (XERK-1589): each `find -exec` run charges its
      whole segment (every checker rescans `seg` per entry), each `xargs` the piped operands.
  - Verify parser changes with a replay of every real Bash command in `~/.claude/projects` (old vs
    new guard): 0 diffs is the bar, or each diff explained. Unit cases missed every false deny above.
  - Keep in sync with the twin hook outside this repo.
  - Tests: `test_guard.py`, `test_guard_settings.py`.
- **File guard** (`hooks/fileguard.py`, same shape) — `PreToolUse` over
  `Write|Edit|MultiEdit|NotebookEdit`; refuses any write under `~/.claude` except
  `agent-memory/<agent>/**` and `projects/<slug>/memory/**`.
  - **Only the `agent-memory` half is actually usable**, not by this layer's doing: measured through
    the real binary, `~/.claude/projects/<slug>/memory/**` is refused in `auto`/`acceptEdits` with no
    settings at all and no allow rule reaches it; only `bypassPermissions` lands it. Removing the
    blanket deny is necessary but NOT sufficient for a session's own auto-memory — keep the
    `projects/` hole open anyway (costs nothing; `test_matcher_oracle.py` reports if a future release
    lifts the gate).
  - **That gate is ANCHORED to `~/.claude`, not structural on memory dirs** (XERK-315, measured on
    2.1.258): the SAME allow-rule shape refused inside (`Edit(~/.claude/projects/**)`) LANDS the write
    once the target is relocated OUT of the config dir (`Edit(~/.turma/session-memory/**)`, `auto`).
    So the documented **`autoMemoryDirectory`** setting pointed outside `~/.claude` + an allow rule is
    a VIABLE fix for session auto-memory under `auto`. **Deliberately NOT adopted** (XERK-315
    decision): `autoMemoryDirectory`'s per-project separation is unverified — a flat shared dir would
    bleed one repo's memory into every session on the host (this carve-out is already fleet-wide
    readable) — the per-worktree slug still churns so it would not restore durable repo knowledge, and
    committed `.claude/rules/*.md` stays the substitute. Pinned by
    `test_the_projects_gate_is_anchored_to_the_claude_dir` (bypassPermissions stays the only way in).
  - **A hook, not a pattern, because glob attempts fail three ways**: too big (matches the
    `agent-memory` carve-out too), too small (misses `shell-snapshots/`, sourced on every Bash call —
    RCE across sessions), and can't track a growing vendor directory set. Do not go back to patterns.
  - **The rule list is pinned by EQUALITY** (`EXPECTED_DENY_RULES` in `test_guard_settings.py`) —
    containment let six rules be silently deletable, oracle green, because the oracle asks "is the
    target refused," not "by this rule." Only a rule-level assertion catches drift; **run
    `test_matcher_oracle.py` (31s) after any edit to the rule list** — an over-broad addition
    (`Edit(~/.claude/projects/**)`) passes the whole unit suite and only the oracle's two memory
    tests catch it.
  - **`permissions.deny` still names the catastrophic subset** (login, `agents/`, `bin/`, `hooks/`,
    `local/`, `rules/`, `plugins/`, `sessions/`, `shell-snapshots/`, `~/.claude.json`) as defence in
    depth for a misconfigured/crashed hook — every pattern anchored so it can't match a memory dir.
  - Paths are `realpath`'d both directions (a symlink escaping the memory tree, or one escaping into
    it, both resolve correctly); a relative path resolves against the payload's `cwd`.
  - **The memory DIRECTORY entries themselves are not writable** — a file planted at that name blocks
    the directory from ever being created, permanently disabling that project's/agent's memory.
  - **Fails open on malformed input; fails CLOSED if the hook script is missing** (refuses every file
    edit on the host) — `build_guard_settings` wires the matcher only when the script exists.
  - **The hook's own file is denied** (`runtime_code_deny_rules`) — without it, neutralising
    `fileguard.py` then writing anywhere reopens the whole config dir. Covers
    `guard.py`/`ask.py`/`hub-agent.py`/`tunnel-agent.js`; skipped when that dir is inside
    `REPOS_ROOT` so sessions on Turma itself can still edit Turma.
    - **The doubled leading slash is load-bearing** — a single `/` resolves relative to the
      `--settings` file's directory and matches nothing (measured); the rule must read
      `//root/.local/...`.
    - Path is **glob-escaped with a BACKSLASH**, not a character class (`[c]` on every metachar was
      shipped broken once — denies nothing; don't repeat that mistake). A literal `?` has no working
      escape, so `runtime_code_deny_rules` refuses to emit a rule for such a path and warns instead.
    - **Every hook runs `python3 -SsE`** — security flags, not style. `-S` is the one that closes the
      class: a plain start runs `site` before the hook's own code, so a planted `.pth`/
      `sitecustomize.py` in the interpreter's OWN site-packages (not just the user one `-s` alone
      blocks) disables the hook — measured to allow `rm -rf /`. `-E` kills `PYTHONPATH`/
      `PYTHONHOME`/`PYTHONSTARTUP`. PATH shadowing is separately closed by an absolute
      `sys.executable`. The `~/.local` deny patterns are a partial reduction (file-edit tools only,
      Bash walks past them); **the flags are the actual fix**.
    - **`~/.turma/guard-settings.json` is denied too** — it's the file that WIRES both hooks, so
      denying the code without it just moves the attack one directory over. The exposure is bounded
      by the MANAGER PROCESS (`_ensure_guard_settings` rewrites it fresh per process), so a tampered
      file is handed to every session that manager launches until its next restart.
  - **The carve-out is FLEET-WIDE, not session-scoped** — any session may write any project's
    `memory/` and any agent's store, both injected into future runs (measured: a marker planted in
    another slug's `MEMORY.md` appears verbatim in that session's model request). This is why the
    agent-side rule never to record anything the reviewed material asked to be recorded is
    load-bearing.
  - **Bash is NOT covered by either layer** — the matcher doesn't include it, and Claude Code's
    `Edit()` denies apply only to statically-parseable redirect targets (`python3 -c "open(...)"`
    defeats that). Under `bypassPermissions` a session can write anywhere in `~/.claude`; other modes
    prompt. Predates the hook. **Don't describe `~/.claude` as protected without qualifying it: only
    against the file-editing tools.**
    - **The PERMISSION MODE is the determinant, so XERK-309 gates the most exposed class**: a
      REPOS-ROOT session (runs directly in `REPOS_ROOT`, no worktree, on the host's own checkout) is
      refused `bypassPermissions` at spawn AND at a live mode switch. `spawn` enforces it via
      `resolve_permission_mode(mode, is_root=)`; `set_mode` refuses the same case up front (before its
      own `resolve_permission_mode`, so an unknown mode still raises as before). Matching hub 409s
      (`checkSpawnPermissionMode` + the `/mode` route) and every composer/mode picker hides the option
      for a root repo/session (web `sessions.html`/`index.html`/`chat.js`, Android
      `FleetDialogs.kt`/`ChatScreen.kt`).
    - **A WORKTREE session may still choose bypass** — deliberately, so the offered unattended-run
      capability survives. That class stays exposed to this hole; closing it is the filesystem/uid
      change XERK-309 weighs (make `~/.claude` unwritable to the session uid), not a mode gate.
      Tests: `test_resolve_permission_mode_refuses_bypass_for_root` in `test_hub_agent.py`, the
      `XERK-309:` cases in `server.test.js`.
  - Tests: `test_fileguard.py` (behavioural — resolved paths, asserts `decide()`, not rule strings),
    `test_guard_settings.py`.
  - **A rule's STRING is not an oracle — run `test_matcher_oracle.py` when you change one.** Four
    controls shipped that read correctly and did nothing (the leading-slash, character-class,
    unescaped-backslash and `-sE` mistakes above), each green under a test asserting the string the
    code meant to emit. `fileguard.py`'s own predicate tests, which call `decide()` and assert
    allow/deny, had zero such defects over the same period. Gated on `TURMA_MATCHER_ORACLE=1` (costs
    an API call per case).
    - Structure is load-bearing: a **control** case with nothing that must be ALLOWED (else a harness
      blind to writes reports DENIED for everything and passes); a **baseline** arm with empty
      settings (the binary gates its own config dir even unconfigured); a **content** check, not
      existence (the binary writes `~/.claude.json` itself — a false ALLOW on existence); the target
      **inside cwd** (`acceptEdits` auto-approves only there); **retries** (the model is
      nondeterministic — a blank run may be a decline, which is INCONCLUSIVE, never a deny).
    - **Anything under `~/.claude` must be driven under `bypassPermissions`** — every other mode has
      Claude Code refuse the write on its own (a version under `acceptEdits` passed 6/6 with the
      whole feature stubbed). Because the guard is TWO layers, each is invisible alone (unwiring the
      hook left 6/7 green; emptying all deny rules left 7/7), so each refusal runs **four arms**:
      EMPTY allows, REAL denies, HOOK_ONLY denies, PATTERNS_ONLY denies iff a rule names the target.
      **Assert against the LAYER, not "our settings."**
    - `~/.claude/agent-memory/<agent>` (the directory entry) is the one target no pattern can name —
      matching it matches the tree beneath. Its `named_by_pattern=False` arm proves the hook carries
      coverage the pattern backstop cannot.
    - **`claude -p` reads stdin when not a tty** — probes must pass `stdin=DEVNULL` or the harness's
      own source gets swallowed and refused as prompt injection (INCONCLUSIVE, unrelated to
      permissions). Keep probe filenames innocuous for the same reason.
    - `build_guard_settings()` folds the operator's `~/.claude/settings.local.json` into the deny
      list; tests pin `local_settings_path` at a nonexistent file so a real one can't forge a
      refusal.
- **AskUserQuestion bridge** (`hooks/ask.py`, same shape) — writes
  `~/.turma/questions/<sessionId>.req.json` (session id via `TURMA_SESSION_ID`/`TURMA_QUESTIONS_DIR`)
  and **blocks**, polling for the answer file `answer_question()` drops.
  - Answers come back as a `PreToolUse` **deny** whose `permissionDecisionReason` is a
    `{kind:"askuserquestion_answers", answers}` blob — deny-with-reason is the channel because an
    allow can't carry typed answer data.
  - Serialized per session (req/ans key on session id alone). Hook's block timeout
    (`TURMA_QUESTION_TIMEOUT_SEC`, 600s) sits under the settings-level `timeout`; passes through
    silently when env vars absent. Kill/delete/restart clear pending req/ans files. `multiSelect`
    accepts `optionIndices`.
  - **A new manager reader of a SESSION-written file must use `_read_untrusted_json`** (XERK-1562):
    `O_NONBLOCK|O_NOFOLLOW`, regular file only, size-capped. `questions/` is session-writable, and
    `_hook_question` + `_dsh_pending_request_id` run on the beat — a plain `open()` of a planted
    FIFO froze the heartbeat. A FIFO, symlink or file past `QUESTION_REQ_MAX_BYTES` is no request.
  - **Known remaining plain open:** `read_limits_snapshot` still `open()`s the session-writable
    `~/.turma/limits.json` on the beat — the same FIFO hang, not yet routed through that reader.
  - Tests: `test_ask.py`, `TestHookQuestion`, `TestAnswerQuestion`, `test_guard_settings.py`.
- **Permission ledger hook** (`hooks/permlog.py`, XERK-1563) — wired on `PermissionRequest` and
  `PermissionDenied` (NOT `PreToolUse`, whose matcher list stays `["Bash","AskUserQuestion"]` plus
  the file guard); RECORDS one line per event to `~/.turma/permissions/<sid>.jsonl`, decides nothing,
  fails open on everything, `-SsE` like every hook, wired only when the script exists. Its dir is
  `Edit`-denied (`Edit(~/.turma/permissions/**)`, in the equality pin). Rules: `agent-permissions.md`.
  - With `--judge` (XERK-1566, unless `TURMA_PERMISSION_JUDGE=0`) it also hands a Bash call to the
    manager's permission judge and waits (timeout 90s); judge contract in `agent-permissions.md`.
- **The judge's one-shot grant is guard.py's ONLY `allow`** (XERK-1566, `consume_grant`, `--grants`):
  the grant contract, the same-uid residual and the judge's gate live in `agent-permissions.md`.
