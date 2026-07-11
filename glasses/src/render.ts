// PURE rendering: (state) -> a ScreenModel. No I/O, no Date.now — every
// timestamp render needs travels in AppState.now. Target: 10 lines x ~560px
// usable width (the G2's 576x288 canvas, ~10 text lines).
import type { AppState, ReplyScreenState, SessionScreenState } from "./app.ts";
import { bottomBoxLines, inputBoxBody, menuBox, sheetBody, statusLabel, type MicState } from "./input-box.ts";
import { DISPLAY_LINES, LINE_WIDTH_PX } from "./layout.ts";
import { glyph, liveState } from "./sessions.ts";
import { wrapText } from "./text-wrap.ts";
import type { AgentInfo, SessionInfo } from "./types.ts";

export { DISPLAY_LINES, LINE_WIDTH_PX };

// How many lines the transcript scrolls per scroll-gesture step on the
// session screen (distinct from the menu screens, which move a cursor one row
// at a time through a single sliding-window list).
export const SESSION_SCROLL_STEP = 2;

// Synthetic id for the in-progress assistant turn scraped live from the TUI
// (app.ts `liveTurn`). It's rendered as the newest transcript entry while
// generating and the reveal types it; the committed transcript supersedes it
// on completion. A stable non-uuid string so it never collides with a real
// entry id.
export const LIVE_TURN_ID = "__live";

// Focus target on the session screen: the scrollable transcript, or the
// bottom input/sheet box.
export type SessionFocus = "transcript" | "bottom";

export type BottomModel =
  | { mode: "input"; lines: string[]; status: string; focused: boolean }
  | { mode: "sheet"; lines: string[]; status: string; focused: boolean; options: string[]; selected: number }
  | { mode: "menu"; lines: string[]; status: string };

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

interface WindowResult<T> {
  visible: T[];
  start: number;
}

// A single cursor-following window over `rows` — one continuous scrollable
// list, never split into "p/N" pages. When everything fits in `area` the whole
// list shows; otherwise the window slides one row at a time to keep the cursor
// centred (clamped at both ends), the same behaviour menuBox/sheetBody use for
// their option lists. Deterministic from (rows, selectedIndex, area) alone, so
// the pure render stays testable without carrying a scroll offset in state.
function windowRows<T>(rows: T[], selectedIndex: number, area: number): WindowResult<T> {
  if (rows.length <= area) return { visible: rows, start: 0 };
  const selected = Math.max(0, Math.min(selectedIndex, rows.length - 1));
  let start = Math.max(0, selected - Math.floor(area / 2));
  start = Math.min(start, rows.length - area);
  return { visible: rows.slice(start, start + area), start };
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
  const { visible, start } = windowRows(rows, state.home.cursor, DISPLAY_LINES - 1);
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === state.home.cursor)));
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
// render() windows. Includes the "loading earlier" indicator and the
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
  // The newest entry of the focused session may be mid-typewriter (reveal.ts):
  // show only its revealed prefix so still-streaming text types in rather than
  // block-jumping. Older entries, and any other session, always render in full.
  const entries = buffer?.entries ?? [];
  const reveal = state.session?.sessionId === sessionId ? state.reveal : null;
  const lastIdx = entries.length - 1;
  entries.forEach((entry, i) => {
    let text = entry.text;
    if (reveal && i === lastIdx && reveal.entryId === entry.id && reveal.shown < text.length) {
      text = text.slice(0, Math.max(0, reveal.shown));
    }
    lines.push(...wrap(roleLine(entry.role, text)));
  });
  // A pending question no longer duplicates here — the session bottom's sheet
  // mode (Task 6) is the one place it renders. PR links aren't part of the
  // question, so they still surface at the newest end of the transcript.
  const s = findSessionLocal(state, hostKey, sessionId);
  for (const url of s?.session?.newPrUrls ?? []) {
    lines.push(...wrap(`PR ${url}`));
  }
  // The in-progress assistant turn scraped live from the TUI (real-time),
  // rendered as the newest entry and typed in by the reveal. It supersedes
  // nothing in the committed transcript — the agent clears it (empty text)
  // the instant the turn completes and the committed tail owns that message.
  const lt = state.liveTurn;
  if (lt && lt.sessionId === sessionId && lt.text) {
    const reveal = state.session?.sessionId === sessionId ? state.reveal : null;
    let text = lt.text;
    if (reveal && reveal.entryId === LIVE_TURN_ID && reveal.shown < text.length) {
      text = text.slice(0, Math.max(0, reveal.shown));
    }
    lines.push(...wrap(roleLine("assistant", text)));
  }
  return lines;
}

// Whether the session bottom box should render/dispatch as the
// AskUserQuestion sheet: a question is pending AND the user hasn't already
// committed to a free-text answer instead. Task 6's "Dictate answer…" row
// hands off to input mode by starting box dictation — once the mic goes hot,
// or once a dictated draft is sitting there ready to send, the box stays in
// input mode (so a mid-dictation tap/scroll isn't reinterpreted as an option
// pick) even though the live session still reports the question as pending.
// A type guard so callers narrow `question` to `string` in the sheet branch.
// Exported so app.ts's bottom-box input dispatch routes through the exact
// same predicate render.ts uses to choose a rendering mode.
export function questionSheetActive(
  question: string | null | undefined,
  sess: SessionScreenState
): question is string {
  return !!question && sess.mic === "idle" && sess.draft === "";
}

// Builds the session screen's bottom bar — an AskUserQuestion sheet when the
// session has a pending question, otherwise the free-text dictation input —
// from the session's live signals plus its focus/draft/mic/selected fields
// (added to AppState.session in Task 4).
function renderSessionBottom(state: AppState, sess: SessionScreenState): BottomModel {
  const s = findSessionLocal(state, sess.hostKey, sess.sessionId);
  const focus = sess.focus;
  const mic: MicState = sess.mic;
  const live = s ? liveState(s) : "idle";
  const status = statusLabel({ mic, live });
  const focused = focus === "bottom";

  const question = s?.session?.question;
  if (questionSheetActive(question, sess)) {
    const options = s?.session?.questionOptions ?? [];
    const selected = sess.selected;
    return { mode: "sheet", lines: sheetBody({ question, options, selected }), options, selected, status, focused };
  }

  const draft = sess.draft;
  const viewOffset = sess.viewOffset;
  return { mode: "input", lines: inputBoxBody({ text: draft, focused, mic, viewOffset }), status, focused };
}

// The bottom box's on-screen height in text lines. Input/sheet boxes cap at
// BOTTOM_MAX_LINES via bottomBoxLines; the menu box is already capped at
// MENU_MAX_LINES by menuBox, so it sizes to its own content (up to 8 lines).
// Shared by the evenhub backend (which sizes the box container) and
// sessionOverlay (which sizes the transcript above it) so the two never drift.
export function boxLineCount(bottom: BottomModel): number {
  return bottom.mode === "menu" ? Math.max(1, bottom.lines.length) : bottomBoxLines(bottom.lines);
}

// The transcript's visible line-count for a given session — the bottom box
// (input or sheet) grows/shrinks with its content, so app.ts's scroll-offset
// math needs this exact figure to stay in sync with what renderSession
// actually windows. Shared rather than duplicated so the two never drift.
export function sessionTranscriptArea(state: AppState, sess: SessionScreenState): number {
  return DISPLAY_LINES - bottomBoxLines(renderSessionBottom(state, sess).lines);
}

function renderSession(state: AppState): ScreenModel {
  const sess = state.session;
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
  // An active flash (e.g. "✓ queued" after Send/restart/kill) has nowhere
  // else to render on this screen — Task 2 dropped the session header this
  // and every other screen's headerLine used to carry it. Surface it as a
  // transient top line of the transcript instead (only while it's live),
  // borrowing from the content window the same way a header line would.
  const flash = activeFlash(state);
  const flashLines = flash ? wrap(flash) : [];
  const area = Math.max(1, DISPLAY_LINES - bottomBoxLines(bottom.lines) - flashLines.length);
  const maxOffset = Math.max(0, content.length - area);
  const offset = Math.min(sess.offset, maxOffset);
  const end = content.length - offset;
  const start = Math.max(0, end - area);
  const transcriptLines = [...flashLines, ...content.slice(start, end)];

  return { type: "session", transcriptLines, bottom };
}

// ---- actions --------------------------------------------------------

export interface ActionRow {
  action: "send" | "clear" | "dictate" | "start" | "kill" | "back";
  text: string;
}

// Context-sensitive rows. Back is always cursor 0 so the default selection is
// a safe no-op (a stray tap backs out rather than acting). Restart is
// intentionally not offered on the glasses. Send/Clear/Dictate more appear only
// when the session's bottom-box draft (dictated in-box) actually has text to
// act on — read from `state.session` (the same session's draft), since the
// transient ActionsScreenState carries no draft of its own. There's no "Answer
// question" row: the sheet is always visible in the session bottom whenever a
// question is pending, so a menu path would be redundant.
export function buildActionsRows(state: AppState, hostKey: string, sessionId: string): ActionRow[] {
  const s = findSessionLocal(state, hostKey, sessionId);
  if (!s || s.status === "stopped") {
    return [
      { action: "back", text: "Back" },
      { action: "start", text: "Start" },
    ];
  }
  const draft =
    state.session && state.session.hostKey === hostKey && state.session.sessionId === sessionId
      ? state.session.draft
      : "";
  const rows: ActionRow[] = [{ action: "back", text: "Back" }];
  if (draft) {
    // Send acts on the dictated draft, Clear discards it, "Dictate more"
    // appends another dictation (the append a bare tap used to do in place —
    // now an explicit choice so a tap doesn't record over text).
    rows.push({ action: "send", text: "Send" });
    rows.push({ action: "clear", text: "Clear" });
    rows.push({ action: "dictate", text: "Dictate more" });
  }
  // "End this session" issues the same non-destructive kill the hub does:
  // the session drops off the hub but its worktree (any uncommitted work),
  // conversation, and token history all survive on disk. There is
  // deliberately no "Delete" row — the glasses never remove a worktree.
  rows.push({ action: "kill", text: "End this session" });
  return rows;
}

// Builds the session-screen overlay used by the actions/confirm menus: the
// underlying session's transcript, bottom-anchored to whatever room the menu
// box leaves, with `bottom` (a menu-mode box) drawn over it. The transcript is
// static while a menu is open (the reveal only ticks on the session screen).
function sessionOverlay(state: AppState, hostKey: string, sessionId: string, bottom: BottomModel): ScreenModel {
  const content = sessionContentLines(state, hostKey, sessionId);
  const area = Math.max(1, DISPLAY_LINES - boxLineCount(bottom));
  const start = Math.max(0, content.length - area);
  return { type: "session", transcriptLines: content.slice(start), bottom };
}

function renderActions(state: AppState): ScreenModel {
  const a = state.actions;
  if (!a) return linesModel([headerLine(state, "Actions")]);
  const rows = buildActionsRows(state, a.hostKey, a.sessionId);
  const bottom: BottomModel = {
    mode: "menu",
    lines: menuBox({ title: "Options", rows: rows.map((r) => r.text), selected: a.cursor }),
    status: "",
  };
  return sessionOverlay(state, a.hostKey, a.sessionId, bottom);
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
  return `End session ${id}?`;
}

function renderConfirm(state: AppState): ScreenModel {
  const c = state.confirm;
  if (!c) return linesModel([headerLine(state, "Confirm")]);
  const bottom: BottomModel = {
    mode: "menu",
    lines: menuBox({ title: confirmHeader(state), rows: ["Cancel", "Confirm"], selected: c.cursor }),
    status: "",
  };
  return sessionOverlay(state, c.action.hostKey, c.action.sessionId, bottom);
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
  const { visible, start } = windowRows(rows, n.cursor, DISPLAY_LINES - 1);
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === n.cursor)));
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
    // The repos-root pseudo-repo spawns a session at the root (no worktree);
    // give it a legible label instead of the bare "(root)" sentinel name.
    rows.push({ kind: "repo", repo: repo.name, text: repo.isRoot ? "Repos root (all repos)" : repo.name });
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
  const { visible, start } = windowRows(rows, n.cursor, DISPLAY_LINES - 1);
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === n.cursor)));
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
      return renderActions(state);
    case "reply":
      return linesModel(renderReply(state));
    case "confirm":
      return renderConfirm(state);
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
