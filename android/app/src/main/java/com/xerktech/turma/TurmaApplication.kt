package com.xerktech.turma

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.SvgDecoder
import com.xerktech.turma.push.Notifications
import com.xerktech.turma.push.PushRegistrar

class TurmaApplication : Application(), ImageLoaderFactory {
    lateinit var container: AppContainer
        private set

    // Coil's app-wide loader, taught to decode SVG (data:image/svg+xml) so chat
    // image previews (XERK-221) render inline. AsyncImage picks this up via the
    // ImageLoaderFactory. SVG is rasterized statically — no script execution.
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .components { add(SvgDecoder.Factory()) }
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
