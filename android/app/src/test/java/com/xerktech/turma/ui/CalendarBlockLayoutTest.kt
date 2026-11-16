package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.CalMode
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.ZoneId
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * XERK-3026: at the 24h zoom the grid's rows sit at their 10dp minimum, so a short event's block
 * is drawn taller than its 20 minutes. The grid must lay it out by that drawn floor, or the block
 * covers the start of an event 20-30 minutes later in the same column. Pins the grid's wiring
 * (the floor passed to the layout, and the one floor used to draw), which `CalendarTest` can't.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CalendarBlockLayoutTest {
    @get:Rule(order = 0) val main = MainDispatcherRule()
    @get:Rule(order = 1) val hub = HubHarness()
    @get:Rule(order = 2) val compose = createAndroidComposeRule<ComponentActivity>()

    private val a = "a.atlassian.net"
    private val zone = ZoneId.systemDefault()
    private val day = LocalDate.now(zone).plusDays(1)
    private fun t(h: Int, m: Int = 0) = day.atTime(h, m).atZone(zone).toInstant().toEpochMilli()
    private fun ev(id: String, s: Long, e: Long) = """{ "host": "h1", "org": "$a", "matchOrg": "$a", "id": "$id",
        "source": "outlook", "subject": "Event $id", "startMs": $s, "endMs": $e, "busy": "busy", "myResponse": "accepted" }"""

    @Test fun `XERK-3026 at the 24h zoom no short block covers the next event`() {
        // B and C start 25 minutes after the last: a 20-minute layout put them in one column, the
        // earlier block drawn over the later one's top. D starts exactly where C's floored layout
        // ends (30 minutes at 10dp rows), in C's column: a block DRAWN taller than the floor the
        // layout read would overlap it.
        val events = listOf(
            ev("A", t(9), t(9)), ev("B", t(9, 25), t(9, 40)), ev("C", t(9, 50), t(10, 5)), ev("D", t(10, 20), t(10, 30)),
        )
        hub.seedFleet("""{ "now": 1, "agents": [ { "key": "h1", "device": "h1", "online": true, "lastSeen": 1, "org": "$a",
            "jira": { "available": true, "siteKey": "$a", "site": "$a", "tickets": [] } } ] }""")
        hub.route("/api/calendar") { req ->
            val url = req.requestUrl!!
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "from": ${url.queryParameter("from")}, "until": ${url.queryParameter("until")},
                  "hosts": [ { "host": "h1", "device": "h1", "online": true, "syncedAt": 1, "ranges": [[0, 9000000000000000]] } ],
                  "events": [ ${events.joinToString(",")} ] }""",
            )
        }
        hub.json("/api/holidays", "[]")
        val cvm = main.track(CalendarViewModel(hub.app))
        cvm.setZoom(24f, save = false)
        cvm.setMode(false, CalMode.DAY)
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = false) }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("cal-next")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("cal-next").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("cal-ev")).fetchSemanticsNodes().size >= events.size }
        compose.waitForIdle()

        val boxes = compose.onAllNodes(hasTestTag("cal-ev")).fetchSemanticsNodes().map { it.boundsInRoot }
        assertEquals(events.size, boxes.size)
        // The rows really are at their minimum here, so the floor is taller than 20 minutes.
        assertTrue(boxes.all { it.height > 0f })
        for (i in boxes.indices) for (j in i + 1 until boxes.size) {
            val p = boxes[i]
            val q = boxes[j]
            val x = minOf(p.right, q.right) - maxOf(p.left, q.left)
            val y = minOf(p.bottom, q.bottom) - maxOf(p.top, q.top)
            assertTrue("blocks $i and $j overlap: $p / $q", x <= 0.5f || y <= 0.5f)
        }
    }
}
