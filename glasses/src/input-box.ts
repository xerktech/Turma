// PURE helpers for the bottom "input box" on the session screen: geometry
// (how many lines it occupies) and the text bodies for its two modes —
// free-text input and the AskUserQuestion sheet — plus the right-corner
// status label. No SDK, no state machine, no Date.now: everything here is
// data in, strings out. Ported from ClaudeHUD's plugin/src/screens/
// input-strip.ts (box body + status label) and prompt-sheet.ts (sheet
// windowing idea), adapted to this codebase's units.
import { DISPLAY_LINES, LINE_WIDTH_PX } from "./layout.ts";
import { wrapText } from "./text-wrap.ts";

export type MicState = "idle" | "recording" | "finalising" | "error";

// Half the canvas's 10 text lines. The bottom box (input or sheet) never
// grows past this so the transcript above it always keeps at least half
// the screen.
export const BOTTOM_MAX_LINES = Math.floor(DISPLAY_LINES / 2);

// How many text lines the bottom box should occupy for the given wrapped
// content — at least 1 (never fully collapse), capped at BOTTOM_MAX_LINES.
export function bottomBoxLines(contentLines: string[]): number {
  return Math.max(1, Math.min(BOTTOM_MAX_LINES, contentLines.length));
}

// Windows `lines` down to at most BOTTOM_MAX_LINES, keeping the tail
// visible by default and shifting the window back by `viewOffset` lines
// (clamped so it never scrolls past the top). Shared by inputBoxBody's
// free-text path.
function windowTail(lines: string[], viewOffset: number): string[] {
  const total = lines.length;
  const maxOffset = Math.max(0, total - BOTTOM_MAX_LINES);
  const offset = Math.max(0, Math.min(viewOffset, maxOffset));
  const end = total - offset;
  const start = Math.max(0, end - BOTTOM_MAX_LINES);
  return lines.slice(start, end);
}

// Input-mode body: the visible (windowed) text for the box, given the draft
// text, focus, mic state, and a scroll offset within a tall box. Mic state
// takes priority over the text itself — a user actively dictating should
// always see that reflected regardless of what's already been typed.
export function inputBoxBody(opts: {
  text: string;
  focused: boolean;
  mic: MicState;
  viewOffset: number;
}): string[] {
  const { text, focused, mic, viewOffset } = opts;
  if (mic === "recording") return ["> Listening…"];
  if (mic === "finalising") return ["> Processing…"];
  if (text.length === 0) return focused ? ["> Tap to dictate…"] : [""];

  const prefix = focused ? "> " : "  ";
  const wrapped = wrapText(text, LINE_WIDTH_PX);
  const windowed = windowTail(wrapped, viewOffset);
  if (windowed.length === 0) return windowed;
  return [`${prefix}${windowed[0]}`, ...windowed.slice(1)];
}

// Sheet-mode body: wrapped question title lines + numbered option rows +
// a trailing "Dictate answer…" row, windowed around `selected` so it stays
// visible even when the option list overflows BOTTOM_MAX_LINES.
export function sheetBody(opts: { question: string; options: string[]; selected: number }): string[] {
  const { question, options } = opts;
  const rows = [...options.map((opt, i) => `${i + 1}. ${opt}`), `${options.length + 1}. Dictate answer…`];
  const total = rows.length;
  // Clamp `selected` once so the window math and the row marking agree even
  // if a caller passes an out-of-range index.
  const selected = Math.max(0, Math.min(opts.selected, total - 1));

  // Reserve at least one option row: cap the question portion so it never
  // eats the whole box, then the option area is whatever's left. This keeps
  // the combined output within BOTTOM_MAX_LINES even for a question that
  // wraps to many lines.
  const questionLines = wrapText(question, LINE_WIDTH_PX).slice(0, BOTTOM_MAX_LINES - 1);
  const area = BOTTOM_MAX_LINES - questionLines.length;

  let start = 0;
  if (total > area) {
    start = Math.max(0, selected - Math.floor(area / 2));
    start = Math.min(start, total - area);
  }
  const visibleRows = rows
    .slice(start, start + area)
    .map((row, i) => (start + i === selected ? `> ${row}` : `  ${row}`));

  return [...questionLines, ...visibleRows];
}

// Short right-corner status label from live state + mic. Mic state wins
// over the live/thinking state — a user holding the mic should see their
// own action reflected, not the background "Working"/"Waiting" signal.
export function statusLabel(opts: {
  mic: MicState;
  live: "working" | "waiting" | "idle" | "stopped" | "error";
}): string {
  switch (opts.mic) {
    case "recording":
      return "[REC]";
    case "finalising":
      return "[…]";
    case "error":
      return "[!]";
    case "idle":
      break;
  }
  switch (opts.live) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "stopped":
      return "Stopped";
    case "error":
      return "Error";
  }
}
