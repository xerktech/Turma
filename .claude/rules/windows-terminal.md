---
paths:
  - "agent/win/**"
---

# Native Windows agent — terminal layer invariants (XERK-668, epic XERK-666)

The per-session **pty-host** replaces the Linux `tmux + ttyd` stack on a native
Windows host. **The decisions and their rationale (D1-D5, the spike, the open
questions) are in [`docs/windows-agent-adr.md`](../../docs/windows-agent-adr.md)** —
read it for *why*; this file is the rules. Code lives in `agent/win/`
(`agent/win/README.md` is the operator guide + manual drive recipe).

The load-bearing finding the whole design descends from: on Linux **`tmux` and
`ttyd` are two views of one session, and `ttyd` is the smaller half** — a Windows
replacement must absorb ALL FOUR roles (terminal ws, the HTTP client, input,
capture/persistence), not just the ws bridge.

## The pty-host is a ttyd DROP-IN, byte-for-byte — nothing hub-side changes

- **`turma/server.js` proxies `/term/<id>/*` to the port unchanged** (`proxyTerm`
  for HTTP, the ws-proxy for the upgrade). It **buffers the served HTML and injects
  its font/scroll/OSC52 shims before `</head>`**, and those shims + the jump-to-
  bottom pill drive ttyd's **`window.term`**. So the pty-host MUST serve a client
  that keeps `</head>`, `window.term`, the `tty` subprotocol, `/token`, `/ws`, and
  builds those URLs from `window.location.pathname`. **We do not author that client
  — we vendor ttyd's real one** (`agent/win/vendor/ttyd-1.7.7/index.html`, captured
  verbatim from the pinned binary; `PROVENANCE.md` reproduces it). Re-vendoring a
  newer ttyd MUST re-run the protocol test — its "hub-integration anchor" case is
  the guard that a new client didn't drop one of those.
- **The `-c term:<token>` basic-auth is the contract**: the hub proxies every
  `/term` request with `Authorization: Basic base64(term:<token>)` (`ttydAuth`),
  so the pty-host validates exactly that on the HTTP surface AND the ws upgrade.
  `/token` returns `base64("term:<token>")` (ttyd's shape — the value the browser
  echoes back as the ws init `AuthToken`), verified against the real binary.
- **The command bytes are DIRECTION-SPECIFIC** and were read off real ttyd 1.7.7,
  not inferred: client `1`=RESIZE but server `1`=SET_WINDOW_TITLE; client `2`=PAUSE
  but server `2`=SET_PREFERENCES. Getting one wrong silently breaks the terminal,
  so they are pinned in `test/tty-protocol.test.mjs`. The server connect sequence
  is title(`1`) → preferences(`2`) → scrollback(`0`), then live output.
- **SET_PREFERENCES carries the `-t` flags** `_launch_ttyd` passes (font/fontSize/
  webgl/…) — `DEFAULT_PREFS` is the fleet-parity set, so a Windows terminal renders
  like the Linux one. Delivered over the ws on connect, NOT baked into the HTML
  (ttyd does the same).

## Pure protocol vs. I/O shell — the split is a CI constraint, not style

- **`agent/win/tty-protocol.mjs` owns every wire/auth/framing DECISION plus the
  `TerminalGrid` screen emulator (XERK-703), and imports NO I/O** (no node-pty, no
  ws, no http, no fs writes). `code-scan.yml` runs its tests with `node --test` and
  **installs zero npm deps** (node-pty is a native addon CI cannot build), so
  anything CI must check lives here — which is WHY `TerminalGrid` is hand-rolled
  dep-free rather than pulling `@xterm/headless` into the I/O shell (that would put
  the terminal LOGIC where CI cannot reach it, and add a runtime dep the self-updater
  does not rebuild). This mirrors how `server.js` hand-rolls its WS framing and the
  dsh guard splits pure `*.test.mjs` from host-proof drives.
- **`agent/win/pty-host.mjs` is only the node-pty + ws + http around it** — never
  imported by CI, only run. Keep new protocol logic in the pure module with a test,
  not in the shell.
- **`drive.mjs` is host-proof** (needs the deps) and is EXCLUDED from CI by its
  filename (not `*.test.mjs`), exactly like the XERK-667 spike. It proves the
  end-to-end lifecycle on a real pty; re-run it after any shell change.

## Lifecycle — detached, adopted, KillMode=process

- **Spawned DETACHED so it outlives a manager restart** (the manager does
  `spawn(..., {detached:true}); child.unref()`); a fresh manager re-adopts it from
  the persisted `{pid,termPort,ctrlPort}` state file ALONE — the direct analog of
  `resume_on_boot`'s `ttydPid`/`ttydPort` probe. The pty-host itself does not
  "adopt"; it persists state (atomic temp+rename) and keeps running.
- **Clean SIGTERM/SIGINT tears the pty down; any other spawner death leaves it
  running** to be re-adopted. This is the `KillMode=process` invariant the D2
  service child depends on — its job-object breakaway must actually deliver it on
  real Windows (the ADR open question the Linux backend cannot exercise).
- **The manager keys `session id → pty-host process` and caps at `MAX_SESSIONS`**,
  exactly as it caps tmux sessions today. The pty-host is per-session; the cap is
  the manager's, not the host's.

## The control channel is the tmux-CLI replacement (D5 wired by XERK-697)

- **`inject`/`capture`/`alive`/`resize`/`kill` map 1:1 to the tmux calls
  `hub-agent.py` makes** (`_type_into_pane`/`_capture_pane`/`_tmux_alive`/…). D1
  ships and pins that protocol; the manager side that DRIVES it (D5) is now
  wired — **the manager-side seam is `.claude/rules/windows-agent.md` ("The
  terminal seam IS wired")**. Do not add a second Windows branch into the tmux
  paths outside those `IS_WINDOWS` dispatches.
- **`capture` returns the RENDERED screen grid (`TerminalGrid`), not the raw ring
  (XERK-703).** The raw scrollback ring is bytes over TIME, and Claude Code paints
  its `esc to interrupt` footer ONCE per turn then updates the spinner in place, so
  a turn that streams past the ring's byte window pushes the sole marker out of the
  tail and `_busy_from_capture` reads a working session IDLE (the false-idle that
  fired the "you have uncommitted work" nudge). `TerminalGrid` is a minimal VT
  emulator in the pure module, fed EVERY pty byte, returning the visible screen as
  plain text — the `tmux capture-pane -p` analog, where the footer is a persistent
  element regardless of when it was painted. The ring is KEPT, but only for the ws
  REPLAY on re-attach (raw bytes are what xterm.js wants); `capture` no longer reads
  it. This is the headless-emulator the ADR flagged, hand-rolled dep-free (so it
  stays in the CI-tested pure module) and validated BYTE-FOR-BYTE against
  `@xterm/headless` on real captured Claude output (`test/fixtures/`), a
  development-only oracle, not a CI dep. The emulator covers exactly the escape
  subset Claude emits; per-word absolute `\x1b[NG` repositioning resyncs the column
  so a width miscount in one segment self-corrects at the next move.
- Control is loopback + a `?token=<token>` shared secret (defence in depth); the
  manager holds the token and reads `ctrlPort` from the state file.
- **The pty-host REFUSES to start without `--auth-token`** — unlike ttyd's optional
  `-c`, the control channel is ours and an empty token would accept unauthenticated
  `inject`/`kill`; the manager always mints one (`_launch_ttyd`'s
  `-c term:{TURMA_TOKEN}`), so an empty token is a misconfiguration, not a mode.
- **The `-m` client cap counts RAW connections, not just inited ones** (`termWss.clients`),
  or a socket that never sends its init frame bypasses it.

## The ORIGIN keep-alive must outlast the hub's pooled-channel idle window

- The hub keeps a per-`host:port` keep-alive `http.Agent` over the tunnel (`termAgentFor`) and reuses
  a FREE channel for the next asset/`/token` request. **If this side closes first, the hub sends that
  request down a socket already FIN'd** and the browser gets `ECONNRESET` / "socket hang up" before it
  ever reached us — the terminal that needs two or three refreshes. `termRetryReset` replays exactly
  ONE such request and the pool holds four, so two consecutive stale sockets still 502'd.
- So `KEEPALIVE_TIMEOUT_MS` (75s, applied to BOTH servers via `applyKeepAlive`) must stay comfortably
  above `TERM_AGENT_IDLE_MS` in `turma/server.js` (30s), and `HEADERS_TIMEOUT_MS` above it in turn — a
  `headersTimeout` at or below `keepAliveTimeout` closes an idle kept-alive socket anyway.
  **Node's default `server.keepAliveTimeout` is 5_000ms**, so leaving it unset GUARANTEES the race on
  any terminal whose assets are more than ~5s apart. Both halves are pinned, each from the other side
  (`tty-protocol.test.mjs` and `server.test.js`); raising one means raising the other.
  - **The hub half only evicts anything because `armChannelIdleTimeout` makes it real.** A tunnel
    channel is a Duplex whose `setTimeout` is a no-op stub, and `http.Agent`'s `timeout:` is applied
    ONLY by calling `socket.setTimeout` — so `TERM_AGENT_IDLE_MS` sat inert, and the two-sided
    contract described an eviction that never happened, until that was measured. Never assume the hub
    ages a stale channel out for you: on Linux it never did, which is why the bounded replay is the
    real mitigation there.
- **Do not write that ttyd held connections longer — it does not.** A real `ttyd 1.7.4
  (libwebsockets 4.3.3)` was measured closing an idle keep-alive connection after **5.0s**, and
  `_launch_ttyd` passes no flag to change it, so the stale-pooled-socket race is FLEET-WIDE, not a
  Windows novelty. The two-sided window above fixes it only where the origin is the pty-host; on
  Linux the mitigation is `termRetryReset`'s bounded replay (budgeted to the free-socket pool size,
  because one reset evicts one socket and the pool parks four the origin ages out together). No idle
  window the hub could pick sits under 5s without re-dialling a tunnel channel every few seconds.
- **The assignments live in the PURE module on purpose** (`applyKeepAlive`,
  `installFatalErrorHandlers`). CI runs only `agent/win/test/*.test.mjs`; `pty-host.mjs` is never
  imported, so anything written inline there is covered by nothing and deleting it — reinstating the
  exact bug — passes every gate. The one thing that cannot move, the emitter LIST, is pinned by a
  test that reads the call site out of the source.

## The auth token is LIVE — a roll must never cost a session

- **`--auth-token-file` names a manager-owned file the pty-host re-reads PER AUTH CHECK**
  (`authTokensInForce`), so republishing that file IS a token roll — no relaunch, nothing lost.
- **BOTH the file token and the baked `--auth-token` are in force; the file must NOT outrank it.**
  Letting it win hands any stale or failed-to-update file the power to lock the MANAGER — which
  authenticates with its env `TURMA_TOKEN` — out of a pty-host it just spawned, which is the same
  zombie by another door, and makes "a failed publish leaves the baked token in force" untrue. The
  cost is deliberate: a pre-roll credential keeps working against an already-running pty-host until
  it is relaunched, on a loopback port, behind a credential that is defence in depth.
- **The read is hardened, because it is on the only thread, per request, on a session-writable path**:
  a non-REGULAR file is refused (a planted FIFO would block the event loop forever, wedging the
  terminal AND the control channel with the pid still alive), a file over `TOKEN_FILE_MAX` is refused
  rather than read, and the answer is cached on (mtime, size, inode, dev).
- **A baked-in-only token is fatal HERE in a way it is not on Linux.** There a hub token roll kills and
  relaunches the stale ttyd while tmux (and the claude in it) lives on. Here the pty-host IS the pty,
  so the same relaunch kills the operator's running session — and leaving it alone left an
  unrecoverable zombie: the terminal 401s into a browser password prompt, the ws upgrade is refused,
  AND the manager's own control channel stops authenticating, so `capture`/`inject`/`kill` silently
  fail while the pid stays alive and the session reports `running` forever.
- **A read failure falls back to the BAKED token, never to an empty one** — an empty token means "no
  auth required" to `basicAuthOk`/`controlTokenOk`, which would open the control channel that accepts
  `inject`/`kill`. The state file carries `authTokenFile` so the manager can tell a pty-host that
  predates this apart from one that can be healed.
- **`serializeState` is a WHITELIST, and `pty-host.mjs` is never imported by CI.** A field added to
  `writeState()` but not to it is silently dropped, and the manager reads the ABSENCE as fact — that
  omission shipped once with `authTokenFile` and turned the post-roll self-heal into "tear down every
  session", while a python test that hand-wrote the field into a FAKE state file stayed green. The
  writer spells every key out and a CI test reads its object literal; never assert the state file's
  shape against one a test wrote itself.

## Bind BOTH servers before spawning the pty, and handle their `'error'`

- `pty.spawn` runs only from the `listen` callback once BOTH servers are up. It used to run at module
  top, so an `EADDRINUSE` — a port a failed teardown left held, or any squatter winning the TOCTOU
  against the manager's `_port_open` probe — was an uncaught `'error'` that killed the process with
  `claude.exe` ALREADY RUNNING under the ConPTY, leaking a child nothing could reach while the manager
  waited out the whole `PTY_SPAWN_TIMEOUT_SEC` on its beat.
- **`ws` RE-EMITS its attached http server's `'error'` on the WebSocketServer**, so a handler on the
  http server alone is not enough — the re-emit is itself an unhandled `'error'` and throws. Handle it
  on all four (`termHttp`, `ctrlHttp`, `termWss`, `ctrlWss`), log which server and why, and exit
  non-zero: the `.log` is the manager's only window into a launch that never published.

## Truecolor & OSC 52 — preserved, and simpler than the tmux stack

With no multiplexer in the middle, both pass straight through: the child env sets
`COLORTERM=truecolor` (the analog of `tmux.conf`'s RGB override) so 24-bit color
reaches truecolor xterm.js, and the app's OSC 52 copy escape reaches the hub's
injected `TERM_OSC52_JS` handler as raw output. The `tmux.conf` `Ms` +
`set-clipboard on` existed only to undo tmux's dropping of OSC 52; there is nothing
to undo here. Detail: `agent/win/README.md`.

## Tests

- CI: `agent/win/test/tty-protocol.test.mjs` (stdlib only) — pins the command
  bytes against the capture, the auth/`/token`/prefs/redirect/ring/state/control
  logic, the vendored-client hub-integration anchors, and `TerminalGrid` against
  real captured Claude output (`test/fixtures/`, XERK-703): a mid-turn render reads
  BUSY where the raw ring tail reads idle, chunk-boundary stability, and dialog
  rendering.
- Host proof: `agent/win/drive.mjs` (`npm run drive`) — spawn (via a spawner that
  exits, proving the child outlives it) → bind failure on a taken port (clean
  non-zero exit, a reason in the log, no orphaned pty) → HTTP surface
  (302/index/token/auth) → attach/detach/reattach with scrollback → control →
  adopt-from-state → keep-alive across an idle gap past Node's 5s default → a
  live token roll with the pty and its scrollback intact → teardown.
  **OS-aware child** (`CHILD_CMD` = a POSIX shell on forkpty, `%COMSPEC%` on
  ConPTY), so it runs on BOTH backends — do not re-hardcode `/bin/bash` (XERK-678).
  Host-verified **24/24 on real Windows ConPTY** (XERK-678, node-pty 1.1.0 bundled
  win32-x64 prebuild). Still un-exercised by the plain drive: ConPTY inside a
  Session-0 WinSW service + job-object breakaway (need the real service; ADR open
  questions).

## Teardown, grid correctness and pane geometry (C6/C9/C14/C15)

- **A deliberate teardown closes every terminal socket with 1000 before exiting.**
  The vendored ttyd client branches on the close code: anything but 1000 shows
  "Reconnecting..." and re-dials forever. `process.exit` closes sockets abruptly
  as **1006** and does not flush pending writes, so the browser reconnect-stormed
  (each iteration re-fetching `/term/<id>/token` through the hub and dialling a
  dead port) and the final screen could be truncated. `closeTermClients(1000, …)`
  runs in BOTH `onExit` and `shutdown()`, then the process exits on its own
  `PTY_EXIT_DRAIN_MS` timer — never waiting on a peer, so a wedged client cannot
  keep the host alive. **Never go back to a bare `process.exit` on a teardown path.**
- **`ScrollbackRing` is a bounded CHUNK LIST with a running byte total, not one
  growing Buffer.** `Buffer.concat([this.buf, b])` per pty chunk copied the whole
  256 KiB ring on every write — on the pty-host's ONLY thread, which also fans
  bytes to every attached browser and answers the manager's beat-path control
  RPCs. Appends are O(1) amortised; only `bytes()` pays a concat, memoised until
  the next append. The observable tail is byte-for-byte what the old code
  produced (pinned by a reference-implementation test).
- **A BLANK capture is `None` ("can't tell"), never `""`.** `_pty_capture` maps a
  whitespace-only grid to None because `_busy_from_capture("")` returns False — an
  AFFIRMATIVE not-busy that skips the transcript-freshness fallback an
  uncapturable Linux pane gets, so a working session reads idle and can fire
  ready-for-review mid-turn. This is XERK-703's false-idle class by another door,
  and it is reachable in ordinary use (right after spawn; between an `ED 2` and
  the app's repaint), not only on failure.
- **`TerminalGrid` refuses an unusable scroll region and clamps EL/ED.** An
  inverted `DECSTBM` (`\x1b[10;5r` → top 9, bot 4) made `_scrollUp`'s splice pair
  remove and reinsert at the wrong ends and scramble the screen; it is now
  IGNORED (the current region stands). `EL`/`ED` with `m===1` looped `c <= cc`,
  and `cc` sits at `cols` while a wrap is PENDING, which wrote `grid[cr][cols]`
  and grew the row past `cols` — `capture()` trimmed that cosmetically while
  `resize`/`_scrollUp` carried the wrong row shape forward. Both are untrusted
  pty bytes reachable by `echo`.
- **The pty returns to its LAUNCH geometry when the last viewer detaches.** A
  browser sizes the real pty to its own viewport, and nothing put it back, so the
  first narrow client framed the pty for the rest of the session's life. Every
  manager read is calibrated against `--cols 220 --rows 50` (the tmux `-x 220 -y
  50` analog): the busy truncated-hint/spinner fallbacks, `parse_pane_prompt`,
  `parse_model_picker`, `_answer_trust_dialog`'s short-line heuristics, and the
  chat's pane scrape. Restoring on DETACH rather than refusing the resize keeps an
  attached viewer's terminal fitting its window (refusing would letterbox and
  diverge from ttyd) while the unobserved state — most of a session's life, and
  the only state the manager parses — is always parser-shaped.
- Tests: the `C6:`/`C14:` cases in `agent/win/test/tty-protocol.test.mjs` (ring
  reference-equivalence + ceiling, inverted DECSTBM, EL/ED row width) and
  `test_a_blank_capture_reads_as_cant_tell_not_as_idle` in `test_hub_agent.py`.
  **C9 and C15 live in `pty-host.mjs`, the I/O shell, which needs node-pty and is
  excluded from CI — both are HOST-VERIFIED ONLY**, like the rest of that file.

## Liveness proof and teardown order (C7/C8/C13)

- **The BOOT/adopt decision proves the pty-host, not a pid** (`_pty_alive(..., strict=True)`,
  reached via `_tmux_alive(..., strict=True)` from `resume_on_boot`). The state
  file is removed ONLY by `_pty_teardown`, so a hard stop — reboot, SIGKILL, OOM,
  a WinSW force-kill — leaves it naming a DEAD pid, and Windows recycles pids from
  a small space. A pid check alone then reads an unrelated process as this session
  and ADOPTS a session that is not there: no relaunch, `running` forever, dead
  terminal, no claude, and nothing re-checks. Strict additionally probes the
  published `ctrlPort`. It **fails shut** (an absent/garbage port reads closed) —
  a false negative merely resumes the session, while a false positive strands it
  dead-but-`running` with no operator recovery. The Linux path is name-keyed
  (`tmux has-session`) and cannot hit this, so it ignores the flag.
  - **Strict is NOT for the beat.** It costs a loopback connect, and the beat's
    liveness scan runs per session per beat under `OFFLINE_AFTER_MS`. A recycled
    pid mid-run is also far less reachable — this manager spawned that pty-host.
- **The teardown SIGNAL is a fallback, never the first move** (C8,
  `PTY_CLEAN_EXIT_GRACE_SEC`). `os.kill(pid, SIGTERM)` on Windows is NOT a signal:
  it maps to `TerminateProcess` for every signal but `CTRL_*_EVENT`, so the
  pty-host's own handler never runs there. Firing it immediately after the `kill`
  RPC PRE-EMPTED the clean teardown that RPC had just asked for — sockets died as
  1006 (so the client reconnect-stormed), buffered output was lost, and the ConPTY
  child was left to handle closure. `_pty_teardown` now waits out a short grace
  for the host to exit on its own and only signals if it did not. The state file
  is still kept when the reap fails (C3), so a wedged host is retried, not orphaned.
- **`dropTermAgents` matches on the `host:` PREFIX only** (C13). Keys are always
  `` `${name}:${port}` ``, so the old `key === name` arm could never match and read
  as a second matching rule that was not one. The `:` is what stops host `a`
  dropping host `ab`'s pools.
- **`_pty_task_cleanup` removes the `.spawn.json` as well as the `.cmd`** (C13).
  That file carries `TURMA_TOKEN` and the whole launch env, and only the SPAWNER
  removed it — so a `schtasks /run` that succeeded while the task engine never
  launched the spawner (or a manager that died in between) left a
  credential-bearing file on disk indefinitely. It is `restrict_file_to_owner`'d
  at write, so this is defence in depth, but a secret with no reader should not
  outlive the thing that needed it.
- Tests: `test_strict_liveness_refuses_a_recycled_pid`,
  `test_strict_is_windows_only_and_tmux_ignores_it`,
  `test_teardown_lets_the_pty_host_exit_cleanly_before_signalling`. Both were
  mutation-checked: restoring the pid-only read fails the first, and restoring the
  unconditional `os.kill` fails the third.
