---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: taint filters and arithmetic (rollup XERK-1584)

Split from `guard-substitutions.md` (size ceiling); the taint reading itself is described there.

- A bare `xargs`, or `xargs echo|printf`, relays what it is fed (`_xargs_prints`), so it is a
  pass-through stage in `_stmt_tainted`: `$(false || echo rm -rf /etc | xargs echo)` ran unread.
- bash's deprecated `$[ … ]` is arithmetic like `$(( … ))` (`_subst_in_bracket_arith`): a
  substitution inside it is an operand, never a program. Same plain-arithmetic gap rule
  (`_ARITH_GAP_RE`), so a quoted `'$['` decoy still reads as not arithmetic.
- `xargs $x cmd` with `$x` empty runs `cmd`: `_empty_program_dropped` walks on past xargs and
  its options (`_xargs_options`) before deciding the program.
- Tests: `test_rollup_batch_four_shapes`.
