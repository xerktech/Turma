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
- `model/` — the wire shapes + shared `TurmaJson` decoder. `vm/` — the ViewModels.
- `net/` — the `HubClient` (Retrofit/OkHttp/kotlinx.serialization), `LiveTail`+`FleetRepository`
  (WebSocket `/live` + SSE `/api/events` with a 6s `/api/agents` poll floor), and `Dictation` (16kHz
  PCM → the hub's `/audio` Whisper socket).
- `ui/` — the Compose screens; see `android/PARITY.md` for the web page → screen map.
- `push/` — the FCM service + `PushRegistrar` (registers via `POST /api/devices`; guarded so a build
  with no `google-services.json` still runs). Driven hub-side by `turma/push.js`.

## Web page → Android screen map

When you touch one of these web files, check its Android counterpart:

| Web | Android |
|-----|---------|
| `index.html` | `ui/FleetScreen.kt` + `ui/FleetDialogs.kt` |
| `sessions.html` + `chat.js` | `ui/SessionsScreen.kt` + `ui/ChatScreen.kt` + `vm/ChatViewModel.kt` |
| `board.js` + `board.html` | `ui/BoardScreen.kt` + `core/Board.kt` + `vm/BoardViewModel.kt` |
| `usage.html` | `ui/UsageScreen.kt` |
| `nav.js` | `ui/MainScaffold.kt` + `ui/TurmaApp.kt` |
| `org.js` | `ui/OrgControl.kt` + `vm/OrgViewModel.kt` + `data/OrgFilter.kt` |

- **Pure logic ports live in `core/` and are JVM-unit-tested against the web behavior** — the board
  category carve-out (`core/Board.kt` ↔ `board.js` `categoryOf`), the chat item builder
  (`core/ChatItems.kt` ↔ `chat.js` `buildItems`), the summary-tile reducers (`core/Fleet.kt` ↔
  `index.html` `fleetTokens`/`mergeModels`), the Ready-for-review split (`core/Sessions.kt`
  `rankRunning` → `LiveGroups`), the sessions search (`core/Search.kt`, XERK-243 — its ONE box
  filters the live lists AND appends archive matches). Port the *logic* there and keep the Compose
  screen a thin renderer.
- **Match features and structure, not pixels** — laid out platform-idiomatically (a Material
  dropdown for a `<select>`, an overflow menu for the ⋯ menu). A justified platform difference
  (native chat vs ttyd terminal, the Hub-URL login field, voice dictation) is recorded in
  `android/PARITY.md`, the **living gap tracker** — update it whenever you close a gap or knowingly
  open one.
- Android has no in-place chat/terminal toggle (the terminal is its own screen), so the compose
  draft lives outside both screens in `data/DraftStore.kt`, keyed per (host, session);
  `ChatViewModel` mirrors it into `ChatUiState.draft` and writes every change — incl. dictation and
  send-clears — back through it. Tests: `DraftStoreTest.kt`.
- Ports of the org filter, board pins and tinting live in `data/OrgFilter.kt` + `ui/OrgControl.kt` +
  `core/Board.kt` (`orgColorMap`, `FleetState.orgColors`, `TurmaCard(tint=)`), tested in
  `BoardTest.kt` alongside `hostOptions`/`agentPinOf`/`modelPinOf`/`statusChangeable`/`autoStartOn`.
- Create-ticket parity: ＋ in `ScreenHeader` → `CreateTicketSheet`; `source` on `JiraBlock`/
  `BoardSite`, endpoints in `net/HubApi.kt`, the label/meta/result ports in `core/Board.kt`. A `409`
  agent-gap refusal is read via `hubError()`.

## Push delivery

- The Android client owns the delivery half: `POST_NOTIFICATIONS`, the Android-13+ runtime request
  in `MainActivity`, channels + rendering in `push/Notifications.kt`, `push/PushRegistrar.kt`.
- `Notifications.idFor` keys off the hub's stable `notifKey`, so alert kinds coexist instead of
  colliding on one per-session id. `DeviceRequest.features` is **required** (not defaulted) —
  `encodeDefaults=false` would drop it and the hub would never retract an alert. Tests:
  `DeviceRequestTest.kt`.
- **`android/app/google-services.json` is committed** (XERK-37): the Firebase client config must be
  IN the repo or CI-built release APKs ship with Firebase inert and push does nothing. It holds only
  public identifiers (same as the committed release keystore); the gradle apply stays conditional so
  a fork that removes it still builds.
- A hub reporting `pushEnabled === false` banners "mobile push is off" (`FleetScreen`
  `PushOffBanner`, `FleetState.pushEnabled`) — strict, so an older hub never false-alarms.

## In-app update (XERK-11)

- A stopgap self-updater until the app ships on Google Play: checks the **public** `xerktech/turma`
  releases for a newer APK and, on a one-tap **Update**, hands it to the system package installer.
  `core.Update` is the pure, JVM-tested picker (`apkAssetVersion`, `compareVersions`,
  `latestApkUpdate`); `net.Updater` is the I/O; `ui.UpdateBanner` + `vm.UpdateViewModel` render it.
- It compares the version in the **asset FILENAME** (`turma-android-v<x.y.z>.apk`) against the
  installed `versionName`, never the release TAG, and scans every recent release's assets, not just
  "latest".
- **Anonymous + credential-isolated**: the updater uses its OWN `OkHttpClient` WITHOUT `HubClient`'s
  Basic-auth interceptor, so the hub password never reaches github.com. Checked on app start and
  each Dashboard visit, throttled ~15 min; **quiet on failure**.
- Install uses `REQUEST_INSTALL_PACKAGES` + a `FileProvider` (`@xml/file_paths`, authority
  `${applicationId}.updates`) over a `content://` URI. On API 26+ the OS gates on "install unknown
  apps"; ungranted, the updater routes to that settings screen and the banner reads **Install**. The
  OS verifies the APK signature, so no sha is re-verified.
- **Stable signing key (XERK-26)**: in-place update works ONLY when every build shares one cert, so
  `release.yml` builds `assembleRelease` signed with a fixed keystore committed to the repo
  (`android/app/turma-release.keystore`, wired in `app/build.gradle.kts`'s `signingConfigs`). Never
  `assembleDebug` — each CI runner generates that key fresh, forcing an uninstall+reinstall on every
  update. The key is deliberately in the public repo; Play App Signing supersedes it on Play.
- Tests: `core/UpdateTest.kt`.

## Testing the call sites (XERK-262)

`core/` is gated by plain JVM tests; **`vm/` and `ui/` are gated by Robolectric**, in the
`test/` source set — not `androidTest/`.

- **Compose and ViewModel tests MUST stay in `test/`.** `testDebugUnitTest` is the only Android
  gate CI runs (`android-ci.yml`); `androidTest` needs an emulator job this repo doesn't have, so a
  test moved there gates nothing. `testOptions.unitTests.isIncludeAndroidResources = true` is what
  makes `createComposeRule` work at all, and the test JVM is pinned to `maxHeapSize = "2g"` —
  Gradle's 512m default OOMs during the FIRST composition.
- **Pin `@Config(sdk = [35])`, matching `compileSdk`/`targetSdk`.** Robolectric downloads a ~190MB
  `android-all` per SDK level, so a class left on a different level makes CI fetch a second one for
  no fidelity gain. Move these with `compileSdk`.
- **Never set `@Config(qualifiers = …)` on a Compose test.** Measured: any screen-size qualifier
  puts Compose into a composition loop that never goes idle, and every test in the class then fails
  after a 60s Espresso timeout rather than on an assertion. Use `performScrollTo` for a node below
  the fold instead; a row inside a `LazyColumn` is UNCOMPOSED rather than merely off-screen, so
  that one needs `performScrollToNode` on the scrollable.
- **`harness/HubHarness`** points `Config` at a `MockWebServer` after the app has started —
  `HubClient` rebuilds its Retrofit on a base-URL change, so no production seam is needed. Drive the
  fleet with `seedFleet()`, which awaits `FleetRepository.refresh()` directly rather than waiting on
  the 6s poll. It FAILS LOUD on a fixture that doesn't decode, because `/api/agents` decodes
  atomically and `refresh()` swallows the throw into an empty fleet with an error string.
- **Use the real HTTP stack, not a fake `HubApi`.** The refusals these tests exist to cover are a
  409 with a JSON `error` body, which is exactly what `hubErrorMessage` digs a reason out of; a fake
  proves only that the fake was called.
- **`harness/MainDispatcherRule` defaults to `UnconfinedTestDispatcher`** so a ViewModel's
  `viewModelScope.launch` runs eagerly and assertions need no `advanceUntilIdle()` — a forgotten one
  is a test that passes against state nothing has written yet. It does NOT make the network
  synchronous: join the `Job` a VM action returns, or use `awaitValue`/`collectMessages`.
- **Assert a model-switch memo on the STORE (`container.modelSwitches`), never `ChatUiState`** —
  the state copy is a mirror the VM rebuilds, so a mirror assertion passes on a change that dropped
  the real thing.
- **The in-app updater is silenced in tests (XERK-281).** `TurmaApplication.onCreate` fires a
  fire-and-forget `Updater.check()`, and Robolectric rebuilds the Application per test METHOD so the
  ~15-min throttle never applies — every test hit live `api.github.com` (~33 anonymous calls/suite,
  from shared-IP CI runners). `Updater.check()` no-ops when the `turma.updater.disabled` system
  property is `true` (checked BEFORE the throttle/force branch, so even a forced "check now" stays
  quiet); `build.gradle.kts`'s `testOptions.unitTests.all { systemProperty(…) }` sets it JVM-wide.
  Nothing in production sets it. Don't re-introduce startup egress into the harness. Tests:
  `net/UpdaterTestSeamTest`.
- Tests: `vm/ChatModelSourceTest`, `vm/FleetOutcomeTest`, `ui/SpawnComposerTest`,
  `ui/ChatModelChipsTest`, `ui/SessionsPaneSpawnTest`, `ui/FleetSpawnLocalModelTest`.

## Building

- Gradle (wrapper generated in CI, not committed); PR-gated by `android-ci.yml` on `ubuntu-latest`,
  JDK 17 and Gradle pinned in-job to match `app/build.gradle.kts`. Setup + FCM wiring in
  `android/README.md`.
- **Don't copy `code-scan.yml`'s runner-toolchain reclaim into `android-ci.yml`** — that job builds
  against the runner's own preinstalled Android SDK, which the reclaim deletes.
