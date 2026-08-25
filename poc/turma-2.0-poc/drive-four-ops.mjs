#!/usr/bin/env node
/**
 * Drive the four G1 operations against a REAL dsh session, through the Fleet
 * Hub (XERK-463). Connects to the hub as a dashboard client and:
 *
 *   1. spawn      — ask the hub to create a session on <device>; the real dsh
 *                   plugin calls ctx.agents.create() and returns a sessionId.
 *   2. input      — send a prompt; the plugin calls agent.followup(), the real
 *                   model runs a turn.
 *   3. transcript — collect the session-event stream the plugin forwards and
 *                   assert a real assistant/message (model output) arrives.
 *   4. kill       — dispose the session; assert it leaves the heartbeat.
 *
 * No mocks: every operation crosses the hub → WebSocket → dsh plugin → real
 * dsh agent loop → configured model. Exit 0 on PASS, 1 on FAIL, and print a
 * machine-checkable "=== FOUR-OPS PASS ===" / "=== FOUR-OPS FAIL ===" line.
 *
 * Usage: node drive-four-ops.mjs --hub-port 3000 --device dsh-test-host \
 *          [--prompt "Reply with exactly: PONG"] [--turn-timeout 90]
 */

import { WebSocket } from 'ws'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const HUB_PORT = Number(arg('hub-port', '3000'))
const DEVICE = arg('device', 'dsh-test-host')
const PROMPT = arg('prompt', 'Reply with exactly the single word PONG and nothing else.')
const TURN_TIMEOUT_MS = Number(arg('turn-timeout', '90')) * 1000
const ONLINE_TIMEOUT_MS = 30_000
const KILL_TIMEOUT_MS = 20_000

const url = `ws://localhost:${HUB_PORT}/ws?type=dashboard`
const ws = new WebSocket(url)

// Every message the hub broadcasts, in arrival order, for the final report.
const seen = []
let lastFleetState = null

const listeners = new Set()
function onMessage(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(entry)
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`))
    }, timeoutMs)
    const entry = (msg) => {
      let hit
      try {
        hit = pred(msg)
      } catch {
        hit = false
      }
      if (hit) {
        clearTimeout(timer)
        listeners.delete(entry)
        resolve(msg)
      }
    }
    listeners.add(entry)
  })
}

ws.on('message', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  seen.push(msg)
  if (msg.type === 'fleet-state') lastFleetState = msg
  for (const l of [...listeners]) l(msg)
})

function send(obj) {
  ws.send(JSON.stringify(obj))
}

function deviceSessions(fleetState) {
  const a = (fleetState?.agents || []).find((x) => x.device === DEVICE)
  return a ? a.sessions || [] : null
}

function fail(stage, err) {
  console.error(`\n[drive] FAIL at ${stage}: ${err?.message || err}`)
  console.error('[drive] messages seen from hub:')
  for (const m of seen.slice(-40)) {
    console.error('   ', JSON.stringify(m).slice(0, 240))
  }
  console.log('\n=== FOUR-OPS FAIL ===')
  try {
    ws.close()
  } catch {}
  process.exit(1)
}

async function main() {
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  console.log(`[drive] connected to hub ${url}`)

  // -------------------------------------------------------- 0. device online
  // The very first message is a fleet-state; wait until <device> is online.
  await onMessage(
    (m) => m.type === 'fleet-state' && (m.agents || []).some((a) => a.device === DEVICE && a.online),
    ONLINE_TIMEOUT_MS,
    `device ${DEVICE} online`,
  ).catch((e) => fail('device-online', e))
  console.log(`[drive] device ${DEVICE} is online`)

  // --------------------------------------------------------------- 1. spawn
  // Spawn WITHOUT a prompt so the "input" op below is what first drives a turn
  // — keeping the four operations cleanly separable.
  console.log('[drive] [1/4] spawn ...')
  const sentP = onMessage((m) => m.type === 'command-sent', 10_000, 'command-sent')
  send({ type: 'spawn', device: DEVICE })
  const sent = await sentP.catch((e) => fail('spawn/command-sent', e))
  const cmdId = sent.cmdId
  const result = await onMessage(
    (m) => m.type === 'command-result' && m.cmdId === cmdId,
    20_000,
    'command-result',
  ).catch((e) => fail('spawn/command-result', e))
  if (result.error) fail('spawn', new Error(`agent reported: ${result.error}`))
  const sessionId = result.result?.sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    fail('spawn', new Error(`no sessionId in result: ${JSON.stringify(result.result)}`))
  }
  console.log(`[drive]   spawned session ${sessionId}`)

  // Confirm the session shows up in the heartbeat (proves the plugin's
  // ctx.sessions.list() sees the created session, not just the ack).
  await onMessage(
    (m) => m.type === 'fleet-state' && (deviceSessions(m) || []).some((s) => s.id === sessionId),
    ONLINE_TIMEOUT_MS,
    'session in heartbeat',
  ).catch((e) => fail('spawn/heartbeat', e))
  console.log('[drive]   session present in heartbeat')

  // --------------------------------------------------- 2. input + 3. transcript
  console.log('[drive] [2/4] input + [3/4] transcript ...')
  const events = []
  const gotUserMsg = onMessage(
    (m) =>
      m.type === 'session-event' &&
      m.event?.sessionId === sessionId &&
      String(m.event?.type).includes('user/message'),
    TURN_TIMEOUT_MS,
    'user/message session-event',
  )
  const gotAssistant = onMessage(
    (m) =>
      m.type === 'session-event' &&
      m.event?.sessionId === sessionId &&
      String(m.event?.type).includes('assistant/message'),
    TURN_TIMEOUT_MS,
    'assistant/message session-event',
  )
  // dsh reports a failed turn with `turn/end {kind:'error'}` (e.g. an
  // unreachable model gateway) after its own retries -- watch for it so a
  // failed turn fails THIS run fast with dsh's reason, rather than eating the
  // whole --turn-timeout waiting for an assistant/message that never comes.
  const gotTurnError = onMessage(
    (m) =>
      m.type === 'session-event' &&
      m.event?.sessionId === sessionId &&
      String(m.event?.type).includes('turn/end') &&
      turnErrorReason(m.event?.data) !== null,
    TURN_TIMEOUT_MS,
    'turn/end error session-event',
  )
  gotTurnError.catch(() => {}) // may lose the race; don't leak an unhandled rejection
  // Record the whole session-event stream for the report.
  const recorder = (m) => {
    if (m.type === 'session-event' && m.event?.sessionId === sessionId) events.push(m.event)
  }
  listeners.add(recorder)

  send({ type: 'input', device: DEVICE, sessionId, message: PROMPT })

  await gotUserMsg.catch((e) => fail('input', e))
  console.log('[drive]   input recorded as a user/message event')
  const outcome = await Promise.race([
    gotAssistant.then((m) => ({ assistant: m })),
    gotTurnError.then((m) => ({ turnError: m })),
  ]).catch((e) => fail('transcript', e))
  if (outcome.turnError) {
    fail(
      'transcript',
      new Error(`dsh turn ended with an error: ${turnErrorReason(outcome.turnError.event?.data)}`),
    )
  }
  const assistantMsg = outcome.assistant
  listeners.delete(recorder)

  const assistantText = extractText(assistantMsg.event?.data)
  console.log(
    `[drive]   assistant/message streamed back (${events.length} session events total)`,
  )
  console.log(`[drive]   model said: ${JSON.stringify((assistantText || '').slice(0, 120))}`)

  // ---------------------------------------------------------------- 4. kill
  console.log('[drive] [4/4] kill ...')
  send({ type: 'kill', device: DEVICE, sessionId })
  await onMessage(
    (m) => m.type === 'fleet-state' && !(deviceSessions(m) || []).some((s) => s.id === sessionId),
    KILL_TIMEOUT_MS,
    'session removed from heartbeat',
  ).catch((e) => fail('kill', e))
  console.log('[drive]   session gone from heartbeat')

  // -------------------------------------------------------------- verdict
  const eventTypes = [...new Set(events.map((e) => e.type))].sort()
  console.log('\n[drive] session-event types observed:')
  console.log('   ', eventTypes.join(', '))
  console.log('\n=== FOUR-OPS PASS ===')
  console.log(
    JSON.stringify(
      {
        sessionId,
        spawn: 'ok',
        input: 'ok',
        transcriptEvents: events.length,
        assistantText: (assistantText || '').slice(0, 200),
        kill: 'ok',
      },
      null,
      2,
    ),
  )
  ws.close()
  process.exit(0)
}

// If a `turn/end` event carries an error, return a human reason; else null.
// dsh shapes it as `data.reason = { kind: 'error', error: { message, code } }`.
function turnErrorReason(data) {
  const reason = data?.reason
  if (!reason || reason.kind !== 'error') return null
  const err = reason.error
  const text =
    (typeof err === 'string' && err) ||
    err?.message ||
    (typeof reason.message === 'string' && reason.message) ||
    ''
  return text || JSON.stringify(err ?? reason).slice(0, 200)
}

// dsh assistant-message event data carries model-facing content blocks; pull
// the visible text out of whatever shape arrives, defensively.
function extractText(data) {
  if (!data) return ''
  const msg = data.message || data
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '')
      .join('')
  }
  if (typeof data.text === 'string') return data.text
  return ''
}

ws.on('error', (e) => fail('websocket', e))
main().catch((e) => fail('main', e))
