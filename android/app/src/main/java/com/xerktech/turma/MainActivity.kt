package com.xerktech.turma

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.xerktech.turma.ui.TurmaApp
import com.xerktech.turma.ui.theme.TurmaTheme

/** Single-activity host. Handles FCM deep-link extras (host/sessionId/url). */
class MainActivity : ComponentActivity() {

    companion object {
        const val EXTRA_HOST = "host"
        const val EXTRA_SESSION = "sessionId"
        const val EXTRA_URL = "url"
    }

    private var deepLink by mutableStateOf<DeepLink?>(null)

    data class DeepLink(val host: String?, val sessionId: String?, val url: String?)

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        deepLink = intent?.toDeepLink()
        maybeRequestNotifications()

        val container = (application as TurmaApplication).container
        setContent {
            TurmaTheme {
                TurmaApp(
                    container = container,
                    pendingDeepLink = deepLink,
                    onDeepLinkConsumed = { deepLink = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLink = intent.toDeepLink()
    }

    private fun Intent.toDeepLink(): DeepLink? {
        val host = getStringExtra(EXTRA_HOST)
        val session = getStringExtra(EXTRA_SESSION)
        val url = getStringExtra(EXTRA_URL)
        return if (host == null && session == null && url == null) null
        else DeepLink(host, session, url)
    }

    private fun maybeRequestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
