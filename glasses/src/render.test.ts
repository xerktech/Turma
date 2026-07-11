import { describe, expect, it } from "vitest";
import { createInitialState, newSessionState, type AppState } from "./app.ts";
import { render, SESSION_SCROLL_STEP, type ScreenModel } from "./render.ts";
import type { AgentInfo, LiveSignals, SessionInfo } from "./types.ts";

const NOW = 1_700_000_000_000;

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
    id: "sess-0001",
    repo: "myrepo",
    status: "running",
    session: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

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

function base(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(NOW), ...overrides };
}

// Every non-session screen renders {type:"lines"}; this unwraps it (and
// fails loudly if a test accidentally points it at the session screen).
function asLines(model: ScreenModel): string[] {
  if (model.type !== "lines") throw new Error(`expected a "lines" ScreenModel, got "${model.type}"`);
  return model.lines;
}

function asSession(model: ScreenModel) {
  if (model.type !== "session") throw new Error(`expected a "session" ScreenModel, got "${model.type}"`);
  return model;
}

describe("render: home", () => {
  it("shows the run/ask header, grouped hosts (incl. an offline one), and the trailing menu rows", () => {
    const agents: AgentInfo[] = [
      agent({
        key: "alpha",
        device: "alpha",
        sessions: [
          session({ id: "s-work", repo: "repoA", session: signals({ transcriptAgeSec: 5 }) }),
          session({ id: "s-ask", repo: "repoB", status: "running", session: signals({ question: "pick one" }) }),
          session({ id: "s-idle", repo: "repoC", status: "running", session: signals({ transcriptAgeSec: 999 }) }),
        ],
      }),
      agent({ key: "beta", device: "beta", online: false }),
    ];
    const state = base({ agents, home: { cursor: 0 } });

    const model = render(state);
    expect(model.type).toBe("lines");
    const lines = asLines(model);

    expect(lines[0]).toBe("TURMA 1 run · 1 ask");
    expect(lines).toContain("> alpha");
    // Rows are <repo>-<name>; the host (alpha) is the header above, not repeated.
    expect(lines.some((l) => l.includes("! repoA-"))).toBe(true);
    expect(lines.some((l) => l.includes("? repoB-"))).toBe(true);
    expect(lines.some((l) => l.includes("- repoC-"))).toBe(true);
    expect(lines.some((l) => l.includes("alpha·"))).toBe(false);
    expect(lines).toContain("  beta offline");
    expect(lines).toContain("  + New session");
    expect(lines).toContain("  Settings");
  });

  it("shows the agent-generated summary as each session's name, falling back to the short id when unnamed", () => {
    const agents: AgentInfo[] = [
      agent({
        key: "alpha",
        device: "alpha",
        sessions: [
          session({ id: "s-named", repo: "repoA", summary: "Adding Compose Flag" }),
          session({ id: "abcdef123456", repo: "repoB", summary: null }),
        ],
      }),
    ];
    const lines = asLines(render(base({ agents, home: { cursor: 0 } })));

    // Named session shows <repo>-<summary>, not its id.
    expect(lines.some((l) => l.includes("repoA-Adding Compose Flag"))).toBe(true);
    expect(lines.some((l) => l.includes("s-named"))).toBe(false);
    // Unnamed session falls back to <repo>-<first 6 chars of id>.
    expect(lines.some((l) => l.includes("repoB-abcdef"))).toBe(true);
  });

  it("marks a cursor'd session row with '>' and renders its glyph as pending overlay", () => {
    const agents: AgentInfo[] = [
      agent({ sessions: [session({ id: "s1", session: signals({ transcriptAgeSec: 1 }) })] }),
    ];
    // Row 0 = host header (non-selectable), row 1 = the session.
    const state = base({ agents, home: { cursor: 1 }, pending: { s1: { at: NOW } } });

    const lines = asLines(render(state));
    expect(lines.some((l) => l.startsWith("> … myrepo-"))).toBe(true);
  });

  it("windows a long row list into one scrollable page — no p/N footer, cursor stays visible", () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session({ id: `s${i}`, repo: `repo${i}`, session: signals({ transcriptAgeSec: 999 }) })
    );
    const agents: AgentInfo[] = [agent({ sessions })];
    // rows = [hostHeader, s0..s11, newSession, settings] = 15 rows total,
    // more than the DISPLAY_LINES-1 = 9 content lines can show at once.
    const state = base({ agents, home: { cursor: 0 } });

    const lines = asLines(render(state));
    expect(lines[0]).toBe("TURMA 0 run · 0 ask");
    // Never split into pages: no "p/N" footer, ever.
    expect(lines.some((l) => /^p\d+\/\d+$/.test(l))).toBe(false);
    // Header + one full window of content (DISPLAY_LINES-1 rows) = DISPLAY_LINES.
    expect(lines.length).toBe(10);

    // The cursor is always in the rendered window, wherever it sits in the list.
    const state2 = base({ agents, home: { cursor: 14 } }); // settings row, at the very end
    const lines2 = asLines(render(state2));
    expect(lines2.some((l) => /^p\d+\/\d+$/.test(l))).toBe(false);
    expect(lines2.some((l) => l === "> Settings")).toBe(true);
    // A mid-list cursor is also windowed in — the list scrolled to follow it.
    const state3 = base({ agents, home: { cursor: 7 } }); // s6 (rows: header=0, s0=1, ...)
    const lines3 = asLines(render(state3));
    expect(lines3.some((l) => l.startsWith("> "))).toBe(true);
  });

  it("shows a flash message in place of the header", () => {
    const state = base({ flash: "hub unreachable", flashUntil: NOW + 1000 });
    expect(asLines(render(state))[0]).toBe("hub unreachable");
  });

  it("does not show an expired flash", () => {
    const state = base({ flash: "hub unreachable", flashUntil: NOW - 1000 });
    expect(asLines(render(state))[0]).toBe("TURMA 0 run · 0 ask");
  });
});

describe("render: session", () => {
  it("returns a session ScreenModel with no header line and an input-mode bottom bar when no question is pending", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [{ id: "1", role: "user", text: "hi" }] } },
    });

    const model = asSession(render(state));

    // No header: the first (and only) transcript line is the content itself,
    // not "host-a·myrepo" or similar.
    expect(model.transcriptLines[0]).toBe("> hi");
    expect(model.transcriptLines.some((l) => l.includes("host-a"))).toBe(false);
    expect(model.bottom.mode).toBe("input");
  });

  it("shows a sheet-mode bottom bar with numbered options and a Dictate answer row when a question is pending", () => {
    const s = session({ id: "s1", session: signals({ question: "Deploy now?", questionOptions: ["Yes", "No"] }) });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [] } },
    });

    const model = asSession(render(state));

    expect(model.bottom.mode).toBe("sheet");
    if (model.bottom.mode !== "sheet") throw new Error("unreachable");
    expect(model.bottom.options).toEqual(["Yes", "No"]);
    expect(model.bottom.lines.some((l) => l.includes("1. Yes"))).toBe(true);
    expect(model.bottom.lines.some((l) => l.includes("2. No"))).toBe(true);
    expect(model.bottom.lines.some((l) => l.includes("Dictate answer…"))).toBe(true);
  });

  it("shows the merged transcript and PR urls at the newest end, without duplicating the pending question (Task 6: the sheet owns it)", () => {
    const s = session({
      id: "s1",
      repo: "myrepo",
      session: signals({ question: "Deploy now?", newPrUrls: ["https://github.com/x/y/pull/1"] }),
    });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: {
        s1: {
          entries: [
            { id: "1", role: "user", text: "hello" },
            { id: "2", role: "assistant", text: "hi there" },
          ],
        },
      },
    });

    const model = asSession(render(state));

    expect(model.transcriptLines.some((l) => l.includes("> hello"))).toBe(true);
    expect(model.transcriptLines.some((l) => l.includes("hi there"))).toBe(true);
    // The question renders once — in the sheet, not the transcript.
    expect(model.transcriptLines.some((l) => l.includes("Deploy now?"))).toBe(false);
    expect(model.transcriptLines.some((l) => l.includes("https://github.com/x/y/pull/1"))).toBe(true);
    expect(model.bottom.mode).toBe("sheet");
    expect(model.bottom.lines.some((l) => l.includes("Deploy now?"))).toBe(true);
  });

  it("pages a long transcript, showing only the bottom-anchored window at offset 0", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      role: i % 2 === 0 ? "user" : "assistant",
      text: `line ${i}`,
    }));
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries } },
    });

    const model = asSession(render(state));
    // No header line now; the input bottom bar (empty draft, unfocused) is 1
    // line, so the transcript area is DISPLAY_LINES - 1 = 9.
    expect(model.transcriptLines.length).toBe(9);
    expect(model.transcriptLines[model.transcriptLines.length - 1]).toContain("line 19");
    expect(model.transcriptLines.join("\n")).not.toContain("line 0\n");
  });

  it("shows the loading-earlier indicator while history is being fetched", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: { ...newSessionState("host-a", "s1"), offset: 999 },
      transcripts: { s1: { entries: [{ id: "1", role: "user", text: "hi" }] } },
      loadingHistory: { s1: true },
    });

    const model = asSession(render(state));
    expect(model.transcriptLines).toContain("· loading earlier ·");
  });

  it("shows a truncated-history marker at the very top when the buffer's hasMore is true", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: {
        s1: {
          entries: [
            { id: "1", role: "user", text: "hello" },
            { id: "2", role: "assistant", text: "hi there" },
          ],
          hasMore: true,
        },
      },
    });

    const model = asSession(render(state));
    // No header now: the marker must be the very first transcript line.
    expect(model.transcriptLines[0]).toBe("· earlier history truncated ·");
    expect(model.transcriptLines.indexOf("· earlier history truncated ·")).toBeLessThan(
      model.transcriptLines.findIndex((l) => l.includes("hello"))
    );
  });

  it("does not show the truncated marker when hasMore is false (real top) or undefined (never fetched)", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const falseState = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [{ id: "1", role: "user", text: "hi" }], hasMore: false } },
    });
    const undefinedState = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [{ id: "1", role: "user", text: "hi" }] } },
    });

    expect(asSession(render(falseState)).transcriptLines.some((l) => l.includes("truncated"))).toBe(false);
    expect(asSession(render(undefinedState)).transcriptLines.some((l) => l.includes("truncated"))).toBe(false);
  });

  // ---- flash surfacing (Task 5 carry-forward: the session screen has no
  // header of its own to show it, unlike every other screen) -------------

  it("surfaces an active flash as a transient top line of the transcript", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [{ id: "1", role: "user", text: "hi" }] } },
      flash: "✓ queued — agent picks up in ~20s",
      flashUntil: NOW + 1000,
    });

    const model = asSession(render(state));
    expect(model.transcriptLines[0]).toContain("✓ queued");
    expect(model.transcriptLines.some((l) => l.includes("hi"))).toBe(true);
  });

  it("does not show an expired flash on the session screen", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "session",
      agents,
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [{ id: "1", role: "user", text: "hi" }] } },
      flash: "✓ queued — agent picks up in ~20s",
      flashUntil: NOW - 1,
    });

    const model = asSession(render(state));
    expect(model.transcriptLines.some((l) => l.includes("queued"))).toBe(false);
    expect(model.transcriptLines[0]).toBe("> hi");
  });
});

describe("SESSION_SCROLL_STEP", () => {
  it("is 2", () => {
    expect(SESSION_SCROLL_STEP).toBe(2);
  });
});

describe("render: actions", () => {
  it("renders the running-session menu as an overlay: Back first (cursor 0), no Send/Clear/Answer/Restart when there's no draft", () => {
    const s = session({ id: "s1", session: signals({ question: "pick" }) });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: newSessionState("host-a", "s1"),
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const model = asSession(render(state));
    expect(model.bottom.mode).toBe("menu");
    const box = model.bottom.lines;
    expect(box).toContain("> Back");
    expect(box).toContain("  End this session");
    expect(box.some((l) => l.includes("Delete"))).toBe(false);
    expect(box.some((l) => l.includes("Restart"))).toBe(false);
    expect(box.some((l) => l.includes("Answer question"))).toBe(false);
    expect(box.some((l) => l.includes("Send"))).toBe(false);
    expect(box.some((l) => l.includes("Clear"))).toBe(false);
  });

  it("keeps the session transcript visible behind the menu", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: newSessionState("host-a", "s1"),
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
      transcripts: { s1: { entries: [{ id: "e1", role: "assistant", text: "behind the menu" }] } },
    });

    const model = asSession(render(state));
    expect(model.transcriptLines.some((l) => l.includes("behind the menu"))).toBe(true);
    expect(model.bottom.mode).toBe("menu");
  });

  it("prepends Send/Clear/Dictate more after Back once the session's bottom-box draft has text", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: { ...newSessionState("host-a", "s1"), draft: "deploy the fix" },
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const box = asSession(render(state)).bottom.lines;
    expect(box).toContain("> Back");
    expect(box).toContain("  Send");
    expect(box).toContain("  Clear");
    expect(box).toContain("  Dictate more");
    expect(box).toContain("  End this session");
  });

  it("ignores another session's draft (Send/Clear only reflect the actions target's own session)", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: { ...newSessionState("host-a", "other-session"), draft: "unrelated draft" },
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const box = asSession(render(state)).bottom.lines;
    expect(box.some((l) => l.includes("Send"))).toBe(false);
    expect(box.some((l) => l.includes("Clear"))).toBe(false);
  });

  it("shows Back/Start (no Delete, no Kill, no Restart) when the session is stopped", () => {
    const s = session({ id: "s1", status: "stopped", session: null });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const box = asSession(render(state)).bottom.lines;
    expect(box).toContain("> Back");
    expect(box).toContain("  Start");
    expect(box.some((l) => l.includes("Delete"))).toBe(false);
    expect(box.some((l) => l.includes("Kill"))).toBe(false);
    expect(box.some((l) => l.includes("End this session"))).toBe(false);
    expect(box.some((l) => l.includes("Restart"))).toBe(false);
  });
});

describe("render: reply", () => {
  it("shows the listening indicator", () => {
    const state = base({
      screen: "reply",
      reply: {
        target: { kind: "session", hostKey: "host-a", sessionId: "s1", back: "session" },
        phase: "listening",
        text: "",
        cursor: 0,
      },
    });
    expect(asLines(render(state))).toContain("● listening… (tap=done)");
  });

  it("shows the preview text, char count, and Send/Redo/Cancel buttons", () => {
    const state = base({
      screen: "reply",
      reply: {
        target: { kind: "session", hostKey: "host-a", sessionId: "s1", back: "session" },
        phase: "preview",
        text: "deploy it",
        cursor: 0,
      },
    });
    const lines = asLines(render(state));
    expect(lines.some((l) => l.includes("deploy it"))).toBe(true);
    expect(lines).toContain("9 chars");
    expect(lines).toContain("> Send");
    expect(lines).toContain("  Redo");
    expect(lines).toContain("  Cancel");
  });

  it("shows only Redo/Cancel and the reason when dictation is unavailable", () => {
    const state = base({
      screen: "reply",
      reply: {
        target: { kind: "session", hostKey: "host-a", sessionId: "s1", back: "session" },
        phase: "unavailable",
        text: "",
        reason: "whisper not configured",
        cursor: 0,
      },
    });
    const lines = asLines(render(state));
    expect(lines.some((l) => l.includes("whisper not configured"))).toBe(true);
    expect(lines).toContain("> Redo");
    expect(lines).toContain("  Cancel");
    expect(lines.some((l) => l.includes("Send"))).toBe(false);
  });
});

describe("render: confirm", () => {
  it("renders the end-session confirmation as a menu overlay with Cancel preselected", () => {
    const state = base({
      screen: "confirm",
      confirm: { action: { kind: "kill", hostKey: "host-a", sessionId: "sess-0001" }, cursor: 0 },
    });
    const model = asSession(render(state));
    expect(model.bottom.mode).toBe("menu");
    expect(model.bottom.lines[0]).toBe("End session sess-0?");
    expect(model.bottom.lines).toContain("> Cancel");
    expect(model.bottom.lines).toContain("  Confirm");
  });

  it("honors the cursor selection on the confirmation menu", () => {
    const state = base({
      screen: "confirm",
      confirm: { action: { kind: "kill", hostKey: "host-a", sessionId: "sess-0001" }, cursor: 1 },
    });
    const model = asSession(render(state));
    expect(model.bottom.lines[0]).toBe("End session sess-0?");
    expect(model.bottom.lines).toContain("  Cancel");
    expect(model.bottom.lines).toContain("> Confirm");
  });

  it("names the session in the confirmation prompt when it has a summary", () => {
    const s = session({ id: "sess-0001", summary: "Adding Compose Flag" });
    const state = base({
      screen: "confirm",
      agents: [agent({ key: "host-a", sessions: [s] })],
      confirm: { action: { kind: "kill", hostKey: "host-a", sessionId: "sess-0001" }, cursor: 0 },
    });
    const model = asSession(render(state));
    expect(model.bottom.lines[0]).toBe("End session Adding Compose Flag?");
  });
});

describe("render: newRepo", () => {
  it("lists repos plus Resume rows for repos with closed sessions", () => {
    const agents: AgentInfo[] = [
      agent({
        key: "host-a",
        repos: [{ name: "repoA", path: "/repos/repoA" }, { name: "repoB", path: "/repos/repoB" }],
        closedSessions: [
          { id: "closed-1", repo: "repoA", label: "old-fix", createdAt: null, closedAt: null },
        ],
      }),
    ];
    const state = base({
      screen: "newRepo",
      agents,
      newRepo: { hostKey: "host-a", cursor: 1 },
    });

    const lines = asLines(render(state));
    expect(lines).toContain("  repoA");
    expect(lines).toContain("> Resume old-fix");
    expect(lines).toContain("  repoB");
  });
});

describe("render: settings", () => {
  it("shows host online/offline counts", () => {
    const agents = [agent({ key: "a", online: true }), agent({ key: "b", online: false })];
    const state = base({ screen: "settings", agents, settings: { cursor: 0 } });
    const lines = asLines(render(state));
    expect(lines).toContain("1/2 hosts online");
  });
});
