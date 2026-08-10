import type { AgentInfo, PrInfo, SessionInfo, SessionRef } from "./types.ts";

export type LiveState = "working" | "waiting" | "idle" | "stopped" | "error";

// "pending" is not a live-server state — it's an app-layer overlay app.ts
// paints over a session's glyph right after queuing a mutation, until the
// next poll shows convergence or a 60s timeout. See app.ts's pending map.
export type DisplayState = LiveState | "pending";

const WORKING_WINDOW_MS = 90 * 1000;
// Mirrors the hub's OFFLINE_AFTER_MS: beats arrive every ~20s.
const OFFLINE_AFTER_MS = 75 * 1000;

// Precedence: error > stopped > waiting > working > idle. "working" is read
// straight off the session's TUI (paneBusy: the "esc to interrupt" hint is on
// screen iff the model is actively working), falling back to transcript
// freshness only when the agent didn't report paneBusy (older agent, or the
// pane couldn't be captured).
export function liveState(
  s: SessionInfo,
  hostLastSeen?: number,
  now?: number,
): LiveState {
  if (s.status === "error") return "error";
  if (s.status === "stopped") return "stopped";
  const live = s.session;
  if (live?.question) return "waiting";
  // Two rules the web applies and this did not (XERK-235), in the web's order:
  // no transcript yet is IDLE before paneBusy is consulted, and working requires
  // the HOST to be online — paneBusy is a value on the record the host last
  // pushed, so a host that dies mid-turn reads WORKING forever. Both host
  // arguments are optional: a caller that cannot supply them keeps the old
  // behaviour rather than reading every session as idle.
  if (live?.transcriptAgeSec == null) return "idle";
  if (hostLastSeen != null && (now ?? Date.now()) - hostLastSeen >= OFFLINE_AFTER_MS) {
    return "idle";
  }
  // Background agents are what paneBusy cannot see (XERK-245): a session that
  // delegated work and ended its own turn paints no interrupt hint, so it read
  // idle here while an agent was still running. Checked after the offline gate
  // for the same reason paneBusy is — this too is a value on a pushed record.
  if (hasLiveAgents(live)) return "working";
  const working = live?.paneBusy != null
    ? live.paneBusy
    : live.transcriptAgeSec * 1000 < WORKING_WINDOW_MS;
  return working ? "working" : "idle";
}

// Does the session have background agents in flight? Older agents report none,
// which reads as "can't tell" and leaves the paneBusy behaviour untouched.
export function hasLiveAgents(live: SessionInfo["session"]): boolean {
  return (live?.agents?.length ?? 0) > 0;
}

// Has this PR left the operator's plate? MERGED/CLOSED are the two end states;
// everything else — OPEN, DRAFT, and an unfetched/unknown state — counts as
// still live. An unreadable state must never be what drops work off the list.
const prLanded = (p: PrInfo): boolean =>
  ["MERGED", "CLOSED"].includes((p?.state ?? "").toUpperCase());

// "Ready for review" (XERK-224): a running session that has stopped and is now
// waiting on the OPERATOR rather than on itself — its own section above Active,
// because a working session is one to leave alone and this is the work to look
// at. A port of the web's `readyForReview` (turma/public/sessions.html), which
// the hub's ready-for-review alert (turma/server.js) and the Android client
// (core/Sessions.kt) mirror too; all four agree on what the group means.
//
// Derived from the signals alone — there is no "I've reviewed this" action, so
// a qualifying session stays listed until it runs again or its PR lands. It
// qualifies on a pending question (blocked on a human, whatever the busy read
// says), a PR that hasn't landed (a diff to read), or a finished turn — newest
// entry is plain assistant output with nothing pending, the only trace a
// research task that never opened a PR leaves behind. A session that opened a
// PR is judged on the PR alone: every one merged or closed IS the review, and
// drops it back to Idle.
export function readyForReview(
  s: SessionInfo,
  hostLastSeen?: number,
  now?: number,
): boolean {
  const state = liveState(s, hostLastSeen, now);
  if (state === "waiting") return true;
  if (state !== "idle") return false;
  const live = s.session;
  if (!live) return false;
  const prs = s.prs ?? [];
  if (prs.some((p) => !prLanded(p))) return true;   // an unlanded PR is a diff to read
  // Landed PRs stop being a reason to look, but must not become a reason NOT
  // to: the same session can be given a new task after the merge and would
  // otherwise be hidden for good. The demotion expires once the conversation
  // moves past the landing (`newWorkSincePrs`, XERK-224).
  if (prs.length && !s.newWorkSincePrs) return false;
  return live.lastRole === "assistant" && !live.lastHasToolUse;
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
