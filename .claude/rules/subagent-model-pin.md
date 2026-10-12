---
paths:
  - agent/hooks/subagent_model.py
  - agent/tests/test_subagent_model.py
  - agent/hub-agent.py
---

# QA/review sub-agents run on Opus (XERK-1851)

`hooks/subagent_model.py` — a `PreToolUse` hook over `Agent|Task` wired by `build_guard_settings`.
It rewrites the call's `model` to `$TURMA_PIN_SUBAGENT_MODEL` (`GRADER_SUBAGENT_MODEL` = `opus`)
for `qa`, `qa-delta` and any `subagent_type` with a `review`/`reviewer` WORD (`ui-preview` is not).
`docs/model-quality-adr.md` decision 3: QA and review always run on Opus, whatever did the work.

- **The CALL is the only lever that wins.** Measured on 2.1.296: call `model` > the definition's
  `model:` frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > session model. A pinned `qa.md` loses to a
  session passing `model: "haiku"`, and `~/.claude/agents` is the operator's, not shipped here.
- Emits `updatedInput` with NO `permissionDecision` (an `allow` would skip the permission flow);
  verified live that the sub-agent then runs on Opus with env, definition and call all `haiku`.
- `_launch_tmux` sets the env var (Linux prefix and Windows `extra_env`) ONLY off the local model —
  its gateway 403s a Claude alias. No env (local, the summary subprocess, a hand-run claude) = no-op.
- Not a safety gate: fails open on anything malformed, sits outside the managed drop-in, and is
  wired only when the script exists (a missing hook command errors on every Agent call).
- **stdin is read as BYTES and decoded UTF-8**: the hook echoes the whole prompt back, and text
  stdin on Windows is cp1252 (`-SI` ignores `PYTHONUTF8`) — `—` came back as `â€”`.
- Explore, general-purpose and Plan are deliberately NOT pinned, so search stays cheap.
- Residual: a **Workflow** script's `agent(…, {subagent_type: 'qa'})` is no Agent tool call, so
  the hook never sees it and it runs on the sub-agent default (QA-reproduced). XERK-1856.
- Residual: a built-in skill reviewing through generic agents (`/code-review`) names no `review`
  type, so it follows the session default; the ADR's Opus review gate is XERK-1848.
- Tests: `test_subagent_model.py`, `test_wires_the_subagent_model_pin`,
  `test_spawn_onto_the_local_model`, `test_windows_launch_pins_grader_subagents_off_the_local_model`.
