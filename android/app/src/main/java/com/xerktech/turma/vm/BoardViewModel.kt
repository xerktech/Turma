package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.IssueFetch
import com.xerktech.turma.core.classifyIssueResponse
import com.xerktech.turma.model.JiraIssueDetail
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** Board state: reuses the shared fleet stream; refresh fans a jira re-poll. */
class BoardViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<com.xerktech.turma.net.FleetState> get() = container.fleet.state

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

    // The org scope ("" = all orgs) is the header control's now (XERK-62), held
    // by the container so the board reads the same pick every other screen does.
    val orgFilter: StateFlow<String> get() = container.org.stored

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

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

    /** Start a session on a ticket (hub picks the host + triaged repo). */
    fun startSession(siteKey: String, issueKey: String) {
        viewModelScope.launch {
            val msg = try {
                val r = container.client.api.startJiraSession(siteKey, issueKey)
                val b = r.body()
                when {
                    r.isSuccessful && b?.ok == true -> "✓ starting session on ${b.repo}"
                    else -> "✗ ${b?.error?.takeIf { it.isNotBlank() } ?: "HTTP ${r.code()}"}"
                }
            } catch (_: Exception) {
                "✗ hub unreachable"
            }
            _messages.tryEmit(msg)
            container.fleet.nudge()
        }
    }

    /**
     * Override a ticket's repo. `repo` = a name to pin, or null with `auto`
     * deciding between "no repo fits" (auto=false) and "let the model decide"
     * (auto=true). Built as a JsonObject so an explicit null reaches the hub.
     */
    fun setRepo(siteKey: String, issueKey: String, repo: String?, auto: Boolean) {
        viewModelScope.launch {
            val body = buildJsonObject {
                if (auto) put("auto", JsonPrimitive(true))
                else put("repo", if (repo != null) JsonPrimitive(repo) else JsonNull)
            }
            val ok = runCatching { container.client.api.setJiraRepo(siteKey, issueKey, body) }.isSuccess
            _messages.tryEmit(if (ok) "✓ repo updated" else "✗ hub unreachable")
            container.fleet.nudge()
        }
    }

    /**
     * Pin which HOST a ticket's sessions spawn on (XERK-38), or release the pin
     * back to automatic routing (`host = null`). Hub-owned and durable — the
     * POST is authoritative, and the fleet payload's ticketAgents reflects it
     * on the next poll/SSE event.
     */
    fun setTicketAgent(siteKey: String, issueKey: String, host: String?) {
        viewModelScope.launch {
            val body = buildJsonObject {
                if (host == null) put("auto", JsonPrimitive(true))
                else put("host", JsonPrimitive(host))
            }
            val ok = runCatching { container.client.api.setTicketAgent(siteKey, issueKey, body) }.isSuccess
            _messages.tryEmit(if (ok) "✓ agent updated" else "✗ hub unreachable")
            container.fleet.nudge()
        }
    }

    /**
     * Fetch one ticket's full detail on demand, polling while the host fetches it
     * (HTTP 202) with backoff up to a deadline — a port of board.html
     * `fetchDetail`. The hub queues the fetch and 202s on a cache miss, so a
     * single shot (the old behaviour) always caught the pending state and spun
     * the detail sheet forever (XERK-83). Never returns null: a terminal failure
     * comes back as an error-bearing detail so the sheet stops loading.
     */
    suspend fun fetchIssue(siteKey: String, key: String): JiraIssueDetail {
        val deadline = System.currentTimeMillis() + 45_000  // host beats ~20s: 2 shots
        var delayMs = 600L
        while (System.currentTimeMillis() < deadline) {
            val outcome = try {
                val resp = container.client.api.jiraIssue(siteKey, key)
                classifyIssueResponse(resp.code(), resp.body())
            } catch (_: Exception) {
                return JiraIssueDetail(error = "the hub is unreachable")
            }
            when (outcome) {
                is IssueFetch.Done -> return outcome.detail
                IssueFetch.Pending -> {
                    delay(delayMs)
                    delayMs = (delayMs * 3 / 2).coerceAtMost(3_000L)
                }
            }
        }
        return JiraIssueDetail(error = "the host didn't answer in time")
    }
}
