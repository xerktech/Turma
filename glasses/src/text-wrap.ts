// Greedy word-wrap for the glasses display (576x288, ~560px usable line
// width). No DOM/measurement dependency by default — `charMeasure` is a flat
// per-character approximation good enough for the monospace-ish glasses
// font; `pretextMeasure()` upgrades to real font metrics when
// `@evenrealities/pretext` is available (browser/packaged app), and silently
// falls back otherwise so tests and plain Node never need that package.

// ~55 characters fill the display's ~560px usable width.
export const PX_PER_CHAR = 560 / 55;

export function charMeasure(s: string): number {
  return s.length * PX_PER_CHAR;
}

export type Measure = (s: string) => number;

// Module-level default measure, swappable at boot. `render.ts`'s `wrap()`
// helper calls `wrapText(text, width)` with no explicit measure — leaving it
// on `charMeasure` in dev/tests, and letting main.ts's Even Hub bridge path
// upgrade every wrap call to real font metrics (via `pretextMeasure()`
// below) without changing render.ts's signature or touching the
// hardware-agnostic core. Default-parameter expressions are evaluated at
// call time, so re-pointing `defaultMeasure` here takes effect immediately
// for every future `wrapText(text, width)` call.
let defaultMeasure: Measure = charMeasure;

// Bumped every time the default measure is re-pointed (main.ts's boot upgrade
// to real pretext font metrics). Callers that cache wrapped output (render.ts's
// per-entry wrap memo) fold this into their cache key, so a metric change can
// never serve a wrap computed under the old font.
let measureGen = 0;

export function setDefaultMeasure(measure: Measure): void {
  defaultMeasure = measure;
  measureGen++;
}

// The current default-measure generation (see setDefaultMeasure). Increments
// on every swap; a stable value means the wrap cache stays valid.
export function measureGeneration(): number {
  return measureGen;
}

// Tolerance for float rounding in measure functions (px-per-char
// multiplication isn't exact) — never lets a hair-thin overflow force an
// extra wrap point.
const EPSILON = 1e-6;

function fits(s: string, maxWidthPx: number, measure: Measure): boolean {
  return measure(s) <= maxWidthPx + EPSILON;
}

// Hard-splits a single word wider than maxWidthPx into width-fitting chunks.
// Always makes progress (splits at least one character) even if a single
// character alone exceeds maxWidthPx, so it never infinite-loops.
function splitLongWord(word: string, maxWidthPx: number, measure: Measure): string[] {
  const chunks: string[] = [];
  let remainder = word;
  while (remainder.length > 0 && !fits(remainder, maxWidthPx, measure)) {
    let splitAt = remainder.length;
    while (splitAt > 1 && !fits(remainder.slice(0, splitAt), maxWidthPx, measure)) {
      splitAt--;
    }
    chunks.push(remainder.slice(0, splitAt));
    remainder = remainder.slice(splitAt);
  }
  if (remainder.length > 0) chunks.push(remainder);
  return chunks;
}

// Greedy word-wrap: packs words onto a line until the next word would
// overflow maxWidthPx, then starts a new line. A single word wider than
// maxWidthPx is hard-split across as many lines as it needs. `\n` in the
// input forces a line break (each paragraph is wrapped independently);
// runs of other whitespace collapse to single spaces, matching how the
// glasses render plain text lines.
export function wrapText(text: string, maxWidthPx: number, measure: Measure = defaultMeasure): string[] {
  if (!text.trim()) return [];

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (fits(candidate, maxWidthPx, measure)) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (fits(word, maxWidthPx, measure)) {
        current = word;
      } else {
        const chunks = splitLongWord(word, maxWidthPx, measure);
        for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]!);
        current = chunks[chunks.length - 1] ?? "";
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// Dynamically imports @evenrealities/pretext and returns a measure function
// backed by its getTextWidth. Falls back to charMeasure if the package isn't
// resolvable (plain Node/vitest runs, or any environment without it) so
// nothing at import time or call time requires the package to exist.
export async function pretextMeasure(): Promise<Measure> {
  try {
    const mod: unknown = await import("@evenrealities/pretext");
    const candidate =
      (mod as { getTextWidth?: unknown }).getTextWidth ??
      (mod as { default?: { getTextWidth?: unknown } }).default?.getTextWidth;
    if (typeof candidate !== "function") throw new Error("pretext: getTextWidth not found");
    const getTextWidth = candidate as (s: string) => number;
    return (s: string) => getTextWidth(s);
  } catch {
    return charMeasure;
  }
}
