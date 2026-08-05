/**
 * Background JSContext entry — Turma miniapp (Foverlay port of the Turma
 * Even G2 glasses app, XERK-211).
 *
 * Plays the role of upstream's main.ts boot: load the persisted config,
 * and — once the device is signed in — wire the hardware-agnostic App
 * (core/app.ts, ported verbatim) to the Mentra backends:
 *
 *   GlassesDisplay  -> display/mentra.ts   (session.display.render scenes)
 *   Dictation       -> audio/dictation.ts + audio/audio.ts (unchanged) over
 *                      audio/mic-bridge.ts (session.mic) + the polyfill's
 *                      binary-capable WebSocket to the hub's /audio socket
 *   KeyValueStorage -> background/storage.ts (session.storage)
 *   LiveTail        -> core/live.ts (unchanged) over the polyfill WebSocket
 *   HubClient       -> core/hub-client.ts with the background's fetch
 *                      (no CORS in the JSContext)
 *
 * The phone companion runs in the miniapp's WebView and talks to this
 * context over the typed channel bus (shared/channels.ts): state/enter/rich-
 * tail observers out, commands + proxied fetch + config storage RPCs in.
 */

import { registerMiniapp, type TypedMiniappSession } from "@mentra/miniapp/background";

import { App } from "../core/app.ts";
import { DEFAULT_POLL_MS, isConfigured, loadConfig, type Config } from "../core/config.ts";
import { HubClient } from "../core/hub-client.ts";
import { LiveTail } from "../core/live.ts";
import { setDefaultMeasure } from "../core/text-wrap.ts";
import { AudioRecorder } from "../audio/audio.ts";
import { HubAudioDictation } from "../audio/dictation.ts";
import { MentraMicBridge } from "../audio/mic-bridge.ts";
import { MentraDisplay } from "../display/mentra.ts";
import { createG2Measure } from "../display/measure.ts";
import type { BackgroundPhase, Channels } from "../shared/channels.ts";
import { serializePhoneState } from "../shared/phone-state.ts";
import { MentraStorage } from "./storage.ts";

type Session = TypedMiniappSession<Channels>;

// All wrapText/measureDefault calls use real G2 font metrics from the first
// render on — module scope so it runs before any App is constructed.
setDefaultMeasure(createG2Measure());

class TurmaBackground {
  private readonly session: Session;
  private readonly storage: MentraStorage;

  private app: App | null = null;
  private display: MentraDisplay | null = null;
  // Serialized against overlapping config-changed RPCs / the initial start.
  private transition: Promise<void> = Promise.resolve();

  constructor(session: Session) {
    this.session = session;
    this.storage = new MentraStorage(session);
    this.registerUiHandlers();
    this.registerLifecycle();
  }

  start(): void {
    this.enqueue(() => this.applyConfig());
  }

  private phase(): BackgroundPhase {
    return this.app ? "running" : "setup";
  }

  // Run config transitions one at a time so a sign-out racing a sign-in can
  // never interleave a half-started App with a half-stopped one.
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(fn, fn);
    return this.transition;
  }

  // Load the stored config and converge the running state on it: start the
  // App when signed in, tear it down (back to the setup screen) when not.
  private async applyConfig(): Promise<void> {
    const config = await loadConfig(this.storage);
    // Always rebuild on a config change: the hub URL or credentials may have
    // changed, and every collaborator (HubClient/LiveTail/Dictation) captured
    // the old config at construction.
    this.stopApp();
    if (!isConfigured(config)) {
      await this.renderSetupScreen();
      this.session.ui.send("turma:phase", { phase: "setup" });
      return;
    }
    await this.startApp(config);
    this.session.ui.send("turma:phase", { phase: "running" });
  }

  private async startApp(config: Config): Promise<void> {
    const client = new HubClient({ config, fetchFn: globalThis.fetch.bind(globalThis) });
    const liveTail = new LiveTail({ hubClient: client, hubUrl: config.hubUrl });
    const dictation = new HubAudioDictation({
      hubClient: client,
      hubUrl: config.hubUrl,
      recorder: new AudioRecorder({ bridge: new MentraMicBridge(this.session) }),
    });
    const display = new MentraDisplay(this.session);
    const app = new App({
      client,
      display,
      dictation,
      liveTail,
      pollMs: config.pollMs ?? DEFAULT_POLL_MS,
      onState: (state) => this.session.ui.send("turma:state", serializePhoneState(state)),
      onEnterSession: (hostKey, sessionId) => this.session.ui.send("turma:enter-session", { hostKey, sessionId }),
      onRichTail: (sessionId, entries) => this.session.ui.send("turma:rich-tail", { sessionId, entries }),
    });
    this.display = display;
    this.app = app;
    // Start with the session's current visibility: if the miniapp was
    // launched backgrounded, don't leave the poll loop running.
    await app.start();
    if (this.session.visibility === "background") app.pause();
  }

  // Upstream reloaded the whole page on sign-out; the App has no stop().
  // pause({hard:true}) is the sanctioned full-stop (cancels dictation, the
  // poll loop, live tail, reveal + history timers), and disposing the
  // display unsubscribes its input stream — after which dropping the
  // references retires the instance completely.
  private stopApp(): void {
    if (this.app) {
      try {
        this.app.pause({ hard: true });
      } catch (err) {
        console.error("[turma] app.pause on teardown failed:", err);
      }
    }
    this.display?.dispose();
    this.app = null;
    this.display = null;
  }

  private async renderSetupScreen(): Promise<void> {
    try {
      await this.session.display.render([
        {
          type: "text",
          id: "main",
          box: { x: 0, y: 0, w: 576, h: 288 },
          text: "TURMA\n\nSet up on your phone:\nopen the Turma miniapp\nand sign in to your hub.",
        },
      ]);
    } catch (err) {
      console.error("[turma] setup-screen render failed:", err);
    }
  }

  // ---- phone WebView bus ---------------------------------------------------

  private registerUiHandlers(): void {
    const ui = this.session.ui;

    // Proxied hub fetch: the WebView runs from file:// where cross-origin
    // fetch is CORS-fragile; the JSContext's fetch has no CORS. The UI's
    // HubClient builds its own auth headers — this proxy is transport only.
    ui.handle("turma:fetch", async (req) => {
      const res = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body,
      });
      const bodyText = await res.text();
      return { status: res.status, ok: res.ok, bodyText };
    });

    ui.handle("turma:storage-get", async ({ key }) => ({ value: await this.storage.get(key) }));
    ui.handle("turma:storage-set", async ({ key, value }) => {
      await this.storage.set(key, value);
      return { ok: true as const };
    });

    ui.handle("turma:config-changed", async () => {
      await this.enqueue(() => this.applyConfig());
      return { phase: this.phase() };
    });

    ui.handle("turma:cmd", (cmd) => {
      const app = this.app;
      if (!app) return { ok: false };
      switch (cmd.kind) {
        case "enterSession":
          app.enterSession(cmd.sessionId, cmd.hostKey);
          break;
        case "setOrgFilter":
          app.setOrgFilter(cmd.siteKey);
          break;
        case "setAutoStartOrg":
          app.setAutoStartOrg(cmd.siteKey, cmd.enabled);
          break;
      }
      return { ok: true };
    });

    ui.handle("turma:get-state", () => ({
      phase: this.phase(),
      state: this.app ? serializePhoneState(this.app.getState()) : null,
    }));

    // A freshly opened WebView gets a snapshot without asking (it also pulls
    // one via turma:get-state on bootstrap — idempotent either way).
    ui.onOpen(() => {
      this.session.ui.send("turma:phase", { phase: this.phase() });
      if (this.app) this.session.ui.send("turma:state", serializePhoneState(this.app.getState()));
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  private registerLifecycle(): void {
    // Foreground/background visibility maps to App.pause()/resume() — the
    // same glue upstream's lifecycle.ts provided over Even Hub events. A
    // plain background keeps the post-mutation grace window alive (soft
    // pause); disconnect is a hard stop, so no poll can fire against a
    // display that's being torn down.
    this.session.on("visibility", (v) => {
      const app = this.app;
      if (!app) return;
      if (v === "foreground") app.resume();
      else app.pause();
    });
    this.session.on("beforeDisconnect", () => {
      this.app?.pause({ hard: true });
    });
    this.session.on("disconnect", () => {
      this.app?.pause({ hard: true });
    });
  }
}

registerMiniapp<Channels>((session) => {
  new TurmaBackground(session).start();
});
