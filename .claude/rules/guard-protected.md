---
paths:
  - "agent/native/turma-agent-protect"
  - "agent/native/install.sh"
  - "agent/hub-agent.py"
  - "agent/tests/test_turma_agent_protect.py"
  - "agent/tests/test_guard_settings.py"
---

# Root-owned guard hooks (XERK-1677)

The manager and its sessions share one uid, so any hook in that uid's home is one the session can
stub (XERK-1643 incident). `agent/native/turma-agent-protect` moves the two SECURITY hooks out of it.

- Layout: `/etc/turma-agent/hooks/{guard,fileguard}.py` + the drop-in
  `/etc/claude-code/managed-settings.d/50-turma-guard.json`, all root:root, not group/other-writable.
  - `/etc`, not `/usr/local`: `/usr` is read-only on TrueNAS. Beside `/etc/claude-code`, an OS reset
    loses both together (falls back to `--settings`), never the drop-in alone.
- **Managed settings are the point, not just the uid.** A user/flag `disableAllHooks: true` turns off
  every `--settings` hook but NOT a managed one (measured, claude 2.1.294). Every `claude` on the
  host runs them, nested and operator ones included.
- **A drop-in naming a MISSING hook blocks every Bash call on the host** (measured). So: hooks are
  written before the drop-in, the drop-in removed before the hooks, every write atomic.
- **Nothing the root helper runs or reads comes from the session uid's home.** `sync` (root
  systemd timer, hourly + boot) takes the hooks from the LATEST release, checked against its
  sha256 asset; a release without one is refused. Never copy from `$PREFIX/hooks` (a tampered copy
  would become a protected one) and never pin to `$PREFIX/VERSION` (a session could pin an old,
  bypassable guard). The unit runs `/etc/turma-agent/turma-agent-protect`, never a `$PREFIX` path.
  - `install --from DIR` trusts DIR: `install.sh --protect` passes its own (bootstrap-verified)
    payload. Don't document running it from `$PREFIX`.
- The hook command is `/usr/bin/python3 -SI <root path>` — never `python3` off PATH (`~/.local/bin`).
- **The manager must not wire them twice.** `managed_guard_active()` (both hooks wired AND present)
  makes `build_guard_settings` drop the Bash + file-edit entries: a second guard run would refuse a
  command the first just allowed on a judge's one-shot grant. `_ensure_guard_settings` re-checks it
  per launch, so protection appearing/vanishing reaches the next session without a restart.
  - The drop-in always passes `--grants`; the guard still ANDs it with `TURMA_PERMISSION_JUDGE`.
  - The drop-in carries ONLY `hooks` — an unknown key could get the whole file rejected.
- **It is a boundary only while the session uid cannot become root.** `NOPASSWD: ALL` (TrueNAS's
  `truenas_admin`) walks past it; `status` exits 1 and says so. Removing that is per-host operator
  config, not code.
- Still session-writable (best-effort, XERK-1749): `~/.turma/grants`, `ask.py`/`permlog.py`, the
  `--settings` deny rules, the `claude` binary in `~/.local`, and the dsh/qwen guards (their own
  runtimes, which read `$PREFIX` copies).
- Tests: `test_turma_agent_protect.py`, `TestManagedGuard` in `test_guard_settings.py`.
