import { describe, expect, it } from "vitest";
import {
  CONFIG_STORAGE_KEY,
  isConfigured,
  LEGACY_CONFIG_STORAGE_KEY,
  loadConfig,
  normalizeHubUrl,
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

describe("normalizeHubUrl", () => {
  it("defaults a missing scheme to https (a phone keyboard omits it)", () => {
    expect(normalizeHubUrl("turma.example.com")).toBe("https://turma.example.com");
  });

  it("leaves an explicit scheme alone, including http for a LAN hub", () => {
    expect(normalizeHubUrl("http://192.168.1.10:8300")).toBe("http://192.168.1.10:8300");
    expect(normalizeHubUrl("https://turma.example.com")).toBe("https://turma.example.com");
  });

  it("trims surrounding space and strips trailing slashes so callers can append paths", () => {
    expect(normalizeHubUrl("  https://turma.example.com//  ")).toBe("https://turma.example.com");
  });

  it("maps blank input to blank rather than a bare scheme", () => {
    expect(normalizeHubUrl("")).toBe("");
    expect(normalizeHubUrl("   ")).toBe("");
  });
});

describe("loadConfig hub URL", () => {
  const stored = (hubUrl: unknown): Record<string, string> => ({
    [CONFIG_STORAGE_KEY]: JSON.stringify({ hubUrl, user: "u", password: "p", pollMs: 6000 }),
  });

  it("honors the stored hub URL — the whole point of persisting it", async () => {
    const cfg = await loadConfig(fakeStorage(stored("https://hub.example.org")));
    expect(cfg.hubUrl).toBe("https://hub.example.org");
  });

  it("normalizes the stored value, so a config saved by an older build still works", async () => {
    const cfg = await loadConfig(fakeStorage(stored("https://hub.example.org/")));
    expect(cfg.hubUrl).toBe("https://hub.example.org");
  });

  it("has no baked-in host: an unconfigured device loads a blank hub URL", async () => {
    const cfg = await loadConfig(fakeStorage());
    expect(cfg.hubUrl).toBe("");
  });

  it("falls back to blank when the stored hub URL is the wrong type", async () => {
    const cfg = await loadConfig(fakeStorage(stored(42)));
    expect(cfg.hubUrl).toBe("");
  });
});

describe("isConfigured", () => {
  const cfg = (over: Partial<Config> = {}): Config => ({
    hubUrl: "https://turma.example.com",
    user: "u",
    password: "p",
    pollMs: 6000,
    ...over,
  });

  it("is true only once a hub and both credentials are present", () => {
    expect(isConfigured(cfg())).toBe(true);
  });

  it("is false when any one of them is missing", () => {
    expect(isConfigured(cfg({ hubUrl: "" }))).toBe(false);
    expect(isConfigured(cfg({ user: "" }))).toBe(false);
    expect(isConfigured(cfg({ password: "" }))).toBe(false);
  });
});
