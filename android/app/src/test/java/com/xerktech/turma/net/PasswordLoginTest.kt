package com.xerktech.turma.net

import com.xerktech.turma.core.SignInResult
import com.xerktech.turma.data.Config
import com.xerktech.turma.harness.HubHarness
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.atomic.AtomicInteger
import org.robolectric.annotation.Config as RoboConfig

/**
 * Password sign-in through POST /api/login (XERK-2569), driving the REAL
 * OkHttp/Retrofit stack against a MockWebServer. The hub checks Basic against
 * its break-glass credential only, so a local account signs in solely through
 * /api/login and then rides the returned `hub_session` cookie.
 */
@RunWith(RobolectricTestRunner::class)
@RoboConfig(sdk = [35])
class PasswordLoginTest {

    @get:Rule
    val hub = HubHarness()

    private val base get() = hub.server.url("/").toString()

    private fun candidate() = Config.Settings(hubUrl = base, user = "alice", password = "s3cret")

    private fun loginIssues(token: String, onLogin: (RecordedRequest) -> Unit = {}) = hub.route("/api/login") {
        onLogin(it)
        MockResponse().setResponseCode(200)
            .setHeader("Content-Type", "application/json")
            .addHeader("Set-Cookie", "hub_session=$token; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
            .setBody("{\"ok\":true}")
    }

    // /api/agents accepts only the given session cookie (as a hub does for a
    // local account, whose password it never checks as Basic).
    private fun agentsAcceptOnly(token: String, seen: MutableList<RecordedRequest> = mutableListOf()) =
        hub.route("/api/agents") { req ->
            seen += req
            if (req.getHeader("Cookie") == "hub_session=$token")
                MockResponse().setResponseCode(200)
                    .setHeader("Content-Type", "application/json").setBody("{\"agents\":[]}")
            else MockResponse().setResponseCode(401).setBody("{\"error\":\"unauthorized\"}")
        }

    @Test fun `a local account signs in via api login and carries the session cookie`() = runBlocking {
        var loginBody = ""
        loginIssues("local-tok") { loginBody = it.body.readUtf8() }
        val seen = mutableListOf<RecordedRequest>()
        agentsAcceptOnly("local-tok", seen)

        val signIn = hub.container.client.signIn(candidate())

        assertEquals(SignInResult.Ok, signIn.result)
        assertEquals("local-tok", signIn.sessionToken)
        assertTrue(loginBody.contains("\"username\":\"alice\""))
        assertTrue(loginBody.contains("\"password\":\"s3cret\""))
        // The probe proved the cookie, never sent Basic.
        assertTrue(seen.all { it.getHeader("Authorization") == null })

        hub.container.config.save(base, "alice", "s3cret", signIn.sessionToken)
        seen.clear()
        hub.container.client.api.listAgents()
        assertEquals("hub_session=local-tok", seen.single().getHeader("Cookie"))
        assertNull(seen.single().getHeader("Authorization"))
    }

    @Test fun `a refused password is bad credentials and earns no session`() = runBlocking {
        hub.json("/api/login", "{\"error\":\"invalid credentials\"}", 401)
        hub.json("/api/agents", "{\"error\":\"unauthorized\"}", 401)
        val signIn = hub.container.client.signIn(candidate())
        assertEquals(SignInResult.BadCredentials, signIn.result)
        assertEquals("", signIn.sessionToken)
    }

    // Break-glass fallback: a hub (or proxy) that gives no session through
    // /api/login still signs in over Basic, as before.
    @Test fun `no session from api login falls back to Basic`() = runBlocking {
        var seenAuth: String? = null
        hub.route("/api/agents") { req ->
            seenAuth = req.getHeader("Authorization")
            if (seenAuth != null) MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json").setBody("{\"agents\":[]}")
            else MockResponse().setResponseCode(401)
        }
        val signIn = hub.container.client.signIn(candidate()) // /api/login is unrouted → 404
        assertEquals(SignInResult.Ok, signIn.result)
        assertEquals("", signIn.sessionToken)
        assertTrue(seenAuth!!.startsWith("Basic "))
    }

    @Test fun `a non-hub server answering 200 is not signed into`() = runBlocking {
        loginIssues("whatever")
        hub.route("/api/agents") { MockResponse().setResponseCode(200).setBody("<html>hi</html>") }
        assertEquals(SignInResult.Unreachable, hub.container.client.signIn(candidate()).result)
    }

    @Test fun `a lapsed password session signs in again and retries once`() = runBlocking {
        hub.container.config.save(base, "alice", "s3cret", "old-tok")
        loginIssues("new-tok")
        val seen = mutableListOf<RecordedRequest>()
        agentsAcceptOnly("new-tok", seen)

        hub.container.client.api.listAgents() // no throw: the retry succeeded

        assertEquals("new-tok", hub.container.config.current.sessionToken)
        assertEquals(listOf("hub_session=old-tok", "hub_session=new-tok"), seen.map { it.getHeader("Cookie") })
    }

    // An install from before XERK-2569 stored a password and no session; the
    // first Basic 401 moves it onto a session.
    @Test fun `a stored password with no session is moved onto one`() = runBlocking {
        hub.container.config.save(base, "alice", "s3cret")
        loginIssues("migrated-tok")
        agentsAcceptOnly("migrated-tok")
        hub.container.client.api.listAgents()
        assertEquals("migrated-tok", hub.container.config.current.sessionToken)
    }

    @Test fun `a password the hub now refuses signs the app out`() = runBlocking {
        hub.container.config.save(base, "alice", "changed", "old-tok")
        hub.json("/api/login", "{\"error\":\"invalid credentials\"}", 401)
        hub.json("/api/agents", "{\"error\":\"unauthorized\"}", 401)
        runCatching { hub.container.client.api.listAgents() }
        assertFalse(hub.container.config.current.configured)
        assertEquals(base.trim(), hub.container.config.current.hubUrl) // the URL is kept
    }

    // A burst of calls that all 401 on one lapsed session signs in ONCE: the
    // relogin is serialised, and a call that waited reuses the fresh token.
    @Test fun `concurrent 401s on one lapsed session sign in once`() = runBlocking {
        hub.container.config.save(base, "alice", "s3cret", "old-tok")
        val logins = AtomicInteger()
        loginIssues("new-tok") { logins.incrementAndGet(); Thread.sleep(100) }
        agentsAcceptOnly("new-tok")

        val results = (1..12).map {
            async(Dispatchers.IO) { runCatching { hub.container.client.api.listAgents() }.isSuccess }
        }.awaitAll()

        assertTrue("every call recovered", results.all { it })
        assertEquals(1, logins.get())
        assertEquals("new-tok", hub.container.config.current.sessionToken)
    }

    // A sign-out landing while the interceptor's /api/login is in flight must
    // stay signed out — the old credentials are never written back.
    @Test fun `a sign-out during a relogin stays signed out`() = runBlocking {
        hub.container.config.save(base, "alice", "s3cret", "old-tok")
        loginIssues("new-tok") { hub.container.config.clear() }
        agentsAcceptOnly("new-tok")

        runCatching { hub.container.client.api.listAgents() }

        assertFalse(hub.container.config.current.configured)
        assertEquals("", hub.container.config.current.password)
        assertEquals("", hub.container.config.current.sessionToken)
    }

    // Only the hub's own 401 means a wrong password; a 403 on /api/login is
    // more likely a proxy in front of the hub and must not sign the app out.
    @Test fun `a 403 on api login does not sign the app out`() = runBlocking {
        hub.container.config.save(base, "alice", "s3cret", "old-tok")
        hub.json("/api/login", "{\"error\":\"forbidden\"}", 403)
        hub.json("/api/agents", "{\"error\":\"unauthorized\"}", 401)
        runCatching { hub.container.client.api.listAgents() }
        assertTrue(hub.container.config.current.configured)
        assertEquals("s3cret", hub.container.config.current.password)
    }

    // /api/login accepted the password but the hub refuses the session it
    // issued: report THAT (no Basic fallback), never "wrong password".
    @Test fun `a refused session after an accepted password is not bad credentials`() = runBlocking {
        for (code in listOf(401, 403)) {
            loginIssues("tok")
            var basicTried = false
            hub.route("/api/agents") { req ->
                if (req.getHeader("Authorization") != null) basicTried = true
                MockResponse().setResponseCode(code)
            }
            val signIn = hub.container.client.signIn(candidate())
            assertEquals(SignInResult.SessionRefused(code), signIn.result)
            assertEquals("", signIn.sessionToken)
            assertFalse("no Basic fallback once a session was issued", basicTried)
        }
    }
}
