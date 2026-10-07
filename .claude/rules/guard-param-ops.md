---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: `${v#pat}`-style ops and `eval` assignments (XERK-1651)

- **A trim/replace pattern is a bash glob, matched by `_glob_tokens` + `_glob_ends`.**
  - Quotes and `\` make text literal, `[...]` takes POSIX classes; `fnmatch` does neither.
  - Never go back to "leave the value whole" for a pattern it can't read: a value with blanks
    stays ONE quoted word, so `"${a%% *}" ${a#* }` ran `rm` while the guard saw one word.
  - Unreadable (extglob, an unknown `$` in the pattern, over the cost cap) → `_unreadable_op`:
    `_UNREAD_OUTPUT` + the value, so as a program it is refused and its words still reach path rules.
  - `_glob_ends` is a state-set run, O(value × pattern) whatever the stars; fnmatch per cut
    blew one line past the hook deadline. The `_VAR_OP_*_COST` caps bound it; keep them.
  - Bash parity: `test_glob_trims_match_bash` runs real bash; extend it with any new spelling.
- **A name an `eval` assigns is bound for the whole line** (`_assigned_values`, depth-capped):
  any `eval` word in the segment, a `$x` holding `eval`, and the raw `$(…)` it is handed.
  - The `$(…)` is read as printed AND by its taint readings (`cat <<<…`, pipes), and each script
    with the line's names spliced (`v=a; eval "$(echo "$v=…")"`) (XERK-1668).
  - `printf %q` prints its argument shell-quoted; printed bare, the eval bound `a=rm`.
  - `eval echo …` prints what its echo prints (`_printed_from_tokens`), depth-capped.
- **`source`/`.` bind names as `eval` does** (XERK-1668): a `<(…)` file, or a stdin file
  (`/dev/stdin`, `/dev/fd/0`) fed as a `read` is (`_reader_feeds`: here-string, group, `< <(…)`).
- **An op whose pattern nests a `${…}` is resolved whole** (`_var_sub(nested=True)`, the three
  assignment resolvers only): cut at the inner `}`, `c="${a#${b:-x}}"` bound `x/etc}`.
  - A value bound from several readings (marker-led) splices as words even inside `"$c"`.
  - Only there: made global, a 3000-deep `${a:-${a:-…}}` blew Python's recursion limit.
- `$((…))` in an offset is arithmetic (`_arith_offset`), so `${a:$((1+1))}` is read.
- XERK-1668 cost, measured: 0 changed decisions over a 14.4k-command real corpus replay vs main.
- Names in a pattern, replacement or offset are spliced by `_pattern_vars` (unassigned `IFS` =
  bash's default). A name not assigned on the line may be unset OR hold what bash knows (`$PWD`,
  `$HOME`, `$_`), and a `$(…)` prints something: no single reading is safe either way.
  - Pattern/offset: `_op_readings` yields every reading (unknowns empty, `$(…)` as printed, value
    untouched); `_splice_readings` splices them as separate words led by `_UNREAD_OUTPUT`.
    Reading unknowns empty alone let `${a#$PWD}` through; keeping the value alone, `${a#${nope}xx}`.
  - Replacement and `:+`/`+` alternative: words, not patterns. An unknown stays live text (a
    trailing name braced, `_brace_trailing`, so glued text stays text); the line's reading then
    expands it, as for any `$x`. Stripped, `${a/X/$(echo /etc)}` lost `/etc`; read empty,
    `${q:+$HOME}` lost `$HOME`.
  - Cost: a benign command-position op with an unknown pattern (`${cmd%$x}`) is refused. Accepted.
- `${a:off:len}` arithmetic (`_arith_offset`) truncates `/` and `%` toward zero as bash/C do.
- Extglob (`+(x)`) is unreadable on purpose: its meaning depends on `shopt -s extglob`, which the
  guard does not track; reading it either way is a bypass the other way.
- **A default applies wherever bash applies it, not only to an unassigned name** (XERK-1659):
  - A name assigned empty takes its `:-`/`:=` default (`x=; ${x:-cmd}`); `-`/`=` keep the empty value.
  - An unset array element takes its default as a scalar does (`${y[0]:-cmd}`, `[@]`, `[*]`).
  - A `}` quoted or escaped inside the braces does not end them: the operator reads up to the
    real `}` (`${a#\}}`), its `#` kept a word. Left raw, `eval "${a#\}}"` ran unread.
  - `printf -v` arguments are also read with their defaults applied, as `x=${y:-…}` is.
  - Inside `"…"` a `\}` in a default or `:+` word is a plain `}` (`_dq_unescape_brace`), as in bash.
  - An ASSIGNED array element's default op is read as the values AND the default, marker-led
    (top level only: inside another op's pattern the marker would hide its trim).
    Cost: `y=(ls -la); "${y[@]:-ls}"` is refused as a program. Accepted.
  - A quoted-`}` op on an assigned array element stays raw text, as before (XERK-1700).
  - Cost, measured: 0 changed decisions over a 38k-command real corpus replay vs main.
