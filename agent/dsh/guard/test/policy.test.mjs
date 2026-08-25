// Unit proof of the dsh guard's deny policy (XERK-470 [F]).
//
// These drive the REAL `agent/hooks/guard.py` and `agent/hooks/fileguard.py`
// (the same binaries the Claude guard runs) through the dsh classifier, so a
// PASS here is proof that a hostile dsh tool call is denied by the same policy
// that denies the Claude one — the deny-policy half of "the same denied
// operations are denied under dsh". The live-dsh-pipeline half is the harness in
// `agent/dsh/guard/test/drive-real-dsh.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classify, decideDeny, isAllowedRead, compileConfig, _internals } from '../policy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOKS = path.resolve(HERE, '..', '..', '..', 'hooks')
const HOME = os.homedir()
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-cwd-'))

// A config shaped exactly like `build_dsh_guard_config()` output, with the
// credential/roster globs the real builder derives from build_guard_settings.
const cfg = compileConfig({
  pythonExe: 'python3',
  guardScript: path.join(HOOKS, 'guard.py'),
  fileguardScript: path.join(HOOKS, 'fileguard.py'),
  cwd: CWD,
  sessionId: 'test-session',
  denyWrite: [
    `${HOME}/.ssh/**`,
    `${HOME}/.aws/**`,
    `${HOME}/.kube/**`,
    `${HOME}/.git-credentials`,
    `${HOME}/.claude/hooks/**`,
    `${HOME}/.turma/guard-settings.json`,
    `${HOME}/.local/lib/python*/site-packages/**`,
  ],
  denyRead: [`${HOME}/.turma/local-model.env`],
  allowRead: [`${HOME}/.turma/uploads/**`, `${HOME}/.turma/peers.tsv`],
})

const ex = (name, args) => ({ name, arguments: args })

// --- routing -------------------------------------------------------------

test('classify routes dsh tools by name and verb', () => {
  assert.deepEqual(classify('bash', { command: 'ls' }), { kind: 'shell', command: 'ls' })
  assert.deepEqual(classify('bash-persistent', { command: 'ls' }), { kind: 'shell', command: 'ls' })
  assert.equal(classify('write', { path: '/x', content: 'y' }).kind, 'write')
  assert.equal(classify('edit', { path: '/x' }).kind, 'write')
  assert.equal(classify('read', { path: '/x' }).kind, 'read')
  assert.equal(classify('read_image', { path: '/x' }).kind, 'read')
  // str_replace_editor is a write when its verb mutates, a read when it views
  assert.equal(classify('str_replace_editor', { command: 'create', path: '/x' }).kind, 'write')
  assert.equal(classify('str_replace_editor', { command: 'str_replace', path: '/x' }).kind, 'write')
  assert.equal(classify('str_replace_editor', { command: 'view', path: '/x' }).kind, 'read')
  // unknown verb -> write (fail safe)
  assert.equal(classify('str_replace_editor', { command: 'wat', path: '/x' }).kind, 'write')
  // unrelated tool -> ungated
  assert.equal(classify('web_search', { query: 'x' }).kind, 'other')
})

// --- destructive / policy / attribution shell (guard.py) -----------------

const DENIED_SHELL = [
  ['destructive rm -rf /', 'rm -rf /'],
  ['destructive rm -rf home', 'rm -rf ~'],
  ['destructive .git wipe', 'rm -rf .git'],
  ['destructive dd disk', 'dd if=/dev/zero of=/dev/sda'],
  ['destructive fork bomb', ':(){ :|:& };:'],
  ['destructive chmod system', 'chmod -R 777 /'],
  ['destructive DROP DATABASE', 'psql -c "DROP DATABASE prod"'],
  ['policy push to main', 'git push origin main'],
  ['policy delete main', 'git push origin --delete main'],
  ['policy self-merge PR', 'gh pr merge 42 --merge'],
  ['attribution co-author', 'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'],
]

for (const [label, command] of DENIED_SHELL) {
  test(`shell DENIED: ${label}`, () => {
    const r = decideDeny(ex('bash', { command }), cfg)
    assert.ok(r, `expected a denial for: ${command}`)
    assert.equal(typeof r, 'string')
  })
}

const ALLOWED_SHELL = [
  ['ordinary build', 'npm run build && npm test'],
  ['git normal', 'git commit -m "fix: real change" && git push origin XERK-470'],
  ['rm node_modules', 'rm -rf node_modules'],
]

for (const [label, command] of ALLOWED_SHELL) {
  test(`shell ALLOWED: ${label}`, () => {
    assert.equal(decideDeny(ex('bash', { command }), cfg), null, command)
  })
}

// --- ~/.claude write predicate (fileguard.py) ----------------------------

test('write to ~/.claude/settings.json is DENIED', () => {
  const r = decideDeny(ex('write', { path: `${HOME}/.claude/settings.json`, content: '{}' }), cfg)
  assert.ok(r)
})

test('write to ~/.claude hook script is DENIED', () => {
  const r = decideDeny(ex('str_replace_editor', { command: 'create', path: `${HOME}/.claude/hooks/evil.py`, file_text: 'x' }), cfg)
  assert.ok(r)
})

test('write to the subagent memory tree is ALLOWED (the fileguard carve-out)', () => {
  const r = decideDeny(ex('write', { path: `${HOME}/.claude/agent-memory/qa/notes.md`, content: 'x' }), cfg)
  assert.equal(r, null)
})

test('write inside the worktree is ALLOWED', () => {
  const r = decideDeny(ex('write', { path: path.join(CWD, 'src/app.js'), content: 'x' }), cfg)
  assert.equal(r, null)
})

// --- credential-store path denies (native globs) -------------------------

for (const p of [`${HOME}/.ssh/id_rsa`, `${HOME}/.aws/credentials`, `${HOME}/.kube/config`, `${HOME}/.git-credentials`, `${HOME}/.turma/guard-settings.json`, `${HOME}/.local/lib/python3.11/site-packages/usercustomize.py`]) {
  test(`write DENIED: ${p}`, () => {
    assert.ok(decideDeny(ex('write', { path: p, content: 'x' }), cfg), p)
  })
}

// Reads of credential STORES are not denied under Claude (its rules are Edit-only);
// mirror that exactly — fidelity over intuition.
test('read of ~/.ssh is ALLOWED (matches Claude: write-deny only)', () => {
  assert.equal(decideDeny(ex('read', { path: `${HOME}/.ssh/id_rsa` }), cfg), null)
})

test('read of the local-model gateway secret is DENIED', () => {
  assert.ok(decideDeny(ex('read', { path: `${HOME}/.turma/local-model.env` }), cfg))
})

// --- uploads / roster read carve-outs ------------------------------------

test('read of a staged upload is ALLOWED and pre-approved', () => {
  const p = `${HOME}/.turma/uploads/test-session/attachment.png`
  assert.equal(decideDeny(ex('read', { path: p }), cfg), null)
  assert.equal(isAllowedRead(ex('read', { path: p }), cfg), true)
})

test('read of the peer roster is pre-approved', () => {
  assert.equal(isAllowedRead(ex('read', { path: `${HOME}/.turma/peers.tsv` }), cfg), true)
})

test('a non-carve-out read is not pre-approved', () => {
  assert.equal(isAllowedRead(ex('read', { path: path.join(CWD, 'README.md') }), cfg), false)
})

// --- symlink escape does not dodge a rule --------------------------------

test('a symlink into a credential store still resolves to a DENIED write', () => {
  // Point at an existing sensitive dir so realpath resolves the symlink (a link
  // to a nonexistent target is unwritable anyway). ~/.aws exists on this host.
  const store = `${HOME}/.aws`
  if (!fs.existsSync(store)) return // environment without the store: nothing to prove
  const link = path.join(CWD, 'sneaky')
  try { fs.symlinkSync(store, link) } catch { return } // skip if unsupported
  const r = decideDeny(ex('write', { path: path.join(link, 'credentials'), content: 'x' }), cfg)
  assert.ok(r, 'symlinked write into a credential store must be denied')
})

// --- fail-closed on a broken hook ----------------------------------------

test('a missing guard script fails CLOSED (denies)', () => {
  const broken = compileConfig({ ...cfg, guardScript: path.join(HOOKS, 'does-not-exist.py'), denyWrite: [], denyRead: [], allowRead: [] })
  const r = decideDeny(ex('bash', { command: 'echo hi' }), broken)
  assert.ok(r, 'a shell call must be denied when the guard cannot run')
})

// --- glob matcher --------------------------------------------------------

test('globToRegExp: ** crosses / but * does not', () => {
  const g = _internals.globToRegExp
  assert.ok(g('/a/**').test('/a/b/c'))
  assert.ok(!g('/a/*').test('/a/b/c'))
  assert.ok(g('/a/*.json').test('/a/x.json'))
  assert.ok(!g('/a/*.json').test('/a/x.jsonl'))
  assert.ok(g('/a/python*/x/**').test('/a/python3.11/x/y/z'))
})
