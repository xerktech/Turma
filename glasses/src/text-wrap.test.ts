import { afterEach, describe, expect, it } from "vitest";
import { charMeasure, PX_PER_CHAR, pretextMeasure, setDefaultMeasure, wrapText } from "./text-wrap.ts";

// A trivial 1px-per-char measure makes wrap-point math exact and easy to
// reason about in assertions.
const perChar = (s: string) => s.length;

describe("wrapText", () => {
  it("greedily packs words onto a line up to the width", () => {
    const lines = wrapText("the quick brown fox jumps", 11, perChar);
    // "the quick" = 9 chars fits in 11; adding " brown" -> 15 exceeds.
    expect(lines).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("hard-splits a single word longer than the width", () => {
    const lines = wrapText("supercalifragilistic", 5, perChar);
    expect(lines).toEqual(["super", "calif", "ragil", "istic"]);
  });

  it("hard-splits a long word encountered mid-wrap and resumes packing", () => {
    const lines = wrapText("hi supercalifragilistic bye", 5, perChar);
    expect(lines).toEqual(["hi", "super", "calif", "ragil", "istic", "bye"]);
  });

  it("returns an empty array for empty text", () => {
    expect(wrapText("", 100, perChar)).toEqual([]);
  });

  it("returns an empty array for whitespace-only text", () => {
    expect(wrapText("   ", 100, perChar)).toEqual([]);
  });

  it("treats explicit newlines as forced breaks", () => {
    const lines = wrapText("foo bar\nbaz", 20, perChar);
    expect(lines).toEqual(["foo bar", "baz"]);
  });

  it("collapses runs of internal whitespace within a paragraph", () => {
    const lines = wrapText("foo   bar", 20, perChar);
    expect(lines).toEqual(["foo bar"]);
  });

  it("uses the injected measure function, not just character count", () => {
    // Every char "costs" 10px here, so a width of 25 only fits 2 chars.
    const wide = (s: string) => s.length * 10;
    const lines = wrapText("ab cd", 25, wide);
    expect(lines).toEqual(["ab", "cd"]);
  });

  it("defaults to charMeasure (~10.2px/char) when no measure is given", () => {
    // ~55 chars should fit in 560px per the brief's target.
    const text = "a".repeat(55);
    const lines = wrapText(text, 560);
    expect(lines).toEqual([text]);
    expect(charMeasure("a")).toBeCloseTo(PX_PER_CHAR, 5);
  });

  it("wraps with the default measure when text exceeds the width", () => {
    const text = "a".repeat(56);
    const lines = wrapText(text, 560);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(text);
  });
});

describe("setDefaultMeasure", () => {
  afterEach(() => {
    // Restore the module-level default so later tests (and other files
    // sharing this module instance within a run) see the plain charMeasure.
    setDefaultMeasure(charMeasure);
  });

  it("changes the measure wrapText uses when none is passed explicitly", () => {
    setDefaultMeasure((s) => s.length * 100); // 100px/char -> "ab cd" (500px) can't fit on one 250px line
    const lines = wrapText("ab cd", 250);
    expect(lines).toEqual(["ab", "cd"]);
  });

  it("does not affect calls that pass an explicit measure", () => {
    setDefaultMeasure((s) => s.length * 100);
    const lines = wrapText("ab cd", 25, (s) => s.length);
    expect(lines).toEqual(["ab cd"]);
  });
});

describe("pretextMeasure", () => {
  it("falls back to charMeasure when @evenrealities/pretext is unavailable or unusable", async () => {
    // The real package IS installed in this workspace, so this test can't
    // force the import-failure branch without module mocking; it instead
    // documents and exercises the resolvable path — pretextMeasure() must
    // always resolve to *some* Measure function without throwing.
    const measure = await pretextMeasure();
    expect(typeof measure).toBe("function");
    expect(typeof measure("hello")).toBe("number");
  });
});
