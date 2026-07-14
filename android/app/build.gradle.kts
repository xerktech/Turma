import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// versionName tracks the repo-wide MAJOR.MINOR in the root VERSION file (repo
// convention — see CLAUDE.md), suffixed with the CI run number for a full
// version. versionCode is that run number (monotonic per build).
val repoVersion: String = File(rootDir.parentFile, "VERSION").takeIf { it.exists() }
    ?.readText()?.trim() ?: "0.0"
val runNumber: Int = (System.getenv("GITHUB_RUN_NUMBER") ?: "0").toIntOrNull() ?: 0

android {
    namespace = "com.xerktech.turma"
    compileSdk = 35
    // Pin the build-tools explicitly instead of inheriting AGP's default, which
    // for AGP 8.7.x is 34.0.0 — a version nothing else here installs. Left
    // unpinned, Gradle tries to auto-download it into the SDK, which fails on
    // any read-only SDK (the agent image ships build-tools 35.0.0 only, root-
    // owned, while sessions run as the host uid). Keep in lockstep with
    // ANDROID_BUILD_TOOLS in agent/Dockerfile and the android-ci.yml SDK step.
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.xerktech.turma"
        minSdk = 26
        targetSdk = 35
        versionCode = if (runNumber > 0) runNumber else 1
        versionName = "$repoVersion.$runNumber"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
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
