---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Native Windows agent — `hub-agent.py` portability (XERK-670, epic XERK-666)

The shared runtime is ONE cross-platform codebase — **never forked per OS** (ADR D5,
`docs/windows-agent-adr.md`). Windows reuses the same `hub-agent.py`; the few Unix-only seams
dispatch on `IS_WINDOWS = os.name == "nt"` rather than living in a Windows copy. Read the ADR for
*why*; this is the operative rule.

## Scope boundary — the terminal layer is NOT here (XERK-668)

- **`hub-agent.py` never calls the tmux/ttyd CLI through an OS branch of its own.** The tmux/ttyd
  call sites (`_spawn_in_tmux`, `_type_into_pane`, `_capture_pane`, `_tmux_alive`, `_launch_ttyd`)
  and `resume_on_boot`'s adopt path are **XERK-668's `TerminalBackend` seam** (the ConPTY pty-host
  replacing tmux+ttyd, ADR D1). XERK-670 is deliberately seam-INDEPENDENT and touches none of them.
- So a Windows-portability change here must stay on the **paths / permissions / state-dir / liveness
  / degradation** side. Anything that drives, captures, spawns or adopts a session's terminal belongs
  to XERK-668 — do not add a `sys.platform` branch to those call sites from this side.

## Paths & separators (ADR D4)

- **Use `os.path`/`os.path.join`, never a hard-coded `/`.** Existing joins (`WORKTREES_ROOT`,
  `CLONES_TMP_ROOT`, `REGISTRY_DIR = expanduser("~/.turma")`, socket/upload/questions dirs) already
  hold on Windows — `expanduser("~")` resolves to `%USERPROFILE%`, and a dotdir (`.turma`) is fine on
  NTFS.
- **The only POSIX literals are the last-resort DEFAULTS** for `REPOS_ROOT` and `PROJECTS_ROOT`,
  behind `_default_repos_root()` / `_default_projects_root()`. The native launcher normally sets
  `REPOS_ROOT`/`CLAUDE_PROJECTS_ROOT`, so these fire only against an env that omits them; on Windows
  they land under `%USERPROFILE%` (`~/.claude/projects` is where Claude Code itself writes there).
  Keep the container default an explicit POSIX literal — a moved `$HOME` must not silently relocate it.
- **`_project_slug` is already platform-agnostic** — it maps EVERY non-alphanumeric char (`\`, `:`,
  `/`, `.`) to `-`, so a Windows cwd (drive letter + backslashes) slugs the same on both sides of the
  wire. Do not re-introduce a `/`-only mapping. Transcript resolution rides this unchanged.
- **A wire path is FORWARD SLASH, always — normalize `os.path.relpath` at the boundary (XERK-678).**
  `_session_files`'s raw-archive rel is the hub's cursor + store key, and `safeRawRel` splits on "/"
  only; the un-normalized `os.path.relpath` handed a Windows host `<tid>\tool-results\x`, which the
  hub 400'd for EVERY raw sidecar. It is `.replace(os.sep, "/")`'d at construction (Windows accepts
  "/" for the local reopen too), and `_archivable_rel` splits on "/" so a backslash rel still
  validates by component. A no-op on POSIX. Any other agent→hub path key needs the same treatment.
  Tests: `test_archivable_rel_accepts_a_windows_backslash_rel`.

## State dirs (ADR D4)

- `~/.turma` stays `expanduser("~/.turma")` on both OSes (→ `%USERPROFILE%\.turma`).
- `~/.config/turma-agent` → **`%APPDATA%\turma-agent`** on Windows: `agent_env_path()`'s fallback
  branches on `IS_WINDOWS` (`%APPDATA%`, else `~/AppData/Roaming`) vs XDG (`$XDG_CONFIG_HOME`, else
  `~/.config`). This fallback only fires for a launcher too old to export `TURMA_AGENT_ENV`.

## Permissions — `chmod 600` → NTFS ACL (ADR D4)

- **`restrict_file_to_owner(path)` is the cross-platform `chmod 600`.** POSIX: `os.chmod(0o600)`,
  byte-identical to before. Windows: `icacls <path> /inheritance:r /grant:r <user>:F SYSTEM:F` — the
  owner-only NTFS ACL. `os.chmod` on Windows only toggles the read-only bit and is NOT a substitute.
- **Windows is BEST-EFFORT — an icacls failure is LOGGED, never raised.** The bytes are already on
  disk; refusing here would strand XERK-578 token onboarding over a cosmetic ACL. POSIX still raises,
  preserving the old contract for existing callers.
- **It acts only on a REGULAR file (`lstat`, so a symlink is refused)** — the "guard against opening a
  non-regular path" on the permissions side. Callers create the file first, so this never diverges on
  the real path.
- Routed through it: `write_local_model_env`, `rewrite_env_var` (the `TURMA_TOKEN` env file). The
  per-pid credential-tmp opens carry **`getattr(os, "O_NOFOLLOW", 0)`** (a no-op flag on Windows) so
  a planted symlink can't redirect the write; `_write_new_file` (uploads) uses the same `getattr`
  form. Never write bare `os.O_NOFOLLOW` — it does not exist on Windows and raises at call time.

## Token-roll restart is a supervisor exit, never turma-agentctl (XERK-675)

- A hub-pushed `setToken` (Roll) or `--enroll` (Enroll) ends in a manager restart. `_perform_restart`
  brings the manager back per its supervisor: systemd (`INVOCATION_ID`), a container's restart policy,
  or — on Windows — **the WinSW-supervised launcher**, which `WaitForExit`s the manager and relays its
  exit code, so a clean exit propagates up and WinSW restarts the launcher → a fresh manager on the
  rolled token.
- **`IS_WINDOWS` counts as supervised**, alongside `INVOCATION_ID`: `turma-agentctl` is a POSIX-only
  bash script a Windows host does not have, so `_perform_restart` must NEVER `subprocess.Popen` it
  there (a stray copy would fight the supervisor). Only a bash native/nohup install with no supervisor
  self-relaunches through the ctl script. Tests: `test_perform_restart_exits_on_windows_without_agentctl`.
- The rest of Roll/Enroll is the SHARED `hub-agent.py` (`set_token`/`enroll_self`/`rewrite_env_var`/
  `token_device_name`, XERK-578) — already `IS_WINDOWS`-aware for the env path (`agent_env_path`) and
  the owner-only ACL (`restrict_file_to_owner` above). The Windows-launcher half (the
  `TURMA_AGENT_SELF_ENROLL` loop, `TURMA_AGENT_ENV` export) is `windows-launcher.md`.

## Manager-boot POSIX seams — guarded so `run_forever` starts (XERK-678)

Found by the first real-Windows run: the manager crashed at startup on POSIX-only symbols the
XERK-670 pass missed. Each is a NO-OP-on-Windows guard, behaviour-identical on POSIX; **never write
the bare POSIX form** (it raises at call time on Windows Python, exactly like `os.O_NOFOLLOW` above).

- **`os.O_NONBLOCK` is guarded like `O_NOFOLLOW`** — `_read_untrusted_json`'s `os.open` uses
  `getattr(os, "O_NONBLOCK", 0)` (and adds `getattr(os, "O_BINARY", 0)`, a no-op on POSIX, so the
  JSON read is binary on Windows). It sat un-guarded beside an already-guarded `O_NOFOLLOW` and was
  the FIRST startup crash (`AttributeError: module 'os' has no attribute 'O_NONBLOCK'`).
- **`signal.SIGUSR1` install is `IS_WINDOWS`-gated in `run_forever`** — Windows Python has no
  SIGUSR1, so registering the handler raised. The tunnel's heartbeat poke is a no-op on Windows
  (tunnel-agent.js portability), so there is no signal to install; the manager beats on its normal
  interval. SIGTERM/SIGINT exist on Windows and stay unguarded.
- **The subscription `_start_limits_probe` no-ops on Windows** — it shells `tmux` (`WinError 2`), a
  self-contained TTY probe the ConPTY session terminal layer (XERK-668) does not cover. Degrades to
  no `limits` block ("can't tell"), like the cc-socks sweep and container-log tail. `os.getuid` and
  the `/proc` reads stay unreached on Windows behind their existing `/proc/self` guard.
- Tests: `TestReadUntrustedJson` (the FIFO refusal proves the guarded `os.open` still works),
  `TestWindowsManagerBoot` (SIGUSR1 installed on POSIX, skipped under mocked `IS_WINDOWS` — inverting
  the guard must fail a test), `TestLimitsSnapshot.test_the_probe_no_ops_on_windows` (probe skip).

## Liveness & degradation (already hold — do not regress)

- **`_pid_alive` uses `os.kill(pid, 0)`, which works on Windows** — the generic liveness primitive.
  The `/proc`-specific cc-socks sweep is a POSIX/dsh feature that already self-guards
  (`getattr(os, "getuid", None)`, `os.path.isdir("/proc/self")`) and degrades to no-op on Windows.
- **`startedAt` falls back to the manager's start time** (`run(["docker", ...]) or now_iso()`) and the
  **container-log tail** to `LOG_TAIL_UNAVAILABLE` (`except Exception`) — both hold on Windows because
  `run()` returns `""` on a missing binary. Keep these fallbacks; the restart-loop alert keys on a
  non-empty changing `startedAt`.

## Tests

`TestWindowsPortability` in `test_hub_agent.py` MOCKS `IS_WINDOWS` so the Windows branch is verified
on Linux CI: the icacls owner-only ACL, its best-effort swallow, the non-regular-path refusal, the
`%APPDATA%` env-path fallback, and the profile-relative default roots. The POSIX branches stay pinned
by the existing `TestSetToken`/local-model-env cases (0600 preserved).
