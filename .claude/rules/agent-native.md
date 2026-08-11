---
paths:
  - "agent/native/**"
---

# `agent/native/` — non-Docker agent install (WSL/Linux)

Installs the SAME runtime files onto a host and reuses its tooling. See `agent/native/README.md`.
**Nothing under `native/` edits the shared runtime files**; the one enabling change is
`resume_on_boot`'s adopt path.

- `turma-agent` — the launcher: the runtime half of `entrypoint.sh` minus every container/privilege
  bit. Defaults `CLAUDE_PROJECTS_ROOT=$HOME/.claude/projects` (the one env decoupling from the
  container's hardcoded `/root`) and `DEVICE_NAME=$(hostname)`, idles on missing claude creds,
  supervises the tunnel, execs the manager.
- It puts **`$HOME/.local/bin` on PATH itself** (XERK-94): a systemd `--user` unit doesn't inherit
  the login shell's PATH, so claude at the prefix `install.sh` blesses is otherwise unreachable and
  every session dies on exec. A missing claude is a **loud, log-only** warning at start —
  install-time `have claude` checks run in the login shell and can't catch it.
- The config is **validated before it is sourced**, and a bad one **idles** rather than exiting:
  - The launcher `.`-sources the env file, so a non-assignment line RUNS (a YAML-style `JIRA_SITE:
    "x"` exits 127 and takes the launcher down under `set -e`). The check is anchored on the `=`
    directly after the name (`JIRA_TOKEN: "a=b"` carries an `=` in its VALUE); `export` stays legal.
  - **Idling, never `exit 1`.** To systemd an exit is indistinguishable from one worth restarting in
    5s — the exit IS the loop. `--preflight` is the one exception (exits 1); nothing is sourced
    then.
  - The report carries **line numbers and key names, never values** (`chmod 600`, holds
    `TURMA_TOKEN`/`JIRA_TOKEN`).
- The tunnel is **supervised** here (`turma-agent --tunnel-supervisor`): a native install is the
  only place its runtime can be MISSING — node is an apt prereq, not a baked layer.
  - **The node check lives INSIDE the loop**, so installing node heals the terminals within one
    `TUNNEL_RETRY_SEC`; fire-and-forget would make a missing node silent AND permanent.
  - The supervisor's pkill key is PREFIX-scoped; the launcher reaps the supervisor **BEFORE** the
    tunnel (else the old loop respawns the just-killed tunnel), and `turma-agentctl stop` reaps it
    too. Tests: `test_turma_agent.sh`.
- The launcher exports **`TURMA_MANAGER_PID=$$`**, which `exec` makes the manager's own pid, so the
  tunnel's `pokeHeartbeat` signals the right process. Its PID-1 fallback is right only in the
  container.
- `install.sh` — idempotent (`--verify`/`--uninstall`): installs prereqs (apt + npm + pinned static
  ttyd), lays files into a prefix **keeping `hub-agent.py` and `hooks/` siblings**, writes a `chmod
  600` config, wires the service, writes `$PREFIX/VERSION`, then `try-restart`s it (`enable --now`
  does nothing to a running service).
  - **`have_sudo` asks** when it must, rather than probing `sudo -n` only (which makes a
    password-sudo host look sudo-less and skips every apt prereq under `curl … | bash`). Gated on `[
    -t 2 ]`; cached.
  - **It must never become `curl … | sudo bash`**: the install belongs to the invoking user, only
    prereqs need root. Tests: `test_install_sudo.sh`.
- `bootstrap.sh` — the `curl … | bash` front door: resolve the newest native tarball, verify its
  sha256, unpack to a temp dir, `exec` the `install.sh` inside it (**not** copied into `$PREFIX`, so
  `--verify`/`--uninstall` re-run through it). Resolves by the version in the **asset's filename**,
  never the release tag (a carried-forward build keeps its older name, so a tag-derived name would
  404). Anonymous and parser-free — it runs BEFORE `install.sh` apt-installs python3. Tests:
  `test_bootstrap.sh`.
- Service: a systemd **user** unit with `KillMode=process` (a restart signals only the manager,
  leaving tmux/claude/ttyd/tunnel alive), plus a nohup `turma-agentctl` fallback for WSL without
  systemd. Both preserve running sessions via adopt-on-boot.
  - `turma-agentctl` keys pidfiles on `XDG_RUNTIME_DIR` but falls back to `~/.turma` unless that dir
    exists and is **writable** — on WSL-without-logind the var points at a `/run/user/<uid>` logind
    never created, so a plain `${XDG_RUNTIME_DIR:-…}` orphans the old manager and spawns a second.
    Tests: `test_turma_agentctl.sh`.
- `turma-agent-update` — self-updater: compares the release `manifest.json`'s **agent-native
  component version** (never the tag), verifies the sha256, swaps files, restarts the manager. Falls
  back to the legacy `agent-native-v*` stream. Tests: `test_turma_agent_update.sh`.
  - It also updates **Claude Code** (XERK-254), which the agent otherwise installs once and never
    touches again. A version COMPARE, never a blind `npm i -g @latest` — the install replaces the
    package under live sessions. `npm` only when npm-manages it; a claude from Anthropic's native
    installer goes through `claude update`, since `npm i -g` would lay a SECOND one beside it and
    leave PATH order deciding the version. A MISSING claude is installed, not reported: without it
    every session dies on exec. Registry unreachable and installed-ahead-of-latest both stay put.
    `TURMA_CLAUDE_AUTO_UPDATE=0` pins the host.
  - **Claude Code goes first**, because the self-update after it can restart the manager (and on the
    non-systemd path is the last thing the process does).
- **Every start is an update check**: the launcher fires `turma-agent-update --boot` **detached**
  before the manager, so a restart for any reason lands on current code. Detached because it does
  network I/O (a start must not wait on GitHub/npm) and because a successful self-update restarts
  this unit — `setsid` + `KillMode=process` is what lets it survive to finish its own swap.
  - `--boot` **rate-limits itself** off `~/.turma/last-update-check` (every run stamps it;
    `TURMA_BOOT_UPDATE_MIN_INTERVAL`, 300s). Not optional: `Restart=always` restarts a crash-looping
    manager every 5s, and unthrottled that is a release+registry check — and possibly a swap and
    restart — at that same rate. A future-dated stamp reads as no stamp.
  - Fired **before** the credential gate (a host idling for want of a login should still pick up
    builds) and **never** by `--preflight`, which `install.sh --verify` calls. `TURMA_BOOT_UPDATE=0`
    opts out. Tests: `test_turma_agent.sh`.
- **Auth on that read is an optimisation, never a precondition** (XERK-151): `all_tags`/
  `download_assets` try `gh`, then `$GH_TOKEN`, then **anonymously** — requiring auth pins a host
  with no GitHub login at its installed version forever. It exports the **same `$HOME/.local/bin`
  PATH the launcher does** (XERK-94): its unit sets no PATH, so a `gh` installed there is invisible
  to the timer.
- Not installed natively: cloud CLIs, PowerShell, docker CLI, the Android toolchain.
- **Container ⇄ native parity (XERK-34)**: the same runtime files run in both, so session model,
  heartbeat, board/PR/usage/archive features are identical. Known deltas:
  - `startedAt` is docker's StartedAt where docker can answer, else the manager's OWN start time —
    **never empty** (`TestStartedAt`), keeping the restart-loop alert (keyed on `startedAt`
    CHANGING) and card Uptime working natively. The log tail stays container-only.
  - The bundled `tmux.conf` only takes effect at `/etc/tmux.conf`/`~/.tmux.conf`; a host with its
    own conf loses truecolor and the OSC 52 copy chain (hub-agent launches bare `tmux`).
