import type { HubClient } from "./hub-client.ts";
import type { GlassesDisplay } from "./display/index.ts";
import type { Dictation, DictationResult } from "./dictation.ts";
import { emptyBuffer, mergeTail, prependHistory, type TranscriptBuffer } from "./transcript.ts";
import { NoopLiveTail, type LiveTailLike } from "./live.ts";
import {
  advanceReveal,
  emptyReveal,
  fullReveal,
  revealComplete,
  type RevealState,
} from "./reveal.ts";
import { flattenSessions } from "./sessions.ts";
import { draftMaxViewOffset, type MicState } from "./input-box.ts";
import {
  buildActionsRows,
  buildHomeRows,
  buildNewRepoRows,
  questionSheetActive,
  render,
  sessionContentLines,
  sessionTranscriptArea,
  SESSION_SCROLL_STEP,
  LIVE_TURN_ID,
  type HomeRow,
  type SessionFocus,
} from "./render.ts";
import type { AgentInfo, InputEvent, SessionInfo, SessionRef, SessionStatus, TailEntry } from "./types.ts";

export type Screen =
  | "home"
  | "session"
  | "actions"
  | "reply"
  | "confirm"
  | "newHost"
  | "newRepo"
  | "newPrompt"
  | "settings";

// Bookkeeping recorded whenever a mutation is queued, so its glyph renders as
// "…" (pending) until a later poll shows the expected change, or 60s pass —
// whichever first. Keyed by sessionId for session-targeted actions, or
// `spawn:<hostKey>:<repo>` for a not-yet-existing session being spawned.
export interface PendingEntry {
  at: number;
  status?: SessionStatus;
  question?: string | null;
  tailLen?: number;
  sessionCount?: number; // spawn pending only: session count for host+repo at spawn time
}

export const PENDING_TIMEOUT_MS = 60 * 1000;
export const FLASH_DURATION_MS = 4000;
export const FLASH_QUEUED = "✓ queued — agent picks up in ~20s";
export const FLASH_HUB_UNREACHABLE = "hub unreachable";
export const HISTORY_RETRY_MS = 3000;
export const WORKING_WINDOW_SEC = 90;
// How often the typewriter reveal advances while a session's newest entry is
// still catching up to its full text. ~12fps — smooth enough to read as
// typing, cheap enough for the BLE render path's debounce (display/debounce.ts).
export const REVEAL_TICK_MS = 80;

export function pendingKeyForSpawn(hostKey: string, repo: string): string {
  return `spawn:${hostKey}:${repo}`;
}

export interface HomeScreenState {
  cursor: number;
}

export interface SessionScreenState {
  hostKey: string;
  sessionId: string;
  offset: number; // lines scrolled up from the bottom (0 = anchored at bottom)
  focus: SessionFocus; // transcript scroll vs. the bottom input/sheet box
  draft: string; // dictation buffer for the bottom input box
  mic: MicState;
  viewOffset: number; // scroll within a tall bottom box
  selected: number; // highlighted sheet option (AskUserQuestion)
}

// Every transition into the session screen builds its SessionScreenState
// through here so the new focus/draft/mic/viewOffset/selected fields never
// drift out of sync between call sites.
export function newSessionState(hostKey: string, sessionId: string): SessionScreenState {
  return { hostKey, sessionId, offset: 0, focus: "transcript", draft: "", mic: "idle", viewOffset: 0, selected: 0 };
}

export interface ActionsScreenState {
  hostKey: string;
  sessionId: string;
  cursor: number;
}

export type ReplyTarget =
  | { kind: "session"; hostKey: string; sessionId: string; back: "session" }
  | {
      kind: "spawn";
      hostKey: string;
      repo: string;
      label?: string;
      baseRef?: string;
      model?: string;
      permissionMode?: string;
    };

export interface ReplyScreenState {
  target: ReplyTarget;
  phase: "listening" | "preview" | "unavailable";
  text: string;
  reason?: string;
  cursor: number; // preview/unavailable button selection
}

export type ConfirmAction =
  | { kind: "kill"; hostKey: string; sessionId: string }
  | { kind: "delete"; hostKey: string; sessionId: string };

export interface ConfirmScreenState {
  action: ConfirmAction;
  cursor: number; // 0 = Cancel (preselected), 1 = Confirm
}

export interface NewHostScreenState {
  cursor: number;
}

export interface NewRepoScreenState {
  hostKey: string;
  cursor: number;
}

export interface NewPromptScreenState {
  hostKey: string;
  repo: string;
  cursor: number;
}

export interface SettingsScreenState {
  cursor: number;
}

export interface AppState {
  now: number;
  screen: Screen;

  flash: string | null;
  flashUntil: number;
  pollErrorActive: boolean;

  agents: AgentInfo[];
  sessionRefs: SessionRef[];
  transcripts: Record<string, TranscriptBuffer>;
  // Typewriter state for the focused session's newest transcript entry (see
  // reveal.ts). Only ever describes state.session's newest entry; reset to
  // empty whenever the session screen isn't the one in view.
  reveal: RevealState;
  // The in-progress assistant turn scraped live from the session's TUI pane
  // (real-time streaming — the transcript JSONL only lands on completion).
  // Only for the focused session; cleared on completion, session change, and
  // background. Rendered as the newest transcript entry (LIVE_TURN_ID).
  liveTurn: { sessionId: string; text: string } | null;
  pending: Record<string, PendingEntry>;
  loadingHistory: Record<string, boolean>;

  home: HomeScreenState;
  session: SessionScreenState | null;
  actions: ActionsScreenState | null;
  reply: ReplyScreenState | null;
  confirm: ConfirmScreenState | null;
  newHost: NewHostScreenState | null;
  newRepo: NewRepoScreenState | null;
  newPrompt: NewPromptScreenState | null;
  settings: SettingsScreenState | null;
}

export function createInitialState(now: number): AppState {
  return {
    now,
    screen: "home",
    flash: null,
    flashUntil: 0,
    pollErrorActive: false,
    agents: [],
    sessionRefs: [],
    transcripts: {},
    reveal: emptyReveal(),
    liveTurn: null,
    pending: {},
    loadingHistory: {},
    home: { cursor: 0 },
    session: null,
    actions: null,
    reply: null,
    confirm: null,
    newHost: null,
    newRepo: null,
    newPrompt: null,
    settings: null,
  };
}

// ---- lookups --------------------------------------------------------------

export function findAgent(state: AppState, hostKey: string): AgentInfo | undefined {
  return state.agents.find((a) => a.key === hostKey);
}

export function findSession(state: AppState, hostKey: string, sessionId: string): SessionInfo | undefined {
  return findAgent(state, hostKey)?.sessions.find((s) => s.id === sessionId);
}

export interface AppOptions {
  client: HubClient;
  display: GlassesDisplay;
  dictation: Dictation;
  // Near-real-time transcript stream for the focused session. Defaults to a
  // no-op (poll-only) so callers/tests that don't wire it still work.
  liveTail?: LiveTailLike;
  now?: () => number;
  pollMs?: number;
}

// The controller: owns AppState, drives the HubClient on a poll loop, reacts
// to InputEvents from the display, and re-renders after every mutation.
export class App {
  private readonly client: HubClient;
  private readonly display: GlassesDisplay;
  private readonly dictation: Dictation;
  private readonly liveTail: LiveTailLike;
  private readonly now: () => number;
  private readonly pollMs: number;

  private state: AppState;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private historyTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRevealAt = 0;
  private paused = false;

  constructor(opts: AppOptions) {
    this.client = opts.client;
    this.display = opts.display;
    this.dictation = opts.dictation;
    this.liveTail = opts.liveTail ?? new NoopLiveTail();
    this.now = opts.now ?? (() => Date.now());
    this.pollMs = opts.pollMs ?? 6000;
    this.state = createInitialState(this.now());
  }

  getState(): AppState {
    return this.state;
  }

  async start(): Promise<void> {
    await this.display.start();
    this.display.onInput((e) => this.handleInput(e));
    this.schedulePoll(0);
  }

  // Lifecycle glue (Task 7) funnels foreground-exit / abnormal-exit /
  // system-exit through here via lifecycle.ts's onForegroundExit and
  // onAbnormalOrSystemExit — both call app.pause(), never dictation.cancel()
  // directly. That keeps dictation-cancel ownership in exactly one place:
  // App is the only thing that knows whether a dictation is actually active
  // (the reply screen's "listening" phase) and is already the sole caller of
  // dictation.start/stop/cancel for user-driven flows (see onReply below).
  pause(): void {
    if (this.state.screen === "reply" && this.state.reply?.phase === "listening") {
      const r = this.state.reply;
      this.dictation.cancel();
      this.leaveReply(r);
    } else if (this.state.session && (this.state.session.mic === "recording" || this.state.session.mic === "finalising")) {
      // Task 5: dictation can now also be live directly in the session's
      // bottom box (no reply screen involved) — cancel that mic the same
      // way, so backgrounding never leaves it hot.
      this.dictation.cancel();
      this.setState({ session: { ...this.state.session, mic: "idle" } });
    }
    this.paused = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Backgrounding also stops the live transcript stream and its reveal
    // animation — both re-established on resume() if we come back to a
    // session screen. Leaving the live WS open while backgrounded would keep
    // the agent tailing a transcript nobody's watching.
    this.liveTail.stop();
    this.clearRevealTimer();
    if (this.state.liveTurn) this.state = { ...this.state, liveTurn: null };
    // Backgrounding stops the poll loop above, but history-fetch retry
    // timers are independent `setTimeout`s keyed by sessionId — without
    // this they keep firing every HISTORY_RETRY_MS while backgrounded.
    this.clearHistoryTimers();
    if (Object.keys(this.state.loadingHistory).length > 0) {
      this.state = { ...this.state, now: this.now(), loadingHistory: {} };
      this.repaint();
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Re-attach the live stream if we resume straight onto a session screen
    // (lifecycle can restore us there via restoreScreen).
    if (this.state.screen === "session" && this.state.session) {
      this.startLiveTail(this.state.session.hostKey, this.state.session.sessionId);
      this.reanchorReveal(this.state.session.sessionId);
      this.scheduleRevealTick();
    }
    this.schedulePoll(0);
  }

  // Lifecycle glue (Task 6): jumps straight to a screen/session snapshot
  // restored from a background→foreground migration (the host may recreate
  // a fresh WebView on restore, so in-memory AppState alone isn't enough —
  // see glasses/src/lifecycle.ts). Hardware-agnostic: no SDK dependency,
  // just the same public setState path every other mutation uses.
  restoreScreen(screen: Screen, session: SessionScreenState | null): void {
    this.setState({ screen, session });
  }

  private schedulePoll(delayMs: number): void {
    if (this.paused) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private setState(patch: Partial<AppState>): void {
    const prevScreen = this.state.screen;
    const prevSession = this.state.session;
    this.state = { ...this.state, ...patch, now: this.now() };
    // Leaving the session screen: that session's history-fetch retry timer
    // (if any) and its loading-line flag are no longer relevant to what's on
    // screen — stop the background 202-retry loop from continuing to poll
    // for a transcript nobody's looking at.
    if (prevScreen === "session" && prevSession && this.state.screen !== "session") {
      this.clearHistoryTimer(prevSession.sessionId);
      if (this.state.loadingHistory[prevSession.sessionId]) {
        this.state = {
          ...this.state,
          loadingHistory: { ...this.state.loadingHistory, [prevSession.sessionId]: false },
        };
      }
    }
    this.syncSession(prevScreen, prevSession);
    this.repaint();
  }

  // Attach/detach the near-real-time transcript stream (and its reveal
  // animation) to whatever session — if any — the session screen now shows.
  // Called from every setState, so it fires on entering a session, switching
  // between two sessions, and leaving the session screen. LiveTail.start is
  // idempotent for the same session, so same-session setStates (scrolling,
  // offset changes) don't churn the socket.
  private syncSession(prevScreen: Screen, prevSession: SessionScreenState | null): void {
    const cur = this.state.session;
    const inSession = this.state.screen === "session" && !!cur;
    const wasSession = prevScreen === "session" && !!prevSession;
    const same =
      inSession &&
      wasSession &&
      prevSession!.sessionId === cur!.sessionId &&
      prevSession!.hostKey === cur!.hostKey;
    if (same) return;

    if (inSession) {
      this.startLiveTail(cur!.hostKey, cur!.sessionId);
      // The existing buffer is history, not a live stream — show it in full,
      // and let only subsequent growth type in. Any live turn from a previous
      // session is dropped (a fresh session has no in-progress turn until the
      // stream delivers one).
      const entries = this.state.transcripts[cur!.sessionId]?.entries ?? [];
      const last = entries[entries.length - 1];
      this.state = {
        ...this.state,
        liveTurn: null,
        reveal: fullReveal(last?.id ?? null, last?.text.length ?? 0),
      };
      this.lastRevealAt = this.now();
    } else if (wasSession) {
      this.liveTail.stop();
      this.clearRevealTimer();
      this.state = { ...this.state, liveTurn: null, reveal: emptyReveal() };
    }
  }

  private startLiveTail(hostKey: string, sessionId: string): void {
    this.liveTail.start(hostKey, sessionId, (ev) => {
      if (ev.type === "tail") this.onLiveTail(hostKey, sessionId, ev.entries);
      else this.onLiveTurn(hostKey, sessionId, ev.text);
    });
  }

  // A committed transcript delta for the focused session: merge it into the
  // buffer (same dedup/append as a poll's tail), re-anchor the reveal, and
  // repaint. Frames for a session no longer in view are dropped (a stale close
  // race).
  private onLiveTail(_hostKey: string, sessionId: string, entries: TailEntry[]): void {
    if (this.state.screen !== "session" || this.state.session?.sessionId !== sessionId) return;
    const existing = this.state.transcripts[sessionId] ?? emptyBuffer();
    const merged = mergeTail(existing, entries);
    this.state = {
      ...this.state,
      now: this.now(),
      transcripts: { ...this.state.transcripts, [sessionId]: merged },
    };
    this.reanchorReveal(sessionId);
    this.repaint();
    this.scheduleRevealTick();
  }

  // The in-progress assistant turn scraped from the TUI (real-time streaming).
  private onLiveTurn(_hostKey: string, sessionId: string, text: string): void {
    if (this.state.screen !== "session" || this.state.session?.sessionId !== sessionId) return;
    if (text) {
      // Still generating — update the live turn and let the reveal type it in.
      this.state = { ...this.state, now: this.now(), liveTurn: { sessionId, text } };
      this.reanchorReveal(sessionId);
    } else {
      // Turn completed: drop the live turn (the committed tail owns the message
      // now) and show the now-committed newest entry in FULL — it was already
      // streamed live via the turn, so don't re-type it from scratch.
      const entries = this.state.transcripts[sessionId]?.entries ?? [];
      const last = entries[entries.length - 1];
      this.state = {
        ...this.state,
        now: this.now(),
        liveTurn: null,
        reveal: fullReveal(last?.id ?? null, last?.text.length ?? 0),
      };
      this.lastRevealAt = this.now();
    }
    this.repaint();
    this.scheduleRevealTick();
  }

  // The newest entry the reveal should type: the live in-progress turn if one
  // is streaming for this session, else the newest committed transcript entry.
  private newestRevealTarget(sessionId: string): { id: string | null; len: number } {
    const lt = this.state.liveTurn;
    if (lt && lt.sessionId === sessionId && lt.text) return { id: LIVE_TURN_ID, len: lt.text.length };
    const entries = this.state.transcripts[sessionId]?.entries ?? [];
    const last = entries[entries.length - 1];
    return { id: last?.id ?? null, len: last?.text.length ?? 0 };
  }

  private repaint(): void {
    this.display.render(render(this.state));
  }

  private flash(text: string): void {
    const now = this.now();
    this.state = { ...this.state, now, flash: text, flashUntil: now + FLASH_DURATION_MS };
  }

  // ---- reveal (streaming typewriter) ----------------------------------

  private clearRevealTimer(): void {
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  // Re-anchor the reveal to the focused session's current newest entry with
  // dt=0 (see reveal.ts): starts a brand-new entry hidden and snaps blocks,
  // but types nothing yet — the tick loop does the typing. Called on every
  // transcript change (live delta or poll) so the reveal tracks the newest id.
  private reanchorReveal(sessionId: string): void {
    if (this.state.session?.sessionId !== sessionId) return;
    const target = this.newestRevealTarget(sessionId);
    const reveal = advanceReveal(this.state.reveal, target.id, target.len, 0);
    this.state = { ...this.state, reveal };
    this.lastRevealAt = this.now();
  }

  private scheduleRevealTick(): void {
    if (this.paused || this.revealTimer) return;
    if (this.state.screen !== "session") return;
    // While the user has scrolled up to read history (offset > 0) the newest
    // entry is off-screen, so typing it in is invisible work that also creeps
    // the visible window; freeze the tick loop. It re-arms when they scroll
    // back to the tail (offset 0) — see onSession.
    if (this.state.session && this.state.session.offset > 0) return;
    this.revealTimer = setTimeout(() => {
      this.revealTimer = null;
      this.revealTick();
    }, REVEAL_TICK_MS);
  }

  private revealTick(): void {
    const s = this.state.session;
    if (this.state.screen !== "session" || !s) return;
    // Scrolled up since this tick was scheduled — pause without advancing or
    // repainting; onSession re-arms on the return to the tail.
    if (s.offset > 0) return;
    const target = this.newestRevealTarget(s.sessionId);
    const targetLen = target.len;
    const now = this.now();
    const dt = now - this.lastRevealAt;
    this.lastRevealAt = now;
    const reveal = advanceReveal(this.state.reveal, target.id, targetLen, dt);
    this.state = { ...this.state, now, reveal };
    this.repaint();
    if (!revealComplete(reveal, targetLen)) this.scheduleRevealTick();
  }

  // ---- polling --------------------------------------------------------

  async poll(): Promise<void> {
    const now = this.now();
    try {
      const res = await this.client.listAgents();
      const sessionRefs = flattenSessions(res.agents);
      const transcripts = { ...this.state.transcripts };
      for (const ref of sessionRefs) {
        const tail = ref.session.session?.tail ?? [];
        if (tail.length === 0) continue;
        const existing = transcripts[ref.session.id] ?? emptyBuffer();
        transcripts[ref.session.id] = mergeTail(existing, tail);
      }
      const pending = this.reconcilePending(this.state.pending, res.agents, sessionRefs, now);
      const wasErroring = this.state.pollErrorActive;
      // Snapshot the current session's pending-question view *before* the
      // new agents array lands — used below to detect a question that just
      // arrived this poll (vs. one the user is already comfortably sitting
      // in the sheet with).
      const prevSession = this.state.session;
      const prevQuestion = prevSession
        ? findSession(this.state, prevSession.hostKey, prevSession.sessionId)?.session?.question ?? null
        : null;
      this.state = {
        ...this.state,
        now,
        agents: res.agents,
        sessionRefs,
        transcripts,
        pending,
        pollErrorActive: false,
        flash: wasErroring ? null : this.state.flash,
        flashUntil: wasErroring ? 0 : this.state.flashUntil,
      };
      // The row list a fresh home.cursor indexes into just changed (hosts
      // going offline, sessions converging/disappearing) — keep the cursor
      // in range and off non-selectable rows rather than leaving it stranded
      // on a row that no longer exists or never was tappable.
      this.state = { ...this.state, home: { cursor: clampHomeCursor(this.homeRows(), this.state.home.cursor) } };
      // A poll can grow the focused session's transcript too (the 20s
      // heartbeat, or a beat the live stream missed) — re-anchor the reveal so
      // that growth snaps (block) or types (small delta) exactly as a live
      // delta would, rather than flashing in at full length.
      if (this.state.screen === "session" && this.state.session) {
        this.reanchorReveal(this.state.session.sessionId);
        this.scheduleRevealTick();
      }
      // A question that newly appeared while the bottom box was focused in
      // plain input mode must not let the user's next gesture land on the
      // freshly-arrived sheet by accident (and, if they were mid-dictation,
      // must not leave that mic stranded hot) — cancel any live box
      // recording and drop focus back to the transcript. Mirrors
      // ClaudeHUD's setPendingSheet, which drops input focus the instant a
      // sheet appears. Only fires on the *arrival* transition (prevQuestion
      // was falsy) — an already-pending question the user is actively
      // working the sheet for must not get its focus yanked on every poll.
      if (this.state.session && this.state.session.focus === "bottom") {
        const sess = this.state.session;
        const live = findSession(this.state, sess.hostKey, sess.sessionId);
        const nowQuestion = live?.session?.question ?? null;
        if (nowQuestion && !prevQuestion) {
          if (sess.mic === "recording" || sess.mic === "finalising") this.dictation.cancel();
          this.state = { ...this.state, session: { ...sess, mic: "idle", focus: "transcript" } };
        } else if (nowQuestion && prevQuestion && nowQuestion !== prevQuestion) {
          // A *different* question replaced the one already pending on this
          // session while the user was still sitting in its sheet (not a
          // fresh arrival, so the branch above doesn't fire) — the sheet's
          // highlighted row must not carry over onto the new question's own
          // options list. Dispatch already clamps `selected` against the
          // new options length so a stale index can't send a wrong digit,
          // but the highlight itself would still land on the wrong row
          // until the user scrolls. Reset it, edge-triggered the same way
          // as the arrival guard above.
          this.state = { ...this.state, session: { ...sess, selected: 0 } };
        }
      }
      this.repaint();
    } catch {
      if (!this.state.pollErrorActive) {
        this.state = { ...this.state, now, pollErrorActive: true };
        this.flash(FLASH_HUB_UNREACHABLE);
      } else {
        this.state = { ...this.state, now };
      }
      this.repaint();
    } finally {
      this.schedulePoll(this.pollMs);
    }
  }

  // Clears a pending entry once its session shows a change from its
  // snapshot-at-queue-time, or once PENDING_TIMEOUT_MS has passed. Spawn
  // pending entries (keyed by `spawn:<host>:<repo>`) clear once that host's
  // session count for that repo grows past its snapshot.
  private reconcilePending(
    pending: Record<string, PendingEntry>,
    agents: AgentInfo[],
    sessionRefs: SessionRef[],
    now: number
  ): Record<string, PendingEntry> {
    const next: Record<string, PendingEntry> = {};
    for (const [key, entry] of Object.entries(pending)) {
      if (now - entry.at >= PENDING_TIMEOUT_MS) continue;
      if (key.startsWith("spawn:")) {
        const [, hostKey, repo] = key.split(":");
        const count = agents
          .find((a) => a.key === hostKey)
          ?.sessions.filter((s) => s.repo === repo).length ?? 0;
        if (entry.sessionCount != null && count > entry.sessionCount) continue; // converged
        next[key] = entry;
        continue;
      }
      const ref = sessionRefs.find((r) => r.session.id === key);
      if (!ref) {
        next[key] = entry; // session momentarily missing from a beat; keep pending
        continue;
      }
      const s = ref.session;
      const tailLen = s.session?.tail.length ?? 0;
      const converged =
        (entry.status !== undefined && entry.status !== s.status) ||
        (entry.question !== undefined && entry.question !== (s.session?.question ?? null)) ||
        (entry.tailLen !== undefined && entry.tailLen !== tailLen);
      if (converged) continue;
      next[key] = entry;
    }
    return next;
  }

  private markPending(sessionId: string, s: SessionInfo | undefined): void {
    const entry: PendingEntry = {
      at: this.now(),
      status: s?.status,
      question: s?.session?.question ?? null,
      tailLen: s?.session?.tail.length ?? 0,
    };
    this.state = { ...this.state, pending: { ...this.state.pending, [sessionId]: entry } };
  }

  private markSpawnPending(hostKey: string, repo: string): void {
    const count = findAgent(this.state, hostKey)?.sessions.filter((s) => s.repo === repo).length ?? 0;
    const key = pendingKeyForSpawn(hostKey, repo);
    const entry: PendingEntry = { at: this.now(), sessionCount: count };
    this.state = { ...this.state, pending: { ...this.state.pending, [key]: entry } };
  }

  // ---- input dispatch ---------------------------------------------------

  handleInput(e: InputEvent): void {
    switch (this.state.screen) {
      case "home":
        return this.onHome(e);
      case "session":
        return this.onSession(e);
      case "actions":
        return this.onActions(e);
      case "reply":
        return this.onReply(e);
      case "confirm":
        return this.onConfirm(e);
      case "newHost":
        return this.onNewHost(e);
      case "newRepo":
        return this.onNewRepo(e);
      case "newPrompt":
        return this.onNewPrompt(e);
      case "settings":
        return this.onSettings(e);
    }
  }

  private goHome(): void {
    this.setState({ screen: "home" });
  }

  // ---- home ---------------------------------------------------------

  private homeRows(): HomeRow[] {
    return buildHomeRows(this.state);
  }

  private onHome(e: InputEvent): void {
    const rows = this.homeRows();
    // Rows can shrink or reorder between a poll and the next input (a
    // session dies, a host drops offline) — reclamp before acting so a tap
    // never indexes a row that's gone and never lands on a non-selectable
    // row (host headers/offline lines).
    const cursor = clampHomeCursor(rows, this.state.home.cursor);
    if (cursor !== this.state.home.cursor) {
      this.state = { ...this.state, home: { cursor } };
    }
    if (e.type === "doubleTap") {
      this.display.requestExit();
      return;
    }
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      const next = nextSelectableIndex(rows, cursor, dir);
      this.setState({ home: { cursor: next } });
      return;
    }
    if (e.type === "tap") {
      const row = rows[cursor];
      if (!row || !row.selectable) return;
      if (row.kind === "session" && row.hostKey && row.sessionId) {
        this.setState({
          screen: "session",
          session: newSessionState(row.hostKey, row.sessionId),
        });
      } else if (row.kind === "newSession") {
        this.setState({ screen: "newHost", newHost: { cursor: 0 } });
      } else if (row.kind === "settings") {
        this.setState({ screen: "settings", settings: { cursor: 0 } });
      }
    }
  }

  // ---- session --------------------------------------------------------

  private sessionContentLength(hostKey: string, sessionId: string): number {
    const lines = sessionContentLines(this.state, hostKey, sessionId);
    return lines.length;
  }

  // Transcript-focus gestures (the default focus on entering the session
  // screen). scrollUp/scrollDown creep the transcript SESSION_SCROLL_STEP
  // lines at a time (not a full-page jump) against the same area render.ts
  // windows against (sessionTranscriptArea — the bottom box's height varies
  // with its content, so this can't be a fixed constant). tap snaps back to
  // the newest content if scrolled, otherwise hands focus to the bottom
  // box; doubleTap always leaves the session screen.
  private onSession(e: InputEvent): void {
    const s = this.state.session;
    if (!s) return this.goHome();
    if (s.focus === "bottom") return this.onSessionBottom(e, s);
    if (e.type === "doubleTap") return this.goHome();
    const area = sessionTranscriptArea(this.state, s);
    const total = this.sessionContentLength(s.hostKey, s.sessionId);
    const maxOffset = Math.max(0, total - area);
    if (e.type === "scrollDown") {
      const offset = Math.max(0, s.offset - SESSION_SCROLL_STEP);
      this.setState({ session: { ...s, offset } });
      // Back at the tail — resume the typewriter (frozen while scrolled up),
      // catching up to whatever streamed in meanwhile.
      if (offset === 0) this.resumeRevealAtTail(s.sessionId);
      return;
    }
    if (e.type === "scrollUp") {
      if (s.offset >= maxOffset) {
        const buffer = this.state.transcripts[s.sessionId];
        // undefined: history has never been fetched — worth a round trip.
        // true: already fetched and the server told us it's truncated at
        // HISTORY_MAX_MSGS (see render.ts's "truncated" marker) — that can't
        // grow, so re-fetching is pointless. false: genuinely at the top.
        if (buffer?.hasMore === undefined) {
          this.triggerHistoryLoad(s.hostKey, s.sessionId);
          return;
        }
        return; // nothing more to load
      }
      this.setState({ session: { ...s, offset: Math.min(maxOffset, s.offset + SESSION_SCROLL_STEP) } });
      return;
    }
    if (e.type === "tap") {
      if (s.offset > 0) {
        this.setState({ session: { ...s, offset: 0 } }); // snap to newest
        this.resumeRevealAtTail(s.sessionId); // resume the frozen typewriter
      } else {
        this.setState({ session: { ...s, focus: "bottom" } });
      }
    }
  }

  // Re-anchor and restart the reveal tick after the user scrolls back to the
  // tail. reanchorReveal snaps a large backlog (a block that streamed in while
  // scrolled up) or leaves a small one to type; scheduleRevealTick (now
  // unblocked, offset === 0) resumes the animation.
  private resumeRevealAtTail(sessionId: string): void {
    this.reanchorReveal(sessionId);
    this.scheduleRevealTick();
  }

  // Bottom-box focus gestures. A pending AskUserQuestion turns the box into
  // a sheet (Task 6) — dispatched by onSheetBottom below, per
  // questionSheetActive (shared with render.ts's mode choice so the two
  // never disagree about what's on screen). Otherwise (plain input mode, or
  // a pending question the user has already handed off to dictation/a draft)
  // this is Task 5's real dispatch: tap toggles in-box dictation, scroll
  // moves the box's view (or exits to the transcript at either end),
  // doubleTap opens the context actions menu.
  private onSessionBottom(e: InputEvent, s: SessionScreenState): void {
    const live = findSession(this.state, s.hostKey, s.sessionId);
    if (questionSheetActive(live?.session?.question, s)) {
      return this.onSheetBottom(e, s, live);
    }

    if (e.type === "doubleTap") {
      // Leaving input focus with the mic still hot (tap-to-record, then
      // doubleTap before the stop-tap) would strand a live HubAudioDictation
      // recorder capturing until the app happens to background. Cancel it and
      // clear the mic at the transition, mirroring onReply's doubleTap guard.
      this.cancelBoxDictation(s);
      this.setState({
        screen: "actions",
        session: { ...s, mic: "idle" },
        actions: { hostKey: s.hostKey, sessionId: s.sessionId, cursor: 0 },
      });
      return;
    }
    if (e.type === "tap") {
      this.toggleBoxDictation(s);
      return;
    }
    if (e.type === "scrollUp" || e.type === "scrollDown") {
      this.scrollInputBox(e.type, s);
    }
  }

  // Sheet-mode dispatch (Task 6): scroll moves `selected` through
  // [...options, "Dictate answer…"], clamped; tap on an option index sends
  // that 1-based digit as the answer (the agent appends Enter) and hands
  // focus back to the transcript; tap on the trailing "Dictate answer…" row
  // starts box dictation instead of answering directly — that flips
  // questionSheetActive false for the rest of the flow (mic goes hot, then a
  // draft lands), so the box renders/dispatches as plain input from here,
  // and the dictated answer is later sent through the ordinary actions-menu
  // Send path (Task 5) rather than a bespoke one. doubleTap still reaches
  // the actions menu. The mic is guaranteed idle on entry (questionSheetActive
  // requires it), so cancelBoxDictation below is a no-op in practice — kept
  // anyway so no future change to this dispatch can strand a hot mic on a
  // sheet-focus-leaving transition.
  private onSheetBottom(e: InputEvent, s: SessionScreenState, live: SessionInfo | undefined): void {
    const options = live?.session?.questionOptions ?? [];
    if (e.type === "doubleTap") {
      this.cancelBoxDictation(s);
      this.setState({
        screen: "actions",
        session: { ...s, mic: "idle" },
        actions: { hostKey: s.hostKey, sessionId: s.sessionId, cursor: 0 },
      });
      return;
    }
    if (e.type === "scrollUp" || e.type === "scrollDown") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      const selected = clamp(s.selected + dir, 0, options.length);
      this.setState({ session: { ...s, selected } });
      return;
    }
    if (e.type === "tap") {
      if (s.selected < options.length) {
        const digit = String(s.selected + 1);
        this.markPending(s.sessionId, live);
        void this.client
          .sendInput(s.hostKey, s.sessionId, digit)
          .then(() => {
            this.flash(FLASH_QUEUED);
            this.repaint();
          })
          .catch(() => {
            this.flash(FLASH_HUB_UNREACHABLE);
            this.repaint();
          });
        this.setState({ session: { ...s, focus: "transcript" } });
        return;
      }
      // Trailing "Dictate answer…" row.
      this.toggleBoxDictation(s);
    }
  }

  // Cancels a live box recording if one is active (recording/finalising) —
  // shared by every path that leaves the bottom input focus, so a hot mic
  // never outlives the screen it was started on. No-op for idle/error.
  private cancelBoxDictation(s: SessionScreenState): void {
    if (s.mic === "recording" || s.mic === "finalising") this.dictation.cancel();
  }

  // idle -> recording (dictation.start) -> finalising (dictation.stop);
  // ignored while finalising/error so a stray extra tap can't double-fire
  // start/stop against an in-flight result. The originating session's
  // hostKey+sessionId are captured into the result callback so a late
  // transcript delivered after the user navigated to a *different* session
  // can be dropped rather than misattributed (see onBoxDictationResult).
  private toggleBoxDictation(s: SessionScreenState): void {
    if (s.mic === "idle") {
      const { hostKey, sessionId } = s;
      this.setState({ session: { ...s, mic: "recording" } });
      this.dictation.start((r) => this.onBoxDictationResult(r, hostKey, sessionId));
      return;
    }
    if (s.mic === "recording") {
      this.setState({ session: { ...s, mic: "finalising" } });
      this.dictation.stop();
    }
  }

  // Delivered result -> appended to the draft (space-joined with whatever
  // was already there), mic back to idle, and the box's scroll snapped to
  // the tail so the just-added text is what's visible. Unavailable -> flash
  // the reason and settle back to idle rather than stranding the box in a
  // permanent error state the input-mode tap dispatch would otherwise never
  // let the user out of (tap is a no-op while mic==="error").
  //
  // Guarded on the originating session: if the current session isn't the one
  // the dictation started on (user navigated away mid-capture), the result
  // is dropped — never appended to, and thus never Sent to, the wrong agent.
  private onBoxDictationResult(result: DictationResult, hostKey: string, sessionId: string): void {
    const s = this.state.session;
    if (!s || s.hostKey !== hostKey || s.sessionId !== sessionId) return;
    if (result.unavailable) {
      this.setState({ session: { ...s, mic: "error" } });
      this.flash(result.reason ?? "dictation unavailable");
      this.setState({ session: { ...s, mic: "idle" } });
      return;
    }
    const draft = s.draft ? `${s.draft} ${result.text}` : result.text;
    this.setState({ session: { ...s, draft, mic: "idle", viewOffset: 0 } });
  }

  // Moves the box's view one line at a time (mirrors the transcript's
  // step-scroll); running off either end hands focus back to the
  // transcript rather than clamping in place — an empty draft has nothing
  // to scroll through, so any scroll there exits immediately. Any exit to
  // the transcript also cancels a live box recording (same hot-mic guard as
  // the doubleTap path above).
  private scrollInputBox(type: "scrollUp" | "scrollDown", s: SessionScreenState): void {
    if (s.draft === "") return this.handBackToTranscript(s);
    if (type === "scrollDown") {
      if (s.viewOffset <= 0) return this.handBackToTranscript(s);
      this.setState({ session: { ...s, viewOffset: s.viewOffset - 1 } });
      return;
    }
    const maxOffset = draftMaxViewOffset(s.draft);
    if (s.viewOffset >= maxOffset) return this.handBackToTranscript(s);
    this.setState({ session: { ...s, viewOffset: s.viewOffset + 1 } });
  }

  // Hands focus back to the transcript, cancelling any live box recording
  // and resetting the mic first so the mic never outlives the input focus.
  private handBackToTranscript(s: SessionScreenState): void {
    this.cancelBoxDictation(s);
    this.setState({ session: { ...s, focus: "transcript", mic: "idle" } });
  }

  private clearHistoryTimer(sessionId: string): void {
    const timer = this.historyTimers[sessionId];
    if (timer === undefined) return;
    clearTimeout(timer);
    delete this.historyTimers[sessionId];
  }

  private clearHistoryTimers(): void {
    for (const timer of Object.values(this.historyTimers)) clearTimeout(timer);
    this.historyTimers = {};
  }

  private triggerHistoryLoad(hostKey: string, sessionId: string): void {
    if (this.state.loadingHistory[sessionId]) return;
    // The "· loading earlier ·" line (render.ts's sessionContentLines) is
    // about to become the new topmost content line. The caller only ever
    // reaches here already scrolled to the (pre-insert) top, so bump the
    // offset by the one line being inserted to keep that top line in view —
    // otherwise it renders one line above the visible window (clipped).
    const bumpedSession =
      this.state.session && this.state.session.sessionId === sessionId
        ? { ...this.state.session, offset: this.state.session.offset + 1 }
        : this.state.session;
    this.setState({ loadingHistory: { ...this.state.loadingHistory, [sessionId]: true }, session: bumpedSession });
    void this.pollHistory(hostKey, sessionId, this.now());
  }

  // `startedAt` bounds the 202-retry loop to PENDING_TIMEOUT_MS total (an
  // offline/wedged host would otherwise retry forever) — reusing the same
  // budget the pending-overlay reconciliation uses elsewhere in this file.
  private async pollHistory(hostKey: string, sessionId: string, startedAt: number): Promise<void> {
    try {
      const res = await this.client.getHistory(hostKey, sessionId);
      if (res.status === 202) {
        delete this.historyTimers[sessionId];
        if (this.now() - startedAt >= PENDING_TIMEOUT_MS) {
          this.state = {
            ...this.state,
            now: this.now(),
            loadingHistory: { ...this.state.loadingHistory, [sessionId]: false },
          };
          this.repaint();
          return;
        }
        this.historyTimers[sessionId] = setTimeout(() => {
          delete this.historyTimers[sessionId];
          void this.pollHistory(hostKey, sessionId, startedAt);
        }, HISTORY_RETRY_MS);
        return;
      }
      const existing = this.state.transcripts[sessionId] ?? emptyBuffer();
      const merged = prependHistory(existing, res.body.entries, res.body.truncated);
      this.state = {
        ...this.state,
        now: this.now(),
        transcripts: { ...this.state.transcripts, [sessionId]: merged },
        loadingHistory: { ...this.state.loadingHistory, [sessionId]: false },
      };
      this.repaint();
    } catch {
      this.state = {
        ...this.state,
        now: this.now(),
        loadingHistory: { ...this.state.loadingHistory, [sessionId]: false },
      };
      this.repaint();
    }
  }

  // ---- actions --------------------------------------------------------

  private onActions(e: InputEvent): void {
    const a = this.state.actions;
    if (!a) return this.goHome();
    if (e.type === "doubleTap") {
      this.setState({ screen: "session", session: this.returnToSession(a.hostKey, a.sessionId) });
      return;
    }
    const rows = buildActionsRows(this.state, a.hostKey, a.sessionId);
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      const cursor = clamp(a.cursor + dir, 0, rows.length - 1);
      this.setState({ actions: { ...a, cursor } });
      return;
    }
    if (e.type === "tap") {
      const row = rows[a.cursor];
      if (!row) return;
      this.runAction(a.hostKey, a.sessionId, row.action);
    }
  }

  private runAction(hostKey: string, sessionId: string, action: string): void {
    switch (action) {
      case "send": {
        const sess = this.state.session;
        const draft = sess && sess.hostKey === hostKey && sess.sessionId === sessionId ? sess.draft : "";
        const s = findSession(this.state, hostKey, sessionId);
        this.markPending(sessionId, s);
        void this.client
          .sendInput(hostKey, sessionId, draft)
          .then(() => {
            this.flash(FLASH_QUEUED);
            this.repaint();
          })
          .catch(() => {
            this.flash(FLASH_HUB_UNREACHABLE);
            this.repaint();
          });
        this.setState({ screen: "session", session: newSessionState(hostKey, sessionId) });
        return;
      }
      case "clear":
        this.setState({ screen: "session", session: newSessionState(hostKey, sessionId) });
        return;
      case "restart":
        this.queueAction(hostKey, sessionId, "restart");
        return;
      case "start":
        this.queueAction(hostKey, sessionId, "start");
        return;
      case "kill":
        this.setState({ screen: "confirm", confirm: { action: { kind: "kill", hostKey, sessionId }, cursor: 0 } });
        return;
      case "delete":
        this.setState({ screen: "confirm", confirm: { action: { kind: "delete", hostKey, sessionId }, cursor: 0 } });
        return;
      case "back":
        // Non-destructive exit: unlike Send/Clear (which must zero the
        // draft), Back must not discard a dictated draft the user hasn't
        // acted on yet — input mode has no tap-to-send, so the actions menu
        // is the only route to Send, and bouncing through it must be a safe
        // no-op. Preserve the existing session state (draft/focus/mic/
        // viewOffset/selected) rather than minting a fresh one.
        this.setState({ screen: "session", session: this.returnToSession(hostKey, sessionId) });
        return;
    }
  }

  // Returns to the session screen after a non-destructive actions-menu exit
  // (doubleTap out, or the "Back" row) preserving whatever session state was
  // already there — draft, focus, mic, viewOffset, selected — rather than
  // resetting via newSessionState (which Send/Clear still use deliberately,
  // since those *should* zero the draft). Falls back to a fresh state only
  // if state.session doesn't already match this hostKey/sessionId, which
  // shouldn't happen in practice (actions is only ever entered from this
  // exact session) but keeps this defensive rather than silently wrong.
  private returnToSession(hostKey: string, sessionId: string): SessionScreenState {
    const s = this.state.session;
    if (s && s.hostKey === hostKey && s.sessionId === sessionId) return s;
    return newSessionState(hostKey, sessionId);
  }

  private queueAction(hostKey: string, sessionId: string, action: "kill" | "start" | "restart" | "resume"): void {
    const s = findSession(this.state, hostKey, sessionId);
    this.markPending(sessionId, s);
    void this.client
      .sessionAction(hostKey, sessionId, action)
      .then(() => {
        this.flash(FLASH_QUEUED);
        this.repaint();
      })
      .catch(() => {
        this.flash(FLASH_HUB_UNREACHABLE);
        this.repaint();
      });
    this.setState({ screen: "session", session: newSessionState(hostKey, sessionId) });
  }

  // ---- reply (dictation) ----------------------------------------------

  private startDictation(): void {
    this.dictation.start((result) => this.onDictationResult(result));
  }

  private onDictationResult(result: DictationResult): void {
    const r = this.state.reply;
    if (!r) return;
    if (result.unavailable) {
      this.setState({ reply: { ...r, phase: "unavailable", reason: result.reason, cursor: 0 } });
      return;
    }
    this.setState({ reply: { ...r, phase: "preview", text: result.text, cursor: 0 } });
  }

  private onReply(e: InputEvent): void {
    const r = this.state.reply;
    if (!r) return this.goHome();
    if (r.phase === "listening") {
      if (e.type === "tap") {
        this.dictation.stop();
        return;
      }
      if (e.type === "doubleTap") {
        this.dictation.cancel();
        this.leaveReply(r);
      }
      return;
    }
    // preview / unavailable: buttons Send/Redo/Cancel or Redo/Cancel.
    const buttons = r.phase === "unavailable" ? (["redo", "cancel"] as const) : (["send", "redo", "cancel"] as const);
    if (e.type === "doubleTap") {
      this.leaveReply(r);
      return;
    }
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      this.setState({ reply: { ...r, cursor: clamp(r.cursor + dir, 0, buttons.length - 1) } });
      return;
    }
    if (e.type === "tap") {
      const button = buttons[r.cursor];
      if (button === "send") {
        this.sendReply(r);
      } else if (button === "redo") {
        this.setState({ reply: { ...r, phase: "listening", text: "", cursor: 0 } });
        this.startDictation();
      } else {
        this.leaveReply(r);
      }
    }
  }

  private leaveReply(r: ReplyScreenState): void {
    if (r.target.kind === "session") {
      this.setState({
        screen: r.target.back,
        session: newSessionState(r.target.hostKey, r.target.sessionId),
      });
    } else {
      this.setState({
        screen: "newPrompt",
        newPrompt: { hostKey: r.target.hostKey, repo: r.target.repo, cursor: 0 },
      });
    }
  }

  private sendReply(r: ReplyScreenState): void {
    if (r.target.kind === "session") {
      const { hostKey, sessionId } = r.target;
      const s = findSession(this.state, hostKey, sessionId);
      this.markPending(sessionId, s);
      void this.client
        .sendInput(hostKey, sessionId, r.text)
        .then(() => {
          this.flash(FLASH_QUEUED);
          this.repaint();
        })
        .catch(() => {
          this.flash(FLASH_HUB_UNREACHABLE);
          this.repaint();
        });
      this.setState({ screen: "session", session: newSessionState(hostKey, sessionId) });
      return;
    }
    const { hostKey, repo, label, baseRef, model, permissionMode } = r.target;
    this.markSpawnPending(hostKey, repo);
    void this.client
      .spawnSession(hostKey, { repo, prompt: r.text, label, baseRef, model, permissionMode })
      .then(() => {
        this.flash(FLASH_QUEUED);
        this.repaint();
      })
      .catch(() => {
        this.flash(FLASH_HUB_UNREACHABLE);
        this.repaint();
      });
    this.goHome();
  }

  // ---- confirm ----------------------------------------------------------

  private onConfirm(e: InputEvent): void {
    const c = this.state.confirm;
    if (!c) return this.goHome();
    if (e.type === "doubleTap") {
      this.setState({
        screen: "actions",
        actions: { hostKey: c.action.hostKey, sessionId: c.action.sessionId, cursor: 0 },
      });
      return;
    }
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      this.setState({ confirm: { ...c, cursor: c.cursor === 0 ? 1 : 0 } });
      return;
    }
    if (e.type === "tap") {
      if (c.cursor === 0) {
        // Cancel
        this.setState({
          screen: "actions",
          actions: { hostKey: c.action.hostKey, sessionId: c.action.sessionId, cursor: 0 },
        });
        return;
      }
      const { hostKey, sessionId } = c.action;
      if (c.action.kind === "kill") {
        this.queueAction(hostKey, sessionId, "kill");
      } else {
        this.markPending(sessionId, findSession(this.state, hostKey, sessionId));
        void this.client
          .deleteSession(hostKey, sessionId)
          .then(() => {
            this.flash(FLASH_QUEUED);
            this.repaint();
          })
          .catch(() => {
            this.flash(FLASH_HUB_UNREACHABLE);
            this.repaint();
          });
        this.goHome();
      }
    }
  }

  // ---- newHost / newRepo / newPrompt ------------------------------------

  private onlineHosts(): AgentInfo[] {
    return this.state.agents.filter((a) => a.online);
  }

  private onNewHost(e: InputEvent): void {
    const n = this.state.newHost;
    if (!n) return this.goHome();
    if (e.type === "doubleTap") return this.goHome();
    const hosts = this.onlineHosts();
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      this.setState({ newHost: { cursor: clamp(n.cursor + dir, 0, Math.max(0, hosts.length - 1)) } });
      return;
    }
    if (e.type === "tap") {
      const host = hosts[n.cursor];
      if (!host) return;
      this.setState({ screen: "newRepo", newRepo: { hostKey: host.key, cursor: 0 } });
    }
  }

  private onNewRepo(e: InputEvent): void {
    const n = this.state.newRepo;
    if (!n) return this.goHome();
    if (e.type === "doubleTap") {
      this.setState({ screen: "newHost", newHost: { cursor: 0 } });
      return;
    }
    const rows = buildNewRepoRows(this.state, n.hostKey);
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      this.setState({ newRepo: { ...n, cursor: clamp(n.cursor + dir, 0, Math.max(0, rows.length - 1)) } });
      return;
    }
    if (e.type === "tap") {
      const row = rows[n.cursor];
      if (!row) return;
      if (row.kind === "repo") {
        this.setState({
          screen: "newPrompt",
          newPrompt: { hostKey: n.hostKey, repo: row.repo, cursor: 0 },
        });
      } else if (row.kind === "resume") {
        this.markPending(row.closedSessionId, undefined);
        void this.client
          .sessionAction(n.hostKey, row.closedSessionId, "resume")
          .then(() => {
            this.flash(FLASH_QUEUED);
            this.repaint();
          })
          .catch(() => {
            this.flash(FLASH_HUB_UNREACHABLE);
            this.repaint();
          });
        this.goHome();
      }
    }
  }

  private onNewPrompt(e: InputEvent): void {
    const n = this.state.newPrompt;
    if (!n) return this.goHome();
    if (e.type === "doubleTap") {
      this.setState({ screen: "newRepo", newRepo: { hostKey: n.hostKey, cursor: 0 } });
      return;
    }
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      this.setState({ newPrompt: { ...n, cursor: clamp(n.cursor + dir, 0, 1) } });
      return;
    }
    if (e.type === "tap") {
      if (n.cursor === 0) {
        this.setState({
          screen: "reply",
          reply: {
            target: { kind: "spawn", hostKey: n.hostKey, repo: n.repo },
            phase: "listening",
            text: "",
            cursor: 0,
          },
        });
        this.startDictation();
      } else {
        this.markSpawnPending(n.hostKey, n.repo);
        void this.client
          .spawnSession(n.hostKey, { repo: n.repo })
          .then(() => {
            this.flash(FLASH_QUEUED);
            this.repaint();
          })
          .catch(() => {
            this.flash(FLASH_HUB_UNREACHABLE);
            this.repaint();
          });
        this.goHome();
      }
    }
  }

  // ---- settings -----------------------------------------------------------

  private onSettings(e: InputEvent): void {
    if (e.type === "doubleTap" || e.type === "tap") {
      this.goHome();
    }
  }
}

// ---- shared pure helpers (also used by render.ts's row builders) ---------

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function nextSelectableIndex(rows: { selectable: boolean }[], from: number, dir: 1 | -1): number {
  let i = from;
  for (let steps = 0; steps < rows.length; steps++) {
    const next = i + dir;
    if (next < 0 || next >= rows.length) break;
    i = next;
    if (rows[i]?.selectable) return i;
  }
  return from;
}

// Keeps the home cursor in range as the row list shrinks/grows (host
// offline, sessions converging away) and off non-selectable rows (host
// headers, offline lines) — including the very first render, where the
// cursor starts at 0 and row 0 is always a non-selectable host header once
// any host is known. Searches outward (nearest first, forward on ties) for
// the closest selectable row; "+ New session"/"Settings" are always present
// and selectable, so a selectable row always exists once rows is non-empty.
function clampHomeCursor(rows: { selectable: boolean }[], cursor: number): number {
  if (rows.length === 0) return 0;
  const c = clamp(cursor, 0, rows.length - 1);
  if (rows[c]?.selectable) return c;
  for (let d = 1; d < rows.length; d++) {
    const forward = c + d;
    if (forward < rows.length && rows[forward]?.selectable) return forward;
    const backward = c - d;
    if (backward >= 0 && rows[backward]?.selectable) return backward;
  }
  return c;
}
