import { describe, expect, it } from "vitest";
import { createInitialState, newSessionState, type AppState } from "../app.ts";
import type { AgentInfo, LiveSignals, SessionInfo } from "../types.ts";
import {
  orgLabel,
  orgOptions,
  phoneHtml,
  sessionEntries,
  sessionsBodyHtml,
  sessionViewHtml,
  type PhoneView,
} from "./render.ts";

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
  it("orgLabel strips the Jira suffix and takes the last segment of a slashed key", () => {
    expect(orgLabel("acme.atlassian.net")).toBe("acme");
    expect(orgLabel("dev.azure.com/myorg")).toBe("myorg");
    expect(orgLabel("")).toBe("All orgs");
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

  it("a session card carries its enter hooks and status", () => {
    const st = state({ agents: [agent({ sessions: [session({ id: "sX", summary: "do a thing", session: signals({ paneBusy: true }) })] })] });
    const html = sessionsBodyHtml(st);
    expect(html).toMatch(/data-enter="sX"/);
    expect(html).toMatch(/data-host="host-a"/);
    expect(html).toContain("do a thing");
    expect(html).toContain("st-working");
  });

  it("sessionEntries appends the growing live turn as the newest assistant bubble", () => {
    const st = state({
      screen: "session",
      session: newSessionState("host-a", "s1"),
      transcripts: { s1: { entries: [{ id: "u1", role: "user", text: "hi" }] } },
      liveTurn: { sessionId: "s1", text: "typing…" },
    });
    const entries = sessionEntries(st);
    expect(entries.map((e) => e.text)).toEqual(["hi", "typing…"]);
    expect(entries[1]?.role).toBe("assistant");
  });

  it("sessionViewHtml renders a pending question with numbered options and a compose box", () => {
    const st = state({
      screen: "session",
      session: newSessionState("host-a", "s1"),
      agents: [agent({ sessions: [session({ id: "s1", session: signals({ question: "Pick one", questionOptions: ["A", "B"] }) })] })],
      transcripts: {},
    });
    const html = sessionViewHtml(st);
    expect(html).toContain("Pick one");
    expect(html).toMatch(/data-answer="0"[^>]*>1\. A/);
    expect(html).toMatch(/data-answer="1"[^>]*>2\. B/);
    expect(html).toContain('id="ph-input"');
    expect(html).toMatch(/data-back/);
  });

  it("phoneHtml shows the shell (header org menu + bottom nav) on the sessions tab", () => {
    const st = state({ agents: [agent({ jira: { siteKey: "acme.atlassian.net" } })] });
    const view: PhoneView = { tab: "sessions", inSession: false };
    const html = phoneHtml(st, view, false);
    expect(html).toMatch(/data-tab="sessions"[^>]*class="ph-tab active"|class="ph-tab active"[^>]*data-tab="sessions"/);
    expect(html).toContain("data-org-toggle");
    expect(html).toContain("data-signout");
  });

  it("phoneHtml overlays the session view (no shell) when inSession and a session is focused", () => {
    const st = state({
      screen: "session",
      session: newSessionState("host-a", "s1"),
      agents: [agent({ sessions: [session({ id: "s1" })] })],
    });
    const html = phoneHtml(st, { tab: "sessions", inSession: true }, false);
    expect(html).toContain("ph-transcript");
    expect(html).not.toContain("ph-nav"); // the shell nav is hidden in the session view
  });

  it("phoneHtml falls back to the shell if inSession but the glasses left the session", () => {
    const st = state({ screen: "home", session: null, agents: [agent()] });
    const html = phoneHtml(st, { tab: "sessions", inSession: true }, false);
    expect(html).toContain("ph-nav");
  });
});
