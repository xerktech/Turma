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
- **Distrusted once the transcript is quiet** for `TURN_STATE_QUIET_SEC` (300s) or absent,
  over an idle pane AND an unreadable one (None): a lost `turn.complete` must not hold a
  finished session busy (out of review, out of auto-merge), even where every capture fails.

## `/rename` through the mod (XERK-2131 task 2)

- `_reconcile_rc_names` hands the rename to the mod (`_rename_via_mod`) while its turn state
  reads bound to the pinned conversation: `rename.json` `{v, name, at}` in
  `TURMA_MOD_REQUESTS` (`~/.turma/mod-requests/<sid>/`); the mod runs `$.command.run`
  (`rename`) and answers `rename.done.json` `{v, at, name, ok}`.
- **The mod runs it only while the main turn is IDLE** (its own turn state). Claude Code then
  runs it at once. Queued mid-turn, an Esc drops it, and Turma's chat fold shows it as a queued
  operator prompt (the queue-operation entry carries no origin, and Claude Code dequeues a
  human prompt ahead of it, breaking the FIFO fold) — QA on 2.1.304. Never drop the gate.
- **rcName moves on the mod's ok answer only** (matched by `at`), never on the request, so
  peers.tsv never names a name the live registry does not answer to (verified on 2.1.304:
  the registry `name` changes).
- While a request is out, a changed summary re-asks with a newer `at` — even back to the
  current name, since the older request may already be running. A pending request is never
  typed beside, even if the mod's turn state goes unreadable.
- **ok:false is asked again (`MOD_RENAME_ATTEMPTS`), then renaming stops for that process
  (`rcRenameVia: "off"`) — NEVER the pane.** The pane fallback typed `/rename` + Enter onto
  the prompt an Esc had just restored to the composer, submitting both glued (QA).
- The request name follows the mod's rule (control runs → one space, trimmed), so rcName
  equals the name the registry ends up with. No mod → the pane path, as before.
- **The mod runs `rename` and nothing else**: the request is session-writable, so it carries
  a name, never a command (pinned by `bridge-mod.test.js`). The mod strips control chars and
  refuses a name over 200 chars.
- Request dir and `rcRenamePending`/`rcRenameVia` are dropped on every launch/teardown.
- **Operator messages stay on the pane**: a `$.prompt.submit` lands as `origin: plugin`,
  framed "The <plugin> plugin sent a message", and the model attributes it to the plugin,
  not the user (measured on 2.1.304). A wake or hub nudge could move there, but the chat
  view would first need to parse that frame (py + js entry blocks).
- Residual: a session can plant a rename request for a sibling, renaming its live name until
  the agent's next request; the same-uid class as typing into a sibling's pane.

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
- **A new top-level payload dir takes TWO releases to reach a host**: the release that adds
  it is swapped in by the host's OLD updater (already running), which skips dirs it does not
  know; the next agent release, swapped by the new updater, lays it down (seen on 2.3.49,
  the XERK-523 class). The manager logs `bridge mod: on|off (<reason>)` at start.
- **Packaging**: `mods/` ships beside `hooks/` in every build — `install.sh` + `do_verify`,
  `turma-agent-update`, both release stagings, the Windows `$RuntimeDirs` + `$VerifyFiles`.
  `agent/mods/` matches no `AGENT_RULES` prefix, so it builds both agents.
- **Claude writes `tsconfig.json` + `.claude-plugin/types/` into the mod folder** on every
  interactive load; the folder's `.gitignore` keeps them out of git (types ignores itself).
  On a host they land in `$PREFIX/mods`, harmlessly — a failed write still loads the mod.
- **Loading also rides a server-side flag** (`tengu_plugin_hooks_modules`, seen in
  `~/.claude.json`) the version gate cannot see. Off → no file → the pane alone, as before.
- **After a `/clear` the signal is off for that process** (new session id ≠ pinned id).
- **Pre-existing gap it exposes**: a dialog `parse_pane_prompt` misses (an MCP elicitation?)
  reads busy for up to the quiet bound instead of idle.
- Verified headless on 2.1.304: `claude -p --plugin-dir` loads it with no prompt and writes
  idle → running → idle (seq 3).

## Tests

- `TestReconcileRcNamesViaMod` (mod-routed rename: request, ack, retry-then-stop, re-ask,
  stale answer, never typed beside, name rule, FIFO answer).
- `TestBridgeMod` (gate, shipped files, reader incl. FIFO, the fold, report claude-only),
  `test_a_claude_that_reads_mods_launches_the_bridge_mod` /
  `test_an_older_claude_launches_without_the_bridge_mod` (`TestSessionLifecycle`),
  `test_a_launch_drops_the_turn_state` (`TestLocalModelFailover`).
- `agent/tests/bridge-mod.test.js` (CI's node step): strips the module's types, parses it as
  an ES module, pins the env-var contract with hub-agent.py.
- Shadow exclusion: `test_a_shadow_never_loads_the_bridge_mod`; Windows argv/env:
  `test_windows_launch_loads_the_bridge_mod`.
- Also run `claude plugin validate agent/mods/turma-bridge` after any edit to the module.
- The interactive load is HOST proof only: run `_launch_tmux`'s exact command in a scratch
  `tmux -L <name>` server (`TMUX` unset first) and watch the state file beside the pane.
