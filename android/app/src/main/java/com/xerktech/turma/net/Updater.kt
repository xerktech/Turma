package com.xerktech.turma.net

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.xerktech.turma.core.AvailableUpdate
import com.xerktech.turma.core.ReleaseAssetView
import com.xerktech.turma.core.ReleaseView
import com.xerktech.turma.core.latestApkUpdate
import com.xerktech.turma.model.TurmaJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * In-app updater (XERK-11): checks the public GitHub releases for a newer
 * Android APK than what's installed, and — on the operator's tap — downloads it
 * and hands it to the system package installer. A stopgap until the app ships on
 * Google Play; the store path will supersede this, not replace what it needs.
 *
 * Read-only against GitHub over anonymous HTTPS (the repo is public, like
 * `bootstrap.sh`), so there is no token or hub credential involved — and it uses
 * its OWN OkHttpClient, deliberately WITHOUT [HubClient]'s Basic-auth
 * interceptor, so the hub password is never sent to github.com.
 *
 * The pure picking/compare logic is `core.Update`; this half is the I/O.
 */
class Updater(
    private val appContext: Context,
    private val scope: CoroutineScope,
    /** Installed versionName (e.g. "0.4.2"), read once from the package manager. */
    private val installedVersion: String,
) {
    sealed interface State {
        /** Nothing to show: not checked, up to date, offline, or dismissed. */
        data object Hidden : State
        data class Available(val version: String) : State
        data class Downloading(val version: String, val pct: Int?) : State

        /**
         * Downloaded and handed off (or waiting to be). [needsPermission] is set
         * when the OS won't let us request an install until the operator grants
         * "install unknown apps" for Turma — the banner then reads "Install" and
         * a re-tap retries once the setting is on.
         */
        data class ReadyToInstall(val version: String, val needsPermission: Boolean) : State
        data class Failed(val version: String?, val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Hidden)
    val state: StateFlow<State> = _state

    // The one client, no hub auth. Its own timeouts; downloads can be large.
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    private var pending: AvailableUpdate? = null
    private var downloaded: File? = null

    // Session-scoped: a version the operator dismissed stays hidden until a still
    // newer one appears. Deliberately not persisted — "regular checking" means it
    // resurfaces next launch, which is the reminder the ticket asks for.
    private var dismissedVersion: String? = null

    @Volatile private var checking = false
    @Volatile private var lastCheckAt = 0L

    /**
     * Check for an update. Throttled to [CHECK_THROTTLE_MS] so it's cheap to call
     * on every dashboard visit; pass [force] for an explicit "check now". Stays
     * quiet on failure (offline, rate-limit) — an update banner should never turn
     * into an error nag — leaving the state Hidden and logging.
     */
    fun check(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && (checking || now - lastCheckAt < CHECK_THROTTLE_MS)) return
        checking = true
        lastCheckAt = now
        scope.launch {
            try {
                val update = withContext(Dispatchers.IO) { fetchLatest() }
                if (update == null || update.version == dismissedVersion) {
                    // Don't clobber an in-flight download/install with a re-check.
                    if (_state.value is State.Hidden || _state.value is State.Available) {
                        _state.value = State.Hidden
                    }
                } else {
                    pending = update
                    if (_state.value is State.Hidden || _state.value is State.Available) {
                        _state.value = State.Available(update.version)
                    }
                }
            } catch (e: Exception) {
                Log.i(TAG, "update check failed: ${e.message}")
            } finally {
                checking = false
            }
        }
    }

    /** Hide the current offer for this session (until a newer version turns up). */
    fun dismiss() {
        (_state.value as? State.Available)?.let { dismissedVersion = it.version }
        _state.value = State.Hidden
    }

    /**
     * The banner's action button. Branches on the current state: download+install
     * a freshly-offered update, (re)launch the installer for an already-downloaded
     * one, resume once install permission is granted, or retry a failure.
     */
    fun act() {
        when (val s = _state.value) {
            is State.Available -> pending?.let { startDownload(it) }
            is State.ReadyToInstall -> downloaded?.let { install(s.version, it) }
            is State.Failed -> pending?.let { startDownload(it) }
            else -> {}
        }
    }

    private fun startDownload(u: AvailableUpdate) {
        _state.value = State.Downloading(u.version, null)
        scope.launch {
            val file = try {
                withContext(Dispatchers.IO) { download(u) }
            } catch (e: Exception) {
                Log.w(TAG, "update download failed", e)
                _state.value = State.Failed(u.version, "Download failed")
                return@launch
            }
            downloaded = file
            install(u.version, file)
        }
    }

    /**
     * Hand the APK to the system installer. On API 26+ an app must be granted
     * "install unknown apps"; if it isn't yet, send the operator to that settings
     * screen and leave the banner offering "Install" so the retap installs once
     * they're back. The OS verifies the signature on install, which is the real
     * integrity gate for updating an already-installed app (why, unlike the
     * native updater's file-swap, we don't re-verify a sha here).
     */
    private fun install(version: String, file: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !appContext.packageManager.canRequestPackageInstalls()
        ) {
            _state.value = State.ReadyToInstall(version, needsPermission = true)
            runCatching {
                appContext.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${appContext.packageName}"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return
        }
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.updates", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            appContext.startActivity(intent)
            // Keep the banner as a re-tap in case the operator backs out of the
            // system installer; a completed update bumps the app, so the next
            // check goes Hidden on its own.
            _state.value = State.ReadyToInstall(version, needsPermission = false)
        } catch (e: Exception) {
            Log.w(TAG, "install intent failed", e)
            _state.value = State.Failed(version, "Couldn't open installer")
        }
    }

    private fun fetchLatest(): AvailableUpdate? {
        val req = Request.Builder()
            .url("https://api.github.com/repos/$REPO/releases?per_page=$RELEASES_PAGE")
            .header("Accept", "application/vnd.github+json")
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            val body = resp.body?.string() ?: throw IOException("empty body")
            val releases = TurmaJson.decodeFromString<List<GhRelease>>(body)
            val views = releases.map { r ->
                ReleaseView(
                    draft = r.draft,
                    prerelease = r.prerelease,
                    assets = r.assets.map { ReleaseAssetView(it.name, it.browserDownloadUrl) },
                )
            }
            return latestApkUpdate(views, installedVersion)
        }
    }

    private fun download(u: AvailableUpdate): File {
        val dir = File(appContext.cacheDir, "updates").apply { mkdirs() }
        // Only ever keep the one APK we're installing now.
        dir.listFiles()?.forEach { if (it.name.endsWith(".apk")) it.delete() }
        val out = File(dir, "turma-${u.version}.apk")
        val req = Request.Builder().url(u.downloadUrl).build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            val bodyStream = resp.body?.byteStream() ?: throw IOException("empty body")
            val total = resp.body?.contentLength() ?: -1L
            var lastPct = -1
            bodyStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var read = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val pct = ((read * 100) / total).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                _state.value = State.Downloading(u.version, pct)
                            }
                        }
                    }
                }
            }
        }
        return out
    }

    @Serializable
    private data class GhRelease(
        val draft: Boolean = false,
        val prerelease: Boolean = false,
        val assets: List<GhAsset> = emptyList(),
    )

    @Serializable
    private data class GhAsset(
        val name: String = "",
        @SerialName("browser_download_url") val browserDownloadUrl: String = "",
    )

    companion object {
        private const val TAG = "Updater"
        private const val REPO = "xerktech/turma"
        private const val RELEASES_PAGE = 20
        private const val CHECK_THROTTLE_MS = 15 * 60 * 1000L // 15 min
    }
}
