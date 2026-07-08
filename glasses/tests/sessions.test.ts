import { describe, it, expect } from "vitest";
import { flattenSessions, liveState, sortSessions, waitingCount, findRef } from "../src/sessions.js";
import { agentsFixture } from "./fixtures.js";

describe("session helpers", () => {
  const refs = sortSessions(flattenSessions(agentsFixture()));

  it("flattens every host's sessions", () => {
    expect(flattenSessions(agentsFixture())).toHaveLength(3);
  });

  it("derives live state from status + signals", () => {
    const byId = (id: string) => refs.find((r) => r.session.id === id)!.session;
    expect(liveState(byId("ab12"))).toBe("waiting"); // has a question
    expect(liveState(byId("ef56"))).toBe("working"); // fresh transcript
    expect(liveState(byId("cd34"))).toBe("stopped"); // not running
  });

  it("orders waiting-on-you first, then working, then stopped", () => {
    expect(refs.map((r) => r.session.id)).toEqual(["ab12", "ef56", "cd34"]);
  });

  it("counts sessions waiting on the user", () => {
    expect(waitingCount(refs)).toBe(1);
  });

  it("finds a ref by host + id", () => {
    expect(findRef(refs, "nas-agent", "ef56")?.session.repo).toBe("AgentHub");
    expect(findRef(refs, "nas-agent", "nope")).toBeUndefined();
  });
});
