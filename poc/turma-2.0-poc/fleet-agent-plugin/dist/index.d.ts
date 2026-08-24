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
    /**
     * Opaque per-process identity, echoed back by the hub on /api/agents.
     * A device NAME cannot prove which process is connected -- an abandoned
     * instance reconnects under the same name -- so a harness that needs to
     * assert "the dsh I just started is the one registered" matches on this.
     *
     * Prefer the TURMA_FLEET_INSTANCE_ID environment variable (read below).
     * Setting it HERE is unsafe for that purpose: this file is a dsh config,
     * dsh hot-reloads config, and every dsh sharing the DSH_HOME reads the same
     * one -- so an abandoned instance adopts whatever id is written here and
     * reports it as its own. An environment variable is fixed per process at
     * exec time and cannot be adopted by an already-running one.
     */
    instanceId?: string;
}
export declare const name = "turma-fleet-agent";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
export {};
