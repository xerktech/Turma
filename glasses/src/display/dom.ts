import type { ScreenModel } from "../render.ts";
import type { InputEvent } from "../types.ts";
import type { GlassesDisplay } from "./index.ts";

// Width of the divider line dev-rendered between the session screen's
// transcript and its bottom box — arbitrary but wide enough to look like a
// rule under the ~560px-wide transcript text.
const DIVIDER_WIDTH = 40;

// Renders a "─"-filled divider of DIVIDER_WIDTH chars with `status`
// overlaid flush against its right edge (a plain-text stand-in for the real
// backend's separate status-corner container — see evenhub.ts).
function sessionDivider(status: string): string {
  const bar = "─".repeat(DIVIDER_WIDTH);
  if (status.length === 0) return bar;
  return bar.slice(0, Math.max(0, bar.length - status.length)) + status;
}

// Dev backend: renders the glasses' screen into a styled <pre>, and maps a
// keyboard to the four-gesture input vocabulary (ArrowUp/ArrowDown =
// scroll, Enter = tap, Escape = double-tap). No debouncing — the real
// hardware backend (Task 6) owns pacing the BLE write path; this dev
// backend just needs to be visually usable.
export class DomDisplay implements GlassesDisplay {
  private readonly el: HTMLElement;
  private inputCb: ((e: InputEvent) => void) | null = null;

  constructor(el: HTMLElement = document.getElementById("glasses-display") as HTMLElement) {
    this.el = el;
  }

  async start(): Promise<void> {
    this.el.tabIndex = 0;
    this.el.addEventListener("keydown", (ev) => this.onKeydown(ev));
    this.el.focus();
  }

  render(model: ScreenModel): void {
    if (model.type === "lines") {
      this.el.textContent = model.lines.join("\n");
      return;
    }
    // Session screen: no real bordered-box container in the dev DOM
    // backend, so stack the transcript, a status divider, and the bottom
    // box's own lines into one string — visually distinct enough to be
    // usable, per the brief.
    const divider = sessionDivider(model.bottom.status);
    this.el.textContent = [...model.transcriptLines, divider, ...model.bottom.lines].join("\n");
  }

  onInput(cb: (e: InputEvent) => void): void {
    this.inputCb = cb;
  }

  requestExit(): void {
    console.log("[glasses] exit requested (Task 6 wires the real exit dialog)");
  }

  private onKeydown(ev: KeyboardEvent): void {
    const emit = (type: InputEvent["type"]) => this.inputCb?.({ type });
    switch (ev.key) {
      case "ArrowUp":
        ev.preventDefault();
        emit("scrollUp");
        break;
      case "ArrowDown":
        ev.preventDefault();
        emit("scrollDown");
        break;
      case "Enter":
        ev.preventDefault();
        emit("tap");
        break;
      case "Escape":
        ev.preventDefault();
        emit("doubleTap");
        break;
    }
  }
}
