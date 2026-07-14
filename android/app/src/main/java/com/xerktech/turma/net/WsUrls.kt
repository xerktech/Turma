package com.xerktech.turma.net

import com.xerktech.turma.data.Config

/**
 * ws(s):// base derived from the configured hub URL. A https hub upgrades to
 * wss; the plain-ws branch below is only ever taken for an http:// hub, i.e. a
 * LAN dev address the operator typed — the production tunnel is always https.
 */
fun Config.Settings.wsBase(): String {
    val b = baseUrl.trimEnd('/')
    return when {
        b.startsWith("https://") -> "wss://" + b.removePrefix("https://")
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- intentional: only an http:// (LAN dev) hub yields ws://; https upgrades to wss above.
        b.startsWith("http://") -> "ws://" + b.removePrefix("http://")
        else -> b
    }
}

fun Config.Settings.liveUrl(host: String, sessionId: String, token: String): String =
    "${wsBase()}/live/$host/$sessionId?auth=$token"

fun Config.Settings.audioUrl(token: String): String = "${wsBase()}/audio?auth=$token"
