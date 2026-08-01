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
  // The rich per-entry blocks the hub's /live + /history already deliver
  // (thinking, tool_use/tool_result, code, pr_link, interrupt, …; see
  // hub-agent.py `_entry_blocks`). The glasses flatten to `text`; the native
  // phone UI (XERK-171) keeps these and renders them through the vendored
  // chat.js engine for full transcript parity. Untyped payload — the engine
  // reads the shapes.
  blocks?: { t: string; [key: string]: unknown }[];
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
  // Live TUI probe: true = the model is actively working ("esc to interrupt"
  // hint on screen), false = resting, null = unknown (fall back to
  // transcriptAgeSec). Absent from older agents.
  paneBusy?: boolean | null;
  transcriptAgeSec: number | null;
  lastRole: string | null;
  lastHasToolUse: boolean;
  question: string | null;
  questionOptions: string[];
  tail: TailEntry[];
  newPrUrls: string[];
}

export type SessionStatus = "running" | "stopped" | "error" | "queued";

export interface UsagePeriod {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export interface UsageSummary {
  today?: UsagePeriod;
  week?: UsagePeriod;
  totals?: UsagePeriod;
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
  // Card chips (XERK-171 full parity): the PR status pills a session opened, the
  // Jira/Azure ticket it works, and — for a queued session — why it's waiting.
  prs?: PrInfo[] | null;
  ticket?: { key?: string; siteKey?: string; url?: string; [key: string]: unknown } | null;
  queuedReason?: string | null;
  [key: string]: unknown;
}

// A PR's status as the agent reports it (hub-agent.py `pr_status`). Rendered as
// the GitHub-style pill (state colour + #number + ✓/✗/● readiness mark).
export interface PrInfo {
  url?: string;
  number?: number;
  state?: string; // Open | Draft | Merged | Closed
  checks?: string | null; // passing | failing | pending
  ready?: string | null; // ready | blocked | pending
  mergeable?: string | null;
  title?: string;
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
  // The tracker org this host polls (a host polls exactly one). Only `siteKey`
  // is read here — it's what the phone-side org filter partitions the fleet by
  // (XERK-171), matching the web dashboard's org.js `siteKeyOf`. The real block
  // carries far more (tickets, status, …), ignored via the index signature.
  jira?: { siteKey?: string | null; orgName?: string | null; [key: string]: unknown } | null;
  [key: string]: unknown; // startedAt, memory, logTail, reposRoot, ...
}

export interface AgentsResponse {
  now: number;
  agents: AgentInfo[];
  // Top-level fleet state the board reads (XERK-171): the hub's manual org-colour
  // pins (siteKey -> palette slot 1..8), so a card's tint matches the web/Android
  // exactly. The plugin used to drop this, which made its colours diverge.
  orgColors?: Record<string, number>;
  // The hub's per-org auto-start opt-in (XERK-41): siteKey -> true when the org
  // auto-starts a session for every To Do ticket with a repo. Presence = enabled.
  autoStartOrgs?: Record<string, boolean>;
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
