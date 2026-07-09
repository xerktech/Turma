# @agenthub/glasses

Even Realities G2 smart-glasses client for AgentHub: a sessions list, a
scrollable transcript, question answering (`AskUserQuestion`), spawn/kill/
resume of Claude Code sessions, and G2-mic dictation transcribed by the hub's
Whisper integration. `src/app.ts` is a hardware-agnostic controller driven
purely by the `GlassesDisplay` / `Dictation` / `KeyValueStorage` interfaces;
`src/main.ts` wires in either the real Even Hub SDK backend
(`src/display/evenhub.ts`, on-device) or a DOM dev backend
(`src/display/dom.ts`, `npm run dev`), chosen automatically by racing
`waitForEvenAppBridge()` against a short timeout.

## Dev quickstart

```sh
npm install
npm run mock-hub   # in one terminal — a stdlib Node mock of the hub API
npm run dev         # in another — Vite dev server, DOM backend
```

`npm run dev` opens a keyboard-driven DOM stand-in for the glasses display:
arrow keys scroll, Enter taps, Escape double-taps (back).

To point the dev server at a real hub instead of the mock, set
`VITE_HUB_URL` / `VITE_HUB_USER` / `VITE_HUB_PASSWORD` (e.g. in a `.env.local`
Vite picks up) before running `npm run dev`.

## Simulator

```sh
npm run dev                                       # in one terminal
npm run simulate                                   # in another
```

`npm run simulate` launches `@evenrealities/evenhub-simulator` against the
running dev server. Known gaps versus real hardware: the simulator's
scripted automation surface (`/api/input`) only drives touchpad actions (up/
down/click/double-click) — there's no way to inject synthetic mic audio
through it, so the dictation path can't be exercised via automation and
should be verified on real hardware; and `sysEvent.eventSource` is hardcoded
by the simulator to `TOUCH_EVENT_FROM_GLASSES_R`, so anything keyed on which
touchpad produced an event won't be meaningfully exercised there either.

## Hub requirements

The hub (`agent-hub/server.js`) needs its Whisper STT env vars set for
dictation to work — otherwise the `/audio` WebSocket still accepts
connections but every result reports `unavailable`:

- `WHISPER_URL` — OpenAI-compatible Whisper server endpoint. Unset disables
  STT.
- `WHISPER_MODEL` — model name passed to the Whisper server (optional).
- `WHISPER_API_KEY` — bearer token for the Whisper server (optional).
- `WHISPER_LANGUAGE` — default `en`.
- `WHISPER_TIMEOUT_MS` — default `30000`.

Set these in DockerOps' compose file alongside the hub's existing env
(`HUB_USER`/`HUB_PASSWORD`/`HUB_TOKEN`/etc.).

The agent side (`agent/hub-agent.py`) has its own tunables for the
transcript-tail and history/input surfaces the glasses client polls:

- `SESSION_TAIL_MSGS` — messages kept in the per-heartbeat transcript tail,
  default `30`.
- `SESSION_TAIL_MSG_CHARS` — chars kept per tailed message, default `500`.
- `SESSION_HISTORY_MSGS` — messages returned by an on-demand `history`
  request, default `200`.
- `SESSION_INPUT_MAX_CHARS` — max chars accepted by an `input` request,
  default `4000`.

## Packaging / sideload

Before `npm run pack`, edit `app.json`'s `permissions[].whitelist` (the
`network` permission) to your own hub's host — both the `https://` and
`wss://` entries — Even Hub enforces this whitelist at the WebView network
layer, so a stale entry means the packaged app simply can't reach your hub.

```sh
npm run pack   # builds dist/ and packages it + app.json into ../agenthub-hud.ehpk
npx evenhub qr # sideload: generates a QR code the Even app scans to install
```

Use a dedicated hub password for this app rather than reusing your normal
one: HTTP Basic credentials are stored on-device via the bridge's key/value
storage, not just held in memory.

## Testing the hub audio path without glasses

```sh
node tests/audio-client.mjs <hubUrl> <user:pass> <file.wav>
```

Fetches a `ws-token`, streams a 16kHz mono s16le WAV/PCM file to the hub's
`/audio` WebSocket in real time, and prints the resulting transcript — a way
to exercise the whole STT path without hardware.

## On-hardware QA checklist

- Whitelist edited to your hub host and the app sideloads/opens OK.
- Credentials entered via the phone settings panel and "Test connection"
  shows green.
- Session list matches the web dashboard.
- Each lifecycle action (spawn/kill/start/restart/resume) shows queued (…)
  then converges within ~40s.
- A dictated reply appears in the session's terminal and Claude answers it.
- `AskUserQuestion` shows the option labels; tapping one answers it (digit +
  Enter lands in the RC TUI — verify); a dictated free-text answer is also
  verified.
- Scrolling a long session to the top loads/prepends history with a
  truncated marker.
- Resuming a closed session from the Resume picker works.
- Spawning a session with a dictated prompt works end-to-end.
- The mic LED is off after every teardown path — stop, cancel, back out,
  backgrounding the app, locking the phone for 5 minutes — and state is
  restored correctly afterward.
- A root double-tap shows the system exit dialog.

## Scripts

- `npm run dev` — Vite dev server, DOM backend, keyboard-driven (arrows =
  scroll, Enter = tap, Escape = double-tap).
- `npm run build` — typecheck + production build (`dist/`).
- `npm test` / `npm run typecheck` — vitest / `tsc --noEmit`.
- `npm run pack` — builds and packages `dist/` + `app.json` into an
  `.ehpk` via `@evenrealities/evenhub-cli` (one directory up, alongside this
  package).
- `npm run simulate` — launches `@evenrealities/evenhub-simulator` against
  the local dev server (run `npm run dev` first).
- `npm run mock-hub` — a stdlib Node mock of the hub API for manual dev
  without a real hub/agent stack.
- `npm run audio-client` — `node tests/audio-client.mjs`, see above.
