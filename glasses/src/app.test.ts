import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_MASK_MS, App, FLASH_ANSWERED, FLASH_HUB_UNREACHABLE, FLASH_QUEUED, HEARD_NOTHING, newSessionState } from "./app.ts";
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
  // Every listener ever registered, in order — so a test can fire a STALE one
  // (the listener for a session no longer focused, or after leaving the screen)
  // to exercise App.onLiveRefused's own session/screen guard, which the real
  // LiveTail's generation guard normally shields.
  callbacks: ((ev: import("./live.ts").LiveEvent) => void)[] = [];
  private cb: ((ev: import("./live.ts").LiveEvent) => void) | null = null;
  private current: string | null = null;

  start(hostKey: string, sessionId: string, onEvent: (ev: import("./live.ts").LiveEvent) => void): void {
    this.started.push({ hostKey, sessionId });
    this.cb = onEvent;
    this.callbacks.push(onEvent);
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
  // Committed transcript delta.
  deliver(entries: import("./types.ts").TailEntry[]): void {
    this.cb?.({ type: "tail", entries });
  }
  // In-progress assistant turn scraped from the TUI ("" clears it).
  deliverTurn(text: string): void {
    this.cb?.({ type: "turn", text });
  }
  // A terminal ws-token refusal (XERK-335) — LiveTail has already stopped.
  deliverRefused(message: string): void {
    this.cb?.({ type: "refused", message });
  }
  // Fire a refusal into a specific past listener (by registration order), even
  // after a switch or a stop() replaced/cleared the live one — used to prove
  // App.onLiveRefused ignores a refusal that no longer matches the focus.
  deliverRefusedVia(index: number, message: string): void {
    this.callbacks[index]?.({ type: "refused", message });
  }
}

function fakeClient(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    listAgents: vi.fn(async () => ({ now: Date.now(), agents: [] })),
    spawnSession: vi.fn(async () => ({ ok: true, cmdId: "spawn-1" })),
    sessionAction: vi.fn(async () => ({ ok: true, cmdId: "action-1" })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    sendInput: vi.fn(async () => ({ ok: true, cmdId: "input-1" })),
    answerQuestion: vi.fn(async () => ({ ok: true, cmdId: "answer-1" })),
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
    expect(display.lines[0]).toBe("TURMA 1 run · 0 ask");
  });

  it("setAutoStartOrg keys a prototype-member org name as an own key (XERK-1486)", () => {
    const app = makeApp(fakeClient());
    for (const k of ["constructor", "__proto__"]) {
      // OFF from the start: the prototype member is not the org's opt-in.
      expect(app.setAutoStartOrg(k, true)).toBe(false);
      expect(Object.hasOwn(app.getState().autoStartOrgs, k)).toBe(true);
      expect(app.setAutoStartOrg(k, false)).toBe(true);
      expect(Object.hasOwn(app.getState().autoStartOrgs, k)).toBe(false);
    }
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

  it("navigates newOrg -> newRepo -> newPrompt and spawns on Skip", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    // Home rows: [newSession(0), settings(1)] — no sessions, so no status
    // header, and the cursor starts on newSession.
    expect(app.getState().home.cursor).toBe(0);
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("newOrg");

    display.emit({ type: "tap" }); // pick "No org" (the only org with an online host)
    expect(app.getState().screen).toBe("newRepo");
    expect(app.getState().newRepo?.orgKey).toBe("");

    display.emit({ type: "tap" }); // pick myrepo (only repo, cursor 0)
    expect(app.getState().screen).toBe("newPrompt");
    expect(app.getState().newPrompt?.repo).toBe("myrepo");

    display.emit({ type: "scrollDown" }); // -> "Skip (spawn now)"
    display.emit({ type: "tap" });

    expect(client.spawnSession).toHaveBeenCalledWith("host-a", { repo: "myrepo" });
    expect(app.getState().screen).toBe("home");
    expect(app.getState().pending["spawn:host-a:myrepo"]).toBeDefined();
  });

  it("a blank prompt dictation offers Redo/Cancel, never Send on an empty preview", async () => {
    // Rollup XERK-1701: silence (or filtered non-speech) came back as "" and the
    // preview read "0 chars" with Send enabled.
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "tap" }); // newSession -> newOrg
    display.emit({ type: "tap" }); // org -> newRepo
    display.emit({ type: "tap" }); // myrepo -> newPrompt
    display.emit({ type: "tap" }); // "Dictate prompt" -> reply/listening
    expect(app.getState().screen).toBe("reply");
    dictation.resolve({ text: "  \n " });
    expect(app.getState().reply?.phase).toBe("unavailable");
    expect(app.getState().reply?.reason).toBe(HEARD_NOTHING);
    display.emit({ type: "tap" }); // cursor 0 = Redo, not Send
    expect(client.spawnSession).not.toHaveBeenCalled();
    expect(app.getState().reply?.phase).toBe("listening");
    dictation.resolve({ text: " fix the build " });
    expect(app.getState().reply?.text).toBe("fix the build");
  });


  // From home: scroll to the bottom (Settings), one up is "+ New session", tap.
  function openNewSession(): void {
    for (let i = 0; i < 12; i++) display.emit({ type: "scrollDown" });
    display.emit({ type: "scrollUp" });
    display.emit({ type: "tap" });
  }

  // ---- XERK-1913: status groups + the org-first new-session flow ---------

  it("the home cursor follows its session when a status flip regroups the list", async () => {
    const idle = signals({ paneBusy: false, transcriptAgeSec: 999 });
    const sA = session({ id: "sA", summary: "Alpha", createdAt: "2026-01-01T00:00:02Z", session: idle });
    const sB = session({ id: "sB", summary: "Bravo", createdAt: "2026-01-01T00:00:01Z", session: idle });
    const busyB = { ...sB, session: signals({ paneBusy: true, transcriptAgeSec: 1 }) };
    const client = fakeClient({
      listAgents: vi.fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [agent({ sessions: [sA, sB] })] })
        .mockResolvedValue({ now: Date.now(), agents: [agent({ sessions: [sA, busyB] })] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    // rows = [Idle(0), sA(1), sB(2), ...]
    expect(app.getState().home.cursor).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    // rows = [Active(0), sB(1), Idle(2), sA(3), ...] — the cursor moved with sA.
    expect(app.getState().home.cursor).toBe(3);
    display.emit({ type: "tap" });
    expect(app.getState().session?.sessionId).toBe("sA");
  });

  it("New session: org, then repo, starts on the org's least-busy host and Back returns to that org", async () => {
    const acme = { siteKey: "acme.atlassian.net", orgName: "Acme" };
    const repos = [{ name: "web", path: "/r/web" }];
    const busy = agent({ key: "h1", device: "h1", jira: acme, repos,
      sessions: [session({ id: "x1" }), session({ id: "x2" })] });
    const free = agent({ key: "h2", device: "h2", jira: acme, repos });
    const zeta = agent({ key: "h3", device: "h3", jira: { siteKey: "zeta.atlassian.net", orgName: "Zeta" }, repos });
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [zeta, busy, free] })) });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    openNewSession();
    display.emit({ type: "tap" }); // Acme (listed before Zeta)
    expect(app.getState().newRepo?.orgKey).toBe("acme.atlassian.net");
    display.emit({ type: "tap" }); // web
    expect(app.getState().newPrompt?.hostKey).toBe("h2");
    display.emit({ type: "doubleTap" }); // back to the repo list of the SAME org
    expect(app.getState().screen).toBe("newRepo");
    expect(app.getState().newRepo?.orgKey).toBe("acme.atlassian.net");
  });

  it("New session: tapping a repo whose org lost its hosts does nothing", async () => {
    const acme = { siteKey: "acme.atlassian.net", orgName: "Acme" };
    const up = agent({ key: "h1", jira: acme, repos: [{ name: "web", path: "/r/web" }] });
    const client = fakeClient({
      listAgents: vi.fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [up] })
        .mockResolvedValue({ now: Date.now(), agents: [{ ...up, online: false }] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    openNewSession();
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("newRepo");
    await vi.advanceTimersByTimeAsync(1000); // the org's only host went offline
    expect(() => display.emit({ type: "tap" })).not.toThrow();
    expect(app.getState().screen).toBe("newRepo");
    expect(client.spawnSession).not.toHaveBeenCalled();
  });

  it("the home cursor stays on its session when the list regroups with NO poll (a host ages offline)", async () => {
    const t0 = Date.now();
    const hA = agent({ key: "hA", lastSeen: t0,
      sessions: [session({ id: "sA", summary: "Alpha", createdAt: "2026-01-01T00:00:02Z", session: signals({ paneBusy: false, transcriptAgeSec: 999 }) })] });
    const hB = agent({ key: "hB", lastSeen: t0,
      sessions: [session({ id: "sB", summary: "Bravo", createdAt: "2026-01-01T00:00:01Z", session: signals({ paneBusy: true, transcriptAgeSec: 1 }) })] });
    const client = fakeClient({
      listAgents: vi.fn()
        .mockResolvedValueOnce({ now: t0, agents: [hA, hB] })
        .mockRejectedValue(new Error("offline")),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    // rows = [Active(0), sB(1), Idle(2), sA(3), ...]
    expect(app.getState().home.cursor).toBe(1);
    // Every poll now fails; past OFFLINE_AFTER_MS sB reads idle and regroups:
    // rows = [Idle(0), sA(1), sB(2), ...] with no successful poll to re-pin it.
    await vi.advanceTimersByTimeAsync(80_000);
    const screen = display.lines.join("\n");
    expect(screen).toMatch(/> . myrepo-Bravo/);
    display.emit({ type: "tap" });
    expect(app.getState().session?.sessionId).toBe("sB");
  });

  it("the home cursor stays on '+ New session' when a group header appears above it", async () => {
    const quiet = session({ id: "s1", summary: "One", session: signals({ paneBusy: false, transcriptAgeSec: 999 }) });
    const client = fakeClient({
      listAgents: vi.fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [agent({ sessions: [quiet] })] })
        .mockResolvedValue({ now: Date.now(), agents: [agent({ sessions: [quiet,
          session({ id: "s2", summary: "Two", createdAt: "2026-01-02T00:00:00Z", session: signals({ paneBusy: true, transcriptAgeSec: 1 }) })] })] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "scrollDown" }); // [Idle, s1, New, Settings] -> New
    await vi.advanceTimersByTimeAsync(1000); // [Active, s2, Idle, s1, New, Settings]
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("newOrg");
  });

  it("the home cursor keeps to its HOST's copy of a session id listed on two hosts", async () => {
    const dup = (summary: string) => session({ id: "dup", summary, session: signals({ paneBusy: false, transcriptAgeSec: 999 }) });
    const hA = agent({ key: "hA", sessions: [dup("OnA")] });
    const hB = agent({ key: "hB", sessions: [dup("OnB")] });
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [hA, hB] })) });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "scrollDown" }); // second copy
    const host = app.getState().home.selected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.getState().home.selected).toBe(host);
    display.emit({ type: "tap" });
    expect(`s:${JSON.stringify([app.getState().session?.hostKey, "dup"])}`).toBe(host);
  });

  it("New session pickers: a later org, a scroll past the end, and a tap after the repo list shrank", async () => {
    const repos = (...names: string[]) => names.map((name) => ({ name, path: "/r/" + name }));
    const acme = agent({ key: "h1", jira: { siteKey: "acme.atlassian.net", orgName: "Acme" }, repos: repos("a") });
    const zeta = (r: string[]) => agent({ key: "h3", jira: { siteKey: "zeta.atlassian.net", orgName: "Zeta" }, repos: repos(...r) });
    const client = fakeClient({
      listAgents: vi.fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [acme, zeta(["x", "y", "z"])] })
        .mockResolvedValue({ now: Date.now(), agents: [acme, zeta(["x"])] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    openNewSession();
    for (let i = 0; i < 5; i++) display.emit({ type: "scrollDown" }); // clamped to Zeta, the last
    expect(app.getState().newOrg?.cursor).toBe(1);
    display.emit({ type: "tap" });
    expect(app.getState().newRepo?.orgKey).toBe("zeta.atlassian.net");
    display.emit({ type: "scrollDown" });
    display.emit({ type: "scrollDown" }); // on "z"
    await vi.advanceTimersByTimeAsync(1000); // only "x" left
    display.emit({ type: "tap" });
    expect(app.getState().newPrompt).toMatchObject({ hostKey: "h3", repo: "x" });
  });

  // ---- post-mutation refresh: immediate poll + grace window -------------
  // A bare spawn via newOrg -> newRepo -> newPrompt -> "Skip (spawn now)",
  // then flush the spawnSession promise (which triggers nudgePoll's immediate
  // re-poll). Mirrors the "spawns on Skip" nav above.
  async function spawnBare(app: App): Promise<void> {
    display.emit({ type: "tap" }); // home newSession -> newOrg
    display.emit({ type: "tap" }); // pick the org
    display.emit({ type: "tap" }); // pick myrepo -> newPrompt
    display.emit({ type: "scrollDown" }); // -> "Skip (spawn now)"
    display.emit({ type: "tap" }); // spawn
    await vi.advanceTimersByTimeAsync(0); // flush spawn promise + immediate nudge poll
  }

  it("re-polls immediately after a spawn instead of waiting a full pollMs (nudgePoll)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client); // pollMs 6000
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listAgents).toHaveBeenCalledTimes(1);

    await spawnBare(app);

    // The refresh fires right after the spawn resolves — nowhere near pollMs.
    expect(client.spawnSession).toHaveBeenCalledTimes(1);
    expect(client.listAgents).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through the grace window after a spawn even when backgrounded", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    await spawnBare(app); // listAgents: 1 (start) + 1 (nudge) = 2
    expect(client.listAgents).toHaveBeenCalledTimes(2);

    app.pause(); // the HUD closes right after spawning

    // Without the grace window the poll loop would freeze here; instead it
    // keeps fetching so the just-spawned session still reaches the HUD.
    await vi.advanceTimersByTimeAsync(6000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(client.listAgents).toHaveBeenCalledTimes(4);
  });

  it("stops polling once the grace window elapses", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    await spawnBare(app);
    app.pause();

    await vi.advanceTimersByTimeAsync(120_000); // well past POLL_GRACE_MS
    const settled = client.listAgents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.listAgents).toHaveBeenCalledTimes(settled); // no polls after grace
  });

  it("a hard pause (abnormal/system exit) cancels the grace poll immediately", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent()] })),
    });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    await spawnBare(app); // 2 calls
    app.pause({ hard: true });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.listAgents).toHaveBeenCalledTimes(2); // frozen — no grace polling
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

  // A pending question makes the whole session screen act as the answer sheet
  // regardless of focus, so entering the session (one tap from home) lands
  // straight in it — no second "arm the box" tap. From here a single tap
  // answers the highlighted option; scroll moves the highlight first.
  async function toSheet(app: App): Promise<void> {
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    display.emit({ type: "tap" }); // home -> session (sheet active: question pending)
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

  it("sheet mode: tap on option index 1 sends the 0-based optionIndex, flashes, marks pending, and hands focus back to the transcript", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "scrollDown" }); // selected -> 1 ("B")
    display.emit({ type: "tap" });

    expect(client.answerQuestion).toHaveBeenCalledWith("host-a", "s1", { optionIndex: 1 });
    expect(client.sendInput).not.toHaveBeenCalled();
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.focus).toBe("transcript");
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(0); // flush the answerQuestion promise
    expect(app.getState().flash).toBe(FLASH_ANSWERED);
    expect(display.lines.some((l) => l.includes("answer sent"))).toBe(true);
  });

  it("sheet mode: an answered question leaves the screen at once, before the send settles, and re-polls immediately", async () => {
    let settle: (v: { ok: boolean; cmdId: string }) => void = () => {};
    const listAgents = vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] }));
    const client = fakeClient({
      listAgents,
      answerQuestion: vi.fn(() => new Promise((r) => { settle = r; })),
    });
    const app = makeApp(client);
    await toSheet(app);
    expect(bottomMode()).toBe("sheet");

    display.emit({ type: "tap" });
    // Hidden synchronously — no waiting on the POST, the agent's beat, or a poll.
    expect(bottomMode()).toBe("input");
    expect(app.getState().agents[0]!.sessions[0]!.session?.question).toBeNull();

    const polls = listAgents.mock.calls.length;
    settle({ ok: true, cmdId: "answer-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(listAgents.mock.calls.length).toBe(polls + 1); // nudged, not the 6s tick

    // The hub still reports the question until the agent's beat lands: it stays hidden.
    expect(bottomMode()).toBe("input");
    expect(app.getState().answered["s1"]).toBeDefined();
  });

  it("sheet mode: the hidden question is forgotten once the hub drops it, so a later identical question shows again", async () => {
    let agents = [questionAgent()];
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents })) });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    await vi.advanceTimersByTimeAsync(0);

    agents = [agent({ sessions: [session({ session: signals({ transcriptAgeSec: 1 }) })] })];
    await vi.advanceTimersByTimeAsync(6000);
    expect(app.getState().answered).toEqual({});

    agents = [questionAgent()];
    await vi.advanceTimersByTimeAsync(6000);
    expect(bottomMode()).toBe("sheet");
  });

  it("sheet mode: a different question replacing the answered one shows at once", async () => {
    let agents = [questionAgent()];
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents })) });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    await vi.advanceTimersByTimeAsync(0);

    agents = [questionAgentWith("next?", ["X", "Y"])];
    await vi.advanceTimersByTimeAsync(6000);
    expect(bottomMode()).toBe("sheet");
    expect(app.getState().answered).toEqual({});
  });

  it("sheet mode: a refused answer brings the question back so the wearer can retry", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })),
      answerQuestion: vi.fn(async () => { throw Object.assign(new Error("host offline"), { status: 503 }); }),
    });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    expect(bottomMode()).toBe("input");

    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().flash).toBe("x host offline");
    expect(app.getState().answered).toEqual({});
    expect(app.getState().pending["s1"]).toBeUndefined();
    expect(bottomMode()).toBe("sheet");
  });

  it("sheet mode: a question the hub keeps reporting comes back shortly after the send lands (an identical re-ask, or an answer the agent dropped)", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    await vi.advanceTimersByTimeAsync(0);
    expect(bottomMode()).toBe("input");

    // No question id on the wire: past the short mask the hub's word wins,
    // within one poll interval of it.
    await vi.advanceTimersByTimeAsync(ANSWER_MASK_MS + 6000);
    expect(bottomMode()).toBe("sheet");
  });

  it("sheet mode: the same text with different options is a new question and shows at once", async () => {
    let agents = [questionAgent()];
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents })) });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    await vi.advanceTimersByTimeAsync(0);

    agents = [questionAgentWith("pick", ["C", "D"])];
    await vi.advanceTimersByTimeAsync(6000);
    expect(bottomMode()).toBe("sheet");
  });

  it("sheet mode: the session stays pending until the hub itself stops reporting the question", async () => {
    let agents = [questionAgent()];
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents })) });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    await vi.advanceTimersByTimeAsync(0); // send lands + nudged poll (hub still reports it)
    expect(app.getState().pending["s1"]).toBeDefined();

    agents = [agent({ sessions: [session({ session: signals({ transcriptAgeSec: 1 }) })] })];
    await vi.advanceTimersByTimeAsync(6000);
    expect(app.getState().pending["s1"]).toBeUndefined();
  });

  it("an answer from outside the sheet (the phone) marks the session pending too", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    void app.answerQuestion("host-a", "s1", { optionIndex: 0 });
    expect(app.getState().pending["s1"]).toBeDefined();
  });

  it("an action queued while the answered question is hidden stays pending until the hub moves", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);
    display.emit({ type: "tap" });
    await vi.advanceTimersByTimeAsync(0);
    // A free-text send in the mask window snapshots pending from the masked view.
    (app as unknown as { markPending(id: string, s: unknown): void }).markPending(
      "s1",
      app.getState().agents[0]!.sessions[0]
    );
    await vi.advanceTimersByTimeAsync(6000); // hub still reports the question: nothing converged
    expect(app.getState().pending["s1"]).toBeDefined();
  });

  it("a second answer that fails does not bring back a question the first answer got through on", async () => {
    const answerQuestion = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, cmdId: "a1" })
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503 }));
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })),
      answerQuestion,
    });
    const app = makeApp(client);
    await toSheet(app);
    const first = app.answerQuestion("host-a", "s1", { optionIndex: 0 });
    const second = app.answerQuestion("host-a", "s1", { optionIndex: 1 }).catch(() => {});
    await first;
    await second;
    await vi.advanceTimersByTimeAsync(0);
    expect(bottomMode()).toBe("input");
    expect(app.getState().answered["s1"]).toBeDefined();
  });

  it("sheet mode: tap on option index 0 sends optionIndex 0", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "tap" }); // selected 0 = "A"
    expect(client.answerQuestion).toHaveBeenCalledWith("host-a", "s1", { optionIndex: 0 });
  });

  it("sheet mode: a single tap answers with no prior 'arm the box' tap, even from transcript focus", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);
    // Just entered the session — still transcript focus, never armed the box.
    expect(app.getState().session?.focus).toBe("transcript");

    display.emit({ type: "tap" }); // one tap answers the highlighted option
    expect(client.answerQuestion).toHaveBeenCalledTimes(1);
    expect(client.answerQuestion).toHaveBeenCalledWith("host-a", "s1", { optionIndex: 0 });
  });

  it("sheet mode: scroll moves the option highlight rather than scrolling the transcript while a question is pending", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);
    expect(app.getState().session?.focus).toBe("transcript");

    // From transcript focus, a scroll now drives the sheet's selection (the
    // sheet takes over the whole screen while a question is pending) — the
    // transcript offset stays put.
    display.emit({ type: "scrollDown" });
    expect(app.getState().session?.selected).toBe(1);
    expect(app.getState().session?.offset).toBe(0);
  });

  it("sheet mode: doubleTap opens the actions menu (session actions stay reachable while a question is pending)", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "doubleTap" });
    expect(app.getState().screen).toBe("actions");
  });

  it("sheet mode: the Options menu's last row, Home, leaves for home with the question still pending (XERK-1914)", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client);
    await toSheet(app);

    display.emit({ type: "doubleTap" }); // -> actions
    for (let i = 0; i < 10; i++) display.emit({ type: "scrollDown" }); // clamps on the last row
    display.emit({ type: "tap" });

    expect(app.getState().screen).toBe("home");
    expect(client.answerQuestion).not.toHaveBeenCalled();
    expect(client.sessionAction).not.toHaveBeenCalled();
  });

  it("sheet mode: tap on the trailing 'Dictate answer…' row starts box dictation and hands the box to input mode; the dictated draft then sends as a free-text answer while the question is pending", async () => {
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

    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back, draft present)
    display.emit({ type: "scrollDown" }); // 1 = Send
    display.emit({ type: "tap" }); // select Send

    // A pending question routes the dictated draft to answerQuestion as a
    // free-text ("Other") answer, not a plain typed message.
    expect(client.answerQuestion).toHaveBeenCalledWith("host-a", "s1", {
      optionIndex: -1,
      custom: "yes deploy",
    });
    expect(app.getState().screen).toBe("session");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().flash).toBe(FLASH_ANSWERED);
    expect(bottomMode()).toBe("input"); // the answered sheet does not flash back
  });

  it("a question arriving via poll while the box mic is recording (plain input mode) cancels the mic so it can't outlive the switch to the sheet", async () => {
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
    // The hot mic is cancelled and settled to idle, which flips the box into
    // sheet mode (mic idle + empty draft). Focus is now immaterial — the sheet
    // takes over the whole session screen regardless of it — so a tap answers.
    expect(dictation.cancelled).toBe(1);
    expect(app.getState().session?.mic).toBe("idle");
    expect(bottomMode()).toBe("sheet");
  });

  it("preserves the sheet's highlighted option across polls while the same question stays pending", async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [questionAgent()] })) });
    const app = makeApp(client, 1000);
    await toSheet(app);

    display.emit({ type: "scrollDown" }); // selected -> 1
    expect(app.getState().session?.selected).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // poll again: same question still pending
    expect(app.getState().session?.selected).toBe(1); // untouched
    expect(bottomMode()).toBe("sheet"); // still on the sheet
  });

  it("a different question replacing the pending one resets `selected` back to 0", async () => {
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

    // With a draft present, a tap opens the options menu (not a new recording
    // over the text). "Dictate more" appends another round, space-joined.
    display.emit({ type: "tap" }); // draft present -> actions menu
    expect(app.getState().screen).toBe("actions");
    display.emit({ type: "scrollDown" }); // Back(0) -> Send(1)
    display.emit({ type: "scrollDown" }); // -> Clear(2)
    display.emit({ type: "scrollDown" }); // -> Dictate more(3)
    display.emit({ type: "tap" }); // Dictate more -> back to box, recording
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.mic).toBe("recording");
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "and redeploy" });
    expect(app.getState().session?.draft).toBe("deploy the fix and redeploy");
  });

  describe("kept drafts (XERK-1858)", () => {
    let fleet: AgentInfo[] = [];
    const POLL = 1000;
    const poll = () => vi.advanceTimersByTimeAsync(POLL);
    async function boot(): Promise<App> {
      const app = makeApp(fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: fleet })) }), POLL);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      return app;
    }
    // From the session screen's transcript: focus the box and dictate `text`.
    function dictate(text: string): void {
      display.emit({ type: "tap" }); // -> bottom
      display.emit({ type: "tap" }); // -> recording
      display.emit({ type: "tap" }); // -> finalising
      dictation.resolve({ text });
    }
    const draftOf = (app: App) => app.getState().session?.draft;

    it("a phone switch stashes the left session's draft, and a phone entry restores it", async () => {
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      const app = await boot();
      app.enterSession("s1");
      dictate("one");
      app.enterSession("s2");
      expect(draftOf(app)).toBe("");
      app.enterSession("s1");
      expect(draftOf(app)).toBe("one");
    });

    it("a phone switch mid-recording cancels the mic", async () => {
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      const app = await boot();
      app.enterSession("s1");
      display.emit({ type: "tap" }); // -> bottom
      display.emit({ type: "tap" }); // -> recording
      expect(app.getState().session?.mic).toBe("recording");
      app.enterSession("s2");
      expect(dictation.cancelled).toBe(1);
      expect(app.getState().session?.mic).toBe("idle");
    });

    it("never hands one host's draft to another host's copy of the same id; the phone's hint picks the copy", async () => {
      fleet = [
        agent({ key: "A", sessions: [session({ id: "dup" }), session({ id: "other" })] }),
        agent({ key: "B", sessions: [session({ id: "dup" })] }),
      ];
      const app = await boot();
      app.enterSession("dup", "A");
      dictate("for A");
      app.enterSession("other");
      app.enterSession("dup", "B");
      expect(app.getState().session?.hostKey).toBe("B");
      expect(draftOf(app)).toBe("");
      app.enterSession("other");
      app.enterSession("dup", "A");
      expect(draftOf(app)).toBe("for A");
    });

    it("follows its session to a new host, and is dropped once no host lists the session", async () => {
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] }), agent({ key: "B" })];
      const app = await boot();
      app.enterSession("s1");
      dictate("moving");
      app.enterSession("s2");
      fleet = [agent({ key: "A", sessions: [session({ id: "s2" })] }), agent({ key: "B", sessions: [session({ id: "s1" })] })];
      await poll();
      app.enterSession("s1");
      expect(app.getState().session?.hostKey).toBe("B");
      expect(draftOf(app)).toBe("moving");

      app.enterSession("s2"); // stash it again, under B
      fleet = [agent({ key: "A", sessions: [session({ id: "s2" })] }), agent({ key: "B" })];
      await poll();
      expect(app.getState().drafts).toEqual({});
    });

    it("stays stashed while a question is pending, so the sheet shows and Send can't answer with it", async () => {
      const asking = signals({ question: "Ship it?", questionOptions: ["Yes", "No"] });
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      const app = await boot();
      app.enterSession("s1");
      dictate("unrelated note");
      app.enterSession("s2");
      fleet = [agent({ key: "A", sessions: [session({ id: "s1", session: asking }), session({ id: "s2" })] })];
      await poll();
      app.enterSession("s1");
      expect(draftOf(app)).toBe("");
      const model = app.getState();
      expect(model.screen).toBe("session");
      expect(display.lines.some((l) => l.includes("Ship it?"))).toBe(true);
      // The question clears: the draft comes back on the next poll.
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      await poll();
      expect(draftOf(app)).toBe("unrelated note");
    });

    // Holds "held note" back on s1 behind a pending question, with the wearer
    // now on s1's sheet. `client` is the fake hub.
    async function heldBehindQuestion() {
      const asking = signals({ question: "Ship it?", questionOptions: ["Yes", "No"] });
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: fleet })) });
      const app = makeApp(client, POLL);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      app.enterSession("s1");
      dictate("held note");
      app.enterSession("s2");
      fleet = [agent({ key: "A", sessions: [session({ id: "s1", session: asking }), session({ id: "s2" })] })];
      await poll();
      app.enterSession("s1");
      expect(draftOf(app)).toBe("");
      expect(Object.keys(app.getState().drafts)).toHaveLength(1);
      return { app, client };
    }
    const cleared = () => {
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
    };

    it("a held draft restored by the poll leaves the stash: sent once, never back", async () => {
      const { app, client } = await heldBehindQuestion();
      cleared();
      await poll();
      expect(draftOf(app)).toBe("held note");
      expect(app.getState().drafts).toEqual({});
      display.emit({ type: "tap" }); // -> bottom
      display.emit({ type: "tap" }); // draft present -> actions
      display.emit({ type: "scrollDown" }); // Back(0) -> Send(1)
      display.emit({ type: "tap" });
      await vi.waitFor(() => expect(client.sendInput).toHaveBeenCalledTimes(1));
      await poll();
      await poll();
      expect(draftOf(app)).toBe("");
      expect(app.getState().drafts).toEqual({});
      expect(client.sendInput).toHaveBeenCalledTimes(1);
    });

    it("answering the sheet brings the held draft back once, out of the stash", async () => {
      const { app, client } = await heldBehindQuestion();
      display.emit({ type: "tap" }); // answer option 1 on the sheet
      await vi.waitFor(() => expect(client.answerQuestion).toHaveBeenCalledTimes(1));
      await poll();
      expect(draftOf(app)).toBe("held note");
      expect(app.getState().drafts).toEqual({});
      await poll();
      expect(draftOf(app)).toBe("held note");
    });

    it("an empty poll is not a cleared question: the held draft stays stashed until the session is listed without one", async () => {
      const { app, client } = await heldBehindQuestion();
      const asked = fleet;
      fleet = []; // a hub that just restarted
      await poll();
      expect(draftOf(app)).toBe("");
      expect(Object.keys(app.getState().drafts)).toHaveLength(1);
      fleet = asked; // back, question still pending
      await poll();
      expect(draftOf(app)).toBe("");
      expect(display.lines.some((l) => l.includes("Ship it?"))).toBe(true);
      // The wearer's tap answers the sheet with an option, never the draft.
      display.emit({ type: "tap" });
      await vi.waitFor(() => expect(client.answerQuestion).toHaveBeenCalledTimes(1));
      expect(JSON.stringify(client.answerQuestion.mock.calls)).not.toContain("held note");
      cleared();
      await poll();
      expect(draftOf(app)).toBe("held note");
      expect(app.getState().drafts).toEqual({});
      await poll();
      expect(draftOf(app)).toBe("held note");
    });

    it("a restored held draft is not doubled by leaving and coming back", async () => {
      const { app } = await heldBehindQuestion();
      cleared();
      await poll();
      app.enterSession("s2");
      expect(Object.values(app.getState().drafts).map((d) => d.text)).toEqual(["held note"]);
      app.enterSession("s1");
      expect(draftOf(app)).toBe("held note");
      expect(app.getState().drafts).toEqual({});
    });

    it("the phone's hint switches between two hosts' copies of the id on screen", async () => {
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" })] }), agent({ key: "B", sessions: [session({ id: "s1" })] })];
      const app = await boot();
      app.enterSession("s1", "B");
      app.enterSession("s1", "A");
      expect(app.getState().session?.hostKey).toBe("A");
      app.enterSession("s1"); // no hint: already here, stays
      expect(app.getState().session?.hostKey).toBe("A");
    });

    it("keeps drafts through an empty fleet or an offline host; drops them once their online host stops listing them", async () => {
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      const app = await boot();
      app.enterSession("s1");
      dictate("keep me");
      app.enterSession("s2");
      fleet = []; // a hub that just restarted
      await poll();
      expect(Object.keys(app.getState().drafts)).toHaveLength(1);
      fleet = [agent({ key: "A", online: false, sessions: [] })];
      await poll();
      expect(Object.keys(app.getState().drafts)).toHaveLength(1);
      fleet = [agent({ key: "A", sessions: [session({ id: "s2" })] })];
      await poll();
      expect(app.getState().drafts).toEqual({});
    });

    it("a new draft left beside a held one joins it, never replaces it, and is never doubled", async () => {
      const asking = signals({ question: "Ship it?", questionOptions: ["Yes", "No"] });
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      const app = await boot();
      app.enterSession("s1");
      dictate("held note");
      app.enterSession("s2");
      fleet = [agent({ key: "A", sessions: [session({ id: "s1", session: asking }), session({ id: "s2" })] })];
      await poll();
      app.enterSession("s1"); // sheet shows; "held note" stays held
      // Dictate a fresh draft through the sheet's last row, then leave twice
      // over (home, then another session) without sending.
      for (let i = 0; i < 5; i++) display.emit({ type: "scrollDown" });
      display.emit({ type: "tap" }); // Dictate answer -> recording
      display.emit({ type: "tap" }); // -> finalising
      dictation.resolve({ text: "new note" });
      expect(draftOf(app)).toBe("new note");
      display.emit({ type: "doubleTap" }); // -> actions
      for (let i = 0; i < 10; i++) display.emit({ type: "scrollDown" });
      display.emit({ type: "tap" }); // Home
      expect(app.getState().screen).toBe("home");
      app.enterSession("s2");
      fleet = [agent({ key: "A", sessions: [session({ id: "s1" }), session({ id: "s2" })] })];
      await poll();
      app.enterSession("s1");
      expect(draftOf(app)).toBe("held note new note");
    });
  });

  it("leaving a session keeps its unsent draft for the next entry; Send still clears it (XERK-1858)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);
    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "deploy the fix" });

    // Leave by the Options menu's Home row (the last row).
    display.emit({ type: "tap" }); // draft present -> actions menu
    for (let i = 0; i < 10; i++) display.emit({ type: "scrollDown" });
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("home");

    display.emit({ type: "tap" }); // home -> the same session
    expect(app.getState().screen).toBe("session");
    expect(app.getState().session?.draft).toBe("deploy the fix");

    // Sending it zeroes the draft, and the next entry starts empty.
    display.emit({ type: "doubleTap" }); // transcript -> home
    expect(app.getState().screen).toBe("home");
    display.emit({ type: "tap" });
    expect(app.getState().session?.draft).toBe("deploy the fix");
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom"
    display.emit({ type: "tap" }); // draft present -> actions menu
    display.emit({ type: "scrollDown" }); // Back(0) -> Send(1)
    display.emit({ type: "tap" });
    await vi.waitFor(() => expect(client.sendInput).toHaveBeenCalled());
    display.emit({ type: "doubleTap" }); // transcript -> home
    display.emit({ type: "tap" });
    expect(app.getState().session?.draft).toBe("");
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

  it("input mode: a blank dictation leaves the draft untouched and says it heard nothing", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [session()] })] })),
    });
    const app = makeApp(client);
    await toSessionBottom(app);

    display.emit({ type: "tap" }); // idle -> recording
    dictation.resolve({ text: "deploy the fix " });
    expect(app.getState().session?.draft).toBe("deploy the fix");
    // With a draft, a tap opens the menu: Back, Send, Clear, Dictate more.
    display.emit({ type: "tap" });
    for (let i = 0; i < 3; i++) display.emit({ type: "scrollDown" });
    display.emit({ type: "tap" }); // Dictate more -> recording
    expect(app.getState().session?.mic).toBe("recording");
    dictation.resolve({ text: " " }); // silence: no stray trailing space (rollup XERK-1701)
    expect(app.getState().session?.draft).toBe("deploy the fix");
    expect(app.getState().session?.mic).toBe("idle");
    expect(app.getState().flash).toBe(HEARD_NOTHING);
    // ...and DRAWN: a flash set after the repaint stayed off the glasses (QA).
    expect(display.lines.join(" ")).toContain("heard nothing");
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

    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back)
    display.emit({ type: "scrollDown" }); // 1 = Send
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

    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back)
    display.emit({ type: "scrollDown" }); // 1 = Send
    display.emit({ type: "scrollDown" }); // 2 = Clear
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

    // Draft present: rows are [Back, Send, Clear, Dictate more, End this session].
    display.emit({ type: "doubleTap" }); // -> actions, cursor 0 = Back
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
    // Newest first (XERK-1913), so s1 is the newer one and heads the list.
    const s1 = session({ id: "s1", createdAt: "2026-01-01T00:00:01Z" });
    const s2 = session({ id: "s2", createdAt: "2026-01-01T00:00:00Z" });
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

  it("a stopped session's Options menu also ends with Home, which leaves without starting it (XERK-1914)", async () => {
    const stopped = agent({ sessions: [session({ status: "stopped", session: null })] });
    const client = fakeClient({ listAgents: vi.fn(async () => ({ now: Date.now(), agents: [stopped] })) });
    const app = makeApp(client);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);

    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // focus:"bottom"
    display.emit({ type: "doubleTap" }); // -> actions: Back / Start / Home
    expect(app.getState().screen).toBe("actions");
    display.emit({ type: "scrollDown" });
    display.emit({ type: "scrollDown" }); // Home
    display.emit({ type: "tap" });

    expect(app.getState().screen).toBe("home");
    expect(client.sessionAction).not.toHaveBeenCalled();
  });

  it("pending overlay clears once a poll shows the session's status changed", async () => {
    const running = agent({ sessions: [session({ status: "running" })] });
    const stopped = agent({ sessions: [session({ status: "stopped", session: null })] });
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [running] })
        .mockResolvedValueOnce({ now: Date.now(), agents: [running] }) // immediate nudge poll after kill: still pending
        .mockResolvedValueOnce({ now: Date.now(), agents: [running] }) // unchanged: still pending
        .mockResolvedValue({ now: Date.now(), agents: [stopped] }), // converged: kill took effect
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0); // 1st poll

    display.emit({ type: "tap" }); // session
    display.emit({ type: "tap" }); // tap at tail -> focus:"bottom" (Task 4)
    display.emit({ type: "doubleTap" }); // input-mode doubleTap -> actions (cursor 0 = Back, no draft)
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
    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back, no draft)
    display.emit({ type: "scrollDown" }); // 1 = Kill
    display.emit({ type: "tap" }); // -> confirm
    display.emit({ type: "scrollDown" }); // cursor -> Confirm
    display.emit({ type: "tap" }); // queue kill (session stays running, never converges)
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getState().pending["s1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(app.getState().pending["s1"]).toBeUndefined();
  });

  // XERK-270: the hub explains every refusal it makes — "the target agent is in
  // a different org", the queue limit, the character cap — and the flash is the
  // wearer's ONLY feedback. Every catch used to drop those words for a flat
  // "hub unreachable", which is also wrong: the hub answered, it just said no.
  describe("a refused command flashes the hub's own words", () => {
    function refused(status: number, message: string): Error {
      return Object.assign(new Error(message), { name: "HttpError", status });
    }

    async function toKillConfirm(app: App): Promise<void> {
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      display.emit({ type: "tap" }); // home -> session
      display.emit({ type: "tap" }); // -> focus "bottom"
      display.emit({ type: "doubleTap" }); // -> actions
      display.emit({ type: "scrollDown" }); // 1 = Kill
      display.emit({ type: "tap" }); // -> confirm
      display.emit({ type: "scrollDown" }); // cursor -> Confirm
      display.emit({ type: "tap" }); // executes kill
    }

    it("a session action refused by the hub shows what the hub said", async () => {
      const running = agent({ sessions: [session({ status: "running" })] });
      const client = fakeClient({
        listAgents: vi.fn(async () => ({ now: Date.now(), agents: [running] })),
        sessionAction: vi.fn(async () => { throw refused(503, "that host is offline"); }),
      });
      const app = makeApp(client, 10_000);
      await toKillConfirm(app);

      await vi.advanceTimersByTimeAsync(0); // flush the rejection
      expect(app.getState().flash).toBe("x that host is offline");
      expect(display.lines.some((l) => l.includes("that host is offline"))).toBe(true);
    });

    it("a spawn refusal lands on the home screen the spawn returned to", async () => {
      const client = fakeClient({
        listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [] })] })),
        spawnSession: vi.fn(async () => { throw refused(429, "too many queued commands"); }),
      });
      const app = makeApp(client, 10_000);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      display.emit({ type: "tap" }); // home's "+ New session" -> choose host
      display.emit({ type: "tap" }); // pick host-a -> choose repo
      display.emit({ type: "tap" }); // pick myrepo -> dictate initial prompt?
      display.emit({ type: "scrollDown" }); // -> "Skip (spawn now)"
      display.emit({ type: "tap" }); // spawn

      await vi.advanceTimersByTimeAsync(0);
      expect(client.spawnSession).toHaveBeenCalled();
      expect(app.getState().screen).toBe("home");
      expect(app.getState().flash).toBe("x too many queued commands");
    });

    it("a transport failure still reads 'hub unreachable' — nothing answered", async () => {
      const running = agent({ sessions: [session({ status: "running" })] });
      const client = fakeClient({
        listAgents: vi.fn(async () => ({ now: Date.now(), agents: [running] })),
        sessionAction: vi.fn(async () => { throw new Error("Failed to fetch"); }),
      });
      const app = makeApp(client, 10_000);
      await toKillConfirm(app);

      await vi.advanceTimersByTimeAsync(0);
      expect(app.getState().flash).toBe(FLASH_HUB_UNREACHABLE);
    });

    it("a refused history pull says why instead of looking like 'no more history'", async () => {
      const running = agent({ sessions: [session({ session: signals({ transcriptAgeSec: 1 }) })] });
      const client = fakeClient({
        listAgents: vi.fn(async () => ({ now: Date.now(), agents: [running] })),
        getHistory: vi.fn(async () => { throw refused(503, "that host is offline"); }),
      });
      const app = makeApp(client, 10_000);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      display.emit({ type: "tap" }); // -> session screen
      display.emit({ type: "scrollUp" }); // triggers the history load
      await vi.advanceTimersByTimeAsync(0);

      expect(app.getState().loadingHistory["s1"]).toBe(false);
      expect(app.getState().flash).toBe("x that host is offline");
    });

    it("a REFUSED poll says so instead of blaming the network", async () => {
      const client = fakeClient({
        listAgents: vi.fn(async () => { throw refused(401, "the hub answered HTTP 401"); }),
      });
      const app = makeApp(client, 10_000);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(app.getState().pollErrorActive).toBe(true);
      expect(app.getState().flash).toBe("x the hub answered HTTP 401");
    });
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
    await vi.advanceTimersByTimeAsync(0); // 1st poll: rows = [Active header, s1, s2, newSession, settings]

    expect(app.getState().home.cursor).toBe(1); // auto-snapped to s1
    display.emit({ type: "scrollDown" });
    expect(app.getState().home.cursor).toBe(2); // s2

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: rows shrink to [newSession, settings]
    // Without the clamp fix this stays 2, an index that no longer exists, so
    // the cursor must land on a valid, selectable row automatically.
    expect(app.getState().home.cursor).toBe(1); // "Settings"

    // Scroll still works from the clamped position (doesn't get stuck).
    display.emit({ type: "scrollUp" });
    expect(app.getState().home.cursor).toBe(0); // "+ New session"

    // Tap works — not a no-op against a stale/undefined row.
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("newOrg");
  });

  it("rows shrinking so the cursor lands exactly on a header searches outward for the nearest selectable row", async () => {
    // XERK-1913: the headers are status groups now. Two sessions wait on the
    // operator (Ready for review) and one is idle; the first review one goes,
    // so the Idle header slides up under the cursor.
    const ask = (id: string, at: string) =>
      session({ id, createdAt: at, session: signals({ question: "pick one" }) });
    const quiet = session({ id: "sI", createdAt: "2026-01-01T00:00:09Z", session: signals({ transcriptAgeSec: 999 }) });
    const r1 = ask("sR1", "2026-01-01T00:00:01Z"), r2 = ask("sR2", "2026-01-01T00:00:02Z");
    const client = fakeClient({
      listAgents: vi
        .fn()
        .mockResolvedValueOnce({ now: Date.now(), agents: [agent({ sessions: [r1, r2, quiet] })] })
        .mockResolvedValue({ now: Date.now(), agents: [agent({ sessions: [r2, quiet] })] }),
    });
    const app = makeApp(client, 1000);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    // rows = [reviewH(0), sR1(1), sR2(2), idleH(3), sI(4), newSession(5), settings(6)]
    expect(app.getState().home.cursor).toBe(1);
    display.emit({ type: "scrollDown" });
    expect(app.getState().home.cursor).toBe(2); // sR2

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: sR1 gone
    // rows = [reviewH(0), sR2(1), idleH(2), sI(3), ...] — the old cursor (2) is
    // now squarely on a non-selectable header, so the clamp must search outward.
    const c = app.getState().home.cursor;
    expect([1, 3]).toContain(c); // a session — never a header

    display.emit({ type: "tap" }); // must not be a no-op
    expect(app.getState().screen).toBe("session");
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

  it("input mode: an empty-box tap starts dictation (not the actions menu)", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "tap" }); // -> focus:"bottom"
    display.emit({ type: "tap" }); // idle -> recording
    expect(app.getState().screen).toBe("session"); // stays put — no jump to actions
    expect(app.getState().session?.mic).toBe("recording");
    expect(dictation.started).toBe(1);
  });

  it("input mode: with a draft present, a tap opens the options menu instead of recording over the text", async () => {
    const client = fakeClient({
      listAgents: vi.fn(async () => ({ now: Date.now(), agents: [agent({ sessions: [longSession()] })] })),
    });
    const app = await enterSession(client);

    display.emit({ type: "tap" }); // focus bottom
    display.emit({ type: "tap" }); // idle -> recording
    display.emit({ type: "tap" }); // recording -> finalising
    dictation.resolve({ text: "ship it" });
    expect(app.getState().session?.draft).toBe("ship it");
    expect(dictation.started).toBe(1);

    // The next tap opens Send/Clear/Dictate-more, and does NOT start a new
    // recording over the existing text.
    display.emit({ type: "tap" });
    expect(app.getState().screen).toBe("actions");
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

  describe("live tail", () => {
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

    // XERK-251: nothing types in any more — a delta is on the glasses in full
    // the frame it lands, however big it is.
    it("shows a freshly-committed entry in full immediately", async () => {
      const app = await enterSession();
      liveTail.deliver([{ id: "m1", role: "assistant", text: "hello world" }]);
      expect(app.getState().transcripts.s1?.entries.length).toBe(1);
      expect(display.lines.some((l) => l.includes("hello world"))).toBe(true);
    });

    it("shows an entry growing in place in full, with no prefix held back", async () => {
      const app = await enterSession();
      liveTail.deliver([{ id: "m1", role: "assistant", text: "done" }]);
      liveTail.deliver([
        { id: "m1", role: "assistant", text: "done" },
        { id: "m2", role: "assistant", text: "abc" },
      ]);
      // The SAME entry now grows in place (e.g. a poll delivering more of a
      // still-arriving message) — every new character is on screen at once.
      liveTail.deliver([
        { id: "m1", role: "assistant", text: "done" },
        { id: "m2", role: "assistant", text: "abcdefghijklmnopqrstuvwxyz0123456789" },
      ]);
      expect(app.getState().transcripts.s1?.entries.length).toBe(2);
      expect(display.lines.some((l) => l.includes("done"))).toBe(true);
      expect(display.lines.join(" ")).toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    });

    it("sanitises the in-progress turn for the G2 font like the committed tail (XERK-928)", async () => {
      const app = await enterSession();
      liveTail.deliverTurn(`${String.fromCodePoint(0x2713)} live`);
      expect(app.getState().liveTurn).toEqual({ sessionId: "s1", text: "√ live" });
    });

    it("stops the live tail on pause()", async () => {
      const app = await enterSession();
      liveTail.deliver([{ id: "m1", role: "assistant", text: "some text here" }]);
      app.pause();
      expect(liveTail.stops).toBe(1);
      expect(app.getState().liveTurn).toBe(null);
    });

    it("shows the in-progress assistant turn from the TUI, then hands off to the committed transcript", async () => {
      const app = await enterSession();
      // A live delta: Claude is generating (transcript has only the user turn).
      liveTail.deliver([{ id: "u1", role: "user", text: "haiku please" }]);
      // The TUI stream delivers the in-progress assistant text.
      liveTail.deliverTurn("Salt breath meets the shore");
      expect(app.getState().liveTurn).toEqual({ sessionId: "s1", text: "Salt breath meets the shore" });
      expect(display.lines.some((l) => l.includes("Salt breath"))).toBe(true);

      // Turn completes: the committed transcript delivers the real entry and the
      // agent clears the live turn.
      liveTail.deliver([
        { id: "u1", role: "user", text: "haiku please" },
        { id: "a1", role: "assistant", text: "Salt breath meets the shore, gulls trace the tide." },
      ]);
      liveTail.deliverTurn("");
      expect(app.getState().liveTurn).toBe(null);
      await vi.advanceTimersByTimeAsync(300);
      // No duplicate: the committed entry is shown, the synthetic __live is gone.
      expect(display.lines.filter((l) => l.includes("Salt breath")).length).toBe(1);
    });

    it("drops the live turn when leaving the session", async () => {
      const app = await enterSession();
      liveTail.deliverTurn("streaming…");
      expect(app.getState().liveTurn).not.toBe(null);
      display.emit({ type: "doubleTap" }); // session -> home
      expect(app.getState().liveTurn).toBe(null);
    });

    it("pins a terminal ws-token refusal as a sticky line, then clears it on leaving (XERK-335)", async () => {
      const app = await enterSession();
      // The hub refused the ws-token (a wrong hub password 401s it); LiveTail
      // surfaces the reason once rather than reconnecting forever in silence.
      liveTail.deliverRefused("wrong hub password");
      expect(app.getState().liveRefusal).toEqual({ sessionId: "s1", message: "wrong hub password" });
      expect(display.lines.some((l) => l.includes("x wrong hub password"))).toBe(true);

      display.emit({ type: "doubleTap" }); // session -> home
      expect(app.getState().liveRefusal).toBe(null);
    });

    it("clamps a refusal message to the render-safe ceiling", async () => {
      const app = await enterSession();
      liveTail.deliverRefused("x".repeat(500));
      expect(app.getState().liveRefusal?.message.length).toBe(300);
    });

    it("ignores a refusal that arrives after leaving the session screen (onLiveRefused guard)", async () => {
      const app = await enterSession();
      display.emit({ type: "doubleTap" }); // session -> home
      expect(app.getState().screen).toBe("home");
      // A late refusal from the (now stale) s1 listener must not paint a sticky
      // line onto a screen that is no longer a session.
      liveTail.deliverRefusedVia(0, "wrong hub password");
      expect(app.getState().liveRefusal).toBe(null);
    });

    it("pins the visible window when scrolled up and new text lands, but auto-scrolls at the tail", async () => {
      const app = await enterSession();
      // Enough one-line entries to overflow the display so scrolling up moves
      // the offset above 0 and leaves a stable window of older lines.
      const entries = Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        role: "assistant",
        text: `line ${i}`,
      }));
      liveTail.deliver(entries);

      // Scroll up to read history and snapshot the top visible transcript line.
      display.emit({ type: "scrollUp" });
      const offsetUp = app.getState().session!.offset;
      expect(offsetUp).toBeGreaterThan(0);
      const model = () => display.model as { type: "session"; transcriptLines: string[] };
      const topBefore = model().transcriptLines[0];

      // A committed block lands underneath the scrolled-up view: the visible
      // window stays pinned to the same lines (offset absorbs the added lines)
      // and the fresh text is NOT yanked on screen.
      const block = "brand new block ".repeat(20); // ~320 chars -> several wrapped lines
      liveTail.deliver([...entries, { id: "mNew", role: "assistant", text: block }]);
      expect(model().transcriptLines[0]).toBe(topBefore);
      expect(app.getState().session!.offset).toBeGreaterThan(offsetUp);
      expect(display.lines.some((l) => l.includes("brand new block"))).toBe(false);

      // Back at the tail (offset 0), new text auto-scrolls in as before.
      for (let i = 0; i < 40; i++) display.emit({ type: "scrollDown" });
      expect(app.getState().session!.offset).toBe(0);
      liveTail.deliver([
        ...entries,
        { id: "mNew", role: "assistant", text: block },
        { id: "mNew2", role: "assistant", text: "newest line here" },
      ]);
      expect(display.lines.some((l) => l.includes("newest line here"))).toBe(true);
    });
  });

  // ---- phone companion App API (XERK-171) -----------------------------------
  // The native phone UI drives these in-process (setOrgFilter/enterSession) and
  // follows onEnterSession; no bridge, no postMessage.
  describe("phone companion App API", () => {
    function jiraAgent(key: string, siteKey: string, sessions: SessionInfo[]): AgentInfo {
      return agent({ key, device: key, jira: { siteKey }, sessions });
    }

    it("setOrgFilter scopes the home session list to one org", async () => {
      const client = fakeClient({
        listAgents: vi.fn(async () => ({
          now: Date.now(),
          agents: [
            jiraAgent("host-a", "acme.atlassian.net", [session({ id: "sa", summary: "alpha" })]),
            jiraAgent("host-b", "globex.atlassian.net", [session({ id: "sb", summary: "bravo" })]),
          ],
        })),
      });
      const app = makeApp(client);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      // Unfiltered: both hosts' sessions are on the home list.
      expect(display.lines.some((l) => l.includes("alpha"))).toBe(true);
      expect(display.lines.some((l) => l.includes("bravo"))).toBe(true);

      app.setOrgFilter("acme.atlassian.net");
      expect(display.lines.some((l) => l.includes("alpha"))).toBe(true);
      expect(display.lines.some((l) => l.includes("bravo"))).toBe(false);
      // The header counts only the scoped fleet too.
      expect(display.lines[0]).toBe("TURMA 1 run · 0 ask");

      // "" reopens every org.
      app.setOrgFilter("");
      expect(display.lines.some((l) => l.includes("bravo"))).toBe(true);
    });

    it("a session you are IN survives its org leaving the filter", async () => {
      const client = fakeClient({
        listAgents: vi.fn(async () => ({
          now: Date.now(),
          agents: [jiraAgent("host-b", "globex.atlassian.net", [session({ id: "sb" })])],
        })),
      });
      const app = makeApp(client);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      app.enterSession("sb");
      expect(app.getState().screen).toBe("session");
      // Filtering to a different org empties the LIST but doesn't eject the open
      // session (findSession reads the full agents list) — one-way scoping.
      app.setOrgFilter("acme.atlassian.net");
      expect(app.getState().screen).toBe("session");
      expect(app.currentSessionId()).toBe("sb");
    });

    it("enterSession enters the session and resolves its host by id", async () => {
      const client = fakeClient({
        listAgents: vi.fn(async () => ({
          now: Date.now(),
          agents: [agent({ key: "host-z", sessions: [session({ id: "s9" })] })],
        })),
      });
      const app = makeApp(client);
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      app.enterSession("s9");
      expect(app.getState().screen).toBe("session");
      expect(app.getState().session).toEqual(newSessionState("host-z", "s9"));
    });

    it("enterSession ignores an unknown id (no blank session screen)", async () => {
      const app = makeApp(fakeClient());
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      app.enterSession("nope");
      expect(app.getState().screen).toBe("home");
    });

    it("onEnterSession fires on a genuine enter — from a tap and from enterSession — but NOT on leave", async () => {
      const entered: string[] = [];
      const client = fakeClient({
        listAgents: vi.fn(async () => ({
          now: Date.now(),
          agents: [agent({ sessions: [session({ id: "s1", createdAt: "2026-01-03T00:00:00Z" }), session({ id: "s2", createdAt: "2026-01-02T00:00:00Z" })] })],
        })),
      });
      const app = new App({
        client: client as unknown as HubClient,
        display,
        dictation,
        now: () => Date.now(),
        pollMs: 6000,
        onEnterSession: (_h, id) => entered.push(id),
      });
      await app.start();
      await vi.advanceTimersByTimeAsync(0);

      // Enter via a home tap (cursor snapped to the first session row).
      display.emit({ type: "tap" });
      expect(app.getState().screen).toBe("session");
      expect(entered).toEqual(["s1"]);

      // Leave back to home — no signal on leaving.
      display.emit({ type: "doubleTap" });
      expect(app.getState().screen).toBe("home");
      expect(entered).toEqual(["s1"]);

      // Programmatic enter (the phone driving it) signals the switch.
      app.enterSession("s2");
      expect(entered).toEqual(["s1", "s2"]);

      // Re-entering the SAME session is a no-op — no duplicate signal, the guard
      // that breaks a phone<->glasses echo.
      app.enterSession("s2");
      expect(entered).toEqual(["s1", "s2"]);
    });
  });
});
