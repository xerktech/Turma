// Runs REAL SDK payload parsing into the router — the one test here that
// imports `@evenrealities/even_hub_sdk`. router.test.ts stays SDK-free; this
// pins the SDK half of the long-press contract, which the router cannot see:
// an SDK < 0.0.14 drops eventType 9/10, and what reaches normalizeEvent is
// then a bare sysEvent that reads as a protobuf-zero CLICK.
import { describe, expect, it } from "vitest";
import { evenHubEventFromJson } from "@evenrealities/even_hub_sdk";
import { normalizeEvent } from "./router.ts";

describe("SDK-parsed events through normalizeEvent", () => {
  it.each([9, 10, "LONG_PRESS_EVENT"])("a long press / release (%s) is not a tap", (eventType) => {
    const event = evenHubEventFromJson({ type: "sysEvent", jsonData: { eventType, eventSource: 1 } });
    expect(normalizeEvent(event)).toBeNull();
  });

  it("a real click still taps", () => {
    const event = evenHubEventFromJson({ type: "sysEvent", jsonData: { eventSource: 1 } });
    expect(normalizeEvent(event)).toEqual({ type: "tap" });
  });
});
