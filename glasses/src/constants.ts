// G2 hardware limits that shape the UI. Verified figures:
//   - 576 x 288 px micro-LED, 4-bit grayscale (16 levels of green) — monochrome,
//     so status is conveyed with glyphs/words, never colour.
//   - Text-only is the reliable surface; images are <=200x100, max 4/page and
//     slow, so this app renders no images.
//   - Input is discrete: temple taps + the R1 ring produce CLICK / DOUBLE_CLICK
//     / SCROLL_TOP / SCROLL_BOTTOM events. No pointer, no keyboard.
export const SCREEN = { W: 576, H: 288 } as const;

// Best-guess character grid for the default G2 font. There is no SDK font-size
// API, so these are tuned conservatively to never overflow the HUD; refine them
// against the everything-evenhub `font-measurement` skill on real hardware.
export const GRID = { ROWS: 6, COLS: 44 } as const;

// Status glyphs (monochrome-safe — no colour to lean on).
export const GLYPH = {
  working: "*", // actively producing output
  waiting: "?", // blocked on a question — needs you
  idle: "-", // running but quiet
  stopped: "o", // not running
  error: "!", // failed
  cursor: "▸", // ▸ selection marker
} as const;
