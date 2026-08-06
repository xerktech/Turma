// Hardware-agnostic key/value persistence. The Mentra port swaps in a
// `session.storage`-backed implementation (background/storage.ts) on the
// background side and an RPC-proxied one (ui/rpc-storage.ts) on the phone
// WebView side; this app only ever depends on the interface below.
//
// not ported: upstream's BridgeStorage (Even Hub `bridge.setLocalStorage`) —
// Even-runtime specific; MentraStorage (background/storage.ts) replaces it.
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
