package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pinch
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.click
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Meetings tab's Calendar view (XERK-2900) over the real HTTP stack: the
 * week the hub serves, the detail with the capture reviewed in place, relink,
 * stale-host notices, the per-phone switch and modes, and the two cross-links
 * with the notes review. Events sit on today's local clock, as the phone reads it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CalendarScreenTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val site = "o.atlassian.net"
    private val zone = ZoneId.systemDefault()
    private val today = LocalDate.now(zone)
    private fun t(day: LocalDate, h: Int, m: Int = 0) = day.atTime(h, m).atZone(zone).toInstant().toEpochMilli()

    private val host = """{ "key": "h1", "device": "Desk", "online": true, "lastSeen": 1,
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } }"""

    // Served text is the sender's: markup must render as the literal characters.
    private val subject = "Sync <b>with</b> Ann"

    private fun meeting(by: String = "operator") = """
        { "meetingId": "m1", "status": "ok", "title": "Meeting", "startedAt": ${t(today, 10)},
          "calendarEventId": "E1", "calendarBy": "$by",
          "calendarEvent": { "subject": "$subject", "startMs": ${t(today, 10)}, "endMs": ${t(today, 11)},
            "attendees": ["Ann", "Bo"] },
          "items": [ { "id": "p1", "kind": "task", "title": "Wire the export" },
                     { "id": "p2", "kind": "task", "title": "Write the runbook" } ] }"""

    private fun seed(online: Boolean = true) {
        val old = today.minusWeeks(3)
        val m0 = """{ "meetingId": "m0", "status": "ok", "title": "Old review", "startedAt": ${t(old, 10)},
            "calendarEventId": "E0", "calendarBy": "auto",
            "calendarEvent": { "subject": "Old review", "startMs": ${t(old, 10)}, "endMs": ${t(old, 11)} },
            "items": [ { "id": "q1", "kind": "task", "title": "Ship the old thing" } ] }"""
        hub.seedFleet("""{ "now": 1, "agents": [ $host ], "meetingProposals": { "$site": [ ${meeting()}, $m0 ] } }""")
        val tomorrow = today.plusDays(1)
        serve(online, """
                { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "E0", "source": "outlook", "subject": "Old review",
                  "startMs": ${t(old, 10)}, "endMs": ${t(old, 11)}, "busy": "busy", "myResponse": "accepted",
                  "meetings": [ { "site": "$site", "meetingId": "m0", "title": "Old review" } ] }""", """
                { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "E1", "source": "outlook", "subject": "$subject",
                  "startMs": ${t(today, 10)}, "endMs": ${t(today, 11)}, "busy": "busy", "myResponse": "accepted",
                  "location": "Room 1", "organizer": "Ann",
                  "attendees": [ { "name": "Ann", "role": "organizer", "response": "organizer" },
                                 { "name": "Bo", "role": "required", "response": "declined" } ],
                  "joinUrl": "https://teams.microsoft.com/l/abc", "body": "Agenda line",
                  "meetings": [ { "site": "$site", "meetingId": "m1", "title": "Sync" } ] },
                { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "E2", "source": "outlook", "subject": "Overlap",
                  "startMs": ${t(today, 10, 30)}, "endMs": ${t(today, 11, 30)}, "busy": "tentative", "myResponse": "tentative" },
                { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "E3", "source": "outlook", "subject": "Planning",
                  "startMs": ${t(tomorrow, 14)}, "endMs": ${t(tomorrow, 15)}, "busy": "busy", "myResponse": "accepted",
                  "joinUrl": "https://teams.microsoft.com/l/plan" }""")
        hub.json("/api/holidays", """[ { "id": "us-test", "date": "$today", "name": "Test Day", "offFor": ["$site"] } ]""")
    }

    /**
     * Serve `/api/calendar` as the hub does: only the events overlapping the
     * asked range, so a week's answer never carries another week's meeting.
     */
    private fun serve(online: Boolean, vararg events: String, hostExtra: String = "") {
        val rows = events.flatMap { TurmaJson.decodeFromString<kotlinx.serialization.json.JsonArray>("[$it]") }
            .map { it as JsonObject }
        hub.route("/api/calendar") { req ->
            val url = req.requestUrl!!
            val from = url.queryParameter("from")!!.toLong()
            val until = url.queryParameter("until")!!.toLong()
            val hit = rows.filter {
                val s = it["startMs"]!!.jsonPrimitive.content.toLong()
                val e = it["endMs"]!!.jsonPrimitive.content.toLong()
                s < until && e > from
            }
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "from": $from, "until": $until,
                  "hosts": [ { "host": "h1", "device": "Desk", "online": $online, "syncedAt": 1, "ranges": [[0, 9000000000000000]]$hostExtra } ],
                  "events": ${kotlinx.serialization.json.JsonArray(hit)} }""",
            )
        }
    }

    private fun calendarVm(view: String? = null) = main.track(CalendarViewModel(hub.app)).also { v -> view?.let { v.setView(it) } }

    private fun show(
        cvm: CalendarViewModel = calendarVm(), wide: Boolean = false, push: String? = null,
        box: androidx.compose.ui.Modifier? = null,
    ) {
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent {
            if (box == null) BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = wide, openSite = push)
            else androidx.compose.foundation.layout.Box(box) {
                BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = wide, openSite = push)
            }
        }
    }

    private fun event(text: String) = hasTestTag("cal-ev") and hasContentDescription(text, substring = true)

    private fun awaitEvent(text: String) =
        compose.waitUntil(10_000) { compose.onAllNodes(event(text)).fetchSemanticsNodes().isNotEmpty() }

    @Test fun `the calendar opens by default and draws the week the hub serves, text as text`() {
        seed()
        show()
        awaitEvent(subject)
        compose.onNodeWithTag("view-calendar").assertIsSelected()
        // The aria sentence says the org, the place and the badge; the subject's markup is literal.
        compose.onNode(event("Room 1") and hasContentDescription("2 proposals to review", substring = true)).assertExists()
        compose.onAllNodesWithTag("cal-badge", useUnmergedTree = true).fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }
        // A tentative event is drawn too, overlapping its neighbour.
        compose.onNode(event("Overlap") and hasContentDescription("tentative", substring = true)).assertExists()
        // The holiday rides the all-day band; the org's day off says so.
        compose.onNodeWithText("Test Day").assertExists()
        compose.onNodeWithText("Day off", substring = true).assertExists()
        compose.onNodeWithTag("cal-now").assertExists()
    }

    @Test fun `an event opens its detail with Outlook's details and the capture reviewed in place`() {
        seed()
        hub.json("/api/orgs/$site/meetings/m1/items/p1", """{ "ok": true }""")
        show()
        awaitEvent(subject)
        compose.onNode(event(subject)).performScrollTo().performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        compose.onNodeWithText("Room 1").assertExists()
        // The attendee list starts collapsed (XERK-2942) and opens on its toggle.
        compose.onNodeWithText("Declined").assertDoesNotExist()
        compose.onNodeWithText("Attendees (2)", substring = true).assertExists()
        compose.onNodeWithTag("cal-attendees").performScrollTo().performClick()
        compose.onNodeWithText("Declined").performScrollTo().assertExists()
        compose.onNodeWithTag("cal-join").assertExists()
        compose.onNodeWithTag("cal-desc").performScrollTo().performClick()
        compose.onNodeWithText("Agenda line").assertExists()
        compose.onNodeWithText("Wire the export").performScrollTo().assertExists()
        compose.onAllNodesWithText("Reject")[0].performScrollTo().performClick()
        val req = hub.findRequest("/meetings/m1/items/p1")
        assertEquals("reject", TurmaJson.decodeFromString<JsonObject>(req.body.readUtf8())["action"]?.jsonPrimitive?.content)
        // Back (the ✕) returns to the grid.
        compose.onNodeWithTag("cal-detail-close").performClick()
        compose.onNodeWithTag("cal-detail").assertDoesNotExist()
    }

    @Test fun `relink moves the capture to the picked same-day event`() {
        seed()
        hub.json("/api/orgs/$site/meetings/m1/calendar", """{ "ok": true, "meeting": ${meeting("operator")} }""")
        show()
        awaitEvent(subject)
        compose.onNode(event(subject)).performScrollTo().performClick()
        compose.onNodeWithTag("cal-link-auto").performScrollTo().assertExists()   // an operator's choice
        compose.onNodeWithText("Move it to another event…", substring = true).performScrollTo().performClick()
        compose.onNodeWithText("Overlap", substring = true).performClick()
        compose.onNodeWithTag("cal-link-go").performScrollTo().performClick()
        val req = hub.findRequest("/meetings/m1/calendar")
        assertEquals("""{"eventId":"E2"}""", req.body.readUtf8())
    }

    @Test fun `XERK-2954 the grid opens on 10 hours and zooms by its accessibility actions, kept per phone`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        assertEquals(10f, cvm.zoom.value)
        val grid = compose.onNodeWithTag("cal-scroll")
        val action = { label: String ->
            grid.fetchSemanticsNode().config[SemanticsActions.CustomActions].first { it.label == label }
        }
        compose.runOnUiThread { action("Zoom in").action() }
        compose.waitForIdle()
        assertEquals(8f, cvm.zoom.value)
        compose.runOnUiThread { action("Zoom out").action(); }
        compose.waitForIdle()
        compose.runOnUiThread { action("Zoom out").action(); }
        compose.waitForIdle()
        assertEquals(12f, cvm.zoom.value)
        // The whole day is the widest step: no Zoom out there.
        cvm.setZoom(24f)
        compose.waitForIdle()
        val labels = grid.fetchSemanticsNode().config[SemanticsActions.CustomActions].map { it.label }
        assertEquals(listOf("Zoom in"), labels)
        // The pick outlives the screen (kept on this phone).
        assertEquals(24f, calendarVm().zoom.value)
    }

    @Test fun `an offline host's copy shows a stale notice`() {
        seed(online = false)
        show()
        awaitEvent(subject)
        compose.onNodeWithText("Desk is offline", substring = true).assertExists()
    }

    @Test fun `a phone steps by the mode it shows and keeps the pick`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        compose.onNodeWithTag("cal-mode-DAY").assertIsSelected()
        compose.onNodeWithTag("cal-dh-$today").assertExists()
        compose.onNodeWithTag("cal-mode-THREE").performClick()
        compose.onNodeWithTag("cal-dh-${today.plusDays(2)}").assertExists()
        compose.onNodeWithTag("cal-next").performClick()
        compose.onNodeWithTag("cal-dh-${today.plusDays(3)}").assertExists()
        compose.onNodeWithTag("cal-dh-$today").assertDoesNotExist()
        compose.onNodeWithTag("cal-today").performClick()
        compose.onNodeWithTag("cal-dh-$today").assertExists()
        // The day strip jumps to a day of the week.
        val first = com.xerktech.turma.core.calWeekStart(today)
        compose.onNodeWithTag("cal-strip-$first").performClick()
        compose.onNodeWithTag("cal-dh-$first").assertExists()
        // Kept on this phone: a fresh ViewModel reads it back.
        assertEquals(com.xerktech.turma.core.CalMode.THREE, calendarVm().modes.value[false])
    }

    @Test fun `a swipe slides 3 days one day at a time (XERK-2980)`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        compose.onNodeWithTag("cal-mode-THREE").performClick()
        compose.onNodeWithTag("cal-dh-${today.plusDays(2)}").assertExists()
        compose.onNodeWithTag("cal-scroll").performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.onNodeWithTag("cal-dh-${today.plusDays(3)}").assertExists()
        compose.onNodeWithTag("cal-dh-${today.plusDays(1)}").assertExists()
        // The day slid off is drawn off-screen for the next swipe back, but untagged and silent.
        compose.onNodeWithTag("cal-dh-$today").assertDoesNotExist()
        compose.onNodeWithTag("cal-scroll").performTouchInput { swipeRight() }
        compose.waitForIdle()
        compose.onNodeWithTag("cal-dh-$today").assertExists()
        compose.onNodeWithTag("cal-dh-${today.plusDays(3)}").assertDoesNotExist()
    }

    private fun shown(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun xOf(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().first().positionInRoot.x
    private fun colW() = compose.onAllNodesWithTag("cal-col-$today").fetchSemanticsNodes().first().size.width.toFloat()

    private fun threeDays(): CalendarViewModel {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        compose.onNodeWithTag("cal-mode-THREE").performClick()
        compose.waitForIdle()
        return cvm
    }

    @Test fun `a settle slides the days to their place and never flashes the old ones (XERK-2980)`() {
        threeDays()
        val tag = "cal-dh-${today.plusDays(1)}"
        val start = xOf(tag)
        val col = colW()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("cal-scroll").performTouchInput {
            down(center)
            repeat(10) { moveBy(Offset(-col * 0.05f, 0f), delayMillis = 60) }
            up()
        }
        // Tomorrow moves left, frame by frame, from its column to the first one, never back.
        var last = xOf(tag)
        repeat(25) {
            compose.mainClock.advanceTimeByFrame()
            val x = xOf(tag)
            assertTrue("frame $it: $x after $last", x <= last + 1f)
            last = x
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(start - col, xOf(tag), 2f)
        assertTrue(shown("cal-dh-${today.plusDays(3)}"))
    }

    @Test fun `a pinch that interrupts a drag zooms and never moves the day (XERK-2980)`() {
        val cvm = threeDays()
        val col = colW()
        // On the root, so both fingers land on the visible grid (the scroll node spans 24 hours).
        compose.onRoot().performTouchInput {
            val p = Offset(width * 0.5f, height * 0.75f)
            down(0, p)
            repeat(4) { moveBy(0, Offset(-col * 0.45f / 4, 0f), delayMillis = 30) }
            down(1, p + Offset(0f, height * 0.12f))
            repeat(6) { moveBy(1, Offset(0f, 20f), delayMillis = 20) }
            up(1); up(0)
        }
        compose.waitForIdle()
        assertTrue(shown("cal-dh-$today"))
        assertTrue(!shown("cal-dh-${today.plusDays(3)}"))
        assertTrue("the pinch zoomed", cvm.zoom.value < 10f)
    }

    @Test fun `a swipe during a settle lands it and moves on again (XERK-2980)`() {
        threeDays()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("cal-scroll").performTouchInput { swipeLeft(durationMillis = 100) }
        compose.mainClock.advanceTimeBy(80)
        compose.onNodeWithTag("cal-scroll").performTouchInput { swipeLeft(durationMillis = 100) }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(shown("cal-dh-${today.plusDays(4)}"))
        assertTrue(!shown("cal-dh-${today.plusDays(1)}"))
    }

    @Test fun `a drag on an event never opens it, and off-screen days are silent (XERK-2980)`() {
        seed()
        show(calendarVm())
        awaitEvent(subject)
        // Tomorrow's Planning is drawn off-screen beside Day view, but TalkBack never reaches it.
        assertTrue(compose.onAllNodes(event("Planning")).fetchSemanticsNodes().isEmpty())
        compose.onAllNodes(event(subject))[0].performScrollTo().performTouchInput {
            down(center); repeat(4) { moveBy(Offset(-12f, 0f), delayMillis = 16) }; up()
        }
        compose.waitForIdle()
        compose.onNodeWithTag("cal-detail").assertDoesNotExist()
    }

    @Test fun `an off-screen day's all-day chips never grow the band (XERK-2980)`() {
        seed()   // today holds a holiday chip
        show(calendarVm())
        awaitEvent(subject)
        compose.onNodeWithTag("cal-next").performClick()   // tomorrow: today is off-screen to its left
        compose.waitForIdle()
        val y1 = compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().positionInRoot.y
        compose.onNodeWithTag("cal-next").performClick()   // no holiday on either side
        compose.waitForIdle()
        assertEquals(y1, compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().positionInRoot.y, 1f)
    }

    // A slow drag of [frac] of a column to the left, released: past a third, so it settles on.
    private fun dragOn(frac: Float) = compose.onNodeWithTag("cal-scroll").performTouchInput {
        down(center)
        repeat(8) { moveBy(Offset(-colW() * frac / 8, 0f), delayMillis = 60) }
        up()
    }

    @Test fun `a tap during a settle is swallowed, never opening a day still moving (XERK-2980)`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        // Just inside the visible grid's top: the scroll node spans 24 hours, so its center is off-screen.
        val top = compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().positionInRoot.y
        val at: (Float, Float) -> Offset = { w, _ -> Offset(w * 0.6f, top + 20f) }
        // At rest the same tap opens a new event, so the assertion below is not vacuous.
        compose.onRoot().performTouchInput { click(at(width.toFloat(), height.toFloat())) }
        compose.waitForIdle()
        assertTrue("a tap at rest opens the editor", cvm.editor.value != null)
        cvm.closeEditor()
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        dragOn(0.4f)
        compose.mainClock.advanceTimeByFrame()
        compose.onRoot().performTouchInput { click(at(width.toFloat(), height.toFloat())) }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue("a mid-settle tap opened ${cvm.editor.value}", cvm.editor.value == null)
        assertTrue(shown("cal-dh-${today.plusDays(1)}"))
    }

    @Test fun `a mode pick during a settle wins and lays the new mode out at rest (XERK-2980)`() {
        seed()
        show(calendarVm())
        awaitEvent(subject)
        val rest = xOf("cal-dh-$today")
        compose.mainClock.autoAdvance = false
        dragOn(0.4f)
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("cal-mode-THREE").performClick()
        repeat(20) {
            compose.mainClock.advanceTimeByFrame()
            if (shown("cal-dh-${today.plusDays(2)}")) assertEquals("frame $it", rest, xOf("cal-dh-$today"), 1f)
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(shown("cal-dh-$today") && shown("cal-dh-${today.plusDays(2)}"))
        assertTrue(!shown("cal-dh-${today.plusDays(3)}"))
        assertEquals(rest, xOf("cal-dh-$today"), 1f)
    }

    @Test fun `an arrow during a settle pages once, never adding the swipe's step (XERK-2980)`() {
        threeDays()
        compose.mainClock.autoAdvance = false
        dragOn(0.5f)
        compose.mainClock.advanceTimeBy(80)
        compose.onNodeWithTag("cal-next").performClick()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(shown("cal-dh-${today.plusDays(3)}") && shown("cal-dh-${today.plusDays(5)}"))
        assertTrue(!shown("cal-dh-${today.plusDays(6)}"))
    }

    @Test fun `back to a day a swipe left lays it out at rest (XERK-2980)`() {
        seed()
        show(calendarVm())
        awaitEvent(subject)
        val rest = xOf("cal-dh-$today")
        dragOn(0.5f)
        compose.waitForIdle()
        assertTrue(shown("cal-dh-${today.plusDays(1)}"))
        compose.onNodeWithTag("cal-prev").performClick()
        compose.waitForIdle()
        assertEquals(rest, xOf("cal-dh-$today"), 1f)
    }

    private fun scrollY() =
        compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()

    // A quick vertical flick of [dy] px on the visible grid: < 0 scrolls on, > 0 back. Aimed at
    // the viewport's middle: the scroll node spans 24 hours, and the test screen is small.
    private fun flick(dy: Float) {
        val n = compose.onNodeWithTag("cal-scroll").fetchSemanticsNode()
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.6f, n.positionInRoot.y + n.size.height / 2f))
            repeat(4) { moveBy(Offset(0f, dy / 4), delayMillis = 2) }   // all inside one frame
            up()
        }
    }

    @Test fun `a vertical fling during a settle keeps its momentum (XERK-2980)`() {
        seed()   // today's holiday chip makes its band taller than tomorrow's
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        cvm.setZoom(4f)
        compose.waitForIdle()
        // At rest a flick flings well past the finger's 40px (or to the top).
        val y0 = scrollY()
        flick(40f)
        compose.waitForIdle()
        assertTrue("at rest: ${y0 - scrollY()}", y0 - scrollY() > 120f || scrollY() == 0f)
        // Mid-settle the same flick, landing the day (and its shorter band) at its down.
        compose.mainClock.autoAdvance = false
        dragOn(0.5f)
        compose.mainClock.advanceTimeByFrame()
        val y1 = scrollY()
        flick(-40f)
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(shown("cal-dh-${today.plusDays(1)}"))
        assertTrue("mid-settle: ${scrollY() - y1}", scrollY() - y1 > 120f)
    }

    @Test fun `a pinch holds the minute under the fingers (rollup XERK-2953)`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        // The centroid sits on 10 AM, the top of the 10:00 block; a top-hold would move it.
        val top0 = compose.onAllNodes(event(subject))[0].fetchSemanticsNode().positionInRoot.y
        compose.onRoot().performTouchInput {
            val c = Offset(width * 0.6f, top0)
            pinch(c - Offset(0f, 40f), c - Offset(0f, 80f), c + Offset(0f, 40f), c + Offset(0f, 80f), durationMillis = 400)
        }
        compose.waitForIdle()
        assertTrue("the pinch zoomed in: ${cvm.zoom.value}", cvm.zoom.value < 7f)
        assertEquals(top0, compose.onAllNodes(event(subject))[0].fetchSemanticsNode().positionInRoot.y, 4f)
    }

    // A point just inside the visible grid's top, on today's empty column (events start at 10).
    private fun emptySlot(): Offset {
        val top = compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().positionInRoot.y
        val root = compose.onRoot().fetchSemanticsNode().size
        return Offset(root.width * 0.6f, top + 20f)
    }

    @Test fun `only a tap on an empty slot opens New event, never a moved touch or a long press (rollup XERK-2953)`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        val p = emptySlot()
        // Past the slop, but neither a swipe (dx under 2 dy) nor a scroll (dy under the slop).
        compose.onRoot().performTouchInput {
            val s = viewConfiguration.touchSlop
            down(p); moveBy(Offset(s * 1.5f, s * 0.9f), delayMillis = 16); up()
        }
        compose.waitForIdle()
        assertTrue("a moved touch opened ${cvm.editor.value}", cvm.editor.value == null)
        // A short horizontal drag, under the day's step.
        compose.onRoot().performTouchInput {
            down(p); repeat(4) { moveBy(Offset(-viewConfiguration.touchSlop, 0f), delayMillis = 16) }; up()
        }
        compose.waitForIdle()
        assertTrue("a short drag opened ${cvm.editor.value}", cvm.editor.value == null)
        compose.onRoot().performTouchInput { down(p); advanceEventTime(900); up() }
        compose.waitForIdle()
        assertTrue("a long press opened ${cvm.editor.value}", cvm.editor.value == null)
        // The same point tapped opens it, so none of the above is vacuous.
        compose.onRoot().performTouchInput { click(p) }
        compose.waitForIdle()
        assertTrue("a tap opens the editor", cvm.editor.value != null)
    }

    @Test fun `the last hour scrolls clear of the New event button (rollup XERK-2953)`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        serve(true, """
            { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "L1", "source": "outlook", "subject": "Late call",
              "startMs": ${t(today, 23)}, "endMs": ${t(today, 23, 59)}, "busy": "busy", "myResponse": "accepted" }""")
        hub.json("/api/holidays", "[]")
        show(calendarVm())
        awaitEvent("Late call")
        compose.onNodeWithTag("cal-scroll").performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 1e6f) }
        compose.waitForIdle()
        val ev = compose.onAllNodes(event("Late call"))[0].fetchSemanticsNode().boundsInRoot
        val fab = compose.onNodeWithTag("cal-new-event").fetchSemanticsNode().boundsInRoot
        assertTrue("block bottom ${ev.bottom} vs button top ${fab.top}", ev.bottom <= fab.top)
    }

    @Test fun `closing a detail or the editor keeps the grid where it was (rollup XERK-2953)`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        serve(true, """
            { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "L1", "source": "outlook", "subject": "Late call",
              "startMs": ${t(today, 23)}, "endMs": ${t(today, 23, 59)}, "busy": "busy", "myResponse": "accepted" }""")
        hub.json("/api/holidays", "[]")
        val cvm = calendarVm()
        show(cvm)
        awaitEvent("Late call")
        val opened = scrollY()
        compose.onNodeWithTag("cal-scroll").performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 1e6f) }
        compose.waitForIdle()
        val end = scrollY()
        assertTrue("scrolled past the 8 AM open: $opened -> $end", end > opened + 50f)
        // The detail replaces the grid on a phone; Back brings it back at the same place.
        compose.onAllNodes(event("Late call"))[0].performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        compose.onNodeWithTag("cal-detail-close").performClick()
        compose.waitForIdle()
        assertEquals(end, scrollY(), 2f)
        // So does the editor, opened by a tap on an empty slot.
        compose.onRoot().performTouchInput { click(emptySlot()) }
        compose.waitForIdle()
        assertTrue(cvm.editor.value != null)
        cvm.closeEditor()
        compose.waitForIdle()
        assertEquals(end, scrollY(), 2f)
    }

    @Test fun `a short wide pane puts New event in the toolbar, never over the grid (rollup XERK-2953)`() {
        seed()
        val cvm = calendarVm()
        show(cvm, box = androidx.compose.ui.Modifier.requiredSize(androidx.compose.ui.unit.DpSize(720.dp, 320.dp)))
        // Work week by width; today may be a weekend, so wait on the grid, not an event.
        compose.waitUntil(10_000) { shown("cal-scroll") && shown("cal-new-event") }
        val btn = compose.onNodeWithTag("cal-new-event").fetchSemanticsNode().boundsInRoot
        val grid = compose.onNodeWithTag("cal-scroll").fetchSemanticsNode().positionInRoot.y
        assertTrue("button bottom ${btn.bottom} vs grid top $grid", btn.bottom <= grid)
        // A semantics click: the 720dp box overhangs the 320dp test window.
        compose.onNodeWithTag("cal-new-event").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        assertTrue("the toolbar action opens the editor", cvm.editor.value != null)
    }

    @Test fun `the view switch is kept on this phone and a push opens the notes review`() {
        seed()
        show()
        compose.onNodeWithTag("view-notes").performClick()
        compose.onNodeWithText("Search meetings and proposals").assertExists()
        assertEquals(CalendarViewModel.VIEW_NOTES, calendarVm().view.value)
        val again = calendarVm(CalendarViewModel.VIEW_CALENDAR)
        assertEquals(CalendarViewModel.VIEW_CALENDAR, again.view.value)
    }

    @Test fun `a push opens the notes review whatever view was kept`() {
        seed()
        val cvm = calendarVm(CalendarViewModel.VIEW_CALENDAR)
        show(cvm, push = site)
        compose.waitUntil(5_000) { cvm.view.value == CalendarViewModel.VIEW_NOTES }
        compose.onNodeWithTag("view-notes").assertIsSelected()
        // Shown, not kept: the next visit still opens the operator's Calendar (web `?site=`).
        assertEquals(CalendarViewModel.VIEW_CALENDAR, calendarVm().view.value)
    }

    @Test fun `the notes review lists an upcoming meeting and Open in calendar opens it`() {
        seed()
        val cvm = calendarVm(CalendarViewModel.VIEW_NOTES)
        show(cvm)
        compose.onNodeWithText("All").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Planning").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Planning").performClick()
        compose.onNodeWithText("Its notes and proposals land here once Tenir captures the meeting.").assertExists()
        compose.onNodeWithTag("open-cal").performClick()
        compose.waitUntil(5_000) { cvm.view.value == CalendarViewModel.VIEW_CALENDAR }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("cal-detail").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithText("Planning")[0].assertExists()
    }

    @Test fun `Open in notes review selects the event's capture`() {
        seed()
        val cvm = calendarVm()
        show(cvm)
        awaitEvent(subject)
        compose.onNode(event(subject)).performScrollTo().performClick()
        compose.onNodeWithTag("cal-open-notes").performScrollTo().performClick()
        compose.waitUntil(5_000) { cvm.view.value == CalendarViewModel.VIEW_NOTES }
        // The capture opens, named by its Outlook subject, with its calendar line.
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Wire the export").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasText(subject)).fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }
        compose.onNodeWithText("Invited").assertExists()
        compose.onNodeWithText("Ann, Bo").assertExists()
    }

    @Test fun `Open in calendar reveals a capture weeks back once that week is read`() {
        seed()
        val cvm = calendarVm(CalendarViewModel.VIEW_NOTES)
        show(cvm)
        compose.onNodeWithText("All").performClick()
        compose.onNodeWithText("Search meetings and proposals").performTextInput("Ship the old")
        compose.onNodeWithText("Old review").performClick()
        compose.onNodeWithTag("open-cal").performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("cal-detail").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Ship the old thing").performScrollTo().assertExists()
        compose.onNodeWithTag("cal-dh-${today.minusWeeks(3)}").assertDoesNotExist()   // the phone shows the detail
        compose.onNodeWithTag("cal-detail-close").performClick()
        compose.onNodeWithTag("cal-dh-${today.minusWeeks(3)}").assertExists()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w700dp-h900dp")
    fun `an unfolded foldable or portrait tablet gets the week, and the detail full screen`() {
        // Medium width: the app's `wide` (Expanded) is false, the calendar still shows weeks.
        seed()
        show(wide = false)
        compose.onNodeWithTag("cal-mode-WORK").assertIsSelected()
        compose.onNodeWithTag("cal-mode-DAY").assertDoesNotExist()
        compose.onNodeWithTag("cal-mode-WEEK").performClick()
        awaitEvent(subject)
        compose.onNodeWithTag("cal-dh-${com.xerktech.turma.core.calWeekStart(today)}").assertExists()
        compose.onNodeWithTag("cal-dh-${com.xerktech.turma.core.calWeekStart(today).plusDays(6)}").assertExists()
        // Too narrow for the grid and a 400dp panel side by side: the detail takes the screen.
        compose.onNode(event(subject)).performScrollTo().performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        compose.onNodeWithTag("cal-range").assertDoesNotExist()
        // The week pick is kept apart from a phone's Day / 3 days.
        assertEquals(com.xerktech.turma.core.CalMode.WEEK, calendarVm().modes.value[true])
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    fun `a wide screen opens on the Work week and shows the detail beside the grid`() {
        seed()
        show(wide = true)
        compose.onNodeWithTag("cal-mode-WORK").assertIsSelected()
        // Week, so today's events show on a weekend run too.
        compose.onNodeWithTag("cal-mode-WEEK").performClick()
        awaitEvent(subject)
        compose.onNode(event(subject)).performScrollTo().performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        // The grid stays beside it.
        compose.onNodeWithTag("cal-range").assertExists()
        compose.onNode(event("Overlap")).assertExists()
    }

    // ---- Calendar settings (XERK-2929) -----------------------------------------------------

    private val settingsRow = """, "org": "$site", "showPrivate": false"""

    /** One Outlook event today on h1, with the host's settings row; [extra] adds event fields. */
    private fun seedSettings(extra: String = "") {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        serve(true, """
            { "host": "h1", "org": "$site", "id": "E9", "seriesId": "S9", "source": "outlook", "subject": "Weekly sync",
              "startMs": ${t(today, 10)}, "endMs": ${t(today, 11)}, "busy": "busy", "myResponse": "accepted"$extra }""",
            hostExtra = settingsRow)
        hub.json("/api/holidays", "[]")
    }

    private fun settingsBody(): String = hub.findRequest("/api/agents/h1/calendar/settings").body.readUtf8()

    private fun awaitEnabled(tag: String) = compose.waitUntil(10_000) {
        compose.onAllNodes(hasTestTag(tag) and androidx.compose.ui.test.isEnabled()).fetchSemanticsNodes().isNotEmpty()
    }

    @Test fun `the calendar's settings name each host's org and save only private events`() {
        seedSettings()
        hub.json("/api/agents/h1/calendar/settings", """{ "ok": true, "settings": {} }""")
        show()
        awaitEvent("Weekly sync")
        compose.onNodeWithTag("cal-settings").performClick()
        // XERK-2964: the org is the host's, shown as text; there is no Default org pick.
        compose.onNodeWithTag("cal-host-org-h1").assertTextEquals("o")
        compose.onNodeWithText("Default org").assertDoesNotExist()

        compose.onNodeWithTag("cal-host-private-h1").performClick()
        assertEquals("""{"showPrivate":true}""", settingsBody())
    }

    @Test fun `an event's org is shown as text, never picked`() {
        seedSettings(""", "recurring": true """)
        show()
        awaitEvent("Weekly sync")
        compose.onNode(event("Weekly sync")).performScrollTo().performClick()
        compose.onNodeWithText("Part of a recurring series").assertExists()
        compose.onNodeWithTag("cal-series-org").assertDoesNotExist()
        compose.onNodeWithText("for the whole series").assertDoesNotExist()
        compose.onNodeWithText("Automatic", substring = true).assertDoesNotExist()
    }
    // XERK-3024: on a 640dp-tall phone the default 10 hours give a 15-minute meeting less than its
    // one title line, which was clipped. The block grows to hold the line, at any font scale.
    @Test
    @Config(sdk = [35], qualifiers = "w360dp-h640dp")
    fun `a 15-minute meeting's block holds its whole title line on a small phone (XERK-3024)`() = shortBlockHoldsItsLine()

    @Test
    @Config(sdk = [35], qualifiers = "w360dp-h640dp", fontScale = 1.3f)
    fun `a 15-minute meeting's title line is whole at a large font too (XERK-3024)`() = shortBlockHoldsItsLine()

    private fun shortBlockHoldsItsLine() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ], "meetingProposals": { "$site": [ ${meeting()} ] } }""")
        serve(true, """
            { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "Q1", "source": "outlook", "subject": "Standup",
              "startMs": ${t(today, 9)}, "endMs": ${t(today, 9, 15)}, "busy": "busy", "myResponse": "accepted" }""")
        hub.json("/api/holidays", "[]")
        val cvm = calendarVm()
        show(cvm)
        awaitEvent("Standup")
        assertEquals(10f, cvm.zoom.value)
        val node = compose.onNode(event("Standup")).fetchSemanticsNode()
        val line = with(node.layoutInfo.density) { 12.sp.toPx() }
        val room = with(node.layoutInfo.density) { 2.dp.toPx() }   // the line plus a 1dp margin each side
        assertTrue("block ${node.size.height}px < title line ${line}px + ${room}px", node.size.height >= line + room)
    }
}
