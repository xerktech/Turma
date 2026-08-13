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
- **Not** installed: the cloud CLIs (aws/az/terraform), PowerShell, the docker
  CLI, and the Android toolchain (JDK/Gradle/SDK) the image bundles — a session
  that needs those should use the Docker image, or the host must provide them
  itself. `gh` is installed (needed for auto-update on a private repo and for
  private git/PR).

## Prerequisites (auto-installed)

`install.sh` ensures these, installing any that are missing:

| Tool | How | Needs sudo |
|---|---|---|
| git, tmux, ripgrep, ncurses-term, python3, curl | apt | yes |
| Node ≥ 24 (`tunnel-agent.js` needs the global `WebSocket`, Node 22+) | NodeSource, or keeps yours | yes |
| ttyd (pinned 1.7.7 static, or apt) | download/apt | download: no |
| claude (`@anthropic-ai/claude-code`) | npm -g | no |
| gh | apt | yes |

Most of that column says **yes**, so unless you have NOPASSWD sudo the installer
has to ask for your password — see below. Run with `--no-install-deps` to skip
all of it and only lay down files.

## Install

No checkout needed — `bootstrap.sh` fetches the latest native release,
checksum-verifies it, and hands off to the `install.sh` inside it:

```sh
sudo -v && curl -fsSL https://raw.githubusercontent.com/xerktech/turma/main/agent/native/bootstrap.sh | bash
```

The leading `sudo -v` authenticates you once, up front, so the apt prerequisites
in the table above actually get installed. The installer will also prompt on its
own if you skip it, but priming is better: you answer the password prompt while
you are still looking at the terminal, rather than partway through the install.

> **Don't** run it as `curl … | sudo bash`. The install itself must run as **you**
> — it installs into your `$HOME` and wires your systemd **user** service. As root
> it would land in `/root` and run as the wrong user. Only the prerequisites need
> root, and the installer sudo's those individually.

If you have neither sudo nor the prerequisites, the installer says exactly what
is missing and carries on (it's idempotent — install the tool, re-run it). Watch
for a **node** warning in particular: node runs the reverse tunnel, so without it
the agent still comes up and reports online, but every session on the host reads
*"terminal offline"* in the UI. The agent retries for node on its own, so
installing it heals the terminals within seconds — no restart.

Everything after `-s --` is passed straight through to `install.sh`, so the
one-liner supports every option the checkout does:

```sh
sudo -v && curl -fsSL .../bootstrap.sh | bash -s -- --autostart --prefix /opt/turma
```

Or, from a repo checkout / an extracted release tarball:

```sh
./install.sh
# options: --prefix DIR  --no-install-deps  --autostart  --verify  --uninstall
```

Default install prefix is `~/.local/share/turma-agent`; config is
`~/.config/turma-agent/turma-agent.env`.

`bootstrap.sh` is only the way IN — once installed, `turma-agent-update` keeps
the host current. It resolves the newest native build by the version in the
**asset's own filename**, not by release tag: a release carries an unchanged
native build forward under its original older name, so the newest tag does not
always name the newest native tarball. It is anonymous (the repo is public, so
no `gh` login or token, unlike the updater), and needs only curl + tar +
sha256sum, since it runs before `install.sh` has installed anything — including
python3, which is why it reads the release stream with grep rather than a JSON
parser.

### Appliance hosts (TrueNAS SCALE and kin)

Hosts with a **present-but-disabled apt** (TrueNAS shims `apt-get` to an
"is disabled" stub), a **noexec `/tmp`**, and **root as the operating user**
are supported:

- apt failures are non-fatal — the installer names what's missing and moves on;
  node falls back to the official nodejs.org tarball (into the prefix, like the
  static ttyd) and `bootstrap.sh` runs `install.sh` through bash so noexec
  `/tmp` doesn't matter.
- Run it as root directly (no sudo dance — root *is* the user there). With no
  systemd **user** bus for root, the service lands as **system units**
  (`systemctl status turma-agent`), same zero-downtime `KillMode=process`
  semantics; the updater restarts through the same scope.
- Set `IS_SANDBOX=1` in the config if sessions should be able to use
  `bypassPermissions` (Claude Code refuses it under root otherwise), and mind
  that a TrueNAS OS upgrade builds a fresh boot environment that can drop the
  `/etc` pieces (system units, `/etc/tmux.conf`) — re-run the installer after
  upgrading; prefix, config, and state all survive.

## Configure

Edit `~/.config/turma-agent/turma-agent.env` (created `chmod 600` — it holds a
token):

- **`TURMA_URL`** — the hub's public URL.
- **`TURMA_TOKEN`** — this host's own agent token, printed on the hub by `node
  turma/server.js --agent-token <DEVICE_NAME>`. It is derived from the hub's
  `TURMA_AGENT_TOKEN` **and the device name below**, so the two must agree —
  re-derive it if you change `DEVICE_NAME`. The hub's raw `TURMA_AGENT_TOKEN`
  also works unless the hub sets `TURMA_AGENT_STRICT`, but then this agent can
  act as any host in the fleet.
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
manager is back. It runs **on every agent start** and then hourly (a systemd
timer, or the `turma-agent-update --loop` poller on non-systemd hosts). The
start-fired one is detached, so it never delays the agent coming up. Force one
any time with `turma-agent-update` (or `turma-agentctl update`).

It also updates **Claude Code**, which is otherwise installed once at setup and
never touched again — but **only at agent start**, never on the hourly timer.
Replacing that package leaves `claude` missing from `PATH` for a second or two,
and a session launched in that window dies immediately; at start the session
manager doesn't exist yet, so nothing can be launching. That check therefore
runs to completion *before* the agent comes up (bounded, so a slow npm registry
can delay the start but not block it). **Restarting the agent is how a host
takes a new Claude Code**; `turma-agent-update --claude-only` does it by hand.

Both checks are rate-limited to one per `TURMA_BOOT_UPDATE_MIN_INTERVAL` (300s),
so a crash-looping unit can't turn `Restart=always` into a check every five
seconds. `TURMA_CLAUDE_AUTO_UPDATE=0` in `turma-agent.env` pins Claude Code;
`TURMA_BOOT_UPDATE=0` turns off both start checks — which, since start is the
only time Claude Code is looked at, also stops it being updated at all.

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

`install.sh` is not copied into the prefix, so on a host installed via the
one-liner these run through `bootstrap.sh` — both modes act on the existing
`$PREFIX`, not on the tarball they arrive in:

```sh
curl -fsSL .../bootstrap.sh | bash -s -- --verify
```

## Known limitations (graceful degradation)

- **No container self-inspect** — the heartbeat's container-log tail is empty
  (`docker logs` isn't there). Sessions and per-session restart are unaffected.
  `startedAt` falls back to the manager's own start time when `docker inspect`
  can't answer, so the host card's Uptime reads as MANAGER uptime here (an
  update restart resets it) and the hub's restart-loop alert still catches a
  crash-looping native manager.
- **`DEVICE_NAME` is explicit** — the container's docker/SMB auto-detection is
  gone; the launcher defaults it to `$(hostname)`.
- **Lifetime** — the agent lives only while the WSL distro is running. Windows
  may idle-stop the distro after the last shell exits despite lingering; there's
  no Docker-daemon-under-a-Windows-service to keep it up.
- **tmux colors AND clipboard** — the web terminal's truecolor/passthrough and
  its copy-to-system-clipboard (the OSC 52 chain: the `Ms` override +
  `set-clipboard on` + `allow-passthrough on`) all live in the bundled
  `tmux.conf`, which only takes effect at `/etc/tmux.conf` or `~/.tmux.conf`.
  The installer never clobbers an existing conf at either path — it warns when
  the one in effect lacks the clipboard settings; merge the missing lines from
  `$PREFIX/tmux.conf`, or colors flatten and every copy made in the terminal is
  silently dropped. The agent's sessions also share the user's own tmux server
  on a native host, so a personal tmux config applies to them.
- **Manual `stop` leaves sessions running** — like the container's "kill keeps
  the worktree", stopping the service orphans the tmux/ttyd (a later `start`
  re-adopts). `--uninstall` prints how to sweep them.
