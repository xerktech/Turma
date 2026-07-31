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
    buildFeatures { compose = true }
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
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}

// Apply the Firebase plugin only when a real google-services.json is present.
// Keeps a credential-less build (CI, contributors without the Firebase project)
// green while wiring full FCM for whoever drops their config in.
if (File(projectDir, "google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
