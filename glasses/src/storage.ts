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
