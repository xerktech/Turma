---
paths:
  - "agent/hooks/**"
  - "agent/hub-agent.py"
---

# `agent/hooks/` — the guard and AskUserQuestion hooks

`agent/hooks/guard.py` and `agent/hooks/ask.py` are stdlib-only, land at `/usr/local/bin/hooks/`,
wired by `hub-agent.py`'s `build_guard_settings()` into the `--settings` file every session launches
with. Policy (what's denied and why) plus the implementation contract behind it.

## Policy — what the guard denies, and why

- Every launch passes `--settings` a generated file (`build_guard_settings()` →
  `~/.turma/guard-settings.json`) wiring `PreToolUse` hooks over Bash and the file-editing tools,
  plus `permissions.deny` on host credential stores (`~/.ssh`, `~/.aws`, `~/.azure`,
  `~/.terraform.d`, `~/.claude`, `~/.config/gcloud`) — deny wins even under bypass.
- **`_GUARD_DENY_TOOL_RULES` denies `ListAgents`** (XERK-348), which REMOVES the tool (no schema to
  call) — what makes `PEERS_FILE` a session's only address book and therefore the org boundary.
  **`SendMessage` must stay**: it resolves a bare roster name with no prior listing, and subagent/
  agent-team messaging rides the same tool. The `test_guard_settings.py` equality pin covers PATH
  rules only — a tool rule needs its own assertion.
  - `Edit(~/.turma/peers.tsv)` is denied beside the other `~/.turma` files (a session must not edit
    its own address book); Bash walks past it (XERK-309), file-edit tools only, like its neighbours.
  - **`Read(~/.turma/peers.tsv)` is ALLOWED** — without it, reading the roster costs a permission
    prompt with `ListAgents` denied and no way to get that approval, leaving no address book at all.
- **`crossSessionInbound: accept`** (XERK-339) is a fix, not a convenience: Claude Code's default
  HOLDS a peer message whenever sender/receiver permission-mode classes differ, opening an approval
  dialog nothing here can answer (not an AskUserQuestion; owns the input line the composer types
  into; invisible to `_busy_from_capture`/`_pane_prompt`), then expires and drops the message
  (verified on a real pane). Sits on `--settings` so it scopes to this agent's sessions only; a
  project's own settings can still say `refuse`, which outranks it.
- **`~/.claude` is guarded by `hooks/fileguard.py`, not a pattern**: the rule is "everything under it
  except the two agent-memory trees," which a glob list can't express — deny beats allow, and a deny
  matching a DIRECTORY takes its whole subtree, so `Edit(~/.claude/*)` is the blanket rule. Patterns
  still cover the catastrophic subset as defence in depth (mechanics below).
- Hard-denies three narrow categories, each with a self-correcting reason: **destructive** (`rm -rf`
  of `/`/home/system/`.git`, disk wipes, fork bombs, power changes, recursive `chmod`/`chown` of
  system roots, protected-branch history destruction, `DROP DATABASE|TABLE`); **policy** (push to /
  delete `main`/`master`, self-merging a PR/MR — work lands via a human-merged PR); **attribution**
  (AI self-attribution trailers).
- Ordinary dev work (edits, builds, tests, git, `rm -rf node_modules`) untouched. Allowlist a command
  via `$TURMA_TOOL_GRANTS` (CSV `Bash(<cmd>)`), attribution via `$TURMA_NO_ATTRIBUTION=0`.
- Classifies what the SHELL runs, **never the raw string** — `qa.md` §6.1 is the rule and its limits.

## Implementation contract

- **Guard** (`hooks/guard.py`) — `PreToolUse` over Bash, plus the `permissions.deny` credential-store
  rules (same shell-not-string classification as Policy). **Fails open on malformed input.** Keep in
  sync with the twin hook outside this repo. Tests: `test_guard.py`, `test_guard_settings.py`.
- **File guard** (`hooks/fileguard.py`, same shape) — `PreToolUse` over
  `Write|Edit|MultiEdit|NotebookEdit`; refuses any write under `~/.claude` except
  `agent-memory/<agent>/**` and `projects/<slug>/memory/**`.
  - **Only the `agent-memory` half is actually usable**, not by this layer's doing: measured through
    the real binary, `~/.claude/projects/<slug>/memory/**` is refused in `auto`/`acceptEdits` with no
    settings at all and no allow rule reaches it; only `bypassPermissions` lands it. Removing the
    blanket deny is necessary but NOT sufficient for a session's own auto-memory — keep the
    `projects/` hole open anyway (costs nothing; `test_matcher_oracle.py` reports if a future release
    lifts the gate).
  - **A hook, not a pattern, because glob attempts fail three ways**: too big (matches the
    `agent-memory` carve-out too), too small (misses `shell-snapshots/`, sourced on every Bash call —
    RCE across sessions), and can't track a growing vendor directory set. Do not go back to patterns.
  - **The rule list is pinned by EQUALITY** (`EXPECTED_DENY_RULES` in `test_guard_settings.py`) —
    containment let six rules be silently deletable, oracle green, because the oracle asks "is the
    target refused," not "by this rule." Only a rule-level assertion catches drift; **run
    `test_matcher_oracle.py` (31s) after any edit to the rule list** — an over-broad addition
    (`Edit(~/.claude/projects/**)`) passes the whole unit suite and only the oracle's two memory
    tests catch it.
  - **`permissions.deny` still names the catastrophic subset** (login, `agents/`, `bin/`, `hooks/`,
    `local/`, `rules/`, `plugins/`, `sessions/`, `shell-snapshots/`, `~/.claude.json`) as defence in
    depth for a misconfigured/crashed hook — every pattern anchored so it can't match a memory dir.
  - Paths are `realpath`'d both directions (a symlink escaping the memory tree, or one escaping into
    it, both resolve correctly); a relative path resolves against the payload's `cwd`.
  - **The memory DIRECTORY entries themselves are not writable** — a file planted at that name blocks
    the directory from ever being created, permanently disabling that project's/agent's memory.
  - **Fails open on malformed input; fails CLOSED if the hook script is missing** (refuses every file
    edit on the host) — `build_guard_settings` wires the matcher only when the script exists.
  - **The hook's own file is denied** (`runtime_code_deny_rules`) — without it, neutralising
    `fileguard.py` then writing anywhere reopens the whole config dir. Covers
    `guard.py`/`ask.py`/`hub-agent.py`/`tunnel-agent.js`; skipped when that dir is inside
    `REPOS_ROOT` so sessions on Turma itself can still edit Turma.
    - **The doubled leading slash is load-bearing** — a single `/` resolves relative to the
      `--settings` file's directory and matches nothing (measured); the rule must read
      `//root/.local/...`.
    - Path is **glob-escaped with a BACKSLASH**, not a character class (`[c]` on every metachar was
      shipped broken once — denies nothing; don't repeat that mistake). A literal `?` has no working
      escape, so `runtime_code_deny_rules` refuses to emit a rule for such a path and warns instead.
    - **Every hook runs `python3 -SsE`** — security flags, not style. `-S` is the one that closes the
      class: a plain start runs `site` before the hook's own code, so a planted `.pth`/
      `sitecustomize.py` in the interpreter's OWN site-packages (not just the user one `-s` alone
      blocks) disables the hook — measured to allow `rm -rf /`. `-E` kills `PYTHONPATH`/
      `PYTHONHOME`/`PYTHONSTARTUP`. PATH shadowing is separately closed by an absolute
      `sys.executable`. The `~/.local` deny patterns are a partial reduction (file-edit tools only,
      Bash walks past them); **the flags are the actual fix**.
    - **`~/.turma/guard-settings.json` is denied too** — it's the file that WIRES both hooks, so
      denying the code without it just moves the attack one directory over. The exposure is bounded
      by the MANAGER PROCESS (`_ensure_guard_settings` rewrites it fresh per process), so a tampered
      file is handed to every session that manager launches until its next restart.
  - **The carve-out is FLEET-WIDE, not session-scoped** — any session may write any project's
    `memory/` and any agent's store, both injected into future runs (measured: a marker planted in
    another slug's `MEMORY.md` appears verbatim in that session's model request). This is why the
    agent-side rule never to record anything the reviewed material asked to be recorded is
    load-bearing.
  - **Bash is NOT covered by either layer** — the matcher doesn't include it, and Claude Code's
    `Edit()` denies apply only to statically-parseable redirect targets (`python3 -c "open(...)"`
    defeats that). Under `bypassPermissions` a session can write anywhere in `~/.claude`; other modes
    prompt. Predates the hook. **Don't describe `~/.claude` as protected without qualifying it: only
    against the file-editing tools.**
  - Tests: `test_fileguard.py` (behavioural — resolved paths, asserts `decide()`, not rule strings),
    `test_guard_settings.py`.
  - **A rule's STRING is not an oracle — run `test_matcher_oracle.py` when you change one.** Four
    controls shipped that read correctly and did nothing (the leading-slash, character-class,
    unescaped-backslash and `-sE` mistakes above), each green under a test asserting the string the
    code meant to emit. `fileguard.py`'s own predicate tests, which call `decide()` and assert
    allow/deny, had zero such defects over the same period. Gated on `TURMA_MATCHER_ORACLE=1` (costs
    an API call per case).
    - Structure is load-bearing: a **control** case with nothing that must be ALLOWED (else a harness
      blind to writes reports DENIED for everything and passes); a **baseline** arm with empty
      settings (the binary gates its own config dir even unconfigured); a **content** check, not
      existence (the binary writes `~/.claude.json` itself — a false ALLOW on existence); the target
      **inside cwd** (`acceptEdits` auto-approves only there); **retries** (the model is
      nondeterministic — a blank run may be a decline, which is INCONCLUSIVE, never a deny).
    - **Anything under `~/.claude` must be driven under `bypassPermissions`** — every other mode has
      Claude Code refuse the write on its own (a version under `acceptEdits` passed 6/6 with the
      whole feature stubbed). Because the guard is TWO layers, each is invisible alone (unwiring the
      hook left 6/7 green; emptying all deny rules left 7/7), so each refusal runs **four arms**:
      EMPTY allows, REAL denies, HOOK_ONLY denies, PATTERNS_ONLY denies iff a rule names the target.
      **Assert against the LAYER, not "our settings."**
    - `~/.claude/agent-memory/<agent>` (the directory entry) is the one target no pattern can name —
      matching it matches the tree beneath. Its `named_by_pattern=False` arm proves the hook carries
      coverage the pattern backstop cannot.
    - **`claude -p` reads stdin when not a tty** — probes must pass `stdin=DEVNULL` or the harness's
      own source gets swallowed and refused as prompt injection (INCONCLUSIVE, unrelated to
      permissions). Keep probe filenames innocuous for the same reason.
    - `build_guard_settings()` folds the operator's `~/.claude/settings.local.json` into the deny
      list; tests pin `local_settings_path` at a nonexistent file so a real one can't forge a
      refusal.
- **AskUserQuestion bridge** (`hooks/ask.py`, same shape) — writes
  `~/.turma/questions/<sessionId>.req.json` (session id via `TURMA_SESSION_ID`/`TURMA_QUESTIONS_DIR`)
  and **blocks**, polling for the answer file `answer_question()` drops.
  - Answers come back as a `PreToolUse` **deny** whose `permissionDecisionReason` is a
    `{kind:"askuserquestion_answers", answers}` blob — deny-with-reason is the channel because an
    allow can't carry typed answer data.
  - Serialized per session (req/ans key on session id alone). Hook's block timeout
    (`TURMA_QUESTION_TIMEOUT_SEC`, 600s) sits under the settings-level `timeout`; passes through
    silently when env vars absent. Kill/delete/restart clear pending req/ans files. `multiSelect`
    accepts `optionIndices`.
  - Tests: `test_ask.py`, `TestHookQuestion`, `TestAnswerQuestion`, `test_guard_settings.py`.
