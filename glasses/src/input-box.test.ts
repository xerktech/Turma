import { describe, expect, it } from "vitest";
import { BOTTOM_MAX_LINES, bottomBoxLines, inputBoxBody, sheetBody, statusLabel } from "./input-box.ts";

describe("bottomBoxLines", () => {
  it("clamps to a minimum of 1 line when content is empty", () => {
    expect(bottomBoxLines([])).toBe(1);
  });

  it("grows with content up to BOTTOM_MAX_LINES", () => {
    expect(bottomBoxLines(["a", "b", "c"])).toBe(3);
    expect(bottomBoxLines(["a", "b", "c", "d", "e"])).toBe(BOTTOM_MAX_LINES);
  });

  it("clamps to BOTTOM_MAX_LINES when content overflows", () => {
    expect(bottomBoxLines(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])).toBe(BOTTOM_MAX_LINES);
  });
});

describe("inputBoxBody", () => {
  it("shows a listening indicator while the mic is recording, regardless of text", () => {
    expect(inputBoxBody({ text: "hello", focused: true, mic: "recording", viewOffset: 0 })).toEqual([
      "> Listening…",
    ]);
    expect(inputBoxBody({ text: "", focused: false, mic: "recording", viewOffset: 0 })).toEqual([
      "> Listening…",
    ]);
  });

  it("shows a processing indicator while the mic is finalising", () => {
    expect(inputBoxBody({ text: "hello", focused: true, mic: "finalising", viewOffset: 0 })).toEqual([
      "> Processing…",
    ]);
  });

  it("shows a focused placeholder when text is empty and the box is focused", () => {
    expect(inputBoxBody({ text: "", focused: true, mic: "idle", viewOffset: 0 })).toEqual([
      "> Tap to dictate…",
    ]);
  });

  it("shows a blank line when text is empty and the box is unfocused", () => {
    expect(inputBoxBody({ text: "", focused: false, mic: "idle", viewOffset: 0 })).toEqual([""]);
  });

  it("shows a focused placeholder when text is empty even if mic errored", () => {
    expect(inputBoxBody({ text: "", focused: true, mic: "error", viewOffset: 0 })).toEqual([
      "> Tap to dictate…",
    ]);
  });

  it("wraps and prefixes short text with '> ' when focused", () => {
    expect(inputBoxBody({ text: "hi there", focused: true, mic: "idle", viewOffset: 0 })).toEqual([
      "> hi there",
    ]);
  });

  it("wraps and prefixes short text with two spaces when unfocused", () => {
    expect(inputBoxBody({ text: "hi there", focused: false, mic: "idle", viewOffset: 0 })).toEqual([
      "  hi there",
    ]);
  });

  it("windows long text down to at most BOTTOM_MAX_LINES, keeping the tail visible", () => {
    const text = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
    const lines = inputBoxBody({ text, focused: true, mic: "idle", viewOffset: 0 });
    expect(lines).toEqual(["> line3", "line4", "line5", "line6", "line7"]);
    expect(lines.length).toBeLessThanOrEqual(BOTTOM_MAX_LINES);
  });

  it("shifts the window back by viewOffset", () => {
    const text = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
    const lines = inputBoxBody({ text, focused: true, mic: "idle", viewOffset: 2 });
    expect(lines).toEqual(["> line1", "line2", "line3", "line4", "line5"]);
  });

  it("clamps an out-of-range viewOffset instead of overshooting the start", () => {
    const text = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
    const lines = inputBoxBody({ text, focused: true, mic: "idle", viewOffset: 999 });
    expect(lines).toEqual(["> line1", "line2", "line3", "line4", "line5"]);
  });
});

describe("sheetBody", () => {
  it("wraps the question, numbers options, and appends a Dictate answer row", () => {
    const lines = sheetBody({ question: "Pick one?", options: ["Red", "Green"], selected: 0 });
    expect(lines).toEqual(["Pick one?", "> 1. Red", "  2. Green", "  3. Dictate answer…"]);
  });

  it("marks the selected option row", () => {
    const lines = sheetBody({ question: "Pick one?", options: ["Red", "Green"], selected: 1 });
    expect(lines).toEqual(["Pick one?", "  1. Red", "> 2. Green", "  3. Dictate answer…"]);
  });

  it("marks the Dictate answer row as selected when it's the chosen index", () => {
    const lines = sheetBody({ question: "Pick one?", options: ["Red", "Green"], selected: 2 });
    expect(lines).toEqual(["Pick one?", "  1. Red", "  2. Green", "> 3. Dictate answer…"]);
  });

  it("stays within BOTTOM_MAX_LINES for a long multi-line question and keeps the selected row visible", () => {
    const question = "word ".repeat(60).trim(); // ~300 chars -> wraps to several lines
    const options = ["Red", "Green", "Blue"];
    const lines = sheetBody({ question, options, selected: 1 });
    expect(lines.length).toBeLessThanOrEqual(BOTTOM_MAX_LINES);
    expect(lines).toContain("> 2. Green");
  });

  it("clamps an out-of-range selected so a row is still marked", () => {
    const lines = sheetBody({ question: "Pick one?", options: ["Red", "Green"], selected: 99 });
    expect(lines).toEqual(["Pick one?", "  1. Red", "  2. Green", "> 3. Dictate answer…"]);
  });

  it("windows a long option list so the selected row stays visible", () => {
    const options = ["Red", "Green", "Blue", "Yellow", "Purple", "Orange", "Pink"];
    const lines = sheetBody({ question: "Pick a color?", options, selected: 5 });
    expect(lines).toEqual([
      "Pick a color?",
      "  4. Yellow",
      "  5. Purple",
      "> 6. Orange",
      "  7. Pink",
    ]);
    expect(lines.length).toBeLessThanOrEqual(BOTTOM_MAX_LINES);
  });
});

describe("statusLabel", () => {
  it("lets an active mic win over the live state", () => {
    expect(statusLabel({ mic: "recording", live: "idle" })).toBe("[REC]");
    expect(statusLabel({ mic: "finalising", live: "working" })).toBe("[…]");
    expect(statusLabel({ mic: "error", live: "waiting" })).toBe("[!]");
  });

  it("maps each live state when the mic is idle", () => {
    expect(statusLabel({ mic: "idle", live: "working" })).toBe("Working");
    expect(statusLabel({ mic: "idle", live: "waiting" })).toBe("Waiting");
    expect(statusLabel({ mic: "idle", live: "idle" })).toBe("Idle");
    expect(statusLabel({ mic: "idle", live: "stopped" })).toBe("Stopped");
    expect(statusLabel({ mic: "idle", live: "error" })).toBe("Error");
  });
});
