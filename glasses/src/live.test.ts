import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLiveWsUrl, LiveTail, NoopLiveTail, type LiveTailOptions } from "./live.ts";
import type { WebSocketEvent, WebSocketEventName, WebSocketLike } from "./audio.ts";
import type { TailEntry } from "./types.ts";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  url: string;
  private listeners: Record<string, ((ev: WebSocketEvent) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(event: WebSocketEventName, cb: (ev: WebSocketEvent) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }
  removeEventListener(event: WebSocketEventName, cb: (ev: WebSocketEvent) => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== cb);
  }
  emit(event: WebSocketEventName, ev: WebSocketEvent = {}): void {
    for (const cb of this.listeners[event] ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  message(obj: unknown): void {
    this.emit("message", { data: JSON.stringify(obj) });
  }
}

// A manual timer scheduler so reconnect backoff is deterministic.
function makeScheduler() {
  const pending: { id: number; cb: () => void }[] = [];
  let nextId = 1;
  return {
    setTimer: (cb: () => void) => {
      const id = nextId++;
      pending.push({ id, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (t: ReturnType<typeof setTimeout>) => {
      const id = t as unknown as number;
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    fireAll: () => {
      const runs = pending.splice(0);
      for (const p of runs) p.cb();
    },
    count: () => pending.length,
  };
}

function tail(entries: TailEntry[]) {
  return { type: "tail", entries };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeLiveTail(overrides: Partial<LiveTailOptions> = {}) {
  const sched = makeScheduler();
  const wsToken = vi.fn(async () => ({ token: "tok", expiresInSec: 300 }));
  const lt = new LiveTail({
    hubClient: { wsToken },
    hubUrl: "https://hub.example",
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocketLike,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    ...overrides,
  });
  return { lt, sched, wsToken };
}

describe("buildLiveWsUrl", () => {
  it("derives wss and encodes the path + token", () => {
    expect(buildLiveWsUrl("https://hub.example/", "host a", "s/1", "t ok")).toBe(
      "wss://hub.example/live/host%20a/s%2F1?auth=t%20ok"
    );
  });
  it("derives ws for a plain-http hub", () => {
    expect(buildLiveWsUrl("http://192.168.1.9:8300", "h", "s", "t")).toBe(
      "ws://192.168.1.9:8300/live/h/s?auth=t"
    );
  });
});

describe("NoopLiveTail", () => {
  it("does nothing", () => {
    const n = new NoopLiveTail();
    expect(() => {
      n.start("h", "s", () => {});
      n.stop();
    }).not.toThrow();
  });
});

describe("LiveTail", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it("connects with a fresh ws-token and the right URL, then delivers tail deltas", async () => {
    const { lt, wsToken } = makeLiveTail();
    const got: TailEntry[][] = [];
    lt.start("host-a", "s1", (e) => got.push(e));
    await flush();
    expect(wsToken).toHaveBeenCalledTimes(1);
    const ws = FakeSocket.instances[0]!;
    expect(ws.url).toBe("wss://hub.example/live/host-a/s1?auth=tok");
    ws.open();
    ws.message(tail([{ id: "a", role: "assistant", text: "hi" }]));
    expect(got).toEqual([[{ id: "a", role: "assistant", text: "hi" }]]);
  });

  it("ignores non-tail frames and empty deltas", async () => {
    const { lt } = makeLiveTail();
    const got: TailEntry[][] = [];
    lt.start("h", "s", (e) => got.push(e));
    await flush();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.message({ type: "other", entries: [{ id: "x", role: "user", text: "no" }] });
    ws.message(tail([]));
    ws.emit("message", { data: "not json" });
    expect(got).toEqual([]);
  });

  it("reconnects with backoff after an unexpected close", async () => {
    const { lt, sched } = makeLiveTail();
    lt.start("h", "s", () => {});
    await flush();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.emit("close");
    expect(sched.count()).toBe(1); // reconnect scheduled
    sched.fireAll();
    await flush();
    expect(FakeSocket.instances.length).toBe(2); // reconnected
  });

  it("stop() closes the socket and silences further deltas", async () => {
    const { lt } = makeLiveTail();
    const got: TailEntry[][] = [];
    lt.start("h", "s", (e) => got.push(e));
    await flush();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    lt.stop();
    expect(ws.closed).toBe(true);
    ws.message(tail([{ id: "a", role: "assistant", text: "late" }]));
    expect(got).toEqual([]);
  });

  it("stop() before the socket opens cancels the pending reconnect and delivers nothing", async () => {
    const { lt, sched } = makeLiveTail();
    const got: TailEntry[][] = [];
    lt.start("h", "s", (e) => got.push(e));
    await flush();
    FakeSocket.instances[0]!.emit("error");
    expect(sched.count()).toBe(1);
    lt.stop();
    expect(sched.count()).toBe(0); // reconnect cancelled
  });

  it("start() for the same session is idempotent (keeps the live socket)", async () => {
    const { lt } = makeLiveTail();
    lt.start("h", "s", () => {});
    await flush();
    lt.start("h", "s", () => {});
    await flush();
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("switching sessions tears down the old socket and opens a new one", async () => {
    const { lt } = makeLiveTail();
    lt.start("h", "s1", () => {});
    await flush();
    const first = FakeSocket.instances[0]!;
    first.open();
    lt.start("h", "s2", () => {});
    await flush();
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[1]!.url).toContain("/live/h/s2");
  });

  it("a ws-token fetch failure schedules a reconnect (poll keeps working)", async () => {
    const wsToken = vi.fn(async () => {
      throw new Error("nope");
    });
    const { lt, sched } = makeLiveTail({ hubClient: { wsToken } });
    lt.start("h", "s", () => {});
    await flush();
    expect(FakeSocket.instances.length).toBe(0);
    expect(sched.count()).toBe(1);
  });
});
