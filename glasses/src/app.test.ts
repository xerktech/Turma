import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, FLASH_HUB_UNREACHABLE, FLASH_QUEUED, newSessionState } from "./app.ts";
import type { HubClient } from "./hub-client.ts";
import type { GlassesDisplay } from "./display/index.ts";
import type { Dictation, DictationResult } from "./dictation.ts";
import type { ScreenModel } from "./render.ts";
import type { AgentInfo, InputEvent, LiveSignals, SessionInfo } from "./types.ts";

function signals(overrides: Partial<LiveSignals> = {}): LiveSignals {
  return {
    bridgeAttached: true,
    transcriptAgeSec: null,
    lastRole: null,
    lastHasToolUse: false,
    question: null,
    questionOptions: [],
    tail: [],
    newPrUrls: [],
    ...overrides,
  };
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    repo: "myrepo",
    status: "running",
    session: signals({ transcriptAgeSec: 1 }),
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    key: "host-a",
    device: "host-a",
    online: true,
    repos: [{ name: "myrepo", path: "/repos/myrepo" }],
    sessions: [],
    closedSessions: [],
    ...overrides,
  };
}

class FakeDisplay implements GlassesDisplay {
  model: ScreenModel | null = null;
  started = false;
  exitRequested = false;
  private cb: ((e: InputEvent) => void) | null = null;

  // Flattened convenience view of whatever render() last produced. Most
  // assertions below just want "the text on screen" regardless of screen
  // type: for {type:"lines"} that's `lines`; for {type:"session"} it's the
  // transcript followed by the bottom box's lines (no header either way).
  get lines(): string[] {
    if (!this.model) return [];
    return this.model.type === "lines"
      ? this.model.lines
      : [...this.model.transcriptLines, ...this.model.bottom.lines];
  }

  async start(): Promise<void> {
    this.started = true;
  }
  render(model: ScreenModel): void {
    this.model = model;
  }
  onInput(cb: (e: InputEvent) => void): void {
    this.cb = cb;
  }
  requestExit(): void {
    this.exitRequested = true;
  }
  emit(e: InputEvent): void {
    this.cb?.(e);
  }
}

class FakeDictation implements Dictation {
  started = 0;
  stopped = 0;
  cancelled = 0;
  private cb: ((r: DictationResult) => void) | null = null;

  start(onResult: (r: DictationResult) => void): void {
    this.started++;
    this.cb = onResult;
  }
  stop(): void {
    this.stopped++;
  }
  cancel(): void {
    this.cancelled++;
  }
  resolve(r: DictationResult): void {
    this.cb?.(r);
  }
}

class FakeLiveTail {
  started: { hostKey: string; sessionId: string }[] = [];
  stops = 0;
  private cb: ((entries: import("./types.ts").TailEntry[]) => void) | null = null;
  private current: string | null = null;

  start(hostKey: string, sessionId: string, onTail: (entries: import("./types.ts").TailEntry[]) => void): void {
    this.started.push({ hostKey, sessionId });
    this.cb = onTail;
    this.current = sessionId;
  }
  stop(): void {
    this.stops++;
    this.cb = null;
    this.current = null;
  }
  isWatching(sessionId: string): boolean {
    return this.current === sessionId;
  }
  deliver(entries: import("./types.ts").TailEntry[]): void {
    this.cb?.(entries);
  }
}

function fakeClient(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    listAgents: vi.fn(async () => ({ now: Date.now(), agents: [] })),
    spawnSession: vi.fn(async () => ({ ok: true, cmdId: "spawn-1" })),
    sessionAction: vi.fn(async () => ({ ok: true, cmdId: "action-1" })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    sendInput: vi.fn(async () => ({ ok: true, cmdId: "input-1" })),
    getHistory: vi.fn(async () => ({
      status: 200 as const,
      body: { entries: [], truncated: false, fetchedAt: Date.now() },
    })),
    wsToken: vi.fn(async () => ({ token: "t", expiresInSec: 300 })),
    ...overrides,
  };
}

const START = 1_700_000_000_000;

describe("App", () => {
  let display: FakeDisplay;
  let dictation: FakeDictation;
  let liveTail: FakeLiveTail;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    display = new FakeDisplay();
    dictation = new FakeDictation();
    liveTail = new FakeLiveTail();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeApp(client: ReturnType<typeof fakeClient>, pollMs = 6000) {
    return new App({
      client: client as unknown as HubClient,
      display,
      dictation,
      liveTail,
      now: () => Date.now(),
      pollMs,
    });
  }

  it("poll merges the listAgents response into state and re-renders", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({
        now: Date.now(),
        agents: [agent({ sessions: [session()] })],
      })),
    });
    const app = makeApp(client);

    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.listAgents).toHaveBeenCalledTimes(1);
    expect(app.getState().agents).toHaveLength(1);
    expect(app.getState().sessionRefs).toHaveLength(1);
    expect(display.lines[0]).toBe("AGENTHUB 1 run · 0 ask");
  });

  it("navigates home -> session -> actions -> back to session on double-tap", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // home.cursor auto-snaps off the non-selectable host header row onto the
    // first selectable row (the session) as soon as the poll resolves — see
    // "fresh state -> home cursor snaps..." below for the dedicated test.
    expect(app.getState().home.cursor).toBe(1);
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual(newSessionState("host-a", "s1"));

    // Fresh session screen: transcript focus, offset 0 ("at the tail") — tap
    // hands focus to the bottom box. Once focused there (input mode, no
    // pending question), tap toggles dictation and doubleTap opens the
    // context actions menu (Task 5).
    display.emit({ type: "tap" }); // -> focus:"bottom"
    expect(app.getState().session?.focus).toBe("bottom");
    display.emit({ type: "doubleTap" }); // input-mode doubleTap -> actions
    expect(app.getState().screen).toBe("actions");

    display.emit({ type: "doubleTap" });
    expect(app.getState().screen).toBe("session");
  });

  it("double-tap on home requests exit", async () => {
    const app = makeApp(fakeClient());
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "doubleTap" });
    expect(display.exitRequested).toBe(true);
  });

  it("navigates newHost -> newRepo -> newPrompt and spawns on Skip", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // Home rows: [hostHeader(0), newSession(1), settings(2)] — no sessions on
    // this agent, so home.cursor auto-snaps straight past the header to newSession(1).
    expect(app.getState().home.cursor).toBe(1);
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("newHost");

    display.emit({ type: "tap" }); // pick host-a (only online host, cursor 0)
    expect(app.getState().screen).toBe("newRepo");
    expect(app.getState().newRepo?.hostKey).toBe("host-a");

    display.emit({ type: "tap" }); // pick myrepo (only repo, cursor 0)
    expect(app.getState().screen).toBe("newPrompt");
    expect(app.getState().newPrompt?.repo).toBe("myrepo");

    display.emit({ type: "scrollDown" }); // -> "Skip (spawn now)"
    display.emit({ type: "tap" });

    expect(client.spawnSession).toHaveBeenCalledWith("host-a", { repo: "myrepo" });
    expect(app.getState().screen).toBe("home");
    expect(app.getState().pending["spawn:host-a:myrepo"]).toBeDefined();
  });

  // ---- session bottom: AskUserQuestion sheet mode (Task 6) --------------
  // Replaces the old separate "question" screen: a pending question renders
  // inline in the session bottom bar (render.ts's sheet mode) whenever
  // focus==="bottom", dispatched by onSessionBottom's sheet branch.

  function questionAgent(): AgentInfo {
    return agent({
      sessions: [
        session({ session: signals({ transcriptAgeSec: 1, question: "pick", questionOptions: ["A", "B"] }) }),
      ],
    });
  }

  // Same shape as questionAgent, but with a caller-chosen question/options —
  // used to simulate one pending question on a session being *replaced* by a
  // different one mid-sheet (as opposed to a question newly arriving where
  // none was pending before, which questionAgent()/toSheet() already cover).
  function questionAgentWith(question: string, options: string[]): AgentInfo {
    return agent({
      sessions: [session({ session: signals({ transcriptAgeSec: 1, question, questionOptions: options }) })],
    });
  }

  async function toSheet(app: App): Promise<void> {
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "tap" }); // home -> session
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom" (sheet mode: question pending)
  }

  function bottomMode(): string {
    const model = display.model;
    if (!model || model.type !== "session") throw new Error("expected a session ScreenModel");
    return model.bottom.mode;
  }

  it("sheet mode: entering the session with a pending question renders bottom.mode as 'sheet'", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);
    expect(bottomMode()).toBe("sheet");
    expect(app.getState().session?.selected).toBe(0);
  });

  it("sheet mode: scroll moves `selected` through the options plus the trailing Dictate-answer row, clamped", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "scrollDown" }); // A -> B
    expect(app.getState().session?.selected).toBe(1);
    display.emit({ type: "scrollDown" }); // B -> "Dictate answer…" (index === options.length)
    expect(app.getState().session?.selected).toBe(2);
    display.emit({ type: "scrollDown" }); // clamped at the end
    expect(app.getState().session?.selected).toBe(2);

    display.emit({ type: "scrollUp" });
    display.emit({ type: "scrollUp" });
    display.emit({ type: "scrollUp" }); // clamped at 0
    expect(app.getState().session?.selected).toBe(0);
  });

  it("sheet mode: tap on option index 1 sends the 1-based digit, flashes, marks pending, and hands focus back to the transcript", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "scrollDown" }); // selected -> 1 ("B")
    display.emit({ type: "tap" });

    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "2");
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.focus).toBe("transcript");
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(0); // flush the sendInput promise
    expect(app.getState().flash).toBe(FLASH_QUEUED);
    expect(display.lines.some((l) => l.includes("queued"))).toBe(true);
  });

  it("sheet mode: tap on option index 0 sends digit '1'", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "tap" }); // selected 0 = "A"
    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "1");
  });

  it("sheet mode: doubleTap opens the actions menu (session actions stay reachable while a question is pending)", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "doubleTap" });
    expect(app.getState().screen).toBe("actions");
  });

  it("sheet mode: tap on the trailing 'Dictate answer…' row starts box dictation and hands the box to input mode; the dictated draft then sends via the ordinary actions-menu Send path", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "scrollDown" });
    display.emit({ type: "scrollDown" }); // selected -> options.length ("Dictate answer…")
    display.emit({ type: "tap" });

    expect(dictation.started).toBe(1);
    expect(app.getState().session?.mic).toBe("recording");
    expect(app.getState().screen).toBe("session"); // stays put — no separate reply screen
    expect(app.getState().session?.focus).toBe("bottom");
    // Bottom now renders as input (dictation active) even though the live
    // session still reports the question as pending.
    expect(bottomMode()).toBe("input");

    dictation.resolve({ text: "yes deploy" });
    expect(app.getState().session?.draft).toBe("yes deploy");
    expect(app.getState().session?.mic).toBe("idle");
    // Still input mode: a non-empty draft keeps the box out of the sheet
    // until it's sent or cleared.
    expect(bottomMode()).toBe("input");

    display.emit({ type: "doubleTap" }); // -> actions, cursor 0 = Send (draft present)
    display.emit({ type: "tap" }); // select Send

    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "yes deploy");
    expect(app.getState().screen).toBe("session");
  });

  it("a question arriving via poll while the box mic is recording (plain input mode) cancels the mic and drops focus to the transcript", async () => {
    const noQuestion = agent({ sessions: [session({ session: signals({ transcriptAgeSec: 1 }) })] });
    const withQuestion = questionAgent();
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [noQuestion] })
        .mockResolvedValue({ now: Date.now(), agents: [withQuestion] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0); // 1st poll: no question yet

    display.emit({ type: "tap" }); // -> session
    display.emit({ type: "tap" }); // focus:"bottom", input mode (no question)
    display.emit({ type: "tap" }); // idle -> recording
    expect(app.getState().session?.mic).toBe("recording");

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: question now pending
    expect(dictation.cancelled).toBe(1);
    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().session?.focus).toBe("transcript");
  });

  it("does not yank focus away from an already-pending question's sheet on subsequent polls", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client, 1000);
    await toSheet(app);

    display.emit({ type: "scrollDown" }); // selected -> 1, focus stays "bottom"
    expect(app.getState().session?.focus).toBe("bottom");

    await vi.advanceTimersByTimeAsync(1000); // poll again: same question still pending
    expect(app.getState().session?.focus).toBe("bottom");
    expect(app.getState().session?.selected).toBe(1); // untouched
  });

  it("a different question replacing the pending one mid-sheet resets `selected` back to 0", async () => {
    const first = questionAgentWith("pick one", ["A", "B"]);
    const second = questionAgentWith("pick two", ["X", "Y", "Z"]);
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [first] })
        .mockResolvedValue({ now: Date.now(), agents: [second] }),
    });
    const app = makeApp(client, 1000);
    await toSheet(app);

    display.emit({ type: "scrollDown" }); // A -> B
    display.emit({ type: "scrollDown" }); // B -> "Dictate answer…" (selected === options.length === 2)
    expect(app.getState().session?.selected).toBe(2);

    await vi.advanceTimersByTimeAsync(1000); // poll: a *different* question replaces this one
    // Dispatch already clamps against the new options list, so this stale
    // index couldn't have sent a wrong digit — but the highlighted row must
    // still reset rather than silently point at the wrong option.
    expect(app.getState().session?.selected).toBe(0);
    // Still sitting in the sheet (this isn't the "question newly arrived
    // while unfocused" case) — only the highlight resets, not the focus.
    expect(app.getState().session?.focus).toBe("bottom");
  });

  // ---- bottom-box input mode: dictate / send / clear (Task 5) -----------

  async function toSessionBottom(app: App): Promise<void> {
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "tap" }); // home -> session
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom"
  }

  it("input mode: tap toggles dictation start/stop; a delivered result appends to the draft", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);
    expect(app.getState().session?.focus).toBe("bottom");

    display.emit({ type: "tap" }); // idle -> recording
    expect(app.getState().session?.mic).toBe("recording");
    expect(dictation.started).toBe(1);

    display.emit({ type: "tap" }); // recording -> finalising
    expect(app.getState().session?.mic).toBe("finalising");
    expect(dictation.stopped).toBe(1);

    dictation.resolve({ text: "deploy the fix" });
    expect(app.getState().session?.draft).toBe("deploy the fix");
    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().session?.viewOffset).toBe(0);

    // A second dictation round appends, space-joined, to the existing draft.
    display.emit({ type: "tap" }); // idle -> recording again
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "and redeploy" });
    expect(app.getState().session?.draft).toBe("deploy the fix and redeploy");
  });

  it("input mode: tap is ignored while finalising or in error", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    display.emit({ type: "tap" }); // finalising: ignored
    expect(dictation.started).toBe(1); // not re-started
    expect(app.getState().session?.mic).toBe("finalising");
  });

  it("input mode: an unavailable dictation result flashes the reason and settles back to idle", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    dictation.resolve({ text: "", unavailable: true, reason: "mic permission denied" });

    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().flash).toBe("mic permission denied");
    expect(app.getState().session?.draft).toBe(""); // nothing appended
  });

  it("input mode: doubleTap opens the actions menu; Send/Clear only appear once there's a draft", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "doubleTap" }); // no draft yet -> actions, no Send/Clear
    expect(app.getState().screen).toBe("actions");
    expect(display.lines.some((l) => l.includes("Send"))).toBe(false);
    expect(display.lines.some((l) => l.includes("Clear"))).toBe(false);

    display.emit({ type: "doubleTap" }); // back to session
    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" });

    display.emit({ type: "doubleTap" }); // draft present -> actions with Send/Clear prepended
    expect(app.getState().screen).toBe("actions");
    expect(display.lines.some((l) => l.includes("Send"))).toBe(true);
    expect(display.lines.some((l) => l.includes("Clear"))).toBe(true);
  });

  it("input mode: Send calls sendInput with the draft, clears it, flashes, marks pending, and the flash is visible on the session screen", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" });

    display.emit({ type: "doubleTap" }); // -> actions, cursor 0 = Send
    display.emit({ type: "tap" }); // select Send

    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "deploy the fix");
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.draft).toBe("");
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(0); // flush the sendInput promise
    expect(app.getState().flash).toBe(FLASH_QUEUED);
    // Task 5 surfaces the flash as a transient top transcript line — the
    // session screen otherwise has no header of its own since Task 2.
    expect(display.lines.some((l) => l.includes("queued"))).toBe(true);
  });

  it("input mode: Clear empties the draft and returns to session without sending anything", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" });

    display.emit({ type: "doubleTap" }); // -> actions, cursor 0 = Send
    display.emit({ type: "scrollDown" }); // cursor 1 = Clear
    display.emit({ type: "tap" }); // select Clear

    expect(client.sendInput).not.toHaveBeenCalled();
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.draft).toBe("");
  });

  it("input mode: Back preserves the dictated draft instead of discarding it (only Send/Clear should reset it)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" });
    expect(app.getState().session?.draft).toBe("deploy the fix");

    // Draft present: rows are [Send, Clear, Restart, Kill, Delete, Back].
    display.emit({ type: "doubleTap" }); // -> actions, cursor 0 = Send
    display.emit({ type: "scrollDown" }); // 1 = Clear
    display.emit({ type: "scrollDown" }); // 2 = Restart
    display.emit({ type: "scrollDown" }); // 3 = Kill
    display.emit({ type: "scrollDown" }); // 4 = Delete
    display.emit({ type: "scrollDown" }); // 5 = Back
    display.emit({ type: "tap" }); // select Back

    expect(client.sendInput).not.toHaveBeenCalled();
    expect(app.getState().screen).toBe("session");
    // The only way to Send a dictated draft is via this same actions menu
    // (input mode has no tap-to-send) — Back must not silently discard it.
    expect(app.getState().session?.draft).toBe("deploy the fix");
    // Focus returns to right where the user left it (the bottom box).
    expect(app.getState().session?.focus).toBe("bottom");
  });

  it("input mode: double-tapping out of the actions menu (without picking a row) also preserves the draft", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" });

    display.emit({ type: "doubleTap" }); // -> actions
    display.emit({ type: "doubleTap" }); // double-tap out, no row picked

    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.draft).toBe("deploy the fix");
    expect(app.getState().session?.focus).toBe("bottom");
  });

  it("input mode: scrolling an empty box returns focus to the transcript immediately", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);
    expect(app.getState().session?.draft).toBe("");

    display.emit({ type: "scrollDown" });
    expect(app.getState().session?.focus).toBe("transcript");
  });

  it("pause() cancels an in-progress box dictation (mic recording) and resets mic to idle", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    expect(dictation.started).toBe(1);

    app.pause();

    expect(dictation.cancelled).toBe(1);
    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().screen).toBe("session"); // stays put, unlike the reply-screen cancel
  });

  it("pause() is a no-op for dictation when nothing is recording", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    app.pause();
    expect(dictation.cancelled).toBe(0);
    expect(app.getState().screen).toBe("home");
  });

  it("pause() does not re-cancel once a box dictation has already settled back to idle", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" }); // -> mic idle, draft set
    expect(app.getState().session?.mic).toBe("idle");

    app.pause();
    expect(dictation.cancelled).toBe(0); // nothing active to cancel
    expect(app.getState().session?.draft).toBe("deploy the fix"); // untouched
  });

  it("input mode: doubleTap while recording cancels the mic before opening actions (no hot mic left behind)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording (no stop-tap yet)
    expect(app.getState().session?.mic).toBe("recording");

    display.emit({ type: "doubleTap" }); // leave input focus -> actions
    expect(dictation.cancelled).toBe(1); // mic torn down, not left capturing
    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().screen).toBe("actions");
  });

  it("input mode: scroll handing focus back to the transcript while recording also cancels the mic", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording; draft still empty
    expect(app.getState().session?.mic).toBe("recording");

    display.emit({ type: "scrollUp" }); // empty draft -> exits to transcript
    expect(dictation.cancelled).toBe(1);
    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().session?.focus).toBe("transcript");
  });

  it("input mode: a result delivered after navigating to a different session is NOT appended to the new session's draft", async () => {
    const s1 = session({ id: "s1", createdAt: "2026-01-01T00:00:00Z" });
    const s2 = session({ id: "s2", createdAt: "2026-01-01T00:00:01Z" });
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s1, s2] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // Home cursor auto-snaps to the first session (s1); tap in, focus the box,
    // start recording — the callback captures s1 as the originating session.
    display.emit({ type: "tap" }); // home -> session s1
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom"
    display.emit({ type: "tap" }); // idle -> recording (captures host-a/s1)
    expect(app.getState().session?.sessionId).toBe("s1");

    // User navigates to a *different* session before the transcript lands.
    app.restoreScreen("session", newSessionState("host-a", "s2"));
    expect(app.getState().session?.sessionId).toBe("s2");

    // The late s1 result must be dropped, not appended to s2's draft.
    dictation.resolve({ text: "deploy the fix" });
    expect(app.getState().session?.draft).toBe("");
    expect(app.getState().session?.sessionId).toBe("s2");
  });

  it("scrolling above the top triggers getHistory and shows the loading line until it resolves", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1 }) });
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory: vi
        .fn()
        .mockResolvedValueOnce({ status: 202, body: { pending: true, cmdId: "h1" } })
        .mockResolvedValueOnce({
          status: 200,
          body: { entries: [{ id: "older-1", role: "user", text: "earlier msg" }], truncated: false, fetchedAt: Date.now() },
        }),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // -> session screen, empty transcript, offset 0 = maxOffset

    display.emit({ type: "scrollUp" }); // triggers history load (202 first)
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getHistory).toHaveBeenCalledWith("host-a", "s1");
    expect(app.getState().loadingHistory["s1"]).toBe(true);
    expect(display.lines).toContain("· loading earlier ·");

    await vi.advanceTimersByTimeAsync(3000); // history retry timer -> resolves 200
    expect(app.getState().loadingHistory["s1"]).toBe(false);
    expect(app.getState().transcripts["s1"]?.entries.map((e) => e.id)).toEqual(["older-1"]);
    expect(display.lines.some((l) => l.includes("earlier msg"))).toBe(true);
  });

  it("pending overlay clears once a poll shows the session's status changed", async () => {
    const running = agent({ sessions: [session({ status: "running" })] });
    const stopped = agent({ sessions: [session({ status: "stopped", session: null })] });
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [running] })
        .mockResolvedValueOnce({ now: Date.now(), agents: [running] }) // unchanged: still pending
        .mockResolvedValue({ now: Date.now(), agents: [stopped] }), // converged: kill took effect
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0); // 1st poll

    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom" (Task 4)
    display.emit({ type: "doubleTap" }); // input-mode doubleTap -> actions (cursor 0 = Restart, no draft)
    display.emit({ type: "scrollDown" }); // Kill
    display.emit({ type: "tap" }); // -> confirm
    display.emit({ type: "scrollDown" }); // cursor -> Confirm
    display.emit({ type: "tap" }); // executes kill

    await vi.advanceTimersByTimeAsync(0); // flush the sessionAction promise
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: unchanged
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(1000); // 3rd poll: status changed -> converged
    expect(app.getState().pending["s1"]).toBeUndefined();
  });

  it("pending overlay clears after 60s even with no convergence", async () => {
    const running = agent({ sessions: [session({ status: "running" })] });
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [running] })),
    });
    const app = makeApp(client, 10_000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom" (Task 4)
    display.emit({ type: "doubleTap" }); // input-mode doubleTap -> actions (cursor 0 = Restart, no draft)
    display.emit({ type: "tap" }); // queue restart
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(app.getState().pending["s1"]).toBeUndefined();
  });

  it("flashes 'hub unreachable' once on a poll error and clears it on the next success", async () => {
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue({ now: Date.now(), agents: [] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0); // 1st poll: error -> flash set

    expect(app.getState().pollErrorActive).toBe(true);
    expect(display.lines[0]).toBe(FLASH_HUB_UNREACHABLE);

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: still erroring
    expect(app.getState().pollErrorActive).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // 3rd poll: succeeds -> flash cleared
    expect(app.getState().pollErrorActive).toBe(false);
    expect(app.getState().flash).toBeNull();
  });

  it("restoreScreen jumps directly to a screen/session snapshot and repaints (Task 6 lifecycle glue)", async () => {
    const app = makeApp(fakeClient());
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().screen).toBe("home");

    app.restoreScreen("session", newSessionState("host-a", "s1"));

    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual(newSessionState("host-a", "s1"));
    expect(display.lines.length).toBeGreaterThan(0); // repainted

    app.restoreScreen("settings", null);
    expect(app.getState().screen).toBe("settings");
    expect(app.getState().session).toBeNull();
  });

  // ---- home cursor clamping (final-review finding #1) -------------------

  it("fresh state: home cursor snaps past the non-selectable host header onto the first session, so the very first tap opens it", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // Row 0 (hostHeader) is never selectable — the cursor must already be on
    // row 1 (the session) without any scroll input.
    expect(app.getState().home.cursor).toBe(1);
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual(newSessionState("host-a", "s1"));
  });

  it("rows shrinking below the cursor after a poll clamp it to a selectable row — tap works and scroll recovers", async () => {
    const s1 = session({ id: "s1", createdAt: "2026-01-01T00:00:00Z" });
    const s2 = session({ id: "s2", createdAt: "2026-01-01T00:00:01Z" });
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [agent({ sessions: [s1, s2] })] })
        // Both sessions converge away (killed/host reclaimed) — same host, no sessions left.
        .mockResolvedValue({ now: Date.now(), agents: [agent({ sessions: [] })] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0); // 1st poll: rows = [header, s1, s2, newSession, settings]

    expect(app.getState().home.cursor).toBe(1); // auto-snapped to s1
    display.emit({ type: "scrollDown" });
    expect(app.getState().home.cursor).toBe(2); // s2

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: rows shrink to [header, newSession, settings]
    // Without the clamp fix this stays 2, but row 2 no longer exists as a
    // session — it's now "Settings" here, so a stale (undefined) index would
    // have been the actual bug on a further-shrunk list. Either way the
    // cursor must land on a valid, selectable row automatically.
    expect(app.getState().home.cursor).toBe(2);

    // Scroll still works from the clamped position (doesn't get stuck).
    display.emit({ type: "scrollUp" });
    expect(app.getState().home.cursor).toBe(1); // "+ New session"

    // Tap works — not a no-op against a stale/undefined row.
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("newHost");
  });

  it("rows shrinking so the cursor lands exactly on a header searches outward for the nearest selectable row", async () => {
    const hostA = agent({ key: "host-a", device: "host-a", sessions: [session({ id: "sA1" })] });
    const hostB = agent({ key: "host-b", device: "host-b", sessions: [session({ id: "sB1" })] });
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [hostA, hostB] })
        // Both hosts' sessions disappear but both stay online — headerA and
        // headerB now sit back-to-back, right where the cursor (on sA1) was.
        .mockResolvedValue({
          now: Date.now(),
          agents: [
            agent({ key: "host-a", device: "host-a", sessions: [] }),
            agent({ key: "host-b", device: "host-b", sessions: [] }),
          ],
        }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    // rows = [headerA(0), sA1(1), headerB(2), sB1(3), newSession(4), settings(5)]
    expect(app.getState().home.cursor).toBe(1); // auto-snapped to sA1

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: both sessions gone
    // rows = [headerA(0), headerB(1), newSession(2), settings(3)] — the old
    // cursor (1) is now squarely on a non-selectable header, so the clamp
    // must search outward rather than just bounds-clamping.
    expect(app.getState().home.cursor).toBe(2); // newSession — never a header

    display.emit({ type: "tap" }); // must not be a no-op
    expect(app.getState().screen).toBe("newHost");
  });

  // ---- history polling: pause / leave-screen / retry cap (finding #3) ---

  it("pause() clears a pending history retry timer so it never fires again", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1 }) });
    const getHistory = vi.fn(async () => ({ status: 202 as const, body: { pending: true, cmdId: "h1" } }));
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory,
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // -> session
    display.emit({ type: "scrollUp" }); // triggers history load
    await vi.advanceTimersByTimeAsync(0);
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(app.getState().loadingHistory["s1"]).toBe(true);

    app.pause();
    expect(app.getState().loadingHistory["s1"]).toBeFalsy();

    await vi.advanceTimersByTimeAsync(30_000); // well past HISTORY_RETRY_MS
    expect(getHistory).toHaveBeenCalledTimes(1); // no further retries after pause
  });

  it("the 202 retry loop gives up after ~60s total and clears the loading line", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1 }) });
    const getHistory = vi.fn(async () => ({ status: 202 as const, body: { pending: true, cmdId: "h1" } }));
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory,
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // -> session
    display.emit({ type: "scrollUp" }); // triggers history load
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().loadingHistory["s1"]).toBe(true);

    await vi.advanceTimersByTimeAsync(61_000); // > PENDING_TIMEOUT_MS of retries
    expect(app.getState().loadingHistory["s1"]).toBe(false);

    const callsAtExpiry = getHistory.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getHistory.mock.calls.length).toBe(callsAtExpiry); // no further retries
  });

  it("leaving the session screen clears that session's history retry timer", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1 }) });
    const getHistory = vi.fn(async () => ({ status: 202 as const, body: { pending: true, cmdId: "h1" } }));
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory,
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // -> session
    display.emit({ type: "scrollUp" }); // triggers history load
    await vi.advanceTimersByTimeAsync(0);
    expect(getHistory).toHaveBeenCalledTimes(1);

    // triggerHistoryLoad bumped offset to 1 (to keep the new loading line in
    // view) — so reaching the bottom box now takes one extra tap: first
    // snaps offset back to 0, then hands focus to the bottom; doubleTap
    // there (input mode) opens actions (leaves the session screen).
    display.emit({ type: "tap" }); // offset>0 -> snap to 0
    display.emit({ type: "tap" }); // offset===0 -> focus:"bottom"
    display.emit({ type: "doubleTap" }); // input-mode doubleTap -> actions
    expect(app.getState().screen).toBe("actions");
    expect(app.getState().loadingHistory["s1"]).toBeFalsy();

    await vi.advanceTimersByTimeAsync(30_000); // well past HISTORY_RETRY_MS
    expect(getHistory).toHaveBeenCalledTimes(1); // no retry fired after leaving
  });

  // ---- truncated-history marker / no pointless refetch (finding #6) -----

  it("scrolling up at an already-fetched truncated top does not call getHistory again", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1 }) });
    const getHistory = vi.fn(async () => ({
      status: 200 as const,
      body: { entries: [{ id: "older-1", role: "user", text: "earlier msg" }], truncated: true, fetchedAt: Date.now() },
    }));
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory,
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // -> session, empty transcript
    display.emit({ type: "scrollUp" }); // hasMore undefined -> fetches
    await vi.advanceTimersByTimeAsync(0);
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(app.getState().transcripts["s1"]?.hasMore).toBe(true);

    display.emit({ type: "scrollUp" }); // hasMore === true -> must NOT re-fetch
    await vi.advanceTimersByTimeAsync(0);
    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it("the loading-earlier line stays visible at the top of a long, already-scrolled transcript while history is being fetched", async () => {
    // 11 lines so maxOffset (11 - area(9) = 2) is reachable in exactly one
    // SESSION_SCROLL_STEP (2-line) hop — preserves the "one hop to the top"
    // shape of this test under Task 4's stepped (not full-page) scrolling.
    const tail = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, role: "assistant", text: `msg ${i}` }));
    const s = session({ session: signals({ transcriptAgeSec: 1, tail }) });
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory: vi.fn(() => new Promise(() => {})), // never resolves — stays "loading"
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // -> session
    display.emit({ type: "scrollUp" }); // jumps to the (pre-fetch) top in one hop
    display.emit({ type: "scrollUp" }); // already at top, hasMore undefined -> triggers fetch
    await vi.advanceTimersByTimeAsync(0);

    expect(app.getState().loadingHistory["s1"]).toBe(true);
    // No header line (Task 2 dropped it): the loading line must be the very
    // first transcript line, not pushed out of view by a scroll offset that
    // didn't account for it.
    expect(display.lines[0]).toBe("· loading earlier ·");
  });
});

// ---- Task 4: session screen focus/scroll state --------------------------

describe("session screen: transcript-focus gestures (Task 4)", () => {
  let display: FakeDisplay;
  let dictation: FakeDictation;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    display = new FakeDisplay();
    dictation = new FakeDictation();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeApp(client: ReturnType<typeof fakeClient>) {
    return new App({
      client: client as unknown as HubClient,
      display,
      dictation,
      now: () => Date.now(),
      pollMs: 6000,
    });
  }

  // 20 short (unwrapped) tail lines is comfortably more than the transcript
  // area (9, given the default 1-line empty/unfocused input box) so offset
  // has room to move by SESSION_SCROLL_STEP without immediately hitting
  // maxOffset / triggering a history fetch.
  function longSession(): SessionInfo {
    const tail = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, role: "assistant", text: `msg ${i}` }));
    return session({ session: signals({ transcriptAgeSec: 1, tail }) });
  }

  async function enterSession(client: ReturnType<typeof fakeClient>): Promise<App> {
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "tap" }); // home -> session (fresh: focus:"transcript", offset:0)
    return app;
  }

  it("a fresh session starts at offset 0 with transcript focus", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);
    expect(app.getState().session).toEqual(newSessionState("host-a", "s1"));
  });

  it("two scrollUps move the offset by exactly 2 each — not a full-page jump", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "scrollUp" });
    expect(app.getState().session?.offset).toBe(2);

    display.emit({ type: "scrollUp" });
    expect(app.getState().session?.offset).toBe(4);
  });

  it("scrollDown moves the offset back by 2, clamped at 0", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "scrollUp" });
    display.emit({ type: "scrollUp" });
    expect(app.getState().session?.offset).toBe(4);

    display.emit({ type: "scrollDown" });
    expect(app.getState().session?.offset).toBe(2);

    display.emit({ type: "scrollDown" });
    expect(app.getState().session?.offset).toBe(0);

    display.emit({ type: "scrollDown" }); // already at 0 -> stays clamped
    expect(app.getState().session?.offset).toBe(0);
  });

  it("tap while scrolled snaps back to the newest (offset 0) and keeps transcript focus", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "scrollUp" });
    expect(app.getState().session?.offset).toBe(2);

    display.emit({ type: "tap" });
    expect(app.getState().session?.offset).toBe(0);
    expect(app.getState().session?.focus).toBe("transcript");
    expect(app.getState().screen).toBe("session");
  });

  it("tap at the tail (offset 0) hands focus to the bottom box, staying on the session screen", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);
    expect(app.getState().session?.offset).toBe(0);

    display.emit({ type: "tap" });
    expect(app.getState().session?.focus).toBe("bottom");
    expect(app.getState().screen).toBe("session");
  });

  it("doubleTap from transcript focus returns to home", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "doubleTap" });
    expect(app.getState().screen).toBe("home");
  });

  it("scrolling past the top still triggers a history fetch and shows the loading line (snap-to-tail behavior unaffected)", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1 }) }); // empty transcript
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
      getHistory: vi.fn(() => new Promise(() => {})), // never resolves — stays "loading"
    });
    const app = await enterSession(client);

    display.emit({ type: "scrollUp" }); // empty transcript: already at "the top"
    await vi.advanceTimersByTimeAsync(0);

    expect(app.getState().loadingHistory["s1"]).toBe(true);
    expect(display.lines).toContain("· loading earlier ·");
  });

  // ---- bottom-focus input mode (Task 5; sheet mode is still Task 6) -----

  it("input mode: doubleTap opens the actions menu (not a return to the transcript)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "tap" }); // -> focus:"bottom"
    expect(app.getState().session?.focus).toBe("bottom");

    display.emit({ type: "doubleTap" });
    expect(app.getState().screen).toBe("actions");
  });

  it("input mode: tap toggles dictation instead of opening the actions menu", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "tap" }); // -> focus:"bottom"
    display.emit({ type: "tap" }); // idle -> recording
    expect(app.getState().screen).toBe("session"); // stays put — no longer jumps to actions
    expect(app.getState().session?.mic).toBe("recording");
    expect(dictation.started).toBe(1);
  });

  it("input mode: scrolling an empty box (no draft) returns focus to the transcript", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "tap" }); // -> focus:"bottom"
    display.emit({ type: "scrollUp" });
    expect(app.getState().session?.focus).toBe("transcript");
  });

  describe("live tail + streaming reveal", () => {
    // This block needs a FakeLiveTail wired into the App (the enclosing
    // Task-4 describe's makeApp doesn't pass one), so it builds the App
    // itself rather than reusing the outer makeApp.
    let liveTail: FakeLiveTail;
    beforeEach(() => {
      liveTail = new FakeLiveTail();
    });

    async function enterSession() {
      const client = fakeClient({
        listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
      });
      const app = new App({
        client: client as unknown as HubClient,
        display,
        dictation,
        liveTail,
        now: () => Date.now(),
        pollMs: 6000,
      });
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      display.emit({ type: "tap" }); // home -> session
      expect(app.getState().screen).toBe("session");
      return app;
    }

    it("starts the live tail on entering a session and stops it on leaving", async () => {
      const app = await enterSession();
      expect(liveTail.started).toEqual([{ hostKey: "host-a", sessionId: "s1" }]);
      expect(liveTail.isWatching("s1")).toBe(true);

      display.emit({ type: "doubleTap" }); // session -> home
      expect(app.getState().screen).toBe("home");
      expect(liveTail.stops).toBe(1);
      expect(liveTail.isWatching("s1")).toBe(false);
    });

    it("types a small live delta in over successive reveal ticks", async () => {
      const app = await enterSession();
      // A brand-new short assistant entry: re-anchors hidden, then types in.
      liveTail.deliver([{ id: "m1", role: "assistant", text: "hello world" }]); // 11 chars
      expect(app.getState().reveal).toEqual({ entryId: "m1", shown: 0 });
      // 80ms tick @ 150cps -> 12 chars, clamps to the 11 available.
      await vi.advanceTimersByTimeAsync(80);
      expect(app.getState().reveal.shown).toBe(11);
      // The rendered assistant line shows the (now full) text.
      expect(display.lines.some((l) => l.includes("hello world"))).toBe(true);
    });

    it("snaps a big live block instead of typewriting it", async () => {
      const app = await enterSession();
      const big = "x".repeat(400); // > REVEAL_SNAP_CHARS
      liveTail.deliver([{ id: "m1", role: "assistant", text: big }]);
      // No tick needed — a block appears at once.
      expect(app.getState().reveal).toEqual({ entryId: "m1", shown: 400 });
    });

    it("reveals only the typed prefix of the newest entry while typing", async () => {
      const app = await enterSession();
      // Seed a first (older) entry via the live tail, let it finish.
      liveTail.deliver([{ id: "m1", role: "assistant", text: "done" }]);
      await vi.advanceTimersByTimeAsync(80);
      // A new long-ish entry that will take more than one tick to type.
      liveTail.deliver([
        { id: "m1", role: "assistant", text: "done" },
        { id: "m2", role: "assistant", text: "abcdefghijklmnopqrstuvwxyz0123456789" }, // 36 chars
      ]);
      expect(app.getState().reveal.entryId).toBe("m2");
      await vi.advanceTimersByTimeAsync(80); // 12 chars revealed
      const state = app.getState();
      expect(state.reveal.shown).toBe(12);
      // Older entry stays full; newest shows only its 12-char prefix.
      expect(display.lines.some((l) => l.includes("done"))).toBe(true);
      expect(display.lines.some((l) => l.includes("abcdefghijkl") && !l.includes("mnop"))).toBe(true);
    });

    it("stops the live tail and reveal timer on pause()", async () => {
      const app = await enterSession();
      liveTail.deliver([{ id: "m1", role: "assistant", text: "streaming text here" }]);
      app.pause();
      expect(liveTail.stops).toBe(1);
      const shownAtPause = app.getState().reveal.shown;
      await vi.advanceTimersByTimeAsync(500); // no ticks should fire while paused
      expect(app.getState().reveal.shown).toBe(shownAtPause);
    });

    it("freezes the reveal while scrolled up and resumes at the tail", async () => {
      const app = await enterSession();
      // Enough short entries that scrolling up moves the offset above 0.
      const older = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        role: "assistant",
        text: `line ${i}`,
      }));
      liveTail.deliver(older);
      await vi.advanceTimersByTimeAsync(80);
      // A new long entry begins typing (78 chars — more than one 80ms tick,
      // under the 200-char snap threshold).
      const longText = "abcdefghijklmnopqrstuvwxyz".repeat(3);
      liveTail.deliver([...older, { id: "mLast", role: "assistant", text: longText }]);
      expect(app.getState().reveal.entryId).toBe("mLast");

      // Scroll up to read history — the reveal must freeze.
      display.emit({ type: "scrollUp" });
      expect(app.getState().session?.offset ?? 0).toBeGreaterThan(0);
      const frozen = app.getState().reveal.shown;
      await vi.advanceTimersByTimeAsync(500);
      expect(app.getState().reveal.shown).toBe(frozen); // no ticks while scrolled up

      // Scroll back to the tail — the typewriter resumes and advances.
      for (let i = 0; i < 12; i++) display.emit({ type: "scrollDown" });
      expect(app.getState().session?.offset).toBe(0);
      await vi.advanceTimersByTimeAsync(80);
      expect(app.getState().reveal.shown).toBeGreaterThan(frozen);
    });
  });
});
