// KeyValueStorage proxied over the channel bus to the background JSContext's
// session.storage — so the UI-side config code (core/config.ts, phone-login)
// reads/writes the exact same persisted `turma.glasses.config` record the
// background boots from.

import type { KeyValueStorage } from "../core/storage.ts";
import "../shared/channels.ts";

export class RpcStorage implements KeyValueStorage {
  async get(key: string): Promise<string | null> {
    const res = await mentra.request("turma:storage-get", { key });
    return res.value;
  }

  async set(key: string, value: string): Promise<void> {
    await mentra.request("turma:storage-set", { key, value });
  }
}
