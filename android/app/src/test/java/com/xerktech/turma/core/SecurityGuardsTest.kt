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

        // Assert on the whole <exclude> ELEMENT, not merely that the filename
        // appears. Flipping <exclude> to <include> keeps every name present and
        // INVERTS the meaning — under include semantics Android backs up only
        // the listed paths, making these two files the only things backed up.
        // A name-presence check stayed green through exactly that mutation.
        fun excludes(xml: String, store: String) =
            Regex("""<exclude[^>]*domain\s*=\s*"sharedpref"[^>]*path\s*=\s*"$store\.xml"""")
                .containsMatchIn(xml)

        val backup = repoFile("src/main/res/xml/backup_rules.xml").readText()
        assertFalse("backup_rules.xml must not use <include> — it inverts the rule",
            backup.contains("<include"))
        for (s in stores) {
            assertTrue("backup_rules.xml must <exclude> $s.xml from sharedpref", excludes(backup, s))
        }

        // API 31+ splits the two directions; an entry under only one of them
        // still leaks through the other.
        val extraction = repoFile("src/main/res/xml/data_extraction_rules.xml").readText()
        assertFalse("data_extraction_rules.xml must not use <include> — it inverts the rule",
            extraction.contains("<include"))
        for (section in listOf("cloud-backup", "device-transfer")) {
            val body = extraction.substringAfter("<$section", "").substringBefore("</$section>", "")
            assertFalse("data_extraction_rules.xml is missing a <$section> section", body.isEmpty())
            for (s in stores) {
                assertTrue("<$section> must <exclude> $s.xml from sharedpref", excludes(body, s))
            }
        }
    }
}
