---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: unknown names in a target read empty (XERK-1639, XERK-1652)

- bash reads an unset leading name as empty: `rm -rf "$x"/etc` deletes /etc, `"$dir"/*` is `/*`.
- `_dangerous_target` adds that reading for `rm` and recursive `chmod`/`chown`, judged by
  `_is_dangerous_path` like any target, so `"$build"/out` → `/out` (a plain root child) stays
  allowed. Owner decision: deny only when the empty reading leaves a protected path.
- By the time a target reaches it, every name the line assigns or defaults (`x=…;`,
  `${x:-…}`) is already substituted; what still starts with `$` is unknown. Don't read an
  assigned name empty — that denied ordinary `d=$(mktemp -d); rm -rf "$d"/*`.
- `$HOME`/`$PWD` are never read empty (always set) unless an operator can empty them
  (`${HOME:+}`, `${HOME#/root}`, `${HOME[1]}`): `_empties_a_set_path` WHITELISTS the safe
  operators — a pattern blacklist missed literal patterns equal to HOME; a name not directly before `/` is left
  alone (`"$x"*`, `"$d".bak` stay relative).
- `${HOME@a}` is HOME's attributes, empty once HOME is not exported (`export -n HOME`), so it is
  the one `@` transform `_empties_a_set_path` reads as empty.
- A last component globbing `..` (`/.*`, `/etc/.?`) is judged on its parent for every walker but
  GNU rm (`keep_last=False`): bash before 5.2 globs `/..`, and only rm refuses `..`.
  Accepted over-deny: `chmod -R 700 ~/.ssh/.*` (it is `chmod -R 700 ~` there).
- Match the names on the token BEFORE `_norm_path`: normpath folds `"$x"/../etc` to `etc`
  and hid the bypass; the remainder is normalised by `_is_dangerous_path` itself.
- A `${…}` with an operator is empty too (`"${dir%/}"/*`, `${x:+$x}`); only a length
  (`${#x}`) or a non-empty default/error (`${x:-a}`, `${x:?}`) is never empty.
- A `${…}` is closed with `_brace_end(raw, pos, False)`, never a `[^{}]*` regex: that missed `${x:-${y}}`
  and backtracked quadratically on an unclosed `${aaaa…` (45s hook deadline).
  - Pass `quoted=False` (the token is dequoted): looking quotes up rescans the word per `${`,
    quadratic in a run of names.
- Positionals (`$0`-`$9`, `$@`, `$*`) are left out: bound in `bash -c '…' _ /tmp/x`,
  `find -exec sh -c` and functions, where reading them empty denied the common idiom.
- Later names are read empty in the SAME reading (`_unset_names_dropped`, XERK-1652):
  - every name in a component before the last, glued or not: `/$x/etc`, `"$a/$b"/*` → `//*`,
    `"$x/usr$y/lib"` → `/usr/lib`, `"$x/.${y}/etc"` → `/./etc`.
  - in the last component, only a trailing run glued to text: `$x/etc$y` → `/etc`.
  - Kept: the rest of the last component. Reading it empty denied the everyday
    `"$dir/$f"`, `"$TMP/$x"` (→ `/`) and `"$dir/$name.$ext"` (→ `/.`); so `$x/$y` stays allowed.
  - That kept rest is for GNU `rm` only, whose preserve-root refuses `/` (XERK-1687). Every
    other tree-walker reads it empty too (`keep_last=False`): `chmod`/`chown`/`chgrp -R`,
    `rm --no-preserve-root`, `busybox rm` (no preserve-root), `find -delete` (emitted as
    `rm -r --no-preserve-root`), and a `find -exec`'s `{}` (each root's empty reading is
    added to the roots, since find walks `/` child by child).
  - Same for a `find` feeding `xargs`: its roots' empty readings join `piped_operands`.
  - `busybox` is a `_PREFIX_WORDS` wrapper (its `rm` gets `--no-preserve-root`): every
    pipe/stdin/xargs reader sees the applet. Its shells `hush`/`msh` are in `_SHELL_PROGS`.
  - The strip lost busybox ITSELF as a `-c` shell (`busybox script -qc '…'`), so `_expand`
    adds a reading of the words from `busybox` on with it as `sh`. Keep both: an applet-only
    added reading (no strip) lost the pipe readers; the strip alone lost `-c` (3 QA passes).
  - Any name STARTING with `busybox` or `toybox` is read as `busybox` (`_basename`,
    `_MULTICALL_PREFIXES`): both binaries dispatch on that prefix, and the shipped files are
    `toybox-x86_64`, `busybox.static`. Exact names only let `toybox-x86_64 rm -rf /etc` run.
    - `_CMD_START` takes one as a wrapper word, so `cat a.sh | busybox sh` is a stdin shell
      for the write-then-run rule (was allowed on main). Rollup XERK-1701.
    - `_MULTICALL_WORD` is anchored by a lookbehind: unanchored, every `-busybox` in one long
      word started a match, quadratic (1 MB: 945s, past the hook timeout, which runs it).
      Test: `test_multicall_names_scan_linearly`.
    - `_CMD_START`'s keyword/wrapper words start only at a word start (after a blank or a start
      character), as in bash: read with `\b`, `A=env`/`A=:env`/`A=-busybox` values each started a
      match that ran the assignment loop to the end (quadratic, past the hook timeout, on main
      too). 0 diffs over 2182 real commands with such a glued word. Start characters INSIDE a
      value (`A=; `, `A='env' `) are still quadratic: XERK-1866.
  - One reading, both ends: per-end readings let `"$x/etc$y"` through each one.
  - Scan per NAME, never per run: a run restarted after a blocking `${x:-a}` rescans.
- That reading is judged with `trailing=False`: XERK-1623's trailing-name reading on top
  would read `"$TMP/$x"` as `/`.
- Cost, measured: 0 new denies over a 36.7k-command real corpus replay vs main (XERK-1652).
- Tests: `test_an_unset_name_leading_a_target_is_read_empty`,
  `test_a_last_component_of_names_is_read_empty_without_preserve_root`,
  `test_every_unset_name_component_is_read_empty`,
  `test_leading_names_are_one_run_and_scan_linearly`.
