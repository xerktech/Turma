package com.xerktech.turma.net

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.model.Me
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test fun `an older hub without the route leaves the account unknown, and is not re-asked`() {
        val calls = java.util.concurrent.atomic.AtomicInteger()
        hub.route("/api/me") { calls.incrementAndGet(); okhttp3.mockwebserver.MockResponse().setResponseCode(404).setBody("{}") }
        val r = repo()
        hub.awaitValue { if (calls.get() >= 1) true else null }
        // The container's own repository may ask once too, so judge GROWTH: with a
        // 50ms retry period, a retry loop would keep adding calls here.
        Thread.sleep(300)
        val settled = calls.get()
        Thread.sleep(500)
        assertNull(r.me.value)
        assertEquals(settled, calls.get())
    }

    @Test fun `a hub mid-rollout (5xx) is asked again until it answers`() {
        val calls = java.util.concurrent.atomic.AtomicInteger()
        hub.route("/api/me") {
            if (calls.incrementAndGet() < 3) okhttp3.mockwebserver.MockResponse().setResponseCode(503).setBody("{}")
            else okhttp3.mockwebserver.MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json").setBody("""{"kind":"user","name":"alice"}""")
        }
        val r = repo()
        assertEquals("alice", hub.awaitValue { r.me.value }.name)
    }

    @Test fun `a session-token refresh for the same sign-in never blanks the account`() {
        hub.json("/api/me", """{"kind":"user","name":"alice","roles":["user"],"tenant":true}""")
        val r = repo()
        hub.awaitValue { r.me.value }
        val seen = mutableListOf<Me?>()
        val job = scope.launch { r.me.collect { synchronized(seen) { seen += it } } }
        hub.container.config.saveSession("fresh-token")
        Thread.sleep(400)
        job.cancel()
        synchronized(seen) { assertTrue("never null: $seen", seen.none { it == null }) }
    }

    @Test fun `signing out forgets the account`() {
        hub.json("/api/me", """{"kind":"user","name":"alice","roles":["user"],"tenant":true}""")
        val r = repo()
        hub.awaitValue { r.me.value }
        hub.container.config.clear()
        hub.awaitValue { if (r.me.value == null) true else null }
    }
}
