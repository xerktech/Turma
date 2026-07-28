package com.xerktech.turma.data

import android.content.Context
import com.xerktech.turma.core.TextSize
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The fleet-wide chat text size (XERK-144), held once per process so every
 * session's chat renders at the operator's chosen size. Unlike verbosity (which
 * `ChatViewModel` keys per-session) the ticket wants ONE size for all sessions,
 * so it lives here rather than in a per-session ViewModel. Ordinary
 * SharedPreferences — a display preference is not a credential.
 */
class TextSizePref(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _size = MutableStateFlow(TextSize.fromOrdinal(prefs.getInt(KEY, TextSize.DEFAULT.ordinal)))
    val size: StateFlow<TextSize> = _size

    fun set(size: TextSize) {
        _size.value = size
        prefs.edit().putInt(KEY, size.ordinal).apply()
    }

    private companion object {
        const val PREFS = "turma_prefs"
        const val KEY = "chatTextSize"
    }
}
