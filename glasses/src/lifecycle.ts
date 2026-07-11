// Background/foreground lifecycle glue for the Even Hub bridge backend.
//
// Two independent pieces, ported from ClaudeHUD's `plugin/src/state.ts` and
// `plugin/src/main.ts` (§4/§5 of its CLAUDE.md, the background-state and
// handle-input skills):
//
//  1. A tiny background-state registry. The SDK (0.0.10) doesn't ship
//     `setBackgroundState`/`onBackgroundRestore` helpers — the host instead
//     calls `window.__getStateSnapshot()` right before backgrounding and
//     `window.__restoreState(json)` on a (possibly brand-new, headless)
//     WebView afterwards. This registry is that missing plumbing: register
//     an exporter/restorer pair per state group, plain-JSON only.
//  2. Glue between the router's `LifecycleEvent`s and the hardware-agnostic
//     `App`: foreground-exit pauses + snapshots UI state (screen + selected
//     session id); foreground-enter/restore resumes (which polls
//     immediately); abnormal/system exit pauses and tears the display down.
import { newSessionState, type App, type AppState } from "./app.ts";

type Exporter = () => unknown;
type Restorer = (saved: unknown) => void;

type SnapshotHost = {
  __getStateSnapshot?: () => string;
  __restoreState?: (snapshot: string) => void;
};

const exporters = new Map<string, Exporter>();
const restorers = new Map<string, Restorer>();
const pendingRestore = new Map<string, unknown>();
let installed = false;

function getHost(): SnapshotHost {
  return globalThis as unknown as SnapshotHost;
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const host = getHost();
  host.__getStateSnapshot = (): string => {
    const out: Record<string, unknown> = {};
    for (const [key, exporter] of exporters) {
      try {
        out[key] = exporter();
      } catch (err) {
        console.warn("[lifecycle] exporter threw for key:", key, err);
      }
    }
    return JSON.stringify(out);
  };
  host.__restoreState = (snapshot: string): void => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(snapshot) as Record<string, unknown>;
    } catch (err) {
      console.warn("[lifecycle] __restoreState received invalid JSON:", err);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, value] of Object.entries(parsed)) {
      const restorer = restorers.get(key);
      if (restorer) {
        try {
          restorer(value);
        } catch (err) {
          console.warn("[lifecycle] restorer threw for key:", key, err);
        }
      } else {
        // Restorer not registered yet — replay when it lands.
        pendingRestore.set(key, value);
      }
    }
  };
}

// Registers a state exporter. The exporter MUST return a plain
// JSON-serialisable value and SHOULD return a fresh copy (capturing a live
// reference races with mutations between snapshot and the post-snapshot
// pause).
export function setBackgroundState(key: string, exporter: Exporter): void {
  exporters.set(key, exporter);
  ensureInstalled();
}

// Registers a state restorer. If `__restoreState` arrived before this
// restorer registered, the pending value is replayed synchronously here.
export function onBackgroundRestore(key: string, restorer: Restorer): void {
  restorers.set(key, restorer);
  ensureInstalled();
  if (pendingRestore.has(key)) {
    const value = pendingRestore.get(key);
    pendingRestore.delete(key);
    try {
      restorer(value);
    } catch (err) {
      console.warn("[lifecycle] restorer threw for key:", key, err);
    }
  }
}

// Test-only: drops all registered exporters/restorers and uninstalls the
// host hooks. Production code never tears this registry down.
export function resetLifecycleForTests(): void {
  exporters.clear();
  restorers.clear();
  pendingRestore.clear();
  installed = false;
  const host = getHost();
  delete host.__getStateSnapshot;
  delete host.__restoreState;
}

// ---- App-facing glue ------------------------------------------------------

// Only these three screens are worth resurrecting after a background →
// foreground WebView migration. Transient screens (actions/confirm/
// reply/newHost/newRepo/newPrompt) carry sub-state (cursors, dictation
// phases, half-built spawn targets) that would restore as null and render a
// degraded header-only fallback — so the snapshot records their *parent*
// instead: the session they were operating on when they have one, else home.
export type PersistedScreen = "home" | "session" | "settings";

export interface AppSnapshot {
  screen: PersistedScreen;
  hostKey: string | null;
  sessionId: string | null;
}

export const BACKGROUND_STATE_KEY = "turma.glasses.app";

// Pure: AppState -> what the background snapshot should record. Exported for
// direct unit testing of every screen's mapping.
export function snapshotFromState(state: AppState): AppSnapshot {
  const home: AppSnapshot = { screen: "home", hostKey: null, sessionId: null };
  const sessionSnap = (hostKey: string | undefined, sessionId: string | undefined): AppSnapshot =>
    hostKey && sessionId ? { screen: "session", hostKey, sessionId } : home;

  switch (state.screen) {
    case "home":
      return home;
    case "settings":
      return { screen: "settings", hostKey: null, sessionId: null };
    case "session":
      return sessionSnap(state.session?.hostKey, state.session?.sessionId);
    // Transient session-scoped screens → their parent session view.
    case "actions":
      return sessionSnap(state.actions?.hostKey, state.actions?.sessionId);
    case "confirm":
      return sessionSnap(state.confirm?.action.hostKey, state.confirm?.action.sessionId);
    case "reply": {
      const target = state.reply?.target;
      if (target?.kind === "session") return sessionSnap(target.hostKey, target.sessionId);
      return home; // spawn-target reply (or no reply state) → home
    }
    // Transient spawn-flow screens → home.
    case "newHost":
    case "newRepo":
    case "newPrompt":
      return home;
  }
}

// Registers the App's exporter/restorer pair. Call once, right after
// constructing the App and BEFORE `app.start()` — so a foreground migration
// that races the boot sequence still finds both handlers installed (mirrors
// ClaudeHUD's "register before onEvenHubEvent" rule; app.start() is what
// subscribes the display's onEvenHubEvent listener). Both the exporter and
// the restorer are safe to fire before start(): they only read/patch
// AppState, which exists from construction.
export function installLifecycle(app: App): void {
  setBackgroundState(BACKGROUND_STATE_KEY, (): AppSnapshot => snapshotFromState(app.getState()));
  onBackgroundRestore(BACKGROUND_STATE_KEY, (saved) => {
    const s = (saved ?? {}) as Partial<AppSnapshot>;
    if (typeof s.hostKey === "string" && typeof s.sessionId === "string") {
      app.restoreScreen("session", newSessionState(s.hostKey, s.sessionId));
      return;
    }
    // Only home/settings are restorable without session context; anything
    // else in a (stale/foreign) snapshot degrades safely to home.
    app.restoreScreen(s.screen === "settings" ? "settings" : "home", null);
  });
}

// FOREGROUND_EXIT_EVENT (5): handle-input skill — flush pending state, pause
// timers. The background-state snapshot itself is pulled by the host calling
// `__getStateSnapshot()`; this just pauses the poll loop.
export function onForegroundExit(app: App): void {
  app.pause();
}

// FOREGROUND_ENTER_EVENT (4): handle-input skill — re-render current state,
// resume timers. `app.resume()` schedules an immediate poll.
export function onForegroundEnter(app: App): void {
  app.resume();
}

// ABNORMAL_EXIT_EVENT (6) / SYSTEM_EXIT_EVENT (7): handle-input skill — stop
// hardware, unsubscribe, flush state. Pauses the app and tears the display's
// event subscription down; `display` only needs a `teardown()` method
// (EvenHubDisplay has one — not part of the GlassesDisplay interface since
// the DOM dev backend never needs it).
export function onAbnormalOrSystemExit(app: App, display: { teardown?(): void }): void {
  // Hard pause: also cancels any post-mutation grace poll, so no fetch/repaint
  // can fire against the display we're about to tear down.
  app.pause({ hard: true });
  display.teardown?.();
}
