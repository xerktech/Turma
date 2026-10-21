import { afterEach, describe, expect, it } from "vitest";
import { charMeasure, PX_PER_CHAR, pretextMeasure, setDefaultMeasure, splitLongWord, wrapText } from "./text-wrap.ts";

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

  it("hard-splits on code points, never through an emoji's surrogate pair (XERK-1858)", () => {
    const utf16 = (s: string) => s.length; // a pair is 2 units wide
    const lines = wrapText("😀".repeat(5), 3, utf16);
    expect(lines).toEqual(["😀", "😀", "😀", "😀", "😀"]);
  });

  it("hard-splits a long word in O(log n) measures per line, not O(n) (XERK-1858)", () => {
    let calls = 0;
    const counting = (s: string) => (calls++, s.length);
    const lines = wrapText("x".repeat(400), 10, counting);
    expect(lines).toHaveLength(40);
    expect(calls).toBeLessThan(1000); // the linear walk-back took ~8000
  });

  // The XERK-1858 binary search, kept verbatim as the reference the galloping
  // split must reproduce exactly (XERK-2109).
  function oldSplitLongWord(word: string, maxWidthPx: number, measure: (s: string) => number): string[] {
    const fits = (s: string) => measure(s) <= maxWidthPx + 1e-6;
    const chunks: string[] = [];
    let rest = Array.from(word);
    while (rest.length > 0 && !fits(rest.join(""))) {
      let lo = 1;
      let hi = rest.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(rest.slice(0, mid).join(""))) lo = mid;
        else hi = mid - 1;
      }
      chunks.push(rest.slice(0, lo).join(""));
      rest = rest.slice(lo);
    }
    if (rest.length > 0) chunks.push(rest.join(""));
    return chunks;
  }

  it("splits a long word exactly as the old binary search did, on varied inputs (XERK-2109)", () => {
    // Uneven per-code-point widths, zero-width ones included (still monotone).
    const uneven = (s: string) => Array.from(s).reduce((w, c) => w + ((c.codePointAt(0)! * 7) % 5), 0);
    const utf16 = (s: string) => s.length;
    const measures = [perChar, charMeasure, uneven, utf16];
    let seed = 12345;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const alphabet = Array.from("abcdefghijXYZ0123456789😀é漢​");
    for (let trial = 0; trial < 300; trial++) {
      const len = rand(400);
      const word = Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join("");
      const width = [0, 0.5, 1, 2, 3, 7, 40, 560][rand(8)]!;
      for (const m of measures) {
        expect(splitLongWord(word, width, m), `trial ${trial} width ${width}`).toEqual(oldSplitLongWord(word, width, m));
      }
    }
  });

  it("wraps a 200k-char unbroken word in well under a second (XERK-2109)", () => {
    const t0 = performance.now();
    const lines = wrapText("x".repeat(200_000), 560);
    expect(lines).toHaveLength(Math.ceil(200_000 / 55));
    // Was ~9.6s here (quadratic); now ~25ms. The bound leaves room for slow CI.
    expect(performance.now() - t0).toBeLessThan(1000);
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
