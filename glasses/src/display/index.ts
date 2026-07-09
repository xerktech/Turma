import type { InputEvent } from "../types.ts";

// Hardware-agnostic glasses display. Task 6 implements the real backend
// (the Even Hub SDK display + input router); this app only ever depends on
// this interface, plus the dev DOM implementation in dom.ts.
export interface GlassesDisplay {
  start(): Promise<void>;
  render(lines: string[]): void;
  onInput(cb: (e: InputEvent) => void): void;
  // Root-screen double-tap "exit intent". The real backend (Task 6) wires
  // this to the actual Even Hub exit-confirmation dialog; the DOM dev
  // backend just logs.
  requestExit(): void;
}
