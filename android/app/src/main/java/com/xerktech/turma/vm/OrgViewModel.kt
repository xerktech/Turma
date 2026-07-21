package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.AutoStartRequest
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Backs the header's org control (XERK-62) — the one place per-org settings now
 * live. It owns nothing itself: the pick is the container's (shared by every
 * screen) and the auto-start opt-in is the hub's, so this is purely the screen's
 * handle on both.
 */
class OrgViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<com.xerktech.turma.net.FleetState> get() = container.fleet.state

    /** The operator's literal pick ("" = all orgs); self-healed at the render. */
    val org: StateFlow<String> get() = container.org.stored

    fun setOrg(key: String) = container.org.set(key)

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    /**
     * Flip an org's auto-start opt-in (XERK-41), which rode the board's org chips
     * before this control replaced them. Hub-owned and durable — the POST is
     * authoritative, and the fleet payload's autoStartOrgs (plus its SSE event)
     * reflects it on the next poll.
     */
    fun setAutoStart(siteKey: String, enabled: Boolean) {
        viewModelScope.launch {
            val ok = runCatching {
                container.client.api.setAutoStart(siteKey, AutoStartRequest(enabled))
            }.isSuccess
            _messages.tryEmit(if (ok) "✓ auto-start updated" else "✗ hub unreachable")
            container.fleet.nudge()
        }
    }
}
