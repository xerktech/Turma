# Turma Android client

A native Android client for the Turma hub — full parity with the web dashboard
and the G2 glasses client, plus two things only a phone can do well: **OS push
notifications** and **voice** for starting sessions and mid-session prompts.

## Features

- **Fleet tree** — host → repo → session, with working / idle / **waiting-on-question**
  state, live branch (or `detached`), token cost, and a GitHub-style **PR pill**.
- **Session lifecycle** — one-click spawn, a composer (initial prompt + **voice**,
  label, base branch, model, permission mode), Resume picker, Kill / Start /
  Restart / Resume / Delete, per-session model/mode switch, Clone from GitHub,
  and arm/confirm Prune.
- **Native chat** — user/agent bubbles, collapsible tool-action cards and
  thinking traces, a **typewriter reveal** on the in-progress turn, a
  **verbosity** control (Concise / Normal / Verbose), and a raw **Terminal**
  (ttyd) toggle for debugging. Streams over the hub's `/live` WebSocket, seeded
  from the heartbeat tail + `/history`, with a poll fallback.
- **Voice** — 16 kHz PCM streamed to the hub's `/audio` Whisper endpoint;
  dictate a new session's initial prompt or a mid-session message / custom
  question answer.
- **AskUserQuestion** — option chips + custom free-text answer.
- **History** — persistent daily / all-time cost, By-repo (unified across hosts
  by `remoteKey`) and By-host.
- **Search & archive** — full-text search of ended sessions and a read-only
  transcript viewer.
- **Push** — FCM notifications for question waiting / turn finished / PR created /
  host offline / cost threshold, each on its own channel, deep-linking a tap to
  the exact session or host.
- **Adaptive layout** — dashboard / board / usage simply expand to fill the
  window; the Sessions screen becomes a web-style **list-detail two-pane** (cards
  left, chat right) on an expanded width (≥840dp: tablets, unfolded foldables,
  large landscape) and single-pane (list → full-screen chat) when narrow. The
  open session is `rememberSaveable`, so a foldable folding/unfolding reflows
  between the two forms without losing the conversation. Driven by
  `WindowWidthSizeClass` in `MainActivity` → `SessionsRoute`.

## Architecture

Mirrors the glasses client's pure-core / adapter-shell split:

- `model/` — wire shapes + the shared `TurmaJson` decoder.
- `core/` — pure, JVM-tested reducers ported from `glasses/src`: `Reveal`,
  `Transcript` (grow-only merge), `Sessions` (working/idle/waiting), `ChatItems`
  (buildItems + verbosity). Unit tests in `src/test/`.
- `net/` — `HubClient` (Retrofit + OkHttp + kotlinx.serialization),
  `LiveTail`/`FleetRepository` (WebSocket + SSE), `Dictation` (mic → `/audio`).
- `vm/` — ViewModels. `ui/` — Jetpack Compose screens. `push/` — FCM.

## Build

The Gradle wrapper jar/scripts are **not** committed (see `.gitignore`); generate
them once, pinned to the version in `gradle/wrapper/gradle-wrapper.properties`:

```bash
cd android
gradle wrapper --gradle-version 8.11.1   # one-time, needs a system Gradle
./gradlew testDebugUnitTest              # run the pure-core unit tests
./gradlew assembleDebug                  # build the debug APK
```

CI (`.github/workflows/android-ci.yml`) does exactly this on a GitHub-hosted
`ubuntu-latest` runner, using its preinstalled Android SDK with JDK 17 and
Gradle pinned in-job.

## Push notifications (FCM) setup

Push is optional — the app builds and runs without it (the Firebase plugin is
skipped when no config is present). To enable:

1. Create a Firebase project, add an Android app with applicationId
   `com.xerktech.turma`, and download **`google-services.json`** into
   `android/app/` (gitignored).
2. On the **hub**, set `FCM_SERVICE_ACCOUNT_JSON` (the Firebase project's
   service-account JSON, inline) in `compose/turma-truenas.yaml` (DockerOps).
   The hub's `turma/push.js` mints an OAuth token from it and fans every alert
   (`notify()`) out to registered devices.

The app registers its token via `POST /api/devices` after sign-in and on token
refresh, and unregisters on sign-out.
