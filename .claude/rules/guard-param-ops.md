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
  - The eval word resolves through `${!x}` (ops/elements too, in `_pattern_vars`) and `for`
    names (XERK-1666); quotes and `\` are removed before comparing (`_spells_eval`).
  - `for` words join `known` for this scan only, never `vals`: list words are data, not counted values.
  - Build that map ONCE per line: rebuilt per segment it was segments × words, 45s on a long line.
  - A literal multi-word list is separated by `_for_word_lines`, not here; only a word-split
    `$x` list word is tried field by field. Trying every multi-valued name per value was 3.5x
    slower and changed no verdict.
  - A word holding `${!` or an `@X` transform is read AS an eval (`_MAYBE_EVAL_RE`): x's value
    can be built in ways no reading follows (`$'\x79'`, `${z#a}`, a loop name), and `@E`/`@P`
    decode escapes. Cost: such a word with a destructive assignment in its args is refused.
  - `@E` decodes (`_decode_escapes`, cut at a NUL as bash does) in every value resolver and the
    main splice: the word rule above never sees `z=${y@E}; $z`. `@P` is a prompt expansion
    (`\s`, `$(…)` run): a value with `\`/`$`/backtick is marker-led, never decoded as `@E`.
  - Match `@E`/`@P` with `_decoding_op`, never `tail == "@E"`: a subscript makes it `[0]@E`.
    It scans ONE subscript as bash finds its `]` (quotes, `\`, `$(…)`, `${…}`, backticks): a loose
    `\[.*\]` took the trim `${y[0]%]@E}` as `@E` and the NUL cut hid the script; quotes alone
    missed `${y[\"]@E}`. Keeping the text past a NUL instead split `bash -c "…"`'s script word.
  - Case ops (`^^`, `@U`) stay unapplied in the main splice: on a case-blind disk `/ETC` is `/etc`.
  - Never key loop readings on `${!` instead: keyed on every loop it made plain loops "too large",
    keyed on the name's spelling it missed built names (QA, 3 passes).
  - Not modelled: `for e in $(echo $x)`, `set -- $x; for e` (XERK-1726); namerefs (XERK-1722);
    glued array elements `${y[0]}${y[1]}` (XERK-1730); a named `source`, `eval \$x'al'` (XERK-1732).
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
  - On `${HOME<op>}` every reading is kept (`_home_readings`): spliced as an op's readings are,
    and each judged. One picked dropped glued text (`${HOME##@(*)}/etc`); a None read not-home.
- **Each reading of a multi-reading op also gets a whole-line pass of its own** (`_READING_PICK`,
  `_expand_both`, XERK-1664), spliced plainly, on top of the split and joined forms below.
  - Text glued after the op (`bash -c "rm -rf ${a%@(X)}tc"`) joins only the last reading in both
    marker-led forms; only a per-reading pass reads `/etc` there.
  - `_READING_PICK` is in `_memo`'s and `_reading()`'s keys: missing, a pick pass replayed the
    default pass's result. `_READINGS_MOST` (how many) is not main's `_READINGS_SEEN` (whether).
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
- **A `${…}` nested in an op word is matched to its real `}` everywhere** (XERK-1673, `_var_uses`):
  `_VAR_USE_RE`'s `[^}]*` cut `y=${q#${nope}x}` at the inner `}`, so the assignment route read
  `${q#${nope}` plus a stray `x}` (`_substitute_vars` already had its own nested resolver).
  - Only when a `${` sits inside and `_brace_end` closes past the match; yielded as `_NestedUse`.
  - Each extension is charged to the growth budget (`_spend`): every caller re-reads the op word
    a level down, and 200 levels of a 40 KB value took 49s uncharged. Past `_MAX_NESTED_VARS`
    levels the flat match stays (the line is already too large to `_substitute_vars`).
  - `_quote_states` once per `_var_uses` call, never per use: per use, 400 values took 4x.
- Several op readings inside `"…"` (`_splice_readings`, an assigned marker-led `"$y"` too) are
  read BOTH ways (XERK-1673 QA): split into quoted words, and as ONE marker-led word in an added
  whole reading (`_READINGS_JOINED`, only once `_READINGS_SEEN`; it re-runs every reading, as a
  one-hop `s="$y …"` resolves only in the chained one).
  - Split alone, `bash -c "${q%x$nope} …"` became a lone marker script plus arguments.
  - One word alone, every per-word judge but the path one missed it: a lone stdin-fed program
    (`echo … | "$y"`, `len(tokens) > 1`), `_is_home_ssh`, a `cd /` relative target.
  - `_dangerous_target`/`_is_dangerous_path` judge each reading of a joined word on its own (the
    home map-back too: joined, `$HOME/proj/build` read as `/root/…`, a false deny).
  - A stored marker-led value is split only with 2+ readings: a `$(…)` output with ONE
    (`L=$(cat f || echo ls)`) lost its marker and its program was read as known (QA).
- Open (XERK-1734): readings glued to text (`"$HOME/.${h%x$nope}"`), a `cd` target, or a `$(…)`
  printing them never yield bash's word.
- Open (XERK-1729): a quoted/escaped `}` in an ASSIGNED op word (`y=${q%'}x'}`) — the
  stored value has lost its quotes, so the op is cut at that `}`.
- Tests: `test_a_nested_brace_in_an_assigned_op_word_is_read_whole`.
