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
2. **~~No native AskUserQuestion tool~~ — WRONG (corrected by XERK-520 D2).** qwen 0.22.x DOES ship a
   native `ask_user_question`, but it renders its selector in the PANE and writes no rendezvous file,
   so it is invisible to Turma and shadows the MCP tool. So `_qwen_settings` DISABLES the built-in
   (`tools.exclude:["ask_user_question"]`) and the MCP server (`agent/qwen/ask_mcp.py`, exposed
   server-prefixed) is the structured-question tool the model actually reaches — still the SAME
   operator card, not a yes/no approval. Details: `.claude/rules/qwen.md` [Qwen C] HITL (2).
3. **The cwd→slug rule is uncertain** (G0 recorded `/`→`-`; Claude's own rule is every non-alnum→`-`)
   — so every native-log lookup GLOBs by pinned id instead of computing a slug.
4. **Hook contract is Claude Code's, ported** — so the shared `guard.py`/`fileguard.py` deny policy is
   reused directly, with only a thin shim to bridge tool names.
5. **Hook `timeout` is MILLISECONDS**, not seconds — a too-small value silently disables the guard.

An auto-update trap surfaced during the G0 spike (qwen upgraded the binary mid-run), and the runtime
was originally version-pinned to protect the [Qwen S1] projectors — `disableAutoUpdate` in the
per-worktree settings plus a `QWEN_CODE_MANAGED_NPM_PIN` base-build force (`_qwen_version_pin`).

**XERK-525 reverses that pin: qwen now AUTO-UPDATES like Claude Code**, so a Stop-hook / behaviour fix
in a newer build reaches every host without a manual bump (the ticket's driver was qwen 0.22.2's Stop
hook being skipped on steer/queued/aborted turn-ends, which a newer build is expected to fix). The
accepted cost is that a native-log format change in a future qwen can silently degrade
chat/history/PR/usage while the ttyd TUI stays live — the projectors are corpus-validated per version
and are the reason the pin existed. Currency was chosen over the pin deliberately; the projectors
must be re-verified host-side after a qwen major/format change (host-proof only — qwen is not in CI),
and a version-compatibility gate (degrade qwen availability outside a known-good version set) is
possible future work. Only `disableUpdateNag` is kept, to keep an update banner out of the pane where
it would disturb `capture-pane` parsing.

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
- the `tools.exclude` key actually dropping the native `ask_user_question` at runtime (key + name
  matching confirmed by static bundle inspection, XERK-520; live confirmation gated on D1);
- whether qwen honours a `permissions.deny` block at all (the G0 catalogue found no `permissions`
  key) — it is emitted as defence in depth, and the shim does not depend on it;
- that hooks fire under `approvalMode:"auto"` (above);
- **PostToolUse hooks in headless `qwen -p`** — XERK-533 reports (from log deltas on the user's own
  global hooks) that qwen 0.22.x fires PreToolUse and Stop but NOT PostToolUse in `-p`; a 0.22.3
  bundle read shows the scheduler gates both identically (`hooksEnabled && messageBus`), so the
  asymmetry is UNCONFIRMED here. Immaterial to the guard — the launcher runs `-i` (interactive, hooks
  fire) and the guard is PreToolUse regardless — but the reason any hook Turma ever wires into a qwen
  session must be **PreToolUse or Stop, never PostToolUse**: a PostToolUse hook would be silently dead
  the moment a qwen session were driven headless.

## Accepted residual gaps

- **An unknown mutating tool NAME is ungated** — the shim only sees tools its matcher lists. This is
  worse than dsh, which pins `sandbox: workspace-write` (landlock) as an fs backstop; qwen's
  `--sandbox` needs docker/podman, absent on native hosts, so there is NO fs confinement backstop.
  Widening the tool list, not adding a sandbox, is the honest fix if qwen grows a new fs tool.
- **A `run_shell_command` that overwrites the shim's config could self-bypass** — not net-new
  (`guard.py` equally allows `echo > guard.py`); the guard defends against the MODEL, not a hostile
  same-uid shell. It is a weaker backstop than the guard-settings file claude reads once at launch.
- **A credential-store glob dodge via a symlinked HOME subdirectory is FIXED** (XERK-503,
  `_realpath_glob_prefix`) — `~/.aws` itself being a bind mount, or on WSL the Windows-side profile,
  no longer dodges its deny rule; the glob's literal prefix is realpath'd the same way `fileguard.py`
  already realpaths its `~/.claude` base.
- **A credential FILE itself symlinked out is now also caught** (XERK-497, `_matches_target`) — a
  `~/.kube/config` pointing elsewhere with `~/.kube` itself real has nothing to realpath in the glob
  prefix, so the realpath'd target alone missed it. The shim (and dsh's `policy.mjs`) now match the
  deny globs against BOTH the literal (pre-realpath, `..`-collapsed) and the realpath'd target, deny
  if either matches. With XERK-503's prefix realpath this covers dir-symlinked-out,
  file-symlinked-out, and an unrelated symlink into a symlinked-out store. `fileguard.py`'s
  `~/.claude` predicate is unaffected (it realpaths base and target together, so a symlinked
  `~/.claude` dir already matched). Verified on MaxAI the dsh/qwen sandbox independently blocks the
  actual /mnt/c write, so this closed a defence-in-depth gap, not a live credential write.
- **The project's own `QWEN.md` is not auto-loaded**, since `context.fileName` points at Turma's own
  context file instead. Accepted trade.
