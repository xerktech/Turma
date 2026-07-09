// Hardware-agnostic dictation. Task 7 implements the real G2-mic backend
// (capture -> the hub's /audio STT WebSocket); this app only ever depends on
// this interface, plus the dev PromptDictation implementation below.
import type { AudioRecorderLike } from "./audio.ts";
import type { HubClient } from "./hub-client.ts";

export interface DictationResult {
  text: string;
  unavailable?: boolean;
  reason?: string;
  durationMs?: number;
}

export interface Dictation {
  start(onResult: (r: DictationResult) => void): void;
  stop(): void;
  cancel(): void;
}

// Dev implementation backed by window.prompt — good enough to drive the
// reply screen's listening -> preview flow without a microphone. `stop()`
// (tap = done) and `cancel()` (double-tap) are no-ops here because
// window.prompt is synchronous and already resolved by the time start()
// returns; a real backend's stop/cancel matter because capture is async.
export class PromptDictation implements Dictation {
  start(onResult: (r: DictationResult) => void): void {
    const text = window.prompt("Dictate (dev stand-in for G2 mic):", "");
    if (text == null) {
      onResult({ text: "", unavailable: true, reason: "cancelled" });
      return;
    }
    onResult({ text });
  }

  stop(): void {
    // no-op: window.prompt already resolved synchronously in start()
  }

  cancel(): void {
    // no-op: window.prompt already resolved synchronously in start()
  }
}

// Builds the `/audio` WS URL for a given hub base URL + short-lived ws-token:
// `https://` -> `wss://`, `http://` -> `ws://`, path `/audio?auth=<token>`.
// Exported directly so URL derivation is unit-testable without a fake
// recorder/WebSocket in the loop.
export function buildAudioWsUrl(hubUrl: string, token: string): string {
  const wsBase = hubUrl.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://").replace(/\/$/, "");
  return `${wsBase}/audio?auth=${encodeURIComponent(token)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface HubAudioDictationOptions {
  hubClient: Pick<HubClient, "wsToken">;
  recorder: AudioRecorderLike;
  hubUrl: string;
}

// Real G2-mic backend: capture -> the hub's /audio STT WebSocket. Owns no
// hardware itself — `recorder` (audio.ts's `AudioRecorder`, or a fake in
// tests) does the WS + mic work; this class is purely the hub-token/URL/
// result-mapping glue between it and the `Dictation` interface the App
// consumes.
//
// Dictation-cancel ownership: `cancel()` here is the *mechanism* (turns the
// mic off and tears down the WS via `recorder.cancel()`); *deciding when* to
// cancel because the app is backgrounding/exiting lives one layer up, in
// App.pause() (see app.ts) — the single place that already knows whether a
// dictation is active (the reply screen's "listening" phase) and is already
// the sole caller of `dictation.start/stop/cancel` for user-driven flows.
// Lifecycle.ts's onForegroundExit/onAbnormalOrSystemExit both funnel through
// App.pause(), so there is exactly one call site that ever decides to cancel
// a dictation for a lifecycle reason.
export class HubAudioDictation implements Dictation {
  private readonly hubClient: Pick<HubClient, "wsToken">;
  private readonly recorder: AudioRecorderLike;
  private readonly hubUrl: string;
  private onResultCb: ((r: DictationResult) => void) | null = null;
  // Guards against delivering a result twice (e.g. a connect failure racing
  // a user-initiated cancel) and against stop() delivering after cancel()
  // already claimed "no result, ever".
  private delivered = false;

  constructor(opts: HubAudioDictationOptions) {
    this.hubClient = opts.hubClient;
    this.recorder = opts.recorder;
    this.hubUrl = opts.hubUrl;
  }

  start(onResult: (r: DictationResult) => void): void {
    this.onResultCb = onResult;
    this.delivered = false;
    void this.connect();
  }

  private async connect(): Promise<void> {
    let token: string;
    try {
      const res = await this.hubClient.wsToken();
      token = res.token;
    } catch (err) {
      this.deliverUnavailable(`ws token fetch failed: ${errorMessage(err)}`);
      return;
    }
    const url = buildAudioWsUrl(this.hubUrl, token);
    try {
      await this.recorder.start(url);
    } catch (err) {
      this.deliverUnavailable(`mic/connect failed: ${errorMessage(err)}`);
    }
  }

  private deliverUnavailable(reason: string): void {
    if (this.delivered) return;
    this.delivered = true;
    this.onResultCb?.({ text: "", unavailable: true, reason });
  }

  stop(): void {
    void this.finish();
  }

  private async finish(): Promise<void> {
    const result = await this.recorder.stopAndFinalize();
    if (this.delivered) return;
    this.delivered = true;
    const t = result.transcript;
    this.onResultCb?.({
      text: t?.text ?? "",
      unavailable: t?.unavailable,
      reason: t?.reason,
      durationMs: result.durationMs,
    });
  }

  cancel(): void {
    // Mark delivered synchronously so a connect failure that's still
    // in-flight (see `connect()`) can never deliver a late "unavailable"
    // result after the caller has already moved on — cancel() never
    // delivers a result, full stop.
    this.delivered = true;
    void this.recorder.cancel();
  }
}
