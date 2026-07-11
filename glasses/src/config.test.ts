import { describe, expect, it } from "vitest";
import {
  CONFIG_STORAGE_KEY,
  LEGACY_CONFIG_STORAGE_KEY,
  loadConfig,
  saveConfig,
  type Config,
} from "./config.ts";
import type { KeyValueStorage } from "./storage.ts";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    async get(key: string): Promise<string | null> {
      return store[key] ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      store[key] = value;
    },
  };
}

const creds = (over: Partial<Config> = {}): string =>
  JSON.stringify({ user: "u", password: "p", pollMs: 6000, ...over });

describe("loadConfig legacy key migration", () => {
  it("reads credentials stored under the pre-Turma key when the new key is empty", async () => {
    const storage = fakeStorage({ [LEGACY_CONFIG_STORAGE_KEY]: creds() });
    const cfg = await loadConfig(storage);
    expect(cfg.user).toBe("u");
    expect(cfg.password).toBe("p");
  });

  it("re-saves the migrated value under the new key so the fallback is one-time", async () => {
    const storage = fakeStorage({ [LEGACY_CONFIG_STORAGE_KEY]: creds() });
    await loadConfig(storage);
    expect(storage.store[CONFIG_STORAGE_KEY]).toBe(creds());
  });

  it("prefers the new key over the legacy key when both exist", async () => {
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: creds({ user: "new" }),
      [LEGACY_CONFIG_STORAGE_KEY]: creds({ user: "old" }),
    });
    const cfg = await loadConfig(storage);
    expect(cfg.user).toBe("new");
  });

  it("returns the empty config when neither key is present", async () => {
    const storage = fakeStorage();
    const cfg = await loadConfig(storage);
    expect(cfg.user).toBe("");
    expect(cfg.password).toBe("");
  });

  it("round-trips a saved config without touching the legacy key", async () => {
    const storage = fakeStorage();
    await saveConfig(storage, { hubUrl: "", user: "a", password: "b", pollMs: 6000 });
    expect(storage.store[LEGACY_CONFIG_STORAGE_KEY]).toBeUndefined();
    const cfg = await loadConfig(storage);
    expect(cfg.user).toBe("a");
  });
});
