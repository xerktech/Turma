// Round-trip test for the background -> phone state serialization (Foverlay
// port — new module). The payload must carry exactly what phone/render.ts and
// phone/phone.ts read, and hydrate back into a full-shaped AppState.
import { describe, expect, it } from "bun:test";
import { createInitialState, newSessionState, type AppState } from "../core/app.ts";
import type { AgentInfo } from "../core/types.ts";
import {
  assembleStateChunks,
  createPhoneStateGate,
  hydratePhoneState,
  nextChunkedSnapshot,
  serializePhoneState,
  stateChunkOf,
  type StateChunk,
} from "./phone-state.ts";

const agents: AgentInfo[] = [
  {
    key: "host-a",
    device: "alpha",
    online: true,
    repos: [],
    sessions: [
      {
        id: "s1",
        repo: "myrepo",
        status: "running",
        session: {
          bridgeAttached: true,
          transcriptAgeSec: 3,
          lastRole: "assistant",
          lastHasToolUse: false,
          question: null,
          questionOptions: [],
          tail: [],
          newPrUrls: [],
        },
      },
    ],
    closedSessions: [],
    jira: { siteKey: "acme.atlassian.net" },
  },
];

describe("phone-state serialization", () => {
  it("round-trips the fields the phone reads, including session identity", () => {
    const state = {
      ...createInitialState(123456),
      screen: "session" as const,
      session: { hostKey: "host-a", sessionId: "s1", offset: 0, focus: "transcript" as const, draft: "", mic: "idle" as const, viewOffset: 0, selected: 0 },
      agents,
      orgFilter: "acme.atlassian.net",
      orgColors: { "acme.atlassian.net": 3 },
      autoStartOrgs: { "acme.atlassian.net": true },
      liveTurn: { sessionId: "s1", text: "typing…" },
      flash: "✓ queued — agent picks up in ~20s",
      flashUntil: 123999,
    };

    const payload = serializePhoneState(state);
    // JSON-clean (what actually crosses the channel bus).
    const wire = JSON.parse(JSON.stringify(payload)) as typeof payload;
    const hydrated = hydratePhoneState(wire);

    expect(hydrated.now).toBe(123456);
    expect(hydrated.screen).toBe("session");
    expect(hydrated.session?.hostKey).toBe("host-a");
    expect(hydrated.session?.sessionId).toBe("s1");
    expect(hydrated.agents).toEqual(agents);
    expect(hydrated.orgFilter).toBe("acme.atlassian.net");
    expect(hydrated.orgColors).toEqual({ "acme.atlassian.net": 3 });
    expect(hydrated.autoStartOrgs).toEqual({ "acme.atlassian.net": true });
    expect(hydrated.liveTurn).toEqual({ sessionId: "s1", text: "typing…" });
    expect(hydrated.flash).toBe("✓ queued — agent picks up in ~20s");
    expect(hydrated.flashUntil).toBe(123999);
    // The glasses-only heavyweight fields are deliberately not carried.
    expect(payload).not.toHaveProperty("transcripts");
    expect(payload).not.toHaveProperty("reveal");
    expect(hydrated.transcripts).toEqual({});
  });

  it("hydrates a null session as null", () => {
    const state = createInitialState(1);
    const hydrated = hydratePhoneState(serializePhoneState(state));
    expect(hydrated.session).toBeNull();
    expect(hydrated.screen).toBe("home");
  });

  it("carries the hub-unreachable state so the phone can show a banner (XERK-215)", () => {
    const erroring = { ...createInitialState(1), agents, pollErrorActive: true };
    const hydrated = hydratePhoneState(JSON.parse(JSON.stringify(serializePhoneState(erroring))));
    expect(hydrated.pollErrorActive).toBe(true);
    // And an older payload without the field hydrates to false, not undefined.
    const payload = serializePhoneState(createInitialState(1));
    delete (payload as unknown as Record<string, unknown>).pollError;
    expect(hydratePhoneState(payload).pollErrorActive).toBe(false);
  });
});

// XERK-215: the raw fleet payload is hundreds of KB, and it used to cross the
// channel bus VERBATIM on every repaint. The serializer must ship only what
// the phone renders.
describe("agent slimming (XERK-215)", () => {
  const heavyAgent = {
    key: "host-b",
    device: "beta",
    online: true,
    repos: [
      {
        name: "repoA",
        path: "/r/repoA",
        branches: ["main", "XERK-1"],
        remote: "git@github.com:o/repoA.git",
        resumable: [
          {
            transcriptId: "t-ticketed",
            summary: "worked XERK-9",
            endedTs: "2026-08-01T00:00:00Z",
            cwd: "/r/.turma/worktrees/repoA/x",
            prUrls: ["https://github.com/o/repoA/pull/1"],
            ticket: { key: "XERK-9", siteKey: "acme.atlassian.net" },
          },
          { transcriptId: "t-plain", summary: "no ticket", endedTs: "2026-08-02T00:00:00Z" },
        ],
      },
      { name: "repoB", path: "/r/repoB", resumable: [{ transcriptId: "t-b", summary: "unticketed" }] },
    ],
    sessions: [
      {
        id: "s9",
        repo: "repoA",
        status: "running" as const,
        session: {
          bridgeAttached: true,
          paneBusy: true,
          transcriptAgeSec: 2,
          lastRole: "assistant",
          lastHasToolUse: false,
          question: "Pick one?",
          questionOptions: ["a", "b"],
          tail: [{ id: "e1", role: "assistant", text: "x".repeat(5000) }],
          newPrUrls: [],
        },
      },
    ],
    closedSessions: [{ id: "c1", repo: "repoA", closedAt: "2026-08-03T00:00:00Z" }],
    jira: { siteKey: "acme.atlassian.net", tickets: [{ key: "XERK-9" }], repoOptions: [{ name: "repoA" }] },
    models: { available: ["opus", "sonnet"], defaultLabel: "Opus 4.8" },
    commands: [{ type: "spawnTicket", issueKey: "XERK-9" }],
    // Heavy host blocks the phone never reads:
    github: { available: true, repos: new Array(50).fill({ nameWithOwner: "o/r" }) },
    gitSources: [{ source: "gitlab", repos: new Array(50).fill({ name: "r" }) }],
    repoUsage: new Array(30).fill({ repo: "repoA", tokens: 1 }),
    usage: { total: { input: 1 } },
    alerts: { offline: false },
    claudeAuth: { present: true },
    capacity: { maxSessions: 8, running: 1, queued: 0, free: 7 },
  } as unknown as AgentInfo;

  function slimmed(): AgentInfo {
    const state = { ...createInitialState(5), agents: [heavyAgent] };
    return serializePhoneState(state).agents[0]!;
  }

  it("strips the cached tail from live signals but keeps the question state the sheet reads", () => {
    const s = slimmed().sessions[0]!;
    expect(s.session?.tail).toEqual([]);
    expect(s.session?.question).toBe("Pick one?");
    expect(s.session?.questionOptions).toEqual(["a", "b"]);
    expect(s.session?.paneBusy).toBe(true);
    // The original state is never mutated — the App still owns the full tail.
    expect(heavyAgent.sessions[0]!.session!.tail.length).toBe(1);
  });

  it("keeps only ticketed resumable entries (the board's chip channel) and drops chip-less repos", () => {
    const repos = slimmed().repos;
    expect(repos.map((r) => r.name)).toEqual(["repoA"]);
    const entries = repos[0]!.resumable as Record<string, unknown>[];
    expect(entries.map((e) => e.transcriptId)).toEqual(["t-ticketed"]);
    // Chip fields survive; the rest (cwd, prUrls) does not.
    expect(entries[0]!.ticket).toEqual({ key: "XERK-9", siteKey: "acme.atlassian.net" });
    expect(entries[0]!.summary).toBe("worked XERK-9");
    expect(entries[0]!.endedTs).toBe("2026-08-01T00:00:00Z");
    expect(entries[0]!).not.toHaveProperty("cwd");
    expect(entries[0]!).not.toHaveProperty("prUrls");
  });

  it("drops the host blocks the phone never reads and keeps the ones the board does", () => {
    const a = slimmed();
    for (const gone of ["github", "gitSources", "repoUsage", "usage", "alerts", "claudeAuth", "capacity"]) {
      expect(a).not.toHaveProperty(gone);
    }
    expect(a.jira).toEqual(heavyAgent.jira);
    expect(a.models).toEqual(heavyAgent.models);
    expect(a.commands).toEqual(heavyAgent.commands);
    expect(a.closedSessions).toEqual(heavyAgent.closedSessions);
    expect(a.key).toBe("host-b");
    expect(a.device).toBe("beta");
    expect(a.online).toBe(true);
  });
});

// The one consumer the repos slimming exists for must still see its chips.
describe("slimmed agents still feed the board's ticket chips", () => {
  it("ticketSessionIndex finds the resumable entry after slimming", async () => {
    const { Board } = await import("../ui/vendor/engines.ts");
    const heavy = {
      key: "host-c",
      device: "gamma",
      online: true,
      repos: [
        {
          name: "repoA",
          path: "/r/repoA",
          resumable: [
            { transcriptId: "t9", summary: "did XERK-9", endedTs: "2026-08-01T00:00:00Z", ticket: { key: "XERK-9", siteKey: "acme.atlassian.net" } },
          ],
        },
      ],
      sessions: [],
      closedSessions: [],
      jira: { siteKey: "acme.atlassian.net" },
    } as unknown as AgentInfo;
    const payload = serializePhoneState({ ...createInitialState(1), agents: [heavy] });
    const idx = Board.ticketSessionIndex(payload.agents as unknown[]) as Map<string, unknown[]>;
    const chips = idx.get("acme.atlassian.net" + String.fromCharCode(0) + "XERK-9");
    expect(chips?.length).toBe(1);
    expect((chips![0] as { transcriptId: string }).transcriptId).toBe("t9");
  });
});

// The chunked state pull (XERK-215): the state must survive being sliced into
// RPC-reply-sized pieces and reassembled — the only frame size the device's
// host→WebView leg provably delivers.
describe("chunked state pull", () => {
  const bigState = (): AppState => ({ ...createInitialState(7), agents, flash: "x".repeat(40_000) });

  it("round-trips a payload bigger than one chunk", () => {
    const snap = nextChunkedSnapshot(null, bigState());
    const size = 16 * 1024;
    const total = Math.ceil(snap.json.length / size);
    expect(total).toBeGreaterThan(1);
    const chunks: StateChunk[] = [];
    for (let seq = 0; seq < total; seq++) {
      const c = stateChunkOf(snap, seq, size);
      expect(c.total).toBe(total);
      expect(c.chunk.length).toBeLessThanOrEqual(size);
      chunks.push(c);
    }
    const payload = assembleStateChunks(chunks);
    expect(payload).not.toBeNull();
    expect(hydratePhoneState(payload!).agents).toEqual(serializePhoneState(bigState()).agents);
  });

  it("a fresh snapshot bumps v, and a mid-pull roll is rejected on assembly", () => {
    const s1 = nextChunkedSnapshot(null, bigState());
    const s2 = nextChunkedSnapshot(s1, bigState());
    expect(s2.v).toBe(s1.v + 1);
    const size = 16 * 1024;
    const mixed = [stateChunkOf(s1, 0, size), ...Array.from({ length: stateChunkOf(s2, 0, size).total - 1 }, (_, i) => stateChunkOf(s2, i + 1, size))];
    expect(assembleStateChunks(mixed)).toBeNull();
  });

  it("rejects an incomplete or misordered pull instead of parsing garbage", () => {
    const snap = nextChunkedSnapshot(null, bigState());
    const size = 16 * 1024;
    const all = Array.from({ length: stateChunkOf(snap, 0, size).total }, (_, i) => stateChunkOf(snap, i, size));
    expect(assembleStateChunks(all.slice(0, all.length - 1))).toBeNull();
    const swapped = [...all];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(assembleStateChunks(swapped)).toBeNull();
    expect(assembleStateChunks([])).toBeNull();
  });

  it("a single-chunk payload still reports total 1 and assembles", () => {
    const snap = nextChunkedSnapshot(null, createInitialState(1));
    const c = stateChunkOf(snap, 0);
    expect(c.total).toBe(1);
    expect(assembleStateChunks([c])).not.toBeNull();
  });
});

// XERK-215's other half: App.onState fires on every glasses repaint (80ms
// reveal ticks included), but those mutate only fields the phone payload
// doesn't carry — the gate keeps them off the channel bus.
describe("createPhoneStateGate", () => {
  function state(patch: Partial<AppState> = {}): AppState {
    return { ...createInitialState(100), agents, ...patch };
  }

  it("passes the first state, then suppresses repaints that change nothing the phone reads", () => {
    const gate = createPhoneStateGate();
    const s1 = state();
    expect(gate(s1)).toBe(true);
    // A reveal tick: new state object, same field references.
    expect(gate({ ...s1, now: 101, transcripts: { s1: { entries: [], anchor: 0 } } } as unknown as AppState)).toBe(false);
    expect(gate({ ...s1, now: 102 })).toBe(false);
  });

  it("passes when a poll replaces the agents array, even with identical content", () => {
    const gate = createPhoneStateGate();
    const s1 = state();
    gate(s1);
    expect(gate({ ...s1, agents: [...s1.agents] })).toBe(true);
  });

  it("passes when the hub-unreachable state flips", () => {
    const gate = createPhoneStateGate();
    const s1 = state();
    gate(s1);
    expect(gate({ ...s1, pollErrorActive: true })).toBe(true);
    const s2 = { ...s1, pollErrorActive: true };
    gate(s2);
    expect(gate({ ...s2 })).toBe(false);
    expect(gate({ ...s2, pollErrorActive: false })).toBe(true);
  });

  it("passes on the changes the phone renders: screen/session, liveTurn, org fields, flash", () => {
    const gate = createPhoneStateGate();
    const s1 = state();
    gate(s1);
    expect(gate({ ...s1, screen: "session", session: newSessionState("host-a", "s1") })).toBe(true);
    const s2 = { ...s1, screen: "session" as const, session: newSessionState("host-a", "s1") };
    gate(s2);
    expect(gate({ ...s2, liveTurn: { sessionId: "s1", text: "hi" } })).toBe(true);
    expect(gate({ ...s2, liveTurn: { sessionId: "s1", text: "hi" }, orgFilter: "x" })).toBe(true);
    const s3 = { ...s2, liveTurn: { sessionId: "s1", text: "hi" }, orgFilter: "x" };
    gate(s3);
    expect(gate({ ...s3, flash: "✓ sent", flashUntil: 999 })).toBe(true);
  });
});
