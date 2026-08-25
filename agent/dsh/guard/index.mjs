// Turma dsh safety guard — the cordis plugin (XERK-470 [F]).
//
// The dsh analogue of Claude Code's `--settings` guard wiring. Composed into the
// per-session dsh process by `@turma/dsh-session-driver` (XERK-466 [B]); the
// config it receives is produced by `build_dsh_guard_config()` in `hub-agent.py`
// — the "settings equivalent every launch passes" the ticket names.
//
// It maps Turma's deny policy onto dsh's tool pipeline (see the
// `@deepseek-ai/dsh-tools` contract):
//
//   ctx.tools.guard(fn)  — a MONOTONIC, non-overridable deny run after every
//     `tools/pre-execute` listener and before the tool body. "Guards have no
//     allow result, so listener ordering cannot turn a denial back into
//     permission." This is exactly the semantics Claude's guard needs — a hard
//     rule the model self-corrects from, never something a later plugin (or the
//     model) can talk its way past. All three Claude categories live here:
//     destructive/policy/attribution shell (guard.py), the ~/.claude write
//     predicate (fileguard.py), and the credential-store path denies.
//
//   tools/pre-execute -> { kind:'allow' }  — the read carve-out for the
//     per-session uploads tree, so an attachment staged by [C] (XERK-467) is
//     readable with no approval prompt (the analogue of Claude's
//     `Read(~/.turma/uploads/**)` allow). pre-execute `allow` short-circuits the
//     approval seam; the monotonic guard above still never denies these reads.
//
// The AskUserQuestion bridge and the ask/never approval policy are NOT this
// plugin's to implement: dsh already owns them (`@deepseek-ai/dsh-user-approval`
// — `ask` delegates to the composed answerer and FAILS CLOSED with none; the
// answerer over the control socket is [C]'s). `build_dsh_guard_config()` pins
// `approval/policy: ask` + `sandbox/mode: workspace-write` into the profile so
// this plugin composes on top of a fail-closed base. See `.claude/rules/dsh-guard.md`.

import { compileConfig, decideDeny, isAllowedRead } from './policy.mjs'

export const name = 'turma-dsh-guard'
// `tools` is required — without the registry there is nothing to guard. The
// approval/sandbox services are consumed by dsh itself, not injected here.
export const inject = ['tools']

export function apply(ctx, config) {
  const cfg = compileConfig(config || {})

  // The hard, non-overridable deny. Synchronous by contract; the guard.py /
  // fileguard.py subprocess is a blocking `execFileSync`, matching how Claude
  // Code spawns the same hook on every Bash call. Any throw fails closed.
  const disposeGuard = ctx.tools.guard((execution) => {
    try {
      return decideDeny(execution, cfg) ?? undefined
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      return `Turma safety guard error: ${msg}. Denying by default.`
    }
  })

  // Pre-approve reads of the per-session uploads tree (and the roster) so no
  // approval prompt blocks a staged attachment. Only ALLOW is emitted here —
  // denial stays with the monotonic guard, which this cannot weaken.
  const disposePre = ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (isAllowedRead(exec, cfg)) return { kind: 'allow' }
    } catch {
      // fall through to the normal pipeline on any classification error
    }
    return next()
  })

  return () => {
    disposeGuard()
    disposePre()
  }
}

export default { name, inject, apply }
