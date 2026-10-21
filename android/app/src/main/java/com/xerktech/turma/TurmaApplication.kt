package com.xerktech.turma

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import com.xerktech.turma.push.Notifications
import com.xerktech.turma.push.PushRegistrar
import okhttp3.OkHttpClient

class TurmaApplication : Application(), ImageLoaderFactory {
    lateinit var container: AppContainer
        private set

    // Coil's app-wide loader, taught to decode SVG (data:image/svg+xml) so chat
    // image previews (XERK-221) render inline. AsyncImage picks this up via the
    // ImageLoaderFactory. SVG is rasterized statically — no script execution — and
    // only past SafeSvgDecoder's DOCTYPE check (an entity bomb never reaches it). Its
    // HTTP client keeps the type a server sent (ServedContentType): a remote SVG
    // renders only when served as image/svg+xml, as in a browser.
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient { OkHttpClient.Builder().addInterceptor(ServedContentType).build() }
            // A cache of its own: entries the old loader stored keep the type it didn't
            // relabel, so a text/plain .svg would still render from them. Built lazily on
            // the first fetch (off the main thread), which is where the old one is dropped.
            .diskCache {
                cacheDir.resolve("image_cache").deleteRecursively()
                DiskCache.Builder().directory(cacheDir.resolve("image_cache_served_type")).build()
            }
            .components(turmaImageComponents())
            .crossfade(true)
            .build()

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // Non-essential startup work is guarded so a notification-channel or
        // FCM hiccup can never silently take down the app on launch.
        runCatching { Notifications.createChannels(this) }
        // Register this device's FCM token with the hub (no-op if Firebase or
        // the hub credentials aren't configured yet; retried after sign-in).
        runCatching { PushRegistrar.register(this, container) }
        // Check GitHub for a newer APK (XERK-11). Quiet on failure; the banner
        // only surfaces on the Dashboard when there's actually an update.
        runCatching { container.updater.check() }
    }
}
