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
  - `busybox <applet> …` is also read as the applet alone, an ADDED reading in `_expand`
    (busybox `rm` gets `--no-preserve-root`). Never make busybox a `_PREFIX_WORDS` strip:
    busybox itself must stay a shell to the `-c` readings (`busybox script -qc '…'`) (QA).
  - One reading, both ends: per-end readings let `"$x/etc$y"` through each one.
  - Scan per NAME, never per run: a run restarted after a blocking `${x:-a}` rescans.
- That reading is judged with `trailing=False`: XERK-1623's trailing-name reading on top
  would read `"$TMP/$x"` as `/`.
- Cost, measured: 0 new denies over a 36.7k-command real corpus replay vs main (XERK-1652).
- Tests: `test_an_unset_name_leading_a_target_is_read_empty`,
  `test_a_last_component_of_names_is_read_empty_without_preserve_root`,
  `test_every_unset_name_component_is_read_empty`,
  `test_leading_names_are_one_run_and_scan_linearly`.
