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
import * as path from 'node:path';
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
    // Resume vs fresh (XERK-475). The launcher sets this when relaunching a
    // session that already has a persisted dsh store (start / resume-on-boot /
    // migration import). `agents.create` on an already-persisted id THROWS
    // ("already has a persisted log on disk; load/resume it instead"), so a
    // resume MUST take the resume() path to reload the model's context.
    const resume = env.TURMA_DSH_RESUME === '1';
    // Peer messaging (XERK-476): this session's roster NAME (what a peer addresses
    // and what the forged Claude-inbox record is registered under) and Claude
    // Code's session-registry dir (where that record goes). Absent -> peer
    // messaging is off for this session (older hub, or the fields unset).
    const rcName = env.TURMA_DSH_RCNAME || '';
    const claudeSessionsDir = env.TURMA_DSH_CLAUDE_SESSIONS_DIR || '';
    if (!sessionId || !socketPath) {
        ctx.logger.error('[turma-dsh] TURMA_DSH_SESSION_ID and TURMA_DSH_SOCKET are '
            + 'required; the driver is not managing this session');
        return;
    }
    let handle = null;
    // Whether agents.create/resume has RESOLVED (XERK-492). The control socket
    // binds before this, so `agentUp` is what the hub's launch confirmation waits
    // on to tell "socket up, agent still creating" (normal) from "socket up,
    // process already dead / agent failed to start" (a zombie). Reported on the
    // `state` reply.
    let agentUp = false;
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
    // ---- delegation capture (XERK-474 [J]) -----------------------------------
    // A dsh session that delegates to sub-agents / workflows must surface the same
    // picker + per-agent transcripts a Claude session does. The hub-side [S1]
    // projector builds those Claude-Code shapes from two extra streams this driver
    // writes: (1) each descendant session's own native log, beside the parent's;
    // (2) a `turma/subagent-*` forward of dsh's ctx-bus subagent lifecycle events
    // into the parent log, since those are not session-log entries the tail sees.
    const childEventsDir = eventsPath ? path.join(path.dirname(eventsPath), 'subagents') : '';
    // A child SessionId names a file and rides a path on the hub side, so it is
    // validated to hub-agent's own VALID_WORKFLOW_AGENT_ID_RE grammar before use.
    const CHILD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    // childId -> its durable label, folded from the child's `subagent/descriptor`
    // event, so a forwarded launch carries a real name rather than the bare id.
    const childLabels = new Map();
    // childIds belonging to a WORKFLOW run (seen on a parent `tool-workflow/agent-start`):
    // their launch is the run's, so the subagent forward is skipped for them.
    const workflowChildIds = new Set();
    function writeParentEvent(type, seq, data) {
        if (!eventsPath)
            return;
        try {
            fs.appendFileSync(eventsPath, JSON.stringify({ type, seq, time: Date.now(), data }) + '\n');
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] parent event forward failed: ${e}`);
        }
    }
    function writeChildEvent(childId, event) {
        if (!childEventsDir || !CHILD_ID_RE.test(childId))
            return;
        if (event.type === 'subagent/descriptor') {
            const d = event.data;
            if (d && typeof d.label === 'string' && d.label)
                childLabels.set(childId, d.label);
        }
        try {
            fs.mkdirSync(childEventsDir, { recursive: true });
            fs.appendFileSync(path.join(childEventsDir, `${childId}.jsonl`), JSON.stringify({ type: event.type, seq: event.seq, time: event.time, data: event.data }) + '\n');
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] child event log write failed: ${e}`);
        }
    }
    // Forward one subagent lifecycle edge into the parent log. DEFERRED a tick so a
    // near-simultaneous `tool-workflow/agent-start` lands first: that ordering is
    // what lets a workflow agent be told apart from an ordinary subagent (its
    // launch is the run's, so it is skipped here — the hub tail re-checks the same).
    function forwardSubagentEdge(kind, info) {
        if (!info)
            return;
        const childId = String(info.id || '');
        const runId = String(info.runId || '');
        if (!childId)
            return;
        setImmediate(() => {
            if (workflowChildIds.has(childId))
                return;
            if (kind === 'start') {
                const data = { runId, childId, provider: String(info.provider || '') };
                const label = childLabels.get(childId);
                if (label)
                    data.label = label;
                writeParentEvent('turma/subagent-start', `sa-start-${runId || childId}`, data);
            }
            else {
                writeParentEvent('turma/subagent-end', `sa-end-${runId || childId}`, { runId, childId, stopReason: String(info.stopReason || '') });
            }
        });
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
    // Pin the per-session approval policy + sandbox mode from the guard config
    // (XERK-470 [F]): approvals must ASK so [C]'s answerer over the socket is
    // called (a 'never' default would auto-reject every escalation without ever
    // asking); writes are confined to the worktree. These are per-session runtime
    // settings, so they are set here rather than in the shared profile. The guard
    // plugin's monotonic deny is the load-bearing protection regardless; these are
    // additional confinement, so a failure is warned, not fatal.
    const pinGuardPolicy = async (agent) => {
        const policy = env.TURMA_DSH_APPROVAL_POLICY;
        if (policy && ctx.approval && typeof ctx.approval.setPolicy === 'function') {
            try {
                ctx.approval.setPolicy(agent, policy);
            }
            catch (e) {
                ctx.logger.warn(`[turma-dsh] could not set approval policy: ${e}`);
            }
        }
        const mode = env.TURMA_DSH_SANDBOX_MODE;
        if (mode) {
            try {
                const pkg = '@deepseek-ai/dsh-sandbox-policy';
                const mod = await import(pkg);
                if (mod && typeof mod.setSandboxMode === 'function') {
                    mod.setSandboxMode(agent.session, mode);
                }
            }
            catch (e) {
                ctx.logger.warn(`[turma-dsh] could not set sandbox mode: ${e}`);
            }
        }
    };
    (async () => {
        try {
            const agentOptions = (provider || model) ? { provider, model } : undefined;
            if (resume) {
                // Reload the persisted session — the model's full context (XERK-475).
                // No `meta`: the cwd is read from the store's header, not supplied. If
                // the store is somehow absent, resume() rejects; fall back to a fresh
                // create so the session at least comes up (loudly logged) rather than
                // leaving the process dead — the create then also succeeds only if no
                // store exists, so it can never mask a present-but-unreadable store.
                try {
                    handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
                    ctx.logger.info(`[turma-dsh] agent ${handle.agent.id} resumed (cwd ${cwd})`);
                }
                catch (re) {
                    ctx.logger.error(`[turma-dsh] agent resume failed (${re}); creating fresh`);
                    handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
                    ctx.logger.info(`[turma-dsh] agent ${handle.agent.id} created fresh after resume failure (cwd ${cwd})`);
                }
            }
            else {
                handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
                ctx.logger.info(`[turma-dsh] agent ${handle.agent.id} created (cwd ${cwd})`);
            }
            await pinGuardPolicy(handle.agent);
            agentUp = true;
        }
        catch (e) {
            // The agent is the whole reason this process exists; without it the
            // session is a zombie — socket bound, pane empty, no events ever (a bad
            // model route, a missing dynamic import in setup, an unreadable store).
            // EXIT rather than linger, so the hub's launch confirmation (XERK-492)
            // sees the tmux process die and refuses the launch with a reason, instead
            // of recording a session that is dead on arrival.
            ctx.logger.error(`[turma-dsh] agent create failed: ${e} — exiting`);
            // Drop the bound control socket so the launcher's stale-socket check and
            // the next launch are clean; exiting closes the listener regardless. The
            // forged peer-inbox record (if any) is left to the hub's cc-socks sweep,
            // which reaps it once this pid is dead (a hard-killed dsh session leaves
            // the same, and it is undeliverable meanwhile — harmless).
            try {
                fs.unlinkSync(socketPath);
            }
            catch { /* */ }
            process.exit(1);
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
                        // Launch-liveness signal (XERK-492): true once agents.create/resume
                        // has resolved. Distinct from `status`, which reads 'idle' both while
                        // the agent is still being created and when it has failed to.
                        agentUp,
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
                    cleanupPeerInbox();
                }
                catch { /* */ } // drop the forged inbox record + socket
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
    (async () => {
        // Resolve the tools service via ctx.get, NOT `ctx.tools`: cordis THROWS on a
        // property access for a service not named in `inject` ("cannot get property
        // tools without inject"), which fires before any `!ctx.tools` guard and
        // aborts the whole plugin load — DOA on the real `web` profile. `ctx.get`
        // returns undefined for an absent/uninjected service instead (the same
        // tolerated-optional pattern the preset mount uses), so a deployment without
        // dsh-tools simply skips the peer send_message tool. (Fixes an XERK-476 [L]
        // crash surfaced while QAing XERK-475.)
        const tools = ctx.get('tools');
        if (!tools || typeof tools.register !== 'function')
            return;
        let defineTool;
        try {
            // Indirect specifier (the sandbox-policy pattern): resolved at runtime from
            // the dsh process's node_modules, not statically by the driver's own build.
            const pkg = '@deepseek-ai/dsh-tools';
            const mod = await import(pkg);
            defineTool = mod.defineTool;
            if (typeof defineTool !== 'function')
                return;
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] send_message tool unavailable (no dsh-tools): ${e}`);
            return;
        }
        try {
            tools.register(defineTool({
                name: 'send_message',
                description: 'Send a short message to another session in your organisation, '
                    + 'addressed by its `name` exactly as it appears in ~/.turma/peers.tsv. '
                    + 'A message costs the receiver a turn and sits in their context, so send '
                    + 'one only when it is worth that: to ask before working something out the '
                    + 'expensive way, or to warn a peer about to lose work. Not for status or '
                    + 'progress. Delivery is best-effort.',
                parameters: {
                    to: { type: 'string', required: true,
                        description: "The peer's `name` from ~/.turma/peers.tsv (its second column)." },
                    message: { type: 'string', required: true,
                        description: 'The message. One or two sentences of fact.' },
                },
                output: {
                    schema: { type: 'string' },
                    render: (_a, v) => [{ type: 'text', text: v }],
                },
                async execute(args) {
                    const to = String(args.to || '').trim();
                    const text = String(args.message || '');
                    if (!to || !text.trim())
                        return 'No recipient or message; nothing sent.';
                    emit({ evt: 'peer_send', name: to, text });
                    return `Message queued to ${to}. Delivery is best-effort; a name not `
                        + `currently running on this host is dropped.`;
                },
            }));
            ctx.logger.info('[turma-dsh] send_message tool registered');
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] could not register send_message tool: ${e}`);
        }
    })();
    // ---- peer messaging: RECEIVE (native Claude peer -> dsh) ------------------
    // For a Claude peer's native SendMessage to reach this dsh session, the
    // session must be addressable in Claude Code's OWN session registry: it
    // resolves a name to a `~/.claude/sessions/<pid>.json` record and posts one
    // LDJSON line to that record's messagingSocketPath (XERK-476). A dsh process
    // is not in that registry, so this DRIVER registers a record under its OWN
    // live pid and binds the inbox socket — the pid must be a live process the
    // registry's liveness/peercred checks accept, which the single-pid hub cannot
    // masquerade as per-session, so the driver holds it while the hub still owns
    // resolution, policy and delivery. Received messages are forwarded as
    // `peer_inbound`; the hub applies crossSessionInbound policy before injecting.
    //
    // This depends on Claude Code's PRIVATE, versioned peer-record format (no CI;
    // may drift across Claude releases) — host-verified, not unit-tested.
    let cleanupPeerInbox = () => { };
    if (rcName && claudeSessionsDir) {
        try {
            cleanupPeerInbox = setupPeerInbox();
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] peer inbox setup failed (Claude peers cannot `
                + `reach this dsh session by name): ${e}`);
        }
    }
    function setupPeerInbox() {
        // Claude Code binds inbox sockets under a `cc-socks` dir (see the record's
        // messagingSocketPath) and validates the path shape `cc-socks*/<pid>.sock`;
        // match the dir it uses in this environment.
        const ccDir = env.XDG_RUNTIME_DIR
            ? path.join(env.XDG_RUNTIME_DIR, 'cc-socks') : '/tmp/cc-socks';
        const inboxSock = path.join(ccDir, `${process.pid}.sock`);
        const recordPath = path.join(claudeSessionsDir, `${process.pid}.json`);
        fs.mkdirSync(ccDir, { recursive: true });
        fs.mkdirSync(claudeSessionsDir, { recursive: true });
        try {
            fs.unlinkSync(inboxSock);
        }
        catch { /* no stale socket */ }
        const inbox = net.createServer((sock) => {
            let buf = '';
            sock.on('data', (d) => {
                buf += d.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl < 0) {
                    if (buf.length > LINE_MAX_BYTES) {
                        try {
                            sock.destroy();
                        }
                        catch { /* */ }
                    }
                    return;
                }
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                try {
                    sock.end();
                }
                catch { /* */ }
                if (!line)
                    return;
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    return;
                }
                if (!msg || typeof msg !== 'object')
                    return;
                // Drop a message for a different conversation — the wire session_id
                // names who it is FOR, and a socket at a recycled pid could otherwise
                // deliver a stray. This is the receiver half of what _post_to_inbox's
                // session_id carries.
                if (msg.session_id && msg.session_id !== sessionId)
                    return;
                const text = typeof msg.message?.content === 'string' ? msg.message.content
                    : (typeof msg.message === 'string' ? msg.message : '');
                if (!text.trim())
                    return;
                emit({ evt: 'peer_inbound', from: String(msg.from || 'a peer'), text });
            });
            sock.on('error', () => { });
        });
        inbox.on('error', (e) => ctx.logger.warn(`[turma-dsh] peer inbox error: ${e}`));
        inbox.listen(inboxSock, () => {
            try {
                fs.chmodSync(inboxSock, 0o600);
            }
            catch { /* best effort */ }
            writePeerRecord(inboxSock, recordPath);
            ctx.logger.info(`[turma-dsh] peer inbox bound for '${rcName}' at ${inboxSock}`);
        });
        return () => {
            try {
                inbox.close();
            }
            catch { /* */ }
            try {
                fs.unlinkSync(inboxSock);
            }
            catch { /* */ }
            try {
                fs.unlinkSync(recordPath);
            }
            catch { /* */ }
        };
    }
    // Write the forged Claude-Code session-registry record for this dsh session so
    // a Claude peer's SendMessage resolves its `name` to our inbox socket. The
    // shape mirrors a live Claude record; version/peerFeatures are copied from a
    // real peer record when one exists (Claude may check peer-protocol compat).
    function writePeerRecord(inboxSock, recordPath) {
        let version = '2.1.0';
        let peerFeatures = ['notify_idle'];
        try {
            for (const f of fs.readdirSync(claudeSessionsDir)) {
                if (!f.endsWith('.json'))
                    continue;
                const r = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir, f), 'utf8'));
                if (r && r.peerProtocol === 1 && typeof r.version === 'string') {
                    version = r.version;
                    if (Array.isArray(r.peerFeatures))
                        peerFeatures = r.peerFeatures;
                    break;
                }
            }
        }
        catch { /* fall back to defaults */ }
        let procStart = '0';
        try {
            // field 22 (starttime) of /proc/self/stat, after the ')' that closes comm.
            const stat = fs.readFileSync('/proc/self/stat', 'utf8');
            procStart = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] || '0';
        }
        catch { /* not Linux / no procfs */ }
        let pidDomain = `linux::pid:[0]`;
        try {
            pidDomain = 'linux::' + fs.readlinkSync('/proc/self/ns/pid');
        }
        catch { /* */ }
        const now = Date.now();
        const record = {
            pid: process.pid, sessionId, cwd, startedAt: now,
            procStart, version, peerProtocol: 1, peerFeatures,
            kind: 'interactive', entrypoint: 'cli', pidDomain,
            messagingSocketPath: inboxSock, name: rcName, nameSince: now,
            updatedAt: now, status: 'idle', statusUpdatedAt: now,
        };
        try {
            const tmp = `${recordPath}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(record));
            fs.renameSync(tmp, recordPath);
        }
        catch (e) {
            ctx.logger.warn(`[turma-dsh] could not write peer record: ${e}`);
        }
    }
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
        if (!session)
            return;
        if (session.id === sessionId) {
            writeEvent(event);
            // Learn which children are WORKFLOW agents, so their subagent lifecycle is
            // not ALSO forwarded as a top-level Agent row (they are the run's members).
            if (event.type === 'tool-workflow/agent-start') {
                const d = event.data;
                if (d && typeof d.childId === 'string' && d.childId)
                    workflowChildIds.add(d.childId);
            }
            if (event.type === 'turn/start' || event.type === 'turn/end') {
                // Derive the liveness status from the turn EDGE, not from
                // ctx.agents.get(sessionId).status at emit time: at turn/end the agent
                // has NOT yet settled to idle, so reading .status there pushes a final
                // `running` and no idle edge ever follows. The hub cannot recover from
                // that — dsh_pane_busy is deliberately not age-expired (a long silent
                // tool call must stay `running`) — so a finished dsh session reads
                // "working" forever and never becomes ready-for-review (XERK-479 D3).
                // A turn/start IS the turn beginning (running); a turn/end IS it
                // ending (idle).
                emit({
                    evt: 'state',
                    status: event.type === 'turn/start' ? 'running' : 'idle',
                    eventCount: session.events.length,
                });
            }
            return;
        }
        // A descendant (subagent / workflow-agent) session — capture its native log
        // so the hub projects a per-agent transcript (XERK-474 [J]). In-process
        // providers reach here; a worker-thread workflow agent runs in its own ctx
        // and does NOT (its run RECORD still works from the parent events — see
        // .claude/rules/dsh.md [J]).
        writeChildEvent(session.id, event);
    }, { global: true });
    // ---- subagent lifecycle -> parent-log forward (XERK-474 [J]) --------------
    // dsh's subagent/start & subagent/end are ctx-bus events (they carry the live
    // parent Agent), NOT session-log entries — so they never reach the tail on
    // their own. Forwarded here into the parent native log so [S1] can synthesize
    // the background Agent launch/stop. Global + parent-id filter: the emitter uses
    // scoped dispatch, and we want only OUR session's direct subagents.
    ctx.on('subagent/start', (info, parent) => {
        if (!info || !parent || parent.id !== sessionId)
            return;
        forwardSubagentEdge('start', info);
    }, { global: true });
    ctx.on('subagent/end', (info, parent) => {
        if (!info || !parent || parent.id !== sessionId)
            return;
        forwardSubagentEdge('end', info);
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
        try {
            cleanupPeerInbox();
        }
        catch { /* */ } // drop the forged inbox record + socket
        for (const [rid, resolve] of pending) {
            emit({ evt: 'interaction_end', requestId: rid });
            resolve(null);
        }
        pending.clear();
    }, 'turma-dsh.cleanup');
}
