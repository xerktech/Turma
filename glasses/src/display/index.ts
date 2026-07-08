// The glasses are treated as a dumb text surface with four discrete inputs.
// Everything above this line (app state, rendering) is hardware-agnostic and
// unit-testable; only the backends below touch a real device or the SDK.

export type GlassesEvent =
  | "up" // SCROLL_TOP  / ring up  — move selection / page up
  | "down" // SCROLL_BOTTOM / ring down — move selection / page down
  | "select" // CLICK (single tap)      — activate
  | "back" // DOUBLE_CLICK             — go back / cancel
  | "foreground" // app brought to front
  | "background"; // app sent to background

export interface GlassesDisplay {
  // Initialise the display surface (e.g. create the SDK's start-up container).
  start(): Promise<void>;
  // Replace the on-screen text. Called on every state change.
  render(text: string): void;
  // Subscribe to input events. Called once at startup.
  onEvent(cb: (e: GlassesEvent) => void): void;
}
