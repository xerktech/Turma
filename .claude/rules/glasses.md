---
paths:
  - "glasses/**"
---

# `glasses/` — Even Realities G2 smart-glasses client

- Vite + TypeScript, Vitest; an Even Hub plugin. An open session screen tails the hub's `/live`
  WebSocket (`live.ts`), else the 6s poll. See `glasses/README.md` for dev/packaging/QA.
- Text lands on the display **whole, the frame it arrives** — the typewriter reveal this client
  invented was deleted in XERK-251, here and in every client that ported it. Don't bring one back.
- `src/` is the reference implementation the Android `core/` reducers are ported from
  (`live.ts`/`transcript.ts` → `Transcript`/`ChatItems`). A change to the transcript-merge semantics
  here is a change to those.
- **`src/sessions.ts` is one of the FOUR `readyForReview` mirrors** that must agree — see
  `CLAUDE.md`'s cross-cutting contracts.
- **Every body read in `hub-client.ts` goes through `readJson`, never a bare `res.json()`** —
  `timeoutFetch` bounds the RESPONSE only, so an unwrapped read is an unbounded await on a live
  socket; since `App.poll()` re-arms only in its `finally`, a hub that sends headers then stalls
  freezes the display on stale content forever. A bare `res.json()` on a new endpoint reopens it.
- **The hub's refusal text is clamped in `refusalText`, at the point it becomes ours** (300 chars).
  It reaches `render.ts`'s `wrapText`, which is quadratic in an unbroken word — 200k chars measured
  at 4s — so an unclamped refusal stalls the render loop rather than the socket.
- The glasses client has **no board creds and no picker TUI**: pending `AskUserQuestion`s reach it
  only through the agent's `hooks/ask.py` req/ans bridge, and it renders the backward-compat flat
  `questionOptions` list rather than the rich cards the web chat uses.
- **Even phone companion (XERK-171):** the PHONE screen is a NATIVE Sessions + Board UI
  (`src/phone/`), not the hub's web pages. It renders from `App` state and drives it in-process (no
  iframe/postMessage) — a tap is `App.enterSession`, the org filter `App.setOrgFilter`. **ENTER
  syncs, LEAVE doesn't**: entering on one pulls the other in (`App.onEnterSession`); the org filter
  scopes the list too. Board is Phase 2.
- CI: `glasses-ci.yml`, path-filtered to `glasses/**`, runs typecheck + Vitest + a production build
  in a throwaway `node:24-alpine` container.
