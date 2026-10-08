---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: targets built from the home (XERK-1656)

- `_dangerous_target` adds a reading of each target with `~`, `~user`, `$HOME` and
  `${HOME<op>}` expanded against the session's REAL home (`_home_readings`).
  - As tokens, `$HOME/..` normpaths to `.` and `${HOME/root/etc}` hides the name, so
    `chmod -R 777 $HOME/..` (= `/`) and `rm -rf "${HOME/root/}"*` (= `/*`) were allowed.
- A reading that stays inside a home is put back as `$HOME…` / `~user…` before it is judged
  (`$HOME`, not `~`: bash expands no tilde in `~*`, so `$HOME*/build` must stay `$HOME*`).
  - Never judge it as the absolute path: `/root/.cache` is a child of the /root system
    root, so every `$HOME/...` cleanup would deny.
- Ops are evaluated by the guard's own `_apply_var_op` / `_replace_op`; an unset name in an
  op's word reads empty (`${HOME/root/$y}` is `/`). An element or quoting transform (`@Q`) → no reading.
- `${HOME:-w}` is spliced as `w` AND, in a second `_expand_readings` pass (`_HOME_KEPT`, only
  for lines with a `${HOME:-`/`:=` default), kept as written for `_home_readings`.
  - Never one instead of the other: as `w` only, `"${HOME:-/tmp}"/*` hid the home wipe; as
    written only, `local HOME`, `read HOME </dev/null` and `exec -c` unset HOME and ran `w`.
  - Never gate it on the line's text (`unset`/`env`): any `echo env` turned it off, and a
    per-use regex over the whole line was quadratic (45s on 87 KB).
  - A new reading flag joins `_memo`'s key and `_reading()`, or the memo replays the old pass.
  - The pass doubles the line's cost, so it runs only when the first pass found a command
    whose target it can change (`_HOME_TARGET_PROGS`); a default in heredoc data doubled a
    4.7 KB command past the deadline (QA). A line holding both a target command and a
    default still pays twice; it fails closed (rollup, XERK-1584).
- An op sees HOME as written (`${HOME%root/}etc` is /etc when HOME=/root/); only the
  map-back normalises it.
- Only person homes map back (session HOME, /root, /home/*, /Users/*): `~bin/x` is /bin/x.
  With HOME=/ nothing maps back. `cd ~/..` is read through the same reading.
- The reading depends on `$HOME`: tests pin it with `mock.patch.dict(os.environ, ...)`.
- Cost, measured at the final commit: 0 changed decisions over a 35k-command real corpus
  replay vs main; 200 targets of 64 HOME ops decide as fast as main.
- Cost bound: past `_MAX_HOME_OPS` operators on HOME in one target, the reading is `/`.
- `~` and `$PWD` follow the LINE, not the session (XERK-1685): `HOME=/; rm -rf ~/etc` is //etc.
  - `_home_tilde_reading` adds a reading with every word-start `~` (and a bare `cd`) as `$HOME`
    when the raw text holds `HOM`, `OME` or `eval` (`HOM{E,}`, `H\OME`, `x=OME; …H$x`).
    `~+` always reads as `$PWD`.
  - `~-` reads as `$OLDPWD`, and a `dirs` entry (`~1`, `~+1`, `~-1`) as `$PWD` (XERK-1696);
    `_under_cwd` reads `$OLDPWD` as `$PWD`: any directory the line visited, unordered.
  - `_PWD_LEAD_RE` also takes `${PWD:?}`/`${PWD?}` and an unspliced directory tilde, which
    `eval rm '~-'` / `\~-` reach a target as (the splice's lookbehind skips quotes).
    `${PWD:-x}` never reaches it: the default is spliced upstream (XERK-1755).
  - Unknown names glued after that lead read empty in `_under_cwd` (`$PWD$x`, eval'd `'~-'$x`);
    any other glued tail (`$1`, `${x#a}`) is joined to the directory as bash joins it.
  - Accepted over-read: a literal `~-` word (`t='~-'; rm -rf $t`) reads as `$OLDPWD`, so after a
    `cd /` it is refused; bash would remove a file named `~-`.
  - A quote may end the tilde word (`bash -c 'cd /etc; rm -rf ~+'`): `~'/x'` is literal in
    bash, so that splice over-reads, which only adds a reading.
  - A `~` opening a `${y:-…}`/`-`/`:+`/`:=`/`:?` word (`_PARAM_TILDE_RE`) or a `${y/pat/…}`
    replacement (`_replacement_tildes`) is spliced too, read both braced (`${HOME}`: an
    unbraced name ending a default word is unresolved, XERK-1670) and bare. Never add `-`/`+`
    to the word-start lookbehind: it would splice `a-~/x`.
  - The replacement is found by a one-pass right-to-left scan, never a regex: a pattern may
    hold `\x`, quotes, `$'…'` and nested `${…}` (a bare `{` is a character), and every regex
    for it was exponential, then quadratic. One `re.search` holds the GIL past the hook's 45s
    deadline, so the 600s hook timeout fires and the command RUNS. Keep it linear (timing test).
  - `pr_summary_reason` reads `_expand_both(command, home=False)`: the reading repeats the line,
    and a heredoc writer read twice was "another part naming the description file".
  - A textual gate, never the line's values: those miss a `bash -c` script's own `HOME=`,
    `HOME[0]=`, `read HOME`; each inner level's values pass resolves the spliced `$HOME`.
  - `$HOME`, never `${HOME}` or `${HOME:-~}`: braced, it is not resolved inside `{a,b}`, and a
    default is applied at the OUTER level, before a `bash -c` script's own HOME is known.
  - Every `~` is spliced, a program's too. Any "command position" test by the text before it
    reopened the bypass (`rm -rf do ~/etc`, `rm -rf \; ~/etc`, `a=(~/etc)`): that needs a parse.
  - A spliced program stays literal: `_owner_word_may_be_shell` reads an unassigned
    `$HOME/…` as `~/…` (HOME is always set; a bare `$HOME` program stays unresolved), so
    `~/.claude/bin/jira … <<'EOF'` notes stay data. Every gate-side workaround (command-position skip, dropping data bodies from the
    gate) reopened a bypass; fix false denies at the owner test, never by narrowing the splice.
  - Added, never swapped: the `~` reading is what catches `rm -rf ~` itself.
  - `_under_cwd` reads `$PWD` as a relative operand is (exact root or `..` only).
  - Known false deny: `HOME=/ rm -rf ~/etc` (a prefix binding; bash expands `~` first),
    as `$HOME` already is there.
  - Tests: `test_tilde_and_pwd_follow_the_line_s_own_home_and_cd`,
    `test_directory_tildes_read_as_the_directories_the_line_visited`.
- An unassigned `${HOME<op>}` (not a `:-`/`:=` default) is spliced in the values pass as its
  `_home_readings` (XERK-1686): kept as written, `${HOME:+r}m -rf /`, `${HOME/*/rm} -rf /` and
  `rm ${HOME:+-rf} /` hid the program or flag.
  - Through `_home_readings`, so a value inside the home comes back as `$HOME…` and target rules
    still judge it as the home (`rm -rf ${HOME:+$HOME/.cache}` stays allowed).
  - The unset-HOME reading is the unset-names one every name gets; no extra pass.
  - An op it cannot read (`[i]`, `@Q`) stays as written. 0 diffs over 126 real `${HOME` commands.
  - Tests: `test_a_program_or_flag_built_from_home_is_read_with_the_real_home`.
- Tests: `test_a_target_built_from_home_is_read_with_the_real_home`,
  `test_home_readings_are_bounded`.
