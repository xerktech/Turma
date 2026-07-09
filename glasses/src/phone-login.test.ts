import { describe, expect, it, vi } from "vitest";
import { initPhoneLogin, type PhoneLoginElements } from "./phone-login.ts";
import { CONFIG_STORAGE_KEY, DEFAULT_HUB_URL } from "./config.ts";
import type { KeyValueStorage } from "./storage.ts";

// DOM-less tests of the phone login controller: `initPhoneLogin` takes plain
// objects satisfying `PhoneLoginElements`, and `reload`/`fetchFn` are
// injectable, so no jsdom/browser globals are needed.

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

// A form whose registered submit listener we can fire directly.
function fakeForm(): HTMLFormElement & { submit: () => void } {
  let handler: ((e: { preventDefault: () => void }) => void) | null = null;
  return {
    addEventListener: (_event: string, cb: (e: { preventDefault: () => void }) => void) => {
      handler = cb;
    },
    submit: () => handler?.({ preventDefault: () => {} }),
  } as unknown as HTMLFormElement & { submit: () => void };
}

function fakeButton(): HTMLButtonElement & { click: () => void } {
  let handler: (() => void) | null = null;
  return {
    disabled: false,
    textContent: "",
    addEventListener: (_event: string, cb: () => void) => {
      handler = cb;
    },
    click: () => handler?.(),
  } as unknown as HTMLButtonElement & { click: () => void };
}

function fakeHidable(): HTMLElement & { hidden: boolean } {
  return { hidden: false } as unknown as HTMLElement & { hidden: boolean };
}

function fakeError(): HTMLElement & { textContent: string; classList: { add: (c: string) => void; remove: (c: string) => void; has: boolean } } {
  const classes = new Set<string>();
  return {
    textContent: "",
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      get has() {
        return classes.has("show");
      },
    },
  } as unknown as HTMLElement & { textContent: string; classList: { add: (c: string) => void; remove: (c: string) => void; has: boolean } };
}

type Els = PhoneLoginElements & {
  form: ReturnType<typeof fakeForm>;
  submit: ReturnType<typeof fakeButton>;
  signOut: ReturnType<typeof fakeButton>;
  login: ReturnType<typeof fakeHidable>;
  app: ReturnType<typeof fakeHidable>;
  error: ReturnType<typeof fakeError>;
  appUser: { textContent: string };
};

function fakeEls(): Els {
  return {
    login: fakeHidable(),
    app: fakeHidable(),
    form: fakeForm(),
    user: fakeInput(),
    password: fakeInput(),
    submit: fakeButton(),
    error: fakeError(),
    signOut: fakeButton(),
    appUser: { textContent: "" } as unknown as HTMLElement,
  } as unknown as Els;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const okFetch = () =>
  vi.fn(async () => new Response(JSON.stringify({ now: 0, agents: [] }), { status: 200 })) as unknown as typeof fetch;

describe("initPhoneLogin", () => {
  it("shows the login card and hides the app when no credentials are stored", async () => {
    const els = fakeEls();
    await initPhoneLogin(fakeStorage(), els, okFetch(), vi.fn());
    expect(els.login.hidden).toBe(false);
    expect(els.app.hidden).toBe(true);
  });

  it("shows the signed-in mirror when credentials are already stored", async () => {
    const stored = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ user: "u", password: "p", pollMs: 6000 }),
    });
    const els = fakeEls();
    await initPhoneLogin(stored, els, okFetch(), vi.fn());
    expect(els.login.hidden).toBe(true);
    expect(els.app.hidden).toBe(false);
    expect(els.appUser.textContent).toBe("u");
  });

  it("validates, persists the hardcoded hub URL + creds, then reloads on a good sign-in", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();

    await initPhoneLogin(storage, els, okFetch(), reload);
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    const saved = JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string);
    expect(saved).toMatchObject({ hubUrl: DEFAULT_HUB_URL, user: "u", password: "p" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows an incorrect-credentials error on a 401 and does not persist or reload", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();
    const fetch401 = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;

    await initPhoneLogin(storage, els, fetch401, reload);
    els.user.value = "u";
    els.password.value = "wrong";
    els.form.submit();
    await flushMicrotasks();

    expect(els.error.textContent).toBe("Incorrect username or password.");
    expect(els.error.classList.has).toBe(true);
    expect(storage.store[CONFIG_STORAGE_KEY]).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(els.submit.disabled).toBe(false);
  });

  it("shows a reachability error (not a credential error) when the hub can't be reached", async () => {
    const els = fakeEls();
    const reload = vi.fn();
    const fetchThrows = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await initPhoneLogin(fakeStorage(), els, fetchThrows, reload);
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(els.error.textContent).toMatch(/couldn't reach the hub/i);
    expect(reload).not.toHaveBeenCalled();
  });

  it("Sign out clears the stored credentials and reloads", async () => {
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ user: "u", password: "p", pollMs: 6000 }),
    });
    const els = fakeEls();
    const reload = vi.fn();

    await initPhoneLogin(storage, els, okFetch(), reload);
    els.signOut.click();
    await flushMicrotasks();

    const saved = JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string);
    expect(saved.user).toBe("");
    expect(saved.password).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
