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
    // Ticket -> pinned host (XERK-38), from the same /api/agents payload; the
    // board's Agent row reads it. Refreshed by the poll and the hub's
    // "ticketAgents" SSE event.
    val ticketAgents: Map<String, com.xerktech.turma.model.TicketAgentPin> = emptyMap(),
    // Per-org auto-start opt-in (XERK-41), keyed by siteKey; the board's org-chip
    // switch reads it. Refreshed by the poll and the "autoStartOrgs" SSE event.
    val autoStartOrgs: Map<String, Boolean> = emptyMap(),
    // Per-org auto-MERGE opt-in (XERK-550), keyed by siteKey; the org row's second
    // switch reads it. An INDEPENDENT map from autoStartOrgs. Refreshed by the
    // poll and the "autoMergeOrgs" SSE event.
    val autoMergeOrgs: Map<String, Boolean> = emptyMap(),
    // Ticket -> pinned model (XERK-123), from the same payload; the board's Model
    // row reads it. Refreshed by the poll and the "ticketModels" SSE event.
    val ticketModels: Map<String, com.xerktech.turma.model.TicketModelPin> = emptyMap(),
    // Ticket -> pinned runtime (XERK-473), from the same payload; the board's
    // Runtime row reads it. Refreshed by the poll and the "ticketRuntimes" SSE event.
    val ticketRuntimes: Map<String, com.xerktech.turma.model.TicketRuntimePin> = emptyMap(),
    // Manual org-color pins (XERK-145), keyed by siteKey, value the palette slot
    // 1..8; every screen's org tint reads it. Refreshed by the poll and the
    // "orgColors" SSE event.
    val orgColors: Map<String, Int> = emptyMap(),
    // Tickets waiting for a free session slot (XERK-296), from the same payload;
    // the board card's queued chip reads it. Refreshed by the poll and the
    // "ticketQueue" SSE event.
    val ticketQueue: List<com.xerktech.turma.model.QueuedTicket> = emptyList(),
    // Usage for hosts the hub's registry no longer has (XERK-338), from the same
    // payload; only the Usage screen reads it. Poll-only (no SSE event), which
    // the 6s poll covers.
    val retiredUsage: List<AgentInfo> = emptyList(),
    // Hub-wide mobile-push health (XERK-152): false when the hub has no FCM
    // credential, so every alert is silently dropped. Drives the Dashboard's
    // "push is off" banner. Poll-only (no SSE event); defaults true so an older
    // hub never false-alarms.
    val pushEnabled: Boolean = true,
    // Per-ticket triage verdict (XERK-486), keyed "<siteKey>/<issueKey>"; the
    // board's Triage lane + card chip + detail row read it. Refreshed by the
    // poll and the "triageActions" SSE event.
    val ticketTriageActions: Map<String, com.xerktech.turma.model.TriageActionPin> = emptyMap(),
    // Per-org triage policy (XERK-486), keyed by siteKey; the board's Triage
    // policy sheet reads it. Refreshed by the poll and the "triagePolicies"
    // SSE event.
    val triagePolicies: Map<String, com.xerktech.turma.model.TriagePolicy> = emptyMap(),
    // Armed epic auto-orchestration runs (XERK-635/638), keyed "<siteKey>/<epicKey>";
    // the board's epic card control + detail panel read it. Refreshed by the poll
    // and the "epicRuns" SSE event.
    val epicRuns: Map<String, com.xerktech.turma.model.EpicRun> = emptyMap(),
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
            ticketAgents = resp.ticketAgents
            autoStartOrgs = resp.autoStartOrgs
            autoMergeOrgs = resp.autoMergeOrgs
            ticketModels = resp.ticketModels
            ticketRuntimes = resp.ticketRuntimes
            orgColors = resp.orgColors
            ticketQueue = resp.ticketQueue
            retiredUsage = resp.retiredUsage
            pushEnabled = resp.pushEnabled
            ticketTriageActions = resp.ticketTriageActions
            triagePolicies = resp.triagePolicies
            epicRuns = resp.epicRuns
            emit(resp.now, error = null)
        } catch (e: Exception) {
            emit(_state.value.now, error = e.message ?: "hub unreachable")
        }
    }

    @Volatile
    private var ticketAgents: Map<String, com.xerktech.turma.model.TicketAgentPin> = emptyMap()

    @Volatile
    private var autoStartOrgs: Map<String, Boolean> = emptyMap()

    @Volatile
    private var autoMergeOrgs: Map<String, Boolean> = emptyMap()

    @Volatile
    private var ticketModels: Map<String, com.xerktech.turma.model.TicketModelPin> = emptyMap()

    @Volatile
    private var ticketRuntimes: Map<String, com.xerktech.turma.model.TicketRuntimePin> = emptyMap()

    @Volatile
    private var orgColors: Map<String, Int> = emptyMap()

    @Volatile
    private var ticketQueue: List<com.xerktech.turma.model.QueuedTicket> = emptyList()

    @Volatile
    private var retiredUsage: List<AgentInfo> = emptyList()

    @Volatile
    private var pushEnabled: Boolean = true

    @Volatile
    private var ticketTriageActions: Map<String, com.xerktech.turma.model.TriageActionPin> = emptyMap()

    @Volatile
    private var triagePolicies: Map<String, com.xerktech.turma.model.TriagePolicy> = emptyMap()

    @Volatile
    private var epicRuns: Map<String, com.xerktech.turma.model.EpicRun> = emptyMap()

    private fun emit(now: Long, error: String?) {
        val list = synchronized(byKey) { byKey.values.sortedBy { it.key } }
        _state.value = FleetState(
            agents = list, now = now, loading = false, error = error,
            ticketAgents = ticketAgents,
            autoStartOrgs = autoStartOrgs,
            autoMergeOrgs = autoMergeOrgs,
            ticketModels = ticketModels,
            ticketRuntimes = ticketRuntimes,
            orgColors = orgColors,
            ticketQueue = ticketQueue,
            retiredUsage = retiredUsage,
            pushEnabled = pushEnabled,
            ticketTriageActions = ticketTriageActions,
            triagePolicies = triagePolicies,
            epicRuns = epicRuns,
        )
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
                    // A ticket->agent pin changed somewhere; the event carries
                    // the whole (tiny) map, same as the web board consumes it.
                    "ticketAgents" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, com.xerktech.turma.model.TicketAgentPin>>(data)
                    }.getOrNull()?.let { ticketAgents = it; emit(_state.value.now, null) }
                    // An org's auto-start opt-in changed (XERK-41); the event
                    // carries the whole (tiny) map, same as the web board.
                    "autoStartOrgs" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, Boolean>>(data)
                    }.getOrNull()?.let { autoStartOrgs = it; emit(_state.value.now, null) }
                    // An org's auto-merge opt-in changed (XERK-550); whole tiny map.
                    "autoMergeOrgs" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, Boolean>>(data)
                    }.getOrNull()?.let { autoMergeOrgs = it; emit(_state.value.now, null) }
                    // A ticket->model pin changed (XERK-123); whole tiny map.
                    "ticketModels" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, com.xerktech.turma.model.TicketModelPin>>(data)
                    }.getOrNull()?.let { ticketModels = it; emit(_state.value.now, null) }
                    // A ticket->runtime pin changed (XERK-473); whole tiny map.
                    "ticketRuntimes" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, com.xerktech.turma.model.TicketRuntimePin>>(data)
                    }.getOrNull()?.let { ticketRuntimes = it; emit(_state.value.now, null) }
                    // An org's color pin changed (XERK-145); whole tiny map.
                    "orgColors" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, Int>>(data)
                    }.getOrNull()?.let { orgColors = it; emit(_state.value.now, null) }
                    // A ticket was queued, dispatched or cancelled (XERK-296);
                    // the event carries the whole (small) list, like the maps.
                    "ticketQueue" -> runCatching {
                        TurmaJson.decodeFromString<List<com.xerktech.turma.model.QueuedTicket>>(data)
                    }.getOrNull()?.let { ticketQueue = it; emit(_state.value.now, null) }
                    // A per-ticket triage verdict changed (XERK-486); the event
                    // carries the whole (tiny) map, like the other pins.
                    "triageActions" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, com.xerktech.turma.model.TriageActionPin>>(data)
                    }.getOrNull()?.let { ticketTriageActions = it; emit(_state.value.now, null) }
                    // An org's triage policy changed (XERK-486); whole tiny map.
                    "triagePolicies" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, com.xerktech.turma.model.TriagePolicy>>(data)
                    }.getOrNull()?.let { triagePolicies = it; emit(_state.value.now, null) }
                    // An epic run was armed/advanced/cancelled (XERK-638); the
                    // event carries the whole (small) map, like the other pins.
                    "epicRuns" -> runCatching {
                        TurmaJson.decodeFromString<Map<String, com.xerktech.turma.model.EpicRun>>(data)
                    }.getOrNull()?.let { epicRuns = it; emit(_state.value.now, null) }
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
