package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.net.AnswerRequest
import com.xerktech.turma.net.CloneRequest
import com.xerktech.turma.net.InputRequest
import com.xerktech.turma.net.MigrateRequest
import com.xerktech.turma.net.ModeRequest
import com.xerktech.turma.net.ModelRequest
import com.xerktech.turma.net.OkResponse
import com.xerktech.turma.net.ResumeRequest
import com.xerktech.turma.net.SpawnRequest
import com.xerktech.turma.net.SummaryRequest
import com.xerktech.turma.net.hubErrorMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
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

    /** The header's org selection (XERK-62, multi per XERK-222), shared by every screen. */
    val orgFilter: StateFlow<Set<String>> get() = container.org.stored

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    /**
     * Optimistic per-session pending, keyed "<host>::<id>" — the dashboard's
     * instant feedback for kill/start/restart/resume/delete (web index.html
     * `pending`/`reconcilePending`). Set synchronously BEFORE the POST (the
     * card dims to "stopping"/busy right away) and cleared on the completion
     * signal each kind actually has — session gone, status running, the id
     * reappearing, restartCount bumping — with a TTL backstop.
     */
    private val _pending = MutableStateFlow<Map<String, SessPending>>(emptyMap())
    val pending: StateFlow<Map<String, SessPending>> = _pending

    init {
        viewModelScope.launch {
            container.fleet.state.collect {
                val next = reconcilePending(_pending.value, it.agents, System.currentTimeMillis())
                if (next != _pending.value) _pending.value = next
            }
        }
    }

    fun start() = container.fleet.start()
    fun stop() = container.fleet.stop()
    fun refresh() = container.fleet.nudge()

    /**
     * Fire one command and report what actually happened.
     *
     * A refusal the hub EXPLAINED — an org mismatch, an agent too old to run it,
     * an offline host, a command queue too full to take another — arrives as a
     * non-2xx, which Retrofit throws as an HttpException with the body attached.
     * Reporting that as "hub unreachable" sent the operator hunting for a
     * network fault that isn't there (XERK-264), so [hubErrorMessage] reads the
     * hub's own `{error}` text and only a genuine transport failure keeps the
     * generic wording.
     *
     * `pendKeys` are the optimistic rows this command painted: a command that
     * never reached the agent must not keep a spinner up for the whole TTL, so
     * they come straight back off on a failure.
     */
    private fun run(ok: String, vararg pendKeys: String, block: suspend () -> OkResponse) {
        viewModelScope.launch {
            val msg = try {
                val r = block()
                if (r.error.isNotEmpty()) "✗ ${r.error}" else "✓ $ok"
            } catch (e: Exception) {
                // Prefer the hub's OWN reason when it gave one (XERK-246): a
                // refused spawn — "host has no local model configured" on a 409
                // — used to read "hub unreachable", which is both wrong and
                // unactionable. Only a genuinely unanswered request says that.
                "✗ " + (hubErrorMessage(e) ?: "hub unreachable")
            }
            // A refusal also rolls back whatever was painted optimistically
            // (XERK-264) — the card must not sit dimmed on a command that never ran.
            if (msg.startsWith("✗") && pendKeys.isNotEmpty()) {
                _pending.value = _pending.value - pendKeys.toSet()
            }
            _messages.tryEmit(msg)
            container.fleet.nudge()
        }
    }

    /** Mark a session action pending NOW, before its POST (optimistic paint). */
    private fun mark(host: String, id: String, kind: String) {
        val restartCount =
            if (kind == "restart")
                fleet.value.agents.firstOrNull { it.key == host }
                    ?.sessions?.firstOrNull { it.id == id }?.restartCount ?: 0
            else 0
        _pending.value = _pending.value +
            (pendKey(host, id) to SessPending(kind, System.currentTimeMillis(), restartCount))
    }

    fun spawn(
        host: String, repo: String, prompt: String? = null, label: String? = null,
        baseRef: String? = null, model: String? = null, permissionMode: String? = null,
        modelSource: String? = null,
    ) = run("session queued") {
        container.client.api.spawnSession(
            host,
            spawnRequest(repo, prompt, label, baseRef, model, permissionMode, modelSource),
        )
    }

    fun kill(host: String, id: String) {
        mark(host, id, "kill")
        run("kill queued", pendKey(host, id)) { container.client.api.sessionAction(host, id, "kill") }
    }
    fun start(host: String, id: String) {
        mark(host, id, "start")
        run("start queued", pendKey(host, id)) { container.client.api.sessionAction(host, id, "start") }
    }
    fun restart(host: String, id: String) {
        mark(host, id, "restart")
        run("restart queued", pendKey(host, id)) { container.client.api.sessionAction(host, id, "restart") }
    }
    fun resume(host: String, id: String) {
        mark(host, id, "resume")
        run("resume queued", pendKey(host, id)) { container.client.api.sessionAction(host, id, "resume") }
    }
    fun delete(host: String, id: String) {
        mark(host, id, "delete")
        run("delete queued", pendKey(host, id)) { container.client.api.deleteSession(host, id) }
    }

    /** Move a running session to another agent in the same org (XERK-101). The
     *  moved session reappears on its new host in the list once it's up. */
    fun migrate(host: String, id: String, targetHost: String) =
        run("move queued") { container.client.api.migrateSession(host, id, MigrateRequest(targetHost)) }

    fun clone(host: String, repo: String, source: String? = null) =
        run("clone queued") { container.client.api.clone(host, CloneRequest(repo, source)) }
    fun prune(host: String, repo: String) = run("prune queued") { container.client.api.prune(host, repo) }

    /** Restart a host's agent manager (XERK-157). The host announces the expected
     *  downtime, exits for its supervisor to relaunch it, and re-adopts sessions. */
    fun restartAgent(host: String) = run("restart queued") { container.client.api.restartAgent(host) }

    fun resumeTranscript(host: String, transcriptId: String, cwd: String) =
        run("resume queued") { container.client.api.resumeTranscript(host, transcriptId, ResumeRequest(cwd)) }

    fun setModel(host: String, id: String, model: String) =
        run("model change queued") { container.client.api.setModel(host, id, ModelRequest(model)) }

    fun setMode(host: String, id: String, mode: String) =
        run("mode change queued") { container.client.api.setMode(host, id, ModeRequest(mode)) }

    /** Rename a session (web sessions.html ⋯ → Rename). A blank name clears it. */
    fun setSummary(host: String, id: String, summary: String) =
        run("rename queued") { container.client.api.setSummary(host, id, SummaryRequest(summary)) }

    fun sendInput(host: String, id: String, text: String) =
        run("sent") { container.client.api.sendInput(host, id, InputRequest(text)) }

    fun answer(host: String, id: String, optionIndex: Int, custom: String?) =
        run("answer queued") { container.client.api.answerQuestion(host, id, AnswerRequest(optionIndex, custom)) }

    /** One in-flight session action (web index.html `pending` entry). */
    data class SessPending(val kind: String, val at: Long, val restartCount: Int = 0)

    companion object {
        fun pendKey(host: String, id: String) = "$host::$id"

        /**
         * The body a "New session" spawn posts. Pure, and separate from [spawn]
         * so the wire shape is pinned by a test rather than only by driving the
         * app: every blank optional is omitted, so a bare one-click spawn queues
         * exactly `{repo}` as it always did.
         *
         * `modelSource` is sent ONLY for the local model (XERK-246) —
         * "subscription" is what a spawn already meant. `model` is sent whatever
         * the source, matching the web composer: the agent drops `--model` for a
         * local session itself, and the alias is what that session goes back to
         * if it is later switched to the subscription.
         */
        fun spawnRequest(
            repo: String, prompt: String? = null, label: String? = null,
            baseRef: String? = null, model: String? = null, permissionMode: String? = null,
            modelSource: String? = null,
        ) = SpawnRequest(
            repo = repo,
            prompt = prompt?.ifBlank { null },
            label = label?.ifBlank { null },
            baseRef = baseRef?.ifBlank { null },
            model = model?.ifBlank { null },
            permissionMode = permissionMode?.ifBlank { null },
            modelSource = ModelSource.spawnValue(modelSource),
        )

        /** The in-flight action kind for a session, or null (web sessPending). */
        fun sessPending(pending: Map<String, SessPending>, host: String, id: String): String? =
            pending[pendKey(host, id)]?.kind

        private const val PENDING_TTL_MS = 45_000L
        private const val RESTART_TTL_MS = 15_000L

        /**
         * Clear pending entries whose effect is now visible (or that timed
         * out), so controls re-enable exactly when the change lands — a pure
         * port of web index.html `reconcilePending`'s session branch:
         * kill/delete clear when the session disappears from the reported
         * list; start when it enters "running"; resume once the id is reported
         * again (even as "error" — the card then shows what went wrong);
         * restart when the agent's monotonic restartCount bumps (TTL fallback
         * for an older agent that doesn't report it).
         */
        fun reconcilePending(
            pending: Map<String, SessPending>,
            agents: List<com.xerktech.turma.model.AgentInfo>,
            now: Long,
        ): Map<String, SessPending> {
            if (pending.isEmpty()) return pending
            val index = HashMap<String, com.xerktech.turma.model.SessionInfo>()
            for (a in agents) for (s in a.sessions) index[pendKey(a.key, s.id)] = s
            val next = pending.toMutableMap()
            for ((key, p) in pending) {
                val ttl = if (p.kind == "restart") RESTART_TTL_MS else PENDING_TTL_MS
                if (now - p.at > ttl) { next.remove(key); continue }
                val s = index[key]
                val done = when (p.kind) {
                    "kill", "delete" -> s == null
                    "start" -> s?.status == "running"
                    "resume" -> s != null
                    "restart" -> s != null && s.restartCount != p.restartCount
                    else -> false
                }
                if (done) next.remove(key)
            }
            return next
        }
    }
}
