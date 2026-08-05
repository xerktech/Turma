// The Mentra `AudioBridge` for audio.ts's AudioRecorder (Foverlay port).
//
// Upstream, `audioControl(true/false)` was a literal Even Hub hardware call
// and PCM frames rode the display's single `onEvenHubEvent` subscription.
// Here the mic is demand-driven: the phone turns the G2 mic on when the
// first `audio_chunk` subscriber appears and off when the last one leaves —
// so `audioControl(true)` IS "subscribe session.mic.onAudioChunk" and
// `audioControl(false)` IS "unsubscribe". Chunks arrive base64-encoded
// (16kHz s16le mono PCM on the G2 path — the same wire format the hub's
// /audio socket expects), decoded here and fanned out to `onAudioFrame`
// subscribers exactly like upstream's EvenHubDisplay.onAudioFrame.
//
// Every teardown-path guarantee in audio.ts survives unchanged: the
// recorder still calls audioControl(false) on stop/cancel/unexpected-end,
// and this bridge makes that an idempotent unsubscribe.

import type { AudioBridge } from "./audio.ts";

export interface AudioChunkLike {
  /** Base64-encoded PCM (or LC3) payload. */
  data: string;
}

// The slice of the miniapp SDK session this bridge needs — structural, so
// tests can hand in a fake without importing @mentra/miniapp.
export interface MicSessionLike {
  mic: {
    onAudioChunk(handler: (data: AudioChunkLike) => void): () => void;
  };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class MentraMicBridge implements AudioBridge {
  private readonly session: MicSessionLike;
  private readonly frameCbs = new Set<(pcm: Uint8Array) => void>();
  private unsubscribeChunks: (() => void) | null = null;

  constructor(session: MicSessionLike) {
    this.session = session;
  }

  // Mic on = subscribe (the phone runtime turns the hardware mic on for the
  // first subscriber); mic off = unsubscribe. Idempotent both ways, so the
  // recorder's overlapping teardown paths can call freely.
  async audioControl(on: boolean): Promise<void> {
    if (on) {
      if (this.unsubscribeChunks) return;
      this.unsubscribeChunks = this.session.mic.onAudioChunk((chunk) => this.handleChunk(chunk));
      return;
    }
    const unsub = this.unsubscribeChunks;
    this.unsubscribeChunks = null;
    if (unsub) {
      try {
        unsub();
      } catch {
        // best-effort — the subscription may already be gone
      }
    }
  }

  onAudioFrame(cb: (pcm: Uint8Array) => void): () => void {
    this.frameCbs.add(cb);
    return () => {
      this.frameCbs.delete(cb);
    };
  }

  private handleChunk(chunk: AudioChunkLike): void {
    // Defense in depth for the mic-off discipline: once audioControl(false)
    // ran, no frame may reach subscribers — even one delivered through a
    // stale handler reference racing the unsubscribe.
    if (!this.unsubscribeChunks) return;
    if (!chunk || typeof chunk.data !== "string" || chunk.data.length === 0) return;
    let pcm: Uint8Array;
    try {
      pcm = base64ToBytes(chunk.data);
    } catch {
      return; // malformed frame — drop it, the next one may be fine
    }
    for (const cb of this.frameCbs) cb(pcm);
  }
}
