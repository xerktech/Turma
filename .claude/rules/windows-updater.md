---
paths:
  - "agent/native/windows/turma-agent-update.ps1"
  - "agent/native/windows/bootstrap.ps1"
  - "agent/tests/test_turma_agent_update_ps1.ps1"
  - "agent/tests/test_bootstrap_ps1.ps1"
---

# Windows self-updater and bootstrap (`turma-agent-update.ps1`, `bootstrap.ps1`)

Split out of `windows-launcher.md` (size ceiling).

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
  install dirs, else `winget install Microsoft.PowerShell` then re-probe.
  - **winget is NOT assumed present (XERK-678).** It ships as part of App Installer, which a Server
    image or a stripped/older Windows install can lack — a winget-only path DEAD-ENDED there on a
    manual step, breaking the "clean-machine one-liner" DoD. `Install-PwshViaMsi` is the winget-less
    fallback: resolve the latest PowerShell MSI for this host's `$env:PROCESSOR_ARCHITECTURE` (x64/
    arm64; unknown → x64) from the PowerShell repo's `releases/latest`, download it, and `msiexec
    /i /quiet /norestart`. The msiexec call is behind `Invoke-MsiInstall` so the POSIX suite drives
    the resolve+arch+download logic without a real installer (msiexec/winget themselves stay host
    proof). A non-0/3010 exit (a non-elevated shell → 1603) is a reported FAILURE, then the clear
    manual-install Die — never a silent success. Everything else (git/node/python/gh/claude/service)
    stays `install.ps1`'s job.
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
