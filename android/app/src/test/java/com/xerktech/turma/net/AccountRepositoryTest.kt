package com.xerktech.turma.net

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.model.Me
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config as RoboConfig

/**
 * XERK-2553: who the app is signed in as, over the REAL HTTP stack. Each test
 * builds its own repository after routing `/api/me`, so the container's own
 * (started with the Application) never races the routes.
 */
@RunWith(RobolectricTestRunner::class)
@RoboConfig(sdk = [35])
class AccountRepositoryTest {

    @get:Rule
    val hub = HubHarness()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After fun stop() = scope.cancel()

    private fun repo() = AccountRepository(hub.container.client, hub.container.config, scope, retryMs = 50)

    @Test fun `a signed-in app reads its account`() {
        hub.json("/api/me", """{"kind":"user","name":"alice","source":"local","roles":["user"],"tenant":true,"adminOnly":false}""")
        val r = repo()
        val me = hub.awaitValue { r.me.value }
        assertEquals(Me("user", "alice", "local", listOf("user"), tenant = true), me)
    }

    @Test fun `an admin-only account reads as admin-only`() {
        hub.json("/api/me", """{"kind":"user","name":"root","roles":["admin"],"tenant":false,"adminOnly":true}""")
        val r = repo()
        assertEquals(true, hub.awaitValue { r.me.value }.adminOnly)
    }

    @Test fun `an older hub without the route leaves the account unknown`() {
        hub.json("/api/me", """{"error":"not found"}""", code = 404)
        val r = repo()
        hub.findRequest("/api/me")
        Thread.sleep(300)
        assertNull(r.me.value)
    }

    @Test fun `signing out forgets the account`() {
        hub.json("/api/me", """{"kind":"user","name":"alice","roles":["user"],"tenant":true}""")
        val r = repo()
        hub.awaitValue { r.me.value }
        hub.container.config.clear()
        hub.awaitValue { if (r.me.value == null) true else null }
    }
}
