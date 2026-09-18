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

## The terminal seam IS wired (XERK-697, ADR D5)

The tmux/ttyd call sites now dispatch on `IS_WINDOWS` to the per-session ConPTY pty-host (agent/win/,
XERK-668). Before this, they shelled `tmux`/`ttyd` unconditionally and every Windows session died at
launch with `WinError 2` — the whole session surface was dead. The seam, in `hub-agent.py`:

- **One pty-host process per session replaces BOTH tmux AND ttyd.** So `_spawn_in_tmux`+`_launch_ttyd`
  COLLAPSE into `_spawn_pty_host` on Windows (the pty-host owns the pty and serves the terminal on the
  same stable `ttydPort` the hub proxies `/term/<id>` to). `_kill_ttyd` NO-OPs on Windows; `_kill_tmux`
  tears the pty-host down. Every kill/delete/restart path runs `_kill_tmux` before `_kill_ttyd`, so
  nothing leaks.
- **`_launch_ttyd` is NOT a bare no-op on Windows** — there is no bridge to re-ensure, but it still
  owes the XERK-578 post-roll check its Linux branch performs (`_ensure_pty_auth_current`, below).
- **A token ROLL must not cost the session** (XERK-578). The Linux branch kills and relaunches a stale
  ttyd, which is free because tmux (and the claude in it) lives on; here the pty-host IS the pty. So
  the manager publishes the live token to ONE host-wide file (`_write_pty_token_file`, at boot and
  before every spawn) that every pty-host re-reads per auth check — republishing it IS the roll, with
  no relaunch and nothing lost. **The manager is the only writer**, which is why `_pty_control` can
  keep authenticating with the env `TURMA_TOKEN`: the file always equals it.
  - `_spawn_pty_host` records `sess["ttydTokenFp"]` like the Linux launch does; without it nothing
    could tell a roll had moved the token under a surviving pty-host.
  - A pty-host whose state carries no `authTokenFile` predates this and can NEVER match again — the
    terminal 401s, the ws upgrade is refused, AND `capture`/`inject`/`kill` all fail while its pid
    stays alive and the session reports `running` forever. That zombie is strictly worse than a
    stopped session, so it is torn down and Restart rebuilds it.
- **`_pty_teardown` removes the state file ONLY once the pid is confirmed gone** (it returns False
  otherwise). The state file is the only handle to a pty-host — there is deliberately no in-memory
  registry — so dropping it after a kill that did not take loses the process permanently: `_pty_alive`
  reads False, `_pty_control` finds no port, `_kill_ttyd` no-ops, and the orphan keeps claude.exe alive
  in the worktree and its `ttydPort` bound.
- **`_pty_spawn_and_wait` waits for the old terminal port to be RELEASED before rebinding it**, as the
  Linux ttyd relaunch does; and it refuses to launch only while that port is demonstrably still held.
  **The port is the authority, not the pid** — Windows recycles pids aggressively, so refusing on a
  state-file pid alone would strand a session forever.
- **The pty-host STATE FILE is the single source of truth — there is NO in-memory registry.** Every
  terminal helper (`_capture_pane`/`_type_into_pane`/`_tmux_alive`/`_pane_send_keys`) resolves the
  session from `<REGISTRY_DIR>/pty-hosts/<tmuxName>.state.json` (`{pid, ctrlPort, termPort}`) keyed by
  the same `tmuxName` the Linux path passes around. So **resume-on-boot ADOPT is FREE**: a surviving
  detached pty-host is reached by reading its state file — the adopt path needs no reattach code (the
  qwen/dsh tail analog does not apply; the pty-host is stateless-per-op from the manager's side).
- **The control channel is a PURE-PYTHON RFC 6455 client** (`_ws_control_rpc`/`_pty_control`, stdlib
  socket/struct/base64/hashlib — no `ws` dep on the Python side), one connect per op like the per-op
  `tmux` subprocess it replaces. `inject`/`capture`/`alive`/`resize`/`kill` are the tmux-CLI ops. It
  authenticates with `TURMA_TOKEN or 'changeme'` = the pty-host's `--auth-token` = ttyd's `-c` token,
  so nothing hub-side changes (`.claude/rules/windows-terminal.md`).
- **A control op ON THE BEAT takes `PTY_CONTROL_BEAT_TIMEOUT_SEC` (1.5s), not the 5s teardown budget**,
  and `_pane_status` takes ONE capture for busy + mode + prompt (a second only on the busy->idle edge).
  Unlike Linux's `tmux capture-pane` subprocess, each capture here is a TCP connect + RFC 6455
  handshake, and the old shape was three at 5s per session: times `MAX_SESSIONS` that is 90s against
  the hub's 75s `OFFLINE_AFTER_MS`, flapping a healthy host offline — the CLAUDE.md beat-loop contract.
  A missed capture just reads "can't tell", which the transcript-freshness fallback already handles.
  Tests: `TestBeatLoopBudget.test_pane_capture_worst_case_fits_under_the_offline_threshold`.
- **A MULTI-LINE composer send must DELAY the Enter after the paste** (`_pty_inject`,
  `PTY_SUBMIT_SETTLE_SEC`). Claude Code collapses a multi-line bracketed paste into a
  `[Pasted text +N lines]` chip, and an Enter that races that collapse is ABSORBED — the message
  lands in the composer but is never submitted ("it gets typed into the terminal chat but not
  actually sent"; bites attachment sends, whose `attachment_message` is always multi-line). Measured
  on real Claude Code 2.1.270 over fresh sessions: immediate Enter submitted 0-1/4, a ~0.4s-settled
  Enter 6/6. The Linux tmux path never hit this because its SEPARATE `send-keys Enter` subprocess
  spawn already interposed that delay; the Windows control channel is a fast loopback call. So
  `_pty_inject` settles before the Enter and, if the `[Pasted text` chip is still showing and no turn
  has started, Enters again (bounded, `PTY_SUBMIT_MAX_RETRIES`). A SINGLE-line paste doesn't collapse
  and keeps the immediate-Enter fast path. **Do NOT "simplify" to an atomic paste+`\r` in one inject
  (`submit:true`)** — that removes the settle and submitted 0/4. Tests: the `_pty_inject` cases in
  `TestWindowsTerminalBackend`.
- **`_launch_tmux` translates its POSIX shell command into argv + an env dict** on Windows (node-pty
  spawns claude directly, no shell): the `VAR=x` env-assignment prefix → env entries; the failover
  `set -a; . <local-model.env>` → `_read_env_file` merged into the env dict (the gateway credential
  stays OFF the command line, as the source kept it); the claude flags → portable argv, the initial
  prompt a positional after `--`. Keep `--settings` (wires the guard + AskUserQuestion bridge).
- **`_windows_claude_launcher` resolves `.exe` (argv-spawn) vs `.cmd` (`cmd.exe /c claude`)** via
  `shutil.which` (PATHEXT). The npm shim is not CreateProcess-spawnable, hence the `cmd.exe` wrap.
- **`capture` returns the RENDERED screen grid** (`TerminalGrid`, XERK-703), so `_busy_from_capture`'s
  `esc to interrupt` scan reads the persistent footer exactly as on Linux — NOT the raw ring, whose
  byte-time-tail loses Claude's paint-once footer mid-turn and read a working session IDLE (the
  false-idle that fired the "you have uncommitted work" nudge). Details + the pane-drive keystroke map
  (`_pane_send_keys`: Escape/BTab/Up/Down/… → terminal bytes for interrupt/set_mode/set_model/
  answer_pane_prompt) in `windows-terminal.md`.
- **Deps + lay-down are `install.ps1`'s** (node-pty + ws into `<base>\win\node_modules`, beside
  `pty-host.mjs` at `<base>\win\`). Detached spawn = `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP`
  (KillMode=process analog); `start_new_session` on POSIX lets the forkpty backend exercise the path.
- **A Windows-portability change on the paths/permissions/state-dir/liveness side must still NOT grow
  a SECOND OS branch into these call sites** — extend the existing `IS_WINDOWS` dispatch instead.
- Tests: `TestWindowsTerminalBackend`/`TestWindowsTerminalBackendManager` (mock `IS_WINDOWS`: framing,
  the shell→argv/env translation, every call-site dispatch). Host-proof (need node-pty, CI-excluded):
  `agent/win/drive.mjs` (the pty-host, 24/24 on real ConPTY) and `agent/win/pty-control-drive.py` (the
  manager's control client against a real pty-host); the Python client is also proven cross-language
  against the real `ws` + `tty-protocol.mjs` control server.

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

### A POSIX DIRECTORY mode (0o700) LOCKS OUT the session on Windows — uploads (XERK-234)

- **`UPLOAD_DIR_MODE = 0o777 if IS_WINDOWS else 0o700`; NEVER pass `mode=0o700` to `os.makedirs` for
  a dir the SESSION must read.** Since Python 3.13 `os.mkdir` TRANSLATES a POSIX dir mode into an
  explicit ACL that BLOCKS inheritance, so a 0o700 dir grants ONLY its owner (+ SYSTEM/Admins). The
  native agent runs ELEVATED (its dirs are owned by `BUILTIN\Administrators`) while the Claude/pty-host
  session runs as the interactive user via the scheduled-task launch (XERK-668) — a DIFFERENT,
  non-elevated identity — so every attachment landed in a dir that identity could not read and the
  session reported "I can't view the file". The inheriting mode keeps the profile's ACL (which grants
  the interactive user). Verified on-host: `~/.turma/pty-hosts` (elevated-created, DEFAULT mode) IS
  readable by the session; a 0o700 upload dir is DENIED.
- **This is DIRECTORY-only. Files (`_write_new_file`, 0o600) inherit correctly** — measured: `os.open`
  with a mode does not emit the inheritance-blocking SD that `os.mkdir` does. So only the makedirs mode
  changed.
- **`ensure_upload_dir(path)` is the one choke point** for both `_store_uploads` and
  `_store_ticket_attachments`: makedirs at `UPLOAD_DIR_MODE`, then on Windows HEAL a PRE-EXISTING dir
  an older agent created 0o700 (`_restore_dir_inheritance_windows` → `icacls /reset /T`) — a live
  session survives an agent update (`resume_on_boot` adopts it), so its pre-fix dir would otherwise
  stay unreadable forever. Best-effort, never raises; the elevated agent owns the dir so it can rewrite
  the ACL. No-op on POSIX (`existed` gates on `IS_WINDOWS`). Tests: the `ensure_upload_dir` /
  `_restore_dir_inheritance_windows` cases in `TestWindowsPortability`.

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
  SIGUSR1, so registering the handler raised. SIGTERM/SIGINT exist on Windows and stay unguarded.
- **The "beat now" poke is a LOOPBACK LISTENER on Windows, not a no-op** (`_start_poke_listener`,
  gated as the `else` of the SIGUSR1 install). Leaving it a no-op meant EVERY hub command (a composer
  Send, an answer, a model/mode switch, the chat's `/history` load) waited up to a full
  `TURMA_INTERVAL` (20s) for the next scheduled beat — the terminal/chat/submit "instability" on
  native Windows hosts. The manager binds an ephemeral `127.0.0.1` port, publishes it atomically to
  `POKE_PORT_FILE` (`~/.turma/poke-port`, matching `REGISTRY_DIR`), and sets the same `_poke` Event
  the SIGUSR1 handler does on any connection whose payload equals `TURMA_TOKEN` (a shared-secret gate
  — the loopback analog of SIGUSR1's same-uid send permission; an UNSET token accepts any poke). The
  tunnel dials it in `pokeWindows` (`tunnel-agent.js`). Best-effort throughout: a bind/publish/connect
  failure only costs the poke, never the beat. Tests: `TestPokeListener` (real socket, token gate),
  the Windows arm of `TestWindowsManagerBoot` (listener started instead of SIGUSR1).
- **The subscription-limits probe RUNS on Windows via the ConPTY pty-host** (XERK-704, superseding the
  XERK-678 no-op). It needs a real interactive claude on a TTY (print mode never invokes a statusLine),
  which tmux gave POSIX; on Windows `_run_limits_probe_windows` runs the SAME throwaway probe claude in
  a pty-host (the XERK-668/697 terminal layer) with an EPHEMERAL terminal port nobody proxies
  (`--term-port 0`), answers the trust-folder modal (below), polls the same snapshot
  (`_await_limits_snapshot`), and tears it down (`_kill_limits_probe` → `_pty_teardown`). Without it a
  native Windows host reported no `limits` block and its Claude subscription showed no usage card — the
  OPPOSITE degradation from the cc-socks sweep, since a whole subscription's card vanishes. `os.getuid`
  and the `/proc` reads stay unreached on Windows behind their existing `/proc/self` guard.
  - **The probe must NAVIGATE the trust-folder modal, never blind-Enter it** (XERK-704 follow-up). An
    INTERACTIVE claude in REGISTRY_DIR opens "do you trust the files in this folder?" on a host that
    hasn't trusted that dir (print-mode helpers never do), and on Claude Code 2.1.266 its DEFAULT is
    "No, exit" with "Yes, I trust this folder" one option below — so a single Enter SELECTS EXIT and the
    turn never runs (`rate_limits` never populate, the statusLine never fires, `limits.json` never
    written — the whole "no rate limits before the timeout" symptom on a fresh host). `_answer_trust_dialog`
    reads the rendered pane, finds the cursor (`❯`) line and the accept-option line, and STEPS the
    cursor to accept before Enter (default-position-agnostic); it no-ops when there is no modal (an
    already-trusted dir just runs the positional prompt). **BOTH probe paths POLL for it** over a
    startup window (it lags claude's cold start) — the ConPTY path and, since XERK-709, the Linux tmux
    path (`_run_limits_probe`), which previously blind-Enter'd and only worked because current Linux
    hosts trusted `~/.turma` long ago when the default was "Yes"; a FRESH Linux host hit the same
    "No, exit" modal. `_answer_trust_dialog` is OS-general (`_capture_pane`/`_pane_send_keys` dispatch
    per-OS), so the two paths share it verbatim. Verified against real Claude Code 2.1.263 on Linux.
  - **`_pty_spawn_and_wait` is the ONE ConPTY-spawn choke point** — session launch (`_spawn_pty_host`)
    and this probe both go through it (detached spawn via the one-shot Scheduled Task, wait for bound
    ports, reap on timeout), so neither grows a second copy. Do NOT re-inline the spawn dance.
- Tests: `TestReadUntrustedJson` (the FIFO refusal proves the guarded `os.open` still works),
  `TestWindowsManagerBoot` (SIGUSR1 installed on POSIX, skipped under mocked `IS_WINDOWS` — inverting
  the guard must fail a test), the Windows probe cases in `TestLimitsSnapshot`
  (`test_the_probe_runs_in_a_pty_host_on_windows`, `test_a_windows_probe_that_cannot_launch_backs_off`,
  `test_kill_limits_probe_tears_down_the_pty_host_on_windows`), and `TestAnswerTrustDialog` (navigate to
  accept over the verbatim 2.1.266 modal, cursor-already-on-accept, ANSI ring, no-modal/empty no-ops).

## Liveness & degradation (already hold — do not regress)

- **`_pid_alive` must NOT use `os.kill(pid, 0)` on Windows — it is an unreliable, version-dependent
  liveness probe there** (XERK-701). On POSIX `os.kill(pid, 0)` is a signal-less probe. On Windows
  how it fails depends on the CPython version: on older CPython `os.kill` maps to
  `TerminateProcess(handle, sig)` for every signal but `CTRL_C_EVENT`/`CTRL_BREAK_EVENT`, so signal 0
  *terminates* the target (exit code 0); on Python 3.14 (the MAXAI-WIN host, gh-58685) signal 0 no
  longer terminates but the call still opens the process for access it can be DENIED on a detached,
  task-engine-parented pty-host, so it raises and misreports the live process as dead. Either way
  `resume_on_boot`'s adopt-vs-resume check read the surviving pty-host as dead (and on the
  terminating CPythons killed it), so a restart resumed from scratch instead of adopting
  (host-verified: before the fix a restart RESUMED, after it ADOPTS, pids identical). The Windows
  branch opens a minimal `SYNCHRONIZE` handle and reads whether the process object is signaled
  (`WaitForSingleObject(h, 0)`: `WAIT_TIMEOUT` == alive; `ACCESS_DENIED` on open == alive), delivering
  nothing on any version. The POSIX branch keeps the `os.kill(pid, 0)` probe. **Never collapse the two
  back into one `os.kill`-based definition** — guarded by `test_windows_pid_alive_does_not_use_os_kill`.
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
