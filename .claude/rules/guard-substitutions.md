---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: finding command substitutions (XERK-1605)

- **Substitutions are found by a balanced scan, not `_SUBST_RE`** (`_find_substs`): the regex
  cannot nest, so nested backticks paired wrongly and `\$( (echo …) )` matched nothing.
  - Backticks pair by EQUAL backslash-run length, so nesting reads right at any re-parse depth;
    a backtick body loses one escape level, as in bash.
  - `$((…))` arithmetic is skipped but scanned INTO: skipping it whole stopped inner `$(…)`
    resolving early and pushed a real `kubectl exec … sh -c` one-liner into `_TOO_DEEP`.
  - Every parser of substitution text must use it — `_sub_substs`, `_produced_text`,
    `_reads_stdin_script`, the `<(` feed — and `_ASSIGN_SUBST`'s backtick must skip `\``.
    Converting `_sub_substs` alone made `x=\`echo \\\`echo …\\\`\`; $x` a NEW bypass.
  - `_subst_text` resolves a body's own substitutions (memoised `_body_printed`), and `_expand`
    never expands one body twice at the same cwds: without both, deep nesting went 2^depth.
  - Still on `_SUBST_RE` (blanking only): the heredoc owner and the DB scan.
- Tests: `test_a_nested_substitution_in_a_reparsed_string_is_classified`,
  `test_deep_substitution_nesting_stays_fast` (`test_guard.py`).
