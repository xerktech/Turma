package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import android.net.Uri
import android.provider.OpenableColumns
import com.xerktech.turma.core.AttachStatus
import com.xerktech.turma.core.Attachment
import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.core.Uploads
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.VerbosityPrefs
import com.xerktech.turma.core.mergeTail
import com.xerktech.turma.core.prependHistory
import com.xerktech.turma.core.tunnelOnlineOf
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TurnStatus
import com.xerktech.turma.net.AnswerRequest
import com.xerktech.turma.net.Dictation
import com.xerktech.turma.net.HubClient
import com.xerktech.turma.net.InputRequest
import com.xerktech.turma.net.LiveEvent
import com.xerktech.turma.net.ModeRequest
import com.xerktech.turma.net.ModelRequest
import com.xerktech.turma.net.ModelSourceRequest
import com.xerktech.turma.net.OkResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import com.xerktech.turma.net.hubErrorMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class MicState { IDLE, RECORDING, FINALIZING }

data class ChatUiState(
    val entries: List<TailEntry> = emptyList(),
    val liveTurn: String = "",
    val turnStatus: TurnStatus? = null,
    // The session's live agent list, held apart from turnStatus because it
    // outlives the turn: a background agent keeps running after the main one
    // stops, which is exactly when the bar used to vanish (XERK-245).
    val liveAgents: List<com.xerktech.turma.model.AgentRow> = emptyList(),
    val verbosity: Verbosity = Verbosity.CONCISE,
    val connected: Boolean = false,
    // Whether the session's HOST still has its terminal tunnel (control
    // channel) up, off the fleet heartbeat. Distinct from [connected], which
    // only says our own /live socket is open: the hub accepts and holds that
    // socket across a tunnel flap, so it stays open while nothing flows
    // (XERK-252). True until a beat says otherwise, so the very first frames —
    // before any fleet payload has arrived — don't flash "tunnel offline".
    val tunnelOnline: Boolean = true,
    val hasMore: Boolean = false,
    val loadingHistory: Boolean = false,
    val mic: MicState = MicState.IDLE,
    val draft: String = "",
    // Files staged for the next message (XERK-234) and this host's per-file cap
    // (0 = its agent predates attachments, which is what hides the composer's
    // clip button rather than letting the operator attach into a void).
    val attachments: List<Attachment> = emptyList(),
    val uploadMaxBytes: Long = 0,
    val session: SessionInfo? = null,
    // The host this session's agent runs on, shown in the header (XERK-121):
    // the agent's device name, falling back to its registration key.
    val hostLabel: String = "",
    // This host's self-hosted model (XERK-246) and an unconfirmed switch onto or
    // off it. Null localModel = its agent can't fail over, which is what hides
    // the "run against" chip rather than offering a command the host would drop.
    val localModel: com.xerktech.turma.model.LocalModelInfo? = null,
    // This host's dsh runtime + its discovered models (XERK-504), so a dsh
    // session's footer shows a live dsh model dropdown instead of the Claude
    // subscription/local chips. Null = not a dsh host (the common case).
    val dsh: com.xerktech.turma.model.DshInfo? = null,
    // This host's qwen (Qwen Code) capability (XERK-506): qwen has NO discovered
    // model list (capability-flag-only), so a qwen session's footer shows a
    // FIXED model label + "⚙ Qwen Code" chip, never the Claude alias picker.
    // Null = not a qwen host (the common case).
    val qwen: com.xerktech.turma.model.QwenInfo? = null,
    val modelSourcePending: ModelSource.Pending? = null,
) {
    val prefs: VerbosityPrefs get() = VerbosityPrefs.forPreset(verbosity)
    val question: String get() = session?.session?.question ?: ""
    val questionOptions: List<String> get() = session?.session?.questionOptions ?: emptyList()
    val questionOptionsRich: List<com.xerktech.turma.model.QuestionOption> get() = session?.session?.questionOptionsRich ?: emptyList()
    val questionHeader: String get() = session?.session?.questionHeader ?: ""
    val questionMulti: Boolean get() = session?.session?.questionMulti ?: false
    val questionTotal: Int? get() = session?.session?.questionTotal
    val questionIndex: Int? get() = session?.session?.questionIndex
    // Attaching is off while a question is pending: the draft then routes to
    // POST .../answer, which carries no files (web chat.js renderAttachments).
    val canAttach: Boolean get() = Uploads.canAttach(uploadMaxBytes) && question.isBlank()

    /**
     * Which model this session runs against, taking an unconfirmed switch at its
     * word until the heartbeat agrees. Read with a caller-supplied clock so the
     * memo can age out on a repaint rather than only on the next state change.
     */
    fun modelSource(now: Long = System.currentTimeMillis()): String =
        ModelSource.current(session, modelSourcePending, now)

    fun canSwitchModelSource(now: Long = System.currentTimeMillis()): Boolean =
        ModelSource.offered(localModel, modelSource(now))

    /**
     * Everything this screen takes from a fleet beat, in one place.
     *
     * Extracted from the two callers (the poll collector and the initial seed)
     * so the set of carried fields is pinned by a test rather than by whoever
     * last resolved a merge on that `copy(...)`. A field silently dropped there
     * disables its whole feature — [localModel] going missing hides both
     * local-model controls forever — and nothing else in the suite notices,
     * because a Composable's body has no gate at all.
     */
    fun fromFleet(agent: AgentInfo?, session: SessionInfo?, host: String): ChatUiState = copy(
        session = session,
        hostLabel = agent?.device?.ifBlank { host } ?: host,
        tunnelOnline = tunnelOnlineOf(agent),
        uploadMaxBytes = agent?.uploadMaxBytes ?: 0,
        localModel = agent?.localModel,
        dsh = agent?.dsh,
        qwen = agent?.qwen,
    )
}

class ChatViewModel(
    app: Application,
    private val host: String,
    private val sessionId: String,
) : AndroidViewModel(app) {

    private val container = (app as TurmaApplication).container
    private val client: HubClient get() = container.client
    private val prefs = app.getSharedPreferences("turma_verbosity", 0)

    private val _state = MutableStateFlow(
        ChatUiState(verbosity = Verbosity.entries.getOrElse(prefs.getInt(sessionId, 0)) { Verbosity.CONCISE })
    )
    val state: StateFlow<ChatUiState> = _state

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    /**
     * The compose draft is the container's, not this ViewModel's (XERK-122): the
     * terminal screen has a second box over the same session, and the text has to
     * survive walking between them. This VM mirrors it into [ChatUiState.draft]
     * for the renderer and writes every change back through it — the flow, not
     * the state copy, is the source of truth.
     */
    private val draft = container.drafts.of(host, sessionId)

    /**
     * The in-flight model-source switch, held in the container for the SAME
     * reason as [draft] (XERK-246): this ViewModel is scoped to the chat's nav
     * entry, so a memo kept here died the moment you walked back to the session
     * list — mid-switch, which is when it is doing its job.
     */
    private val modelSwitch = container.modelSwitches.of(host, sessionId)

    init {
        // Collected on viewModelScope (not the onEnter/onLeave jobs): the mirror
        // must survive a detail-pane swap, or a re-entry would paint an empty box
        // until the next keystroke.
        viewModelScope.launch { draft.collect { text -> _state.update { it.copy(draft = text) } } }
        viewModelScope.launch {
            modelSwitch.collect { p ->
                _state.update { it.copy(modelSourcePending = p) }
                armMemoExpiry(p)
            }
        }
    }

    /**
     * Wake once when the outstanding memo ages out and retire it (XERK-246).
     *
     * Without this the TTL is only ever observed by whoever next reads the clock,
     * and on a quiet fleet nobody does — Compose skips recomposition while the
     * state compares equal, so an expired memo stays painted indefinitely. The
     * heartbeat's own `settle` cannot cover it either: it runs on fleet
     * emissions, which is exactly what a quiet fleet does not produce.
     *
     * Collected off the STORE rather than set alongside each POST, so a memo
     * carried in from another nav entry is armed too — that is the case the
     * store exists for. Self-cancelling and bounded: one alarm per memo, none at
     * all when there is no memo.
     */
    private var memoExpiryJob: Job? = null

    private fun armMemoExpiry(pending: ModelSource.Pending?) {
        memoExpiryJob?.cancel()
        if (pending == null) return
        memoExpiryJob = viewModelScope.launch {
            val left = ModelSource.SWITCH_SETTLE_MS - (System.currentTimeMillis() - pending.at)
            if (left > 0) delay(left)
            // Retire by IDENTITY, never by re-asking the clock. `delay` measures
            // elapsed UPTIME while `expired` re-reads the WALL clock, and a
            // backward wall-clock jump between the two makes the re-check false:
            // `settle` then returns the same instance, `MutableStateFlow` does
            // not emit an equal value, the collector never runs, and no new
            // alarm is armed — so the memo is pinned until the clock catches up.
            // Measured with a 10-minute backward jump: the chip still claimed
            // the subscription at t+190s while the record said `local`.
            //
            // This alarm's only job is the TTL, so it does not need `settle`'s
            // other rules: the heartbeat-agreement case is handled by the fleet
            // collector, and `compareAndSet` no-ops if a newer switch (a
            // different `at`) or a settle has already replaced this memo.
            modelSwitch.compareAndSet(pending, null)
        }
    }

    private var liveJob: Job? = null
    private var historyJob: Job? = null
    private var fleetJob: Job? = null
    private var pollJob: Job? = null
    private var refreshJob: Job? = null
    private var dictation: Dictation? = null
    // Chip ids for staged attachments — a counter, not the Uri, so the same file
    // picked twice is two removable chips.
    private var attachSeq = 0

    fun onEnter() {
        seedFromFleet()
        observeFleet()
        startLive()
        loadHistory()
        startPollFallback()
    }

    // Symmetric with onEnter: cancels every launched job so a re-entry (the
    // two-pane detail swapping back to a session whose VM lingered in the store)
    // restarts cleanly rather than stacking a second collector on each job.
    fun onLeave() {
        liveJob?.cancel(); historyJob?.cancel(); fleetJob?.cancel()
        pollJob?.cancel(); refreshJob?.cancel()
        cancelDictation()
    }

    // Session record + heartbeat tail seed + question state ride the fleet poll.
    private fun observeFleet() {
        fleetJob?.cancel()
        fleetJob = viewModelScope.launch {
            container.fleet.state.collect { fleet ->
                val agent = fleet.agents.firstOrNull { it.key == host }
                val session = agent?.sessions?.firstOrNull { it.id == sessionId }
                // Retire a memo the heartbeat has caught up with, through the
                // store — the state copy is a mirror, so clearing only that
                // would let the next emission paint the stale memo back.
                modelSwitch.value =
                    ModelSource.settle(modelSwitch.value, session, System.currentTimeMillis())
                _state.update { it.fromFleet(agent, session, host) }
                session?.session?.tail?.takeIf { it.isNotEmpty() }?.let { seed ->
                    _state.update { it.copy(entries = mergeTail(it.entries, seed)) }
                }
            }
        }
    }

    private fun seedFromFleet() {
        val agent = container.fleet.state.value.agents.firstOrNull { it.key == host }
        val session = agent?.sessions?.firstOrNull { it.id == sessionId }
        val seed = session?.session?.tail ?: emptyList()
        _state.update {
            it.fromFleet(agent, session, host)
                .copy(modelSourcePending = modelSwitch.value,
                    entries = mergeTail(it.entries, seed))
        }
    }

    private fun startLive() {
        liveJob?.cancel()
        liveJob = viewModelScope.launch {
            container.liveTail.stream(host, sessionId).collect { ev ->
                when (ev) {
                    is LiveEvent.Tail -> {
                        _state.update {
                            it.copy(entries = mergeTail(it.entries, ev.entries), liveTurn = "")
                        }
                    }
                    is LiveEvent.Turn -> _state.update {
                        // Empty text = turn committed; the tail owns it now.
                        // Prefer the frame's agent list; a hub/agent predating it
                        // carries the list only on `status`, scoped to the turn.
                        it.copy(
                            liveTurn = ev.text,
                            turnStatus = ev.status,
                            liveAgents = ev.agents.ifEmpty { ev.status?.agents ?: emptyList() },
                        )
                    }
                    // Clear the live status when the tail drops: a phone backgrounds
                    // sockets far more than a desktop tab, and a "Working…" spinner
                    // stuck on forever after the tail dies is worse than none (the
                    // same reasoning the web's Stop button uses — a status it can no
                    // longer see should not be shown). It repopulates on reconnect.
                    is LiveEvent.Connected -> _state.update {
                        if (ev.up) it.copy(connected = true)
                        else it.copy(connected = false, turnStatus = null, liveAgents = emptyList())
                    }
                }
            }
        }
    }

    private fun loadHistory(attempt: Int = 0) {
        historyJob?.cancel()
        _state.update { it.copy(loadingHistory = true) }
        historyJob = viewModelScope.launch {
            when (val r = runCatching { client.history(host, sessionId) }.getOrNull()) {
                is HubClient.HistoryResult.Ready -> {
                    _state.update {
                        val (merged, more) = prependHistory(it.entries, r.entries, r.truncated)
                        it.copy(entries = merged, hasMore = more, loadingHistory = false)
                    }
                }
                is HubClient.HistoryResult.Pending -> {
                    if (attempt < 20) { delay(3000); loadHistory(attempt + 1) }
                    else _state.update { it.copy(loadingHistory = false) }
                }
                // A refusal is not "not yet" (XERK-264): polling it for the full
                // 20×3s and then giving up in silence told the operator nothing
                // and cost them a minute. Say what the hub said, and stop.
                is HubClient.HistoryResult.Failed -> {
                    _messages.tryEmit("✗ " + r.why)
                    _state.update { it.copy(loadingHistory = false) }
                }
                null -> _state.update { it.copy(loadingHistory = false) }
            }
        }
    }

    // /history fallback poll — the web chat's POLL_MS loop (and what LiveTail's
    // doc promises the caller does): while the live socket is down, the buffer
    // otherwise only grows via the heartbeat's 500-char text-only previews, so
    // messages appear cut off mid-sentence and stay that way (XERK-77). A phone
    // backgrounds its sockets far more than a desktop tab, so this path is the
    // common one, not the exception.
    private fun startPollFallback() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(POLL_MS)
                if (!_state.value.connected) refreshHistory()
            }
        }
    }

    /** Silent /history re-fetch + merge (no spinner, no 202 retry loop). */
    private fun refreshHistory() {
        if (refreshJob?.isActive == true) return
        refreshJob = viewModelScope.launch {
            val r = runCatching { client.history(host, sessionId) }.getOrNull()
            if (r is HubClient.HistoryResult.Ready) {
                _state.update {
                    val (merged, more) = prependHistory(it.entries, r.entries, r.truncated)
                    it.copy(entries = merged, hasMore = more)
                }
            }
        }
    }

    fun setDraft(text: String) { draft.value = text }

    fun setVerbosity(v: Verbosity) {
        prefs.edit().putInt(sessionId, v.ordinal).apply()
        _state.update { it.copy(verbosity = v) }
    }

    // ---- file attachments (XERK-234) -----------------------------------------

    /**
     * Stage picked files and start their uploads. Each goes up the moment it is
     * picked, so Send is instant and a file too big is refused while there is
     * still a chip on screen to remove — the web composer's attachFiles.
     */
    fun attach(uris: List<Uri>) {
        val cap = _state.value.uploadMaxBytes
        if (!Uploads.canAttach(cap) || uris.isEmpty()) return
        val resolver = getApplication<Application>().contentResolver
        for (uri in uris) {
            if (_state.value.attachments.size >= Uploads.MAX_PER_MESSAGE) {
                _messages.tryEmit("✗ at most ${Uploads.MAX_PER_MESSAGE} files per message")
                break
            }
            val (name, size) = runCatching {
                resolver.query(uri, null, null, null, null)?.use { c ->
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (c.moveToFirst()) {
                        (if (ni >= 0) c.getString(ni) else null) to (if (si >= 0 && !c.isNull(si)) c.getLong(si) else 0L)
                    } else null
                }
            }.getOrNull() ?: (null to 0L)
            val rec = Attachment(
                key = "a" + (++attachSeq),
                name = Uploads.sanitizeUploadName(name ?: uri.lastPathSegment),
                size = size,
                status = if (size > cap) AttachStatus.ERROR else AttachStatus.UPLOADING,
                error = if (size > cap) "too big — max ${Uploads.formatBytes(cap)}" else "",
            )
            _state.update { it.copy(attachments = it.attachments + rec) }
            if (rec.status != AttachStatus.ERROR) uploadOne(rec, uri)
        }
    }

    fun removeAttachment(key: String) {
        _state.update { it.copy(attachments = it.attachments.filterNot { a -> a.key == key }) }
    }

    private fun updateAttachment(key: String, f: (Attachment) -> Attachment) {
        _state.update { st ->
            st.copy(attachments = st.attachments.map { if (it.key == key) f(it) else it })
        }
    }

    private fun uploadOne(rec: Attachment, uri: Uri) {
        viewModelScope.launch {
            val result = runCatching {
                // Read on IO: a document provider's stream can be a network
                // fetch (Drive), and the whole file has to be in hand before the
                // POST — the hub takes raw bytes with a Content-Length.
                val bytes = withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openInputStream(uri)
                        ?.use { it.readBytes() } ?: error("can't read the file")
                }
                client.api.uploadAttachment(
                    host, sessionId, rec.name,
                    bytes.toRequestBody("application/octet-stream".toMediaType()),
                )
            }
            val reply = result.getOrNull()
            if (reply != null && reply.uploadId.isNotBlank()) {
                updateAttachment(rec.key) {
                    it.copy(
                        status = AttachStatus.READY,
                        uploadId = reply.uploadId,
                        name = reply.name.ifBlank { it.name },
                        size = if (reply.size > 0) reply.size else it.size,
                    )
                }
            } else {
                val why = result.exceptionOrNull()?.let { hubErrorMessage(it) } ?: "upload failed"
                updateAttachment(rec.key) { it.copy(status = AttachStatus.ERROR, error = why) }
            }
        }
    }

    /** Send the draft: routes to answer(custom) when a question is pending. */
    fun submitDraft() {
        val text = draft.value.trim()
        val answering = _state.value.question.isNotBlank()
        // Attachments ride a plain message only, and a message can be
        // attachments alone — but never one still on its way up, which would
        // arrive with the file missing and nothing said (web chat.js send()).
        val staged = if (answering) emptyList() else _state.value.attachments
        val uploadIds = Uploads.readyUploadIds(staged)
        if (uploadIds == null) {
            _messages.tryEmit("✗ " + Uploads.holdReason(staged))
            return
        }
        if (text.isEmpty() && uploadIds.isEmpty()) return
        draft.value = ""
        if (staged.isNotEmpty()) _state.update { it.copy(attachments = emptyList()) }
        viewModelScope.launch {
            val sent = runCatching {
                if (answering) {
                    client.api.answerQuestion(host, sessionId, AnswerRequest(optionIndex = -1, custom = text))
                } else {
                    client.api.sendInput(
                        host, sessionId,
                        InputRequest(text, uploadIds.ifEmpty { null }),
                    )
                }
            }
            if (sent.isSuccess) {
                _messages.tryEmit("✓ sent")
            } else {
                // Put the message back rather than swallowing it — the web
                // composer restores its box the same way — and say WHY when the
                // hub explained itself (a paste past the character cap is
                // fixable; "hub unreachable" would send the operator hunting for
                // a network fault). Only if nothing has been typed since.
                if (draft.value.isBlank()) setDraft(text)
                // Same for the chips: the operator is going to press Send again,
                // and re-picking the files by hand is not something a failed
                // POST should cost them (the staged uploads live on the hub for
                // 20 minutes). Only if nothing has been attached since.
                if (staged.isNotEmpty() && _state.value.attachments.isEmpty()) {
                    _state.update { it.copy(attachments = staged) }
                }
                val why = sent.exceptionOrNull()?.let { hubErrorMessage(it) }
                _messages.tryEmit("✗ " + (why ?: "hub unreachable"))
            }
            container.fleet.nudge()
        }
    }

    /**
     * Kill this session (web chat/terminal header "Kill" — POST .../kill). Fire-
     * and-forget like the web's post-then-history.back(): the UI leaves the view
     * immediately, the kill lands on the agent's next beat and drops the card.
     */
    fun kill() {
        viewModelScope.launch {
            report("kill queued") { client.api.sessionAction(host, sessionId, "kill") }
            container.fleet.nudge()
        }
    }

    /**
     * Run one command and say what actually happened. A refusal the hub
     * explained — an unknown session, an offline host, a command queue too full
     * to take another — used to be swallowed by a bare `runCatching` under an
     * unconditional "✓ queued" (XERK-264), so a command that never ran read as
     * one that did. Retrofit throws a non-2xx as an HttpException carrying the
     * body, which [hubErrorMessage] reads; only a transport failure is generic.
     */
    private suspend fun report(ok: String, block: suspend () -> Unit) {
        val r = runCatching { block() }
        if (r.isSuccess) _messages.tryEmit("✓ $ok")
        else _messages.tryEmit("✗ " + (r.exceptionOrNull()?.let { hubErrorMessage(it) } ?: "hub unreachable"))
    }

    /** Interrupt the in-flight turn (web "◼ Stop" — POST .../interrupt). */
    fun stop() {
        viewModelScope.launch {
            val r = runCatching { client.api.interruptSession(host, sessionId) }
            if (r.isSuccess) _messages.tryEmit("◼ stop sent")
            else _messages.tryEmit("✗ " + (r.exceptionOrNull()?.let { hubErrorMessage(it) } ?: "hub unreachable"))
            container.fleet.nudge()
        }
    }

    fun answerOption(index: Int) {
        viewModelScope.launch {
            // Only the failure is worth a message here: the answer landing is
            // its own visible feedback (the question box goes).
            val r = runCatching { client.api.answerQuestion(host, sessionId, AnswerRequest(optionIndex = index)) }
            if (r.isFailure) _messages.tryEmit("✗ " + (r.exceptionOrNull()?.let { hubErrorMessage(it) } ?: "hub unreachable"))
            container.fleet.nudge()
        }
    }

    /** Multi-select answer: submit the picked option indices together. */
    fun answerMulti(picks: List<Int>) {
        if (picks.isEmpty()) return
        viewModelScope.launch {
            val r = runCatching { client.api.answerQuestion(host, sessionId, AnswerRequest(optionIndex = -1, optionIndices = picks)) }
            if (r.isFailure) _messages.tryEmit("✗ " + (r.exceptionOrNull()?.let { hubErrorMessage(it) } ?: "hub unreachable"))
            container.fleet.nudge()
        }
    }

    /**
     * Report what the hub actually said, never a blanket "✓ queued" (XERK-246).
     *
     * These two discarded their result, so every refusal painted as a success.
     * That was survivable while the routes only failed on the network, but the
     * hub now 409s `/model` on a session running the self-hosted model —
     * deliberately, so an out-of-parity client cannot silently drop the command
     * — and a session CAN be on the local model while the compose bar still
     * offers the picker, in the window before a switch settles. Same shape as
     * [setModelSource]'s handler, and the same reason `FleetViewModel.run`
     * stopped collapsing every failure into "hub unreachable".
     */
    private fun reportedOutcome(res: Result<OkResponse>, queued: String, failed: String) {
        _messages.tryEmit(
            ModelSource.outcomeMessage(
                ok = res.isSuccess,
                bodyError = res.getOrNull()?.error,
                hubMessage = res.exceptionOrNull()?.let { hubErrorMessage(it) },
                queued = queued,
                failed = failed,
            )
        )
    }

    fun setModel(model: String) = viewModelScope.launch {
        val res = runCatching { client.api.setModel(host, sessionId, ModelRequest(model)) }
        reportedOutcome(res, "✓ model queued", "could not set the model")
    }

    fun setMode(mode: String) = viewModelScope.launch {
        val res = runCatching { client.api.setMode(host, sessionId, ModeRequest(mode)) }
        reportedOutcome(res, "✓ mode queued", "could not set the mode")
    }

    /**
     * Move this session between the subscription and the host's self-hosted
     * model (XERK-246). The agent relaunches Claude with `--resume`, so the
     * conversation, worktree and branch carry over — but that takes several
     * beats, hence the memo the chip paints from meanwhile.
     *
     * A refusal DROPS the memo instead of letting it age out: the hub 409s when
     * the host has no local model, and a chip that keeps claiming a switch that
     * was rejected is worse than one that never moved.
     */
    fun setModelSource(source: String) = viewModelScope.launch {
        if (source == _state.value.modelSource()) return@launch
        modelSwitch.value = ModelSource.Pending(sessionId, source, System.currentTimeMillis())
        val res = runCatching { client.api.setModelSource(host, sessionId, ModelSourceRequest(source)) }
        res.onSuccess {
            _messages.tryEmit(
                if (source == ModelSource.LOCAL) "✓ switching to the local model…"
                else "✓ switching back to the subscription…"
            )
            container.fleet.nudge()
        }.onFailure { e ->
            _messages.tryEmit("✗ " + (hubErrorMessage(e) ?: "could not switch model"))
        }
        // One place decides what survives the attempt, success or failure, so
        // the drop-on-refusal can't be deleted without a test noticing.
        modelSwitch.value = ModelSource.afterAttempt(modelSwitch.value, res.isSuccess)
    }

    // ---- voice dictation into the draft --------------------------------------
    fun startDictation() {
        if (_state.value.mic != MicState.IDLE) return
        val d = container.newDictation()
        dictation = d
        _state.update { it.copy(mic = MicState.RECORDING) }
        viewModelScope.launch {
            val opened = runCatching { d.start() }.getOrDefault(false)
            if (!opened) {
                _state.update { it.copy(mic = MicState.IDLE) }
                _messages.tryEmit("✗ mic/STT unavailable")
                dictation = null
            }
        }
    }

    fun stopDictation() {
        val d = dictation ?: return
        _state.update { it.copy(mic = MicState.FINALIZING) }
        viewModelScope.launch {
            val result = runCatching { d.stopAndFinalize() }.getOrNull()
            dictation = null
            val text = (result as? Dictation.Result.Text)?.text
            // Dictation appends to whatever is already typed, so it goes through
            // the shared draft too (the mirror repaints the box).
            if (!text.isNullOrBlank()) {
                draft.value = listOf(draft.value, text).filter { s -> s.isNotBlank() }.joinToString(" ")
            }
            _state.update { it.copy(mic = MicState.IDLE) }
            if (text.isNullOrBlank()) _messages.tryEmit("✗ nothing transcribed")
        }
    }

    fun cancelDictation() {
        dictation?.cancel(); dictation = null
        if (_state.value.mic != MicState.IDLE) _state.update { it.copy(mic = MicState.IDLE) }
    }

    override fun onCleared() {
        onLeave()
        super.onCleared()
    }

    companion object {
        const val LIVE_TURN_ID = "__live_turn__"
        /** /history fallback cadence while the live WS is down (web chat POLL_MS). */
        const val POLL_MS = 6000L

        fun factory(app: Application, host: String, sessionId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ChatViewModel(app, host, sessionId) as T
            }
    }
}
