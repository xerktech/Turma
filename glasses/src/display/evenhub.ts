// On-device backend: the Even Hub SDK bridge. This is the ONLY module that
// touches @evenrealities/even_hub_sdk, so it's the only thing to reconcile with
// the real SDK — everything else in the app is plain TS.
//
// ⚠️  VERIFY AGAINST THE SDK. The calls below are written against the documented
//    Even Hub API (createStartUpPageContainer / rebuildPageContainer /
//    onEvenHubEvent, TextContainerProperty, the CLICK/DOUBLE_CLICK/SCROLL_TOP/
//    SCROLL_BOTTOM/FOREGROUND_* event constants). Confirm the exact import path,
//    method signatures, and event enum with the everything-evenhub
//    `sdk-reference` skill and `test-with-simulator` before shipping. The SDK is
//    imported dynamically so browser dev/build works without the private pkg.

import { SCREEN, GRID } from "../constants.js";
import type { GlassesDisplay, GlassesEvent } from "./index.js";

// Loose typing of the bits of the SDK we use; replace with the real types from
// @evenrealities/even_hub_sdk once available.
type EvenSdk = {
  createStartUpPageContainer: (props: unknown) => Promise<unknown> | unknown;
  rebuildPageContainer: (props: unknown) => Promise<unknown> | unknown;
  onEvenHubEvent: (cb: (evt: { type: string }) => void) => void;
};

const TEXT_CONTAINER_ID = "screen";

// Documented event-type strings -> our four inputs. Foreground/background let
// the app pause polling while it's not on the HUD.
const EVENT_MAP: Record<string, GlassesEvent> = {
  SCROLL_TOP_EVENT: "up",
  SCROLL_BOTTOM_EVENT: "down",
  CLICK_EVENT: "select",
  DOUBLE_CLICK_EVENT: "back",
  FOREGROUND_ENTER_EVENT: "foreground",
  FOREGROUND_EXIT_EVENT: "background",
};

export class EvenHubDisplay implements GlassesDisplay {
  private sdk!: EvenSdk;
  private cb: (e: GlassesEvent) => void = () => {};
  private started = false;

  // Built from parts so TS/bundler don't try to statically resolve the private
  // Even Hub package (absent in browser dev). The device build provides it.
  private static readonly PKG = "@evenrealities/" + "even_hub_sdk";

  static async isAvailable(): Promise<boolean> {
    try {
      await import(/* @vite-ignore */ EvenHubDisplay.PKG);
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.sdk = (await import(/* @vite-ignore */ EvenHubDisplay.PKG)) as unknown as EvenSdk;
    // A single full-screen text container we keep rewriting. One container, one
    // update path — avoids the image/list constraints entirely.
    const props = {
      containerID: TEXT_CONTAINER_ID,
      containerName: TEXT_CONTAINER_ID,
      xPosition: 0,
      yPosition: 0,
      width: SCREEN.W,
      height: SCREEN.H,
      paddingLength: 4,
      text: "",
    };
    await this.sdk.createStartUpPageContainer(props);
    this.sdk.onEvenHubEvent((evt) => {
      const mapped = EVENT_MAP[evt.type];
      if (mapped) this.cb(mapped);
    });
    this.started = true;
  }

  render(text: string): void {
    if (!this.started) return;
    // Clamp to the safe grid so nothing overflows the HUD, then push a rebuild.
    const clamped = text
      .split("\n")
      .slice(0, GRID.ROWS)
      .map((l) => l.slice(0, GRID.COLS))
      .join("\n");
    this.sdk.rebuildPageContainer({ containerID: TEXT_CONTAINER_ID, text: clamped });
  }

  onEvent(cb: (e: GlassesEvent) => void): void {
    this.cb = cb;
  }
}
