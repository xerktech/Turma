/**
 * @turma/dsh-fleet-agent
 *
 * Real dsh plugin that connects a dsh instance to the Turma Fleet Hub.
 * Streams session events to the hub and handles commands (spawn, input, kill).
 */
import { WebSocket } from 'ws';
// Plugin metadata
export const name = 'turma-fleet-agent';
export const inject = ['sessions', 'agents'];
// Plugin entry point
export function apply(ctx, config) {
    // Env wins over config: it is per-process, so a second dsh sharing this
    // DSH_HOME cannot pick it up on a config hot-reload. See Config.instanceId.
    const instanceId = process.env.TURMA_FLEET_INSTANCE_ID || config.instanceId;
    let ws = null;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    const pendingCommands = new Map();
    function connect() {
        const url = `${config.hubUrl}?device=${encodeURIComponent(config.device)}`;
        ctx.logger.info(`[fleet] Connecting to hub: ${url}`);
        ws = new WebSocket(url);
        ws.on('open', () => {
            ctx.logger.info(`[fleet] Connected to hub as ${config.device}`);
            startHeartbeat();
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleHubMessage(msg);
            }
            catch (e) {
                ctx.logger.error(`[fleet] Invalid message from hub: ${e}`);
            }
        });
        ws.on('close', () => {
            ctx.logger.info('[fleet] Disconnected from hub, reconnecting in 5s...');
            stopHeartbeat();
            scheduleReconnect();
        });
        ws.on('error', (err) => {
            ctx.logger.error(`[fleet] WebSocket error: ${err.message}`);
        });
    }
    function scheduleReconnect() {
        if (reconnectTimer)
            return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, 5000);
    }
    function startHeartbeat() {
        if (heartbeatTimer)
            return;
        sendHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, 15000);
    }
    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }
    function sendHeartbeat() {
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        const sessions = ctx.sessions.list().map((s) => ({
            id: s.id,
            status: getSessionStatus(s),
            cwd: s.header.cwd,
            eventCount: s.events.length,
        }));
        ws.send(JSON.stringify({
            type: 'heartbeat',
            sessions,
            instanceId,
        }));
    }
    function getSessionStatus(session) {
        const agent = ctx.agents.get(session.id);
        return agent?.status || 'idle';
    }
    function handleHubMessage(msg) {
        switch (msg.type) {
            case 'spawn':
                handleSpawn(msg);
                break;
            case 'input':
                handleInput(msg);
                break;
            case 'kill':
                handleKill(msg);
                break;
            default:
                ctx.logger.info(`[fleet] Unknown message type: ${msg.type}`);
        }
    }
    async function handleSpawn(msg) {
        ctx.logger.info(`[fleet] Spawn request: ${msg.cmdId}`);
        try {
            // Create or resume an agent
            const result = await ctx.agents.resume({
                cwd: msg.cwd,
                prompt: msg.prompt,
            });
            sendCommandResult(msg.cmdId, { sessionId: result.agent.id });
        }
        catch (e) {
            ctx.logger.error(`[fleet] Spawn failed: ${e}`);
            sendCommandResult(msg.cmdId, null, String(e));
        }
    }
    function handleInput(msg) {
        const agent = ctx.agents.get(msg.sessionId);
        if (!agent) {
            ctx.logger.warn(`[fleet] Session not found for input: ${msg.sessionId}`);
            return;
        }
        // Queue user message to the agent's inbox
        const userMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            source: { kind: 'fleet', clientId: config.device },
            content: [{ type: 'text', text: msg.message }],
        };
        agent.inbox.append('next-turn', userMessage);
    }
    async function handleKill(msg) {
        const agent = ctx.agents.get(msg.sessionId);
        if (!agent) {
            ctx.logger.warn(`[fleet] Session not found for kill: ${msg.sessionId}`);
            return;
        }
        await agent.cancel();
    }
    function sendCommandResult(cmdId, result, error) {
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({
            type: 'command-result',
            cmdId,
            result,
            error,
        }));
    }
    function sendSessionEvent(sessionId, event) {
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({
            type: 'session-event',
            event: {
                sessionId,
                type: event.type,
                seq: event.seq,
                time: event.time,
                data: event.data,
            },
        }));
    }
    // Forward session events to hub
    ctx.on('session/event', (...args) => {
        const session = args[0];
        const event = args[1];
        sendSessionEvent(session.id, event);
    }, { global: true });
    // Announce new sessions
    ctx.on('session/created', (...args) => {
        const session = args[0];
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({
            type: 'session-created',
            session: {
                id: session.id,
                cwd: session.header.cwd,
                createdAt: session.header.createdAt,
            },
        }));
    }, { global: true });
    // Connect on plugin load
    connect();
    // Cleanup on plugin unload
    ctx.effect(() => () => {
        ctx.logger.info('[fleet] Plugin unloading, disconnecting...');
        if (reconnectTimer)
            clearTimeout(reconnectTimer);
        stopHeartbeat();
        if (ws) {
            ws.close();
            ws = null;
        }
    }, 'fleet-agent.cleanup');
}
