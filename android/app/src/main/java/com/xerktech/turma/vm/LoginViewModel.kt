package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.data.Config
import com.xerktech.turma.push.PushRegistrar
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Sign-in / settings: save + validate hub creds, then (re)register for push. */
class LoginViewModel(private val app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container

    data class Ui(val busy: Boolean = false, val error: String? = null, val done: Boolean = false)

    private val _state = MutableStateFlow(Ui())
    val state: StateFlow<Ui> = _state

    val current: Config.Settings get() = container.config.current

    /** Save creds, verify by hitting /api/agents, and register for push on success. */
    fun signIn(hubUrl: String, user: String, password: String) {
        _state.update { it.copy(busy = true, error = null) }
        container.config.save(hubUrl, user, password)
        viewModelScope.launch {
            val ok = runCatching { container.client.api.listAgents() }.isSuccess
            if (ok) {
                PushRegistrar.register(app, container)
                _state.update { it.copy(busy = false, done = true) }
            } else {
                _state.update { it.copy(busy = false, error = "Could not reach the hub — check URL and credentials.") }
            }
        }
    }

    fun signOut() {
        PushRegistrar.unregister(app, container)
        container.config.clear()
        _state.update { Ui() }
    }
}
