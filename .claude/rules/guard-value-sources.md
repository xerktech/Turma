---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: redirects in a command, value sources, files run as scripts (XERK-1641)

- **A redirect's `&`/`|` is read split AND joined** (`_split_on_operators`, XERK-1631): bash takes
  a redirect anywhere among a command's words, so `rm -rf 2>&1 /` and `rm -rf &>/dev/null /etc`
  run rm. The joined simple command is one more segment; pieces are slices of `buf` (linear).
  - A LIVE `>&N`/`>&-` (`_FD_DUP_RE`) is never cut: split, it only names a program `2`, and a
    third reading of every `2>&1` tripled real decisions (replayed). An escaped `\>&` still is.
  - The stage walk (`keep_redirects`) never joins: joined, `echo … \>&1 | sh` fed sh.
  - Every path-like word feeds `xargs` once (`piped_operands` de-duped): the extra readings
    repeated them until a benign `xargs kill` line hit the value cap ("too large").
- **A live `<`/`>` glued to a word ends it** (XERK-1754, `_unglue_redirects` in the tokenizer):
  shlex kept `rm -rf /etc>/dev/null` one word `/etc>/dev/null`, which named no protected root.
  - Left glued: an fd word (`2>`, `{fd}>`; `/etc2>` is the word `/etc2`), `<(`/`>(`, quoted or
    escaped text, and anything inside a CLOSED `$(…)`/`${…}`/`(…)`/backtick (read with its body).
  - A frame that never closes does not hide its redirections (`_redirect_ops`): `${y:-(}`
    spliced reads `(`, and skipping it hid `rm -rf /etc>/dev/null` after it (QA).
  - A segment with a redirection BEFORE another word is ALSO read with them moved after its
    words (`_redirects_last`): every option walker took one as an argument
    (`bash -c>/dev/null '…' 2>&1`, `bash -c 2>f '…'`, `env -u >f X cmd`, `eval>f -- '…'`).
    - Moved, never cut: cut, `bash -o 2>x errexit <<< '…'` lost its stdin feed (QA).
    - Added, never swapped. Already-trailing redirections add no copy: a copy of every
      `cmd 2>&1` doubled real cost (replay). Gate on ALL words after the first move, never
      on the tail alone: that let any trailing `2>&1` switch the reading off (QA).
    - `pr_summary_reason` skips `_note_paths` for a segment whose moved reading is the PR
      command: noted, its own `-F f` was "another part naming f" (QA).
    - A reader's options (`_reader_opts`) drop redirection words first: `read -d 2>x , v`.
  - `_stray_group_fragments` strips its tail by a backward walk: the regex was quadratic in an
      inner blank run, which these copies made.
  - In the tokenizer, not per target rule: every `_tokenize` consumer gets bash's words.
  - `_script_file_readings` reads each written text once: `>f>f…` wrote 20k copies of one text.
  - Tests: `test_a_redirection_glued_to_a_target_ends_it`.
- **Values a line sets, beyond `name=value`** (`_assigned_values`, XERK-1634):
  - an array's elements, each a value of its own (`"${a[1]}"`), up to `_MAX_VALUE_READINGS`/2;
  - `${x:=w}`/`${x=w}` as an ADDED whole-line reading with `x=w` written first
    (`_default_assignments`). Folded into the values it shadowed the default at the `${…}` itself
    (`echo ${GIT_EDITOR:='$(reboot)'}`) and the name's own value (`a=${a=x}"rm …"`);
  - `${x:+alt}` read as `alt` on the assignment, `for` and `read <<<` routes (`_default_readings`):
    with no value `_substitute_vars` never takes that branch, and `$PATH` is always set;
  - `${!a}` resolved through a's value (`_INDIRECT_RE` in `_substitute_vars`);
  - a substitution body's own assignments (`$(x=…; echo "$x")`) in `_body_printed`, whose memo
    key now carries `_VALUE_PICK`.
- **Two reassigned names are read against each other** (`_expand_picks` cross passes): same-index
  passes paired `p=true…c=rm` and never read `bash` with `rm`. Only when a multi-valued name is
  used in program position or eval'd (`_PROGRAM_USE`) and the product ≤ `_MAX_CROSS_PASSES`;
  each pass is a whole-line expansion and 23 of them timed real lines out (replayed).
- **Text written to a file a later `sh f`/`. f`/`source f` runs is a script** (`_written_scripts`,
  XERK-1555): a printer redirected (`echo … > f`), a `tee f` fed by a printer, or a heredoc
  `cat`/`tee` writes. An exact run is matched after `normpath`.
  - Each file is read ONCE per line (`written.pop`): per run, N appends and N runs were
    quadratic and a 24 KB benign line hit the deadline (QA).
  - A write inside a group or compound (`{ echo … > f; }`, `if …; then …; fi`, a loop body) is
    found too (XERK-1657): `_written_scripts` recurses into `_group_core`, `_MAX_WRITE_NEST` deep.
- **A run the guard cannot pin to a written path FAILS CLOSED** (XERK-1674, operator default):
  on a line that writes text, any such run reads EVERY written file not already read.
  - Patching spellings (XERK-1641) kept leaving neighbours: copies, `$PWD`/`$(pwd)` paths,
    `cat f | sh`, `sh -c 'sh < f'`, `xargs`, `find -exec`, `PATH=.`. Don't go back to a list.
  - A run's path matches a written one by BASENAME too (`$S/x.sh` written, run with `$S`
    spliced; `"$PWD"/f`; after a `cd`), then it is an exact run, bound to its own args.
  - Fails closed on: a shell/`.`/`source` given a file that is not written; a path run that
    is not written when the line also copies (`_COPIES_RE`: cp/mv/ln/install/rsync/dd/tar,
    `cat f > g`) or names a glob; `_RUNS_UNNAMED_RE` at a COMMAND START (a shell reading stdin,
    `.`/`source`, `eval`, `xargs`, `hash`) or `-exec`/`PATH=` anywhere; a `-c` script, `eval`, `trap`
    action or function body when a written file's basename appears twice (`bash -c ./f`,
    `f(){ sh x; }; f`, `trap 'sh f' EXIT`).
  - Accepted over-deny (10 of 40k replayed): a note whose line STARTS with a destructive
    command, named again beside a function/eval/trap (`f(){ git add n.md; }`).
  - Never match those words anywhere: `git add .`, "bash" in a note, `~/.claude/bin/jira -F
    notes.md` beside a written note denied 87 real commands (QA corpus replay).
  - Writers are read broadly too: any non-shell stage fed text or a here-string writes it
    (`| cat - > f`, `| tr … > f`, `cat > f <<< …`), `dd of=`, `cp|install /dev/stdin f`, and a
    write inside a `-c` script or `eval`. A transform (`base64`) is read as its input: accepted.
  - On a line that sources (`.`/`source`), a no-argument reading also binds every parameter
    to the line's first `_MAX_LINE_WORDS` path-like words: a sourced file inherits `set --`/a
    function's `$@`. On every line it multiplied real scripts' cost (QA).
  - Accepted over-deny: `echo 'rm -rf /etc' > notes; bash b.sh`. Accepted cost: a big heredoc
    written beside an unrelated `source venv/bin/activate` is read as shell (250 Python
    functions ~2 s), and a heredoc script run as `$S/x.sh` is now read as main reads an exact
    run (main missed the spelling): ~2-3x the script typed alone, the deadline fails closed.
- **A coproc shell reads EVERY text the line prints** (XERK-1717): its stdin fd may be written
  by any route (`>&${COPROC[1]}`, `>&"${S[1]}"`, `exec 5>&${S[1]}`, `fd=${S[1]}; >&$fd`,
  `/dev/fd/N`, `/proc/self/fd/N`), so it fails closed like an unpinned file run.
  - Gate: a walked stage holding `coproc` that `_stage_reads` (the stdin-walk's reader test);
    fed: `_stage_emits` of every walked stage. Any `coproc` text turns `feeds_a_shell` on.
    Never pair writers by fd spelling: each spelling is a neighbour.
  - Accepted over-deny: a shell coproc beside an echo of a destructive command sent elsewhere,
    and a writer in a pipeline stage (bash closes coproc fds in a pipeline's subshells).
  - `_printed_from_tokens` reads `yes WORDS` as printing WORDS (`y` with none, a leading `--`
    dropped as GNU yes does), so every printed-text route sees it, not only the pipe walk.
    `yes ''` prints EMPTY lines (`" ".join(args) if args else "y"`, never `or "y"`).
  - A substitution whose producers all print NOTHING is read as empty by the line-level taint
    (`_body_tainted` → `("",)`, `_taint_line_repl` takes it): `$(echo '' | head -1) rm …` and
    `$(echo '' | sed 1q) rm …` run `rm`; skipping a falsy print hid it (on main too).
  - 0 changed decisions over 4,729 real Bash commands holding `$(`, a backtick, `yes` or `coproc`.
  - Tests: `test_a_coproc_shell_runs_what_the_line_writes_to_its_fd`.
- An alias use runs its VALUE with the use's words after it: `alias b='bash -c'; b '<cmd>'`,
  through a chain, an `eval "b …"`, or a pipe (`echo /etc | b`). `_aliased_readings` is an
  ADDED whole-line reading with every use replaced, `_ALIASES_ON` off inside.
  - `_ALIAS_USE_RE` matches the name as a WHOLE WORD anywhere, not a list of command positions:
    each list missed one (`if b`, `! b`, `coproc b`, `x=1 b`, a value ending in a blank). An
    argument replaced too only adds a reading. The growth is charged (`_spend`).
  - At most two: each name's FIRST and LAST value. One reading per use, then per value, was
    (definitions × uses) and a 3000-use line false-denied (QA). Off inside so `alias ls='ls
    -l'` is not re-replaced per level until "too deep". Accepted: a 2000-char alias used 500
    times is refused as too large.
- An array element written with its index (`([1]=w)`, `([k]=w)`, `+=`) is the element `w`,
  one element too.
- A `tee f` stage writes a here-string (`tee f <<< …`) or what it is fed; a `{ …; }`/`( … )`
  group writes ALL its statements' text (`_statements_printed`, never its first-word reading:
  `_strip_prefixes` drops the `{`); a lone `cat`/pass-through relays what it is fed.
- A file is run by a shell operand, `.`/`source`, a shell's stdin redirect (`bash < f`) or its
  own path (`./f`) — `_script_file` / `script_path`. Every run is RECORDED in the segment loop
  and the file read once after it (`_script_file_readings`), all runs known:
  - a run with arguments is read bound as a `sh -c` script is (`set --`/`shift` applied), per
    distinct list; bound alone without `_positional_readings` lost the script's own `set --` (QA);
  - unbound only for a run with none: both doubled a real script's cost toward "too large";
  - past `_MAX_SCRIPT_RUNS` lists, ONE reading binds every parameter to every argument of every
    run, a word each, beside the unbound text and its `set --` readings (alone it lost a default,
    the script's `set --` and a glued `/$1`, QA). Read as runs arrived, the 10th was dropped.
  - ...and a script gluing two parameters (`"$1/$2"`, `_GLUED_PARAMS_RE`) is read once per
    (parameter, argument) with the others empty, charged: `sh x.sh "" etc` is `/etc` (XERK-1674).
  - Its contents are judged like any command: a written script doing `rm -rf /var/tmp/x` is
    refused as that command typed directly is (1 replayed diff, explained).
- `_alias_values` takes only `alias NAME=…` with a name bash accepts (`_ALIAS_NAME_RE`):
  `alias={…}` in a heredoc's Python made an empty name that matched every word (replayed).
- **A program word that is not literal may be a shell on the `-c` and pipe paths too**
  (XERK-1632, `_owner_word_may_be_shell`). Gated on `_NONLITERAL_RE`/defined names before the
  call: asking every stage of every pipeline doubled the walk.
  - A `-c` script naming its reader through its own variables (`sh -c 'x=bash; $x'`) is asked
    per stage whose program word is non-literal (`_NONLITERAL_PROG_RE`), never every stage.
  - `hash -p`, `BASH_ALIASES`, `BASH_CMDS`, `command_not_found_handle` anywhere make EVERY name a
    possible shell (`_ANY_NAME`); `_defined_names` also reads quote-joined text (`eval "ali""as"`).
- `bash -c -e '<cmd>'`: options between `-c` and the script are skipped (`_shell_c_script_index`).
- Not covered: cross passes past the cap.
- Tests: `TestScriptChannels.test_xerk_1641_remaining_bypasses`,
  `test_xerk_1674_write_then_run_fails_closed`,
  `test_a_redirection_before_the_program`.
