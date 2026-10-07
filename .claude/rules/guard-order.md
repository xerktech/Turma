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
    `_expand_readings` only when it holds a value NEITHER other reading has (`_ORDER_DIFFERS`).
    One that only drops values is already read value by value; each reading is a whole-line
    expansion, and running it whenever it differed cost 2-12x on real loops (QA).
  - Computed only where order can matter: a value using a name assigned AFTER it, or a loop
    replay that produced a new value. Otherwise it returns the chained values untouched.
  - ADDED, never in place of the order-blind readings. Don't swap it in.
- A value with no one place keeps its chained reading and is a value of its name everywhere
  (`where` None): `read`, `printf -v`, an `eval`'s, and every `for` list word.
  - A `for` list word is not resolved in order even when it uses a line name (`for f in "$q$c"`):
    its name's value still travels through the loop BODY replay, which catches the common shapes,
    and resolving the words multiplies the per-word loop readings — 100s on a real command (QA).
    The `for f in "$q$c"` shape is the residual (XERK-1703).
- Left order-blind too (`_OrderUnread`), each from a QA false deny on a real command:
  - a value the assignment regex over-captured PAST its statement (`misparse` positions): a
    `${…}` it extended over an UNQUOTED `;`/newline/`<`/`>` (`rest=${m#*|} python3 … <<EOF`). A
    QUOTED separator (`d="$q$c ;"`) is part of the value and IS read in order (`_quote_states` at
    capture tells them apart — the stored value has lost its quotes). The whole misparse signal is
    a position set, not a scan of the dequoted value (that reopened the ticket's own shape, QA);
  - a `${x#pat}`-style op whose pattern is unreadable (several readings).
- A `do … done` body is read again lap after lap until its values settle (`_loop_bodies`):
  - Only a `do`/`done` at a command start is a keyword, judged on the EXPANSION-MASKED text
    (`_mask_expansions`): a `)`/`}`/`(` closing or opening `$(…)`, `${…}`, `$((…))` or an `=(…)`
    array is not a command boundary, so `echo ${q} done`, `$(true) done`, `x=(done)` keep the body
    open (a QA bypass otherwise). A real `(subshell)`/`{ group; }` closer still is; `case …(pat)`
    stays a residual. `echo done`/`x=done` arguments were already handled.
  - Laps: a `for` over N literal words runs N times, so at most N; anything else, or a body
    holding another loop, up to `_ORDER_LAPS`. Deeper laps built values bash never builds.
  - A later lap's different value is one more value of its name, counted for the per-value
    passes except for a `for` name (its words are data; counted, a 30-word list was too large).
  - On a later lap a value naming its own name (`s="$s $f"`) reads that name as it ENTERED the
    loop: as it is, it grew every lap; skipped, `z=$z$a; a=/etc` never read `/etc`.
- Growth is bounded by `_MAX_SUBST_GROWTH` per computation, never charged to the decision: every
  reading recomputes it, and charged each time a benign 11 KB value used five times was too
  large. Splicing the values into a reading is charged where it happens.
- Accepted over-deny: a value really doubled to tens of KB (`y=$x$x; x=$y` ×3 on 2 KB), or a
  160-link chain rebuilt in a loop, is too large; main never built those values.
- Cost: a line where order adds a value pays one more reading set (a 1000-link ring ~3-4x; the
  deadline still bounds it). `_mask_expansions` is `lru_cache`d, pure on the command text.
- Not modelled (all allowed on main too, routed to XERK-1703): a function body polluted by a
  later assignment (`f(){ z=$a$c; }; …; f; c=x`), `read`/`printf -v`/`eval` assignment positions,
  `eval` in a loop, a `for` list word using a line name (`for f in "$q$c"`), `if`/`case` arms
  (read in sequence), `{ … }`-bodied loops, `case …(pat)`, chains longer than the laps, `unset`,
  prefix scope.
- Tests: `test_assignments_are_also_read_in_order`,
  `test_a_chain_of_assignments_resolves_every_link`.
