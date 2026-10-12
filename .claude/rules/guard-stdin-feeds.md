---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: stdin feeds into readers and shells

Split out of `guard-substitutions.md` (size ceiling); read it for the substitution scan these rely on.

- **A reader with no here-string of its own takes the stdin feeds that reach it** (XERK-1650,
  `_reader_feeds`): a here-string or `< <(…)` on a group it is in, and an `echo`/`printf`
  (or a group of them) piped into it or into one of its groups.
  - A feed on any OTHER command (`cat <<< … |`, `f <<< …` calling a reader function,
    `exec < <(…)`, an echo piped into `cat`) feeds EVERY reader: its path can't be traced.
  - Paired, never every feed to every reader: N `echo … | while read` loops read each name N
    ways, N² readings, and a benign script was refused as too large.
  - A multi-line text is one more value with its lines kept (each line a read), never a value
    per line: N reads of an N-line here-string was N² readings again.
  - `mapfile`/`readarray` bind an array (MAPFILE by default); `select` binds REPLY, its list as
    `for` does. A reader's own `<(…)` words are cut before its names are read.
  - Residuals: IFS/`-d` delimiters, `bash -c 'read …'`, `mapfile -C`, coproc, files, `yes`, and `read a <<E` (values are read with
    heredoc bodies already cut) (XERK-1658)..
- **The stdin-feed walk splits with `groups=True`** (XERK-1614): a cut inside `{ echo …; }` or
  `X=<(a; b)` severed producer from reader. Only that walk: every other caller keeps the old
  split and relies on `_expand`'s group pass to read bodies.
  - `|&` is one pipe, in every split; `2>&1` is XERK-1616's `keep_redirects`, which the walk also passes.
  - No group opens inside `${…}` (`${x#(}` is pattern text), and a group still open at the end
    re-splits without `groups`: an unclosed "group" swallowed every later pipe (a QA regression).
  - Producers are flattened by `_simple_commands` (recursive, groups on): a single plain split
    cut a deep `{ { …; }; }` apart. A `{` right after an opener counts at any depth.
  - The walk reads pipelines from BOTH splits plus each whole-group pipeline's interior
    (`_walked_pipelines`): a group kept whole but not opened (`do (a; echo …) | sh`) hid what
    the plain split had cut out — a QA regression. Never walk the group split alone.
  - `_group_core` opens a group behind keywords (`do`, `then`, `!`, `time`) or before trailing
    redirections (`(…) 2>&1`); `_unwrap_group` opens only a group that IS the segment.
  - Its trailing redirections are read by `_only_redirects`, one greedy pass from the closer. Not a
    regex: searched it went O(n²), and anchored it split `>a1>a1…` every way — exponential.
- **`_reads_stdin_script` recurses** into a group/list and a `-c` script: `bash -c bash` and
  `(cat | bash)` read the stdin they inherit. Past `_MAX_EXPAND_DEPTH` it says "reads" (closed).
  - A part equal to its stage goes to `_command_reads_stdin`, never re-split: the redirect
    re-reading returns `>&1` among `>&1`'s own parts, and looping hit the cap (a false deny).
- **An `exec`'s here-string joins the line-wide `<(…)` texts**, and a line with any of them scans
  every pipeline: `exec 3< <(…); bash <&3` has no pipe. De-duped + capped once, else O(n²).
- **More stdin-to-shell routes the walk now reaches** (XERK-1628), each still a producer→reader pair:
  - A COMPOUND command (`if…fi`, `for/while/until/select…done`, `case…esac`) is kept whole in
    `groups=True` splits (as `( )`/`{ }`), so a pipe to/from it is not cut at its inner `;`
    (`echo … | if true; then bash; fi`, `if …; then echo …; fi | sh`). `_compound_opener` detects
    the head at a command start; `_group_core` opens the body via `_compound_body`, a scanner that
    drops the skeleton keywords and `case` patterns but keeps inner groups and PIPELINES whole
    (a plain split cut the inner group, a group-aware one re-groups the whole compound). `time -p
    { …; }` opens because `-p` is a `_CMD_KEYWORDS` keyword-arg.
  - `_group_core` finds a group's closer by a quote/escape/`$(…)`-aware FORWARD scan (`_group_close`),
    not a reverse search of the last few closers, so a closer quoted (`2>"/tmp/x )))))"`),
    substituted (`2>"…$(echo \")\")…"`) or escaped (`2>/tmp/f\)`) in a trailing redirect target is
    not mistaken for the group's. Substitutions in that target are blanked before `_only_redirects`.
  - `_unwrap_group` strips only a bracket that WRAPS the whole segment (`(a) 2>f\)` and `(a)|(b)` are
    left alone); the verifying scan runs ONLY when a redirect/escape char is present, so a 3000-deep
    `(…)` nest stays O(n) per call, not O(n²) at every recursion level.
  - `eval` reads stdin as a script (`_command_reads_stdin_as`): its joined words run inheriting
    stdin (`… | eval bash`, `eval '{,bash}'`, `eval 'cat | {,bash}'`), and a `$(cat)` in them
    (`_passes_input`) captures that stdin to BE the script (`bash -c 'eval "$(cat)"'`). The `-c`
    script is re-read off the raw stage so its `$(cat)` survives the placeholder pass.
  - `xargs … sh -c` with no script arg runs the piped text as the shell's `-c` script.
  - An output process substitution `cmd > >(reader)` feeds the reader this stage's stdout
    (`>(` joins `feeds_a_shell` and the single-stage-skip exemption).
  - A bare call to a function the line defines runs its body in the walk (`_function_bodies`):
    `f() { bash; }; echo … | f` and `f() { echo …; }; f | sh`.
  - A named/variable fd reader is a stdin-script read (`_STDIN_SCRIPT_RE` matches `/dev/fd/$fd`),
    and a heredoc an `exec` holds on an fd joins the fed texts (`exec 3<<EOF…EOF; bash <&3`).
  - 0 decision changes over a 33.9k-command real-Bash replay; `_compound_body` must keep inner
    pipelines whole (a nested `{…} | sh` regressed when it over-flattened).
- **`cat`/`tac`/`tee`/`head`/`tail` of only `<(…)` operands prints their texts** (`_cat_printed`),
  as does `< <(…)` and bash's `$(< <(…))`; redirects, `-` and `/dev/null` are skipped, a real file
  operand stays opaque. Bounded by `_SUBST_DEPTH`.
  - `_proc_subst_texts` is memoised per decision (`_memo("proc")`) and skips the split for a body
    with no operator or `#`: each `cat <(` level re-split its body, 7.5x main on a deep nest.
