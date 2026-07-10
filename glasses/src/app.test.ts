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

  it("question screen: tapping option N sends the digit as input and marks the session pending", async () => {
    const s = session({ session: signals({ transcriptAgeSec: 1, question: "pick", questionOptions: ["A", "B"] }) });
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [s] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // home.cursor already sits on the (only) session row post-poll.
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

  it("pause() cancels an in-progress dictation (reply screen, listening phase) and navigates back", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // actions (cursor 0 = Reply)
    display.emit({ type: "tap" }); // -> reply, listening
    expect(app.getState().reply?.phase).toBe("listening");
    expect(dictation.started).toBe(1);

    app.pause();

    expect(dictation.cancelled).toBe(1);
    // Same navigation a user-initiated cancel (double-tap while listening)
    // performs — back to the session screen, not stranded on "listening".
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual({ hostKey: "host-a", sessionId: "s1", offset: 0 });
  });

  it("pause() is a no-op for dictation when not on the reply/listening screen", async () => {
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

  it("pause() does not cancel dictation once the reply screen has moved past listening (preview phase)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // actions
    display.emit({ type: "tap" }); // -> reply, listening
    dictation.resolve({ text: "deploy the fix" });
    expect(app.getState().reply?.phase).toBe("preview");

    app.pause();
    expect(dictation.cancelled).toBe(0);
    expect(app.getState().screen).toBe("reply"); // untouched — not a listening dictation
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
    expect(app.getState().session).toEqual({ hostKey: "host-a", sessionId: "s1", offset: 0 });
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

    display.emit({ type: "tap" }); // -> actions (leaves the session screen)
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
    const tail = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, role: "assistant", text: `msg ${i}` }));
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
    // Header is lines[0]; the loading line must be the very next line, not
    // pushed out of view by a scroll offset that didn't account for it.
    expect(display.lines[1]).toBe("· loading earlier ·");
  });

  describe("live tail + streaming reveal", () => {
    async function enterSession() {
      const client = fakeClient({
        listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
      });
      const app = makeApp(client);
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
  });
});
