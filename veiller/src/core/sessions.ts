import type { AgentInfo, SessionInfo, SessionRef } from "./types.ts";

// "queued" added in the Veiller port: upstream liveState never handled the
// newer "queued" SessionStatus, so a queued session fell through to the live-
// signal heuristics and read as "idle". It renders like the app-layer
// "pending" overlay (glyph "…") — the session is waiting to start.
export type LiveState = "working" | "waiting" | "idle" | "stopped" | "error" | "queued";

// "pending" is not a live-server state — it's an app-layer overlay app.ts
// paints over a session's glyph right after queuing a mutation, until the
// next poll shows convergence or a 60s timeout. See app.ts's pending map.
export type DisplayState = LiveState | "pending";

const WORKING_WINDOW_MS = 90 * 1000;

// Precedence: error > stopped > waiting > working > idle. "working" is read
// straight off the session's TUI (paneBusy: the "esc to interrupt" hint is on
// screen iff the model is actively working), falling back to transcript
// freshness only when the agent didn't report paneBusy (older agent, or the
// pane couldn't be captured).
export function liveState(s: SessionInfo): LiveState {
  if (s.status === "error") return "error";
  if (s.status === "stopped") return "stopped";
  if (s.status === "queued") return "queued"; // port fix: see LiveState note above
  const live = s.session;
  if (live?.question) return "waiting";
  const working = live?.paneBusy != null
    ? live.paneBusy
    : (live?.transcriptAgeSec != null && live.transcriptAgeSec * 1000 < WORKING_WINDOW_MS);
  return working ? "working" : "idle";
}

// Leading status icon on each home-menu session row — chosen to be
// glanceable on the G2's tiny monochrome display, with the two states the
// user acts on made loud: "!" = actively working, "?" = a question from
// Claude is waiting on you. Idle stays a quiet "-". ("!" used to mean error;
// error moved to "x" so "!" can carry the more common working state.)
const GLYPHS: Record<DisplayState, string> = {
  working: "!",
  waiting: "?",
  idle: "-",
  stopped: "o",
  error: "x",
  pending: "…",
  queued: "…", // port fix: queued renders like pending (waiting to start)
};

export function glyph(state: DisplayState): string {
  return GLYPHS[state];
}

// The user-facing name for a session row: the agent-generated few-word task
// summary when it has one, else the short session id as a disambiguating
// fallback (bare spawns and the repos-root pseudo-repo get no summary).
export function sessionName(s: SessionInfo): string {
  const summary = s.summary?.trim();
  return summary || s.id.slice(0, 6);
}

// The tracker org a host belongs to — a host with no tracker creds reports no
// jira block and belongs to no org (empty key). Mirrors the web dashboard's
// org.js `siteKeyOf`, the pure half of the phone-side org filter (XERK-171).
export function siteKeyOf(agent: AgentInfo): string {
  return (agent.jira && agent.jira.siteKey) || "";
}

// The fleet scoped to one org. An empty key ("all orgs") is the identity. The
// phone's org filter (owned by the embedded web pages) drives this so the
// glasses home list shows the same org the phone does. Mirrors org.js's
// `filterAgents`.
export function filterAgents(agents: AgentInfo[], key: string): AgentInfo[] {
  if (!key) return agents;
  return agents.filter((a) => siteKeyOf(a) === key);
}

// Flattens every host's sessions into one list, hosts sorted by device name
// (falling back to the host key), sessions within a host sorted by
// createdAt (missing createdAt sorts first).
export function flattenSessions(agents: AgentInfo[]): SessionRef[] {
  const hosts = [...agents].sort((a, b) => (a.device ?? a.key).localeCompare(b.device ?? b.key));
  const out: SessionRef[] = [];
  for (const agent of hosts) {
    const sessions = [...(agent.sessions ?? [])].sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
    );
    for (const session of sessions) {
      out.push({ hostKey: agent.key, device: agent.device ?? agent.key, online: agent.online, session });
    }
  }
  return out;
}
