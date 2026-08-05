// Phone-side login page (index.html) — plain DOM, no framework. This is what the
// user sees on their phone while the WebView is open; it mirrors the web
// dashboard's login (turma/public/login.html), plus a hub URL field: the hub is
// self-hosted, so there is no default host this app could assume.
//
// The URL is persisted alongside the credentials (BridgeStorage survives Even app
// restarts), so it is typed once per device and prefilled thereafter — including
// across a sign-out, which clears the credentials but deliberately keeps the hub.
//
// On sign-in it POSTs /api/login (like the web login) to VALIDATE the password,
// then persists the credentials — the native phone UI (XERK-171) polls the hub
// with Basic auth from those creds — and reloads so the app boots signed-in. On
// success `onSignedIn()` reveals the native app shell and the caller mounts the
// phone UI into it (boot() in main.ts). There is no embedded dashboard iframe any
// more; the phone screen is the dedicated native interface.
import {
  authHeader,
  isConfigured,
  loadConfig,
  normalizeHubUrl,
  resolveHubUrl,
  saveConfig,
  type Config,
} from "../core/config.ts";
import type { KeyValueStorage } from "../core/storage.ts";

export interface PhoneLoginElements {
  login: HTMLElement; // the login card
  app: HTMLElement; // the signed-in app shell (holds #phone)
  form: HTMLFormElement;
  url: HTMLInputElement;
  user: HTMLInputElement;
  password: HTMLInputElement;
  submit: HTMLButtonElement;
  error: HTMLElement;
}

export function queryPhoneLoginElements(doc: Document = document): PhoneLoginElements {
  const byId = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`phone-login: missing #${id}`);
    return el as T;
  };
  return {
    login: byId("login"),
    app: byId("app"),
    form: byId("login-form"),
    url: byId("hub-url"),
    user: byId("hub-user"),
    password: byId("hub-password"),
    submit: byId("login-submit"),
    error: byId("login-error"),
  };
}

function hubBase(config: Pick<Config, "hubUrl">): string {
  return config.hubUrl.replace(/\/$/, "");
}

// POSTs the web dashboard's own login endpoint with the credentials to validate
// them (200 ok / 401 bad creds). Throws only on a network-level failure.
async function postLogin(config: Config, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(`${hubBase(config)}/api/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: config.user, password: config.password }),
  });
}

function showError(els: PhoneLoginElements, msg: string): void {
  els.error.textContent = msg;
  els.error.classList.add("show");
}

function showApp(els: PhoneLoginElements): void {
  els.login.hidden = true;
  els.app.hidden = false;
}

function showLogin(els: PhoneLoginElements, config: Config): void {
  els.url.value = config.hubUrl;
  els.user.value = config.user;
  els.login.hidden = false;
  els.app.hidden = true;
}

// Clears the credentials (keeping the hub URL) and reloads back to the login card.
export async function signOut(
  storage: KeyValueStorage,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  reload: () => void = () => location.reload()
): Promise<void> {
  const config = await loadConfig(storage);
  try {
    await fetchFn(`${hubBase(config)}/api/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* best-effort */
  }
  await saveConfig(storage, { ...config, user: "", password: "" });
  reload();
}

export async function initPhoneLogin(
  storage: KeyValueStorage,
  onSignedIn: () => void,
  els: PhoneLoginElements = queryPhoneLoginElements(),
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  // The app reads config once at boot (main.ts); after we persist new credentials
  // we reload so it re-reads them and boots signed-in.
  reload: () => void = () => location.reload()
): Promise<void> {
  const config = await loadConfig(storage);

  if (isConfigured(config)) {
    showApp(els);
    onSignedIn();
  } else {
    showLogin(els, config);
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      els.error.classList.remove("show");
      const typedUrl = normalizeHubUrl(els.url.value);
      const hubUrl = resolveHubUrl() || typedUrl;
      if (!hubUrl) {
        showError(els, "Enter the URL of your Turma hub.");
        return;
      }
      els.submit.disabled = true;
      els.submit.textContent = "Signing in…";
      const candidate: Config = {
        hubUrl,
        user: els.user.value,
        password: els.password.value,
        pollMs: config.pollMs,
      };
      let res: Response;
      try {
        res = await postLogin(candidate, fetchFn);
      } catch {
        showError(els, `Couldn't reach ${hubUrl}. Check the URL and your connection.`);
        els.submit.disabled = false;
        els.submit.textContent = "Sign in";
        return;
      }
      if (!res.ok) {
        showError(
          els,
          res.status === 401 ? "Incorrect username or password." : "Sign-in failed. Please try again."
        );
        els.submit.disabled = false;
        els.submit.textContent = "Sign in";
        return;
      }
      // Persist so the native UI's Basic-auth polling picks the creds up, then
      // reload into the signed-in app shell.
      await saveConfig(storage, candidate);
      reload();
    })();
  });
}

// Re-exported for callers that just need the header without the DOM glue.
export { authHeader };
