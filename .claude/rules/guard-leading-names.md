---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: an unknown name at the START of a target (XERK-1639)

- bash reads an unset leading name as empty: `rm -rf "$x"/etc` deletes /etc, `"$dir"/*` is `/*`.
- `_dangerous_target` adds that reading for `rm` and recursive `chmod`/`chown`, judged by
  `_is_dangerous_path` like any target, so `"$build"/out` → `/out` (a plain root child) stays
  allowed. Owner decision: deny only when the empty reading leaves a protected path.
- By the time a target reaches it, every name the line assigns or defaults (`x=…;`,
  `${x:-…}`) is already substituted; what still starts with `$` is unknown. Don't read an
  assigned name empty — that denied ordinary `d=$(mktemp -d); rm -rf "$d"/*`.
- `$HOME`/`$PWD` are never read empty (always set); a name not directly before `/` is left
  alone (`"$x"*`, `"$d".bak` stay relative).
- Match the names on the token BEFORE `_norm_path`: normpath folds `"$x"/../etc` to `etc`
  and hid the bypass; the remainder is normalised by `_is_dangerous_path` itself.
- A `${…}` with an operator is empty too (`"${dir%/}"/*`, `${x:+$x}`); only a length
  (`${#x}`) or a non-empty default/error (`${x:-a}`, `${x:?}`) is never empty.
- A `${…}` is closed with `_brace_end`, never a `[^{}]*` regex: that missed `${x:-${y}}`
  and backtracked quadratically on an unclosed `${aaaa…` (45s hook deadline).
- Positionals (`$0`-`$9`, `$@`, `$*`) are left out: bound in `bash -c '…' _ /tmp/x`,
  `find -exec sh -c` and functions, where reading them empty denied the common idiom.
- Only the LEADING run is read empty. `"$a/$b"/*` (→ `//*`) is open: reading later
  components empty would deny the everyday `rm -rf "$dir/$f"` (decision pending, XERK-1652).
- Cost, measured: 0 new denies over a 35.7k-command real corpus replay vs main.
- Tests: `test_an_unset_name_leading_a_target_is_read_empty`,
  `test_leading_names_are_one_run_and_scan_linearly`.
