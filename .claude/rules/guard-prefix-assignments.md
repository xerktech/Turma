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
- Only LEADING words: an argument's expansion IS word-split (`rm -rf X=${v:- /etc}` deletes /etc).
- Replayed against ~33k real Bash commands: 0 decision changes.
- Tests: `TestWrapperUnwrapping` (`PREFIX_WRAPPED`, `WRAPPED_SAFE`) in `test_guard.py`.
