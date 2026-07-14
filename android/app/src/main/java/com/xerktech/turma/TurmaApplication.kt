package com.xerktech.turma

import android.app.Application
import com.xerktech.turma.push.Notifications
import com.xerktech.turma.push.PushRegistrar

class TurmaApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifications.createChannels(this)
        // Register this device's FCM token with the hub (no-op if Firebase or
        // the hub credentials aren't configured yet; retried after sign-in).
        PushRegistrar.register(this, container)
    }
}
