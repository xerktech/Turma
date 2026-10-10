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
  - The growth budget (4x + 8 KB per call, checked per word as a pass builds) and the
    decision's `_spend` budget bound it: every later reader and eval level re-reads the
    expanded text. At 16 KB a 6-deep `eval` of `{a,b}` x10 took 8s; 200 `$(…)` bodies of it,
    each inside one call's budget, read 2.6 MB (26s). Worst measured now ~3.7s.
  - `_brace_word_start` takes a per-pass memo (substitutions per body, how far its word walk
    got): walked from the start per list, a line of quoted lists was quadratic (9s on 135 B).
  - A refusal is never grantable (`_expand_top` sets `_budget["capped"]`): the policy checks
    after a grant see only `_TOO_LARGE`, so brace padding hid a `gh pr merge` (QA).
  - Accepted over-deny: products past that budget, e.g. `touch f{0..9}{0..9}{0..9}.txt`
    (1000 words), `{a,b}` x10 in one word, 5+ glued unquoted objects `{a:{b:'x',c:[1,2]}}…`.
    A bigger budget makes the readers after it slow; 0 real replayed commands reach it.
  - Accepted over-deny: JSON objects glued in one word in text a reading takes as a script
    (`printf '{"a":{"b":"%s"}}' x y z | python3`): each object is a list, and the product
    passes the growth budget. Never make it non-product: padding then hides `/{e,'x'}{t,'y'}c`.
  - Cost, measured: 1 decision change (that shape) over 12.2k real Bash commands holding a
    `,`; CPU time within noise except lines with many lists (+9-14%: more text is read).
- The pass follows bash closely, not exactly: in 2 of 300 random words of `{ } , ' " \ $( ${ ..`
  (e.g. `"}"{{},},{}a}"a b"}`) it reads extra words where bash keeps one. That over-reads
  (a false deny at worst); a word read SHORT would be a bypass, so test new shapes for that.
- Tests: `test_a_quoted_escaped_or_literal_brace_inside_a_list_is_read`,
  `test_brace_lists_expand_as_bash_expands_them` (against real bash).
