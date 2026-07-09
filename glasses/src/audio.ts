// AudioRecorder: streams G2 mic PCM to the hub's `/audio` STT WebSocket.
//
// Ported from ClaudeHUD's proven `plugin/src/audio.ts` pattern (WS-first,
// mic-second on start; mic-off-always on every teardown path), fitted to
// this package's hub protocol (`agent-hub/server.js`'s `/audio` handler):
// connect `ws(s)://<hub>/audio?auth=<token>`, stream raw 16kHz s16le mono
// PCM as binary frames, send a `{"type":"finalize"}` text frame to trigger
// transcription, receive one `{"type":"audio_result",...}` text frame, then
// the server closes.
//
// Injectable everywhere: the bridge-ish object (audioControl + an audio-frame
// subscription — see `display/evenhub.ts`'s `onAudioFrame`, which fans out
// the *existing* single `onEvenHubEvent` subscription rather than opening a
// second one), the WebSocket constructor, and the clock. Nothing here
// imports `@evenrealities/even_hub_sdk` — a fake bridge and a fake
// WebSocketCtor are all vitest needs.
//
// Mic teardown discipline (the whole point of this port — a stuck mic is the
// worst failure mode on hardware): `audioControl(false)` fires on every one
// of: stopAndFinalize(), cancel(), an unexpected WS 'error', an unexpected
// WS 'close', and audioControl(true) itself rejecting. It's idempotent (a
// `micOn` flag guards it) so these paths can freely overlap without double
// hardware calls.

export interface AudioTranscript {
  text: string;
  language?: string;
  unavailable?: boolean;
  reason?: string;
}

export interface AudioResultMessage {
  type: "audio_result";
  transcript: AudioTranscript;
  durationMs?: number;
  bytes?: number;
  capped?: boolean;
}

export type WebSocketEventName = "open" | "message" | "close" | "error";

export type WebSocketEvent = {
  data?: string | ArrayBuffer | Uint8Array;
  message?: string;
};

// Structural WebSocket contract — the browser `WebSocket`, Node's built-in
// `WebSocket` (Node >=22), and any test fake all satisfy this with no cast.
export interface WebSocketLike {
  readyState: number;
  send(data: ArrayBufferView | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: WebSocketEventName, cb: (ev: WebSocketEvent) => void): void;
  removeEventListener(event: WebSocketEventName, cb: (ev: WebSocketEvent) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

// The bridge-ish dependency AudioRecorder needs: mic on/off, plus a way to
// receive PCM frames without opening a second `onEvenHubEvent` subscription.
// `EvenHubDisplay.onAudioFrame` satisfies this structurally; main.ts adapts
// the real bridge's `audioControl` alongside it.
export interface AudioBridge {
  audioControl(on: boolean): Promise<unknown>;
  onAudioFrame(cb: (pcm: Uint8Array) => void): () => void;
}

export interface AudioRecorderOptions {
  bridge: AudioBridge;
  /** Override the WebSocket constructor (tests). Defaults to globalThis.WebSocket. */
  WebSocket?: WebSocketCtor;
  /** Override the clock (tests). Defaults to Date.now. */
  now?: () => number;
}

// Public shape both the real recorder and test fakes implement — lets
// `HubAudioDictation` (dictation.ts) be tested without a real WebSocketCtor.
export interface AudioRecorderLike {
  start(url: string): Promise<void>;
  stopAndFinalize(): Promise<AudioResultMessage>;
  cancel(): Promise<void>;
}

const FINALIZE_TIMEOUT_MS = 15_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unavailableResult(reason: string): AudioResultMessage {
  return { type: "audio_result", transcript: { text: "", unavailable: true, reason } };
}

export class AudioRecorder implements AudioRecorderLike {
  private readonly bridge: AudioBridge;
  private readonly wsCtor: WebSocketCtor | undefined;
  private readonly now: () => number;

  private ws: WebSocketLike | null = null;
  private micOn = false;
  private recording = false;
  private startedAt: number | null = null;
  private unsubscribeFramesFn: (() => void) | null = null;

  constructor(opts: AudioRecorderOptions) {
    this.bridge = opts.bridge;
    this.wsCtor =
      opts.WebSocket ?? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket as WebSocketCtor | undefined);
    this.now = opts.now ?? (() => Date.now());
  }

  isRecording(): boolean {
    return this.recording;
  }

  // Permanent safety-net listener, attached to every WS this recorder opens
  // for its whole lifetime: if the socket drops on its own (not because we
  // asked it to, via stopAndFinalize/cancel), the mic still gets turned off.
  // `teardownMic`/`unsubscribeFrames` are idempotent, so this coexists safely
  // with the explicit teardown stopAndFinalize()/cancel() also perform.
  private readonly handleUnexpectedEnd = (): void => {
    this.recording = false;
    this.unsubscribeFrames();
    void this.teardownMic();
  };

  /**
   * Open the WS FIRST; once it's open, turn the mic on. If the mic fails to
   * turn on, the WS is closed and this rejects — never leaves a WS dangling
   * with no audio arriving. PCM frames start flowing to the socket only
   * after both steps succeed.
   */
  async start(url: string): Promise<void> {
    const Ctor = this.wsCtor;
    if (!Ctor) {
      throw new Error("WebSocket constructor not available");
    }

    const ws = new Ctor(url);
    this.ws = ws;
    ws.addEventListener("close", this.handleUnexpectedEnd);
    ws.addEventListener("error", this.handleUnexpectedEnd);

    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          cleanup();
          resolve();
        };
        const onError = (ev: WebSocketEvent): void => {
          cleanup();
          reject(new Error(ev.message ?? "WS error"));
        };
        const cleanup = (): void => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
        };
        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
      });
    } catch (err) {
      this.detachPermanentListeners(ws);
      this.ws = null;
      throw err;
    }

    // Mic on *after* the WS handshake — if this fails we close cleanly
    // without ever having sent a byte of audio to a broker-side session
    // that would otherwise finalize on empty/orphaned input.
    try {
      await this.bridge.audioControl(true);
    } catch (err) {
      this.detachPermanentListeners(ws);
      try {
        ws.close();
      } catch {
        // ignore — peer may have already dropped
      }
      this.ws = null;
      throw new Error(`audioControl(true) failed: ${errorMessage(err)}`);
    }

    this.micOn = true;
    this.recording = true;
    this.startedAt = this.now();
    this.unsubscribeFramesFn = this.bridge.onAudioFrame((pcm) => this.sendFrame(pcm));
  }

  /**
   * Mic off (always), then send the finalize control frame and wait for the
   * server's `audio_result`. Never rejects — connection drops, send
   * failures, and the 15s timeout all resolve to an `unavailable` result so
   * callers (HubAudioDictation) have one code path to map to a
   * `DictationResult`.
   */
  async stopAndFinalize(): Promise<AudioResultMessage> {
    await this.teardownMic();
    this.unsubscribeFrames();
    this.recording = false;

    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      return unavailableResult("not recording");
    }
    this.detachPermanentListeners(ws);

    return new Promise<AudioResultMessage>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(unavailableResult("timed out waiting for transcription"));
      }, FINALIZE_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onCloseOrError);
        ws.removeEventListener("error", onCloseOrError);
      };
      const finish = (result: AudioResultMessage): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          // ignore — already closed
        }
        resolve(this.withDuration(result));
      };
      const onMessage = (ev: WebSocketEvent): void => {
        if (typeof ev.data !== "string") return;
        let parsed: AudioResultMessage;
        try {
          parsed = JSON.parse(ev.data) as AudioResultMessage;
        } catch {
          return;
        }
        if (parsed?.type !== "audio_result") return;
        finish(parsed);
      };
      const onCloseOrError = (): void => finish(unavailableResult("connection closed before result"));

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onCloseOrError);
      ws.addEventListener("error", onCloseOrError);

      if (ws.readyState === WS_OPEN) {
        try {
          ws.send(JSON.stringify({ type: "finalize" }));
        } catch (err) {
          finish(unavailableResult(`finalize send failed: ${errorMessage(err)}`));
        }
      } else {
        finish(unavailableResult("socket not open"));
      }
    });
  }

  /** Mic off (always), close the WS with no finalize frame — the server discards whatever it buffered. No result. */
  async cancel(): Promise<void> {
    await this.teardownMic();
    this.unsubscribeFrames();
    this.recording = false;

    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    this.detachPermanentListeners(ws);
    try {
      ws.close();
    } catch {
      // ignore — already closed
    }
  }

  private sendFrame(pcm: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(pcm);
    } catch {
      // best-effort — a dropped frame isn't fatal; the next one may land
    }
  }

  private withDuration(result: AudioResultMessage): AudioResultMessage {
    if (result.durationMs != null || this.startedAt == null) return result;
    return { ...result, durationMs: Math.max(0, this.now() - this.startedAt) };
  }

  private unsubscribeFrames(): void {
    if (!this.unsubscribeFramesFn) return;
    try {
      this.unsubscribeFramesFn();
    } catch {
      // ignore
    }
    this.unsubscribeFramesFn = null;
  }

  private detachPermanentListeners(ws: WebSocketLike): void {
    ws.removeEventListener("close", this.handleUnexpectedEnd);
    ws.removeEventListener("error", this.handleUnexpectedEnd);
  }

  // Idempotent — guarded by `micOn` so every teardown path can call this
  // freely without double-firing the hardware call.
  private async teardownMic(): Promise<void> {
    if (!this.micOn) return;
    this.micOn = false;
    try {
      await this.bridge.audioControl(false);
    } catch {
      // best-effort: nothing more we can do if the hardware call itself fails on teardown
    }
  }
}
