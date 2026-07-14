package com.xerktech.turma.ui

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.xerktech.turma.TurmaApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Raw ttyd terminal in a WebView — the "Terminal ▸" debugging affordance. We
 * plant the hub's login cookie into the WebView's CookieManager (via POST
 * /api/login) so every ttyd subresource + its WebSocket authenticates, then
 * load /term/<sessionId>/.
 */
@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalScreen(sessionId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val container = (context.applicationContext as TurmaApplication).container
    val settings = container.config.current
    val termUrl = settings.baseUrl + "term/$sessionId/"

    val ready by produceState(initialValue = false, sessionId) {
        value = withContext(Dispatchers.IO) { plantCookie(container, settings.baseUrl) }
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Terminal") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        )
    }) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            if (!ready) {
                Text("Connecting terminal…", Modifier.padding(16.dp))
            } else {
                AndroidView(factory = { ctx ->
                    WebView(ctx).apply {
                        this.settings.javaScriptEnabled = true
                        this.settings.domStorageEnabled = true
                        webViewClient = WebViewClient()
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                        loadUrl(termUrl)
                    }
                }, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

/** POST /api/login and copy the Set-Cookie into the WebView CookieManager. */
private fun plantCookie(container: com.xerktech.turma.AppContainer, baseUrl: String): Boolean {
    val s = container.config.current
    return try {
        val body = "{\"username\":${jsonStr(s.user)},\"password\":${jsonStr(s.password)}}"
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url(baseUrl + "api/login").post(body).build()
        container.client.http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return false
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            for (c in resp.headers("Set-Cookie")) cm.setCookie(baseUrl, c)
            cm.flush()
            true
        }
    } catch (_: Exception) {
        false
    }
}

private fun jsonStr(s: String): String = buildString {
    append('"')
    for (ch in s) when (ch) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        else -> append(ch)
    }
    append('"')
}
