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
- Cost, measured: 0 new denies over a 35.7k-command real corpus replay vs main.
- Tests: `test_an_unset_name_leading_a_target_is_read_empty`.
