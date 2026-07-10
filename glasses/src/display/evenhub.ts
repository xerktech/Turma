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
import type { BottomModel, ScreenModel } from "../render.ts";
import type { InputEvent } from "../types.ts";
import type { GlassesDisplay } from "./index.ts";
import { createInputRouter, type LifecycleEvent, type RawEvenHubEvent } from "../input/router.ts";
import { bottomBoxLines } from "../input-box.ts";
import { capContent, createTrailingDebounce, type Debounced } from "./debounce.ts";

// G2 canvas: 576x288, one full-canvas text container, the sole
// `isEventCapture: 1` container on the page (SDK rule — exactly one per
// page). `createStartUpPageContainer` is called exactly once at startup;
// every subsequent update goes through `textContainerUpgrade`.
const CANVAS_WIDTH = 576;
const CANVAS_HEIGHT = 288;
const CONTAINER_ID = 0;
const CONTAINER_NAME = "main";
// The tracked "page shape" value for the single-container `lines` layout.
// Session layouts use their own `sessionSignature()` string instead; any
// change between the two (or between two different session signatures)
// means the containers currently on the page are wrong and the page must be
// rebuilt — see `renderSession` / the `lines` branch of `render`.
const LINES_SHAPE = "lines";
// glasses-ui skill: "Debounce to ~120ms" for the BLE return path.
const RENDER_DEBOUNCE_MS = 120;
// sdk-reference / glasses-ui skill: textContainerUpgrade's hard content cap.
const MAX_CONTENT_CHARS = 2000;
// sdk-reference / glasses-ui skill: rebuildPageContainer's smaller per-
// container content cap (vs. textContainerUpgrade's 2000).
const REBUILD_MAX_CONTENT_CHARS = 1000;

// ---- session screen: multi-container bottom bar --------------------------
//
// The session screen's bordered bottom box (input or AskUserQuestion sheet)
// is drawn as three containers stacked with a fourth full-canvas transparent
// event-capture overlay, ported from ClaudeHUD's
// plugin/src/screens/input-strip.ts (border/inset conventions, status-corner
// geometry) and chat.ts's buildPage (container list shape + the
// rebuildPageContainer call). IDs are distinct from the single-container
// `lines` path's CONTAINER_ID (0) — a `rebuildPageContainer` call replaces
// the whole page, so there's no need for continuity between the two shapes,
// only that each container list itself uses unique IDs.
const SESSION_TRANSCRIPT_ID = 1;
const SESSION_TRANSCRIPT_NAME = "transcript";
const SESSION_BOX_ID = 2;
const SESSION_BOX_NAME = "bottombox";
const SESSION_STATUS_ID = 3;
const SESSION_STATUS_NAME = "status";
const SESSION_CAPTURE_ID = 4;
const SESSION_CAPTURE_NAME = "capture";

// input-strip.ts's line-height / border conventions.
const LINE_HEIGHT_PX = 27;
const BOX_BORDER_WIDTH = 1;
const BOX_BORDER_RADIUS = 12;
// 15 = full-bright on the 4-bit greyscale palette.
const BOX_BORDER_COLOR = 15;
const BOX_PADDING = 2;
const BOX_INSET = 2 * (BOX_PADDING + BOX_BORDER_WIDTH);
// Status corner: sized to fit the widest label ("Working"/"[REC]" etc.)
// without crowding the box's right/top border.
const STATUS_WIDTH = 120;
const STATUS_HEIGHT = 27;

export interface TextContainerConfig {
  xPosition?: number;
  yPosition?: number;
  width?: number;
  height?: number;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
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

export interface RebuildContainerConfig {
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
  rebuildPageContainer(container: RebuildContainerConfig): Promise<unknown>;
  textContainerUpgrade(container: TextUpgradeConfig): Promise<unknown>;
  shutDownPageContainer(exitMode?: number): Promise<unknown>;
  onEvenHubEvent(cb: (event: RawEvenHubEvent) => void): () => void;
}

// The layout "shape" that decides rebuild-vs-upgrade: screen enter (no prior
// session render), an input<->sheet mode switch, and any change in the
// bottom box's line count (which changes its height, and therefore the
// transcript/status containers' geometry too) all change this signature —
// exactly the cases the brief calls out as needing a full rebuild.
function sessionSignature(bottom: BottomModel): string {
  return `${bottom.mode}:${bottomBoxLines(bottom.lines)}`;
}

interface SessionContent {
  transcript: string;
  box: string;
  status: string;
}

function sessionContentFrom(model: Extract<ScreenModel, { type: "session" }>, cap: number): SessionContent {
  return {
    transcript: capContent(model.transcriptLines.join("\n"), cap),
    box: capContent(model.bottom.lines.join("\n"), cap),
    status: capContent(model.bottom.status, cap),
  };
}

// The single full-canvas text container that backs every `{type:"lines"}`
// screen — also the sole `isEventCapture:1` container in that layout. Shared
// by `start()`'s createStartUpPageContainer and the session→lines transition
// rebuild so both produce an identical container shape.
function buildLinesContainer(content: string): TextContainerConfig {
  return {
    xPosition: 0,
    yPosition: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    paddingLength: 16,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content,
    isEventCapture: 1,
  };
}

// Builds the four session containers: transcript (top), bordered bottom box,
// its status corner, and the full-canvas transparent capture overlay — the
// only one with `isEventCapture: 1`.
function buildSessionContainers(boxLines: number, content: SessionContent): TextContainerConfig[] {
  const boxHeight = boxLines * LINE_HEIGHT_PX + BOX_INSET;
  const boxY = CANVAS_HEIGHT - boxHeight;
  const statusX = CANVAS_WIDTH - STATUS_WIDTH - (BOX_PADDING + BOX_BORDER_WIDTH);
  const statusY = boxY + BOX_PADDING + BOX_BORDER_WIDTH;

  return [
    {
      xPosition: 0,
      yPosition: 0,
      width: CANVAS_WIDTH,
      height: boxY,
      paddingLength: 16,
      containerID: SESSION_TRANSCRIPT_ID,
      containerName: SESSION_TRANSCRIPT_NAME,
      content: content.transcript,
      isEventCapture: 0,
    },
    {
      xPosition: 0,
      yPosition: boxY,
      width: CANVAS_WIDTH,
      height: boxHeight,
      borderWidth: BOX_BORDER_WIDTH,
      borderColor: BOX_BORDER_COLOR,
      borderRadius: BOX_BORDER_RADIUS,
      paddingLength: BOX_PADDING,
      containerID: SESSION_BOX_ID,
      containerName: SESSION_BOX_NAME,
      content: content.box,
      isEventCapture: 0,
    },
    {
      xPosition: statusX,
      yPosition: statusY,
      width: STATUS_WIDTH,
      height: STATUS_HEIGHT,
      paddingLength: 0,
      containerID: SESSION_STATUS_ID,
      containerName: SESSION_STATUS_NAME,
      content: content.status,
      isEventCapture: 0,
    },
    {
      xPosition: 0,
      yPosition: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      paddingLength: 0,
      containerID: SESSION_CAPTURE_ID,
      containerName: SESSION_CAPTURE_NAME,
      content: " ",
      isEventCapture: 1,
    },
  ];
}

export class EvenHubDisplay implements GlassesDisplay {
  private readonly bridge: EvenHubBridge;
  private inputCb: ((e: InputEvent) => void) | null = null;
  private lifecycleCb: ((e: LifecycleEvent) => void) | null = null;
  private readonly audioFrameCbs = new Set<(pcm: Uint8Array) => void>();
  private unsubscribeRouter: (() => void) | null = null;
  private readonly scheduleUpdate: Debounced<string>;
  private readonly scheduleSessionUpdate: Debounced<SessionContent>;
  // The layout shape currently on the glasses: `LINES_SHAPE` for the single-
  // container layout, or a `sessionSignature()` string for a session layout.
  // null before `start()` creates the first container. Whenever a render's
  // shape differs from this, the on-screen containers are wrong for it and we
  // must `rebuildPageContainer` (not just `textContainerUpgrade`, which
  // silently no-ops against a container that no longer exists) — this is what
  // makes session→lines (e.g. opening a session then going back home)
  // actually redraw instead of freezing on the stale session layout.
  private currentPageShape: string | null = null;

  constructor(bridge: EvenHubBridge) {
    this.bridge = bridge;
    this.scheduleUpdate = createTrailingDebounce((content: string) => {
      void this.pushContent(content);
    }, RENDER_DEBOUNCE_MS);
    this.scheduleSessionUpdate = createTrailingDebounce((content: SessionContent) => {
      void this.pushSessionContent(content);
    }, RENDER_DEBOUNCE_MS);
  }

  async start(): Promise<void> {
    // Startup content can't be empty on some hosts; a single space is the
    // documented placeholder (glasses-ui skill's event-layer example).
    const textObject = buildLinesContainer(" ");
    try {
      await this.bridge.createStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [textObject],
      });
      // The page now holds the single-container `lines` layout.
      this.currentPageShape = LINES_SHAPE;
    } catch (err) {
      console.error("[glasses] createStartUpPageContainer failed:", err);
    }

    this.unsubscribeRouter = createInputRouter(this.bridge, {
      onInput: (e) => this.inputCb?.(e),
      onLifecycle: (e) => this.lifecycleCb?.(e),
      onAudioFrame: (pcm) => {
        for (const cb of this.audioFrameCbs) cb(pcm);
      },
    });
  }

  render(model: ScreenModel): void {
    if (model.type === "lines") {
      this.renderLines(model);
      return;
    }
    this.renderSession(model);
  }

  private renderLines(model: Extract<ScreenModel, { type: "lines" }>): void {
    const content = capContent(model.lines.join("\n"), MAX_CONTENT_CHARS);
    if (this.currentPageShape !== LINES_SHAPE) {
      // Coming from a session layout (containers 1-4) — the single "main"
      // container doesn't exist, so a bare textContainerUpgrade would
      // silently no-op and freeze the stale session layout on screen. Cancel
      // any in-flight (session) debounce, then rebuild the page back to the
      // single full-canvas container with this content directly.
      this.cancelPendingUpdates();
      this.currentPageShape = LINES_SHAPE;
      void this.rebuild([buildLinesContainer(capContent(content, REBUILD_MAX_CONTENT_CHARS))]);
      return;
    }
    // Single container already current — debounced in-place update (unchanged).
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

  private renderSession(model: Extract<ScreenModel, { type: "session" }>): void {
    const signature = sessionSignature(model.bottom);
    if (signature !== this.currentPageShape) {
      // Layout shape changed (screen enter from a `lines` screen,
      // bottomBoxLines changed, or an input<->sheet mode switch) — full
      // rebuild, immediately (not debounced: rebuilds are already the
      // "expensive/flicker" path, so there's no BLE-pacing reason to also
      // delay them). Cancel any in-flight (session) debounce first so a late
      // trailing textContainerUpgrade carrying stale content can't fire
      // ~120ms after — and overwrite — these fresh containers.
      this.cancelPendingUpdates();
      this.currentPageShape = signature;
      const boxLines = bottomBoxLines(model.bottom.lines);
      const content = sessionContentFrom(model, REBUILD_MAX_CONTENT_CHARS);
      const containers = buildSessionContainers(boxLines, content);
      void this.rebuild(containers);
      return;
    }
    // Same shape: just new text in the same three containers. Debounced
    // like the `lines` path, pacing the BLE return path.
    this.scheduleSessionUpdate(sessionContentFrom(model, MAX_CONTENT_CHARS));
  }

  // Drop any pending trailing debounce so a stale in-place update can't fire
  // after — and clobber — an immediate rebuild.
  private cancelPendingUpdates(): void {
    this.scheduleUpdate.cancel();
    this.scheduleSessionUpdate.cancel();
  }

  private async rebuild(containers: TextContainerConfig[]): Promise<void> {
    try {
      await this.bridge.rebuildPageContainer({
        containerTotalNum: containers.length,
        textObject: containers,
      });
    } catch (err) {
      console.error("[glasses] rebuildPageContainer failed:", err);
    }
  }

  private async pushSessionContent(content: SessionContent): Promise<void> {
    try {
      await Promise.all([
        this.bridge.textContainerUpgrade({
          containerID: SESSION_TRANSCRIPT_ID,
          containerName: SESSION_TRANSCRIPT_NAME,
          contentOffset: 0,
          contentLength: 0,
          content: content.transcript,
        }),
        this.bridge.textContainerUpgrade({
          containerID: SESSION_BOX_ID,
          containerName: SESSION_BOX_NAME,
          contentOffset: 0,
          contentLength: 0,
          content: content.box,
        }),
        this.bridge.textContainerUpgrade({
          containerID: SESSION_STATUS_ID,
          containerName: SESSION_STATUS_NAME,
          contentOffset: 0,
          contentLength: 0,
          content: content.status,
        }),
      ]);
    } catch (err) {
      console.error("[glasses] textContainerUpgrade (session) failed:", err);
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

  // Not part of `GlassesDisplay` — Task 7's `AudioRecorder` (main.ts) is the
  // one consumer, subscribing here instead of opening a second
  // `bridge.onEvenHubEvent` listener (see router.ts's `RouterHandlers.onAudioFrame`
  // doc comment for why). Multiple subscribers are supported for symmetry
  // with the real bridge's `onEvenHubEvent`, though in practice only one
  // recorder runs at a time. Returns an unsubscribe function.
  onAudioFrame(cb: (pcm: Uint8Array) => void): () => void {
    this.audioFrameCbs.add(cb);
    return () => {
      this.audioFrameCbs.delete(cb);
    };
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
