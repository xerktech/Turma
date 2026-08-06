// KeyValueStorage over the miniapp SDK's session.storage (phone-local KV,
// MMKV-backed, scoped to this miniapp). Replaces upstream's BridgeStorage;
// the same config key (`turma.glasses.config`, config.ts) is used, so the
// storage contract is unchanged from the app's point of view.

import type { KeyValueStorage } from "../core/storage.ts";

export interface StorageSessionLike {
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
}

export class MentraStorage implements KeyValueStorage {
  constructor(private readonly session: StorageSessionLike) {}

  async get(key: string): Promise<string | null> {
    try {
      const raw = await this.session.storage.get(key);
      // Missing keys resolve null from the SDK already; treat "" as a miss
      // too, mirroring upstream BridgeStorage's semantics.
      return raw ? raw : null;
    } catch (err) {
      console.error("[turma] storage.get failed:", err);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.session.storage.set(key, value);
    } catch (err) {
      console.error("[turma] storage.set failed:", err);
    }
  }
}
