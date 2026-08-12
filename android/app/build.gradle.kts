import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// The unified release pipeline stamps the version via env vars: TURMA_VERSION
// (the full MAJOR.MINOR.PATCH) and TURMA_VERSION_CODE (the monotonic packed
// code), both computed by the one tested place — .github/scripts/version.js —
// rather than duplicating the packing arithmetic here in Kotlin. A local or CI
// build without them (e.g. android-ci.yml's assembleDebug) falls back to the
// repo VERSION with a placeholder patch and versionCode 1.
val turmaVersion: String = System.getenv("TURMA_VERSION")
    ?: ((File(rootDir.parentFile, "VERSION").takeIf { it.exists() }?.readText()?.trim() ?: "0.0") + ".0")
val turmaVersionCode: Int = (System.getenv("TURMA_VERSION_CODE") ?: "").toIntOrNull() ?: 1

android {
    namespace = "com.xerktech.turma"
    compileSdk = 35
    // Pin rather than inherit AGP's default (34.0.0): the only build-tools the
    // CI image and the agent image install is the 35.0.0 that matches
    // compileSdk, so the default resolves to a revision that isn't there.
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.xerktech.turma"
        minSdk = 26
        targetSdk = 35
        versionCode = turmaVersionCode
        versionName = turmaVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
    }

    // A FIXED, in-repo signing key — the fix for XERK-26. The APK is distributed
    // by sideload (the in-app updater in core.Update / net.Updater pulls it from
    // the public GitHub releases), and Android only lets a new APK update an
    // installed one IN PLACE when the two carry the SAME signing certificate.
    // Before this, release.yml shipped `assembleDebug`, signed with the debug
    // keystore that each fresh ephemeral CI runner auto-generates — so every
    // release had a DIFFERENT cert and refused to update, forcing an
    // uninstall+reinstall each time. Committing one keystore and always signing
    // with it makes the cert stable across builds and hosts, so updates install
    // in place. The key is deliberately in the repo (which is public): its whole
    // job is to be identical everywhere, and the app's own updater only installs
    // official releases fetched over HTTPS. When the app eventually ships on
    // Google Play, Play App Signing supersedes this.
    signingConfigs {
        create("release") {
            storeFile = file("turma-release.keystore")
            storePassword = "turma-release"
            keyAlias = "turma"
            keyPassword = "turma-release"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    lint {
        // `assembleRelease` runs `lintVitalRelease` (a fatal-error gate that
        // `assembleDebug` — all this project's CI ever built before XERK-26 —
        // never ran), so switching the release pipeline to it surfaced one
        // latent false positive: InvalidFragmentVersionForActivityResult on
        // MainActivity's `registerForActivityResult`. That check assumes an
        // androidx.fragment is on the classpath and wants it ≥1.3.0, but this
        // app is Compose-only — MainActivity is a bare ComponentActivity and
        // nothing depends on fragment — so there is no Fragment whose version
        // could be wrong. Disable that one check; lintVital still gates the
        // rest of the release build.
        disable += "InvalidFragmentVersionForActivityResult"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // buildConfig: AGP 8 stops generating BuildConfig unless asked. It is what
    // lets debug-only behaviour actually be debug-only — see TerminalScreen's
    // setWebContentsDebuggingEnabled (XERK-235).
    buildFeatures { compose = true; buildConfig = true }

    // XERK-262. `core/` is fully gated by plain JVM tests, but the CALL SITES
    // were not: a mutation battery deleted `ModelSource.afterAttempt(...)`,
    // forced `composerOffers(...)` true and set `localModel = null` at a spawn
    // site, and the whole suite stayed green — a fix behind a call site nothing
    // reaches (qa.md §5.7). ViewModels need an Application and Composables need
    // a host Activity, so neither had anywhere to live.
    //
    // Robolectric supplies both INSIDE `testDebugUnitTest`, which is the one
    // Android gate CI actually runs (android-ci.yml). The alternative — Compose
    // tests in `androidTest` — would need an emulator job this repo does not
    // have, so those tests would never gate anything, which is the exact failure
    // this ticket exists to fix.
    //
    // `isIncludeAndroidResources` is what makes it work at all: Compose resolves
    // real resources, and without the merged resource table `createComposeRule`
    // fails at inflate time. `isReturnDefaultValues` is deliberately NOT set —
    // it would silently paper over an un-shadowed Android call in the existing
    // pure tests rather than failing it.
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Gradle defaults the test JVM to 512m, which is comfortable for
                // the pure `core/` tests and nowhere near enough once Robolectric
                // loads a whole instrumented android-all and Compose builds a
                // real semantics tree on top of it — it OOMs during the FIRST
                // composition, not at some later scale. Raised here rather than
                // in gradle.properties so it applies to the test JVM only, and
                // not to the compiler daemon that shares that file.
                it.maxHeapSize = "2g"
            }
        }
    }
    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // Window size classes drive the foldable/tablet adaptive layout (compact →
    // single pane, expanded → list-detail two pane). BOM-versioned.
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Persistence: DataStore for prefs, security-crypto for credentials.
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Inline image/SVG rendering in chat (XERK-221): Coil for <img>-style loading
    // of data: URIs + remote URLs, with the SVG decoder for data:image/svg+xml.
    // Reuses the app's OkHttp for remote fetches; SVG renders in Coil's secure
    // static mode (no scripts). HTML previews use a JS-disabled WebView instead.
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("io.coil-kt:coil-svg:2.7.0")

    // Networking + JSON.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter:1.0.0")

    // Firebase Cloud Messaging (push). The BOM is safe to include without a
    // google-services.json; FirebaseApp simply never initializes and push is
    // inert — see TurmaMessagingService / PushRegistrar.
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")

    // XERK-262 — the call-site harness. See the `testOptions` block above for
    // why this lives in the unit-test source set and not in androidTest.
    //
    // Robolectric 4.14.1 is the first release that ships an android-all for
    // SDK 35, which is this module's compileSdk/targetSdk; pinning an older one
    // forces every test to @Config(sdk=…) down to a platform the app does not
    // build against.
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core-ktx:1.6.1")
    // The compose-test artifacts are BOM-versioned like the rest of Compose, so
    // the test stack can never drift from the UI stack it drives.
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    // Supplies the ComponentActivity that `createComposeRule()` hosts. It is a
    // manifest-only artifact and must be `debugImplementation`, not
    // `testImplementation`: it is merged into the DEBUG app manifest, which is
    // the manifest Robolectric loads.
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    // Lets a ViewModel test drive the REAL Retrofit/OkHttp/kotlinx stack against
    // a scripted hub, rather than a fake HubApi that would prove only that the
    // fake was called. The hub's refusals are HTTP-shaped (a 409 with a JSON
    // `error` body), and `hubErrorMessage` digs the reason back out of exactly
    // that — a seam a hand-rolled fake would step over.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}

// Apply the Firebase plugin only when a real google-services.json is present.
// Keeps a credential-less build (CI, contributors without the Firebase project)
// green while wiring full FCM for whoever drops their config in.
if (File(projectDir, "google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
