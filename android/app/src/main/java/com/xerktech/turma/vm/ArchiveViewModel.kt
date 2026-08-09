package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.HISTORY_MIN_QUERY
import com.xerktech.turma.model.ArchiveTranscript
import com.xerktech.turma.model.SearchGroup
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The hub's durable archive: full-text search over every ended session, and the
 * read-only transcript behind a result.
 *
 * Both halves are hub-local (the hub pulled each ended transcript into its own
 * store), so they answer for hosts that are offline or gone. Search feeds the
 * Sessions list's "In history" section (XERK-243); the transcript feeds
 * `EndedSessionView`.
 */
class ArchiveViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container

    data class Ui(
        val query: String = "",
        /**
         * The trimmed query [groups] belongs to — what the UI compares the typed
         * query against while the debounce runs, so stale results are never
         * rendered under a newer query.
         */
        val searchedQuery: String = "",
        val searching: Boolean = false,
        val groups: List<SearchGroup> = emptyList(),
        val open: ArchiveTranscript? = null,
        val openLoading: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(Ui())
    val state: StateFlow<Ui> = _state
    private var searchJob: Job? = null

    fun onQuery(q: String) {
        val trimmed = q.trim()
        if (_state.value.query == q) return
        _state.update { it.copy(query = q) }
        searchJob?.cancel()
        if (trimmed.length < HISTORY_MIN_QUERY) {
            _state.update { it.copy(groups = emptyList(), searchedQuery = "", searching = false) }
            return
        }
        searchJob = viewModelScope.launch {
            delay(250) // debounce — one search per pause, not per keystroke
            _state.update { it.copy(searching = true) }
            val res = runCatching { container.client.api.search(q = trimmed, limit = 50) }.getOrNull()
            // Stamp the query the results answer even on failure: an unreachable
            // hub is "no matches", not a spinner that never stops.
            _state.update {
                it.copy(groups = res?.groups ?: emptyList(), searchedQuery = trimmed, searching = false)
            }
        }
    }

    fun openTranscript(transcriptId: String) {
        _state.update { it.copy(openLoading = true) }
        viewModelScope.launch {
            val t = runCatching { container.client.api.archiveTranscript(transcriptId) }.getOrNull()
            _state.update { it.copy(open = t, openLoading = false, error = if (t == null) "not found" else null) }
        }
    }

    fun closeTranscript() = _state.update { it.copy(open = null) }
}
