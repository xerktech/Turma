package com.xerktech.turma.net

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.xerktech.turma.core.SESSION_COOKIE
import com.xerktech.turma.core.SignInResult
import com.xerktech.turma.core.loginRefusalMessage
import com.xerktech.turma.core.sessionTokenFrom
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
 * Thin wrapper over [HubApi]: stamps the stored credential from [Config] on every
 * request and rebuilds the Retrofit stack when the hub URL changes. Exposes the
 * shared [OkHttpClient] so the WebSocket clients (live tail, /audio) reuse the
 * same connection pool + auth interceptor.
 */
class HubClient(private val config: Config) {

    /** What a `POST /api/login` came back with (XERK-2569). */
    private sealed interface LoginOutcome {
        data class Token(val token: String) : LoginOutcome
        /**
         * The hub answered 401: these credentials are wrong. Only 401 — the hub
         * refuses a bad password with exactly that, while a 403 here is more
         * likely a proxy (WAF, Cloudflare Access) and must not sign the app out.
         */
        data object Refused : LoginOutcome
        /** No session to be had here — a non-hub URL, a hub without the route, a 5xx, no network. */
        data object Unavailable : LoginOutcome
        /**
         * The hub answered 429/503 with its own `{error}` (XERK-2576): sign-in is
         * throttled — too many in flight, or the failed-sign-in backoff. [message]
         * is the hub's words plus the Retry-After wait, shown as-is on the login
         * screen; never retried as Basic, which would word it as a wrong password.
         */
        data class Throttled(val message: String) : LoginOutcome
    }

    // Serialises re-logins, so a burst of calls that all 401 on one lapsed
    // session signs in once rather than once per call.
    private val reloginLock = Any()

    // Stamps the STORED credential on every call — but leaves a request that
    // already carries its own Authorization or Cookie alone, so signIn() can
    // test creds that aren't stored yet (XERK-228) over this same client.
    //
    // Two credential shapes: a session token rides as `Cookie: hub_session=<token>`
    // (the SAME opaque value the web cookie carries — from SSO, XERK-591, or a
    // password sign-in via /api/login, XERK-2569), and with no token a stored
    // password rides as Basic. The hub checks Basic against its break-glass
    // credential ONLY — never a local account's password, which it would have to
    // scrypt on every request — so Basic is the fallback, not the main path.
    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        if (original.header("Authorization") != null || original.header("Cookie") != null) {
            return@Interceptor chain.proceed(original)
        }
        val s = config.current
        val resp = chain.proceed(withCredential(original, s))
        if (resp.code != 401) return@Interceptor resp
        // A 401 means the credential lapsed: a session's TTL ran out (the shorter
        // OIDC one, or the 30-day password one), the user was dropped from an
        // access group, or the password changed. With a password on file, sign
        // in again and retry once — this also moves an install that predates
        // XERK-2569 (password, no token) onto a session.
        if (s.password.isNotEmpty()) {
            when (val fresh = relogin(s)) {
                is LoginOutcome.Token -> {
                    resp.close()
                    return@Interceptor chain.proceed(
                        original.newBuilder().header("Cookie", "$SESSION_COOKIE=${fresh.token}").build()
                    )
                }
                // The stored password itself is refused: drop the credentials so
                // the app returns to the login screen, rather than replaying a
                // known-bad password on every call.
                LoginOutcome.Refused -> config.clear()
                LoginOutcome.Unavailable, is LoginOutcome.Throttled -> dropSession(s)
            }
        } else {
            // An SSO-only sign-in has no password to retry with: drop the token so
            // `configured` flips false and the app returns to the login screen.
            dropSession(s)
        }
        resp
    }

    // Drop the session [s] carried — but only if it is still the stored one, so
    // a late 401 never signs out a session a fresh sign-in has since stored.
    private fun dropSession(s: Config.Settings) {
        if (s.sessionToken.isNotBlank() && config.current.sessionToken == s.sessionToken) config.clearSession()
    }

    private fun withCredential(req: Request, s: Config.Settings): Request =
        if (s.sessionToken.isNotBlank())
            req.newBuilder().header("Cookie", "$SESSION_COOKIE=${s.sessionToken}").build()
        else
            req.newBuilder().header("Authorization", s.authHeader).build()

    /**
     * Sign in again with [stale]'s stored password after a 401, storing the new
     * session token. If another call already refreshed the session while this
     * one waited on the lock, reuse that token instead of signing in twice.
     */
    private fun relogin(stale: Config.Settings): LoginOutcome = synchronized(reloginLock) {
        val now = config.current
        if (now.sessionToken.isNotBlank() && now.sessionToken != stale.sessionToken) {
            return LoginOutcome.Token(now.sessionToken)
        }
        if (!sameCredentials(now, stale)) return LoginOutcome.Unavailable
        val outcome = login(stale)
        // Checked again AFTER the login: a sign-out (TurmaApp's Config.clear,
        // which never takes this lock) landing while /api/login was in flight
        // must stay signed out, not have these credentials written back.
        if (!sameCredentials(config.current, stale)) return LoginOutcome.Unavailable
        if (outcome is LoginOutcome.Token) config.save(stale.hubUrl, stale.user, stale.password, outcome.token)
        outcome
    }

    // Still the same sign-in — not signed out or signed in as someone else.
    private fun sameCredentials(a: Config.Settings, b: Config.Settings) =
        a.hubUrl == b.hubUrl && a.user == b.user && a.password == b.password

    /**
     * POST /api/login {username, password} — the web login's own call — and
     * pull the `hub_session` token out of its Set-Cookie (XERK-2569). Sent over
     * [bare] so the interceptor neither stamps a credential on it nor re-enters
     * itself on a 401.
     */
    private fun login(s: Config.Settings): LoginOutcome {
        val payload = TurmaJson.encodeToString(LoginRequest(s.user, s.password))
        val req = runCatching {
            Request.Builder().url(s.baseUrl + "api/login")
                .post(payload.toRequestBody("application/json".toMediaType())).build()
        }.getOrNull() ?: return LoginOutcome.Unavailable
        return try {
            bare.newCall(req).execute().use { resp ->
                when {
                    resp.code == 401 -> LoginOutcome.Refused
                    resp.code == 429 || resp.code == 503 -> {
                        val said = runCatching {
                            TurmaJson.decodeFromString<OkResponse>(resp.body?.string().orEmpty()).error
                        }.getOrNull()?.trim().orEmpty()
                        if (said.isEmpty()) LoginOutcome.Unavailable
                        else LoginOutcome.Throttled(loginRefusalMessage(said, resp.header("Retry-After")))
                    }
                    !resp.isSuccessful -> LoginOutcome.Unavailable
                    else -> sessionTokenFrom(resp.headers("Set-Cookie"))
                        ?.let { LoginOutcome.Token(it) } ?: LoginOutcome.Unavailable
                }
            }
        } catch (_: IOException) {
            LoginOutcome.Unavailable
        }
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS) // keep live-tail / audio sockets warm
        .build()

    // The same pool and timeouts with no auth interceptor, for /api/login.
    private val bare: OkHttpClient by lazy { http.newBuilder().apply { interceptors().clear() }.build() }

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

    /** A sign-in verdict plus the session token it earned (empty = use Basic). */
    data class SignIn(val result: SignInResult, val sessionToken: String = "")

    /**
     * Sign in with [settings]' username + password WITHOUT storing anything
     * (XERK-228). The login screen has to know the answer before [Config.save]
     * runs: saving is what makes the app "configured", and that alone lands the
     * operator on the dashboard — so persisting first meant a wrong password
     * signed you in and then 401'd on every call.
     *
     * The password goes to POST /api/login, exactly as the web login sends it
     * (XERK-2569): that is the only place the hub checks a local account's
     * password, and it answers with the `hub_session` cookie the app then carries.
     * Only when the hub gives no session that way are the same creds tried as
     * Basic — the break-glass fallback, which also covers a proxy or hub without
     * the route.
     *
     * Either way the credential is proven on /api/agents, the read the app opens
     * with, and a 2xx must also DECODE as that payload: a URL pointing at some
     * other server answers 200 to anything, and accepting it would sign the
     * operator into a hub that isn't there.
     */
    suspend fun signIn(settings: Config.Settings): SignIn = withContext(Dispatchers.IO) {
        val outcome = login(settings)
        if (outcome is LoginOutcome.Throttled) return@withContext SignIn(SignInResult.HubRefused(outcome.message))
        // The hub itself refused the password (401). Basic checks the same
        // break-glass credential, so retrying it there can't succeed — and the
        // hub counts each miss toward this client's sign-in backoff (XERK-2577),
        // so a second try would spend the user's budget twice.
        if (outcome is LoginOutcome.Refused) return@withContext SignIn(SignInResult.BadCredentials)
        val token = (outcome as? LoginOutcome.Token)?.token
        if (token != null) {
            // The hub accepted the password, so its verdict on the session is
            // the answer — falling back to Basic here would word a refused
            // SESSION as a wrong password.
            val viaSession = probe(settings, sessionIssued = true) { header("Cookie", "$SESSION_COOKIE=$token") }
            return@withContext SignIn(viaSession, if (viaSession == SignInResult.Ok) token else "")
        }
        SignIn(probe(settings) { header("Authorization", settings.authHeader) })
    }

    /** GET /api/agents carrying the credential [auth] stamps, classified for the login screen. */
    private fun probe(
        settings: Config.Settings,
        sessionIssued: Boolean = false,
        auth: Request.Builder.() -> Request.Builder,
    ): SignInResult {
        val req = runCatching {
            Request.Builder().url(settings.baseUrl + "api/agents").auth().build()
        }.getOrNull() ?: return SignInResult.Unreachable // a URL OkHttp can't parse
        return try {
            http.newCall(req).execute().use { resp ->
                val result = signInResultFor(resp.code)
                if (result == SignInResult.BadCredentials && sessionIssued) {
                    return@use SignInResult.SessionRefused(resp.code)
                }
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
