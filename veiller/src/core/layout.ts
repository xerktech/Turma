// Shared G2-canvas display-geometry constants. Pulled out of render.ts into
// their own module because render.ts now imports from input-box.ts (for the
// session bottom-bar helpers) while input-box.ts imports these constants —
// keeping them here avoids a render.ts <-> input-box.ts circular import.
//
// Adapted for the Mentra scene-display path (Veiller port, XERK-211): the
// upstream Even Hub WebView drew ~27px lines (~10 per 288px canvas); the
// Mentra host renders G2 text at a hardware-calibrated 40px line height (see
// mobile/modules/engine/src/utils/display/profiles/g2.ts), so the same
// 576x288 canvas fits 7 lines. Everything downstream (BOTTOM_MAX_LINES,
// MENU_MAX_LINES, transcript windowing) derives from these two constants.
export const DISPLAY_LINES = 7; // G2 scene: 288px / 40px lines
export const LINE_WIDTH_PX = 560; // 576px canvas minus safety margin
