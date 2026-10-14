// PURE rendering: (state) -> a ScreenModel. No I/O, no Date.now — every
// timestamp render needs travels in AppState.now. Target: 10 lines x ~560px
// usable width (the G2's 576x288 canvas, ~10 text lines).
import type { AppState, ReplyScreenState, SessionScreenState } from "./app.ts";
import { fontSafe, fontStrip } from "./font.ts";
import { bottomBoxLines, inputBoxBody, menuBox, sheetBody, statusLabel, type MicState } from "./input-box.ts";
import { DISPLAY_LINES, LINE_WIDTH_PX } from "./layout.ts";
import { filterAgents, glyph, inReview, liveState, sessionName, siteKeyOf } from "./sessions.ts";
import { measureDefault, measureGeneration, wrapText } from "./text-wrap.ts";
import type { AgentInfo, SessionInfo } from "./types.ts";
import { Board } from "./vendor/engines.ts";

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
  kind: "groupHeader" | "offline" | "session" | "newSession" | "settings";
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
    const seen = typeof agent.lastSeen === "number" ? agent.lastSeen : undefined;
    for (const session of agent.sessions ?? []) {
      const s = liveState(session, seen);
      if (s === "working") working++;
      else if (s === "waiting") waiting++;
    }
  }
  return `TURMA ${working} run · ${waiting} ask`;
}

// The display name of an org (XERK-1913): board.js's own orgName, the same label
// the web and the phone's org filter show; a host with no tracker is "No org".
export function orgDisplayName(key: string, agents: AgentInfo[]): string {
  if (!key) return "No org";
  const named = agents.find((a) => siteKeyOf(a) === key && a.jira?.orgName);
  return Board.orgName(key, named?.jira?.orgName ?? null);
}

// The fleet partitioned by org, orgs by display name with "No org" last — what
// the new-session flow offers. Machines are never named on the display
// (XERK-1913), so the hosts behind an org are an implementation detail.
export function orgGroups(agents: AgentInfo[]): { key: string; name: string; agents: AgentInfo[] }[] {
  const byKey = new Map<string, AgentInfo[]>();
  for (const a of [...agents].sort((x, y) => x.key.localeCompare(y.key))) {
    const k = siteKeyOf(a);
    byKey.set(k, [...(byKey.get(k) ?? []), a]);
  }
  return [...byKey.entries()]
    .map(([key, list]) => ({ key, name: orgDisplayName(key, agents), agents: list }))
    .sort((x, y) => Number(!x.key) - Number(!y.key) || x.name.localeCompare(y.name));
}

// The home list in the Sessions page's status sections (XERK-1913), the split
// and order the phone, the web and Android use: Ready for review (`inReview`,
// oldest-waiting first), Active (working / waiting / holding), Idle, Queued,
// then Ended (stopped / errored records). Newest first within a group, like
// the phone. Machines are never named — every online host's sessions share one
// list; an offline host's sessions stay hidden, as before, and a count row
// says how many hosts that is.
export function buildHomeRows(state: AppState): HomeRow[] {
  const rows: HomeRow[] = [];
  const agents = homeAgents(state);
  const online = agents.filter((a) => a.online);
  const offline = agents.length - online.length;
  if (offline) {
    const text = online.length ? `${offline} host${offline === 1 ? "" : "s"} offline` : "Hosts offline";
    rows.push({ kind: "offline", selectable: false, text });
  }
  const now = Date.now();
  const seen = (a: AgentInfo) => (typeof a.lastSeen === "number" ? a.lastSeen : undefined);
  const all = online
    .flatMap((agent) => (agent.sessions ?? []).map((session) => ({ agent, session })))
    .sort((a, b) => (b.session.createdAt ?? "").localeCompare(a.session.createdAt ?? ""));
  const running = all.filter((x) => x.session.status === "running");
  const review = running.filter((x) => inReview(x.session, seen(x.agent), now));
  // Oldest-waiting first by the hub's attention `since` (phone `render.ts`);
  // a row with none keeps its place after them (the sort is stable).
  review.sort((a, b) => {
    const x = a.session.attention?.since, y = b.session.attention?.since;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return typeof x === "number" ? -1 : typeof y === "number" ? 1 : 0;
  });
  const rest = running.filter((x) => !review.includes(x));
  const ACTIVE = ["working", "waiting", "holding"];
  const isActive = (x: (typeof all)[number]) => ACTIVE.includes(liveState(x.session, seen(x.agent), now));
  const groups: [string, typeof all][] = [
    ["Ready for review", review],
    ["Active", rest.filter(isActive)],
    ["Idle", rest.filter((x) => !isActive(x))],
    ["Queued", all.filter((x) => x.session.status === "queued")],
    ["Ended", all.filter((x) => x.session.status !== "running" && x.session.status !== "queued")],
  ];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    rows.push({ kind: "groupHeader", selectable: false, text: `${title} (${list.length})` });
    for (const { agent, session } of list) {
      const display = state.pending[session.id] ? "pending" : liveState(session, seen(agent), now);
      const g = glyph(display);
      const labelOrRepo = session.label || session.repo;
      const name = glassesName(session);
      // The row is just <repo>-<generated name> (e.g. "Turma-Adding Compose
      // Flag"), falling back to <repo>-<short id> when the session is unnamed.
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

// A home row's identity: a session by host + id (one id can sit on two hosts
// mid-migration), an action row by its kind. Headers have none.
export function homeRowKey(row: HomeRow | undefined): string | undefined {
  if (!row || !row.selectable) return undefined;
  return row.kind === "session" ? `s:${row.hostKey}:${row.sessionId}` : row.kind;
}

// Where the home cursor sits in `rows`: on the selected row wherever the
// status groups moved it (XERK-1913), else the index, kept in range and off
// headers. Render and input both resolve through this, so the marker and a tap
// agree even when the list regrouped with no poll (a host aging offline).
export function homeCursor(rows: HomeRow[], home: { cursor: number; selected?: string }): number {
  if (home.selected) {
    const i = rows.findIndex((r) => homeRowKey(r) === home.selected);
    if (i >= 0) return i;
  }
  return clampHomeCursor(rows, home.cursor);
}

// Keeps the home cursor in range as the row list shrinks/grows (host
// offline, sessions converging away) and off non-selectable rows (host
// group headers, offline lines) — including the very first render, where the
// cursor starts at 0 and row 0 is a non-selectable header once any session is
// listed. Searches outward (nearest first, forward on ties) for
// the closest selectable row; "+ New session"/"Settings" are always present
// and selectable, so a selectable row always exists once rows is non-empty.
function clampHomeCursor(rows: { selectable: boolean }[], cursor: number): number {
  if (rows.length === 0) return 0;
  const c = Math.max(0, Math.min(cursor, rows.length - 1));
  if (rows[c]?.selectable) return c;
  for (let d = 1; d < rows.length; d++) {
    const forward = c + d;
    if (forward < rows.length && rows[forward]?.selectable) return forward;
    const backward = c - d;
    if (backward >= 0 && rows[backward]?.selectable) return backward;
  }
  return c;
}

function renderHome(state: AppState): string[] {
  const header = headerLine(state, homeHeaderText(state));
  const rows = buildHomeRows(state);
  const cursor = homeCursor(rows, state.home);
  const { visible, start } = windowRows(rows, cursor, DISPLAY_LINES - 1);
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === cursor)));
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
    return { mode: "sheet", lines: sheetBody({ question: fontSafe(question), options: options.map(fontSafe), selected }), options, selected, status: "", focused };
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
  return refusal ? wrap(`x ${refusal}`) : [];
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
  // An active flash (e.g. "√ queued" after Send/restart/kill) has nowhere
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

// sessionName made drawable by the G2 font. Done here, not in sessionName: the
// phone companion shares that and pre-fills Rename from it, so degrading it
// there would write back to the hub. Stripped BEFORE the name falls back, so an
// undrawable summary gets the short id rather than "?".
function glassesName(s: SessionInfo): string {
  return sessionName(s.summary ? { ...s, summary: fontStrip(s.summary) } : s);
}

// ---- confirm ----------------------------------------------------------

function confirmHeader(state: AppState): string {
  const c = state.confirm;
  if (!c) return "Confirm";
  const s = findSessionLocal(state, c.action.hostKey, c.action.sessionId);
  const name = s ? glassesName(s) : c.action.sessionId.slice(0, 6);
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

// A picker's cursor held inside its list: hosts going offline mid-flow shrink
// the org/repo lists under a cursor the operator left further down.
export function pickerCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length - 1));
}

// ---- newOrg ---------------------------------------------------------------

// The orgs a session can be started in: those with at least one online host.
export function newOrgRows(state: AppState): { orgKey: string; text: string }[] {
  return orgGroups(state.agents.filter((a) => a.online)).map((g) => ({ orgKey: g.key, text: fontSafe(g.name) }));
}

function renderNewOrg(state: AppState): string[] {
  const n = state.newOrg;
  const header = headerLine(state, "New session · Choose org");
  const rows = newOrgRows(state);
  if (!n) return [header];
  const cursor = pickerCursor(n.cursor, rows.length);
  const { visible, start } = windowRows(rows, cursor, DISPLAY_LINES - 1);
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === cursor)));
  return lines;
}

// ---- newRepo ------------------------------------------------------------

export type NewRepoRow = { kind: "repo"; repo: string; text: string };

function orgOnlineAgents(state: AppState, orgKey: string): AgentInfo[] {
  return state.agents
    .filter((a) => a.online && siteKeyOf(a) === orgKey)
    .sort((x, y) => x.key.localeCompare(y.key));
}

// Every repo cloned on any online host in the org, once each, repos root first.
export function buildNewRepoRows(state: AppState, orgKey: string): NewRepoRow[] {
  const rows: NewRepoRow[] = [];
  const seen = new Set<string>();
  const repos = orgOnlineAgents(state, orgKey).flatMap((a) => a.repos ?? []);
  for (const repo of [...repos.filter((r) => r.isRoot), ...repos.filter((r) => !r.isRoot)]) {
    if (seen.has(repo.name)) continue;
    seen.add(repo.name);
    // The repos-root pseudo-repo spawns a session at the root (no worktree);
    // give it a legible label instead of the bare "(root)" sentinel name.
    rows.push({ kind: "repo", repo: repo.name, text: repo.isRoot ? "Repos root (all repos)" : repo.name });
  }
  return rows;
}

// The host a new session in (org, repo) starts on, chosen for the operator
// (XERK-1913): an online host in that org with the repo cloned, the one running
// the fewest sessions, ties by host key so the pick is stable.
export function spawnHostFor(state: AppState, orgKey: string, repo: string): AgentInfo | undefined {
  const running = (a: AgentInfo) => (a.sessions ?? []).filter((s) => s.status === "running").length;
  return orgOnlineAgents(state, orgKey)
    .filter((a) => (a.repos ?? []).some((r) => r.name === repo))
    .sort((x, y) => running(x) - running(y))[0];
}

function renderNewRepo(state: AppState): string[] {
  const n = state.newRepo;
  const org = n ? fontSafe(orgDisplayName(n.orgKey, state.agents)) : "";
  const header = headerLine(state, `New session · ${org} · Choose repo`);
  if (!n) return [header];
  const rows = buildNewRepoRows(state, n.orgKey);
  const cursor = pickerCursor(n.cursor, rows.length);
  const { visible, start } = windowRows(rows, cursor, DISPLAY_LINES - 1);
  const lines = [header];
  visible.forEach((row, i) => lines.push(markerLine(row.text, start + i === cursor)));
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
    case "newOrg":
      return linesModel(renderNewOrg(state));
    case "newRepo":
      return linesModel(renderNewRepo(state));
    case "newPrompt":
      return linesModel(renderNewPrompt(state));
    case "settings":
      return linesModel(renderSettings(state));
  }
}
