// timeoutFetch (XERK-215): a lost native fetch reply must become a rejection
// the App's poll catch can absorb — never a promise that hangs the poll loop
// forever.
import { describe, expect, it } from "bun:test";
import { timeoutFetch } from "./net.ts";

describe("timeoutFetch", () => {
  it("passes a resolving fetch through untouched", async () => {
    const base = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await timeoutFetch(base, 1000)("https://hub.example/api/agents");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects when the underlying fetch never settles", async () => {
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    await expect(timeoutFetch(hang, 50)("https://hub.example/api/agents")).rejects.toThrow(/timed out after 50ms/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("propagates a rejection from the underlying fetch", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(timeoutFetch(failing, 1000)("https://hub.example/api/agents")).rejects.toThrow("Failed to fetch");
  });
});
