import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvenHubDisplay,
  type EvenHubBridge,
  type RebuildContainerConfig,
  type StartUpContainerConfig,
  type TextUpgradeConfig,
} from "./evenhub.ts";
import type { RawEvenHubEvent } from "../input/router.ts";
import type { InputEvent } from "../types.ts";
import type { LifecycleEvent } from "../input/router.ts";
import type { ScreenModel } from "../render.ts";

function fakeBridge(overrides: Partial<EvenHubBridge> = {}): {
  bridge: EvenHubBridge;
  startCalls: StartUpContainerConfig[];
  rebuildCalls: RebuildContainerConfig[];
  upgradeCalls: TextUpgradeConfig[];
  shutDownCalls: (number | undefined)[];
  emit: (e: RawEvenHubEvent) => void;
  unsubscribed: boolean;
} {
  const startCalls: StartUpContainerConfig[] = [];
  const rebuildCalls: RebuildContainerConfig[] = [];
  const upgradeCalls: TextUpgradeConfig[] = [];
  const shutDownCalls: (number | undefined)[] = [];
  let handler: ((e: RawEvenHubEvent) => void) | null = null;
  const state = { unsubscribed: false };

  const bridge: EvenHubBridge = {
    async createStartUpPageContainer(container) {
      startCalls.push(container);
      return 0;
    },
    async rebuildPageContainer(container) {
      rebuildCalls.push(container);
      return true;
    },
    async textContainerUpgrade(container) {
      upgradeCalls.push(container);
      return true;
    },
    async shutDownPageContainer(exitMode) {
      shutDownCalls.push(exitMode);
      return true;
    },
    onEvenHubEvent(cb) {
      handler = cb;
      return () => {
        state.unsubscribed = true;
      };
    },
    ...overrides,
  };

  return {
    bridge,
    startCalls,
    rebuildCalls,
    upgradeCalls,
    shutDownCalls,
    emit: (e) => handler?.(e),
    get unsubscribed() {
      return state.unsubscribed;
    },
  };
}

function linesModel(lines: string[]): ScreenModel {
  return { type: "lines", lines };
}

function sessionModel(opts: {
  transcriptLines?: string[];
  mode?: "input" | "sheet" | "menu";
  lines?: string[];
  status?: string;
}): ScreenModel {
  const mode = opts.mode ?? "input";
  const lines = opts.lines ?? ["> draft"];
  const status = opts.status ?? "Working";
  let bottom: Extract<ScreenModel, { type: "session" }>["bottom"];
  if (mode === "input") bottom = { mode: "input", lines, status, focused: true };
  else if (mode === "sheet") bottom = { mode: "sheet", lines, status, focused: true, options: ["yes", "no"], selected: 0 };
  else bottom = { mode: "menu", lines, status };
  return { type: "session", transcriptLines: opts.transcriptLines ?? ["hello"], bottom };
}

describe("EvenHubDisplay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("start", () => {
    it("creates exactly one full-canvas text container with isEventCapture: 1", async () => {
      const { bridge, startCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      expect(startCalls).toHaveLength(1);
      const call = startCalls[0]!;
      expect(call.containerTotalNum).toBe(1);
      expect(call.textObject).toHaveLength(1);
      const container = call.textObject![0]!;
      expect(container.isEventCapture).toBe(1);
      expect(container.width).toBe(576);
      expect(container.height).toBe(288);
      expect(container.xPosition).toBe(0);
      expect(container.yPosition).toBe(0);
    });

    it("does not throw when createStartUpPageContainer rejects", async () => {
      const { bridge } = fakeBridge({
        createStartUpPageContainer: async () => {
          throw new Error("boom");
        },
      });
      const display = new EvenHubDisplay(bridge);
      await expect(display.start()).resolves.toBeUndefined();
    });
  });

  describe("render", () => {
    it("joins lines with \\n and sends them via textContainerUpgrade", async () => {
      const { bridge, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(linesModel(["line1", "line2", "line3"]));
      expect(upgradeCalls).toHaveLength(1); // leading-edge fire
      expect(upgradeCalls[0]!.content).toBe("line1\nline2\nline3");
      expect(upgradeCalls[0]!.containerID).toBe(0);
      expect(upgradeCalls[0]!.containerName).toBe("main");
    });

    it("debounces rapid render calls to a single trailing update with the last content", async () => {
      const { bridge, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(linesModel(["a"])); // leading fire
      expect(upgradeCalls).toHaveLength(1);
      display.render(linesModel(["b"]));
      display.render(linesModel(["c"]));
      expect(upgradeCalls).toHaveLength(1); // still coalescing

      await vi.advanceTimersByTimeAsync(120);
      expect(upgradeCalls).toHaveLength(2);
      expect(upgradeCalls[1]!.content).toBe("c");
    });

    it("hard-caps content at 2000 chars, truncating from the top", async () => {
      const { bridge, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      const longLine = "b".repeat(2500);
      display.render(linesModel([longLine]));
      expect(upgradeCalls[0]!.content).toHaveLength(2000);
      expect(upgradeCalls[0]!.content).toBe("b".repeat(2000));
    });

    it("does not throw when textContainerUpgrade rejects", async () => {
      const { bridge } = fakeBridge({
        textContainerUpgrade: async () => {
          throw new Error("boom");
        },
      });
      const display = new EvenHubDisplay(bridge);
      await display.start();
      expect(() => display.render(linesModel(["x"]))).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  describe("render — session model (multi-container bottom bar)", () => {
    it("first session render issues a rebuildPageContainer with a transcript container, a bordered box container (borderWidth:1), a status container, and exactly one isEventCapture:1 overlay", async () => {
      const { bridge, rebuildCalls, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(
        sessionModel({ transcriptLines: ["line a", "line b"], lines: ["> draft text"], status: "Working" })
      );

      expect(rebuildCalls).toHaveLength(1);
      expect(upgradeCalls).toHaveLength(0); // no textContainerUpgrade on a shape change

      const containers = rebuildCalls[0]!.textObject!;
      expect(containers.length).toBe(4);

      const captureContainers = containers.filter((c) => c.isEventCapture === 1);
      expect(captureContainers).toHaveLength(1);
      expect(captureContainers[0]!.width).toBe(576);
      expect(captureContainers[0]!.height).toBe(288);

      const boxContainer = containers.find((c) => c.borderWidth === 1);
      expect(boxContainer).toBeDefined();
      expect(boxContainer!.content).toBe("> draft text");

      const transcriptContainer = containers.find((c) => c.content === "line a\nline b");
      expect(transcriptContainer).toBeDefined();
      expect(transcriptContainer!.isEventCapture).not.toBe(1);

      const statusContainer = containers.find((c) => c.content === "Working");
      expect(statusContainer).toBeDefined();
      expect(statusContainer).not.toBe(boxContainer);
    });

    it("a second render with the same shape (same mode + box line count) uses textContainerUpgrade, not another rebuild", async () => {
      const { bridge, rebuildCalls, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ lines: ["> draft"], status: "Working" }));
      expect(rebuildCalls).toHaveLength(1);

      display.render(sessionModel({ lines: ["> draft two"], status: "Waiting" }));
      expect(rebuildCalls).toHaveLength(1); // still just the one rebuild
      expect(upgradeCalls.length).toBeGreaterThan(0); // leading-edge fire of the upgrade debounce
      expect(upgradeCalls.some((u) => u.content === "> draft two")).toBe(true);
      expect(upgradeCalls.some((u) => u.content === "Waiting")).toBe(true);
    });

    it("switching from input mode to sheet mode triggers a rebuild even with an unchanged box line count", async () => {
      const { bridge, rebuildCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ mode: "input", lines: ["> draft"] }));
      expect(rebuildCalls).toHaveLength(1);

      display.render(sessionModel({ mode: "sheet", lines: ["> draft"] }));
      expect(rebuildCalls).toHaveLength(2);
    });

    it("a bottomBoxLines change (same mode) also triggers a rebuild", async () => {
      const { bridge, rebuildCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ mode: "input", lines: ["one line only"] }));
      expect(rebuildCalls).toHaveLength(1);

      display.render(sessionModel({ mode: "input", lines: ["line one", "line two", "line three"] }));
      expect(rebuildCalls).toHaveLength(2);
    });

    it("sizes a menu-mode box container by its full line count (past the 5-line input/sheet cap)", async () => {
      const { bridge, rebuildCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      // Both menus are TALLER than the 5-line input/sheet cap, so under the
      // old bottomBoxLines() sizing both would clamp to 5 lines — identical
      // height and identical shape signature (the second wouldn't even
      // rebuild). Only boxLineCount()'s per-mode sizing tells them apart, so
      // this genuinely regression-guards the clipping bug.
      const eightLineMenu = ["Options", "  Back", "  Send", "  Clear", "  Dictate more", "  Kill", "  Delete", "  X"];
      display.render(sessionModel({ mode: "menu", lines: eightLineMenu, status: "" }));
      const tallBox = rebuildCalls[0]!.textObject!.find((c) => c.borderWidth === 1)!;

      const sixLineMenu = ["Options", "  Back", "  Send", "  Clear", "  Kill", "  Delete"];
      display.render(sessionModel({ mode: "menu", lines: sixLineMenu, status: "" }));
      const shortBox = rebuildCalls[1]!.textObject!.find((c) => c.borderWidth === 1)!;

      expect(tallBox.content).toContain("Delete"); // all eight lines present, not truncated to 5
      expect(tallBox.height!).toBeGreaterThan(shortBox.height!); // 8-line box taller than 6-line box
    });

    it("debounces rapid same-shape session renders to a single trailing textContainerUpgrade batch", async () => {
      const { bridge, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ lines: ["> a"], status: "Working" }));
      const afterRebuild = upgradeCalls.length; // 0 — the first render was a rebuild

      display.render(sessionModel({ lines: ["> b"], status: "Working" })); // leading fire
      expect(upgradeCalls.length).toBe(afterRebuild + 3); // transcript + box + status

      display.render(sessionModel({ lines: ["> c"], status: "Working" }));
      display.render(sessionModel({ lines: ["> d"], status: "Working" }));
      expect(upgradeCalls.length).toBe(afterRebuild + 3); // still coalescing

      await vi.advanceTimersByTimeAsync(120);
      expect(upgradeCalls.length).toBe(afterRebuild + 6); // one trailing batch with "> d"
      expect(upgradeCalls.some((u) => u.content === "> d")).toBe(true);
    });

    it("does not throw when rebuildPageContainer rejects", async () => {
      const { bridge } = fakeBridge({
        rebuildPageContainer: async () => {
          throw new Error("boom");
        },
      });
      const display = new EvenHubDisplay(bridge);
      await display.start();
      expect(() => display.render(sessionModel({}))).not.toThrow();
      await Promise.resolve();
    });

    it("guards currentPageShape against a rebuild rejection: a same-shape render after a rejected rebuild retries the rebuild instead of no-op upgrading", async () => {
      let rebuildCallCount = 0;
      let shouldReject = true;
      const { bridge } = fakeBridge({
        rebuildPageContainer: async () => {
          rebuildCallCount++;
          if (shouldReject) {
            shouldReject = false;
            throw new Error("boom");
          }
          return true;
        },
      });
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ lines: ["> draft"], status: "Working" }));
      expect(rebuildCallCount).toBe(1);

      // Let the rejected rebuild's catch handler run and roll the shape
      // tracker back — without this, the tracker would be stuck advanced to
      // a shape whose containers were never actually built.
      await vi.advanceTimersByTimeAsync(0);

      // Same shape as before. If the tracker had been left advanced despite
      // the rejection, this would wrongly be treated as "already current"
      // and routed through textContainerUpgrade against containers that
      // don't exist on the glasses — a silent no-op (frozen screen).
      display.render(sessionModel({ lines: ["> draft"], status: "Working" }));
      expect(rebuildCallCount).toBe(2);
    });
  });

  describe("render — session <-> lines transitions", () => {
    it("a lines render after a session render rebuilds the page back to the single full-canvas container", async () => {
      const { bridge, rebuildCalls, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ lines: ["> draft"], status: "Working" }));
      expect(rebuildCalls).toHaveLength(1); // session rebuild
      const upgradesBeforeBack = upgradeCalls.length;

      // Going "back home" — a lines screen. The session layout (containers
      // 1-4) is on screen, so a bare textContainerUpgrade to container 0
      // would no-op; this must rebuild back to one container.
      display.render(linesModel(["AGENTHUB 0 run", "  + New session"]));

      expect(rebuildCalls).toHaveLength(2);
      const backContainers = rebuildCalls[1]!.textObject!;
      expect(backContainers).toHaveLength(1);
      const single = backContainers[0]!;
      expect(single.containerID).toBe(0);
      expect(single.containerName).toBe("main");
      expect(single.isEventCapture).toBe(1);
      expect(single.width).toBe(576);
      expect(single.height).toBe(288);
      expect(single.content).toBe("AGENTHUB 0 run\n  + New session");
      // The transition rebuilds — it does not route through the in-place
      // upgrade path.
      expect(upgradeCalls.length).toBe(upgradesBeforeBack);
    });

    it("a second lines render after the single container is current uses textContainerUpgrade, not another rebuild", async () => {
      const { bridge, rebuildCalls, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(sessionModel({ lines: ["> draft"] }));
      display.render(linesModel(["home one"])); // session -> lines rebuild
      expect(rebuildCalls).toHaveLength(2);
      const upgradesBeforeSecond = upgradeCalls.length;

      display.render(linesModel(["home two"])); // lines -> lines, single container current
      expect(rebuildCalls).toHaveLength(2); // no new rebuild
      expect(upgradeCalls.length).toBe(upgradesBeforeSecond + 1); // leading-edge upgrade
      expect(upgradeCalls[upgradeCalls.length - 1]!.content).toBe("home two");
    });

    it("a shape-change rebuild cancels a pending same-shape update so a late upgrade cannot clobber the fresh containers", async () => {
      const { bridge, rebuildCalls, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      // Establish the session layout, then queue a trailing (debounced)
      // same-shape update that has NOT yet flushed.
      display.render(sessionModel({ lines: ["> a"], status: "Working" })); // rebuild
      display.render(sessionModel({ lines: ["> b"], status: "Working" })); // leading upgrade
      display.render(sessionModel({ lines: ["> stale"], status: "Working" })); // trailing pending
      const upgradesBeforeSwitch = upgradeCalls.length;

      // Now change shape (input -> sheet) — an immediate rebuild. The pending
      // "> stale" trailing upgrade must be cancelled, not fire 120ms later.
      display.render(sessionModel({ mode: "sheet", lines: ["> a"], status: "Working" }));
      expect(rebuildCalls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(200); // well past the debounce window
      // No upgrade fired after the switch — the stale trailing flush was cancelled.
      expect(upgradeCalls.length).toBe(upgradesBeforeSwitch);
      expect(upgradeCalls.some((u) => u.content === "> stale")).toBe(false);
    });
  });

  describe("onInput / the sysEvent-click gotcha", () => {
    it("forwards a sysEvent click as tap, not textEvent", async () => {
      const { bridge, emit } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      const received: InputEvent[] = [];
      display.onInput((e) => received.push(e));
      await display.start();

      emit({ sysEvent: { eventType: 0 } });
      expect(received).toEqual([{ type: "tap" }]);
    });

    it("forwards textEvent scrolls", async () => {
      const { bridge, emit } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      const received: InputEvent[] = [];
      display.onInput((e) => received.push(e));
      await display.start();

      emit({ textEvent: { eventType: 1 } });
      emit({ textEvent: { eventType: 2 } });
      expect(received).toEqual([{ type: "scrollUp" }, { type: "scrollDown" }]);
    });
  });

  describe("onLifecycle", () => {
    it("forwards lifecycle events separately from input events", async () => {
      const { bridge, emit } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      const input: InputEvent[] = [];
      const lifecycle: LifecycleEvent[] = [];
      display.onInput((e) => input.push(e));
      display.onLifecycle((e) => lifecycle.push(e));
      await display.start();

      emit({ sysEvent: { eventType: 5 } });
      expect(lifecycle).toEqual([{ type: "lifecycle", phase: "foreground-exit" }]);
      expect(input).toEqual([]);
    });
  });

  describe("requestExit", () => {
    it("calls shutDownPageContainer(1)", async () => {
      const { bridge, shutDownCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();
      display.requestExit();
      await Promise.resolve();
      await Promise.resolve();
      expect(shutDownCalls).toEqual([1]);
    });

    it("does not throw when shutDownPageContainer rejects", async () => {
      const { bridge } = fakeBridge({
        shutDownPageContainer: async () => {
          throw new Error("boom");
        },
      });
      const display = new EvenHubDisplay(bridge);
      await display.start();
      expect(() => display.requestExit()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe("onAudioFrame (Task 7)", () => {
    it("fans mic PCM frames out to a subscriber without a second onEvenHubEvent subscription", async () => {
      const { bridge, emit } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      const frames: Uint8Array[] = [];
      display.onAudioFrame((pcm) => frames.push(pcm));

      const pcm = new Uint8Array([4, 5, 6]);
      emit({ audioEvent: { audioPcm: pcm } });
      expect(frames).toEqual([pcm]);
    });

    it("supports multiple subscribers and independent unsubscribe", async () => {
      const { bridge, emit } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      const a: Uint8Array[] = [];
      const b: Uint8Array[] = [];
      const unsubA = display.onAudioFrame((pcm) => a.push(pcm));
      display.onAudioFrame((pcm) => b.push(pcm));

      emit({ audioEvent: { audioPcm: new Uint8Array([1]) } });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);

      unsubA();
      emit({ audioEvent: { audioPcm: new Uint8Array([2]) } });
      expect(a).toHaveLength(1); // unsubscribed — no second frame
      expect(b).toHaveLength(2);
    });

    it("never delivers audio frames to onInput", async () => {
      const { bridge, emit } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      const received: InputEvent[] = [];
      display.onInput((e) => received.push(e));
      await display.start();

      emit({ audioEvent: { audioPcm: new Uint8Array([1]) } });
      expect(received).toEqual([]);
    });
  });

  describe("teardown", () => {
    it("unsubscribes the router", async () => {
      const helper = fakeBridge();
      const display = new EvenHubDisplay(helper.bridge);
      await display.start();
      expect(helper.unsubscribed).toBe(false);
      display.teardown();
      expect(helper.unsubscribed).toBe(true);
    });
  });
});
