package com.xerktech.turma.core

/**
 * Pure logic for the in-app updater (XERK-11): picking the newest published
 * Android APK out of the GitHub release list and deciding whether it is newer
 * than what's installed. The network fetch + download + install live in
 * `net.Updater`; this stays pure and JVM-tested, matching the `core/` split.
 *
 * Distribution model (see `.github/scripts/manifest.js`): every release is
 * self-contained — a component unchanged in a release still carries its own APK
 * forward onto that release under its ORIGINAL name (`turma-android-v<x>.apk`).
 * So the version baked into the asset FILENAME is the component's real version,
 * and the newest release always carries the current APK. We compare that
 * filename version against the installed `versionName` — never the release TAG,
 * which runs ahead of a carried component (the same reason the native updater
 * compares the manifest component version, not the tag).
 */

private val APK_NAME = Regex("""^turma-android-v(\d+\.\d+\.\d+)\.apk$""")

/** Parse the semver out of a `turma-android-v<x.y.z>.apk` asset name, else null. */
fun apkAssetVersion(name: String): String? = APK_NAME.matchEntire(name.trim())?.groupValues?.get(1)

/**
 * Compare two dotted-numeric versions. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * Missing/short components read as 0 (`0.4` == `0.4.0`); a non-numeric component
 * (a dev/placeholder version) reads as 0 rather than throwing.
 */
fun compareVersions(a: String, b: String): Int {
    val pa = a.trim().split('.')
    val pb = b.trim().split('.')
    for (i in 0 until maxOf(pa.size, pb.size)) {
        val x = pa.getOrNull(i)?.toIntOrNull() ?: 0
        val y = pb.getOrNull(i)?.toIntOrNull() ?: 0
        if (x != y) return x - y
    }
    return 0
}

/** An APK newer than what's installed, ready to offer to the operator. */
data class AvailableUpdate(val version: String, val downloadUrl: String)

/** Minimal projection of a GitHub release the picker needs, decoupled from wire shapes. */
data class ReleaseView(val draft: Boolean, val prerelease: Boolean, val assets: List<ReleaseAssetView>)

data class ReleaseAssetView(val name: String, val downloadUrl: String)

/**
 * Given the parsed release list and the installed `versionName`, return the
 * newest publishable APK strictly newer than installed, or null if none exists
 * or we're already current. Draft and prerelease entries are skipped, and EVERY
 * APK across the recent releases is considered (not only the single "latest"
 * release) so a carried-forward asset can't hide a build.
 */
fun latestApkUpdate(releases: List<ReleaseView>, installed: String): AvailableUpdate? {
    var best: AvailableUpdate? = null
    for (r in releases) {
        if (r.draft || r.prerelease) continue
        for (a in r.assets) {
            val v = apkAssetVersion(a.name) ?: continue
            if (best == null || compareVersions(v, best.version) > 0) {
                best = AvailableUpdate(v, a.downloadUrl)
            }
        }
    }
    return best?.takeIf { compareVersions(it.version, installed) > 0 }
}
