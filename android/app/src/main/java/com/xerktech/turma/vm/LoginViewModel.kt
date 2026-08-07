package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.SignInResult
import com.xerktech.turma.core.signInError
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

    /**
     * Verify the typed creds against the hub, and only then save them and
     * register for push.
     *
     * The order matters (XERK-228): saving is what flips `Settings.configured`,
     * which is TurmaApp's NavHost start destination — so saving first signed a
     * wrong password straight into the dashboard, where every call 401'd, and
     * left those creds stored for the next launch to walk into again. A
     * refusal now says so, in the web login's own words.
     */
    fun signIn(hubUrl: String, user: String, password: String) {
        _state.update { it.copy(busy = true, error = null) }
        val candidate = Config.Settings(hubUrl = hubUrl.trim(), user = user.trim(), password = password)
        viewModelScope.launch {
            val result = container.client.probeCredentials(candidate)
            if (result == SignInResult.Ok) {
                container.config.save(hubUrl, user, password)
                PushRegistrar.register(app, container)
                _state.update { it.copy(busy = false, done = true) }
            } else {
                _state.update { it.copy(busy = false, error = signInError(result)) }
            }
        }
    }

}
