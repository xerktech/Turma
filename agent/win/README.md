# Windows agent — per-session terminal layer (XERK-668)

The production form of the [XERK-667 spike](../../docs/windows-agent-spike/): one
**pty-host process per session** that owns the session's pty (ConPTY on Windows
via `node-pty`, forkpty elsewhere) and serves, on loopback, the **exact surface
ttyd serves today** — so the hub, `tunnel-agent.js` and the browser's xterm.js are
unchanged. It replaces BOTH halves of the Linux terminal stack: `tmux`
(detached session, `send-keys`, `capture-pane`, `has-session`) **and** `ttyd` (the
ws bridge + HTTP client). Decision D1 of [`../../docs/windows-agent-adr.md`](../../docs/windows-agent-adr.md).

## Files

| File | What |
|------|------|
| `tty-protocol.mjs` | **Pure, stdlib-only** ttyd wire protocol: frame bytes, basic-auth, `/token`, `-t` prefs, base-path redirect, scrollback ring, adopt-state, the JSON control protocol. All the DECISIONS — CI tests them with no npm install. |
| `pty-host.mjs` | The I/O shell wiring `node-pty` + `ws` + http around the pure module. Host-proof (native addon). |
| `vendor/ttyd-1.7.7/` | ttyd 1.7.7's real web client, vendored verbatim (see its `PROVENANCE.md`) + its MIT `LICENSE`. |
| `test/tty-protocol.test.mjs` | CI unit tests (stdlib only). Runs in `code-scan.yml`. |
| `drive.mjs` | Host-proof end-to-end drive (needs the deps). Excluded from CI, like the spike. |

## What the pty-host serves

Per session, two loopback servers, both behind basic-auth `term:<token>` (the
same credential ttyd's `-c` takes, which the hub proxies as
`Authorization: Basic base64(term:<token>)`):

- **TERMINAL** (`--term-port`, allocated off `TTYD_PORT_BASE` like ttyd today):
  - `GET <base>` → `302 <base>/` (query preserved) — the hub relies on this.
  - `GET <base>/` → ttyd's vendored `index.html` (the hub's `proxyTerm` injects
    its font/scroll/OSC52 shims into `</head>` and drives its `window.term`).
  - `GET <base>/token` → `{"token": base64("term:<token>")}` (ttyd's shape).
  - `WS  <base>/ws` (subprotocol `tty`) → the byte-for-byte ttyd protocol:
    server sends `1`=title, `2`=preferences (the `-t` flags), `0`=output;
    client sends the init `{AuthToken,columns,rows}`, `0`=input, `1`=resize,
    `2`/`3`=pause/resume.
- **CONTROL** (`--ctrl-port`, ephemeral, published in the state file) — the JSON
  ws the manager drives instead of the tmux CLI, gated on `?token=<token>`:
  `inject` (send-keys/paste), `capture` (capture-pane), `alive` (has-session),
  `resize`, `kill`.

Spawn it **detached** so it outlives a manager restart (`KillMode=process`); a
fresh manager re-adopts it from the persisted `{pid,termPort,ctrlPort}` state
file alone — the analog of `resume_on_boot`'s pid+port probe. The manager keys
`session id → pty-host process` and spawns at most `MAX_SESSIONS`, exactly as it
caps tmux sessions today.

## Manual drive recipe

```sh
cd agent/win
npm ci                 # node-pty (native build; Windows ships prebuilds) + ws
npm run drive          # spawn → HTTP surface → attach/detach/reattach →
                       # control → adopt-after-spawner-exit → teardown; exit 0 iff all pass
```

`drive.mjs` spawns the pty-host from a **throwaway spawner that exits**, proving
the pty child outlives its spawner (the manager-restart property), then drives it
as both the manager (control ws) and the browser (tty ws). On Linux node-pty
binds forkpty; the identical API binds ConPTY on Windows.

### Driving one by hand

```sh
node pty-host.mjs --session demo --term-port 7681 --auth-token secret -- /bin/bash &
# browser view (through the hub in production): http://127.0.0.1:7681/term/demo/
# with Authorization: Basic base64(term:secret)
```

## Truecolor & OSC 52 (the ticket's "or an explicit documented gap")

Both are **preserved, and are in fact simpler than the tmux stack** because there
is no multiplexer in the middle to flatten them:

- **Truecolor** — the pty-host runs the app *directly* on the pty (no tmux), so
  the app's 24-bit color sequences pass straight through to xterm.js, which is
  truecolor. The child env sets `TERM=xterm-256color` and `COLORTERM=truecolor`
  (the direct analog of `tmux.conf`'s `terminal-overrides ",*:RGB"`, which existed
  only to stop tmux quantizing). No terminfo override is needed.
- **OSC 52 copy-out** — the app's `ESC]52;…` clipboard escape passes through as
  raw pty output (an `0`=OUTPUT frame) to xterm.js, where the hub's injected
  `TERM_OSC52_JS` handler (unchanged) writes it to the system clipboard. The
  `tmux.conf` `Ms` capability + `set-clipboard on` existed only because tmux sat
  between the app and xterm.js and dropped OSC 52 otherwise; with no tmux there is
  nothing to drop it. Clipboard READ (`ESC]52;…;?`) stays unsupported, exactly as
  the hub's write-only handler intends.

## Not in this task (carried by the ADR)

- Wiring `hub-agent.py`'s tmux/ttyd calls to the control channel + spawn/adopt is
  the **manager portability pass (D5)** — a separate child. This task ships the
  terminal layer it will drive, with the control protocol pinned in
  `tty-protocol.mjs` and `.claude/rules/windows-agent.md`.
- **ConPTY inside a Session-0 service** and **job-object breakaway** are the two
  properties the Linux backend cannot exercise — the ADR's open questions for the
  service/supervisor child (D2). The `node-pty` API surface this drives is the
  identical one ConPTY binds; those two remain to be verified on a real Windows
  host.
