package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.model.JiraIssueDetail
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Board state: reuses the shared fleet stream; refresh fans a jira re-poll. */
class BoardViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<com.xerktech.turma.net.FleetState> get() = container.fleet.state

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

    fun start() = container.fleet.start()

    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            try { container.client.api.jiraRefresh() } catch (_: Exception) {}
            container.fleet.nudge()
            _refreshing.value = false
        }
    }

    /** Fetch full issue detail on demand; null while the host is still fetching. */
    suspend fun fetchIssue(siteKey: String, key: String): JiraIssueDetail? = try {
        val resp = container.client.api.jiraIssue(siteKey, key)
        if (resp.code() == 202) null else resp.body()
    } catch (_: Exception) {
        null
    }
}
