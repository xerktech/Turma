package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.ui.theme.TurmaTheme
import com.xerktech.turma.vm.MeetingsViewModel
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Meetings screen (XERK-2511): a meeting's proposals with their actions,
 * review states and the org's project pick, rendered off the real fleet.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MeetingsScreenTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val site = "o.atlassian.net"
    private val host = """{ "key": "h1", "device": "h1", "online": true, "lastSeen": 1,
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } }"""

    private fun seed() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "ENG", "name": "Engineering" } ] }""")
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ], "meetingProposals": { "$site": [
              { "meetingId": "m2", "status": "ok", "title": "Sprint sync", "platform": "Zoom",
                "startedAt": 1700000000000, "endedAt": 1700002700000, "tenirUrl": "https://tenir.example/c/1",
                "participants": ["Ann", "Bo", "Cy"], "items": [
                  { "id": "p1", "kind": "bug", "title": "Fix the login 500", "description": "Login fails for SSO users.",
                    "suggestedAssignee": "Ann", "duplicateKeys": ["ENG-12"],
                    "quotes": [ { "speaker": "Ann", "text": "login is broken again", "atMs": 61000 } ] },
                  { "id": "p2", "kind": "task", "title": "Write the runbook", "description": "",
                    "review": { "state": "created", "at": 5, "key": "ENG-40", "start": true, "session": "queued" } },
                  { "id": "p3", "kind": "decision", "title": "Ship on Friday", "description": "after QA" },
                  { "id": "p4", "kind": "followup", "title": "Ask legal", "description": "",
                    "review": { "state": "rejected", "at": 6 } } ] },
              { "meetingId": "m1", "status": "running", "title": "Retro", "host": "h1" } ] } }
        """.trimIndent())
    }

    private fun show(vm: MeetingsViewModel) = compose.setContent {
        TurmaTheme { MeetingsPane(Modifier.fillMaxSize(), vm) }
    }

    @Test fun `a meeting lists its proposals with their actions and states`() {
        seed()
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        compose.waitUntil(10_000) { vm.projectOf(site) == "ENG" }
        compose.onNodeWithText("Sprint sync").assertExists()
        compose.onNodeWithText("Engineering (ENG) ▾").assertExists()
        compose.onNodeWithText("Fix the login 500").assertExists()
        compose.onNodeWithText("Owner: Ann").assertExists()
        compose.onNodeWithText("May duplicate ENG-12").assertExists()
        compose.onNodeWithText("Ann: “login is broken again”").assertExists()
        compose.onNodeWithText("▸ 1:01").assertExists()
        compose.onNodeWithText("✓ Created ENG-40").assertExists()
        compose.onNodeWithText("· session starting").assertExists()
        compose.onNodeWithText("Log decision").performScrollTo().assertExists()
        compose.onNodeWithText("Rejected").performScrollTo().assertExists()
        // A LazyColumn row off-screen is uncomposed: scroll the list to it.
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Reading the captions on h1…"))
        compose.onNodeWithText("Reading the captions on h1…").assertExists()
    }

    @Test fun `Edit opens the draft with the meeting context and Cancel closes it`() {
        seed()
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        compose.onAllNodesWithText("Edit")[0].performClick()
        compose.waitUntil(5_000) { vm.drafts.value.isNotEmpty() }
        compose.onNodeWithText("Cancel").performScrollTo().assertExists()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitUntil(5_000) { vm.drafts.value.isEmpty() }
    }

    @Test fun `an item with a POST in flight cannot be pressed again`() {
        seed()
        val release = java.util.concurrent.CountDownLatch(1)
        hub.route("/api/orgs/") {
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setBody("""{ "ok": true }""")
        }
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        compose.onNodeWithText("Log decision").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.busy.value.isNotEmpty() }
        compose.onNodeWithText("Working…").assertIsNotEnabled()
        release.countDown()
        compose.waitUntil(10_000) { vm.busy.value.isEmpty() }
    }

    @Test fun `no meetings reads as an empty state`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        show(main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithText(
            "No meetings yet — when Tenir sends one, its proposed work items show up here.").assertExists()
    }
}
