package com.xerktech.turma.net

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A host going offline sends no calendar frame, only its agent record (XERK-2921,
 * web brief.html): the calendar re-reads on an `agent` frame that FLIPS `online`,
 * never on an ordinary beat.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FleetCalendarFlipTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private fun agent(online: Boolean, lastSeen: Long = 100) =
        """{"key":"h1","device":"h1","online":$online,"lastSeen":$lastSeen}"""

    @Test
    fun `only an online flip in an agent frame re-reads the calendar`() {
        val fleet = hub.container.fleet
        val start = fleet.calendarFrames.value
        fleet.onSseEvent("agent", agent(true))               // first sight: nothing to compare
        fleet.onSseEvent("agent", agent(true, lastSeen = 120)) // a beat
        assertEquals(start, fleet.calendarFrames.value)
        fleet.onSseEvent("agent", agent(false, lastSeen = 120)) // the offline sweep's frame
        assertEquals(start + 1, fleet.calendarFrames.value)
        fleet.onSseEvent("agent", agent(true, lastSeen = 140))
        assertEquals(start + 2, fleet.calendarFrames.value)
        fleet.onSseEvent("agent", agent(false, lastSeen = 10)) // stale: dropped, not a flip
        fleet.onSseEvent("agent", "{not json")
        assertEquals(start + 2, fleet.calendarFrames.value)
    }

    @Test
    fun `the offline frame still re-reads when the poll saw offline first`() {
        // The hub's /api/agents reads online:false ~11s before its offline sweep's frame,
        // and the 6s poll usually lands in that window (QA, real hub).
        val fleet = hub.container.fleet
        fleet.onSseEvent("agent", agent(true))
        hub.seedFleet("""{"now":100,"agents":[${agent(false)}]}""")
        val start = fleet.calendarFrames.value
        fleet.onSseEvent("agent", agent(false))
        assertEquals(start + 1, fleet.calendarFrames.value)
    }

    @Test
    fun `a removed host comes back with no stale baseline`() {
        val fleet = hub.container.fleet
        fleet.onSseEvent("agent", agent(false))
        fleet.onSseEvent("removed", """{"key":"h1"}""")
        val start = fleet.calendarFrames.value
        fleet.onSseEvent("agent", agent(true, lastSeen = 200)) // first sight again
        assertEquals(start, fleet.calendarFrames.value)
    }
}
