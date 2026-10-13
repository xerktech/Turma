---
paths:
  - agent/hooks/subagent_model.py
  - agent/tests/test_subagent_model.py
  - agent/hub-agent.py
---

# QA/review sub-agents run on Opus (XERK-1851)

`hooks/subagent_model.py` — a `PreToolUse` hook over `Agent|Task|Workflow` wired by `build_guard_settings`.
It rewrites the call's `model` to `$TURMA_PIN_SUBAGENT_MODEL` (`GRADER_SUBAGENT_MODEL` = `opus`)
for `qa`, `qa-delta` and any `subagent_type` containing `review` not after a `p` (`ui-preview` is not).
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
- **Workflow** (XERK-1856): `agent(…, {agentType: 'qa'})` is no Agent call, so the hook rewrites
  the script — one line glued after the `meta` literal's `}` rebinds the `agent` global to add
  `model` to grader opts. Verified live: call + frontmatter `haiku` → Opus; general-purpose untouched.
  - Rebind the GLOBAL, never wrap the body: 2.1.296 runs the body as `async () => {'use strict';…}`
    with `agent` a vm-context global; a wrapper param made a body-level `const agent` a SyntaxError.
  - No added newline, so the runtime's error line numbers stay the model's own.
  - `meta` must be the first statement (after comments/hashbang), as the runtime requires; a
    decoy `export const meta = {` in a leading comment must not be matched.
  - Any doubt passes through: unfound/odd meta, already-pinned marker, past the 524288-byte cap.
  - `scriptPath` is inlined and dropped (it beats `script`). Residual: a saved workflow run by
    `name`, and a nested `workflow()` child, are not pinned.
- Residual: a built-in skill reviewing through generic agents (`/code-review`) names no `review`
  type, so it follows the session default; the ADR's Opus review gate is XERK-1848.
- Tests: `test_subagent_model.py` (`TestWorkflowPin` runs the pinned body in a node vm, as the runtime does), `test_wires_the_subagent_model_pin`,
  `test_spawn_onto_the_local_model`, `test_windows_launch_pins_grader_subagents_off_the_local_model`.
