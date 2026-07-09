// Input router for the Even Hub bridge display.
//
// Normalizes raw `bridge.onEvenHubEvent` payloads into the app's four-gesture
// `InputEvent` vocabulary (tap/doubleTap/scrollUp/scrollDown) plus lifecycle
// notifications, per the handle-input skill and ClaudeHUD's
// `plugin/src/input/router.ts` (the ported reference — same event-routing
// rules, adapted to this package's InputEvent shape):
//
//   - `sysEvent.eventType` 0/undefined -> single click (tap).
//   - `sysEvent.eventType` 3 -> double click (doubleTap).
//   - `sysEvent.eventType` 4-7 -> lifecycle (foreground enter/exit, abnormal
//     exit, system exit).
//   - `textEvent.eventType` 1 / 2 -> scroll up / down on the text container.
//
// CRITICAL gotcha (the whole reason this file exists instead of a one-line
// switch): clicks and double-clicks on a text container arrive as `sysEvent`,
// NOT `textEvent` — only scroll gestures fire `textEvent`. Getting this
// backwards is the most common Even Hub input bug.
//
// Raw event shape is defined structurally right here (not imported from
// `@evenrealities/even_hub_sdk`) so this module — and its tests — never need
// the SDK installed or a WebView bridge; a real `EvenHubEvent` from the SDK
// satisfies this shape structurally.
import type { InputEvent } from "../types.ts";
import { tryConsumeTap } from "even-toolkit/gestures";

// Numeric `OsEventTypeList` codes, mirrored here (not imported) because
// enum *values* are a value-level SDK import, and SDK calls in this file are
// type-level only per the brief. These are stable wire-protocol constants.
const OS_EVENT = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  IMU_DATA_REPORT: 8,
} as const;

export interface RawSysEvent {
  eventType?: number;
  eventSource?: number;
  systemExitReasonCode?: number;
}

export interface RawTextEvent {
  eventType?: number;
}

export interface RawListEvent {
  eventType?: number;
  currentSelectItemIndex?: number;
}

// Structural stand-in for the SDK's `EvenHubEvent` — every field optional,
// same field names, so a real bridge event is assignable here with no cast.
export interface RawEvenHubEvent {
  sysEvent?: RawSysEvent;
  textEvent?: RawTextEvent;
  listEvent?: RawListEvent;
  audioEvent?: unknown;
}

export type LifecyclePhase = "foreground-enter" | "foreground-exit" | "abnormal-exit" | "system-exit";

export interface LifecycleEvent {
  type: "lifecycle";
  phase: LifecyclePhase;
  reasonCode?: number;
}

// Pure normalizer — no dedup, no subscriptions, no SDK. Unit tests feed
// synthetic `RawEvenHubEvent` objects directly; `createInputRouter` below is
// the only thing that touches a real bridge.
export function normalizeEvent(raw: RawEvenHubEvent): InputEvent | LifecycleEvent | null {
  // Scrolls are the only text-container gesture that arrives as `textEvent`.
  if (raw.textEvent) {
    const t = raw.textEvent.eventType ?? OS_EVENT.CLICK;
    if (t === OS_EVENT.SCROLL_TOP) return { type: "scrollUp" };
    if (t === OS_EVENT.SCROLL_BOTTOM) return { type: "scrollDown" };
    return null;
  }

  // Clicks/double-clicks on the text container, plus every lifecycle event,
  // land here — the gotcha called out at the top of this file.
  if (raw.sysEvent) {
    const t = raw.sysEvent.eventType ?? OS_EVENT.CLICK;
    switch (t) {
      case OS_EVENT.CLICK:
        return { type: "tap" };
      case OS_EVENT.DOUBLE_CLICK:
        return { type: "doubleTap" };
      case OS_EVENT.FOREGROUND_ENTER:
        return { type: "lifecycle", phase: "foreground-enter" };
      case OS_EVENT.FOREGROUND_EXIT:
        return { type: "lifecycle", phase: "foreground-exit" };
      case OS_EVENT.ABNORMAL_EXIT:
        return { type: "lifecycle", phase: "abnormal-exit" };
      case OS_EVENT.SYSTEM_EXIT:
        return { type: "lifecycle", phase: "system-exit", reasonCode: raw.sysEvent.systemExitReasonCode };
      default:
        // IMU_DATA_REPORT and anything else unrecognized — not part of this
        // app's vocabulary (no IMU feature, no list containers).
        return null;
    }
  }

  // listEvent (this app never creates list containers) and anything else.
  return null;
}

export type TapDedup = (kind: "tap" | "double") => boolean;

// Structural stand-in for `Pick<EvenAppBridge, 'onEvenHubEvent'>`.
export interface RouterBridge {
  onEvenHubEvent(cb: (event: RawEvenHubEvent) => void): () => void;
}

export interface RouterHandlers {
  onInput: (e: InputEvent) => void;
  onLifecycle?: (e: LifecycleEvent) => void;
  // Overrides the tap-dedup gate; defaults to `tryConsumeTap` from
  // even-toolkit/gestures (matches ClaudeHUD's choice). Tests can inject a
  // pass-through so every synthetic tap gets through deterministically.
  tapDedup?: TapDedup;
}

// Subscribes to the bridge's single event stream, normalizes each event, and
// dispatches to the handlers. Returns the bridge's unsubscribe function
// (there is exactly one `onEvenHubEvent` listener for the whole app, owned
// by `EvenHubDisplay`).
export function createInputRouter(bridge: RouterBridge, handlers: RouterHandlers): () => void {
  const dedup = handlers.tapDedup ?? tryConsumeTap;
  return bridge.onEvenHubEvent((raw) => {
    const normalized = normalizeEvent(raw);
    if (!normalized) return;
    if (normalized.type === "lifecycle") {
      handlers.onLifecycle?.(normalized);
      return;
    }
    if (normalized.type === "tap" && !dedup("tap")) return;
    if (normalized.type === "doubleTap" && !dedup("double")) return;
    handlers.onInput(normalized);
  });
}
