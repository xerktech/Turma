import { describe, expect, it, vi } from "vitest";
import { initPhoneLogin, signOut, type PhoneLoginElements } from "./phone-login.ts";
import { CONFIG_STORAGE_KEY } from "./config.ts";
import type { KeyValueStorage } from "./storage.ts";

// The hub an operator types on the login page. There is no shipped default any
// more, so the tests name their own host exactly as a device would.
const HUB = "https://turma.example.com";

// DOM-less tests of the phone login controller: `initPhoneLogin` takes plain
// objects satisfying `PhoneLoginElements`, and `onSignedIn`/`reload`/`fetchFn`
// are injectable, so no jsdom/browser globals are needed.

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

function fakeForm(): HTMLFormElement & { submit: () => void } {
  let handler: ((e: { preventDefault: () => void }) => void) | null = null;
  return {
    addEventListener: (_event: string, cb: (e: { preventDefault: () => void }) => void) => {
      handler = cb;
    },
    submit: () => handler?.({ preventDefault: () => {} }),
  } as unknown as HTMLFormElement & { submit: () => void };
}

function fakeButton(): HTMLButtonElement {
  return { disabled: false, textContent: "" } as unknown as HTMLButtonElement;
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
  login: ReturnType<typeof fakeHidable>;
  app: ReturnType<typeof fakeHidable>;
  error: ReturnType<typeof fakeError>;
};

function fakeEls(): Els {
  return {
    login: fakeHidable(),
    app: fakeHidable(),
    form: fakeForm(),
    url: fakeInput(),
    user: fakeInput(),
    password: fakeInput(),
    submit: fakeButton(),
    error: fakeError(),
  } as unknown as Els;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stubFetch(status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(status === 200 ? "{}" : "no", { status }));
}

const storedCreds = () => ({
  [CONFIG_STORAGE_KEY]: JSON.stringify({ hubUrl: HUB, user: "u", password: "p", pollMs: 6000 }),
});

describe("initPhoneLogin", () => {
  it("shows the login card and does not signal signed-in when no credentials are stored", async () => {
    const els = fakeEls();
    const onSignedIn = vi.fn();
    await initPhoneLogin(fakeStorage(), onSignedIn, els, stubFetch() as unknown as typeof fetch, vi.fn());
    expect(els.login.hidden).toBe(false);
    expect(els.app.hidden).toBe(true);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("when already signed in, reveals the native app shell and signals onSignedIn (no iframe, no cookie refresh)", async () => {
    const els = fakeEls();
    const onSignedIn = vi.fn();
    const fetchFn = stubFetch();
    await initPhoneLogin(fakeStorage(storedCreds()), onSignedIn, els, fetchFn as unknown as typeof fetch, vi.fn());
    await flushMicrotasks();

    expect(els.login.hidden).toBe(true);
    expect(els.app.hidden).toBe(false);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    // The native UI authenticates its own HubClient with Basic auth — being
    // already signed in makes no network call.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts /api/login with the typed hub URL, persists it with the creds, then reloads on a good sign-in", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, vi.fn(), els, fetchFn as unknown as typeof fetch, reload);
    els.url.value = HUB;
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledWith(
      `${HUB}/api/login`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ username: "u", password: "p" }),
      })
    );
    const saved = JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string);
    expect(saved).toMatchObject({ hubUrl: HUB, user: "u", password: "p" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("prefills the stored hub URL so it is typed once per device, not once per sign-in", async () => {
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ hubUrl: HUB, user: "u", password: "", pollMs: 6000 }),
    });
    const els = fakeEls();
    await initPhoneLogin(storage, vi.fn(), els, stubFetch() as unknown as typeof fetch, vi.fn());

    expect(els.login.hidden).toBe(false);
    expect(els.url.value).toBe(HUB);
    expect(els.user.value).toBe("u");
  });

  it("normalizes a hand-typed host: adds the https scheme and drops a trailing slash", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, vi.fn(), els, fetchFn as unknown as typeof fetch, vi.fn());
    els.url.value = "  turma.example.com/  ";
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledWith(`${HUB}/api/login`, expect.anything());
    expect(JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string).hubUrl).toBe(HUB);
  });

  it("refuses a blank hub URL without calling fetch or persisting", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, vi.fn(), els, fetchFn as unknown as typeof fetch, vi.fn());
    els.url.value = "   ";
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(els.error.textContent).toMatch(/enter the url/i);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(storage.store[CONFIG_STORAGE_KEY]).toBeUndefined();
    expect(els.submit.disabled).toBe(false);
  });

  it("shows an incorrect-credentials error on a 401 and does not persist or reload", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();

    await initPhoneLogin(storage, vi.fn(), els, stubFetch(401) as unknown as typeof fetch, reload);
    els.url.value = HUB;
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

  it("shows a reachability error when the hub can't be reached during sign-in", async () => {
    const els = fakeEls();
    const reload = vi.fn();
    const fetchThrows = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await initPhoneLogin(fakeStorage(), vi.fn(), els, fetchThrows, reload);
    els.url.value = HUB;
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(els.error.textContent).toMatch(/couldn't reach/i);
    expect(els.error.textContent).toContain(HUB);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("clears the hub cookie and stored creds but KEEPS the hub URL, then reloads", async () => {
    const storage = fakeStorage(storedCreds());
    const reload = vi.fn();
    const fetchFn = stubFetch(200);

    await signOut(storage, fetchFn as unknown as typeof fetch, reload);

    expect(fetchFn).toHaveBeenCalledWith(
      `${HUB}/api/logout`,
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    const saved = JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string);
    expect(saved.hubUrl).toBe(HUB); // kept, so signing back in only needs the password
    expect(saved.user).toBe("");
    expect(saved.password).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still clears creds and reloads when the logout request fails (offline)", async () => {
    const storage = fakeStorage(storedCreds());
    const reload = vi.fn();
    const fetchThrows = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await signOut(storage, fetchThrows, reload);

    expect(JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string).password).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
