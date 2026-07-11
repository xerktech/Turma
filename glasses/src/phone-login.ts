// Phone-side login page (index.html) — plain DOM, no framework. This is what
// the user sees on their phone screen while the WebView is open; it mirrors
// the web dashboard's login (turma/public/login.html): the hub URL is
// hardcoded (config.ts `resolveHubUrl`), so it only collects a username and
// password.
//
// On sign-in it POSTs /api/login (like the web login) with credentials
// included, which both validates the password and sets the hub's session
// cookie (SameSite=None; Secure; Partitioned over HTTPS). It then persists the
// credentials — the glasses app itself polls the hub with Basic auth — and
// reloads. The signed-in view embeds the real hub dashboard in a full-bleed
// iframe; the cookie set during sign-in authenticates that cross-site iframe
// (the glasses keep rendering in parallel via the SDK, so navigating away is
// not an option). Sign out clears the cookie and the stored credentials.
import { authHeader, loadConfig, saveConfig, resolveHubUrl, type Config } from "./config.ts";
import type { KeyValueStorage } from "./storage.ts";

export interface PhoneLoginElements {
  login: HTMLElement; // the login card
  app: HTMLElement; // the signed-in view
  dashboard: HTMLIFrameElement; // embedded hub dashboard
  form: HTMLFormElement;
  user: HTMLInputElement;
  password: HTMLInputElement;
  submit: HTMLButtonElement;
  error: HTMLElement;
  signOut: HTMLButtonElement;
  appUser: HTMLElement;
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
    dashboard: byId("dashboard"),
    form: byId("login-form"),
    user: byId("hub-user"),
    password: byId("hub-password"),
    submit: byId("login-submit"),
    error: byId("login-error"),
    signOut: byId("sign-out"),
    appUser: byId("app-user"),
  };
}

function hubBase(config: Pick<Config, "hubUrl">): string {
  return config.hubUrl.replace(/\/$/, "");
}

// POSTs the web dashboard's own login endpoint with credentials included, so a
// success both proves the password and plants the session cookie the embedded
// dashboard iframe rides. Returns the raw Response (200 ok / 401 bad creds);
// throws only on a network-level failure.
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

// Reveals the signed-in view and points the dashboard iframe at the hub.
function showDashboard(els: PhoneLoginElements, config: Config): void {
  els.appUser.textContent = config.user;
  els.dashboard.src = `${hubBase(config)}/`;
  els.login.hidden = true;
  els.app.hidden = false;
}

function showLogin(els: PhoneLoginElements, config: Config): void {
  els.user.value = config.user;
  els.login.hidden = false;
  els.app.hidden = true;
}

export async function initPhoneLogin(
  storage: KeyValueStorage,
  els: PhoneLoginElements = queryPhoneLoginElements(),
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  // The app reads config once at boot (main.ts); after we persist new
  // credentials we reload so the running app re-reads them, exactly like the
  // web login lands you on the dashboard. Injectable so tests can assert the
  // wiring without a real WebView navigation.
  reload: () => void = () => location.reload()
): Promise<void> {
  const config = await loadConfig(storage);

  if (config.user && config.password) {
    // Already signed in: refresh the dashboard cookie (best-effort — if it
    // fails, the iframe falls back to the hub's own login page) and show the
    // embedded dashboard.
    try {
      await postLogin(config, fetchFn);
    } catch {
      /* offline / unreachable — show the iframe anyway; it handles its own auth */
    }
    showDashboard(els, config);
  } else {
    showLogin(els, config);
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      els.error.classList.remove("show");
      els.submit.disabled = true;
      els.submit.textContent = "Signing in…";
      // The hub URL is never user-editable — always the resolved (hardcoded /
      // dev-override) host.
      const candidate: Config = {
        hubUrl: resolveHubUrl(),
        user: els.user.value,
        password: els.password.value,
        pollMs: config.pollMs,
      };
      let res: Response;
      try {
        res = await postLogin(candidate, fetchFn);
      } catch {
        showError(els, "Couldn't reach the hub. Check your connection and try again.");
        els.submit.disabled = false;
        els.submit.textContent = "Sign in";
        return;
      }
      if (!res.ok) {
        showError(
          els,
          res.status === 401
            ? "Incorrect username or password."
            : "Sign-in failed. Please try again."
        );
        els.submit.disabled = false;
        els.submit.textContent = "Sign in";
        return;
      }
      // Persist so the glasses app's Basic-auth polling picks the creds up,
      // then reload into the signed-in (embedded dashboard) view.
      await saveConfig(storage, candidate);
      reload();
    })();
  });

  els.signOut.addEventListener("click", () => {
    void (async () => {
      // Clear the hub cookie too, not just the local creds.
      try {
        await fetchFn(`${hubBase(config)}/api/logout`, { method: "POST", credentials: "include" });
      } catch {
        /* best-effort */
      }
      await saveConfig(storage, { ...config, user: "", password: "" });
      reload();
    })();
  });
}

// Re-exported for callers that just need the header without the DOM glue.
export { authHeader };
