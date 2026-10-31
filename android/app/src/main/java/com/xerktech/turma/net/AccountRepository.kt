package com.xerktech.turma.net

import com.xerktech.turma.data.Config
import com.xerktech.turma.model.Me
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import retrofit2.HttpException

/**
 * Who the app is signed in as (XERK-2553), from `GET /api/me`. Held app-wide
 * (one value every screen's ⋮ menu reads, and the admin-only screen), and
 * re-read whenever the stored credential changes, so a sign-out or a sign-in
 * as somebody else never shows the previous account.
 *
 * Null = not known: signed out, an older hub (404), or not answered yet. A
 * 4xx the hub answered stays null until the credential changes; a 5xx (a hub
 * mid-rollout) or a network failure retries every [retryMs].
 *
 * Only a change of WHO (signed in or out, hub, username) clears the value; a
 * session-token refresh for the same sign-in re-reads it in place, so the ⋮
 * label and the admin-only screen never blink off.
 */
class AccountRepository(
    private val client: HubClient,
    config: Config,
    scope: CoroutineScope,
    private val retryMs: Long = 30_000,
) {
    private val _me = MutableStateFlow<Me?>(null)
    val me: StateFlow<Me?> = _me.asStateFlow()

    init {
        scope.launch {
            var who: Triple<Boolean, String, String>? = null
            config.state
                .map { Triple(Triple(it.configured, it.hubUrl, it.user), it.sessionToken, it.password) }
                .distinctUntilChanged()
                .collectLatest { (id, _, _) ->
                    if (id != who) _me.value = null
                    who = id
                    if (!id.first) return@collectLatest
                    while (true) {
                        val r = runCatching { client.api.me() }
                        r.getOrNull()?.let { _me.value = it; return@collectLatest }
                        val e = r.exceptionOrNull()
                        if (e is HttpException && e.code() < 500) return@collectLatest
                        delay(retryMs)
                    }
                }
        }
    }
}
