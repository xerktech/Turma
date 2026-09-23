import { getAdvW } from "@evenrealities/pretext";
import { afterEach, describe, expect, it } from "vitest";
import { fontSafe, pretextGlyphCoverage, setGlyphCoverage } from "./font.ts";
import { emptyBuffer, mergeTail } from "./transcript.ts";
import { sessionName } from "./sessions.ts";
import type { SessionInfo } from "./types.ts";

// XERK-928. Codepoints are built from numbers so glyphs.test.ts's source scan
// (XERK-923) doesn't flag this file's own inputs.
const s = (...cps: number[]): string => String.fromCodePoint(...cps);
const missing = (t: string): string[] => [...t].filter((c) => getAdvW(c.codePointAt(0)!) === 0);

// The simulator's "glyph dsc. not found" set from the ticket, 19/19.
const SIM_MISSING = [
  0x2713, 0x2717, 0x2714, 0x2718, 0x2715, 0x2716, 0x25fc, 0x22ef, 0x2610, 0x2611, 0x21bb, 0x25b8, 0x25be,
  0x2699, 0x26a0, 0x23f3, 0x231b, 0x1f4ad, 0x1f9e0,
];
// Chars the simulator drew without warning — must pass through untouched.
const RENDERS = "√ x × • ● … — → · » ─ ○ ◐ ▶ ✅ 😀 ╳ ‹ › ↑ ↓ ↗ é ü ß 中 Ж";

const pretext = (cp: number): boolean => getAdvW(cp) > 0;

afterEach(() => setGlyphCoverage(null));

describe("fontSafe", () => {
  it("the probe set really is missing from the font (else the tests pass vacuously)", () => {
    expect(missing(s(...SIM_MISSING))).toHaveLength(SIM_MISSING.length);
  });

  it("leaves no missing glyph behind once pretext's table is installed", () => {
    setGlyphCoverage(pretext);
    const out = fontSafe(SIM_MISSING.map((cp) => s(cp)).join(" ") + " done");
    expect(missing(out)).toEqual([]);
    expect(out.endsWith("done")).toBe(true);
  });

  it("passes glyphs the font has through unchanged", () => {
    setGlyphCoverage(pretext);
    expect(fontSafe(RENDERS)).toBe(RENDERS);
  });

  it("maps meaningful markers even without pretext (dev/tests)", () => {
    expect(fontSafe(`${s(0x2713)} tests ${s(0x2717)} lint`)).toBe("√ tests x lint");
    expect(fontSafe(`${s(0x2610)} todo ${s(0x2611)} done`)).toBe("[ ] todo [√] done");
    expect(fontSafe(`${s(0x26a0)} careful`)).toBe("! careful");
    // Without the table, an unmapped glyph is left alone rather than guessed at.
    expect(fontSafe(`${s(0x1f9e0)} hmm`)).toBe(`${s(0x1f9e0)} hmm`);
  });

  it("every substitute is itself drawable", () => {
    setGlyphCoverage(pretext);
    for (const cp of SIM_MISSING) {
      const out = fontSafe(s(cp));
      expect(missing(out), `U+${cp.toString(16)} -> ${out}`).toEqual([]);
    }
  });

  it("drops an unmapped glyph together with the space that separated it", () => {
    setGlyphCoverage(pretext);
    expect(fontSafe(`${s(0x1f4ad)} thinking`)).toBe("thinking");
    expect(fontSafe(`a ${s(0x1f9e0)} b`)).toBe("a b");
    expect(fontSafe(`a ${s(0x1f9e0)}${s(0x2699)} b`)).toBe("a b");
    expect(fontSafe(`x${s(0x1f9e0)}y`)).toBe("xy");
    expect(fontSafe("a  b")).toBe("a  b"); // untouched when nothing was dropped
  });

  it("composes a decomposed accent instead of dropping it", () => {
    setGlyphCoverage(pretext);
    expect(fontSafe("caf" + s(0x65, 0x301))).toBe("café");
  });

  it("keeps a drawable compatibility form instead of dropping it", () => {
    setGlyphCoverage(pretext);
    expect(fontSafe(`${s(0xfb01)}le`)).toBe("file"); // the "fi" ligature
  });

  it("says ? rather than vanishing when nothing is drawable", () => {
    setGlyphCoverage(pretext);
    expect(fontSafe(s(0x1f4ad))).toBe("?");
    expect(fontSafe("   ")).toBe("   "); // blank input is not "undrawable"
  });

  it("pretextGlyphCoverage resolves to getAdvW > 0 (the device-path activation)", async () => {
    const has = await pretextGlyphCoverage();
    expect(has).not.toBeNull();
    expect(has!(0x2717)).toBe(false);
    expect(has!(0x221a)).toBe(true);
  });

  it("is linear on a long run of drops", () => {
    setGlyphCoverage(pretext);
    const t0 = performance.now();
    expect(fontSafe(`${s(0x1f9e0)} `.repeat(100_000))).toBe("?");
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("fontSafe wiring", () => {
  it("applies to transcript entries of both roles", () => {
    setGlyphCoverage(pretext);
    const buf = mergeTail(emptyBuffer(), [
      { id: "1", role: "assistant", text: `${s(0x2713)} tests pass ${s(0x1f9e0)}` },
      { id: "2", role: "user", text: `${s(0x26a0)} stop` },
    ]);
    expect(buf.entries.map((e) => e.text)).toEqual(["√ tests pass", "! stop"]);
  });

  it("leaves sessionName alone: the phone shares it and pre-fills Rename from it", () => {
    setGlyphCoverage(pretext);
    const summary = `${s(0x2713)} Fix glyphs`;
    expect(sessionName({ id: "abcdef123", summary } as SessionInfo)).toBe(summary);
  });

  it("keeps a trailing checked box (not stripped as a [ToolName] marker)", () => {
    const buf = mergeTail(emptyBuffer(), [{ id: "1", role: "assistant", text: `All tests pass\n${s(0x2611)}` }]);
    expect(buf.entries[0]!.text).toBe("All tests pass\n[√]");
  });

  it("leaves no bare backticks around an inline-code glyph it dropped", () => {
    setGlyphCoverage(pretext);
    const buf = mergeTail(emptyBuffer(), [{ id: "1", role: "assistant", text: `think \`${s(0x1f9e0)}\` hard` }]);
    expect(buf.entries[0]!.text).toBe("think hard");
    const only = mergeTail(emptyBuffer(), [{ id: "2", role: "assistant", text: `\`${s(0x1f9e0)}\`` }]);
    expect(only.entries[0]!.text).toBe("?");
    const bold = mergeTail(emptyBuffer(), [{ id: "3", role: "assistant", text: `ok **\`${s(0x1f9e0)}\`**` }]);
    expect(bold.entries[0]!.text).toBe("ok");
  });

  it("keeps a bracketed word after a dropped glyph, and swallows the gap", () => {
    setGlyphCoverage(pretext);
    const texts = [`the plan ${s(0x1f9e0)} [WIP]`, `a ${s(0x1f9e0)} b`, `${s(0x1f4ad)} thinking`, `done ${s(0x1f9e0)}\nnext`];
    for (const role of ["assistant", "user"]) {
      const buf = mergeTail(emptyBuffer(), texts.map((text, i) => ({ id: String(i), role, text })));
      expect(buf.entries.map((e) => e.text)).toEqual(["the plan [WIP]", "a b", "thinking", "done\nnext"]);
    }
  });

  it("never rewrites literal **** or `` in prose", () => {
    for (const cov of [null, pretext]) {
      setGlyphCoverage(cov);
      const texts = ["token ****1234 set", "Password is ****", "a ****** b", "type `` to open"];
      const buf = mergeTail(emptyBuffer(), texts.map((text, i) => ({ id: String(i), role: "assistant", text })));
      expect(buf.entries.map((e) => e.text)).toEqual(texts);
    }
  });

  it("leaves a tool-only turn empty (render skips it), not \"?\"", () => {
    for (const cov of [null, pretext]) {
      setGlyphCoverage(cov);
      const buf = mergeTail(emptyBuffer(), [
        { id: "1", role: "assistant", text: "[Bash][Read]" },
        { id: "2", role: "assistant", text: "```\n```" },
      ]);
      expect(buf.entries.map((e) => e.text)).toEqual(["", ""]);
    }
  });
});
