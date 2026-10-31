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
 * failure the hub ANSWERED stays null for good; a network failure retries.
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
            config.state
                .map { Triple(it.configured, it.hubUrl, it.sessionToken + "\u0000" + it.user) }
                .distinctUntilChanged()
                .collectLatest { (configured, _, _) ->
                    _me.value = null
                    if (!configured) return@collectLatest
                    while (true) {
                        val r = runCatching { client.api.me() }
                        r.getOrNull()?.let { _me.value = it; return@collectLatest }
                        if (r.exceptionOrNull() is HttpException) return@collectLatest
                        delay(retryMs)
                    }
                }
        }
    }
}
