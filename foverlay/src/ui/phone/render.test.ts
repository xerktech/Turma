import { describe, expect, it } from "bun:test";
import { createInitialState, newSessionState, type AppState } from "../../core/app.ts";
import type { AgentInfo, LiveSignals, SessionInfo } from "../../core/types.ts";
import {
  boardBodyHtml,
  orgLabel,
  orgOptions,
  phoneHtml,
  transcriptEntries,
  sessionsBodyHtml,
  sessionViewHtml,
  type PhoneView,
} from "./render.ts";

const VIEW = (o: Partial<PhoneView> = {}): PhoneView => ({ tab: "sessions", inSession: false, verbosity: "normal", showTerminal: false, menu: "closed", ...o });

function signals(o: Partial<LiveSignals> = {}): LiveSignals {
  return {
    bridgeAttached: true, transcriptAgeSec: 1, lastRole: null, lastHasToolUse: false,
    question: null, questionOptions: [], tail: [], newPrUrls: [], ...o,
  };
}
function session(o: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "s1", repo: "repoA", status: "running", session: signals(), createdAt: "2026-01-01T00:00:00Z", ...o };
}
function agent(o: Partial<AgentInfo> = {}): AgentInfo {
  return { key: "host-a", device: "host-a", online: true, repos: [], sessions: [], closedSessions: [], ...o };
}
function state(patch: Partial<AppState> = {}): AppState {
  return { ...createInitialState(0), ...patch };
}

describe("phone render", () => {
  it("orgLabel uses the manual name override, else derives from the siteKey", () => {
    expect(orgLabel("acme.atlassian.net")).toBe("acme");
    expect(orgLabel("dev.azure.com/myorg")).toBe("myorg");
    expect(orgLabel("")).toBe("All orgs");
    expect(orgLabel("acme.atlassian.net", "Acme Corp")).toBe("Acme Corp"); // BOARD_ORG_NAME wins
  });

  it("orgOptions shows the manual org name from the agent's jira block", () => {
    const st = state({ agents: [agent({ key: "a", jira: { siteKey: "acme.atlassian.net", orgName: "Acme Corp" } })] });
    expect(orgOptions(st)).toEqual([{ key: "acme.atlassian.net", label: "Acme Corp", count: 0, online: true }]);
  });

  it("orgOptions includes an Azure DevOps org (mergeSites is source-agnostic)", () => {
    const st = state({
      agents: [
        agent({ key: "a", jira: { source: "azure", siteKey: "dev.azure.com/myorg", orgName: "My Org",
          tickets: [{ key: "1" }, { key: "2" }] } }),
      ],
    });
    expect(orgOptions(st)).toEqual([{ key: "dev.azure.com/myorg", label: "My Org", count: 2, online: true }]);
  });

  it("card tints honour the hub's org-colour pins (matching the web/Android)", () => {
    const st = state({
      orgColors: { "acme.atlassian.net": 5 }, // pinned to slot 5
      agents: [agent({ key: "a", jira: { siteKey: "acme.atlassian.net" }, sessions: [session({ id: "s1", summary: "x" })] })],
    });
    expect(sessionsBodyHtml(st)).toContain("--org:var(--s5)");
  });

  it("orgOptions lists each reporting org once, sorted", () => {
    const st = state({
      agents: [
        agent({ key: "a", jira: { siteKey: "zeta.atlassian.net" } }),
        agent({ key: "b", jira: { siteKey: "alpha.atlassian.net" } }),
        agent({ key: "c", jira: { siteKey: "zeta.atlassian.net" } }),
        agent({ key: "d" }), // no org
      ],
    });
    expect(orgOptions(st).map((o) => o.key)).toEqual(["alpha.atlassian.net", "zeta.atlassian.net"]);
  });

  it("sessionsBodyHtml scopes the list to the org filter", () => {
    const st = state({
      orgFilter: "acme.atlassian.net",
      agents: [
        agent({ key: "a", jira: { siteKey: "acme.atlassian.net" }, sessions: [session({ id: "sa", summary: "alpha" })] }),
        agent({ key: "b", jira: { siteKey: "other.atlassian.net" }, sessions: [session({ id: "sb", summary: "bravo" })] }),
      ],
    });
    const html = sessionsBodyHtml(st);
    expect(html).toContain("alpha");
    expect(html).not.toContain("bravo");
  });

  it("cards carry org tint, PR chips, a ticket chip, and Queued/Ended sections", () => {
    const st = state({
      agents: [
        agent({ key: "h1", jira: { siteKey: "acme.atlassian.net" }, sessions: [
          session({ id: "sw", summary: "working one", session: signals({ paneBusy: true }), prs: [{ url: "https://github.com/o/r/pull/42", number: 42, state: "Open", ready: "ready" }], ticket: { key: "ACME-9" } }),
          session({ id: "sq", status: "queued", queuedReason: "capacity", summary: "queued one" }),
        ], closedSessions: [{ id: "sk", repo: "web", summary: "killed one" } as never] }),
      ],
    });
    const html = sessionsBodyHtml(st);
    // Org tint: the card carries a --org custom property.
    expect(html).toMatch(/--org:var\(--s\d\)/);
    // PR chip + readiness mark.
    expect(html).toContain("pr-badge");
    expect(html).toContain("#42");
    expect(html).toMatch(/pr-ready ready/);
    // Ticket chip.
    expect(html).toContain("ACME-9");
    // Sections.
    expect(html).toContain("Active");
    expect(html).toContain("Queued");
    expect(html).toContain("Ended");
    expect(html).toContain("waiting for a free session slot"); // queued reason
    expect(html).toMatch(/data-cancel="sq"/);
    expect(html).toContain("killed one");
  });

  it("a session card carries its enter hooks and status", () => {
    const st = state({ agents: [agent({ sessions: [session({ id: "sX", summary: "do a thing", session: signals({ paneBusy: true }) })] })] });
    const html = sessionsBodyHtml(st);
    expect(html).toMatch(/data-enter="sX"/);
    expect(html).toMatch(/data-host="host-a"/);
    expect(html).toContain("do a thing");
    expect(html).toContain("st-working");
  });

  it("transcriptEntries appends the growing live turn as the newest assistant entry", () => {
    const entries = transcriptEntries(
      [{ id: "u1", role: "user", text: "hi" }],
      { sessionId: "s1", text: "typing…" },
      "s1"
    );
    expect(entries.map((e) => e.text)).toEqual(["hi", "typing…"]);
    expect(entries[1]?.role).toBe("assistant");
  });

  it("sessionViewHtml renders a pending question, a compose box, a transcript container and the terminal/verbosity controls", () => {
    const st = state({
      screen: "session",
      session: newSessionState("host-a", "s1"),
      agents: [agent({ sessions: [session({ id: "s1", session: signals({ question: "Pick one", questionOptions: ["A", "B"] }) })] })],
      transcripts: {},
    });
    const html = sessionViewHtml(st, "normal", false, "closed");
    expect(html).toContain("Pick one");
    expect(html).toMatch(/data-answer="0"[\s\S]*?>1<\/span>A/);
    expect(html).toMatch(/data-answer="1"[\s\S]*?>2<\/span>B/);
    expect(html).toContain('id="ph-input"');
    expect(html).toContain('id="ph-transcript"'); // filled by the controller with chat.js output
    // Foverlay port: the Terminal toggle is not ported (see render.ts) — assert
    // it stays absent so it can't silently come back half-wired.
    expect(html).not.toContain("data-term-toggle");
    expect(html).toMatch(/data-verb="verbose"/); // verbosity control
    expect(html).toMatch(/data-back/);
  });

  it("boardBodyHtml renders the kanban (via board.js) with a ticket, a refresh, and a detail modal", () => {
    const st = state({
      agents: [
        agent({ key: "h1", jira: { available: true, siteKey: "acme.atlassian.net", user: "me", fetchedAt: "2026-08-01T00:00:00Z",
          tickets: [{ key: "ACME-1", summary: "Fix the thing", statusCategory: "todo", status: "To Do", updated: "2026-08-01T00:00:00Z", project: "ACME" }] } }),
      ],
    });
    const html = boardBodyHtml(st);
    expect(html).toContain("kanban-cols");
    expect(html).toContain("Fix the thing");
    expect(html).toContain("ACME-1");
    expect(html).toMatch(/data-board-refresh/);
    expect(html).toMatch(/data-new-ticket/);
    expect(html).toContain('id="ph-detail"'); // the detail modal container
    expect(html).toContain('id="ph-create"'); // the create modal container
  });

  it("a drag move override places the ticket in the dropped column", () => {
    const st = state({
      agents: [
        agent({ key: "h1", jira: { available: true, siteKey: "acme.atlassian.net", user: "me", fetchedAt: "2026-08-01T00:00:00Z",
          tickets: [{ key: "ACME-1", summary: "Move me", statusCategory: "todo", status: "To Do", updated: "2026-08-01T00:00:00Z", project: "ACME" }] } }),
      ],
    });
    // No override: the card sits under To Do.
    const plain = boardBodyHtml(st);
    const todoIdx = plain.indexOf("To Do");
    const inprogIdx = plain.indexOf("In Progress");
    expect(plain.indexOf("Move me")).toBeGreaterThan(todoIdx);
    expect(plain.indexOf("Move me")).toBeLessThan(inprogIdx);
    // With a move override to done, the card renders in the Done column.
    const moves = new Map<string, unknown>([["acme.atlassian.net\x00ACME-1", { category: "done", pending: true, at: 0 }]]);
    const moved = boardBodyHtml(st, moves);
    expect(moved.indexOf("Move me")).toBeGreaterThan(moved.indexOf("Done"));
  });

  it("phoneHtml shows the shell (header org menu + bottom nav) on the sessions tab", () => {
    const st = state({ agents: [agent({ jira: { siteKey: "acme.atlassian.net" } })] });
    const html = phoneHtml(st, VIEW(), false);
    expect(html).toMatch(/data-tab="sessions"[^>]*class="ph-tab active"|class="ph-tab active"[^>]*data-tab="sessions"/);
    expect(html).toContain("data-org-toggle");
    expect(html).toContain("data-signout");
  });

  it("the open org menu carries a per-org auto-start toggle reflecting the hub's opt-in", () => {
    const st = state({
      autoStartOrgs: { "acme.atlassian.net": true }, // acme opted in, beta not
      agents: [
        agent({ key: "a", jira: { siteKey: "acme.atlassian.net" } }),
        agent({ key: "b", jira: { siteKey: "beta.atlassian.net" } }),
      ],
    });
    const html = phoneHtml(st, VIEW(), true); // orgOpen -> menu rendered
    // Each real org row has an auto toggle; "All orgs" does not.
    expect(html).toMatch(/data-org-auto="acme\.atlassian\.net"/);
    expect(html).toMatch(/data-org-auto="beta\.atlassian\.net"/);
    // acme is ON, beta is OFF.
    expect(html).toMatch(/class="ph-org-auto on" data-org-auto="acme\.atlassian\.net" aria-pressed="true"/);
    expect(html).toMatch(/class="ph-org-auto" data-org-auto="beta\.atlassian\.net" aria-pressed="false"/);
  });

  it("phoneHtml overlays the session view (no shell) when inSession and a session is focused", () => {
    const st = state({
      screen: "session",
      session: newSessionState("host-a", "s1"),
      agents: [agent({ sessions: [session({ id: "s1" })] })],
    });
    const html = phoneHtml(st, VIEW({ inSession: true }), false);
    expect(html).toContain("ph-transcript");
    expect(html).not.toContain("ph-nav"); // the shell nav is hidden in the session view
  });

  it("phoneHtml falls back to the shell if inSession but the glasses left the session", () => {
    const st = state({ screen: "home", session: null, agents: [agent()] });
    const html = phoneHtml(st, VIEW({ inSession: true }), false);
    expect(html).toContain("ph-nav");
  });
});
