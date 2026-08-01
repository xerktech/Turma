import { describe, expect, it, vi } from "vitest";
import { createPhoneBridge, FROM_HOST, FROM_PAGE } from "./phone-bridge.ts";

function makeBridge() {
  const app = { enterSession: vi.fn(), setOrgFilter: vi.fn() };
  const posted: unknown[] = [];
  const bridge = createPhoneBridge(app, (msg) => posted.push(msg));
  return { app, posted, bridge };
}

describe("phone bridge", () => {
  it("a session-open from the page enters that session on the glasses", () => {
    const { app, bridge } = makeBridge();
    bridge.handleMessage({ source: FROM_PAGE, type: "session-open", host: "host-a", id: "s1" });
    expect(app.enterSession).toHaveBeenCalledWith("s1", "host-a");
  });

  it("an org message scopes the glasses list", () => {
    const { app, bridge } = makeBridge();
    bridge.handleMessage({ source: FROM_PAGE, type: "org", key: "acme.atlassian.net" });
    expect(app.setOrgFilter).toHaveBeenCalledWith("acme.atlassian.net");
    // A missing key means "all orgs".
    bridge.handleMessage({ source: FROM_PAGE, type: "org" });
    expect(app.setOrgFilter).toHaveBeenLastCalledWith("");
  });

  it("ignores messages that aren't ours, are malformed, or lack an id", () => {
    const { app, bridge } = makeBridge();
    bridge.handleMessage(null);
    bridge.handleMessage("nope");
    bridge.handleMessage({ source: "someone-else", type: "session-open", id: "s1" });
    bridge.handleMessage({ source: FROM_PAGE, type: "session-open" }); // no id
    bridge.handleMessage({ source: FROM_PAGE, type: "ready", page: "sessions" }); // acknowledged, no action
    expect(app.enterSession).not.toHaveBeenCalled();
    expect(app.setOrgFilter).not.toHaveBeenCalled();
  });

  it("notifyEnterSession posts an enter-session to the page", () => {
    const { posted, bridge } = makeBridge();
    bridge.notifyEnterSession("host-a", "s1");
    expect(posted).toEqual([{ source: FROM_HOST, type: "enter-session", host: "host-a", id: "s1" }]);
    // No id -> nothing posted.
    bridge.notifyEnterSession("host-a", "");
    expect(posted).toHaveLength(1);
  });
});
