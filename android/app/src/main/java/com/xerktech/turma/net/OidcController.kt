package com.xerktech.turma.net

import com.xerktech.turma.core.Oidc
import com.xerktech.turma.data.Config
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

/**
 * Drives the native Authentik SSO flow (XERK-591). Held in [AppContainer], NOT a
 * ViewModel, because the flow spans a Custom Tab round-trip: it is STARTED from
 * the login screen, but its outcome arrives as a `turma://oidc-callback` deep
 * link on the Activity — possibly after a process death and with a different
 * composable alive. A container-scoped controller both halves can reach keeps
 * the PKCE state and the UI status in one place; the login screen observes [ui]
 * and reacts to `configured` flipping true, exactly as the password path does.
 */
class OidcController(private val client: HubClient, private val config: Config) {

    data class Ui(
        val busy: Boolean = false,
        val error: String? = null,
        // Set when a Custom Tab should be launched; the screen launches it and
        // calls [launchConsumed] so a recomposition doesn't relaunch it.
        val launchUrl: String? = null,
    )

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui

    /** Clear any stale error/launch when the login screen re-arms the button. */
    fun reset() = _ui.update { Ui() }

    fun launchConsumed() = _ui.update { it.copy(launchUrl = null) }

    /**
     * Probe the hub at [hubUrl]; if it offers SSO, stash a fresh PKCE verifier
     * and produce the Custom Tab URL. Saves the hub URL (harmless — the app
     * stays UNCONFIGURED until the code is exchanged) so the deep-link handler
     * knows which hub to redeem against.
     */
    suspend fun begin(hubUrl: String) = withContext(Dispatchers.IO) {
        _ui.update { it.copy(busy = true, error = null, launchUrl = null) }
        val base = Config.Settings(hubUrl = hubUrl.trim()).baseUrl
        when (client.oidcEnabled(base)) {
            null -> _ui.update { it.copy(busy = false, error = "Could not reach the hub — check the URL.") }
            false -> _ui.update { it.copy(busy = false, error = "Single sign-on isn't enabled on this hub.") }
            true -> {
                val pkce = Oidc.newPkce()
                config.startOidc(hubUrl, pkce.verifier)
                _ui.update { it.copy(busy = false, launchUrl = Oidc.loginUrl(base, pkce.challenge)) }
            }
        }
    }

    /**
     * Handle the deep-link outcome. On success the token is stored (which flips
     * `configured` true, sending the app to the dashboard); on an error or a
     * failed exchange the reason lands on [ui] for the login screen to show.
     */
    suspend fun complete(code: String?, error: String?) {
        if (error != null) {
            _ui.update { it.copy(busy = false, launchUrl = null, error = ssoError(error)) }
            return
        }
        if (code.isNullOrEmpty()) return
        _ui.update { it.copy(busy = true, error = null, launchUrl = null) }
        val verifier = config.pendingOidcVerifier
        if (verifier.isEmpty()) {
            _ui.update { it.copy(busy = false, error = "Sign-in expired. Please try again.") }
            return
        }
        val token = client.oidcExchange(config.current.baseUrl, code, verifier)
        if (token == null) {
            _ui.update { it.copy(busy = false, error = "Single sign-on failed. Please try again.") }
            return
        }
        config.saveSession(token)
        _ui.update { it.copy(busy = false, error = null) }
    }

    // Mirrors login.html's OIDC_ERRORS wording.
    private fun ssoError(kind: String) = when (kind) {
        "forbidden" -> "You're signed in, but not in a group with access to this hub."
        else -> "Single sign-on failed. Please try again, or use the local credential below."
    }
}
