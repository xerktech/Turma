package com.xerktech.turma.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.Dictation
import com.xerktech.turma.vm.MicState
import kotlinx.coroutines.launch

/**
 * Self-contained push-to-dictate button: opens a /audio STT session, streams
 * mic PCM, and calls [onText] with the transcript. Handles the RECORD_AUDIO
 * runtime permission. Used by the spawn composer (initial task prompt by voice).
 */
@Composable
fun VoiceButton(onText: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val container = remember { (context.applicationContext as TurmaApplication).container }
    val scope = rememberCoroutineScope()
    var mic by remember { mutableStateOf(MicState.IDLE) }
    var dictation by remember { mutableStateOf<Dictation?>(null) }

    fun begin() {
        val d = container.newDictation()
        dictation = d
        mic = MicState.RECORDING
        scope.launch {
            val ok = runCatching { d.start() }.getOrDefault(false)
            if (!ok) { mic = MicState.IDLE; dictation = null }
        }
    }

    fun finish() {
        val d = dictation ?: return
        mic = MicState.FINALIZING
        scope.launch {
            val r = runCatching { d.stopAndFinalize() }.getOrNull()
            dictation = null
            mic = MicState.IDLE
            (r as? Dictation.Result.Text)?.text?.takeIf { it.isNotBlank() }?.let(onText)
        }
    }

    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) begin() }

    IconButton(
        onClick = {
            when (mic) {
                MicState.IDLE -> {
                    val granted = ContextCompat.checkSelfPermission(
                        context, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                    if (granted) begin() else permLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }
                MicState.RECORDING -> finish()
                MicState.FINALIZING -> { /* wait */ }
            }
        },
        modifier = modifier,
    ) {
        when (mic) {
            MicState.IDLE -> Icon(Icons.Filled.Mic, "Dictate")
            MicState.RECORDING -> Icon(Icons.Filled.Stop, "Stop", tint = MaterialTheme.colorScheme.error)
            MicState.FINALIZING -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
    }
}
