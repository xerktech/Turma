import { describe, expect, it, vi } from "vitest";
import { initPhoneSettings, type PhoneSettingsElements } from "./phone-settings.ts";
import { CONFIG_STORAGE_KEY } from "./config.ts";
import type { KeyValueStorage } from "./storage.ts";

// Config is read once at boot (main.ts); Save previously only wrote storage,
// so first-run onboarding kept polling with the empty config it started with
// until a full app restart. This is a DOM-less test of the save handler's
// wiring — `initPhoneSettings` takes plain objects satisfying
// `PhoneSettingsElements`, and `reload` is injectable, so no jsdom/browser
// globals are needed.

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

function fakeInput(value = ""): HTMLInputElement {
  return { value } as unknown as HTMLInputElement;
}

function fakeButton(): HTMLButtonElement & { click: () => void } {
  let handler: (() => void) | null = null;
  return {
    addEventListener: (_event: string, cb: () => void) => {
      handler = cb;
    },
    click: () => handler?.(),
  } as unknown as HTMLButtonElement & { click: () => void };
}

function fakeEls(): PhoneSettingsElements & {
  save: ReturnType<typeof fakeButton>;
  test: ReturnType<typeof fakeButton>;
  status: { textContent: string };
} {
  return {
    hubUrl: fakeInput(),
    user: fakeInput(),
    password: fakeInput(),
    save: fakeButton(),
    test: fakeButton(),
    status: { textContent: "" } as unknown as HTMLElement,
  } as PhoneSettingsElements & {
    save: ReturnType<typeof fakeButton>;
    test: ReturnType<typeof fakeButton>;
    status: { textContent: string };
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("initPhoneSettings", () => {
  it("Save persists the form to storage and reloads the app so the running config picks it up", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();

    // initPhoneSettings populates the form from storage on load — set the
    // fields (as if the user edited them) only after that load completes.
    await initPhoneSettings(storage, els, vi.fn() as unknown as typeof fetch, reload);
    els.hubUrl.value = "https://hub.example.com";
    els.user.value = "u";
    els.password.value = "p";
    els.save.click();
    await flushMicrotasks();

    const saved = storage.store[CONFIG_STORAGE_KEY];
    expect(saved).toBeDefined();
    expect(JSON.parse(saved as string)).toMatchObject({
      hubUrl: "https://hub.example.com",
      user: "u",
      password: "p",
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(els.status.textContent).toBe("Saved — reloading…");
  });

  it("does not reload before the save actually completes", async () => {
    let resolveSet!: () => void;
    const storage: KeyValueStorage = {
      get: async () => null,
      set: () =>
        new Promise<void>((resolve) => {
          resolveSet = resolve;
        }),
    };
    const els = fakeEls();
    const reload = vi.fn();

    await initPhoneSettings(storage, els, vi.fn() as unknown as typeof fetch, reload);
    els.save.click();
    await flushMicrotasks();

    expect(reload).not.toHaveBeenCalled();
    resolveSet();
    await flushMicrotasks();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
