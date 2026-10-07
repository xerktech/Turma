---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
---

# Guard: assigned values read in order (XERK-1660)

- `_assigned_values` is order-blind: a name's values are every value the line assigns it. So a
  LATER assignment reached an earlier use (`q=/etc; d=$q$c; c=x; rm -rf $d` read `/etcx`), and a
  cycle built on a prefix read as a join (`a=/e; b=$a; a=${b}tc` never read `/etc`).
- `_ordered_values` adds a reading where each value is resolved against what its names hold
  WHERE it is assigned (the last assignment before it; not yet assigned = empty, as unset).
  - Mode 2 of `_VALUES_CHAINED` (0 once, 1 chained, 2 ordered), run by `_expand_both` /
    `_expand_readings` only when it differs from both others (`_ORDER_DIFFERS`).
  - ADDED, never in place of the order-blind readings: a function body runs where it is CALLED
    (`f(){ x=$y; }; y=/etc; f`), and only those read that. Don't swap it in.
  - A value with no one place (`read`, `printf -v`, an `eval`'s) keeps its chained reading and is
    a value of its name everywhere (`where` is None).
- A `do … done` body (outermost, `_loop_bodies`) is read again, lap after lap until its values
  settle, at most `_ORDER_LAPS`: `z=$a; a=$m; m=/etc` gives z `/etc` on the third pass.
  - A later lap's different value is one more value of its name (counted for per-value passes).
  - A value naming its own name (`s="$s $f"`) is read on the first lap only: re-read, it grew
    every lap and never settled.
- Growth is charged only for a value that reads differently from the chained one (already
  charged), but checked as it builds: charged in full, a benign 11 KB value used five times was
  refused as too large; uncharged, a doubling value would be built before any refusal.
- Not modelled: `if`/`case` branches (both arms read in sequence), `while` conditions, a loop
  written with `{ … }` instead of `do`, function bodies (the order-blind readings cover those).
- Tests: `test_assignments_are_also_read_in_order`,
  `test_a_chain_of_assignments_resolves_every_link`.
