import type { KeyValueStorage } from "./storage.ts";

export interface Config {
  hubUrl: string;
  user: string;
  password: string;
  pollMs: number;
}

export const DEFAULT_POLL_MS = 6000;
export const CONFIG_STORAGE_KEY = "agenthub.glasses.config";

// The hub URL is hardcoded — the phone login page only asks for username and
// password, exactly like the web dashboard's login. `VITE_HUB_URL` can still
// override it for local dev (`npm run dev` against a mock-hub), but packaged
// production builds always target this host.
export const DEFAULT_HUB_URL = "https://agents.xerktech.com";

// The single source of truth for which hub to talk to: the dev env override
// if present, otherwise the hardcoded production host. Never comes from a
// user-editable field.
export function resolveHubUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  return env.VITE_HUB_URL || DEFAULT_HUB_URL;
}

// Vite dev-only credential defaults so `npm run dev` can point at a local
// hub/mock-hub without hand-typing settings every reload. Production
// (packaged) builds won't have these env vars set, so the config falls back
// to storage/empty strings for the creds and the resolved hub URL.
function envDefaults(): Partial<Config> {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  return {
    hubUrl: resolveHubUrl(),
    user: env.VITE_HUB_USER ?? "",
    password: env.VITE_HUB_PASSWORD ?? "",
  };
}

function emptyConfig(): Config {
  const env = envDefaults();
  return {
    hubUrl: env.hubUrl ?? "",
    user: env.user ?? "",
    password: env.password ?? "",
    pollMs: DEFAULT_POLL_MS,
  };
}

// Loads the persisted config, if any, layered over env defaults; malformed or
// missing stored JSON falls back to the env-derived empty config rather than
// throwing.
export async function loadConfig(storage: KeyValueStorage): Promise<Config> {
  const base = emptyConfig();
  const raw = await storage.get(CONFIG_STORAGE_KEY);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      // hubUrl is hardcoded (resolveHubUrl via base) — never honor a stored
      // value, so an old saved host can't shadow the current target.
      hubUrl: base.hubUrl,
      user: typeof parsed.user === "string" ? parsed.user : base.user,
      password: typeof parsed.password === "string" ? parsed.password : base.password,
      pollMs: typeof parsed.pollMs === "number" && parsed.pollMs > 0 ? parsed.pollMs : base.pollMs,
    };
  } catch {
    return base;
  }
}

export async function saveConfig(storage: KeyValueStorage, config: Config): Promise<void> {
  await storage.set(CONFIG_STORAGE_KEY, JSON.stringify(config));
}

// HTTP Basic auth header value for every hub-client request.
export function authHeader(config: Pick<Config, "user" | "password">): string {
  return "Basic " + btoa(`${config.user}:${config.password}`);
}
