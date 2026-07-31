import { describe, expect, it, vi } from "vitest";
import { initPhoneLogin, type PhoneLoginElements } from "./phone-login.ts";
import { CONFIG_STORAGE_KEY } from "./config.ts";
import type { KeyValueStorage } from "./storage.ts";

// The hub an operator types on the login page. There is no shipped default
// any more, so the tests name their own host exactly as a device would.
const HUB = "https://turma.example.com";

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
  dashboard: { src: string };
  error: ReturnType<typeof fakeError>;
  appUser: { textContent: string };
};

function fakeEls(): Els {
  return {
    login: fakeHidable(),
    app: fakeHidable(),
    dashboard: { src: "" } as unknown as HTMLIFrameElement,
    form: fakeForm(),
    url: fakeInput(),
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

// A fetch stub that records calls and returns a status by URL substring.
function stubFetch(status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(status === 200 ? "{}" : "no", { status }));
}

const storedCreds = () => ({
  [CONFIG_STORAGE_KEY]: JSON.stringify({ hubUrl: HUB, user: "u", password: "p", pollMs: 6000 }),
});

describe("initPhoneLogin", () => {
  it("shows the login card and hides the app when no credentials are stored", async () => {
    const els = fakeEls();
    await initPhoneLogin(fakeStorage(), els, stubFetch() as unknown as typeof fetch, vi.fn());
    expect(els.login.hidden).toBe(false);
    expect(els.app.hidden).toBe(true);
  });

  it("when already signed in, refreshes the cookie and points the iframe at the hub", async () => {
    const els = fakeEls();
    const fetchFn = stubFetch();
    await initPhoneLogin(fakeStorage(storedCreds()), els, fetchFn as unknown as typeof fetch, vi.fn());
    await flushMicrotasks();

    // Cookie refreshed via /api/login with credentials included.
    expect(fetchFn).toHaveBeenCalledWith(
      `${HUB}/api/login`,
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(els.login.hidden).toBe(true);
    expect(els.app.hidden).toBe(false);
    expect(els.appUser.textContent).toBe("u");
    expect(els.dashboard.src).toBe(`${HUB}/`);
  });

  it("still shows the dashboard iframe when the cookie refresh fails (offline)", async () => {
    const els = fakeEls();
    const fetchThrows = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await initPhoneLogin(fakeStorage(storedCreds()), els, fetchThrows, vi.fn());
    await flushMicrotasks();
    expect(els.app.hidden).toBe(false);
    expect(els.dashboard.src).toBe(`${HUB}/`);
  });

  it("posts /api/login with the typed hub URL, persists it with the creds, then reloads on a good sign-in", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, els, fetchFn as unknown as typeof fetch, reload);
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
    // Signed-out-but-configured: the creds are gone, the hub is not.
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ hubUrl: HUB, user: "u", password: "", pollMs: 6000 }),
    });
    const els = fakeEls();
    await initPhoneLogin(storage, els, stubFetch() as unknown as typeof fetch, vi.fn());

    expect(els.login.hidden).toBe(false);
    expect(els.url.value).toBe(HUB);
    expect(els.user.value).toBe("u");
  });

  it("normalizes a hand-typed host: adds the https scheme and drops a trailing slash", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, els, fetchFn as unknown as typeof fetch, vi.fn());
    els.url.value = "  turma.example.com/  ";
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    // Both the request and the persisted copy get the normalized form, so the
    // stored value is directly reusable as a base for path concatenation.
    expect(fetchFn).toHaveBeenCalledWith(`${HUB}/api/login`, expect.anything());
    expect(JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string).hubUrl).toBe(HUB);
  });

  it("refuses a blank hub URL without calling fetch or persisting", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, els, fetchFn as unknown as typeof fetch, vi.fn());
    els.url.value = "   ";
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(els.error.textContent).toMatch(/enter the url/i);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(storage.store[CONFIG_STORAGE_KEY]).toBeUndefined();
    // The button must be usable again — a blank URL is a correctable mistake.
    expect(els.submit.disabled).toBe(false);
  });

  it("keeps the hub URL on sign-out so signing back in only needs the password", async () => {
    const storage = fakeStorage(storedCreds());
    const els = fakeEls();

    await initPhoneLogin(storage, els, stubFetch(200) as unknown as typeof fetch, vi.fn());
    await flushMicrotasks();
    els.signOut.click();
    await flushMicrotasks();

    expect(JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string).hubUrl).toBe(HUB);
  });

  it("shows an incorrect-credentials error on a 401 and does not persist or reload", async () => {
    const storage = fakeStorage();
    const els = fakeEls();
    const reload = vi.fn();

    await initPhoneLogin(storage, els, stubFetch(401) as unknown as typeof fetch, reload);
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

    await initPhoneLogin(fakeStorage(), els, fetchThrows, reload);
    els.url.value = HUB;
    els.user.value = "u";
    els.password.value = "p";
    els.form.submit();
    await flushMicrotasks();

    expect(els.error.textContent).toMatch(/couldn't reach/i);
    expect(els.error.textContent).toContain(HUB);
    expect(reload).not.toHaveBeenCalled();
  });

  it("Sign out clears the hub cookie, clears stored creds, and reloads", async () => {
    const storage = fakeStorage(storedCreds());
    const els = fakeEls();
    const reload = vi.fn();
    const fetchFn = stubFetch(200);

    await initPhoneLogin(storage, els, fetchFn as unknown as typeof fetch, reload);
    await flushMicrotasks();
    els.signOut.click();
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledWith(
      `${HUB}/api/logout`,
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    const saved = JSON.parse(storage.store[CONFIG_STORAGE_KEY] as string);
    expect(saved.user).toBe("");
    expect(saved.password).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
