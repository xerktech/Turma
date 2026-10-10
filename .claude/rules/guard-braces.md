---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: brace lists the regex cannot match (XERK-1756)

- A list `_BRACE_RE` cannot match is read by bash's own scan (`_bash_brace_list`, a port of
  braces.c's `brace_gobbler`): an item holding a quote, an escape or a literal brace
  (`{x,"}",/etc}`, `{x,a\},/etc}`, `{x,{a},/etc}`, `{'a b',/etc}`) hid the whole list.
  - A `}` closes a list only after a top-level `,`/`..`: `{a},/etc}` is `a}` and `/etc`.
  - Only a body holding a `_BRACE_HARD` char is taken, and a regex match holding a quote or `\`
    is passed to it: `{x,'}` was matched short. Every list the regex reads reads as before.
  - Literal braces are read in place, never masked as units: masking let readings that see
    quoted JSON bare expand its lists (XERK-1694, 4s → 26s on two real commands).
  - Bash rescans the word from each `{`: steps past `_BRACE_SCAN_MAX` refuse as too large.
  - Tests: `test_a_quoted_escaped_or_literal_brace_inside_a_list_is_read`.
