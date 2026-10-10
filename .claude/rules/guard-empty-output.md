---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: a substitution that may print nothing (XERK-1758)

- bash drops an EMPTY unquoted substitution, so `$(false && echo x) rm …` and
  `$(echo x | grep y) rm …` run `rm`. The taint reading (`_body_tainted_at`) must offer the
  reading where the body printed nothing, or the payload stays in argument position.
- A statement MAY print nothing when it is skipped (a `&&`/`||` body) or its producer's text
  passes a filter that can drop it (`_stmt_may_print_nothing`): any later pipeline stage, or the
  command a here-string feeds, that is not `cat`/`tee` (`_KEEPS_ALL_INPUT`).
  - Fail closed on purpose: `grep`, `head -n 0`, `sed d`, `tr -d`, `cut`, `uniq -d`, `sort -o f`
    can all print nothing. Never grow `_KEEPS_ALL_INPUT` with a program that has such an option.
- The readings are each suffix whose skipped statements may all be empty, plus the empty
  reading past the last (`starts`). Only a LEADING run counts: a statement skipped mid-way
  drops words, never the program.
- Past `_MAX_TAINT_STARTS` the readings are the all-run one and one led by `_UNREAD_OUTPUT`,
  which stands in for every later lead and for the empty reading.
  - Never add the empty reading there too: a third pass took a 20k-statement body past 30s.
  - Keep the words after the lead: `$(… ×9; ls /x || echo -rf /etc)` is refused for `-rf /etc`.
  - A `&&`/`||` body keeps main's reading (every word); one made optional only by filters gets
    each word ONCE: repeated, a benign 17 KB `x=$(…); echo $x` went "too large" (QA).
  - Not shortened for `&&`/`||`: a SHORT lead reading took the 20k-statement test past 30s (a
    long one runs out the growth budget early). 200 distinct `$HOME/fN` prints still cost ~10s.
- Accepted over-deny: a filtered or conditional body in program position followed by
  destructive-looking words (`$(command -v x || echo y) rm -rf /etc`); the lookup-or-fallback
  over-deny in `guard-substitutions.md` already refused most of these.
- Open (XERK-1778): nested substitutions (`_taint_nested` takes the all-run
  reading), a `{ …; }` producer, `cat </dev/null`, a non-filter stage first, `exec >/dev/null`.
- Tests: `test_a_body_that_may_print_nothing_does_not_hide_the_command`.
