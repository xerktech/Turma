package com.xerktech.turma.net

import com.xerktech.turma.data.Config

/** ws(s):// base derived from the configured hub URL. */
fun Config.Settings.wsBase(): String {
    val b = baseUrl.trimEnd('/')
    return when {
        b.startsWith("https://") -> "wss://" + b.removePrefix("https://")
        b.startsWith("http://") -> "ws://" + b.removePrefix("http://")
        else -> b
    }
}

fun Config.Settings.liveUrl(host: String, sessionId: String, token: String): String =
    "${wsBase()}/live/$host/$sessionId?auth=$token"

fun Config.Settings.audioUrl(token: String): String = "${wsBase()}/audio?auth=$token"
