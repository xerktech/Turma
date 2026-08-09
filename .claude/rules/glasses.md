---
paths:
  - "glasses/**"
---

# `glasses/` — Even Realities G2 smart-glasses client

- Vite + TypeScript, Vitest; an Even Hub plugin. An open session screen tails the hub's `/live`
  WebSocket (`live.ts`) with a **streaming typewriter reveal** (`reveal.ts`), else the 6s poll. See
  `glasses/README.md` for dev/packaging/QA.
- `src/` is the reference implementation the Android `core/` reducers are ported from
  (`live.ts`/`transcript.ts`/`reveal.ts` → `Reveal`/`Transcript`/`ChatItems`), and `chat.js`'s
  typewriter reveal is ported from it too. A change to the reveal or transcript-merge semantics here
  is a change to those.
- **`src/sessions.ts` is one of the FIVE `readyForReview` mirrors** that must agree — see
  `CLAUDE.md`'s cross-cutting contracts. Veiller carries a FORK of this file; it counts as a mirror.
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
