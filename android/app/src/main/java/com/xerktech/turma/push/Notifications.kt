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
    const val CH_SPEND = "turma_spend"

    fun createChannels(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        val channels = listOf(
            Triple(CH_QUESTION, "Questions", NotificationManager.IMPORTANCE_HIGH),
            // The hub's one per-session work alert (XERK-224). Keeps the channel
            // ID it had as "Turn finished" so an upgrade renames the operator's
            // existing channel in place rather than resetting its settings.
            Triple(CH_TURN, "Ready for review", NotificationManager.IMPORTANCE_DEFAULT),
            Triple(CH_PR, "Pull requests", NotificationManager.IMPORTANCE_DEFAULT),
            Triple(CH_HOST, "Host status", NotificationManager.IMPORTANCE_HIGH),
            // Runaway session spend. Its own channel rather than folding into
            // host status: this fires rarely and is worth muting or promoting
            // independently of whether a host went offline.
            Triple(CH_SPEND, "Session spend", NotificationManager.IMPORTANCE_DEFAULT),
            Triple(CH_ALERTS, "General alerts", NotificationManager.IMPORTANCE_DEFAULT),
        )
        for ((id, name, importance) in channels) {
            mgr.createNotificationChannel(NotificationChannel(id, name, importance))
        }
    }

    private fun channelFor(tags: String): String = when {
        tags.contains("question") -> CH_QUESTION
        // "mag" is the ready-for-review alert (XERK-224), which replaced the
        // separate turn-finished ("checkered_flag") and PR ("rocket") ones — both
        // still routed, since an older hub keeps sending them.
        tags.contains("mag") || tags.contains("checkered_flag") -> CH_TURN
        tags.contains("rocket") -> CH_PR
        // "key" is the Claude-login alert (XERK-98); "circle" also catches the
        // green_circle "login restored" notification. Both are host-level.
        // Runaway per-session spend. Checked BEFORE the host row, which already
        // claims "moneybag" — an older hub's host-level cost alert keeps that
        // channel, this per-session one gets its own. A build predating this
        // channel falls through to CH_ALERTS, so the alert still arrives.
        tags.contains("money_with_wings") -> CH_SPEND
        tags.contains("circle") || tags.contains("rotating_light") || tags.contains("moneybag") || tags.contains("key") -> CH_HOST
        else -> CH_ALERTS
    }

    // The notification id: a stable key derived from the hub's message so
    // repeated alerts of one kind collapse and a later `dismiss` can cancel this
    // exact one (XERK-154). Prefers the hub's explicit `notifKey` (question/PR/
    // turn each get a distinct one, so they coexist instead of clobbering each
    // other), falling back to session/host/title for host-level and older-hub
    // alerts that carry none.
    private fun idFor(data: Map<String, String>): Int =
        (data["notifKey"] ?: data["sessionId"] ?: data["host"] ?: data["title"] ?: "Turma").hashCode()

    fun show(context: Context, data: Map<String, String>) {
        // A retraction from the hub: the alert's subject was addressed elsewhere
        // (PR merged/closed, question answered, turn replied to), so cancel the
        // notification posted under the same key. It carries no title/body.
        if (data["action"] == "dismiss") {
            NotificationManagerCompat.from(context).cancel(idFor(data))
            return
        }
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
        // A per-alert request code so the tap routes to the right place and a
        // repeated alert of the same kind collapses onto its predecessor.
        val reqCode = idFor(data)
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
