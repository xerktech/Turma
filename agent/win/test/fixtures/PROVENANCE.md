# Terminal capture fixtures (XERK-703)

Raw pty output bytes captured from a REAL Claude Code 2.1.263 session, used to
pin `TerminalGrid` (the `capture-pane -p` analog the Windows pty-host renders)
against the exact escape stream Claude emits — the no-mock discipline.

Captured on Linux by running `claude` under a pty (`pty.fork()`, `TERM=xterm-256color`,
`COLORTERM=truecolor` — the same env the pty-host sets) and recording every byte
`os.read` returned. The TUI's escape output is the same node/Ink logic on every
OS, so a Linux capture is a faithful stand-in for the ConPTY stream.

- **`claude-working-turn.raw`** (100x40) — a full turn: boot, a prompt, the model
  streaming a multi-stanza poem, then turn completion. The interrupt-hint footer
  `... · esc to interrupt` is painted ONCE near the start (byte 3530) and never
  re-emitted as ~46 KB of body text streams — the exact shape that pushed the
  marker out of the raw scrollback ring and read the working session IDLE
  (XERK-703). At turn end the footer is gone (correctly idle).
- **`claude-trust-dialog.raw`** (100x40) — the boot trust-folder prompt, whose
  words are laid out with per-word cursor-column escapes (`\x1b[NG`) rather than
  spaces; proves the grid renders a dialog into readable text (the pane-prompt
  parse path), where the raw ring cannot.

Both were validated to render BYTE-FOR-BYTE identically under `TerminalGrid` and
`@xterm/headless` (the reference emulator) at every mid-stream cut point. The
test needs only `TerminalGrid` (stdlib), so it runs in CI; the @xterm cross-check
was a one-time development oracle and is not a CI dependency.
