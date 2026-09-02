// PURE rendering: (state) -> a ScreenModel. No I/O, no Date.now — every
// timestamp render needs travels in AppState.now. Target: 10 lines x ~560px
// usable width (the G2's 576x288 canvas, ~10 text lines).
import type { AppState, ReplyScreenState, SessionScreenState } from "./app.ts";
import { bottomBoxLines, inputBoxBody, menuBox, sheetBody, statusLabel, type MicState } from "./input-box.ts";
import { DISPLAY_LINES, LINE_WIDTH_PX } from "./layout.ts";
import { filterAgents, glyph, liveState, sessionName } from "./sessions.ts";
import { measureDefault, measureGeneration, wrapText } from "./text-wrap.ts";
import type { AgentInfo, SessionInfo } from "./types.ts";

export { DISPLAY_LINES, LINE_WIDTH_PX };

// How many lines the transcript scrolls per scroll-gesture step on the
// session screen (distinct from the menu screens, which move a cursor one row
// at a time through a single sliding-window list).
export const SESSION_SCROLL_STEP = 2;

// Synthetic id for the in-progress assistant turn scraped live from the TUI
// (app.ts `liveTurn`). It's rendered as the newest transcript entry while
// generating; the committed transcript supersedes it on completion. A stable
// non-uuid string so it never collides with a real entry id.
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

// The 2-space hang indent under every transcript turn's marker (see roleBlock).
// Transcript content wraps to a slightly narrower width so the marker + indent
// never push a line past the display edge.
const CONTINUATION_INDENT = "  ";

// The gutter's pixel width only changes when the default measure is re-pointed
// (main.ts's pretext upgrade), so memoize it per measure generation — otherwise
// every roleBlock call would re-measure the gutter, and even a pure wrap-cache
// hit would keep touching the font metric.
let contentWidthCache: { gen: number; width: number } | null = null;

function contentWidth(): number {
  const gen = measureGeneration();
  if (!contentWidthCache || contentWidthCache.gen !== gen) {
    contentWidthCache = { gen, width: LINE_WIDTH_PX - measureDefault(CONTINUATION_INDENT) };
  }
  return contentWidthCache.width;
}

// Memoized word-wrap for transcript content. `sessionContentLines` re-wraps the
// whole visible buffer on every repaint (a ~1s live turn frame, every poll) and
// several times per poll on its own (via `sessionContentLength`), and each wrap
// runs the real device font metric (text-wrap's getTextWidth) once per word —
// so re-wrapping every committed entry every frame is O(all words in the
// buffer) of pure repeat work. Only the live turn changes between frames; every
// committed entry produces byte-identical wrapped output.
//
// Cache key is the exact string handed to `wrapText()` plus the wrap width and
// the measure generation (text-wrap's `measureGeneration()`): identical text at
// the same width wraps identically, a font/measure swap (setDefaultMeasure,
// main.ts boot) bumps the generation so a stale wrap can never be served, and
// folding the width in keeps the two widths in play (full-width meta/PR lines
// vs the narrower hang-indented turn content) from colliding. Bounded and
// evicted LRU-style so it can't grow without limit as sessions churn (the
// live turn's growing text would otherwise accumulate one entry per frame).
const WRAP_CACHE_MAX = 512;
const wrapCache = new Map<string, string[]>();

function wrapCached(text: string, width: number): string[] {
  const key = `${measureGeneration()} ${width} ${text}`;
  const hit = wrapCache.get(key);
  if (hit) {
    // Refresh recency: re-insert so the genuinely hot entries stay newest and
    // survive eviction over the live turn's one-shot growing-text keys.
    wrapCache.delete(key);
    wrapCache.set(key, hit);
    return hit;
  }
  const lines = wrapText(text, width);
  wrapCache.set(key, lines);
  if (wrapCache.size > WRAP_CACHE_MAX) {
    const oldest = wrapCache.keys().next().value;
    if (oldest !== undefined) wrapCache.delete(oldest);
  }
  return lines;
}

function activeFlash(state: AppState): string | null {
  return state.flash && state.now < state.flashUntil ? state.flash : null;
}

// A screen whose header is ONE line still has to show a flash, and a hub
// refusal now arrives in the hub's own words (XERK-270) — which can be longer
// than the ~55 characters a line holds. Clip it to the first wrapped line with
// an ellipsis rather than letting it run off the canvas edge, where the wearer
// would lose the tail with nothing saying it had been cut. The session screen
// wraps the flash in full (see the flashLines path) and is unaffected.
function headerLine(state: AppState, fallback: string): string {
  const flash = activeFlash(state);
  if (flash === null) return fallback;
  // Wrapped to a width that already reserves the ellipsis, so the clipped line
  // plus its "…" still fits inside LINE_WIDTH_PX.
  const lines = wrapText(flash, LINE_WIDTH_PX - measureDefault("…"));
  if (lines.length <= 1) return flash;
  return `${lines[0]}…`;
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
// The fleet as the home screen shows it: scoped to the phone's org filter
// (XERK-171), so filtering orgs on the phone narrows the glasses session list
// too. The full state.agents is kept intact for session lookups (a session you
// are already IN must not vanish because its org left the filter — the web
// dashboard's org.js scopes the list the same one-way).
function homeAgents(state: AppState): AgentInfo[] {
  return filterAgents(state.agents, state.orgFilter);
}

function homeHeaderText(state: AppState): string {
  let working = 0;
  let waiting = 0;
  for (const agent of homeAgents(state)) {
    if (!agent.online) continue;
    for (const session of agent.sessions ?? []) {
      const s = liveState(session);
      if (s === "working") working++;
      else if (s === "waiting") waiting++;
    }
  }
  return `TURMA ${working} run · ${waiting} ask`;
}

export function buildHomeRows(state: AppState): HomeRow[] {
  const rows: HomeRow[] = [];
  const hosts = [...homeAgents(state)].sort((a, b) => (a.device ?? a.key).localeCompare(b.device ?? b.key));
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
      const name = sessionName(session);
      // The host is already the header above these rows, so the row itself is
      // just <repo>-<generated name> (e.g. "Turma-Adding Compose Flag"),
      // falling back to <repo>-<short id> when the session is unnamed.
      rows.push({
        kind: "session",
        hostKey: agent.key,
        sessionId: session.id,
        selectable: true,
        text: `${g} ${labelOrRepo}-${name}`,
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

// The transcript is a flat single-column list on a monochrome display — no
// alignment or colour to lean on — so the only way to tell who said what is a
// textual marker at the head of each turn. The user's own turns open with a "»"
// chevron; the agent's replies open with a "·" dot. Both markers are needed now
// that turns are packed with no blank line between them (transcript.ts strips
// empty lines): without a per-role first-line marker, an agent turn's opening
// line would be indistinguishable from a user turn's hang-indented continuation
// line. Neither marker is the single ">" the menu/home screens use as a
// selection cursor, so the two never read as the same affordance.
function roleMarker(role: string): string {
  if (role === "user") return "» ";
  if (role === "assistant") return "· ";
  return `[${role}] `;
}

// Wraps one turn's text into hang-indented lines: the role marker on the first
// line, a matching indent (CONTINUATION_INDENT) on every wrapped continuation
// line, so each turn reads as one clean left-aligned block and the marker
// column stays visually distinct. Content is wrapped to `contentWidth()` (a hair
// narrower than the display) so the prefix never pushes a line past the edge.
function roleBlock(role: string, text: string): string[] {
  const marker = roleMarker(role);
  return wrapCached(text, contentWidth()).map((line, i) =>
    i === 0 ? marker + line : CONTINUATION_INDENT + line
  );
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
  // Every entry renders in full, the moment it lands (XERK-251 — the newest
  // one used to type in character by character).
  const entries = buffer?.entries ?? [];
  for (const entry of entries) {
    // Concise ingest (transcript.ts) drops a pure tool-call turn to empty
    // text — don't render that as a blank line.
    if (entry.text === "") continue;
    lines.push(...roleBlock(entry.role, entry.text));
  }
  // A pending question no longer duplicates here — the session bottom's sheet
  // mode (Task 6) is the one place it renders. PR links aren't part of the
  // question, so they still surface at the newest end of the transcript.
  const s = findSessionLocal(state, hostKey, sessionId);
  for (const url of s?.session?.newPrUrls ?? []) {
    lines.push(...wrapCached(`PR ${url}`, LINE_WIDTH_PX));
  }
  // The in-progress assistant turn scraped live from the TUI (real-time),
  // rendered as the newest entry. It supersedes nothing in the committed
  // transcript — the agent clears it (empty text) the instant the turn
  // completes and the committed tail owns that message.
  const lt = state.liveTurn;
  if (lt && lt.sessionId === sessionId && lt.text) {
    lines.push(...roleBlock("assistant", lt.text));
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
  // Pass the host: unlike the home list this screen is not pre-gated on
  // `agent.online`, so without it a dead host's session reads "working"
  // forever here (XERK-235).
  const host = findAgentLocal(state, sess.hostKey);
  const live = s ? liveState(s, typeof host?.lastSeen === "number" ? host.lastSeen : undefined) : "idle";
  const status = statusLabel({ mic, live });
  const focused = focus === "bottom";

  const question = s?.session?.question;
  if (questionSheetActive(question, sess)) {
    const options = s?.session?.questionOptions ?? [];
    const selected = sess.selected;
    // The question fills the box; drop the background status so it doesn't sit
    // on top of the sheet. (questionSheetActive already implies mic idle, so
    // there's no mic indicator to preserve here.)
    return { mode: "sheet", lines: sheetBody({ question, options, selected }), options, selected, status: "", focused };
  }

  const draft = sess.draft;
  const viewOffset = sess.viewOffset;
  // Once there's a typed/dictated draft, hide the background status so it
  // doesn't crowd the text. Mic indicators ([REC]/[…]/[!]) are the user's own
  // action, so keep those — only the idle live status is suppressed.
  const boxStatus = mic === "idle" && draft.length > 0 ? "" : status;
  return { mode: "input", lines: inputBoxBody({ text: draft, focused, mic, viewOffset }), status: boxStatus, focused };
}

// The bottom box's on-screen height in text lines. Input/sheet boxes cap at
// BOTTOM_MAX_LINES via bottomBoxLines; the menu box is already capped at
// MENU_MAX_LINES by menuBox, so it sizes to its own content (up to 8 lines).
// Shared by the evenhub backend (which sizes the box container) and
// sessionOverlay (which sizes the transcript above it) so the two never drift.
export function boxLineCount(bottom: BottomModel): number {
  return bottom.mode === "menu" ? Math.max(1, bottom.lines.length) : bottomBoxLines(bottom.lines);
}

// The sticky live-tail refusal line(s) pinned atop this session's transcript,
// or [] when the focused session's tail hasn't been refused (XERK-335). Unlike
// the transient flash, this is persistent, so it must be reflected in the
// scroll-offset math too (see sessionTranscriptArea) — otherwise the transcript
// could scroll a line or two past what's actually visible.
function sessionRefusalLines(state: AppState, sess: SessionScreenState): string[] {
  const refusal = state.liveRefusal?.sessionId === sess.sessionId ? state.liveRefusal.message : null;
  return refusal ? wrap(`✗ ${refusal}`) : [];
}

// The transcript's visible line-count for a given session — the bottom box
// (input or sheet) grows/shrinks with its content, and a sticky refusal line
// eats into it, so app.ts's scroll-offset math needs this exact figure to stay
// in sync with what renderSession actually windows. Shared rather than
// duplicated so the two never drift. (The transient flash is deliberately NOT
// subtracted here — it comes and goes on a 4s timer, so folding it into the
// scroll area would make the transcript jump under a scrolled reader.)
export function sessionTranscriptArea(state: AppState, sess: SessionScreenState): number {
  const sticky = sessionRefusalLines(state, sess).length;
  return Math.max(1, DISPLAY_LINES - bottomBoxLines(renderSessionBottom(state, sess).lines) - sticky);
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
  // A terminal live-tail refusal (XERK-335) is STICKY, not a 4s flash: the tail
  // won't recover on its own (a wrong hub password 401s every reconnect), so its
  // reason stays pinned atop the transcript — below any transient flash — until
  // the wearer leaves the session. The poll keeps the content below it current.
  const stickyLines = [...flashLines, ...sessionRefusalLines(state, sess)];
  const area = Math.max(1, DISPLAY_LINES - bottomBoxLines(bottom.lines) - stickyLines.length);
  const maxOffset = Math.max(0, content.length - area);
  const offset = Math.min(sess.offset, maxOffset);
  const end = content.length - offset;
  const start = Math.max(0, end - area);
  const transcriptLines = [...stickyLines, ...content.slice(start, end)];

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
// box leaves, with `bottom` (a menu-mode box) drawn over it.
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
  const s = findSessionLocal(state, c.action.hostKey, c.action.sessionId);
  const name = s ? sessionName(s) : c.action.sessionId.slice(0, 6);
  return `End session ${name}?`;
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

export type NewRepoRow = { kind: "repo"; repo: string; text: string };

export function buildNewRepoRows(state: AppState, hostKey: string): NewRepoRow[] {
  const agent = findAgentLocal(state, hostKey);
  if (!agent) return [];
  const rows: NewRepoRow[] = [];
  for (const repo of agent.repos ?? []) {
    // The repos-root pseudo-repo spawns a session at the root (no worktree);
    // give it a legible label instead of the bare "(root)" sentinel name.
    rows.push({ kind: "repo", repo: repo.name, text: repo.isRoot ? "Repos root (all repos)" : repo.name });
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
