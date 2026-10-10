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
- A case op on HOME with a pattern, or `~`/`~~`, reads as HOME (`_HOME_CASE_OP_RE`, XERK-1759):
  a pattern matching nothing (`${HOME,x}`) leaves HOME whole; any other result is the home on a
  case-blind disk and no path on a normal one. Never add the mapped form beside it: an
  upper-cased home is not mapped back, so `${HOME^^x}/proj` would over-deny.
  - Unpatterned `^^ ,, ^ ,` keep `_CASE_OPS`'s mapped reading (`${HOME^^}/proj` over-denies).
  - Tests: `test_a_case_op_with_a_pattern_on_home_is_the_home`.
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
  - A line that assigns PWD/OLDPWD AND moves (`cd`/`pushd`/`popd`) is also read with both
    unassigned (`_PWD_UNASSIGNED`, XERK-1753): `cd` rewrites them, so spliced,
    `PWD=/x; cd /etc; rm -rf $PWD` read `/x`. Added, never swapped: `cd -` reads OLDPWD's value.
    - Gated on a move (`_MOVES_RE`) AND a values pass of this decision having bound either name
      (`_PWD_SEEN`), however spelled (`$'P\x57D'`, `P{W,}D`, `eval "${x}D=…"`). Never a text
      gate: each pattern missed the next spelling, and a broad one cost +53% CPU (QA, 3 passes).
    - Each `for` word's pass is read unassigned too: a loop's `cd $d` reaches its words only there.
    - Accepted over-read (visited dirs are unordered): `cd /etc; PWD=/tmp/x; rm -rf $PWD`.
  - `_PWD_LEAD_RE` also takes `${PWD:?}`/`${PWD?}` and an unspliced directory tilde, which
    `eval rm '~-'` / `\~-` reach a target as (the splice's lookbehind skips quotes).
    `${PWD:-x}` never reaches it as written: the values pass splices the default.
  - Other spellings of a visited directory are an ADDED reading (`_dir_readings`, XERK-1755):
    - `${PWD<op>w}`/`${OLDPWD<op>w}` default → the name, `:+`/`+` → `w` rewritten again (both are
      always set); a trim/replace/offset/case op is applied to each directory the line `cd`s to,
      one reading each (`_cd_targets`); `@Q` and an op word holding `$` stay as written.
    - A `DIRSTACK` element, `$DIRSTACK`, and a `$(…)`/backtick/`<(…)` running `dirs`/`pwd`
      (quoted, escaped, behind `builtin`/`command`/`eval`, or a `$d` the line sets) → `$PWD`.
    - zsh: `~e` of a name the line assigns (`hash -d e=/` counts) or PWD/OLDPWD → `${e}`
      (bash leaves it literal: over-read).
    - Gated like the kept default: a spelling in the text AND a `_HOME_TARGET_PROGS` command.
    - Skip an unclosed `${`, and keep the `dirs`/`pwd` argument run bounded: an unclosed opener
      read to the line's end re-copied the line per opener (4 KB → 31s, QA).
    - Past `_MAX_DIR_NEST` nested `${PWD:+…}` words the line is too large: each level is a
      `_brace_end` over the rest (quadratic, then a RecursionError), and leaving the rest to the
      re-read reading only peels it a level per pass (QA).
    - Open (XERK-1774): an always-set name's `:+` word in program position, `di''rs`/`d\irs`,
      `$(/bin/pwd)`/`$(env pwd)`/`$("$p")`, a `dirs`/`pwd` run padded past the bound or holding
      `(`, zsh's `$dirstack`/`$PWD:h`/`${(L)PWD}`/glob qualifiers, the session's own starting cwd.
  - Any tail glued after that lead (`$x`, `$1`, `${x#a}`, `*`) is joined to the directory as bash
    joins it, then judged (`cd /; rm -rf $PWD*` is `/*`); a tilde lead takes only `/` or `$`.
  - Accepted over-read: a function body's unbound reading reads `$1` empty, so after `cd /`,
    `f(){ rm -rf $PWD$1; }; f /build` is refused, as `f(){ rm -rf /$1; }` already was.
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
  - `$HOME`, never `${HOME:-~}`: a default is applied at the OUTER level, before a `bash -c`
    script's own HOME is known.
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
    `test_directory_tildes_read_as_the_directories_the_line_visited`,
    `test_a_cd_overrides_the_line_s_own_pwd_assignment`,
    `test_other_spellings_of_a_visited_directory_are_read`.
- An unassigned `${HOME<op>}` (not a `:-`/`:=` default) is spliced in the values pass as its
  `_home_readings` (XERK-1686): kept as written, `${HOME:+r}m -rf /`, `${HOME/*/rm} -rf /` and
  `rm ${HOME:+-rf} /` hid the program or flag.
  - Through `_home_readings`, so a value inside the home comes back as `$HOME…` and target rules
    still judge it as the home (`rm -rf ${HOME:+$HOME/.cache}` stays allowed).
  - The unset-HOME reading is the unset-names one every name gets; no extra pass.
  - An op it cannot read (`[i]`, `@Q`) stays as written. 0 diffs over 126 real `${HOME` commands.
  - Tests: `test_a_program_or_flag_built_from_home_is_read_with_the_real_home`.
- A brace unit inside a brace list is ONE item (XERK-1694, `_mask_param_braces`): before
  matching lists, `_expand_braces` masks each with a stand-in and restores it after.
  `_BRACE_RE` cannot span braces or blanks, so a list holding one was never expanded:
  `rm -rf {/tmp/x,${HOME}}` (also `{"$HOME",x}`, braced by `_brace_quote_ended`) went unread.
  - Units: a live `${…}` (bash counts plain `{…}` inside it, which `_brace_end` does not:
    `${y:-{a,b}}` is one unit) and a `$(…)`/backtick.
  - Out of stand-ins it refuses as too large: a list left unread fails open.
  - An unbalanced plain count keeps `_brace_end`'s close and stops counting for the line:
    a scan per opener is quadratic.
  - Never mask literal non-list braces here: readings that see quoted JSON bare then expanded
    its lists (4s → 26s, deadline). `_bash_brace_list` reads them in place (XERK-1756).
  - It runs per nested body (thousands of calls on a backtick-heavy line): keep its
    early returns (no unit, or no `{` but a `${`'s) and lazy stand-in pick: without them it
    cost 3-5x on the timing tests, and 100k backticks with no list hit the stand-in refusal.
  - Tests: `test_a_brace_unit_inside_a_brace_list_is_one_item`.
- Tests: `test_a_target_built_from_home_is_read_with_the_real_home`,
  `test_home_readings_are_bounded`.
- A relative `rm`/`chmod`/`find` operand after a `cd` is joined to that cwd when the join may
  name the session home or a directory above it (`_holds_home`, XERK-1752).
  - Otherwise only `..` operands (or any, inside an exact root) are joined: joining every one
    would refuse `cd /usr/src/app && rm -rf build` against a cwd that may be stale.
  - Matched component by component with `fnmatchcase` (and `==`, for a HOME holding `[`), so
    after `cd ~/..` the operands `x`, `./x/`, `x*`, `*` and `x$n` (unset reads empty) all deny.
  - Past the home only all-glob components join (`x/*`), and only from a cwd above the home: the
    join is judged as an absolute path, so `x/build` under /var, or `cd ~ && rm -rf .c*`, would
    refuse an ordinary cleanup.
  - Accepted over-read: every `cd` target stays a candidate cwd for the rest of the line, so
    `cd ~/.. && cd /tmp && rm -rf <home's name>` is refused.
  - Tests: `test_a_relative_name_for_the_home_after_cd_to_its_parent`.
- A cwd at a person home spelled absolutely (`/home/<x>`, `/Users/<x>`) is an exact root like `~`
  and `/root`, so `cd /home/me; rm -rf *` joins (XERK-1757, `_PERSON_HOME_RE`).
  - The SESSION home spelled absolutely is rewritten to `$HOME` in `_cd_targets`: joined as
    `/home/me/build` it would be a /home child and refuse `cd /home/me && rm -rf build`.
  - Accepted over-read: another person's home refuses every relative name, as `/root` does.
  - A tilde target is normpath'd there too (`~root/`, `~root/.` are `~root`): `_norm_path` leaves
    tilde forms unfolded, and `~root/` matched no home token, so `cd ~root/; rm -rf *` ran.
  - Tests: `test_a_cwd_at_a_person_home_spelled_absolutely_is_an_exact_root`.
- Every directory a line can be in is a cwd reading, not only an absolute/home `cd` (XERK-1768):
  - A relative `cd` is joined to the ANCHORS (the cwds the text started with, and each absolute
    or home `cd`), to where the last relative one left the line (`cd ~ && cd ..`), and to each
    STOP (where a relative `cd` left the line had every earlier one persisted); one naming a
    `$`, backtick or opaque substitution stays unknown and adds nothing.
    - Never to every listed cwd: the list doubled per `cd` — 16 `cd`s took 100s CPU and the hook
      denied — and the cap dropped the climb in `cd ~ && cd a && cd b && cd c && cd ../../../..`.
    - Never to the latest alone: a `cd` that did not persist (`(cd x)`, `popd`, `||`, `echo cd x`)
      hid the cwd it left; stops cover one after a relative move (`cd .. && (cd s) && cd ..`).
    - Stops and anchors keep ONE cwd per danger group (`_cd_nearest`, `_cd_reach`): the session
      home or exact root a cwd climbs to, how many `..`, and which land on a `.git`. Two cwds
      in a group land in the same places on every climb, so neither hides the other. Every
      anchor group is kept at any depth (a `.git/hooks` 9 deep was evictable when capped).
    - Stops are grouped to `_MAX_STOP_CLIMBS` (8) or any depth with a `.git` on the climb: each
      `(cd p && cd q)` deepens the line's path, and uncapped 240 of them took 34s. Deeper stops
      keep the 16 shallowest. Residual: 16+ deep decoy stops evict a deep relative one.
    - `/tmp/r/.git/hooks` and `/mnt/d/e/f` share `/` and 4 climbs, but only one `rm -rf ..`
      deletes a `.git`, so the key holds the `.git` climbs, lower-cased (`.GIT`). Floods fail
      closed: `_cd_targets` checks the decision deadline per `cd`.
    - Never cap by recency, depth or distance: decoys near another root (`(cd /opt/dN && cd
      ../sN)` ×17) evicted the real cwd and `rm -rf .ssh` / `rm -rf data` ran there (QA). Probe
      eviction with a home-only AND a root-only target, never `*` alone.
  - Anchors, latest and stops pass from segment to segment in a `walk` state, never re-derived
    from the tuple: joined to every inherited cwd, four `(cd sN)` segments built 2^N phantoms and
    the trim dropped the real cwd (`rm -rf *` in the home was allowed).
  - Past `_MAX_CWDS` the OLDEST cwds go (`_cd_trimmed`), never an anchor, stop or latest one, the
    newest, nor one holding the home or an exact root (`_cwd_holds_home`).
  - A group's head is walked per segment ONCE across the line's groups (`_cd_walk`): re-read per
    group it was quadratic (240 `(cd p && cd q && make)`: 30s → 2.4s). Past `_MAX_CD_WALK`
    characters a group is read from every cwd on the line (over-reads, never under-reads).
  - Time any change here WITH an event cwd: without one most of these paths never run.
  - A cwd inside the session home is kept as `$HOME…` (`_cwd_reading`), as `_home_one_reading`
    keeps a target: `..` from `~/proj` is judged as the home, `../other` never as a child of /root.
    `_cwd_abs` puts the home back in to join a relative `cd`.
  - The hook event's `cwd` seeds the readings (`_SESSION_CWD`, set by `decide` for the whole decision), judged by
    the same `_under_cwd` rules, so no new over-read past what a `cd` there already gets.
  - `dirname`, `realpath` and `readlink -f|-e|-m` print their path for literal or home operands
    (`_path_printed`); a name or a relative path stays opaque. A home operand prints `$HOME…`. Symlinks are not followed.
  - Tests: `test_a_cwd_from_a_relative_cd_a_path_printer_or_the_session`.
