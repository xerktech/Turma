---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: a lone trailing backslash (XERK-1646, XERK-1691)

- **A lone `\` ending a text is read DROPPED** (XERK-1646, `_drop_trailing_escape`): shlex
  raises on it, and the whitespace-split fallback kept a `-c`/`eval` script's quotes.
  - The reading lives in the TOKENIZER (`_tokenize_cached`): every route tokenizes — the
    stdin-feed walk's stages (`echo '…'\ | sh`), a segment whose escaped blank the split ate
    (`'…'\ ; true`), a `\<newline>` split at its newline.
  - Dropped, not bash's literal `\`: zsh drops it, so does a continuation (bash's here-string
    `text\`+newline), and the literal only ever weakens the last word (`/etc\`, `sh\`). Never
    add the literal as a second whole-line or per-segment reading: each level of a nested
    `eval '…'\` re-expanded both, 4x per level, and 1 KB took 29s (QA).
  - Detected by `_quote_states` + the run's parity, never shlex: `comments=True` read a glued
    `'…'#\` as a comment; without it `# don't` is an open quote.
  - `_expand_braces` drops it too, BEFORE joining (as zsh does): left on, `{/etc,/var}\` became
    `/etc\ /var\`, ONE word to shlex.
  - A substitution's PRINTED text ending in one is ALSO read dropped (`_PRINTED_DROP`, XERK-1691):
    kept, it escaped the `"` closing `sh -c "$(echo "…'\\")"` and the script hid. Added, outermost
    splice only, taken only when one was printed: in place it lost main's denies of a
    `\`-newline continuation and of an outer printer whose escape run it made even (QA).
- Tests: `test_a_sibling_or_an_empty_expansion_does_not_hide_the_command` (the XERK-1646/1691 block).
