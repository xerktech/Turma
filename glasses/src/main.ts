// Bootstrap only — kept thin per the brief; lifecycle glue lives in
// lifecycle.ts, the real display backend in display/evenhub.ts.
//
// Races `waitForEvenAppBridge()` against a short timeout to decide which
// hardware backend to wire up:
//   - Bridge resolves (packaged app inside the Even Realities WebView) ->
//     the real Even Hub SDK path: EvenHubDisplay + BridgeStorage + the
//     pretext-based text measure + lifecycle wiring.
//   - Timeout (plain browser / `npm run dev`) -> the existing DOM dev path,
//     unchanged from Task 5.
//
// The SDK is only ever touched via a single dynamic `import()` right here —
// every other file in this package (display/evenhub.ts, storage.ts,
// input/router.ts) is typed structurally against the SDK's shapes instead of
// importing it, so the browser/dev build never needs to load or evaluate
// `@evenrealities/even_hub_sdk` at all unless this import actually runs.
import { App } from "./app.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { DomDisplay } from "./display/dom.ts";
import type { GlassesDisplay } from "./display/index.ts";
import { HubAudioDictation, PromptDictation } from "./dictation.ts";
import type { Dictation } from "./dictation.ts";
import { HubClient } from "./hub-client.ts";
import { LiveTail } from "./live.ts";
import { BridgeStorage, BrowserStorage, type KeyValueStorage } from "./storage.ts";
import { initPhoneLogin } from "./phone-login.ts";
import { pretextMeasure, setDefaultMeasure } from "./text-wrap.ts";
import { installLifecycle, onAbnormalOrSystemExit, onForegroundEnter, onForegroundExit } from "./lifecycle.ts";

const BRIDGE_TIMEOUT_MS = 2000;

function importSdk() {
  return import("@evenrealities/even_hub_sdk");
}

// A structural stand-in for the awaited `waitForEvenAppBridge()` result —
// deliberately untyped against the SDK (see file header): every consumer
// (EvenHubDisplay, BridgeStorage, the input router) declares its own minimal
// structural interface instead, and the real bridge satisfies all of them.
type ResolvedBridge = Awaited<ReturnType<Awaited<ReturnType<typeof importSdk>>["waitForEvenAppBridge"]>>;

// Races bridge resolution against a timeout so a plain browser (no Even
// Realities WebView host) never hangs waiting for a bridge that will never
// arrive. Any import/resolution failure is treated the same as a timeout.
async function resolveBridge(): Promise<ResolvedBridge | null> {
  try {
    const mod = await importSdk();
    const bridgePromise = mod.waitForEvenAppBridge();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS));
    return await Promise.race([bridgePromise, timeout]);
  } catch (err) {
    console.warn("[glasses] Even Hub SDK unavailable, falling back to the DOM dev backend:", err);
    return null;
  }
}

async function main(): Promise<void> {
  const bridge = await resolveBridge();
  if (bridge) {
    await mainBridge(bridge);
  } else {
    await mainDom();
  }
}

async function mainDom(): Promise<void> {
  // Dev/browser path: the signed-in view shows the green-text glasses mirror
  // (#glasses-display) rather than the embedded dashboard iframe.
  document.body.classList.add("backend-dom");
  const storage = new BrowserStorage();
  await boot(storage, new DomDisplay(), () => new PromptDictation());
}

async function mainBridge(bridge: ResolvedBridge): Promise<void> {
  // Device path: the glasses render via the SDK, and the phone's signed-in
  // view embeds the real hub dashboard (#dashboard iframe).
  document.body.classList.add("backend-bridge");
  // These three are independent (two lazy bridge-path-only module imports —
  // audio.ts is Task 7's real G2-mic dictation, both structural-only like
  // display/evenhub.ts — plus resolving the pretext font measure), so run
  // their round-trips concurrently rather than one after another on the cold
  // boot path. `setDefaultMeasure` still runs before boot()/app.start(), so
  // the first render always wraps with the real metric.
  const [{ EvenHubDisplay }, { AudioRecorder }, measure] = await Promise.all([
    import("./display/evenhub.ts"),
    import("./audio.ts"),
    pretextMeasure(),
  ]);
  setDefaultMeasure(measure);
  const storage: KeyValueStorage = new BridgeStorage(bridge);

  const display = new EvenHubDisplay(bridge);
  // Lifecycle handlers MUST be registered before app.start() — start() is
  // what subscribes the display's onEvenHubEvent listener, and the host may
  // call __getStateSnapshot/__restoreState (or deliver FOREGROUND_EXIT) as
  // soon as events go live. Registering afterwards would silently drop
  // anything that fires during the boot window (the "register before
  // onEvenHubEvent" rule) — hence the beforeStart hook.
  await boot(
    storage,
    display,
    (client, config) =>
      new HubAudioDictation({
        hubClient: client,
        hubUrl: config.hubUrl,
        // Mic PCM frames ride the display's single `onEvenHubEvent`
        // subscription (see display/evenhub.ts's `onAudioFrame` / input/
        // router.ts's `onAudioFrame` fan-out) rather than a second one;
        // `audioControl` itself is a plain hardware call straight from the
        // real bridge.
        recorder: new AudioRecorder({
          bridge: {
            audioControl: (on) => bridge.audioControl(on),
            onAudioFrame: (cb) => display.onAudioFrame(cb),
          },
        }),
      }),
    (app) => {
      installLifecycle(app);
      display.onLifecycle((e) => {
        switch (e.phase) {
          case "foreground-exit":
            onForegroundExit(app);
            return;
          case "foreground-enter":
            onForegroundEnter(app);
            return;
          case "abnormal-exit":
          case "system-exit":
            onAbnormalOrSystemExit(app, display);
            return;
        }
      });
    }
  );
}

// Shared wiring for both backends: load config, start the phone-side
// login page, build the HubClient + App, and start the app.
// `makeDictation` picks the backend-appropriate `Dictation` (PromptDictation
// for the DOM dev path, HubAudioDictation for the bridge path) once the
// HubClient + Config it may need both exist. `beforeStart` runs after the
// App exists but before app.start() subscribes the display's event stream —
// the bridge path hangs its lifecycle registration there (see mainBridge).
async function boot(
  storage: KeyValueStorage,
  display: GlassesDisplay,
  makeDictation: (client: HubClient, config: Config) => Dictation,
  beforeStart?: (app: App) => void
): Promise<App> {
  const config = await loadConfig(storage);
  void initPhoneLogin(storage);

  const client = new HubClient({ config });
  const dictation = makeDictation(client, config);
  // Near-real-time transcript stream for the session screen. Uses the same
  // short-lived ws-token + wss/ws derivation as dictation's /audio socket, and
  // the browser's built-in WebSocket on both backends; if it can't connect
  // (agent tunnel offline, dev mock hub with no /live route) the app falls back
  // to the poll unchanged.
  const liveTail = new LiveTail({ hubClient: client, hubUrl: config.hubUrl });
  const app = new App({ client, display, dictation, liveTail, pollMs: config.pollMs });

  beforeStart?.(app);
  await app.start();
  return app;
}

void main();
