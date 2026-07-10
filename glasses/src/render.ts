// PURE rendering: (state) -> a ScreenModel. No I/O, no Date.now — every
// timestamp render needs travels in AppState.now. Target: 10 lines x ~560px
// usable width (the G2's 576x288 canvas, ~10 text lines).
import type { AppState, ReplyScreenState, SessionScreenState } from "./app.ts";
import { bottomBoxLines, inputBoxBody, sheetBody, statusLabel, type MicState } from "./input-box.ts";
import { DISPLAY_LINES, LINE_WIDTH_PX } from "./layout.ts";
import { glyph, liveState } from "./sessions.ts";
import { wrapText } from "./text-wrap.ts";
import type { AgentInfo, SessionInfo } from "./types.ts";

export { DISPLAY_LINES, LINE_WIDTH_PX };
// Legacy fixed transcript-area height (1 header line + 9 content), kept only
// because app.ts's scroll-amount math still references it pending Task 4's
// rewrite. renderSession no longer uses it: the session screen has no header
// line anymore, and the transcript area now varies with the bottom box's
// height (see bottomBoxLines).
export const SESSION_CONTENT_AREA = DISPLAY_LINES - 1;

// How many lines the transcript scrolls per scroll-gesture step on the
// session screen (distinct from the menu screens' page-at-a-time paging).
export const SESSION_SCROLL_STEP = 2;

// Focus target on the session screen: the scrollable transcript, or the
// bottom input/sheet box.
export type SessionFocus = "transcript" | "bottom";

// The session screen's live-interaction fields, added to AppState.session in
// Task 4. Declared here (rather than widening AppState.session itself, which
// is Task 4's job) so render() can read them — with defaults below — while
// staying pure and testable from plain fixtures today.
export interface SessionScreenStateExt extends SessionScreenState {
  focus?: SessionFocus;
  draft?: string;
  mic?: MicState;
  viewOffset?: number;
  selected?: number;
}

export type BottomModel =
  | { mode: "input"; lines: string[]; status: string; focused: boolean }
  | { mode: "sheet"; lines: string[]; status: string; focused: boolean; options: string[]; selected: number };

export type ScreenModel =
  | { type: "lines"; lines: string[] }
  | { type: "session"; transcriptLines: string[]; bottom: BottomModel };

function linesModel(lines: string[]): ScreenModel {
  return { type: "lines", lines };
}

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

// Builds the session screen's bottom bar — an AskUserQuestion sheet when the
// session has a pending question, otherwise the free-text dictation input —
// from the session's live signals plus the (Task 4-supplied, defaulted here)
// focus/draft/mic/selected fields.
function renderSessionBottom(state: AppState, sess: SessionScreenStateExt): BottomModel {
  const s = findSessionLocal(state, sess.hostKey, sess.sessionId);
  const focus = sess.focus ?? "transcript";
  const mic: MicState = sess.mic ?? "idle";
  const live = s ? liveState(s) : "idle";
  const status = statusLabel({ mic, live });
  const focused = focus === "bottom";

  const question = s?.session?.question;
  if (question) {
    const options = s?.session?.questionOptions ?? [];
    const selected = sess.selected ?? 0;
    return { mode: "sheet", lines: sheetBody({ question, options, selected }), options, selected, status, focused };
  }

  const draft = sess.draft ?? "";
  const viewOffset = sess.viewOffset ?? 0;
  return { mode: "input", lines: inputBoxBody({ text: draft, focused, mic, viewOffset }), status, focused };
}

function renderSession(state: AppState): ScreenModel {
  const sess = state.session as SessionScreenStateExt | null;
  if (!sess) {
    // Defensive fallback: screen is "session" but no session target is set.
    // Shouldn't happen in practice (every transition to "session" sets both
    // together), but keeps render() total over AppState.
    return {
      type: "session",
      transcriptLines: [],
      bottom: {
        mode: "input",
        lines: inputBoxBody({ text: "", focused: false, mic: "idle", viewOffset: 0 }),
        status: statusLabel({ mic: "idle", live: "idle" }),
        focused: false,
      },
    };
  }

  const bottom = renderSessionBottom(state, sess);
  const content = sessionContentLines(state, sess.hostKey, sess.sessionId);
  const area = DISPLAY_LINES - bottomBoxLines(bottom.lines);
  const maxOffset = Math.max(0, content.length - area);
  const offset = Math.min(sess.offset, maxOffset);
  const end = content.length - offset;
  const start = Math.max(0, end - area);
  const transcriptLines = content.slice(start, end);

  return { type: "session", transcriptLines, bottom };
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

export function render(state: AppState): ScreenModel {
  switch (state.screen) {
    case "home":
      return linesModel(renderHome(state));
    case "session":
      return renderSession(state);
    case "actions":
      return linesModel(renderActions(state));
    case "question":
      return linesModel(renderQuestion(state));
    case "reply":
      return linesModel(renderReply(state));
    case "confirm":
      return linesModel(renderConfirm(state));
    case "newHost":
      return linesModel(renderNewHost(state));
    case "newRepo":
      return linesModel(renderNewRepo(state));
    case "newPrompt":
      return linesModel(renderNewPrompt(state));
    case "settings":
      return linesModel(renderSettings(state));
  }
}
