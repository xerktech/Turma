---
paths:
  - "agent/hooks/**"
  - "agent/hub-agent.py"
---

# `agent/hooks/` — the guard and AskUserQuestion hooks

`agent/hooks/guard.py` and `agent/hooks/ask.py` are stdlib-only, land at `/usr/local/bin/hooks/`,
and are wired by `hub-agent.py`'s `build_guard_settings()` into the `--settings` file every session
launches with. This file carries both halves: the *policy* (what it denies and why) and the
implementation contract behind it.

## Policy — what the guard denies, and why

- Sessions run hands-off, so every launch passes `--settings` a generated file
  (`build_guard_settings()` → `~/.turma/guard-settings.json`) wiring `PreToolUse` hooks over Bash
  and the file-editing tools, plus `permissions.deny` rules on host credential stores (`~/.ssh`,
  `~/.aws`, `~/.azure`, `~/.terraform.d`, `~/.claude`, `~/.config/gcloud`) — shared by every
  session, so deny wins even under bypass.
- **`~/.claude` is guarded by `hooks/fileguard.py`, not by a pattern**: the rule is "everything
  under it except the two agent-memory trees", and a glob list cannot express that — deny beats
  allow, and **a deny matching a DIRECTORY takes its whole subtree**, so `Edit(~/.claude/*)` is the
  blanket rule. Patterns still cover the catastrophic subset as defence in depth; the mechanics are
  under "Implementation contract" below.
- It hard-denies three narrow categories, each with a reason the agent self-corrects from:
  **destructive** (`rm -rf` of `/`/home/system/`.git`, disk wipes, fork bombs, power changes,
  recursive `chmod`/`chown` of system roots, protected-branch history destruction, `DROP
  DATABASE|TABLE`); **policy** (push to / delete `main`/`master`, or self-merging a PR/MR — work
  lands via a PR a human merges); **attribution** (AI self-attribution trailers in commit/PR
  messages).
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) is untouched. Allowlist a
  command via `$TURMA_TOOL_GRANTS` (CSV of `Bash(<cmd>)`), attribution via
  `$TURMA_NO_ATTRIBUTION=0`.
- It classifies what the SHELL runs, **never the raw string** — `qa.md` §6.1 is the rule and its
  limits.

## Implementation contract

- **Guard** (`hooks/guard.py`, stdlib-only at `/usr/local/bin/hooks/guard.py`) — a `PreToolUse` hook
  over Bash, plus the `permissions.deny` credential-store rules. It classifies what the SHELL runs,
  **never the raw string**. **Fails open on malformed input**; an unwritable settings file still
  launches the session. Keep in sync with the twin hook outside this repo. Tests: `test_guard.py`,
  `test_guard_settings.py`.
- **File guard** (`hooks/fileguard.py`, same shape) — a `PreToolUse` hook over
  `Write|Edit|MultiEdit|NotebookEdit`. It refuses any write under `~/.claude` except the two agent
  memory trees: `agent-memory/<agent>/**` and `projects/<slug>/memory/**`.
  - **Only the `agent-memory` half is actually usable, and that is not our layer's doing.** Measured
    through the real binary: `~/.claude/projects/<slug>/memory/**` is refused in `auto` and
    `acceptEdits` with **no settings at all**, and no allow rule pre-grants it (literal-slug and
    whole-tree allows both tried); only `bypassPermissions` lands it. So removing the blanket deny
    is necessary but NOT sufficient for a session's own auto-memory — subagent stores are what the
    carve-out delivers. Keep the `projects/` hole open anyway: it costs nothing and a future release
    may lift that gate, which `test_matcher_oracle.py` will report as a failure.
  - **It is a hook and not a `permissions.deny` pattern because the rule is "everything under X
    except Y", which a glob list cannot express.** Deny beats allow, so the exception must be a hole
    in the deny, and three attempts each cut one wrong: too big (**a deny matching a DIRECTORY takes
    its whole subtree**, so `Edit(~/.claude/*)` matches the `agent-memory` entry and is the blanket
    rule again), too small (an enumerated danger list missed `shell-snapshots/`, which Claude Code
    sources on every Bash call of every live session — RCE across sessions), and unable to track a
    vendor directory set that grows each release. Do not go back to patterns for this.
  - **The rule list is pinned by EQUALITY** (`EXPECTED_DENY_RULES` in `test_guard_settings.py`),
    because containment lost six rules: each was deletable with the whole suite *and* the live
    oracle green, `settings.json*` among them — the oracle asks whether the TARGET is refused, and
    `Edit(~/.claude/*.json)` still refused it. Only a rule-level assertion sees that.
    - Two measured limits, so nobody mistakes the pin for more than it is. **19 of 45 rules have a
      second signal** elsewhere in the suite; **the other 26 do not**, so an editor who updates the
      frozenset to match a deletion without thinking is green — the failure message tells them to
      make that call deliberately, and no cheap check distinguishes intent.
    - **An over-broad ADDITION pinned in both places is invisible to the unit suite.** Adding
      `Edit(~/.claude/projects/**)` swallows the auto-memory tree and still passes 1386 tests; only
      the oracle's two memory tests catch it, and they run in **31s**. Run them after any edit to
      the rule list — that is the concrete reason the oracle is not optional.
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
      and `*`, and the escaped form does not overreach onto a neighbouring directory. A literal `?`
      has **no** working escape (escaped it matches nothing, unescaped it swallows `qXk`), so
      `runtime_code_deny_rules` refuses to emit a rule for such a path and warns instead. An
      unprotected prefix the operator is told about beats a rule everyone believes in.
      - The spelling that shipped broken was `[c]` applied to **every** metacharacter, so `t[1]`
        became `t[[]1[]]` — that denies nothing. **`[[]` alone does escape `[` correctly**, so the
        earlier note here that "the character-class spelling escapes nothing" was wrong; don't
        repeat it. Backslash is what we rely on, and `test_matcher_oracle.py` pins both.
    - **Every hook is invoked `python3 -SsE`, and those are SECURITY flags.** A plain interpreter
      start runs `site` before the hook's own code, so planting a file it imports disables the hook
      — measured against the real `guard.py`, which then allowed `rm -rf /`, `git push --force
      origin main` and `chmod -R 777 /`, and it persists into every future `python3` run as that
      user.
      - **`-S` is the one that closes the CLASS.** `-s` drops only the USER site dir; the
        interpreter's OWN site-packages is still scanned, so a `.pth` or `sitecustomize.py` there
        runs inside every hook process. Measured end to end, and reachable in the **container**,
        whose final stage sets no `USER` and so runs sessions as root over a writable `/usr`.
      - `-s` and `-E` stay for the user-site and `PYTHON*` env halves (`PYTHONPATH`/`PYTHONHOME`/
        `PYTHONSTARTUP` are all dead under `-E`, measured). PATH shadowing is already closed: the
        command bakes an absolute `sys.executable`.
      - The `~/.local` deny patterns beside them stop a plant via the **file-editing tools only** —
        Bash walks past them as it walks past every pattern (XERK-309), so they are a partial
        reduction, not the fix. **The flags are the fix.**
      - The hooks are stdlib-only by contract, so none of the flags can break them; all four were
        driven under them, output byte-identical, `TURMA_*` env still read.
    - **`~/.turma/guard-settings.json` is denied too**, and that is not optional: it is the file
      that WIRES both hooks, and denying the code without it just moves the attack one directory
      over. Not all of `~/.turma` — the agent stages uploads and question files there.
      - The exposure is bounded by the MANAGER PROCESS, not by the file: `_ensure_guard_settings`
        caches the path on the manager instance and rewrites the file from `build_guard_settings()`
        on a fresh process. So a tampered file is handed to every session that manager launches for
        the rest of its lifetime — managers here run for days — and a restart repairs it. An earlier
        note claiming the file is reused "whenever it merely exists" was wrong.
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
  - **A rule's STRING is not an oracle — run `test_matcher_oracle.py` when you change one.** Four
    controls shipped that read correctly and did nothing (single leading slash, the `[c]` spelling,
    an unescaped `\\`, `-sE`), each green under a test asserting the string the code meant to emit:
    a test written from the same belief as the code cannot falsify that belief. Over the same period
    the `fileguard.py` predicate had **zero** defects, because its tests call `decide()` and assert
    allow/deny. The oracle gives this layer the same footing by driving the real binary, and it is
    gated on `TURMA_MATCHER_ORACLE=1` because each case costs an API call.
    - Its structure is load-bearing, not ceremony: a **control** case with no rules that must be
      ALLOWED (without it a harness that cannot observe a write reports DENIED for everything and
      looks like a pass), a **baseline** arm with empty settings for anything under `~/.claude`
      (the binary gates its own config dir, so a deny there is unattributable without it), a
      **content** check rather than existence (the binary writes `~/.claude.json` itself, which read
      as a false ALLOW), the target **inside cwd** (`acceptEdits` only auto-approves there, and
      outside it the approval gate masks every ALLOW), and **retries** because the model layer is
      nondeterministic — a run that wrote nothing may be the model declining, which is INCONCLUSIVE
      and fails, never a deny.
    - **Attribution is the hard part, and it failed twice before it worked.** Anything under
      `~/.claude` must be driven under **`bypassPermissions`**: every other mode has Claude Code
      refusing the write on its own, and a version of the class asserting under `acceptEdits` passed
      6/6 with the whole feature stubbed to `{}`. Then, because the guard is TWO layers, each was
      individually invisible — unwiring the hook left 6/7 green and emptying all 46 deny rules left
      7/7. So each refusal runs **four arms**: EMPTY allows, REAL denies, HOOK_ONLY denies,
      PATTERNS_ONLY denies iff a rule names that target. **Assert against the LAYER, not against
      "our settings".**
    - `~/.claude/agent-memory/<agent>` (the directory entry) is the one target no pattern names or
      *can* name — a pattern matching it matches the tree beneath it. Its `named_by_pattern=False`
      arm is the proof the hook carries coverage the backstop cannot, so don't "simplify" it away.
    - **`claude -p` reads stdin when it is not a tty**, so any probe must pass `stdin=DEVNULL`: run
      from a heredoc it swallowed the harness's own source and refused writes as prompt injection,
      scoring INCONCLUSIVE for reasons unrelated to permissions. Keep target filenames innocuous for
      the same reason — with `evil.md` under `agents/` the model declines on its own.
    - `build_guard_settings()` folds the **operator's** `~/.claude/settings.local.json` into the deny
      list and runs in the harness process, which a fake `HOME` does not isolate; the tests pin
      `local_settings_path` at a nonexistent file so a rule there cannot forge a refusal.
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

