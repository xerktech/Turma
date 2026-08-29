---
paths:
  - "agent/native/**"
---

# `agent/native/` — non-Docker agent install (WSL/Linux)

Installs the SAME runtime files onto a host and reuses its tooling. See `agent/native/README.md`.
**Nothing under `native/` edits the shared runtime files**; the one enabling change is
`resume_on_boot`'s adopt path.

- `turma-agent` — launcher: resolves runtime env, idles on missing claude creds, supervises the
  tunnel, execs the manager. Defaults `CLAUDE_PROJECTS_ROOT=$HOME/.claude/projects`,
  `DEVICE_NAME=$(hostname)`.
- **Puts `$HOME/.local/bin` on PATH itself** (XERK-94): a systemd `--user` unit doesn't inherit the
  login shell's PATH, so claude is otherwise unreachable and every session dies on exec. Missing
  claude is a loud, log-only warning at start.
- Config is **validated before sourced**; a bad one **idles, never `exit 1`** (an exit reads as
  crash-loop-worth-restarting to systemd). `--preflight` is the one exception (exits 1, sources
  nothing). Report carries line numbers + key names, **never values** (`chmod 600`, holds
  `TURMA_TOKEN`/`JIRA_TOKEN`).
- Tunnel is **supervised** (`--tunnel-supervisor`, node isn't a baked layer here). **Node check lives
  INSIDE the loop** (`TUNNEL_RETRY_SEC`) — fire-and-forget would make a missing node silent AND
  permanent. Launcher reaps
  the supervisor BEFORE the tunnel (else the old loop respawns the just-killed tunnel);
  `turma-agentctl stop` too. Tests: `test_turma_agent.sh`.
- Launcher exports `TURMA_MANAGER_PID=$$` so the tunnel's `pokeHeartbeat` signals the right process.
- `install.sh` — idempotent (`--verify`/`--uninstall`): apt + npm + pinned static ttyd + pinned
  static glab (best-effort; a session's MR gets no chip without it), lays files keeping
  `hub-agent.py`/`hooks/` siblings, `chmod 600` config, wires the service, writes `$PREFIX/VERSION`,
  `try-restart`s.
  - **`have_sudo` ASKS when needed**, never `sudo -n`-only (a password-sudo host would look
    sudo-less and skip every apt prereq under `curl | bash`). Gated on `[ -t 2 ]`; cached.
  - **`--with-dsh`/`TURMA_DSH=1` ships the dsh toolchain (XERK-496)**: lays `dsh_session.py`/
    `dsh_transcript.py` + `dsh-session-driver/dist/` + `dsh/guard/` at `hub-agent.py`'s own dir
    (`DSH_PLUGIN_DIR`), installs LATEST `@deepseek-ai/dsh` into `~/.local` with native-build scripts
    allowed (`--allow-scripts=koffi,node-pty,…` — npm 11+ blocks them by default), writes
    `$PREFIX/.dsh` (the updater's "wants dsh" marker), seeds `TURMA_DSH=1`. CLI updates at every
    agent restart like Claude Code, never on the timer. **A built `dist/` is non-negotiable** —
    `_ensure_dsh_profile` refuses every dsh spawn without it. Tests: `test_install_dsh.sh`.
  - **Never `curl | sudo bash`** — install belongs to the invoking user, only prereqs need root.
    Tests: `test_install_sudo.sh`.
- `bootstrap.sh` — `curl | bash` front door: resolves newest tarball, verifies sha256, unpacks to
  temp, `exec`s `install.sh` from there (not copied to `$PREFIX`, so `--verify`/`--uninstall` re-run
  through it). Resolves by **asset filename version, never the release tag** (a carried-forward
  build keeps its older name; a tag-derived name 404s). Anonymous, parser-free — runs before
  `install.sh` apt-installs python3. Tests: `test_bootstrap.sh`.
- Service: systemd **user** unit, `KillMode=process` (restart signals only the manager; tmux/claude/
  ttyd/tunnel survive), plus a nohup `turma-agentctl` fallback for WSL without systemd. Both
  preserve sessions via adopt-on-boot.
  - `turma-agentctl` keys pidfiles on `XDG_RUNTIME_DIR`, falling back to `~/.turma` unless that dir
    exists AND is writable — WSL-without-logind points at a never-created `/run/user/<uid>`, so a
    bare fallback would orphan the old manager and spawn a second. Tests: `test_turma_agentctl.sh`.
- `turma-agent-update` — self-updater: compares the manifest's **component version, never the tag**,
  verifies sha256, swaps files, restarts. Falls back to the legacy `agent-native-v*` stream. Tests:
  `test_turma_agent_update.sh`.
  - **Lock taken per run, released before the sleep** — `--loop` holding it for its whole life made
    every `turma-agentctl start`-fired check exit as "another update run holds the lock".
  - `install_payload` **requires `hooks/` in the payload before swapping** — the swap deletes
    installed hooks first, and a missing hook command is a non-blocking hook (guard fails open
    silently while VERSION/restart/log all report clean).
  - **dsh's toolchain swaps with the payload (XERK-496)**, gated on `$PREFIX/.dsh`: refresh from the
    staged payload when present (drop the plugins + marker if the payload stops shipping them — never
    leave a stale copy); do nothing when absent. CLI is NOT pinned — updated to LATEST every agent
    restart like Claude Code, via `--dsh-only` (mirrors `--claude-only`), never the hourly timer (a
    session launched into a replaced `dsh` dies on exec). Tests: dsh payload + `--dsh-only` cases.
  - Also updates **Claude Code** (XERK-254, `--claude-only`), which the agent otherwise installs once
    and never touches again.
    - **Only ever at agent start, never the timer/`--loop`.** Replacing the package leaves `claude`
      absent from PATH for ~1.7s; before the manager exists nothing can be launching, at any later
      moment a hub-requested spawn can land in the hole.
    - A version COMPARE: `npm` only when npm's global prefix is where PATH resolves `claude` from
      (`npm ls -g` alone answers a different question) — else `claude update`.
    - **ABSENT/UNREADABLE both go to the same repair, then are VERIFIED** — repairing blind (reporting
      the old version as success, repeating forever) must never happen; `report_claude_install` reads
      back what the agent now resolves.
    - **npm only used where THIS agent's PATH can reach it** — an install PATH can't see leaves
      claude missing, repairing forever; `npm_install_claude` picks npm's global prefix if on PATH,
      else `~/.local`, else refuses and says why.
    - `--loop`'s interval is sanitised: `sleep 0` hot-loops the GitHub API; `sleep abc` silently ends
      auto-updates under `set -e`.
    - Unreachable/unparseable registry output and installed-ahead-of-published both stay put
      (`sort -V` ranks a non-version above a semver). `TURMA_CLAUDE_AUTO_UPDATE=0` /
      `TURMA_BOOT_UPDATE=0` pin a host.
    - **A repair that doesn't help is remembered** (`~/.turma/claude-unparseable`) and retried only
      when what claude prints CHANGES — earned only by a repair that actually ran, else a host that
      restarted mid-repair with no network would brick Claude Code permanently.
    - **Nothing opens a `~/.turma` path that isn't a regular file** — that dir is session-writable, so
      a `mkfifo` there blocks the open forever with no error, inside an awaited start. Stamp/marker go
      through `safe_read`/`safe_write` (temp + rename); `logmsg`/`with_lock` skip non-regular targets.
    - **Every timeout is sanitised where USED, not just where the floor is computed** — `timeout -k
      abc` exits 125 without running the command, turning one config typo into every check failing.
      `0` also disables `timeout` outright. Shipped default 1800s, pinned by a test.
    - Launcher's deadline is a **fixed generous number** (2.5x the install budget), not derived from
      the updater's per-call timeouts — deriving it coupled the launcher to the script's call graph.
    - **The two install attempts SHARE one budget** (`TURMA_NPM_INSTALL_TIMEOUT`, retry gets the
      remainder) — separate per-attempt bounds would double the operator's promised time. Elapsed
      time is **clamped at zero** (a clock correction mid-boot can make it negative). Under ~10s left
      the retry is SKIPPED, not started — an install that can't finish gets SIGKILLed mid-write.
    - `ensure_npm_prefix` must be called DIRECTLY, never `$(...)` — a substitution subshells, so a
      memo function never actually memoises.
    - Every external call is `timeout -k`-bounded and the prefix read once per run — the lock is held
      for the whole run, so one hung child blocks every later update, including the fix.
- **Every start is an update check**, fired two ways: Claude Code AWAITED (`--claude-only`, deadline
  derived from the updater's own timeouts — must finish before the manager exists); the agent
  self-update DETACHED (`--boot`, `setsid` + `KillMode=process` so it survives its own restart). Both
  **rate-limit off their own stamp** (separate stamps, else one would suppress the other;
  `TURMA_BOOT_UPDATE_MIN_INTERVAL` 300s) — a future-dated stamp reads as no stamp, age computed
  base-10 (bash reads a zero-padded stamp as octal). Fired BEFORE the credential gate, NEVER by
  `--preflight`. `TURMA_BOOT_UPDATE=0` opts out. Tests: `test_turma_agent.sh`.
- **Auth on the release read is an optimisation, never a precondition** (XERK-151): tries `gh`, then
  `$GH_TOKEN`, then anonymously — requiring auth would pin a no-login host at its installed version
  forever. Exports the same `$HOME/.local/bin` PATH the launcher does (its unit sets none).
- Not installed natively: cloud CLIs, PowerShell, docker CLI, Android toolchain.
- **The native install is the ONLY runtime** (XERK-34). Capabilities the removed container image had
  that a native host does NOT:
  - Azure DevOps git/CLI enablement (`az` not installed) — PR chips still work, attribution is the
    creating COMMAND (`TURMA_PR_CREATE_CMDS`, `agent-prs.md`), not the CLI.
  - `startedAt` is docker's StartedAt where available, else the manager's own start time — **never
    empty** (`TestStartedAt`), keeping the restart-loop alert and card Uptime working. No container-
    log tail natively.
  - The bundled `tmux.conf` only applies at `/etc/tmux.conf`/`~/.tmux.conf`; a host with its own conf
    loses truecolor + the OSC 52 copy chain.
