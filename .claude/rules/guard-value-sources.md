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
  `cat`/`tee` writes. Paths match after `normpath` only; `cd` between them, a variable path or
  `cp` are not followed.
  - Each file is read ONCE per line (`written.pop`): per run, N appends and N runs were
    quadratic and a 24 KB benign line hit the deadline (QA).
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
  own path (`./f`) — `_script_file` / `script_path`. Run with arguments it is read bound as a
  `sh -c` script is (`set --`/`shift` applied) BESIDE the unbound text, once per distinct
  argument list (`_script_file_readings`, `_MAX_SCRIPT_RUNS`). Bound alone lost the script's own
  `set --`; once per line read only the first run's arguments (QA).
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
- Not covered (XERK-1674): further write-then-run spellings (`cat -`, `cp`/`mv`, `$PWD` paths,
  `cat f | sh`, `bash -s … < f`); cross passes past the cap.
- Tests: `TestScriptChannels.test_xerk_1641_remaining_bypasses`,
  `test_a_redirection_before_the_program`.
