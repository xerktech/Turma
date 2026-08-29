---
paths:
  - "android/**"
---

# `android/` — native Android client

Kotlin + Jetpack Compose, MVVM. Full parity with the web dashboard + glasses client, plus phone-only
**OS push notifications** (FCM) and **voice**.

**The parity rule itself is in `CLAUDE.md`** ("Cross-cutting contracts"): the mobile web UI
(`turma/public/`) is the source of truth, and a PR changing user-facing behavior there must carry
the Android change or add a line to `android/PARITY.md`.

## Layout

Mirrors the glasses pure-core/adapter-shell split:

- `core/` — JVM-unit-tested reducers ported 1:1 from `glasses/src` (`Transcript` grow-only merge,
  `Sessions` working/idle/waiting, `ChatItems` buildItems+verbosity).
- `model/` — wire shapes + shared `TurmaJson` decoder. `vm/` — the ViewModels.
- `net/` — `HubClient` (Retrofit/OkHttp/kotlinx.serialization), `LiveTail`+`FleetRepository`
  (WebSocket `/live` + SSE `/api/events` with a 6s `/api/agents` poll floor), `Dictation` (16kHz PCM
  → the hub's `/audio` Whisper socket).
- `ui/` — Compose screens; see `android/PARITY.md` for the web page → screen map.
- `push/` — FCM service + `PushRegistrar` (registers via `POST /api/devices`; guarded so a build
  with no `google-services.json` still runs). Driven hub-side by `turma/push.js`.

## Web page → Android screen map

| Web | Android |
|-----|---------|
| `index.html` | `ui/FleetScreen.kt` + `ui/FleetDialogs.kt` |
| `sessions.html` + `chat.js` | `ui/SessionsScreen.kt` + `ui/ChatScreen.kt` + `vm/ChatViewModel.kt` |
| `board.js` + `board.html` | `ui/BoardScreen.kt` + `core/Board.kt` + `vm/BoardViewModel.kt` |
| `usage.html` | `ui/UsageScreen.kt` |
| `nav.js` | `ui/MainScaffold.kt` + `ui/TurmaApp.kt` |
| `org.js` | `ui/OrgControl.kt` + `vm/OrgViewModel.kt` + `data/OrgFilter.kt` |

- **Pure logic ports live in `core/`, JVM-unit-tested against the web behavior**: board category
  carve-out (`core/Board.kt` ↔ `board.js` `categoryOf`), chat item builder (`core/ChatItems.kt` ↔
  `chat.js` `buildItems`), summary-tile reducers (`core/Fleet.kt` ↔ `index.html`
  `fleetTokens`/`mergeModels`), Ready-for-review split (`core/Sessions.kt` `rankRunning` →
  `LiveGroups`), sessions search (`core/Search.kt`, XERK-243 — one box filters live lists AND
  appends archive matches). Port logic there; keep the Compose screen a thin renderer.
- **Match features and structure, not pixels** (platform-idiomatic controls). A justified platform
  difference (native chat vs ttyd terminal, Hub-URL login field, voice dictation) goes in
  `android/PARITY.md` — the living gap tracker, updated whenever a gap closes or opens.
- No in-place chat/terminal toggle (terminal is its own screen), so the compose draft lives in
  `data/DraftStore.kt` keyed per (host, session); `ChatViewModel` mirrors it into
  `ChatUiState.draft`, writing every change (dictation, send-clears) back through it. Tests:
  `DraftStoreTest.kt`.
- Org filter/board pins/tinting: `data/OrgFilter.kt` + `ui/OrgControl.kt` + `core/Board.kt`
  (`orgColorMap`, `FleetState.orgColors`, `TurmaCard(tint=)`), tested in `BoardTest.kt` alongside
  `hostOptions`/`agentPinOf`/`modelPinOf`/`statusChangeable`/`autoStartOn`.
- Create-ticket parity: ＋ in `ScreenHeader` → `CreateTicketSheet`; `source` on
  `JiraBlock`/`BoardSite`, endpoints in `net/HubApi.kt`, ports in `core/Board.kt`. A `409` agent-gap
  refusal reads via `hubError()`.

## Push delivery

- Android owns the delivery half: `POST_NOTIFICATIONS` runtime request (API 13+, `MainActivity`),
  channels + rendering in `push/Notifications.kt`, `push/PushRegistrar.kt`.
- `Notifications.idFor` keys off the hub's stable `notifKey`, so alert kinds coexist instead of
  colliding on one per-session id. `DeviceRequest.features` is **required, not defaulted**
  (`encodeDefaults=false` would drop it and the hub would never retract an alert). Tests:
  `DeviceRequestTest.kt`.
- **`android/app/google-services.json` is COMMITTED** (XERK-37) — must be in the repo or CI-built
  release APKs ship with Firebase inert. Holds only public identifiers; gradle apply stays
  conditional so a fork removing it still builds.
- A hub reporting `pushEnabled === false` banners "mobile push is off" (`FleetScreen`
  `PushOffBanner`) — strict, so an older hub never false-alarms.

## In-app update (XERK-11)

- Stopgap self-updater (pre-Play): checks **public** `xerktech/turma` releases for a newer APK,
  hands it to the system installer on one-tap **Update**. `core.Update` is the pure JVM-tested
  picker; `net.Updater` the I/O; `ui.UpdateBanner`/`vm.UpdateViewModel` render it.
- Compares the version in the **asset FILENAME** (`turma-android-v<x.y.z>.apk`) against the
  installed `versionName`, **never the release TAG**; scans every recent release's assets, not just
  "latest".
- **Anonymous + credential-isolated**: its OWN `OkHttpClient`, without `HubClient`'s Basic-auth
  interceptor, so the hub password never reaches github.com. Checked on app start + each Dashboard
  visit, throttled ~15 min; **quiet on failure**.
- Install: `REQUEST_INSTALL_PACKAGES` + `FileProvider` over a `content://` URI. API 26+ gates on
  "install unknown apps"; ungranted, routes to that settings screen, banner reads **Install**. OS
  verifies the APK signature.
- **Stable signing key (XERK-26)**: in-place update works ONLY when every build shares one cert, so
  `release.yml` builds `assembleRelease` with a fixed committed keystore
  (`android/app/turma-release.keystore`). **Never `assembleDebug`** — each CI runner generates a
  fresh key, forcing uninstall+reinstall on every update. Key is deliberately public; Play App
  Signing supersedes it on Play.
- Tests: `core/UpdateTest.kt`.

## Testing the call sites (XERK-262)

`core/` gated by plain JVM tests; **`vm/` and `ui/` by Robolectric**, in `test/` — not `androidTest/`.

- **Compose/ViewModel tests MUST stay in `test/`** — `testDebugUnitTest` is the only Android CI gate;
  `androidTest` needs an emulator this repo doesn't have. `unitTests.isIncludeAndroidResources = true`
  is what makes `createComposeRule` work; JVM pinned to `maxHeapSize = "2g"` (Gradle's 512m default
  OOMs on the first composition).
- **Pin `@Config(sdk = [35])`, matching `compileSdk`/`targetSdk`** — Robolectric downloads a ~190MB
  `android-all` per SDK level. Move it with `compileSdk`.
- **Never set `@Config(qualifiers = …)` on a Compose test** — any screen-size qualifier puts Compose
  into a composition loop that never idles, failing every test in the class after a 60s timeout. Use
  `performScrollTo` for a node below the fold; a `LazyColumn` row is UNCOMPOSED off-screen, so that
  one needs `performScrollToNode`.
- **`harness/HubHarness`** points `Config` at a `MockWebServer` post-start (`HubClient` rebuilds its
  Retrofit on a base-URL change). Drive with `seedFleet()` (awaits `FleetRepository.refresh()`
  directly, skipping the 6s poll). **FAILS LOUD on an undecodable fixture** — `refresh()` otherwise
  swallows the throw into an empty fleet with an error string.
- **Use the real HTTP stack, not a fake `HubApi`** — the refusals under test are a 409 + JSON
  `error` body, which is what `hubErrorMessage` digs a reason out of; a fake only proves itself.
- **`harness/MainDispatcherRule` defaults to `UnconfinedTestDispatcher`** so `viewModelScope.launch`
  runs eagerly, no `advanceUntilIdle()` needed (a forgotten one passes against unwritten state). Does
  NOT make the network synchronous — join the `Job` a VM action returns, or use
  `awaitValue`/`collectMessages`.
- **Assert a model-switch memo on the STORE (`container.modelSwitches`), never `ChatUiState`** — the
  state copy is a VM-rebuilt mirror; asserting it passes on a change that dropped the real thing.
- **The in-app updater is silenced in tests (XERK-281)** — Robolectric rebuilds the Application per
  test method so the ~15-min throttle never applies, hitting live `api.github.com` from shared-IP CI
  otherwise. `Updater.check()` no-ops when `turma.updater.disabled` is `true` (checked BEFORE
  throttle/force), set JVM-wide by `testOptions.unitTests.all`. Nothing in production sets it. Tests:
  `net/UpdaterTestSeamTest`.
- Tests: `vm/ChatModelSourceTest`, `vm/FleetOutcomeTest`, `ui/SpawnComposerTest`,
  `ui/ChatModelChipsTest`, `ui/SessionsPaneSpawnTest`, `ui/FleetSpawnLocalModelTest`.

## Building

- Gradle (wrapper generated in CI, not committed); PR-gated by `android-ci.yml` on `ubuntu-latest`,
  JDK 17, Gradle pinned in-job to match `app/build.gradle.kts`. Setup + FCM wiring:
  `android/README.md`.
- **Don't copy `code-scan.yml`'s runner-toolchain reclaim into `android-ci.yml`** — that job builds
  against the runner's own preinstalled Android SDK, which the reclaim deletes.
