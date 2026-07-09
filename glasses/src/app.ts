import type { HubClient } from "./hub-client.ts";
import type { GlassesDisplay } from "./display/index.ts";
import type { Dictation, DictationResult } from "./dictation.ts";
import { emptyBuffer, mergeTail, prependHistory, type TranscriptBuffer } from "./transcript.ts";
import { flattenSessions } from "./sessions.ts";
import {
  buildActionsRows,
  buildHomeRows,
  buildNewRepoRows,
  render,
  SESSION_CONTENT_AREA,
  sessionContentLines,
  type HomeRow,
} from "./render.ts";
import type { AgentInfo, InputEvent, SessionInfo, SessionRef, SessionStatus } from "./types.ts";

export type Screen =
  | "home"
  | "session"
  | "actions"
  | "question"
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
}

export interface ActionsScreenState {
  hostKey: string;
  sessionId: string;
  cursor: number;
}

export interface QuestionScreenState {
  hostKey: string;
  sessionId: string;
  cursor: number;
}

export type ReplyTarget =
  | { kind: "session"; hostKey: string; sessionId: string; back: "session" | "question" }
  | {
      kind: "spawn";
      hostKey: string;
      repo: string;
      label?: string;
      baseRef?: string;
      branchName?: string;
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
  pending: Record<string, PendingEntry>;
  loadingHistory: Record<string, boolean>;

  home: HomeScreenState;
  session: SessionScreenState | null;
  actions: ActionsScreenState | null;
  question: QuestionScreenState | null;
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
    pending: {},
    loadingHistory: {},
    home: { cursor: 0 },
    session: null,
    actions: null,
    question: null,
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
  now?: () => number;
  pollMs?: number;
}

// The controller: owns AppState, drives the HubClient on a poll loop, reacts
// to InputEvents from the display, and re-renders after every mutation.
export class App {
  private readonly client: HubClient;
  private readonly display: GlassesDisplay;
  private readonly dictation: Dictation;
  private readonly now: () => number;
  private readonly pollMs: number;

  private state: AppState;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private historyTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  private paused = false;

  constructor(opts: AppOptions) {
    this.client = opts.client;
    this.display = opts.display;
    this.dictation = opts.dictation;
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

  pause(): void {
    this.paused = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    if (this.paused) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch, now: this.now() };
    this.repaint();
  }

  private repaint(): void {
    this.display.render(render(this.state));
  }

  private flash(text: string): void {
    const now = this.now();
    this.state = { ...this.state, now, flash: text, flashUntil: now + FLASH_DURATION_MS };
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
      case "question":
        return this.onQuestion(e);
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
    if (e.type === "doubleTap") {
      this.display.requestExit();
      return;
    }
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      const cursor = nextSelectableIndex(rows, this.state.home.cursor, dir);
      this.setState({ home: { cursor } });
      return;
    }
    if (e.type === "tap") {
      const row = rows[this.state.home.cursor];
      if (!row || !row.selectable) return;
      if (row.kind === "session" && row.hostKey && row.sessionId) {
        this.setState({
          screen: "session",
          session: { hostKey: row.hostKey, sessionId: row.sessionId, offset: 0 },
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

  private onSession(e: InputEvent): void {
    const s = this.state.session;
    if (!s) return this.goHome();
    if (e.type === "doubleTap") return this.goHome();
    if (e.type === "tap") {
      this.setState({ screen: "actions", actions: { hostKey: s.hostKey, sessionId: s.sessionId, cursor: 0 } });
      return;
    }
    const contentArea = SESSION_CONTENT_AREA;
    const total = this.sessionContentLength(s.hostKey, s.sessionId);
    const maxOffset = Math.max(0, total - contentArea);
    if (e.type === "scrollDown") {
      this.setState({ session: { ...s, offset: Math.max(0, s.offset - contentArea) } });
      return;
    }
    if (e.type === "scrollUp") {
      if (s.offset >= maxOffset) {
        const buffer = this.state.transcripts[s.sessionId];
        if (buffer?.hasMore !== false) {
          this.triggerHistoryLoad(s.hostKey, s.sessionId);
          return;
        }
        return; // truly at the top, nothing more to load
      }
      this.setState({ session: { ...s, offset: Math.min(maxOffset, s.offset + contentArea) } });
    }
  }

  private triggerHistoryLoad(hostKey: string, sessionId: string): void {
    if (this.state.loadingHistory[sessionId]) return;
    this.setState({ loadingHistory: { ...this.state.loadingHistory, [sessionId]: true } });
    void this.pollHistory(hostKey, sessionId);
  }

  private async pollHistory(hostKey: string, sessionId: string): Promise<void> {
    try {
      const res = await this.client.getHistory(hostKey, sessionId);
      if (res.status === 202) {
        this.historyTimers[sessionId] = setTimeout(() => {
          void this.pollHistory(hostKey, sessionId);
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
      this.setState({ screen: "session", session: { hostKey: a.hostKey, sessionId: a.sessionId, offset: 0 } });
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
      case "reply":
        this.setState({
          screen: "reply",
          reply: { target: { kind: "session", hostKey, sessionId, back: "session" }, phase: "listening", text: "", cursor: 0 },
        });
        this.startDictation();
        return;
      case "answer": {
        this.setState({ screen: "question", question: { hostKey, sessionId, cursor: 0 } });
        return;
      }
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
        this.setState({ screen: "session", session: { hostKey, sessionId, offset: 0 } });
        return;
    }
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
    this.setState({ screen: "session", session: { hostKey, sessionId, offset: 0 } });
  }

  // ---- question -------------------------------------------------------

  private onQuestion(e: InputEvent): void {
    const q = this.state.question;
    if (!q) return this.goHome();
    if (e.type === "doubleTap") {
      this.setState({ screen: "session", session: { hostKey: q.hostKey, sessionId: q.sessionId, offset: 0 } });
      return;
    }
    const s = findSession(this.state, q.hostKey, q.sessionId);
    const options = s?.session?.questionOptions ?? [];
    const rowCount = options.length + 2; // options + dictate + back
    if (e.type === "scrollDown" || e.type === "scrollUp") {
      const dir = e.type === "scrollDown" ? 1 : -1;
      this.setState({ question: { ...q, cursor: clamp(q.cursor + dir, 0, rowCount - 1) } });
      return;
    }
    if (e.type === "tap") {
      if (q.cursor < options.length) {
        const digit = String(q.cursor + 1);
        this.markPending(q.sessionId, s);
        void this.client
          .sendInput(q.hostKey, q.sessionId, digit)
          .then(() => {
            this.flash(FLASH_QUEUED);
            this.repaint();
          })
          .catch(() => {
            this.flash(FLASH_HUB_UNREACHABLE);
            this.repaint();
          });
        this.setState({ screen: "session", session: { hostKey: q.hostKey, sessionId: q.sessionId, offset: 0 } });
        return;
      }
      if (q.cursor === options.length) {
        // Dictate answer…
        this.setState({
          screen: "reply",
          reply: {
            target: { kind: "session", hostKey: q.hostKey, sessionId: q.sessionId, back: "question" },
            phase: "listening",
            text: "",
            cursor: 0,
          },
        });
        this.startDictation();
        return;
      }
      // Back
      this.setState({ screen: "session", session: { hostKey: q.hostKey, sessionId: q.sessionId, offset: 0 } });
    }
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
        session: { hostKey: r.target.hostKey, sessionId: r.target.sessionId, offset: 0 },
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
      this.setState({ screen: "session", session: { hostKey, sessionId, offset: 0 } });
      return;
    }
    const { hostKey, repo, label, baseRef, branchName, model, permissionMode } = r.target;
    this.markSpawnPending(hostKey, repo);
    void this.client
      .spawnSession(hostKey, { repo, prompt: r.text, label, baseRef, branchName, model, permissionMode })
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
