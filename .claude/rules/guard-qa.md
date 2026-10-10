---
paths:
  - "agent/hooks/guard.py"
  - "agent/tests/test_guard.py"
  - "agent/tests/guard_differential.py"
---

# QA-ing the Bash safety guard

- **Never execute guard test cases as root.** The guard only sees the command a session types
  (`python3 rig.py cases.txt`), never what a rig then runs through `subprocess`, so it cannot
  protect the host from its own QA rig.
  - XERK-1590: a hand-rolled differential rig ran `rm -rf ${nope:-/etc}` as root on 2026-10-03
    and deleted /etc on two agent pods (no CA certs → every PR chip grey, no apt, no awk).
  - Every text around `{P}` runs for real too; a case line without `{P}` is not inert.
- **Use `agent/tests/guard_differential.py`** instead of writing a rig: it runs each case as
  `nobody` via `setpriv` and refuses to run if it can't drop privileges. Don't weaken that.
  - `python3 agent/tests/guard_differential.py cases.txt --old <base guard.py>`; one template per
    line with `{P}`, `##` comments. Prints BYPASS / falsedeny / timeout / CHANGED.
  - Multi-line templates (heredocs) are out of its scope; any extra rig must drop privileges the
    same way.
- **A rewrite of the command text is an ADDED reading, never an in-place swap** (XERK-1633).
  - Gluing function headers in place hid the command before a quoted `'()'`, a printed
    `` `echo '()'` ``, or an extglob `@()` — each read as a header. The unglued text must
    still be classified.
  - Rewrite the RAW segment (before substitutions are spliced in), per segment: a whole-line
    re-read doubled the work per nesting level and turned big benign scripts into "too large".
  - Probe any token-joining or header change with quoted/escaped/printed `()`, extglob args,
    `\`-newline splits, zsh quoted names (`'f g'(){`), and timing on nested `eval`s full of functions.
- **A speed test never asserts wall-clock time** (XERK-1750): CI runners are loaded, and one ran
  2-8x over idle. Time with `time.process_time()`.
  - CPU time still rose ~2.2x at 48 busy loops on 16 threads (shared cores), so a ceiling
    sits at ~3x idle CPU. It only has to catch the quadratic blowups (14-180s) it guards.
  - A "too large" verdict is the same reason whether the budget or `_MAX_DECIDE_SECONDS` stopped
    it, and a CPU ceiling at or past the live deadline can never trip. So `test_guard.py` sets
    the deadline off at module top; only the deadline tests patch it back. Keep it off.
  - Keep wall time only where a HANG is the defect (a FIFO read), since a blocked process spends
    no CPU.
