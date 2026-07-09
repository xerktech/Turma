// Hardware-agnostic key/value persistence. Task 6 swaps in a bridge-backed
// implementation (glasses `bridge.setLocalStorage`/`getLocalStorage`) once the
// real Even Hub SDK display backend lands; this app only ever depends on the
// interface below.
export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// Dev/browser implementation backed by window.localStorage.
export class BrowserStorage implements KeyValueStorage {
  async get(key: string): Promise<string | null> {
    return window.localStorage.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    window.localStorage.setItem(key, value);
  }
}

// Structural stand-in for the slice of `EvenAppBridge` this class calls —
// no SDK import needed here (a real bridge satisfies this shape).
export interface StorageBridge {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

// Bridge-backed implementation for the real Even Hub hardware path.
// `bridge.setLocalStorage`/`getLocalStorage` persist across Even app
// restarts, unlike `window.localStorage`/IndexedDB in this WebView (see
// device-features skill) — that unreliability is why this class exists
// instead of just reusing BrowserStorage on-device.
export class BridgeStorage implements KeyValueStorage {
  constructor(private readonly bridge: StorageBridge) {}

  async get(key: string): Promise<string | null> {
    try {
      const raw = await this.bridge.getLocalStorage(key);
      // getLocalStorage resolves "" when the key doesn't exist (per the SDK
      // reference) — treat that as a miss, same as BrowserStorage's null.
      return raw ? raw : null;
    } catch (err) {
      console.error("[glasses] getLocalStorage failed:", err);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.bridge.setLocalStorage(key, value);
    } catch (err) {
      console.error("[glasses] setLocalStorage failed:", err);
    }
  }
}
