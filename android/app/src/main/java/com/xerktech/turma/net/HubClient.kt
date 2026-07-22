package com.xerktech.turma.net

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.xerktech.turma.data.Config
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TurmaJson
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit

/**
 * Thin wrapper over [HubApi]: injects HTTP Basic auth from [Config] on every
 * request and rebuilds the Retrofit stack when the hub URL changes. Exposes the
 * shared [OkHttpClient] so the WebSocket clients (live tail, /audio) reuse the
 * same connection pool + auth interceptor.
 */
class HubClient(private val config: Config) {

    private val authInterceptor = Interceptor { chain ->
        val req = chain.request().newBuilder()
            .header("Authorization", config.current.authHeader)
            .build()
        chain.proceed(req)
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS) // keep live-tail / audio sockets warm
        .build()

    // MUST stay declared before `apiRef`: `apiRef`'s initializer calls build(),
    // which reads contentType. A property initialized textually later is still
    // null at that point, so ordering this after apiRef makes build() pass a
    // null contentType and asConverterFactory throws on launch (crashes onCreate).
    private val contentType = "application/json".toMediaType()

    @Volatile
    private var builtFor: String = ""

    @Volatile
    private var apiRef: HubApi = build(config.current.baseUrl)

    private fun build(baseUrl: String): HubApi {
        builtFor = baseUrl
        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(http)
            .addConverterFactory(TurmaJson.asConverterFactory(contentType))
            .build()
            .create(HubApi::class.java)
    }

    /** Current API, rebuilt if the configured hub URL changed. */
    val api: HubApi
        get() {
            val base = config.current.baseUrl
            if (base != builtFor) synchronized(this) {
                if (base != builtFor) apiRef = build(base)
            }
            return apiRef
        }

    sealed interface HistoryResult {
        data class Ready(val entries: List<TailEntry>, val truncated: Boolean) : HistoryResult
        data class Pending(val cmdId: String) : HistoryResult
    }

    /** GET history, mapping the hub's 202-pending into a typed result. */
    suspend fun history(host: String, sessionId: String): HistoryResult {
        val resp = api.history(host, sessionId)
        return mapHistory(resp)
    }

    /**
     * GET one background agent's transcript by (type, label) — the same 202-pending
     * shape as [history] (the agent fetches on demand; a cache miss 202s until the
     * next heartbeat delivers it, so the caller polls).
     */
    suspend fun subagentHistory(
        host: String,
        sessionId: String,
        type: String,
        label: String,
    ): HistoryResult = mapHistory(api.subagentHistory(host, sessionId, type, label))

    private fun mapHistory(resp: retrofit2.Response<com.xerktech.turma.model.HistoryResponse>): HistoryResult {
        val body = resp.body()
        return if (resp.code() == 202 || body == null || body.pending) {
            HistoryResult.Pending(body?.cmdId ?: "")
        } else {
            HistoryResult.Ready(body.entries, body.truncated)
        }
    }
}
