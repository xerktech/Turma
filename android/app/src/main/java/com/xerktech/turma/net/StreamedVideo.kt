package com.xerktech.turma.net

import com.xerktech.turma.AppContainer
import com.xerktech.turma.model.SendFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.IOException

private const val STREAM_POLL_MS = 1500L
private const val STREAM_WAIT_MS = 5 * 60 * 1000L
private val REF_RE = Regex("[0-9a-f]{32}")
private const val CACHE_KEEP_MS = 24 * 60 * 60 * 1000L

/**
 * A streamed SendUserFile video (web parity: chat.js streamVideoClick): poll the
 * hub until the host has uploaded it — the first poll is what asks the host —
 * then download it through the signed-in client into [cacheDir] and return the
 * file. Reuses a complete cached copy. Fails with the hub's own words.
 */
suspend fun fetchStreamedVideo(
    container: AppContainer, host: String, sessionId: String, f: SendFile, cacheDir: File,
): Result<File> = withContext(Dispatchers.IO) {
    runCatching {
        if (!REF_RE.matches(f.ref)) throw IOException("this video has no usable reference")
        val ext = f.name.substringAfterLast('.', "mp4").lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,5}")) } ?: "mp4"
        val dir = File(cacheDir, "sendfile-video").apply { mkdirs() }
        val dest = File(dir, "stream-${f.ref}.$ext")
        // Streamed copies are re-fetchable: keep the cache from growing forever.
        val cutoff = System.currentTimeMillis() - CACHE_KEEP_MS
        dir.listFiles()?.forEach { if (it.name.startsWith("stream-") && it != dest && it.lastModified() < cutoff) it.delete() }
        if (dest.isFile && f.size > 0 && dest.length() == f.size) return@runCatching dest
        val until = System.currentTimeMillis() + STREAM_WAIT_MS
        while (true) {
            val st = container.client.api.sendFileStatus(host, sessionId, f.ref)
            when (st.state) {
                "ready" -> break
                "error" -> throw IOException(st.error.ifBlank { "the host could not send it" })
            }
            if (System.currentTimeMillis() > until) throw IOException("the host didn't send the video in time")
            delay(STREAM_POLL_MS)
        }
        val url = container.config.current.baseUrl + "api/agents/" + enc(host) + "/sessions/" +
            enc(sessionId) + "/sendfile/" + f.ref
        val part = File(dir, dest.name + ".part")
        container.client.http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("the hub answered HTTP ${resp.code}")
            val body = resp.body ?: throw IOException("the hub sent no video")
            part.outputStream().use { out -> body.byteStream().copyTo(out) }
        }
        if (!part.renameTo(dest)) throw IOException("could not save the video")
        dest
    }
}

private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
