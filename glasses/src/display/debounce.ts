// Pure helpers for `EvenHubDisplay.render()` — no SDK, no bridge, fully
// unit-testable. Two independent concerns:
//
//  1. `createTrailingDebounce` paces rapid `render()` calls to the BLE
//     return path's ~120ms budget (glasses-ui skill: "Debounce to ~120ms and
//     write only the tail of the buffer"). It's a leading+trailing debounce:
//     an isolated call after a quiet period (>= waitMs since the last actual
//     invocation) fires immediately: rapid calls that follow just before the
//     wait elapses reset a trailing timer, coalescing to a single call with
//     the LAST value once the burst goes quiet.
//  2. `capContent` hard-caps a string to `textContainerUpgrade`'s payload
//     limit, truncating from the top (dropping the oldest/least-relevant
//     content) so the newest, bottom-anchored content always survives.

export function createTrailingDebounce<T>(fn: (value: T) => void, waitMs: number): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastInvokeAt = -Infinity;
  let pending: T | undefined;

  const invoke = (value: T): void => {
    lastInvokeAt = Date.now();
    timer = null;
    fn(value);
  };

  return (value: T): void => {
    pending = value;
    const sinceLastInvoke = Date.now() - lastInvokeAt;
    if (timer === null && sinceLastInvoke >= waitMs) {
      // Leading edge: nothing in flight and the pacing window has elapsed —
      // fire immediately rather than making an isolated call wait a full
      // cycle for no reason.
      invoke(value);
      pending = undefined;
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      const v = pending as T;
      pending = undefined;
      invoke(v);
    }, waitMs);
  };
}

export function capContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // Truncate from the top — keep the newest/bottom-anchored tail.
  return content.slice(content.length - maxChars);
}
