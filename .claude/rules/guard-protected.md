---
paths:
  - "agent/native/turma-agent-protect"
  - "agent/native/install.sh"
  - "agent/hub-agent.py"
  - "agent/hooks/guard.py"
  - "agent/hooks/fileguard.py"
  - "agent/tests/test_turma_agent_protect.py"
  - "agent/tests/test_guard_settings.py"
  - "agent/qwen/guard/shim.py"
  - "agent/dsh/guard/**"
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
- **The protected guard trusts NOTHING in its env for a loosening** (`--protected`): a session can
  start a nested `claude` with any env, and the hook inherits it — `TURMA_TOOL_GRANTS='Bash(*)'`
  lifted every destructive deny (QA). Its overrides come only from root-owned
  `/etc/turma-agent/guard.env` (`protected_settings`). fileguard protects the passwd home's
  `~/.claude` as well as `$HOME`'s, for the same reason. A new env-read override in either hook
  must join `_PROTECTED_KEYS`, not read `os.environ`.
- **`remove` stops the units, then takes the lock, then unlinks; `sync` under the lock is a no-op
  once the self copy is gone.** Unlinking first raced a running sync, which re-laid the hooks
  (or a drop-in naming missing ones) after "removed" (QA).
- `install --from` is replaced by the latest release almost at once: enabling the timer fires a
  sync. QA of a branch's hooks must stop the timer first, or it tests the release's.
  - The drop-in carries ONLY `hooks` — an unknown key could get the whole file rejected.
- **It is a boundary only while the session uid cannot become root.** `NOPASSWD: ALL` (TrueNAS's
  `truenas_admin`) walks past it; `status` exits 1 and says so. Removing that is per-host operator
  config, not code.
- Still session-controllable (best-effort, XERK-1749): `~/.turma/grants` and the grant's
  `TURMA_SESSION_ID` env, `$HOME` as guard.py's own home readings use it, `ask.py`/`permlog.py`, the
  `--settings` deny rules, the `claude` binary in `~/.local`.
- **dsh and qwen read no managed settings**, so `runtime_hook_paths()` points their guard configs at
  the protected copies while `managed_guard_active()` (XERK-1751); both caches re-check it per launch.
  - They run the protected guard WITHOUT `--protected`: its env is the runtime's own, which the
    session cannot set (unlike a nested `claude`'s).
  - Still session-writable around them: the qwen shim + dsh plugin code under `$PREFIX`,
    `~/.turma/qwen-guard.json`, the dsh profile, and qwen's per-worktree `.qwen/settings.json` (XERK-1764).
- Tests: `test_turma_agent_protect.py`, `TestManagedGuard` (`test_guard_settings.py`),
  `TestProtectedOverrides` (`test_guard.py`), `TestFakedHome` (`test_fileguard.py`).
