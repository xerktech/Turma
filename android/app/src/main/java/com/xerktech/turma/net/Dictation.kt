package com.xerktech.turma.net

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import com.xerktech.turma.data.Config
import com.xerktech.turma.model.AudioResult
import com.xerktech.turma.model.TurmaJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.decodeFromString
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

/**
 * Voice dictation: streams 16 kHz mono PCM16 (the /audio contract) to the hub's
 * Whisper STT socket and returns the transcript. A port of glasses/src/audio.ts
 * discipline — open the socket first, THEN turn the mic on; mic-off is
 * idempotent on every teardown path (a stuck mic is the worst failure); never
 * throws — drops/timeouts degrade to [Result.Unavailable].
 */
class Dictation(private val client: HubClient, private val config: Config) {

    sealed interface Result {
        data class Text(val text: String) : Result
        data class Unavailable(val reason: String) : Result
    }

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val FINALIZE_TIMEOUT_MS = 15_000L
    }

    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var captureThread: Thread? = null
    @Volatile private var capturing = false
    private var webSocket: WebSocket? = null
    private var result: CompletableDeferred<AudioResult.Transcript>? = null

    /** Open the socket and start capturing. Returns false if the socket can't open. */
    suspend fun start(): Boolean {
        val token = try { client.api.wsToken().token } catch (_: Exception) { return false }
        if (token.isEmpty()) return false
        val url = config.current.audioUrl(token)
        val opened = CompletableDeferred<Boolean>()
        val deferred = CompletableDeferred<AudioResult.Transcript>()
        result = deferred

        webSocket = client.http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!opened.isCompleted) opened.complete(true)
                    startCapture(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val r = runCatching { TurmaJson.decodeFromString<AudioResult>(text) }.getOrNull() ?: return
                    if (r.type == "audio_result" && !deferred.isCompleted) deferred.complete(r.transcript)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!opened.isCompleted) opened.complete(false)
                    if (!deferred.isCompleted) deferred.complete(AudioResult.Transcript(unavailable = true, reason = "socket"))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!deferred.isCompleted) deferred.complete(AudioResult.Transcript(unavailable = true, reason = "closed"))
                }
            },
        )
        return withTimeoutOrNull(8_000) { opened.await() } ?: false
    }

    /** Stop the mic, ask the server to transcribe, and await the result. */
    suspend fun stopAndFinalize(): Result {
        stopCapture()
        webSocket?.send("{\"type\":\"finalize\"}")
        val t = withTimeoutOrNull(FINALIZE_TIMEOUT_MS) { result?.await() }
        webSocket?.close(1000, null)
        webSocket = null
        return when {
            t == null || t.unavailable -> Result.Unavailable(t?.reason ?: "timeout")
            else -> Result.Text(t.text)
        }
    }

    /** Abandon: mic off, socket closed, server discards the buffer. */
    fun cancel() {
        stopCapture()
        webSocket?.close(1000, null)
        webSocket = null
        result?.cancel()
        result = null
    }

    @SuppressLint("MissingPermission") // caller ensures RECORD_AUDIO before start()
    private fun startCapture(ws: WebSocket) {
        if (capturing) return
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val bufSize = maxOf(minBuf, 4096)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize,
            )
        } catch (_: Exception) {
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release(); return
        }
        recorder = rec
        capturing = true
        rec.startRecording()
        captureThread = Thread {
            val buf = ByteArray(bufSize)
            while (capturing) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) ws.send(buf.toByteString(0, n))
                else if (n < 0) break
            }
        }.also { it.isDaemon = true; it.start() }
    }

    /** Idempotent mic teardown — safe to call from any path. */
    @Synchronized
    private fun stopCapture() {
        capturing = false
        captureThread = null
        recorder?.let {
            runCatching { if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) it.stop() }
            runCatching { it.release() }
        }
        recorder = null
    }
}
