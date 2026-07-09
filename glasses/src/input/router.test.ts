import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInputRouter,
  normalizeEvent,
  type RawEvenHubEvent,
  type RouterBridge,
} from "./router.ts";
import type { InputEvent } from "../types.ts";

describe("normalizeEvent", () => {
  it("maps a sysEvent click (eventType undefined) to tap — protobuf zero-omission", () => {
    expect(normalizeEvent({ sysEvent: {} })).toEqual({ type: "tap" });
  });

  it("maps an explicit sysEvent CLICK_EVENT (0) to tap", () => {
    expect(normalizeEvent({ sysEvent: { eventType: 0 } })).toEqual({ type: "tap" });
  });

  it("THE GOTCHA: a click on the text container is sysEvent, not textEvent", () => {
    // This is the exact scenario the brief calls out: a single click lands
    // in event.sysEvent (undefined/0 eventType), never event.textEvent.
    const raw: RawEvenHubEvent = { sysEvent: { eventType: 0 } };
    expect(normalizeEvent(raw)).toEqual({ type: "tap" });
    expect(normalizeEvent({ textEvent: { eventType: 0 } })).not.toEqual({ type: "tap" });
  });

  it("maps sysEvent DOUBLE_CLICK_EVENT (3) to doubleTap", () => {
    expect(normalizeEvent({ sysEvent: { eventType: 3 } })).toEqual({ type: "doubleTap" });
  });

  it("maps textEvent SCROLL_TOP_EVENT (1) to scrollUp", () => {
    expect(normalizeEvent({ textEvent: { eventType: 1 } })).toEqual({ type: "scrollUp" });
  });

  it("maps textEvent SCROLL_BOTTOM_EVENT (2) to scrollDown", () => {
    expect(normalizeEvent({ textEvent: { eventType: 2 } })).toEqual({ type: "scrollDown" });
  });

  it("treats an undefined textEvent eventType as a click (protobuf zero) and ignores it", () => {
    // A textEvent whose eventType is 0/undefined isn't a scroll gesture at
    // all (scrolls are always 1 or 2) — the router shouldn't invent one.
    expect(normalizeEvent({ textEvent: {} })).toBeNull();
  });

  it.each([
    [4, { type: "lifecycle", phase: "foreground-enter" }],
    [5, { type: "lifecycle", phase: "foreground-exit" }],
    [6, { type: "lifecycle", phase: "abnormal-exit" }],
  ])("maps sysEvent eventType %i to the matching lifecycle phase", (eventType, expected) => {
    expect(normalizeEvent({ sysEvent: { eventType } })).toEqual(expected);
  });

  it("maps SYSTEM_EXIT_EVENT (7) to lifecycle system-exit and carries the reason code", () => {
    expect(normalizeEvent({ sysEvent: { eventType: 7, systemExitReasonCode: 42 } })).toEqual({
      type: "lifecycle",
      phase: "system-exit",
      reasonCode: 42,
    });
  });

  it("maps IMU_DATA_REPORT (8) to null — not part of this app's vocabulary", () => {
    expect(normalizeEvent({ sysEvent: { eventType: 8 } })).toBeNull();
  });

  it("maps an unrecognized sysEvent eventType to null", () => {
    expect(normalizeEvent({ sysEvent: { eventType: 999 } })).toBeNull();
  });

  it("maps a listEvent to null — this app never creates list containers", () => {
    expect(normalizeEvent({ listEvent: { currentSelectItemIndex: 2 } })).toBeNull();
  });

  it("maps an empty/unknown event to null", () => {
    expect(normalizeEvent({})).toBeNull();
    expect(normalizeEvent({ audioEvent: {} })).toBeNull();
  });
});

describe("createInputRouter", () => {
  function fakeBridge(): { bridge: RouterBridge; emit: (e: RawEvenHubEvent) => void; unsubscribed: boolean } {
    let cb: ((e: RawEvenHubEvent) => void) | null = null;
    const state = { unsubscribed: false };
    const bridge: RouterBridge = {
      onEvenHubEvent(handler) {
        cb = handler;
        return () => {
          state.unsubscribed = true;
        };
      },
    };
    return {
      bridge,
      emit: (e) => cb?.(e),
      get unsubscribed() {
        return state.unsubscribed;
      },
    };
  }

  it("dispatches normalized input events to onInput, using a pass-through dedup", () => {
    const { bridge, emit } = fakeBridge();
    const received: InputEvent[] = [];
    createInputRouter(bridge, { onInput: (e) => received.push(e), tapDedup: () => true });
    emit({ sysEvent: { eventType: 0 } });
    emit({ textEvent: { eventType: 1 } });
    emit({ textEvent: { eventType: 2 } });
    expect(received).toEqual([{ type: "tap" }, { type: "scrollUp" }, { type: "scrollDown" }]);
  });

  it("dispatches lifecycle events to onLifecycle, not onInput", () => {
    const { bridge, emit } = fakeBridge();
    const input: InputEvent[] = [];
    const lifecycle: string[] = [];
    createInputRouter(bridge, {
      onInput: (e) => input.push(e),
      onLifecycle: (e) => lifecycle.push(e.phase),
      tapDedup: () => true,
    });
    emit({ sysEvent: { eventType: 5 } });
    emit({ sysEvent: { eventType: 4 } });
    expect(lifecycle).toEqual(["foreground-exit", "foreground-enter"]);
    expect(input).toEqual([]);
  });

  it("drops unknown/null-normalized events silently", () => {
    const { bridge, emit } = fakeBridge();
    const received: InputEvent[] = [];
    createInputRouter(bridge, { onInput: (e) => received.push(e), tapDedup: () => true });
    emit({ sysEvent: { eventType: 8 } }); // IMU
    emit({});
    expect(received).toEqual([]);
  });

  it("gates tap and doubleTap through the injected dedup function", () => {
    const { bridge, emit } = fakeBridge();
    const received: InputEvent[] = [];
    let allow = false;
    createInputRouter(bridge, { onInput: (e) => received.push(e), tapDedup: () => allow });
    emit({ sysEvent: { eventType: 0 } }); // tap, suppressed
    expect(received).toEqual([]);
    allow = true;
    emit({ sysEvent: { eventType: 0 } }); // tap, allowed
    emit({ sysEvent: { eventType: 3 } }); // doubleTap, allowed
    expect(received).toEqual([{ type: "tap" }, { type: "doubleTap" }]);
  });

  it("does not gate scroll events through dedup", () => {
    const { bridge, emit } = fakeBridge();
    const received: InputEvent[] = [];
    createInputRouter(bridge, { onInput: (e) => received.push(e), tapDedup: () => false });
    emit({ textEvent: { eventType: 1 } });
    expect(received).toEqual([{ type: "scrollUp" }]);
  });

  it("returns the bridge's unsubscribe function", () => {
    // `helper.unsubscribed` is a live getter — read it via the object, not a
    // destructured binding, so each read reflects the current state.
    const helper = fakeBridge();
    const stop = createInputRouter(helper.bridge, { onInput: () => {} });
    expect(helper.unsubscribed).toBe(false);
    stop();
    expect(helper.unsubscribed).toBe(true);
  });

  describe("onAudioFrame fan-out (Task 7)", () => {
    // Mic PCM rides the same `onEvenHubEvent` stream as taps/lifecycle
    // events — the router fans it out to a dedicated handler instead of a
    // second `bridge.onEvenHubEvent` subscription. Frames are ungated: they
    // never touch tapDedup and are dispatched even on ticks that also carry
    // a normalized input/lifecycle event.
    it("dispatches audioEvent.audioPcm frames to onAudioFrame, not onInput/onLifecycle", () => {
      const { bridge, emit } = fakeBridge();
      const frames: Uint8Array[] = [];
      const input: InputEvent[] = [];
      createInputRouter(bridge, {
        onInput: (e) => input.push(e),
        onAudioFrame: (pcm) => frames.push(pcm),
        tapDedup: () => true,
      });
      const pcm = new Uint8Array([1, 2, 3]);
      emit({ audioEvent: { audioPcm: pcm } });
      expect(frames).toEqual([pcm]);
      expect(input).toEqual([]);
    });

    it("ignores an audioEvent with no audioPcm or an empty frame", () => {
      const { bridge, emit } = fakeBridge();
      const frames: Uint8Array[] = [];
      createInputRouter(bridge, { onInput: () => {}, onAudioFrame: (pcm) => frames.push(pcm) });
      emit({ audioEvent: {} });
      emit({ audioEvent: { audioPcm: new Uint8Array([]) } });
      expect(frames).toEqual([]);
    });

    it("does nothing (no throw) when onAudioFrame isn't provided", () => {
      const { bridge, emit } = fakeBridge();
      createInputRouter(bridge, { onInput: () => {} });
      expect(() => emit({ audioEvent: { audioPcm: new Uint8Array([1]) } })).not.toThrow();
    });

    it("still normalizes a tap/lifecycle event delivered on the same tick as an audio frame", () => {
      const { bridge, emit } = fakeBridge();
      const frames: Uint8Array[] = [];
      const input: InputEvent[] = [];
      createInputRouter(bridge, {
        onInput: (e) => input.push(e),
        onAudioFrame: (pcm) => frames.push(pcm),
        tapDedup: () => true,
      });
      // Not a realistic combined payload from the SDK, but proves the two
      // fan-outs are independent regardless of what else rides the event.
      emit({ audioEvent: { audioPcm: new Uint8Array([9]) }, sysEvent: { eventType: 0 } });
      expect(frames).toHaveLength(1);
      expect(input).toEqual([{ type: "tap" }]);
    });
  });

  describe("default tap dedup (real tryConsumeTap, no injection)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("detects and dedups a rapid duplicate tap using the default tryConsumeTap gate", () => {
      const { bridge, emit } = fakeBridge();
      const received: InputEvent[] = [];
      createInputRouter(bridge, { onInput: (e) => received.push(e) });
      emit({ sysEvent: { eventType: 0 } }); // first tap: allowed
      emit({ sysEvent: { eventType: 0 } }); // immediate duplicate: deduped
      expect(received).toEqual([{ type: "tap" }]);

      vi.setSystemTime(1000); // well past tryConsumeTap's cooldown windows
      emit({ sysEvent: { eventType: 0 } }); // a fresh tap after cooldown: allowed
      expect(received).toEqual([{ type: "tap" }, { type: "tap" }]);
    });

    it("detects a double-tap distinctly from a duplicate single tap", () => {
      // tryConsumeTap's cooldown state is module-level and persists across
      // tests in this file — jump far enough forward that no prior test's
      // last-tap timestamp can still be within any cooldown window.
      vi.setSystemTime(10_000_000);
      const { bridge, emit } = fakeBridge();
      const received: InputEvent[] = [];
      createInputRouter(bridge, { onInput: (e) => received.push(e) });
      emit({ sysEvent: { eventType: 3 } }); // doubleTap: allowed
      expect(received).toEqual([{ type: "doubleTap" }]);
    });
  });
});
