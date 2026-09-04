package com.xerktech.turma

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
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
    private var oidcLink by mutableStateOf<OidcLink?>(null)

    data class DeepLink(val host: String?, val sessionId: String?, val url: String?)

    /** The native SSO callback (XERK-591): the outcome the hub deep-linked back. */
    data class OidcLink(val code: String?, val error: String?)

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        deepLink = intent?.toDeepLink()
        oidcLink = intent?.toOidcLink()
        maybeRequestNotifications()

        val container = (application as TurmaApplication).container
        setContent {
            TurmaTheme {
                // Expanded width (≥840dp: tablets, unfolded foldables, large
                // landscape) drives the sessions list-detail two-pane; anything
                // narrower stays single-pane. calculateWindowSizeClass re-reads
                // the live window metrics, so folding/unfolding reflows the UI.
                val wide = calculateWindowSizeClass(this).widthSizeClass ==
                    WindowWidthSizeClass.Expanded
                TurmaApp(
                    container = container,
                    wide = wide,
                    pendingDeepLink = deepLink,
                    onDeepLinkConsumed = { deepLink = null },
                    pendingOidc = oidcLink,
                    onOidcConsumed = { oidcLink = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLink = intent.toDeepLink()
        oidcLink = intent.toOidcLink()
    }

    private fun Intent.toDeepLink(): DeepLink? {
        val host = getStringExtra(EXTRA_HOST)
        val session = getStringExtra(EXTRA_SESSION)
        val url = getStringExtra(EXTRA_URL)
        return if (host == null && session == null && url == null) null
        else DeepLink(host, session, url)
    }

    // The SSO Custom Tab returns via a `turma://oidc-callback?code=…|error=…`
    // VIEW intent (XERK-591). Parsed here off the intent data; the flow's PKCE
    // verifier is held in Config, so only the outcome needs to travel.
    private fun Intent.toOidcLink(): OidcLink? {
        val data = this.data ?: return null
        if (data.scheme != "turma" || data.host != "oidc-callback") return null
        val code = data.getQueryParameter("code")
        val error = data.getQueryParameter("error")
        return if (code == null && error == null) null else OidcLink(code, error)
    }

    private fun maybeRequestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
