// Pure HTML builders for the native phone companion (XERK-171). No I/O, no
// Date.now — everything comes from the AppState the glasses App already polls,
// so the phone renders the SAME fleet the glasses do, in the same process. The
// controller (phone.ts) turns these strings into DOM and wires the clicks.
//
// This is the dedicated Even phone interface the ticket asks for: Sessions +
// Board, driving the glasses in-process (a tap calls App.enterSession directly —
// no iframe, no postMessage). Phase 1 ships Sessions + the session view; Board
// is a placeholder tab filled in Phase 2.
import type { AppState } from "../app.ts";
import type { AgentInfo, SessionInfo } from "../types.ts";
import { filterAgents, liveState, sessionName, siteKeyOf, type LiveState } from "../sessions.ts";
import { LIVE_TURN_ID } from "../render.ts";

export type PhoneTab = "sessions" | "board";

// Which surface the phone is showing. `inSession` overlays the focused session
// view (App.state.session) over whichever tab; it is separate from the glasses'
// own screen — leaving it here never moves the glasses (XERK-171).
export interface PhoneView {
  tab: PhoneTab;
  inSession: boolean;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

// The org label for a siteKey — the site host minus the Jira suffix, or the last
// path segment of a slashed (Azure collection) key. Presentational only; the
// value routed on stays the full siteKey. (A fuller port lives in Phase 2's
// board core; this is enough for the filter menu.)
export function orgLabel(siteKey: string): string {
  if (!siteKey) return "All orgs";
  if (siteKey.includes("/")) return siteKey.split("/").filter(Boolean).pop() || siteKey;
  return siteKey.replace(/\.atlassian\.net$/, "");
}

// The distinct orgs the fleet reports, for the header filter menu.
export function orgOptions(state: AppState): { key: string; label: string }[] {
  const seen = new Set<string>();
  const out: { key: string; label: string }[] = [];
  for (const a of state.agents) {
    const key = siteKeyOf(a);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: orgLabel(key) });
  }
  out.sort((x, y) => x.label.localeCompare(y.label));
  return out;
}

const STATE_LABEL: Record<LiveState, string> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  stopped: "stopped",
  error: "error",
};

// ---- Sessions list --------------------------------------------------------

function sessionCardHtml(hostKey: string, s: SessionInfo, current: boolean): string {
  const st = liveState(s);
  const name = sessionName(s);
  const sub = s.branch || s.label || s.repo;
  return (
    `<button class="ph-card ph-sess${current ? " cur" : ""}" data-enter="${esc(s.id)}" data-host="${esc(hostKey)}">` +
    `<span class="ph-dot st-${st}" aria-hidden="true"></span>` +
    `<span class="ph-card-body">` +
    `<span class="ph-card-title">${esc(name)}</span>` +
    `<span class="ph-card-sub">${esc(s.repo)}${sub && sub !== s.repo ? " · " + esc(sub) : ""}</span>` +
    `</span>` +
    `<span class="ph-state st-${st}">${STATE_LABEL[st]}</span>` +
    `</button>`
  );
}

export function sessionsBodyHtml(state: AppState): string {
  const agents = filterAgents(state.agents, state.orgFilter);
  const hosts = [...agents].sort((a, b) => (a.device ?? a.key).localeCompare(b.device ?? b.key));
  const curId = state.screen === "session" ? state.session?.sessionId : null;
  const blocks: string[] = [];
  let total = 0;
  for (const host of hosts) {
    const sessions = [...(host.sessions ?? [])].sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
    );
    if (!host.online && sessions.length === 0) continue;
    total += sessions.length;
    const cards = sessions.map((s) => sessionCardHtml(host.key, s, s.id === curId)).join("");
    blocks.push(
      `<div class="ph-host">` +
      `<div class="ph-host-name">${esc(host.device ?? host.key)}${host.online ? "" : " · offline"}</div>` +
      (cards || `<div class="ph-empty-row">No sessions</div>`) +
      `</div>`
    );
  }
  if (total === 0) {
    blocks.push(`<div class="ph-empty">No sessions${state.orgFilter ? " in this org" : ""}.</div>`);
  }
  return `<div class="ph-list">${blocks.join("")}</div>`;
}

// ---- Session view (the focused session) -----------------------------------

// The entries to show for the focused session: the committed transcript buffer
// plus the in-progress live turn appended as the newest assistant bubble (so the
// phone streams as the App's liveTurn grows, repaint by repaint).
export function sessionEntries(state: AppState): { id: string; role: string; text: string }[] {
  const s = state.session;
  if (!s) return [];
  const buf = state.transcripts[s.sessionId]?.entries ?? [];
  const out = buf.map((e) => ({ id: e.id, role: e.role, text: e.text }));
  const live = state.liveTurn;
  if (live && live.sessionId === s.sessionId && live.text) {
    // Supersede a trailing assistant entry the live turn is still growing.
    out.push({ id: LIVE_TURN_ID, role: "assistant", text: live.text });
  }
  return out;
}

function bubbleHtml(role: string, text: string): string {
  const mine = role === "user";
  return (
    `<div class="ph-bubble ${mine ? "me" : "them"}">` +
    `<div class="ph-bubble-txt">${esc(text)}</div>` +
    `</div>`
  );
}

export function sessionViewHtml(state: AppState): string {
  const s = state.session;
  if (!s) return `<div class="ph-empty">Session ended.</div>`;
  const live = findSession(state, s.hostKey, s.sessionId);
  const title = live ? sessionName(live) : s.sessionId.slice(0, 6);
  const question = live?.session?.question ?? null;
  const options = live?.session?.questionOptions ?? [];

  const bubbles = sessionEntries(state)
    .filter((e) => e.text.trim())
    .map((e) => bubbleHtml(e.role, e.text))
    .join("");

  const questionBox = question
    ? `<div class="ph-question"><div class="ph-question-q">${esc(question)}</div>` +
      options
        .map((o, i) => `<button class="ph-opt" data-answer="${i}">${i + 1}. ${esc(o)}</button>`)
        .join("") +
      `</div>`
    : "";

  return (
    `<div class="ph-session">` +
    `<div class="ph-session-head">` +
    `<button class="ph-back" data-back="1" aria-label="Back">‹</button>` +
    `<span class="ph-session-title">${esc(title)}</span>` +
    `</div>` +
    `<div class="ph-transcript" id="ph-transcript">${bubbles || `<div class="ph-empty">No messages yet.</div>`}</div>` +
    questionBox +
    `<div class="ph-compose">` +
    `<textarea class="ph-input" id="ph-input" rows="1" placeholder="Message…"></textarea>` +
    `<button class="ph-send" data-send="1">Send</button>` +
    `</div>` +
    `</div>`
  );
}

// ---- Shell ----------------------------------------------------------------

function orgMenuHtml(state: AppState): string {
  const opts = orgOptions(state);
  const cur = state.orgFilter;
  const label = cur ? orgLabel(cur) : "All orgs";
  if (opts.length === 0) return "";
  const items = [{ key: "", label: "All orgs" }, ...opts]
    .map(
      (o) =>
        `<button class="ph-org-item${o.key === cur ? " cur" : ""}" data-org="${esc(o.key)}">${esc(o.label)}</button>`
    )
    .join("");
  return (
    `<div class="ph-org">` +
    `<button class="ph-org-btn" data-org-toggle="1">${esc(label)} ▾</button>` +
    `<div class="ph-org-menu" hidden>${items}</div>` +
    `</div>`
  );
}

export function boardPlaceholderHtml(): string {
  return `<div class="ph-empty">Board — coming next.</div>`;
}

export function phoneHtml(state: AppState, view: PhoneView, orgOpen: boolean): string {
  // The session view overlays whichever tab and has its own header, so the shell
  // header + bottom nav are hidden while it's up.
  if (view.inSession && state.screen === "session" && state.session) {
    return sessionViewHtml(state);
  }
  const body = view.tab === "sessions" ? sessionsBodyHtml(state) : boardPlaceholderHtml();
  const orgMenu = orgMenuHtml(state).replace('class="ph-org-menu" hidden', orgOpen ? 'class="ph-org-menu"' : 'class="ph-org-menu" hidden');
  return (
    `<div class="ph-shell">` +
    `<header class="ph-header">` +
    `<span class="ph-title">Turma</span>` +
    `<span class="ph-header-right">` +
    orgMenu +
    `<button class="ph-signout" data-signout="1" title="Sign out" aria-label="Sign out">⎋</button>` +
    `</span>` +
    `</header>` +
    `<main class="ph-body">${body}</main>` +
    `<nav class="ph-nav">` +
    `<button class="ph-tab${view.tab === "sessions" ? " active" : ""}" data-tab="sessions">Sessions</button>` +
    `<button class="ph-tab${view.tab === "board" ? " active" : ""}" data-tab="board">Board</button>` +
    `</nav>` +
    `</div>`
  );
}

// Local copy to avoid importing app.ts's (identical) lookup and its cycle risk.
function findSession(state: AppState, hostKey: string, sessionId: string): SessionInfo | undefined {
  return state.agents.find((a: AgentInfo) => a.key === hostKey)?.sessions.find((s) => s.id === sessionId);
}
