import { describe, expect, it } from "vitest";
import { DomDisplay } from "./dom.ts";
import type { ScreenModel } from "../render.ts";

// This suite runs under vitest's default "node" test environment (no jsdom
// dependency in this package), so a real HTMLElement isn't available. A
// minimal fake covering the surface DomDisplay actually touches
// (textContent, tabIndex, addEventListener, focus) is enough to exercise
// render() without pulling in a DOM implementation.
function makeEl(): HTMLElement {
  return {
    textContent: null,
    tabIndex: 0,
    addEventListener: () => {},
    focus: () => {},
  } as unknown as HTMLElement;
}

describe("DomDisplay.render", () => {
  it("renders a {type:'lines'} model by joining lines with \\n (unchanged behavior)", async () => {
    const el = makeEl();
    const display = new DomDisplay(el);
    await display.start();

    const model: ScreenModel = { type: "lines", lines: ["one", "two", "three"] };
    display.render(model);

    expect(el.textContent).toBe("one\ntwo\nthree");
  });

  it("renders a {type:'session'} model by stacking transcript, a status divider, then the bottom box lines", async () => {
    const el = makeEl();
    const display = new DomDisplay(el);
    await display.start();

    const model: ScreenModel = {
      type: "session",
      transcriptLines: ["> hi", "hello there"],
      bottom: { mode: "input", lines: ["> draft text"], status: "Working", focused: true },
    };
    display.render(model);

    const text = el.textContent ?? "";
    const lines = text.split("\n");
    expect(lines[0]).toBe("> hi");
    expect(lines[1]).toBe("hello there");
    // Divider line: dashes with the status right-aligned against the edge.
    expect(lines[2]!.endsWith("Working")).toBe(true);
    expect(lines[2]).toMatch(/^─+Working$/);
    expect(lines[3]).toBe("> draft text");
  });

  it("renders a sheet-mode session model the same way (bottom.lines are already the sheet body)", async () => {
    const el = makeEl();
    const display = new DomDisplay(el);
    await display.start();

    const model: ScreenModel = {
      type: "session",
      transcriptLines: [],
      bottom: {
        mode: "sheet",
        lines: ["question?", "> 1. yes", "  2. no"],
        status: "Waiting",
        focused: true,
        options: ["yes", "no"],
        selected: 0,
      },
    };
    display.render(model);

    const text = el.textContent ?? "";
    expect(text).toContain("question?");
    expect(text).toContain("> 1. yes");
    expect(text.endsWith("2. no")).toBe(true);
  });
});
