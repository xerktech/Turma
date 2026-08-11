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
import com.xerktech.turma.core.Uploads
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.VerbosityPrefs
import com.xerktech.turma.core.entryTruncated
import com.xerktech.turma.core.mergeTail
import com.xerktech.turma.core.prependHistory
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

    init {
        // Collected on viewModelScope (not the onEnter/onLeave jobs): the mirror
        // must survive a detail-pane swap, or a re-entry would paint an empty box
        // until the next keystroke.
        viewModelScope.launch { draft.collect { text -> _state.update { it.copy(draft = text) } } }
    }

    private var liveJob: Job? = null
    private var historyJob: Job? = null
    private var fleetJob: Job? = null
    private var pollJob: Job? = null
    private var refreshJob: Job? = null
    // Entry keys whose cap-truncated live-tail blocks already triggered a
    // /history upgrade fetch — one fetch per entry, so a block still truncated
    // at the FULL caps can't refetch forever.
    private val upgradedKeys = HashSet<String>()
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
                val label = agent?.device?.ifBlank { host } ?: host
                _state.update {
                    it.copy(session = session, hostLabel = label,
                        tunnelOnline = agent?.terminalOnline ?: true,
                        uploadMaxBytes = agent?.uploadMaxBytes ?: 0)
                }
                session?.session?.tail?.takeIf { it.isNotEmpty() }?.let { seed ->
                    _state.update { it.copy(entries = mergeTail(it.entries, seed)) }
                }
            }
        }
    }

    private fun seedFromFleet() {
        val agent = container.fleet.state.value.agents.firstOrNull { it.key == host }
        val session = agent?.sessions?.firstOrNull { it.id == sessionId }
        val label = agent?.device?.ifBlank { host } ?: host
        val seed = session?.session?.tail ?: emptyList()
        _state.update {
            it.copy(session = session, hostLabel = label,
                tunnelOnline = agent?.terminalOnline ?: true,
                uploadMaxBytes = agent?.uploadMaxBytes ?: 0,
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
                        maybeUpgradeTruncated(ev.entries)
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

    /**
     * The live tail clips blocks to the tight LIVE caps (4000-char text), so a
     * long assistant message arrives flagged truncated. The web offers a manual
     * "Show more…" that refetches /history (FULL caps); here the upgrade is
     * automatic — once per entry key, so an entry still truncated at the FULL
     * caps can't loop.
     */
    private fun maybeUpgradeTruncated(incoming: List<TailEntry>) {
        val need = incoming.asSequence()
            .filter { entryTruncated(it) }
            .map { it.key }
            .filter { it.isNotEmpty() && it !in upgradedKeys }
            .toList()
        if (need.isEmpty()) return
        upgradedKeys.addAll(need)
        refreshHistory()
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
            runCatching { client.api.sessionAction(host, sessionId, "kill") }
            _messages.tryEmit("✓ kill queued")
            container.fleet.nudge()
        }
    }

    /** Interrupt the in-flight turn (web "◼ Stop" — POST .../interrupt). */
    fun stop() {
        viewModelScope.launch {
            runCatching { client.api.interruptSession(host, sessionId) }
            _messages.tryEmit("◼ stop sent")
            container.fleet.nudge()
        }
    }

    fun answerOption(index: Int) {
        viewModelScope.launch {
            runCatching { client.api.answerQuestion(host, sessionId, AnswerRequest(optionIndex = index)) }
            container.fleet.nudge()
        }
    }

    /** Multi-select answer: submit the picked option indices together. */
    fun answerMulti(picks: List<Int>) {
        if (picks.isEmpty()) return
        viewModelScope.launch {
            runCatching { client.api.answerQuestion(host, sessionId, AnswerRequest(optionIndex = -1, optionIndices = picks)) }
            container.fleet.nudge()
        }
    }

    fun setModel(model: String) = viewModelScope.launch {
        runCatching { client.api.setModel(host, sessionId, ModelRequest(model)) }
        _messages.tryEmit("✓ model queued")
    }

    fun setMode(mode: String) = viewModelScope.launch {
        runCatching { client.api.setMode(host, sessionId, ModeRequest(mode)) }
        _messages.tryEmit("✓ mode queued")
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
