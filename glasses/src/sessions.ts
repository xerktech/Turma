// Pure helpers over the /api/agents payload: flatten host→session, derive the
// glanceable live-state, and order sessions the way the glasses should show
// them (the ones that need you first).

import type { Agent, Session, SessionRef, LiveState } from "./types.js";

// Matches the hub's WORKING_WINDOW_MS: a session counts as working while its
// transcript was written within this window.
const WORKING_WINDOW_SEC = 90;

export function flattenSessions(agents: Agent[]): SessionRef[] {
  const out: SessionRef[] = [];
  for (const a of agents) {
    for (const s of a.sessions || []) {
      out.push({ hostKey: a.key, device: a.device || a.key, session: s });
    }
  }
  return out;
}

export function liveState(s: Session): LiveState {
  if (s.status === "error") return "error";
  if (s.status !== "running") return "stopped";
  const sig = s.session;
  if (sig?.question) return "waiting";
  if (sig && sig.transcriptAgeSec != null && sig.transcriptAgeSec < WORKING_WINDOW_SEC) {
    return "working";
  }
  return "idle";
}

const ORDER: Record<LiveState, number> = {
  waiting: 0,
  working: 1,
  idle: 2,
  error: 3,
  stopped: 4,
};

// Waiting-on-you first, then working, then quiet, then stopped; stable by id
// within a bucket so the list doesn't jitter between polls.
export function sortSessions(refs: SessionRef[]): SessionRef[] {
  return [...refs].sort((x, y) => {
    const d = ORDER[liveState(x.session)] - ORDER[liveState(y.session)];
    return d !== 0 ? d : x.session.id.localeCompare(y.session.id);
  });
}

export function findRef(refs: SessionRef[], hostKey: string, id: string): SessionRef | undefined {
  return refs.find((r) => r.hostKey === hostKey && r.session.id === id);
}

export function waitingCount(refs: SessionRef[]): number {
  return refs.filter((r) => liveState(r.session) === "waiting").length;
}
