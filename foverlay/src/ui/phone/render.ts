// Pure HTML builders for the native phone companion (XERK-171). No I/O, no
// Date.now — everything comes from the AppState the glasses App already polls,
// so the phone renders the SAME fleet the glasses do, in the same process. The
// controller (phone.ts) turns these strings into DOM and wires the clicks.
//
// The look is matched 1:1 to the Turma mobile app (Android / mobile web): the
// same Inter/Space-Grotesk fonts, the warm-paper palette, glowing status dots,
// flat hairline cards, iMessage-style chat bubbles (user accent-right, agent
// surface-left), and a Material bottom nav. Phase 1 ships Sessions + the session
// view; Board is a placeholder tab (Phase 2).
import type { AppState } from "../../core/app.ts";
import type { AgentInfo, PrInfo, SessionInfo } from "../../core/types.ts";
import { filterAgents, liveState, sessionName, siteKeyOf, type LiveState } from "../../core/sessions.ts";
import { LIVE_TURN_ID } from "../../core/render.ts";
import { Board } from "../vendor/engines.ts";

export type PhoneTab = "sessions" | "board";

// Which surface the phone is showing. `inSession` overlays the focused session
// view (App.state.session) over whichever tab; it is separate from the glasses'
// own screen — leaving it here never moves the glasses (XERK-171).
// The ⋯ session-actions menu state (closed, the menu, an inline rename field, or
// the armed "Confirm kill"). Kept on the view so the pure render draws it.
export type SessionMenu = "closed" | "open" | "renaming" | "killArm";

export interface PhoneView {
  tab: PhoneTab;
  inSession: boolean;
  verbosity: VerbosityPreset;
  showTerminal: boolean;
  menu: SessionMenu;
}

// nav.js's own tab icons, so the bottom nav matches the web/Android glyphs.
const TAB_ICON: Record<PhoneTab, string> = {
  sessions: `<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/>`,
  board: `<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="9.5" y="3" width="5" height="12" rx="1"/><rect x="16" y="3" width="5" height="15" rx="1"/>`,
};

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

// The org label for a siteKey, via board.js's own orgName: the manual override
// (BOARD_ORG_NAME) wins, else the site host minus the Jira suffix / the last path
// segment of an Azure collection key. Value routed on stays the full siteKey.
export function orgLabel(siteKey: string, override?: string | null): string {
  if (!siteKey) return "All orgs";
  return Board.orgName(siteKey, override);
}

export interface OrgOption { key: string; label: string; count: number; online: boolean; }

// The orgs the fleet reports, for the header filter — derived from board.js's
// `mergeSites`, exactly like the web's org.js. That is SOURCE-AGNOSTIC, so both
// Jira and Azure DevOps orgs appear (the direct `agent.jira.siteKey` read this
// replaces missed the ADO org), and each org carries its own name + ticket count.
export function orgOptions(state: AppState): OrgOption[] {
  const sites = Board.mergeSites(state.agents as unknown[]);
  return sites
    .map((s) => ({ key: s.siteKey, label: Board.orgName(s.siteKey, (s.orgName as string | undefined) ?? null), count: (s.tickets || []).length, online: !!s.online }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// The one-word state shown on a card, matching the web card's `.state` label.
const STATE_LABEL: Record<LiveState, string> = {
  working: "working",
  waiting: "waiting for your answer",
  idle: "idle",
  stopped: "stopped",
  error: "error",
  queued: "waiting to start", // port fix: see sessions.ts LiveState note
};

// ---- Sessions list --------------------------------------------------------

// device · repo · branch — the web card's meta line, ticket key appended.
function metaLine(hostLabel: string, s: SessionInfo): string {
  const parts = [esc(hostLabel), esc(s.repo)];
  const branch = s.branch || s.label;
  if (branch && branch !== s.repo) parts.push(`<span class="ph-mono">${esc(branch)}</span>`);
  let html = parts.join(" · ");
  if (s.ticket?.key) html += ` · <span class="ph-ticket">${esc(s.ticket.key)}</span>`;
  return html;
}

// The GitHub-style PR pill (ported from sessions.html prBadgeHtml/prReady): state
// colour + #number + a ✓/✗/● merge-readiness mark. Uses the .pr-badge CSS bundled
// via chat.css (extracted from app.css), so it matches the web/Android exactly.
function prReady(pr: PrInfo): string {
  return pr.ready || ({ passing: "ready", failing: "blocked", pending: "pending" } as Record<string, string>)[pr.checks ?? ""] || "";
}
function prBadgeHtml(pr: PrInfo): string {
  const url = pr.url || "";
  const m = url.match(/\/pull\/(\d+)|\/-\/merge_requests\/(\d+)/);
  const num = pr.number ? "#" + pr.number : m ? "#" + (m[1] || m[2]) : "PR";
  const state = String(pr.state || "").toUpperCase();
  const cls = ({ OPEN: "pr-open", DRAFT: "pr-draft", MERGED: "pr-merged", CLOSED: "pr-closed" } as Record<string, string>)[state] || "";
  const label = state ? state[0] + state.slice(1).toLowerCase() : "";
  const ready = prReady(pr);
  const mark = ready === "ready" ? "✓" : ready === "blocked" ? "✗" : ready === "pending" ? "●" : "";
  const chk = mark ? ` <span class="pr-ready ${ready}">${mark}</span>` : "";
  return `<span class="pr-badge ${cls}"><span class="pr-dot"></span>${esc(num)}${label ? " " + esc(label) : ""}${chk}</span>`;
}

function prChips(s: SessionInfo): string {
  const prs = s.prs ?? [];
  if (!prs.length) return "";
  return `<span class="ph-pr-list">${prs.map((p) => prBadgeHtml(p)).join("")}</span>`;
}

const QUEUED_REASON: Record<string, string> = {
  capacity: "waiting for a free session slot",
  "awaiting-clone": "cloning the repo first",
  "root-busy": "waiting for the repos-root slot",
};

function orgTintStyle(colorMap: Map<string, string>, siteKey: string): string {
  const c = siteKey ? colorMap.get(siteKey) : "";
  return c ? ` style="--org:${c}"` : "";
}

function sessionCardHtml(hostKey: string, hostLabel: string, s: SessionInfo, current: boolean, tint: string): string {
  const st = liveState(s);
  const name = sessionName(s);
  const q = s.session?.question;
  const stateRow =
    `<span class="ph-state-row">` +
    `<span class="ph-state st-${st}">${STATE_LABEL[st]}</span>` +
    prChips(s) +
    `</span>`;
  return (
    `<button class="ph-card ph-sess${current ? " cur" : ""}"${tint} data-enter="${esc(s.id)}" data-host="${esc(hostKey)}">` +
    `<span class="ph-dot st-${st}" aria-hidden="true"></span>` +
    `<span class="ph-card-body">` +
    `<span class="ph-card-title">${esc(name)}</span>` +
    `<span class="ph-card-meta">${metaLine(hostLabel, s)}</span>` +
    stateRow +
    (st === "waiting" && q ? `<span class="ph-card-q">${esc(q)}</span>` : "") +
    `</span>` +
    `</button>`
  );
}

// A queued session (no worktree yet) — a static, dashed card showing why it's
// waiting, with an arm-then-confirm Cancel.
function queuedCardHtml(hostKey: string, hostLabel: string, s: SessionInfo, tint: string): string {
  const reason = QUEUED_REASON[s.queuedReason ?? ""] || "waiting to start";
  return (
    `<div class="ph-card ph-queued"${tint}>` +
    `<span class="ph-dot st-waiting" aria-hidden="true"></span>` +
    `<span class="ph-card-body">` +
    `<span class="ph-card-title">${esc(sessionName(s))}</span>` +
    `<span class="ph-card-meta">${esc(hostLabel)} · ${esc(s.repo)}${s.ticket?.key ? " · " + `<span class="ph-ticket">${esc(s.ticket.key)}</span>` : ""}</span>` +
    `<span class="ph-state">${esc(reason)}</span>` +
    `</span>` +
    `<button class="ph-cancel" data-cancel="${esc(s.id)}" data-host="${esc(hostKey)}">Cancel</button>` +
    `</div>`
  );
}

// An ended (killed/stopped) session — a muted, non-entering row with its PR chips.
function endedCardHtml(hostLabel: string, s: SessionInfo, tint: string): string {
  return (
    `<div class="ph-card ph-ended"${tint}>` +
    `<span class="ph-dot st-stopped" aria-hidden="true"></span>` +
    `<span class="ph-card-body">` +
    `<span class="ph-card-title">${esc(sessionName(s))}</span>` +
    `<span class="ph-card-meta">${esc(hostLabel)} · ${esc(s.repo)}${s.ticket?.key ? " · " + `<span class="ph-ticket">${esc(s.ticket.key)}</span>` : ""}</span>` +
    prChips(s) +
    `</span>` +
    `</div>`
  );
}

interface Row { hostKey: string; hostLabel: string; s: SessionInfo; siteKey: string; }

export function sessionsBodyHtml(state: AppState): string {
  const agents = filterAgents(state.agents, state.orgFilter);
  const curId = state.screen === "session" ? state.session?.sessionId : null;
  // Org colours over the WHOLE fleet (not the filtered view) so a card's tint is
  // stable regardless of the filter — the same rule the web/Android use.
  const allKeys = [...new Set(state.agents.map(siteKeyOf).filter(Boolean))];
  const colorMap = Board.orgColorMap(allKeys, state.orgColors);

  const running: Row[] = [];
  const queued: Row[] = [];
  const ended: Row[] = [];
  for (const a of agents) {
    const hostLabel = a.device ?? a.key;
    const siteKey = siteKeyOf(a);
    for (const s of a.sessions ?? []) {
      const row = { hostKey: a.key, hostLabel, s, siteKey };
      if (s.status === "queued") queued.push(row);
      else if (s.status === "running") running.push(row);
      else ended.push(row); // stopped / error records still in the registry
    }
    for (const s of a.closedSessions ?? []) ended.push({ hostKey: a.key, hostLabel, s: s as unknown as SessionInfo, siteKey });
  }
  const active = running.filter((r) => ["working", "waiting"].includes(liveState(r.s)));
  const idle = running.filter((r) => !["working", "waiting"].includes(liveState(r.s)));
  const byCreated = (a: Row, b: Row) => (b.s.createdAt ?? "").localeCompare(a.s.createdAt ?? "");
  [active, idle, queued, ended].forEach((l) => l.sort(byCreated));

  const tintOf = (r: Row): string => orgTintStyle(colorMap, r.siteKey);
  const section = (label: string, list: Row[], render: (r: Row) => string, cls = ""): string =>
    list.length
      ? `<div class="ph-section${cls ? " " + cls : ""}"><div class="ph-section-label">${label} <span class="ph-count">${list.length}</span></div>` +
        list.map(render).join("") +
        `</div>`
      : "";

  const body =
    section("Active", active, (r) => sessionCardHtml(r.hostKey, r.hostLabel, r.s, r.s.id === curId, tintOf(r))) +
    section("Idle", idle, (r) => sessionCardHtml(r.hostKey, r.hostLabel, r.s, r.s.id === curId, tintOf(r))) +
    section("Queued", queued, (r) => queuedCardHtml(r.hostKey, r.hostLabel, r.s, tintOf(r))) +
    section("Ended", ended.slice(0, 20), (r) => endedCardHtml(r.hostLabel, r.s, tintOf(r)), "ph-ended-section");

  return `<div class="ph-list">${body || `<div class="ph-empty">No sessions${state.orgFilter ? " in this org" : ""}.</div>`}</div>`;
}

// ---- Session view (the focused session) -----------------------------------

// The rich transcript entries the vendored chat.js engine renders: the phone's
// own history+live buffer (blocks intact) plus the in-progress live turn as a
// trailing streaming assistant entry. Built by the controller (it owns the
// buffer); shaped here so it stays testable.
export function transcriptEntries(
  buffer: { id?: string; role: string; text?: string; blocks?: unknown[] }[],
  liveTurn: { sessionId: string; text: string } | null,
  sessionId: string
): { id?: string; role: string; text?: string; blocks?: unknown[] }[] {
  const out = buffer.slice();
  if (liveTurn && liveTurn.sessionId === sessionId && liveTurn.text) {
    out.push({ id: LIVE_TURN_ID, role: "assistant", text: liveTurn.text });
  }
  return out;
}

export type VerbosityPreset = "concise" | "normal" | "verbose";

// The session-view SHELL. The transcript container (#ph-transcript / .chat-scroll)
// is filled by the controller with the vendored engine's HTML, and the terminal
// pane (#ph-term) is revealed on the Terminal toggle. Both are in the shell so
// the toggle is a class flip, not a re-render.
export function sessionViewHtml(state: AppState, verbosity: VerbosityPreset, showTerminal: boolean, menu: SessionMenu): string {
  const s = state.session;
  if (!s) return `<div class="ph-empty">Session ended.</div>`;
  const live = findSession(state, s.hostKey, s.sessionId);
  const title = live ? sessionName(live) : s.sessionId.slice(0, 6);
  const sub = live ? [s.hostKey, live.repo, live.branch].filter(Boolean).join(" · ") : s.hostKey;
  const question = live?.session?.question ?? null;
  const options = live?.session?.questionOptions ?? [];

  const questionBox = question
    ? `<div class="ph-question"><div class="ph-question-q">${esc(question)}</div>` +
      options.map((o, i) => `<button class="ph-opt" data-answer="${i}"><span class="ph-opt-n">${i + 1}</span>${esc(o)}</button>`).join("") +
      `</div>`
    : "";

  const presets: VerbosityPreset[] = ["concise", "normal", "verbose"];
  const verbBtns = presets
    .map((p) => `<button class="ph-verb${p === verbosity ? " on" : ""}" data-verb="${p}">${p[0]!.toUpperCase()}${p.slice(1)}</button>`)
    .join("");

  // The ⋯ actions menu: Rename (→ inline field) / Kill (→ arm-then-confirm).
  const curName = live ? sessionName(live) : "";
  const menuHtml =
    menu === "open"
      ? `<div class="ph-sess-menu"><button data-menu-rename="1">Rename…</button><button class="danger" data-menu-kill="1">Kill</button></div>`
      : menu === "renaming"
        ? `<div class="ph-sess-menu ph-rename"><input id="ph-rename" value="${esc(curName)}" placeholder="Session name"><div class="ph-rename-row"><button data-menu-cancel="1">Cancel</button><button class="primary" data-menu-save="1">Save</button></div></div>`
        : menu === "killArm"
          ? `<div class="ph-sess-menu"><button class="danger armed" data-menu-kill-confirm="1">Confirm kill</button><button data-menu-cancel="1">Cancel</button></div>`
          : "";

  return (
    `<div class="ph-session${showTerminal ? " show-term" : ""}">` +
    `<div class="ph-session-head">` +
    `<button class="ph-back" data-back="1" aria-label="Back">‹</button>` +
    `<span class="ph-session-titles"><span class="ph-session-title">${esc(title)}</span>` +
    `<span class="ph-session-sub ph-mono">${esc(sub)}</span></span>` +
    // Foverlay port: the Terminal toggle is not ported (the ttyd iframe needs
    // WebView-jar cookies the background fetch proxy can't plant).
    `<span class="ph-kebab-wrap"><button class="ph-kebab" data-sess-menu="1" title="Actions">⋯</button>${menuHtml}</span>` +
    `</div>` +
    // Chat pane
    `<div class="ph-chat-pane">` +
    `<div class="ph-verbbar">${verbBtns}</div>` +
    `<div class="chat-scroll" id="ph-transcript"></div>` +
    questionBox +
    `<div class="ph-compose">` +
    `<textarea class="ph-input" id="ph-input" rows="1" placeholder="Message…"></textarea>` +
    `<button class="ph-stop" data-stop="1" hidden>◼ Stop</button>` +
    `<button class="ph-send" data-send="1">Send</button>` +
    `</div>` +
    `</div>` +
    // Terminal pane (iframe filled by the controller on first reveal)
    `<div class="ph-term-pane"><iframe id="ph-term" title="Terminal"></iframe></div>` +
    `</div>`
  );
}

// ---- Shell ----------------------------------------------------------------

// The header org filter — matched to the web's org.js menu: a scoping button
// carrying the current org's colour dot, opening a menu of "All orgs" + one row
// per org (colour dot + name + ticket-count chip + an offline marker + the
// per-org auto-start "auto" toggle, XERK-41). Orgs come from mergeSites (ADO
// included) and colours from board.js's orgColorMap honouring the hub's manual
// pins, so the phone's dots match the web/Android exactly. The scope pick and
// the auto toggle are separate targets on one row (data-org vs data-org-auto).
function orgMenuHtml(state: AppState, open: boolean): string {
  const opts = orgOptions(state);
  if (opts.length === 0) return "";
  const cur = state.orgFilter;
  const colorMap = Board.orgColorMap(opts.map((o) => o.key), state.orgColors);
  const total = opts.reduce((n, o) => n + o.count, 0);
  const curOpt = cur ? opts.find((o) => o.key === cur) : null;
  const curLabel = cur ? (curOpt?.label || orgLabel(cur)) : "All orgs";
  const curColor = cur ? colorMap.get(cur) || "" : "";

  const row = (key: string, label: string, count: number, online: boolean): string => {
    const color = key ? colorMap.get(key) || "" : "";
    const autoOn = !!(key && state.autoStartOrgs[key]);
    return (
      `<div class="ph-org-row${key === cur ? " cur" : ""}"${key ? ` style="--org:${color}"` : ""}>` +
      `<button class="ph-org-item" data-org="${esc(key)}">` +
      (key ? `<span class="ph-org-dot"></span>` : `<span class="ph-org-dot ph-org-dot-all"></span>`) +
      `<span class="ph-org-name">${esc(label)}</span>` +
      `<span class="ph-org-count">${count}</span>` +
      (key && !online ? `<span class="ph-org-off">offline</span>` : "") +
      `</button>` +
      // The auto-start toggle (XERK-41): only real orgs, never "All orgs".
      (key
        ? `<button class="ph-org-auto${autoOn ? " on" : ""}" data-org-auto="${esc(key)}"` +
          ` aria-pressed="${autoOn ? "true" : "false"}"` +
          ` title="Auto-start a session for every To Do ticket with a repo">` +
          `<span class="ph-org-auto-dot"></span>auto</button>`
        : "") +
      `</div>`
    );
  };
  const items = row("", "All orgs", total, true) +
    opts.map((o) => row(o.key, o.label, o.count, o.online)).join("");

  return (
    `<div class="ph-org">` +
    `<button class="ph-org-btn${cur ? " scoped" : ""}" data-org-toggle="1">` +
    (cur && curColor ? `<span class="ph-org-dot" style="--org:${curColor}"></span>` : "") +
    `<span class="ph-org-btn-label">${esc(curLabel)}</span> <span class="ph-chev">▾</span></button>` +
    (open ? `<div class="ph-org-menu">${items}</div>` : "") +
    `</div>`
  );
}

// The Kanban board, rendered by the vendored board.js exactly as the web/Android
// show it (columns, org-coloured cards, repo/session chips, start buttons). The
// controller wires the clicks (open detail, start session, refresh) and fills the
// detail modal. `orgColors` pins aren't wired yet (empty), and starts/moves
// optimistic overrides are the controller's job — passed empty here.
export function boardBodyHtml(state: AppState, moves: Map<string, unknown> = new Map()): string {
  const sites = Board.mergeSites(state.agents as unknown[]);
  const bar = `<div class="ph-board-bar"><button class="ph-newticket" data-new-ticket="1">+ New ticket</button><button class="ph-refresh" data-board-refresh="1">↻ Refresh</button></div>`;
  // The create modal (filled + shown by the controller on New ticket).
  const create = `<div class="td-backdrop" id="ph-create" hidden><div class="td-panel cf-panel" id="ph-create-panel"></div></div>`;
  if (!sites.length) {
    return `${bar}<div class="ph-empty">No tickets yet. Connect an org's tracker (Jira / Azure DevOps) on an agent.</div>${create}`;
  }
  const sessionIndex = Board.ticketSessionIndex(state.agents as unknown[]);
  const board = Board.boardHtml(sites, state.orgFilter, {
    allKeys: sites.map((s) => s.siteKey),
    now: state.now,
    sessionIndex,
    starts: new Map(),
    moves,
    orgColors: state.orgColors,
  });
  // The detail modal (filled + shown by the controller on a card tap).
  const modal = `<div class="td-backdrop" id="ph-detail" hidden><div class="td-panel" id="ph-detail-panel"></div></div>`;
  return `${bar}<div class="ph-board">${board}</div>${modal}${create}`;
}

const TAB_LABEL: Record<PhoneTab, string> = { sessions: "Sessions", board: "Board" };

function bottomNavHtml(view: PhoneView): string {
  const tabs = (["sessions", "board"] as PhoneTab[])
    .map(
      (t) =>
        `<button class="ph-tab${view.tab === t ? " active" : ""}" data-tab="${t}">` +
        `<span class="ph-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TAB_ICON[t]}</svg></span>` +
        `<span class="ph-tab-label">${TAB_LABEL[t]}</span></button>`
    )
    .join("");
  return `<nav class="ph-nav">${tabs}</nav>`;
}

export function phoneHtml(state: AppState, view: PhoneView, orgOpen: boolean, moves: Map<string, unknown> = new Map()): string {
  // The session view overlays whichever tab and has its own header, so the shell
  // header + bottom nav are hidden while it's up.
  if (view.inSession && state.screen === "session" && state.session) {
    return sessionViewHtml(state, view.verbosity, view.showTerminal, view.menu);
  }
  const body = view.tab === "sessions" ? sessionsBodyHtml(state) : boardBodyHtml(state, moves);
  return (
    `<div class="ph-shell">` +
    `<header class="ph-header">` +
    `<span class="ph-title">${TAB_LABEL[view.tab]}</span>` +
    `<span class="ph-header-right">` +
    orgMenuHtml(state, orgOpen) +
    `<button class="ph-signout" data-signout="1" title="Sign out" aria-label="Sign out">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>` +
    `</button>` +
    `</span>` +
    `</header>` +
    `<main class="ph-body">${body}</main>` +
    bottomNavHtml(view) +
    `</div>`
  );
}

// Local copy to avoid importing app.ts's (identical) lookup and its cycle risk.
function findSession(state: AppState, hostKey: string, sessionId: string): SessionInfo | undefined {
  return state.agents.find((a: AgentInfo) => a.key === hostKey)?.sessions.find((s) => s.id === sessionId);
}
