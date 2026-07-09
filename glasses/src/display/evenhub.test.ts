import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvenHubDisplay, type EvenHubBridge, type StartUpContainerConfig, type TextUpgradeConfig } from "./evenhub.ts";
import type { RawEvenHubEvent } from "../input/router.ts";
import type { InputEvent } from "../types.ts";
import type { LifecycleEvent } from "../input/router.ts";

function fakeBridge(overrides: Partial<EvenHubBridge> = {}): {
  bridge: EvenHubBridge;
  startCalls: StartUpContainerConfig[];
  upgradeCalls: TextUpgradeConfig[];
  shutDownCalls: (number | undefined)[];
  emit: (e: RawEvenHubEvent) => void;
  unsubscribed: boolean;
} {
  const startCalls: StartUpContainerConfig[] = [];
  const upgradeCalls: TextUpgradeConfig[] = [];
  const shutDownCalls: (number | undefined)[] = [];
  let handler: ((e: RawEvenHubEvent) => void) | null = null;
  const state = { unsubscribed: false };

  const bridge: EvenHubBridge = {
    async createStartUpPageContainer(container) {
      startCalls.push(container);
      return 0;
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
    upgradeCalls,
    shutDownCalls,
    emit: (e) => handler?.(e),
    get unsubscribed() {
      return state.unsubscribed;
    },
  };
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

      display.render(["line1", "line2", "line3"]);
      expect(upgradeCalls).toHaveLength(1); // leading-edge fire
      expect(upgradeCalls[0]!.content).toBe("line1\nline2\nline3");
      expect(upgradeCalls[0]!.containerID).toBe(0);
      expect(upgradeCalls[0]!.containerName).toBe("main");
    });

    it("debounces rapid render calls to a single trailing update with the last content", async () => {
      const { bridge, upgradeCalls } = fakeBridge();
      const display = new EvenHubDisplay(bridge);
      await display.start();

      display.render(["a"]); // leading fire
      expect(upgradeCalls).toHaveLength(1);
      display.render(["b"]);
      display.render(["c"]);
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
      display.render([longLine]);
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
      expect(() => display.render(["x"])).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
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
