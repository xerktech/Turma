---
paths:
  - "agent/mods/**"
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/native/install.sh"
  - "agent/native/turma-agent-update"
  - "agent/native/windows/install.ps1"
  - "agent/native/windows/turma-agent-update.ps1"
---

# The Claude bridge mod (XERK-2131)

`agent/mods/turma-bridge` is a Claude Code mod (an in-process plugin of function hooks) that
every Claude launch loads with `--plugin-dir`. Roadmap for what else rides it: XERK-2131.

## What it does today

- Writes `TURMA_TURN_STATE` (`~/.turma/turn-state/<sessionId>.json`) on `session.start`
  (idle), `turn.start` (running) and `turn.complete` (idle), main loop only (`agentId` unset).
  Body: `{v:1, claudeSessionId, turn, turnId, seq, at}`.
- The beat reads it in `session_report`'s `_finish` (`read_turn_state` → `fold_turn_state`),
  Claude sessions only. dsh and qwen load no Claude mod.
- **It only ever RAISES `paneBusy` to true, never lowers it.** The pane also reads busy for
  work that is no model turn (a compaction, a `!` command), and the pane stays the source for
  mode, dialogs and everything else. No new wire field: the five working mirrors are unchanged.
- **Skipped while a `panePrompt` dialog is up**: the turn is running, but every consumer reads
  a dialog as the session waiting on a person.
- **Distrusted over a pane reading idle once the transcript is quiet** for
  `TURN_STATE_QUIET_SEC` (300s): a lost `turn.complete` must not hold a finished session busy
  (out of review, out of auto-merge). A pane read of None (failed capture) trusts it fully.

## Invariants

- **The mod draws nothing.** A band, pane or status entry changes the screen the pane
  parsers read (the statusLine already broke busy detection once, XERK-130).
- **Its hooks never await a write**: writes go on one chain (event order) off the hook, so a
  slow disk cannot hold a turn. The mod validator requires `$` to reach a TOP-LEVEL function
  declaration, hence `publish($, w, …)`.
- **The file is session-written** (the session's own process writes it, Bash can too): read
  through `_read_untrusted_json` (FIFO/symlink/oversize refused), bound to the record's pinned
  `claudeSessionId` (a `/clear`, or a nested claude inheriting the env, says nothing).
  - A session can forge its own state to read busy; the quiet-transcript rule bounds that.
  - No `Edit(~/.turma/turn-state/**)` deny: whether `permissions.deny` binds a plugin's
    `$.fs.write` is unmeasured, and a deny that did would switch the mod off.
- **Expiry is the relaunch**: `_forget_live_agents` (every launch and teardown) unlinks the
  file, since a claude killed mid-turn never writes its idle.
- **Gated** by `bridge_mod_launch_dir`: `TURMA_BRIDGE_MOD=0` off, Claude Code below
  `BRIDGE_MOD_MIN_CLAUDE` (2.1.304, the first verified) or unreadable, or the files missing
  (an install predating it) → launch exactly as before. Never on a shadow run.
- **Packaging**: `mods/` ships beside `hooks/` in every build — `install.sh` + `do_verify`,
  `turma-agent-update`, both release stagings, the Windows `$RuntimeDirs` + `$VerifyFiles`.
  `agent/mods/` matches no `AGENT_RULES` prefix, so it builds both agents.
- Verified headless on 2.1.304: `claude -p --plugin-dir` loads it with no prompt and writes
  idle → running → idle (seq 3).

## Tests

- `TestBridgeMod` (gate, shipped files, reader incl. FIFO, the fold, report claude-only),
  `test_a_claude_that_reads_mods_launches_the_bridge_mod` /
  `test_an_older_claude_launches_without_the_bridge_mod` (`TestSessionLifecycle`),
  `test_a_launch_drops_the_turn_state` (`TestLocalModelFailover`).
- `claude plugin validate agent/mods/turma-bridge` must pass after any edit to the module.
