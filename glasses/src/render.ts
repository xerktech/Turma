// PURE rendering: (state) -> display lines. No I/O, no Date.now — every
// timestamp render needs travels in AppState.now. Target: 10 lines x ~560px
// usable width (the G2's 576x288 canvas, ~10 text lines).
import type { AppState, ReplyScreenState } from "./app.ts";
import { glyph, liveState } from "./sessions.ts";
import { wrapText } from "./text-wrap.ts";
import type { AgentInfo, SessionInfo } from "./types.ts";

export const DISPLAY_LINES = 10;
export const LINE_WIDTH_PX = 560;
// Session transcript view: 1 header line, rest is scrollable content. No
// footer page indicator here (paging is continuous scroll, not discrete
// pages, so "p/N" doesn't apply the way it does to the menu screens).
export const SESSION_CONTENT_AREA = DISPLAY_LINES - 1;

function wrap(text: string): string[] {
  return wrapText(text, LINE_WIDTH_PX);
}

function activeFlash(state: AppState): string | null {
  return state.flash && state.now < state.flashUntil ? state.flash : null;
}

function headerLine(state: AppState, fallback: string): string {
  return activeFlash(state) ?? fallback;
}

function findSessionLocal(state: AppState, hostKey: string, sessionId: string): SessionInfo | undefined {
  return state.agents.find((a) => a.key === hostKey)?.sessions.find((s) => s.id === sessionId);
}

function findAgentLocal(state: AppState, hostKey: string): AgentInfo | undefined {
  return state.agents.find((a) => a.key === hostKey);
}

function markerLine(text: string, selected: boolean): string {
  return (selected ? "> " : "  ") + text;
}

interface PaginateResult<T> {
  visible: T[];
  start: number;
  page: number;
  totalPages: number;
  showFooter: boolean;
}

// Windows `rows` into fixed-size pages so `selectedIndex` is always visible;
// pages are aligned from row 0 (no cursor-centering), which keeps the
// windowing deterministic and easy to test. Reserves one line for a "p/N"
// footer once the rows don't fit in a single page.
function paginate<T>(rows: T[], selectedIndex: number, maxArea: number, footerArea: number): PaginateResult<T> {
  const area = rows.length <= maxArea ? maxArea : footerArea;
  const totalPages = Math.max(1, Math.ceil(rows.length / area));
  const page = Math.min(totalPages - 1, Math.floor(Math.max(0, selectedIndex) / area));
  const start = page * area;
  const end = Math.min(rows.length, start + area);
  return { visible: rows.slice(start, end), start, page: page + 1, totalPages, showFooter: totalPages > 1 };
}

// ---- home -------------------------------------------------------------

export interface HomeRow {
  kind: "hostHeader" | "hostOffline" | "session" | "newSession" | "settings";
  hostKey?: string;
  sessionId?: string;
  selectable: boolean;
  text: string;
}

// Counts derive straight from state.agents (not the separately-maintained
// sessionRefs cache) so render() only ever needs one source of truth — a
// plain AppState fixture with `agents` set is always renderable, matching
// the brief's requirement.
function homeHeaderText(state: AppState): string {
  let working = 0;
  let waiting = 0;
  for (const agent of state.agents) {
    if (!agent.online) continue;
    for (const session of agent.sessions ?? []) {
      const s = liveState(session);
      if (s === "working") working++;
      else if (s === "waiting") waiting++;
    }
  }
  return `AGENTHUB ${working} run · ${waiting} ask`;
}

export function buildHomeRows(state: AppState): HomeRow[] {
  const rows: HomeRow[] = [];
  const hosts = [...state.agents].sort((a, b) => (a.device ?? a.key).localeCompare(b.device ?? b.key));
  for (const agent of hosts) {
    const device = agent.device ?? agent.key;
    if (!agent.online) {
      rows.push({ kind: "hostOffline", hostKey: agent.key, selectable: false, text: `${device} offline` });
      continue;
    }
    rows.push({ kind: "hostHeader", hostKey: agent.key, selectable: false, text: device });
    const sessions = [...(agent.sessions ?? [])].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    for (const session of sessions) {
      const display = state.pending[session.id] ? "pending" : liveState(session);
      const g = glyph(display);
      const labelOrRepo = session.label || session.repo;
      const shortId = session.id.slice(0, 6);
      rows.push({
        kind: "session",
        hostKey: agent.key,
        sessionId: session.id,
        selectable: true,
        text: `${g} ${device}·${labelOrRepo} ${shortId}`,
      });
    }
  }
  rows.push({ kind: "newSession", selectable: true, text: "+ New session" });
  rows.push({ kind: "settings", selectable: true, text: "Settings" });
  return rows;
}

function renderHome(state: AppState): string[] {
  const header = headerLine(state, homeHeaderText(state));
  const rows = buildHomeRows(state);
  const { visible, start, page, totalPages, showFooter } = paginate(
    rows,
    state.home.cursor,
    DISPLAY_LINES - 1,
    DISPLAY_LINES - 2
  );
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === state.home.cursor)));
  if (showFooter) lines.push(`p${page}/${totalPages}`);
  return lines;
}

// ---- session ------------------------------------------------------------

function roleLine(role: string, text: string): string {
  if (role === "user") return `> ${text}`;
  if (role === "assistant") return text;
  return `[${role}] ${text}`;
}

// Every line the session screen could show, oldest first, bottom-anchored —
// exported so app.ts can compute scroll-offset bounds from the same list
// render() paginates. Includes the "loading earlier" indicator and the
// pending-question/PR lines the brief calls out as rendering at the newest
// end.
export function sessionContentLines(state: AppState, hostKey: string, sessionId: string): string[] {
  const lines: string[] = [];
  const buffer = state.transcripts[sessionId];
  if (state.loadingHistory[sessionId]) {
    lines.push("· loading earlier ·");
  } else if (buffer?.hasMore === true) {
    // History has been fetched and the server told us it's truncated at
    // HISTORY_MAX_MSGS — that can't grow (app.ts's onSession only re-fetches
    // when hasMore is undefined), so mark it instead of implying more is a
    // scroll away.
    lines.push("· earlier history truncated ·");
  }
  for (const entry of buffer?.entries ?? []) {
    lines.push(...wrap(roleLine(entry.role, entry.text)));
  }
  const s = findSessionLocal(state, hostKey, sessionId);
  if (s?.session?.question) {
    lines.push(...wrap(`? ${s.session.question}`));
  }
  for (const url of s?.session?.newPrUrls ?? []) {
    lines.push(...wrap(`PR ${url}`));
  }
  return lines;
}

function renderSession(state: AppState): string[] {
  const sess = state.session;
  if (!sess) return [headerLine(state, "Session")];
  const s = findSessionLocal(state, sess.hostKey, sess.sessionId);
  const device = findAgentLocal(state, sess.hostKey)?.device ?? sess.hostKey;
  const labelOrRepo = s ? s.label || s.repo : sess.sessionId;
  const header = headerLine(state, `${device}·${labelOrRepo}`);

  const content = sessionContentLines(state, sess.hostKey, sess.sessionId);
  const area = SESSION_CONTENT_AREA;
  const maxOffset = Math.max(0, content.length - area);
  const offset = Math.min(sess.offset, maxOffset);
  const end = content.length - offset;
  const start = Math.max(0, end - area);
  const visible = content.slice(start, end);

  return [header, ...visible];
}

// ---- actions --------------------------------------------------------

export interface ActionRow {
  action: "reply" | "answer" | "restart" | "start" | "kill" | "delete" | "back";
  text: string;
}

export function buildActionsRows(state: AppState, hostKey: string, sessionId: string): ActionRow[] {
  const s = findSessionLocal(state, hostKey, sessionId);
  if (!s || s.status === "stopped") {
    return [
      { action: "start", text: "Start" },
      { action: "delete", text: "Delete" },
      { action: "back", text: "Back" },
    ];
  }
  const rows: ActionRow[] = [{ action: "reply", text: "Reply (dictate)" }];
  if (s.session?.question) rows.push({ action: "answer", text: "Answer question" });
  rows.push({ action: "restart", text: "Restart" });
  rows.push({ action: "kill", text: "Kill" });
  rows.push({ action: "delete", text: "Delete" });
  rows.push({ action: "back", text: "Back" });
  return rows;
}

function renderActions(state: AppState): string[] {
  const a = state.actions;
  if (!a) return [headerLine(state, "Actions")];
  const s = findSessionLocal(state, a.hostKey, a.sessionId);
  const labelOrRepo = s ? s.label || s.repo : a.sessionId;
  const header = headerLine(state, `Actions · ${labelOrRepo}`);
  const rows = buildActionsRows(state, a.hostKey, a.sessionId);
  const { visible, start, page, totalPages, showFooter } = paginate(
    rows,
    a.cursor,
    DISPLAY_LINES - 1,
    DISPLAY_LINES - 2
  );
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === a.cursor)));
  if (showFooter) lines.push(`p${page}/${totalPages}`);
  return lines;
}

// ---- question -------------------------------------------------------

function questionOptionRows(options: string[]): string[] {
  return [...options.map((opt, i) => `${i + 1}) ${opt}`), "Dictate answer…", "Back"];
}

function renderQuestion(state: AppState): string[] {
  const q = state.question;
  if (!q) return [headerLine(state, "Question")];
  const s = findSessionLocal(state, q.hostKey, q.sessionId);
  const question = s?.session?.question ?? "";
  const options = s?.session?.questionOptions ?? [];
  const header = headerLine(state, "Question");
  const questionLines = wrap(question);
  const rows = questionOptionRows(options);
  const area = Math.max(1, DISPLAY_LINES - 1 - questionLines.length);
  const { visible, start, page, totalPages, showFooter } = paginate(rows, q.cursor, area, Math.max(1, area - 1));
  const lines = [header, ...questionLines];
  visible.forEach((text, i) => lines.push(markerLine(text, start + i === q.cursor)));
  if (showFooter) lines.push(`p${page}/${totalPages}`);
  return lines;
}

// ---- reply ------------------------------------------------------------

function replyButtons(r: ReplyScreenState): string[] {
  return r.phase === "unavailable" ? ["Redo", "Cancel"] : ["Send", "Redo", "Cancel"];
}

function renderReply(state: AppState): string[] {
  const r = state.reply;
  if (!r) return [headerLine(state, "Reply")];
  const header = headerLine(state, "Reply");
  if (r.phase === "listening") {
    return [header, "● listening… (tap=done)"];
  }
  const lines = [header];
  if (r.phase === "unavailable") {
    lines.push(...wrap(r.reason ?? "dictation unavailable"));
  } else {
    lines.push(...wrap(r.text));
    lines.push(`${r.text.length} chars`);
  }
  const buttons = replyButtons(r);
  buttons.forEach((text, i) => lines.push(markerLine(text, i === r.cursor)));
  return lines;
}

// ---- confirm ----------------------------------------------------------

function confirmHeader(state: AppState): string {
  const c = state.confirm;
  if (!c) return "Confirm";
  const id = c.action.sessionId.slice(0, 6);
  return c.action.kind === "kill" ? `Kill ${id}?` : `Delete ${id}? Also removes branch`;
}

function renderConfirm(state: AppState): string[] {
  const c = state.confirm;
  if (!c) return [headerLine(state, "Confirm")];
  const header = headerLine(state, confirmHeader(state));
  const rows = ["Cancel", "Confirm"];
  const lines = [header];
  rows.forEach((text, i) => lines.push(markerLine(text, i === c.cursor)));
  return lines;
}

// ---- newHost ------------------------------------------------------------

function newHostRows(state: AppState): { hostKey: string; text: string }[] {
  return state.agents.filter((a) => a.online).map((a) => ({ hostKey: a.key, text: a.device ?? a.key }));
}

function renderNewHost(state: AppState): string[] {
  const n = state.newHost;
  const header = headerLine(state, "New session · Choose host");
  const rows = newHostRows(state);
  if (!n) return [header];
  const { visible, start, page, totalPages, showFooter } = paginate(
    rows,
    n.cursor,
    DISPLAY_LINES - 1,
    DISPLAY_LINES - 2
  );
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === n.cursor)));
  if (showFooter) lines.push(`p${page}/${totalPages}`);
  return lines;
}

// ---- newRepo ------------------------------------------------------------

export type NewRepoRow =
  | { kind: "repo"; repo: string; text: string }
  | { kind: "resume"; closedSessionId: string; text: string };

export function buildNewRepoRows(state: AppState, hostKey: string): NewRepoRow[] {
  const agent = findAgentLocal(state, hostKey);
  if (!agent) return [];
  const rows: NewRepoRow[] = [];
  for (const repo of agent.repos ?? []) {
    rows.push({ kind: "repo", repo: repo.name, text: repo.name });
    for (const c of agent.closedSessions ?? []) {
      if (c.repo !== repo.name) continue;
      rows.push({ kind: "resume", closedSessionId: c.id, text: `Resume ${c.label || c.repo}` });
    }
  }
  return rows;
}

function renderNewRepo(state: AppState): string[] {
  const n = state.newRepo;
  const device = n ? findAgentLocal(state, n.hostKey)?.device ?? n.hostKey : "";
  const header = headerLine(state, `New session · ${device} · Choose repo`);
  if (!n) return [header];
  const rows = buildNewRepoRows(state, n.hostKey);
  const { visible, start, page, totalPages, showFooter } = paginate(
    rows,
    n.cursor,
    DISPLAY_LINES - 1,
    DISPLAY_LINES - 2
  );
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === n.cursor)));
  if (showFooter) lines.push(`p${page}/${totalPages}`);
  return lines;
}

// ---- newPrompt ------------------------------------------------------------

function renderNewPrompt(state: AppState): string[] {
  const n = state.newPrompt;
  const header = headerLine(state, "Dictate initial prompt?");
  if (!n) return [header];
  const rows = ["Dictate initial prompt…", "Skip (spawn now)"];
  const lines = [header];
  rows.forEach((text, i) => lines.push(markerLine(text, i === n.cursor)));
  return lines;
}

// ---- settings -------------------------------------------------------

function renderSettings(state: AppState): string[] {
  const header = headerLine(state, "Settings");
  const online = state.agents.filter((a) => a.online).length;
  const total = state.agents.length;
  return [header, `${online}/${total} hosts online`, "Configure on phone", markerLine("Back", true)];
}

// ---- dispatcher -----------------------------------------------------

export function render(state: AppState): string[] {
  switch (state.screen) {
    case "home":
      return renderHome(state);
    case "session":
      return renderSession(state);
    case "actions":
      return renderActions(state);
    case "question":
      return renderQuestion(state);
    case "reply":
      return renderReply(state);
    case "confirm":
      return renderConfirm(state);
    case "newHost":
      return renderNewHost(state);
    case "newRepo":
      return renderNewRepo(state);
    case "newPrompt":
      return renderNewPrompt(state);
    case "settings":
      return renderSettings(state);
  }
}
