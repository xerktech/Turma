package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsSelected
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
                  "startMs": ${t(tomorrow, 14)}, "endMs": ${t(tomorrow, 15)}, "busy": "busy", "myResponse": "accepted" }""")
        hub.json("/api/holidays", """[ { "id": "us-test", "date": "$today", "name": "Test Day", "offFor": ["$site"] } ]""")
    }

    /**
     * Serve `/api/calendar` as the hub does: only the events overlapping the
     * asked range, so a week's answer never carries another week's meeting.
     */
    private fun serve(online: Boolean, vararg events: String) {
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
                  "hosts": [ { "host": "h1", "device": "Desk", "online": $online, "syncedAt": 1, "ranges": [[0, 9000000000000000]] } ],
                  "events": ${kotlinx.serialization.json.JsonArray(hit)} }""",
            )
        }
    }

    private fun calendarVm(view: String? = null) = main.track(CalendarViewModel(hub.app)).also { v -> view?.let { v.setView(it) } }

    private fun show(cvm: CalendarViewModel = calendarVm(), wide: Boolean = false, push: String? = null) {
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = wide, openSite = push) }
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
        val monday = com.xerktech.turma.core.calWeekStart(today)
        compose.onNodeWithTag("cal-strip-$monday").performClick()
        compose.onNodeWithTag("cal-dh-$monday").assertExists()
        // Kept on this phone: a fresh ViewModel reads it back.
        assertEquals(com.xerktech.turma.core.CalMode.THREE, calendarVm().modes.value[false])
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
}
