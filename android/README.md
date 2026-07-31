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
  host offline/recovered / restart loop, each on its own channel, deep-linking a
  tap to the exact session or host.
- **Adaptive layout** — dashboard / board / usage simply expand to fill the
  window; the Sessions screen becomes a web-style **list-detail two-pane** (cards
  left, chat right) on an expanded width (≥840dp: tablets, unfolded foldables,
  large landscape) and single-pane (list → full-screen chat) when narrow. The
  open session is `rememberSaveable`, so a foldable folding/unfolding reflows
  between the two forms without losing the conversation. Driven by
  `WindowWidthSizeClass` in `MainActivity` → `SessionsRoute`.
- **In-app update** — checks the public GitHub releases for a newer APK and, on a
  one-tap **Download & Install**, sideloads it via the system installer. A stopgap
  until the app ships on Google Play (see "In-app update" below).

## Architecture

Mirrors the glasses client's pure-core / adapter-shell split:

- `model/` — wire shapes + the shared `TurmaJson` decoder.
- `core/` — pure, JVM-tested reducers ported from `glasses/src`: `Reveal`,
  `Transcript` (grow-only merge), `Sessions` (working/idle/waiting), `ChatItems`
  (buildItems + verbosity). Unit tests in `src/test/`.
- `net/` — `HubClient` (Retrofit + OkHttp + kotlinx.serialization),
  `LiveTail`/`FleetRepository` (WebSocket + SSE), `Dictation` (mic → `/audio`),
  `Updater` (in-app update — see below). The updater is pure/`core.Update` +
  I/O/`net.Updater`, like everything else.
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

## In-app update

A stopgap self-updater until the app ships on Google Play (XERK-11). It checks
the **public** `xerktech/turma` GitHub releases for a newer Android APK and, on a
one-tap **Update**, downloads it and hands it to the system package installer.

- **How the version is decided.** Every unified release is self-contained: a
  component unchanged in a release still carries its own APK forward onto that
  release under its ORIGINAL name (`turma-android-v<x.y.z>.apk` — see
  `.github/scripts/manifest.js`). So the version in the asset FILENAME is the
  component's real version, and the updater compares THAT against the installed
  `versionName` — never the release TAG, which runs ahead of a carried component
  (the same reasoning as the native agent updater). `core.Update` is the pure,
  JVM-tested picker; it scans every recent release's assets and offers the
  highest APK strictly newer than installed.
- **Anonymous + isolated.** The repo is public, so the check is anonymous HTTPS
  with no token or hub credential (like `agent/native/bootstrap.sh`). It uses its
  own `OkHttpClient`, deliberately WITHOUT `HubClient`'s Basic-auth interceptor,
  so the hub password never reaches github.com.
- **Checking cadence.** On app start and each Dashboard visit, throttled to ~15
  min. Quiet on failure (offline / rate-limit) — the banner only surfaces when
  there's an actual update, and a "Later" tap hides that version for the session.
- **Install.** `REQUEST_INSTALL_PACKAGES` + a `FileProvider` (`@xml/file_paths`,
  authority `${applicationId}.updates`) expose the downloaded APK to the
  installer over a `content://` URI. On API 26+ the OS gates this on "install
  unknown apps" for Turma; when it isn't granted yet the updater routes the
  operator to that settings screen and the banner reads **Install** to retry. The
  OS verifies the APK signature on install — the real integrity gate for updating
  an installed app — so no sha check is re-implemented here.
- **Stable signing (XERK-26).** That signature check is also why every build must
  carry the SAME signing certificate: Android only updates an installed app IN
  PLACE when the new APK's cert matches the installed one, else it fails with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` and the app has to be uninstalled first.
  The release build is therefore signed with a fixed keystore committed to the
  repo (`app/turma-release.keystore`, wired in `app/build.gradle.kts`'s
  `signingConfigs`), so every release — on any CI runner — shares one cert.
  Before this, `release.yml` shipped `assembleDebug`, signed with the debug key
  each ephemeral runner auto-generates fresh, so no two releases matched and each
  update forced an uninstall+reinstall. The key is intentionally in a public repo
  (its whole job is to be identical everywhere; the updater only installs official
  HTTPS releases); Play App Signing supersedes it once the app ships on Play.
  **Moving onto the first stable-key build still needs one final uninstall**,
  because the currently-installed app carries an old random debug cert no stable
  key can match; every update after that installs in place.

## Push notifications (FCM) setup

Push is optional — the app builds and runs without it (the Firebase plugin is
skipped when no config is present).

**`android/app/google-services.json` is committed** (XERK-37) so the CI-built
release APKs — the ones the in-app updater installs — actually carry the
Firebase client config. It holds only public identifiers (project id, app id, an
Android API key), not secrets, the same reasoning as the committed release
keystore. While it was gitignored, every released APK was built without it, so
push was silently inert in production. A fork pointing at its own Firebase
project replaces the file with its own.

To set up a new Firebase project:

1. Create a Firebase project, add an Android app with applicationId
   `com.xerktech.turma`, and commit its **`google-services.json`** at
   `android/app/`.
2. On the **hub**, set `FCM_SERVICE_ACCOUNT_JSON` (the same Firebase project's
   service-account JSON, inline) in `compose/turma-truenas.yaml` (DockerOps).
   The hub's `turma/push.js` mints an OAuth token from it and fans every alert
   (`notify()`) out to registered devices.

The app registers its token via `POST /api/devices` after sign-in and on token
refresh, and unregisters on sign-out.
