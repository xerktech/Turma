// PURE helpers for the bottom "input box" on the session screen: geometry
// (how many lines it occupies) and the text bodies for its two modes —
// free-text input and the AskUserQuestion sheet — plus the right-corner
// status label. No SDK, no state machine, no Date.now: everything here is
// data in, strings out.
import { DISPLAY_LINES, LINE_WIDTH_PX } from "./layout.ts";
import { measureDefault, measureGeneration, wrapText } from "./text-wrap.ts";

export type MicState = "idle" | "recording" | "finalising" | "error";

// Half the canvas's 10 text lines. The bottom box (input or sheet) never
// grows past this so the transcript above it always keeps at least half
// the screen.
export const BOTTOM_MAX_LINES = Math.floor(DISPLAY_LINES / 2);

// The menu-overlay box (actions menu / confirm dialog) is taller than the
// input/sheet box: it may show a title plus several option rows. Cap it so at
// least two transcript lines stay visible behind it.
export const MENU_MAX_LINES = DISPLAY_LINES - 2;

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

// How far the box can scroll back from the tail for a given draft — the
// same bound `windowTail` clamps `viewOffset` against, exposed so app.ts's
// bottom-box scroll dispatch (Task 5) can tell "already at the top" apart
// from "more to scroll" without duplicating the wrap/width math here.
export function draftMaxViewOffset(text: string): number {
  const wrapped = wrapText(text, LINE_WIDTH_PX);
  return Math.max(0, wrapped.length - BOTTOM_MAX_LINES);
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

// The sheet's numbered rows, wrapped. Memoized on the labels (and the measure
// generation): every repaint and every scroll re-renders the sheet, and a
// long spaceless label costs a hard-split under the font measure each time.
let sheetRowCache: { key: string; rows: string[][] } | null = null;
function sheetRowLines(labels: string[]): string[][] {
  const key = JSON.stringify([measureGeneration(), labels]);
  if (sheetRowCache?.key === key) return sheetRowCache.rows;
  const width = LINE_WIDTH_PX - Math.max(measureDefault("> "), measureDefault("  "));
  const rows = labels.map((label, r) => {
    const num = `${r + 1}.`;
    const wrapped = wrapText(label, width - measureDefault(`${num} `));
    return wrapped.length ? [`${num} ${wrapped[0]}`, ...wrapped.slice(1)] : [num];
  });
  sheetRowCache = { key, rows };
  return rows;
}

// Sheet-mode body: wrapped question title lines + numbered option rows +
// a trailing "Dictate answer…" row, windowed around `selected` so it stays
// visible even when the option list overflows BOTTOM_MAX_LINES.
// Options are wrapped here and windowed by DISPLAY line, not by option: an
// over-wide row handed to the display wraps there, uncounted, and pushes the
// selected row out of the box while a tap still picks it.
export function sheetBody(opts: { question: string; options: string[]; selected: number }): string[] {
  const { question, options } = opts;
  const labels = [...options, "Dictate answer…"];
  const total = labels.length;
  // Clamp `selected` once so the window math and the row marking agree even
  // if a caller passes an out-of-range index.
  const selected = Math.max(0, Math.min(opts.selected, total - 1));

  // Reserve at least one option line: cap the question portion so it never
  // eats the whole box, then the option area is whatever's left. This keeps
  // the combined output within BOTTOM_MAX_LINES even for a question that
  // wraps to many lines.
  const questionLines = wrapText(question, LINE_WIDTH_PX).slice(0, BOTTOM_MAX_LINES - 1);
  const area = BOTTOM_MAX_LINES - questionLines.length;

  // Each row's wrapped lines: the number leads the label's first line (the
  // label wraps in the width left after it), the row is marked there, and its
  // continuation lines are indented under it.
  const lines: string[] = [];
  const rowStarts: number[] = [];
  sheetRowLines(labels).forEach((rowLines, r) => {
    rowStarts.push(lines.length);
    rowLines.forEach((line, i) => lines.push(i === 0 && r === selected ? `> ${line}` : `  ${line}`));
  });
  rowStarts.push(lines.length);
  const first = rowStarts[selected]!;
  const count = rowStarts[selected + 1]! - first;

  // Centre the selected row's lines (the same placement the one-line-per-row
  // window had), clamped at both ends; a row taller than the area shows its head.
  let start = 0;
  if (lines.length > area) {
    start = count >= area ? first : Math.max(0, first - Math.ceil((area - count) / 2));
    start = Math.min(start, lines.length - area);
    // Never open the window mid-row, where a continuation line has no number:
    // back up to that row's first line if the selected row still fits, else
    // skip ahead to the next row's.
    if (!rowStarts.includes(start)) {
      const owner = rowStarts.filter((s) => s < start).pop()!;
      start = owner + area >= first + count ? owner : rowStarts.find((s) => s > start)!;
    }
  }
  return [...questionLines, ...lines.slice(start, start + area)];
}

// Short right-corner status label from live state + mic. Mic state wins
// over the live/thinking state — a user holding the mic should see their
// own action reflected, not the background "Working"/"Waiting" signal.
export function statusLabel(opts: {
  mic: MicState;
  live: "working" | "waiting" | "holding" | "idle" | "stopped" | "error";
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
    case "holding":
      return "Holding";
    case "idle":
      return "Idle";
    case "stopped":
      return "Stopped";
    case "error":
      return "Error";
  }
}

// Menu-mode body for the actions/confirm overlay: a wrapped title line (or
// lines) followed by option rows, each prefixed "> " when selected / "  "
// otherwise, windowed around `selected` so it stays visible when the list
// overflows MENU_MAX_LINES. Mirrors sheetBody's windowing, minus the numbering.
export function menuBox(opts: { title: string; rows: string[]; selected: number }): string[] {
  const { title, rows } = opts;
  const total = rows.length;
  // Clamp `selected` once so the window math and the row marking agree even
  // if a caller passes an out-of-range index.
  const selected = Math.max(0, Math.min(opts.selected, total - 1));

  // Reserve at least one option row: cap the title portion, the option area is
  // whatever's left, keeping the combined output within MENU_MAX_LINES.
  const titleLines = wrapText(title, LINE_WIDTH_PX).slice(0, MENU_MAX_LINES - 1);
  const area = MENU_MAX_LINES - titleLines.length;

  let start = 0;
  if (total > area) {
    start = Math.max(0, selected - Math.floor(area / 2));
    start = Math.min(start, total - area);
  }
  const visibleRows = rows
    .slice(start, start + area)
    .map((row, i) => (start + i === selected ? `> ${row}` : `  ${row}`));

  return [...titleLines, ...visibleRows];
}
