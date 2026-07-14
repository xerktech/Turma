package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.AnswerRequest
import com.xerktech.turma.net.CloneRequest
import com.xerktech.turma.net.InputRequest
import com.xerktech.turma.net.ModeRequest
import com.xerktech.turma.net.ModelRequest
import com.xerktech.turma.net.OkResponse
import com.xerktech.turma.net.ResumeRequest
import com.xerktech.turma.net.SpawnRequest
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Owns the fleet state stream and every host/session mutation. Each mutation is
 * best-effort: it emits a transient [messages] toast and nudges the fleet to
 * re-poll so the change shows on the next beat (glasses nudgePoll pattern).
 */
class FleetViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<com.xerktech.turma.net.FleetState> get() = container.fleet.state

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    fun start() = container.fleet.start()
    fun stop() = container.fleet.stop()
    fun refresh() = container.fleet.nudge()

    private fun run(ok: String, block: suspend () -> OkResponse) {
        viewModelScope.launch {
            val msg = try {
                val r = block()
                if (r.error.isNotEmpty()) "✗ ${r.error}" else "✓ $ok"
            } catch (e: Exception) {
                "✗ hub unreachable"
            }
            _messages.tryEmit(msg)
            container.fleet.nudge()
        }
    }

    fun spawn(
        host: String, repo: String, prompt: String? = null, label: String? = null,
        baseRef: String? = null, model: String? = null, permissionMode: String? = null,
    ) = run("session queued") {
        container.client.api.spawnSession(
            host,
            SpawnRequest(
                repo = repo,
                prompt = prompt?.ifBlank { null },
                label = label?.ifBlank { null },
                baseRef = baseRef?.ifBlank { null },
                model = model?.ifBlank { null },
                permissionMode = permissionMode?.ifBlank { null },
            ),
        )
    }

    fun kill(host: String, id: String) = run("kill queued") { container.client.api.sessionAction(host, id, "kill") }
    fun start(host: String, id: String) = run("start queued") { container.client.api.sessionAction(host, id, "start") }
    fun restart(host: String, id: String) = run("restart queued") { container.client.api.sessionAction(host, id, "restart") }
    fun resume(host: String, id: String) = run("resume queued") { container.client.api.sessionAction(host, id, "resume") }
    fun delete(host: String, id: String) = run("delete queued") { container.client.api.deleteSession(host, id) }

    fun clone(host: String, repo: String) = run("clone queued") { container.client.api.clone(host, CloneRequest(repo)) }
    fun prune(host: String, repo: String) = run("prune queued") { container.client.api.prune(host, repo) }

    fun resumeTranscript(host: String, transcriptId: String, cwd: String) =
        run("resume queued") { container.client.api.resumeTranscript(host, transcriptId, ResumeRequest(cwd)) }

    fun setModel(host: String, id: String, model: String) =
        run("model change queued") { container.client.api.setModel(host, id, ModelRequest(model)) }

    fun setMode(host: String, id: String, mode: String) =
        run("mode change queued") { container.client.api.setMode(host, id, ModeRequest(mode)) }

    fun sendInput(host: String, id: String, text: String) =
        run("sent") { container.client.api.sendInput(host, id, InputRequest(text)) }

    fun answer(host: String, id: String, optionIndex: Int, custom: String?) =
        run("answer queued") { container.client.api.answerQuestion(host, id, AnswerRequest(optionIndex, custom)) }
}
