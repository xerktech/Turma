package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.model.ArchiveSession
import com.xerktech.turma.model.ArchiveTranscript
import com.xerktech.turma.model.SearchGroup
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Archive search + ended-session browser + read-only transcript view. */
class ArchiveViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container

    data class Ui(
        val query: String = "",
        val searching: Boolean = false,
        val groups: List<SearchGroup> = emptyList(),
        val sessions: List<ArchiveSession> = emptyList(),
        val loadingList: Boolean = false,
        val open: ArchiveTranscript? = null,
        val openLoading: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(Ui())
    val state: StateFlow<Ui> = _state
    private var searchJob: Job? = null

    fun loadList() {
        _state.update { it.copy(loadingList = true) }
        viewModelScope.launch {
            val list = runCatching { container.client.api.archive(limit = 100) }.getOrNull()
            _state.update { it.copy(sessions = list?.sessions ?: emptyList(), loadingList = false) }
        }
    }

    fun onQuery(q: String) {
        _state.update { it.copy(query = q) }
        searchJob?.cancel()
        if (q.trim().length < 2) {
            _state.update { it.copy(groups = emptyList(), searching = false) }
            return
        }
        searchJob = viewModelScope.launch {
            delay(250) // debounce
            _state.update { it.copy(searching = true) }
            val res = runCatching { container.client.api.search(q = q.trim(), limit = 50) }.getOrNull()
            _state.update { it.copy(groups = res?.groups ?: emptyList(), searching = false) }
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
