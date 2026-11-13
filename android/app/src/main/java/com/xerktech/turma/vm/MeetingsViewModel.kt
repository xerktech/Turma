package com.xerktech.turma.vm

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.CreateMetaFetch
import com.xerktech.turma.core.meetingDefaultType
import com.xerktech.turma.core.meetingProject
import com.xerktech.turma.core.meetingReviewable
import com.xerktech.turma.core.meetingTicketDescription
import com.xerktech.turma.model.CreateProject
import com.xerktech.turma.model.CreateType
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingArchiveRequest
import com.xerktech.turma.model.MeetingItem
import com.xerktech.turma.model.MeetingReviewRequest
import com.xerktech.turma.net.FleetState
import com.xerktech.turma.net.OkResponse
import com.xerktech.turma.net.hubErrorMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** The org's projects, or a project's issue types, as the create-meta route answered. */
sealed interface MetaState {
    object Loading : MetaState
    data class Projects(val projects: List<CreateProject>) : MetaState
    data class Types(val types: List<CreateType>) : MetaState
    data class Error(val message: String) : MetaState
}

/** An item's open editor: what the operator typed, and what it opened with. */
data class MeetingDraft(
    val title: String,
    val description: String,
    val issueType: String,
    val initialTitle: String,
    val initialDescription: String,
)

/**
 * Backs the Meetings screen (XERK-2511, the web's /meetings, XERK-2510). The
 * meetings ride the fleet payload (`meetingProposals`); this owns the review:
 * which items have a POST in flight, the hub's refusal per item (XERK-264), the
 * open editors, and the org's projects/types for an Approve. Nothing reaches the
 * board unasked: every create is the operator's Approve.
 */
class MeetingsViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<FleetState> get() = container.fleet.state

    /** The header's org selection (XERK-62), shared by every screen. */
    val orgFilter: StateFlow<Set<String>> get() = container.org.stored

    fun start() = container.fleet.start()

    private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _busy = MutableStateFlow<Set<String>>(emptySet())

    /** Item keys ([itemKey]) whose review POST has not answered yet. */
    val busy: StateFlow<Set<String>> = _busy

    private val _errors = MutableStateFlow<Map<String, String>>(emptyMap())

    /** The hub's refusal per item key, shown under the item until it is retried. */
    val errors: StateFlow<Map<String, String>> = _errors

    private val _drafts = MutableStateFlow<Map<String, MeetingDraft>>(emptyMap())
    val drafts: StateFlow<Map<String, MeetingDraft>> = _drafts

    private val _meta = MutableStateFlow<Map<String, MetaState>>(emptyMap())

    /** Per org: its projects (or the error). Per "site\u0000project": that project's types. */
    val meta: StateFlow<Map<String, MetaState>> = _meta

    private val _picks = MutableStateFlow(loadPicks())

    /** The viewer's "New tickets go to" project per org (kept on this phone). */
    val picks: StateFlow<Map<String, String>> = _picks

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    private val inflight = mutableMapOf<String, Job>()

    /** The project new tickets of [siteKey] go to, or "" until one is picked. */
    fun projectOf(siteKey: String): String =
        meetingProject(_picks.value[siteKey], (meta.value[siteKey] as? MetaState.Projects)?.projects.orEmpty())

    fun typesOf(siteKey: String): MetaState? {
        val p = projectOf(siteKey)
        return if (p.isEmpty()) null else meta.value[typesKey(siteKey, p)]
    }

    /** Load the org's projects once (and the picked project's types). */
    fun ensureMeta(siteKey: String) {
        val cur = meta.value[siteKey]
        if (cur != null && cur !is MetaState.Error) {
            ensureTypes(siteKey)
            return
        }
        load(siteKey, null) { ensureTypes(siteKey) }
    }

    fun retryMeta(siteKey: String) {
        _meta.value = _meta.value - siteKey
        ensureMeta(siteKey)
    }

    /** Load the picked project's issue types once; the returned job finishes when they are in. */
    fun ensureTypes(siteKey: String): Job? {
        val p = projectOf(siteKey)
        if (p.isEmpty()) return null
        val k = typesKey(siteKey, p)
        val cur = meta.value[k]
        if (cur != null && cur !is MetaState.Error) return inflight[k]
        return load(k, p) {}
    }

    private fun load(key: String, project: String?, then: () -> Unit): Job {
        inflight[key]?.let { return it }
        _meta.value = _meta.value + (key to MetaState.Loading)
        val site = if (project == null) key else key.substringBefore('\u0000')
        val job = viewModelScope.launch {
            val out = when (val r = fetchCreateMetaFrom(container.client.api, site, project)) {
                is CreateMetaFetch.Projects -> MetaState.Projects(r.projects)
                is CreateMetaFetch.Types -> MetaState.Types(r.types)
                is CreateMetaFetch.Error -> MetaState.Error(r.message)
                CreateMetaFetch.Pending -> MetaState.Error("the host didn't answer in time")
            }
            _meta.value = _meta.value + (key to out)
            then()
        }
        inflight[key] = job
        job.invokeOnCompletion { inflight.remove(key) }
        return job
    }

    fun setProject(siteKey: String, project: String) {
        _picks.value = _picks.value + (siteKey to project)
        prefs.edit().putString(siteKey, project).apply()
        // A type picked under the old project means nothing under the new one.
        _drafts.value = _drafts.value.mapValues { (k, d) ->
            if (k.startsWith(siteKey + "\u0000")) d.copy(issueType = "") else d
        }
        ensureTypes(siteKey)
    }

    fun startEdit(siteKey: String, m: Meeting, it: MeetingItem) {
        val desc = if (it.kind == "decision") it.description else meetingTicketDescription(m, it)
        val types = (typesOf(siteKey) as? MetaState.Types)?.types.orEmpty()
        _drafts.value = _drafts.value + (itemKey(siteKey, m.meetingId, it.id) to MeetingDraft(
            title = it.title, description = desc,
            issueType = if (it.kind == "decision") "" else meetingDefaultType(it.kind, types),
            initialTitle = it.title, initialDescription = desc,
        ))
        if (it.kind != "decision") ensureMeta(siteKey)
    }

    fun editDraft(key: String, f: (MeetingDraft) -> MeetingDraft) {
        val d = _drafts.value[key] ?: return
        _drafts.value = _drafts.value + (key to f(d))
    }

    fun cancelEdit(key: String) {
        _drafts.value = _drafts.value - key
        _errors.value = _errors.value - key
    }

    private fun fail(key: String, text: String) {
        _errors.value = _errors.value + (key to text)
        _messages.tryEmit("✗ $text")
    }

    /**
     * Approve (optionally + start a session) or reject one proposal. Approve
     * sends the draft when one is open, else the proposal with its meeting
     * context; a ticket needs the org's project and an issue type for its kind.
     */
    fun review(siteKey: String, m: Meeting, it: MeetingItem, action: String, start: Boolean = false): Job =
        viewModelScope.launch {
            val key = itemKey(siteKey, m.meetingId, it.id)
            if (key in _busy.value || !meetingReviewable(it)) return@launch
            // Busy from the FIRST await, not the POST (XERK-2511 QA): while the
            // project's types load, a Reject pressed now must not post first and
            // then be overtaken by this Approve, creating a ticket it rejected.
            _busy.value = _busy.value + key
            _errors.value = _errors.value - key
            val err = try {
                val body = prepare(siteKey, m, it, key, action, start)
                if (body == null) null else post(siteKey, m, it, action, body)
            } catch (e: CancellationException) {
                _busy.value = _busy.value - key
                throw e
            }
            _busy.value = _busy.value - key
            if (err != null) fail(key, err)
        }

    /** The request body, or null after refusing it locally (the refusal already shown). */
    private suspend fun prepare(
        siteKey: String, m: Meeting, it: MeetingItem, key: String, action: String, start: Boolean,
    ): MeetingReviewRequest? {
        var body = MeetingReviewRequest(action = action)
        if (action != "approve") return body
        val d = _drafts.value[key]
        body = body.copy(
            title = d?.title ?: it.title,
            description = d?.description
                ?: if (it.kind == "decision") it.description else meetingTicketDescription(m, it),
            edited = if (d != null && (d.title != d.initialTitle || d.description != d.initialDescription)) true else null,
        )
        if (it.kind == "decision") return body
        ensureMeta(siteKey)
        inflight[siteKey]?.join()
        val project = projectOf(siteKey)
        if (project.isEmpty()) {
            val err = (meta.value[siteKey] as? MetaState.Error)?.message
            return refuse(key, if (err != null) "Approving failed — $err" else "Pick a project for new tickets first")
        }
        ensureTypes(siteKey)?.join()
        val t = meta.value[typesKey(siteKey, project)]
        if (t is MetaState.Error) return refuse(key, "Approving failed — ${t.message}")
        val issueType = d?.issueType?.ifEmpty { null }
            ?: meetingDefaultType(it.kind, (t as? MetaState.Types)?.types.orEmpty())
        if (issueType.isEmpty()) return refuse(key, "That project offers no issue type to create")
        return body.copy(project = project, issueType = issueType, start = if (start) true else null)
    }

    private fun refuse(key: String, text: String): MeetingReviewRequest? {
        fail(key, text)
        return null
    }

    /** POST the review; null on success (the hub's row patched in), else the operator-facing error. */
    private suspend fun post(siteKey: String, m: Meeting, it: MeetingItem, action: String, body: MeetingReviewRequest): String? {
        val what = when {
            action == "reject" -> "Rejecting"
            action == "reopen" -> "Reopening"
            it.kind == "decision" -> "Logging the decision"
            else -> "Approving"
        }
        return try {
            val r = container.client.api.reviewMeetingItem(siteKey, m.meetingId, it.id, body)
            val out = r.body()
            when {
                !r.isSuccessful -> "$what failed — ${hubErrorMessage(r)}"
                out == null || !out.ok -> "$what failed — " + (out?.error?.ifBlank { null } ?: "the hub refused it")
                else -> {
                    out.meeting?.let { row -> container.fleet.patchMeeting(siteKey, row) }
                    _drafts.value = _drafts.value - itemKey(siteKey, m.meetingId, it.id)
                    null
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            "$what failed — the hub is unreachable"
        }
    }

    /**
     * Put a rejected or failed proposal back to review (XERK-2856's "reopen");
     * the hub also unarchives its meeting. A refusal shows under the item.
     */
    fun reopen(siteKey: String, m: Meeting, it: MeetingItem): Job = viewModelScope.launch {
        val key = itemKey(siteKey, m.meetingId, it.id)
        if (key in _busy.value) return@launch
        _busy.value = _busy.value + key
        _errors.value = _errors.value - key
        val err = try {
            post(siteKey, m, it, "reopen", MeetingReviewRequest(action = "reopen"))
        } catch (e: CancellationException) {
            _busy.value = _busy.value - key
            throw e
        }
        _busy.value = _busy.value - key
        if (err != null) fail(key, err)
    }

    private val _archiving = MutableStateFlow<Set<String>>(emptySet())

    /** "site\u0000meetingId" whose archive POST has not answered yet. */
    val archiving: StateFlow<Set<String>> = _archiving

    /** Archive or unarchive a whole meeting (XERK-2856); a refusal toasts in the hub's words. */
    fun archive(siteKey: String, m: Meeting, archived: Boolean): Job = viewModelScope.launch {
        val key = "$siteKey\u0000${m.meetingId}"
        if (key in _archiving.value) return@launch
        _archiving.value = _archiving.value + key
        val what = if (archived) "Archiving" else "Unarchiving"
        val err = try {
            val r = container.client.api.archiveMeeting(siteKey, m.meetingId, MeetingArchiveRequest(archived))
            val out = r.body()
            when {
                !r.isSuccessful -> "$what failed — ${hubErrorMessage(r)}"
                out == null || !out.ok -> "$what failed — " + (out?.error?.ifBlank { null } ?: "the hub refused it")
                else -> { out.meeting?.let { row -> container.fleet.patchMeeting(siteKey, row) }; null }
            }
        } catch (e: CancellationException) {
            _archiving.value = _archiving.value - key
            throw e
        } catch (_: Exception) {
            "$what failed — the hub is unreachable"
        }
        _archiving.value = _archiving.value - key
        if (err != null) _messages.tryEmit("✗ $err")
    }

    private val collapsedPrefs = app.getSharedPreferences(COLLAPSED_PREFS, Context.MODE_PRIVATE)
    private val _collapsed = MutableStateFlow(
        runCatching { collapsedPrefs.getStringSet(COLLAPSED_KEY, null)?.toSet() }.getOrNull().orEmpty(),
    )

    /** Orgs the operator folded in the list, remembered on this phone (the web's localStorage set). */
    val collapsed: StateFlow<Set<String>> = _collapsed

    fun toggleCollapsed(siteKey: String) {
        val next = if (siteKey in _collapsed.value) _collapsed.value - siteKey else _collapsed.value + siteKey
        _collapsed.value = next
        runCatching { collapsedPrefs.edit().putStringSet(COLLAPSED_KEY, next).apply() }
    }

    private val _saving = MutableStateFlow<Set<String>>(emptySet())

    /** Settings saves in flight, "site\u0000focus" / "label" / "schedule". */
    val saving: StateFlow<Set<String>> = _saving

    private val _saved = MutableStateFlow<Set<String>>(emptySet())

    /** Settings saves the hub took (same keys as [saving]); cleared by the next save or edit. */
    val saved: StateFlow<Set<String>> = _saved

    fun clearSaved(siteKey: String, what: String) {
        _saved.value = _saved.value - "$siteKey\u0000$what"
    }

    /** Whose work the org's meetings propose (XERK-2514): no names and no role clears it. */
    fun saveFocus(siteKey: String, names: List<String>, role: String): Job =
        save(siteKey, "focus", "Saving whose work") {
            container.client.api.setMeetingFocus(siteKey, buildJsonObject {
                putJsonArray("names") { names.forEach { add(JsonPrimitive(it)) } }
                put("role", role.trim())
            })
        }

    /** The org's Tenir label (XERK-2638); blank goes back to the default. */
    fun saveLabel(siteKey: String, label: String): Job =
        save(siteKey, "label", "Saving the Tenir label") {
            val v = label.trim().lowercase()
            container.client.api.setMeetingLabel(siteKey, buildJsonObject {
                put("label", if (v.isEmpty()) JsonNull else JsonPrimitive(v))
            })
        }

    /** The fields of the org's standup schedule to change; the hub merges them over the stored one. */
    fun saveSchedule(siteKey: String, fields: JsonObject): Job =
        save(siteKey, "schedule", "Saving the schedule") {
            container.client.api.putDailyBriefSchedule(siteKey, fields)
        }

    private fun save(siteKey: String, what: String, verb: String, call: suspend () -> retrofit2.Response<OkResponse>): Job =
        viewModelScope.launch {
            val key = "$siteKey\u0000$what"
            if (key in _saving.value) return@launch
            _saving.value = _saving.value + key
            _saved.value = _saved.value - key
            val err = try {
                val r = call()
                val out = r.body()
                when {
                    !r.isSuccessful -> hubErrorMessage(r)
                    out != null && !out.ok -> out.error.ifBlank { "the hub refused it" }
                    else -> null
                }
            } catch (e: CancellationException) {
                _saving.value = _saving.value - key
                throw e
            } catch (_: Exception) {
                "the hub is unreachable"
            }
            _saving.value = _saving.value - key
            // Like every failure surface, the toast only ever means "it did not
            // happen"; a save that worked reads as "Saved" beside its button.
            if (err != null) _messages.tryEmit("✗ $verb failed — $err") else _saved.value = _saved.value + key
            container.fleet.nudge()
        }

    private fun loadPicks(): Map<String, String> =
        prefs.all.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap()

    companion object {
        private const val PREFS = "turma-meetings-project"
        private const val COLLAPSED_PREFS = "turma-meetings-collapsed"
        private const val COLLAPSED_KEY = "orgs"

        /** One item's key: org, meeting and item id, NUL-joined (none can hold a NUL). */
        fun itemKey(siteKey: String, meetingId: String, itemId: String) =
            "$siteKey\u0000$meetingId\u0000$itemId"

        fun typesKey(siteKey: String, project: String) = "$siteKey\u0000$project"
    }
}
