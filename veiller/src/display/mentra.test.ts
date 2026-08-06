// Tests for the new Mentra scene backend (Veiller port — no upstream
// counterpart; display/evenhub.test.ts covered the Even Hub backend these
// mirror the spirit of: shape-change-immediate vs same-shape-debounced,
// element geometry, input mapping, and the blank-content guard).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fakeTimers } from "../test-utils/fake-timers.ts";
import { MentraDisplay, type MentraDisplaySession, type RenderElementLike, type TouchDataLike } from "./mentra.ts";
import type { ScreenModel } from "../core/render.ts";
import type { InputEvent } from "../core/types.ts";

class FakeSession implements MentraDisplaySession {
  frames: RenderElementLike[][] = [];
  touchHandler: ((data: TouchDataLike) => void) | null = null;
  touchGestures: string[] = [];
  unsubscribed = 0;

  display = {
    render: (elements: RenderElementLike[]): Promise<unknown> => {
      this.frames.push(elements);
      return Promise.resolve({ status: "displayed" });
    },
  };

  input = {
    onTouch: (gestures: string[], handler: (data: TouchDataLike) => void): (() => void) => {
      this.touchGestures = gestures;
      this.touchHandler = handler;
      return () => {
        this.unsubscribed++;
        this.touchHandler = null;
      };
    },
  };
}

function linesModel(lines: string[]): ScreenModel {
  return { type: "lines", lines };
}

function sessionModel(boxLines: string[], transcript: string[] = ["hello"]): ScreenModel {
  return {
    type: "session",
    transcriptLines: transcript,
    bottom: { mode: "input", lines: boxLines, status: "Idle", focused: false },
  };
}

describe("MentraDisplay", () => {
  let session: FakeSession;
  let display: MentraDisplay;

  beforeEach(async () => {
    fakeTimers.useFakeTimers();
    fakeTimers.setSystemTime(1_000_000);
    session = new FakeSession();
    display = new MentraDisplay(session);
    await display.start();
  });

  afterEach(() => {
    fakeTimers.useRealTimers();
  });

  it("start() seeds a blank lines frame and subscribes the four gestures", () => {
    expect(session.frames.length).toBe(1);
    expect(session.frames[0]).toEqual([
      { type: "text", id: "main", box: { x: 0, y: 0, w: 576, h: 288 }, text: " " },
    ]);
    expect(session.touchGestures.sort()).toEqual(["double_tap", "single_tap", "swipe_down", "swipe_up"]);
  });

  it("maps touch gestures to the app's InputEvent vocabulary and drops unknown kinds", () => {
    const events: InputEvent[] = [];
    display.onInput((e) => events.push(e));
    session.touchHandler!({ kind: "single_tap" });
    session.touchHandler!({ kind: "double_tap" });
    session.touchHandler!({ kind: "swipe_up" });
    session.touchHandler!({ kind: "swipe_down" });
    session.touchHandler!({ kind: "triple_tap" }); // not in the vocabulary
    expect(events.map((e) => e.type)).toEqual(["tap", "doubleTap", "scrollUp", "scrollDown"]);
  });

  it("a same-shape lines render is debounced; the trailing flush carries the LAST value", () => {
    display.render(linesModel(["a"])); // leading edge (first since start's direct push)
    expect(session.frames.length).toBe(2);
    display.render(linesModel(["b"]));
    display.render(linesModel(["c"]));
    expect(session.frames.length).toBe(2); // coalescing
    fakeTimers.advanceTimersByTime(120);
    expect(session.frames.length).toBe(3);
    expect(session.frames[2]![0]!).toMatchObject({ id: "main", text: "c" });
  });

  it("a shape change renders immediately and cancels the pending stale flush", () => {
    display.render(linesModel(["a"]));
    display.render(linesModel(["stale"])); // pending trailing flush
    display.render(sessionModel(["draft"])); // lines -> session: immediate
    const sessionFrame = session.frames[session.frames.length - 1]!;
    expect(sessionFrame.map((el) => el.id)).toEqual(["transcript", "boxborder", "boxtext", "status"]);
    fakeTimers.advanceTimersByTime(500);
    // The stale "lines" flush must never have fired after the session frame.
    const last = session.frames[session.frames.length - 1]!;
    expect(last.map((el) => el.id)).toEqual(["transcript", "boxborder", "boxtext", "status"]);
  });

  it("sizes the session bottom box from its line count (40px lines + border/padding inset)", () => {
    display.render(sessionModel(["l1", "l2", "l3"])); // 3 box lines
    const frame = session.frames[session.frames.length - 1]!;
    const boxHeight = 3 * 40 + 6;
    const boxY = 288 - boxHeight;
    expect(frame[0]!.box).toEqual({ x: 0, y: 0, w: 576, h: boxY }); // transcript above the box
    expect(frame[1]!.box).toEqual({ x: 0, y: boxY, w: 576, h: boxHeight }); // bordered rect
    expect(frame[1]!).toMatchObject({ type: "rect", style: { border: 1, radius: 12 } });
    expect(frame[3]!.box.w).toBe(120); // status corner
    expect(frame[3]!.box.y).toBe(boxY + 3);
  });

  it("a box line-count change within the session shape is immediate (page-shape change)", () => {
    display.render(sessionModel(["one"]));
    const before = session.frames.length;
    display.render(sessionModel(["one", "two"])); // 1 -> 2 box lines
    expect(session.frames.length).toBe(before + 1);
  });

  it("coerces empty content to a single space so elements never carry ''", () => {
    display.render(sessionModel([""], []));
    const frame = session.frames[session.frames.length - 1]!;
    const texts = frame.filter((el): el is Extract<RenderElementLike, { type: "text" }> => el.type === "text");
    for (const el of texts) expect(el.text.length).toBeGreaterThan(0);
  });

  it("dispose() unsubscribes the touch stream and drops pending renders", () => {
    display.render(linesModel(["a"]));
    display.render(linesModel(["pending"]));
    const before = session.frames.length;
    display.dispose();
    fakeTimers.advanceTimersByTime(500);
    expect(session.frames.length).toBe(before); // pending flush cancelled
    expect(session.unsubscribed).toBe(1);
  });
});
