# Qwen Code integration — decision record (XERK-504)

Background and rationale for adding Qwen Code (`@qwen-code/qwen-code`) as a SECOND selectable
per-session runtime alongside Claude Code and dsh.

**This is history and reasoning, not an instruction file.** The operative invariants live in
`.claude/rules/qwen.md` (and, per subsystem, `qwen-migration.md`, `qwen-delegation.md`,
`agent-usage.md`, `agent-prs.md`, `turma-board.md`). Read this for *why*; read the rules for the rule.

## Shape: the interactive-TUI analogue of dsh

Qwen's process model is **Claude-shaped, not dsh-headless**: a pinned session id, native JSONL on
disk, tmux pane injection, `capture-pane` state parsing, a PreToolUse hard-deny guard. That single
fact is why almost every qwen child is simpler than its dsh twin:

| Concern | dsh (headless) | qwen (interactive TUI) |
|---|---|---|
| Liveness | control-socket `state` cache | real pane, `_pane_status` unchanged |
| Input / nudges | control socket (`_dsh_notify`) | the Claude pane path, no new arm |
| Terminal | suppressed; Turma Trajectory viewer | its own ttyd, unchanged |
| Resume store | separate `DSH_SESSIONS_ROOT` file | the native log IS the store |

Proven against real Qwen Code in the G0 spike (`docs/qwen-g0-spike.md`, XERK-505: **GO**, no new
drive mechanism needed).

## Why it mirrors dsh's architecture section-for-section

The XERK-460 dsh epic established the decisions qwen inherits wholesale (`docs/dsh-adr.md`):

- **D1** — a per-session LAUNCHER inside the existing agent, not a separate agent.
- **D2** — reports through the existing hub; no new control plane.
- **D3** — the runtime's native log is canonical; a Claude-JSONL PROJECTION serves display, existing
  so the parity mirrors stay at N rather than 2N.
- **D4** — no credential or fleet identity of its own; the host token proves the host (XERK-268).
- **D5** — the runtime picks its own model mechanism; NO Claude subscription failover.

Because those were already settled and shipped once, the qwen epic is deliberately a *port*, and each
child's ticket is scoped as "the dsh [X] analogue". Where qwen diverges it is because the TUI process
model differs, never because a decision was revisited.

## The G0 spike's load-bearing findings

Recorded in full in `docs/qwen-g0-spike.md`; these five drove concrete code:

1. **No native title mechanism** — so session naming needed the three-tier scheme (a dormant tier 1
   honours a future qwen that emits one).
2. **No native AskUserQuestion tool** — so structured questions are registered via an MCP server
   (`agent/qwen/ask_mcp.py`) rather than degraded to a yes/no approval.
3. **The cwd→slug rule is uncertain** (G0 recorded `/`→`-`; Claude's own rule is every non-alnum→`-`)
   — so every native-log lookup GLOBs by pinned id instead of computing a slug.
4. **Hook contract is Claude Code's, ported** — so the shared `guard.py`/`fileguard.py` deny policy is
   reused directly, with only a thin shim to bridge tool names.
5. **Hook `timeout` is MILLISECONDS**, not seconds — a too-small value silently disables the guard.

An auto-update trap also surfaced: a pinned fleet must not let the binary drift under the parsers,
hence `disableAutoUpdate` in the per-worktree settings.

## Why `QWEN_ENABLED` shipped False

An in-code fleet-wide kill switch, gating all three components (agent `qwen_configured()`, hub
`qwenAvailable`/`normalizeQwen`, Android `Runtime.QWEN_ENABLED`) so no single component can
re-enable qwen alone.

It stayed False through the launcher child on purpose: `approvalMode:"auto"` runs tools unattended,
so a launcher without the guard is an UNGUARDED runtime, and without the projection its chat surface
is blank. The gate to flip it was both the safety guard ([Qwen F]) and the transcript projection
([Qwen S1]) landing.

**The remaining host-proof gate:** G0 proved the deny hook fires under `approvalMode: default`; that
it also fires under `auto` (the mode the launcher runs) is UNVERIFIED. If `auto` skips hooks on a real
host, qwen must not be enabled until that is resolved.

## Known unverified surfaces (qwen is not installed in CI)

Every one of these is unit-tested against its contract and awaits host confirmation:

- the `mcpServers` settings key, and that qwen surfaces an MCP tool to its deferred-tool model;
- whether qwen honours a `permissions.deny` block at all (the G0 catalogue found no `permissions`
  key) — it is emitted as defence in depth, and the shim does not depend on it;
- that hooks fire under `approvalMode:"auto"` (above).

## Accepted residual gaps

- **An unknown mutating tool NAME is ungated** — the shim only sees tools its matcher lists. This is
  worse than dsh, which pins `sandbox: workspace-write` (landlock) as an fs backstop; qwen's
  `--sandbox` needs docker/podman, absent on native hosts, so there is NO fs confinement backstop.
  Widening the tool list, not adding a sandbox, is the honest fix if qwen grows a new fs tool.
- **A `run_shell_command` that overwrites the shim's config could self-bypass** — not net-new
  (`guard.py` equally allows `echo > guard.py`); the guard defends against the MODEL, not a hostile
  same-uid shell. It is a weaker backstop than the guard-settings file claude reads once at launch.
- **The project's own `QWEN.md` is not auto-loaded**, since `context.fileName` points at Turma's own
  context file instead. Accepted trade.
