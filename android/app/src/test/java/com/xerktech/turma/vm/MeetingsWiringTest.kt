package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.MeetingReviewRequest
import com.xerktech.turma.model.TurmaJson
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Meetings screen's wiring below the UI (XERK-2511): the poll and the SSE
 * frame fill `FleetState.meetingProposals`, and a review POSTs what the web page
 * sends — the org's project, the kind's issue type, the meeting context — and
 * shows a refusal in the hub's words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MeetingsWiringTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = """{ "key": "h1", "device": "h1", "online": true, "lastSeen": 1 }"""
    private val site = "o.atlassian.net"

    private fun meeting(review: String = "") = """
        { "meetingId": "m1", "status": "ok", "title": "Sprint sync", "startedAt": 1700000000000,
          "tenirUrl": "https://t/x",
          "items": [
            { "id": "p1", "kind": "bug", "title": "Fix login", "description": "It 500s",
              "quotes": [ { "speaker": "Ann", "text": "broken", "atMs": 61000 } ] $review },
            { "id": "p2", "kind": "decision", "title": "Ship Friday", "description": "after QA" } ] }
    """.trimIndent()

    private fun seed() = hub.seedFleet("""
        { "now": 1, "agents": [ $host ], "meetingProposals": { "$site": [ ${meeting()} ] } }
    """.trimIndent())

    private fun body(path: String): MeetingReviewRequest =
        TurmaJson.decodeFromString(MeetingReviewRequest.serializer(), hub.findRequest(path).body.readUtf8())

    @Test fun `the poll fills the meetings and an SSE frame replaces them`() {
        seed()
        val fleet = hub.container.fleet
        assertEquals("Fix login", fleet.state.value.meetingProposals.getValue(site).single().items[0].title)
        fleet.onSseEvent("meetingProposals", """{ "$site": [ { "meetingId": "m9", "status": "running" } ] }""")
        assertEquals("m9", fleet.state.value.meetingProposals.getValue(site).single().meetingId)
        fleet.onSseEvent("meetingProposals", "not json")
        assertEquals("m9", fleet.state.value.meetingProposals.getValue(site).single().meetingId)
    }

    @Test fun `a poll that started before an SSE frame keeps the frame's meetings`() {
        seed()
        val fleet = hub.container.fleet
        val release = java.util.concurrent.CountDownLatch(1)
        val entered = java.util.concurrent.CountDownLatch(1)
        hub.route("/api/agents") {
            entered.countDown()
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            MockResponse().setHeader("Content-Type", "application/json").setBody("""
                { "now": 2, "agents": [ $host ], "meetingProposals": { "$site": [ ${meeting()} ] } }
            """.trimIndent())
        }
        val poll = kotlin.concurrent.thread { kotlinx.coroutines.runBlocking { fleet.refresh() } }
        assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
        fleet.onSseEvent("meetingProposals", """{ "$site": [ { "meetingId": "m9", "status": "running" } ] }""")
        release.countDown()
        poll.join(10_000)
        assertEquals("m9", fleet.state.value.meetingProposals.getValue(site).single().meetingId)
    }

    @Test fun `approve sends the org's project, the bug type and the meeting context`() {
        seed()
        hub.json("/api/jira/$site/create-meta?project=ENG",
            """{ "types": [ { "id": "10", "name": "Task" }, { "id": "11", "name": "Bug" } ] }""")
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "ENG", "name": "Engineering" } ] }""")
        hub.json("/api/orgs/", """{ "ok": true, "meeting": ${meeting(""", "review": { "state": "creating", "at": 5, "cmdId": "c1", "host": "h1" }""")} }""")
        val vm = main.track(MeetingsViewModel(hub.app))
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).single()
        kotlinx.coroutines.runBlocking { vm.review(site, m, m.items[0], "approve", start = true).join() }
        val req = hub.findRequest("/api/orgs/")
        assertEquals("/api/orgs/$site/meetings/m1/items/p1", req.path)
        val b = TurmaJson.decodeFromString(MeetingReviewRequest.serializer(), req.body.readUtf8())
        assertEquals("approve", b.action)
        assertEquals("ENG", b.project)
        assertEquals("11", b.issueType)
        assertEquals(true, b.start)
        assertNull(b.edited)
        assertEquals("Fix login", b.title)
        assertEquals(
            "It 500s\n\nProposed from the meeting \"Sprint sync\" (2023-11-14).\n> Ann: broken [1:01]\nMeeting: https://t/x",
            b.description,
        )
        // The hub's answer is in place at once, before any SSE frame.
        val item = hub.container.fleet.state.value.meetingProposals.getValue(site).single().items[0]
        assertEquals("creating", item.review!!.state)
        assertTrue(vm.busy.value.isEmpty())
    }

    @Test fun `a decision logs without asking for a project, and an edit is flagged`() {
        seed()
        hub.json("/api/orgs/", """{ "ok": true }""")
        val vm = main.track(MeetingsViewModel(hub.app))
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).single()
        vm.startEdit(site, m, m.items[1])
        val k = MeetingsViewModel.itemKey(site, "m1", "p2")
        assertEquals("after QA", vm.drafts.value.getValue(k).description)
        vm.editDraft(k) { it.copy(title = "Ship Monday") }
        kotlinx.coroutines.runBlocking { vm.review(site, m, m.items[1], "approve").join() }
        val b = body("/api/orgs/")
        assertEquals("Ship Monday", b.title)
        assertEquals(true, b.edited)
        assertNull(b.project)
        assertNull(b.issueType)
        assertTrue(k !in vm.drafts.value)
    }

    @Test fun `an editor opened but left unchanged is not an edit`() {
        seed()
        hub.json("/api/orgs/", """{ "ok": true }""")
        val vm = main.track(MeetingsViewModel(hub.app))
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).single()
        vm.startEdit(site, m, m.items[1])
        kotlinx.coroutines.runBlocking { vm.review(site, m, m.items[1], "approve").join() }
        assertNull(body("/api/orgs/").edited)
    }

    @Test fun `a second press while an Approve awaits its types posts nothing`() {
        seed()
        val release = java.util.concurrent.CountDownLatch(1)
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "ENG" } ] }""")
        hub.route("/api/jira/$site/create-meta?project=") {
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            MockResponse().setHeader("Content-Type", "application/json").setBody("""{ "types": [ { "id": "11", "name": "Bug" } ] }""")
        }
        val posts = java.util.concurrent.CopyOnWriteArrayList<String>()
        hub.route("/api/orgs/") { r ->
            posts += r.body.readUtf8()
            MockResponse().setHeader("Content-Type", "application/json").setBody("""{ "ok": true }""")
        }
        val vm = main.track(MeetingsViewModel(hub.app))
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).single()
        val approve = vm.review(site, m, m.items[0], "approve")
        assertTrue(MeetingsViewModel.itemKey(site, "m1", "p1") in vm.busy.value)
        val reject = vm.review(site, m, m.items[0], "reject")
        kotlinx.coroutines.runBlocking { reject.join() }
        assertTrue(posts.isEmpty())
        release.countDown()
        kotlinx.coroutines.runBlocking { approve.join() }
        assertEquals(1, posts.size)
        assertTrue(posts.single().contains("\"approve\""))
    }

    @Test fun `a review answer patched in outlives a poll that started before it`() {
        seed()
        val fleet = hub.container.fleet
        val release = java.util.concurrent.CountDownLatch(1)
        val entered = java.util.concurrent.CountDownLatch(1)
        hub.route("/api/agents") {
            entered.countDown()
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "now": 2, "agents": [ $host ], "meetingProposals": { "$site": [ ${meeting()} ] } }""")
        }
        val poll = kotlin.concurrent.thread { kotlinx.coroutines.runBlocking { fleet.refresh() } }
        assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
        val m = fleet.state.value.meetingProposals.getValue(site).single()
        fleet.patchMeeting(site, m.copy(items = m.items.map {
            if (it.id == "p1") it.copy(review = com.xerktech.turma.model.MeetingReview("rejected")) else it
        }))
        release.countDown()
        poll.join(10_000)
        assertEquals("rejected", fleet.state.value.meetingProposals.getValue(site).single().items[0].review?.state)
    }

    @Test fun `a refusal is shown in the hub's words and keeps the item reviewable`() {
        seed()
        hub.json("/api/orgs/", """{ "error": "that proposal's ticket is already being created" }""", code = 409)
        val vm = main.track(MeetingsViewModel(hub.app))
        val got = hub.expectMessage(vm.messages)
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).single()
        kotlinx.coroutines.runBlocking { vm.review(site, m, m.items[0], "reject").join() }
        assertEquals("✗ Rejecting failed — that proposal's ticket is already being created", got())
        assertEquals("Rejecting failed — that proposal's ticket is already being created",
            vm.errors.value[MeetingsViewModel.itemKey(site, "m1", "p1")])
        assertEquals("reject", body("/api/orgs/").action)
    }

    @Test fun `approve with no project to pick refuses before any POST`() {
        seed()
        hub.json("/api/jira/$site/create-meta", """{ "projects": [ { "key": "A" }, { "key": "B" } ] }""")
        val vm = main.track(MeetingsViewModel(hub.app))
        val m = hub.container.fleet.state.value.meetingProposals.getValue(site).single()
        kotlinx.coroutines.runBlocking { vm.review(site, m, m.items[0], "approve").join() }
        assertEquals("Pick a project for new tickets first", vm.errors.value[MeetingsViewModel.itemKey(site, "m1", "p1")])
        assertNull(hub.findRequestOrNull("/api/orgs/"))
        // Picking one makes the next approve go through with it.
        vm.setProject(site, "B")
        assertEquals("B", vm.projectOf(site))
    }
}
