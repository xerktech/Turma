#!/usr/bin/env npx tsx
/**
 * Standalone test for the Fleet Hub + Agent protocol.
 * Simulates two agents connecting to the hub without requiring dsh.
 *
 * Usage:
 *   1. Start the hub: cd fleet-hub && npm install && npm run dev
 *   2. Run this test: npx tsx test-standalone.ts
 *   3. Open http://localhost:3000 to see the dashboard
 */

import { WebSocket } from 'ws'

const HUB_URL = 'ws://localhost:3000/ws'

interface Session {
  id: string
  status: 'running' | 'idle'
  cwd?: string
}

class MockAgent {
  private ws: WebSocket | null = null
  private sessions: Session[] = []
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    private device: string,
    private onCommand?: (cmd: unknown) => void
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${HUB_URL}?device=${encodeURIComponent(this.device)}`
      console.log(`[${this.device}] Connecting to ${url}`)

      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        console.log(`[${this.device}] Connected`)
        this.startHeartbeat()
        resolve()
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        console.log(`[${this.device}] Received:`, msg.type)
        this.handleMessage(msg)
      })

      this.ws.on('error', (err) => {
        console.error(`[${this.device}] Error:`, err.message)
        reject(err)
      })

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
      sessions: this.sessions,
    })
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }) {
    this.onCommand?.(msg)

    switch (msg.type) {
      case 'spawn': {
        const sessionId = crypto.randomUUID()
        console.log(`[${this.device}] Spawning session: ${sessionId}`)
        this.sessions.push({
          id: sessionId,
          status: 'running',
          cwd: (msg.repo as string) || '/tmp/test',
        })
        this.send({
          type: 'command-result',
          cmdId: msg.cmdId,
          result: { sessionId },
        })
        // Simulate session becoming idle after 2s
        setTimeout(() => {
          const session = this.sessions.find(s => s.id === sessionId)
          if (session) session.status = 'idle'
          this.sendHeartbeat()
        }, 2000)
        break
      }

      case 'input': {
        console.log(`[${this.device}] Input to ${msg.sessionId}: ${msg.message}`)
        // Simulate a session event
        setTimeout(() => {
          this.send({
            type: 'session-event',
            event: {
              sessionId: msg.sessionId,
              type: 'user/message',
              data: { content: msg.message },
              time: Date.now(),
            },
          })
          // Simulate assistant response
          setTimeout(() => {
            this.send({
              type: 'session-event',
              event: {
                sessionId: msg.sessionId,
                type: 'assistant/message',
                data: { content: `Response from ${this.device}` },
                time: Date.now(),
              },
            })
          }, 500)
        }, 100)
        break
      }

      case 'kill': {
        console.log(`[${this.device}] Killing session: ${msg.sessionId}`)
        this.sessions = this.sessions.filter(s => s.id !== msg.sessionId)
        this.sendHeartbeat()
        break
      }
    }
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}

async function main() {
  console.log('Starting Turma 2.0 PoC test...\n')
  console.log('Make sure the Fleet Hub is running:')
  console.log('  cd fleet-hub && npm install && npm run dev\n')

  // Create two mock agents
  const agent1 = new MockAgent('host-1')
  const agent2 = new MockAgent('host-2')

  try {
    // Connect both agents
    await agent1.connect()
    await agent2.connect()

    console.log('\n✓ Both agents connected to hub')
    console.log('\nOpen http://localhost:3000 to see the dashboard')
    console.log('You should see both hosts listed.\n')
    console.log('Try clicking "Spawn Session" on each host.')
    console.log('Press Ctrl+C to stop.\n')

    // Keep running
    await new Promise(() => {})
  } catch (err) {
    console.error('Failed to connect:', err)
    console.log('\nMake sure the Fleet Hub is running first:')
    console.log('  cd fleet-hub && npm install && npm run dev')
    process.exit(1)
  }
}

main()
