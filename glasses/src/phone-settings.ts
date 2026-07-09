// Binds the phone-side settings panel in index.html (#settings) — plain DOM,
// no framework. Not rendered to the glasses; this is the config UI the user
// sees on their phone screen while the WebView is open. Reads/writes through
// config.ts/storage.ts, and a "Test connection" button exercises the real
// HubClient.listAgents() to confirm the hub is reachable before the user
// backs out of setup.
import { authHeader, loadConfig, saveConfig, type Config } from "./config.ts";
import { HubClient } from "./hub-client.ts";
import type { KeyValueStorage } from "./storage.ts";

export interface PhoneSettingsElements {
  hubUrl: HTMLInputElement;
  user: HTMLInputElement;
  password: HTMLInputElement;
  save: HTMLButtonElement;
  test: HTMLButtonElement;
  status: HTMLElement;
}

export function queryPhoneSettingsElements(doc: Document = document): PhoneSettingsElements {
  const byId = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`phone-settings: missing #${id}`);
    return el as T;
  };
  return {
    hubUrl: byId("hub-url"),
    user: byId("hub-user"),
    password: byId("hub-password"),
    save: byId("settings-save"),
    test: byId("settings-test"),
    status: byId("settings-status"),
  };
}

export async function initPhoneSettings(
  storage: KeyValueStorage,
  els: PhoneSettingsElements = queryPhoneSettingsElements(),
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<void> {
  const config = await loadConfig(storage);
  els.hubUrl.value = config.hubUrl;
  els.user.value = config.user;
  els.password.value = config.password;

  const readForm = (): Config => ({
    hubUrl: els.hubUrl.value.trim(),
    user: els.user.value,
    password: els.password.value,
    pollMs: config.pollMs,
  });

  els.save.addEventListener("click", () => {
    void (async () => {
      await saveConfig(storage, readForm());
      els.status.textContent = "Saved.";
    })();
  });

  els.test.addEventListener("click", () => {
    void (async () => {
      els.status.textContent = "Testing…";
      const testConfig = readForm();
      try {
        const client = new HubClient({ config: testConfig, fetchFn });
        const res = await client.listAgents();
        els.status.textContent = `OK — ${res.agents.length} host(s) reporting.`;
      } catch (e) {
        els.status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    })();
  });
}

// Re-exported for callers that just need the header without the DOM glue
// (e.g. a future diagnostics panel).
export { authHeader };
