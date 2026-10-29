package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.briefPage
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.vm.BriefViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/** The Brief screen (XERK-2397): what it reads aloud, and Run now's two outcomes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BriefScreenTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val ny = ZoneId.of("America/New_York")
    private fun at(d: Int, h: Int, m: Int) = ZonedDateTime.of(2026, 10, d, h, m, 0, 0, ny).toInstant().toEpochMilli()
    private val now = at(29, 8, 0)

    private val briefs = listOf(
        DailyBrief(runId = "b2", status = "ok", meetingAt = at(29, 9, 30), day = "Two tickets shipped.",
            week = "Five this week.", next = "XERK-9 is next."),
        DailyBrief(runId = "b1", status = "ok", trigger = "manual", meetingAt = at(28, 9, 30),
            headline = "One ticket shipped."),
    )

    private fun body(list: List<DailyBrief>, onRunNow: () -> Unit = {}) = compose.setContent {
        BriefBody(
            page = briefPage(list), nextMeeting = at(30, 9, 30), now = now,
            running = briefPage(list).running != null, asking = false, onRunNow = onRunNow,
            zone = ny, locale = Locale.US,
        )
    }

    @Test fun `the latest brief reads aloud with the next meeting and earlier headlines`() {
        var ran = 0
        body(briefs) { ran++ }
        compose.onNodeWithText("Next meeting Tomorrow 9:30 AM").assertExists()
        compose.onNodeWithText("For Today 9:30 AM").assertExists()
        compose.onNodeWithText("Since yesterday").assertExists()
        compose.onNodeWithText("Two tickets shipped.").assertExists()
        compose.onNodeWithText("Five this week.").assertExists()
        compose.onNodeWithText("XERK-9 is next.").assertExists()
        compose.onNodeWithText("Yesterday 9:30 AM · Run now").assertExists()
        compose.onNodeWithText("One ticket shipped.").assertExists()
        compose.onNodeWithText("Run now").assertIsEnabled().performClick()
        assertEquals(1, ran)
    }

    @Test fun `Run now is off while a brief is being written`() {
        body(listOf(DailyBrief(runId = "r", status = "running")) + briefs)
        compose.onNodeWithText("Writing…").assertIsNotEnabled()
        compose.onNodeWithText("Two tickets shipped.").assertExists()
    }

    @Test fun `an org with no brief says so`() {
        body(emptyList())
        compose.onNodeWithText("No brief yet. Run now writes one.").assertExists()
    }

    @Test fun `a refused Run now reports the hub's own words`() {
        hub.route("/api/orgs/") { HubHarness.refusal("a brief is already being written for this org") }
        val vm = main.track(BriefViewModel(hub.app))
        val message = hub.expectMessage(vm.messages)
        vm.runNow("o/acme")
        val msg = message()
        assertTrue("reported \"$msg\"", msg == "✗ a brief is already being written for this org")
        // The siteKey is one path segment: its slash is escaped, not a new segment.
        val req = hub.findRequest("/daily-brief/run")
        assertEquals("POST", req.method)
        assertEquals("/api/orgs/o%2Facme/daily-brief/run", req.path)
    }
}
