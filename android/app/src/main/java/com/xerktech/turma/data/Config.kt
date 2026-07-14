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
 * The hub URL is user-editable here (unlike the glasses client's hardcoded URL —
 * a phone app should let the operator point at any hub / a LAN address).
 */
class Config private constructor(private val prefs: SharedPreferences) {

    private val _state = MutableStateFlow(read())
    val state: StateFlow<Settings> = _state

    data class Settings(
        val hubUrl: String = DEFAULT_HUB_URL,
        val user: String = "",
        val password: String = "",
    ) {
        val configured: Boolean get() = hubUrl.isNotBlank() && password.isNotBlank()

        /** Base URL guaranteed to end with a single '/', for Retrofit/WS building. */
        val baseUrl: String get() = hubUrl.trim().trimEnd('/') + "/"

        val authHeader: String
            get() = "Basic " + Base64.encodeToString(
                "$user:$password".toByteArray(Charsets.UTF_8), Base64.NO_WRAP
            )
    }

    private fun read() = Settings(
        hubUrl = prefs.getString(KEY_URL, DEFAULT_HUB_URL) ?: DEFAULT_HUB_URL,
        user = prefs.getString(KEY_USER, "") ?: "",
        password = prefs.getString(KEY_PASS, "") ?: "",
    )

    fun save(hubUrl: String, user: String, password: String) {
        prefs.edit()
            .putString(KEY_URL, hubUrl.trim())
            .putString(KEY_USER, user.trim())
            .putString(KEY_PASS, password)
            .apply()
        _state.value = read()
    }

    fun clear() {
        prefs.edit().remove(KEY_USER).remove(KEY_PASS).apply()
        _state.value = read()
    }

    val current: Settings get() = _state.value

    companion object {
        const val DEFAULT_HUB_URL = "https://turma.xerktech.com"
        private const val KEY_URL = "hub_url"
        private const val KEY_USER = "hub_user"
        private const val KEY_PASS = "hub_pass"

        @Volatile
        private var instance: Config? = null

        fun get(context: Context): Config = instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }

        private fun build(context: Context): Config {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                context,
                "turma_secure_prefs",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return Config(prefs)
        }
    }
}
