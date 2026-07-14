package com.xerktech.turma.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.xerktech.turma.TurmaApplication

/**
 * Receives FCM data messages from the hub and renders them as local
 * notifications (channel + deep-link chosen from the message data). Declared in
 * the manifest but only ever invoked when a real FirebaseApp is initialized, so
 * a build without google-services.json simply never runs this.
 */
class TurmaMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data.isEmpty()) return
        Notifications.show(applicationContext, data)
    }

    override fun onNewToken(token: String) {
        val app = application as? TurmaApplication ?: return
        PushRegistrar.onNewToken(applicationContext, app.container, token)
    }
}
