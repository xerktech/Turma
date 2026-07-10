// Streaming "typewriter" reveal for the session screen's newest transcript
// entry. PURE — no I/O, no Date.now; the App feeds it elapsed time.
//
// The live tail (live.ts) and the 6s poll both deliver a transcript entry's
// FULL current text each update. Showing that whole text the instant it
// arrives makes a still-streaming assistant turn land as a block jump every
// frame. Instead we hold a `shown` character count for the NEWEST entry and
// advance it toward the full length over time, so text that grows a little at
// a time reads as it does in the console — typing in.
//
// The catch the brief calls out: don't slow a real block down with a fake
// stream. When the gap between what's shown and the full text is larger than
// REVEAL_SNAP_CHARS (a big chunk landed at once — a user message, a pasted
// blob, a whole message the transcript only recorded on completion), we snap
// straight to the end instead of typewriting it for seconds. Small deltas
// (real streaming) type; large ones appear immediately.
//
// Only the newest entry is ever partially revealed; everything above it is
// already complete and always rendered in full.

export interface RevealState {
  // uuid of the entry `shown` counts characters into — the newest transcript
  // entry for the focused session. null when there's nothing to reveal.
  entryId: string | null;
  shown: number;
}

// Chars/second the typewriter advances at. Fast enough that a normal
// streaming second (tens of chars) drains smoothly rather than lagging behind
// the source, slow enough to still read as typing.
export const REVEAL_RATE_CPS = 150;
// Backlog past which we stop typing and snap to the end: a chunk this large
// arrived as a block, so mirror that instead of animating it.
export const REVEAL_SNAP_CHARS = 200;

export function emptyReveal(): RevealState {
  return { entryId: null, shown: 0 };
}

// A reveal that shows `len` chars of `entryId` outright — used when entering a
// session so the existing transcript renders in full (it's history, not a
// live stream) and only subsequent growth types in.
export function fullReveal(entryId: string | null, len: number): RevealState {
  return { entryId, shown: entryId === null ? 0 : Math.max(0, len) };
}

export interface RevealOpts {
  rateCps?: number;
  snapChars?: number;
}

// Advance the reveal toward the newest entry (`newestId`, `targetLen` chars)
// given `dtMs` elapsed since the last advance. dtMs = 0 is the "text just
// changed" call: it re-anchors to the newest entry and snaps blocks without
// typing anything yet.
export function advanceReveal(
  prev: RevealState,
  newestId: string | null,
  targetLen: number,
  dtMs: number,
  opts: RevealOpts = {}
): RevealState {
  if (newestId === null || targetLen <= 0) {
    return { entryId: newestId, shown: 0 };
  }
  const rate = opts.rateCps ?? REVEAL_RATE_CPS;
  const snap = opts.snapChars ?? REVEAL_SNAP_CHARS;

  // A new entry starts hidden (typed from 0); the same entry keeps whatever
  // was already shown. Either way, clamp to the current length in case the
  // tail re-truncated shorter than before.
  const base = prev.entryId === newestId ? Math.min(prev.shown, targetLen) : 0;
  const backlog = targetLen - base;
  if (backlog <= 0) return { entryId: newestId, shown: targetLen };
  if (backlog > snap) return { entryId: newestId, shown: targetLen };

  const step = Math.floor((rate * Math.max(0, dtMs)) / 1000);
  return { entryId: newestId, shown: Math.min(targetLen, base + step) };
}

// Nothing left to type for the newest entry — the animation loop can stop.
export function revealComplete(state: RevealState, targetLen: number): boolean {
  return state.entryId === null || targetLen <= 0 || state.shown >= targetLen;
}
