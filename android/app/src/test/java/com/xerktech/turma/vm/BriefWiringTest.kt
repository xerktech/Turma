package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The Daily Brief's wiring below the screen (XERK-2397 QA): the poll and the
 * SSE frames fill `FleetState`, and Run now sends one request per org at a time.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BriefWiringTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = """{ "key": "h1", "device": "h1", "online": true, "lastSeen": 1 }"""

    @Test fun `the poll fills the briefs and schedules`() {
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ],
              "dailyBriefs": { "o": [ { "runId": "a1", "status": "ok", "day": "Shipped." } ] },
              "dailyBriefSchedules": { "o": { "enabled": true, "time": "09:30", "timeZone": "UTC", "weekdays": [1] } } }
        """.trimIndent())
        val s = hub.container.fleet.state.value
        assertEquals("Shipped.", s.dailyBriefs.getValue("o").single().day)
        assertEquals("09:30", s.dailyBriefSchedules.getValue("o").time)
    }

    @Test fun `the SSE frames replace the briefs and schedules, and a bad frame changes nothing`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        val fleet = hub.container.fleet
        fleet.onSseEvent("dailyBriefs", """{ "o": [ { "runId": "r", "status": "running" } ] }""")
        assertEquals("running", fleet.state.value.dailyBriefs.getValue("o").single().status)
        fleet.onSseEvent("dailyBriefSchedules", """{ "o": { "enabled": true, "time": "08:00", "timeZone": "UTC", "weekdays": [2] } }""")
        assertEquals("08:00", fleet.state.value.dailyBriefSchedules.getValue("o").time)
        // A non-JSON frame is dropped, the last good state kept.
        fleet.onSseEvent("dailyBriefs", "not json")
        assertEquals("r", fleet.state.value.dailyBriefs.getValue("o").single().runId)
        fleet.onSseEvent("dailyBriefs", "{}")
        assertNull(fleet.state.value.dailyBriefs["o"])
    }

    @Test fun `a second Run now while the first is unanswered sends nothing`() {
        val hits = AtomicInteger()
        val release = CountDownLatch(1)
        hub.route("/api/orgs/") {
            hits.incrementAndGet()
            release.await(10, TimeUnit.SECONDS)
            MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                .setBody("""{"ok":true}""")
        }
        val vm = main.track(BriefViewModel(hub.app))
        val first = vm.runNow("o")
        hub.awaitFlow(vm.asking) { "o" in it }
        vm.runNow("o")
        hub.awaitValue { hits.get().takeIf { it > 0 } }
        release.countDown()
        hub.awaitFlow(vm.asking) { "o" !in it }
        kotlinx.coroutines.runBlocking { first.join() }
        assertEquals(1, hits.get())
    }
}
