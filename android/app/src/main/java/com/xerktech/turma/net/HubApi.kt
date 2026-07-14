package com.xerktech.turma.net

import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.ArchiveListResponse
import com.xerktech.turma.model.ArchiveTranscript
import com.xerktech.turma.model.HistoryResponse
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

    @POST("api/agents/{host}/sessions/{id}/answer")
    suspend fun answerQuestion(
        @Path("host") host: String,
        @Path("id") id: String,
        @Body body: AnswerRequest,
    ): OkResponse

    // 200 with entries, or 202 {pending, cmdId}; caller inspects the code.
    @GET("api/agents/{host}/sessions/{id}/history")
    suspend fun history(@Path("host") host: String, @Path("id") id: String): Response<HistoryResponse>

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

    @POST("api/devices")
    suspend fun registerDevice(@Body body: DeviceRequest): OkResponse

    @DELETE("api/devices")
    suspend fun unregisterDevice(@Query("token") token: String): OkResponse
}

@Serializable
data class OkResponse(val ok: Boolean = false, val cmdId: String = "", val error: String = "")

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

@Serializable
data class AnswerRequest(val optionIndex: Int = -1, val custom: String? = null)

@Serializable
data class CloneRequest(val repo: String)

@Serializable
data class ResumeRequest(val cwd: String = "")

@Serializable
data class DeviceRequest(val token: String, val platform: String = "android")
