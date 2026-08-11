package com.xerktech.turma.ui

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import com.xerktech.turma.BuildConfig
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.liveMarker
import com.xerktech.turma.core.tunnelOnlineOf
import com.xerktech.turma.net.InputRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Raw ttyd terminal in a WebView — the "Terminal ▸" debugging affordance. We
 * plant the hub's login cookie into the WebView's CookieManager (via POST
 * /api/login) so every ttyd subresource + its WebSocket authenticates, then
 * load /term/<sessionId>/. Load failures surface on-screen (not a blank white
 * page) and the WebView console is mirrored to logcat (tag "TurmaTerm").
 */
@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalScreen(host: String, sessionId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val container = (context.applicationContext as TurmaApplication).container
    val settings = container.config.current
    val termUrl = settings.baseUrl + "term/$sessionId/"
    val scope = rememberCoroutineScope()

    var reload by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    // The fleet beat: the tunnel marker below (XERK-252) and the compose bar's
    // busy read both come off it, so it is collected ONCE here rather than a
    // second time further down.
    val fleet by container.fleet.state.collectAsStateWithLifecycle()
    val agent = fleet.agents.firstOrNull { it.key == host }
    val tunnelOnline = tunnelOnlineOf(agent)
    // Heal in place when the tunnel comes back, the way the web re-navigates its
    // ttyd iframe (XERK-252). This screen needs it MORE than the chat does: ttyd
    // is served THROUGH the control channel, so the WebView died with it and
    // nothing inside the frame retries — without this the operator is left on a
    // stale 502 with a manual Retry, long after the host is fine again.
    //
    // The RETURN edge only. Keying on `tunnelOnline` alone would fire on first
    // composition and reload a terminal that had just loaded, and re-firing per
    // beat while it stays up would restart the terminal every few seconds.
    var sawTunnelDown by remember { mutableStateOf(false) }
    LaunchedEffect(tunnelOnline) {
        if (tunnelOnline && sawTunnelDown) reload++
        sawTunnelDown = !tunnelOnline
    }

    val ready by produceState(initialValue = false, sessionId, reload) {
        error = null
        value = withContext(Dispatchers.IO) { plantCookie(container, settings.baseUrl) }
    }

    Scaffold(
        // Keep the input bar above the soft keyboard (XERK-76) — edge-to-edge
        // means the IME otherwise overlays it. Same fix as the chat screen.
        modifier = Modifier.imePadding(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    // Whether anything can actually reach this pane (XERK-252),
                    // the same marker the chat header carries. `connected` is
                    // false here by construction — this screen keeps no /live
                    // socket of its own — so the only thing liveMarker can say
                    // is the warning, which is the half that matters: the
                    // WebView below is dead and this is why.
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Terminal", maxLines = 1)
                        val mark = liveMarker(tunnelOnline, false)
                        if (mark.isNotEmpty()) {
                            Text(
                                " · " + mark,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = { reload++ }) { Icon(Icons.Filled.Refresh, "Reload") }
                    // Kill the session you're in (web termKill): arm/confirm, then
                    // leave the terminal — the session drops on the next beat.
                    KillAction(onKill = {
                        scope.launch {
                            runCatching { container.client.api.sessionAction(host, sessionId, "kill") }
                            container.fleet.nudge()
                        }
                        onBack()
                    })
                },
            )
        },
    ) { pad ->
      Column(Modifier.fillMaxSize().padding(pad)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                !ready -> Text("Connecting terminal…", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onBackground)
                else -> AndroidView(
                    factory = { ctx ->
                        WebView(ctx).apply {
                            // ttyd renders with xterm's CANVAS renderer (agent launches
                            // it `-t rendererType=canvas`), which paints BLACK in a
                            // hardware-accelerated Android WebView. A software layer
                            // composites the 2D canvas on the CPU so it draws correctly.
                            setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
                            setBackgroundColor(AndroidColor.parseColor("#0D0D0D"))
                            with(this.settings) {
                                javaScriptEnabled = true
                                domStorageEnabled = true
                                databaseEnabled = true
                                mediaPlaybackRequiresUserGesture = false
                                // ttyd loads over https and opens a wss WebSocket;
                                // compatibility mode avoids spurious mixed-content blocks.
                                mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                                // NB: do NOT enable useWideViewPort/loadWithOverviewMode —
                                // they make the WebView size the layout viewport from content,
                                // which collapses ttyd's height:100% terminal to ~1 row.
                            }
                            // Debug builds only. Unconditional, this shipped in
                            // every RELEASE APK the in-app updater installs, so
                            // anyone with ADB access to the device could attach
                            // DevTools to a WebView holding the planted hub
                            // session cookie and the live terminal (XERK-235).
                            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                            webChromeClient = object : WebChromeClient() {
                                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                                    Log.w("TurmaTerm", "console: ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                                    return true
                                }
                            }
                            webViewClient = object : WebViewClient() {
                                override fun onPageFinished(view: WebView, url: String) {
                                    // ttyd/xterm fits to its container; if the initial fit ran
                                    // before the WebView had a size the canvas stays 0×0 (black).
                                    // Nudge a resize once layout settles so it re-fits + redraws,
                                    // and log the measured dimensions for diagnosis.
                                    // ttyd's terminal collapses to ~1 row here: this WebView
                                    // resolves BOTH height:100% (parent chain is 0) AND 100vh
                                    // (layout-viewport height is 0) to 0. So size the page + the
                                    // xterm element in explicit PIXELS from window.innerHeight
                                    // (inline !important, which always applies), then re-fit.
                                    view.evaluateJavascript(
                                        """(function(){
                                          function px(e,h,w){ e.style.setProperty('height',h+'px','important');
                                            e.style.setProperty('width',w+'px','important');
                                            e.style.setProperty('margin','0','important'); }
                                          function fix(){
                                            var h=window.innerHeight, w=window.innerWidth;
                                            px(document.documentElement,h,w); px(document.body,h,w);
                                            document.body.style.setProperty('overflow','hidden','important');
                                            document.querySelectorAll('body>div, .xterm').forEach(function(e){ px(e,h,w); });
                                            window.dispatchEvent(new Event('resize'));
                                          }
                                          // Re-apply as ttyd initializes async after page load,
                                          // and once more after a beat so late layout still fits.
                                          [80,350,800,1500].forEach(function(t){ setTimeout(fix,t); });
                                          // Re-fit on real viewport changes (rotation / keyboard).
                                          // visualViewport.resize won't loop with fix()'s synthetic
                                          // window 'resize' dispatch.
                                          if(window.visualViewport){ window.visualViewport.addEventListener('resize', fix); }
                                        })();""".trimIndent(),
                                        null,
                                    )
                                }
                                override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                                    // Log every failure (incl. ttyd JS/CSS/token subresources — a
                                    // blank page is usually one of those failing through the tunnel).
                                    Log.w("TurmaTerm", "error ${err.errorCode} ${err.description} for ${req.url} main=${req.isForMainFrame}")
                                    if (req.isForMainFrame) error = "Couldn't load the terminal (${err.errorCode}): ${err.description}"
                                }
                                override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, resp: WebResourceResponse) {
                                    if (req.isForMainFrame) {
                                        error = "The hub rejected the terminal request (HTTP ${resp.statusCode}). The session may not be running."
                                        Log.w("TurmaTerm", "http ${resp.statusCode} for ${req.url}")
                                    }
                                }
                            }
                            loadUrl(termUrl)
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            error?.let { msg ->
                Column(
                    Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(msg, color = MaterialTheme.colorScheme.error)
                    Text(termUrl, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    GhostButton("Retry", onClick = { reload++ })
                }
            }
        }
        // The compose box shares the chat screen's draft for this session
        // (XERK-122) — stepping in here to read the pane and back must not eat a
        // half-typed message, the same contract the web's view toggle keeps.
        val draft = remember(host, sessionId) { container.drafts.of(host, sessionId) }
        val text by draft.collectAsStateWithLifecycle()
        // ◼ Stop mirrors the chat footer's (XERK-177): the terminal screen keeps
        // no live tail of its own, so busy is the heartbeat's paneBusy — the chat
        // screen's fallback signal. Suppressed while a question is pending
        // (XERK-21: the pane is showing the picker; an accidental interrupt would
        // destroy it), and briefly after a tap (the heartbeat takes a beat to
        // read the turn as over; if it outlives the suppression the interrupt
        // didn't take and Stop comes back — web chat.js STOP_SUPPRESS_MS).
        val live = agent?.sessions?.firstOrNull { it.id == sessionId }?.session
        var stopPending by remember { mutableStateOf(false) }
        LaunchedEffect(stopPending) {
            if (stopPending) {
                kotlinx.coroutines.delay(4000)
                stopPending = false
            }
        }
        TerminalInputBar(
            text = text,
            busy = live != null && live.paneBusy == true && live.question.isBlank() && !stopPending,
            onText = { draft.value = it },
            onSend = {
                val body = draft.value
                draft.value = ""
                scope.launch { runCatching { container.client.api.sendInput(host, sessionId, InputRequest(body)) } }
            },
            onStop = {
                stopPending = true
                scope.launch {
                    // A failed interrupt gives Stop back right away (web stop()).
                    runCatching { container.client.api.interruptSession(host, sessionId) }
                        .onFailure { stopPending = false }
                }
            },
        )
      }
    }
}

/** A compose input on the terminal page — types the text into the session (same
 *  `input` endpoint the chat uses), so you needn't tap into the ttyd WebView.
 *  Stateless: the draft it edits is the session's shared one (see DraftStore).
 *  Mirrors the chat footer's split bar: Send ALWAYS sends (mid-turn it queues),
 *  and a separate warning-coloured ◼ Stop appears beside it while a turn runs. */
@Composable
private fun TerminalInputBar(
    text: String,
    busy: Boolean,
    onText: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = onText,
            placeholder = { Text("Type into the terminal…") },
            keyboardOptions = SentenceCapsKeyboard,
            modifier = Modifier.weight(1f),
            maxLines = 4,
        )
        if (busy) {
            IconButton(onClick = onStop) {
                Icon(Icons.Filled.Stop, "Stop turn", tint = com.xerktech.turma.ui.theme.TurmaColors.waiting)
            }
        }
        IconButton(
            onClick = { if (text.isNotBlank()) onSend() },
            enabled = text.isNotBlank(),
        ) { Icon(Icons.AutoMirrored.Filled.Send, if (busy) "Send (queues mid-turn)" else "Send") }
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
            // Strip the browser-context attributes (SameSite=None; Secure;
            // Partitioned) the hub sets for its cross-site iframe use — a
            // Partitioned/CHIPS cookie isn't reliably replayed on the WebView's
            // top-level /term navigation, which renders the terminal blank. A bare
            // first-party name=value is all this same-origin WebView needs.
            for (c in resp.headers("Set-Cookie")) {
                val pair = c.substringBefore(';').trim()
                if (pair.contains('=')) cm.setCookie(baseUrl, "$pair; Path=/")
            }
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
