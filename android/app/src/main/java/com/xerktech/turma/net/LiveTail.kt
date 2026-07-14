package com.xerktech.turma.net

import com.xerktech.turma.data.Config
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TailFrame
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.model.TurnStatus
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.serialization.decodeFromString
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.coroutines.coroutineContext

/**
 * Live transcript WebSocket — a port of glasses/src/live.ts. Streams a session's
 * committed `tail` deltas and the in-progress `turn` from /live/<host>/<id>. A
 * fresh ws-token is fetched per (re)connect; reconnect uses capped exponential
 * backoff. Purely additive: if the socket never connects the caller falls back
 * to the /history poll, exactly as the web + glasses clients do.
 */
sealed interface LiveEvent {
    data class Tail(val entries: List<TailEntry>) : LiveEvent
    data class Turn(val text: String, val status: TurnStatus?) : LiveEvent
    /** Emitted on connect/disconnect so the UI can show a live/offline dot. */
    data class Connected(val up: Boolean) : LiveEvent
}

class LiveTail(private val client: HubClient, private val config: Config) {

    private val backoffMs = longArrayOf(1000, 2000, 4000, 8000, 15000)

    fun stream(host: String, sessionId: String): Flow<LiveEvent> = callbackFlow {
        var attempt = 0
        var socket: WebSocket? = null

        while (coroutineContext.isActive) {
            val token = try {
                client.api.wsToken().token
            } catch (_: Exception) {
                // Can't even mint a token (hub down / unauthorized): back off.
                delayBackoff(attempt++); continue
            }
            if (token.isEmpty()) { delayBackoff(attempt++); continue }

            val url = config.current.liveUrl(host, sessionId, token)
            val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
            var opened = false

            val ws = client.http.newWebSocket(
                Request.Builder().url(url).build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        opened = true
                        attempt = 0
                        trySend(LiveEvent.Connected(true))
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val frame = try { TurmaJson.decodeFromString<TailFrame>(text) } catch (_: Exception) { return }
                        when (frame.type) {
                            "tail" -> if (frame.entries.isNotEmpty()) trySend(LiveEvent.Tail(frame.entries))
                            "turn" -> trySend(LiveEvent.Turn(frame.text, frame.status))
                        }
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        if (!closed.isCompleted) closed.complete(Unit)
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        if (!closed.isCompleted) closed.complete(Unit)
                    }
                },
            )
            socket = ws

            closed.await() // suspend until this socket dies
            trySend(LiveEvent.Connected(false))
            // If it never opened, the token may be bad — the next loop refetches.
            delayBackoff(if (opened) 0 else attempt++)
        }

        awaitClose { socket?.close(1000, null) }
    }

    private suspend fun delayBackoff(attempt: Int) {
        if (attempt <= 0) return
        val idx = (attempt - 1).coerceIn(0, backoffMs.size - 1)
        kotlinx.coroutines.delay(backoffMs[idx])
    }
}
