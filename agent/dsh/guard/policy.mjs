// Turma dsh safety guard — the deny-policy engine (XERK-470 [F]).
//
// This is the dsh equivalent of Claude Code's safety guard. Under Claude the
// guard is three stdlib `PreToolUse` hooks (`guard.py`, `fileguard.py`,
// `ask.py`) wired into a `--settings` file by `build_guard_settings()`. dsh has
// no `--settings` file and no external hook process: it gates tool calls INSIDE
// the agent process through `ctx.tools` (see `index.mjs`). This module is the
// pure classifier those in-process gates call — kept side-effect-free (except
// the guard-hook subprocess) and free of any cordis import so it is unit-testable
// on its own.
//
// The deny POLICY is not re-implemented here. destructive/policy/attribution
// shell classification and the "everything under ~/.claude except the two memory
// trees" predicate are the hardest, most safety-critical logic in the fleet, and
// they already exist, measured and tested, in `agent/hooks/guard.py` and
// `agent/hooks/fileguard.py`. This module SHELLS OUT to those exact hooks — the
// same binaries, invoked the same `python3 -SsE` way Claude Code invokes them —
// so both runtimes share ONE deny policy and a change to it lands in one place.
// What this module owns natively is only the flat path-glob rules (credential
// stores, the runtime-code dir, the uploads/roster read carve-outs), which
// `build_dsh_guard_config()` hands over as data derived from the SAME
// `build_guard_settings()` rule set — again, no second list to keep in sync.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// --- tool routing --------------------------------------------------------
//
// dsh's tool names and argument shapes, read from the real packages
// (`@deepseek-ai/dsh-tool-bash`, `-tool-fs`, `-tool-str-replace-editor`):
//   bash                { command, cwd?, ... }          -> shell
//   write, edit         { path, content?, ... }         -> file write
//   read, read_image    { path, offset?, limit? }       -> file read
//   str_replace_editor  { command: <verb>, path, ... }  -> write or read by verb
//
// A shell tool is matched by NAME pattern, not by "has a `command` arg", because
// str_replace_editor also carries a `command` (its verb is `view`/`create`/…,
// never a shell line). Persistent/alternate shells (bash-persistent, pwsh) match
// the same pattern.
const SHELL_NAME_RE = /(^|[-_])(bash|sh|zsh|pwsh|powershell|shell|terminal)([-_]|$)/i
const FS_READ_TOOLS = new Set(['read', 'read_image'])
const FS_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit'])
const EDITOR_TOOLS = new Set(['str_replace_editor', 'str_replace_based_edit_tool'])
// str_replace_editor verbs that MUTATE the file. `view` reads; everything that
// changes bytes is a write. Unknown verbs are treated as writes (fail safe).
const EDITOR_READ_VERBS = new Set(['view'])

const PATH_KEYS = ['path', 'file_path', 'notebook_path']

function firstPath(args) {
  for (const k of PATH_KEYS) {
    const v = args && args[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

// Classify a tool call into the surface the guard reasons about.
// Returns { kind: 'shell', command } | { kind: 'write'|'read', target } |
//   { kind: 'other' }  (ungated — see the run_code residual note in the rules).
export function classify(name, args) {
  const n = String(name || '').toLowerCase()
  args = args || {}
  if (SHELL_NAME_RE.test(n) && typeof args.command === 'string') {
    return { kind: 'shell', command: args.command }
  }
  if (FS_WRITE_TOOLS.has(n)) return { kind: 'write', target: firstPath(args) }
  if (FS_READ_TOOLS.has(n)) return { kind: 'read', target: firstPath(args) }
  if (EDITOR_TOOLS.has(n)) {
    const verb = String(args.command || '').toLowerCase()
    const kind = EDITOR_READ_VERBS.has(verb) ? 'read' : 'write'
    return { kind, target: firstPath(args) }
  }
  // Everything else (cordis_run, ralph, glob, grep, web_*, MCP tools) is
  // UNGATED here — a code-exec tool's nested tool calls re-enter this pipeline
  // and are re-gated, but its own direct fs/network is dsh's sandbox's job (the
  // workspace-write / ask pins build_dsh_guard_config sets). See dsh-guard.md.
  return { kind: 'other' }
}

// --- glob matching -------------------------------------------------------
//
// The path rules arrive as absolute, `~`-expanded globs from
// `build_dsh_guard_config()` (e.g. `/root/.ssh/**`, `/root/.claude/*.json`).
// Semantics mirror the gitignore-style matching Claude Code applies to its own
// `Read(...)`/`Edit(...)` rules: `*` and `?` do not cross `/`; `**` crosses any
// depth. The deny side is deliberately allowed to be no NARROWER than Claude's;
// where it is looser it over-denies, which is the safe direction for a guard.
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ } // ** — any depth incl. `/`
      else re += '[^/]*'                            // *  — within one segment
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  // The glob is a TRUSTED path rule from build_dsh_guard_config (the operator's
  // and repo's own deny list), compiled ONCE at plugin load, and every produced
  // token is linear (`.*`, `[^/]*`, `[^/]`, escaped literals) with no nested
  // quantifier, so there is no catastrophic-backtracking surface. Not built from
  // any tool argument.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp('^' + re + '$')
}

function matchesAny(target, regexps) {
  return regexps.some((r) => r.test(target))
}

// The absolute, lexically-normalized target WITHOUT symlink resolution — the
// path the tool actually NAMED, with `..` collapsed but every symlink left
// intact. Matched BESIDE the realpath'd target (XERK-497): a credential store
// symlinked OUT of $HOME defeats a $HOME-relative deny glob when only the
// realpath'd target is checked, because realpath rewrites the target to a
// location the glob no longer covers. The classic case is WSL, where `~/.aws`,
// `~/.azure` and `~/.kube/config` point at `/mnt/c/Users/<u>/…`. Denying if
// EITHER the literal or the realpath'd target matches catches the store
// whichever way its symlink points, while realpath still closes a symlink used
// to DODGE a rule from inside the worktree (the anti-symlink-dodge resolveTarget
// exists for). `_realpath_glob_prefix` on the RULE side (XERK-503) is the
// complementary half: together they cover a store DIR symlinked out, a store
// FILE symlinked out under a real dir, and an unrelated symlink pointing into a
// symlinked-out store.
function literalTarget(p, cwd) {
  if (typeof p !== 'string' || !p) return null
  return path.resolve(cwd || process.cwd(), p)
}

// Deny if the literal OR the realpath'd target matches — the both-sides check
// XERK-497 adds. `real` is always present here; `literal` is skipped when equal.
function matchesTarget(literal, real, regexps) {
  if (real != null && matchesAny(real, regexps)) return true
  if (literal != null && literal !== real && matchesAny(literal, regexps)) return true
  return false
}

// Resolve a tool's path argument to an absolute, symlink-canonical path the way
// the py guards do (`os.path.realpath`), so a rule cannot be dodged by a symlink
// or a `..`. A write target may not exist yet, so realpath the longest existing
// prefix and re-join the tail.
function resolveTarget(p, cwd) {
  if (typeof p !== 'string' || !p) return null
  let abs = path.resolve(cwd || process.cwd(), p)
  let tail = []
  let cur = abs
  // Walk up to the nearest existing ancestor, canonicalize it, re-descend.
  // Bounded by the path depth; no unbounded loop.
  for (let guard = 0; guard < 4096; guard++) {
    try {
      const real = fs.realpathSync(cur)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs // reached root without an existing prefix
      tail.unshift(path.basename(cur))
      cur = parent
    }
  }
  return abs
}

// --- the shared py deny policy (guard.py / fileguard.py) ------------------
//
// Invoke a Claude `PreToolUse` hook exactly as Claude Code does: the same
// `python3 -SsE <hook>` command (the `-SsE` flags are the interpreter-injection
// defence documented in agent-hooks.md), the PreToolUse JSON on stdin, the deny
// JSON on stdout. Returns the denial reason, or null to allow.
//
// FAILS CLOSED. guard.py/fileguard.py themselves fail OPEN on a malformed
// payload because Claude keeps `permissions.deny` patterns as a backstop; dsh
// has no such backstop, so if the hook process cannot be run at all (missing
// interpreter, missing script, crash, timeout) we DENY with a clear reason
// rather than silently stop enforcing — a guard that quietly disengages is the
// exact "not shippable" state this ticket exists to prevent.
function runHook(cfg, script, toolName, toolInput, cwd) {
  if (!script) return null
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    cwd: cwd || cfg.cwd || process.cwd(),
    session_id: cfg.sessionId || '',
    permission_mode: 'bypassPermissions',
  })
  let out
  try {
    out = execFileSync(cfg.pythonExe || 'python3', ['-SsE', script], {
      input: payload,
      timeout: cfg.hookTimeoutMs || 5000,
      maxBuffer: 1 << 20,
      encoding: 'utf8',
      // Pass the process env through so guard.py still reads $TURMA_TOOL_GRANTS
      // and $TURMA_NO_ATTRIBUTION (unaffected by -E, which only drops PYTHON*).
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch (e) {
    return `Turma safety guard could not run (${script}): ${e && e.message ? e.message : e}. Denying by default.`
  }
  const text = String(out || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    const hs = parsed && parsed.hookSpecificOutput
    if (hs && hs.permissionDecision === 'deny') {
      return String(hs.permissionDecisionReason || 'denied by Turma safety guard')
    }
  } catch {
    // Hook emitted something we cannot parse — treat as a deny, fail closed.
    return `Turma safety guard returned an unreadable decision from ${script}. Denying by default.`
  }
  return null
}

// --- the decision --------------------------------------------------------
//
// The single entry point the monotonic `ctx.tools.guard()` calls. Returns a
// denial reason string, or null to leave the call allowed. This is the
// non-overridable HARD deny — the analogue of Claude's guard + file guard +
// credential-store `permissions.deny`.
export function decideDeny(execution, cfg) {
  const c = classify(execution && execution.name, execution && execution.arguments)

  if (c.kind === 'shell') {
    // destructive / policy / attribution — guard.py. Shell commands walk past
    // the path rules exactly as they do under Claude (agent-hooks.md / XERK-309).
    return runHook(cfg, cfg.guardScript, 'Bash', { command: c.command }, cfg.cwd)
  }

  if (c.kind === 'write') {
    const target = resolveTarget(c.target, cfg.cwd)
    if (!target) return null
    const literal = literalTarget(c.target, cfg.cwd)
    // ~/.claude "everything except the memory trees" — fileguard.py owns this
    // predicate; a glob list cannot express it (agent-hooks.md). It realpaths
    // both its base and the target itself, so a symlinked `~/.claude` DIR cannot
    // dodge it — the both-sides match below is for the flat globs, not this.
    const claudeReason = runHook(cfg, cfg.fileguardScript, 'Write', { file_path: target }, cfg.cwd)
    if (claudeReason) return claudeReason
    // Credential / config / runtime-code stores — the flat write-deny globs
    // (Claude's `Edit(...)` rules), defence in depth beside fileguard. Matched
    // against the literal AND the realpath'd target (XERK-497).
    if (matchesTarget(literal, target, cfg._denyWriteRe)) {
      return denyWriteReason(target)
    }
    return null
  }

  if (c.kind === 'read') {
    const target = resolveTarget(c.target, cfg.cwd)
    if (!target) return null
    const literal = literalTarget(c.target, cfg.cwd)
    // Read carve-outs win over every read deny: the per-session uploads tree and
    // the peer roster are files the session is MEANT to read (XERK-234/348), and
    // pre-approving them is the cross-child contract [C] (XERK-467) depends on.
    // Matched on the realpath'd target only — widening an ALLOW on a literal
    // path is the wrong direction for a guard.
    if (matchesAny(target, cfg._allowReadRe)) return null
    if (matchesTarget(literal, target, cfg._denyReadRe)) return denyReadReason(target)
    return null
  }

  return null
}

// Is this a read the session is explicitly allowed (uploads / roster)? Used by
// the pre-execute allow short-circuit so no approval prompt ever blocks it.
export function isAllowedRead(execution, cfg) {
  const c = classify(execution && execution.name, execution && execution.arguments)
  if (c.kind !== 'read') return false
  const target = resolveTarget(c.target, cfg.cwd)
  return target != null && matchesAny(target, cfg._allowReadRe)
}

function denyWriteReason(target) {
  return (
    `Writing ${target} is blocked by the Turma safety guard: it is a host ` +
    `credential store, agent config, or the guard's own runtime code, shared ` +
    `across every session on this host. Do the work inside your worktree.`
  )
}

function denyReadReason(target) {
  return (
    `Reading ${target} is blocked by the Turma safety guard: it holds a ` +
    `host-shared credential. It is not needed for your task.`
  )
}

// Compile the string globs into anchored regexps once, at plugin load.
export function compileConfig(cfg) {
  const compile = (arr) => (Array.isArray(arr) ? arr : []).map(globToRegExp)
  return {
    ...cfg,
    _denyWriteRe: compile(cfg.denyWrite),
    _denyReadRe: compile(cfg.denyRead),
    _allowReadRe: compile(cfg.allowRead),
  }
}

// Exported for tests only.
export const _internals = { globToRegExp, resolveTarget, literalTarget, matchesAny, matchesTarget, runHook }
