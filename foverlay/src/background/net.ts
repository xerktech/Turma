// Timeout wrapper for the background JSContext's fetch (XERK-215).
//
// The polyfill's fetch rides a native round-trip with NO timeout of its own:
// if the reply is ever lost (a dropped dispatch, a watchdog-killed evaluate,
// transient memory pressure), the promise never settles. App.poll() awaits
// that promise, so one lost reply used to kill the poll loop PERMANENTLY and
// silently — the phone just showed an empty fleet forever. Racing a timer
// turns a lost reply into an ordinary poll error: the App flashes
// hub-unreachable, the loop's finally re-arms, and the next poll retries.

export const HUB_FETCH_TIMEOUT_MS = 30_000;

export function timeoutFetch(base: typeof fetch, timeoutMs: number = HUB_FETCH_TIMEOUT_MS): typeof fetch {
  const wrapped = (input: unknown, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.error(`[turma] hub fetch timed out after ${timeoutMs}ms:`, String(input));
        reject(new Error(`hub fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      base(input as never, init).then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          // Loud on purpose: this is the one place every background hub
          // request funnels through, and the console tap forwards it to the
          // host's dev logs — the only debug channel a device has.
          console.error("[turma] hub fetch failed:", err instanceof Error ? err.message : String(err));
          reject(err);
        }
      );
    });
  return wrapped as unknown as typeof fetch;
}
