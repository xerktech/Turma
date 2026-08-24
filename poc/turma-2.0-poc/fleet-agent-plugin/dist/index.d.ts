/**
 * @turma/dsh-fleet-agent
 *
 * Real dsh plugin that connects a dsh instance to the Turma Fleet Hub.
 * Streams session events to the hub and handles commands (spawn, input, kill).
 */
interface Context {
    sessions: SessionStore;
    agents: AgentRegistry;
    on(event: string, handler: (...args: unknown[]) => void, options?: {
        global?: boolean;
    }): () => void;
    effect(fn: () => (() => void) | void, name?: string): void;
    logger: {
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
}
interface SessionStore {
    list(): Session[];
    get(id: string): Session | undefined;
    create(id?: string, options?: CreateSessionOptions): Session;
}
interface CreateSessionOptions {
    seed?: SessionEvent[];
    meta?: SessionMeta;
}
interface SessionMeta {
    cwd?: string;
    createdAt?: number;
    parentSession?: string;
    origin?: {
        type: string;
        host?: string;
    };
}
interface Session {
    id: string;
    header: SessionHeader;
    events: SessionEvent[];
    append(type: string, data: unknown): SessionEvent;
}
interface SessionHeader {
    id: string;
    cwd?: string;
    createdAt: number;
    parentSession?: string;
    origin?: {
        type: string;
        host?: string;
    };
}
interface SessionEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
}
interface AgentRegistry {
    get(id: string): Agent | undefined;
    resume(options: ResumeOptions): Promise<{
        agent: Agent;
    }>;
}
interface ResumeOptions {
    resumeSessionId?: string;
    cwd?: string;
    prompt?: string;
    agentOptions?: AgentOptions;
}
interface AgentOptions {
    instructions?: string;
}
interface Agent {
    id: string;
    session: Session;
    status: 'running' | 'idle';
    inbox: {
        append(target: 'next-turn' | 'next-step', message: UserMessage): void;
    };
    cancel(): Promise<void>;
}
interface UserMessage {
    id: string;
    role: 'user';
    source: {
        kind: string;
        clientId?: string;
    };
    content: Array<{
        type: 'text';
        text: string;
    }>;
}
export interface Config {
    hubUrl: string;
    device: string;
}
export declare const name = "turma-fleet-agent";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
export {};
