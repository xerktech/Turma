import { describe, expect, it } from "vitest";
import { flattenSessions, glyph, liveState } from "./sessions.ts";
import type { AgentInfo, LiveSignals, SessionInfo } from "./types.ts";

function signals(overrides: Partial<LiveSignals> = {}): LiveSignals {
  return {
    bridgeAttached: true,
    transcriptAgeSec: null,
    lastRole: null,
    lastHasToolUse: false,
    question: null,
    questionOptions: [],
    tail: [],
    newPrUrls: [],
    ...overrides,
  };
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    repo: "myrepo",
    status: "running",
    session: null,
    ...overrides,
  };
}

describe("liveState", () => {
  it("is 'error' when status is error, regardless of session signals", () => {
    const s = session({ status: "error", session: signals({ question: "pick one" }) });
    expect(liveState(s)).toBe("error");
  });

  it("is 'stopped' when status is stopped, even over a lingering question", () => {
    const s = session({ status: "stopped", session: signals({ question: "pick one" }) });
    expect(liveState(s)).toBe("stopped");
  });

  it("is 'waiting' when a question is pending, even while transcript is fresh", () => {
    const s = session({
      status: "running",
      session: signals({ question: "pick one", transcriptAgeSec: 1 }),
    });
    expect(liveState(s)).toBe("waiting");
  });

  it("is 'working' when the transcript was written to within 90s", () => {
    const s = session({ status: "running", session: signals({ transcriptAgeSec: 89 }) });
    expect(liveState(s)).toBe("working");
  });

  it("is 'idle' when the transcript is stale (>= 90s)", () => {
    const s = session({ status: "running", session: signals({ transcriptAgeSec: 90 }) });
    expect(liveState(s)).toBe("idle");
  });

  it("is 'idle' when running with null session signals", () => {
    const s = session({ status: "running", session: null });
    expect(liveState(s)).toBe("idle");
  });

  it("is 'idle' when transcriptAgeSec is null", () => {
    const s = session({ status: "running", session: signals({ transcriptAgeSec: null }) });
    expect(liveState(s)).toBe("idle");
  });
});

describe("glyph", () => {
  it.each([
    ["working", "*"],
    ["waiting", "?"],
    ["idle", "-"],
    ["stopped", "o"],
    ["error", "!"],
    ["pending", "…"],
  ] as const)("maps %s -> %s", (state, expected) => {
    expect(glyph(state)).toBe(expected);
  });
});

describe("flattenSessions", () => {
  function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
    return {
      key: "host-a",
      device: "host-a",
      online: true,
      repos: [],
      sessions: [],
      closedSessions: [],
      ...overrides,
    };
  }

  it("sorts hosts by device name and sessions by createdAt within a host", () => {
    const agents: AgentInfo[] = [
      agent({
        key: "zeta",
        device: "zeta",
        sessions: [
          session({ id: "z2", createdAt: "2026-01-02T00:00:00Z" }),
          session({ id: "z1", createdAt: "2026-01-01T00:00:00Z" }),
        ],
      }),
      agent({
        key: "alpha",
        device: "alpha",
        sessions: [session({ id: "a1", createdAt: "2026-01-01T00:00:00Z" })],
      }),
    ];

    const flat = flattenSessions(agents);
    expect(flat.map((r) => `${r.device}:${r.session.id}`)).toEqual([
      "alpha:a1",
      "zeta:z1",
      "zeta:z2",
    ]);
  });

  it("carries the host's online flag onto each session ref", () => {
    const agents: AgentInfo[] = [
      agent({ key: "offhost", device: "offhost", online: false, sessions: [session({ id: "s1" })] }),
    ];
    const flat = flattenSessions(agents);
    expect(flat).toEqual([
      { hostKey: "offhost", device: "offhost", online: false, session: agents[0]!.sessions[0] },
    ]);
  });

  it("returns an empty array for no agents", () => {
    expect(flattenSessions([])).toEqual([]);
  });

  it("skips hosts with no sessions but keeps other hosts' sessions", () => {
    const agents: AgentInfo[] = [
      agent({ key: "empty", device: "empty", sessions: [] }),
      agent({ key: "busy", device: "busy", sessions: [session({ id: "b1" })] }),
    ];
    expect(flattenSessions(agents).map((r) => r.session.id)).toEqual(["b1"]);
  });
});
