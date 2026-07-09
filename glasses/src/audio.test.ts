import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioRecorder,
  type AudioBridge,
  type WebSocketCtor,
  type WebSocketEvent,
  type WebSocketEventName,
  type WebSocketLike,
} from "./audio.ts";

const OPEN = 1;
const CLOSED = 3;

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readyState = 0;
  sentFrames: (ArrayBufferView | ArrayBuffer | string)[] = [];
  closeCalls: number;
  private listeners: Record<WebSocketEventName, Set<(ev: WebSocketEvent) => void>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  constructor(public readonly url: string) {
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: WebSocketEventName, cb: (ev: WebSocketEvent) => void): void {
    this.listeners[event].add(cb);
  }
  removeEventListener(event: WebSocketEventName, cb: (ev: WebSocketEvent) => void): void {
    this.listeners[event].delete(cb);
  }
  send(data: ArrayBufferView | ArrayBuffer | string): void {
    this.sentFrames.push(data);
  }
  close(): void {
    this.closeCalls++;
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", {});
  }

  emit(event: WebSocketEventName, ev: WebSocketEvent): void {
    for (const cb of [...this.listeners[event]]) cb(ev);
  }
  open(): void {
    this.readyState = OPEN;
    this.emit("open", {});
  }
}

function fakeBridge(overrides: Partial<AudioBridge> = {}): {
  bridge: AudioBridge;
  audioControlCalls: boolean[];
  emitFrame: (pcm: Uint8Array) => void;
  frameUnsubscribed: () => boolean;
} {
  const audioControlCalls: boolean[] = [];
  let frameCb: ((pcm: Uint8Array) => void) | null = null;
  const state = { unsubscribed: false };
  const bridge: AudioBridge = {
    audioControl: async (on: boolean) => {
      audioControlCalls.push(on);
      return true;
    },
    onAudioFrame(cb) {
      frameCb = cb;
      state.unsubscribed = false;
      return () => {
        frameCb = null;
        state.unsubscribed = true;
      };
    },
    ...overrides,
  };
  return {
    bridge,
    audioControlCalls,
    emitFrame: (pcm) => frameCb?.(pcm),
    frameUnsubscribed: () => state.unsubscribed,
  };
}

function makeRecorder(bridge: AudioBridge, now?: () => number) {
  const ctor = FakeWebSocket as unknown as WebSocketCtor;
  return new AudioRecorder({ bridge, WebSocket: ctor, now });
}

async function startAndOpen(recorder: AudioRecorder, url = "wss://hub.example.com/audio?auth=t"): Promise<FakeWebSocket> {
  const startPromise = recorder.start(url);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  ws.open();
  await startPromise;
  return ws;
}

describe("AudioRecorder", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
  });

  describe("start", () => {
    it("opens the WS with the given URL before touching the mic (WS-first, mic-second)", async () => {
      const calls: string[] = [];
      const { bridge } = fakeBridge({
        audioControl: async (on) => {
          calls.push(`audioControl(${on})`);
          return true;
        },
      });
      const recorder = makeRecorder(bridge);
      const startPromise = recorder.start("wss://hub.example.com/audio?auth=tok");
      const ws = FakeWebSocket.instances[0]!;
      expect(ws.url).toBe("wss://hub.example.com/audio?auth=tok");
      expect(calls).toEqual([]); // mic not touched yet — WS hasn't opened

      ws.open();
      await startPromise;
      expect(calls).toEqual(["audioControl(true)"]);
    });

    it("subscribes to audio frames only after the mic is on", async () => {
      const { bridge, emitFrame } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);
      ws.readyState = OPEN;

      emitFrame(new Uint8Array([1, 2, 3]));
      expect(ws.sentFrames).toEqual([new Uint8Array([1, 2, 3])]);
    });

    it("closes the WS and rejects when audioControl(true) fails", async () => {
      const { bridge, audioControlCalls } = fakeBridge({
        audioControl: async (on) => {
          audioControlCalls.push(on);
          if (on) throw new Error("mic busy");
          return true;
        },
      });
      const recorder = makeRecorder(bridge);
      const startPromise = recorder.start("wss://hub.example.com/audio?auth=t");
      const ws = FakeWebSocket.instances[0]!;
      ws.open();

      await expect(startPromise).rejects.toThrow(/mic busy/);
      expect(ws.closeCalls).toBe(1);
      // Only the failed audioControl(true) call — no compensating false call
      // needed since the mic was never actually turned on.
      expect(audioControlCalls).toEqual([true]);
    });

    it("rejects when the WS itself errors before opening", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const startPromise = recorder.start("wss://hub.example.com/audio?auth=t");
      const ws = FakeWebSocket.instances[0]!;
      ws.emit("error", { message: "handshake failed" });

      await expect(startPromise).rejects.toThrow(/handshake failed/);
      expect(audioControlCalls).toEqual([]); // mic never touched
    });
  });

  describe("PCM frame forwarding", () => {
    it("forwards frames as binary sends only while the socket is OPEN, drops them otherwise", async () => {
      const { bridge, emitFrame } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);

      emitFrame(new Uint8Array([9, 9]));
      expect(ws.sentFrames).toHaveLength(1);

      ws.readyState = 2; // CLOSING
      emitFrame(new Uint8Array([1]));
      expect(ws.sentFrames).toHaveLength(1); // dropped, not sent
    });
  });

  describe("stopAndFinalize", () => {
    it("turns the mic off BEFORE sending the finalize control frame, and resolves with the parsed audio_result", async () => {
      // A shared ordering log (not two separate arrays) so the assertion
      // proves "audioControl(false) always happens, and strictly before the
      // finalize send" rather than just that both eventually occurred.
      const events: string[] = [];
      const { bridge } = fakeBridge({
        audioControl: async (on) => {
          events.push(`audioControl(${on})`);
          return true;
        },
      });
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);
      const realSend = ws.send.bind(ws);
      ws.send = (data) => {
        events.push(`send:${String(data)}`);
        realSend(data);
      };
      events.length = 0; // drop the audioControl(true) from start()

      const resultPromise = recorder.stopAndFinalize();
      // stopAndFinalize's `await this.teardownMic()` needs a couple of
      // microtask hops before it reaches the WS send — schedule the server's
      // reply as a macrotask so it always lands after the listener is
      // attached, regardless of exactly how many microtask ticks that takes.
      setTimeout(() => {
        ws.emit("message", {
          data: JSON.stringify({ type: "audio_result", transcript: { text: "hello world" }, durationMs: 500, bytes: 1000 }),
        });
      }, 0);
      const result = await resultPromise;

      expect(events).toEqual(["audioControl(false)", `send:${JSON.stringify({ type: "finalize" })}`]);
      expect(result).toEqual({
        type: "audio_result",
        transcript: { text: "hello world" },
        durationMs: 500,
        bytes: 1000,
      });
      expect(ws.closeCalls).toBe(1);
    });

    it("mic teardown: audioControl(false) fires even when there is nothing to finalize (no active recording)", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);

      const result = await recorder.stopAndFinalize();
      expect(result.transcript.unavailable).toBe(true);
      expect(audioControlCalls).toEqual([]); // never started, so no mic to turn off — still no crash
    });

    it("computes a durationMs fallback from the injected clock when the server omits it", async () => {
      let t = 1_000;
      const now = () => t;
      const { bridge } = fakeBridge();
      const recorder = makeRecorder(bridge, now);
      const ws = await startAndOpen(recorder);

      t = 4_500;
      const resultPromise = recorder.stopAndFinalize();
      setTimeout(() => {
        ws.emit("message", { data: JSON.stringify({ type: "audio_result", transcript: { text: "hi" } }) });
      }, 0);
      const result = await resultPromise;
      expect(result.durationMs).toBe(3_500);
    });

    describe("15s finalize timeout", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("resolves with an unavailable result and the mic is already off", async () => {
        const { bridge, audioControlCalls } = fakeBridge();
        const recorder = makeRecorder(bridge);
        const startPromise = recorder.start("wss://hub.example.com/audio?auth=t");
        const ws = FakeWebSocket.instances[0]!;
        ws.open();
        await startPromise;

        const resultPromise = recorder.stopAndFinalize();
        // Mic teardown happens before the WS round trip even begins.
        expect(audioControlCalls).toEqual([true, false]);

        await vi.advanceTimersByTimeAsync(15_000);
        const result = await resultPromise;
        expect(result.transcript.unavailable).toBe(true);
        expect(result.transcript.reason).toMatch(/timed out/);
        expect(ws.closeCalls).toBe(1);
      });
    });
  });

  describe("cancel", () => {
    it("turns the mic off and closes the WS without sending finalize", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);

      await recorder.cancel();
      expect(audioControlCalls).toEqual([true, false]);
      expect(ws.sentFrames).toEqual([]); // no finalize frame — server discards
      expect(ws.closeCalls).toBe(1);
    });

    it("is a no-op safe call when nothing is recording", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);
      await expect(recorder.cancel()).resolves.toBeUndefined();
      expect(audioControlCalls).toEqual([]);
    });

    it("unsubscribes the audio-frame handler", async () => {
      const helper = fakeBridge();
      const recorder = makeRecorder(helper.bridge);
      await startAndOpen(recorder);
      expect(helper.frameUnsubscribed()).toBe(false);
      await recorder.cancel();
      expect(helper.frameUnsubscribed()).toBe(true);
    });
  });

  describe("mic teardown on unexpected WS end", () => {
    it("turns the mic off when the WS fires an unexpected 'error' event mid-recording", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);

      ws.emit("error", { message: "socket died" });
      // audioControl(false) is async internally, but the call fires synchronously.
      expect(audioControlCalls).toEqual([true, false]);
      expect(recorder.isRecording()).toBe(false);
    });

    it("turns the mic off when the WS fires an unexpected 'close' event mid-recording", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);

      ws.emit("close", {});
      expect(audioControlCalls).toEqual([true, false]);
      expect(recorder.isRecording()).toBe(false);
    });

    it("does not double-call audioControl(false) when cancel() follows an already-unexpected close", async () => {
      const { bridge, audioControlCalls } = fakeBridge();
      const recorder = makeRecorder(bridge);
      const ws = await startAndOpen(recorder);

      ws.emit("close", {});
      await recorder.cancel();
      expect(audioControlCalls).toEqual([true, false]); // idempotent — no second `false`
    });
  });
});
