import type { Register, EngineInterface } from 'claude-code'

// Turma's bridge mod (XERK-2131). The agent launches every Claude session with
// `--plugin-dir <this folder>` and `TURMA_TURN_STATE=<file>`; this module keeps
// that file saying whether the session's OWN turn (the main loop, never a
// subagent's) is running. The agent reads it on the beat as an extra paneBusy
// source, so a pane scrape that missed the "esc to interrupt" hint (a redraw
// gap, a failed capture) no longer reads a working session idle.
//
// It draws nothing: a band or status entry would change the pane the agent's
// parsers read. Writes are chained so they land in event order, and never
// awaited by a hook, so a slow disk cannot hold a turn.

type Turn = 'idle' | 'running'

// One per module load: the write chain and the order stamp it hands out.
type Writer = { chain: Promise<unknown>; seq: number }

function publish($: EngineInterface, w: Writer, turn: Turn, turnId: string | null) {
  const seq = ++w.seq
  const at = Date.now()
  w.chain = w.chain
    .then(async () => {
      const path = await $.env.get('TURMA_TURN_STATE')
      if (!path) return
      const claudeSessionId = await $.session.id()
      await $.fs.write(path, JSON.stringify({ v: 1, claudeSessionId, turn, turnId, seq, at }))
    })
    .catch(() => undefined)
}

export const register: Register = on => {
  const w: Writer = { chain: Promise.resolve(), seq: 0 }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    publish($, w, 'idle', null)
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
