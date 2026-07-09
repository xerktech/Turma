import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, createInitialState, type AppState } from "./app.ts";
import type { HubClient } from "./hub-client.ts";
import type { GlassesDisplay } from "./display/index.ts";
import type { Dictation, DictationResult } from "./dictation.ts";
import type { AgentInfo, InputEvent } from "./types.ts";
import {
  installLifecycle,
  onAbnormalOrSystemExit,
  onBackgroundRestore,
  onForegroundEnter,
  onForegroundExit,
  resetLifecycleForTests,
  setBackgroundState,
  snapshotFromState,
  BACKGROUND_STATE_KEY,
} from "./lifecycle.ts";

type SnapshotHost = {
  __getStateSnapshot?: () => string;
  __restoreState?: (snapshot: string) => void;
};

function host(): SnapshotHost {
  return globalThis as unknown as SnapshotHost;
}

class FakeDisplay implements GlassesDisplay {
  lines: string[] = [];
  teardownCalled = 0;
  private cb: ((e: InputEvent) => void) | null = null;

  async start(): Promise<void> {}
  render(lines: string[]): void {
    this.lines = lines;
  }
  onInput(cb: (e: InputEvent) => void): void {
    this.cb = cb;
  }
  requestExit(): void {}
  emit(e: InputEvent): void {
    this.cb?.(e);
  }
  teardown(): void {
    this.teardownCalled++;
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

// A single online host with one running session — enough to drive the app
// into the reply/listening screen the same way a real user would (home ->
// session -> actions -> reply), for the mic-cancel-on-lifecycle tests below.
function agentWithSession(): AgentInfo {
  return {
    key: "host-a",
    device: "host-a",
    online: true,
    repos: [{ name: "myrepo", path: "/repos/myrepo" }],
    sessions: [
      {
        id: "s1",
        repo: "myrepo",
        status: "running",
        createdAt: "2026-01-01T00:00:00Z",
        session: {
          bridgeAttached: true,
          transcriptAgeSec: 1,
          lastRole: null,
          lastHasToolUse: false,
          question: null,
          questionOptions: [],
          tail: [],
          newPrUrls: [],
        },
      },
    ],
    closedSessions: [],
  };
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetLifecycleForTests();
});

afterEach(() => {
  resetLifecycleForTests();
  vi.useRealTimers();
});

describe("background-state registry (setBackgroundState / onBackgroundRestore)", () => {
  it("installs __getStateSnapshot and serialises the exporter result", () => {
    setBackgroundState("k", () => ({ n: 7 }));
    const snap = host().__getStateSnapshot?.();
    expect(typeof snap).toBe("string");
    expect(JSON.parse(snap as string)).toEqual({ k: { n: 7 } });
  });

  it("invokes the matching restorer when __restoreState is called", () => {
    let restored: unknown = null;
    onBackgroundRestore("k", (saved) => {
      restored = saved;
    });
    host().__restoreState?.(JSON.stringify({ k: { v: "hi" } }));
    expect(restored).toEqual({ v: "hi" });
  });

  it("replays a pending restore when the restorer registers late", () => {
    setBackgroundState("other", () => ({}));
    host().__restoreState?.(JSON.stringify({ k: { v: 9 } }));
    let restored: unknown = null;
    onBackgroundRestore("k", (saved) => {
      restored = saved;
    });
    expect(restored).toEqual({ v: 9 });
  });

  it("ignores invalid JSON without throwing", () => {
    let called = false;
    onBackgroundRestore("k", () => {
      called = true;
    });
    expect(() => host().__restoreState?.("not json")).not.toThrow();
    expect(called).toBe(false);
  });
});

describe("snapshotFromState", () => {
  function state(patch: Partial<AppState>): AppState {
    return { ...createInitialState(0), ...patch };
  }

  const HOME = { screen: "home", hostKey: null, sessionId: null };

  it("records home and settings as-is", () => {
    expect(snapshotFromState(state({ screen: "home" }))).toEqual(HOME);
    expect(snapshotFromState(state({ screen: "settings", settings: { cursor: 0 } }))).toEqual({
      screen: "settings",
      hostKey: null,
      sessionId: null,
    });
  });

  it("records the session screen with its hostKey/sessionId", () => {
    const s = state({ screen: "session", session: { hostKey: "h", sessionId: "s1", offset: 3 } });
    expect(snapshotFromState(s)).toEqual({ screen: "session", hostKey: "h", sessionId: "s1" });
  });

  it("degrades a session screen with missing sub-state to home", () => {
    expect(snapshotFromState(state({ screen: "session", session: null }))).toEqual(HOME);
  });

  it("maps the transient actions screen to its parent session", () => {
    const s = state({ screen: "actions", actions: { hostKey: "h", sessionId: "s1", cursor: 2 } });
    expect(snapshotFromState(s)).toEqual({ screen: "session", hostKey: "h", sessionId: "s1" });
  });

  it("maps the transient question screen to its parent session", () => {
    const s = state({ screen: "question", question: { hostKey: "h", sessionId: "s1", cursor: 1 } });
    expect(snapshotFromState(s)).toEqual({ screen: "session", hostKey: "h", sessionId: "s1" });
  });

  it("maps the transient confirm screen to its parent session", () => {
    const s = state({
      screen: "confirm",
      confirm: { action: { kind: "kill", hostKey: "h", sessionId: "s1" }, cursor: 0 },
    });
    expect(snapshotFromState(s)).toEqual({ screen: "session", hostKey: "h", sessionId: "s1" });
  });

  it("maps a session-targeted reply screen to its parent session", () => {
    const s = state({
      screen: "reply",
      reply: {
        target: { kind: "session", hostKey: "h", sessionId: "s1", back: "session" },
        phase: "listening",
        text: "",
        cursor: 0,
      },
    });
    expect(snapshotFromState(s)).toEqual({ screen: "session", hostKey: "h", sessionId: "s1" });
  });

  it("maps a spawn-targeted reply screen to home", () => {
    const s = state({
      screen: "reply",
      reply: {
        target: { kind: "spawn", hostKey: "h", repo: "r" },
        phase: "listening",
        text: "",
        cursor: 0,
      },
    });
    expect(snapshotFromState(s)).toEqual(HOME);
  });

  it("maps the transient spawn-flow screens (newHost/newRepo/newPrompt) to home", () => {
    expect(snapshotFromState(state({ screen: "newHost", newHost: { cursor: 0 } }))).toEqual(HOME);
    expect(snapshotFromState(state({ screen: "newRepo", newRepo: { hostKey: "h", cursor: 0 } }))).toEqual(HOME);
    expect(
      snapshotFromState(state({ screen: "newPrompt", newPrompt: { hostKey: "h", repo: "r", cursor: 0 } }))
    ).toEqual(HOME);
  });

  it("degrades a transient screen with missing sub-state to home", () => {
    expect(snapshotFromState(state({ screen: "actions", actions: null }))).toEqual(HOME);
    expect(snapshotFromState(state({ screen: "reply", reply: null }))).toEqual(HOME);
  });
});

describe("installLifecycle", () => {
  function makeApp(): { app: App; display: FakeDisplay } {
    const display = new FakeDisplay();
    const app = new App({
      client: fakeClient() as unknown as HubClient,
      display,
      dictation: new FakeDictation(),
      now: () => Date.now(),
      pollMs: 6000,
    });
    return { app, display };
  }

  it("exports the current screen and (when on the session screen) hostKey/sessionId", async () => {
    const { app } = makeApp();
    installLifecycle(app);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // Still on home — no session selected.
    let snap = JSON.parse(host().__getStateSnapshot!());
    expect(snap[BACKGROUND_STATE_KEY]).toEqual({ screen: "home", hostKey: null, sessionId: null });

    app.restoreScreen("session", { hostKey: "host-a", sessionId: "s1", offset: 0 });
    snap = JSON.parse(host().__getStateSnapshot!());
    expect(snap[BACKGROUND_STATE_KEY]).toEqual({ screen: "session", hostKey: "host-a", sessionId: "s1" });
  });

  it("restores to the session screen when the snapshot has hostKey+sessionId", async () => {
    const { app } = makeApp();
    installLifecycle(app);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    host().__restoreState?.(
      JSON.stringify({ [BACKGROUND_STATE_KEY]: { screen: "actions", hostKey: "host-a", sessionId: "s1" } })
    );

    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual({ hostKey: "host-a", sessionId: "s1", offset: 0 });
  });

  it("restores to a plain screen when the snapshot has no session", async () => {
    const { app } = makeApp();
    installLifecycle(app);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    host().__restoreState?.(JSON.stringify({ [BACKGROUND_STATE_KEY]: { screen: "settings", hostKey: null, sessionId: null } }));

    expect(app.getState().screen).toBe("settings");
    expect(app.getState().session).toBeNull();
  });

  it("round-trips a snapshot -> restore across a simulated fresh App instance", async () => {
    const { app: appA } = makeApp();
    installLifecycle(appA);
    await appA.start();
    await vi.advanceTimersByTimeAsync(0);
    appA.restoreScreen("session", { hostKey: "host-b", sessionId: "s9", offset: 0 });

    const snapshot = host().__getStateSnapshot!();

    // Simulate the host tearing down and recreating a headless WebView: a
    // brand-new App/lifecycle registration, replayed with the old snapshot.
    resetLifecycleForTests();
    const { app: appB } = makeApp();
    installLifecycle(appB);
    await appB.start();
    await vi.advanceTimersByTimeAsync(0);
    host().__restoreState?.(snapshot);

    expect(appB.getState().screen).toBe("session");
    expect(appB.getState().session).toEqual({ hostKey: "host-b", sessionId: "s9", offset: 0 });
  });

  it("works during the boot window: snapshot and restore both function BEFORE app.start()", async () => {
    // main.ts registers installLifecycle before app.start() (which is what
    // subscribes onEvenHubEvent) — so a host that snapshots or restores
    // during the boot window must not lose anything.
    const { app } = makeApp();
    installLifecycle(app);

    // Host snapshots before the app has even started polling.
    const snap = JSON.parse(host().__getStateSnapshot!());
    expect(snap[BACKGROUND_STATE_KEY]).toEqual({ screen: "home", hostKey: null, sessionId: null });

    // Host replays a prior snapshot before start() — must not be dropped.
    host().__restoreState?.(
      JSON.stringify({ [BACKGROUND_STATE_KEY]: { screen: "session", hostKey: "h", sessionId: "s1" } })
    );
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session).toEqual({ hostKey: "h", sessionId: "s1", offset: 0 });

    // Starting afterwards keeps the restored screen (the poll merges agent
    // data but never navigates).
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().screen).toBe("session");
  });

  it("snapshots a transient screen as its parent session and restores there (live App)", async () => {
    const { app } = makeApp();
    installLifecycle(app);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // Simulate the user being mid-flow on the actions screen when the host
    // backgrounds the app: snapshot must record the parent session view.
    app.restoreScreen("session", { hostKey: "host-a", sessionId: "s1", offset: 0 });
    app.handleInput({ type: "tap" }); // session -> actions
    expect(app.getState().screen).toBe("actions");

    const snapshot = host().__getStateSnapshot!();
    expect(JSON.parse(snapshot)[BACKGROUND_STATE_KEY]).toEqual({
      screen: "session",
      hostKey: "host-a",
      sessionId: "s1",
    });

    // Fresh WebView replays the snapshot -> lands on the parent session
    // screen, not a degraded null-sub-state actions screen.
    resetLifecycleForTests();
    const { app: appB } = makeApp();
    installLifecycle(appB);
    host().__restoreState?.(snapshot);
    expect(appB.getState().screen).toBe("session");
    expect(appB.getState().session).toEqual({ hostKey: "host-a", sessionId: "s1", offset: 0 });
  });

  it("degrades an unknown/transient screen in a stale snapshot to home on restore", async () => {
    const { app } = makeApp();
    installLifecycle(app);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // A snapshot written by an older build (or hand-corrupted) might carry a
    // transient screen with no session context — restore must land on home,
    // never a header-only fallback screen.
    host().__restoreState?.(
      JSON.stringify({ [BACKGROUND_STATE_KEY]: { screen: "reply", hostKey: null, sessionId: null } })
    );
    expect(app.getState().screen).toBe("home");
    expect(app.getState().session).toBeNull();
  });
});

describe("lifecycle phase handlers", () => {
  function makeApp(): { app: App; display: FakeDisplay } {
    const display = new FakeDisplay();
    const app = new App({
      client: fakeClient() as unknown as HubClient,
      display,
      dictation: new FakeDictation(),
      now: () => Date.now(),
      pollMs: 6000,
    });
    return { app, display };
  }

  it("onForegroundExit pauses the app (stops the poll loop)", async () => {
    const { app } = makeApp();
    await app.start();
    const pauseSpy = vi.spyOn(app, "pause");
    onForegroundExit(app);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it("onForegroundEnter resumes the app (triggers an immediate poll)", async () => {
    const { app } = makeApp();
    await app.start();
    app.pause();
    const resumeSpy = vi.spyOn(app, "resume");
    onForegroundEnter(app);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it("onAbnormalOrSystemExit pauses the app and tears the display down", async () => {
    const { app, display } = makeApp();
    await app.start();
    const pauseSpy = vi.spyOn(app, "pause");
    onAbnormalOrSystemExit(app, display);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(display.teardownCalled).toBe(1);
  });

  it("onAbnormalOrSystemExit tolerates a display with no teardown method", async () => {
    const { app } = makeApp();
    await app.start();
    expect(() => onAbnormalOrSystemExit(app, {})).not.toThrow();
  });
});

// Task 7: recording + foreground-exit / abnormal-exit / system-exit MUST
// cancel the active dictation (mic off). Ownership lives in App.pause()
// (app.ts) — onForegroundExit and onAbnormalOrSystemExit both funnel through
// it, never touching `dictation` directly — so driving these through the
// same fake-driven lifecycle handlers Task 6 established also proves the
// mic gets cancelled.
describe("lifecycle cancels an active dictation (mic off)", () => {
  function makeAppWithSession(): { app: App; display: FakeDisplay; dictation: FakeDictation } {
    const display = new FakeDisplay();
    const dictation = new FakeDictation();
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agentWithSession()] })),
    });
    const app = new App({
      client: client as unknown as HubClient,
      display,
      dictation,
      now: () => Date.now(),
      pollMs: 6000,
    });
    return { app, display, dictation };
  }

  async function driveIntoListeningReply(app: App, display: FakeDisplay): Promise<void> {
    await app.start();
    await vi.advanceTimersByTimeAsync(0); // let the first poll land the session; cursor auto-snaps to it
    display.emit({ type: "tap" }); // home -> session
    display.emit({ type: "tap" }); // session -> actions (cursor 0 = Reply)
    display.emit({ type: "tap" }); // actions -> reply, listening
  }

  it("onForegroundExit cancels a recording dictation via App.pause()", async () => {
    const { app, display, dictation } = makeAppWithSession();
    await driveIntoListeningReply(app, display);
    expect(app.getState().reply?.phase).toBe("listening");
    expect(dictation.started).toBe(1);

    onForegroundExit(app);

    expect(dictation.cancelled).toBe(1);
    expect(app.getState().screen).toBe("session");
  });

  it("onAbnormalOrSystemExit cancels a recording dictation via App.pause()", async () => {
    const { app, display, dictation } = makeAppWithSession();
    await driveIntoListeningReply(app, display);
    expect(app.getState().reply?.phase).toBe("listening");

    onAbnormalOrSystemExit(app, display);

    expect(dictation.cancelled).toBe(1);
    expect(app.getState().screen).toBe("session");
    expect(display.teardownCalled).toBe(1); // display teardown still happens too
  });

  it("does not cancel dictation when no dictation is active", async () => {
    const { app, display, dictation } = makeAppWithSession();
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    onForegroundExit(app);
    expect(dictation.cancelled).toBe(0);
  });
});
