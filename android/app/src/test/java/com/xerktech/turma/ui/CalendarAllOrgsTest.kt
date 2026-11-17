package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * XERK-3031: the calendar shows every org whatever the header's site-wide org pick — the
 * read carries no `org=`, every org's day off shows, and New event never pre-fills the pick.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CalendarAllOrgsTest {
    @get:Rule(order = 0) val main = MainDispatcherRule()
    @get:Rule(order = 1) val hub = HubHarness()
    @get:Rule(order = 2) val compose = createAndroidComposeRule<ComponentActivity>()

    private val a = "a.atlassian.net"
    private val b = "b.atlassian.net"
    private val zone = ZoneId.systemDefault()
    private val today = LocalDate.now(zone)
    private fun t(day: LocalDate, h: Int) = day.atTime(h, 0).atZone(zone).toInstant().toEpochMilli()
    private fun host(k: String, site: String, name: String) = """{ "key": "$k", "device": "D$k", "online": true, "lastSeen": 1,
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "orgName": "$name", "tickets": [] } }"""
    private val queries = java.util.Collections.synchronizedList(mutableListOf<String>())

    /** Two orgs (Zed = a, Alpha = b), one meeting each today; today is Alpha's day off. */
    private fun seed(twoOrgs: Boolean = true) {
        val hosts = if (twoOrgs) "${host("h1", a, "Zed")}, ${host("h2", b, "Alpha")}" else host("h2", b, "Alpha")
        hub.seedFleet("""{ "now": 1, "agents": [ $hosts ] }""")
        val ev = { id: String, org: String, s: String, h: Int -> """{ "host": "h1", "org": "$org", "matchOrg": "$org", "id": "$id",
            "source": "outlook", "subject": "$s", "startMs": ${t(today, h)}, "endMs": ${t(today, h + 1)}, "busy": "busy",
            "myResponse": "accepted" }""" }
        val rows = listOf(ev("EA", a, "Zed meeting", 10), ev("EB", b, "Alpha meeting", 13))
        hub.route("/api/calendar") { req ->
            val url = req.requestUrl!!
            queries.add(url.encodedQuery ?: "")
            val org = url.queryParameter("org")
            val from = url.queryParameter("from")!!.toLong()
            val until = url.queryParameter("until")!!.toLong()
            val hit = rows.filter { r -> (org == null || org.split(",").any { r.contains("\"org\": \"$it\"") }) &&
                t(today, 10) < until && t(today, 14) > from }
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "from": $from, "until": $until, "hosts": [ { "host": "h1", "device": "Dh1", "online": true, "syncedAt": 1,
                  "ranges": [[0, 9000000000000000]] } ], "events": [ ${hit.joinToString(",")} ] }""")
        }
        hub.json("/api/holidays", """[ { "id": "us-test", "date": "$today", "name": "Test Day", "offFor": ["$b"] } ]""")
    }

    private fun await(text: String) = compose.waitUntil(10_000) {
        compose.onAllNodes(hasTestTag("cal-ev") and hasContentDescription(text, substring = true)).fetchSemanticsNodes().isNotEmpty()
    }

    private fun show(): CalendarViewModel {
        val cvm = main.track(CalendarViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm) }
        return cvm
    }

    @Test fun `a header pick of one org still shows every org's events and days off, unscoped`() {
        seed()
        hub.container.org.set(setOf(a))
        show()
        await("Zed meeting"); await("Alpha meeting")
        compose.onAllNodesWithText("Day off · Alpha", substring = true).fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }
        assertTrue("org= on a read: $queries", queries.isNotEmpty() && queries.none { it.contains("org=") })
    }

    @Test fun `changing the header pick live keeps both orgs and unscoped reads`() {
        seed()
        hub.container.org.set(setOf(a))
        show()
        await("Alpha meeting")
        hub.container.org.set(setOf(b)); compose.waitForIdle()
        hub.container.org.set(setOf("gone.atlassian.net")); compose.waitForIdle()
        await("Zed meeting"); await("Alpha meeting")
        assertTrue("org= on a read: $queries", queries.none { it.contains("org=") })
    }

    @Test fun `New event never pre-fills the header pick`() {
        seed()
        hub.container.org.set(setOf(a))
        val cvm = show()
        await("Zed meeting")
        compose.onAllNodesWithTag("cal-new-event")[0].performClick()
        compose.waitUntil(5_000) { cvm.editor.value != null }
        assertEquals(emptySet<String>(), cvm.editor.value!!.draft.orgs.toSet())
    }

    @Test fun `a one-org fleet's day off is a bare Day off`() {
        seed(twoOrgs = false)
        show()
        await("Alpha meeting")
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Day off").fetchSemanticsNodes().isNotEmpty() }
        assertTrue(compose.onAllNodesWithText("Day off · ", substring = true).fetchSemanticsNodes().isEmpty())
    }
}
