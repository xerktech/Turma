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
  It reaches `render.ts`'s `wrapText`; the clamp keeps a hostile refusal's wrap cost bounded.
- **`splitLongWord` stays near-linear in an unbroken word** (XERK-2109): it gallops from each
  chunk's start. Measuring or slicing the whole REST per chunk is quadratic (200k chars took ~10s).
  Tests: `text-wrap.test.ts` "exactly as the old binary search did" / "200k-char unbroken word".
- The glasses client has **no board creds and no picker TUI**: pending `AskUserQuestion`s reach it
  only through the agent's `hooks/ask.py` req/ans bridge, and it renders the backward-compat flat
  `questionOptions` list rather than the rich cards the web chat uses.
- **Even phone companion (XERK-171):** the PHONE screen is a NATIVE Sessions + Board UI
  (`src/phone/`), not the hub's web pages. It renders from `App` state and drives it in-process (no
  iframe/postMessage) — a tap is `App.enterSession`, the org filter `App.setOrgFilter`. **ENTER
  syncs, LEAVE doesn't**: entering on one pulls the other in (`App.onEnterSession`); the org filter
  scopes the list too. Board is Phase 2.
- **The glasses DISPLAY names no machine (XERK-1913)**, operator's call. The home list uses the
  Sessions page's status sections (Ready for review / Active / Idle / Queued / Ended), never host
  headers; an offline host's sessions hide behind one "N hosts offline" count row.
  - **The home selection is an IDENTITY, not an index** (`home.selected`, `homeRowKey` = host +
    session id, or the action row's kind), resolved by `homeCursor` in render AND input. The
    groups regroup on a poll and on time alone (a host aging past offline with polls failing), so
    an index silently lands a tap on another session.
  - A selected session no longer at its host + id resolves by id on any host (a landed
    migration), then to the nearest session ABOVE the index, never onto "+ New session".
  - Session home keys are `s:` + JSON `[host, id]`, so the id parses back exactly (ids may hold ':').
  - New session is org → repo, and `spawnHostFor` picks the org's least-busy online host with that
    repo. The phone companion is out of that scope.
  - Tests: `render.test.ts` "home status groups"/"new session by org"/"new session pickers",
    `app.test.ts` "the home cursor follows/stays on/keeps to ..." cases.
- CI: `glasses-ci.yml`, path-filtered to `glasses/**`, runs typecheck + Vitest + a production build
  in a throwaway `node:24-alpine` container.
- **Keep `@evenrealities/even_hub_sdk` >= 0.0.14.** Older SDKs strip long-press eventTypes (9/10),
  so `input/router.ts` sees a bare `sysEvent` — protobuf-zero CLICK — and a long press fires taps.
  Tests: `input/sdk-events.test.ts` (fails on SDK 0.0.10), `router.test.ts` "ignores sysEvent LONG_PRESS".
- **`npm run pack` passes `--sdk-ver` = the INSTALLED SDK.** evenhub-cli >= 0.1.14 stamps the .ehpk's
  `min_app_version` from that SDK's npm `minAppVersion`; without the flag it uses the LATEST published
  SDK, so an unrelated SDK release silently raises our floor. Keep `app.json`'s values equal to it.
- **`vite.config.ts`'s serve-only `turma-vendored-cjs-dev` plugin is what lets `npm run dev` boot**
  (XERK-934). Vite's CJS interop runs only in `build`, and `optimizeDeps` covers only `node_modules`,
  so without it dev serves `src/vendor/*.cjs` raw and the simulator dies on `Importing binding name
  'default'`. Tests: `src/vendor/dev-server.test.ts`.
- **Hub text reaching the display goes through `fontSafe` (`src/font.ts`, XERK-928)** — transcript
  entries at ingest, the live TUI turn (`onLiveTurn`), question sheet, session names. Missing
  G2-font glyphs draw as blank gaps.
  - Session names are sanitised in `render.ts`, NEVER in `sessionName`: the phone shares it and
    pre-fills Rename from it, so a degraded name would be written back to the hub.
  - Known markers map to drawable ones (check -> √, cross -> x); any other codepoint pretext's
    `getAdvW` reports as 0 is dropped. That table is lazy (~670 KB), installed in `main.ts`
    via `setGlyphCoverage` BEFORE boot — ingest before it would cache unchecked text.
  - Transcript ingest runs the markdown/tool-marker trims on the RAW text, fontStrip AFTER: a
    dropped glyph run first turned "the plan 🧠 [WIP]" into a stripped tool marker.
  - Map keys are codepoint numbers: `glyphs.test.ts` (XERK-923) scans string literals, escapes too.
  - Tests: `font.test.ts`.
- **Every non-ASCII char in a glasses source literal must exist in the firmware font** (XERK-923).
  A missing codepoint draws blank — ✓ U+2713 and ✗ U+2717 are absent, so markers are `√` and `x`.
  Check a glyph with `@evenrealities/pretext`'s `getAdvW(cp)` (0 = missing; it matches the
  simulator's font). Exempt: phone/, vendor/, phone-login.ts (browser fonts). Hub text is not a
  literal — it goes through `fontSafe` (bullet above). Tests: `glyphs.test.ts` "has a glyph for every
  non-ASCII character".
- **A resolved `waitForEvenAppBridge()` does NOT mean a host is there** — it resolves in any browser.
  `bridge.ts`'s `resolveBridge` also requires `window.flutter_inappwebview.callHandler` (the device
  WebView or the simulator's shim), else it falls back to the DOM backend at `BRIDGE_TIMEOUT_MS`.
  Tests: `src/bridge.test.ts`.
- **An answered question leaves the screen at once, masked locally** (`maskAnswered`, `App.answerQuestion`
  — every answer path, phone included). The wire carries NO question id, so the mask matches text +
  options and lasts only `ANSWER_MASK_MS` (10s) once the POST lands: lengthening it hides an identical
  re-ask. Pending converges on the hub's UNMASKED word. Tests: the `sheet mode:` answer cases in `app.test.ts`.
- **Leaving a session keeps its unsent draft** (`App.drafts`, XERK-1858); entering it again restores it.
  - Never restored while a question is pending there: a draft hides the sheet, and Send would post
    it as an answer to a question the wearer never saw. The poll restores it once the question clears.
  - A question ARRIVING on the open session (or replacing its pending one) stashes the box's
    ordinary draft the same way (XERK-2095, `holdDraftFrom`): typed before the question, never its answer.
  - A "Dictate answer…" draft carries `answerFor` (its question): it stays when that same question
    re-arrives, and is DROPPED for any other — held, it would come back as an ordinary prompt.
  - `answerFor` clears on the first poll LISTING the session with no question (an empty poll is no
    proof), so an abandoned "Dictate answer…" never tags a later ordinary draft.
  - The local answer mask is NOT "no question" for `answerFor`: the hub may re-ask after it expires,
    and the box answer must still be that answer, not a held-back prompt.
  - An answer whose question cleared stays in the box as `staleAnswer`: the box status says
    `STALE_ANSWER_STATUS` and the menu row reads "Send as prompt" (`draftSendsAsPrompt`), since
    Send then posts it as an ordinary prompt. Never let it read as a plain "Send".
  - A stash keeps an answer apart (`DraftEntry.answer` + its question): it comes back only while
    THAT question is pending, is dropped for another, waits out the mask, and once the question is
    gone returns with the ordinary part, marked `staleAnswer`.
  - The first sheet tap within `QUESTION_TAP_GUARD_MS` (1s) of a question arriving on the open
    session is swallowed (`armQuestionTapGuard`): a tap already under way (meant for the box, its
    menu's Send, the transcript) would answer with the option just highlighted. A scroll disarms it.
  - Tests: `app.test.ts` "kept drafts" cases naming an arriving/replacing/re-listed question.
  - Keyed by host + id, and never followed by a bare id to another host: ids are unique per host
    only. A draft moves ONLY by the moved record's `migratedFrom` {host, sessionId}
    (`followMigratedDrafts`, XERK-2109, `session-migration.md`); a null source id moves nothing.
  - A stash MOVES the draft out of `state.session` (home keeps a stale one) and joins any held one,
    so a second stash of the same left session neither replaces nor doubles it.
  - `takeDraft`/`stashDraft` rewrite `state.drafts`: call them BEFORE spreading `this.state`, or
    the stale stash survives and a sent draft returns on every poll.
  - Bounded by COUNT only (`MAX_DRAFTS`, least recently stashed out, never the session being
    entered). A poll not listing a session (hub restart, migration gap, short beat) is no proof
    it's gone, so absence never deletes or releases a draft.
  - Tests: `app.test.ts` "kept drafts (XERK-1858)".
