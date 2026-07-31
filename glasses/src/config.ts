import type { KeyValueStorage } from "./storage.ts";

export interface Config {
  hubUrl: string;
  user: string;
  password: string;
  pollMs: number;
}

export const DEFAULT_POLL_MS = 6000;
export const CONFIG_STORAGE_KEY = "turma.glasses.config";
// Pre-Turma storage key (app was "Agent Hub"). loadConfig reads this once when
// the new key is empty and re-saves under CONFIG_STORAGE_KEY, so a device that
// stored its credentials before the rename doesn't have to re-enter them. Safe
// to delete in a later cleanup once devices have re-saved under the new key.
export const LEGACY_CONFIG_STORAGE_KEY = "agenthub.glasses.config";

// Shown as the hub-URL field's placeholder. Deliberately an example host, not a
// real one: the hub is self-hosted, so there is no default deployment to point
// at and this app must not ship one operator's host baked in.
export const HUB_URL_PLACEHOLDER = "https://turma.example.com";

// Normalize a hand-typed hub URL: trim it, default a missing scheme to https
// (a phone keyboard makes "turma.example.com" the likely input), and drop any
// trailing slash so every caller can append a path. Blank stays blank — the
// caller decides whether that's an error.
//
// NOTE: reaching the resulting host on-device also requires it to be listed in
// app.json's `network` permission whitelist, which the Even WebView enforces at
// the network layer. That whitelist is a pack-time constant, so a build can
// only talk to the hosts it was packaged for — see glasses/README.md.
export function normalizeHubUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return withScheme.replace(/\/+$/, "");
}

// Vite dev-only hub override (`npm run dev` against a local mock-hub). Returns
// "" when unset, which is the signal that the stored/user-entered value is the
// one to use. Packaged builds never set it.
export function resolveHubUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  return normalizeHubUrl(env.VITE_HUB_URL ?? "");
}

// Vite dev-only credential defaults so `npm run dev` can point at a local
// hub/mock-hub without hand-typing settings every reload. Production
// (packaged) builds won't have these env vars set, so the config falls back
// to storage/empty strings.
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

// True once the config names a hub and a user to reach it as — i.e. the login
// page has been filled in at least once on this device.
export function isConfigured(config: Config): boolean {
  return Boolean(config.hubUrl && config.user && config.password);
}

// Loads the persisted config, if any, layered over env defaults; malformed or
// missing stored JSON falls back to the env-derived empty config rather than
// throwing.
export async function loadConfig(storage: KeyValueStorage): Promise<Config> {
  const base = emptyConfig();
  let raw = await storage.get(CONFIG_STORAGE_KEY);
  if (!raw) {
    // One-time migration from the pre-Turma key.
    const legacy = await storage.get(LEGACY_CONFIG_STORAGE_KEY);
    if (legacy) {
      raw = legacy;
      await storage.set(CONFIG_STORAGE_KEY, legacy);
    }
  }
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const storedUrl =
      typeof parsed.hubUrl === "string" ? normalizeHubUrl(parsed.hubUrl) : "";
    return {
      // The hub is whatever the operator typed on the login page and we then
      // persisted — that's the whole point of the field, and it's why an
      // install survives a restart without re-entry. `base.hubUrl` (the
      // VITE_HUB_URL dev override) still wins when set, so `npm run dev`
      // against a mock-hub can't be hijacked by a value stored on that device.
      hubUrl: base.hubUrl || storedUrl,
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
