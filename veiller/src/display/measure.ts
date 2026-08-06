// Pixel text measurement for the G2 scene display, vendored (minimally) from
// the engine's display-utils:
//   mobile/modules/engine/src/utils/display/profiles/g1.ts   (glyph table +
//     render formula — G2 uses the same display hardware/font as G1)
//   mobile/modules/engine/src/utils/display/measurer/TextMeasurer.ts
//
// Only what text-wrap.ts's `Measure` seam needs is kept: per-character
// rendered-pixel widths. The full TextMeasurer (script detection tables,
// kinsoku constraints, byte budgets) stays in the engine; this port needs a
// `(s: string) => widthPx` function, nothing more.
//
// Rendered width = (glyphWidth + 1) * 2  (G1FontLoaderKt formula).

import type { Measure } from "../core/text-wrap.ts";

// Complete G1 glyph widths from G1FontLoaderKt (GLYPH widths — multiply via
// the render formula to get rendered pixels). Copied verbatim from the
// engine's g1.ts profile.
const G1_GLYPH_WIDTHS: Record<string, number> = {
  // Punctuation & Symbols
  " ": 2,
  "!": 1,
  '"': 2,
  "#": 6,
  "$": 5,
  "%": 6,
  "&": 7,
  "'": 1,
  "(": 2,
  ")": 2,
  "*": 3,
  "+": 4,
  ",": 1,
  "-": 4,
  ".": 1,
  "/": 3,

  // Numbers
  "0": 5,
  "1": 3,
  "2": 5,
  "3": 5,
  "4": 5,
  "5": 5,
  "6": 5,
  "7": 5,
  "8": 5,
  "9": 5,

  // More punctuation
  ":": 1,
  ";": 1,
  "<": 4,
  "=": 4,
  ">": 4,
  "?": 5,
  "@": 7,

  // Uppercase
  "A": 6,
  "B": 5,
  "C": 5,
  "D": 5,
  "E": 4,
  "F": 4,
  "G": 5,
  "H": 5,
  "I": 2,
  "J": 3,
  "K": 5,
  "L": 4,
  "M": 7,
  "N": 5,
  "O": 5,
  "P": 5,
  "Q": 5,
  "R": 5,
  "S": 5,
  "T": 5,
  "U": 5,
  "V": 6,
  "W": 7,
  "X": 6,
  "Y": 6,
  "Z": 5,

  // Brackets & special
  "[": 2,
  "\\": 3,
  "]": 2,
  "^": 4,
  "_": 3,
  "`": 2,

  // Lowercase
  "a": 5,
  "b": 4,
  "c": 4,
  "d": 4,
  "e": 4,
  "f": 4,
  "g": 4,
  "h": 4,
  "i": 1,
  "j": 2,
  "k": 4,
  "l": 1,
  "m": 7,
  "n": 4,
  "o": 4,
  "p": 4,
  "q": 4,
  "r": 3,
  "s": 4,
  "t": 3,
  "u": 5,
  "v": 5,
  "w": 7,
  "x": 5,
  "y": 5,
  "z": 4,

  // More special
  "{": 3,
  "|": 1,
  "}": 3,
  "~": 7,
};

const renderFormula = (glyphWidth: number): number => (glyphWidth + 1) * 2;

// Uniform-width scripts — ALL characters in these scripts render at exactly
// this many pixels on the G1/G2 firmware font (hardware-verified values from
// the engine's g1.ts). Detection is by Unicode block, mirroring the engine's
// script-detection but reduced to the ranges the widths cover.
const CJK_WIDTH = 18; // CJK ideographs, hiragana, katakana
const KOREAN_WIDTH = 24; // Hangul
const CYRILLIC_WIDTH = 18;

// Fallback for unmapped Latin/unknown characters — MAX Latin width ('m'/'w'
// at (7+1)*2 = 16px), so measurement never under-reports and a line can
// never overflow the display.
const LATIN_MAX_WIDTH = 16;

function uniformScriptWidth(code: number): number | null {
  // Hangul (syllables, jamo, compat jamo)
  if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f)) {
    return KOREAN_WIDTH;
  }
  // Hiragana / Katakana
  if (code >= 0x3040 && code <= 0x30ff) return CJK_WIDTH;
  // CJK ideographs (unified + ext A), CJK punctuation, fullwidth forms
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return CJK_WIDTH;
  }
  // Cyrillic
  if (code >= 0x0400 && code <= 0x04ff) return CYRILLIC_WIDTH;
  return null;
}

// Pre-computed rendered widths for the mapped glyphs, plus a growing cache
// for everything else (the same memoization TextMeasurer does).
const charCache = new Map<string, number>();
for (const [ch, glyphWidth] of Object.entries(G1_GLYPH_WIDTHS)) {
  charCache.set(ch, renderFormula(glyphWidth));
}

export function measureChar(ch: string): number {
  const cached = charCache.get(ch);
  if (cached !== undefined) return cached;
  const code = ch.codePointAt(0) ?? 0;
  const width = uniformScriptWidth(code) ?? LATIN_MAX_WIDTH;
  charCache.set(ch, width);
  return width;
}

export function measureText(s: string): number {
  let total = 0;
  for (const ch of s) total += measureChar(ch);
  return total;
}

// The `Measure` the background boot hands to text-wrap's setDefaultMeasure —
// every wrapText/measureDefault call then uses real G2 font metrics.
export function createG2Measure(): Measure {
  return measureText;
}
