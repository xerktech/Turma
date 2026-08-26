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
interface Disposable {
    (): void;
}
interface Context {
    agents: AgentRegistry;
    userQuestions?: UserQuestionService;
    approval?: ApprovalService;
    systemPrompt?: SystemPromptService;
    tools?: {
        register(definition: unknown): () => void;
    };
    get(name: string): any;
    on(name: string, listener: (...args: any[]) => any, options?: boolean | {
        global?: boolean;
    }): Disposable;
    effect(execute: () => Disposable | void, label?: string): unknown;
    logger: {
        info(m: string): void;
        warn(m: string): void;
        error(m: string): void;
    };
}
interface AgentRegistry {
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
    get(id: string): Agent | undefined;
}
interface CreateAgentOptions {
    sessionId: string;
    meta?: {
        cwd?: string;
        agentPreset?: string;
    };
    agentOptions?: {
        provider?: string;
        model?: string;
        maxTokens?: number;
    };
    setup?: (agentCtx: unknown) => void | Promise<void>;
}
interface ResumeAgentOptions {
    resumeSessionId: string;
    agentOptions?: {
        provider?: string;
        model?: string;
        maxTokens?: number;
    };
    setup?: (agentCtx: unknown) => void | Promise<void>;
}
interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
}
interface Agent {
    id: string;
    status: 'idle' | 'running';
    session: {
        id: string;
        events: unknown[];
    };
    followup(message: UserMessage): void;
    cancel(cause: {
        kind: string;
        reason?: string;
    }): void;
}
interface UserMessage {
    id: string;
    role: 'user';
    content: Array<{
        type: 'text';
        text: string;
    }>;
    source: {
        kind: string;
        plugin?: string;
        form?: string;
    };
}
interface ApprovalService {
    setPolicy?(agent: Agent, policy: string): void;
}
interface UserQuestionService {
    registerProvider(provider: {
        ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
    }): Disposable;
}
interface AskUserQuestionRequest {
    questions: AskUserQuestionItem[];
    agent?: Agent;
    signal?: AbortSignal;
}
interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: Array<{
        label: string;
        description?: string;
    }>;
    multiSelect?: boolean;
}
interface AskUserQuestionAnswer {
    answers: Array<{
        id: string;
        selected: string[];
        custom?: string;
    }>;
}
interface SystemPromptService {
    section(spec: {
        name: string;
        order: number;
        text: string;
    }): Disposable;
}
export interface Config {
    provider?: string;
    model?: string;
}
export declare const name = "turma-dsh-session-driver";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
export {};
