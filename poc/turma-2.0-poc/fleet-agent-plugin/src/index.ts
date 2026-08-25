/**
 * @turma/dsh-fleet-agent
 *
 * Real dsh plugin that connects a dsh instance to the Turma Fleet Hub.
 * Streams session events to the hub and handles commands (spawn, input, kill).
 */

import { WebSocket } from 'ws'

// Cordis Context types (from @deepseek-ai/cordis)
interface Context {
  sessions: SessionStore
  agents: AgentRegistry
  on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): () => void
  effect(fn: () => (() => void) | void, name?: string): void
  logger: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}

interface SessionStore {
  list(): Session[]
  get(id: string): Session | undefined
  create(id?: string, options?: CreateSessionOptions): Session
}

interface CreateSessionOptions {
  seed?: SessionEvent[]
  meta?: SessionMeta
}

interface SessionMeta {
  cwd?: string
  createdAt?: number
  parentSession?: string
  origin?: { type: string; host?: string }
}

interface Session {
  id: string
  header: SessionHeader
  events: SessionEvent[]
  append(type: string, data: unknown): SessionEvent
}

interface SessionHeader {
  id: string
  cwd?: string
  createdAt: number
  parentSession?: string
  origin?: { type: string; host?: string }
}

interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

// Real dsh @deepseek-ai/dsh-agent surface (0.1.1-rc.2). These mirror the
// package's own .d.ts: `create()` mints a NEW agent on a caller-supplied
// session id and returns a disposable HANDLE; `resume()` reloads a PERSISTED
// session and is not how a fresh session is born; `get()` returns a bare live
// agent. The PoC first drove these against mock workers only, and the guessed
// shapes it carried (a `resume({cwd, prompt})` create, an arg-less `cancel()`,
// an `inbox.append` that never wakes the driver) do not exist on real dsh.
interface AgentRegistry {
  get(id: string): Agent | undefined
  create(options: CreateAgentOptions): Promise<AgentHandle>
}

interface CreateAgentOptions {
  sessionId: string
  meta?: { cwd?: string }
  agentOptions?: AgentOptions
}

interface AgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

// `dispose()` is the true "kill": it stops the loop, unregisters the agent,
// and removes its session. `agent.cancel()` only aborts the active turn.
interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

interface Agent {
  id: string
  session: Session
  status: 'running' | 'idle'
  // Queue an ordinary follow-up turn and WAKE the driver, so the message is
  // actually processed. `inbox.append` alone enqueues without waking.
  followup(message: UserMessage): void
  cancel(cause: AgentCancelCause): void
}

type AgentCancelCause =
  | { kind: 'user' }
  | { kind: 'parent' }
  | { kind: 'hook'; reason: string }
  | { kind: 'disposed' }

interface UserMessage {
  id: string
  role: 'user'
  source: { kind: string; clientId?: string; plugin?: string }
  content: Array<{ type: 'text'; text: string }>
}

// Plugin configuration
export interface Config {
  hubUrl: string
  device: string
  /**
   * Opaque per-process identity, echoed back by the hub on /api/agents.
   * A device NAME cannot prove which process is connected -- an abandoned
   * instance reconnects under the same name -- so a harness that needs to
   * assert "the dsh I just started is the one registered" matches on this.
   *
   * Prefer the TURMA_FLEET_INSTANCE_ID environment variable (read below).
   * Setting it HERE is unsafe for that purpose: this file is a dsh config,
   * dsh hot-reloads config, and every dsh sharing the DSH_HOME reads the same
   * one -- so an abandoned instance adopts whatever id is written here and
   * reports it as its own. An environment variable is fixed per process at
   * exec time and cannot be adopted by an already-running one.
   */
  instanceId?: string
  /**
   * Provider route and model a spawned session's agent uses, passed straight to
   * `ctx.agents.create({ agentOptions })`. Omitted, dsh falls back to whatever
   * `agent-default-model` the profile configures. dsh has no Claude-style
   * failover (XERK-462 D5): this selector is the whole model story for the
   * session, and the provider route must be registered (e.g. a `dsh-llm-pi-ai`
   * profile pointing at DeepSeek or an OpenAI-compatible LiteLLM/Ollama gateway).
   */
  provider?: string
  model?: string
}

// Build a well-formed dsh UserMessage. dsh's own `createUserMessage` freezes
// and mints a branded id, but the loose literal here carries the same fields
// the inbox durably logs and the model request reads: a plain uuid id, the
// `user` source kind, and one text block.
function userMessage(text: string): UserMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

// Plugin metadata
export const name = 'turma-fleet-agent'
export const inject = ['sessions', 'agents']

// Plugin entry point
export function apply(ctx: Context, config: Config) {
  // Env wins over config: it is per-process, so a second dsh sharing this
  // DSH_HOME cannot pick it up on a config hot-reload. See Config.instanceId.
  const instanceId = process.env.TURMA_FLEET_INSTANCE_ID || config.instanceId

  let ws: WebSocket | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  const pendingCommands = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  // Live agent handles keyed by session id. `ctx.agents.get()` returns a bare
  // agent with no disposer, so a spawned session's handle is kept here to make
  // `kill` a real teardown (stop loop + unregister + remove session) rather
  // than a turn cancel.
  const handles = new Map<string, AgentHandle>()

  function connect() {
    const url = `${config.hubUrl}?device=${encodeURIComponent(config.device)}`
    ctx.logger.info(`[fleet] Connecting to hub: ${url}`)

    ws = new WebSocket(url)

    ws.on('open', () => {
      ctx.logger.info(`[fleet] Connected to hub as ${config.device}`)
      startHeartbeat()
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleHubMessage(msg)
      } catch (e) {
        ctx.logger.error(`[fleet] Invalid message from hub: ${e}`)
      }
    })

    ws.on('close', () => {
      ctx.logger.info('[fleet] Disconnected from hub, reconnecting in 5s...')
      stopHeartbeat()
      scheduleReconnect()
    })

    ws.on('error', (err) => {
      ctx.logger.error(`[fleet] WebSocket error: ${err.message}`)
    })
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, 5000)
  }

  function startHeartbeat() {
    if (heartbeatTimer) return
    sendHeartbeat()
    heartbeatTimer = setInterval(sendHeartbeat, 15000)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function sendHeartbeat() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const sessions = ctx.sessions.list().map((s) => ({
      id: s.id,
      status: getSessionStatus(s),
      cwd: s.header.cwd,
      eventCount: s.events.length,
    }))

    ws.send(JSON.stringify({
      type: 'heartbeat',
      sessions,
      instanceId,
    }))
  }

  function getSessionStatus(session: Session): string {
    const agent = ctx.agents.get(session.id)
    return agent?.status || 'idle'
  }

  function handleHubMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case 'spawn':
        handleSpawn(msg as { type: string; cmdId: string; cwd?: string; prompt?: string })
        break
      case 'input':
        handleInput(msg as { type: string; sessionId: string; message: string })
        break
      case 'kill':
        handleKill(msg as { type: string; sessionId: string })
        break
      default:
        ctx.logger.info(`[fleet] Unknown message type: ${msg.type}`)
    }
  }

  async function handleSpawn(msg: { cmdId: string; cwd?: string; prompt?: string }) {
    ctx.logger.info(`[fleet] Spawn request: ${msg.cmdId}`)
    try {
      // Mint the session id ourselves -- create() is identity-in, so the id is
      // known before the agent exists (the same discipline the real hub uses to
      // name a session's transcript before its first byte).
      const sessionId = crypto.randomUUID()
      const agentOptions =
        config.provider || config.model
          ? { provider: config.provider, model: config.model }
          : undefined
      // A dsh session's meta.cwd must be a validated absolute path; fall back
      // to this process's cwd when the hub sends none (its `spawn` carries
      // `repo`, not `cwd`), so create() always has a real working directory.
      const cwd = msg.cwd || process.cwd()
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions,
      })
      handles.set(handle.agent.id, handle)
      // An initial prompt is delivered like any other input: a follow-up turn
      // that wakes the driver. create() alone leaves the agent idle.
      if (msg.prompt) handle.agent.followup(userMessage(msg.prompt))
      sendCommandResult(msg.cmdId, { sessionId: handle.agent.id })
      // Reflect the new session in the hub's state now, not on the next 15s beat.
      sendHeartbeat()
    } catch (e) {
      ctx.logger.error(`[fleet] Spawn failed: ${e}`)
      sendCommandResult(msg.cmdId, null, String(e))
    }
  }

  function handleInput(msg: { sessionId: string; message: string }) {
    const agent = ctx.agents.get(msg.sessionId)
    if (!agent) {
      ctx.logger.warn(`[fleet] Session not found for input: ${msg.sessionId}`)
      return
    }
    // followup queues the message as its own turn AND wakes the driver, so the
    // model actually processes it. `inbox.append` would enqueue without waking.
    agent.followup(userMessage(msg.message))
  }

  async function handleKill(msg: { sessionId: string }) {
    const handle = handles.get(msg.sessionId)
    if (handle) {
      // The capability disposer: stop the loop, unregister, remove the session.
      handles.delete(msg.sessionId)
      await handle.dispose()
      // Reflect the teardown immediately rather than on the next 15s beat.
      sendHeartbeat()
      return
    }
    // No handle (e.g. a session created outside this plugin): fall back to
    // cancelling the active turn, the strongest teardown a bare agent allows.
    const agent = ctx.agents.get(msg.sessionId)
    if (!agent) {
      ctx.logger.warn(`[fleet] Session not found for kill: ${msg.sessionId}`)
      return
    }
    agent.cancel({ kind: 'disposed' })
  }

  function sendCommandResult(cmdId: string, result: unknown, error?: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'command-result',
      cmdId,
      result,
      error,
    }))
  }

  function sendSessionEvent(sessionId: string, event: SessionEvent) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'session-event',
      event: {
        sessionId,
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: event.data,
      },
    }))
  }

  // Forward session events to hub
  ctx.on('session/event', (...args: unknown[]) => {
    const session = args[0] as Session
    const event = args[1] as SessionEvent
    sendSessionEvent(session.id, event)
  }, { global: true })

  // Announce new sessions
  ctx.on('session/created', (...args: unknown[]) => {
    const session = args[0] as Session
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'session-created',
      session: {
        id: session.id,
        cwd: session.header.cwd,
        createdAt: session.header.createdAt,
      },
    }))
  }, { global: true })

  // Connect on plugin load
  connect()

  // Cleanup on plugin unload
  ctx.effect(() => () => {
    ctx.logger.info('[fleet] Plugin unloading, disconnecting...')
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopHeartbeat()
    if (ws) {
      ws.close()
      ws = null
    }
  }, 'fleet-agent.cleanup')
}
