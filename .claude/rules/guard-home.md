---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: targets built from the home (XERK-1656)

- `_dangerous_target` adds a reading of each target with `~`, `~user`, `$HOME` and
  `${HOME<op>}` expanded against the session's REAL home (`_home_reading`).
  - As tokens, `$HOME/..` normpaths to `.` and `${HOME/root/etc}` hides the name, so
    `chmod -R 777 $HOME/..` (= `/`) and `rm -rf "${HOME/root/}"*` (= `/*`) were allowed.
- A reading that stays inside a home is put back as `$HOME…` / `~user…` before it is judged
  (`$HOME`, not `~`: bash expands no tilde in `~*`, so `$HOME*/build` must stay `$HOME*`).
  - Never judge it as the absolute path: `/root/.cache` is a child of the /root system
    root, so every `$HOME/...` cleanup would deny.
- Ops are evaluated by the guard's own `_apply_var_op` / `_replace_op`; an unset name in an
  op's word reads empty (`${HOME/root/$y}` is `/`). An element or transform → no reading.
- `${HOME:-w}` / `${HOME:=w}` are NOT spliced as `w`: HOME is always set, so `w` hid
  `"${HOME:-/tmp}"/*`. A line that can unset HOME (`_HOME_UNSET_RE`: `unset`, `env`,
  `HOME=`) still gets the default, since `env -i bash -c 'rm -rf ${HOME:-/etc}'` uses it.
- The reading depends on `$HOME`: tests pin it with `mock.patch.dict(os.environ, ...)`.
- Cost bound: past `_MAX_HOME_OPS` operators on HOME in one target, the reading is `/`.
- Open: an unquoted `${x: -5}` is split at its space before any of this (XERK-1680).
- Tests: `test_a_target_built_from_home_is_read_with_the_real_home`,
  `test_home_readings_are_bounded`.
