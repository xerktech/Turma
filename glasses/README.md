# AgentHub · G2 glasses app

An [Even Realities G2](https://www.evenrealities.com/) companion app for the
AgentHub **sessions** dashboard. It lets you monitor, switch between, and
**voice-drive** the fleet's Claude Code sessions from the glasses — read what a
session last said, answer the question it's blocked on by speaking, and spawn or
control sessions — without a laptop.

It talks to the existing hub REST API (`agents.xerktech.com`); the only backend
additions it needs already ship in this repo (see **Backend** below).

## Why it looks the way it does (G2 constraints)

The G2 is a glanceable monocular HUD, not a screen. The design is shaped by hard
limits:

| Limit | Value | Design consequence |
| --- | --- | --- |
| Display | 576×288 px micro-LED | ~6 lines of text; everything is windowed to `GRID` in `constants.ts`. |
| Colour | 4-bit, 16 levels of green (monochrome) | Status is glyphs/words (`* ? - o !`), never colour. |
| Images | ≤200×100, max 4/page, slow | Not used — the UI is pure text. |
| Input | `CLICK` / `DOUBLE_CLICK` / `SCROLL_TOP` / `SCROLL_BOTTOM` (temple taps + R1 ring) | Everything reduces to up / down / select / back. |
| Text entry | none | Input is **speech-to-text only** (`dictation.ts`). |

**Not attempted:** the dashboard's live ttyd/tmux terminal — an ANSI TUI is
unreadable on this display. Instead the app reads a clean, plain-text transcript
tail the agent now publishes, and sends input by voice.

## Interaction model

```
up / down  → move selection or page through text
select     → drill in / activate  (single tap)
back       → up a level / cancel   (double tap)
```

Screens:

```
Home (all sessions, waiting-on-you first)
 ├─ select session → Session (status, pending question, transcript tail; up/down pages)
 │    └─ select → Actions ─┬─ Reply (voice) → speak → tap to send
 │                         ├─ Restart / Kill / Start
 │                         └─ Delete → confirm
 └─ "+ New session" → Host → Repo → spawns
```

Answering a blocked session is the headline flow: Home shows `? N ask`, the
session's `?` question is rendered at the top, **Reply (voice)** dictates your
answer, and one tap sends it into that session's Claude prompt.

## Architecture

All logic is hardware-agnostic and unit-tested; only two thin backends touch the
outside world, so they're the only things to verify on real hardware.

```
main.ts        bootstrap: pick backend, wire everything, run
app.ts         state machine — events → navigation + hub calls, polling
render.ts      pure: AppState → text (fully tested)
sessions.ts    flatten / live-state / ordering (pure)
hub-client.ts  typed AgentHub REST client
dictation.ts   speech-to-text (Web Speech API backend)
display/
  index.ts     GlassesDisplay interface (render text + emit up/down/select/back)
  dom.ts       browser/simulator backend — simulated 576×288 HUD + keyboard
  evenhub.ts   ⚠ Even Hub SDK backend — VERIFY against the real SDK (see below)
```

## Run it

```bash
npm install
npm run dev        # browser: simulated HUD, keyboard = glasses input
npm test           # vitest (pure logic)
npm run typecheck
npm run build      # tsc --noEmit && vite build
```

In the browser it prompts once for the hub URL + Basic-auth credentials
(remembered in `localStorage`); or bake them in with `VITE_HUB_URL` /
`VITE_HUB_USER` / `VITE_HUB_PASSWORD`.

## On-device: finishing the SDK glue

`src/display/evenhub.ts` is written against the **documented** Even Hub SDK
(`createStartUpPageContainer` / `rebuildPageContainer` / `onEvenHubEvent`, the
`CLICK_EVENT` / `DOUBLE_CLICK_EVENT` / `SCROLL_TOP_EVENT` / `SCROLL_BOTTOM_EVENT`
/ `FOREGROUND_*` events). Confirm the import path, method signatures, and event
enum before shipping, and tune `GRID` (rows/cols) to the real font:

- Scaffold/verify with the [everything-evenhub](https://github.com/even-realities/everything-evenhub)
  skills: `/quickstart`, `/template` (ASR starter for voice), `/sdk-reference`,
  `/glasses-ui`, `/handle-input`, `/font-measurement`, `/test-with-simulator`.
- The device audio path may prefer the SDK's `g2-microphone` capture (PCM 16 kHz
  mono) feeding your ASR of choice instead of the browser Web Speech API — swap
  the `Dictation` implementation in `main.ts`; nothing else changes.

## Backend it depends on

Two small additions to this repo (already implemented and tested):

- **agent** (`agent/hub-agent.py`): each running session's heartbeat now carries
  a readable `session.tail` (last few conversation turns, ANSI-stripped and
  truncated), and an `input` command types dictated text into the session's tmux
  (`send-keys`). Tunables: `SESSION_TAIL_MSGS`, `SESSION_TAIL_MSG_CHARS`,
  `SESSION_INPUT_MAX_CHARS`.
- **hub** (`agent-hub/server.js`): `POST /api/agents/<host>/sessions/<id>/input`
  `{text}` queues that command, and `/api` + `/term` now return CORS headers so
  this cross-origin WebView app can call the hub (auth is still enforced).

Because agents are outbound-only (heartbeat every ~20 s), the tail refreshes and
queued input/commands land on that cadence — fine for glance-and-answer, not a
live stream. A lower-latency path would reuse the reverse tunnel (future work).
