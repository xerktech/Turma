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
  - Unreadable (an unknown `$` in the pattern, over the cost cap) → `_unreadable_op`:
    `_UNREAD_OUTPUT` + the value, so as a program it is refused and its words still reach path rules.
  - `_glob_ends` is a state-set run, O(value × pattern) whatever the stars; fnmatch per cut
    blew one line past the hook deadline. The `_VAR_OP_*_COST` caps bound it; keep them.
  - Bash parity: `test_glob_trims_match_bash` runs real bash; extend it with any new spelling.
- **A name an `eval` assigns is bound for the whole line** (`_assigned_values`, depth-capped):
  any `eval` word in the segment, a `$x` holding `eval`, and the raw `$(…)` it is handed.
- Names in a pattern, replacement or offset are spliced by `_pattern_vars` (unassigned `IFS` =
  bash's default). A name not assigned on the line may be unset OR hold what bash knows (`$PWD`,
  `$HOME`, `$_`), and a `$(…)` prints something: no single reading is safe either way.
  - Pattern/offset: `_op_readings` yields every reading (unknowns empty, `$(…)` as printed, value
    untouched); `_splice_readings` splices them marker-led, each also read alone (see below).
    Reading unknowns empty alone let `${a#$PWD}` through; keeping the value alone, `${a#${nope}xx}`.
  - Replacement and `:+`/`+` alternative: words, not patterns. An unknown stays live text (a
    trailing name braced, `_brace_trailing`, so glued text stays text); the line's reading then
    expands it, as for any `$x`. Stripped, `${a/X/$(echo /etc)}` lost `/etc`; read empty,
    `${q:+$HOME}` lost `$HOME`.
  - Cost: a benign command-position op with an unknown pattern (`${cmd%$x}`) is refused. Accepted.
- `${a:off:len}` arithmetic (`_arith_offset`) truncates `/` and `%` toward zero as bash/C do.
- **An extglob pattern (`+(x)`) is read BOTH ways** (`_var_op_readings`, XERK-1664): its meaning
  depends on `shopt -s extglob`, which the guard does not track, and either reading alone is a bypass.
  - Off, it is plain glob; on, `_GlobExt` groups matched by `_ext_ends` (memoised, step-capped:
    `!(…)` makes it O(value² x pattern)).
  - It ALWAYS yields 2+ readings (equal ones repeated), spliced marker-led: as a program it is
    refused, and each reading reaches the path rules (`${a##+(x)}` on `xx/etc` names `/etc`).
  - Never trust the on reading as THE text: bash's matcher has quirks it does not model
    (`${a#*@(x|)}` on `x/etc` is `/etc`; `[[ x == *!(x) ]]` is false). Path-form quirks: XERK-1714.
  - On `${HOME<op>}` an extglob op reads as `/`: a None there read the target as not-home.
- **Each reading of a multi-reading op gets a whole-line pass** (`_READING_PICK`, `_expand_both`).
  - The default pass splices them marker-led: bare as words, inside `"…"` as ONE word.
  - Never split a quoted word into reading words: a one-argument carrier (`bash -c "…"`, `trap`,
    `<<<`) then got the marker alone and the script's rest landed in `$0` (XERK-1664 QA).
  - `_READING_PICK` is in `_memo`'s key: missing, a pick pass replayed the default pass's result.
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
