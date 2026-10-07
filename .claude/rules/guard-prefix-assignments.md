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
    (`$(v=X; echo "$v=…")`) are therefore unread: XERK-1684.
  - Added only when it differs from the raw line's cut spliced the same way, so a written
    assignment is not cut twice; its pipelines join `unsplit_line`'s.
  - Every re-parse level is handed its script `${…}`-substituted (`_substitute_vars` expands
    inside `'…'` too), so the cut must run on RAW text one level up: the heredoc site cuts the
    body (quoted delimiter too), and `_raw_printed_cuts` walks the raw line for every `-c`/eval
    script, recursing into scripts, substitution bodies, `<(…)` and unquoted heredoc bodies
    (`: $(bash -c 'eval $(…) rm …')`). Read the raw line BEFORE `_expand` rebinds `command`.
  - A QUOTED shell-fed heredoc body is walked at the heredoc site (the line's walk skips quoted
    bodies, which are data unless a shell owns them).
  - A segment's leading `f(){`/`function f {`/`{`/`(` is dropped first (`_RAW_SEG_OPENER_RE`):
    `_tokenize` keeps `f(){` as one word. Every `-exec` script counts, not the first.
  - Its scripts: an eval join, every `-c` script, a `trap` action, and a shell's or `.`'s
    here-string (name glued to `<<<` too).
  - The walk also reads its text ANSI-C decoded BEFORE splitting and its `$(` gate: split raw, a
    `$'…\'…'` ended at the `\'` and `; …` after it cut the script (`\x24(` is a `$(`).
  - Decoded is an ADDED reading, never the only one: `_ANSI_C_RE` is quote-blind, so a quoted
    `"$'\'"` decoy read as one swallowed the rest of the line. Not yet a here-string a pipe carries to a shell
    (`cat <<< '…' | bash`): XERK-1684.
  - Accepted over-deny, as base already does for `$(echo 'X=1 Y=2') rm …`: printed text at
    command start is read as re-parsed (`$(echo 'X=${v:-a b}') rm …` runs no `rm`).
- `eval` counts as a wrapper for the cut, any spelling bash dequotes to it (`\eval`, `ev''al`,
  `$'eval'`): its words re-join, so a printed `X=${v:-a` `b}` is one assignment again.
- Only LEADING words: an argument's expansion IS word-split (`rm -rf X=${v:- /etc}` deletes /etc).
- Replayed against ~33k real Bash commands: 0 decision changes.
- Tests: `TestWrapperUnwrapping` (`PREFIX_WRAPPED`, `WRAPPED_SAFE`) in `test_guard.py`.
