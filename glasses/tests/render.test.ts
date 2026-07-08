import { describe, it, expect } from "vitest";
import { render, wrap, windowRange, actionsFor } from "../src/render.js";
import { flattenSessions, sortSessions, findRef } from "../src/sessions.js";
import { agentsFixture } from "./fixtures.js";
import { GRID } from "../src/constants.js";
import type { AppState } from "../src/app.js";

// A minimal AppState stand-in so render() can be exercised without the full App
// I/O wiring. render() only reads state, never mutates.
function stateAt(screen: AppState["screen"]["name"], extra: Partial<AppState> = {}): AppState {
  const refs = sortSessions(flattenSessions(agentsFixture()));
  return {
    agents: agentsFixture(),
    refs,
    screen: { name: screen },
    flash: null,
    focus: { hostKey: "nas-agent", id: "ab12" },
    home: { sel: 0 },
    session: { page: 0 },
    actions: { sel: 0 },
    reply: { text: "", listening: false, sending: false, error: null },
    confirm: { action: "delete", sel: 0 },
    newHost: { sel: 0 },
    newRepo: { hostKey: "nas-agent", sel: 0 },
    currentRef() {
      return this.focus ? findRef(this.refs, this.focus.hostKey, this.focus.id) : undefined;
    },
    ...extra,
  } as AppState;
}

describe("text utilities", () => {
  it("wraps to the column width", () => {
    const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
    expect(lines.every((l) => l.length <= 12)).toBe(true);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("hard-splits an over-long word", () => {
    expect(wrap("x".repeat(50), 10).every((l) => l.length <= 10)).toBe(true);
  });

  it("windows around the selection", () => {
    expect(windowRange(10, 8, 4)).toEqual([6, 10]); // clamps to the end
    expect(windowRange(3, 0, 5)).toEqual([0, 3]); // fits without a window
  });
});

describe("render", () => {
  it("never exceeds the HUD grid on any screen", () => {
    for (const s of ["home", "session", "actions", "reply", "confirm", "newHost", "newRepo"] as const) {
      const out = render(stateAt(s));
      const rows = out.split("\n");
      expect(rows.length).toBeLessThanOrEqual(GRID.ROWS);
      expect(rows.every((l) => l.length <= GRID.COLS)).toBe(true);
    }
  });

  it("home lists sessions and the new-session row", () => {
    const out = render(stateAt("home"));
    expect(out).toContain("ab12");
    expect(out).toContain("+ New session");
    expect(out).toMatch(/ask/); // waiting count in the header
  });

  it("session screen shows the pending question and tail", () => {
    const out = render(stateAt("session"));
    expect(out).toContain("? Deploy to prod"); // question, prefixed
    expect(out).toMatch(/ASK/); // waiting marker in header
  });

  it("action menu adapts to running vs stopped", () => {
    const running = findRef(sortSessions(flattenSessions(agentsFixture())), "nas-agent", "ab12")!;
    const stopped = findRef(sortSessions(flattenSessions(agentsFixture())), "nas-agent", "cd34")!;
    expect(actionsFor(running)).toContain("reply");
    expect(actionsFor(running)).toContain("kill");
    expect(actionsFor(stopped)).toContain("start");
    expect(actionsFor(stopped)).not.toContain("reply");
  });
});
