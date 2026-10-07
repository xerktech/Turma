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
  op's word reads empty (`${HOME/root/$y}` is `/`). An element or quoting transform (`@Q`) → no reading.
- `${HOME:-w}` is spliced as `w` AND, in a second `_expand_readings` pass (`_HOME_KEPT`, only
  for lines with a `${HOME:-`/`:=` default), kept as written for `_home_reading`.
  - Never one instead of the other: as `w` only, `"${HOME:-/tmp}"/*` hid the home wipe; as
    written only, `local HOME`, `read HOME </dev/null` and `exec -c` unset HOME and ran `w`.
  - Never gate it on the line's text (`unset`/`env`): any `echo env` turned it off, and a
    per-use regex over the whole line was quadratic (45s on 87 KB).
  - A new reading flag joins `_memo`'s key and `_reading()`, or the memo replays the old pass.
- An op sees HOME as written (`${HOME%root/}etc` is /etc when HOME=/root/); only the
  map-back normalises it.
- Only person homes map back (session HOME, /root, /home/*, /Users/*): `~bin/x` is /bin/x.
  With HOME=/ nothing maps back. `cd ~/..` is read through the same reading.
- The reading depends on `$HOME`: tests pin it with `mock.patch.dict(os.environ, ...)`.
- Cost, measured: 0 changed decisions over a 34.8k-command real corpus replay vs main;
  decide time on 200 targets of 64 HOME ops matches main.
- Cost bound: past `_MAX_HOME_OPS` operators on HOME in one target, the reading is `/`.
- Open: an unquoted `${x: -5}` is split at its space before any of this (XERK-1680).
- Tests: `test_a_target_built_from_home_is_read_with_the_real_home`,
  `test_home_readings_are_bounded`.
