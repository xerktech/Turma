---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: brace lists the regex cannot match (XERK-1756)

- A list `_BRACE_RE` cannot match is read as bash's scan reads it (`_bash_brace_list`, after
  braces.c's `brace_gobbler`): an item holding a quote, an escape or a literal brace
  (`{x,"}",/etc}`, `{x,a\},/etc}`, `{x,{a},/etc}`, `{'a b',/etc}`) hid the whole list.
  - A `}` closes a list only after a top-level `,`/`..`: `{a},/etc}` is `a}` and `/etc`.
  - Only a body holding a `_BRACE_HARD` char is taken, and a regex match holding a quote or `\`
    is passed to it: `{x,'}` was matched short. Every list the regex reads reads as before.
  - Literal braces are read in place, never masked as units: masking let readings that see
    quoted JSON bare expand its lists (XERK-1694, 4s → 26s on two real commands).
  - Bash rescans the word from each `{` (quadratic). Read instead in ONE right-to-left pass over
    `_brace_units`: a level-0 scan entering a nested `{` is back at level 0 just past the first
    `}` that brace's own scan meets. A per-opener scan with a step budget false-denied
    `docker --format {{.Names}},…` ×400 and slowed nested readings 15x (QA).
- Every list on a line is expanded, and past `_BRACE_PASSES_MAX` or `_BRACE_GROWTH` the line
  is refused: the old 4-expansion stop ran the 5th list unread, so four harmless lists before
  `rm -rf {x,'/etc'}` hid it.
  - A pass expands the first list of EVERY word in one rebuild: a pass per list re-read the
    line's quoting per list, quadratic (1000 lists through 6 nested readers went too large).
  - So passes = lists in one word + nesting depth; `{a,b}` ×24 in one word is refused.
- Tests: `test_a_quoted_escaped_or_literal_brace_inside_a_list_is_read`,
  `test_brace_lists_expand_as_bash_expands_them` (against real bash).
