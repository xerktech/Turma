import type { AgentInfo, SessionInfo, SessionRef } from "./types.ts";

export type LiveState = "working" | "waiting" | "idle" | "stopped" | "error";

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
