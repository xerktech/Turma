// Tests for the Mentra AudioBridge (Foverlay port — new module). The bridge
// is what audio.ts's teardown discipline leans on: audioControl must be an
// idempotent subscribe/unsubscribe, and frames must decode base64 -> bytes.
import { describe, expect, it } from "bun:test";
import { base64ToBytes, MentraMicBridge, type AudioChunkLike, type MicSessionLike } from "./mic-bridge.ts";

class FakeMicSession implements MicSessionLike {
  handler: ((data: AudioChunkLike) => void) | null = null;
  subscribes = 0;
  unsubscribes = 0;

  mic = {
    onAudioChunk: (handler: (data: AudioChunkLike) => void): (() => void) => {
      this.subscribes++;
      this.handler = handler;
      return () => {
        this.unsubscribes++;
        this.handler = null;
      };
    },
  };
}

const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));

describe("base64ToBytes", () => {
  it("decodes to the exact byte sequence", () => {
    expect(Array.from(base64ToBytes(b64([0, 127, 255, 16])))).toEqual([0, 127, 255, 16]);
  });
});

describe("MentraMicBridge", () => {
  it("audioControl(true) subscribes once, audioControl(false) unsubscribes — both idempotent", async () => {
    const session = new FakeMicSession();
    const bridge = new MentraMicBridge(session);

    await bridge.audioControl(true);
    await bridge.audioControl(true); // second on: no double subscription
    expect(session.subscribes).toBe(1);

    await bridge.audioControl(false);
    await bridge.audioControl(false); // second off: no double unsubscribe
    expect(session.unsubscribes).toBe(1);

    // A fresh on after off subscribes again (recorder start/stop cycles).
    await bridge.audioControl(true);
    expect(session.subscribes).toBe(2);
  });

  it("decodes chunks and fans them out to every onAudioFrame subscriber", async () => {
    const session = new FakeMicSession();
    const bridge = new MentraMicBridge(session);
    const got1: Uint8Array[] = [];
    const got2: Uint8Array[] = [];
    bridge.onAudioFrame((pcm) => got1.push(pcm));
    const off2 = bridge.onAudioFrame((pcm) => got2.push(pcm));

    await bridge.audioControl(true);
    session.handler!({ data: b64([1, 2, 3]) });
    expect(got1.length).toBe(1);
    expect(Array.from(got1[0]!)).toEqual([1, 2, 3]);
    expect(got2.length).toBe(1);

    off2();
    session.handler!({ data: b64([4]) });
    expect(got1.length).toBe(2);
    expect(got2.length).toBe(1); // unsubscribed
  });

  it("drops malformed/empty chunks instead of throwing", async () => {
    const session = new FakeMicSession();
    const bridge = new MentraMicBridge(session);
    const got: Uint8Array[] = [];
    bridge.onAudioFrame((pcm) => got.push(pcm));
    await bridge.audioControl(true);
    session.handler!({ data: "" });
    session.handler!({ data: "not-base64!!!" });
    session.handler!({} as AudioChunkLike);
    expect(got.length).toBe(0);
  });

  it("no frames are delivered after audioControl(false) even if a stale chunk arrives", async () => {
    const session = new FakeMicSession();
    const bridge = new MentraMicBridge(session);
    const got: Uint8Array[] = [];
    bridge.onAudioFrame((pcm) => got.push(pcm));
    await bridge.audioControl(true);
    const handler = session.handler!;
    await bridge.audioControl(false);
    // The SDK never calls a handler after unsubscribe, but a stale reference
    // racing the off must be inert too — the mic-off discipline says no
    // frames flow once audioControl(false) ran.
    handler({ data: b64([9]) });
    expect(got.length).toBe(0);
  });
});
