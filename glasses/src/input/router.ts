// Input router for the Even Hub bridge display.
//
// Normalizes raw `bridge.onEvenHubEvent` payloads into the app's four-gesture
// `InputEvent` vocabulary (tap/doubleTap/scrollUp/scrollDown) plus lifecycle
// notifications, per the handle-input skill:
//
//   - `sysEvent.eventType` 0/undefined -> single click (tap).
//   - `sysEvent.eventType` 3 -> double click (doubleTap).
//   - `sysEvent.eventType` 4-7 -> lifecycle (foreground enter/exit, abnormal
//     exit, system exit).
//   - `sysEvent.eventType` 9/10 (long press / release) -> ignored, NOT a tap.
//   - a `sysEvent` whose eventType the SDK didn't recognise (stripped, so the
//     raw value survives only in `jsonData`) -> ignored, NOT a tap. See the
//     block in `normalizeEvent` and XERK-922.
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
  // SDK 0.0.14+. An SDK older than that strips an eventType it doesn't know,
  // so a long press reached this router as a bare `sysEvent` — indistinguishable
  // from a protobuf-zero CLICK — and fired a tap on press AND another on
  // release. The SDK must stay >= 0.0.14 for these to be ignorable at all.
  LONG_PRESS: 9,
  LONG_PRESS_RELEASE: 10,
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

// device-features skill: `event.audioEvent.audioPcm` is a Uint8Array of raw
// 16kHz s16le mono PCM. Structural stand-in for the SDK's `AudioEventPayload`.
export interface RawAudioEvent {
  audioPcm?: Uint8Array;
}

// The SDK preserves the pre-parse payload on every event as `jsonData`, so its
// `eventType` survives even when the SDK strips one it doesn't recognise (the
// numeric/string codes below). We read it to tell a genuine protobuf-zero CLICK
// (no `eventType` at all) apart from an unknown type the SDK dropped.
export interface RawJsonData {
  eventType?: number | string;
}

// Structural stand-in for the SDK's `EvenHubEvent` — every field optional,
// same field names, so a real bridge event is assignable here with no cast.
export interface RawEvenHubEvent {
  sysEvent?: RawSysEvent;
  textEvent?: RawTextEvent;
  listEvent?: RawListEvent;
  audioEvent?: RawAudioEvent;
  jsonData?: RawJsonData;
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
    // The SDK's `evenHubEventFromJson` DROPS an eventType it doesn't recognise
    // (any numeric code or string outside its enum), leaving `sysEvent` empty
    // but keeping the raw value in `jsonData`. A missing `sysEvent.eventType`
    // is therefore ambiguous: it's either a genuine protobuf-zero CLICK (which
    // omits the field entirely — `jsonData.eventType` is absent too) or an
    // unknown type the SDK stripped (`jsonData.eventType` carries what it saw).
    // Treating the second as a CLICK is XERK-922 — the next firmware event type
    // fires a tap. Ignore an unknown type; only a true protobuf-zero taps.
    if (raw.sysEvent.eventType === undefined) {
      // A genuine CLICK omits eventType from `jsonData` entirely (absent, i.e.
      // undefined here); ANY present value — including a literal `null` the
      // firmware sent — is a type the SDK saw and stripped, so ignore it.
      const rawType = raw.jsonData?.eventType;
      if (rawType !== undefined && rawType !== OS_EVENT.CLICK) {
        return null;
      }
    }
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
      case OS_EVENT.LONG_PRESS:
      case OS_EVENT.LONG_PRESS_RELEASE:
        return null;
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
  // Task 7: raw mic PCM frames ride the same `onEvenHubEvent` stream as taps
  // and lifecycle events (see device-features skill — `audioEvent.audioPcm`).
  // Rather than a second `bridge.onEvenHubEvent` subscription (there must be
  // exactly one, owned by `EvenHubDisplay`/this router), we fan audio frames
  // out here alongside the existing normalized dispatch. `normalizeEvent`
  // deliberately keeps returning null for `audioEvent` (see its tests) —
  // frames aren't part of the InputEvent/LifecycleEvent vocabulary, so they
  // never go through tap dedup and are dispatched here instead, ungated.
  onAudioFrame?: (pcm: Uint8Array) => void;
  // Overrides the tap-dedup gate; defaults to `tryConsumeTap` from
  // even-toolkit/gestures. Tests can inject a pass-through so every synthetic
  // tap gets through deterministically.
  tapDedup?: TapDedup;
}

// Subscribes to the bridge's single event stream, normalizes each event, and
// dispatches to the handlers. Returns the bridge's unsubscribe function
// (there is exactly one `onEvenHubEvent` listener for the whole app, owned
// by `EvenHubDisplay`).
export function createInputRouter(bridge: RouterBridge, handlers: RouterHandlers): () => void {
  const dedup = handlers.tapDedup ?? tryConsumeTap;
  return bridge.onEvenHubEvent((raw) => {
    const pcm = raw.audioEvent?.audioPcm;
    if (pcm && pcm.length > 0) {
      handlers.onAudioFrame?.(pcm);
    }
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
