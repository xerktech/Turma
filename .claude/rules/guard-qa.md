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
