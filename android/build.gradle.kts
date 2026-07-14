// Top-level build file. Plugin versions are declared here with `apply false`
// and applied in :app. Kept in lockstep with the Compose compiler that ships
// with the Kotlin plugin (Kotlin 2.x has the Compose compiler built in).
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
    // Firebase (FCM). Applied conditionally in :app only when a real
    // google-services.json is present, so a credential-less CI build still works.
    id("com.google.gms.google-services") version "4.4.2" apply false
}
