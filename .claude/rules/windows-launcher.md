---
paths:
  - "agent/native/windows/**"
  - "agent/tests/test_turma_agent_ps1.ps1"
---

# `agent/native/windows/` — native (no-WSL) Windows shell layer

The Windows port of the bash `agent/native/` shell layer, epic XERK-666. **Decisions +
rationale (D1-D5, the terminal spike, open questions) are in `docs/windows-agent-adr.md`** — read
it for *why*; this file is the rules. The shared runtime (`hub-agent.py`, `tunnel-agent.js`) stays
ONE cross-platform codebase (ADR D5); nothing here forks it. The `hub-agent.py` half of the
Windows port (paths, `%APPDATA%`, icacls, liveness/degradation — XERK-670) is `windows-agent.md`.

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
- **`turma-agent-update` + "every start is an update check"** — a Windows updater child. The bash
  launcher's update block has no analogue here yet.
- **Windows INSTALL/packaging** (winget + npm + bundled WinSW, ADR D3) — the installer child. The
  Linux `install.sh`/`release.yml`/`turma-agent-update` do NOT lay these files down, so the
  `agent-native.md` "new sibling in all three packaging paths" rule does not apply until that child
  builds the Windows installer.

### Manager-side Windows gaps this launcher surfaces (NOT fixed here)

`hub-agent.py`'s own Windows portability is XERK-670 (`windows-agent.md`); the tunnel is its own
pass. This launcher exports the correct pid regardless.

- **The tunnel's `pokeHeartbeat` uses `process.kill(pid, "SIGUSR1")`; Windows Node has no POSIX
  signals**, so that call would terminate the manager rather than poke it. Making the poke a no-op /
  named-event on Windows is `tunnel-agent.js`'s portability pass.
- **`hub-agent.py`'s `SIGUSR1` handler + other Unix seams** (tmux CLI, `os.setsid`, `/proc`) are the
  `IS_WINDOWS` dispatch in `windows-agent.md` (XERK-670) and the `TerminalBackend` seam (XERK-668);
  the launcher does not touch the shared runtime.
