package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.util.TimeZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The calendar grid's DST rows on screen (XERK-2932): a step or swipe into or out of a 25-row day
 * keeps the same wall time at the top, and a day whose midnight is skipped labels its 1 AM top row.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CalendarDstGridTest {
    @get:Rule(order = 0) val main = MainDispatcherRule()
    @get:Rule(order = 1) val hub = HubHarness()
    @get:Rule(order = 2) val compose = createAndroidComposeRule<ComponentActivity>()

    private val savedZone: TimeZone = TimeZone.getDefault()
    @After fun restoreZone() = TimeZone.setDefault(savedZone)

    private fun rel(label: String): Float {
        val y = compose.onAllNodesWithText(label).fetchSemanticsNodes().firstOrNull()?.positionInRoot?.y ?: Float.NaN
        return y - compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().positionInRoot.y
    }

    /** The calendar in Day view on [day], in [zone]. */
    private fun showDay(zone: String, day: LocalDate) {
        TimeZone.setDefault(TimeZone.getTimeZone(zone))
        hub.seedFleet("""{ "now": 1, "agents": [ { "key": "h1", "device": "Desk", "online": true, "lastSeen": 1 } ] }""")
        hub.json("/api/calendar", """{ "from": 0, "until": 0, "hosts": [], "events": [] }""")
        hub.json("/api/holidays", "[]")
        val cvm = main.track(CalendarViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = false) }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("cal-scroll")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("cal-mode-DAY").performClick()
        val n = ChronoUnit.DAYS.between(day, cvm.today()).toInt()
        val tag = if (n >= 0) "cal-prev" else "cal-next"
        repeat(kotlin.math.abs(n)) { compose.onNodeWithTag(tag).performClick() }
        compose.waitForIdle()
    }

    private fun settle() { compose.waitForIdle(); compose.mainClock.advanceTimeBy(1000); compose.waitForIdle() }

    @Test fun `XERK-2932 a step or swipe into a 25-row day keeps 9 AM where it was`() {
        showDay("America/New_York", LocalDate.of(2026, 11, 2))
        compose.onNodeWithTag("cal-scroll").performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, rel("9 AM") - 40f) }
        settle()
        val at = rel("9 AM")
        val seen = ArrayList<Pair<String, Float>>()
        fun rec(what: String) { settle(); seen += what to rel("9 AM") }
        compose.onNodeWithTag("cal-prev").performClick(); rec("prev -> Nov 1 (25 rows)")
        compose.onNodeWithTag("cal-prev").performClick(); rec("prev -> Oct 31")
        compose.onNodeWithTag("cal-next").performClick(); rec("next -> Nov 1")
        compose.onNodeWithTag("cal-scroll").performTouchInput { swipeRight() }; rec("swipe -> Oct 31")
        compose.onNodeWithTag("cal-scroll").performTouchInput { swipeLeft() }; rec("swipe -> Nov 1")
        assertTrue("9 AM drifted from $at: $seen", seen.all { kotlin.math.abs(it.second - at) < 3f })
    }

    @Test fun `XERK-2932 a tap on the second 1 AM row opens New event in that hour's second pass`() {
        showDay("America/New_York", LocalDate.of(2026, 11, 1))
        compose.onNodeWithTag("cal-scroll").performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, -100_000f) }
        settle()
        val labels = compose.onAllNodesWithText("1 AM").fetchSemanticsNodes().map { it.positionInRoot.y }.sorted()
        assertEquals(2, labels.size)
        val row = labels[1] - labels[0]                       // an hour of grid, the two labels' distance
        val col = compose.onNodeWithTag("cal-col-2026-11-01").fetchSemanticsNode()
        val y = labels[1] + row * 0.6f - col.positionInRoot.y // into the EST 1 AM row, below its label
        compose.onNodeWithTag("cal-col-2026-11-01").performTouchInput { click(Offset(width / 2f, y)) }
        settle()
        val d = hub.app.container.calendarEditor.value!!.draft
        assertEquals(java.time.LocalTime.of(1, 0), d.startTime)
        assertEquals(java.time.ZoneOffset.ofHours(-5), d.startOffset)
    }

    @Test fun `XERK-2932 a day whose midnight is skipped labels its 1 AM top row`() {
        showDay("America/Santiago", LocalDate.of(2026, 9, 6))
        compose.onNodeWithTag("cal-scroll").performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, -100_000f) }
        settle()
        assertEquals(0f, rel("1 AM"), 1f)
    }
}
