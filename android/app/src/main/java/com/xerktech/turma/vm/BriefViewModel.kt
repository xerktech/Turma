package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.FleetState
import com.xerktech.turma.net.hubErrorMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Backs the Brief screen (XERK-2397). The briefs and schedules ride the fleet
 * payload (`dailyBriefs` / `dailyBriefSchedules`), so this owns only the Run now
 * call: which org has one in flight, and the hub's words when it refuses one
 * (XERK-264). Schedule editing is web-only (android/PARITY.md).
 */
class BriefViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<FleetState> get() = container.fleet.state

    /** The header's org selection (XERK-62), shared by every screen. */
    val orgFilter: StateFlow<Set<String>> get() = container.org.stored

    fun start() = container.fleet.start()

    private val _asking = MutableStateFlow<Set<String>>(emptySet())

    /** Orgs whose Run now POST has not answered yet. */
    val asking: StateFlow<Set<String>> = _asking

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    /**
     * Ask the hub to write [siteKey]'s brief now. The started row arrives on the
     * fleet payload (and its SSE event); a refusal — one already being written,
     * no capable host, asked again too soon — is shown in the hub's own words.
     */
    fun runNow(siteKey: String): Job = viewModelScope.launch {
        if (siteKey in _asking.value) return@launch
        _asking.value = _asking.value + siteKey
        val err = try {
            val r = container.client.api.runDailyBrief(siteKey)
            val body = r.body()
            when {
                !r.isSuccessful -> hubErrorMessage(r)
                body != null && !body.ok -> body.error.ifBlank { "the hub did not start a brief" }
                else -> null
            }
        } catch (_: Exception) {
            "the hub is unreachable"
        }
        _asking.value = _asking.value - siteKey
        if (err != null) _messages.tryEmit("✗ $err")
        container.fleet.nudge()
    }
}
