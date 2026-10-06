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
  XERK-1555): a printer redirected (`echo … > f`) or a heredoc `cat`/`tee` writes. Paths match
  after `normpath` only; `cd` between them, a variable path or `cp` are not followed.
- **A program word that is not literal may be a shell on the `-c` and pipe paths too**
  (XERK-1632, `_owner_word_may_be_shell`). Gated on `_NONLITERAL_RE`/defined names before the
  call: asking every stage of every pipeline doubled the walk.
  - A `-c` script naming its reader through its own variables (`sh -c 'x=bash; $x'`) is asked
    per stage whose program word is non-literal (`_NONLITERAL_PROG_RE`), never every stage.
  - `hash -p`, `BASH_ALIASES`, `BASH_CMDS`, `command_not_found_handle` anywhere make EVERY name a
    possible shell (`_ANY_NAME`); `_defined_names` also reads quote-joined text (`eval "ali""as"`).
- `bash -c -e '<cmd>'`: options between `-c` and the script are skipped (`_shell_c_script_index`).
- Not covered: a `for` list's words given per-value passes (XERK-1647), cross passes past the cap.
- Tests: `TestScriptChannels.test_xerk_1641_remaining_bypasses`,
  `test_a_redirection_before_the_program`.
