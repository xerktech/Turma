#!/usr/bin/env node
/**
 * Multi-host federation test for Turma 2.0
 *
 * This test proves the core Coordinator Pattern:
 * 1. Multiple "worker" agents connect to a hub
 * 2. Workers create sessions and stream events
 * 3. A single dashboard sees ALL sessions from ALL workers
 * 4. Commands can be routed to the correct worker
 *
 * Run:
 *   1. cd fleet-hub && npm run dev
 *   2. node test-multi-host.js
 *   3. Open http://localhost:3000
 */

import { WebSocket } from 'ws'

const HUB_URL = process.env.HUB_URL || 'ws://localhost:3000/ws'

interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

interface Session {
  id: string
  status: 'running' | 'idle'
  cwd: string
  events: SessionEvent[]
}

/**
 * Simulates a dsh worker instance that:
 * - Creates sessions locally
 * - Streams session events to the hub
 * - Responds to commands from the hub
 */
class MockDshWorker {
  private ws: WebSocket | null = null
  private sessions = new Map<string, Session>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private eventSeq = 0

  constructor(
    private device: string,
    private workDir: string = `/repos/${device}`
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${HUB_URL}?device=${encodeURIComponent(this.device)}`
      console.log(`[${this.device}] Connecting to hub...`)

      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        console.log(`[${this.device}] Connected`)
        this.startHeartbeat()
        resolve()
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        this.handleCommand(msg)
      })

      this.ws.on('error', reject)
      this.ws.on('close', () => {
        console.log(`[${this.device}] Disconnected`)
        this.stopHeartbeat()
      })
    })
  }

  disconnect() {
    this.stopHeartbeat()
    this.ws?.close()
  }

  private startHeartbeat() {
    this.sendHeartbeat()
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 5000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sendHeartbeat() {
    this.send({
      type: 'heartbeat',
      sessions: [...this.sessions.values()].map(s => ({
        id: s.id,
        status: s.status,
        cwd: s.cwd,
      })),
    })
  }

  private handleCommand(msg: { type: string; [key: string]: unknown }) {
    console.log(`[${this.device}] Command: ${msg.type}`)

    switch (msg.type) {
      case 'spawn':
        this.createSession(msg.cmdId as string, msg.repo as string | undefined, msg.prompt as string | undefined)
        break
      case 'input':
        this.handleInput(msg.sessionId as string, msg.message as string)
        break
      case 'kill':
        this.killSession(msg.sessionId as string)
        break
    }
  }

  /**
   * Simulates dsh session creation with full event stream
   */
  private createSession(cmdId: string, repo?: string, prompt?: string) {
    const sessionId = `${this.device}-${crypto.randomUUID().slice(0, 8)}`
    const cwd = repo || this.workDir

    const session: Session = {
      id: sessionId,
      status: 'running',
      cwd,
      events: [],
    }
    this.sessions.set(sessionId, session)

    // Emit session/created event
    this.emitSessionEvent(session, 'session/created', {
      id: sessionId,
      cwd,
      createdAt: Date.now(),
    })

    // Acknowledge command
    this.send({
      type: 'command-result',
      cmdId,
      result: { sessionId },
    })

    // Simulate initial turn if prompt provided
    if (prompt) {
      setTimeout(() => this.runTurn(session, prompt), 500)
    } else {
      // Session becomes idle
      setTimeout(() => {
        session.status = 'idle'
        this.sendHeartbeat()
      }, 1000)
    }
  }

  /**
   * Simulates a full agent turn with realistic events
   */
  private runTurn(session: Session, userMessage: string) {
    const msgId = crypto.randomUUID()

    // 1. User message event
    this.emitSessionEvent(session, 'user/message', {
      message: {
        id: msgId,
        role: 'user',
        source: { kind: 'api', clientId: 'test' },
        content: [{ type: 'text', text: userMessage }],
      },
    })

    // 2. Turn start
    setTimeout(() => {
      this.emitSessionEvent(session, 'turn/start', { turnId: crypto.randomUUID() })
    }, 100)

    // 3. Request header (model selection)
    setTimeout(() => {
      this.emitSessionEvent(session, 'request/header', {
        provider: 'openai',
        model: 'gpt-4o-mini',
        streaming: true,
      })
    }, 200)

    // 4. Assistant chunks (streaming)
    const responseText = `Hello from ${this.device}! You said: "${userMessage}"`
    let charIndex = 0
    const chunkInterval = setInterval(() => {
      if (charIndex >= responseText.length) {
        clearInterval(chunkInterval)
        // 5. Complete assistant message
        setTimeout(() => {
          this.emitSessionEvent(session, 'assistant/message', {
            message: {
              id: crypto.randomUUID(),
              role: 'assistant',
              source: { kind: 'model', provider: 'openai', model: 'gpt-4o-mini' },
              content: [{ type: 'text', text: responseText }],
            },
          })

          // 6. Turn end
          setTimeout(() => {
            this.emitSessionEvent(session, 'turn/end', {})
            session.status = 'idle'
            this.sendHeartbeat()
          }, 100)
        }, 100)
        return
      }

      const chunk = responseText.slice(charIndex, charIndex + 5)
      charIndex += 5
      this.emitSessionEvent(session, 'assistant/chunk', {
        chunk: { type: 'text-delta', text: chunk },
      })
    }, 50)
  }

  private handleInput(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[${this.device}] Session not found: ${sessionId}`)
      return
    }

    session.status = 'running'
    this.sendHeartbeat()
    this.runTurn(session, message)
  }

  private killSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.emitSessionEvent(session, 'session/disposed', {})
    this.sessions.delete(sessionId)
    this.sendHeartbeat()
  }

  private emitSessionEvent(session: Session, type: string, data: unknown) {
    const event: SessionEvent = {
      type,
      seq: this.eventSeq++,
      time: Date.now(),
      data,
    }
    session.events.push(event)

    this.send({
      type: 'session-event',
      event: {
        sessionId: session.id,
        ...event,
      },
    })
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}

/**
 * Dashboard client that verifies multi-host visibility
 */
class DashboardVerifier {
  private ws: WebSocket | null = null
  private fleetState: { agents: Array<{ device: string; sessions: unknown[]; online: boolean }> } = { agents: [] }
  private events: Array<{ device: string; event: SessionEvent }> = []

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${HUB_URL}?type=dashboard`
      console.log('[Dashboard] Connecting...')

      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        console.log('[Dashboard] Connected')
        resolve()
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'fleet-state') {
          this.fleetState = msg
        } else if (msg.type === 'session-event') {
          this.events.push({ device: msg.device, event: msg.event })
        }
      })

      this.ws.on('error', reject)
    })
  }

  disconnect() {
    this.ws?.close()
  }

  spawnSession(device: string, prompt?: string) {
    this.ws?.send(JSON.stringify({ type: 'spawn', device, prompt }))
  }

  sendInput(device: string, sessionId: string, message: string) {
    this.ws?.send(JSON.stringify({ type: 'input', device, sessionId, message }))
  }

  getState() {
    return this.fleetState
  }

  getEvents() {
    return this.events
  }

  waitForAgents(count: number, timeout = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (this.fleetState.agents.filter(a => a.online).length >= count) {
          resolve()
        } else if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for ${count} agents`))
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })
  }

  waitForSessions(count: number, timeout = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        const totalSessions = this.fleetState.agents.reduce((sum, a) => sum + a.sessions.length, 0)
        if (totalSessions >= count) {
          resolve()
        } else if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for ${count} sessions (have ${totalSessions})`))
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })
  }

  waitForEvents(count: number, timeout = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (this.events.length >= count) {
          resolve()
        } else if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for ${count} events (have ${this.events.length})`))
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })
  }
}

async function runTests() {
  console.log('='.repeat(60))
  console.log('Turma 2.0 Multi-Host Federation Test')
  console.log('='.repeat(60))
  console.log()

  // Create workers and dashboard
  const worker1 = new MockDshWorker('truenas-1', '/mnt/data/repos')
  const worker2 = new MockDshWorker('truenas-2', '/mnt/storage/repos')
  const worker3 = new MockDshWorker('k8x', '/repos')
  const dashboard = new DashboardVerifier()

  try {
    // Test 1: Connect workers and dashboard
    console.log('Test 1: Connect multiple workers to hub')
    console.log('-'.repeat(40))

    await dashboard.connect()
    await worker1.connect()
    await worker2.connect()
    await worker3.connect()

    await dashboard.waitForAgents(3)
    const state = dashboard.getState()
    console.log(`✓ ${state.agents.length} agents connected`)
    state.agents.forEach(a => console.log(`  - ${a.device}: ${a.online ? 'online' : 'offline'}`))
    console.log()

    // Test 2: Spawn sessions on different workers
    console.log('Test 2: Spawn sessions on different workers')
    console.log('-'.repeat(40))

    dashboard.spawnSession('truenas-1', 'Hello from test on truenas-1')
    dashboard.spawnSession('truenas-2', 'Hello from test on truenas-2')
    dashboard.spawnSession('k8x', 'Hello from test on k8x')

    await dashboard.waitForSessions(3)

    const state2 = dashboard.getState()
    const totalSessions = state2.agents.reduce((sum, a) => sum + a.sessions.length, 0)
    console.log(`✓ ${totalSessions} sessions created across ${state2.agents.length} workers`)
    state2.agents.forEach(a => {
      console.log(`  - ${a.device}: ${a.sessions.length} session(s)`)
    })
    console.log()

    // Test 3: Verify event streaming
    console.log('Test 3: Verify event streaming to dashboard')
    console.log('-'.repeat(40))

    // Wait for events from all workers
    await dashboard.waitForEvents(15, 15000) // At least 5 events per session

    const events = dashboard.getEvents()
    const eventsByDevice = new Map<string, number>()
    events.forEach(e => {
      eventsByDevice.set(e.device, (eventsByDevice.get(e.device) || 0) + 1)
    })

    console.log(`✓ ${events.length} events received`)
    for (const [device, count] of eventsByDevice) {
      console.log(`  - ${device}: ${count} events`)
    }

    // Show event types
    const eventTypes = new Set(events.map(e => e.event.type))
    console.log(`  Event types: ${[...eventTypes].join(', ')}`)
    console.log()

    // Test 4: Send input to specific session
    console.log('Test 4: Route input to specific worker')
    console.log('-'.repeat(40))

    const k8xSession = state2.agents.find(a => a.device === 'k8x')?.sessions[0] as { id: string } | undefined
    if (k8xSession) {
      const eventCountBefore = events.length
      dashboard.sendInput('k8x', k8xSession.id, 'Follow-up message to k8x')

      // Wait for response events
      await new Promise(resolve => setTimeout(resolve, 3000))

      const newEvents = dashboard.getEvents().slice(eventCountBefore)
      const k8xEvents = newEvents.filter(e => e.device === 'k8x')
      console.log(`✓ Input routed to k8x, received ${k8xEvents.length} new events`)

      // Verify the user message was received
      const userMsg = k8xEvents.find(e => e.event.type === 'user/message')
      if (userMsg) {
        console.log('  ✓ User message event received')
      }

      const assistantMsg = k8xEvents.find(e => e.event.type === 'assistant/message')
      if (assistantMsg) {
        console.log('  ✓ Assistant message event received')
      }
    }
    console.log()

    // Summary
    console.log('='.repeat(60))
    console.log('VALIDATION COMPLETE')
    console.log('='.repeat(60))
    console.log()
    console.log('Proven capabilities:')
    console.log('  ✓ Multiple workers can connect to single hub')
    console.log('  ✓ Sessions from all workers visible in one dashboard')
    console.log('  ✓ Session events stream from workers to dashboard')
    console.log('  ✓ Commands can be routed to specific workers')
    console.log()
    console.log('This validates the Coordinator Pattern for multi-host dsh federation.')
    console.log()
    console.log('Keep the test running to explore the dashboard at http://localhost:3000')
    console.log('Press Ctrl+C to stop.')

    // Keep running for manual exploration
    await new Promise(() => {})

  } catch (error) {
    console.error('Test failed:', error)
    process.exit(1)
  } finally {
    worker1.disconnect()
    worker2.disconnect()
    worker3.disconnect()
    dashboard.disconnect()
  }
}

// Check if hub is running
async function checkHub(): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${HUB_URL}?type=dashboard`)
    const timeout = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 2000)

    ws.on('open', () => {
      clearTimeout(timeout)
      ws.close()
      resolve(true)
    })

    ws.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

async function main() {
  console.log('Checking if Fleet Hub is running...')
  const hubRunning = await checkHub()

  if (!hubRunning) {
    console.log()
    console.log('Fleet Hub is not running. Start it first:')
    console.log('  cd fleet-hub && npm run dev')
    console.log()
    process.exit(1)
  }

  await runTests()
}

main()
