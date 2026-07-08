// Typed client for the AgentHub REST API. Every session action the dashboard
// exposes has an endpoint here; the two glasses-specific ones (readable tail,
// voice input) ride the same API the browser UI uses:
//   GET    /api/agents                               — hosts + repos + sessions
//   POST   /api/agents/<host>/sessions               — spawn {repo, ...}
//   POST   /api/agents/<host>/sessions/<id>/<action> — kill|start|restart|resume
//   POST   /api/agents/<host>/sessions/<id>/input    — {text}  (voice-dictated)
//   DELETE /api/agents/<host>/sessions/<id>          — delete
//
// Session commands are queued on the hub and drained by the owning agent on its
// next heartbeat, so a 200 here means "accepted", not "done" — the effect shows
// up on a later GET /api/agents.

import type { AgentsResponse } from "./types.js";
import { authHeader, type HubConfig } from "./config.js";

export type SessionAction = "kill" | "start" | "restart" | "resume";

export interface SpawnOptions {
  prompt?: string;
  label?: string;
  baseRef?: string;
  branchName?: string;
  model?: string;
  permissionMode?: string;
}

export class HubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export class HubClient {
  constructor(private cfg: HubConfig) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...authHeader(this.cfg) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.cfg.url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HubError(0, `network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    const data = text ? safeParse(text) : null;
    if (!res.ok) {
      const err =
        data && typeof data === "object" ? (data as { error?: string }).error : undefined;
      throw new HubError(res.status, err || `HTTP ${res.status}`);
    }
    return data as T;
  }

  listAgents(): Promise<AgentsResponse> {
    return this.req<AgentsResponse>("GET", "/api/agents");
  }

  spawn(hostKey: string, repo: string, opts: SpawnOptions = {}): Promise<{ cmdId: string }> {
    return this.req("POST", `/api/agents/${enc(hostKey)}/sessions`, { repo, ...opts });
  }

  sessionAction(hostKey: string, id: string, action: SessionAction): Promise<{ cmdId: string }> {
    return this.req("POST", `/api/agents/${enc(hostKey)}/sessions/${enc(id)}/${action}`);
  }

  deleteSession(hostKey: string, id: string): Promise<{ cmdId: string }> {
    return this.req("DELETE", `/api/agents/${enc(hostKey)}/sessions/${enc(id)}`);
  }

  // Voice-dictated (or typed) input, typed into the session's Claude prompt and
  // submitted. The hub caps text at 4000 chars; the agent flattens newlines.
  sendInput(hostKey: string, id: string, text: string): Promise<{ cmdId: string }> {
    return this.req("POST", `/api/agents/${enc(hostKey)}/sessions/${enc(id)}/input`, { text });
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
