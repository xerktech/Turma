// Minimal vitest-compatible fake timers for bun:test.
//
// bun:test's `jest.useFakeTimers()` only mocks the Date (via setSystemTime);
// it has no advanceTimersByTime. The ported suites (app.test, debounce.test,
// audio.test) drive setTimeout-based loops with vi.advanceTimersByTime(Async),
// so this shim patches globalThis.setTimeout/clearTimeout with a virtual
// scheduler and keeps bun's setSystemTime in lockstep so Date.now() advances
// with the timers — the semantics those suites rely on.
//
// Converted call sites: `vi.useFakeTimers()` -> `fakeTimers.useFakeTimers()`
// etc. (same method names as vitest's timer API).

import { setSystemTime } from "bun:test";

interface TimerRecord {
  id: number;
  at: number;
  cb: (...args: unknown[]) => void;
  args: unknown[];
}

class FakeTimers {
  private installed = false;
  private timers: TimerRecord[] = [];
  private nextId = 1;
  private now = 0;
  private readonly realSetTimeout = globalThis.setTimeout.bind(globalThis);
  private readonly realClearTimeout = globalThis.clearTimeout.bind(globalThis);

  useFakeTimers(): void {
    if (this.installed) return;
    this.installed = true;
    this.timers = [];
    this.now = Date.now();
    const g = globalThis as unknown as Record<string, unknown>;
    g.setTimeout = (cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = this.nextId++;
      this.timers.push({ id, at: this.now + Math.max(0, ms ?? 0), cb, args });
      return id;
    };
    g.clearTimeout = (id: unknown) => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  useRealTimers(): void {
    if (!this.installed) return;
    this.installed = false;
    const g = globalThis as unknown as Record<string, unknown>;
    g.setTimeout = this.realSetTimeout;
    g.clearTimeout = this.realClearTimeout;
    this.timers = [];
    setSystemTime(); // un-mock Date
  }

  setSystemTime(t: number | Date): void {
    this.now = typeof t === "number" ? t : t.getTime();
    setSystemTime(this.now);
  }

  /** Fire every timer due within `ms` virtual milliseconds, synchronously. */
  advanceTimersByTime(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = this.takeDueBefore(target);
      if (!next) break;
      this.now = next.at;
      setSystemTime(this.now);
      next.cb(...next.args);
    }
    this.now = target;
    setSystemTime(this.now);
  }

  /**
   * Like advanceTimersByTime, but drains the microtask/macrotask queue (via
   * the REAL setTimeout) before, between, and after firing timers — so
   * promise chains a timer kicks off (fetch mocks, .then handlers that
   * schedule more timers) settle exactly as vitest's async advance does.
   */
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    await this.flush();
    const target = this.now + ms;
    for (;;) {
      const next = this.takeDueBefore(target);
      if (!next) break;
      this.now = next.at;
      setSystemTime(this.now);
      next.cb(...next.args);
      await this.flush();
    }
    this.now = target;
    setSystemTime(this.now);
    await this.flush();
  }

  /** Earliest timer with at <= target (FIFO among equals), removed from the queue. */
  private takeDueBefore(target: number): TimerRecord | null {
    let best: TimerRecord | null = null;
    for (const t of this.timers) {
      if (t.at <= target && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    }
    if (best) this.timers = this.timers.filter((t) => t !== best);
    return best;
  }

  private flush(): Promise<void> {
    return new Promise<void>((resolve) => this.realSetTimeout(resolve, 0));
  }
}

export const fakeTimers = new FakeTimers();
