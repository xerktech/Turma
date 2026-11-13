package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Brief tab's Daily brief, folded into each org's daily-meeting entry
 * (XERK-2858), and the per-org settings panel. Times are relative to the
 * real clock: the screen reads it, as the phone does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BriefScreenTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val site = "o.atlassian.net"
    private val host = """{ "key": "h1", "device": "h1", "online": true, "lastSeen": 1,
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } }"""
    private val now = System.currentTimeMillis()
    private val yday = now - 86_400_000L

    // Every day at 23:59 UTC, so the next meeting is always still ahead today or tomorrow.
    private val schedule = """{ "enabled": true, "time": "23:59", "timeZone": "UTC",
        "weekdays": [0,1,2,3,4,5,6], "leadMinutes": 5, "meetingTitle": "standup" }"""

    private fun seed(briefs: String = "", meetings: String = "") = hub.seedFleet("""
        { "now": 1, "agents": [ $host ],
          "dailyBriefSchedules": { "$site": $schedule },
          "dailyBriefs": { "$site": [ $briefs ] },
          "meetingProposals": { "$site": [ $meetings ] } }
    """.trimIndent())

    private fun show(vm: BriefViewModel = main.track(BriefViewModel(hub.app)),
                     mvm: MeetingsViewModel = main.track(MeetingsViewModel(hub.app))) =
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm) }

    private fun open(text: String) {
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(text, substring = true))
        compose.onAllNodesWithText(text, substring = true)[0].performClick()
    }

    @Test fun `the upcoming daily meeting is an entry with its brief and Run now`() {
        seed()
        show()
        compose.onNodeWithText("Daily meeting").assertExists()
        open("Daily meeting")
        compose.onNodeWithText("Run now").assertExists()
        compose.onNodeWithText("No brief yet. It is written before the meeting, or Run now writes one.").assertExists()
    }

    @Test fun `a past daily meeting pairs its brief with the captured meeting's proposals`() {
        seed(
            briefs = """{ "runId": "b1", "status": "ok", "meetingAt": $yday, "day": "Two tickets shipped.",
                "week": "Five this week.", "next": "XERK-9 is next." }""",
            meetings = """{ "meetingId": "m1", "status": "ok", "title": "Team standup", "startedAt": ${yday + 60_000},
                "daily": { "meetingAt": $yday, "briefRunId": "b1" },
                "items": [ { "id": "p1", "kind": "task", "title": "Wire the export" } ] }""",
        )
        show()
        open("Daily meeting · Team standup")
        compose.onNodeWithText("Since yesterday").assertExists()
        compose.onNodeWithText("Two tickets shipped.").assertExists()
        compose.onNodeWithText("XERK-9 is next.").performScrollTo().assertExists()
        compose.onNodeWithText("Wire the export").performScrollTo().assertExists()
        // A past meeting's brief is history: Run now writes the NEXT one.
        compose.onNodeWithText("Run now").assertDoesNotExist()
        // One entry, not a brief entry and a meeting entry.
        compose.onNodeWithText("‹ Back").performClick()
        compose.onNodeWithText("All").performClick()
        compose.onAllNodesWithText("Team standup", substring = true).assertCountEquals(1)
    }

    @Test fun `Run now is off while a brief is being written`() {
        seed(briefs = """{ "runId": "r", "status": "running", "meetingAt": ${now + 3_600_000} }""")
        show()
        open("Daily meeting")
        compose.onNodeWithText("Writing…").assertIsNotEnabled()
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

    private fun bodyOf(path: String): JsonObject =
        TurmaJson.parseToJsonElement(hub.findRequest(path).body.readUtf8()).jsonObject

    @Test fun `the settings panel saves whose work, the Tenir label and the schedule`() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "ENG", "name": "Engineering" } ] }""")
        hub.json("/api/orgs/$site/meeting-focus", """{ "ok": true }""")
        hub.json("/api/orgs/$site/meeting-label", """{ "ok": true }""")
        hub.json("/api/orgs/$site/daily-brief/schedule", """{ "ok": true }""")
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ], "dailyBriefSchedules": { "$site": $schedule },
              "meetingLabels": { "$site": { "label": "acme", "custom": true } },
              "meetingFocus": { "$site": { "names": ["Lee, Ann"], "role": "backend" } } }
        """.trimIndent())
        val mvm = main.track(MeetingsViewModel(hub.app))
        show(mvm = mvm)
        compose.onNodeWithContentDescription("o settings").performClick()
        compose.onNodeWithText("Tenir sends this org's meetings as \"acme\".").performScrollTo().assertExists()

        // A name with a comma survives: one name per line.
        compose.onNodeWithText("Lee, Ann").performTextInput("\nMalcolm H.")
        compose.onAllNodesWithText("Save")[0].performScrollTo().performClick()
        val f = bodyOf("/meeting-focus")
        assertEquals("""["Lee, Ann","Malcolm H."]""", f["names"].toString())
        assertEquals("\"backend\"", f["role"].toString())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Saved").fetchSemanticsNodes().isNotEmpty() }

        // A blank label goes back to the default: an explicit null on the wire.
        compose.onNodeWithText("acme").performScrollTo().performTextClearance()
        compose.onAllNodesWithText("Save")[1].performScrollTo().performClick()
        assertEquals("""{"label":null}""", hub.findRequest("/meeting-label").body.readUtf8())

        compose.onNodeWithText("standup").performScrollTo().performTextClearance()
        compose.onNodeWithText("standup").assertDoesNotExist()
        compose.onAllNodesWithText("Daily meeting title contains")[0].performTextInput("Daily sync")
        compose.onAllNodesWithText("Save")[2].performScrollTo().performClick()
        val s = bodyOf("/daily-brief/schedule")
        assertEquals("\"Daily sync\"", s["meetingTitle"].toString())
        assertEquals("\"23:59\"", s["time"].toString())
        assertEquals("[0,1,2,3,4,5,6]", s["weekdays"].toString())
        assertEquals("PUT", hub.findRequest("/daily-brief/schedule").method)
    }

    @Test fun `a refused save reports the hub's words`() {
        hub.route("/api/orgs/$site/meeting-label") { HubHarness.refusal("the org acme already has the meeting label \"x\"") }
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        val mvm = main.track(MeetingsViewModel(hub.app))
        val message = hub.expectMessage(mvm.messages)
        mvm.saveLabel(site, "x")
        assertEquals("✗ Saving the Tenir label failed — the org acme already has the meeting label \"x\"", message())
        assertTrue(mvm.saved.value.isEmpty())
    }
}
