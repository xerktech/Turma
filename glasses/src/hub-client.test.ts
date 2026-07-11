import { describe, expect, it, vi } from "vitest";
import { HubClient } from "./hub-client.ts";
import type { Config } from "./config.ts";

const config: Config = { hubUrl: "https://hub.example.com", user: "u", password: "p", pollMs: 6000 };
const authHeaderValue = "Basic " + btoa("u:p");

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("HubClient", () => {
  it("listAgents GETs /api/agents with the Basic auth header", async () => {
    const payload = { now: 123, agents: [] };
    const fetchFn = fakeFetch(payload);
    const client = new HubClient({ config, fetchFn });

    const result = await client.listAgents();

    expect(result).toEqual(payload);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(authHeaderValue);
  });

  it("spawnSession POSTs to /api/agents/<host>/sessions with the body", async () => {
    const fetchFn = fakeFetch({ ok: true, cmdId: "abc" });
    const client = new HubClient({ config, fetchFn });

    const result = await client.spawnSession("host1", { repo: "myrepo", label: "test" });

    expect(result).toEqual({ ok: true, cmdId: "abc" });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents/host1/sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ repo: "myrepo", label: "test" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sessionAction POSTs to .../sessions/<id>/<action>", async () => {
    const fetchFn = fakeFetch({ ok: true, cmdId: "x" });
    const client = new HubClient({ config, fetchFn });

    await client.sessionAction("host1", "sess1", "kill");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents/host1/sessions/sess1/kill");
    expect(init.method).toBe("POST");
  });

  it("sessionAction supports resume, targeting a closed session id", async () => {
    const fetchFn = fakeFetch({ ok: true, cmdId: "x" });
    const client = new HubClient({ config, fetchFn });

    await client.sessionAction("host1", "closed-sess-1", "resume");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents/host1/sessions/closed-sess-1/resume");
  });

  it("deleteSession DELETEs .../sessions/<id>", async () => {
    const fetchFn = fakeFetch({ ok: true });
    const client = new HubClient({ config, fetchFn });

    await client.deleteSession("host1", "sess1");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents/host1/sessions/sess1");
    expect(init.method).toBe("DELETE");
  });

  it("sendInput POSTs {text} to .../sessions/<id>/input", async () => {
    const fetchFn = fakeFetch({ ok: true, cmdId: "y" });
    const client = new HubClient({ config, fetchFn });

    await client.sendInput("host1", "sess1", "hello");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents/host1/sessions/sess1/input");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
  });

  it("answerQuestion POSTs {optionIndex} to .../sessions/<id>/answer", async () => {
    const fetchFn = fakeFetch({ ok: true, cmdId: "y" });
    const client = new HubClient({ config, fetchFn });

    await client.answerQuestion("host1", "sess1", { optionIndex: 2 });

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/agents/host1/sessions/sess1/answer");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ optionIndex: 2 });
  });

  it("answerQuestion carries {custom} and defaults a missing optionIndex to -1", async () => {
    const fetchFn = fakeFetch({ ok: true, cmdId: "y" });
    const client = new HubClient({ config, fetchFn });

    await client.answerQuestion("host1", "sess1", { custom: "other thing" });

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ optionIndex: -1, custom: "other thing" });
  });

  it("getHistory returns {status:200, body} on a resolved history", async () => {
    const payload = { entries: [], truncated: false, fetchedAt: 111 };
    const fetchFn = fakeFetch(payload, 200);
    const client = new HubClient({ config, fetchFn });

    const result = await client.getHistory("host1", "sess1");

    expect(result).toEqual({ status: 200, body: payload });
  });

  it("getHistory returns {status:202, body} without throwing when pending", async () => {
    const payload = { pending: true, cmdId: "abc" };
    const fetchFn = fakeFetch(payload, 202);
    const client = new HubClient({ config, fetchFn });

    const result = await client.getHistory("host1", "sess1");

    expect(result).toEqual({ status: 202, body: payload });
  });

  it("wsToken GETs /api/ws-token", async () => {
    const payload = { token: "ws.123.abc", expiresInSec: 300 };
    const fetchFn = fakeFetch(payload);
    const client = new HubClient({ config, fetchFn });

    const result = await client.wsToken();

    expect(result).toEqual(payload);
    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/ws-token");
  });

  it("throws an Error carrying the status on a non-2xx response other than history's 202", async () => {
    const fetchFn = fakeFetch({ error: "unauthorized" }, 401);
    const client = new HubClient({ config, fetchFn });

    await expect(client.listAgents()).rejects.toMatchObject({ status: 401 });
  });

  it("throws on a 404 from a mutation endpoint", async () => {
    const fetchFn = fakeFetch({ error: "unknown agent" }, 404);
    const client = new HubClient({ config, fetchFn });

    await expect(client.sessionAction("badhost", "s1", "kill")).rejects.toThrow();
  });

  it("defaults fetchFn to globalThis.fetch when not injected", () => {
    const client = new HubClient({ config });
    expect(client).toBeInstanceOf(HubClient);
  });
});
