package com.xerktech.turma.net

import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.ArchiveListResponse
import com.xerktech.turma.model.ArchiveTranscript
import com.xerktech.turma.model.HistoryResponse
import com.xerktech.turma.model.JiraIssueDetail
import com.xerktech.turma.model.SearchResponse
import com.xerktech.turma.model.WsTokenResponse
import kotlinx.serialization.Serializable
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

    @POST("api/agents/{host}/sessions/{id}/input")
    suspend fun sendInput(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: InputRequest,
    ): OkResponse

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
    // shape as history). type+label identify the pane agent-list row.
    @GET("api/agents/{host}/sessions/{id}/subagents/history")
    suspend fun subagentHistory(
        @Path("host") host: String,
        @Path("id") id: String,
        @Query("type") type: String,
        @Query("label") label: String,
    ): Response<HistoryResponse>

    @POST("api/agents/{host}/clone")
    suspend fun clone(@Path("host") host: String, @Body body: CloneRequest): OkResponse

    @POST("api/agents/{host}/repos/{repo}/prune")
    suspend fun prune(@Path("host") host: String, @Path("repo") repo: String): OkResponse

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

    // 200 with the issue, or 202 {pending} while the host fetches it on demand.
    @GET("api/jira/{siteKey}/{issueKey}")
    suspend fun jiraIssue(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
    ): Response<JiraIssueDetail>

    @POST("api/jira/refresh")
    suspend fun jiraRefresh(): OkResponse

    // Start a session on a ticket: the hub picks the host + triaged repo and
    // spawns with the ticket as context. 200 {ok, cmdId, host, repo}, or 4xx
    // when the ticket has no triaged/cloned repo.
    @POST("api/jira/{siteKey}/{issueKey}/session")
    suspend fun startJiraSession(
        @Path("siteKey") siteKey: String,
        @Path("issueKey") issueKey: String,
    ): Response<JiraSessionResponse>

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

    // Flip an org's auto-start opt-in (XERK-41). Hub-owned durable state, so —
    // like the agent pin — an authoritative 200. Body: {enabled:true|false}.
    @POST("api/jira/{siteKey}/autostart")
    suspend fun setAutoStart(
        @Path("siteKey") siteKey: String,
        @Body body: AutoStartRequest,
    ): OkResponse

    @POST("api/devices")
    suspend fun registerDevice(@Body body: DeviceRequest): OkResponse

    @DELETE("api/devices")
    suspend fun unregisterDevice(@Query("token") token: String): OkResponse
}

@Serializable
data class OkResponse(val ok: Boolean = false, val cmdId: String = "", val error: String = "")

@Serializable
data class JiraSessionResponse(
    val ok: Boolean = false,
    val cmdId: String = "",
    val host: String = "",
    val repo: String = "",
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
)

@Serializable
data class InputRequest(val text: String)

@Serializable
data class ModelRequest(val model: String)

@Serializable
data class ModeRequest(val permissionMode: String)

/** Rename a session — a blank [summary] clears the name back to the fallback. */
@Serializable
data class SummaryRequest(val summary: String)

@Serializable
data class AutoStartRequest(val enabled: Boolean)

@Serializable
data class AnswerRequest(
    val optionIndex: Int = -1,
    val custom: String? = null,
    val optionIndices: List<Int>? = null,
)

@Serializable
data class CloneRequest(val repo: String)

@Serializable
data class ResumeRequest(val cwd: String = "")

@Serializable
data class DeviceRequest(val token: String, val platform: String = "android")
