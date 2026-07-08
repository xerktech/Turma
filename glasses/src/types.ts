// Shapes mirrored from the hub's GET /api/agents response, which relays the
// agent heartbeat payload verbatim (see agent/hub-agent.py:build_payload and
// agent-hub/server.js). Only the fields this app reads are typed; the payload
// carries more.

export interface TailMessage {
  role: "user" | "assistant";
  text: string;
}

// Per-running-session live signals (agent/hub-agent.py:session_report).
export interface SessionSignals {
  transcriptAgeSec: number | null;
  lastRole: string | null;
  question: string | null; // pending AskUserQuestion, if the session is waiting
  tail: TailMessage[]; // readable conversation tail for small screens
  newPrUrls?: string[];
}

export interface SessionUsage {
  totalUsd?: number;
  // ...other usage fields exist but aren't surfaced on the glasses.
}

export interface Session {
  id: string;
  repo: string;
  branch?: string;
  label?: string | null;
  model?: string | null;
  status: "running" | "stopped" | "error";
  errorMsg?: string | null;
  session: SessionSignals | null; // running only; null otherwise
  usage?: SessionUsage | null;
}

export interface ClosedSession {
  id: string;
  repo: string;
  branch?: string;
  label?: string | null;
  closedAt?: string;
}

export interface Repo {
  name: string;
  path?: string;
}

export interface Agent {
  key: string; // stable host key (containerName) — the API path segment
  device?: string; // friendly host name
  online: boolean;
  repos?: Repo[];
  sessions?: Session[];
  closedSessions?: ClosedSession[];
}

export interface AgentsResponse {
  now: number;
  agents: Agent[];
}

// A session flattened together with the host that owns it — the unit the UI
// lists and acts on.
export interface SessionRef {
  hostKey: string;
  device: string;
  session: Session;
}

export type LiveState = "working" | "waiting" | "idle" | "stopped" | "error";
