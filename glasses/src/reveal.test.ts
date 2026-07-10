import { describe, expect, it } from "vitest";
import {
  advanceReveal,
  emptyReveal,
  fullReveal,
  revealComplete,
  REVEAL_RATE_CPS,
  REVEAL_SNAP_CHARS,
  type RevealState,
} from "./reveal.ts";

describe("reveal", () => {
  it("emptyReveal shows nothing", () => {
    expect(emptyReveal()).toEqual({ entryId: null, shown: 0 });
  });

  it("fullReveal shows the whole entry (history isn't re-typed)", () => {
    expect(fullReveal("a", 42)).toEqual({ entryId: "a", shown: 42 });
    // No entry -> nothing shown regardless of len.
    expect(fullReveal(null, 42)).toEqual({ entryId: null, shown: 0 });
  });

  it("returns empty when there is no newest entry", () => {
    expect(advanceReveal(fullReveal("a", 10), null, 0, 100)).toEqual({ entryId: null, shown: 0 });
  });

  it("types a small delta on the same entry at the configured rate", () => {
    // 100ms at 150 cps -> 15 chars.
    const prev: RevealState = { entryId: "a", shown: 10 };
    const next = advanceReveal(prev, "a", 40, 100);
    expect(next).toEqual({ entryId: "a", shown: 25 });
  });

  it("never overshoots the target length", () => {
    const prev: RevealState = { entryId: "a", shown: 38 };
    const next = advanceReveal(prev, "a", 40, 1000); // huge dt
    expect(next.shown).toBe(40);
    expect(revealComplete(next, 40)).toBe(true);
  });

  it("snaps a large block instead of typing it (don't slow blocks down)", () => {
    const prev: RevealState = { entryId: "a", shown: 0 };
    // Backlog 500 > snap 200 -> straight to the end.
    const next = advanceReveal(prev, "a", 500, 80);
    expect(next).toEqual({ entryId: "a", shown: 500 });
  });

  it("a brand-new small entry starts hidden then types from 0", () => {
    const prev: RevealState = { entryId: "old", shown: 30 };
    // dt=0 re-anchor: new entry, small -> shown 0 (nothing flashes full).
    const anchored = advanceReveal(prev, "new", 20, 0);
    expect(anchored).toEqual({ entryId: "new", shown: 0 });
    // then it types in: 100ms @ 150cps = 15 chars, more dt clamps to the end.
    expect(advanceReveal(anchored, "new", 20, 100).shown).toBe(15);
    expect(advanceReveal(anchored, "new", 20, 200).shown).toBe(20);
  });

  it("a brand-new large entry snaps (block appeared at once)", () => {
    const prev: RevealState = { entryId: "old", shown: 30 };
    const anchored = advanceReveal(prev, "new", 400, 0);
    expect(anchored).toEqual({ entryId: "new", shown: 400 });
  });

  it("dt=0 on the same entry holds position (re-anchor without typing)", () => {
    const prev: RevealState = { entryId: "a", shown: 12 };
    const next = advanceReveal(prev, "a", 40, 0);
    expect(next).toEqual({ entryId: "a", shown: 12 });
    expect(revealComplete(next, 40)).toBe(false);
  });

  it("clamps shown down if the tail re-truncated shorter", () => {
    const prev: RevealState = { entryId: "a", shown: 50 };
    const next = advanceReveal(prev, "a", 30, 100);
    expect(next).toEqual({ entryId: "a", shown: 30 });
  });

  it("exposes the tuning constants", () => {
    expect(REVEAL_RATE_CPS).toBeGreaterThan(0);
    expect(REVEAL_SNAP_CHARS).toBeGreaterThan(0);
  });
});
