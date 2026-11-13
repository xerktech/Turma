package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.ui.theme.TurmaTheme
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
    private val t0 = System.currentTimeMillis() - 3_600_000
    private val host = """{ "key": "h1", "device": "h1", "online": true, "lastSeen": 1,
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } }"""

    private fun seed() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "ENG", "name": "Engineering" } ] }""")
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ], "meetingProposals": { "$site": [
              { "meetingId": "m2", "status": "ok", "title": "Sprint sync", "platform": "Zoom",
                "startedAt": $t0, "endedAt": ${t0 + 2_700_000}, "tenirUrl": "https://tenir.example/c/1",
                "participants": ["Ann", "Bo", "Cy"], "items": [
                  { "id": "p1", "kind": "bug", "title": "Fix the login 500", "description": "Login fails for SSO users.",
                    "suggestedAssignee": "Ann", "duplicateKeys": ["ENG-12"],
                    "quotes": [ { "speaker": "Ann", "text": "login is broken again", "atMs": 61000 } ] },
                  { "id": "p2", "kind": "task", "title": "Write the runbook", "description": "",
                    "review": { "state": "created", "at": 5, "key": "ENG-40", "start": true, "session": "queued" } },
                  { "id": "p3", "kind": "decision", "title": "Ship on Friday", "description": "after QA" },
                  { "id": "p4", "kind": "followup", "title": "Ask legal", "description": "",
                    "review": { "state": "rejected", "at": 6 } } ] },
              { "meetingId": "m1", "status": "running", "title": "Retro", "host": "h1", "startedAt": $t0 },
              { "meetingId": "m0", "status": "ok", "title": "Planning", "startedAt": ${t0 - 86_400_000},
                "items": [ { "id": "p1", "kind": "task", "title": "Done already",
                  "review": { "state": "rejected", "at": 2 } } ] },
              { "meetingId": "ma", "status": "ok", "title": "Old offsite", "startedAt": ${t0 - 9 * 86_400_000},
                "archivedAt": 9, "items": [] } ] } }
        """.trimIndent())
    }

    private fun show(vm: MeetingsViewModel) = compose.setContent {
        TurmaTheme {
            BriefScreen(Modifier.fillMaxSize(), vm = main.track(BriefViewModel(hub.app)), meetingsVm = vm)
        }
    }

    private fun open(title: String) {
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(title))
        compose.onNodeWithText(title).performClick()
    }

    @Test fun `Needs review lists what waits on the operator, All and Archived the rest`() {
        seed()
        show(main.track(MeetingsViewModel(hub.app)))
        // Pending count: p1 + p3 of Sprint sync (p2 created, p4 rejected).
        compose.onAllNodesWithText("2").assertCountEquals(2) // the org pill and the entry pill
        compose.onNodeWithText("Sprint sync").assertExists()
        compose.onNodeWithText("Retro").assertExists() // still being read
        compose.onNodeWithText("Planning").assertDoesNotExist() // nothing pending
        compose.onNodeWithText("Old offsite").assertDoesNotExist()
        compose.onNodeWithText("All").performClick()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Planning"))
        compose.onNodeWithText("Planning").assertExists()
        compose.onNodeWithText("Old offsite").assertDoesNotExist()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithText("Old offsite").assertExists()
        compose.onNodeWithText("Sprint sync").assertDoesNotExist()
    }

    @Test fun `search narrows to meetings whose title or a proposal matches`() {
        seed()
        show(main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithText("Search meetings and proposals").performTextInput("login")
        compose.onNodeWithText("Sprint sync").assertExists()
        compose.onNodeWithText("Retro").assertDoesNotExist()
    }

    @Test fun `a folded org hides its meetings and stays folded`() {
        seed()
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        compose.onNodeWithContentDescription("Collapse o").performClick()
        compose.onNodeWithText("Sprint sync").assertDoesNotExist()
        assertTrue(site in vm.collapsed.value)
        // Remembered on the phone: a new ViewModel reads it back.
        assertTrue(site in main.track(MeetingsViewModel(hub.app)).collapsed.value)
    }

    @Test fun `a meeting shows pending proposals first and reviewed ones on demand`() {
        seed()
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        open("Sprint sync")
        // Wait on the rendered picker, not on vm.projectOf: the projects land on
        // an OkHttp thread (XERK-2633).
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Engineering (ENG) ▾").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("2 of 4 reviewed").assertExists()
        compose.onNodeWithText("Fix the login 500").assertExists()
        compose.onNodeWithText("Owner: Ann").assertExists()
        compose.onNodeWithText("May duplicate ENG-12").assertExists()
        compose.onNodeWithText("Ann: “login is broken again”").assertExists()
        compose.onNodeWithText("▸ 1:01").assertExists()
        compose.onNodeWithText("Log decision").performScrollTo().assertExists()
        compose.onNodeWithText("Write the runbook").assertDoesNotExist()
        compose.onNodeWithText("Show reviewed (2)").performScrollTo().performClick()
        compose.onNodeWithText("✓ Created ENG-40").performScrollTo().assertExists()
        compose.onNodeWithText("· session starting").assertExists()
        compose.onNodeWithText("Rejected").performScrollTo().assertExists()
        compose.onNodeWithText("Reopen").performScrollTo().assertExists()
    }

    @Test fun `Reopen sends the reopen action and Archive the archive route`() {
        seed()
        hub.json("/api/orgs/$site/meetings/m2/items/p4", """{ "ok": true }""")
        hub.json("/api/orgs/$site/meetings/m2/archive", """{ "ok": true }""")
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        open("Sprint sync")
        compose.onNodeWithText("Show reviewed (2)").performScrollTo().performClick()
        compose.onNodeWithText("Reopen").performScrollTo().performClick()
        val r = hub.findRequest("/meetings/m2/items/p4")
        assertEquals("POST", r.method)
        assertEquals("""{"action":"reopen"}""", r.body.readUtf8())
        compose.onNodeWithText("Archive meeting").performScrollTo().performClick()
        val a = hub.findRequest("/meetings/m2/archive")
        assertEquals("""{"archived":true}""", a.body.readUtf8())
    }

    @Test fun `a refused archive is reported in the hub's words`() {
        seed()
        hub.route("/api/orgs/$site/meetings/m0/archive") { HubHarness.refusal("that meeting is still being read") }
        val vm = main.track(MeetingsViewModel(hub.app))
        val message = hub.expectMessage(vm.messages)
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).first { it.meetingId == "m0" }
        vm.archive(site, m, true)
        assertEquals("✗ Archiving failed — that meeting is still being read", message())
    }

    @Test fun `Edit opens the draft and Cancel closes it`() {
        seed()
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        open("Sprint sync")
        compose.onAllNodesWithText("Edit")[0].performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.drafts.value.isNotEmpty() }
        compose.onNodeWithText("Cancel").performScrollTo().performClick()
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
        open("Sprint sync")
        compose.onNodeWithText("Log decision").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.busy.value.isNotEmpty() }
        compose.onNodeWithText("Working…").assertIsNotEnabled()
        release.countDown()
        compose.waitUntil(10_000) { vm.busy.value.isEmpty() }
    }

    @Test fun `a proposal whose ticket may exist offers Reject only`() {
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "ENG", "name": "Engineering" } ] }""")
        hub.seedFleet("""
            { "now": 1, "agents": [ $host ], "meetingProposals": { "$site": [
              { "meetingId": "m3", "status": "ok", "title": "Planning", "platform": "Zoom",
                "startedAt": 1700000000000, "endedAt": 1700002700000, "participants": [], "items": [
                  { "id": "p1", "kind": "task", "title": "Write the doc", "description": "",
                    "review": { "state": "failed", "at": 5, "maybeCreated": true,
                      "error": "the host is gone — the ticket may have been created" } } ] } ] } }
        """.trimIndent())
        val posted = java.util.concurrent.atomic.AtomicReference<String>()
        hub.route("/api/orgs/") { req ->
            posted.set(req.body.readUtf8())
            okhttp3.mockwebserver.MockResponse().setBody("""{ "ok": true }""")
        }
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        open("Planning")
        compose.onNodeWithText("Maybe created — the host is gone — the ticket may have been created").assertExists()
        compose.onAllNodesWithText("Approve").assertCountEquals(0)
        compose.onAllNodesWithText("Edit").assertCountEquals(0)
        compose.onNodeWithText("Reject").performScrollTo().performClick()
        compose.waitUntil(10_000) { posted.get() != null }
        org.junit.Assert.assertTrue(posted.get(), posted.get().contains("\"action\":\"reject\""))
    }

    @Test fun `an org with no meetings says nothing needs review`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ] }""")
        show(main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithText("Nothing needs review.").assertExists()
        compose.onNodeWithText("All").performClick()
        compose.onNodeWithText(
            "No meetings yet — when Tenir sends one, its proposed work items show up here.").assertExists()
    }

    @Test fun `an unmapped Tenir label is one banner`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host ],
            "meetingLabelMisses": { "acme": { "at": 2 }, "beta@0123": { "at": 1, "shared": true } } }""")
        show(main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithText(
            "Tenir sent meetings for \"acme\", \"beta\", which no org answers to. " +
                "Give an org that label in its settings and they arrive.").assertExists()
    }

    @Test fun `an entry reviewed to zero stays open with Next`() {
        // XERK-2858 QA: looking the open entry up in the FILTERED list would
        // drop it from under the operator the moment its last proposal is answered.
        seed()
        val reviewed = """{ "ok": true, "meeting": { "meetingId": "m2", "status": "ok", "title": "Sprint sync",
            "startedAt": $t0, "items": [
              { "id": "p1", "kind": "bug", "title": "Fix the login 500", "review": { "state": "rejected", "at": 9 } },
              { "id": "p3", "kind": "decision", "title": "Ship on Friday", "review": { "state": "logged", "at": 9 } } ] } }"""
        hub.json("/api/orgs/$site/meetings/m2/items/", reviewed)
        val vm = main.track(MeetingsViewModel(hub.app))
        show(vm)
        open("Sprint sync")
        compose.onAllNodesWithText("Reject")[0].performScrollTo().performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("✓ Every proposal is reviewed.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Sprint sync").assertExists()
        compose.onNodeWithText("2 of 2 reviewed").assertExists()
    }

    @Test fun `a search lists only the orgs it hits`() {
        hub.seedFleet("""{ "now": 1, "agents": [ $host, { "key": "h2", "device": "h2", "online": true, "lastSeen": 1,
            "jira": { "available": true, "siteKey": "b.atlassian.net", "site": "b.atlassian.net", "tickets": [] } } ],
            "meetingProposals": { "$site": [ { "meetingId": "m1", "status": "ok", "title": "Sprint sync", "startedAt": $t0,
              "items": [ { "id": "p1", "kind": "task", "title": "Wire it" } ] } ] } }""")
        show(main.track(MeetingsViewModel(hub.app)))
        compose.onNodeWithContentDescription("b settings").assertExists()
        compose.onNodeWithText("Search meetings and proposals").performTextInput("sprint")
        compose.onNodeWithContentDescription("b settings").assertDoesNotExist()
        compose.onNodeWithText("Sprint sync").assertExists()
    }
}
