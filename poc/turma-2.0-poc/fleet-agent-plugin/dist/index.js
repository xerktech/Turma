/**
 * @turma/dsh-fleet-agent
 *
 * Real dsh plugin that connects a dsh instance to the Turma Fleet Hub.
 * Streams session events to the hub and handles commands (spawn, input, kill).
 */
import { WebSocket } from 'ws';
// Build a well-formed dsh UserMessage. dsh's own `createUserMessage` freezes
// and mints a branded id, but the loose literal here carries the same fields
// the inbox durably logs and the model request reads: a plain uuid id, the
// `user` source kind, and one text block.
function userMessage(text) {
    return {
        id: crypto.randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
    };
}
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
    // Live agent handles keyed by session id. `ctx.agents.get()` returns a bare
    // agent with no disposer, so a spawned session's handle is kept here to make
    // `kill` a real teardown (stop loop + unregister + remove session) rather
    // than a turn cancel.
    const handles = new Map();
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
            // Mint the session id ourselves -- create() is identity-in, so the id is
            // known before the agent exists (the same discipline the real hub uses to
            // name a session's transcript before its first byte).
            const sessionId = crypto.randomUUID();
            const agentOptions = config.provider || config.model
                ? { provider: config.provider, model: config.model }
                : undefined;
            // A dsh session's meta.cwd must be a validated absolute path; fall back
            // to this process's cwd when the hub sends none (its `spawn` carries
            // `repo`, not `cwd`), so create() always has a real working directory.
            const cwd = msg.cwd || process.cwd();
            const handle = await ctx.agents.create({
                sessionId,
                meta: { cwd },
                agentOptions,
            });
            handles.set(handle.agent.id, handle);
            // An initial prompt is delivered like any other input: a follow-up turn
            // that wakes the driver. create() alone leaves the agent idle.
            if (msg.prompt)
                handle.agent.followup(userMessage(msg.prompt));
            sendCommandResult(msg.cmdId, { sessionId: handle.agent.id });
            // Reflect the new session in the hub's state now, not on the next 15s beat.
            sendHeartbeat();
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
        // followup queues the message as its own turn AND wakes the driver, so the
        // model actually processes it. `inbox.append` would enqueue without waking.
        agent.followup(userMessage(msg.message));
    }
    async function handleKill(msg) {
        const handle = handles.get(msg.sessionId);
        if (handle) {
            // The capability disposer: stop the loop, unregister, remove the session.
            handles.delete(msg.sessionId);
            await handle.dispose();
            // Reflect the teardown immediately rather than on the next 15s beat.
            sendHeartbeat();
            return;
        }
        // No handle (e.g. a session created outside this plugin): fall back to
        // cancelling the active turn, the strongest teardown a bare agent allows.
        const agent = ctx.agents.get(msg.sessionId);
        if (!agent) {
            ctx.logger.warn(`[fleet] Session not found for kill: ${msg.sessionId}`);
            return;
        }
        agent.cancel({ kind: 'disposed' });
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
