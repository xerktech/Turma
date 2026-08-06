package com.xerktech.turma.data

import android.content.Context
import com.xerktech.turma.core.storedOrg
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The fleet-wide org selection (XERK-62; multi-select per XERK-222), held once
 * per process so every screen sees the same scope — selecting orgs on the Board
 * and walking to the Dashboard keeps them, exactly as the web's shared
 * `turma-org` localStorage key does. An empty set means every org.
 *
 * What is stored is the operator's LITERAL selection, not what currently
 * applies: an org nobody reports right now doesn't scope anything
 * (`core.effectiveOrgs`), but the selection stays on disk so it resumes when
 * that host comes back. Ordinary SharedPreferences — a filter is not a
 * credential.
 */
class OrgFilter(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _stored = MutableStateFlow(load())
    val stored: StateFlow<Set<String>> = _stored

    fun set(keys: Set<String>) {
        _stored.value = keys
        prefs.edit().putStringSet(KEY_SET, keys).apply()
    }

    /** Flip one org in or out of the selection (XERK-222). */
    fun toggle(key: String) {
        set(if (key in _stored.value) _stored.value - key else _stored.value + key)
    }

    /**
     * First read migrates the older single-org preferences forward (and writes
     * the set, so the migration happens once): the pre-multi single-key value,
     * else the board-only pick — see `core.storedOrg`. A pre-multi single pick
     * becomes a one-org selection, so it survives the upgrade.
     */
    private fun load(): Set<String> {
        // getStringSet's return must not be mutated — copy defensively.
        prefs.getStringSet(KEY_SET, null)?.let { return it.toSet() }
        val v = storedOrg(prefs.getString(KEY, null), prefs.getString(LEGACY_KEY, null))
        val keys = if (v.isNullOrBlank()) emptySet() else setOf(v)
        prefs.edit().putStringSet(KEY_SET, keys).apply()
        return keys
    }

    private companion object {
        // One prefs file, so the older keys are right here to migrate from.
        const val PREFS = "turma_board"
        const val KEY_SET = "orgFilterSet"
        const val KEY = "orgFilter"
        const val LEGACY_KEY = "org"
    }
}
