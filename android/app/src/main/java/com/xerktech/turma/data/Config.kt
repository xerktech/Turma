package com.xerktech.turma.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Hub connection config + credentials, persisted in EncryptedSharedPreferences.
 * The hub URL is user-editable here — a phone app should let the operator
 * point at any hub / a LAN address.
 */
class Config private constructor(private val prefs: SharedPreferences) {

    private val _state = MutableStateFlow(read())
    val state: StateFlow<Settings> = _state

    data class Settings(
        val hubUrl: String = DEFAULT_HUB_URL,
        val user: String = "",
        val password: String = "",
        // The opaque hub_session token — the SAME one the web cookie carries —
        // from either the native Authentik SSO flow (XERK-591) or a password
        // sign-in through POST /api/login (XERK-2569). When present, requests
        // authenticate with it as a Cookie; Basic auth is only the fallback for
        // a hub that issued none (the hub checks Basic against its break-glass
        // credential alone, never a local account).
        val sessionToken: String = "",
    ) {
        // Signed in either way: a stored password OR a session token.
        val configured: Boolean get() = hubUrl.isNotBlank() && (password.isNotBlank() || sessionToken.isNotBlank())

        /**
         * Base URL guaranteed to end with a single '/' and carry a scheme, for
         * Retrofit/WS building. With no hub set yet it returns a harmless
         * placeholder (never requested — the login screen saves a real URL before
         * any call), so Retrofit can be constructed without a hub configured. A
         * scheme-less host the operator typed (`myhub.com`) is promoted to https.
         */
        val baseUrl: String
            get() {
                var u = hubUrl.trim().trimEnd('/')
                if (u.isBlank()) return "http://localhost/"
                if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
                return "$u/"
            }

        val authHeader: String
            get() = "Basic " + Base64.encodeToString(
                "$user:$password".toByteArray(Charsets.UTF_8), Base64.NO_WRAP
            )
    }

    private fun read() = Settings(
        hubUrl = prefs.getString(KEY_URL, DEFAULT_HUB_URL) ?: DEFAULT_HUB_URL,
        user = prefs.getString(KEY_USER, "") ?: "",
        password = prefs.getString(KEY_PASS, "") ?: "",
        sessionToken = prefs.getString(KEY_SESSION, "") ?: "",
    )

    /**
     * Store a password sign-in. [sessionToken] is the `hub_session` that
     * POST /api/login returned (XERK-2569), or empty when the hub issued none and
     * the app falls back to Basic. Either way it supersedes any prior SSO token.
     * The password is kept so [com.xerktech.turma.net.HubClient] can sign in
     * again when the session lapses.
     */
    fun save(hubUrl: String, user: String, password: String, sessionToken: String = "") {
        val edit = prefs.edit()
            .putString(KEY_URL, hubUrl.trim())
            .putString(KEY_USER, user.trim())
            .putString(KEY_PASS, password)
        if (sessionToken.isNotEmpty()) edit.putString(KEY_SESSION, sessionToken) else edit.remove(KEY_SESSION)
        edit.apply()
        _state.value = read()
    }

    /**
     * Persist the hub URL and stash the PKCE verifier before launching the SSO
     * Custom Tab (XERK-591). Deliberately does NOT set a credential, so the app
     * stays UNCONFIGURED until the handoff code is exchanged — a flow abandoned
     * in the browser leaves no half-signed-in state.
     */
    fun startOidc(hubUrl: String, verifier: String) {
        prefs.edit()
            .putString(KEY_URL, hubUrl.trim())
            .putString(KEY_OIDC_VERIFIER, verifier)
            .apply()
        _state.value = read()
    }

    /** The verifier stashed by [startOidc], read when the deep link returns. */
    val pendingOidcVerifier: String get() = prefs.getString(KEY_OIDC_VERIFIER, "") ?: ""

    /** Store the SSO session token and clear the one-shot pending verifier. */
    fun saveSession(token: String) {
        prefs.edit()
            .putString(KEY_SESSION, token)
            .remove(KEY_OIDC_VERIFIER)
            .apply()
        _state.value = read()
    }

    /**
     * Drop ONLY the session token — used when the hub 401s a session (the
     * shorter OIDC TTL lapsed, or the user was removed from an access group) and
     * no fresh one could be had. Leaves a stored password intact, so the app
     * falls back to Basic. `configured` flips false when no password remains,
     * sending the app back to the login screen to re-authenticate.
     */
    fun clearSession() {
        if (prefs.getString(KEY_SESSION, "").isNullOrEmpty()) return
        prefs.edit().remove(KEY_SESSION).apply()
        _state.value = read()
    }

    fun clear() {
        prefs.edit()
            .remove(KEY_USER).remove(KEY_PASS)
            .remove(KEY_SESSION).remove(KEY_OIDC_VERIFIER)
            .apply()
        _state.value = read()
    }

    val current: Settings get() = _state.value

    companion object {
        // No baked-in hub; the operator enters it on the login screen.
        const val DEFAULT_HUB_URL = ""
        private const val KEY_URL = "hub_url"
        private const val KEY_USER = "hub_user"
        private const val KEY_PASS = "hub_pass"
        private const val KEY_SESSION = "hub_session_token"
        private const val KEY_OIDC_VERIFIER = "oidc_pending_verifier"

        private const val SECURE_PREFS = "turma_secure_prefs"
        private const val PLAIN_PREFS = "turma_prefs"

        @Volatile
        private var instance: Config? = null

        fun get(context: Context): Config = instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }

        // Build the config store, guaranteeing this never throws — it runs in
        // Application.onCreate, so any exception here silently kills the whole
        // app on launch with no visible error. EncryptedSharedPreferences (the
        // deprecated security-crypto lib) can throw on create() when its keyset
        // is corrupt or the Android keystore is unavailable; we recover, and as
        // a last resort fall back to plaintext app-private prefs so the app
        // still starts (private storage, so the credential exposure is bounded).
        private fun build(context: Context): Config {
            val prefs = securePrefs(context)
                ?: context.getSharedPreferences(PLAIN_PREFS, Context.MODE_PRIVATE)
            return Config(prefs)
        }

        private fun securePrefs(context: Context): SharedPreferences? = try {
            createEncrypted(context)
        } catch (_: Throwable) {
            // A corrupt keyset makes create() throw every launch. Wipe the
            // encrypted store and retry once; if it still fails, give up (the
            // caller falls back to plaintext) rather than crash.
            runCatching { context.deleteSharedPreferences(SECURE_PREFS) }
            runCatching { createEncrypted(context) }.getOrNull()
        }

        private fun createEncrypted(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                SECURE_PREFS,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
    }
}
