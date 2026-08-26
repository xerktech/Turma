---
paths:
  - "agent/native/**"
---

# `agent/native/` — non-Docker agent install (WSL/Linux)

Installs the SAME runtime files onto a host and reuses its tooling. See `agent/native/README.md`.
**Nothing under `native/` edits the shared runtime files**; the one enabling change is
`resume_on_boot`'s adopt path.

- `turma-agent` — the launcher: resolves the runtime env, idles on missing claude creds, supervises
  the tunnel, execs the manager. Defaults `CLAUDE_PROJECTS_ROOT=$HOME/.claude/projects` (rooted at
  the agent user's real `$HOME`, not a hardcoded `/root`) and `DEVICE_NAME=$(hostname)`.
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
  tunnel's `pokeHeartbeat` signals the right process.
- `install.sh` — idempotent (`--verify`/`--uninstall`): installs prereqs (apt + npm + pinned static
  ttyd + pinned static glab — the MR counterpart of `gh`, without which a session's MR never gets a
  chip; best-effort, absence doesn't fail `--verify`), lays files into a prefix **keeping
  `hub-agent.py` and `hooks/` siblings**, writes a `chmod 600` config, wires the service, writes
  `$PREFIX/VERSION`, then `try-restart`s it (`enable --now` does nothing to a running service).
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
  - The lock is taken **per run and released before the sleep**. `--loop` held it for its whole
    life, and since `turma-agentctl start` runs that poller on every non-systemd host, every
    start-fired check there exited at once as "another update run holds the lock".
  - `install_payload` requires `hooks/` in the payload before it swaps: the swap DELETES the
    installed hooks first, and a missing hook command is a non-blocking hook — the safety guard
    would fail open while VERSION, the restart and the log all reported a clean update.
  - It also updates **Claude Code** (XERK-254, `--claude-only`), which the agent otherwise installs
    once and never touches again.
    - **Only ever at agent start**, never on the timer or in `--loop`. Replacing the package leaves
      `claude` absent from PATH for ~1.7s and a session launched then dies on exec; before the
      manager exists nothing can be launching, at any later moment a hub-requested spawn can land in
      the hole. Restarting the agent is therefore how a host takes a new Claude Code.
    - A version COMPARE, so there is no window at all unless something newer is really published.
      `npm` only when npm's global prefix is **where PATH resolves `claude` from** — `npm ls -g`
      alone answers a different question, and on a host with both (npm prefix `~/.local/node`,
      claude in `~/.local/bin`) it "updates" the copy nobody runs, reports the unchanged version as
      success, and repeats forever. Otherwise `claude update`, the installer that owns it.
    - **ABSENT and UNREADABLE skip the compare and go to the same repair**, and both are then
      VERIFIED: a missing claude means every session dies on exec, and one that runs but can't say
      what it is is a half-written install. What must never happen is repairing blind — reporting
      the OLD version as success and repeating forever — so `report_claude_install` reads back what
      the agent now resolves and says when nothing moved. The start-check rate limit is what bounds
      a repair that cannot work.
    - **npm is only used where this agent's PATH can reach it.** An install into a prefix PATH never
      looks at leaves claude just as missing, so the next check repairs again, on every start,
      forever; `npm_install_claude` picks npm's global prefix if its bin is on PATH, else the
      `~/.local` the launcher exports, else refuses and says why.
    - `--loop`'s interval is sanitised too: `sleep 0` is a hot loop against the GitHub API, and
      `sleep abc` exits the poller under `set -e`, silently ending auto-updates on that host.
    - Unreachable-or-unparseable registry output and installed-ahead-of-published both stay put
      (`sort -V` ranks a non-version ABOVE a semver, so an error line would otherwise read as an
      upgrade). `TURMA_CLAUDE_AUTO_UPDATE=0` pins the host — and so does `TURMA_BOOT_UPDATE=0`,
      since start is the only time Claude Code is checked at all.
    - **A repair that doesn't help is remembered** (`~/.turma/claude-unparseable`, the raw
      `--version` string): an unreadable version is usually a half-written install, but equally a
      working claude printing a shape this doesn't parse — there the reinstall fixes nothing and
      would run on every start forever, inside the awaited boot path. Retried only when what claude
      prints CHANGES — and the marker is earned only by a repair that actually RAN (`install_claude`
      returns the install's status): remembering an install that never reached the registry, because
      the host restarted while its network was down, would brick Claude Code on that host
      permanently.
    - **Nothing opens a `~/.turma` path that isn't a regular file.** That dir is writable by the
      identity the SESSIONS run as, so a `mkfifo` there blocks the open forever with no error —
      inside an awaited start. Stamp and marker go through `safe_read`/`safe_write` (temp file +
      rename, no check-then-open race), `logmsg` skips a non-regular log target, and `with_lock`
      removes a non-regular lock path rather than opening it.
    - **Every timeout value is sanitised where it is USED, not only where the floor is computed**
      (`num` in both files): `timeout -k abc …` exits 125 WITHOUT running the command, so one typo
      in the config stops being "no timeout" and becomes "every claude read looks broken, every
      start attempts a futile repair, no check ever runs". `0` reads as the default too — it
      disables `timeout` outright. Shipped default deadline (1800s) pinned by a test.
    - The launcher's deadline is a **fixed generous number**, held clear of the install budget only
      (2.5x it). Deriving it from this script's per-call timeouts coupled the launcher to this
      script's call graph, and every miscount was a defect — including one that could only be seen
      by counting as a NON-ROOT user, since the EACCES retry sits behind `[ "$(id -u)" = 0 ]`.
    - **The two install attempts SHARE one budget** (`TURMA_NPM_INSTALL_TIMEOUT`, the retry gets the
      remainder): per-attempt bounds let the step take twice the operator's number, which is
      arithmetic the floor is built on — and counting them separately instead would mean promising a
      965s boot for the same work. The elapsed-time subtraction is **clamped at zero**: this runs
      during a start, which is when a host with no battery-backed RTC gets its clock corrected, and
      a backwards step made `remaining` EXCEED the budget (measured: 3897s against 300s). Under ~10s
      left the retry is skipped rather than started — an install that cannot finish is one that gets
      SIGKILLed mid-write, and that leaves no claude at all.
    - **`ensure_npm_prefix` must be called DIRECTLY, never as `$(...)`** — a command substitution is
      a subshell, so a memo written as a value-returning function silently never memoised and every
      caller re-read the prefix.
    - Every external call is `timeout -k`-bounded, `npm prefix -g`/`npm ls -g` included and the
      prefix read once per run: the lock is held for the whole run, so one hung child would block every
      later update — including the one shipping the fix — and this runs inside a start.
- **Every start is an update check**, fired by the launcher two different ways:
  - **Claude Code, awaited** (`--claude-only`, bounded by a deadline DERIVED from the updater's own
    per-call timeouts — `timeout` signals its direct child only, so a bound that can fire mid-install
    orphans npm into the session-relaunch window; an operator value below that floor is raised) — it must
    finish before the manager exists, per the window above. A slow registry may delay the start; it
    cannot stop it, and a late start is visible where a session that died on a missing binary is
    not.
  - **The agent self-update, detached** (`--boot`) — it waits on GitHub, and a successful one
    restarts this very unit, so it has to be outside the process tree that restart tears down.
    `setsid` + `KillMode=process` is what lets it survive to finish its own swap.
  - Both **rate-limit themselves** off their own stamp (`~/.turma/last-update-check`,
    `last-claude-check` — separate, or the first would always suppress the second;
    `TURMA_BOOT_UPDATE_MIN_INTERVAL`, 300s). Not optional: `Restart=always` restarts a crash-looping
    manager every 5s. A future-dated stamp reads as no stamp, and the age is computed base-10 (bash
    reads a zero-padded stamp as OCTAL, and `09` is an arithmetic error that killed the check).
  - Fired **before** the credential gate (a host idling for want of a login should still pick up
    builds) and **never** by `--preflight`, which `install.sh --verify` calls. `TURMA_BOOT_UPDATE=0`
    opts out. Tests: `test_turma_agent.sh`.
- **Auth on that read is an optimisation, never a precondition** (XERK-151): `all_tags`/
  `download_assets` try `gh`, then `$GH_TOKEN`, then **anonymously** — requiring auth pins a host
  with no GitHub login at its installed version forever. It exports the **same `$HOME/.local/bin`
  PATH the launcher does** (XERK-94): its unit sets no PATH, so a `gh` installed there is invisible
  to the timer.
- Not installed natively: cloud CLIs, PowerShell, docker CLI, the Android toolchain.
- **The native install is the ONLY runtime** (XERK-34): session model, heartbeat, board/PR/usage/
  archive features all run from these shared files. Capabilities the removed container image used to
  add, and that a native host therefore does NOT have:
  - **Azure DevOps git/CLI enablement**: the `--wire-azure-git` path and `AZURE_DEVOPS_EXT_PAT` were
    wired by the old container entrypoint, and `az` isn't installed natively at all, so a native ADO
    host authenticates git and opens PRs with its own tooling. PR chips still work — attribution is
    the creating COMMAND (`TURMA_PR_CREATE_CMDS`, see `.claude/rules/agent-prs.md`), not the CLI.
  - `startedAt` is docker's StartedAt where docker can answer, else the manager's OWN start time —
    **never empty** (`TestStartedAt`), keeping the restart-loop alert (keyed on `startedAt`
    CHANGING) and card Uptime working. The container-log tail is not available natively.
  - The bundled `tmux.conf` only takes effect at `/etc/tmux.conf`/`~/.tmux.conf`; a host with its
    own conf loses truecolor and the OSC 52 copy chain (hub-agent launches bare `tmux`).
