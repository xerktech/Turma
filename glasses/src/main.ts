// Bootstrap: choose the display backend (real SDK on device, simulated HUD in
// the browser), wire up dictation + the hub client, and start the app.

import { App } from "./app.js";
import { HubClient } from "./hub-client.js";
import { WebSpeechDictation } from "./dictation.js";
import { loadConfig, saveConfig } from "./config.js";
import { DomDisplay } from "./display/dom.js";
import { EvenHubDisplay } from "./display/evenhub.js";
import type { GlassesDisplay } from "./display/index.js";

async function pickDisplay(): Promise<GlassesDisplay> {
  // On the glasses the SDK import resolves; in the browser it doesn't, so we
  // fall back to the simulated DOM HUD.
  if (await EvenHubDisplay.isAvailable()) return new EvenHubDisplay();
  return new DomDisplay();
}

async function ensureConfig() {
  let cfg = loadConfig();
  // Dev convenience: if creds are missing and we have a DOM (browser) prompt,
  // ask once and remember. On device, config is provided via build-time env.
  if ((!cfg.user || !cfg.password) && typeof window !== "undefined" && window.prompt) {
    const url = window.prompt("Hub URL", cfg.url) || cfg.url;
    const user = window.prompt("Hub user", cfg.user) || cfg.user;
    const password = window.prompt("Hub password", cfg.password) || cfg.password;
    saveConfig({ url, user, password });
    cfg = loadConfig();
  }
  return cfg;
}

async function main() {
  const cfg = await ensureConfig();
  const app = new App(await pickDisplay(), new WebSpeechDictation(), new HubClient(cfg), cfg);
  await app.run();
}

void main();
