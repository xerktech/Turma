import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDshEnabled, flattenSessions, glyph, isDsh, liveState } from "./sessions.ts";
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
  // XERK-235: two rules the web applies and this mirror did not. paneBusy is a
  // value on the record the host last pushed, so a host that dies mid-turn left
  // its session reading "working" forever — and so never reached Ready for
  // review, which is exactly where stranded work belongs.
  it("is 'idle' when the host has gone offline, even with paneBusy true", () => {
    const s = session({ session: signals({ paneBusy: true, transcriptAgeSec: 5 }) });
    const now = 1_000_000;
    expect(liveState(s, now - 10_000, now)).toBe("working");
    expect(liveState(s, now - 600_000, now)).toBe("idle");
  });

  it("is 'idle' before a transcript exists, whatever paneBusy says", () => {
    const s = session({ session: signals({ paneBusy: true, transcriptAgeSec: null }) });
    expect(liveState(s, Date.now(), Date.now())).toBe("idle");
  });

  it("keeps the old behaviour when no host is supplied", () => {
    const s = session({ session: signals({ paneBusy: true, transcriptAgeSec: 5 }) });
    expect(liveState(s)).toBe("working");
  });

  // XERK-245: a session that delegated work and ended its own turn paints no
  // interrupt hint, so paneBusy reads false while a background agent is still
  // running — and the glyph said idle for work in progress.
  it("is 'working' while background agents run, even with paneBusy false", () => {
    const s = session({ session: signals({
      paneBusy: false, transcriptAgeSec: 999,
      agents: [{ type: "qa", label: "QA the parity change" }],
    }) });
    const now = 1_000_000;
    expect(liveState(s, now - 10_000, now)).toBe("working");
    // An empty list is "no agents", not "can't tell"; an older agent sends none.
    expect(liveState(session({ session: signals({ paneBusy: false, transcriptAgeSec: 999, agents: [] }) }),
      now - 10_000, now)).toBe("idle");
    expect(liveState(session({ session: signals({ paneBusy: false, transcriptAgeSec: 999 }) }),
      now - 10_000, now)).toBe("idle");
    // Behind the offline gate, like paneBusy.
    expect(liveState(s, now - 600_000, now)).toBe("idle");
  });

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

  it("is 'working' when paneBusy is true, even with a stale transcript", () => {
    const s = session({
      status: "running",
      session: signals({ paneBusy: true, transcriptAgeSec: 999 }),
    });
    expect(liveState(s)).toBe("working");
  });

  it("is 'idle' when paneBusy is false, even with a fresh transcript", () => {
    const s = session({
      status: "running",
      session: signals({ paneBusy: false, transcriptAgeSec: 1 }),
    });
    expect(liveState(s)).toBe("idle");
  });

  it("still yields to a pending question when paneBusy is true", () => {
    const s = session({
      status: "running",
      session: signals({ paneBusy: true, question: "pick one" }),
    });
    expect(liveState(s)).toBe("waiting");
  });

  it("falls back to transcript freshness when paneBusy is null (older agent)", () => {
    const fresh = session({ status: "running", session: signals({ paneBusy: null, transcriptAgeSec: 89 }) });
    expect(liveState(fresh)).toBe("working");
    const stale = session({ status: "running", session: signals({ paneBusy: null, transcriptAgeSec: 90 }) });
    expect(liveState(stale)).toBe("idle");
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
    ["working", "!"],
    ["waiting", "?"],
    ["idle", "-"],
    ["stopped", "o"],
    ["error", "x"],
    ["pending", "…"],
  ] as const)("maps %s -> %s", (state, expected) => {
    expect(glyph(state)).toBe(expected);
  });
});

describe("isDsh", () => {
  // The dsh machinery is RETAINED behind the DSH_ENABLED kill switch (currently
  // OFF fleet-wide). These assertions exercise the marker's own logic, so they
  // flip the switch on for the block and reset it after — no leakage into the
  // rest of the suite, which must see the shipped (disabled) behavior.
  beforeEach(() => __setDshEnabled(true));
  afterEach(() => __setDshEnabled(false));

  // XERK-460: "dsh" is the only truthy runtime; the default and every pre-dsh
  // session (claude / "" / absent) must read false so it shows no marker.
  it("is true only for agentType === 'dsh'", () => {
    expect(isDsh(session({ agentType: "dsh" }))).toBe(true);
  });
  it.each([
    ["claude", { agentType: "claude" }],
    ["empty string (pre-dsh agent)", { agentType: "" }],
    ["absent", {}],
    ["null", { agentType: null }],
    ["unknown value", { agentType: "something-else" }],
  ] as const)("is false for %s", (_label, overrides) => {
    expect(isDsh(session(overrides))).toBe(false);
  });

  // With the kill switch OFF (the shipped default) a dsh session is invisible as
  // a dsh session — the marker reads false even for agentType === "dsh".
  it("is false for a dsh session when DSH_ENABLED is off", () => {
    __setDshEnabled(false);
    expect(isDsh(session({ agentType: "dsh" }))).toBe(false);
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
