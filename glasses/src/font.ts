// Makes hub-supplied text (transcript turns, session summaries) drawable by the
// G2 firmware font (XERK-928). The G2 renders through LVGL with a fixed fallback
// chain (evenroster -> evenroster_crylgrek -> cn -> evenemoji); a codepoint none
// of them carry draws as a blank gap, and Claude's output is full of them
// (✓ ✗ ⚠ ☐ ▸ 💭 …). Source literals are guarded separately (glyphs.test.ts,
// XERK-923); this covers the text we don't write.
//
// Two layers:
//  - A fixed substitution table for the common markers whose MEANING matters
//    (a check vs a cross), mapped to glyphs the font has. Always on, so dev and
//    tests without pretext still get it.
//  - Any other non-ASCII codepoint the font lacks is dropped, judged by
//    `@evenrealities/pretext`'s `getAdvW` (0 = missing; it matches the
//    simulator's "glyph dsc. not found" set exactly). That table is ~670 KB and
//    is only loaded lazily on the device path (main.ts), so the check is
//    installed at boot via setGlyphCoverage and is off until then.
//
// Keys are codepoint NUMBERS on purpose: glyphs.test.ts fails on any missing
// glyph in a source string literal, escapes included.
const SUBSTITUTES = new Map<number, string>([
  [0x2713, "√"], // check mark
  [0x2714, "√"], // heavy check mark
  [0x2717, "x"], // ballot x
  [0x2718, "x"], // heavy ballot x
  [0x2715, "x"], // multiplication x
  [0x2716, "x"], // heavy multiplication x
  [0x2610, "[ ]"], // ballot box
  [0x2611, "[√]"], // ballot box with check — not "[x]", which transcript.ts
  // would strip as a trailing [ToolName] marker
  [0x26a0, "!"], // warning sign
  [0x25b8, "»"], // small right-pointing triangle
  [0x25be, "▼"], // small down-pointing triangle
  [0x25fc, "■"], // medium black square
  [0x22ef, "…"], // midline horizontal ellipsis
]);

let hasGlyph: ((cp: number) => boolean) | null = null;

// Installs (or, with null, removes) the font-coverage check. main.ts calls it
// at boot with pretext's table, before any transcript is ingested.
export function setGlyphCoverage(fn: ((cp: number) => boolean) | null): void {
  hasGlyph = fn;
}

// fontSafe, but text with nothing drawable comes back empty (not "?"), for a
// caller with its own fallback or its own later trims (transcript.ts, render.ts).
export function fontStrip(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text; // all ASCII: nothing to do
  let out = "";
  // After dropping a glyph, swallow the space that separated it from the next
  // word ("💭 thinking" -> "thinking", "a 🧠 b" -> "a b"), but only where the
  // output already ends in whitespace, so "x🧠y" -> "xy" loses nothing else.
  let dropped = false;
  // NFC first: a decomposed "e" + U+0301 composes to "é", which the font has,
  // rather than leaving a combining mark it doesn't.
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80) {
      const sub = SUBSTITUTES.get(cp);
      if (sub !== undefined) {
        out += sub;
        dropped = false;
        continue;
      }
      if (hasGlyph && !hasGlyph(cp)) {
        // A compatibility form (the "fi" ligature, a fullwidth letter) may have
        // a drawable NFKC equivalent; keep that rather than lose letters.
        const compat = ch.normalize("NFKC");
        if (compat !== ch && [...compat].every((c) => c.codePointAt(0)! < 0x80 || hasGlyph!(c.codePointAt(0)!))) {
          out += compat;
          dropped = false;
          continue;
        }
        dropped = true;
        continue;
      }
    }
    if (dropped && (ch === " " || ch === "\t") && (out === "" || " \t\n".includes(out[out.length - 1]!))) continue;
    dropped = false;
    out += ch;
  }
  return out;
}

// Text made only of undrawable glyphs (an emoji-only reply, a script the font
// lacks) would otherwise vanish — the renderer skips an empty turn — so say so.
export function undrawable(original: string, safe: string): string {
  return safe.trim() === "" && original.trim() !== "" ? "?" : safe;
}

export function fontSafe(text: string): string {
  return undrawable(text, fontStrip(text));
}

// Resolves pretext's glyph table on the device path, or null where the package
// can't be loaded — the same fallback as text-wrap.ts's pretextMeasure.
export async function pretextGlyphCoverage(): Promise<((cp: number) => boolean) | null> {
  try {
    const mod: unknown = await import("@evenrealities/pretext");
    const candidate =
      (mod as { getAdvW?: unknown }).getAdvW ?? (mod as { default?: { getAdvW?: unknown } }).default?.getAdvW;
    if (typeof candidate !== "function") return null;
    const getAdvW = candidate as (cp: number) => number;
    return (cp: number) => getAdvW(cp) > 0;
  } catch {
    return null;
  }
}
