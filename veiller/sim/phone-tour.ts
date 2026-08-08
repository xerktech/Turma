/**
 * A tour of the Turma miniapp's PHONE half — the companion that runs in the
 * miniapp's WebView.
 *
 * The glasses walkthrough drives the lens; this drives the other surface: the
 * WebView ↔ background bus (`shared/channels.ts`) and everything the phone
 * renders from it. It runs the real background bundle in the simulator and
 * talks to it exactly as the page does — `turma:fetch` for hub REST,
 * `turma:storage-*` for the config, `turma:cmd` for commands, and the
 * `turma:state` / `turma:rich-tail` / `turma:enter-session` broadcasts — then
 * feeds each payload through the app's OWN `hydratePhoneState` + `phoneHtml`,
 * so what is asserted is the markup the operator would actually see.
 *
 * No browser is involved: the DOM event handlers in `phone/phone.ts` are the
 * one layer this can't reach (`src/ui/phone/render.test.ts` covers the markup
 * they act on). Everything the background must provide for that markup to be
 * right IS reached, which is where a port breaks.
 *
 *   bun run build
 *   bun run sim/phone-tour.ts
 */

import { CONFIG_STORAGE_KEY } from "../src/core/config.ts";
import { HubClient } from "../src/core/hub-client.ts";
import { hydratePhoneState, type PhoneStatePayload } from "../src/shared/phone-state.ts";
import { phoneHtml, sessionsBodyHtml, boardBodyHtml, sessionViewHtml, type PhoneView } from "../src/ui/phone/render.ts";
import { defaultFleet, FakeHub } from "./fake-hub.ts";
import { bundlePath, simulatorModule, type SimulatorInstance } from "./sim-path.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const showHtml = args.includes("--html");

const findings: string[] = [];
let stepNo = 0;

function check(ok: boolean, what: string): void {
  console.log(`    ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) findings.push(`step ${stepNo}: ${what}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const VIEW = (o: Partial<PhoneView> = {}): PhoneView => ({
  tab: "sessions",
  inSession: false,
  verbosity: "normal",
  showTerminal: false,
  menu: "closed",
  ...o,
});

/** Strip tags so a test can assert on what the operator reads, not the markup. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function main(): Promise<void> {
  const hub = new FakeHub();
  hub.start();
  hub.agents = defaultFleet();
  hub.ticketDetails["xerktech.atlassian.net/XERK-233"] = {
    key: "XERK-233",
    summary: "Turma Veiller fixes",
    description: "Walk the miniapp in the simulator and fix what breaks.",
    status: "In Progress",
    statusCategory: "indeterminate",
    statusOptions: [
      { id: "31", name: "Done", category: "done" },
      { id: "21", name: "To Do", category: "new" },
    ],
    comments: [{ author: "Malcolm Habeeb", body: "Simulator landed in Veiller main." }],
  };

  const { Simulator } = await simulatorModule();
  const sim: SimulatorInstance = new Simulator({ bundle: bundlePath(), model: "g2", verbose, storage: {} });
  const config = { hubUrl: hub.url, user: hub.user, password: hub.password, pollMs: 400 };

  /** The `fetch` the phone really uses: every request rides turma:fetch. */
  const proxyFetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const res = await sim.phone.request<{ status: number; ok: boolean; bodyText: string }>(
      "turma:fetch",
      {
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string> | undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      },
      45_000
    );
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.bodyText,
      json: async () => JSON.parse(res.bodyText) as unknown,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const client = new HubClient({ config, fetchFn: proxyFetch });

  let payload: PhoneStatePayload | null = null;
  const state = (): ReturnType<typeof hydratePhoneState> => hydratePhoneState(payload!);

  const step = async (title: string, run: () => Promise<void>): Promise<void> => {
    stepNo += 1;
    console.log(`\n${String(stepNo).padStart(2)}. ${title}`);
    await run();
  };

  try {
    await sim.start();
    sim.phone.open();
    sim.phone.on("turma:state", (p) => {
      payload = p as PhoneStatePayload;
    });

    // ------------------------------------------------------------------ 1
    await step("A fresh WebView is told which half to show", async () => {
      const snap = await sim.phone.request<{ phase: string; state: unknown }>("turma:get-state", {});
      check(snap.phase === "setup", "an unconfigured background reports the setup phase");
      check(snap.state === null, "and carries no state, so the login card shows");
    });

    // ------------------------------------------------------------------ 2
    await step("Signing in persists the config and starts the App", async () => {
      await sim.phone.request("turma:storage-set", { key: CONFIG_STORAGE_KEY, value: JSON.stringify(config) });
      const back = await sim.phone.request<{ value: string | null }>("turma:storage-get", { key: CONFIG_STORAGE_KEY });
      check(!!back.value && JSON.parse(back.value).hubUrl === hub.url, "the config reads back from phone storage");
      const res = await sim.phone.request<{ phase: string }>("turma:config-changed", {});
      check(res.phase === "running", "the background starts the App on the new config");
      await sim.phone.waitFor<PhoneStatePayload>("turma:state", (p) => (p?.agents?.length ?? 0) > 0, 8000);
      check(!!payload, "a state broadcast reaches the phone");
    });

    // ------------------------------------------------------------------ 3
    await step("Hub REST works through the background's fetch proxy", async () => {
      const agents = await client.listAgents();
      check(agents.agents.length === 2, "listAgents comes back through turma:fetch");
      const bad = new HubClient({ config: { ...config, password: "wrong" }, fetchFn: proxyFetch });
      let status = 0;
      try {
        await bad.listAgents();
      } catch (err) {
        status = (err as { status?: number }).status ?? 0;
      }
      check(status === 401, "a wrong password surfaces the hub's 401 rather than hanging");
      const hist = await client.getHistory("truenas", "sess-1");
      check(hist.status === 200 || hist.status === 202, "history's 202/200 split survives the proxy");
    });

    // ------------------------------------------------------------------ 4
    await step("The Sessions list renders the fleet the background sent", async () => {
      const html = sessionsBodyHtml(state());
      const text = textOf(html);
      if (showHtml) console.log(html);
      check(text.includes("truenas"), "the host is named");
      check(text.includes("Fixing the lens"), "the session's generated name is the card title");
      check(text.includes("Turma"), "its repo is shown");
      check(html.includes('data-enter="sess-1"'), "the card can be tapped into the session");
      // The phone lists SESSIONS grouped Active/Idle/Queued/Ended (the web
      // Sessions page's shape), not the dashboard's host tree — a host with no
      // sessions is correctly absent.
      check(text.includes("Idle") || text.includes("Active"), "sessions are grouped by how they are running");
      check(!text.includes("wsl-desktop"), "a host with no sessions adds no row");
    });

    // ------------------------------------------------------------------ 5
    await step("The org control offers the org the fleet reports", async () => {
      const html = phoneHtml(state(), VIEW(), true);
      const text = textOf(html);
      check(text.includes("xerktech") || text.includes("All orgs"), "the org menu lists the reporting org");
      check(html.includes("data-org"), "each org row is selectable");
      check(html.includes("data-org-auto"), "each org row carries the auto-start toggle");
    });

    // ------------------------------------------------------------------ 6
    await step("Flipping auto-start round-trips to the hub and back into state", async () => {
      const site = "xerktech.atlassian.net";
      await sim.phone.request("turma:cmd", { kind: "setAutoStartOrg", siteKey: site, enabled: true });
      await client.setAutoStart(site, true);
      check(hub.autoStartOrgs[site] === true, "the hub recorded the opt-in");
      await sim.phone.waitFor<PhoneStatePayload>("turma:state", (p) => !!p?.autoStartOrgs?.[site], 8000);
      check(!!payload?.autoStartOrgs?.[site], "the next poll reports it back to the phone");
      await client.setAutoStart(site, false);
      hub.autoStartOrgs = {};
    });

    // ------------------------------------------------------------------ 7
    await step("Entering a session from the phone moves the glasses too", async () => {
      await sim.phone.request("turma:cmd", { kind: "enterSession", sessionId: "sess-1", hostKey: "truenas" });
      await sim.settle();
      check(sim.lensText().join("\n").includes("Walk the miniapp"), "the glasses followed into the session");
      await sim.phone.waitFor<PhoneStatePayload>("turma:state", (p) => p?.session?.sessionId === "sess-1", 8000);
      check(payload?.screen === "session", "the phone's copy of the state agrees which screen is open");
      check(payload?.session?.sessionId === "sess-1", "and which session");
    });

    // ------------------------------------------------------------------ 8
    await step("The session view renders with the compose box and controls", async () => {
      const html = sessionViewHtml(state(), "normal", false, "closed");
      if (showHtml) console.log(html);
      check(html.includes("ph-input"), "there is a compose box");
      check(html.includes("data-send"), "with a send control");
      check(html.includes("data-back"), "and a way back to the list");
      check(html.includes("data-verb"), "the verbosity control is present");
      check(!html.includes("data-term-toggle"), "the terminal toggle stays out (no cookie jar in the WebView)");
      check(html.includes("data-sess-menu"), "the ⋯ menu (rename / kill) is present");
    });

    // ------------------------------------------------------------------ 9
    await step("Rich transcript blocks reach the phone, tail-free state and all", async () => {
      const rich = sim.phone.waitFor<{ sessionId: string; entries: { blocks?: unknown[] }[] }>("turma:rich-tail", undefined, 8000);
      hub.pushTail([
        {
          id: "r1",
          role: "assistant",
          text: "Ran the build",
          blocks: [
            { t: "text", text: "Ran the build" },
            { t: "tool_use", name: "Bash", detail: { desc: "bun run build" } },
          ],
        },
      ]);
      const got = await rich;
      check(got.sessionId === "sess-1", "the rich tail names its session");
      check((got.entries[0]?.blocks?.length ?? 0) === 2, "the rich blocks survive the bus intact");
      await sim.phone.waitFor<PhoneStatePayload>("turma:state", () => true, 8000);
      const live = payload?.agents.find((a) => a.key === "truenas")?.sessions.find((s) => s.id === "sess-1");
      check(
        (live?.session?.tail?.length ?? 0) === 0,
        "the heavy cached tail is stripped from the state payload (the phone has its own buffer)"
      );
      check(live?.session?.question === null, "but the live signals the phone renders survive");
    });

    // ------------------------------------------------------------------ 10
    await step("A pending question renders as answer chips on the phone", async () => {
      const live = hub.session("sess-1")!.session!;
      live.question = "Which base branch should I cut from?";
      live.questionOptions = ["origin/main", "origin/develop"];
      await sim.phone.waitFor<PhoneStatePayload>(
        "turma:state",
        (p) => !!p?.agents?.find((a) => a.key === "truenas")?.sessions?.find((s) => s.id === "sess-1")?.session?.question,
        8000
      );
      const html = sessionViewHtml(state(), "normal", false, "closed");
      const text = textOf(html);
      check(text.includes("Which base branch"), "the question is shown");
      check(html.includes('data-answer="0"') && html.includes('data-answer="1"'), "each option is answerable");
      await client.answerQuestion("truenas", "sess-1", { optionIndex: 0 });
      const call = hub.callsTo("/sessions/sess-1/answer").pop();
      check((call?.body as { optionIndex?: number })?.optionIndex === 0, "answering posts the chosen index");
      live.question = null;
      live.questionOptions = [];
    });

    // ------------------------------------------------------------------ 11
    await step("Typing a message reaches the session", async () => {
      await client.sendInput("truenas", "sess-1", "run the walkthrough again");
      const call = hub.callsTo("/sessions/sess-1/input").pop();
      check((call?.body as { text?: string })?.text === "run the walkthrough again", "the message posts to …/input");
      await client.interrupt("truenas", "sess-1");
      check(hub.callsTo("/sessions/sess-1/interrupt").length === 1, "Stop reaches …/interrupt");
      await client.setSummary("truenas", "sess-1", "Renamed from the phone");
      const rename = hub.callsTo("/sessions/sess-1/summary").pop();
      check((rename?.body as { summary?: string })?.summary === "Renamed from the phone", "Rename reaches …/summary");
    });

    // ------------------------------------------------------------------ 12
    await step("The Board tab renders the org's tickets in their columns", async () => {
      const html = boardBodyHtml(state());
      const text = textOf(html);
      if (showHtml) console.log(html);
      check(text.includes("XERK-233"), "a ticket card is rendered");
      check(text.includes("Turma Veiller fixes"), "with its summary");
      check(text.includes("XERK-234"), "and the other ticket too");
      check(html.includes("kanban-card"), "cards use the web board's own markup");
      check(text.includes("Turma"), "the triaged repo chip is shown");
      check(html.includes("data-new-ticket") || phoneHtml(state(), VIEW({ tab: "board" }), false).includes("data-new-ticket"), "a new ticket can be created");
    });

    // ------------------------------------------------------------------ 13
    await step("A ticket's detail, status change and start button reach the hub", async () => {
      const detail = await client.jiraDetail("xerktech.atlassian.net", "XERK-233");
      check(detail.status === 200, "the detail fetch resolves");
      check(String((detail.body as { description?: string }).description).includes("Walk the miniapp"), "it carries the description");
      await client.setTicketStatus("xerktech.atlassian.net", "XERK-233", { value: "31" });
      check(hub.callsTo("/XERK-233/status").length === 1, "a status pick posts to …/status");
      await client.setTicketStatus("xerktech.atlassian.net", "XERK-233", { category: "done" });
      check(
        (hub.callsTo("/XERK-233/status").pop()?.body as { category?: string })?.category === "done",
        "a drag posts the target column instead"
      );
      await client.startTicket("xerktech.atlassian.net", "XERK-234");
      check(hub.callsTo("/XERK-234/session").length === 1, "the start button posts to …/session");
      await client.setTicketRepo("xerktech.atlassian.net", "XERK-234", { repo: "Turma" });
      await client.setTicketAgent("xerktech.atlassian.net", "XERK-234", { host: "truenas" });
      await client.setTicketModel("xerktech.atlassian.net", "XERK-234", { model: "opus" });
      check(
        hub.callsTo("/XERK-234/repo").length === 1 &&
          hub.callsTo("/XERK-234/agent").length === 1 &&
          hub.callsTo("/XERK-234/model").length === 1,
        "the repo / agent / model pins each reach their own route"
      );
    });

    // ------------------------------------------------------------------ 14
    await step("Creating a ticket walks the meta cascade and reports the result", async () => {
      const meta = await client.createMeta("xerktech.atlassian.net");
      check(meta.status === 200, "create-meta resolves");
      check(Array.isArray((meta.body as { projects?: unknown[] }).projects), "it lists projects");
      const types = await client.createMeta("xerktech.atlassian.net", "XERK");
      check(Array.isArray((types.body as { types?: unknown[] }).types), "picking a project lists its types");
      const cmd = await client.createTicket("xerktech.atlassian.net", {
        project: "XERK",
        issueType: "10001",
        summary: "Walked by the simulator",
      });
      const result = await client.createResult("xerktech.atlassian.net", cmd.cmdId);
      check(result.status === 200, "the create result polls to a 200");
      check((result.body as { key?: string }).key === "XERK-999", "and names the new ticket");
    });

    // ------------------------------------------------------------------ 15
    await step("A failing hub is visible on the phone, not silently empty", async () => {
      hub.down = true;
      await sim.phone.waitFor<PhoneStatePayload>("turma:state", (p) => !!p?.pollError, 8000);
      check(!!payload?.pollError, "the poll error rides the state payload");
      const html = phoneHtml(state(), VIEW(), false);
      check(textOf(html).includes("reach the hub"), "the phone shows a persistent can't-reach-the-hub banner");
      hub.down = false;
      await sim.phone.waitFor<PhoneStatePayload>("turma:state", (p) => !p?.pollError, 8000);
      check(!payload?.pollError, "it clears when the hub comes back");
    });

    // ------------------------------------------------------------------ 16
    await step("Signing out stops the App and returns the login card", async () => {
      await sim.phone.request("turma:storage-set", { key: CONFIG_STORAGE_KEY, value: "" });
      const res = await sim.phone.request<{ phase: string }>("turma:config-changed", {});
      check(res.phase === "setup", "the background reports setup again");
      const snap = await sim.phone.request<{ phase: string; state: unknown }>("turma:get-state", {});
      check(snap.state === null, "and has no state to render");
      const chunk = await sim.phone.request<{ total: number }>("turma:state-chunk", { seq: 0 });
      check(chunk.total === 0, "the chunked pull reports nothing to pull");
      const before = hub.calls.length;
      await delay(1200);
      check(hub.calls.length === before, "no hub traffic continues after sign-out");
    });
  } finally {
    await sim.stop().catch(() => {});
    await hub.stop();
  }

  console.log("");
  if (findings.length) {
    console.log(`${findings.length} finding${findings.length === 1 ? "" : "s"}:`);
    for (const f of findings) console.log(`  • ${f}`);
  } else {
    console.log("No findings — the phone half behaved.");
  }
  process.exit(findings.length ? 1 : 0);
}

await main();
