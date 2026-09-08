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

- **`agent/win/tty-protocol.mjs` owns every wire/auth/framing DECISION and imports
  NO I/O** (no node-pty, no ws, no http, no fs writes). `code-scan.yml` runs its
  tests with `node --test` and **installs zero npm deps** (node-pty is a native
  addon CI cannot build), so anything CI must check lives here. This mirrors how
  `server.js` hand-rolls its WS framing and the dsh guard splits pure `*.test.mjs`
  from host-proof drives.
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
- **`capture` returns the raw scrollback RING, not a rendered grid.** `_busy_from_
  capture` reads the *rendered* pane today; on Windows it scans that raw ring, and
  the plain-text markers it looks for (`esc to interrupt`) survive as contiguous
  substrings, so busy detection works as an ACCEPTED APPROXIMATION. Byte-for-byte
  parity would need a headless emulator (`@xterm/headless`) in the pty-host to
  render the ring — the ADR open question, still NOT built.
- Control is loopback + a `?token=<token>` shared secret (defence in depth); the
  manager holds the token and reads `ctrlPort` from the state file.
- **The pty-host REFUSES to start without `--auth-token`** — unlike ttyd's optional
  `-c`, the control channel is ours and an empty token would accept unauthenticated
  `inject`/`kill`; the manager always mints one (`_launch_ttyd`'s
  `-c term:{TURMA_TOKEN}`), so an empty token is a misconfiguration, not a mode.
- **The `-m` client cap counts RAW connections, not just inited ones** (`termWss.clients`),
  or a socket that never sends its init frame bypasses it.

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
  logic, and the vendored-client hub-integration anchors.
- Host proof: `agent/win/drive.mjs` (`npm run drive`) — spawn (via a spawner that
  exits, proving the child outlives it) → HTTP surface (302/index/token/auth) →
  attach/detach/reattach with scrollback → control → adopt-from-state → teardown.
  **OS-aware child** (`CHILD_CMD` = a POSIX shell on forkpty, `%COMSPEC%` on
  ConPTY), so it runs on BOTH backends — do not re-hardcode `/bin/bash` (XERK-678).
  Host-verified **24/24 on real Windows ConPTY** (XERK-678, node-pty 1.1.0 bundled
  win32-x64 prebuild). Still un-exercised by the plain drive: ConPTY inside a
  Session-0 WinSW service + job-object breakaway (need the real service; ADR open
  questions).
