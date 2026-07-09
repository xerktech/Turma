import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capContent, createTrailingDebounce } from "./debounce.ts";

describe("createTrailingDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately on the first call (leading edge after quiet period)", () => {
    const calls: string[] = [];
    const debounced = createTrailingDebounce<string>((v) => calls.push(v), 120);
    debounced("a");
    expect(calls).toEqual(["a"]);
  });

  it("coalesces rapid calls within the window to a single trailing call, last value wins", () => {
    const calls: string[] = [];
    const debounced = createTrailingDebounce<string>((v) => calls.push(v), 120);
    debounced("a"); // leading fire
    expect(calls).toEqual(["a"]);

    debounced("b");
    debounced("c");
    debounced("d");
    // Still within the 120ms window since the leading fire — nothing new yet.
    expect(calls).toEqual(["a"]);

    vi.advanceTimersByTime(120);
    expect(calls).toEqual(["a", "d"]);
  });

  it("keeps resetting the trailing timer as long as calls keep arriving", () => {
    const calls: string[] = [];
    const debounced = createTrailingDebounce<string>((v) => calls.push(v), 120);
    debounced("a"); // leading fire
    debounced("b");
    vi.advanceTimersByTime(100); // not yet 120ms since "b" scheduled the timer
    debounced("c"); // resets the timer again
    vi.advanceTimersByTime(100); // 100ms since "c" — still not fired
    expect(calls).toEqual(["a"]);
    vi.advanceTimersByTime(20); // now 120ms since "c"
    expect(calls).toEqual(["a", "c"]);
  });

  it("fires promptly again after a quiet gap following a trailing flush", () => {
    const calls: string[] = [];
    const debounced = createTrailingDebounce<string>((v) => calls.push(v), 120);
    debounced("a"); // leading fire at t=0
    debounced("b"); // scheduled trailing
    vi.advanceTimersByTime(120); // trailing flush -> "b" at t=120
    expect(calls).toEqual(["a", "b"]);

    vi.advanceTimersByTime(200); // quiet period, well past 120ms
    debounced("e"); // new leading fire, isolated call
    expect(calls).toEqual(["a", "b", "e"]);
  });

  it("passes the trailing timer's value even if invoked once, isolated, mid-window", () => {
    const calls: number[] = [];
    const debounced = createTrailingDebounce<number>((v) => calls.push(v), 120);
    debounced(1); // leading
    vi.advanceTimersByTime(50);
    debounced(2); // trailing scheduled
    vi.advanceTimersByTime(120);
    expect(calls).toEqual([1, 2]);
  });
});

describe("capContent", () => {
  it("returns content unchanged when under the cap", () => {
    expect(capContent("hello", 2000)).toBe("hello");
  });

  it("returns content unchanged when exactly at the cap", () => {
    const s = "x".repeat(2000);
    expect(capContent(s, 2000)).toBe(s);
  });

  it("truncates from the top, keeping the newest (bottom) content", () => {
    const s = "a".repeat(500) + "b".repeat(2000);
    const result = capContent(s, 2000);
    expect(result.length).toBe(2000);
    expect(result).toBe("b".repeat(2000));
  });

  it("keeps the tail across a mixed-content overflow", () => {
    const s = "0123456789".repeat(300); // 3000 chars
    const result = capContent(s, 2000);
    expect(result).toBe(s.slice(1000));
    expect(result.length).toBe(2000);
  });
});
