// Shared G2-canvas display-geometry constants. Pulled out of render.ts into
// their own module because render.ts now imports from input-box.ts (for the
// session bottom-bar helpers) while input-box.ts imports these constants —
// keeping them here (rather than in render.ts, which input-box.ts would then
// have to import back) avoids a render.ts <-> input-box.ts circular import.
// (A previous version of this had DISPLAY_LINES/LINE_WIDTH_PX declared in
// render.ts with input-box.ts importing them from there; under Vite/esbuild's
// module evaluation order that cycle left BOTTOM_MAX_LINES computed as NaN
// depending on which module loaded first — moving the constants here removes
// the cycle entirely.)
export const DISPLAY_LINES = 10;
export const LINE_WIDTH_PX = 560;
