package com.xerktech.turma.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.xerktech.turma.MainActivity
import com.xerktech.turma.R

/**
 * Notification channels + rendering for FCM-delivered alerts. The hub sends
 * DATA messages (turma/push.js) carrying {title, body, tags, priority, host,
 * sessionId}; we pick the channel from `tags` and deep-link a tap via the
 * host/sessionId extras (handled in MainActivity).
 */
object Notifications {

    const val CH_ALERTS = "turma_alerts"
    const val CH_QUESTION = "turma_question"
    const val CH_TURN = "turma_turn"
    const val CH_PR = "turma_pr"
    const val CH_HOST = "turma_host"

    fun createChannels(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        val channels = listOf(
            Triple(CH_QUESTION, "Questions", NotificationManager.IMPORTANCE_HIGH),
            Triple(CH_TURN, "Turn finished", NotificationManager.IMPORTANCE_DEFAULT),
            Triple(CH_PR, "Pull requests", NotificationManager.IMPORTANCE_DEFAULT),
            Triple(CH_HOST, "Host status", NotificationManager.IMPORTANCE_HIGH),
            Triple(CH_ALERTS, "General alerts", NotificationManager.IMPORTANCE_DEFAULT),
        )
        for ((id, name, importance) in channels) {
            mgr.createNotificationChannel(NotificationChannel(id, name, importance))
        }
    }

    private fun channelFor(tags: String): String = when {
        tags.contains("question") -> CH_QUESTION
        tags.contains("checkered_flag") -> CH_TURN
        tags.contains("rocket") -> CH_PR
        // "key" is the Claude-login alert (XERK-98); "circle" also catches the
        // green_circle "login restored" notification. Both are host-level.
        tags.contains("circle") || tags.contains("rotating_light") || tags.contains("moneybag") || tags.contains("key") -> CH_HOST
        else -> CH_ALERTS
    }

    fun show(context: Context, data: Map<String, String>) {
        val title = data["title"] ?: "Turma"
        val body = data["body"] ?: ""
        val tags = data["tags"] ?: ""
        val host = data["host"]
        val sessionId = data["sessionId"]

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            host?.let { putExtra(MainActivity.EXTRA_HOST, it) }
            sessionId?.let { putExtra(MainActivity.EXTRA_SESSION, it) }
            data["click"]?.let { putExtra(MainActivity.EXTRA_URL, it) }
        }
        // A per-session/host request code so the tap routes to the right place
        // and repeated alerts for one session collapse rather than stack.
        val reqCode = (sessionId ?: host ?: title).hashCode()
        val pending = PendingIntent.getActivity(
            context, reqCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notif = NotificationCompat.Builder(context, channelFor(tags))
            .setSmallIcon(R.drawable.ic_stat_turma)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        if (NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            try {
                NotificationManagerCompat.from(context).notify(reqCode, notif)
            } catch (_: SecurityException) {
                // POST_NOTIFICATIONS not granted — silently skip.
            }
        }
    }
}
