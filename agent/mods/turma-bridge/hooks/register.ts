import type { Register, EngineInterface } from 'claude-code'

// Turma's bridge mod (XERK-2131). The agent launches every Claude session with
// `--plugin-dir <this folder>`, `TURMA_TURN_STATE=<file>` and
// `TURMA_MOD_REQUESTS=<dir>`.
//
// 1. It keeps TURMA_TURN_STATE saying whether the session's OWN turn (the main
//    loop, never a subagent's) is running. The agent reads it on the beat as an
//    extra paneBusy source, so a pane scrape that missed the "esc to interrupt"
//    hint (a redraw gap, a failed capture) no longer reads a working session idle.
// 2. It runs the agent's `rename.json` request as `/rename <name>` through the
//    engine, then answers in `rename.done.json`. Only while the main turn is
//    IDLE: Claude Code then runs it at once, so it never waits in the queue,
//    where an Esc drops it and Turma's chat would show it as a queued operator
//    prompt (QA, 2.1.304). Rename only: the file is session-writable, so it never
//    names the command to run. After an interrupted turn Claude Code refuses a
//    plugin command until the person sends input, so the mod waits for the next
//    turn rather than answering. A name the agent should have cleaned (control
//    characters, padding, over NAME_MAX) is refused, never rewritten, so the
//    name the agent records is the name the session ends up with.
//
// 3. It serves `/turma` (peers | status | wake <dur> <why>), run on demand:
//    the roster the agent writes (TURMA_PEERS_FILE), the session's status the
//    agent writes beside its requests (`status.json`), and a wake through the
//    session CLI (TURMA_SESSION_CLI), which validates it.
//
// It draws nothing: a band or status entry would change the pane the agent's
// parsers read. Writes are chained so they land in event order, and never
// awaited by a hook, so a slow disk cannot hold a turn.

type Turn = 'idle' | 'running'

// One per module load: the write chain and the order stamp it hands out, and the
// rename poller's state.
type Writer = {
  chain: Promise<unknown>
  seq: number
  turn: Turn
  stopped: boolean
  renaming: boolean
  lastRename: number
}

const NAME_MAX = 200
// What Claude Code's /rename rewrites (each run to one space, measured on
// 2.1.304): Unicode Cc and Cf, and U+2028/9. Same rule as hub-agent.py's
// mod_rename_name, which cleans the name before asking.
const NAME_UNCLEAN = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const POLL_MS = 2000

function publish($: EngineInterface, w: Writer, turn: Turn, turnId: string | null) {
  const seq = ++w.seq
  const at = Date.now()
  w.turn = turn
  w.chain = w.chain
    .then(async () => {
      const path = await $.env.get('TURMA_TURN_STATE')
      if (!path) return
      const claudeSessionId = await $.session.id()
      await $.fs.write(path, JSON.stringify({ v: 1, claudeSessionId, turn, turnId, seq, at }))
    })
    .catch(() => undefined)
}

async function pollRename($: EngineInterface, w: Writer) {
  if (w.renaming || w.turn !== 'idle' || w.stopped) return
  const dir = await $.env.get('TURMA_MOD_REQUESTS')
  if (!dir) return
  let raw: string
  try {
    raw = await $.fs.read(`${dir}/rename.json`)
  } catch {
    return
  }
  let req: { v?: unknown; name?: unknown; at?: unknown }
  try {
    req = JSON.parse(raw)
  } catch {
    return
  }
  const at = typeof req.at === 'number' ? req.at : 0
  const name = typeof req.name === 'string' ? req.name : ''
  if (req.v !== 1 || at <= 0 || at === w.lastRename) return
  // The reads above awaited: a turn may have started meanwhile.
  if (w.turn !== 'idle' || w.stopped) return
  w.renaming = true
  w.lastRename = at
  let ok = false
  let error: string | undefined
  if (!name || name.length > NAME_MAX || name !== name.trim() || NAME_UNCLEAN.test(name)) {
    error = 'unusable name'
  } else {
    try {
      await $.command.run({ command: 'rename', args: name })
      ok = true
    } catch (err) {
      error = String(err).slice(0, 300)
      if (/stopped/.test(error)) {
        // Refused until the person sends input: not an answer, try after.
        w.stopped = true
        w.lastRename = 0
        w.renaming = false
        return
      }
    }
  }
  try {
    await $.fs.write(`${dir}/rename.done.json`, JSON.stringify({ v: 1, at, name, ok, error }))
  } catch {
    // The agent sees no answer and keeps the request; nothing to retry here.
  }
  w.renaming = false
}

const CELL_MAX = 80
const OUT_MAX = 4000

const HELP = [
  'Turma (bridge mod):',
  '  /turma peers                  sessions you can message, from the roster',
  '  /turma status                 this session: ticket, branch, PRs, pending wake',
  '  /turma wake <30m|2h> <why>    re-prompt this session later',
].join('\n')

const PEER_ROWS_MAX = 40

// Text from files sessions (or a tracker) can write, about to be printed into the
// conversation: one line, capped, and unable to pose as structure. Claude Code
// hands a command's output to the model unescaped inside <local-command-stdout>,
// so a cell holding that closing tag ended the wrapper and its tail read as
// instructions the operator never saw (QA, 2.1.304): angle brackets become
// look-alikes. The pane's busy marker is broken up too, or a peer's text on
// screen would read an idle session busy. A non-string is no text.
function cell(v: unknown): string {
  const t = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  const flat = t
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/esc to interrupt/gi, 'esc-to-interrupt')
    .trim()
  return flat.length > CELL_MAX ? `${flat.slice(0, CELL_MAX - 1)}…` : flat
}

async function peersText($: EngineInterface): Promise<string> {
  const path = await $.env.get('TURMA_PEERS_FILE')
  if (!path) return 'No roster: this session was not launched by Turma.'
  let raw: string
  try {
    raw = await $.fs.read(path)
  } catch {
    return 'The roster is missing; Turma rewrites it every heartbeat.'
  }
  const me = await $.env.get('TURMA_SESSION_ID')
  const host = await $.env.get('TURMA_DEVICE')
  const rows = raw.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t'))
  if (!rows.length) return 'No other sessions in your organisation right now.'
  // Ids are unique per host only: "you" is the row matching both.
  const mine = (r: string[]) => r[0] === me && r[2] === host
  const ordered = [...rows.filter(mine), ...rows.filter(r => !mine(r))]
  const lines = ordered.slice(0, PEER_ROWS_MAX).map(r => {
    const [, name, h, repo, branch, task] = r
    const mark = mine(r) ? ' (you)' : ''
    const where = [cell(h), cell(repo)].filter(Boolean).join('/')
    const br = cell(branch) ? ` [${cell(branch)}]` : ''
    const what = cell(task) ? ` — ${cell(task)}` : ''
    return `  ${cell(name)}${mark}  ${where}${br}${what}`
  })
  if (ordered.length > PEER_ROWS_MAX) lines.push(`  …and ${ordered.length - PEER_ROWS_MAX} more in ${path}`)
  return [`${rows.length} session(s); message one by its name with SendMessage:`, ...lines].join('\n')
}

type Pr = { url?: unknown; number?: unknown; title?: unknown; state?: unknown; checks?: unknown; ready?: unknown }
type Status = {
  v?: unknown; id?: unknown; name?: unknown; summary?: unknown; branch?: unknown
  ticket?: { key?: unknown; url?: unknown; summary?: unknown } | null
  prs?: Pr[] | null; wakeAt?: unknown; wakeReason?: unknown
}

async function statusText($: EngineInterface): Promise<string> {
  const dir = await $.env.get('TURMA_MOD_REQUESTS')
  if (!dir) return 'No status: this session was not launched by Turma.'
  let st: Status
  try {
    st = JSON.parse(await $.fs.read(`${dir}/status.json`))
  } catch {
    return 'No status yet; Turma writes it on its next heartbeat.'
  }
  if (st.v !== 1) return 'The status file is not one this mod reads.'
  const out = [`Session ${cell(st.id)}: ${cell(st.name)}`]
  if (cell(st.summary)) out.push(`  task:    ${cell(st.summary)}`)
  if (st.ticket && cell(st.ticket.key)) {
    out.push(`  ticket:  ${cell(st.ticket.key)} ${cell(st.ticket.summary)}`.trimEnd())
  }
  out.push(`  branch:  ${cell(st.branch) || '(detached)'}`)
  const prs = Array.isArray(st.prs) ? st.prs.filter(p => p && typeof p === 'object').slice(0, 10) : []
  if (!prs.length) out.push('  PRs:     none')
  for (const pr of prs) {
    // Readiness means something only while the PR is open.
    const open = cell(pr.state).toUpperCase() === 'OPEN' || cell(pr.state).toLowerCase() === 'opened'
    const ready = !open ? '' : pr.ready === 'ready' ? 'ready to merge' : cell(pr.ready)
    const bits = [cell(pr.state), cell(pr.checks) && `CI ${cell(pr.checks)}`, ready].filter(Boolean)
    out.push(`  PR:      ${cell(pr.url)}${bits.length ? ` (${bits.join(', ')})` : ''}`)
  }
  if (typeof st.wakeAt === 'number' && st.wakeAt > 0 && st.wakeAt < 8.64e15) {
    out.push(`  wake:    ${new Date(st.wakeAt).toISOString()} ${cell(st.wakeReason)}`.trimEnd())
  }
  return out.join('\n')
}

async function wakeText($: EngineInterface, args: string[]): Promise<string> {
  const cli = await $.env.get('TURMA_SESSION_CLI')
  if (!cli) return 'No session CLI: this session was not launched by Turma.'
  if (args.length < 2) return 'Usage: /turma wake <30m|2h|1h30m> <what to check>'
  try {
    // `--`: a reason word starting with `-` is text, never an option.
    const r = await $.process.run(['python3', '-SsE', cli, 'wake', '--', ...args], { timeoutMs: 10000 })
    const said = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout) || `exit ${r.exitCode}`
    const last = said.trim().split('\n').pop() || ''
    return cell(last) || `exit ${r.exitCode}`
  } catch (err) {
    return `Wake not set: ${cell(String(err))}`
  }
}

async function turmaText($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] || '').toLowerCase()
  let text: string
  try {
    if (sub === 'peers') text = await peersText($)
    else if (sub === 'status') text = await statusText($)
    else if (sub === 'wake') text = await wakeText($, words.slice(1))
    else text = HELP
  } catch (err) {
    text = `/turma ${cell(sub)} failed: ${cell(String(err))}`
  }
  return text.length > OUT_MAX ? `${text.slice(0, OUT_MAX - 1)}…` : text
}

export const register: Register = on => {
  const w: Writer = {
    chain: Promise.resolve(), seq: 0, turn: 'idle', stopped: false, renaming: false, lastRename: 0,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    publish($, w, 'idle', null)
    $.clock.every(POLL_MS, () => void pollRename($, w).catch(() => { w.renaming = false }))
    void $.command
      .register({
        name: 'turma',
        description: 'Turma: peers you can message, this session status, wake later',
        argumentHint: 'peers | status | wake <dur> <why>',
        immediate: true,
      })
      .catch(() => undefined)
    return result
  })

  on('command.run', { command: 'turma' }, async ($, e) => ({ text: await turmaText($, e.args) }))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      w.stopped = false
      publish($, w, 'running', e.turnId)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      if (e.isAborted) w.stopped = true
      publish($, w, 'idle', e.turnId)
    }
    return result
  })
}
