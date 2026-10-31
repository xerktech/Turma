---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Killing a child's process group

- **Never `os.killpg` a pid that is not a real `int` > 1.** A `MagicMock` proc's `pid` coerces to 1,
  and `killpg(1, SIGKILL)` is `kill(-1, SIGKILL)`: every process the agent's user owns dies,
  `systemd --user` included, so the agent and every session go down and stay down.
  - This took TrueNAS down repeatedly on 2026-10-31. A mutation test made a mocked `Popen` reach a
    killpg helper. A test that patches `Popen` can reach any kill path the code under test owns.
  - Guard each killpg site with `type(pid) is int and pid > 1`, and fall back to `proc.kill()`.
  - Tests: `TestKillpgNeverHitsPidOne` in `test_hub_agent.py`.
- When mutation-testing a kill path, patch `os.killpg` in the test first, so a mutant can't reach the
  real syscall.
