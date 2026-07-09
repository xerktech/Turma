// Hardware-agnostic dictation. Task 7 implements the real G2-mic backend
// (capture -> the hub's /audio STT WebSocket); this app only ever depends on
// this interface, plus the dev PromptDictation implementation below.
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
