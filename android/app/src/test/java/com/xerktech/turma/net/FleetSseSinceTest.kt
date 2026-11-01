package com.xerktech.turma.net

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Collections

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
/** XERK-2599: the fleet stream opens after the first poll and names that snapshot. */
class FleetSseSinceTest {
    @get:Rule(order = 0) val main = MainDispatcherRule()
    @get:Rule(order = 1) val hub = HubHarness()

    private val body = """{"now": 1, "agents": [{"key": "h1", "device": "h1", "online": true, "lastSeen": 1}]}"""

    private fun run(etag: String?): List<String> {
        val seen = Collections.synchronizedList(ArrayList<String>())
        hub.route("/api/agents") { r ->
            seen.add("A " + r.path)
            val m = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
            if (etag != null) m.setHeader("ETag", etag)
            m
        }
        hub.route("/api/events") { r ->
            seen.add("E " + r.path)
            MockResponse().setResponseCode(200).setHeader("Content-Type", "text/event-stream")
                .setBody("retry: 3000\n\nid: 0\n: connected\n\n")
        }
        hub.container.fleet.start()
        hub.awaitValue { if (seen.any { it.startsWith("E ") }) true else null }
        hub.container.fleet.stop()
        return synchronized(seen) { seen.toList() }
    }

    @Test fun sinceIsTheFirstPollsEtag_andStreamOpensAfterIt() {
        val seen = run("\"ab/c+=\"")
        val e = seen.first { it.startsWith("E ") }
        assertEquals("E /api/events?since=%22ab%2Fc%2B%3D%22", e)
        assertTrue("poll before stream: $seen", seen.indexOfFirst { it.startsWith("A ") } < seen.indexOf(e))
    }

    @Test fun noEtag_noSince() {
        val seen = run(null)
        assertEquals("E /api/events", seen.first { it.startsWith("E ") })
    }

    @Test fun failedFirstPoll_stillOpensStream_unseeded() {
        val seen = Collections.synchronizedList(ArrayList<String>())
        hub.route("/api/agents") { r -> seen.add("A " + r.path); MockResponse().setResponseCode(503).setBody("{\"error\":\"down\"}") }
        hub.route("/api/events") { r -> seen.add("E " + r.path)
            MockResponse().setResponseCode(200).setHeader("Content-Type", "text/event-stream").setBody(": c\n\n") }
        hub.container.fleet.start()
        hub.awaitValue { if (seen.any { it.startsWith("E ") }) true else null }
        hub.container.fleet.stop()
        assertEquals("E /api/events", seen.first { it.startsWith("E ") })
        assertTrue(hub.container.fleet.state.value.error != null)
    }
}
