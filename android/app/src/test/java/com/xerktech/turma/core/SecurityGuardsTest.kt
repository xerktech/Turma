package com.xerktech.turma.core

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards for two security fixes that nothing else in the repo can detect
 * (XERK-235). A QA pass reverted each of them and found that
 * `testDebugUnitTest`, `lintVitalRelease` and the repo's semgrep invocation all
 * stayed green — and `android-ci.yml` runs only the first and `assembleDebug`,
 * so `lintVitalRelease` never even runs on a PR.
 *
 * These read the SOURCE rather than the built artifact, because a unit test has
 * no APK. That is a real limit: they prove the call is guarded and the manifest
 * declares the rules, not that the packaged APK honours them. The APK-level
 * checks (`BuildConfig.DEBUG=false`, the string absent from `classes.dex`,
 * `aapt2 dump xmltree`) are recorded in the PR instead.
 */
class SecurityGuardsTest {

    private fun repoFile(rel: String): File {
        // Tests run with the module dir (android/app) as cwd.
        val f = File(rel)
        assertTrue("missing $rel (cwd=${File(".").absolutePath})", f.isFile)
        return f
    }

    @Test fun `WebView remote debugging is never enabled unconditionally`() {
        // Unguarded, every RELEASE APK the in-app updater installs ships a
        // remotely inspectable WebView holding the hub session cookie and the
        // live terminal.
        val src = repoFile("src/main/java/com/xerktech/turma/ui/TerminalScreen.kt").readText()
        val calls = Regex("""^[^\n]*setWebContentsDebuggingEnabled\([^)]*\)""", RegexOption.MULTILINE)
            .findAll(src).map { it.value }.toList()
        assertTrue("expected the call to still exist", calls.isNotEmpty())
        for (line in calls) {
            assertTrue(
                "setWebContentsDebuggingEnabled must be behind BuildConfig.DEBUG, got: ${line.trim()}",
                line.contains("BuildConfig.DEBUG"),
            )
        }
    }

    @Test fun `both prefs stores are excluded from backup and device transfer`() {
        // Config.build() falls back to PLAINTEXT prefs when the keystore is
        // unavailable, on the reasoning that app-private storage bounds the
        // exposure. Auto-backup and `adb backup` lift private storage off the
        // device, which is that exact boundary.
        val manifest = repoFile("src/main/AndroidManifest.xml").readText()
        assertTrue("manifest must wire fullBackupContent",
            manifest.contains("android:fullBackupContent"))
        assertTrue("manifest must wire dataExtractionRules",
            manifest.contains("android:dataExtractionRules"))

        val stores = listOf("turma_prefs", "turma_secure_prefs")

        val backup = repoFile("src/main/res/xml/backup_rules.xml").readText()
        for (s in stores) {
            assertTrue("backup_rules.xml must exclude $s", backup.contains(s))
        }

        // API 31+ splits the two directions; an entry under only one of them
        // still leaks through the other.
        val extraction = repoFile("src/main/res/xml/data_extraction_rules.xml").readText()
        for (section in listOf("cloud-backup", "device-transfer")) {
            val body = extraction.substringAfter("<$section", "").substringBefore("</$section>", "")
            assertFalse("data_extraction_rules.xml is missing a <$section> section", body.isEmpty())
            for (s in stores) {
                assertTrue("<$section> must exclude $s", body.contains(s))
            }
        }
    }
}
