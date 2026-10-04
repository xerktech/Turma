import type { AgentInfo, PrInfo, SessionInfo, SessionRef } from "./types.ts";

// "holding" (XERK-1570): every live background row is a WAITING shell (a sleep,
// a CI watch) — not working, and not the operator's yet. Stalled waits read
// "idle", so a dead shell surfaces like any finished session. A session ASLEEP
// until a session-CLI wake (XERK-1571) is "holding" too.
export type LiveState = "working" | "waiting" | "holding" | "idle" | "stopped" | "error";

// "pending" is not a live-server state — it's an app-layer overlay app.ts
// paints over a session's glyph right after queuing a mutation, until the
// next poll shows convergence or a 60s timeout. See app.ts's pending map.
export type DisplayState = LiveState | "pending";

const WORKING_WINDOW_MS = 90 * 1000;
// Mirrors the hub's OFFLINE_AFTER_MS: beats arrive every ~20s.
const OFFLINE_AFTER_MS = 75 * 1000;
// The hub's ATTENTION_WAIT_STALL_MIN default and its ETA grace (server.js).
const WAIT_STALL_MS = 45 * 60 * 1000;
const WAIT_ETA_GRACE_MS = 2 * 60 * 1000;

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
    // A sleep is not a pushed busy read: the hub honours a pending wake on an
    // offline host too (sessionSleeping has no online gate), so this does.
    return sleeping(live, now ?? Date.now()) ? "holding" : "idle";
  }
  // Background agents are what paneBusy cannot see (XERK-245): a session that
  // delegated work and ended its own turn paints no interrupt hint, so it read
  // idle here while an agent was still running. Checked after the offline gate
  // for the same reason paneBusy is — this too is a value on a pushed record.
  //
  // Only WORK rows count (XERK-1570): a waiting shell is not working.
  if (hasLiveWork(live)) return "working";
  const working = live?.paneBusy != null
    ? live.paneBusy
    : !hasLiveAgents(live) && live.transcriptAgeSec * 1000 < WORKING_WINDOW_MS;
  if (working) return "working";
  const t = now ?? Date.now();
  // Asleep until a session-CLI wake (XERK-1571) — mirror of server.js
  // sessionSleeping: never ready for review until the wake is due.
  if (sleeping(live, t)) return "holding";
  const wait = backgroundWait(live?.agents, (hostLastSeen ?? t) - live.transcriptAgeSec * 1000, t);
  return wait?.state === "waiting" ? "holding" : "idle";
}

type LiveAgentRow = NonNullable<NonNullable<SessionInfo["session"]>["agents"]>[number];

// A background row that is WAITING (XERK-1570). No kind — an agent/workflow row,
// or an agent predating the field — is work.
export function isWaitRow(a: LiveAgentRow | null | undefined): boolean {
  return !!a && (a.kind === "wait-timed" || a.kind === "wait-external");
}

// A session-CLI wake still in the future (XERK-1571).
export function sleeping(live: SessionInfo["session"], now: number): boolean {
  const w = live?.wakeAt;
  return typeof w === "number" && Number.isSafeInteger(w) && w > now;
}

// Does the session have background WORK in flight (any row that isn't a wait)?
export function hasLiveWork(live: SessionInfo["session"]): boolean {
  return (live?.agents ?? []).some((a) => !isWaitRow(a));
}

export interface BackgroundWait { state: "waiting" | "stalled"; eta: number | null }

// Mirror of the hub's backgroundWait (server.js): null with no wait rows; an
// ETA still ahead is waiting; past it (plus grace) with no transcript write
// since, or silent WAIT_STALL_MS with no ETA ahead, is stalled.
export function backgroundWait(rows: LiveAgentRow[] | undefined, lastWrite: number, now: number): BackgroundWait | null {
  const waits = (rows ?? []).filter(isWaitRow);
  if (!waits.length) return null;
  let eta: number | null = null;
  for (const a of waits) {
    if (typeof a.eta === "number" && Number.isSafeInteger(a.eta) && (eta == null || a.eta > eta)) eta = a.eta;
  }
  if (eta != null && eta > now) return { state: "waiting", eta };
  const overdue = eta != null && lastWrite < eta && now - eta >= WAIT_ETA_GRACE_MS;
  const silent = now - lastWrite >= WAIT_STALL_MS;
  return { state: overdue || silent ? "stalled" : "waiting", eta };
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
  if (state !== "idle") return false;   // working, holding (XERK-1570), or not live
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

// Is this session in the Ready for review group (XERK-1571, web sessions.html
// `inReview`)? Where the hub serves an attention state it DECIDES: every
// needs-you:* session is listed (question, permission, review, stalled) and
// nothing else — the set the dashboard's Ready-for-review tile counts. From an
// older hub (no attention) the local readyForReview port decides, as before.
// On an OFFLINE host the hub's state is frozen at its last beat, so a
// non-needs-you one must not keep stranded work out: the local rule decides
// it too (XERK-235).
export function inReview(s: SessionInfo, hostLastSeen?: number, now?: number): boolean {
  const st = s.attention?.state;
  if (typeof st === "string" && st.startsWith("needs-you:")) return true;
  if (hostLastSeen != null && (now ?? Date.now()) - hostLastSeen >= OFFLINE_AFTER_MS) {
    return readyForReview(s, hostLastSeen, now);
  }
  if (typeof st === "string" && st) return false;
  return readyForReview(s, hostLastSeen, now);
}

// The wait classifier's verdict on a needs-you card (XERK-1572, web sessions.html
// `attentionHint`): "decision · Pick v2 or v3" and the answer it suggests. Empty
// strings when the hub serves none, or the session no longer needs the operator.
const HINT_KIND: Record<string, string> = {
  "rubber-stamp": "go-ahead", "design-decision": "decision", "needs-human-test": "needs a human test",
  "blocked-on-host": "blocked on the host", looping: "looping", "waiting-external": "waiting on something outside",
};
export function attentionHint(s: SessionInfo): { line: string; answer: string } {
  const att = s.attention;
  const h = att?.hint;
  if (!att || !att.state.startsWith("needs-you:") || !h || typeof h.why !== "string" || !h.why) {
    return { line: "", answer: "" };
  }
  const kind = HINT_KIND[h.label] ?? "";
  return { line: kind ? `${kind} · ${h.why}` : h.why,
           answer: typeof h.suggestedAnswer === "string" ? h.suggestedAnswer : "" };
}

// Leading status icon on each home-menu session row — chosen to be
// glanceable on the G2's tiny monochrome display, with the two states the
// user acts on made loud: "!" = actively working, "?" = a question from
// Claude is waiting on you. Idle stays a quiet "-". ("!" used to mean error;
// error moved to "x" so "!" can carry the more common working state.)
const GLYPHS: Record<DisplayState, string> = {
  working: "!",
  waiting: "?",
  holding: "~",
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

// In-code kill switch for ALL dsh (DeepSeek Harness runtime, XERK-460)
// functionality on the glasses client. NOT an env/build flag — it is a single
// source-level constant, flipped by editing this line, that hides every dsh
// surface WITHOUT removing the machinery (the wire types in types.ts and the
// `isDsh` marker below are retained). The agent (Python), hub and Android carry
// the same-named `DSH_ENABLED` flag; this is the glasses half of a fleet-wide
// disable. Set to `false` = dsh disabled.
//
// ESM `let` exports can't be reassigned by importers, so tests flip it through
// `__setDshEnabled` rather than by assigning the binding.
export let DSH_ENABLED = false;
export function __setDshEnabled(v: boolean): void {
  DSH_ENABLED = v;
}

// Does this session run on the dsh (DeepSeek Harness) runtime rather than Claude
// Code (XERK-460)? `agentType` is "dsh" only for a dsh session; "claude", ""
// (a pre-dsh agent) and absent all read as the default Claude runtime, so no
// current session shows a runtime marker. Mirrors the web's `s.agentType ===
// "dsh"` check (turma/public/sessions.html) and Android's `Runtime.isDsh`
// (core/Runtime.kt). Purely presentational — busy/ready/summary state for a dsh
// session rides the same `paneBusy`/transcript signals as any other (XERK-468),
// so nothing else here branches on the runtime.
//
// Gated on the DSH_ENABLED kill switch: when dsh is disabled, no dsh session
// exists as far as this client is concerned, so this presentational marker
// always reads false even for a record whose `agentType` says "dsh".
export function isDsh(s: SessionInfo): boolean {
  return DSH_ENABLED && s.agentType === "dsh";
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
