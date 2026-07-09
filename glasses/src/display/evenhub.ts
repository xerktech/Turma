// Even Hub SDK display backend — implements `GlassesDisplay` over the real
// G2 hardware path (see glasses-ui / handle-input / device-features skills
// and ClaudeHUD's `plugin/src/main.ts` for the ported patterns).
//
// This file never imports `@evenrealities/even_hub_sdk` — the bridge and its
// container payloads are typed structurally right here (a small subset of
// the SDK's real shapes). That keeps the browser dev build free of any SDK
// coupling (nothing to dynamically or statically import) and makes this
// class trivially testable with a plain fake bridge; the real `EvenAppBridge`
// instance `main.ts` resolves via `waitForEvenAppBridge()` satisfies
// `EvenHubBridge` structurally with no cast needed.
import type { InputEvent } from "../types.ts";
import type { GlassesDisplay } from "./index.ts";
import { createInputRouter, type LifecycleEvent, type RawEvenHubEvent } from "../input/router.ts";
import { capContent, createTrailingDebounce } from "./debounce.ts";

// G2 canvas: 576x288, one full-canvas text container, the sole
// `isEventCapture: 1` container on the page (SDK rule — exactly one per
// page). `createStartUpPageContainer` is called exactly once at startup;
// every subsequent update goes through `textContainerUpgrade`.
const CANVAS_WIDTH = 576;
const CANVAS_HEIGHT = 288;
const CONTAINER_ID = 0;
const CONTAINER_NAME = "main";
// glasses-ui skill: "Debounce to ~120ms" for the BLE return path.
const RENDER_DEBOUNCE_MS = 120;
// sdk-reference / glasses-ui skill: textContainerUpgrade's hard content cap.
const MAX_CONTENT_CHARS = 2000;

export interface TextContainerConfig {
  xPosition?: number;
  yPosition?: number;
  width?: number;
  height?: number;
  paddingLength?: number;
  containerID?: number;
  containerName?: string;
  isEventCapture?: number;
  content?: string;
}

export interface StartUpContainerConfig {
  containerTotalNum?: number;
  textObject?: TextContainerConfig[];
}

export interface TextUpgradeConfig {
  containerID?: number;
  containerName?: string;
  contentOffset?: number;
  contentLength?: number;
  content?: string;
}

// Structural stand-in for the slice of `EvenAppBridge` this class calls.
export interface EvenHubBridge {
  createStartUpPageContainer(container: StartUpContainerConfig): Promise<unknown>;
  textContainerUpgrade(container: TextUpgradeConfig): Promise<unknown>;
  shutDownPageContainer(exitMode?: number): Promise<unknown>;
  onEvenHubEvent(cb: (event: RawEvenHubEvent) => void): () => void;
}

export class EvenHubDisplay implements GlassesDisplay {
  private readonly bridge: EvenHubBridge;
  private inputCb: ((e: InputEvent) => void) | null = null;
  private lifecycleCb: ((e: LifecycleEvent) => void) | null = null;
  private unsubscribeRouter: (() => void) | null = null;
  private readonly scheduleUpdate: (content: string) => void;

  constructor(bridge: EvenHubBridge) {
    this.bridge = bridge;
    this.scheduleUpdate = createTrailingDebounce((content: string) => {
      void this.pushContent(content);
    }, RENDER_DEBOUNCE_MS);
  }

  async start(): Promise<void> {
    const textObject: TextContainerConfig = {
      xPosition: 0,
      yPosition: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      paddingLength: 16,
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      // Startup content can't be empty on some hosts; a single space is the
      // documented placeholder (glasses-ui skill's event-layer example).
      content: " ",
      isEventCapture: 1,
    };
    try {
      await this.bridge.createStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [textObject],
      });
    } catch (err) {
      console.error("[glasses] createStartUpPageContainer failed:", err);
    }

    this.unsubscribeRouter = createInputRouter(this.bridge, {
      onInput: (e) => this.inputCb?.(e),
      onLifecycle: (e) => this.lifecycleCb?.(e),
    });
  }

  render(lines: string[]): void {
    const content = capContent(lines.join("\n"), MAX_CONTENT_CHARS);
    this.scheduleUpdate(content);
  }

  private async pushContent(content: string): Promise<void> {
    try {
      await this.bridge.textContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        contentOffset: 0,
        contentLength: 0,
        content,
      });
    } catch (err) {
      console.error("[glasses] textContainerUpgrade failed:", err);
    }
  }

  onInput(cb: (e: InputEvent) => void): void {
    this.inputCb = cb;
  }

  // Not part of `GlassesDisplay` — lifecycle glue (main.ts/lifecycle.ts)
  // subscribes here for foreground/background/exit notifications the router
  // normalizes alongside taps and scrolls.
  onLifecycle(cb: (e: LifecycleEvent) => void): void {
    this.lifecycleCb = cb;
  }

  requestExit(): void {
    // handle-input skill: exitMode 1 shows the system exit confirmation
    // dialog; teardown happens later in the SYSTEM_EXIT_EVENT lifecycle
    // handler, not here (the user can still cancel the dialog).
    void (async () => {
      try {
        await this.bridge.shutDownPageContainer(1);
      } catch (err) {
        console.error("[glasses] shutDownPageContainer failed:", err);
      }
    })();
  }

  // Not part of `GlassesDisplay` — called from lifecycle glue on abnormal /
  // system exit to drop the event subscription.
  teardown(): void {
    this.unsubscribeRouter?.();
    this.unsubscribeRouter = null;
  }
}
