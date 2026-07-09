// Bootstrap only — kept thin and untested per the brief. Wires the concrete
// dev implementations (BrowserStorage, DomDisplay, PromptDictation) into the
// hardware-agnostic App. Task 6 swaps in the real Even Hub SDK display +
// bridge storage; Task 7 swaps in real G2-mic dictation.
import { App } from "./app.ts";
import { loadConfig } from "./config.ts";
import { DomDisplay } from "./display/dom.ts";
import { PromptDictation } from "./dictation.ts";
import { HubClient } from "./hub-client.ts";
import { BrowserStorage } from "./storage.ts";
import { initPhoneSettings } from "./phone-settings.ts";

async function main(): Promise<void> {
  const storage = new BrowserStorage();
  const config = await loadConfig(storage);

  void initPhoneSettings(storage);

  const client = new HubClient({ config });
  const display = new DomDisplay();
  const dictation = new PromptDictation();
  const app = new App({ client, display, dictation, pollMs: config.pollMs });

  await app.start();
}

void main();
