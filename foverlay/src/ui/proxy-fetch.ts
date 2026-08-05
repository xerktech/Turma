// A `fetch`-shaped function that rides the background's turma:fetch RPC.
//
// The miniapp WebView runs from file://, where a cross-origin fetch to the
// hub is CORS-fragile; the background JSContext's fetch has no CORS. The
// UI's HubClient keeps its upstream `fetchFn` injection seam and receives
// this instead — a Response-like object satisfying exactly what HubClient
// and phone-login use (`ok`, `status`, `json()`, `text()`).
//
// WebSockets are deliberately NOT proxied: the phone needs no socket of its
// own — the rich live tail arrives from the background on turma:rich-tail.

import "../shared/channels.ts";

export function createProxyFetch(): typeof fetch {
  const proxyFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string })?.url ?? input);
    const res = await mentra.request("turma:fetch", {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string> | undefined) ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const responseLike = {
      ok: res.ok,
      status: res.status,
      text: async () => res.bodyText,
      json: async () => JSON.parse(res.bodyText) as unknown,
    };
    return responseLike as unknown as Response;
  };
  return proxyFetch as unknown as typeof fetch;
}
