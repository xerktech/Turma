package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Whether the chat notices a live feed that is open but not DELIVERING
 * (XERK-2372) — the web chat's `liveDelivering`, ported.
 *
 * The socket being open was the poll fallback's whole gate, so a socket the hub
 * accepted but never armed an agent watch behind (`armed:false`), or one that
 * went silent mid-turn, left the chat on the heartbeat's preview: agent output
 * reached the phone late, or not until the operator left and came back.
 *
 * The poll loop runs on the test scheduler's VIRTUAL clock (advanced by hand),
 * and the stall read on [ChatViewModel.now], so nothing here races a wall clock;
 * the sockets and HTTP are real (MockWebServer).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatLiveFeedTest {

    private val scheduler = TestCoroutineScheduler()

    @get:Rule(order = 0)
    val main = MainDispatcherRule(UnconfinedTestDispatcher(scheduler))

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = "nas01"
    private val session = "s1"
    private val histories = AtomicInteger()
    private val upgrades = AtomicInteger()
    private val serverSockets = CopyOnWriteArrayList<WebSocket>()
    private val closed = AtomicInteger()
    private var clock = 1_000_000L

    private fun fleet(busy: Boolean) = HubHarness.fleetJson(
        host = host,
        sessions = """{ "id": "$session", "repo": "Turma", "session": { "paneBusy": $busy } }""",
    )

    /** A hub that answers the live upgrade with [watch] (none if null) and then its heartbeat seed. */
    private fun serve(busy: Boolean, watch: String?) {
        hub.seedFleet(fleet(busy))
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.route("/api/agents/$host/sessions/$session/history") {
            histories.incrementAndGet()
            MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{"entries":[{"id":"h1","role":"assistant","text":"from history"}]}""")
        }
        hub.route("/live/") {
            upgrades.incrementAndGet()
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    serverSockets += webSocket
                    watch?.let(webSocket::send)
                    webSocket.send(
                        """{"type":"tail","seed":true,"entries":[{"id":"seed-${upgrades.get()}","role":"assistant","text":"seed"}]}""",
                    )
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    closed.incrementAndGet()
                    webSocket.close(1000, null)
                }
            })
        }
    }

    private fun enter(): ChatViewModel {
        val vm = main.track(ChatViewModel(hub.app, host, session))
        vm.now = { clock }
        vm.onEnter()
        // The seed follows the watch frame on the same socket, so once it is in
        // the buffer the ack has been read too.
        hub.awaitFlow(vm.state) { s -> s.connected && s.entries.any { it.id == "seed-1" } }
        // The open-time /history fetch, so the counts below are the POLL's alone.
        hub.awaitValue { histories.get().takeIf { it >= 1 } }
        return vm
    }

    private fun pollTick() = scheduler.advanceTimeBy(ChatViewModel.POLL_MS + 1)

    @Test
    fun `a socket the hub never armed falls back to the history poll`() {
        serve(busy = false, watch = """{"type":"watch","armed":false,"reason":"this host's tunnel is offline"}""")
        enter()
        val before = histories.get()
        pollTick()
        hub.awaitValue { histories.get().takeIf { it > before } }
    }

    @Test
    fun `an armed socket on a quiet session is left alone`() {
        serve(busy = false, watch = """{"type":"watch","armed":true}""")
        val vm = enter()
        val before = histories.get()
        clock += 60_000 // silence on a quiet session is fine, however long
        pollTick()
        // Nothing to await on a negative; give a wrongly-fired fetch time to land.
        Thread.sleep(500)
        assertEquals(before, histories.get())
        assertEquals(1, upgrades.get())
        assertEquals(true, vm.state.value.connected)
    }

    @Test
    fun `a busy session whose feed went silent polls history and replaces the socket`() {
        serve(busy = true, watch = """{"type":"watch","armed":true}""")
        enter()
        val before = histories.get()
        clock += ChatViewModel.LIVE_STALE_MS + 1
        pollTick()
        hub.awaitValue { histories.get().takeIf { it > before } }
        hub.awaitValue { upgrades.get().takeIf { it >= 2 } }
        // The replaced socket is closed, not leaked beside its successor.
        hub.awaitValue { closed.get().takeIf { it >= 1 } }
    }

    @Test
    fun `a busy session that keeps ticking is not polled`() {
        serve(busy = true, watch = """{"type":"watch","armed":true}""")
        val vm = enter()
        val before = histories.get()
        clock += ChatViewModel.LIVE_STALE_MS + 1
        serverSockets.single().send("""{"type":"turn","text":"working","status":null}""")
        hub.awaitFlow(vm.state) { it.liveTurn == "working" } // the frame stamped lastFrameAt
        pollTick()
        Thread.sleep(500)
        assertEquals(before, histories.get())
        assertEquals(1, upgrades.get())
    }

    @Test
    fun `leaving the chat closes its live socket`() {
        serve(busy = false, watch = """{"type":"watch","armed":true}""")
        val vm = enter()
        vm.onLeave()
        hub.awaitValue { closed.get().takeIf { it >= 1 } }
    }

    @Test
    fun `a feed that will not arm is replaced at most once per cooldown`() {
        serve(busy = false, watch = """{"type":"watch","armed":false,"reason":"this host's tunnel is offline"}""")
        enter()
        pollTick()
        hub.awaitValue { upgrades.get().takeIf { it >= 2 } }
        // Still inside the cooldown: the next tick keeps the socket.
        pollTick()
        Thread.sleep(500)
        assertEquals(2, upgrades.get())
        clock += ChatViewModel.LIVE_RECONNECT_COOLDOWN_MS + 1
        pollTick()
        hub.awaitValue { upgrades.get().takeIf { it >= 3 } }
    }

    @Test
    fun `re-entering after the socket left does not trust the old one`() {
        serve(busy = false, watch = """{"type":"watch","armed":true}""")
        val vm = enter()
        vm.onLeave()
        // The next socket never comes up, so nothing will ever say connected.
        hub.json("/api/ws-token", """{"error":"down"}""", code = 500)
        val opened = histories.get()
        vm.onEnter()
        hub.awaitValue { histories.get().takeIf { it > opened } } // the open-time fetch
        assertEquals(false, vm.state.value.connected)
        val before = histories.get()
        pollTick()
        hub.awaitValue { histories.get().takeIf { it > before } }
    }

    @Test
    fun `a new socket earns its own arming, not the last one's`() {
        serve(busy = false, watch = """{"type":"watch","armed":true}""")
        val vm = enter()
        vm.onLeave()
        // The next socket opens but no watch ack ever follows it.
        serve(busy = false, watch = null)
        val opened = histories.get()
        vm.onEnter()
        hub.awaitFlow(vm.state) { it.connected }
        hub.awaitValue { histories.get().takeIf { it > opened } } // the open-time fetch
        val before = histories.get()
        pollTick()
        hub.awaitValue { histories.get().takeIf { it > before } }
    }

    @Test
    fun `re-entering may replace a dead feed again at once`() {
        serve(busy = false, watch = """{"type":"watch","armed":false,"reason":"this host's tunnel is offline"}""")
        val vm = enter()
        pollTick()
        hub.awaitValue { upgrades.get().takeIf { it >= 2 } }
        vm.onLeave()
        vm.onEnter()
        hub.awaitValue { upgrades.get().takeIf { it >= 3 } } // the re-entry's own socket
        hub.awaitFlow(vm.state) { it.connected }
        pollTick() // same instant as the last forced replace: only the reset allows it
        hub.awaitValue { upgrades.get().takeIf { it >= 4 } }
    }
}
