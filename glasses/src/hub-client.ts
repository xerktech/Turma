import { authHeader, type Config } from "./config.ts";
import type {
  AgentsResponse,
  HistoryPending,
  HistoryResponse,
  SessionAction,
} from "./types.ts";

export interface SpawnOptions {
  repo: string;
  prompt?: string;
  label?: string;
  baseRef?: string;
  model?: string;
  permissionMode?: string;
}

export interface QueuedResponse {
  ok: boolean;
  cmdId: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface HubClientOptions {
  config: Config;
  fetchFn?: typeof fetch;
}

// Typed REST client for the hub API (`turma/server.js`). Every method
// sends the Basic auth header, JSON in/out; every non-2xx response throws an
// HttpError carrying its status — except getHistory's 202 ("still fetching"),
// which is a normal, non-throwing return per the brief's 202-pending pattern.
export class HubClient {
  private readonly config: Config;
  private readonly fetchFn: typeof fetch;

  constructor({ config, fetchFn }: HubClientOptions) {
    this.config = config;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.config.hubUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: authHeader(this.config), ...extra };
  }

  // Every response in 200-299 is treated as success here (fetch's own `ok`);
  // callers that need to distinguish 200 vs 202 (getHistory) don't use this.
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(this.url(path), {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      throw new HttpError(res.status, `hub request failed: ${res.status} ${path}`);
    }
    return (await res.json()) as T;
  }

  listAgents(): Promise<AgentsResponse> {
    return this.request<AgentsResponse>("/api/agents");
  }

  spawnSession(host: string, opts: SpawnOptions): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(`/api/agents/${encodeURIComponent(host)}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  }

  // Resume targets a KILLED session's id (from that host's closedSessions
  // list, see types.ts's ClosedSessionInfo) — same endpoint shape as
  // kill/start/restart (see turma/server.js's sessions/<id>/<action>
  // route and hub-agent.py's SessionManager.resume, which re-registers the
  // closed record and relaunches `claude --resume` on its kept branch).
  sessionAction(host: string, id: string, action: SessionAction): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/${action}`,
      { method: "POST" }
    );
  }

  deleteSession(host: string, id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  sendInput(host: string, id: string, text: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/input`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );
  }

  // 202 ("still fetching", body {pending:true, cmdId}) is a normal return,
  // not a throw — app.ts's session screen polls this every 3s while pending.
  async getHistory(
    host: string,
    id: string
  ): Promise<{ status: 200; body: HistoryResponse } | { status: 202; body: HistoryPending }> {
    const path = `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/history`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    if (!res.ok) {
      throw new HttpError(res.status, `hub request failed: ${res.status} ${path}`);
    }
    const body = await res.json();
    if (res.status === 202) return { status: 202, body: body as HistoryPending };
    return { status: 200, body: body as HistoryResponse };
  }

  wsToken(): Promise<{ token: string; expiresInSec: number }> {
    return this.request<{ token: string; expiresInSec: number }>("/api/ws-token");
  }
}
