package com.xerktech.turma.net

import com.xerktech.turma.harness.HubHarness
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Native Authentik SSO end-to-end on the client (XERK-591), driving the REAL
 * OkHttp/Retrofit stack against a MockWebServer: begin() probes the hub, the
 * exchange stores the token, and the token then authenticates as a Cookie — with
 * a 401 dropping it. The PKCE math is pinned separately in
 * [com.xerktech.turma.core.OidcTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OidcControllerTest {

    @get:Rule
    val hub = HubHarness()

    private val base get() = hub.server.url("/").toString()

    @Test fun `begin surfaces the Custom Tab URL when the hub offers SSO`() = runBlocking {
        hub.json("/api/oidc/config", "{\"enabled\":true}")
        hub.container.oidc.begin(base)
        val ui = hub.container.oidc.ui.value
        assertNull(ui.error)
        assertNotNull(ui.launchUrl)
        assertTrue(ui.launchUrl!!.startsWith(base.trimEnd('/') + "/auth/oidc/login?mobile="))
        // The verifier was stashed for the deep-link return.
        assertTrue(hub.container.config.pendingOidcVerifier.isNotEmpty())
    }

    @Test fun `begin reports a hub with no SSO`() = runBlocking {
        hub.json("/api/oidc/config", "{\"enabled\":false}")
        hub.container.oidc.begin(base)
        assertTrue(hub.container.oidc.ui.value.error!!.contains("isn't enabled"))
        assertNull(hub.container.oidc.ui.value.launchUrl)
    }

    @Test fun `complete exchanges the code, stores the token, and authenticates by cookie`() = runBlocking {
        hub.container.config.startOidc(base, "verifier-abc")
        hub.json("/api/oidc/mobile/exchange", "{\"token\":\"tok-123\",\"ttlMs\":3600000}")
        var seenCookie: String? = null
        var seenAuth: String? = null
        hub.route("/api/agents") { req ->
            seenCookie = req.getHeader("Cookie")
            seenAuth = req.getHeader("Authorization")
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json").setBody("{\"agents\":[]}")
        }

        hub.container.oidc.complete("the-code", null)

        assertEquals("tok-123", hub.container.config.current.sessionToken)
        assertTrue(hub.container.config.current.configured)
        assertTrue("the one-shot verifier is cleared", hub.container.config.pendingOidcVerifier.isEmpty())
        // A subsequent API call rides the SSO cookie, NOT Basic auth.
        hub.container.client.api.listAgents()
        assertEquals("hub_session=tok-123", seenCookie)
        assertNull(seenAuth)
    }

    @Test fun `complete surfaces a forbidden group error and stores no token`() = runBlocking {
        hub.container.oidc.complete(null, "forbidden")
        assertTrue(hub.container.oidc.ui.value.error!!.contains("group"))
        assertTrue(hub.container.config.current.sessionToken.isEmpty())
    }

    @Test fun `a bad handoff code fails cleanly with no token`() = runBlocking {
        hub.container.config.startOidc(base, "verifier-abc")
        hub.json("/api/oidc/mobile/exchange", "{\"error\":\"invalid or expired handoff code\"}", 400)
        hub.container.oidc.complete("stale-code", null)
        assertNotNull(hub.container.oidc.ui.value.error)
        assertTrue(hub.container.config.current.sessionToken.isEmpty())
    }

    @Test fun `a 401 on an SSO session drops the token`() = runBlocking {
        hub.container.config.saveSession("expiring-tok")
        assertTrue(hub.container.config.current.sessionToken.isNotEmpty())
        hub.json("/api/agents", "{\"error\":\"unauthorized\"}", 401)
        runCatching { hub.container.client.api.listAgents() } // throws HttpException on 401
        assertTrue("the lapsed SSO token is cleared", hub.container.config.current.sessionToken.isEmpty())
    }
}
