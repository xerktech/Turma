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
    return `${this.hubBase()}${path}`;
  }

  // The hub origin without a trailing slash — for the terminal iframe URL.
  hubBase(): string {
    return this.config.hubUrl.replace(/\/$/, "");
  }

  // The raw ttyd terminal URL (reverse-tunnelled, keyed by session id — the hub
  // routes by id, not host+id; matches the Android app). Needs the session
  // cookie planted first (loginForCookie).
  termUrl(sessionId: string): string {
    return `${this.hubBase()}/term/${encodeURIComponent(sessionId)}/`;
  }

  // Plant the hub's session cookie so the cross-origin terminal iframe (and its
  // wss socket) authenticate. POSTs /api/login with the stored credentials and
  // `credentials:"include"`, exactly as the web login does. Best-effort.
  async loginForCookie(): Promise<void> {
    try {
      await this.fetchFn(this.url("/api/login"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.config.user, password: this.config.password }),
      });
    } catch {
      /* offline / blocked — the iframe falls back to the hub's own login */
    }
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

  // Answer a pending AskUserQuestion: `optionIndex` is the 0-based option pick
  // (-1 for a pure free-text answer), `custom` carries free-text / "Other".
  // The agent drops the answer file the session's ask.py bridge is blocked on.
  answerQuestion(
    host: string,
    id: string,
    answer: { optionIndex?: number; custom?: string }
  ): Promise<QueuedResponse> {
    const body: { optionIndex: number; custom?: string } = {
      optionIndex: Number.isInteger(answer.optionIndex) ? (answer.optionIndex as number) : -1,
    };
    if (answer.custom) body.custom = answer.custom;
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  // ---- Board (Jira/Azure) — same endpoints the web board.html uses ----------

  // A ticket's full detail (description, comments, statusOptions). 202 means the
  // agent is still fetching it — the caller polls, like the web board.
  async jiraDetail(
    siteKey: string,
    key: string
  ): Promise<{ status: 200; body: Record<string, unknown> } | { status: 202; body: { pending: true; cmdId: string } }> {
    const path = `/api/jira/${encodeURIComponent(siteKey)}/${encodeURIComponent(key)}`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    if (!res.ok) throw new HttpError(res.status, `hub request failed: ${res.status} ${path}`);
    const body = await res.json();
    return res.status === 202 ? { status: 202, body } : { status: 200, body };
  }

  private jiraPost(siteKey: string, key: string, action: string, body: unknown): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/jira/${encodeURIComponent(siteKey)}/${encodeURIComponent(key)}/${action}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
  }

  // Start a session on a ticket (the card's start button).
  startTicket(siteKey: string, key: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(`/api/jira/${encodeURIComponent(siteKey)}/${encodeURIComponent(key)}/session`, { method: "POST" });
  }
  setTicketStatus(siteKey: string, key: string, body: { value?: string; category?: string }): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "status", body);
  }
  setTicketRepo(siteKey: string, key: string, body: unknown): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "repo", body);
  }
  setTicketAgent(siteKey: string, key: string, body: unknown): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "agent", body);
  }
  setTicketModel(siteKey: string, key: string, body: unknown): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "model", body);
  }
  jiraRefresh(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/api/jira/refresh", { method: "POST" });
  }

  // Flip an org's hub-side auto-start opt-in (the org menu's "auto" toggle,
  // XERK-41). Same endpoint the web org.js POSTs; the hub is authoritative on
  // return and its next heartbeat carries the settled `autoStartOrgs`.
  setAutoStart(siteKey: string, enabled: boolean): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/api/jira/${encodeURIComponent(siteKey)}/autostart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }
    );
  }

  // New-ticket create flow (the shared "New ticket" control). All three are the
  // same endpoints the web newticket.js uses; 202 = "still fetching", polled by
  // the caller.
  async createMeta(
    siteKey: string,
    project?: string
  ): Promise<{ status: 200; body: Record<string, unknown> } | { status: 202; body: Record<string, unknown> }> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const path = `/api/jira/${encodeURIComponent(siteKey)}/create-meta${q}`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new HttpError(res.status, (body as { error?: string }).error || `HTTP ${res.status}`);
    return res.status === 202 ? { status: 202, body } : { status: 200, body };
  }
  createTicket(siteKey: string, body: { project: string; issueType: string; summary: string; description?: string; labels?: string[] }): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(`/api/jira/${encodeURIComponent(siteKey)}/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async createResult(
    siteKey: string,
    cmdId: string
  ): Promise<{ status: 200; body: Record<string, unknown> } | { status: 202; body: Record<string, unknown> }> {
    const path = `/api/jira/${encodeURIComponent(siteKey)}/tickets/${encodeURIComponent(cmdId)}`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new HttpError(res.status, (body as { error?: string }).error || `HTTP ${res.status}`);
    return res.status === 202 ? { status: 202, body } : { status: 200, body };
  }

  // Interrupt the in-flight turn (web "◼ Stop") — leaves the session + conversation
  // intact. No body.
  interrupt(host: string, id: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/interrupt`,
      { method: "POST" }
    );
  }

  // Rename a session (web ⋯ → Rename). A blank summary clears the name back to
  // the auto/label fallback.
  setSummary(host: string, id: string, summary: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      }
    );
  }
}
