// KeyValueStorage proxied over the channel bus to the background JSContext's
// session.storage — so the UI-side config code (core/config.ts, phone-login)
// reads/writes the exact same persisted `turma.glasses.config` record the
// background boots from.
//
// Timeouts (XERK-215): the channel RPC has no default timeout, so a lost
// reply would otherwise hang loadConfig — and with it applyView/initPhoneLogin
// — forever, with nothing on screen to say why. A rejection is recoverable
// (the next phase event re-runs applyView); a hang is not.

import type { KeyValueStorage } from "../core/storage.ts";
import "../shared/channels.ts";

const STORAGE_RPC_TIMEOUT_MS = 10_000;

export class RpcStorage implements KeyValueStorage {
  async get(key: string): Promise<string | null> {
    const res = await mentra.request("turma:storage-get", { key }, { timeout: STORAGE_RPC_TIMEOUT_MS });
    return res.value;
  }

  async set(key: string, value: string): Promise<void> {
    await mentra.request("turma:storage-set", { key, value }, { timeout: STORAGE_RPC_TIMEOUT_MS });
  }
}
