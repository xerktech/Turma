# Native Turma agent — Windows (no WSL)

Runs the Turma per-host agent **natively on Windows**, with no WSL and no Docker —
the Windows twin of `agent/native/README.md` (WSL/Linux). Same session model,
heartbeat, worktrees, and Jira/PR/usage features; the agent connects **purely
outbound** to the hub, so it works from any network with no inbound exposure.

Epic XERK-666. The design and its rationale (why native, why a pty-host instead
of `tmux`+`ttyd`, the open questions) are in
[`../../docs/windows-agent-adr.md`](../../docs/windows-agent-adr.md); the
component-by-component invariants are in the `.claude/rules/windows-*.md` files
(mapped from `.claude/rules/agent-native-windows.md`). This file is the operator
guide.

## What runs

The shared runtime is ONE cross-platform codebase — the same `hub-agent.py` +
`tunnel-agent.js` + `hooks/` the Linux host runs, never a fork. Windows replaces
only the OS-shell layer around it:

- **The PowerShell launcher** (`windows/turma-agent.ps1`) — validates config,
  idles on a missing Claude login, supervises the reverse tunnel, starts the
  manager, and runs the auto-update poller.
- **A WinSW service** (`windows/turma-agent.xml`) supervising that launcher, with
  `windows/turma-agentctl.ps1` as the control surface (`start`/`stop`/`restart`/
  `status`/`logs`).
- **A per-session pty-host** (`agent/win/`, ConPTY via `node-pty`) that replaces
  the Linux `tmux`+`ttyd` stack and serves the exact surface the hub already
  proxies — so nothing hub-side changes.

## Quick install (one pasted line)

Open the built-in **Windows PowerShell** (5.1 — you do NOT need PowerShell 7
first) and paste:

```powershell
irm https://raw.githubusercontent.com/xerktech/turma/main/agent/native/windows/bootstrap.ps1 | iex
```

`bootstrap.ps1` resolves the newest windows-native release asset, sha256-verifies
it, unpacks it, and hands off to the `install.ps1` inside it. The one prerequisite
the front door owns is **PowerShell 7** itself (the installer runs under 7, and an
installer cannot provision its own interpreter): if 7 is missing it installs it
via `winget`, then re-runs the installer under it. Everything else — git, Node,
Python, `gh`, `claude`, WinSW, the pty layer's `node-pty` — is `install.ps1`'s job.

A piped `iex` cannot forward options. To pass any, use the call form (the Windows
analog of `bash -s -- …`):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/xerktech/turma/main/agent/native/windows/bootstrap.ps1))) -Verify
& ([scriptblock]::Create((irm .../windows/bootstrap.ps1))) -Prefix 'D:\turma' -NoInstallDeps
```

Or, from a repo checkout / an extracted release asset, run the installer directly
under PowerShell 7:

```powershell
pwsh -File .\install.ps1
# options: -Prefix DIR  -NoInstallDeps  -Verify  -Uninstall
```

Like the Linux front door, both resolve by the **asset's own filename version, not
the release tag** — a release carries an unchanged build forward under its original
older name, so the newest tag does not always name the newest asset.

Default install prefix is `%LOCALAPPDATA%\turma-agent`; config is
`%APPDATA%\turma-agent\turma-agent.env`.

## Configure

Edit `%APPDATA%\turma-agent\turma-agent.env` (written once, with an owner-only NTFS
ACL — it holds a token; a re-install never overwrites an operator-edited value):

- **`TURMA_URL`** — the hub's public URL.
- **`TURMA_TOKEN`** — this host's agent credential. Set it to the hub's shared
  `TURMA_AGENT_TOKEN` to start, then move it onto this host's OWN derived token
  (see **Onboarding** below). A derived token is tied to `DEVICE_NAME`, so the two
  must agree — re-derive if you change the device name.
- **`DEVICE_NAME`** — the hub keys the agent by it; defaults to `%COMPUTERNAME%`.
- **`TURMA_AGENT_SELF_ENROLL`** — set to `1` for zero-touch onboarding: on every
  start the agent rolls itself onto its derived token (idempotent, best-effort — a
  hub too old or any failure just leaves it on the current token). Off by default.
- Leave **`REPOS_ROOT`** / **`CLAUDE_PROJECTS_ROOT`** blank to accept the
  profile-relative defaults (`%USERPROFILE%\git`, `%USERPROFILE%\.claude\projects`).

## Log in

- **`claude /login`** on this host — **required**. Remote Control needs a
  subscription OAuth login; the agent idles until Claude Code has credentials.
- **`gh auth login`** — for private git and `gh pr create`.

## Service

The agent is supervised by a **WinSW service**; drive it with the control surface
(paths are under the install prefix's `bin\`):

```powershell
turma-agentctl.ps1 start | stop | restart | status | logs
```

- **`restart` is session-preserving.** It reaps only the CONTROL PLANE — the
  launcher, the manager, the tunnel + its supervisor — and NEVER the detached
  per-session pty-hosts, which survive and are re-adopted on the next boot. So a
  restart (including one the updater triggers) does not drop running sessions; the
  web UI briefly disconnects and reconnects once the manager is back.
- **`stop` leaves sessions running** — like "kill keeps the worktree", stopping the
  service orphans the detached pty-hosts; a later `start` re-adopts them.
- When no service is installed, the same commands fall back to a pidfile-managed
  background launcher (the pidfile lives in `%USERPROFILE%\.turma`, not `%TEMP%`).

## Onboarding onto the per-host token

Moving a host from the shared master onto its own derived token (XERK-268/578) is
**one action** — any of:

- **From the dashboard** — the host header shows `⚠ shared token` while it rides the
  master; click **Roll token**. The hub pushes the derived token over the existing
  command tunnel; the agent writes it here atomically and does a session-preserving
  restart to adopt it. The chip clears when it beats back bound — that IS the
  verification (a bound host shows no chip).
- **On the host** — `turma-agentctl.ps1 enroll`: fetches this host's derived token
  from the hub (authenticated with the current token), persists it, and restarts.
  Idempotent; refuses to write a token for the wrong `DEVICE_NAME`.
- **Automatically** — `TURMA_AGENT_SELF_ENROLL=1` self-rolls on the next restart.

All are inert once the hub sets `TURMA_AGENT_STRICT` (the fleet is bound by then),
and none hands out more than a master holder could already mint.

## Auto-update

WinSW has no timer, so **the launcher runs the update poller** (`Invoke-UpdateChecks`)
— it fires an on-start check and then polls every `TURMA_UPDATE_INTERVAL`, covering
both the service and pidfile paths. When a newer build ships it downloads +
sha256-verifies the asset, swaps the files, and does a session-preserving restart.

- It compares the **component version in `manifest.json`, never the release tag** —
  a carried-forward release is a no-op. The Windows component key is
  **`agent-windows`** and the asset is **`turma-agent-windows-v<version>.zip`** (+ a
  `.zip.sha256` sidecar); this name is the shared contract with `bootstrap.ps1` and
  CI packaging.
- **Claude Code** is updated too, but **only at agent start**, never on the poller —
  replacing the package leaves `claude` briefly off PATH, and a session launched in
  that window would die; at start nothing is launching yet. **Restarting the agent
  is how a host takes a new Claude Code**; `turma-agent-update.ps1 -ClaudeOnly` does
  it by hand.
- Pin either with `TURMA_CLAUDE_AUTO_UPDATE=0` (Claude Code) or `TURMA_BOOT_UPDATE=0`
  (both start checks) in the config. Force one any time with
  `turma-agent-update.ps1` (or `turma-agentctl.ps1 update`).

## Verify / uninstall

```powershell
pwsh -File .\install.ps1 -Verify      # files, tools, config, service, login — a status table
pwsh -File .\install.ps1 -Uninstall   # removes the prefix + service; preserves config, ~/.turma, ~/.claude
```

`install.ps1` is not copied into the prefix, so on a one-liner install these run
through `bootstrap.ps1` (the call form above with `-Verify` / `-Uninstall`); both
act on the existing prefix, not the asset they arrive in. `-Uninstall` warns that
the detached pty-hosts outlive it (they broke out of the service job) and are
re-adopted on the next install's boot — it does not sweep them.

## Known limitations (graceful degradation)

Windows has no Docker container and no `tmux`, so a few host-card facts degrade the
same way the appliance/WSL hosts do — none affects sessions or per-session restart:

| Surface | On native Windows | Why |
|---|---|---|
| **Container-log tail** | Empty (`LOG_TAIL_UNAVAILABLE`). | No Docker container to `docker logs`; the manager runs as a WinSW service. |
| **`startedAt` / card Uptime** | The **manager's** start time, so Uptime reads as manager uptime and an update restart resets it. | No container `StartedAt`. The hub's restart-loop alert still keys on a changing `startedAt`, so a crash-looping manager is still caught. |
| **`DEVICE_NAME`** | Explicit; defaults to `%COMPUTERNAME%`. | No container, so the docker/SMB auto-detection the container host had isn't available. |
| **Terminal clipboard + truecolor** | **Work natively — nothing to configure.** | With no `tmux` in the middle, the pty-host passes the app's 24-bit color and its OSC 52 copy escape straight through to xterm.js. The WSL/Linux `tmux.conf` clipboard/`Ms` chain existed only to undo `tmux`'s dropping of OSC 52; there is no `tmux.conf` to merge here. |
| **Lifetime** | Persists across logout as a Session-0 service. | Unlike the WSL agent (which lives only while the distro runs and can idle-stop), the WinSW service keeps the agent up. |

Cloud CLIs (aws/az/terraform) and the Android toolchain are not provisioned — a
session needing those requires the host to provide them, exactly as on the Linux
native install.
