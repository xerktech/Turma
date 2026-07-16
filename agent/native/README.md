# Native Turma agent (WSL / Linux, no Docker)

Runs the Turma per-host agent **directly on the host**, reusing its built-in
tooling, instead of the `ghcr.io/xerktech/turma-agent` container. Good for a WSL
box (or any Linux desktop) that already has git, node, python, and a logged-in
Claude — you skip the 2–7 GB image and everything lands owned by your own user.

It runs the exact same `hub-agent.py` + `tunnel-agent.js` + hooks as the image;
this directory only adds the launcher, installer, service, and self-updater. The
agent connects **purely outbound** to the hub, so it works from any network with
no inbound exposure.

## What it is / isn't

- **Same** session model, heartbeat, worktrees, Jira/PR/usage features as the
  container.
- **Not** installed: the cloud CLIs (aws/az/terraform) and PowerShell the image
  bundles — a session that needs those should use the Docker image. `gh` is
  installed (needed for auto-update on a private repo and for private git/PR).

## Prerequisites (auto-installed)

`install.sh` ensures these, installing any that are missing:

| Tool | How | Needs sudo |
|---|---|---|
| git, tmux, ripgrep, ncurses-term, python3, curl | apt | yes |
| Node ≥ 22 (`tunnel-agent.js` needs the global `WebSocket`) | NodeSource, or keeps yours | yes |
| ttyd (pinned 1.7.7 static, or apt) | download/apt | download: no |
| claude (`@anthropic-ai/claude-code`) | npm -g | no |
| gh | apt | yes |

Run with `--no-install-deps` to skip all of that and only lay down files.

## Install

```sh
./install.sh                 # from a repo checkout or an extracted release tarball
# options: --prefix DIR  --no-install-deps  --autostart  --verify  --uninstall
```

Default install prefix is `~/.local/share/turma-agent`; config is
`~/.config/turma-agent/turma-agent.env`.

## Configure

Edit `~/.config/turma-agent/turma-agent.env` (created `chmod 600` — it holds a
token):

- **`TURMA_URL`** — the hub's public URL.
- **`TURMA_TOKEN`** — must equal the hub's `TURMA_AGENT_TOKEN`.
- **`DEVICE_NAME`** — seeded to `$(hostname)`; the hub keys the agent by it.
- Leave `REPOS_ROOT` / `CLAUDE_PROJECTS_ROOT` **blank** to accept the
  HOME-relative defaults (`$HOME/git`, `$HOME/.claude/projects`).

## Log in

- `claude /login` on this host — **required**. Remote Control needs a
  subscription OAuth login; the agent idles until `~/.claude/.credentials.json`
  exists.
- `gh auth login` — for private git and `gh pr create`.

## Service

- **systemd** (WSL with `[boot] systemd=true` in `/etc/wsl.conf`): a `--user`
  unit, enabled with lingering so it survives logout.
  - `systemctl --user status turma-agent`
  - `systemctl --user restart turma-agent` — preserves running sessions (see below)
- **No systemd**: the nohup fallback.
  - `turma-agentctl start | stop | restart | status | logs`
  - `--autostart` adds a guarded launch line to `~/.bashrc`.

## Auto-update

The agent polls the GitHub Releases (via your `gh` login), and when a newer
native build ships it downloads + checksum-verifies it, swaps the files, and
restarts the manager. **Running sessions are not stopped** — the tmux/claude
processes keep running; the web UI briefly disconnects and reconnects once the
manager is back. Driven by a systemd timer (every 6h), or the
`turma-agent-update --loop` poller on non-systemd hosts. Force a check with
`turma-agent-update` (or `turma-agentctl update`).

It reads the unified release stream: each `v<MAJOR>.<MINOR>.<PATCH>` release
carries a `manifest.json`, and the updater compares the manifest's **agent-native
component version** against the installed one — never the release tag, since a
release can carry an unchanged (older) native build under a newer tag. The asset
is fetched by the exact name and release the manifest records. If no unified
release exists (a rollback, or before the cutover) it falls back to the legacy
`agent-native-v*` stream, so a host self-updates correctly either way.

## Verify / uninstall

```sh
./install.sh --verify       # files, tools, config, service, login — a status table
./install.sh --uninstall    # removes $PREFIX + units; preserves config/~/.turma/~/.claude
```

## Known limitations (graceful degradation)

- **No container self-inspect** — the heartbeat's container-log tail and the
  restart `StartedAt` are empty (`docker inspect/logs` aren't there). Sessions
  and per-session restart are unaffected.
- **`DEVICE_NAME` is explicit** — the container's docker/SMB auto-detection is
  gone; the launcher defaults it to `$(hostname)`.
- **Lifetime** — the agent lives only while the WSL distro is running. Windows
  may idle-stop the distro after the last shell exits despite lingering; there's
  no Docker-daemon-under-a-Windows-service to keep it up.
- **tmux colors** — the web terminal's truecolor/passthrough needs the bundled
  `tmux.conf` at `/etc/tmux.conf` or `~/.tmux.conf`. The installer won't clobber
  an existing `~/.tmux.conf`; if colors look flat, add the two lines it prints.
- **Manual `stop` leaves sessions running** — like the container's "kill keeps
  the worktree", stopping the service orphans the tmux/ttyd (a later `start`
  re-adopts). `--uninstall` prints how to sweep them.
