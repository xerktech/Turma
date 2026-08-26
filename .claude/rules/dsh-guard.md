---
paths:
  - "agent/dsh/guard/**"
  - "agent/hub-agent.py"
---

# dsh safety guard — the dsh equivalent of the Claude `--settings` guard (XERK-470 [F])

The Claude guard is in `.claude/rules/agent-hooks.md`: three stdlib PreToolUse hooks
(`guard.py`/`fileguard.py`/`ask.py`) wired into a `--settings` file by `build_guard_settings()`.
dsh (XERK-460) is a **second runtime** with a different enforcement model, so [F] maps that same
deny policy onto it. This file is the mapping and its invariants; the Claude side stays canonical.

## Where the deny policy lives — it is NOT duplicated

- **The deny POLICY is `guard.py` + `fileguard.py`, shared by both runtimes.** The dsh guard
  (`agent/dsh/guard/policy.mjs`) SHELLS OUT to those exact scripts, invoked the same
  `python3 -SsE <hook>` way with the same PreToolUse JSON on stdin. Destructive/policy/attribution
  shell classification and the "everything under ~/.claude except the memory trees" predicate have
  ONE home. **Never port that logic into TS** — that is the N-way mirror multiplication `CLAUDE.md`
  and the dsh ADR (D3) exist to avoid.
- **The credential/roster path globs are ONE list too.** `build_dsh_guard_config()` reads the SAME
  rule set `build_guard_settings()` produces and converts its `Read(...)`/`Edit(...)` rules into the
  guard's `denyWrite`/`denyRead`/`allowRead` globs. Adding a credential store to `_GUARD_DENY_PATH_RULES`
  covers both runtimes with no dsh change.

## dsh's model → the mapping (see `@deepseek-ai/dsh-tools`)

dsh gates tool calls **inside the agent process**, not with an external hook. The pipeline is
`tools/pre-execute` (allow/deny/**ask**) → monotonic `ctx.tools.guard()` → dispatch.

- **`ctx.tools.guard()` carries the hard denies.** It is monotonic — "guards have no allow result,
  so listener ordering cannot turn a denial back into permission" — which is exactly what Claude's
  guard needs: a hard rule the model self-corrects from, never something a later plugin or the model
  can talk past. Shell (guard.py), ~/.claude writes (fileguard.py) and credential-store writes/reads
  all deny here.
- **`tools/pre-execute → {kind:'allow'}` carries the uploads read carve-out.** pre-execute `allow`
  short-circuits the approval seam, the analogue of Claude's `Read(~/.turma/uploads/**)` allow. Only
  ALLOW is emitted there; denial stays with the monotonic guard, which pre-execute cannot weaken.
- **The AskUserQuestion bridge is dsh-native, not this plugin's.** `@deepseek-ai/dsh-user-approval`'s
  `ask` policy delegates to the composed answerer and **fails closed to a denial with none composed**.
  The answerer over the control socket is [C] (XERK-467); [F] only pins the policy so the guard
  composes over a fail-closed base — `never` would auto-reject every escalation without ever asking
  the operator.
- **`sandbox/mode: workspace-write`** confines writes to the worktree (the dsh analogue of a Claude
  session running in its worktree). Both pins are in `build_dsh_guard_config()`; the driver writes
  them into the dsh profile.

## The "settings equivalent every launch passes"

- `build_dsh_guard_config()` is that equivalent — it returns the plugin config + the two profile
  pins, NOT a settings dict claude reads. `_dsh_guard_config()` memoizes it on the manager like
  `_ensure_guard_settings`, and `_launch_dsh` builds it **at the launch choke point** so the seam is
  wired and exercised even while the process launcher (XERK-466 [B]) is a stub.
- **XERK-466's launcher MUST consume it**: compose `@turma/dsh-guard` from `cfg["pluginPath"]` with
  `cfg["plugin"]` (adding the per-session `sessionId`/`cwd`), and pin the profile from
  `cfg["sandboxMode"]`/`cfg["approvalPolicy"]`. A dsh launch that skips this ships a runtime with no
  guard — the "not shippable" state this ticket gates against.

## Invariants a change must not undo

- **Fail CLOSED when a hook cannot RUN.** guard.py/fileguard.py fail OPEN on a malformed payload
  because Claude keeps `permissions.deny` patterns as a backstop; dsh has no such backstop, so
  `runHook` DENIES on a spawn error / crash / timeout / unreadable output. `build_guard_settings`'s
  "missing script fails closed" rule, enforced by the guard itself here.
- **Routing is by tool NAME, not by "has a `command` arg".** `str_replace_editor` also carries a
  `command` (verb `view`/`create`/…), so keying shell classification on the arg would misroute it.
  Shell = name matches `bash|pwsh|…`; writes = `write`/`edit`/`str_replace_editor` (mutating verb);
  reads = `read`/`read_image`/`str_replace_editor view`. An unknown verb is treated as a WRITE.
- **Paths are realpath-resolved (existing-prefix walk for a not-yet-created write target)**, so a
  symlink or `..` cannot dodge a rule — same reason fileguard.py realpaths.
- **Reads of credential STORES are allowed, matching Claude exactly.** Claude's credential rules are
  `Edit(...)` only (write-deny); only `~/.turma/local-model.env` is read-denied. Fidelity over
  intuition — "the same denied operations", no more.

## Residual gaps (state them; do not paper over)

- **Code-execution and search tools are UNGATED.** `classify` returns `other` for anything outside
  the known shell/fs-write/fs-read/editor surfaces. Confirmed against real dsh 0.1.1-rc.2, the
  ungated set includes **`cordis_run`** and **`ralph`** (arbitrary code / autonomous loops, from
  `@deepseek-ai/dsh-tool-cordis` / `-tool-ralph`) plus `glob`/`grep`/`web_fetch`/`web_search`. A
  code-exec tool's own nested tool calls re-enter the pipeline and ARE re-gated, but direct
  fs/network from inside it is **dsh's sandbox's job, not this guard's** — which is why
  `build_dsh_guard_config` pins `sandboxMode: workspace-write` + `approvalPolicy: ask`. This is the
  dsh analogue of Claude's "Bash is not covered by fileguard" caveat, and it is the reason those
  pins are load-bearing: **XERK-466's launcher MUST enforce them** (dsh enforces the sandbox; this
  change only sets the value). Re-QA that seam when the launcher ships.
- **`pwsh` routes to the bash-syntax classifier.** A PowerShell tool call goes to `guard.py` as a
  `Bash` tool, but `guard.py` matches bash-oriented destructive patterns, so `Remove-Item -Recurse
  -Force /` would likely not match. Low risk (Linux agent image; pwsh is niche) and still ahead of
  Claude, which has no pwsh tool at all — but a PowerShell-aware destructive check is the honest fix
  if a pwsh executor is ever composed.
- **The peer-roster boundary (`ListAgents` deny) has no dsh analogue here** — dsh exposes no
  fleet-enumeration tool in scope, so the bare tool rule is dropped by `build_dsh_guard_config`.
- **The uploads read-allow is fleet-wide (`~/.turma/uploads/**`), not per-`<sid>`** — parity with
  Claude's rule, an accepted looseness (one dsh session could read another's staged uploads).

## Verification

- **Deny policy** — `agent/dsh/guard/test/policy.test.mjs` drives the REAL guard.py/fileguard.py
  over hostile inputs (`node --test`, in CI). `agent/tests/test_dsh_guard_config.py` pins the config
  builder.
- **Real-dsh wiring** — `agent/dsh/guard/test/run-drive.sh` composes `@turma/dsh-guard` into the
  REAL `@deepseek-ai/dsh-tools` ToolRuntime with the production `build_dsh_guard_config()` output,
  drives hostile + benign calls through `ctx.tools.execute()` and asserts the hostile ones are
  denied at dispatch (body never runs). Needs a real dsh install (host proof, not CI). This is the
  literal "QA driving hostile input at a real dsh session" the ticket asks for, minus the model —
  end-to-end through a launched Turma dsh session is gated on XERK-466.
