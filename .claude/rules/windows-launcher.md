---
paths:
  - "agent/native/windows/**"
  - "agent/tests/test_turma_agent_ps1.ps1"
  - "agent/tests/test_turma_agentctl_ps1.ps1"
  - "agent/tests/test_install_ps1.ps1"
  - "agent/tests/test_bootstrap_ps1.ps1"
---

# `agent/native/windows/` — native (no-WSL) Windows shell layer

The Windows port of the bash `agent/native/` shell layer, epic XERK-666. **Decisions +
rationale (D1-D5, the terminal spike, open questions) are in `docs/windows-agent-adr.md`** — read
it for *why*; this file is the rules. The shared runtime (`hub-agent.py`, `tunnel-agent.js`) stays
ONE cross-platform codebase (ADR D5); nothing here forks it. The `hub-agent.py` half of the
Windows port (paths, `%APPDATA%`, icacls, liveness/degradation — XERK-670) is `windows-agent.md`.

This file covers the LAUNCHER (`turma-agent.ps1`, XERK-669), the SERVICE + CONTROL SURFACE
(`turma-agent.xml` + `turma-agentctl.ps1`, XERK-671), the INSTALLER (`install.ps1`, XERK-672) and
the `irm | iex` FRONT DOOR (`bootstrap.ps1`, XERK-673).

## `turma-agent.ps1` — the launcher (XERK-669)

PowerShell port of the LAUNCHER ROLE of `agent/native/turma-agent`. Same job, same invariants —
`.claude/rules/agent-native.md`'s launcher bullets are the contract, translated onto Windows:

- **Config is VALIDATED before use; a bad one IDLES, never exits.** An exit reads to the service
  manager (WinSW) exactly like a crash worth restarting — the invisible crash-loop the whole
  discipline exists to prevent. `-Preflight` is the one exception (exits 1, loads nothing). The
  report carries line numbers + key names, **never values** (the file is ACL'd owner-only and holds
  `TURMA_TOKEN`/`JIRA_TOKEN`). The launcher PARSES the env file (does not source it), so a
  YAML-style `KEY: "x"` line is inert rather than an executed command — but the SAME validation is
  kept, because the file format is shared with the bash/systemd hosts.
- **Idle = `Enter-Idle` (sleep loop), never `exit`.** `Set-StrictMode` is the `set -u` analog; there
  is no `set -e` equivalent (it fights idle-not-exit), so the idle cases are explicit. This includes
  a manager that cannot START (python absent from PATH): idle BEFORE the supervisor is backgrounded,
  so no orphaned tunnel points at a hub with no manager, and self-heal on the next restart.
- **Defaults map onto Windows known folders (ADR D4)**: `CLAUDE_PROJECTS_ROOT` →
  `%USERPROFILE%\.claude\projects`, `REPOS_ROOT` → `%USERPROFILE%\git`, `DEVICE_NAME` →
  `COMPUTERNAME` (the manager reads that as a fallback too). Applied only where the config left a key
  blank.
- **USERPROFILE is the `$HOME` analog and is DERIVED if unset** (`GetFolderPath('UserProfile')`) —
  the Windows twin of the systemd-system-scope "HOME unset" trap that once cost a host its agent for
  7.5 hours. StrictMode would otherwise abort on the first read.
- **The tunnel is SUPERVISED with the node check INSIDE the retry loop** (`-TunnelSupervisor`
  re-entry, `TUNNEL_RETRY_SEC`). Node is a setup-time prerequisite, not a baked layer, so it can be
  genuinely absent; a fire-and-forget check makes a missing node BOTH silent (the manager keeps
  heartbeating → host reads ONLINE) AND permanent (nothing retries). Checking each pass heals the
  terminals within one retry the moment node is installed, no restart.
- **The launcher reaps the supervisor BEFORE the tunnel** (`Stop-ByCommandLine`, prefix-scoped on
  the command line) — the reverse order lets the old supervisor respawn the tunnel just killed.
  Matching uses `Get-Process().CommandLine`, which PowerShell 7 exposes on Windows AND Linux, so the
  behavioural test drives the same code.
- **Exports `TURMA_AGENT_ENV`** (resolved env-file path, so the manager can rewrite this host's
  token — XERK-578) and **`TURMA_MANAGER_PID`** (for the tunnel's heartbeat poke). Bash names `$$`
  up front because `exec` preserves it; Windows has no `exec`, so the launcher starts the manager
  (`Start-Process -PassThru`), exports its pid, THEN backgrounds the supervisor so the tunnel
  inherits the right pid.
- **`TURMA_AGENT_SELF_ENROLL` self-enroll (XERK-675, the Windows half of XERK-578)** — `Invoke-SelfEnroll`
  mirrors the bash launcher's block: when opted in (`1|true|yes|on`, off by default) and the config
  exists, it runs `python hub-agent.py --enroll` (the SHARED fetch+verify+atomic-write+owner-ACL,
  which refuses a token whose name half ≠ this host's `DEVICE_NAME`), then re-reads ONLY `TURMA_TOKEN`
  from the rolled file — re-importing the WHOLE file would reset every blank Windows-relative default.
  BEST-EFFORT: a hub too old (`--enroll` exit 2), a failure, or a `python` that won't run all leave
  the current token in place and never block start. Called from the MAIN run path ONLY (not the
  `-TunnelSupervisor` re-entry or `-Preflight`) and BEFORE the credential idle gate, so a host that
  will idle for a missing Claude login still rolls; the manager + supervisor it starts inherit the
  re-read token, and the supervisor's own `Import-Config` re-reads the rolled file anyway.
- **Roll (design A) needs no launcher code — but its restart does**: the hub pushes `setToken` over
  the tunnel, `hub-agent.py`'s `set_token` atomically rewrites `$TURMA_AGENT_ENV` and requests a
  manager restart, which on Windows is a CLEAN MANAGER EXIT that WinSW-supervises back (the launcher
  `WaitForExit`s the manager and relays its exit code, so WinSW restarts the launcher → a fresh
  manager on the rolled token). The manager-side `IS_WINDOWS` half of that (`_perform_restart` never
  shelling out to the POSIX `turma-agentctl`) is `windows-agent.md`.
- **Puts the per-user tool dir on PATH itself** — `%APPDATA%\npm` (npm's global bin on Windows,
  where `claude.cmd` lands) plus the install prefix's bin. A Windows service without an interactive
  login does not inherit the user's shell PATH, so `claude` is otherwise unreachable and every
  session dies on exec — the exact twin of XERK-94's `~/.local/bin`. A genuinely missing `claude` is
  a loud, log-only warning (self-heals when installed; the dir is already on PATH).
- Tests: `agent/tests/test_turma_agent_ps1.ps1` (a PowerShell-on-POSIX harness with `/bin/sh` stubs,
  run on `ubuntu-latest` like the bash launcher suite). Static analysis: PSScriptAnalyzer with
  `PSScriptAnalyzerSettings.psd1` (the ShellCheck analog). Both gated in `code-scan.yml`.

### What this launcher deliberately does NOT do — each owned by another epic child

Kept out to stay on XERK-669's scope and testable; each is marked in the source where it wires in.

- **The WinSW service that supervises this script** — ADR D2, the service/supervisor child.
- **The per-session pty-host** replacing tmux+ttyd — ADR D1 (the `TerminalBackend` seam, XERK-668).
  `-Preflight`'s tool list is claude/git/node/python (no tmux/ttyd).
- **Windows INSTALL/packaging** (winget + npm + bundled WinSW, ADR D3) — `install.ps1` (XERK-672,
  below). So the `agent-native.md` "new sibling in all three packaging paths" rule now HAS a Windows
  installer path: a new `agent/*.py` sibling that `hub-agent.py` imports must also land in
  `install.ps1`'s `$RuntimeFiles`/`$RuntimeDirs` copy AND its `$VerifyFiles` list.

The self-updater IS wired now (`turma-agent-update.ps1`, XERK-674, below) — the launcher's
`Invoke-UpdateChecks` fires it. Its swap is the FOURTH packaging path in that lockstep (see the
updater section).

### Manager-side Windows gaps this launcher surfaces (NOT fixed here)

`hub-agent.py`'s own Windows portability is XERK-670 (`windows-agent.md`); the tunnel is its own
pass. This launcher exports the correct pid regardless.

- **The tunnel's `pokeHeartbeat` uses `process.kill(pid, "SIGUSR1")`; Windows Node has no POSIX
  signals**, so that call would terminate the manager rather than poke it. Making the poke a no-op /
  named-event on Windows is `tunnel-agent.js`'s portability pass.
- **`hub-agent.py`'s `SIGUSR1` handler + other Unix seams** (tmux CLI, `os.setsid`, `/proc`) are the
  `IS_WINDOWS` dispatch in `windows-agent.md` (XERK-670) and the `TerminalBackend` seam (XERK-668);
  the launcher does not touch the shared runtime.

## `turma-agent.xml` + `turma-agentctl.ps1` — service + control surface (XERK-671)

The Windows equivalent of BOTH the systemd user unit AND the bash `turma-agentctl` nohup fallback
(ADR D2). `turma-agent.xml` is the WinSW descriptor (the systemd-unit analog); `turma-agentctl.ps1`
is the control surface that drives the WinSW SERVICE when installed and a pidfile-managed BACKGROUND
launcher when not — the two-scope shape of the bash `restart_manager`, collapsed to (service /
pidfile). Commands mirror the bash ctl: `start|stop|restart|status|logs`, plus thin WinSW
`install|uninstall` wrappers for the installer child to call.

- **Session-preserving restart is the KillMode=process guarantee, and it reaps the CONTROL PLANE
  only** — the launcher, the manager (`hub-agent.py`), the tunnel + its supervisor — NEVER the
  detached per-session pty-hosts, which survive and are re-adopted on boot (`resume_on_boot`,
  XERK-668). Service path: WinSW restarts the launcher and the pty-hosts' job-object breakaway (ADR
  D2, host-verified) keeps them alive. Pidfile path: reap by command line and simply never name a
  pty-host (`pty-host.mjs` is not a reap needle).
- **A Windows restart MUST reap the MANAGER, unlike the bash restart.** Bash exec's the launcher
  INTO the manager, so `kill <manager-pid>` is the whole restart; on Windows launcher ≠ manager (the
  launcher `Start-Process`es `python hub-agent.py` as a child and `WaitForExit`s it), so killing only
  the launcher pid leaves the python manager running and the fresh launcher starts a SECOND — two
  managers double-heartbeating. `Stop-ControlPlane` reaps the manager by command line for this reason.
- **The supervisor is reaped BEFORE the tunnel** (`Stop-ControlPlane` order), the same ordering the
  launcher uses on every start — else the just-killed tunnel is respawned by its own supervisor.
- **The pidfile lives in a Windows-CORRECT per-user location — `%USERPROFILE%\.turma`, NOT `%TEMP%`.**
  This is the Windows twin of the bash ctl guarding against the never-created `/run/user/<uid>`: a
  Session-0 service identity and the interactive user can resolve `%TEMP%` DIFFERENTLY (and it gets
  swept), so a pidfile the writer and reader disagree on — or one whose write silently fails — lets
  stop/restart miss the pid they must kill and orphan-then-DOUBLE the manager. `Resolve-RunDir`
  prefers a set-AND-usable `TURMA_RUNTIME_DIR` (writability probed, not just `${VAR:-default}`,
  which the bash bug taught does not catch a set-but-unusable value) and falls back to the durable
  `~/.turma`. The pidfile only governs the FALLBACK path; the service path uses machine-global service
  state (`Get-Service`), which no identity divergence touches.
- **`Get-Service` is undefined on Linux pwsh (and throws for a not-installed service)** — caught, so
  `Test-ServiceMode` is false and every command takes the fallback path. This is what lets the POSIX
  test drive the fallback, the same way the bash suite runs with no systemd; the WinSW service path is
  host-verified only.
- **The manager NEVER calls `turma-agentctl.ps1` on Windows.** `_perform_restart` treats `IS_WINDOWS`
  as supervised and exits cleanly for WinSW to restart the launcher (XERK-675, `windows-agent.md`);
  only a bash nohup install self-relaunches through the ctl script. So the ctl is operator- and
  installer-facing only.
- **`start` does NOT spin up the auto-update poller — the LAUNCHER does** (`Invoke-UpdateChecks`,
  XERK-674), which covers both the service and pidfile paths uniformly. Unlike the bash ctl (which
  starts its own `--loop` on the nohup path), this ctl stays out of the updater's lifecycle so a
  session-preserving restart the updater itself triggers cannot kill the poller mid-swap.
- **What the installer child owns, not this task**: bundling WinSW.exe (as `<service>.exe` beside the
  xml), the winget/npm provisioning, the service account, and laying these files down. The xml carries
  `%BASE%`/account placeholders the installer substitutes.
- **The pidfile kill is GUARDED by the same command-line check `status`/`start` use**
  (`Test-PidAlive`) — a crashed launcher leaves its pidfile, and a fast-reused pid could name an
  innocent process (worst case a pty-host); `Stop-ControlPlane` kills only a pid it can confirm is the
  launcher, and clears the stale pidfile regardless. `Read-Pid` `TryParse`s so a corrupt/oversize
  value degrades to "no pid" instead of throwing on a status/stop.
- Tests: `agent/tests/test_turma_agentctl_ps1.ps1` (PowerShell-on-POSIX, the `test_turma_agentctl.sh`
  port) — the `~/.turma` fallback + the runtime-dir trap, the status/stop pidfile round-trip, the
  session-preserving stop/restart (control plane reaped, pty-host left alive, no doubled manager, the
  supervisor actually reaped so a respawning-supervisor fixture's tunnel stays dead), and the
  stale/foreign-pidfile guard (an innocent reused pid survives stop). Static analysis: the same
  PSScriptAnalyzer gate as the launcher. Both in `code-scan.yml`.

## `install.ps1` — the installer (XERK-672)

PowerShell port of `agent/native/install.sh`: idempotent install / `-Verify` / `-Uninstall`. Same
job, translated onto Windows per ADR D3/D4 — read `.claude/rules/agent-native.md`'s `install.sh`
bullets for the contract this mirrors.

- **The Windows-specific actions are `$IsWindows`-GATED so the POSIX suite drives the file logic**,
  the same reason the controller's `Get-Service` is caught and the launcher leaves ConPTY to a host:
  winget/npm provisioning, the icacls ACL, and WinSW registration all no-op off Windows, while the
  lay-down / `-Verify` / `-Uninstall` (pure file ops) run identically. The suite runs `-NoInstallDeps`
  so no provisioning fires. Tests: `agent/tests/test_install_ps1.ps1`.
- **The lay-down keeps hub-agent.py's Python siblings + `hooks/` BESIDE it, or a runtime runs DARK**
  (the XERK-528 class): `$RuntimeFiles`/`$RuntimeDirs` mirror `install.sh`'s UNCONDITIONAL set —
  the two core siblings, `hooks/*.py`, the shared `runtime_projection.py`/`runtime_tail.py`
  scaffolding, and `qwen_session.py`/`qwen_transcript.py` + the `qwen/` tree. **`tmux.conf` and the
  dsh toolchain are NOT carried onto Windows.** Plus the Windows terminal layer (`win/`, ADR D1) and
  the launcher/controller into `bin/`.
- **`install.ps1`'s copy + `$VerifyFiles` list is ONE of the THREE packaging paths that must stay in
  lockstep** (`agent-native.md`'s rule, now with a Windows path) — the Windows updater and the
  release staging are the other two, in their own epic children. A new imported sibling added to only
  one is the silent-dark regression that rule exists to catch.
- **The token/config env file gets an OWNER-ONLY NTFS ACL** (`Restrict-FileToOwner`, the chmod-600
  analog of ADR D4 / `restrict_file_to_owner`): icacls `/inheritance:r /grant:r <user>:F SYSTEM:F`,
  Windows-only and BEST-EFFORT (the bytes are already on disk; a failure warns, never aborts). Config
  lands at `%APPDATA%\turma-agent\turma-agent.env` — the launcher's default and `agent_env_path()`'s
  Windows fallback — written ONCE (a re-run preserves an operator-edited token, never overwrites).
- **The WinSW descriptor is RENDERED, not consumed raw**: `%BASE%` → the real prefix (WinSW's own
  `%BASE%` would be `bin\` and mis-resolve `%BASE%\bin\turma-agent.ps1`), and the placeholder
  `TURMA_AGENT_ENV` value → the real `%APPDATA%` config path. `%USERPROFILE%` in `<logpath>` is left
  for WinSW to expand. Then `turma-agentctl install` + `restart` wires + session-preservingly
  restarts it — the twin of `install.sh`'s `systemctl try-restart`.
- **WinSW is a PINNED download** (`Get-WinSW`, into `bin\<service>.exe` where `turma-agentctl install`
  expects it), the bundled-binary analog of `install.sh`'s static ttyd/glab; a release build may
  bundle it instead. **The pty layer's `node-pty`+`ws` are `npm ci`'d into `$Prefix\win`**
  (`Ensure-PtyLayer`) — node-pty ships Windows prebuilds, so no VS build tools in the common case.
  **A re-lay PRESERVES a built `win\node_modules`** (`Copy-Tree`'s `$Preserve`): the source has
  none, so a naive wipe would destroy the pty deps and — under `-NoInstallDeps` — never rebuild
  them (the terminal dies until a full re-run). Preserving it also skips a needless rebuild on an
  ordinary re-run; stale SOURCE files are still dropped.
- **Source resolution mirrors `install.sh`**: the shared runtime is at `..\..` (agent/) from a repo
  checkout, or BESIDE the script in a release tarball — probed via `hub-agent.py` next to the script.
- **`-Uninstall` removes the prefix + service but PRESERVES config, `~/.turma`, `~/.claude`** — and
  warns that the detached pty-hosts (broken out of the service job) outlive it, re-adopted on the next
  install's boot. It does NOT sweep them (no `KillMode=process` teardown to run).

## `turma-agent-update.ps1` — the self-updater (XERK-674)

PowerShell port of `agent/native/turma-agent-update`. Updates two things on different schedules,
the same safety argument as the bash updater — read `.claude/rules/agent-native.md`'s
`turma-agent-update` bullets for the contract this mirrors. **dsh is NOT carried onto Windows**, so
there is no `--dsh-only` analogue (unlike the bash updater).

- **Entry points**: `-ClaudeOnly` (awaited, before the manager), `-Boot` (rate-limited start check),
  `-Loop` (the periodic poller), `(none)` (one-shot), and the internal `-LockedRun`/`-LockedClaude`
  (Invoke-RunLocked re-execs these under a deadline; the parent already holds the lock).
- **WinSW has no timer, so the LAUNCHER runs the poller** (`Invoke-UpdateChecks` in `turma-agent.ps1`),
  started detached and only if one is not already running for this install — its first pass is the
  on-start agent check AND it polls every `TURMA_UPDATE_INTERVAL`. So it replaces BOTH the bash host's
  systemd `.timer` and the nohup ctl's `--loop`. Claude Code is fired separately, AWAITED + bounded,
  before the manager exists (a mid-install `claude` briefly off PATH would kill a session spawned in
  that window; at start nothing is launching). `TURMA_BOOT_UPDATE=0` opts a host out.
- **Component-version compare against `manifest.json`, never the release tag** — a carried release
  (tag ahead, component unchanged) is a NO-OP; comparing the tag reinstalls every poll and mis-stamps
  VERSION. The Windows COMPONENT key is **`agent-windows`** (`TURMA_MANIFEST_COMPONENT`), the asset
  **`turma-agent-windows-v<version>.zip`** + a `.zip.sha256` sidecar. **This name + component are the
  SHARED contract with the one-command installer (XERK-673, `bootstrap.ps1`) and CI packaging
  (XERK-676, which this task BLOCKS)** — the three must resolve the identical asset; keep them in step.
  The legacy stream (`agent-windows-v*`) is the pre-cutover/rollback fallback (normally finds nothing).
- **The payload swap is the FOURTH lockstep packaging path on Windows** (installer copy, `-Verify`
  list, release staging, updater swap) — it MUST carry `hub-agent.py`'s siblings + `hooks/`, kept in
  lockstep with `install.ps1`'s `$RuntimeFiles`/`$RuntimeDirs` (a new imported `agent/*.py` sibling
  added to only some paths is the silent-dark regression). **The swap DELETES the installed `hooks/`
  before moving the staged one in**, so a payload missing a hook would leave the host with NO guard
  hook — a missing hook command is a non-blocking hook, so the guard fails OPEN while VERSION, the
  restart and the log all report clean. Hence `Install-Payload` REFUSES a payload lacking
  `hub-agent.py` + `tunnel-agent.js` + `hooks/` before it deletes anything. `win/` source is refreshed
  too, PRESERVING the built `node_modules` (node-pty is a binary dep the updater does not rebuild — the
  twin of the bash updater leaving ttyd/tmux to `install.sh`; a lockfile bump is healed by a re-run).
- **sha256-verify before install** (`Test-AndInstall`), atomic file swap via `Move-Item` on the same
  volume (`$Prefix.update` staging is a sibling), VERSION stamp, and the `updating.json` expected-
  restart hint (XERK-29) so the restart reads as `updating`, not an outage. Extraction is
  `Expand-Archive` for the `.zip` asset, `tar` for a legacy `.tar.gz`.
- **Session-preserving restart via the Windows control surface** — `turma-agentctl.ps1 restart`
  (WinSW restarts the launcher, the detached pty-hosts break away and survive; the pidfile fallback
  reaps the control plane and never names a pty-host). NEVER the POSIX `turma-agentctl`.
- **Claude Code: version-COMPARE, repair-and-verify, remember an unhelpful repair** (XERK-254). ABSENT
  and UNREADABLE both go to the same repair, VERIFIED afterwards (`Write-ClaudeInstallReport` reads
  back what the agent now resolves). A repair that leaves the SAME unreadable output is remembered
  (`~/.turma/claude-unparseable`) and not retried until the output changes — earned only by a repair
  that actually ran, else a host restarted mid-repair with no network bricks Claude Code permanently.
  Registry-unreachable / installed-ahead-of-published both stay put. `TURMA_CLAUDE_AUTO_UPDATE=0` pins.
- **The lock is the bash flock design on Windows primitives** (XERK-549 + XERK-551): an exclusively-
  opened `FileStream` (`FileShare None`) is the lock (a second updater's Open throws → contended); a
  .NET file handle is NOT inherited by children, so a hung child never holds it (the bash `9>&-`
  guarantee, for free), and the OS releases it when the holder dies (a crashed holder needs no
  reclaim). Taken PER RUN, released BEFORE the sleep. **Prefix-scoped** (`Get-PrefixTag` = sha256 of
  the resolved `$Prefix`, first 12) tags `update.<tag>.lock`, its `.holder`, and the throttle stamps,
  so distinct installs never share one. **A wedged run cannot hold it forever**: the agent self-update
  re-execs as `-LockedRun` under an overall `TURMA_RUN_DEADLINE` (Start-Process + WaitForExit + Kill
  tree), and a staleness-aware reclaim (holder file = pid+epoch; `TURMA_LOCK_RECLAIM_AFTER`, PID-reuse
  guard on the command line) kills a LIVE wedged holder past the threshold and retakes. A contended
  `-Loop` poll RETRIES after `TURMA_POLL_RETRY_SEC`, never forfeits the whole interval; consecutive
  skips escalate to a WARNING (`update-skip-count.<tag>`, `TURMA_UPDATE_STRAND_WARN_AT`).
- Tests: `agent/tests/test_turma_agent_update_ps1.ps1` (PowerShell-on-POSIX; gh/npm/claude/the restart
  stubbed) — the carried-release no-op, carried asset, checksum refusal, legacy fallback, up-to-date
  no-op, `updating.json` hint, the `hooks/` completeness refusal, prefix-scoped lock, wedged-holder
  reclaim vs. healthy-holder stand-aside, the boot throttle, and the Claude repair-and-remember path.
  A real WinSW service / a real `.zip` release are host-verified by later epic children. Static
  analysis: the same PSScriptAnalyzer gate as the launcher, in `code-scan.yml`.

## `bootstrap.ps1` — the `irm | iex` front door (XERK-673)

PowerShell port of `agent/native/bootstrap.sh`: the one pasted line that resolves the newest
windows-native asset, sha256-verifies it, unpacks it, and hands off to the unpacked `install.ps1`.
Read `agent-native.md`'s `bootstrap.sh` bullet for the contract it mirrors.

- **The windows release asset is `turma-agent-windows-v<version>.zip` + `.zip.sha256`, manifest
  component `agent-windows`** (a SHARED CONTRACT across three tickets): `bootstrap.ps1` (XERK-673)
  and the Windows updater (XERK-674) RESOLVE it; the release packaging (XERK-676) must EMIT exactly
  that name/component (legacy tag prefix `agent-windows-v`). `.zip` not `.tar.gz` so the unpack is
  `Expand-Archive` — built into Windows PowerShell 5.1, no tar dependency.
- **Resolves by the ASSET's own filename version, never the release tag** — the same carried-forward
  trap `bootstrap.sh` documents (a newer umbrella carries an unchanged build under its ORIGINAL older
  name; a tag-derived name 404s). Scans every release's assets, picks the highest `[version]`.
- **It MUST run under Windows PowerShell 5.1.** A clean box has 5.1 (`powershell.exe`), not pwsh 7 —
  nothing has provisioned 7 yet — so `irm | iex` lands in 5.1. Hence 5.1-safe surface ONLY: no
  `$IsWindows`, no ternary/`??`, no StrictMode-Latest reads of Core-only automatics. JSON is
  `ConvertFrom-Json` (built into 5.1 — the Windows "parser-light", vs bash's grep before python).
  Sets TLS 1.2 for the GitHub API (5.1's default can still be refused).
- **The ONE prerequisite this front door owns is PowerShell 7 itself.** `install.ps1` is pwsh-7-only
  (`$IsWindows` under StrictMode Latest), and PowerShell is the INTERPRETER the installer runs under —
  an installer cannot provision its own interpreter (the one chicken-and-egg with no Linux analog).
  `Resolve-Pwsh`: this process if already 7+, else `pwsh` on PATH, else the known Program Files
  install dirs, else `winget install Microsoft.PowerShell` then re-probe; a clear message if winget
  is absent. Everything else (git/node/python/gh/claude/service) stays `install.ps1`'s job.
- **Hands off `install.ps1` as a real FILE under pwsh 7** (`-NoProfile -ExecutionPolicy Bypass -File`)
  so its `$PSCommandPath` source-probe resolves the unpacked tree beside it — the analog of
  `bootstrap.sh` running `install.sh` THROUGH bash. Not copied into the prefix, so a later
  `-Verify`/`-Uninstall` re-runs through this same download+unpack path. It captures passthrough via
  the automatic `$args` (NO param block / `[CmdletBinding()]`, which would REJECT an unknown install
  flag as a binding error), forwarding every option verbatim — the analog of `bash -s -- …`. The temp
  tree is swept on BOTH exits (a normal `finally` AND `Die`'s own sweep, since a refusal exits before
  the `finally` — the parity gap vs `bootstrap.sh`'s `trap … EXIT`); the installer's exit code is relayed.
- **Testable seams**: `Get-ReleaseJson`/`Get-ReleaseFile`/`Resolve-Pwsh` are overridable functions and
  the main body is `Invoke-Bootstrap`, auto-run only when `TURMA_BOOTSTRAP_NORUN` is unset — so the
  suite dot-sources the real script and substitutes those three (there is no PATH-stubbable `curl`
  here, unlike `test_bootstrap.sh`). Tests: `agent/tests/test_bootstrap_ps1.ps1` (newest + carried-
  asset resolution by filename, checksum-mismatch/missing-sidecar refusal, args passthrough, clear
  no-asset/unreachable-API failures). Same PSScriptAnalyzer gate; winget/ConPTY stay host proof.
