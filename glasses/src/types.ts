// Shapes mirrored from the hub's GET /api/agents response and the per-session
// mutation/history endpoints. Source of truth: `turma/server.js` (HTTP
// routes, response envelopes) and `agent/hub-agent.py` (`_session_payload`,
// `_closed_payload`, `session_report`, `build_payload`) on this branch. Only
// the fields this app reads are typed; the real payload carries more (git
// info, memory, logTail, etc.) which callers may ignore via the index
// signatures below.

// A single transcript entry as reported by the agent's cheap tail probe
// (`hub-agent.py:transcript_tail`) — `id` is the transcript entry's `uuid`,
// `role` is its `type` ("user" | "assistant" | ...), `text` is truncated
// message text.
export interface TailEntry {
  id: string;
  role: string;
  text: string;
}

// Per-running-session live signals (`hub-agent.py:session_report`), attached
// as `SessionInfo.session` — null when the session isn't running.
//
// NOTE on `prUrls`: the agent's internal `session_report()` calls this field
// `prUrls`, but `_session_payload()` pops it and republishes the accumulated,
// still-unseen-by-hub set as `newPrUrls` before it ever reaches the wire —
// that's the field name actually present in the heartbeat payload this app
// polls. We name it `newPrUrls` here to match the real payload; treat it as
// "PR links to surface that we haven't shown yet".
export interface LiveSignals {
  bridgeAttached: boolean;
  transcriptAgeSec: number | null;
  lastRole: string | null;
  lastHasToolUse: boolean;
  question: string | null;
  questionOptions: string[];
  tail: TailEntry[];
  newPrUrls: string[];
}

export type SessionStatus = "running" | "stopped" | "error";

export interface UsagePeriod {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  cost?: number;
}

export interface UsageSummary {
  today?: UsagePeriod;
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  repo: string;
  branch?: string;
  label?: string | null;
  // Agent-generated few-word task name (hub-agent.py `_session_payload`),
  // filled in async at spawn from the initial prompt. Null for bare/root
  // spawns that had no prompt, or until the summary lands.
  summary?: string | null;
  status: SessionStatus;
  model?: string | null;
  permissionMode?: string | null;
  createdAt?: string | null;
  stoppedAt?: string | null;
  errorMsg?: string | null;
  usage?: UsageSummary | null;
  session: LiveSignals | null;
  [key: string]: unknown;
}

export interface ClosedSessionInfo {
  id: string;
  repo: string;
  branch?: string;
  label?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  [key: string]: unknown;
}

export interface RepoInfo {
  name: string;
  path: string;
  // The REPOS_ROOT pseudo-repo (name ROOT_REPO_NAME): a session spawned against
  // it runs directly at the repos root, no worktree/branch. See hub-agent.py's
  // root_repo_entry / spawn.
  isRoot?: boolean;
  [key: string]: unknown;
}

export interface AgentInfo {
  key: string; // stable host key (the `/api/agents/<host>/...` path segment)
  device?: string;
  online: boolean;
  terminalOnline?: boolean;
  repos: RepoInfo[];
  sessions: SessionInfo[];
  closedSessions: ClosedSessionInfo[];
  [key: string]: unknown; // startedAt, memory, logTail, reposRoot, ...
}

export interface AgentsResponse {
  now: number;
  agents: AgentInfo[];
}

// GET .../sessions/<id>/history — the "resolved" 200 response.
export interface HistoryResponse {
  entries: TailEntry[];
  truncated: boolean;
  fetchedAt: number;
}

// GET .../sessions/<id>/history — the "still fetching" 202 response.
export interface HistoryPending {
  pending: true;
  cmdId: string;
}

export type SessionAction = "kill" | "start" | "restart" | "resume";

// A session flattened together with the host that owns it (and that host's
// online-ness) — the unit the UI lists, scrolls, and acts on.
export interface SessionRef {
  hostKey: string;
  device: string;
  online: boolean;
  session: SessionInfo;
}

// Glasses input gestures — the entire vocabulary the hardware (or the DOM dev
// backend) can produce. Tasks 6/7 wire the real input router; this app only
// ever reacts to these four.
export type InputEventType = "tap" | "doubleTap" | "scrollUp" | "scrollDown";
export interface InputEvent {
  type: InputEventType;
}
