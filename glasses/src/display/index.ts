import type { ScreenModel } from "../render.ts";
import type { InputEvent } from "../types.ts";

// Hardware-agnostic glasses display. Task 6 implements the real backend
// (the Even Hub SDK display + input router); this app only ever depends on
// this interface, plus the dev DOM implementation in dom.ts.
export interface GlassesDisplay {
  start(): Promise<void>;
  // render() takes render()'s ScreenModel output directly rather than plain
  // lines: the session screen's bordered bottom box needs its own container
  // geometry (see display/evenhub.ts), which a flattened string[] can't
  // express.
  render(model: ScreenModel): void;
  onInput(cb: (e: InputEvent) => void): void;
  // Root-screen double-tap "exit intent". The real backend (Task 6) wires
  // this to the actual Even Hub exit-confirmation dialog; the DOM dev
  // backend just logs.
  requestExit(): void;
}
