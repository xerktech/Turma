package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.WorkflowAgent
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
 *
 * A `workflow` row is the one that answers differently (XERK-304): a workflow is
 * N agents and writes no conversation of its own, so with no [agentId] it comes
 * back carrying that run's agent LIST, and picking one re-opens here with its id.
 * [Ui.agents] non-null is what says "show the picker" — an empty list is a run
 * that has started nothing yet, which is a real answer and not an error.
 */
class SubagentViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container

    data class Ui(
        val entries: List<TailEntry> = emptyList(),
        val loading: Boolean = true,
        val error: String? = null,
        val agents: List<WorkflowAgent>? = null,
        val agentsTruncated: Boolean = false,
    )

    private val _state = MutableStateFlow(Ui())
    val state: StateFlow<Ui> = _state
    private var job: Job? = null

    fun open(host: String, sessionId: String, type: String, label: String, agentId: String = "") {
        job?.cancel()
        _state.value = Ui(loading = true)
        job = viewModelScope.launch {
            repeat(12) {
                val r = runCatching {
                    container.client.subagentHistory(host, sessionId, type, label, agentId)
                }.getOrNull()
                when (r) {
                    is HubClient.HistoryResult.Ready -> {
                        _state.update {
                            it.copy(
                                entries = r.entries,
                                agents = r.agents,
                                agentsTruncated = r.agentsTruncated,
                                loading = false,
                                error = null,
                            )
                        }
                        return@launch
                    }
                    is HubClient.HistoryResult.Pending -> delay(1200)
                    // Refused, not pending (XERK-264) — retrying can't fix it,
                    // and the hub's own words beat a generic "unavailable".
                    is HubClient.HistoryResult.Failed -> {
                        _state.update { it.copy(loading = false, error = r.why) }
                        return@launch
                    }
                    null -> { // hub unreachable — stop trying, report it
                        _state.update { it.copy(loading = false, error = "unreachable") }
                        return@launch
                    }
                }
            }
            _state.update {
                it.copy(
                    loading = false,
                    error = if (it.entries.isEmpty() && it.agents == null) "unavailable" else null,
                )
            }
        }
    }

    override fun onCleared() {
        job?.cancel()
        super.onCleared()
    }
}
