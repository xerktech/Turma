package com.xerktech.turma.net

import com.xerktech.turma.data.Config
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.TurmaJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * Fleet state: a 6s poll of GET /api/agents (the reliable floor) plus an SSE
 * subscription to /api/events that upserts per-host records the instant a beat
 * lands — matching the web dashboard. The poll alone keeps everything fresh
 * (pending questions ride the heartbeat), so SSE is purely a latency win and
 * its failure is harmless.
 */
data class FleetState(
    val agents: List<AgentInfo> = emptyList(),
    val now: Long = 0,
    val loading: Boolean = true,
    val error: String? = null,
)

class FleetRepository(
    private val client: HubClient,
    private val config: Config,
    private val scope: CoroutineScope,
) {
    private companion object { const val POLL_MS = 6_000L }

    private val byKey = LinkedHashMap<String, AgentInfo>()
    private val _state = MutableStateFlow(FleetState())
    val state: StateFlow<FleetState> = _state

    private var pollJob: Job? = null
    private var sseJob: Job? = null
    private var eventSource: EventSource? = null

    fun start() {
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            while (isActive) {
                refresh()
                delay(POLL_MS)
            }
        }
        openSse()
    }

    fun stop() {
        pollJob?.cancel(); pollJob = null
        sseJob?.cancel(); sseJob = null
        eventSource?.cancel(); eventSource = null
    }

    /** Force an immediate poll (after a mutation, on resume). */
    fun nudge() {
        scope.launch { refresh() }
    }

    suspend fun refresh() {
        try {
            val resp = client.api.listAgents()
            synchronized(byKey) {
                byKey.clear()
                for (a in resp.agents) byKey[a.key] = a
            }
            emit(resp.now, error = null)
        } catch (e: Exception) {
            emit(_state.value.now, error = e.message ?: "hub unreachable")
        }
    }

    private fun emit(now: Long, error: String?) {
        val list = synchronized(byKey) { byKey.values.sortedBy { it.key } }
        _state.value = FleetState(agents = list, now = now, loading = false, error = error)
    }

    private fun upsert(agent: AgentInfo) {
        if (agent.key.isEmpty()) return
        synchronized(byKey) { byKey[agent.key] = agent }
        emit(_state.value.now.coerceAtLeast(agent.lastSeen), null)
    }

    private fun remove(key: String) {
        synchronized(byKey) { byKey.remove(key) }
        emit(_state.value.now, null)
    }

    private fun openSse() {
        val url = config.current.baseUrl + "api/events"
        val listener = object : EventSourceListener() {
            override fun onEvent(source: EventSource, id: String?, type: String?, data: String) {
                when (type) {
                    "agent" -> runCatching { TurmaJson.decodeFromString<AgentInfo>(data) }.getOrNull()?.let { upsert(it) }
                    "removed" -> runCatching { TurmaJson.decodeFromString<JsonObject>(data) }
                        .getOrNull()?.get("key")?.jsonPrimitive?.content?.let { remove(it) }
                }
            }

            override fun onFailure(source: EventSource, t: Throwable?, response: okhttp3.Response?) {
                // Reconnect after a short delay; the poll covers the gap.
                eventSource = null
                sseJob = scope.launch {
                    delay(3_000)
                    if (isActive && pollJob?.isActive == true) openSse()
                }
            }
        }
        eventSource = EventSources.createFactory(client.http)
            .newEventSource(Request.Builder().url(url).header("Accept", "text/event-stream").build(), listener)
    }
}
