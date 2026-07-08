// Runtime configuration. The hub URL and single-user Basic-auth credentials
// can be baked in at build time (Vite env) or set at runtime and remembered in
// localStorage, so the same build works against a dev hub and the live one.
//
// The hub enforces HTTP Basic auth (HUB_USER/HUB_PASSWORD) and now returns CORS
// headers for /api and /term, so this WebView app can call it cross-origin.

export interface HubConfig {
  url: string; // e.g. https://agents.xerktech.com
  user: string;
  password: string;
  pollMs: number; // how often to refresh the session list
}

const LS_KEY = "agenthub.glasses.config";

function fromEnv(): Partial<HubConfig> {
  const e = import.meta.env as Record<string, string | undefined>;
  return {
    url: e.VITE_HUB_URL,
    user: e.VITE_HUB_USER,
    password: e.VITE_HUB_PASSWORD,
  };
}

function fromStorage(): Partial<HubConfig> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function loadConfig(): HubConfig {
  const env = fromEnv();
  const saved = fromStorage();
  return {
    url: (saved.url || env.url || "https://agents.xerktech.com").replace(/\/$/, ""),
    user: saved.user || env.user || "",
    password: saved.password || env.password || "",
    pollMs: saved.pollMs || 8000,
  };
}

export function saveConfig(cfg: Partial<HubConfig>): void {
  const merged = { ...fromStorage(), ...cfg };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(merged));
  } catch {
    /* private-mode / no storage: fall back to env + defaults */
  }
}

export function authHeader(cfg: HubConfig): Record<string, string> {
  if (!cfg.user && !cfg.password) return {};
  const token = btoa(`${cfg.user}:${cfg.password}`);
  return { Authorization: `Basic ${token}` };
}
