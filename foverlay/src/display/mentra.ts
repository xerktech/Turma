// Mentra scene-display backend — implements `GlassesDisplay` over
// `session.display.render()` (replace-the-frame scene rendering) for the
// Foverlay port (XERK-211). Mirrors the structure of upstream's
// display/evenhub.ts: the same debounce/page-shape discipline, the same
// content caps, but scene elements instead of Even Hub containers.
//
// Layout (576x288 canvas, 40px lines — see core/layout.ts):
//   {type:"lines"}   -> one full-canvas text element ("main").
//   {type:"session"} -> transcript text on top, a bordered bottom box drawn
//                       as a rect ("boxborder") + a text element inside
//                       ("boxtext"), and a right-corner status text
//                       ("status"). 4 elements, well inside the G2's
//                       6-element text/rect pool (rects share it — see
//                       mobile/modules/engine/src/types/capabilities/
//                       even-realities-g2.ts).
//
// Debounce: same leading+trailing 120ms pacing as upstream (the BLE return
// path budget), with a forced immediate render on any page-shape change
// (lines<->session, an input<->sheet mode switch, or a bottom-box
// line-count change) — a pending trailing flush is cancelled first so stale
// content can't land ~120ms after — and overwrite — the fresh shape.

import type { BottomModel, ScreenModel } from "../core/render.ts";
import { boxLineCount } from "../core/render.ts";
import type { InputEvent, InputEventType } from "../core/types.ts";
import type { GlassesDisplay } from "./index.ts";
import { capContent, createTrailingDebounce, type Debounced } from "./debounce.ts";

const CANVAS_WIDTH = 576;
const CANVAS_HEIGHT = 288;
// Hardware-calibrated G2 scene line height (engine g2.ts profile).
const LINE_HEIGHT_PX = 40;
// glasses-ui pacing: debounce same-shape updates to ~120ms for the BLE path.
const RENDER_DEBOUNCE_MS = 120;
// Hard content cap per text element, truncating from the top so the newest,
// bottom-anchored content always survives (same budget as upstream).
const MAX_CONTENT_CHARS = 2000;

// Bordered bottom box conventions, carried over from upstream's evenhub.ts.
const BOX_BORDER_WIDTH = 1;
const BOX_BORDER_RADIUS = 12;
const BOX_PADDING = 2;
const BOX_INSET = 2 * (BOX_PADDING + BOX_BORDER_WIDTH);
// Status corner: sized to fit the widest label ("Working"/"[REC]" etc.).
const STATUS_WIDTH = 120;

const LINES_SHAPE = "lines";

// The slice of the miniapp SDK session this backend needs — typed
// structurally (like upstream's EvenHubBridge) so tests can hand in a fake
// without importing @mentra/miniapp.
export interface RenderBoxLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Assignable to the SDK's RenderElement union (text/rect variants), while
// keeping this module free of an @mentra/miniapp import.
export type RenderElementLike =
  | { type: "text"; id: string; box: RenderBoxLike; text: string }
  | { type: "rect"; id: string; box: RenderBoxLike; style: { border: number; radius: number } };

export interface TouchDataLike {
  kind: string;
}

export interface MentraDisplaySession {
  display: { render(elements: RenderElementLike[]): Promise<unknown> };
  input: {
    onTouch(gestures: string[], handler: (data: TouchDataLike) => void): () => void;
  };
}

// touch_event gesture -> the app's InputEvent vocabulary (see the port spec's
// runtime mapping table and mobile/modules/miniapp/src/modules/events.ts).
const GESTURE_MAP: Record<string, InputEventType> = {
  single_tap: "tap",
  double_tap: "doubleTap",
  swipe_up: "scrollUp",
  swipe_down: "scrollDown",
};

// The layout "shape" that decides immediate-vs-debounced: any change in the
// bottom box's mode or line count changes the element geometry, exactly the
// cases upstream rebuilt containers for.
function sessionSignature(bottom: BottomModel): string {
  return `session:${bottom.mode}:${boxLineCount(bottom)}`;
}

// The host's scene diff updates elements by id; an element whose content
// becomes empty could otherwise read as "nothing to draw" and leave stale
// text (the same failure mode upstream's textContainerUpgrade had). A single
// space keeps the element present and visibly blank.
function orSpace(content: string): string {
  return content.length === 0 ? " " : content;
}

function cap(text: string): string {
  return orSpace(capContent(text, MAX_CONTENT_CHARS));
}

function buildLinesScene(model: Extract<ScreenModel, { type: "lines" }>): RenderElementLike[] {
  return [
    {
      type: "text",
      id: "main",
      box: { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT },
      text: cap(model.lines.join("\n")),
    },
  ];
}

function buildSessionScene(model: Extract<ScreenModel, { type: "session" }>): RenderElementLike[] {
  const boxLines = boxLineCount(model.bottom);
  const boxHeight = boxLines * LINE_HEIGHT_PX + BOX_INSET;
  const boxY = CANVAS_HEIGHT - boxHeight;
  const inset = BOX_PADDING + BOX_BORDER_WIDTH;
  return [
    {
      type: "text",
      id: "transcript",
      box: { x: 0, y: 0, w: CANVAS_WIDTH, h: boxY },
      text: cap(model.transcriptLines.join("\n")),
    },
    {
      type: "rect",
      id: "boxborder",
      box: { x: 0, y: boxY, w: CANVAS_WIDTH, h: boxHeight },
      style: { border: BOX_BORDER_WIDTH, radius: BOX_BORDER_RADIUS },
    },
    {
      type: "text",
      id: "boxtext",
      box: { x: inset + 1, y: boxY + inset, w: CANVAS_WIDTH - 2 * (inset + 1), h: boxHeight - 2 * inset },
      text: cap(model.bottom.lines.join("\n")),
    },
    {
      type: "text",
      id: "status",
      // Right corner of the box, one line tall — right-aligned-ish by
      // geometry (the scene API has no text alignment).
      box: { x: CANVAS_WIDTH - STATUS_WIDTH - inset, y: boxY + inset, w: STATUS_WIDTH, h: LINE_HEIGHT_PX },
      text: cap(model.bottom.status),
    },
  ];
}

export class MentraDisplay implements GlassesDisplay {
  private readonly session: MentraDisplaySession;
  private inputCb: ((e: InputEvent) => void) | null = null;
  private unsubscribeTouch: (() => void) | null = null;
  private readonly scheduleRender: Debounced<RenderElementLike[]>;
  // The layout shape currently on the glasses; null before start()'s first
  // frame. A render whose shape differs is pushed immediately (upstream's
  // rebuild path); a same-shape render is debounced (upstream's upgrade path).
  private currentPageShape: string | null = null;

  constructor(session: MentraDisplaySession) {
    this.session = session;
    this.scheduleRender = createTrailingDebounce((elements: RenderElementLike[]) => {
      void this.push(elements);
    }, RENDER_DEBOUNCE_MS);
  }

  async start(): Promise<void> {
    // Seed the canvas with a blank frame (single space, never "": see
    // orSpace) so the first real render is an in-place update.
    this.currentPageShape = LINES_SHAPE;
    await this.push(buildLinesScene({ type: "lines", lines: [" "] }));
    this.unsubscribeTouch = this.session.input.onTouch(Object.keys(GESTURE_MAP), (data) => {
      const type = GESTURE_MAP[data.kind];
      if (type) this.inputCb?.({ type });
    });
  }

  render(model: ScreenModel): void {
    const shape = model.type === "lines" ? LINES_SHAPE : sessionSignature(model.bottom);
    const elements = model.type === "lines" ? buildLinesScene(model) : buildSessionScene(model);
    if (shape !== this.currentPageShape) {
      // Page shape changed — render immediately (not debounced: shape changes
      // are the enter/leave/grow moments the user is watching for), and drop
      // any pending trailing flush carrying the OLD shape's content.
      this.scheduleRender.cancel();
      this.currentPageShape = shape;
      void this.push(elements);
      return;
    }
    this.scheduleRender(elements);
  }

  private async push(elements: RenderElementLike[]): Promise<void> {
    try {
      await this.session.display.render(elements);
    } catch (err) {
      console.error("[turma] display.render failed:", err);
    }
  }

  onInput(cb: (e: InputEvent) => void): void {
    this.inputCb = cb;
  }

  requestExit(): void {
    // No-op: Foverlay owns the miniapp lifecycle — there is no Even Hub
    // exit-confirmation dialog to request. A root double-tap simply stays on
    // the home screen.
  }

  // Not part of `GlassesDisplay` — the background entry calls this when the
  // app is torn down (sign-out) so a stale input subscription or pending
  // debounce can't fire against a dead App.
  dispose(): void {
    this.scheduleRender.cancel();
    this.unsubscribeTouch?.();
    this.unsubscribeTouch = null;
    this.inputCb = null;
  }
}
