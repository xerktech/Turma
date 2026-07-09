import { describe, expect, it } from "vitest";
import { BridgeStorage, type StorageBridge } from "./storage.ts";

function fakeBridge(initial: Record<string, string> = {}): StorageBridge & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    async getLocalStorage(key: string): Promise<string> {
      return store[key] ?? "";
    },
    async setLocalStorage(key: string, value: string): Promise<boolean> {
      store[key] = value;
      return true;
    },
  };
}

describe("BridgeStorage", () => {
  it("get returns null when the key is missing (empty-string miss)", async () => {
    const storage = new BridgeStorage(fakeBridge());
    expect(await storage.get("missing")).toBeNull();
  });

  it("set then get round-trips a JSON string value through the bridge", async () => {
    const bridge = fakeBridge();
    const storage = new BridgeStorage(bridge);
    const value = JSON.stringify({ hubUrl: "https://agents.example.com", pollMs: 6000 });

    await storage.set("agenthub.glasses.config", value);
    expect(bridge.store["agenthub.glasses.config"]).toBe(value);

    const raw = await storage.get("agenthub.glasses.config");
    expect(raw).toBe(value);
    expect(JSON.parse(raw as string)).toEqual({ hubUrl: "https://agents.example.com", pollMs: 6000 });
  });

  it("get returns null and does not throw when the bridge rejects", async () => {
    const bridge: StorageBridge = {
      getLocalStorage: async () => {
        throw new Error("bridge unavailable");
      },
      setLocalStorage: async () => true,
    };
    const storage = new BridgeStorage(bridge);
    await expect(storage.get("k")).resolves.toBeNull();
  });

  it("set does not throw when the bridge rejects", async () => {
    const bridge: StorageBridge = {
      getLocalStorage: async () => "",
      setLocalStorage: async () => {
        throw new Error("bridge unavailable");
      },
    };
    const storage = new BridgeStorage(bridge);
    await expect(storage.set("k", "v")).resolves.toBeUndefined();
  });
});
