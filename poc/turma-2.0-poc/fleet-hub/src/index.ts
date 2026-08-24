import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

app.use(express.json())

// Agent registry
interface AgentInfo {
  device: string
  ws: WebSocket
  sessions: SessionInfo[]
  lastHeartbeat: number
  /**
   * Per-process identity reported by the agent. A device name is reusable --
   * an abandoned agent reconnects under the same one -- so this is what tells
   * two processes claiming the same device apart.
   */
  instanceId?: string
}

interface SessionInfo {
  id: string
  status: 'running' | 'idle' | 'stopped'
  cwd?: string
  repo?: string
}

interface SessionEvent {
  sessionId: string
  type: string
  data: unknown
  time: number
}

const agents = new Map<string, AgentInfo>()
const dashboardClients = new Set<WebSocket>()

// Broadcast to all dashboard clients
function broadcastToDashboard(message: unknown) {
  const data = JSON.stringify(message)
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

// Get fleet state for dashboard
function getFleetState() {
  return {
    type: 'fleet-state',
    agents: [...agents.entries()].map(([id, info]) => ({
      device: info.device,
      sessions: info.sessions,
      online: Date.now() - info.lastHeartbeat < 30000,
      ...(info.instanceId === undefined ? {} : { instanceId: info.instanceId }),
    })),
  }
}

// WebSocket handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const clientType = url.searchParams.get('type')

  if (clientType === 'dashboard') {
    // Dashboard client
    dashboardClients.add(ws)
    ws.send(JSON.stringify(getFleetState()))

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleDashboardMessage(ws, msg)
      } catch (e) {
        console.error('Invalid dashboard message:', e)
      }
    })

    ws.on('close', () => {
      dashboardClients.delete(ws)
    })
  } else {
    // Agent client
    const device = url.searchParams.get('device')
    if (!device) {
      ws.close(4000, 'Missing device parameter')
      return
    }

    console.log(`Agent connected: ${device}`)
    agents.set(device, {
      device,
      ws,
      sessions: [],
      lastHeartbeat: Date.now(),
    })
    broadcastToDashboard(getFleetState())

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleAgentMessage(device, msg)
      } catch (e) {
        console.error('Invalid agent message:', e)
      }
    })

    ws.on('close', () => {
      console.log(`Agent disconnected: ${device}`)
      agents.delete(device)
      broadcastToDashboard(getFleetState())
    })
  }
})

// Handle messages from agents
function handleAgentMessage(device: string, msg: { type: string; [key: string]: unknown }) {
  const agent = agents.get(device)
  if (!agent) return

  switch (msg.type) {
    case 'heartbeat':
      agent.lastHeartbeat = Date.now()
      agent.sessions = (msg.sessions as SessionInfo[]) || []
      if (typeof msg.instanceId === 'string') agent.instanceId = msg.instanceId
      broadcastToDashboard(getFleetState())
      break

    case 'session-event':
      // Forward session events to dashboard
      broadcastToDashboard({
        type: 'session-event',
        device,
        event: msg.event as SessionEvent,
      })
      break

    case 'command-result':
      // Forward command results to dashboard
      broadcastToDashboard({
        type: 'command-result',
        device,
        cmdId: msg.cmdId,
        result: msg.result,
        error: msg.error,
      })
      break

    case 'session-created':
      // Forward session creation to dashboard
      broadcastToDashboard({
        type: 'session-created',
        device,
        session: msg.session,
      })
      // Trigger a state refresh for any waiting dashboards
      broadcastToDashboard(getFleetState())
      break
  }
}

// Handle messages from dashboard
function handleDashboardMessage(ws: WebSocket, msg: { type: string; [key: string]: unknown }) {
  switch (msg.type) {
    case 'spawn': {
      const { device, repo, prompt } = msg as { device: string; repo?: string; prompt?: string }
      const agent = agents.get(device)
      if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `Agent ${device} not available` }))
        return
      }
      const cmdId = crypto.randomUUID()
      agent.ws.send(JSON.stringify({ type: 'spawn', cmdId, repo, prompt }))
      ws.send(JSON.stringify({ type: 'command-sent', cmdId }))
      break
    }

    case 'input': {
      const { device, sessionId, message } = msg as { device: string; sessionId: string; message: string }
      const agent = agents.get(device)
      if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `Agent ${device} not available` }))
        return
      }
      agent.ws.send(JSON.stringify({ type: 'input', sessionId, message }))
      break
    }

    case 'kill': {
      const { device, sessionId } = msg as { device: string; sessionId: string }
      const agent = agents.get(device)
      if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `Agent ${device} not available` }))
        return
      }
      agent.ws.send(JSON.stringify({ type: 'kill', sessionId }))
      break
    }

    case 'get-state':
      ws.send(JSON.stringify(getFleetState()))
      break
  }
}

// REST API endpoints
app.get('/api/agents', (req, res) => {
  const state = getFleetState()
  res.json(state.agents)
})

app.post('/api/agents/:device/sessions', (req, res) => {
  const { device } = req.params
  const { repo, prompt } = req.body
  const agent = agents.get(device)
  if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
    res.status(503).json({ error: `Agent ${device} not available` })
    return
  }
  const cmdId = crypto.randomUUID()
  agent.ws.send(JSON.stringify({ type: 'spawn', cmdId, repo, prompt }))
  res.json({ cmdId })
})

// Serve dashboard HTML
app.get('/', (req, res) => {
  res.send(dashboardHtml)
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Fleet Hub running at http://localhost:${PORT}`)
  console.log(`Dashboard: http://localhost:${PORT}`)
  console.log(`WebSocket: ws://localhost:${PORT}/ws`)
})

// Simple dashboard HTML
const dashboardHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Turma 2.0 Fleet Dashboard (PoC)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
    h1 { margin-bottom: 20px; color: #00d4ff; }
    .agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 20px; }
    .agent { background: #16213e; border-radius: 8px; padding: 16px; }
    .agent.offline { opacity: 0.5; }
    .agent-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .agent-name { font-size: 1.2em; font-weight: bold; }
    .status { padding: 4px 8px; border-radius: 4px; font-size: 0.8em; }
    .status.online { background: #0f3; color: #000; }
    .status.offline { background: #f33; color: #fff; }
    .sessions { margin-top: 12px; }
    .session { background: #0f3b5c; padding: 8px 12px; border-radius: 4px; margin-bottom: 8px; }
    .session-id { font-family: monospace; font-size: 0.9em; }
    .session-status { font-size: 0.8em; color: #aaa; }
    .controls { margin-top: 12px; display: flex; gap: 8px; }
    button { background: #00d4ff; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #00a8cc; }
    .events { margin-top: 20px; background: #16213e; border-radius: 8px; padding: 16px; max-height: 300px; overflow-y: auto; }
    .event { font-family: monospace; font-size: 0.85em; padding: 4px 0; border-bottom: 1px solid #333; }
    .event-time { color: #888; }
    .event-type { color: #00d4ff; }
    .no-agents { text-align: center; padding: 40px; color: #888; }
  </style>
</head>
<body>
  <h1>Turma 2.0 Fleet Dashboard (PoC)</h1>

  <div id="agents" class="agents">
    <div class="no-agents">Waiting for agents to connect...</div>
  </div>

  <div class="events">
    <h3>Events</h3>
    <div id="event-log"></div>
  </div>

  <script>
    const ws = new WebSocket(\`ws://\${location.host}/ws?type=dashboard\`)
    let state = { agents: [] }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'fleet-state') {
        state = msg
        render()
      } else if (msg.type === 'session-event') {
        logEvent(msg)
      } else if (msg.type === 'command-result') {
        logEvent({ type: 'command-result', ...msg })
      }
    }

    ws.onclose = () => {
      document.getElementById('agents').innerHTML = '<div class="no-agents">Disconnected from hub</div>'
    }

    function render() {
      const container = document.getElementById('agents')
      if (state.agents.length === 0) {
        container.innerHTML = '<div class="no-agents">Waiting for agents to connect...</div>'
        return
      }

      container.innerHTML = state.agents.map(agent => \`
        <div class="agent \${agent.online ? '' : 'offline'}">
          <div class="agent-header">
            <span class="agent-name">\${agent.device}</span>
            <span class="status \${agent.online ? 'online' : 'offline'}">\${agent.online ? 'Online' : 'Offline'}</span>
          </div>
          <div class="sessions">
            <strong>Sessions (\${agent.sessions.length}):</strong>
            \${agent.sessions.length === 0 ? '<p style="color:#888">No active sessions</p>' :
              agent.sessions.map(s => \`
                <div class="session">
                  <div class="session-id">\${s.id.slice(0,8)}...</div>
                  <div class="session-status">\${s.status} | \${s.cwd || 'no cwd'}</div>
                </div>
              \`).join('')}
          </div>
          <div class="controls">
            <button onclick="spawnSession('\${agent.device}')">Spawn Session</button>
          </div>
        </div>
      \`).join('')
    }

    function spawnSession(device) {
      const prompt = window.prompt('Enter initial prompt (optional):')
      ws.send(JSON.stringify({ type: 'spawn', device, prompt }))
    }

    function logEvent(msg) {
      const log = document.getElementById('event-log')
      const time = new Date().toLocaleTimeString()
      const div = document.createElement('div')
      div.className = 'event'
      div.innerHTML = \`<span class="event-time">\${time}</span> <span class="event-type">\${msg.type}</span> \${msg.device || ''} \${JSON.stringify(msg.event || msg.result || '').slice(0,100)}\`
      log.insertBefore(div, log.firstChild)
      if (log.children.length > 50) log.lastChild.remove()
    }

    render()
  </script>
</body>
</html>`
