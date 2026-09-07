---
paths:
  - "agent/native/README-windows.md"
  - "docs/windows-agent-adr.md"
---

# Native Windows agent (no-WSL) — map + operator-doc invariants (epic XERK-666)

This is the **entry point** for the native Windows agent. It does NOT re-derive the
component invariants — each lives in the `paths:`-scoped rules file that loads when
you touch that component's sources. This file loads when you touch the **operator
guide** (`agent/native/README-windows.md`) or the **ADR** (`docs/windows-agent-adr.md`),
so it points you at the right detailed file and keeps the operator doc honest.

The shared runtime (`hub-agent.py`, `tunnel-agent.js`, `hooks/`) is ONE
cross-platform codebase — **never forked per OS** (ADR D5). Windows replaces only
the OS-shell layer around it. Read `docs/windows-agent-adr.md` for *why* (D1–D5,
the terminal spike, open questions); the rules files below are the operative rules.

## Component → source → detailed rules file

| Component | Source | Rules file (loads on those sources) |
|---|---|---|
| `hub-agent.py` portability (paths, `%APPDATA%`, icacls ACL, liveness/degradation) | `agent/hub-agent.py` | `windows-agent.md` (XERK-670) |
| Launcher / service+control / installer / bootstrap / self-updater | `agent/native/windows/**` | `windows-launcher.md` (XERK-669/671/672/673/674) |
| Per-session pty-host (ttyd+tmux drop-in) | `agent/win/**` | `windows-terminal.md` (XERK-668) |
| Install lay-down + tooling (shared with Linux) | `agent/native/**` | `agent-native.md` |
| Operator guide (install/configure/service/update/uninstall + degradation) | `agent/native/README-windows.md` | **this file** |

`agent/native/windows/**` loads BOTH `windows-launcher.md` and `agent-native.md`;
`agent/native/README-windows.md` loads `agent-native.md` and this file.

## The invariants the operator doc rests on — where each is OWNED

Pointers, so a change to the operator guide never drifts from the enforced rule:

- **Packaging lockstep — a new `agent/*.py` sibling `hub-agent.py` imports must land
  in EVERY packaging path or the runtime runs DARK.** On Windows the paths are
  `install.ps1`'s `$RuntimeFiles`/`$RuntimeDirs` copy + `$VerifyFiles`, the updater's
  payload swap, and release staging — the Windows twin of `agent-native.md`'s
  "ALL THREE packaging paths". Owned by `windows-launcher.md`.
- **Session-preserving restart reaps the CONTROL PLANE only** — launcher, manager,
  tunnel + supervisor — NEVER the detached per-session pty-hosts, which survive and
  are re-adopted on boot (`KillMode=process` analog; supervisor reaped BEFORE the
  tunnel). Owned by `windows-launcher.md` (service/control) + `windows-terminal.md`
  (the pty-host's detached/adopt lifecycle).
- **ACL-correct token write** — the config/token env file gets an owner-only NTFS
  ACL (`icacls /inheritance:r /grant:r <user>:F SYSTEM:F`, the `chmod 600` analog),
  BEST-EFFORT (bytes already on disk; a failure warns, never aborts). Owned by
  `windows-agent.md` (`restrict_file_to_owner`) + `windows-launcher.md` (`install.ps1`).
- **DEVICE_NAME match** — the manager refuses to persist a rolled/enrolled token
  whose name half ≠ this host's `DEVICE_NAME` (never a silent invalidation); the hub
  mints for the name the agent beats as. Owned by `windows-agent.md` (`token_device_name`)
  + `windows-launcher.md` (self-enroll).
- **The Windows release asset is `turma-agent-windows-v<version>.zip` + `.zip.sha256`,
  manifest component `agent-windows`** — a SHARED contract that `bootstrap.ps1`, the
  updater, and CI packaging (XERK-676) must resolve identically. Owned by
  `windows-launcher.md`; the CI/release half is `release.md`.

## Docs discipline (this ticket, XERK-677)

- The operator guide is `agent/native/README-windows.md` (NOT an always-loaded
  instruction file, so no size cap) — keep it operator-facing; component internals
  belong in the rules files above, not restated there.
- Every instruction file (`CLAUDE.md`, `.claude/rules/*.md`) stays **under 40,000
  chars** — CI enforces it (`Instruction file size limits` in `code-scan.yml`, which
  already globs `.claude/rules/*.md`, so this file is covered with no CI change).
  Check with `wc -m` (`-m`, not `-c`).
- **No web/UI parity surface** — the Windows agent is agent-side plumbing; nothing in
  `turma/public/` changes, so no `android/PARITY.md` line is due.
