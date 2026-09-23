import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_TIMEOUT_MS, resolveBridge, type ResolvedBridge } from "./bridge.ts";

// XERK-921: the SDK's waitForEvenAppBridge() resolves in any browser, so the
// bridge path is taken only once a host (flutter_inappwebview) is present.
const bridge = { tag: "bridge" } as unknown as ResolvedBridge;
const sdk = (wait: () => Promise<ResolvedBridge>) => async () => ({ waitForEvenAppBridge: wait });
const g = globalThis as { flutter_inappwebview?: unknown };
const injectHost = () => { g.flutter_inappwebview = { callHandler: async () => null }; };

describe("resolveBridge", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); delete g.flutter_inappwebview; });

  it("takes the bridge at once when a host is present", async () => {
    injectHost();
    await expect(resolveBridge(sdk(async () => bridge))).resolves.toBe(bridge);
  });

  it("falls back to the DOM backend when the bridge resolves with no host", async () => {
    const p = resolveBridge(sdk(async () => bridge));
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS);
    await expect(p).resolves.toBeNull();
  });

  it("waits out the timeout window for a host injected late", async () => {
    const p = resolveBridge(sdk(async () => bridge));
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS - 100);
    injectHost();
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe(bridge);
  });

  it("does not count a host without a callable callHandler", async () => {
    g.flutter_inappwebview = { callHandler: "nope" };
    const p = resolveBridge(sdk(async () => bridge));
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS);
    await expect(p).resolves.toBeNull();
  });

  it("falls back when the bridge never resolves", async () => {
    injectHost();
    const p = resolveBridge(sdk(() => new Promise<ResolvedBridge>(() => {})));
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS);
    await expect(p).resolves.toBeNull();
  });

  it("falls back when the SDK fails to load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveBridge(async () => { throw new Error("no sdk"); })).resolves.toBeNull();
  });
});
