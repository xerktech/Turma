package com.xerktech.turma.net

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.xerktech.turma.core.SignInResult
import com.xerktech.turma.core.signInResultFor
import com.xerktech.turma.data.Config
import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TurmaJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Retrofit
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Thin wrapper over [HubApi]: injects HTTP Basic auth from [Config] on every
 * request and rebuilds the Retrofit stack when the hub URL changes. Exposes the
 * shared [OkHttpClient] so the WebSocket clients (live tail, /audio) reuse the
 * same connection pool + auth interceptor.
 */
class HubClient(private val config: Config) {

    // Stamps the STORED credentials on every call — but leaves a request that
    // already carries its own Authorization alone, so probeCredentials() can
    // test creds that aren't stored yet (XERK-228) over this same client.
    //
    // Two credential shapes: an SSO session token rides as `Cookie:
    // hub_session=<token>` (the SAME opaque value the web cookie carries,
    // XERK-591), and a break-glass password rides as Basic auth. A request that
    // already carries either is left alone.
    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        if (original.header("Authorization") != null || original.header("Cookie") != null) {
            return@Interceptor chain.proceed(original)
        }
        val s = config.current
        val req = if (s.sessionToken.isNotBlank())
            original.newBuilder().header("Cookie", "hub_session=${s.sessionToken}").build()
        else
            original.newBuilder().header("Authorization", s.authHeader).build()
        val resp = chain.proceed(req)
        // An SSO session's shorter OIDC TTL can lapse (or the user is dropped
        // from an access group) mid-use; a 401 then means re-authenticate. Drop
        // the token so `configured` flips false and the app returns to the login
        // screen. A Basic (break-glass) 401 is a wrong password the login screen
        // already surfaces, so it is left alone.
        if (resp.code == 401 && s.sessionToken.isNotBlank()) config.clearSession()
        resp
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

    /**
     * Ask the hub whether it accepts [settings]' credentials, WITHOUT storing
     * them (XERK-228). The login screen has to know the answer before
     * [Config.save] runs: saving is what makes the app "configured", and that
     * alone lands the operator on the dashboard — so persisting first meant a
     * wrong password signed you in and then 401'd on every call.
     *
     * The request carries its own Authorization header (the interceptor above
     * defers to it) and hits /api/agents, the same read the app opens with. A
     * 2xx must also DECODE as that payload: a URL pointing at some other server
     * answers 200 to anything, and accepting it would sign the operator into a
     * hub that isn't there — the body parse is what the old listAgents() call
     * gave us for free.
     */
    suspend fun probeCredentials(settings: Config.Settings): SignInResult = withContext(Dispatchers.IO) {
        val req = runCatching {
            Request.Builder()
                .url(settings.baseUrl + "api/agents")
                .header("Authorization", settings.authHeader)
                .build()
        }.getOrNull() ?: return@withContext SignInResult.Unreachable // a URL OkHttp can't parse
        try {
            http.newCall(req).execute().use { resp ->
                val result = signInResultFor(resp.code)
                if (result != SignInResult.Ok) return@use result
                val body = resp.body?.string().orEmpty()
                val isHub = runCatching { TurmaJson.decodeFromString<AgentsResponse>(body) }.isSuccess
                if (isHub) SignInResult.Ok else SignInResult.Unreachable
            }
        } catch (_: IOException) {
            SignInResult.Unreachable
        }
    }

    /**
     * GET /api/oidc/config — whether this hub offers native SSO (XERK-591), so
     * the login screen knows to offer "Sign in with SSO". A raw call (no stored
     * creds needed; the route is public). Returns null when the hub can't be
     * reached, false when it's reachable but SSO is off or the hub is too old to
     * report it (an older hub 404s the route).
     */
    suspend fun oidcEnabled(baseUrl: String): Boolean? = withContext(Dispatchers.IO) {
        val req = runCatching { Request.Builder().url(baseUrl + "api/oidc/config").build() }.getOrNull()
            ?: return@withContext null
        try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use false
                val body = resp.body?.string().orEmpty()
                runCatching { TurmaJson.decodeFromString<OidcConfig>(body).enabled }.getOrDefault(false)
            }
        } catch (_: IOException) {
            null
        }
    }

    /**
     * POST /api/oidc/mobile/exchange {code, verifier} — redeem the single-use
     * handoff code the hub deep-linked back for the opaque hub_session token
     * (XERK-591). Returns null on any refusal (a bad/expired/hijacked code) or a
     * network failure. A raw call — the app has no session yet, and the route
     * authenticates itself with the code + PKCE verifier.
     */
    suspend fun oidcExchange(baseUrl: String, code: String, verifier: String): String? = withContext(Dispatchers.IO) {
        val payload = TurmaJson.encodeToString(OidcExchangeRequest(code, verifier))
        val req = runCatching {
            Request.Builder().url(baseUrl + "api/oidc/mobile/exchange")
                .post(payload.toRequestBody("application/json".toMediaType())).build()
        }.getOrNull() ?: return@withContext null
        try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val body = resp.body?.string().orEmpty()
                runCatching { TurmaJson.decodeFromString<OidcExchangeResponse>(body).token }
                    .getOrNull()?.ifEmpty { null }
            }
        } catch (_: IOException) {
            null
        }
    }

    sealed interface HistoryResult {
        data class Ready(
            val entries: List<TailEntry>,
            val truncated: Boolean,
            // Non-null only for a workflow row's agent list (XERK-304); its
            // PRESENCE is the signal, so an empty list is not the same as null.
            val agents: List<com.xerktech.turma.model.WorkflowAgent>? = null,
            val agentsTruncated: Boolean = false,
        ) : HistoryResult
        data class Pending(val cmdId: String) : HistoryResult

        /**
         * The hub REFUSED the fetch (XERK-264) — an unknown host or session, an
         * offline agent, a command queue too full to take another. Distinct from
         * [Pending] because polling cannot fix it: a refusal folded into "not
         * fetched yet" ran the caller's 20×3s poll out and then gave up with no
         * word to the operator. [why] is the hub's own `{error}` text when it
         * sent one, else the bare status.
         */
        data class Failed(val why: String) : HistoryResult
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
        agentId: String = "",
    ): HistoryResult = mapHistory(api.subagentHistory(host, sessionId, type, label, agentId))

    companion object {
        /**
         * The hub's 202-pending, a real answer, and a refusal are three different
         * things. A null body used to collapse the last two into
         * [HistoryResult.Pending] (XERK-264): an error body Retrofit couldn't
         * decode as a history reply looked exactly like "the agent hasn't
         * fetched it yet", so the caller polled it for 60 seconds and then gave
         * up in silence. The status is what separates them — only a 2xx can be
         * pending. On the companion so it can be unit-tested without a Config.
         */
        fun mapHistory(resp: retrofit2.Response<com.xerktech.turma.model.HistoryResponse>): HistoryResult {
            if (!resp.isSuccessful) return HistoryResult.Failed(hubErrorMessage(resp))
            val body = resp.body()
            return if (resp.code() == 202 || body == null || body.pending) {
                HistoryResult.Pending(body?.cmdId ?: "")
            } else {
                HistoryResult.Ready(body.entries, body.truncated, body.agents, body.agentsTruncated)
            }
        }
    }
}
