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
  - **A new `agent/*.py` sibling must land in ALL THREE packaging paths, or a runtime runs DARK on
    release/update** (XERK-528, the XERK-496/523 lockstep class): `release.yml` staging `cp`,
    `install.sh` copy + `--verify` list, AND `turma-agent-update` payload swap. `hub-agent.py`
    imports the siblings by their own-dir path; nothing in CI/tests stages the tarball, so a miss is
    invisible until a real host updates. `runtime_projection.py`/`runtime_tail.py` (shared by the dsh
    AND qwen transcript/tail siblings) ship UNCONDITIONALLY with the core. Note `dsh_configured()`
    does NOT presence-gate on its files (unlike `qwen_configured`→`qwen_runtime_present`), so a dsh
    host missing a projector runs dark rather than refusing.
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
  - **The lock + stamps are SCOPED to the install `$PREFIX` (XERK-551)** — keyed off `$HOME` (as they
    were), EVERY updater under one user shared one lock regardless of prefix, so a leaked/staged
    `--loop` (or an NFS-shared home) could hold or fight over it and starve the real poller forever,
    silently disabling auto-update on a non-systemd host (the `--loop` poller is the only updater
    there). `prefix_tag` (sha256 of `$PREFIX`, cksum fallback) tags `update.<tag>.lock`,
    its `.holder`, the three throttle stamps, and `update-skip-count`. **`LOG` stays per-USER** (the
    session identity writes it) but each line is tagged `[$PREFIX]` so concurrent updaters are
    distinguishable instead of doubling. `claude-unparseable` and `updating.json` stay unscoped — the
    former is about the one shared `claude`, the latter is a fixed contract the manager reads on boot.
  - **A `--loop` poll lost to contention RETRIES after `TURMA_POLL_RETRY_SEC` (default 60s), never
    forfeits the whole `INTERVAL` (XERK-551)** — sleeping the full hour on a skip is what let one
    contended poll strand the host for an hour and sustained contention strand it forever. The retry
    is capped at `INTERVAL` and floored at 1s; `note_agent_check`'s `STRAND_WARN_AT` escalation still
    fires. Tests: cases 37–39 in `test_turma_agent_update.sh`.
  - **A run cannot WEDGE holding the lock (XERK-549)** — a hung child once held it forever (a
    network/subprocess call that outran its own `timeout`), stranding the host on a stale build
    silently. Three guards, all in `with_lock`/`run_locked`:
    - The locked work runs with the **lock fd CLOSED for it (`9>&-`)**, so NO descendant inherits the
      lock — only the `with_lock` process holds it, and it drops the moment that process releases fd 9.
    - The **agent self-update** (`--loop`/`--boot`/timer — the unbounded paths; `--claude-only`/
      `--dsh-only` already get the launcher's outer bound) is re-exec'd as `--locked-run` under an
      overall `timeout` (`TURMA_RUN_DEADLINE`, default 900s, **< `TURMA_UPDATE_INTERVAL`** so a poll
      never overlaps the next), so a hung run is force-terminated instead of held.
    - **Staleness-aware reclaim**: the holder's `pid`+acquire-epoch is recorded (`update.lock.holder`);
      when `flock -n` fails and the holder is older than `TURMA_LOCK_RECLAIM_AFTER` (default 7200s, **>>
      the deadline** so a healthy slow run is never a target) AND its `/proc/<pid>/cmdline` is this
      updater (PID-reuse guard), it is killed and the lock retaken. Killing the single holder pid
      suffices *because* of `9>&-`.
    - Telemetry: `note_agent_check` counts consecutive skipped/errored agent checks
      (`update-skip-count`) and logs a WARNING every `TURMA_UPDATE_STRAND_WARN_AT` (default 3) so a
      stuck poller shows in `update.log` without a live pod inspection.
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
- **`TURMA_DEFAULT_RUNTIME` = the per-host default runtime for UNPINNED work** (XERK-521): an
  auto-started/unpinned ticket, and a bare "+ New session" with the Runtime dropdown untouched. One
  of `{claude,dsh,qwen}`; UNSET → claude, so every current host is unchanged. Resolved in ONE place
  (`resolve_agent_type`/`default_runtime`): precedence `explicit agentType → TURMA_DEFAULT_RUNTIME →
  claude`, where an EXPLICIT choice is a NON-BLANK `agentType`, applied via `apply_default=True` on
  the fresh-spawn call ONLY — every rebuild/resume/migration passes the STORED value with it OFF, so
  a resumed session keeps its runtime (a blank pre-field record stays claude, never adopts the
  default).
  - **Self-validating / fail-safe** (the `local_model_configured` half-config discipline): checked
    against THIS host's `dsh_configured`/`qwen_configured`, so a host that sets `qwen` but hasn't
    configured it falls back to claude and SAYS so (log + the heartbeat's EFFECTIVE `defaultRuntime`)
    — never a broken launch.
  - **No hub capability-filter on the dispatch path**: an unpinned ticket carries no runtime, so
    `findTicketHost` routes to the most-available host and the CLAIMING host applies its own default
    (always runnable by construction). An explicit pin still filters + blocks (`turma-board.md`).
  - **"Explicit claude" must SEND `agentType:"claude"` or it reads as unpinned** — a composer
    "Claude Code"/"Claude Code Local" pick omitted it (the bare fast path), which on a
    non-claude-default host resolves to the default, so `sessions.html` now sends explicit
    `agentType:"claude"` for a claude/local pick WHEN the host default is non-claude (byte-for-byte
    unchanged on every claude-default host).
  - **KNOWN GAP**: a per-ticket CLAUDE *pin* does NOT yet override a non-claude host default — the
    board Runtime row treats `{runtime:"claude"}` as RELEASE, so a claude-pinned ticket adopts the
    host default (dsh/qwen pins DO override). Closing it needs the Runtime picker to split "Auto —
    host default" from a pinned "Claude Code" across `board.js`/`board.cjs`/`Board.kt`/glasses (a UX
    change), deferred to a follow-up. Latent today (dsh/qwen behind their kill switches).
  - **Known limitation — NONDETERMINISTIC in a MIXED org**: an unpinned ticket runs whatever host
    frees a slot first defaults to. Determinism needs a per-ticket pin (XERK-515) or homogeneous
    hosts. Accepted tradeoff of the per-host choice.
