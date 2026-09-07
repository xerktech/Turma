# Native Windows agent — architecture decision record (XERK-667)

The foundation decision record for a **native, no-WSL Windows host** in the Turma fleet (epic
XERK-666). It fixes the load-bearing tradeoffs before code so the rest of the epic isn't
re-litigated mid-build, and it is proven where it can be: the riskiest piece (the terminal layer)
ships with a working throwaway spike under [`windows-agent-spike/`](windows-agent-spike/).

**This is history and reasoning, not an instruction file.** When code lands, the operative
invariants move into a `paths:`-scoped `.claude/rules/windows-agent.md` (the pattern set by
`docs/dsh-adr.md` → `.claude/rules/dsh.md`). Read this for *why*; read the rules file, when it
exists, for the *rule*.

## Scope — what "native Windows, no WSL" means here

- The fleet model is unchanged: **one native agent per host**, multiplexing worktree-backed sessions,
  reporting to the one existing hub over the existing heartbeat. A Windows host is another host, not a
  new control plane. Every cross-cutting contract in `CLAUDE.md` (heartbeat wire contract, XERK-268
  host proof, XERK-264 refusals, XERK-348 peer boundary, usage ledger) applies to it unchanged.
- **WSL is explicitly out.** WSL would just be the Linux agent again; the epic exists because some
  hosts have no WSL. So every Linux-only mechanism the agent leans on — tmux, ttyd, systemd,
  `KillMode=process`, `chmod`, `setsid`, `/proc`, same-FS `mv` swaps, apt — needs a Windows answer.
- **This task ships no production code** (DoD). It ships this ADR + the terminal spike. Each decision
  below names the child that will implement it.

## The contract we must not break

The single most important finding from mapping the current stack: on Linux, **`tmux` and `ttyd` are
two views of one session, and `ttyd` is the smaller half.** A Windows port that only replaces `ttyd`
misses three of tmux's four jobs.

- The browser terminal is the **raw ttyd `tty` websocket protocol, passed opaque end-to-end.**
  `tunnel-agent.js`'s `openDataChannel` just pipes bytes between the hub data channel and a local TCP
  socket (`agent/tunnel-agent.js:1753`); `turma/server.js` re-issues the browser's upgrade to ttyd
  and cross-pipes (`turma/server.js:15410`). Nothing in Turma parses ttyd's `0/1/2` framing,
  `{columns,rows}` resize, or the `tty` subprotocol — those live between xterm.js and ttyd. **So a
  replacement must serve that exact wire protocol on `127.0.0.1:<port>`** (base path `/term/<id>`,
  basic-auth `term:<token>`), and the tunnel + hub + xterm.js stay untouched. The spike implements
  precisely this protocol.
- Separately, the **manager drives the session through the tmux CLI**, never through ttyd:
  `send_input` → `_type_into_pane` (`tmux load-buffer`/`paste-buffer`, `hub-agent.py:9222`),
  liveness/state via `_capture_pane` (`tmux capture-pane -p`, :9086) and `_tmux_alive`
  (`tmux has-session`, :19684), spawn via `_spawn_in_tmux` (`tmux new-session -d`, :15634).
- And tmux gives **persistence**: under `KillMode=process` the manager restarts while tmux + ttyd +
  claude keep running, and `resume_on_boot` re-adopts each session by probing its own record's
  `tmuxName`/`ttydPid`/`ttydPort` (`hub-agent.py:24807`).

**Conclusion that shapes Decision A:** the Windows terminal layer must absorb *all four* tmux/ttyd
roles — terminal, input, capture, persistence — not just the ws bridge.

## Terminal-layer spike verdict: **GO** (14/14)

A persistent [`node-pty`](https://github.com/microsoft/node-pty) host serving the ttyd `tty`
protocol plus a JSON control channel proves every property Decision A needs — spawn, attach, detach,
**re-attach with scrollback**, inject/capture/liveness, adopt-after-manager-restart from persisted
state alone, and teardown. Run and evidence: [`windows-agent-spike/`](windows-agent-spike/) /
[`SPIKE-RUN.txt`](windows-agent-spike/SPIKE-RUN.txt). `node-pty` is one API over two backends —
**ConPTY** on Windows (10 1809+), **forkpty** on Unix — and the spike drives the identical surface
the Windows build binds to ConPTY. What remains ConPTY-specific and unproven here (Session 0 service
context, ConPTY redraw/resize quirks) is carried as an open question, not a blocker.

## D1 — Terminal layer: one persistent `node-pty` host per session, ttyd protocol preserved

**Decision.** Replace `tmux + ttyd` with a single long-lived **pty-host process per session** (Node +
`node-pty`, ConPTY-backed). It owns the session's ConPTY and exposes two loopback servers:
- a **terminal** websocket speaking ttyd's `tty` subprotocol byte-for-byte, so the hub,
  `tunnel-agent.js` and xterm.js are unchanged — the manager allocates a port from `TTYD_PORT_BASE`
  and the tunnel dials it exactly as it dials ttyd today;
- a **control** channel (local ws/named pipe) the manager uses instead of the tmux CLI: `inject`
  (→ `send_input`/`_type_into_pane`), `capture` (→ `_capture_pane`), `alive` (→ `_tmux_alive`),
  `resize`, `kill`.

It is spawned **detached** so it outlives a manager restart, and re-adopted from the persisted
`{pid, termPort, ctrlPort}` on the session record — the direct analog of `resume_on_boot`'s
pid+port probe (D2).

**Why `node-pty` + a small ws server, not "ttyd for Windows".** `node-pty` is the ConPTY binding the
Windows ecosystem standardises on (VS Code's terminal), it is **already a vetted transitive
dependency in this repo** (the dsh toolchain installs it with build scripts allowed —
`install.sh` `DSH_ALLOW_SCRIPTS=…,node-pty`), and Node ≥ 24 is already a fleet prerequisite. A
"ttyd-for-Windows" either wraps winpty/Cygwin (a heavier, worse-maintained dependency than ConPTY
itself) or doesn't exist as a maintained artifact; and critically, ttyd only ever solved the *ws
bridge*, leaving tmux's other three roles unanswered. Owning a small pty-host lets one process cover
all four with code we control.

**Why not keep a multiplexer (a tmux-for-Windows).** There is no first-class detached-session
multiplexer on native Windows (`abduco`/`dtach`/`screen` are Unix). Rather than bolt on an immature
one, the pty-host *is* the persistence unit: ConPTY already survives client disconnects, and detached
process + registry adopt gives the `KillMode=process` property (proven in the spike, phases 3/6).

**Cost accepted.** One extra long-lived Node process per session (memory/handle budget, sized per
host against `MAX_SESSIONS` like any session child). A scrollback **ring** replaces `capture-pane`'s
rendered grid; parity with `_busy_from_capture` (which reads the *rendered* pane, not raw bytes) will
need a headless terminal emulator (`@xterm/headless`) in the pty-host to render the ring to a grid —
flagged for the drive child, not spiked here. The spike proves the channel; the rendering fidelity is
follow-up.

## D2 — Supervision: a Windows Service (WinSW) for the manager; children break away for restart

**Decision.** Run the **manager** under a Windows Service via **WinSW** (a mature, pinned,
XML-configured service wrapper — a single bundled `.exe`, no .NET SDK, no admin beyond install). WinSW
maps cleanly onto the systemd unit: auto-start at boot (run-without-interactive-login = **Session 0**),
auto-restart (`onfailure restart` ≈ `Restart=always`/`RestartSec=5`). The manager spawns each
pty-host and claude **detached / broken out of the service's job object**
(`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, `CREATE_BREAKAWAY_FROM_JOB` where the job requires it)
so a service **restart signals only the manager** — the `KillMode=process` invariant — and the fresh
manager re-adopts the survivors from the registry (D1).

**Why WinSW over the alternatives.**
- **Scheduled Task** ("run whether logged on or not") gives non-interactive start but weak
  supervision (restart/health/log semantics are clumsy) — a worse `Restart=always`.
- **NSSM** is the classic wrapper but effectively unmaintained; WinSW is maintained and its XML is a
  near 1:1 for the unit file.
- **A native service** (e.g. `node-windows`, which itself shells out to WinSW) or a hand-written
  service stub adds code to own for no capability WinSW lacks.
- **A tray/session process** can't run without login — disqualified by the run-without-login
  requirement.

**Cost / risk accepted.** The job-object breakaway is the load-bearing, Windows-specific piece and is
**not** exercised by the Linux spike — it is the first thing the service child must prove on real
Windows. And **ConPTY inside a Session-0 service** must be verified there too (see open questions).

## D3 — Provisioning: winget for the base tools, npm for the app layer, bundle only WinSW

**Decision.** Mirror the Linux split ("system package manager for the base, static/npm for the
specialised bits"), using Windows-native equivalents:
- **winget** (first-party, present on Win10 1809+/Win11, no third-party trust, no extra admin story)
  for **git, Node ≥ 24, Python 3, gh** — `Git.Git`, `OpenJS.NodeJS`, `Python.Python.3`, `GitHub.cli`.
- **npm** for **claude** and the **pty layer (`node-pty` + `ws`)** — exactly the Linux path; `node-pty`
  ships Windows prebuilds, so no Visual Studio build tools in the common case.
- **Bundle only the tiny `WinSW.exe`** (pinned), the analog of the pinned static `ttyd`/`glab`.
- Fallback to **bundled portable binaries** for hosts too old for winget, the analog of install.sh's
  nodejs.org-tarball fallback.

**Why not choco.** Chocolatey is third-party, generally needs an elevated shell, and duplicates what
winget now does first-party. winget also side-steps a subtlety: provisioning runs **at install time**
(interactive, admin), not from the Session-0 service, so winget's per-user execution-alias model is a
non-issue.

**Cost.** winget availability varies on older/Server SKUs; the portable fallback covers that but is
ours to keep current (same tradeoff the Linux tarball fallback already accepts). Node's enforced
minimum is **24** (`NODE_MAJOR_MIN`), which the Windows installer must assert.

## D4 — Paths & permissions: XDG→known-folders, `icacls` for `chmod 600`, long-path on

**Decision.**
- Map the dir model onto Windows known folders: `REPOS_ROOT` operator-set (default under
  `%USERPROFILE%`); `.turma/worktrees` stays relative to `REPOS_ROOT` (unchanged); `~/.turma` →
  `%USERPROFILE%\.turma` (registry `sessions.json`, `peers.tsv`, uploads — dotdirs are fine on
  Windows); `~/.config/turma-agent` → `%APPDATA%\turma-agent` (the `TURMA_AGENT_ENV` file + config);
  `~/.claude/projects` → `%USERPROFILE%\.claude\projects` (where Claude Code already writes on
  Windows). `state.json` is hub-side and unaffected.
- Replace **`chmod 600`/`700`** (the token env file + config dir) with an **`icacls` owner-only ACL**:
  disable inheritance, grant only the running user + `SYSTEM`. Consider **DPAPI** to encrypt the token
  at rest (open question) — a *stronger* posture than the Linux 600, not merely equal.
- **Enable long paths** (`LongPathsEnabled` + `git config --system core.longpaths true`): a random
  worktree name under a deep `REPOS_ROOT` easily crosses the legacy 260-char `MAX_PATH`, and git
  worktrees + `node_modules` are exactly where this bites.
- Normalise path separators and drive letters in the manager (it currently assumes POSIX paths in
  several places — part of D5's portability pass).

**Why.** These are the mechanical translations; the only judgement calls are the security posture
(icacls vs DPAPI) and committing to long-path support up front rather than debugging truncation later.

## D5 — Language: PowerShell for the OS shell layer; python + node runtime unchanged

**Decision.** Rewrite only the **OS-facing shell layer** — today's bash `bootstrap.sh`, `install.sh`,
`turma-agent` (launcher), `turma-agent-update`, `turma-agentctl` — in **PowerShell**. Keep the
**shared runtime (`hub-agent.py` + the Node tunnel/pty-host) as the one cross-platform codebase**;
do not fork it per OS.

**Why PowerShell for the shell layer.** The `curl | bash` front door must run with **zero
prerequisites** — `bootstrap.sh` deliberately runs before python is even installed. On Windows the
only guaranteed-present shell is PowerShell, which is also the first-class interface to exactly what
this layer touches: Services (WinSW control), NTFS ACLs (`icacls`), winget, job objects, known
folders. A Node launcher would reintroduce the chicken-and-egg (Node not yet installed) and needs
native addons for the Windows process APIs; bash isn't native.

**Why NOT rewrite the manager.** `hub-agent.py` is ~25k lines of shared fleet logic and every
cross-cutting contract. Forking it per OS is the worst outcome. Instead, **`hub-agent.py` needs a
bounded Windows-portability pass** — the real hidden cost of this epic — abstracting the Unix-only
seams behind the pty-host and small shims: the tmux CLI calls (→ the D1 control channel),
`os.setsid`/POSIX signals/process-group kills (→ Windows job/console-group semantics), `chmod`/`/proc`
liveness (→ `icacls` / `os.kill(pid,0)` which works on Windows / the control channel's `alive`), and
the same-FS `mv` swap in the updater. This pass is its own child and is where schedule risk lives, not
in the terminal spike.

## Decisions at a glance

| # | Axis | Choice |
|---|------|--------|
| D1 | Terminal / PTY | Persistent per-session `node-pty` (ConPTY) host; serves ttyd `tty` protocol + a control channel; detached + registry-adopted |
| D2 | Service / supervision | Windows Service via **WinSW**; children break away from the job object for manager-only restart; Session 0 = run-without-login |
| D3 | Provisioning | **winget** (git/node/python/gh) + **npm** (claude/pty) + bundled **WinSW**; portable-binary fallback; not choco |
| D4 | Paths / permissions | Known-folder mapping; `icacls` owner-only for `chmod 600` (DPAPI optional); long-paths on |
| D5 | Language | **PowerShell** for the shell layer; **python + node runtime stays one cross-platform codebase** (manager gets a portability pass) |

## Open questions for Malcolm

None block this ADR. Recorded for the epic's children:

1. **ConPTY in Session 0 (highest risk).** Verify a ConPTY session spawns and drives correctly from a
   non-interactive **Windows Service** context on a real host — this is the one thing the Linux spike
   cannot cover, and it gates D1+D2. First task of the service/terminal child.
2. **Job-object breakaway = the `KillMode=process` guarantee.** Confirm on real Windows that
   `CREATE_BREAKAWAY_FROM_JOB` (or spawning outside the service job) actually leaves pty-hosts + claude
   alive across a service restart, and that adopt-on-boot re-attaches them.
3. **Token-at-rest posture.** `icacls` owner-only (parity with Linux 600) or **DPAPI**-encrypt the
   token (stronger, Windows-specific)? A one-line policy call.
4. **Windows SKU floor.** Minimum supported Windows (ConPTY needs 10 1809+/Server 2019+; winget needs
   1809+). Setting a floor lets the installer drop the portable/winpty fallbacks.
5. **`capture-pane` fidelity.** Is a headless-emulator-rendered grid (for `_busy_from_capture`) needed
   day one, or is raw-ring capture enough until the busy/prompt parsers are ported? A drive-child
   scoping call.
