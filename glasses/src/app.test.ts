import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, FLASH_HUB_UNREACHABLE, FLASH_QUEUED } from "./app.ts";
import type { HubClient } from "./hub-client.ts";
import type { GlassesDisplay } from "./display/index.ts";
import type { Dictation, DictationResult } from "./dictation.ts";
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
  lines: string[] = [];
  started = false;
  exitRequested = false;
  private cb: ((e: InputEvent) => void) | null = null;

  async start(): Promise<void> {
    this.started = true;
  }
  render(lines: string[]): void {
    this.lines = lines;
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    display = new FakeDisplay();
    dictation = new FakeDictation();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeApp(client: ReturnType<typeof fakeClient>, pollMs = 6000) {
    return new App({
      client: client as unknown as HubClient,
      display,
      dictation,
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

    // cursor starts on the non-selectable host header row; scroll to the session row.
    display.emit({ type: "scrollDown" });
    expect(app.getState().home.cursor).toBe(1);
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual({ hostKey: "host-a", sessionId: "s1", offset: 0 });

    display.emit({ type: "tap" });
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

    // Home rows: [hostHeader(0), newSession(1), settings(2)] — no sessions on this agent.
    display.emit({ type: "scrollDown" }); // -> newSession row
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

  it("question screen: tapping option N sends the digit as input and marks the session pending", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1, question: "pick", questionOptions: ["A", "B"] }) });
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "scrollDown" }); // to session row
    display.emit({ type: "tap" }); // -> session screen
    display.emit({ type: "tap" }); // -> actions screen (cursor 0 = Reply)
    display.emit({ type: "scrollDown" }); // -> Answer question
    display.emit({ type: "tap" }); // -> question screen
    expect(app.getState().screen).toBe("question");

    // cursor 0 = option "1) A"
    display.emit({ type: "tap" });

    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "1");
    expect(app.getState().screen).toBe("session");
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(0); // flush the sendInput promise
    expect(display.lines[0]).toBe(FLASH_QUEUED);
  });

  it("reply screen: dictation result -> preview -> Send calls sendInput with the dictated text", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "scrollDown" });
    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // actions (cursor 0 = Reply)
    display.emit({ type: "tap" }); // -> reply, listening
    expect(app.getState().screen).toBe("reply");
    expect(app.getState().reply?.phase).toBe("listening");
    expect(dictation.started).toBe(1);

    dictation.resolve({ text: "deploy the fix" });
    expect(app.getState().reply?.phase).toBe("preview");

    display.emit({ type: "tap" }); // cursor 0 = Send
    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "deploy the fix");
    expect(app.getState().screen).toBe("session");

    await vi.advanceTimersByTimeAsync(0);
    expect(display.lines[0]).toBe(FLASH_QUEUED);
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

    display.emit({ type: "scrollDown" });
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

    display.emit({ type: "scrollDown" });
    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // actions (cursor 0 = Reply)
    display.emit({ type: "scrollDown" }); // Restart
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

    display.emit({ type: "scrollDown" });
    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // actions
    display.emit({ type: "scrollDown" }); // Restart
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

    app.restoreScreen("session", { hostKey: "host-a", sessionId: "s1", offset: 0 });

    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual({ hostKey: "host-a", sessionId: "s1", offset: 0 });
    expect(display.lines.length).toBeGreaterThan(0); // repainted

    app.restoreScreen("settings", null);
    expect(app.getState().screen).toBe("settings");
    expect(app.getState().session).toBeNull();
  });
});
