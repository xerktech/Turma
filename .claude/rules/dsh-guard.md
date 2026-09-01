---
paths:
  - "agent/dsh/guard/**"
  - "agent/hub-agent.py"
---

# dsh safety guard — the dsh equivalent of the Claude `--settings` guard (XERK-470 [F])

Claude guard: `.claude/rules/agent-hooks.md` (canonical, three stdlib PreToolUse hooks). dsh is a
second runtime with a different enforcement model; [F] maps that same deny policy onto it.

## Where the policy lives — NOT duplicated

- **Deny POLICY is `guard.py` + `fileguard.py`, shared by both runtimes.** `agent/dsh/guard/policy.mjs`
  SHELLS OUT to those scripts (`python3 -SsE <hook>`, same PreToolUse JSON on stdin). **Never port
  that logic into TS** — the mirror multiplication `docs/dsh-adr.md` (D3) exists to avoid.
- **Credential/roster path globs are ONE list too.** `build_dsh_guard_config()` reads the SAME rule
  set `build_guard_settings()` produces, converting `Read(...)`/`Edit(...)` into `denyWrite`/
  `denyRead`/`allowRead` globs. A `_GUARD_DENY_PATH_RULES` addition covers both runtimes with no dsh
  change.

## dsh's model → the mapping (`@deepseek-ai/dsh-tools`)

dsh gates INSIDE the agent process, not an external hook: `tools/pre-execute` (allow/deny/**ask**) →
monotonic `ctx.tools.guard()` → dispatch.

- **`ctx.tools.guard()` carries the hard denies, MONOTONIC** — no allow result, so no later plugin or
  the model can talk past a denial. Shell (guard.py), ~/.claude writes (fileguard.py), credential
  reads/writes all deny here.
- **`pre-execute → {kind:'allow'}` carries the uploads read carve-out** (Claude's
  `Read(~/.turma/uploads/**)` analogue) — only ALLOW is emitted there; denial stays with the
  monotonic guard.
- **The AskUserQuestion bridge is dsh-native, not this plugin's.** `@deepseek-ai/dsh-user-approval`'s
  `ask` policy delegates to the composed answerer, **fails closed with none composed**. Answerer is
  [C] (dsh-input.md); [F] only pins the policy so the guard composes over a fail-closed base.
- **`sandbox/mode: workspace-write`** confines writes to the worktree (Claude-session-in-worktree
  analogue). Both pins live in `build_dsh_guard_config()`.

## The "settings equivalent every launch passes"

`build_dsh_guard_config()` returns the plugin config + the two profile pins (not a settings dict).
`_dsh_guard_config()` memoizes it like `_ensure_guard_settings`; `_launch_dsh` builds it **at the
launch choke point** so the guard is wired before the process runs. The launcher composes
`@turma/dsh-guard` from `cfg["pluginPath"]`/`cfg["plugin"]` and pins the profile from
`cfg["sandboxMode"]`/`cfg["approvalPolicy"]` — skipping this ships an unguarded runtime.

## Invariants a change must not undo

- **Fail CLOSED when a hook cannot RUN** — dsh has no `permissions.deny` backstop (unlike Claude), so
  `runHook` DENIES on a spawn error/crash/timeout/unreadable output.
- **Routing is by tool NAME, not "has a `command` arg"** — `str_replace_editor` also carries
  `command`, so arg-keying misroutes it. Shell = `bash|pwsh|…`; writes = `write`/`edit`/
  `str_replace_editor` (mutating verb); reads = `read`/`read_image`/`str_replace_editor view`. An
  unknown verb → WRITE.
- **Paths are realpath-resolved** (existing-prefix walk for a not-yet-created target) — a symlink or
  `..` cannot dodge a rule.
  - **A credential deny is matched against BOTH the literal and the realpath'd target** (XERK-497,
    `matchesTarget` in `policy.mjs` / `_matches_target` in the qwen shim). A store symlinked OUT of
    $HOME (WSL's `~/.aws`, `~/.kube/config` → `/mnt/c/...`) realpaths to a path no $HOME-relative deny
    glob covers, so the realpath'd target ALONE reads as allowed. The literal (pre-realpath, `..`-
    collapsed) target is what still catches a symlinked-out leaf; realpath still closes a symlink used
    to DODGE a rule. The RULE-side half is `_realpath_glob_prefix` (XERK-503), which resolves a
    symlinked store DIRECTORY in the glob's prefix — the two together cover dir-symlinked-out,
    file-symlinked-out-under-a-real-dir, and an unrelated symlink into a symlinked-out store.
    ALLOW carve-outs (uploads/roster) stay realpath-only — widening an allow on a literal path is the
    wrong direction. `sandbox: workspace-write` (`dsh-fs-sandbox`/landlock) independently blocks the
    actual write, so this is defence in depth, not the sole barrier.
- **Reads of credential STORES are allowed, matching Claude exactly** — Claude's rules are
  write-deny-only except `~/.turma/local-model.env`. Fidelity over intuition.

## Residual gaps (accepted, not papered over)

- **Code-execution and search tools are UNGATED** — `classify` returns `other` outside the known
  surfaces: **`cordis_run`**, **`ralph`** (arbitrary code / autonomous loops), `glob`/`grep`/
  `web_fetch`/`web_search`. Direct fs access from inside a code-exec tool is dsh's SANDBOX's job, not
  this guard's — why `sandboxMode: workspace-write` + `approvalPolicy: ask` are pinned on EVERY
  launch (a standing invariant).
  - **`workspace-write` gates the FILESYSTEM only, NOT network egress** (verified on real dsh) — a
    `curl` from a code-exec tool reaches the network unprompted, deliberate parity with Claude's own
    ungated Bash egress. An SSRF-sensitive deployment needs a network policy dsh does not express
    here.
- **`pwsh` routes to the bash-syntax classifier** — a destructive PowerShell pattern likely would not
  match. Low risk (Linux image, niche); still ahead of Claude (no pwsh tool at all).
- **No dsh analogue of the `ListAgents` deny** — dsh exposes no fleet-enumeration tool in scope.
- **Uploads read-allow is fleet-wide, not per-`<sid>`** — parity with Claude, accepted looseness.

## Verification

- **Deny policy** — `agent/dsh/guard/test/policy.test.mjs` drives the REAL guard.py/fileguard.py over
  hostile inputs (CI). `agent/tests/test_dsh_guard_config.py` pins the config builder.
- **Real-dsh wiring** — `agent/dsh/guard/test/run-drive.sh` composes `@turma/dsh-guard` into the REAL
  `@deepseek-ai/dsh-tools` ToolRuntime with production config, drives hostile + benign calls, asserts
  denial at dispatch. Host proof, not CI (needs a real dsh install).
