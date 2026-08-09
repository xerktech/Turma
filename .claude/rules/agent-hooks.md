---
paths:
  - "agent/hooks/**"
---

# `agent/hooks/` — the guard and AskUserQuestion hooks

`agent/hooks/guard.py` and `agent/hooks/ask.py` are stdlib-only, land at `/usr/local/bin/hooks/`,
and are wired by `hub-agent.py`'s `build_guard_settings()` into the `--settings` file every session
launches with. The guard's *policy* (what it denies and why) is in `CLAUDE.md`; this is the
implementation contract.

- **Guard** (`hooks/guard.py`, stdlib-only at `/usr/local/bin/hooks/guard.py`) — a `PreToolUse` hook
  over Bash, plus the `permissions.deny` credential-store rules. It classifies what the SHELL runs,
  **never the raw string**. **Fails open on malformed input**; an unwritable settings file still
  launches the session. Keep in sync with the twin hook outside this repo. Tests: `test_guard.py`,
  `test_guard_settings.py`.
- **AskUserQuestion bridge** (`hooks/ask.py`, same shape) — Claude's own picker is a TUI affordance
  the glasses client isn't attached to, so this hook writes
  `~/.turma/questions/<sessionId>.req.json` (session id from
  `TURMA_SESSION_ID`/`TURMA_QUESTIONS_DIR`, prefixed onto the `claude` command in `_launch_tmux`)
  and **blocks**, polling for the answer file `answer_question()` drops.
  - Answers come back as a `PreToolUse` **deny** whose `permissionDecisionReason` is a
    `{kind:"askuserquestion_answers", answers}` blob — **deny-with-reason is the channel because a
    `PreToolUse` allow can't carry typed answer data**; Claude reads them out of the tool_result.
  - AskUserQuestion is serialized per session, so req/ans files key on the session id alone. The
    hook's block timeout (`TURMA_QUESTION_TIMEOUT_SEC`, 600s) sits **under** the settings-level
    `timeout`. It passes through silently when its env vars are absent. Kill/delete/restart clear
    pending req/ans files. `multiSelect` questions accept `optionIndices`
    (`_question_options`/`_hook_question`).
  - Tests: `test_ask.py`, `TestHookQuestion`, `TestAnswerQuestion`, `test_guard_settings.py`.

