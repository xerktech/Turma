package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
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
                     mvm: MeetingsViewModel = main.track(MeetingsViewModel(hub.app)),
                     wide: Boolean = false) =
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, wide = wide) }

    private fun open(text: String) {
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(text, substring = true))
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
        compose.onNodeWithText("All").performClick()
        compose.onNodeWithText("Search meetings and proposals").performTextInput("Team standup")
        open("Daily meeting")
        compose.onNodeWithText("Team standup").assertExists()
        compose.onNodeWithText("Since yesterday").assertExists()
        compose.onNodeWithText("Two tickets shipped.").assertExists()
        compose.onNodeWithText("XERK-9 is next.").performScrollTo().assertExists()
        compose.onNodeWithText("Wire the export").performScrollTo().assertExists()
        // A past meeting's brief is history: Run now writes the NEXT one.
        compose.onNodeWithText("Run now").assertDoesNotExist()
        // One entry, not a brief entry and a meeting entry: the search for the
        // meeting's title lists the daily entry alone.
        compose.onNodeWithText("‹ Back").performClick()
        compose.onAllNodesWithText("Daily meeting").assertCountEquals(1)
    }

    // XERK-2878: a tablet / unfolded foldable shows the list and the open entry
    // side by side, as the web's rail + main pane and the Sessions tab do.
    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide shows the list beside the first entry, and a pick swaps only the entry`() {
        seed(
            meetings = """{ "meetingId": "m1", "status": "ok", "title": "Design review", "startedAt": $yday,
                "items": [ { "id": "p1", "kind": "task", "title": "Wire the export" } ] }""",
        )
        show(wide = true)
        // Nothing picked: the first entry (the upcoming daily meeting) is open beside the list.
        compose.onNodeWithText("Search meetings and proposals").assertExists()
        compose.onNodeWithText("Run now").assertExists()
        compose.onNodeWithText("‹ Back").assertDoesNotExist()
        open("Design review")
        // The entry pane swapped; the list (and its other entry) stayed.
        compose.onNodeWithText("Wire the export").assertExists()
        compose.onNodeWithText("Run now").assertDoesNotExist()
        compose.onNodeWithText("Daily meeting").assertExists()
        compose.onNodeWithText("Search meetings and proposals").assertExists()
    }

    private fun hostOf(key: String, site: String, name: String = "") = """{ "key": "$key", "device": "$key",
        "online": true, "lastSeen": 1, "jira": { "available": true, "siteKey": "$site", "site": "$site",
        "orgName": "$name", "tickets": [] } }"""

    private fun meeting(id: String, title: String, review: String = "", archived: Boolean = false) =
        """{ "meetingId": "$id", "status": "ok", "title": "$title", "startedAt": $yday, "archivedAt": ${if (archived) 5 else 0},
            "items": [ { "id": "p1", "kind": "task", "title": "Item of $title" $review } ] }"""

    private val wideOpen = hasText("Design review", substring = true) and isSelected()

    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide marks the open entry and keeps it listed once its last proposal is answered`() {
        seed(meetings = meeting("m1", "Design review"))
        show(wide = true)
        compose.onNode(hasText("Daily meeting") and isSelected()).assertExists()
        open("Design review")
        compose.onNode(wideOpen).assertExists()
        // Its last proposal answered: Needs review would drop it, but not from under the pointer.
        seed(meetings = meeting("m1", "Design review", review = """, "review": { "state": "rejected", "at": 5 }"""))
        compose.waitForIdle()
        compose.onNode(wideOpen).assertExists()
        compose.onNodeWithText("Item of Design review").assertDoesNotExist()
    }

    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide moves off an entry archived away and does not jump back when it returns`() {
        seed(meetings = meeting("m1", "Design review"))
        show(wide = true)
        open("Design review")
        compose.onNodeWithText("Item of Design review").assertExists()
        seed(meetings = meeting("m1", "Design review", archived = true))
        compose.waitForIdle()
        compose.onNodeWithText("Run now").assertExists()
        compose.onNodeWithText("Item of Design review").assertDoesNotExist()
        seed(meetings = meeting("m1", "Design review"))
        compose.waitForIdle()
        compose.onNodeWithText("Run now").assertExists()
        compose.onNode(hasText("Daily meeting") and isSelected()).assertExists()
    }

    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide skips a collapsed org's entries`() {
        seed()
        show(wide = true)
        compose.onNodeWithText("Run now").assertExists()
        compose.onNodeWithContentDescription("Collapse o").performClick()
        compose.onNodeWithText("Run now").assertDoesNotExist()
        compose.onNodeWithText(
            "Nothing needs review. When Tenir sends a meeting, its proposed work items show up here.").assertExists()
    }

    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide orders orgs by name and a meetings push opens the pushed org's entry`() {
        // "Zed" sorts first by site key, "Alpha" first by name: the web's rail goes by name.
        hub.seedFleet("""
            { "now": 1, "agents": [ ${hostOf("h1", "a.atlassian.net", "Zed")}, ${hostOf("h2", "b.atlassian.net", "Alpha")} ],
              "meetingProposals": { "a.atlassian.net": [ ${meeting("m1", "Zed sync")} ],
                                    "b.atlassian.net": [ ${meeting("m2", "Alpha sync")} ] } }
        """.trimIndent())
        var push by mutableStateOf<String?>(null)
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, wide = true, openSite = push, onOpened = { push = null }) }
        compose.onNodeWithText("Item of Alpha sync").assertExists()
        push = "a.atlassian.net"
        compose.waitForIdle()
        compose.onNodeWithText("Item of Zed sync").assertExists()
        compose.onNode(hasText("Zed sync", substring = true) and isSelected()).assertExists()
    }

    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide system Back closes an org's settings`() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        seed()
        show(wide = true)
        compose.onNodeWithContentDescription("o settings").performClick()
        compose.onNodeWithText("o · settings").assertExists()
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("o · settings").assertDoesNotExist()
        compose.onNodeWithText("Run now").assertExists()
    }

    @Test fun `narrow still shows one pane at a time`() {
        seed()
        show()
        compose.onNodeWithText("Run now").assertDoesNotExist()
        open("Daily meeting")
        compose.onNodeWithText("Run now").assertExists()
        compose.onNodeWithText("Search meetings and proposals").assertDoesNotExist()
        compose.onNodeWithText("‹ Back").performClick()
        compose.onNodeWithText("Search meetings and proposals").assertExists()
    }

    @Config(sdk = [35], qualifiers = "w1000dp-h800dp")
    @Test fun `wide opens an org's settings in the entry pane and Back closes them`() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        seed()
        show(wide = true)
        compose.onNodeWithContentDescription("o settings").performClick()
        compose.onNodeWithText("o · settings").assertExists()
        compose.onNodeWithText("Search meetings and proposals").assertExists()
        compose.onNodeWithText("‹ Back").performClick()
        compose.onNodeWithText("Run now").assertExists()
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
        compose.onNodeWithText("Lee, Ann").performTextReplacement("Lee, Ann\nMalcolm H.")
        compose.onNodeWithTag("save-focus").performScrollTo().performClick()
        val f = bodyOf("/meeting-focus")
        assertEquals("""["Lee, Ann","Malcolm H."]""", f["names"].toString())
        assertEquals("\"backend\"", f["role"].toString())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Saved").fetchSemanticsNodes().isNotEmpty() }

        // A blank label goes back to the default: an explicit null on the wire.
        compose.onNodeWithText("acme").performScrollTo().performTextClearance()
        compose.onNodeWithTag("save-label").performScrollTo().performClick()
        assertEquals("""{"label":null}""", hub.findRequest("/meeting-label").body.readUtf8())

        compose.onNodeWithText("standup").performScrollTo().performTextClearance()
        compose.onNodeWithText("standup").assertDoesNotExist()
        compose.onAllNodesWithText("Daily meeting title contains")[0].performTextInput("Daily sync")
        compose.onNodeWithTag("save-schedule").performScrollTo().performClick()
        val req = hub.findRequest("/daily-brief/schedule")
        assertEquals("PUT", req.method)
        val s = TurmaJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("\"Daily sync\"", s["meetingTitle"].toString())
        assertEquals("\"23:59\"", s["time"].toString())
        assertEquals("[0,1,2,3,4,5,6]", s["weekdays"].toString())
    }

    @Test fun `a refused save reports the hub's words`() {
        hub.route("/api/orgs/$site/meeting-label") { HubHarness.refusal("the org acme already has that meeting label") }
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        val mvm = main.track(MeetingsViewModel(hub.app))
        val message = hub.expectMessage(mvm.messages)
        mvm.saveLabel(site, "x")
        assertEquals("✗ Saving the Tenir label failed — the org acme already has that meeting label", message())
        assertTrue(mvm.saved.value.isEmpty())
    }

    @Test fun `a settings field follows the hub until edited, and again once saved`() {
        // XERK-2858 QA: an edit survives a change made elsewhere, an untouched
        // field follows it, and a save the hub rewrote ("0930" -> "09:30") must
        // not pin the field to the typed text and overwrite a later change.
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        // The hub answers with the schedule as it stored it.
        hub.json("/api/orgs/$site/daily-brief/schedule", """{ "ok": true, "schedule": { "enabled": true,
            "time": "23:00", "timeZone": "UTC", "weekdays": [0,1,2,3,4,5,6], "leadMinutes": 5,
            "meetingTitle": "standup" } }""")
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ], "dailyBriefSchedules": { "$site": $schedule },
              "meetingFocus": { "$site": { "names": ["Ann"], "role": "dev" } } }
        """.trimIndent())
        val fleet = hub.container.fleet
        show(mvm = main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithContentDescription("o settings").performClick()

        compose.onNodeWithText("Ann").performTextReplacement("Zed Draft")
        fleet.onSseEvent("meetingFocus", """{ "$site": { "names": ["Bo"], "role": "PM" } }""")
        compose.waitUntil(5_000) { compose.onAllNodesWithText("PM").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Zed Draft").assertExists() // edited: kept
        compose.onNodeWithText("Bo").assertDoesNotExist()

        compose.onNodeWithText("23:59").performScrollTo().performTextReplacement("2300")
        compose.onNodeWithTag("save-schedule").performScrollTo().performClick()
        assertEquals("\"23:00\"", TurmaJson.parseToJsonElement(
            hub.findRequest("/daily-brief/schedule").body.readUtf8()).jsonObject["time"].toString())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("23:00").fetchSemanticsNodes().isNotEmpty() }
        // Another client sets 10:00: the hub serves it from now on, so a poll the
        // save nudged (possibly still answering the old fixture) settles on it.
        hub.json("/api/agents", """
            { "now": 2, "agents": [ $host ], "dailyBriefSchedules": { "$site": { "enabled": true,
              "time": "10:00", "timeZone": "UTC", "weekdays": [1], "leadMinutes": 5 } } }
        """.trimIndent())
        fleet.onSseEvent("dailyBriefSchedules", """{ "$site": { "enabled": true, "time": "10:00",
            "timeZone": "UTC", "weekdays": [1], "leadMinutes": 5 } }""")
        compose.waitUntil(15_000) { compose.onAllNodesWithText("10:00").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun `a save shows the values as the hub stored them, keeping text typed while it was in flight`() {
        // XERK-2858 QA: the stored form comes from the hub's own answer (it
        // trims and case-corrects), and a field typed into while the save was in
        // flight keeps the new text instead of being replaced.
        val release = java.util.concurrent.CountDownLatch(1)
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        hub.json("/api/orgs/$site/meeting-focus",
            """{ "ok": true, "focus": { "names": ["Ann"], "role": "Dev" } }""")
        hub.route("/api/orgs/$site/daily-brief/schedule") {
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "ok": true, "schedule": { "enabled": true, "time": "08:00", "timeZone": "America/New_York",
                    "weekdays": [1,2,3,4,5,6,0], "leadMinutes": 5, "meetingTitle": "standup" } }""")
        }
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ], "dailyBriefSchedules": { "$site": $schedule } }
        """.trimIndent())
        val mvm = main.track(MeetingsViewModel(hub.app))
        show(mvm = mvm)
        compose.onNodeWithContentDescription("o settings").performClick()

        compose.onNodeWithText("Names, one per line").performTextReplacement("Ann ")
        compose.onNodeWithText("Role (optional)").performTextReplacement("Dev  ")
        compose.onNodeWithTag("save-focus").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Dev").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Ann").assertExists()

        compose.onNodeWithText("UTC").performScrollTo().performTextReplacement("america/new_york")
        compose.onNodeWithText("23:59").performScrollTo().performTextReplacement("0800")
        compose.onNodeWithTag("save-schedule").performScrollTo().performClick()
        compose.waitUntil(5_000) { mvm.saving.value.isNotEmpty() }
        compose.onNodeWithText("0800").performTextReplacement("0700") // typed while in flight
        release.countDown()
        compose.waitUntil(10_000) { mvm.saving.value.isEmpty() }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("America/New_York").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("0700").assertExists()
        compose.onNodeWithText("08:00").assertDoesNotExist()
        // The field holds text the hub has not seen, so the section is not "Saved".
        compose.onNodeWithTag("save-schedule").performScrollTo()
        compose.onAllNodesWithText("Saved").assertCountEquals(1) // the focus section's only
    }

    @Test fun `a label save shows the label as the hub stored it`() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        hub.json("/api/orgs/$site/meeting-label", """{ "ok": true, "label": "qa-team", "custom": true }""")
        hub.seedFleet("""{ "now": 1, "agents": [ $host ], "meetingLabels": { "$site": { "label": "o", "custom": false } } }""")
        show(mvm = main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithContentDescription("o settings").performClick()
        compose.onNodeWithText("Label (blank = default)").performScrollTo().performTextReplacement("  QA-Team ")
        compose.onNodeWithTag("save-label").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("qa-team").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Saved").assertExists()
    }

    @Test fun `a rotation while a save is in flight still marks the field clean`() {
        // XERK-2858 QA: what a field sent must survive a rotation, or the answer
        // leaves it "edited" for good and a later save overwrites other clients.
        val release = java.util.concurrent.CountDownLatch(1)
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        hub.route("/api/orgs/$site/daily-brief/schedule") {
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "ok": true, "schedule": { "enabled": true, "time": "10:15", "timeZone": "UTC",
                    "weekdays": [0,1,2,3,4,5,6], "leadMinutes": 5, "meetingTitle": "standup" } }""")
        }
        hub.seedFleet("""{ "now": 1, "agents": [ $host ], "dailyBriefSchedules": { "$site": $schedule } }""")
        val mvm = main.track(MeetingsViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val restore = androidx.compose.ui.test.junit4.StateRestorationTester(compose)
        restore.setContent { BriefScreen(vm = vm, meetingsVm = mvm) }
        compose.onNodeWithContentDescription("o settings").performClick()
        compose.onNodeWithText("23:59").performScrollTo().performTextReplacement("1015")
        compose.onNodeWithTag("save-schedule").performScrollTo().performClick()
        compose.waitUntil(5_000) { mvm.saving.value.isNotEmpty() }
        restore.emulateSavedInstanceStateRestore()
        release.countDown()
        compose.waitUntil(10_000) { mvm.saving.value.isEmpty() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("10:15").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun `a rotation mid-save after an earlier save keeps the typed text`() {
        // XERK-2858 QA: a rotation replays the PREVIOUS save's answer; taking it
        // as this save's put the old value back, and a failed save lost the text.
        val release = java.util.concurrent.CountDownLatch(1)
        val calls = java.util.concurrent.atomic.AtomicInteger(0)
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        hub.route("/api/orgs/$site/daily-brief/schedule") {
            if (calls.incrementAndGet() == 1) {
                okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                    """{ "ok": true, "schedule": { "enabled": true, "time": "08:00", "timeZone": "UTC",
                        "weekdays": [0,1,2,3,4,5,6], "leadMinutes": 5, "meetingTitle": "standup" } }""")
            } else {
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
                HubHarness.refusal("time must be HH:MM on a 24-hour clock", 400)
            }
        }
        hub.seedFleet("""{ "now": 1, "agents": [ $host ], "dailyBriefSchedules": { "$site": $schedule } }""")
        val mvm = main.track(MeetingsViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val restore = androidx.compose.ui.test.junit4.StateRestorationTester(compose)
        restore.setContent { BriefScreen(vm = vm, meetingsVm = mvm) }
        compose.onNodeWithContentDescription("o settings").performClick()
        compose.onNodeWithText("23:59").performScrollTo().performTextReplacement("0800")
        compose.onNodeWithTag("save-schedule").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("08:00").fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(5_000) { mvm.saving.value.isEmpty() }
        compose.onNodeWithText("08:00").performScrollTo().performTextReplacement("1015")
        compose.onNodeWithTag("save-schedule").performScrollTo().performClick()
        compose.waitUntil(5_000) { mvm.saving.value.isNotEmpty() }
        restore.emulateSavedInstanceStateRestore()
        compose.waitForIdle()
        compose.onAllNodesWithText("1015").assertCountEquals(1)
        release.countDown()
        compose.waitUntil(10_000) { mvm.saving.value.isEmpty() }
        compose.waitForIdle()
        compose.onAllNodesWithText("1015").assertCountEquals(1)
    }

    @Test fun `whose work and the label are not Saved beside text typed mid-save`() {
        val focusGate = java.util.concurrent.CountDownLatch(1)
        val labelGate = java.util.concurrent.CountDownLatch(1)
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        hub.route("/api/orgs/$site/meeting-focus") {
            focusGate.await(10, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{ "ok": true, "focus": { "names": [], "role": "lead" } }""")
        }
        hub.route("/api/orgs/$site/meeting-label") {
            labelGate.await(10, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{ "ok": true, "label": "acmeq", "custom": true }""")
        }
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        val mvm = main.track(MeetingsViewModel(hub.app))
        show(mvm = mvm)
        compose.onNodeWithContentDescription("o settings").performClick()

        compose.onNodeWithText("Role (optional)").performTextReplacement("lead")
        compose.onNodeWithTag("save-focus").performScrollTo().performClick()
        compose.waitUntil(5_000) { mvm.saving.value.isNotEmpty() }
        compose.onNodeWithText("lead").performTextReplacement("lead2")
        focusGate.countDown()
        compose.waitUntil(10_000) { mvm.saving.value.isEmpty() }
        compose.waitForIdle()
        compose.onNodeWithText("lead2").assertExists()
        compose.onAllNodesWithText("Saved").assertCountEquals(0)

        compose.onNodeWithText("Label (blank = default)").performScrollTo().performTextReplacement("acmeq")
        compose.onNodeWithTag("save-label").performScrollTo().performClick()
        compose.waitUntil(5_000) { mvm.saving.value.isNotEmpty() }
        compose.onNodeWithText("acmeq").performScrollTo().performTextReplacement("acmeqz")
        labelGate.countDown()
        compose.waitUntil(10_000) { mvm.saving.value.isEmpty() }
        compose.waitForIdle()
        compose.onNodeWithText("acmeqz").assertExists()
        compose.onAllNodesWithText("Saved").assertCountEquals(0)
    }

    @Test fun `the label and whose work survive a rotation mid-save after an earlier save`() {
        // The schedule case's twin for the other two sections (QA mutation map):
        // each sends with its OWN last answer, and typing clears its "Saved".
        val gate = java.util.concurrent.atomic.AtomicReference(java.util.concurrent.CountDownLatch(0))
        hub.json("/api/jira/$site/create-meta", """{ "projects": [] }""")
        hub.route("/api/orgs/$site/meeting-label") {
            gate.get().await(10, java.util.concurrent.TimeUnit.SECONDS)
            HubHarness.refusal("label must be 1-40 lowercase letters", 400)
        }
        hub.route("/api/orgs/$site/meeting-focus") {
            gate.get().await(10, java.util.concurrent.TimeUnit.SECONDS)
            HubHarness.refusal("names must be up to 5 names", 400)
        }
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        val mvm = main.track(MeetingsViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val restore = androidx.compose.ui.test.junit4.StateRestorationTester(compose)
        restore.setContent { BriefScreen(vm = vm, meetingsVm = mvm) }
        compose.onNodeWithContentDescription("o settings").performClick()
        // An earlier save of each section that worked (answered by the hub).
        hub.route("/api/orgs/$site/meeting-label") {
            if (gate.get().count == 0L) okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{ "ok": true, "label": "acmea", "custom": true }""")
            else { gate.get().await(10, java.util.concurrent.TimeUnit.SECONDS); HubHarness.refusal("label refused", 400) }
        }
        hub.route("/api/orgs/$site/meeting-focus") {
            if (gate.get().count == 0L) okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{ "ok": true, "focus": { "names": [], "role": "one" } }""")
            else { gate.get().await(10, java.util.concurrent.TimeUnit.SECONDS); HubHarness.refusal("focus refused", 400) }
        }
        compose.onNodeWithText("Label (blank = default)").performScrollTo().performTextReplacement("acmea")
        compose.onNodeWithTag("save-label").performScrollTo().performClick()
        compose.onNodeWithText("Role (optional)").performScrollTo().performTextReplacement("one")
        compose.onNodeWithTag("save-focus").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Saved").fetchSemanticsNodes().size == 2 }
        // Typing clears that section's "Saved".
        compose.onNodeWithText("acmea").performScrollTo().performTextReplacement("acmeb")
        compose.onNodeWithText("one").performScrollTo().performTextReplacement("two")
        compose.onAllNodesWithText("Saved").assertCountEquals(0)
        // Both saves held in flight, one at a time, across a rotation; then refused.
        for ((tag, typed) in listOf("save-label" to "acmeb", "save-focus" to "two")) {
            val release = java.util.concurrent.CountDownLatch(1)
            gate.set(release)
            compose.onNodeWithTag(tag).performScrollTo().performClick()
            compose.waitUntil(5_000) { mvm.saving.value.isNotEmpty() }
            restore.emulateSavedInstanceStateRestore()
            compose.waitForIdle()
            compose.onAllNodesWithText(typed).assertCountEquals(1)
            release.countDown()
            compose.waitUntil(10_000) { mvm.saving.value.isEmpty() }
            compose.waitForIdle()
            compose.onAllNodesWithText(typed).assertCountEquals(1)
        }
    }
}
