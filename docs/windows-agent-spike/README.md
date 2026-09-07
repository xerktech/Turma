# XERK-667 terminal-layer spike — ConPTY host with attach / detach / re-attach

**Throwaway spike. Not production code.** It proves the riskiest decision in
[`../windows-agent-adr.md`](../windows-agent-adr.md) (Decision A): that a native Windows agent can
replace the Linux `tmux + ttyd` terminal stack with **one persistent [`node-pty`](https://github.com/microsoft/node-pty)
host per session** that (a) speaks ttyd's `tty` websocket wire protocol verbatim — so the hub,
`tunnel-agent.js`, and the browser's xterm.js need *no* change — and (b) exposes a small control
channel that replaces the tmux CLI paths the manager drives (`send-keys` / `capture-pane` /
`has-session`).

## Why this is a real proof despite running on Linux

`node-pty` is one cross-platform API over two OS backends: **ConPTY** on Windows (Win10 1809+),
**forkpty** on Unix. The spike drives the *identical* `pty.spawn().onData/.write/.resize/.kill`
surface that the Windows build binds to ConPTY. What it proves is platform-independent: the
attach/detach/re-attach state machine, the ttyd protocol framing, the scrollback-replay model, the
control channel, and the "survive the manager, re-adopt from persisted state" lifecycle. What it
does **not** prove — and the ADR keeps as an open risk to verify on a real Windows host — is
ConPTY's own behaviour: running in a non-interactive **Session 0** service context, and ConPTY's
redraw/resize quirks. See the ADR's "Open questions".

## Run it

```bash
cd docs/windows-agent-spike
npm install            # node-pty + ws
node drive.mjs         # prints a PASS/FAIL checklist; exit 0 iff all pass
```

- Needs Node ≥ 24 (the fleet minimum). `node-pty` compiles a native addon on `npm install`, so a
  Linux box needs a C++ toolchain (`build-essential`). **No compiler?** swap the dependency for the
  prebuilt fork `@homebridge/node-pty-prebuilt-multiarch` (same API, ships linux-x64/win-x64
  prebuilds) — the spike code is unchanged. On Windows, `node-pty` ships prebuilds, so no Visual
  Studio build tools are needed for the common case.
- A captured passing run is committed as [`SPIKE-RUN.txt`](./SPIKE-RUN.txt) (14/14) so a reviewer
  need not re-run it.

## The two files

- **`pty-host.mjs`** — the persistent per-session host. Owns one pty, keeps a scrollback ring, and
  serves two loopback servers: a **terminal** ws speaking the ttyd `tty` subprotocol, and a
  **control** ws speaking JSON (`inject` / `capture` / `alive` / `resize` / `kill`). Spawned
  detached, it outlives its spawner and publishes `{pid, termPort, ctrlPort}` to a state file — the
  registry a fresh manager re-adopts it from.
- **`drive.mjs`** — plays the manager. Runs the seven-phase checklist below and exits non-zero on any
  failure.

## What each check maps to (Linux mechanism it replaces)

| Phase | Spike check | Replaces on Linux |
|---|---|---|
| 1 SPAWN | host up on loopback, pid alive, state published | `tmux new-session -d` + registry record |
| 2 ATTACH | ws negotiates `tty`; client sees its command output | ttyd `-W` + `tmux attach` |
| 3 DETACH | pty still alive after the only client closes | closing the browser terminal tab |
| 4 REATTACH | new client gets scrollback replay **and** live I/O | re-opening ttyd; tmux repaints the pane |
| 5 CONTROL | `inject` + `capture` + `alive` off the terminal ws | `send-keys` / `capture-pane` / `has-session` |
| 6 ADOPT | fresh manager re-adopts from persisted `{pid,ports}` only | `resume_on_boot` pid+port probe under `KillMode=process` |
| 7 TEARDOWN | explicit `kill` stops the pty; host process exits | `_kill_ttyd` + `tmux kill-session` |

## The ttyd `tty` wire protocol the host implements

Preserving this byte-for-byte is what lets the existing tunnel/hub/xterm.js stack stay untouched
(they shovel opaque bytes — ADR §"The contract we must not break"). Command byte is the first byte
of each frame:

- client → server: `0`=INPUT (keystrokes), `1`=RESIZE (`{columns,rows}` JSON), `2`/`3`=pause/resume,
  and the first message is the init JSON `{"AuthToken","columns","rows"}` (starts with `{`).
- server → client: `0`=OUTPUT (pty bytes), `1`=SET_WINDOW_TITLE, `2`=SET_PREFERENCES.
