// Deciding which hardware backend main.ts wires up: the Even Hub SDK bridge,
// or null for the DOM dev backend. The SDK is only ever touched through the
// dynamic `import()` in importSdk — see main.ts's header.

export const BRIDGE_TIMEOUT_MS = 2000;

export function importSdk() {
  return import("@evenrealities/even_hub_sdk");
}

// A structural stand-in for the awaited `waitForEvenAppBridge()` result —
// deliberately untyped against the SDK (see main.ts's header): every consumer
// (EvenHubDisplay, BridgeStorage, the input router) declares its own minimal
// structural interface instead, and the real bridge satisfies all of them.
export type ResolvedBridge = Awaited<ReturnType<Awaited<ReturnType<typeof importSdk>>["waitForEvenAppBridge"]>>;

// The native side of the bridge. The SDK sends every call through
// `window.flutter_inappwebview.callHandler`, which only a real host injects —
// the Even Realities WebView, or the simulator's shim.
export function hostPresent(): boolean {
  const host = (globalThis as { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview;
  return typeof host?.callHandler === "function";
}

// Races bridge resolution against a timeout so a plain browser (no Even
// Realities WebView host) never hangs waiting for a bridge that will never
// arrive. Any import/resolution failure is treated the same as a timeout.
//
// `waitForEvenAppBridge()` resolves in ANY browser — the SDK builds its bridge
// object whether or not a host is there to answer it (XERK-921) — so a
// resolved bridge only counts once the host is present. A host that is late
// gets the rest of the timeout window before we fall back to the DOM backend.
export async function resolveBridge(
  load: () => Promise<{ waitForEvenAppBridge(): Promise<ResolvedBridge> }> = importSdk,
): Promise<ResolvedBridge | null> {
  try {
    const mod = await load();
    const bridgePromise = mod.waitForEvenAppBridge();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS));
    const bridge = await Promise.race([bridgePromise, timeout]);
    if (bridge && !hostPresent()) {
      await timeout;
      if (!hostPresent()) return null;
    }
    return bridge;
  } catch (err) {
    console.warn("[glasses] Even Hub SDK unavailable, falling back to the DOM dev backend:", err);
    return null;
  }
}
