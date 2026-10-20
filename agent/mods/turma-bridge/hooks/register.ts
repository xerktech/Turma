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
//    names the command to run.
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
  renaming: boolean
  lastRename: number
}

const NAME_MAX = 200
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
  if (w.renaming || w.turn !== 'idle') return
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
  const name = typeof req.name === 'string' ? req.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : ''
  if (req.v !== 1 || at <= 0 || at === w.lastRename) return
  w.renaming = true
  w.lastRename = at
  let ok = false
  let error: string | undefined
  if (!name || name.length > NAME_MAX) {
    error = 'unusable name'
  } else {
    try {
      await $.command.run({ command: 'rename', args: name })
      ok = true
    } catch (err) {
      error = String(err).slice(0, 300)
    }
  }
  try {
    await $.fs.write(`${dir}/rename.done.json`, JSON.stringify({ v: 1, at, name, ok, error }))
  } catch {
    // The agent sees no answer and keeps the request; nothing to retry here.
  }
  w.renaming = false
}

export const register: Register = on => {
  const w: Writer = { chain: Promise.resolve(), seq: 0, turn: 'idle', renaming: false, lastRename: 0 }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    publish($, w, 'idle', null)
    $.clock.every(POLL_MS, () => void pollRename($, w).catch(() => { w.renaming = false }))
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) publish($, w, 'running', e.turnId)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) publish($, w, 'idle', e.turnId)
    return result
  })
}
