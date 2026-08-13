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
- **File guard** (`hooks/fileguard.py`, same shape) — a `PreToolUse` hook over
  `Write|Edit|MultiEdit|NotebookEdit`. It refuses any write under `~/.claude` except the two agent
  memory trees: `agent-memory/<agent>/**` and `projects/<slug>/memory/**`.
  - **It is a hook and not a `permissions.deny` pattern because the rule is "everything under X
    except Y", which a glob list cannot express.** Deny beats allow, so the exception must be a hole
    in the deny, and three attempts each cut one wrong: too big (**a deny matching a DIRECTORY takes
    its whole subtree**, so `Edit(~/.claude/*)` matches the `agent-memory` entry and is the blanket
    rule again), too small (an enumerated danger list missed `shell-snapshots/`, which Claude Code
    sources on every Bash call of every live session — RCE across sessions), and unable to track a
    vendor directory set that grows each release. Do not go back to patterns for this.
  - **The `permissions.deny` rules still name the catastrophic subset** — the login, `agents/`,
    `bin/`, `hooks/`, `local/`, `rules/`, `plugins/`, `sessions/`, `shell-snapshots/`,
    `~/.claude.json`. That is deliberate defence in depth for when the hook is misconfigured or
    crashes; the hook is what makes the coverage complete, not what makes it exist. Every one of
    those patterns is anchored on a dot, a name or a suffix so it cannot match a memory directory.
  - Paths are `realpath`'d, which closes escapes in **both** directions: a symlink planted inside
    the memory tree pointing at `agents/` resolves out of the carve-out, and one outside pointing in
    resolves in. A relative path resolves against the payload's `cwd`, not the hook process's.
  - **The memory DIRECTORY entries are not themselves writable** (`agent-memory/<agent>` and
    `projects/<slug>/memory` need something inside them): a file planted at that name makes the
    directory impossible to create, permanently disabling another project's or agent's memory.
  - **Fails open on malformed input**, like `guard.py` — a hook that blocked every edit because it
    could not parse its own input would take the fleet down, and the catastrophic paths hold on
    patterns regardless.
  - Tests: `test_fileguard.py` (behavioural — resolved paths, not rule strings; three glob attempts
    passed their string assertions while the feature was wholly broken), `test_guard_settings.py`.
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

