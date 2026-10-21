---
paths:
  - "android/**"
---

# `android/` — native Android client

Kotlin + Jetpack Compose, MVVM. Full parity with the web dashboard + glasses client, plus phone-only
**OS push notifications** (FCM) and **voice**.

**The parity rule itself is in `contract-clients.md`**: the mobile web UI
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
| `brief.html` | `ui/BriefScreen.kt` + `core/Brief.kt` + `vm/BriefViewModel.kt` |
| `nav.js` | `ui/MainScaffold.kt` + `ui/TurmaApp.kt` |
| `org.js` | `ui/OrgControl.kt` + `vm/OrgViewModel.kt` + `data/OrgFilter.kt` |

- **Pure logic ports live in `core/`, JVM-unit-tested against the web behavior**: board category
  carve-out (`core/Board.kt` ↔ `board.js` `categoryOf`), chat item builder (`core/ChatItems.kt` ↔
  `chat.js` `buildItems`), summary-tile reducers (`core/Fleet.kt` ↔ `index.html`
  `fleetTokens`/`mergeModels`), Ready-for-review split (`core/Sessions.kt` `rankRunning` →
  `LiveGroups`), sessions search (`core/Search.kt`, XERK-243 — one box filters live lists AND
  appends archive matches). Port logic there; keep the Compose screen a thin renderer.
- **A port of a web/hub text rule uses JavaScript's character sets, never Kotlin's or the regex
  engine's** (rollup XERK-1701): `jsTrim`/`isJsBlank`/`JS_WS` (Prose.kt) for `trim()`/`\s`, and
  an explicit `[A-Za-z0-9_]` lookaround + ASCII lowercase for `\b` and `/i`.
  - Kotlin's `trim()`/`isBlank()` keep U+FEFF and cut U+001C..U+001F (JS: the reverse); a device's
    regex is ICU (Unicode `\s`/`\w`/`\b`, Unicode case folding) while JVM unit tests run
    `java.util.regex`, so a test can pass on the JVM and the device still disagree with the web.
  - Tests: `SessionsTest` (wait labels), `BoardTest` (review status, `splitLabels`),
    `CodingAgentLabelTest`.
- **Board search/filter/sort** is `core/BoardView.kt` ↔ `board.js` `boardView*` (rule in
  `turma-board.md`). The phone shows active filters as a badge only — never a second chip row.
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
- Org tints and chart lines read `TurmaColors.series()` — composable, the web's light `--s1..--s8`
  on a light surface and the dark set on dark. Never hold a palette list outside composition (a
  theme switch would keep the old one). Tests: `StatusTextColorsTest`.
- Permission policy editor (XERK-1566): `PermissionPolicySheet` in `ui/BoardScreen.kt` (a labelled
  item in `ScreenHeader`'s ⋮ `menuItems`, never a header icon — one crowded the org filter), state in `BoardViewModel.permission`, its own route — never `/api/agents`.
- Create-ticket parity: ＋ in `ScreenHeader` → `CreateTicketSheet`; `source` on
  `JiraBlock`/`BoardSite`, endpoints in `net/HubApi.kt`, ports in `core/Board.kt`. A `409` agent-gap
  refusal reads via `hubError()`.
- Usage's permission card (XERK-1576) is its OWN `GET /api/permissions` call
  (`model/Permissions.kt`, all fields defaulted, `kind` a string), never the atomic `/api/agents`
  decode. `UsageViewModel.watchPermissions` mirrors usage.html's `refreshPermissions`: waits for a
  FULL fleet snapshot (`FleetState.polled` — poll-only; an SSE upsert is a partial fleet), scopes by the header's effective org keys, drops the old org's view on a scope
  change and discards a late answer for it. Port logic in `core/Permissions.kt`. Tests:
  `UsagePermissionsViewModelTest`, `PermissionsSectionTest`.
- Usage's model-quality card (XERK-1849) is likewise its OWN `GET /api/model-quality` call
  (`model/ModelQuality.kt`, `UsageViewModel.watchModelQuality`); rules in `model-quality.md`.

## Images (rollup XERK-2109)

- **An SVG is sized as Chrome sizes an `<img>`** (`core/SvgGuard.kt` `svgNaturalSize`, expectations
  measured in chrome-headless-shell): read the parsed root's width/height (`SvgRenderGuard.rootSize`),
  never `SVG.getDocumentWidth/Height`, which make a width-only SVG square and drop a lone height.
  - A viewBox alone FILLS the box's width (`svgFilledSize`), as Chrome lays it out; it is not 24dp.
- **A remote SVG renders only when served as image/svg+xml** — a browser never sniffs SVG.
  `ServedContentType` (the loader's OkHttp interceptor) relabels text/plain / missing types, which
  Coil would otherwise replace with the URL extension's guess; it must change the BODY's type (read
  on a fetch) and the header (read on a disk-cache hit). Tests: `ServedContentTypeTest`.
  - It relabels an empty or unparseable type too: OkHttp gives such a body no type, so Coil guesses.
  - Its text/plain test is a raw-string PREFIX, as Coil's is: `text/plainx` is guessed from too.
  - The loader's disk cache is its own directory (the old `image_cache` is deleted): entries cached
    before the relabel would otherwise keep rendering a text/plain `.svg`.

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
- **Wrap every ViewModel a test builds in `main.track(…)`** (rollup XERK-1584 #6): a late OkHttp
  answer otherwise resumes on `Dispatchers.Main` mid `setMain`/`resetMain` and throws "used
  concurrently with setting it". `HubHarness.after()` cancels them BEFORE `server.shutdown()`,
  which aborts in-flight calls and is itself a source of late answers (QA); the rule's
  `finished()` runs after it. `viewModel()` VMs in composables are cleared by the compose rule.
- **Never let a Compose test take a screen's `viewModel()` default** — pass a VM built on
  `hub.app`. In a full-suite run the default handed back a VM over an EARLIER test's container
  (stale fleet, dead MockWebServer): measured in `OrgControlMergeTest` / `BoardTriageTest` flakes.
- **No wall-clock races in tests**: hold a response on a latch the test releases
  (`UsagePermissionsViewModelTest.routeByOrg`), never `setHeadersDelay`; bound a perf test on
  thread CPU time (`ProseTest.cpuMs`), never `System.nanoTime` — both reddened under CPU load.
- A second beat seeded after a VM action that `nudge()`s the fleet carries a fresher `lastSeen`
  (`fleetJson(lastSeen=)`): the nudge's poll can land the FIRST beat after it (`ChatModelSourceTest`).
- Colour call sites are pinned in pixels/text-layout, light theme (`ColourCallSiteTest`); the
  chat's sheet cap and header/footer fit on the real `ChatScreen` in a short `requiredHeight` box
  (`WaitingSheetBoundsTest`, `ChatHeaderFooterFitTest`) — a short box, so the MEASURED bars bind.
- Chat window/inset behaviour is tested by DISPATCHING real insets (status, navigation, ime with
  `setVisible`) to the content view (`ChatWindowFitTest.insets`); Robolectric gives none otherwise.
  - Measure text widths only under `@GraphicsMode(NATIVE)`: legacy mode's `TextMeasurer` returns
    ~1px per character, so width-driven layout (the meta row) reads wrong.
- Org-tint call sites (`TurmaColors.series()`, never `ChartSeries*` outside `ui/theme`) are pinned
  at the source by `SeriesCallSiteTest`: no render test reaches every screen's tint.
- **Assert a model-switch memo on the STORE (`container.modelSwitches`), never `ChatUiState`** — the
  state copy is a VM-rebuilt mirror; asserting it passes on a change that dropped the real thing.
- **The in-app updater is silenced in tests (XERK-281)** — Robolectric rebuilds the Application per
  test method so the ~15-min throttle never applies, hitting live `api.github.com` from shared-IP CI
  otherwise. `Updater.check()` no-ops when `turma.updater.disabled` is `true` (checked BEFORE
  throttle/force), set JVM-wide by `testOptions.unitTests.all`. Nothing in production sets it. Tests:
  `net/UpdaterTestSeamTest`.
- **Coil's `ImageLoader.execute()` hops to the main thread** — in Robolectric that is the test's
  own, so `runBlocking { execute() }` there deadlocks. Run it on another thread and pump
  `shadowOf(Looper.getMainLooper()).idle()` (`ServedContentTypeTest.load`).
- Tests: `vm/ChatModelSourceTest`, `vm/FleetOutcomeTest`, `ui/SpawnComposerTest`,
  `ui/ChatModelChipsTest`, `ui/SessionsPaneSpawnTest`, `ui/FleetSpawnLocalModelTest`.

## Chat header and footer fit (rollup XERK-1701)

- "Short window" (`chatHeaderFit`) reads the chat's height WITHOUT the keyboard (a
  `BoxWithConstraints` outside `imePadding`): measured inside, a tablet's keyboard read as a phone.
- Typing in a short window (`compact`): the meta line folds, the footer pads less, and the top bar
  steps aside (status strip only) when bar + compose box can't both fit (`chatBarFits`) — the box
  being typed into always stays whole — and while a sheet is pending. It returns with no keyboard.
- A question / permission sheet pending in a short window comes first (`sheetFirst`), keyboard up
  OR down: the header keeps the title (plus the tunnel warning alone when the tunnel is down), the
  chip row yields, and the sheet's floor is the room ABOVE the compose footer (`aboveBox`).
  - Never a 0-height sheet: the cap alone gave 0 in the landscape two-pane chat at font 2.0
    (283dp tall) once the tunnel marker took its own line, and while typing.
  - Never more than `aboveBox`: a floor of the whole footer overflowed it by the compose row, and
    (pinned to the bottom) hid the question's first lines under the bar on open.
  - Except typing on a short phone, where `aboveBox` drops under `CHAT_SHEET_MIN` (40dp; ~0 at
    font 2.0 on a 308dp-tall phone): then the floor is the whole footer, reached by scrolling it.
    Keyboard down it stays `aboveBox`, however small, so the question's first line shows on open.
  - Each sheet's scroll state is keyed on its question / prompt (`promptKey`: minus the TUI
    cursor's row), so a new one opens at its top and a cursor move doesn't jump it.
  - Tests must read UNCLIPPED bounds and never scroll first: `getBoundsInRoot` is clipped and
    `performScrollTo` hides exactly this (`ChatWindowFitTest.sheetOnOpen`).
- The bar's height comes from MEASURED line heights (`TextMeasurer`), not the style's `lineHeight`,
  which undershoots the drawn line at a non-linear font scale.
- The tunnel marker never shares a line it can't fit beside a half-width host · repo
  (`chatMetaOneLine`); on its own line it wraps at a word (2 lines max) and the bar grows to hold it.

## Building

- Gradle (wrapper generated in CI, not committed); PR-gated by `android-ci.yml` on `ubuntu-latest`,
  JDK 17, Gradle pinned in-job to match `app/build.gradle.kts`. Setup + FCM wiring:
  `android/README.md`.
- Locally on a host whose `/tmp` is noexec, Robolectric's native runtime and Conscrypt fail to
  load ("failed to map segment"): set `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=<an exec dir>`.
- **Don't copy `code-scan.yml`'s runner-toolchain reclaim into `android-ci.yml`** — that job builds
  against the runner's own preinstalled Android SDK, which the reclaim deletes.
