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

### Session screen: bottom bar + focus model

The session screen has no header line — the whole canvas is the transcript
plus a persistent bordered box pinned to the bottom (drawn as a real
bordered container only on hardware; the DOM dev backend stands it in with a
plain-text divider, see `src/display/dom.ts`). The box has two modes: an
**input box** (a dictation target and free-text draft, with a right-corner
status label showing REC/…/Working/Waiting/etc.) and, whenever the session
has a pending `AskUserQuestion` the user hasn't already started dictating an
answer to, a **question sheet** — the question text and numbered options
fill/grow/scroll the same box, plus a trailing "Dictate answer…" row.

Two focus states drive input dispatch (`SessionFocus` in `src/render.ts`):
**transcript focus** (the default on entering the screen) scrolls the
transcript ~2 lines per gesture (`SESSION_SCROLL_STEP`) and a tap either
snaps back to the newest content (if scrolled up) or hands focus to the
bottom box; a double-tap always leaves the session screen. **Bottom focus**
dispatches to whichever mode is active: in the input box, tap starts/stops
in-box dictation and a double-tap opens the context actions menu (Send —
only shown once there's a draft —/Clear/Restart/Kill/Delete/Back); in the
question sheet, scroll moves the highlighted option (including the trailing
"Dictate answer…" row) and tap either sends the highlighted option's 1-based
digit as the answer or, on the trailing row, starts box dictation instead.
The separate full-screen reply and question-answering screens are gone; the
reply screen still exists but only for the spawn/`newPrompt` initial-prompt
flow.

## Dev quickstart

```sh
npm install
npm run mock-hub   # in one terminal — a stdlib Node mock of the hub API
npm run dev         # in another — Vite dev server, DOM backend
```

`npm run dev` opens a keyboard-driven DOM stand-in for the glasses display:
arrow keys scroll, Enter taps, Escape double-taps (back).

The hub URL is hardcoded (`DEFAULT_HUB_URL` in `src/config.ts`) so the phone
login page only asks for a username and password, exactly like the web
dashboard's login. For local dev, `VITE_HUB_URL` overrides that target (e.g.
to point at the mock-hub or a LAN hub), and `VITE_HUB_USER` /
`VITE_HUB_PASSWORD` prefill the credentials — set them in a `.env.local` Vite
picks up before running `npm run dev`.

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

## Publishing to Even Hub

The `npm run pack` / `evenhub qr` flow above is **sideload only** — it installs
the `.ehpk` onto your own paired glasses for development. Getting the app into
the Even Hub store (so it shows up in the Even phone app for install) is a
separate flow that runs through Even Realities' **developer portal**, not the
CLI: `evenhub` has only `init`, `qr`, and `pack` — there is no `publish`/`submit`
command, so the built `.ehpk` is uploaded through the web portal.

1. **Get developer access (one-time gate).** Even Hub is curated — you can't
   upload without being accepted. Apply to the developer program at
   [evenhub.evenrealities.com/application](https://evenhub.evenrealities.com/application)
   and wait for approval (first batch reviewed within ~10 business days,
   response by email). Until you're in, you can only sideload.
2. **Make `app.json` submission-ready.** Bump `version`; confirm
   `min_app_version` / `min_sdk_version`; and — most important — make sure the
   `network` permission `whitelist` lists your real hub host for **both**
   `https://` and `wss://` (currently `https://agents.xerktech.com` and
   `wss://agents.xerktech.com`). Reviewers enforce this whitelist at the WebView
   network layer, so a stale entry means the app can't reach the hub during
   review.
3. **Build + pack** exactly as for sideload:

   ```sh
   npm run build   # tsc + vite → dist/
   npm run pack    # evenhub pack app.json dist -o ../agenthub-hud.ehpk
   ```

4. **Upload the `.ehpk` in the developer portal** and create/update the app
   entry. This is the step the CLI does not cover.
5. **Manual review.** Every submission goes through a manual review against Even
   Hub's [App Submission & QA checklist](https://hub.evenrealities.com/docs/reference/app-submission);
   anything that fails is returned with a rejection note. The recommended
   pre-flight is the **Beta build** [testing tier](https://hub.evenrealities.com/docs/test)
   (the `.ehpk` distributed to invited testers), because it gives full
   *reviewer parity* — the exact conditions the reviewer sees.

### Private/Beta vs Public

These are two distribution states of the *same* uploaded build, chosen in the
portal:

- **Private / Beta** — distributed only to testers you invite via **email invite
  links**; testers see these under "Beta" plugins. This is the invite-only lane
  and the QA gate before any public listing.
- **Public** — after passing review, listed in the Even Hub store for anyone to
  install (shown under "Public" plugins).

**For AgentHub HUD specifically, the private/beta lane is the realistic one.**
The app is single-user and self-hosted: the hub URL is hardcoded
(`DEFAULT_HUB_URL` in `src/config.ts`), it sits behind HTTP Basic auth, and the
`app.json` `network` whitelist is pinned to one host. A public installer has no
reachable hub and no credentials, so a public store listing wouldn't be usable.
Going genuinely public would first require making the hub URL user-configurable
at login and loosening/parameterizing the `network` whitelist accordingly.

## Testing the hub audio path without glasses

```sh
node tests/audio-client.mjs <hubUrl> <user:pass> <file.wav>
```

Fetches a `ws-token`, streams a 16kHz mono s16le WAV/PCM file to the hub's
`/audio` WebSocket in real time, and prints the resulting transcript — a way
to exercise the whole STT path without hardware.

## On-hardware QA checklist

- Whitelist edited to your hub host and the app sideloads/opens OK.
- Signed in via the phone login page (matches the web dashboard's login —
  username + password; the hub URL is hardcoded in `src/config.ts`) and the
  glasses-display mirror appears.
- Session list matches the web dashboard.
- Each lifecycle action (spawn/kill/start/restart/resume) shows queued (…)
  then converges within ~40s.
- No header line on the session screen — the transcript runs to the top of
  the canvas, with the bordered bottom box the only other thing on screen.
- Scrolling the transcript feels smooth in ~2-line steps per gesture (not a
  full-page jump); tapping (when not scrolled up) focuses the bottom box.
- A pending `AskUserQuestion` turns the bottom box into a sheet: the
  question text and options fill/grow/scroll the box as needed; scrolling
  highlights an option (including a trailing "Dictate answer…" row) and
  tapping a highlighted option sends its digit — verify it lands correctly
  in the RC TUI (the agent appends Enter).
- Dictating into the bottom input box appends to its draft, and Send (from
  the box's double-tap context menu) delivers it to the session.
- The drawn border around the bottom box and real G2-mic dictation are
  hardware-only — the DOM dev backend stands in a plain-text divider and
  can't exercise the mic, so both need on-hardware verification.
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
