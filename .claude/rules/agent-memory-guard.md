---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Agent memory guard (XERK-1019)

Every session shares ONE memory cgroup (the pod's container / the systemd unit). A per-session
cgroup needs a privileged pod (`/sys/fs/cgroup` ro, empty `subtree_control`, PID 1 not systemd) —
an operator/ArgoCD decision, so the guard is userspace, earlyoom-style.

- **Its own thread (`_memguard_loop`), never the beat** — the livelock it exists for stalled beats
  for hours. Kills are staged on `memguard_kills`; the BEAT drains them to `notify_session`
  (whose pane fallback writes the registry). Never raises.
- **Trigger is the WORKING SET** (`memory.current - inactive_file`), never raw usage: page cache
  fills usage to the limit on a healthy host. PSI `full avg10` triggers only within 10 points of
  the line. **No cgroup limit → guard OFF, never host `/proc/meminfo`**: MemAvailable omits ZFS
  ARC, so a healthy TrueNAS reads ~90% and the guard would kill for nothing.
- **Kills only a tree that relieves the overage ON ITS OWN** (`_memguard_relieves`: working set
  minus the tree < the PSI floor), measured by **`smaps_rollup` Pss_Anon** (`_memguard_choose`)
  for the top few: statm anon counts a forked pool's CoW pages once PER CHILD (upper bound only). Without it, pressure the guard can't attribute (a protected
  agent, another uid, shm) makes it serially kill small innocent trees. Otherwise: log once, leave
  it to the kernel. Signalled `(pid, start)` are never re-picked; cooldown after a kill.
- **Owned** = cwd inside a session worktree, else `TURMA_SESSION_ID` in environ (survives a
  double-fork to PID 1). cwd first: an environ read takes the target's mmap lock. Unreadable
  (another uid, setproctitle) = unowned = never killed.
- **Protected BY PID from the registry, never by name**: PID 1, the manager + ancestors + its whole
  subtree, each running session's AGENT pane pid (`_memguard_panes`: registry tmux names, the
  RECORDED `agentPane` — never the lowest pane, which is the session's own window once the agent
  pane exits (XERK-1028); gone = protect nothing; unrecorded legacy record = lowest pane id),
  its tmux server, and a shell pane's children (dash doesn't exec the runtime). A `claude`-named
  process or a pane on a session's own tmux is session work. Can't list tmux → the last listing
  (refreshed while healthy) only if it covers exactly today's running sessions AND each cached
  `(pane pid, start)` is still live — a relaunch keeps the tmux name — else kill nothing. A
  listing that missed a running session is never cached (its relaunched pane would be unvouched).
- **Kill through a pidfd opened BEFORE the start-time re-check** (`_memguard_kill`) — the only
  order that makes a reused pid unreachable.
- Tests: `TestMemoryGuard`.

