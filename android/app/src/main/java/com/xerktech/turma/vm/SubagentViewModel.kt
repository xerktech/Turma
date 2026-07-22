package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.net.HubClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Read-only viewer state for one live background agent's transcript — the Android
 * counterpart of the web's `openSubagentView` (sessions.html). Clicking a subagent
 * row in the live status bar opens that agent's own `subagents/agent-<id>.jsonl`,
 * fetched on demand: the agent 202s until the next heartbeat delivers it, so we
 * poll a bounded number of times, mirroring the web's 12×1.2s loop.
 */
class SubagentViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container

    data class Ui(
        val entries: List<TailEntry> = emptyList(),
        val loading: Boolean = true,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(Ui())
    val state: StateFlow<Ui> = _state
    private var job: Job? = null

    fun open(host: String, sessionId: String, type: String, label: String) {
        job?.cancel()
        _state.value = Ui(loading = true)
        job = viewModelScope.launch {
            repeat(12) {
                val r = runCatching {
                    container.client.subagentHistory(host, sessionId, type, label)
                }.getOrNull()
                when (r) {
                    is HubClient.HistoryResult.Ready -> {
                        _state.update { it.copy(entries = r.entries, loading = false, error = null) }
                        return@launch
                    }
                    is HubClient.HistoryResult.Pending -> delay(1200)
                    null -> { // hub unreachable — stop trying, report it
                        _state.update { it.copy(loading = false, error = "unreachable") }
                        return@launch
                    }
                }
            }
            _state.update { it.copy(loading = false, error = if (it.entries.isEmpty()) "unavailable" else null) }
        }
    }

    override fun onCleared() {
        job?.cancel()
        super.onCleared()
    }
}
