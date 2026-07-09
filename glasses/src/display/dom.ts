import type { InputEvent } from "../types.ts";
import type { GlassesDisplay } from "./index.ts";

// Dev backend: renders the glasses' text lines into a styled <pre>, and maps
// a keyboard to the four-gesture input vocabulary (ArrowUp/ArrowDown =
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

  render(lines: string[]): void {
    this.el.textContent = lines.join("\n");
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
