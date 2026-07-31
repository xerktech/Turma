package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateTest {

    // ---- apkAssetVersion -----------------------------------------------------

    @Test fun parsesApkName() {
        assertEquals("0.4.2", apkAssetVersion("turma-android-v0.4.2.apk"))
        assertEquals("1.10.0", apkAssetVersion("turma-android-v1.10.0.apk"))
        assertEquals("0.4.2", apkAssetVersion("  turma-android-v0.4.2.apk  "))
    }

    @Test fun rejectsOtherAssets() {
        assertNull(apkAssetVersion("turma-hud-v0.4.0.ehpk"))
        assertNull(apkAssetVersion("turma-agent-native-v0.4.1.tar.gz"))
        assertNull(apkAssetVersion("manifest.json"))
        assertNull(apkAssetVersion("turma-android-v0.4.apk")) // not a full semver
        assertNull(apkAssetVersion("turma-android-v0.4.2.apk.sha256"))
    }

    // ---- compareVersions -----------------------------------------------------

    @Test fun comparesVersions() {
        assertTrue(compareVersions("0.4.2", "0.4.1") > 0)
        assertTrue(compareVersions("0.4.1", "0.4.2") < 0)
        assertEquals(0, compareVersions("0.4.2", "0.4.2"))
        assertTrue(compareVersions("0.10.0", "0.9.9") > 0) // numeric, not lexical
        assertTrue(compareVersions("1.0.0", "0.99.99") > 0)
    }

    @Test fun comparesShortAndNonNumericLeniently() {
        assertEquals(0, compareVersions("0.4", "0.4.0"))       // missing reads as 0
        assertTrue(compareVersions("0.4.2", "0.4") > 0)
        assertEquals(0, compareVersions("x.y.z", "0.0.0"))     // non-numeric reads as 0
    }

    // ---- latestApkUpdate -----------------------------------------------------

    private fun rel(vararg apk: String, draft: Boolean = false, prerelease: Boolean = false) =
        ReleaseView(draft, prerelease, apk.map { ReleaseAssetView(it, "https://dl/$it") })

    @Test fun offersNewerApk() {
        val releases = listOf(rel("turma-android-v0.4.2.apk", "manifest.json"))
        val u = latestApkUpdate(releases, "0.4.1")
        assertEquals("0.4.2", u?.version)
        assertEquals("https://dl/turma-android-v0.4.2.apk", u?.downloadUrl)
    }

    @Test fun noOfferWhenCurrentOrAhead() {
        val releases = listOf(rel("turma-android-v0.4.2.apk"))
        assertNull(latestApkUpdate(releases, "0.4.2"))
        assertNull(latestApkUpdate(releases, "0.5.0"))
    }

    @Test fun picksHighestAcrossReleasesRegardlessOfOrder() {
        // Newest release CARRIES an older APK; the highest lives on an earlier
        // release. The picker considers every release, so it still finds it.
        val releases = listOf(
            rel("turma-android-v0.4.0.apk"), // v0.4.2 release, android carried
            rel("turma-android-v0.4.3.apk"), // the release that actually built it
            rel("turma-android-v0.4.0.apk"),
        )
        assertEquals("0.4.3", latestApkUpdate(releases, "0.4.0")?.version)
    }

    @Test fun ignoresDraftAndPrerelease() {
        val releases = listOf(
            rel("turma-android-v0.9.0.apk", draft = true),
            rel("turma-android-v0.9.1.apk", prerelease = true),
            rel("turma-android-v0.4.2.apk"),
        )
        assertEquals("0.4.2", latestApkUpdate(releases, "0.4.1")?.version)
    }

    @Test fun noApkAssetsMeansNoOffer() {
        val releases = listOf(rel("manifest.json", "turma-hud-v0.4.0.ehpk"))
        assertNull(latestApkUpdate(releases, "0.4.0"))
    }
}
