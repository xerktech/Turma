package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.RevealState
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.VerbosityPrefs
import com.xerktech.turma.core.advanceReveal
import com.xerktech.turma.core.liveRevealBase
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
    val reveal: RevealState = RevealState(),
    val verbosity: Verbosity = Verbosity.CONCISE,
    val connected: Boolean = false,
    val hasMore: Boolean = false,
    val loadingHistory: Boolean = false,
    val mic: MicState = MicState.IDLE,
    val draft: String = "",
    val session: SessionInfo? = null,
) {
    val prefs: VerbosityPrefs get() = VerbosityPrefs.forPreset(verbosity)
    val question: String get() = session?.session?.question ?: ""
    val questionOptions: List<String> get() = session?.session?.questionOptions ?: emptyList()
    val questionOptionsRich: List<com.xerktech.turma.model.QuestionOption> get() = session?.session?.questionOptionsRich ?: emptyList()
    val questionHeader: String get() = session?.session?.questionHeader ?: ""
    val questionMulti: Boolean get() = session?.session?.questionMulti ?: false
    val questionTotal: Int? get() = session?.session?.questionTotal
    val questionIndex: Int? get() = session?.session?.questionIndex
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

    private var liveJob: Job? = null
    private var revealJob: Job? = null
    // The live text the current reveal offset indexes into, for the non-monotonic
    // pane-scrape snap check (see liveRevealBase / startRevealLoop).
    private var lastLiveText: String = ""
    private var historyJob: Job? = null
    private var fleetJob: Job? = null
    private var dictation: Dictation? = null

    fun onEnter() {
        seedFromFleet()
        observeFleet()
        startLive()
        startRevealLoop()
        loadHistory()
    }

    // Symmetric with onEnter: cancels every launched job so a re-entry (the
    // two-pane detail swapping back to a session whose VM lingered in the store)
    // restarts cleanly rather than stacking a second collector on each job.
    fun onLeave() {
        liveJob?.cancel(); revealJob?.cancel(); historyJob?.cancel(); fleetJob?.cancel()
        cancelDictation()
    }

    // Session record + heartbeat tail seed + question state ride the fleet poll.
    private fun observeFleet() {
        fleetJob?.cancel()
        fleetJob = viewModelScope.launch {
            container.fleet.state.collect { fleet ->
                val session = fleet.agents.firstOrNull { it.key == host }
                    ?.sessions?.firstOrNull { it.id == sessionId }
                _state.update { it.copy(session = session) }
                session?.session?.tail?.takeIf { it.isNotEmpty() }?.let { seed ->
                    _state.update { it.copy(entries = mergeTail(it.entries, seed)) }
                }
            }
        }
    }

    private fun seedFromFleet() {
        val session = container.fleet.state.value.agents.firstOrNull { it.key == host }
            ?.sessions?.firstOrNull { it.id == sessionId }
        val seed = session?.session?.tail ?: emptyList()
        _state.update { it.copy(session = session, entries = mergeTail(it.entries, seed)) }
    }

    private fun startLive() {
        liveJob?.cancel()
        liveJob = viewModelScope.launch {
            container.liveTail.stream(host, sessionId).collect { ev ->
                when (ev) {
                    is LiveEvent.Tail -> _state.update {
                        it.copy(entries = mergeTail(it.entries, ev.entries), liveTurn = "")
                    }
                    is LiveEvent.Turn -> _state.update {
                        // Empty text = turn committed; the tail owns it now.
                        it.copy(liveTurn = ev.text, turnStatus = ev.status)
                    }
                    is LiveEvent.Connected -> _state.update { it.copy(connected = ev.up) }
                }
            }
        }
    }

    // Typewriter tick (~12fps). Reveals the newest entry (the live turn types;
    // a committed entry snaps). Cheap idle loop when nothing is changing.
    private fun startRevealLoop() {
        revealJob?.cancel()
        revealJob = viewModelScope.launch {
            while (isActive) {
                val s = _state.value
                val (newestId, targetLen, live) = newestTarget(s)
                if (newestId.isNotEmpty()) {
                    // The live pane scrape isn't monotonic: when the new capture no
                    // longer continues what we've revealed, snap the base so we don't
                    // re-stream from a stale offset (XERK-19). Non-live entries are
                    // monotonic and need no snap.
                    val prev = if (live && newestId == s.reveal.entryId) {
                        s.reveal.copy(shown = liveRevealBase(lastLiveText, s.reveal.shown, s.liveTurn))
                    } else s.reveal
                    val next = advanceReveal(prev, newestId, targetLen, 80, live)
                    if (next != s.reveal) _state.update { it.copy(reveal = next) }
                }
                lastLiveText = if (live) s.liveTurn else ""
                delay(80)
            }
        }
    }

    private fun newestTarget(s: ChatUiState): Triple<String, Int, Boolean> {
        if (s.liveTurn.isNotBlank()) return Triple(LIVE_TURN_ID, s.liveTurn.length, true)
        val last = s.entries.lastOrNull() ?: return Triple("", 0, false)
        val len = if (last.text.isNotEmpty()) last.text.length
        else last.blocks.sumOf { b -> (b as? com.xerktech.turma.model.TextBlock)?.text?.length ?: 0 }
        return Triple(last.key, len, false)
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

    fun setDraft(text: String) = _state.update { it.copy(draft = text) }

    fun setVerbosity(v: Verbosity) {
        prefs.edit().putInt(sessionId, v.ordinal).apply()
        _state.update { it.copy(verbosity = v) }
    }

    /** Send the draft: routes to answer(custom) when a question is pending. */
    fun submitDraft() {
        val text = _state.value.draft.trim()
        if (text.isEmpty()) return
        _state.update { it.copy(draft = "") }
        viewModelScope.launch {
            val ok = runCatching {
                if (_state.value.question.isNotBlank()) {
                    client.api.answerQuestion(host, sessionId, AnswerRequest(optionIndex = -1, custom = text))
                } else {
                    client.api.sendInput(host, sessionId, InputRequest(text))
                }
            }.isSuccess
            _messages.tryEmit(if (ok) "✓ sent" else "✗ hub unreachable")
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
            _state.update {
                val merged = if (!text.isNullOrBlank()) listOf(it.draft, text).filter { s -> s.isNotBlank() }.joinToString(" ") else it.draft
                it.copy(mic = MicState.IDLE, draft = merged)
            }
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

        fun factory(app: Application, host: String, sessionId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ChatViewModel(app, host, sessionId) as T
            }
    }
}
