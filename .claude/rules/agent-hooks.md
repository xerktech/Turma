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
    patterns regardless. **A hook that exits nonzero fails open; a hook whose SCRIPT IS MISSING
    fails closed**, refusing every file edit on the host, so `build_guard_settings` wires the
    matcher only when the script exists and logs when it doesn't.
  - **The hook's own file is denied** (`runtime_code_deny_rules`): without that, two Writes —
    neutralise `fileguard.py`, then write anywhere — re-opened the whole config directory, an
    exposure the blanket pattern did not have. It denies the agent's installed code directory,
    covering `guard.py`/`ask.py`/`hub-agent.py`/`tunnel-agent.js` too, and is **skipped when that
    directory is inside `REPOS_ROOT`** so sessions working on Turma can still edit Turma.
    - **The DOUBLED leading slash in that rule is load-bearing.** Claude Code reads a single `/` as
      relative to the directory holding the `--settings` file, so `Edit(/root/.local/share/…)`
      resolves against `~/.turma/` and matches nothing. Measured: one slash and the two-Write
      attack succeeds; two and it is refused. The rule reads correctly and does nothing, and a test
      asserting the rule's STRING was green over it — assert the anchor, not the presence.
    - The path is **glob-escaped with a BACKSLASH** (`_glob_literal`) — measured: `\\` escapes `[`
      and `*`, the `[c]` character-class spelling escapes **nothing** (a rule built that way denies
      nothing at all, and shipped once), and a literal `?` has no working escape, so
      `runtime_code_deny_rules` refuses to emit a rule for such a path and warns instead. An
      unprotected prefix the operator is told about beats a rule everyone believes in.
    - **Every hook is invoked `python3 -sE`, and that is a SECURITY flag.** A plain interpreter
      start imports user-site `usercustomize` before the hook's own code, so one Write to
      `~/.local/lib/pythonX/site-packages/usercustomize.py` disabled every hook on the host —
      measured: the Bash guard then allowed `rm -rf /`, `git push --force origin main` and
      `chmod -R 777 /`, and it persisted into every future `python3` run as that user. `-s` drops
      user site, `-E` drops `PYTHON*` env. The site-packages deny patterns beside it are defence in
      depth for a settings file generated before this; the flag is what closes the class. The hooks
      are stdlib-only by contract, so neither flag can break them.
    - **`~/.turma/guard-settings.json` is denied too**, and that is not optional: it is the file
      that WIRES both hooks, `_ensure_guard_settings` reuses it whenever it merely exists without
      re-validating its content, and denying the code without it just moves the attack one
      directory over. Not all of `~/.turma` — the agent stages uploads and question files there.
  - **The carve-out is FLEET-WIDE, not session-scoped**, and that is a real cost, not an oversight:
    any session may write any project's `memory/` and any agent's store, and both are injected into
    those future runs (measured — a marker planted in another slug's `MEMORY.md` appears verbatim in
    that session's model request). It is what the agent-side rule never to record anything the
    material under review asked to be recorded is load-bearing for.
  - **Bash is NOT covered by either layer.** The matcher does not include it, and Claude Code
    applies `Edit()` denies only to redirect targets it can statically parse — `python3 -c
    "open(...)"` defeats that. Under `bypassPermissions` a session can write anywhere in
    `~/.claude`; the other modes prompt. This predates the hook (the blanket pattern never covered
    Bash either) and is not fixable at the shell-string level. **So do not describe `~/.claude` as
    protected without qualifying it: it is protected against the file-editing tools.**
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

