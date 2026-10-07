---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: a command's leading assignments (XERK-1620)

- bash keeps a leading assignment ONE word whatever its value holds; shlex and the splitter cut it
  at a blank or `;` and made a fragment the program word, so `X='a b' rm …`, `X=${v:-a b} rm …`,
  `X=$((1 + 2)) rm …`, `X=$(echo a; echo b) rm …` and `a[1 + 1]=x rm …` ran unclassified.
- `_ENV_ASSIGN` matches the DEQUOTED token with any value (DOTALL), `+=` and a subscript.
- `_unsplit_assignments` feeds `_expand` ADDED segments: the line with each assignment that
  PREFIXES a command and holds an UNQUOTED blank/operator char cut to `NAME=`.
  - Never swap it in for the line's own reading, nor splice a value as one word in place: its
    scanner (`_word_end`) is not bash (a quoted `$((` decoy over-extends a word), and in-place
    splices lost `x=$(echo true; echo rm …); eval "$x"`, which the split reading catches.
  - Only the segments that differ are added (as `printed_line` does). Re-expanding the whole line
    re-read every nested body once per level: 0.5s → 17s at 5 levels.
  - Memoised per READING (`_unsplit_cuts_at`, keyed on `_reading()`, cleared per decision):
    `_brace_end` parses a `${…}` per shell, and a cut cached under bash's hid dash's.
  - `_word_end` passes its known quoting to `_brace_end`; looked up, that is a whole-line
    `_quote_states` per `${` — quadratic.
  - The cut line's pipelines feed the pipe-to-shell scan too (`echo 'X=${v:-a b} rm …' | bash`).
- After `env` (and its options) EVERY word holding `=` is an assignment, a name bash would refuse
  included: `env 'a;x=1' rm -rf /etc` runs `rm` (XERK-1657 QA; was allowed on main).
- A standalone assignment (`R=$(command -v ruff); $R format`) is never cut: it sets the shell's
  variable, and cutting it read `$R` empty — a false deny.
- Redirections and their targets may precede the assignments (`>/dev/null X=… cmd`, `{fd}>`,
  `<<<x`, `<<E`), as may the keywords.
- After a `_PREFIX_WORDS` wrapper, EVERY assignment-shaped word to the end of the command is cut:
  env/sudo run them, and a flag's value (`env -u N`, `timeout -s KILL 5`, `coproc N {`) would
  otherwise end command-start. Over-cutting an argument is safe: the reading is only added.
- `function NAME` keeps command-start: its `{` body opens a command (`function f { X=… cmd; }`).
- Quoted strings are scanned as scripts (`bash -c '…'`, `eval '…'`), since the outer `${v:-a b}`
  splice reaches the script before its re-parse does. A `"…"` script is read with its escapes
  removed (`bash -c "X=\$((1 + 2)) …"`) and each cut mapped back (`_dq_unescaped`). A script
  spread over several quoted pieces (`sh -c 'X=…"'"'"'…'`) is dequoted and cut whole.
- A shell-fed heredoc script is cut BEFORE `_substitute_vars`, for the same reason. Nested heredocs
  that each need a cut double the cost per level (accepted: the deadline denies). Never add a flag
  that skips the nested cut: a heredoc needing its cut then hid the next one.
- An assignment only a substitution PRINTS is cut on the line with that printed text spliced in
  (`_printed_unsplit`, XERK-1645): `bash -c "$(echo 'X=${v:-a b}') rm …"`, eval, here-string,
  `| bash`, an unquoted shell-fed heredoc. The raw cut never sees it, and the re-parse
  substitutes `a b` before its own cut runs.
  - Spliced plain AND literal (`_literal`): plain, `"$(echo 'X=${v:-a')"' b} rm …'` put a `"`
    inside a `${…}` frame and the multi-piece dequote never closed.
  - With `assigns=False` (`_body_printed`): applying the body's own assignments also expanded the
    `${…}` it prints (`echo 'X=${v:-a b} Y=1'`, `echo $(echo 'X=…')`). Body-bound names
    (`$(v=X; echo "$v=…")`) are read by the glued reading below (XERK-1684).
  - Added only when it differs from the raw line's cut spliced the same way, so a written
    assignment is not cut twice; its pipelines join `unsplit_line`'s.
  - Every re-parse level is handed its script `${…}`-substituted (`_substitute_vars` expands
    inside `'…'` too), so the cut must run on RAW text one level up: the heredoc site cuts the
    body (quoted delimiter too), and `_raw_printed_cuts` walks the raw line for every `-c`/eval
    script, recursing into scripts, substitution bodies, `<(…)` and unquoted heredoc bodies
    (`: $(bash -c 'eval $(…) rm …')`). Read the raw line BEFORE `_expand` rebinds `command`.
  - Heredoc bodies in the walk: an unquoted one through `_heredoc_readings` (`\$'` is live
    there); a quoted one when `_walk_owner_feeds_shell` (the site's `_heredoc_owner_feeds_shell`
    plus a shell named on the owner line) says so, at any nesting; else data (`cat > f.sh`).
  - The heredoc SITE in `_expand` walks a quoted body too, gated by `_owner_feeds_shell`: the
    walk's owner-token check misses `bash<<'E'`, `{ bash; } <<'E'`, `$x <<'E'`, one in `$(…)`.
    Never drop either: the site sees owners, the walk sees nesting.
  - A segment's leading `f(){`/`function f {`/`{`/`(` is dropped first (`_RAW_SEG_OPENER_RE`):
    `_tokenize` keeps `f(){` as one word. Every `-exec` script counts, not the first.
  - Its scripts: an eval join, every `-c` script, a `trap` action, and a shell's or `.`'s
    here-string (name glued to `<<<` too).
  - The walk also reads its text ANSI-C decoded BEFORE splitting and its `$(` gate: split raw, a
    `$'…\'…'` ended at the `\'` and `; …` after it cut the script (`\x24(` is a `$(`).
  - Decoded is an ADDED reading, never the only one: `_ANSI_C_RE` is quote-blind, so a quoted
    `"$'\'"` decoy read as one swallowed the rest of the line. A here-string a pipe carries to a shell
    (`cat <<< '…' | bash`) is left to the glued reading below (XERK-1684).
  - Accepted over-deny, as base already does for `$(echo 'X=1 Y=2') rm …`: printed text at
    command start is read as re-parsed (`$(echo 'X=${v:-a b}') rm …` runs no `rm`).
- `eval` counts as a wrapper for the cut, any spelling bash dequotes to it (`\eval`, `ev''al`,
  `$'eval'`): its words re-join, so a printed `X=${v:-a` `b}` is one assignment again.
- **A value that reaches the command through a re-parse is glued, not cut** (XERK-1684,
  `_glued_param_values`): `_substitute_vars` splices `${v:-a b}` (even inside `'…'`) before any
  eval/pipe/printed/`source <(…)` join puts `X=` and the command in one script, so no cut sees it.
  - The line is also read with each `${…}` (found by brace depth, quoting ignored, `$''{`/`$'"{`
    spellings too) holding its blanks/operators as `_`, and each use of a name whose value holds
    one (`s='a b'; X=$s cmd`) as `_`. The value's content is the line's own reading's job; spliced
    here, one long value bloated every segment it reached.
  - Only an expansion after some `=` or `\` on the line is glued (any, quoted or not; an escape
    can print a `=`: `printf 'X\x3d$s'`). Never gate on where the `=`'s WORD ends: that needs
    bash's lexer, and each hand scan dropped a glue (`X="$(echo "a b")"$s`, `<(…)`; 3 QA passes).
  - `${…}` closes are matched in ONE stack pass; an unclosed `${` is skipped, never a stop
    (stopping hid every later use). Scanning on per opener was quadratic (`${a:-${` × 2000).
  - Only a `${` opener nests, as in bash: `${v:-a { b}` closes at the first `}`. Pairing the
    bare `{` read it as unclosed and glued nothing (QA).
  - A nested span recurses on its text, so past `_MAX_NESTED_VARS` levels it is too large.
  - Added like the cut line: only differing segments, pipelines and `<(…)` texts. A whole-line
    `_expand` of the glued text covered the same cases at 2-6x on real nested scripts.
  - Also read ANSI-C decoded (`a'$'\t''b`), never only: decoding drops the `$` of `$''{`.
  - A value holding any `\` counts as holding a blank: `_var_values` keeps `s=$'a\tb'` as
    `$a\tb`, its quotes gone, so it can't be decoded there (QA).
  - An indirect `${!n}` is glued whole: its value is another name's, not on its own text (QA).
  - Replayed against 37.3k real Bash commands: 0 decision changes once deadline flips under host
    load are re-run. ~2x on assignment-dense scripts (200 in one eval: 2.8s → 5.9s).
  - Covers every channel at once; per-channel cuts (eval join, pipe producer, printed body)
    each left the next channel open.
- Only LEADING words: an argument's expansion IS word-split (`rm -rf X=${v:- /etc}` deletes /etc).
- Replayed against ~33k real Bash commands: 0 decision changes.
- Tests: `TestWrapperUnwrapping` (`PREFIX_WRAPPED`, `WRAPPED_SAFE`, XERK-1684 block) in `test_guard.py`.
