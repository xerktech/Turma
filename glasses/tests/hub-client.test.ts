import { describe, it, expect, vi, afterEach } from "vitest";
import { HubClient, HubError } from "../src/hub-client.js";
import type { HubConfig } from "../src/config.js";

const cfg: HubConfig = {
  url: "https://hub.test",
  user: "u",
  password: "p",
  pollMs: 8000,
};

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("HubClient", () => {
  it("sends Basic auth and parses the agents list", async () => {
    const spy = stubFetch(200, { now: 1, agents: [] });
    const res = await new HubClient(cfg).listAgents();
    expect(res.agents).toEqual([]);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://hub.test/api/agents");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${btoa("u:p")}`,
    });
  });

  it("posts voice input to the right session endpoint with a JSON body", async () => {
    const spy = stubFetch(200, { ok: true, cmdId: "c1" });
    const out = await new HubClient(cfg).sendInput("nas agent", "ab/12", "use option A");
    expect(out).toMatchObject({ cmdId: "c1" });
    const [url, init] = spy.mock.calls[0];
    // Host and id are URL-encoded.
    expect(url).toBe("https://hub.test/api/agents/nas%20agent/sessions/ab%2F12/input");
    expect(init as RequestInit).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "use option A" });
  });

  it("builds session-action and spawn URLs", async () => {
    const spy = stubFetch(200, { ok: true, cmdId: "x" });
    const client = new HubClient(cfg);
    await client.sessionAction("h", "s", "restart");
    await client.spawn("h", "AgentHub", { model: "opus" });
    expect(spy.mock.calls[0][0]).toBe("https://hub.test/api/agents/h/sessions/s/restart");
    expect(spy.mock.calls[1][0]).toBe("https://hub.test/api/agents/h/sessions");
    expect(JSON.parse((spy.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      repo: "AgentHub",
      model: "opus",
    });
  });

  it("throws HubError with the server's message on failure", async () => {
    stubFetch(400, { error: "text required" });
    await expect(new HubClient(cfg).sendInput("h", "s", "")).rejects.toMatchObject({
      name: "HubError",
      status: 400,
      message: "text required",
    } satisfies Partial<HubError>);
  });
});
