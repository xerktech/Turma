package com.xerktech.turma.data

import android.content.Context
import com.xerktech.turma.core.storedOrg
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The fleet-wide org pick (XERK-62), held once per process so every screen sees
 * the same scope — picking an org on the Board and walking to the Dashboard
 * keeps it, exactly as the web's shared `turma-org` localStorage key does.
 *
 * What is stored is the operator's LITERAL pick, not what currently applies: an
 * org nobody reports right now doesn't scope anything (`core.effectiveOrg`), but
 * the pick stays on disk so it resumes when that host comes back. Ordinary
 * SharedPreferences — a filter is not a credential.
 */
class OrgFilter(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _stored = MutableStateFlow(load())
    val stored: StateFlow<String> = _stored

    fun set(key: String) {
        _stored.value = key
        prefs.edit().putString(KEY, key).apply()
    }

    /**
     * First read migrates the board-only preference forward (and writes it here,
     * so the migration happens once) — see `core.storedOrg`.
     */
    private fun load(): String {
        val current = prefs.getString(KEY, null)
        if (current != null) return current
        val legacy = prefs.getString(LEGACY_KEY, null)
        val v = storedOrg(current, legacy) ?: return ""
        prefs.edit().putString(KEY, v).apply()
        return v
    }

    private companion object {
        // One prefs file, so the board's own key is right here to migrate from.
        const val PREFS = "turma_board"
        const val KEY = "orgFilter"
        const val LEGACY_KEY = "org"
    }
}
