---
paths:
  - "agent/qwen/guard/**"
  - "agent/hub-agent.py"
  - "agent/tests/test_qwen_guard.py"
---

# [Qwen F] (XERK-510) Qwen safety guard (PreToolUse shim + permissions.deny)

Split out of `qwen.md` (size ceiling).

qwen's PreToolUse-hook model IS Claude's, so it reuses the shared deny policy directly. The deny
POLICY is NOT duplicated: destructive/policy/attribution shell classification (`guard.py`) and the
"everything under ~/.claude except the two memory trees" predicate (`fileguard.py`) have ONE home,
shelled out to `python3 -SI <hook>` exactly as Claude and dsh do.

- **The one mismatch qwen adds is TOOL NAMES, so a thin SHIM bridges it** (`agent/qwen/guard/shim.py`).
  `guard.py` keys on `tool_name=="Bash"` and `fileguard.py` on `Write|Edit|…`; a qwen
  `run_shell_command`/`write_file` sails past both. The shim classifies a qwen tool
  (shell/write/read, the qwen twin of the dsh guard's `classify`), shells out to the SHARED hooks with
  the Claude tool shape they expect, AND matches the flat credential/config/runtime-code globs itself
  (realpath'd, so a symlink/`..` cannot dodge them). **The shim is the enforcement; it does NOT
  re-implement the deny policy** — only routing + the flat globs.
- **`build_qwen_guard_config()` reads the SAME rule set `build_guard_settings()` produces** (parsed
  with `_parse_perm_rule`, as the dsh builder does) and emits (a) the `hooks.PreToolUse` wiring and
  (b) the shim's data config (`~/.turma/qwen-guard.json`: hook paths + denyWrite/denyRead/allowRead).
  **Adding a store to `_GUARD_DENY_PATH_RULES` covers all three runtimes with NO qwen change** —
  pinned by `test_shim_config_is_the_shared_rule_set`. Built + written at the launch choke point
  (`_qwen_guard_config`, memoized like `_ensure_guard_settings`; primed off-beat by `_prime_qwen`),
  merged into `.qwen/settings.json` by `_qwen_settings`.
- **It FAILS CLOSED.** `guard.py`/`fileguard.py` fail OPEN on a malformed payload because Claude keeps
  `permissions.deny` as a backstop; qwen has none the shim can rely on, so the shim DENIES (deny JSON
  on stdout AND exit 2) on: an unreadable config, a hook it cannot spawn / that crashes (nonzero exit)
  / times out / returns unreadable output, a SHELL call with no configured guard script, an
  unparseable tool payload, or any unexpected error in the shim. A missing FILEGUARD degrades to the
  write-deny globs (defence in depth, like dsh), not a fail-closed — the globs still name the
  catastrophic ~/.claude subset. **G0 GOTCHA baked in: qwen's hook `timeout` is MILLISECONDS** — a
  too-small value silently disables the guard, so `QWEN_GUARD_HOOK_TIMEOUT_MS` (15000) comfortably
  exceeds the shim's own nested-subprocess budget (`QWEN_SHIM_HOOK_TIMEOUT_MS`, 5000).
- **Approval mode stays `auto` (NOT `yolo`, NOT `default`)** — "not auto-yolo, not auto-reject".
  `default` would HANG on every tool-approval prompt (nothing auto-answers them until [Qwen P]);
  `yolo` risks skipping hooks. `auto` is the Claude `--permission-mode auto` analogue: hands-off,
  hooks fire. **That hooks also fire under `auto` is host-UNVERIFIED and is THE gate before
  `QWEN_ENABLED` is flipped** — see `docs/qwen-adr.md`.
- **`permissions.deny` is UNVERIFIED defence in depth** — emitted as the Claude backstop analogue, but
  the shim does NOT depend on it; if a real qwen REJECTS the unknown key the fix is a one-line removal
  (`_confirm_qwen_launch` catches a launch break).
- **The credential env file is read-denied** (`Read(~/.turma/qwen/*.env)`, holds `OPENAI_API_KEY`) —
  defence in depth: 0600 already stops other uids and the session runs as the owning uid, so this only
  stops a casual read via the file-editing tools (Bash walks past it, XERK-309).
- **A credential store symlinked out of $HOME is caught two ways.** `_realpath_glob_prefix` (XERK-503)
  resolves symlinks in each glob's literal prefix (a symlinked HOME *subdirectory* — `~/.aws` a bind
  mount, or WSL's Windows-side profile), and `_matches_target` (XERK-497) matches the deny globs
  against BOTH the literal and the realpath'd target, so a symlinked *leaf* (`~/.kube/config`,
  `~/.kube` itself real) no longer dodges either. Both mirror the dsh guard's `policy.mjs`. Two
  residual gaps (the ungated unknown tool name; the shim's re-readable config) are stated in
  `docs/qwen-adr.md` — accepted, not open bugs.
- Tests: `test_qwen_guard.py` — `TestBuildQwenGuardConfig` pins the config (hook wiring, ms-timeout
  ordering, shared-rule-set derivation, credential read-deny, no-ListAgents, missing-fileguard
  degrade); `TestQwenGuardShimEndToEnd` drives the REAL shim over the REAL guard.py/fileguard.py with
  hostile inputs (destructive/policy/attribution shell, credential + ~/.claude writes, credential
  reads vs the uploads/roster carve-outs, symlink escape, every fail-closed path).
