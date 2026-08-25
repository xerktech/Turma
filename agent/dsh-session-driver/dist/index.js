/**
 * @turma/dsh-session-driver
 *
 * The per-session dsh driver plugin (XERK-467 [C]). One headless dsh process per
 * Turma session (XERK-466 [B]) loads this plugin, which:
 *
 *   - creates exactly ONE agent on the Turma session id pinned at launch, so the
 *     projection transcript resolves by name (D3, the XERK-6 trap stays closed);
 *   - binds the per-session UNIX control socket `~/.turma/dsh/<id>.sock` and
 *     speaks the hub-agent control protocol — input / answer / state / kill, and
 *     the unsolicited state / interaction / interaction_end events
 *     (docs/dsh-session-lifecycle.md);
 *   - writes each raw dsh session event as one JSONL line to the native event
 *     log on disk, which hub-agent (agent/dsh_session.py) tails through the [S1]
 *     projector to build the Claude-JSONL transcript every Turma surface reads.
 *     Display events NEVER ride the socket — it carries control + liveness only.
 *
 * All per-session variance comes from the process ENVIRONMENT, never plugin
 * config: dsh hot-reloads config and every dsh sharing a DSH_HOME reads the same
 * file, so config-borne identity would let an abandoned instance adopt another
 * session's id. Environment is fixed per process at exec (the discipline the PoC
 * used for TURMA_FLEET_INSTANCE_ID). Vars:
 *   TURMA_DSH_SESSION_ID          the pinned session id (== agents.create id)
 *   TURMA_DSH_SOCKET              the control socket path to bind
 *   TURMA_DSH_CWD                 the agent's working directory (absolute)
 *   TURMA_DSH_EVENTS             native event-log path (JSONL, for projection)
 *   TURMA_DSH_PROVIDER           provider route for agentOptions (optional)
 *   TURMA_DSH_MODEL              model id for agentOptions (optional)
 *   TURMA_DSH_SYSTEM_PROMPT_FILE  file whose text is appended as a prompt section
 *
 * dsh interaction model (verified against 0.1.1-rc.2 .d.ts): HITL is
 * register-as-answerer, not event-then-answer-by-id. This plugin bridges it to
 * the socket: it registers the approval and user-question answerers, and when dsh
 * calls one it mints a requestId, emits an `interaction` event, and BLOCKS on a
 * Promise that the hub resolves with an `answer` op. Option indices on the wire
 * are 0-based positions into the emitted options[]; the plugin maps them back to
 * dsh's native answer (an approval OUTCOME, or a question option LABEL).
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
export const name = 'turma-dsh-session-driver';
// Load only once these services exist. `agentLoop` (@deepseek-ai/dsh-agent-loop)
// is what registers the agent FACTORY via agents.setFactory — without injecting
// it, this driver can load before the factory exists and agents.create() throws
// "no agent factory registered". approval/userQuestions/systemPrompt are declared
// so the HITL and prompt seams are wired the moment dsh offers them.
export const inject = ['sessions', 'agents', 'agentLoop', 'userQuestions', 'approval', 'systemPrompt'];
function userMessage(text, source) {
    return { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source };
}
// Map a Turma socket source.kind onto a dsh MessageSource. dsh's vocabulary is
// user | plugin | model | tool (merge-extensible); a peer/machine message is a
// plugin-sourced relay, which is the dsh analogue of Claude's INBOX_PREFIX role.
function dshSource(kind) {
    if (kind === 'user')
        return { kind: 'user' };
    return { kind: 'plugin', plugin: 'turma', form: 'relay' };
}
// 0-based socket indices -> the positions the answerer selected.
function answerIndices(a) {
    if (Array.isArray(a.optionIndices) && a.optionIndices.length) {
        return a.optionIndices.filter((n) => Number.isInteger(n) && n >= 0);
    }
    if (Number.isInteger(a.optionIndex) && a.optionIndex >= 0) {
        return [a.optionIndex];
    }
    return [];
}
export function apply(ctx, config) {
    const env = process.env;
    const sessionId = env.TURMA_DSH_SESSION_ID || '';
    const socketPath = env.TURMA_DSH_SOCKET || '';
    const cwd = env.TURMA_DSH_CWD || process.cwd();
    const eventsPath = env.TURMA_DSH_EVENTS || '';
    const provider = env.TURMA_DSH_PROVIDER || config.provider;
    const model = env.TURMA_DSH_MODEL || config.model;
    const sysPromptFile = env.TURMA_DSH_SYSTEM_PROMPT_FILE || '';
    if (!sessionId || !socketPath) {
        ctx.logger.error('[turma-dsh] TURMA_DSH_SESSION_ID and TURMA_DSH_SOCKET are '
            + 'required; the driver is not managing this session');
        return;
    }
    let handle = null;
    const clients = new Set();
    // requestId -> resolve fn for a pending interaction (an approval or a question)
    const pending = new Map();
    function emit(obj) {
        const line = JSON.stringify(obj) + '\n';
        for (const c of clients) {
            try {
                c.write(line);
            }
            catch { /* dropped client, reaped on close */ }
        }
    }
    function writeEvent(event) {
        if (!eventsPath)
            return;
        try {
            fs.appendFileSync(eventsPath, JSON.stringify({ type: event.type, seq: event.seq, time: event.time, data: event.data }) + '\n');
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] event log write failed: ${e}`);
        }
    }
    // ---- one agent, on the pinned session id ---------------------------------
    // The setup hook MUST compose the agent from a preset, or it is created with
    // no tools — no bash/edit/ask-user/approval — so the model can neither do work
    // nor raise a HITL request (it just prints tool JSON as prose). dsh's own hosts
    // do this via composeAgent(); we mount the default preset directly. A rosterless
    // deployment (no presets — tools live in the global host layer) has no default
    // to mount, so a mount failure there is tolerated rather than rolling the agent
    // back; in a roster deployment (the `web` profile) the mount is what delivers
    // the tools.
    const setup = async (agentCtx) => {
        const presets = ctx.get('agentPresets');
        if (!presets || typeof presets.mount !== 'function')
            return;
        try {
            await presets.mount(agentCtx); // undefined id -> the roster's default preset
        }
        catch (e) {
            // Tolerated ONLY for a rosterless deployment (tools live in the global
            // host layer). Logged at ERROR, not warn: in a roster deployment (the web
            // profile) a mount failure silently reproduces the original no-tools bug,
            // so it must be loud enough for an operator to catch.
            ctx.logger.error(`[turma-dsh] preset mount FAILED (${e}) — if this host uses `
                + `presets the agent has NO TOOLS`);
        }
    };
    (async () => {
        try {
            const agentOptions = (provider || model) ? { provider, model } : undefined;
            handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
            ctx.logger.info(`[turma-dsh] agent ${handle.agent.id} created (cwd ${cwd})`);
        }
        catch (e) {
            ctx.logger.error(`[turma-dsh] agent create failed: ${e}`);
        }
    })();
    // ---- system-prompt section from the policy file --------------------------
    // dsh has no --append-system-prompt; the new-work / ticket-branch / peers
    // directive is registered as an ordered prompt section instead (order 200,
    // after persona and tool guidance).
    if (sysPromptFile && ctx.systemPrompt) {
        try {
            const text = fs.readFileSync(sysPromptFile, 'utf8');
            if (text.trim()) {
                ctx.systemPrompt.section({ name: 'turma-directives', order: 200, text });
            }
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] could not read system prompt file: ${e}`);
        }
    }
    // ---- control socket ------------------------------------------------------
    function ack(sock, ok, error) {
        try {
            sock.write(JSON.stringify(error ? { ok: false, error } : { ok }) + '\n');
        }
        catch { /* */ }
    }
    async function handleOp(sock, line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!msg || typeof msg !== 'object')
            return;
        switch (msg.op) {
            case 'input': {
                // Wait briefly for the agent to be registered: create() is async (its
                // setup composes the preset), so an input that arrives right after the
                // socket binds — the initial prompt — can beat it. Without this the first
                // turn is silently dropped as "agent not ready".
                let agent = ctx.agents.get(sessionId);
                for (let i = 0; i < 100 && !agent; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    agent = ctx.agents.get(sessionId);
                }
                if (!agent) {
                    ack(sock, false, 'agent not ready');
                    return;
                }
                const kind = (msg.source && typeof msg.source.kind === 'string') ? msg.source.kind : 'user';
                agent.followup(userMessage(String(msg.text || ''), dshSource(kind)));
                ack(sock, true);
                return;
            }
            case 'answer': {
                const rid = String(msg.requestId || '');
                const resolve = pending.get(rid);
                if (!resolve) {
                    ack(sock, false, 'no such pending interaction');
                    return;
                }
                pending.delete(rid);
                resolve({ optionIndex: msg.optionIndex, optionIndices: msg.optionIndices, text: msg.text });
                ack(sock, true);
                return;
            }
            case 'state': {
                const agent = ctx.agents.get(sessionId);
                try {
                    sock.write(JSON.stringify({
                        ok: true,
                        status: agent ? agent.status : 'idle',
                        eventCount: agent ? agent.session.events.length : 0,
                        pendingInteraction: pending.size > 0,
                    }) + '\n');
                }
                catch { /* */ }
                return;
            }
            case 'kill': {
                ack(sock, true);
                try {
                    if (handle)
                        await handle.dispose();
                }
                catch (e) {
                    ctx.logger.warn(`[turma-dsh] dispose: ${e}`);
                }
                try {
                    server.close();
                }
                catch { /* */ }
                try {
                    fs.unlinkSync(socketPath);
                }
                catch { /* */ }
                // The dsh process exists to run this one session; tear it down with it.
                process.exit(0);
                return;
            }
            default:
                ack(sock, false, 'unknown op');
        }
    }
    // A single control frame is bounded so a same-uid peer streaming bytes without
    // a newline cannot grow the dsh process's memory without limit. Generous above
    // INPUT_MAX_CHARS (100k, capped hub-side); applies to ONE line.
    const LINE_MAX_BYTES = 4 << 20;
    const server = net.createServer((sock) => {
        clients.add(sock);
        let buf = '';
        sock.on('data', (d) => {
            buf += d.toString('utf8');
            let nl;
            // eslint-disable-next-line no-cond-assign
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line)
                    void handleOp(sock, line);
            }
            if (buf.length > LINE_MAX_BYTES) {
                // No complete line and already over the cap: a broken/hostile stream.
                // Close the connection rather than reset the buffer — resetting leaves
                // the flood's tail to corrupt the next op on the same socket. The hub
                // client reconnects; the hub never sends a frame this large.
                ctx.logger.warn(`[turma-dsh] oversize control frame (${buf.length} bytes, `
                    + `no newline) — closing the connection`);
                buf = '';
                try {
                    sock.destroy();
                }
                catch { /* already gone */ }
                return;
            }
        });
        sock.on('close', () => clients.delete(sock));
        sock.on('error', () => clients.delete(sock));
    });
    try {
        fs.unlinkSync(socketPath);
    }
    catch { /* no stale socket */ }
    server.listen(socketPath, () => {
        try {
            fs.chmodSync(socketPath, 0o600);
        }
        catch { /* best effort */ }
        ctx.logger.info(`[turma-dsh] control socket bound at ${socketPath}`);
    });
    // ---- HITL: bridge dsh's register-as-answerer model to the socket ---------
    // A pending interaction blocks the dsh answerer on a Promise the hub resolves
    // with an `answer` op. An abort (turn cancelled) settles it and tells the hub
    // to drop the rendezvous file via interaction_end.
    function awaitAnswer(requestId, signal) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (a) => {
                if (settled)
                    return;
                settled = true;
                pending.delete(requestId);
                resolve(a);
            };
            pending.set(requestId, done);
            if (signal) {
                if (signal.aborted) {
                    emit({ evt: 'interaction_end', requestId });
                    done(null);
                    return;
                }
                signal.addEventListener('abort', () => { emit({ evt: 'interaction_end', requestId }); done(null); }, { once: true });
            }
        });
    }
    // Approvals (tool permission): answer with an outcome enum.
    if (ctx.approval) {
        ctx.on('approval/request', async (req, next) => {
            if (!req || !req.agent || req.agent.id !== sessionId)
                return next();
            const requestId = crypto.randomUUID();
            emit({
                evt: 'interaction',
                requestId,
                kind: 'approval',
                prompt: req.reason || `Allow the ${req.toolName} tool to run?`,
                options: [{ number: 1, label: 'Approve' }, { number: 2, label: 'Reject' }],
                detail: req.toolName,
            });
            const answer = await awaitAnswer(requestId, req.signal);
            if (!answer)
                return 'cancelled';
            // 0 -> allow, anything else -> reject (the only grant is allowed-once).
            return answerIndices(answer)[0] === 0 ? 'allowed-once' : 'rejected';
        });
    }
    // User questions (model asking the human): answer by option LABEL, per id.
    //
    // The dsh web host (apiproxy) registers the single user-questions provider
    // DURING load, so registering ours inline would throw DUPLICATE_PROVIDER and
    // crash. We DEFER registration to after the synchronous load phase, then
    // displace the incumbent (Turma owns HITL; the dsh web UI is a read-only
    // viewer) and install ours. Guarded — a failure only means AskUserQuestion
    // falls back to the incumbent; approvals (a composable waterfall) are
    // unaffected.
    const questionProvider = {
        async ask(request) {
            if (request.agent && request.agent.id !== sessionId) {
                // Not our session — return empty selections so we don't intercept it.
                return { answers: request.questions.map((q) => ({ id: q.id, selected: [] })) };
            }
            const answers = [];
            // Serialize the questions so at most one interaction is pending per
            // session — the hub renders one rendezvous file at a time, matching how
            // Claude's ask.py bridge serializes a multi-question call.
            for (const q of request.questions) {
                const requestId = crypto.randomUUID();
                const options = (q.options || []).map((o, i) => ({ number: i + 1, label: o.label }));
                emit({
                    evt: 'interaction',
                    requestId,
                    kind: 'question',
                    prompt: q.question,
                    options,
                    detail: q.header || q.detail,
                });
                const answer = await awaitAnswer(requestId, request.signal);
                if (!answer) {
                    answers.push({ id: q.id, selected: [] });
                    continue;
                }
                const opts = q.options || [];
                const selected = [];
                for (const i of answerIndices(answer)) {
                    if (opts[i])
                        selected.push(opts[i].label);
                }
                const entry = { id: q.id, selected };
                if (typeof answer.text === 'string' && answer.text.trim())
                    entry.custom = answer.text;
                answers.push(entry);
            }
            return { answers };
        },
    };
    if (ctx.userQuestions) {
        // POLL-AND-DISPLACE, robust against load-order races. The dsh web host
        // (apiproxy) registers the single user-questions provider during load; the
        // service throws DUPLICATE_PROVIDER if a second registers, and it is
        // whichever registers SECOND that throws. So we must never register while
        // apiproxy still might: we wait until an incumbent is present, THEN displace
        // it (Turma owns HITL; the dsh web UI is read-only) and install ours — which
        // cannot make apiproxy throw, since its apply has already completed. If no
        // incumbent appears within the grace window (a headless profile with no web
        // host), we register ours directly.
        const svc = ctx.userQuestions;
        let done = false;
        let tries = 0;
        const install = () => {
            if (done)
                return true;
            const incumbent = svc.provider !== undefined && svc.provider !== questionProvider;
            if (!incumbent && tries < 40)
                return false; // wait for apiproxy (or timeout)
            done = true;
            try {
                if (svc.provider !== undefined) {
                    ctx.logger.info('[turma-dsh] displacing the incumbent user-questions '
                        + 'provider so Turma owns AskUserQuestion');
                    svc.provider = undefined;
                }
                ctx.userQuestions.registerProvider(questionProvider);
                ctx.logger.info('[turma-dsh] user-questions provider installed');
            }
            catch (e) {
                ctx.logger.warn(`[turma-dsh] user-questions provider registration failed `
                    + `(AskUserQuestion falls back to the incumbent): ${e}`);
            }
            return true;
        };
        const iv = setInterval(() => { tries++; if (install())
            clearInterval(iv); }, 50);
        // Don't let this timer alone keep the process alive.
        if (typeof iv.unref === 'function') {
            iv.unref();
        }
    }
    // ---- forward session events + turn/status edges --------------------------
    ctx.on('session/event', (session, event) => {
        if (!session || session.id !== sessionId)
            return; // only THIS session's log
        writeEvent(event);
        if (event.type === 'turn/start' || event.type === 'turn/end') {
            const agent = ctx.agents.get(sessionId);
            emit({
                evt: 'state',
                status: agent ? agent.status : 'idle',
                eventCount: session.events.length,
            });
        }
    }, { global: true });
    // ---- teardown ------------------------------------------------------------
    ctx.effect(() => () => {
        try {
            server.close();
        }
        catch { /* */ }
        try {
            fs.unlinkSync(socketPath);
        }
        catch { /* */ }
        for (const [rid, resolve] of pending) {
            emit({ evt: 'interaction_end', requestId: rid });
            resolve(null);
        }
        pending.clear();
    }, 'turma-dsh.cleanup');
}
