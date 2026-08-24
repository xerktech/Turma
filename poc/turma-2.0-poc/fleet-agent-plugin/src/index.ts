/**
 * @turma/dsh-fleet-agent-poc
 *
 * PoC plugin that connects a dsh instance to the Turma Fleet Hub.
 * Demonstrates multi-host coordination via WebSocket.
 */

import { WebSocket } from 'ws'

// Cordis types (simplified for PoC)
interface Context {
  sessions: {
    list(): Session[]
  }
  agents: {
    create(opts: CreateAgentOpts): Promise<AgentHandle>
    get(id: string): Agent | undefined
  }
  on(event: string, handler: (...args: unknown[]) => void): () => void
  effect(fn: () => (() => void) | void): void
}

interface Session {
  id: string
  header: { cwd?: string }
}

interface Agent {
  id: string
  session: Session
  status: 'running' | 'idle'
  followup(message: UserMessage): void
  cancel(): void
}

interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

interface CreateAgentOpts {
  cwd?: string
  prompt?: string
}

interface UserMessage {
  content: string
}

// Plugin configuration
export interface Config {
  hubUrl: string
  device: string
}

// Plugin metadata
export const name = 'turma-fleet-agent-poc'
export const inject = ['sessions', 'agents']

// Plugin entry point
export function apply(ctx: Context, config: Config) {
  let ws: WebSocket | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null

  function connect() {
    const url = `${config.hubUrl}?device=${encodeURIComponent(config.device)}`
    console.log(`[fleet] Connecting to hub: ${url}`)

    ws = new WebSocket(url)

    ws.on('open', () => {
      console.log(`[fleet] Connected to hub as ${config.device}`)
      startHeartbeat()
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleHubMessage(msg)
      } catch (e) {
        console.error('[fleet] Invalid message from hub:', e)
      }
    })

    ws.on('close', () => {
      console.log('[fleet] Disconnected from hub, reconnecting in 5s...')
      stopHeartbeat()
      scheduleReconnect()
    })

    ws.on('error', (err) => {
      console.error('[fleet] WebSocket error:', err.message)
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
    }))

    ws.send(JSON.stringify({
      type: 'heartbeat',
      sessions,
    }))
  }

  function getSessionStatus(session: Session): string {
    const agent = ctx.agents.get(session.id)
    return agent?.status || 'idle'
  }

  function handleHubMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case 'spawn':
        handleSpawn(msg as { type: string; cmdId: string; repo?: string; prompt?: string })
        break
      case 'input':
        handleInput(msg as { type: string; sessionId: string; message: string })
        break
      case 'kill':
        handleKill(msg as { type: string; sessionId: string })
        break
      default:
        console.log(`[fleet] Unknown message type: ${msg.type}`)
    }
  }

  async function handleSpawn(msg: { cmdId: string; repo?: string; prompt?: string }) {
    console.log(`[fleet] Spawn request: ${msg.cmdId}`)
    try {
      const handle = await ctx.agents.create({
        cwd: msg.repo,
        prompt: msg.prompt,
      })
      sendCommandResult(msg.cmdId, { sessionId: handle.agent.id })
    } catch (e) {
      sendCommandResult(msg.cmdId, null, String(e))
    }
  }

  function handleInput(msg: { sessionId: string; message: string }) {
    const agent = ctx.agents.get(msg.sessionId)
    if (!agent) {
      console.log(`[fleet] Session not found: ${msg.sessionId}`)
      return
    }
    agent.followup({ content: msg.message })
  }

  function handleKill(msg: { sessionId: string }) {
    const agent = ctx.agents.get(msg.sessionId)
    if (!agent) {
      console.log(`[fleet] Session not found: ${msg.sessionId}`)
      return
    }
    agent.cancel()
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

  // Forward session events to hub
  ctx.on('session/event', (session: Session, event: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'session-event',
      event: {
        sessionId: session.id,
        ...(event as object),
      },
    }))
  })

  // Connect on plugin load
  connect()

  // Cleanup on plugin unload
  ctx.effect(() => () => {
    console.log('[fleet] Plugin unloading, disconnecting...')
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopHeartbeat()
    if (ws) {
      ws.close()
      ws = null
    }
  })
}
