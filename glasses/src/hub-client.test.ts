import { describe, expect, it, vi } from "vitest";
import { HubClient, BODY_TIMEOUT_MS, REFUSAL_BODY_TIMEOUT_MS } from "./hub-client.ts";
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

describe("HubClient request timeout (XERK-235)", () => {
  // fetch has no timeout of its own, and App.poll() re-arms only in its
  // `finally`. A hub that accepts the connection and never answers therefore
  // left the promise unsettled and killed the poll loop PERMANENTLY — the
  // glasses froze on stale content with no "hub unreachable" flash, where
  // every other failure mode recovers within one poll. Veiller already fixed
  // this for its background context (XERK-215); this is the lens's guard.
  it("rejects a never-settling request instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const hang = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const client = new HubClient({ config, fetchFn: hang, timeoutMs: 1000 });

      const pending = client.listAgents();
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire once a response has already arrived", async () => {
    vi.useFakeTimers();
    try {
      const payload = { now: 1, agents: [] };
      const client = new HubClient({ config, fetchFn: fakeFetch(payload), timeoutMs: 1000 });
      await expect(client.listAgents()).resolves.toEqual(payload);
      await vi.advanceTimersByTimeAsync(5000); // the timer must be cleared
    } finally {
      vi.useRealTimers();
    }
  });
});

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

  // XERK-270: the hub explains every refusal it makes, and this client used to
  // throw all of them away as "hub request failed: <status> <path>" — on a
  // display this small the message IS the whole feedback.
  it("puts the hub's own {error} text on the thrown HttpError", async () => {
    const fetchFn = fakeFetch({ error: "too many queued commands for that host" }, 429);
    const client = new HubClient({ config, fetchFn });

    await expect(client.sendInput("h1", "s1", "hello")).rejects.toMatchObject({
      status: 429,
      message: "too many queued commands for that host",
    });
  });

  it("falls back to the status when the hub sent no {error}, worded like the other clients", async () => {
    const client = new HubClient({ config, fetchFn: fakeFetch({}, 503) });

    await expect(client.listAgents()).rejects.toMatchObject({
      status: 503,
      message: "the hub answered HTTP 503",
    });
  });

  it("falls back to the status when the body is unreadable rather than failing on it", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
    })) as unknown as typeof fetch;
    const client = new HubClient({ config, fetchFn });

    await expect(client.sessionAction("h1", "s1", "kill")).rejects.toMatchObject({
      status: 502,
      message: "the hub answered HTTP 502",
    });
  });

  // The request timeout bounds the RESPONSE, not the body after it. Reading the
  // refusal body is a second await on the same socket, so a hub that sends
  // headers and then stalls would hang the throw itself — and App.poll() re-arms
  // only in its `finally`, so that one stall freezes the display for good.
  it("gives up on a refusal body that never arrives instead of hanging the throw", async () => {
    vi.useFakeTimers();
    try {
      const stalled = vi.fn(async () => ({
        ok: false,
        status: 503,
        json: () => new Promise(() => {}), // headers arrived; the body never does
      })) as unknown as typeof fetch;
      const client = new HubClient({ config, fetchFn: stalled, timeoutMs: 0 });

      const pending = client.sessionAction("h1", "s1", "kill");
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(REFUSAL_BODY_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).rejects.toMatchObject({
        status: 503,
        message: "the hub answered HTTP 503",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // The SUCCESS body stalls the same way and is the likelier route — listAgents
  // runs every poll. Bounding only the refusal read left the freeze intact one
  // route over, which is the whole point of the guard.
  it("gives up on a 200 whose body never arrives, not just a refusal's", async () => {
    vi.useFakeTimers();
    try {
      const stalled = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      })) as unknown as typeof fetch;
      const client = new HubClient({ config, fetchFn: stalled, timeoutMs: 0 });

      const pending = client.listAgents();
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(BODY_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  // The hub's text reaches render.ts's wrapText, which is quadratic in an
  // unbroken word — a megabyte refusal would stall the render loop for seconds.
  it("clamps a huge refusal so it can't stall the renderer", async () => {
    const client = new HubClient({ config, fetchFn: fakeFetch({ error: "x".repeat(200_000) }, 413) });

    await expect(client.listAgents()).rejects.toMatchObject({
      status: 413,
      message: `${"x".repeat(300)}…`,
    });
  });

  it("leaves a refusal that already fits completely alone", async () => {
    const said = "the target agent is in a different org";
    const client = new HubClient({ config, fetchFn: fakeFetch({ error: said }, 409) });

    await expect(client.listAgents()).rejects.toMatchObject({ status: 409, message: said });
  });

  // A body that can't be read on a SUCCESS must throw, not resolve empty. The
  // swallowed `{}` here rendered as a ticket created with no key — a false
  // success on a write whose real fate is unknown.
  it("throws rather than reporting an empty success when a 200 body is unreadable", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
    })) as unknown as typeof fetch;
    const client = new HubClient({ config, fetchFn });

    await expect(client.createResult("SITE", "cmd1")).rejects.toThrow();
  });

  // The refusal deadline has to reach the create endpoints too — they build
  // their own HttpError rather than going through request(), and a refused
  // create that hung for the full success budget is the phone form freezing.
  it("holds a refused create to the refusal deadline, not the success one", async () => {
    vi.useFakeTimers();
    try {
      const stalled = vi.fn(async () => ({
        ok: false,
        status: 403,
        json: () => new Promise(() => {}),
      })) as unknown as typeof fetch;
      const client = new HubClient({ config, fetchFn: stalled, timeoutMs: 0 });

      const pending = client.createMeta("SITE");
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(REFUSAL_BODY_TIMEOUT_MS + 1);
      await expect(pending).rejects.toMatchObject({
        status: 403,
        message: "the hub answered HTTP 403",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // A polyfilled Response may not have `json` as a function at all, so the call
  // itself sits inside readJson's promise chain. Covered here rather than only
  // through refusal(), whose own try/catch would mask a regression.
  it("turns a synchronously-throwing json() into a rejection, not a raised throw", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => { throw new TypeError("json is not a function"); },
    })) as unknown as typeof fetch;
    const client = new HubClient({ config, fetchFn });

    await expect(client.listAgents()).rejects.toThrow(/json is not a function/);
  });

  it("clamps without splitting an emoji that straddles the boundary", async () => {
    const said = `${"b".repeat(299)}😀tail`;
    const client = new HubClient({ config, fetchFn: fakeFetch({ error: said }, 409) });

    let message = "";
    await client.listAgents().catch((e: unknown) => { message = (e as Error).message; });

    expect(message).toBe(`${"b".repeat(299)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(message)).toBe(false);
  });

  // The other side of the boundary: a pair sitting entirely INSIDE the clamp
  // must survive intact. Widening the surrogate check to 0xdfff would back the
  // cut off here too and split this one the other way — an escape the straddle
  // case alone does not catch.
  it("keeps an emoji that ends exactly on the boundary rather than splitting it", async () => {
    const said = `${"b".repeat(298)}\u{1F600}tail`;
    const client = new HubClient({ config, fetchFn: fakeFetch({ error: said }, 409) });

    let message = "";
    await client.listAgents().catch((e: unknown) => { message = (e as Error).message; });

    expect(message).toBe(`${"b".repeat(298)}\u{1F600}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(message)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(message)).toBe(false);
  });

  it("reads the hub's words on getHistory and jiraDetail too, not just request()", async () => {
    const refused = { error: "that agent is in a different org" };
    const history = new HubClient({ config, fetchFn: fakeFetch(refused, 409) });
    await expect(history.getHistory("h1", "s1")).rejects.toMatchObject({
      status: 409,
      message: "that agent is in a different org",
    });

    const jira = new HubClient({ config, fetchFn: fakeFetch(refused, 409) });
    await expect(jira.jiraDetail("site", "XERK-1")).rejects.toMatchObject({
      status: 409,
      message: "that agent is in a different org",
    });
  });

  it("createMeta/createResult share that wording and still pass a 202 through", async () => {
    const meta = new HubClient({ config, fetchFn: fakeFetch({}, 500) });
    await expect(meta.createMeta("site")).rejects.toMatchObject({
      status: 500,
      message: "the hub answered HTTP 500",
    });

    const result = new HubClient({ config, fetchFn: fakeFetch({ error: "no such command" }, 404) });
    await expect(result.createResult("site", "cmd1")).rejects.toMatchObject({
      status: 404,
      message: "no such command",
    });

    const pending = new HubClient({ config, fetchFn: fakeFetch({ pending: true }, 202) });
    await expect(pending.createMeta("site")).resolves.toEqual({ status: 202, body: { pending: true } });
  });

  it("defaults fetchFn to globalThis.fetch when not injected", () => {
    const client = new HubClient({ config });
    expect(client).toBeInstanceOf(HubClient);
  });
});
