package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.CreateMetaFetch
import com.xerktech.turma.core.CreateResultFetch
import com.xerktech.turma.core.IssueFetch
import com.xerktech.turma.core.MoveState
import com.xerktech.turma.core.StartState
import com.xerktech.turma.core.SweepVerdict
import com.xerktech.turma.core.categoryOf
import com.xerktech.turma.core.classifyCreateMeta
import com.xerktech.turma.core.classifyCreateResult
import com.xerktech.turma.core.classifyIssueResponse
import com.xerktech.turma.core.moveSweepVerdict
import com.xerktech.turma.core.startSweepVerdict
import com.xerktech.turma.core.ticketSessionIndex
import com.xerktech.turma.core.ticketSessionsOf
import com.xerktech.turma.model.CreateTicketRequest
import com.xerktech.turma.model.JiraIssueDetail
import com.xerktech.turma.model.QueuedTicket
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.net.hubErrorMessage
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Board state: reuses the shared fleet stream; refresh fans a jira re-poll. */
class BoardViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<com.xerktech.turma.net.FleetState> get() = container.fleet.state

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

    // The org selection (empty = all orgs) is the header control's now (XERK-62,
    // multi per XERK-222), held by the container so the board reads the same
    // selection every other screen does.
    val orgFilter: StateFlow<Set<String>> get() = container.org.stored

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    /**
     * Per-ticket in-flight start state, keyed "<siteKey>\u0000<issueKey>" — the
     * board.html `starts` map. Pending is painted the instant the button is
     * pressed (before the POST); the sweep below resolves it on EVIDENCE, not a
     * timer: a session reporting the spawn's cmdId, or the command clearing from
     * the host's queue after having been SEEN there (covering a refused spawn).
     * A failure parks its reason on the ticket until the next attempt.
     */
    private val _starts = MutableStateFlow<Map<String, StartState>>(emptyMap())
    val starts: StateFlow<Map<String, StartState>> = _starts

    /**
     * Per-ticket drag override, keyed like [_starts] — the board.html `moves`
     * map (XERK-141). Holds the card in the dropped column optimistically until
     * the board's own Jira/Azure poll catches up (or a backstop / error TTL).
     */
    private val _moves = MutableStateFlow<Map<String, MoveState>>(emptyMap())
    val moves: StateFlow<Map<String, MoveState>> = _moves

    /**
     * Optimism over the hub's ticket queue (XERK-296), keyed like [_starts]:
     * queued by a click the confirming beat hasn't reflected yet, and cancelled
     * by a DELETE the payload still lists. See [queueView].
     */
    private val _queueAdds = MutableStateFlow<Map<String, QueuedTicket>>(emptyMap())
    val queueAdds: StateFlow<Map<String, QueuedTicket>> = _queueAdds
    private val _queueDrops = MutableStateFlow<Set<String>>(emptySet())
    val queueDrops: StateFlow<Set<String>> = _queueDrops

    init {
        // Sweep on every fleet beat (web board.html sweepStarts on each render).
        viewModelScope.launch { container.fleet.state.collect { sweepStarts(it); sweepMoves(it); sweepQueue(it) } }
    }

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

    /**
     * Start a session on a ticket (hub picks the host + triaged repo). The
     * acknowledgement is optimistic and inline (web board.html startSession):
     * pending paints on the card synchronously, BEFORE the POST; cmdId/host fill
     * in on the reply; a failure parks its reason beside a live retry button
     * rather than flashing a transient toast.
     */
    fun startSession(siteKey: String, issueKey: String) {
        val k = startKey(siteKey, issueKey)
        if (_starts.value[k]?.pending == true) return  // double-tap = no-op
        _starts.value = _starts.value + (k to StartState(pending = true, at = now()))
        viewModelScope.launch {
            val next = try {
                val r = container.client.api.startJiraSession(siteKey, issueKey)
                val b = r.body()
                when {
                    // No host had a free slot, so the hub put the TICKET in line
                    // rather than handing it to an agent (XERK-296). There is no
                    // cmdId to follow: the card switches to the queued chip, fed
                    // by the hub's own queue from the next beat.
                    r.isSuccessful && b?.queued == true -> {
                        _queueAdds.value = _queueAdds.value + (k to QueuedTicket(
                            siteKey = siteKey, issueKey = issueKey, source = "manual",
                            queuedAt = now(), position = b.position.coerceAtLeast(1),
                        ))
                        null
                    }
                    r.isSuccessful && b?.ok == true ->
                        StartState(pending = true, cmdId = b.cmdId.ifBlank { null }, host = b.host, at = now())
                    else -> StartState(error = b?.error?.takeIf { it.isNotBlank() } ?: "HTTP ${r.code()}")
                }
            } catch (_: Exception) {
                StartState(error = "the hub is unreachable")
            }
            _starts.value = if (next == null) _starts.value - k else _starts.value + (k to next)
            container.fleet.nudge()
        }
    }

    /**
     * Take a waiting ticket back out of the hub's queue (XERK-296) — the card's
     * ✕. Nothing has started, so this cancels a queue entry and touches neither
     * a session nor the ticket. The removal paints immediately and rolls back
     * onto the card if the hub refuses; a 404 means it already left the queue,
     * which satisfies the operator's intent rather than failing it.
     */
    fun cancelQueued(siteKey: String, issueKey: String) {
        val k = startKey(siteKey, issueKey)
        _queueAdds.value = _queueAdds.value - k
        _queueDrops.value = _queueDrops.value + k
        viewModelScope.launch {
            val err = try {
                val r = container.client.api.cancelQueuedTicket(siteKey, issueKey)
                if (r.isSuccessful || r.code() == 404) null else hubErrorMessage(r)
            } catch (_: Exception) {
                "the hub is unreachable"
            }
            if (err != null) {
                _queueDrops.value = _queueDrops.value - k
                _starts.value = _starts.value + (k to StartState(error = err))
            }
            container.fleet.nudge()
        }
    }

    /**
     * Retire the queue overlays the hub has caught up with — the counterpart of
     * [sweepStarts], run on the same beat. An add goes once the hub lists it (or
     * once it has expired: a hub that never lists it has already dispatched or
     * dropped it, and the payload is right either way); a drop goes once the hub
     * no longer lists it. Composing core's queueView over what survives is then
     * pure, so the screen can build the list during composition.
     */
    private fun sweepQueue(fleet: com.xerktech.turma.net.FleetState) {
        val inHub = fleet.ticketQueue.map { startKey(it.siteKey, it.issueKey) }.toSet()
        val now = now()
        val adds = _queueAdds.value.filterNot {
            it.key in inHub || now - it.value.queuedAt > QUEUE_OPTIMISM_MS
        }
        if (adds != _queueAdds.value) _queueAdds.value = adds
        val drops = _queueDrops.value.filterTo(mutableSetOf()) { it in inHub }
        if (drops != _queueDrops.value) _queueDrops.value = drops
    }

    /** Resolve in-flight starts against the fleet — web board.html sweepStarts. */
    private fun sweepStarts(fleet: com.xerktech.turma.net.FleetState) {
        val cur = _starts.value
        if (cur.none { it.value.pending }) return
        val idx = ticketSessionIndex(fleet.agents)
        val now = now()
        val next = cur.toMutableMap()
        for ((k, p) in cur) {
            if (!p.pending) continue  // an error sits until the next click
            val (siteKey, issueKey) = k.split("\u0000").let { it[0] to it.getOrElse(1) { "" } }
            val sessions = ticketSessionsOf(idx, siteKey, issueKey)
            val host = fleet.agents.find { it.key == p.host }
            val cmdPresent = host?.commands?.any { it.cmdId == p.cmdId } == true
            // The agent's own word that it declined this spawn (XERK-265). An
            // absent entry means "can't tell" — an older hub sends none — so the
            // timeout rules inside the verdict stay as they were.
            val refusal = p.cmdId?.let { host?.spawnRefusals?.get(it)?.error }
            val (verdict, updated) = startSweepVerdict(
                p, sessions, cmdPresent, host != null, now - p.at, START_TIMEOUT_MS, refusal)
            when (verdict) {
                SweepVerdict.CLEAR -> next.remove(k)
                SweepVerdict.REFUSED -> next[k] =
                    StartState(error = refusal?.ifBlank { null } ?: "the host refused it")
                SweepVerdict.ERROR -> next[k] = StartState(error = "the host didn't start it in time")
                SweepVerdict.HOLD -> next[k] = updated
            }
        }
        if (next != cur) _starts.value = next
    }

    private fun now() = System.currentTimeMillis()

    companion object {
        fun startKey(siteKey: String, issueKey: String) = siteKey + "\u0000" + issueKey
        const val START_TIMEOUT_MS = 60_000L
        // How long an optimistic queue entry survives without the hub listing it
        // (board.html QUEUE_OPTIMISM_MS): past this the payload is authoritative,
        // because a hub that doesn't list it has already dispatched or dropped it.
        const val QUEUE_OPTIMISM_MS = 8_000L
        // Hold a landed drag this long if the board poll never reports it; show a
        // failed one this long before reverting (board.html MOVE_SETTLE_MS / _TTL).
        const val MOVE_SETTLE_MS = 120_000L
        const val MOVE_ERROR_TTL_MS = 6_000L
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
     * Pin which MODEL a ticket's session runs (XERK-123), or release it back to
     * the login's default (`model = null`). Hub-owned and durable — the POST is
     * authoritative, and the fleet payload's ticketModels reflects it on the next
     * poll/SSE event.
     */
    fun setTicketModel(siteKey: String, issueKey: String, model: String?) {
        viewModelScope.launch {
            val body = buildJsonObject {
                if (model == null) put("auto", JsonPrimitive(true))
                else put("model", JsonPrimitive(model))
            }
            val ok = runCatching { container.client.api.setTicketModel(siteKey, issueKey, body) }.isSuccess
            _messages.tryEmit(if (ok) "✓ model updated" else "✗ hub unreachable")
            container.fleet.nudge()
        }
    }

    /**
     * Change a ticket's status and push it to the board (XERK-138) — the one
     * thing Turma writes back. The hub queues a command on an online host and
     * reports the outcome keyed by the returned cmdId, which we poll with backoff
     * (a port of board.html saveStatus). Returns null on success (the caller then
     * re-fetches the detail for the new status + its now-different options), or an
     * error string on failure. A successful change nudges the fleet so the card's
     * column catches up on the next Jira poll.
     */
    suspend fun saveStatus(siteKey: String, issueKey: String, value: String): String? {
        val cmdId = try {
            val body = buildJsonObject { put("value", JsonPrimitive(value)) }
            val r = container.client.api.setTicketStatus(siteKey, issueKey, body)
            val b = r.body()
            if (!r.isSuccessful || b?.ok != true) {
                return b?.error?.takeIf { it.isNotBlank() } ?: r.hubError() ?: "HTTP ${r.code()}"
            }
            b.cmdId
        } catch (_: Exception) {
            return "the hub is unreachable"
        }
        if (cmdId.isBlank()) return "the change wasn't queued"
        val deadline = now() + 60_000
        var delayMs = 600L
        while (now() < deadline) {
            val res = try {
                container.client.api.ticketStatusResult(siteKey, issueKey, cmdId).body()
            } catch (_: Exception) {
                return "the hub is unreachable"
            }
            if (res == null) return "the change didn't take"
            if (res.pending) {
                delay(delayMs)
                delayMs = (delayMs * 3 / 2).coerceAtMost(3_000L)
                continue
            }
            if (res.ok) { container.fleet.nudge(); return null }
            return res.error?.takeIf { it.isNotBlank() } ?: "the change didn't take"
        }
        return "the host didn't confirm in time"
    }

    /**
     * Drag a card into another column (XERK-141): optimistically move it, POST
     * the target COLUMN (the agent resolves it to a real status), then poll the
     * outcome. The card holds its dropped column across fleet beats until the
     * board poll reports it there; a failure reverts it. Mirrors board.html
     * `moveTo` and reuses the same status endpoints saveStatus does.
     */
    fun moveTicket(siteKey: String, issueKey: String, category: String) {
        val k = startKey(siteKey, issueKey)
        if (_moves.value[k]?.pending == true) return   // one drag at a time per ticket
        _moves.value = _moves.value + (k to MoveState(category = category, pending = true, at = now()))
        viewModelScope.launch {
            val cmdId = try {
                val body = buildJsonObject { put("category", JsonPrimitive(category)) }
                val r = container.client.api.setTicketStatus(siteKey, issueKey, body)
                val b = r.body()
                if (!r.isSuccessful || b?.ok != true) {
                    return@launch failMove(k, b?.error?.takeIf { it.isNotBlank() } ?: r.hubError() ?: "HTTP ${r.code()}")
                }
                b.cmdId
            } catch (_: Exception) {
                return@launch failMove(k, "the hub is unreachable")
            }
            if (cmdId.isBlank()) return@launch failMove(k, "the change wasn't queued")
            val deadline = now() + 60_000
            var delayMs = 600L
            while (now() < deadline && _moves.value[k]?.pending == true) {
                val res = try {
                    container.client.api.ticketStatusResult(siteKey, issueKey, cmdId).body()
                } catch (_: Exception) {
                    return@launch failMove(k, "the hub is unreachable")
                }
                if (res == null) return@launch failMove(k, "the change didn't take")
                if (res.pending) {
                    delay(delayMs)
                    delayMs = (delayMs * 3 / 2).coerceAtMost(3_000L)
                    continue
                }
                if (res.ok) {
                    // Landed: hold the dropped column until the poll catches up.
                    _moves.value = _moves.value + (k to MoveState(
                        category = category, settled = true, settledAt = now(), at = now()))
                    // The change is on the tracker, but the board's ticket LIST
                    // only reflects it on the next Jira/Azure poll. Nudge that poll
                    // now so the card's REAL status catches up in a beat or two and
                    // the override releases cleanly, rather than the overlay
                    // lingering until the slow poll cadence.
                    runCatching { container.client.api.jiraRefresh() }
                    container.fleet.nudge()
                    return@launch
                }
                return@launch failMove(k, res.error?.takeIf { it.isNotBlank() } ?: "the change didn't take")
            }
            if (_moves.value[k]?.pending == true) failMove(k, "the host didn't confirm in time")
        }
    }

    private fun failMove(k: String, error: String) {
        val cat = _moves.value[k]?.category ?: ""
        _moves.value = _moves.value + (k to MoveState(category = cat, error = error, at = now()))
        _messages.tryEmit("✗ couldn't move — $error")
    }

    /** Resolve drag overrides against the fleet — web board.html sweepMoves. */
    private fun sweepMoves(fleet: com.xerktech.turma.net.FleetState) {
        val cur = _moves.value
        if (cur.isEmpty()) return
        val now = now()
        val next = cur.toMutableMap()
        for ((k, m) in cur) {
            val (siteKey, issueKey) = k.split("\u0000").let { it[0] to it.getOrElse(1) { "" } }
            val ticket = fleet.agents.asSequence()
                .mapNotNull { it.jira?.takeIf { j -> j.siteKey == siteKey } }
                .flatMap { it.tickets.asSequence() }
                .firstOrNull { it.key == issueKey }
            if (ticket == null) { next.remove(k); continue }   // left the board
            if (moveSweepVerdict(m, categoryOf(ticket), now, MOVE_SETTLE_MS, MOVE_ERROR_TTL_MS)
                == SweepVerdict.CLEAR) next.remove(k)
        }
        if (next != cur) _moves.value = next
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

    /**
     * New-ticket create metadata (XERK-137): the org's projects + labels (no
     * `project`), or a project's issue/work-item types (`project` set). Same
     * 202-poll-with-backoff shape as [fetchIssue].
     */
    suspend fun fetchCreateMeta(siteKey: String, project: String?): CreateMetaFetch {
        val deadline = System.currentTimeMillis() + 45_000
        var delayMs = 600L
        val wantTypes = !project.isNullOrBlank()
        while (System.currentTimeMillis() < deadline) {
            val outcome = try {
                val resp = container.client.api.createMeta(siteKey, project?.ifBlank { null })
                classifyCreateMeta(resp.code(), resp.body(), wantTypes)
            } catch (_: Exception) {
                return CreateMetaFetch.Error("the hub is unreachable")
            }
            if (outcome is CreateMetaFetch.Pending) {
                delay(delayMs)
                delayMs = (delayMs * 3 / 2).coerceAtMost(3_000L)
            } else {
                return outcome
            }
        }
        return CreateMetaFetch.Error("the host didn't answer in time")
    }

    /**
     * Create a ticket, then poll its outcome by the cmdId the POST returns — the
     * web board.html submit + pollCreate. A nudge on completion pulls the new
     * (self-assigned) ticket onto the board on the next poll.
     */
    suspend fun submitCreate(siteKey: String, req: CreateTicketRequest): CreateResultFetch {
        val cmdId = try {
            val resp = container.client.api.createTicket(siteKey, req)
            val b = resp.body()
            if (resp.isSuccessful && !b?.cmdId.isNullOrBlank()) b!!.cmdId
            else return CreateResultFetch.Error(
                b?.error?.takeIf { it.isNotBlank() } ?: resp.hubError() ?: "HTTP ${resp.code()}")
        } catch (_: Exception) {
            return CreateResultFetch.Error("the hub is unreachable")
        }
        val deadline = System.currentTimeMillis() + 60_000
        var delayMs = 700L
        while (System.currentTimeMillis() < deadline) {
            val outcome = try {
                val resp = container.client.api.createResult(siteKey, cmdId)
                classifyCreateResult(resp.code(), resp.body())
            } catch (_: Exception) {
                return CreateResultFetch.Error("the hub is unreachable")
            }
            if (outcome is CreateResultFetch.Pending) {
                delay(delayMs)
                delayMs = (delayMs * 3 / 2).coerceAtMost(3_000L)
            } else {
                container.fleet.nudge()
                return outcome
            }
        }
        return CreateResultFetch.Error("the create didn't complete in time")
    }
}

/**
 * The `{error}` a REFUSING hub response carries. Retrofit parks a non-2xx body
 * in `errorBody()`, so reading `body()` alone degrades every refusal on these
 * routes to a bare "HTTP 409" — including the one that says what to do about it
 * ("this host's Turma agent (v0.5.38) is too old to create tickets; update the
 * agent", XERK-151). Null when there's no readable message to show.
 */
internal fun <T> retrofit2.Response<T>.hubError(): String? = try {
    val raw = errorBody()?.string().orEmpty()
    if (raw.isBlank()) null
    else TurmaJson.parseToJsonElement(raw).jsonObject["error"]
        ?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
} catch (_: Exception) {
    null
}
