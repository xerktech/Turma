---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/tunnel-agent.js"
---

# Signalling a child by pid

- **Never `os.killpg`/`os.kill` a pid that is not a real `int` > 1** (`_signalable_pid`).
  - A `MagicMock` proc's `pid` coerces to 1, and `killpg(1, SIGKILL)` is `kill(-1, SIGKILL)`:
    every process the agent's user owns dies, `systemd --user` included, so the agent and every
    session go down and stay down.
  - This took TrueNAS down repeatedly on 2026-10-31. A mutation test made a mocked `Popen` reach a
    killpg helper. A test that patches `Popen` can reach any kill path the code under test owns.
  - Every pid read from a record (`ttydPid`, `qwenPeerInboxPid`) or a proc goes through
    `_signalable_pid`: a persisted `-1` parses, and `kill(-1, SIGTERM)` has the same reach.
  - `_pid_alive` refuses one too: `kill(-1, 0)` succeeds whenever any process can be signalled.
  - `tunnel-agent.js` `pokeHeartbeat` takes only a positive integer `TURMA_MANAGER_PID`, else 1.
  - Tests: `TestKillpgNeverHitsPidOne` in `test_hub_agent.py`, `pokeHeartbeat falls back` in
    `tunnel-agent.test.js`.
- When mutation-testing a kill path, patch `os.killpg`/`os.kill` in the test first, so a mutant
  can't reach the real syscall.
