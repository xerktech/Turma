package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.FleetState
import com.xerktech.turma.net.hubErrorMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Backs the Brief screen (XERK-1573, web `brief.html`). The briefs themselves
 * ride the fleet payload (`FleetState.briefs`); this only adds the on-demand
 * "Brief now" and its in-flight / refused state per org.
 */
class BriefViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<FleetState> get() = container.fleet.state

    /** The header's org selection (XERK-62), shared by every screen. */
    val orgFilter get() = container.org.stored

    private val _busy = MutableStateFlow<Set<String>>(emptySet())
    /** Orgs with a "Brief now" in flight. */
    val busy: StateFlow<Set<String>> = _busy

    private val _errors = MutableStateFlow<Map<String, String>>(emptyMap())
    /** The hub's own words for an org's last refused "Brief now" (XERK-264). */
    val errors: StateFlow<Map<String, String>> = _errors

    fun start() = container.fleet.start()

    /** Ask the hub to compile [siteKey]'s brief now; it lands on the next poll/SSE frame. */
    fun briefNow(siteKey: String): Job = viewModelScope.launch {
        _busy.value = _busy.value + siteKey
        _errors.value = _errors.value - siteKey
        val failure = runCatching { container.client.api.briefNow(siteKey) }.exceptionOrNull()
        if (failure != null) {
            _errors.value = _errors.value +
                (siteKey to "Brief now failed — ${hubErrorMessage(failure) ?: "the hub is unreachable"}")
        }
        _busy.value = _busy.value - siteKey
        container.fleet.nudge()
    }
}
