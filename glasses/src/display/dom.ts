// Browser backend: renders the composed text into a simulated 576x288 green
// HUD and maps the keyboard to the four glasses inputs, so the whole app runs
// and is demoable with `npm run dev` — no hardware or SDK needed.
//
//   ArrowUp / k   -> up        ArrowDown / j -> down
//   Enter / Space -> select    Esc / Backspace -> back
//
// This is also what the everything-evenhub simulator drives; the on-device
// surface is display/evenhub.ts.

import { SCREEN } from "../constants.js";
import type { GlassesDisplay, GlassesEvent } from "./index.js";

export class DomDisplay implements GlassesDisplay {
  private screen!: HTMLPreElement;
  private cb: (e: GlassesEvent) => void = () => {};

  async start(): Promise<void> {
    const scale = 1.4; // enlarge the tiny native panel for desktop viewing
    const root = document.getElementById("app") || document.body;
    root.innerHTML = "";
    const frame = document.createElement("div");
    frame.style.cssText = `width:${SCREEN.W * scale}px;height:${SCREEN.H * scale}px;
      background:#000;border-radius:14px;padding:14px;box-sizing:border-box;
      margin:24px auto;font-family:ui-monospace,Menlo,monospace;`;
    this.screen = document.createElement("pre");
    this.screen.style.cssText = `margin:0;color:#7dff8a;white-space:pre-wrap;
      font-size:${18 * scale}px;line-height:1.25;text-shadow:0 0 4px #2f7a36;`;
    frame.appendChild(this.screen);
    root.appendChild(frame);

    const hint = document.createElement("p");
    hint.style.cssText = "text-align:center;color:#888;font:13px system-ui;";
    hint.textContent = "↑/↓ or k/j = scroll · Enter = select · Esc = back";
    root.appendChild(hint);

    window.addEventListener("keydown", (e) => {
      const map: Record<string, GlassesEvent> = {
        ArrowUp: "up", k: "up",
        ArrowDown: "down", j: "down",
        Enter: "select", " ": "select",
        Escape: "back", Backspace: "back",
      };
      const ev = map[e.key];
      if (ev) {
        e.preventDefault();
        this.cb(ev);
      }
    });
    document.addEventListener("visibilitychange", () =>
      this.cb(document.hidden ? "background" : "foreground"),
    );
  }

  render(text: string): void {
    this.screen.textContent = text;
  }

  onEvent(cb: (e: GlassesEvent) => void): void {
    this.cb = cb;
  }
}
