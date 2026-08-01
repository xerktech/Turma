// @vitest-environment jsdom
//
// Controller tests for the native phone companion (XERK-171) against a real DOM
// (jsdom): the delegated click wiring drives the App/HubClient IN-PROCESS, which
// is the whole point of the rebuild — a tap is a direct App.enterSession call,
// not a cross-origin postMessage. Verifies the actions fire, the view state
// transitions (enter/leave/glasses-pull), and the compose draft survives a poll
// repaint.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhone } from "./phone.ts";
import { createInitialState, newSessionState, type AppState } from "../app.ts";
import type { AgentInfo, LiveSignals, SessionInfo } from "../types.ts";

function signals(o: Partial<LiveSignals> = {}): LiveSignals {
  return { bridgeAttached: true, transcriptAgeSec: 1, lastRole: null, lastHasToolUse: false, question: null, questionOptions: [], tail: [], newPrUrls: [], ...o };
}
function session(o: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "s1", repo: "web", status: "running", session: signals(), createdAt: "2026-01-01T00:00:00Z", ...o };
}
function agent(o: Partial<AgentInfo> = {}): AgentInfo {
  return { key: "host-a", device: "host-a", online: true, repos: [], sessions: [], closedSessions: [], ...o };
}

const FLEET = [
  agent({ key: "host-a", jira: { siteKey: "acme.atlassian.net" }, sessions: [session({ id: "s1", summary: "alpha" })] }),
  agent({ key: "host-b", jira: { siteKey: "globex.atlassian.net" }, sessions: [session({ id: "s2", summary: "bravo" })] }),
];

function homeState(): AppState {
  return { ...createInitialState(0), agents: FLEET };
}
function sessionState(id: string, host: string): AppState {
  return { ...homeState(), screen: "session", session: newSessionState(host, id) };
}

describe("phone controller", () => {
  let root: HTMLElement;
  let client: Record<string, ReturnType<typeof vi.fn>>;
  let app: { getState: () => AppState; enterSession: ReturnType<typeof vi.fn>; setOrgFilter: ReturnType<typeof vi.fn> };
  let handle: ReturnType<typeof mountPhone>;
  let onSignOut: ReturnType<typeof vi.fn>;
  let state: AppState;

  beforeEach(() => {
    document.body.innerHTML = '<div id="phone"></div>';
    root = document.getElementById("phone") as HTMLElement;
    state = homeState();
    client = {
      sendInput: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      answerQuestion: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      interrupt: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      setSummary: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      sessionAction: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      getHistory: vi.fn(async () => ({ status: 200 as const, body: { entries: [], truncated: false, fetchedAt: 0 } })),
      loginForCookie: vi.fn(async () => {}),
      termUrl: vi.fn((id: string) => `http://hub/term/${id}/`),
      jiraDetail: vi.fn(async () => ({ status: 200 as const, body: {} })),
      jiraRefresh: vi.fn(async () => ({ ok: true })),
      startTicket: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      setTicketStatus: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      setTicketRepo: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      setTicketAgent: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      setTicketModel: vi.fn(async () => ({ ok: true, cmdId: "c" })),
      createMeta: vi.fn(async (_s: string, project?: string) => ({ status: 200 as const, body: project ? { types: [{ id: "10001", name: "Task" }] } : { projects: [{ key: "ACME" }], labels: [], source: "jira" } })),
      createTicket: vi.fn(async () => ({ ok: true, cmdId: "cc" })),
      createResult: vi.fn(async () => ({ status: 200 as const, body: { key: "ACME-99", url: "https://x/ACME-99" } })),
    };
    // A fake App whose enter/setOrgFilter synchronously push the new state to the
    // phone, exactly as the real App's setState→repaint→onState does.
    app = {
      getState: () => state,
      enterSession: vi.fn((id: string, host?: string) => { state = sessionState(id, host ?? "host-a"); handle.render(state); }),
      setOrgFilter: vi.fn((k: string) => { state = { ...state, orgFilter: k }; handle.render(state); }),
    };
    onSignOut = vi.fn();
    handle = mountPhone({ root, app: app as never, client: client as never, onSignOut: onSignOut as unknown as () => void });
  });

  it("renders the sessions list from state", () => {
    expect(root.querySelector('[data-enter="s1"]')).toBeTruthy();
    expect(root.textContent).toContain("alpha");
    expect(root.textContent).toContain("bravo");
  });

  it("tapping a session enters it in-process and shows the session view", () => {
    root.querySelector<HTMLElement>('[data-enter="s1"]')!.click();
    expect(app.enterSession).toHaveBeenCalledWith("s1", "host-a");
    expect(root.querySelector("#ph-transcript")).toBeTruthy();
    expect(root.querySelector(".ph-nav")).toBeFalsy(); // shell hidden in the session view
  });

  it("Back leaves the phone's session view WITHOUT touching the glasses", () => {
    root.querySelector<HTMLElement>('[data-enter="s1"]')!.click();
    expect(root.querySelector("#ph-transcript")).toBeTruthy();
    root.querySelector<HTMLElement>("[data-back]")!.click();
    // Back to the list; nothing was pushed to the App (leaving doesn't sync).
    expect(root.querySelector(".ph-nav")).toBeTruthy();
    expect(app.enterSession).toHaveBeenCalledTimes(1); // only the enter, never on back
  });

  it("the org filter drives App.setOrgFilter in-process", () => {
    root.querySelector<HTMLElement>("[data-org-toggle]")!.click();
    const globex = Array.from(root.querySelectorAll<HTMLElement>("[data-org]")).find((b) => /globex/.test(b.textContent || ""))!;
    globex.click();
    expect(app.setOrgFilter).toHaveBeenCalledWith("globex.atlassian.net");
    // The list re-scoped to that org.
    expect(root.textContent).toContain("bravo");
    expect(root.textContent).not.toContain("alpha");
  });

  it("Send delivers the compose text through the shared HubClient and clears it", () => {
    root.querySelector<HTMLElement>('[data-enter="s1"]')!.click();
    const inp = root.querySelector<HTMLTextAreaElement>("#ph-input")!;
    inp.value = "do the thing";
    root.querySelector<HTMLElement>("[data-send]")!.click();
    expect(client.sendInput).toHaveBeenCalledWith("host-a", "s1", "do the thing");
    expect(root.querySelector<HTMLTextAreaElement>("#ph-input")!.value).toBe("");
  });

  it("answering a pending question routes to HubClient.answerQuestion", () => {
    state = { ...sessionState("s1", "host-a"),
      agents: [agent({ key: "host-a", sessions: [session({ id: "s1", session: signals({ question: "Go?", questionOptions: ["Yes", "No"] }) })] })] };
    handle.render(state);
    handle.enterFromGlasses("host-a", "s1");
    root.querySelectorAll<HTMLElement>("[data-answer]")[1]!.click();
    expect(client.answerQuestion).toHaveBeenCalledWith("host-a", "s1", { optionIndex: 1 });
  });

  it("enterFromGlasses pulls the phone into the session the glasses entered", () => {
    // Simulate the App entering a session by a glasses gesture: onState pushes the
    // new state, then onEnterSession fires.
    state = sessionState("s2", "host-b");
    handle.render(state);
    handle.enterFromGlasses("host-b", "s2");
    expect(root.querySelector("#ph-transcript")).toBeTruthy();
  });

  it("the compose draft survives a poll repaint (render with unchanged state)", () => {
    root.querySelector<HTMLElement>('[data-enter="s1"]')!.click();
    const inp = root.querySelector<HTMLTextAreaElement>("#ph-input")!;
    inp.value = "half-typed";
    inp.focus();
    handle.render(state); // a ~1s poll repaint
    expect(root.querySelector<HTMLTextAreaElement>("#ph-input")!.value).toBe("half-typed");
  });

  it("the ⋯ menu renames via setSummary and kills via sessionAction (arm-then-confirm)", () => {
    root.querySelector<HTMLElement>('[data-enter="s1"]')!.click();
    // Rename
    root.querySelector<HTMLElement>("[data-sess-menu]")!.click();
    root.querySelector<HTMLElement>("[data-menu-rename]")!.click();
    root.querySelector<HTMLInputElement>("#ph-rename")!.value = "New name";
    root.querySelector<HTMLElement>("[data-menu-save]")!.click();
    expect(client.setSummary).toHaveBeenCalledWith("host-a", "s1", "New name");
    // Kill: arm then confirm
    root.querySelector<HTMLElement>("[data-sess-menu]")!.click();
    root.querySelector<HTMLElement>("[data-menu-kill]")!.click();
    expect(client.sessionAction).not.toHaveBeenCalled(); // armed, not fired
    root.querySelector<HTMLElement>("[data-menu-kill-confirm]")!.click();
    expect(client.sessionAction).toHaveBeenCalledWith("host-a", "s1", "kill");
    expect(root.querySelector(".ph-nav")).toBeTruthy(); // left the session view after kill
  });

  it("the Board tab renders the kanban and a card tap opens the ticket detail (via HubClient.jiraDetail)", async () => {
    state = { ...homeState(), agents: [agent({ key: "host-a", jira: { available: true, siteKey: "acme.atlassian.net", user: "me", fetchedAt: "2026-08-01T00:00:00Z",
      tickets: [{ key: "ACME-1", summary: "Fix login", statusCategory: "todo", status: "To Do", updated: "2026-08-01T00:00:00Z", project: "ACME" }] } })] };
    client.jiraDetail = vi.fn(async () => ({ status: 200 as const, body: { key: "ACME-1", summary: "Fix login", status: "To Do", statusCategory: "todo", type: "Task", description: "do it", comments: [], url: "https://x/ACME-1" } }));
    client.jiraRefresh = vi.fn(async () => ({ ok: true }));
    handle.render(state);
    root.querySelector<HTMLElement>('[data-tab="board"]')!.click();
    expect(root.querySelector(".kanban-cols")).toBeTruthy();
    expect(root.textContent).toContain("Fix login");
    // Refresh
    root.querySelector<HTMLElement>("[data-board-refresh]")!.click();
    expect(client.jiraRefresh).toHaveBeenCalled();
    // Card tap -> detail fetch + panel shown
    root.querySelector<HTMLElement>('.kanban-card[data-key="ACME-1"]')!.click();
    expect(client.jiraDetail).toHaveBeenCalledWith("acme.atlassian.net", "ACME-1");
    await new Promise((r) => setTimeout(r, 10));
    expect(root.querySelector<HTMLElement>("#ph-detail")!.hidden).toBe(false);
  });

  it("the detail-panel status picker saves a change via HubClient.setTicketStatus", async () => {
    state = { ...homeState(), agents: [agent({ key: "host-a", online: true, jira: { available: true, siteKey: "acme.atlassian.net", user: "me", fetchedAt: "2026-08-01T00:00:00Z",
      tickets: [{ key: "ACME-1", summary: "Fix login", statusCategory: "todo", status: "To Do", updated: "2026-08-01T00:00:00Z", project: "ACME" }] } })] };
    client.jiraDetail = vi.fn(async () => ({ status: 200 as const, body: { key: "ACME-1", summary: "Fix login", status: "To Do", statusCategory: "todo", type: "Task", url: "https://x/ACME-1",
      statusOptions: [{ id: "11", name: "To Do", category: "todo" }, { id: "31", name: "Done", category: "done" }] } }));
    handle.render(state);
    root.querySelector<HTMLElement>('[data-tab="board"]')!.click();
    root.querySelector<HTMLElement>('.kanban-card[data-key="ACME-1"]')!.click();
    await new Promise((r) => setTimeout(r, 10));
    // Open the status picker, pick "Done".
    root.querySelector<HTMLElement>("[data-status-edit]")!.click();
    const sel = root.querySelector<HTMLSelectElement>("[data-status-select]")!;
    expect(sel).toBeTruthy();
    sel.value = "31";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(client.setTicketStatus).toHaveBeenCalledWith("acme.atlassian.net", "ACME-1", { value: "31" });
  });

  it("New ticket opens the create modal, cascades org→project→type, and creates via HubClient", async () => {
    state = { ...homeState(), agents: [agent({ key: "host-a", online: true, jira: { available: true, siteKey: "acme.atlassian.net", user: "me", fetchedAt: "2026-08-01T00:00:00Z", tickets: [] } })] };
    handle.render(state);
    root.querySelector<HTMLElement>('[data-tab="board"]')!.click();
    root.querySelector<HTMLElement>("[data-new-ticket]")!.click();
    await new Promise((r) => setTimeout(r, 30)); // loadMeta -> lone project auto-selects -> loadTypes -> lone type
    expect(client.createMeta).toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>("#ph-create")!.hidden).toBe(false);
    // Fill the summary and submit.
    const sum = root.querySelector<HTMLInputElement>("[data-cf-summary]");
    expect(sum).toBeTruthy();
    sum!.value = "Do the thing";
    sum!.dispatchEvent(new Event("input", { bubbles: true })); // enables the submit button, like typing
    root.querySelector<HTMLElement>("[data-cf-submit]")!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.createTicket).toHaveBeenCalledWith("acme.atlassian.net", expect.objectContaining({ project: "ACME", issueType: "10001", summary: "Do the thing" }));
    expect(root.textContent).toContain("ACME-99"); // the created-ticket confirmation
  });

  it("the sign-out affordance calls back out", () => {
    root.querySelector<HTMLElement>("[data-signout]")!.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("a session already open on the glasses is not ejected when its org leaves the filter", () => {
    root.querySelector<HTMLElement>('[data-enter="s1"]')!.click();
    // Now filter to a different org — the session view stays (leaving is one-way).
    state = { ...sessionState("s1", "host-a"), orgFilter: "globex.atlassian.net" };
    handle.render(state);
    expect(root.querySelector("#ph-transcript")).toBeTruthy();
  });
});
