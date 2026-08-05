// Round-trip test for the background -> phone state serialization (Foverlay
// port — new module). The payload must carry exactly what phone/render.ts and
// phone/phone.ts read, and hydrate back into a full-shaped AppState.
import { describe, expect, it } from "bun:test";
import { createInitialState } from "../core/app.ts";
import type { AgentInfo } from "../core/types.ts";
import { hydratePhoneState, serializePhoneState } from "./phone-state.ts";

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
});
