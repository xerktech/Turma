package com.xerktech.turma.push

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * `PushRegistrar`'s recovery from a cross-tenant binding (XERK-2622, test gap
 * from rollup XERK-2627): a 409 from `POST /api/devices` rotates the FCM token
 * ONCE and registers the fresh one, and sign-out's release suspends until the
 * hub has answered the DELETE — the caller clears credentials only after it.
 * Real HTTP stack against the scripted hub; only the Firebase token is faked.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PushRegistrarTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    /** Hands out "tok-0", then "tok-1", … on each rotation. */
    private class FakeTokens : PushRegistrar.TokenSource {
        var current = "tok-0"
        var rotations = 0
        override fun ready(context: android.content.Context) = true
        override suspend fun current(): String = current
        override suspend fun rotate(): String {
            rotations++
            current = "tok-$rotations"
            return current
        }
    }

    private val fake = FakeTokens()
    private val original = PushRegistrar.tokens
    private val posted = Collections.synchronizedList(mutableListOf<String>())

    @Before fun setUp() {
        PushRegistrar.tokens = fake
        PushRegistrar.rotated.set(false)
    }

    @After fun tearDown() {
        PushRegistrar.tokens = original
        PushRegistrar.rotated.set(false)
    }

    private fun tokenOf(req: RecordedRequest) =
        Regex("\"token\":\"([^\"]*)\"").find(req.body.readUtf8())!!.groupValues[1]

    /** POSTs answer 409 for every token in [boundElsewhere], 200 otherwise. */
    private fun devicesRoute(boundElsewhere: Set<String>) = hub.route("/api/devices") { req ->
        val token = tokenOf(req)
        posted += token
        if (token in boundElsewhere) HubHarness.refusal("this device is registered to another account")
        else MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
            .setBody("""{"ok":true}""")
    }

    @Test fun `a 409 rotates the token once and registers the fresh one`() {
        devicesRoute(setOf("tok-0"))
        runBlocking { PushRegistrar.registerToken(hub.container, "tok-0") }
        assertEquals(listOf("tok-0", "tok-1"), posted.toList())
        assertEquals(1, fake.rotations)
        // The success re-arms it, so a later account switch can rotate again.
        assertFalse(PushRegistrar.rotated.get())
    }

    @Test fun `a 409 straight after rotating does not rotate again`() {
        devicesRoute(setOf("tok-0", "tok-1"))
        runBlocking { PushRegistrar.registerToken(hub.container, "tok-0") }
        assertEquals(listOf("tok-0", "tok-1"), posted.toList())
        assertEquals(1, fake.rotations)
    }

    @Test fun `each account switch can rotate once`() {
        devicesRoute(setOf("tok-0"))
        runBlocking { PushRegistrar.registerToken(hub.container, "tok-0") }
        devicesRoute(setOf("tok-1"))
        runBlocking { PushRegistrar.registerToken(hub.container, "tok-1") }
        assertEquals(listOf("tok-0", "tok-1", "tok-1", "tok-2"), posted.toList())
        assertEquals(2, fake.rotations)
    }

    @Test fun `sign-out's release returns only once the hub answered the authed DELETE`() {
        val held = CountDownLatch(1)
        val arrived = CountDownLatch(1)
        var seen: RecordedRequest? = null
        hub.route("/api/devices") { req ->
            seen = req
            arrived.countDown()
            held.await(10, TimeUnit.SECONDS)
            MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                .setBody("""{"ok":true}""")
        }
        runBlocking {
            val release = async(Dispatchers.IO) { PushRegistrar.unregister(hub.app, hub.container) }
            assert(arrived.await(10, TimeUnit.SECONDS)) { "DELETE never reached the hub" }
            // The hub has the request but has not answered: still suspended.
            assertFalse(release.isCompleted)
            held.countDown()
            withTimeout(10_000) { release.await() }
        }
        val req = seen!!
        assertEquals("DELETE", req.method)
        assertEquals("tok-0", req.requestUrl!!.queryParameter("token"))
        // Sent while the credentials still exist — the XERK-2622 401 was this.
        assertNotNull(req.getHeader("Authorization") ?: req.getHeader("Cookie"))
    }
}
