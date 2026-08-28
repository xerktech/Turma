package com.xerktech.turma.net

import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.ArchiveListResponse
import com.xerktech.turma.model.ArchiveTranscript
import com.xerktech.turma.model.CreateMetaEnvelope
import com.xerktech.turma.model.CreateResultEnvelope
import com.xerktech.turma.model.CreateTicketRequest
import com.xerktech.turma.model.CreateTicketResponse
import com.xerktech.turma.model.DshTrajectory
import com.xerktech.turma.model.HistoryResponse
import com.xerktech.turma.model.JiraIssueEnvelope
import com.xerktech.turma.model.SearchResponse
import com.xerktech.turma.model.StatusChangePost
import com.xerktech.turma.model.StatusChangeResult
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.model.WsTokenResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import retrofit2.HttpException
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * The Turma hub REST surface (turma/server.js) as a Retrofit interface. Mirrors
 * glasses/src/hub-client.ts plus the full-parity extras the glasses omit
 * (clone, prune, resumeTranscript, model/mode, search, archive, devices).
 */
interface HubApi {

    @GET("api/agents")
    suspend fun listAgents(): AgentsResponse

    @GET("api/ws-token")
    suspend fun wsToken(): WsTokenResponse

    @POST("api/agents/{host}/sessions")
    suspend fun spawnSession(@Path("host") host: String, @Body body: SpawnRequest): OkResponse

    @POST("api/agents/{host}/sessions/{id}/{action}")
    suspend fun sessionAction(
        @Path("host") host: String,
        @Path("id") id: String,
        @Path("action") action: String, // kill | start | restart | resume
    ): OkResponse

    @DELETE("api/agents/{host}/sessions/{id}")
    suspend fun deleteSession(@Path("host") host: String, @Path("id") id: String): OkResponse

    /** Interrupt the turn a running session has in flight (agent sends Escape). */
    @POST("api/agents/{host}/sessions/{id}/interrupt")
    suspend fun interruptSession(@Path("host") host: String, @Path("id") id: String): OkResponse

    /** Move a running session to another agent in the same org (XERK-101). */
    @POST("api/agents/{host}/sessions/{id}/migrate")
    suspend fun migrateSession(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: MigrateRequest,
    ): OkResponse

    @POST("api/agents/{host}/sessions/{id}/input")
    suspend fun sendInput(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: InputRequest,
    ): OkResponse

    /**
     * Stage a file the operator attached in the composer (XERK-234). The body is
     * the raw bytes — no multipart, matching the web composer, which posts the
     * File object straight through. The reply's uploadId is what the following
     * [sendInput] carries; nothing reaches the session until that message is
     * sent, so an attachment the operator removes simply expires hub-side.
     */
    @POST("api/agents/{host}/sessions/{id}/uploads")
    suspend fun uploadAttachment(
        @Path("host") host: String,
        @Path("id") id: String,
        @Query("name") name: String,
        @Body body: okhttp3.RequestBody,
    ): UploadResponse

    @POST("api/agents/{host}/sessions/{id}/model")
    suspend fun setModel(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: ModelRequest,
    ): OkResponse

    @POST("api/agents/{host}/sessions/{id}/mode")
    suspend fun setMode(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: ModeRequest,
    ): OkResponse

    /**
     * Move a RUNNING session between the host's Claude subscription and its
     * self-hosted model (XERK-246), keeping the conversation. The hub 409s when
     * the host reports no local model, so the caller must gate on
     * `localModel.available` rather than let the operator press a dead button.
     */
    @POST("api/agents/{host}/sessions/{id}/model-source")
    suspend fun setModelSource(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: ModelSourceRequest,
    ): OkResponse

    @POST("api/agents/{host}/sessions/{id}/summary")
    suspend fun setSummary(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: SummaryRequest,
    ): OkResponse

    @POST("api/agents/{host}/sessions/{id}/answer")
    suspend fun answerQuestion(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: AnswerRequest,
    ): OkResponse

    // 200 with entries, or 202 {pending, cmdId}; caller inspects the code.
    @GET("api/agents/{host}/sessions/{id}/history")
    suspend fun history(@Path("host") host: String, @Path("id") id: String): Response<HistoryResponse>

    // One live background agent's transcript (same fresh-cache / queue-and-202
    // shape as history). type+label identify the pane agent-list row; agentId is
    // the workflow drill-down (XERK-304) — empty asks a `workflow` row for its
    // run's agent list, one of those ids asks for that agent's transcript.
    @GET("api/agents/{host}/sessions/{id}/subagents/history")
    suspend fun subagentHistory(
        @Path("host") host: String,
        @Path("id") id: String,
        @Query("type") type: String,
        @Query("label") label: String,
        @Query("agentId") agentId: String,
    ): Response<HistoryResponse>

    @POST("api/agents/{host}/clone")
    suspend fun clone(@Path("host") host: String, @Body body: CloneRequest): OkResponse

    @POST("api/agents/{host}/repos/{repo}/prune")
    suspend fun prune(@Path("host") host: String, @Path("repo") repo: String): OkResponse

    // Restart the host's agent manager (XERK-157) — e.g. after fixing an expired
    // Claude login — without SSHing in. The agent exits for its supervisor to
    // bring it back; running sessions are re-adopted on boot.
    @POST("api/agents/{host}/restart")
    suspend fun restartAgent(@Path("host") host: String): OkResponse

    @POST("api/agents/{host}/transcripts/{tid}/resume")
    suspend fun resumeTranscript(
        @Path("host") host: String,
        @Path("tid") transcriptId: String,
        @Body body: ResumeRequest,
    ): OkResponse

    @GET("api/search")
    suspend fun search(
        @Query("q") q: String,
        @Query("repo") repo: String? = null,
        @Query("host") host: String? = null,
        @Query("limit") limit: Int? = null,
    ): SearchResponse

    @GET("api/archive")
    suspend fun archive(
        @Query("repo") repo: String? = null,
        @Query("host") host: String? = null,
        @Query("limit") limit: Int? = null,
        @Query("offset") offset: Int? = null,
    ): ArchiveListResponse

    @GET("api/archive/{tid}")
    suspend fun archiveTranscript(@Path("tid") transcriptId: String): ArchiveTranscript

    // A dsh session's read-only Trajectory (XERK-498): turns/steps/tool-calls/
    // tokens parsed hub-side from the D3 native event log the raw archive holds
    // (`turma/archive.js` dshTrajectory). A Response, not a bare body, because a
    // 404 is the ORDINARY case for a just-opened running dsh session whose log
    // hasn't synced to the archive yet — the screen shows "not synced yet, retry"
    // for a 404 and an error only for anything else.
    @GET("api/dsh/{tid}/trajectory")
    suspend fun dshTrajectory(@Path("tid") transcriptId: String): Response<DshTrajectory>

    // 200 {issue|error, fetchedAt, stale?}, or 202 {pending} while the host
    // fetches it on demand. The issue is nested under `issue` in the envelope.
    @GET("api/jira/{siteKey}/{issueKey}")
    suspend fun jiraIssue(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
    ): Response<JiraIssueEnvelope>

    @POST("api/jira/refresh")
    suspend fun jiraRefresh(): OkResponse

    // New-ticket create metadata (XERK-137): the org's projects + existing labels
    // (no `project`), or a project's creatable issue/work-item types (?project=).
    // 200 with the data, or 202 {pending} while the host fetches it on demand.
    @GET("api/jira/{siteKey}/create-meta")
    suspend fun createMeta(
        @Path("siteKey") siteKey: String,
        @Query("project") project: String? = null,
    ): Response<CreateMetaEnvelope>

    // Create a ticket on the org's board. 200 {ok, cmdId, host}, or 4xx/5xx
    // {error}. The agent creates it and stages the outcome, polled below.
    @POST("api/jira/{siteKey}/tickets")
    suspend fun createTicket(
        @Path("siteKey") siteKey: String,
        @Body body: CreateTicketRequest,
    ): Response<CreateTicketResponse>

    // Poll a create's outcome by the cmdId the POST returned. 200 {key,url} on
    // success, 200 {error} on a create failure, 202 {pending} until then.
    @GET("api/jira/{siteKey}/tickets/{cmdId}")
    suspend fun createResult(
        @Path("siteKey") siteKey: String,
        @Path("cmdId") cmdId: String,
    ): Response<CreateResultEnvelope>

    // Start a session on a ticket: the hub picks the host + triaged repo and
    // spawns with the ticket as context. 200 {ok, cmdId, host, repo}, or 4xx
    // when the ticket has no triaged/cloned repo.
    @POST("api/jira/{siteKey}/{issueKey}/session")
    suspend fun startJiraSession(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
    ): Response<JiraSessionResponse>

    // Take a ticket back out of the hub's queue (XERK-296). It can only ever
    // remove a QUEUED TICKET — nothing has been dispatched, so there is no
    // session to kill and the ticket itself is untouched. 200 {ok}, or 404 once
    // it has already left the queue (dispatched, or cancelled elsewhere).
    @DELETE("api/jira/{siteKey}/{issueKey}/session")
    suspend fun cancelQueuedTicket(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
    ): Response<OkResponse>

    // Override which repo a ticket belongs to (fans out to every host reporting
    // the org). Body: {repo:"name"} to pin, {repo:null} for "no repo fits",
    // {auto:true} to release the pin. Built as a JsonObject so an explicit null
    // survives the shared decoder's explicitNulls=false. 202 {ok, hosts, ...}.
    @POST("api/jira/{siteKey}/{issueKey}/repo")
    suspend fun setJiraRepo(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
        @Body body: kotlinx.serialization.json.JsonObject,
    ): OkResponse

    // Pin which HOST a ticket's sessions spawn on (XERK-38), overriding the
    // hub's most-available routing. Hub-owned and durable (no agent fan-out),
    // so the save is an authoritative 200. Body: {host:"<agent key>"} to pin,
    // {auto:true} to release.
    @POST("api/jira/{siteKey}/{issueKey}/agent")
    suspend fun setTicketAgent(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
        @Body body: kotlinx.serialization.json.JsonObject,
    ): OkResponse

    // Pin which MODEL a ticket's session runs (XERK-123), or release it back to
    // the login's default. Hub-owned and durable like the agent pin, so an
    // authoritative 200. Body: {model:"<alias>"} to pin, {auto:true} to release.
    @POST("api/jira/{siteKey}/{issueKey}/model")
    suspend fun setTicketModel(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
        @Body body: kotlinx.serialization.json.JsonObject,
    ): OkResponse

    // Pin which RUNTIME a ticket's session spawns on (XERK-473): claude or dsh.
    // Hub-owned and durable like the model pin, so an authoritative 200. Body:
    // {runtime:"dsh"} to pin, {runtime:"claude"} (or {auto:true}) to release. A
    // "dsh" pin is refused unless the org offers dsh.
    @POST("api/jira/{siteKey}/{issueKey}/runtime")
    suspend fun setTicketRuntime(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
        @Body body: kotlinx.serialization.json.JsonObject,
    ): OkResponse

    // Change a ticket's status and push it to the board (XERK-138) — the one
    // thing Turma writes back. Body: {value:"<transition id / state name>"}
    // from the detail's statusOptions. Needs an online host (it's a write);
    // 202 {ok, cmdId, host}, the cmdId to poll the outcome by below.
    @POST("api/jira/{siteKey}/{issueKey}/status")
    suspend fun setTicketStatus(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
        @Body body: kotlinx.serialization.json.JsonObject,
    ): Response<StatusChangePost>

    // Poll a queued status change's outcome by its cmdId (XERK-138):
    // {pending:true} until the agent reports, then {ok, error, status, ...}.
    @GET("api/jira/{siteKey}/{issueKey}/status")
    suspend fun ticketStatusResult(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
        @Query("cmdId") cmdId: String,
    ): Response<StatusChangeResult>

    // Flip an org's auto-start opt-in (XERK-41). Hub-owned durable state, so —
    // like the agent pin — an authoritative 200. Body: {enabled:true|false}.
    @POST("api/jira/{siteKey}/autostart")
    suspend fun setAutoStart(
        @Path("siteKey") siteKey: String,
        @Body body: AutoStartRequest,
    ): OkResponse

    // Pin an org's palette color, or release it back to auto (XERK-145).
    // Hub-owned durable state like /autostart, an authoritative 200.
    // Body: {slot:1..8} or {auto:true}.
    @POST("api/jira/{siteKey}/color")
    suspend fun setOrgColor(
        @Path("siteKey") siteKey: String,
        @Body body: OrgColorRequest,
    ): OkResponse

    @POST("api/devices")
    suspend fun registerDevice(@Body body: DeviceRequest): OkResponse

    @DELETE("api/devices")
    suspend fun unregisterDevice(@Query("token") token: String): OkResponse
}

@Serializable
data class OkResponse(val ok: Boolean = false, val cmdId: String = "", val error: String = "")

/**
 * The hub's own `{error}` text from a failed call, or null when it didn't send
 * one (a transport failure, or a body we can't read). Retrofit throws away a
 * non-2xx body as an [HttpException], so a refusal the hub explained — "message
 * too long" (XERK-227), an org/repo mismatch — otherwise reaches the operator as
 * a generic "hub unreachable".
 */
fun hubErrorMessage(e: Throwable): String? {
    val body = (e as? HttpException)?.response()?.errorBody()?.string() ?: return null
    val msg = runCatching { TurmaJson.decodeFromString<OkResponse>(body).error }.getOrNull()
    return msg?.takeIf { it.isNotBlank() }
}

/**
 * The same reading for a call that returns a typed [retrofit2.Response] instead
 * of throwing — the hub's own `{error}` text, falling back to the bare status,
 * which beats reporting nothing at all (XERK-264). Worded to match the web
 * client's `TurmaNav.refusalText`, so the same refusal reads the same on both.
 */
fun hubErrorMessage(resp: retrofit2.Response<*>): String {
    val body = runCatching { resp.errorBody()?.string() }.getOrNull().orEmpty()
    val msg = runCatching { TurmaJson.decodeFromString<OkResponse>(body).error }.getOrNull()
    return msg?.takeIf { it.isNotBlank() } ?: "the hub answered HTTP ${resp.code()}"
}

/** What the hub records about a refused archive push (XERK-356). */
@Serializable
data class ArchiveRefusal(
    val host: String = "",
    val at: Long = 0,
    val error: String = "",
)

/** The 404 body `GET /api/archive/<id>` answers with when it knows why. */
@Serializable
private data class ArchiveMissing(
    val error: String = "",
    val refused: ArchiveRefusal? = null,
)

/**
 * Why an archived transcript is missing, in the hub's own words, when its 404
 * carries them (XERK-356) — else null, meaning the ordinary "not here yet".
 *
 * The distinction is the point: a refused push never arrives, so the reassuring
 * "it syncs within a few minutes" the ended view falls back to is a promise that
 * will not be kept, and the operator would go on waiting for it. Web twin:
 * `archiveRefusalNote` in sessions.html.
 */
fun archiveRefusalMessage(e: Throwable): String? {
    val resp = (e as? HttpException)?.response() ?: return null
    if (resp.code() != 404) return null
    val body = runCatching { resp.errorBody()?.string() }.getOrNull().orEmpty()
    val r = runCatching { TurmaJson.decodeFromString<ArchiveMissing>(body).refused }.getOrNull()
        ?: return null
    if (r.error.isBlank()) return null
    return "${r.host.ifBlank { "The agent" }}\u2019s last push of this conversation " +
        "to the archive was refused: ${r.error}."
}

@Serializable
data class JiraSessionResponse(
    val ok: Boolean = false,
    val cmdId: String = "",
    val host: String = "",
    val repo: String = "",
    // True when no host had the repo cloned: the chosen host clones it on
    // demand and the session queues behind the clone (XERK-14).
    val needsClone: Boolean = false,
    // True when every host in the org was full: the hub queued the TICKET
    // instead of handing it to an agent (XERK-296), so there is no cmdId or host
    // to follow. `position` is its place in the org's line.
    val queued: Boolean = false,
    val position: Int = 0,
    val error: String = "",
)

@Serializable
data class SpawnRequest(
    val repo: String,
    val prompt: String? = null,
    val label: String? = null,
    val baseRef: String? = null,
    val model: String? = null,
    val permissionMode: String? = null,
    // Which model the new session runs against (XERK-246). Omitted unless the
    // operator picked one, so a bare spawn is the exact body it always was; the
    // hub 409s "local" at a host reporting no local model.
    val modelSource: String? = null,
    // Which runtime the new session runs on (XERK-460). Omitted unless the
    // operator picked "dsh", so a bare spawn is unchanged; the hub 409s "dsh" at
    // a host that does not offer it.
    val agentType: String? = null,
    // For a local spawn, which endpoint model (XERK-489). Omitted otherwise; the
    // hub validates membership and the agent clamps its context to the served
    // window. The context override itself is web-only for now (PARITY.md).
    val localModel: String? = null,
)

@Serializable
data class InputRequest(
    val text: String,
    // Ids of files staged by [HubApi.uploadAttachment] (XERK-234). Omitted when
    // empty so an ordinary message is the exact body it always was.
    val uploadIds: List<String>? = null,
)

/** Reply to [HubApi.uploadAttachment]: the staged id plus the sanitized name. */
@Serializable
data class UploadResponse(
    val ok: Boolean = false,
    val uploadId: String = "",
    val name: String = "",
    val size: Long = 0,
)

@Serializable
data class ModelRequest(val model: String)

@Serializable
data class ModeRequest(val permissionMode: String)

@Serializable
data class ModelSourceRequest(val modelSource: String)

/** Rename a session — a blank [summary] clears the name back to the fallback. */
@Serializable
data class SummaryRequest(val summary: String)

@Serializable
data class AutoStartRequest(val enabled: Boolean)

/** Pin an org's palette slot (1..8), or `auto = true` to release the pin. */
@Serializable
data class OrgColorRequest(val slot: Int? = null, val auto: Boolean? = null)

@Serializable
data class AnswerRequest(
    val optionIndex: Int = -1,
    val custom: String? = null,
    val optionIndices: List<Int>? = null,
)

/** The target agent a session should move to (XERK-101). */
@Serializable
data class MigrateRequest(val host: String)

@Serializable
data class CloneRequest(val repo: String, val source: String? = null)

@Serializable
data class ResumeRequest(val cwd: String = "")

@Serializable
data class DeviceRequest(
    val token: String,
    // Capabilities this build supports, so the hub only sends messages it can
    // handle. "dismiss" = it cancels a notification on an {action:"dismiss"}
    // message (XERK-154); without it the hub withholds those, since an older
    // build would render one as a blank notification.
    //
    // NOT defaulted, on purpose: TurmaJson has encodeDefaults=false, so a field
    // left at its default is DROPPED from the request body — a defaulted
    // features would never reach the hub, which would then treat this build as
    // dismiss-incapable and retract nothing. A required field always serializes.
    val features: List<String>,
    val platform: String = "android",
)
