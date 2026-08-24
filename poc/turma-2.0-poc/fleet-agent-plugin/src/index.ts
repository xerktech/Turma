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

interface AgentRegistry {
  get(id: string): Agent | undefined
  resume(options: ResumeOptions): Promise<{ agent: Agent }>
}

interface ResumeOptions {
  resumeSessionId?: string
  cwd?: string
  prompt?: string
  agentOptions?: AgentOptions
}

interface AgentOptions {
  instructions?: string
}

interface Agent {
  id: string
  session: Session
  status: 'running' | 'idle'
  inbox: {
    append(target: 'next-turn' | 'next-step', message: UserMessage): void
  }
  cancel(): Promise<void>
}

interface UserMessage {
  id: string
  role: 'user'
  source: { kind: string; clientId?: string }
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
      // Create or resume an agent
      const result = await ctx.agents.resume({
        cwd: msg.cwd,
        prompt: msg.prompt,
      })
      sendCommandResult(msg.cmdId, { sessionId: result.agent.id })
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

    // Queue user message to the agent's inbox
    const userMessage: UserMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'fleet', clientId: config.device },
      content: [{ type: 'text', text: msg.message }],
    }
    agent.inbox.append('next-turn', userMessage)
  }

  async function handleKill(msg: { sessionId: string }) {
    const agent = ctx.agents.get(msg.sessionId)
    if (!agent) {
      ctx.logger.warn(`[fleet] Session not found for kill: ${msg.sessionId}`)
      return
    }
    await agent.cancel()
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
