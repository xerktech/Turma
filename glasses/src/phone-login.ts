// Phone-side login page (index.html) — plain DOM, no framework. This is what
// the user sees on their phone screen while the WebView is open; it mirrors
// the web dashboard's login (agent-hub/public/login.html): the hub URL is
// hardcoded (config.ts `resolveHubUrl`), so it only collects a username and
// password. On a successful sign-in it validates the credentials against the
// real hub, persists them, and reloads so the running app picks them up; the
// signed-in view then shows the live mirror of the glasses display with a
// Sign out control.
import { authHeader, loadConfig, saveConfig, resolveHubUrl, type Config } from "./config.ts";
import { HubClient, HttpError } from "./hub-client.ts";
import type { KeyValueStorage } from "./storage.ts";

export interface PhoneLoginElements {
  login: HTMLElement; // the login card
  app: HTMLElement; // the signed-in mirror view
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
    form: byId("login-form"),
    user: byId("hub-user"),
    password: byId("hub-password"),
    submit: byId("login-submit"),
    error: byId("login-error"),
    signOut: byId("sign-out"),
    appUser: byId("app-user"),
  };
}

// Shows the login card or the signed-in mirror depending on whether we have
// stored credentials.
function applyView(els: PhoneLoginElements, config: Config): void {
  const signedIn = Boolean(config.user && config.password);
  els.login.hidden = signedIn;
  els.app.hidden = !signedIn;
  els.appUser.textContent = config.user;
}

function showError(els: PhoneLoginElements, msg: string): void {
  els.error.textContent = msg;
  els.error.classList.add("show");
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
  els.user.value = config.user;
  applyView(els, config);

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
      try {
        // Validate before persisting, so a bad password shows an error here
        // rather than silently failing every poll after reload.
        const client = new HubClient({ config: candidate, fetchFn });
        await client.listAgents();
      } catch (err) {
        showError(
          els,
          isUnauthorized(err)
            ? "Incorrect username or password."
            : "Couldn't reach the hub. Check your connection and try again."
        );
        els.submit.disabled = false;
        els.submit.textContent = "Sign in";
        return;
      }
      await saveConfig(storage, candidate);
      reload();
    })();
  });

  els.signOut.addEventListener("click", () => {
    void (async () => {
      await saveConfig(storage, { ...config, user: "", password: "" });
      reload();
    })();
  });
}

// A 401 from the hub means the credentials were rejected (as opposed to the
// hub being unreachable — a network error, which isn't an HttpError).
function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.status === 401;
}

// Re-exported for callers that just need the header without the DOM glue.
export { authHeader };
