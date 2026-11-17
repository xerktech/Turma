package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.net.FleetRepository
import com.xerktech.turma.net.FleetState
import androidx.compose.ui.test.junit4.StateRestorationTester
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import com.xerktech.turma.vm.ArchiveViewModel
import com.xerktech.turma.vm.FleetViewModel
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Backing out of a session on a phone (XERK-2955): the list comes back where the
 * operator left it, with the session just closed marked by the selected border.
 *
 * Narrow mode swaps the list pane out for the chat, so anything the pane
 * remembered itself — its scroll position included — died on the way in and the
 * list reopened at the top with nothing marked.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SessionsBackPositionTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    // VMs over THIS test's hub — never the screen's viewModel() default (android.md).
    private fun showRoute() {
        val fleetVm = main.track(FleetViewModel(hub.app))
        val archiveVm = main.track(ArchiveViewModel(hub.app))
        compose.setContent {
            SessionsRoute(
                wide = false, onNavigate = {}, onTerminal = { _, _ -> },
                fleetVm = fleetVm, archiveVm = archiveVm,
            )
        }
    }

    private fun name(i: Int) = "Session %02d".format(i)

    @Test
    fun backReturnsToTheSameScrollPositionWithTheSessionMarked() {
        // Enough running sessions that the target is well below the first screen.
        val sessions = (0 until 40).joinToString(",") { i ->
            """{ "id": "s$i", "status": "running", "summary": "${name(i)}", "repo": "Turma" }"""
        }
        hub.seedFleet(
            """{ "now": 1, "agents": [ { "key": "h1", "device": "h1", "online": true,
                 "repos": [ { "name": "Turma", "lastActivity": "2026-08-12T00:00:00Z" } ],
                 "sessions": [ $sessions ] } ] }"""
        )
        showRoute()

        val list = compose.onNode(hasScrollAction())
        val target = name(30)
        list.performScrollToNode(hasText(target))
        compose.onNodeWithText(target).performClick()
        compose.waitForIdle()
        // In the full-screen chat now: the list is gone.
        assertEquals(0, compose.onAllNodes(hasScrollAction().and(hasAnyDescendant(hasText(target)))).fetchSemanticsNodes().size)

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()

        // Same place in the list, not the top…
        compose.onNodeWithText(target).assertIsDisplayed()
        assertEquals(0, compose.onAllNodes(hasText(name(0))).fetchSemanticsNodes().size)
        // …and the session just left is the one marked.
        compose.onNode(isSelected().and(hasAnyDescendant(hasText(target)))).assertIsDisplayed()
        // Only that one card (the bottom nav's selected tab is the other selected node).
        val markedCards = compose.onAllNodes(isSelected().and(hasAnyDescendant(hasText("Session ", substring = true))))
        assertEquals(1, markedCards.fetchSemanticsNodes().size)
    }

    @Test
    fun aRestoreOverAStillLoadingFleetKeepsTheListPosition() {
        val sessions = (0 until 40).joinToString(",") { i ->
            """{ "id": "s$i", "status": "running", "summary": "${name(i)}", "repo": "Turma" }"""
        }
        val fleetJson = """{ "now": 1, "agents": [ { "key": "h1", "device": "h1", "online": true,
                 "repos": [ { "name": "Turma", "lastActivity": "2026-08-12T00:00:00Z" } ],
                 "sessions": [ $sessions ] } ] }"""
        hub.seedFleet(fleetJson)
        val fleetVm = main.track(FleetViewModel(hub.app))
        val archiveVm = main.track(ArchiveViewModel(hub.app))
        val restore = StateRestorationTester(compose)
        restore.setContent {
            SessionsRoute(wide = false, onNavigate = {}, onTerminal = { _, _ -> }, fleetVm = fleetVm, archiveVm = archiveVm)
        }
        val target = name(30)
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(target))
        compose.waitForIdle()

        // Process death: the saved state comes back, but the new process's fleet has not
        // loaded yet (the repository's initial state: loading, no hosts). The fleet answer is
        // held until the test releases it, and the old poll stopped: the restored screen's own
        // start() refreshes at once and the 6s poll runs on a real clock, so either could land
        // the fleet before "Loading…" was read (a CI flake).
        val gate = java.util.concurrent.CountDownLatch(1)
        hub.route("/api/agents") {
            gate.await(10, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(fleetJson)
        }
        hub.container.fleet.stop()
        val state = FleetRepository::class.java.getDeclaredField("_state").apply { isAccessible = true }
            .get(hub.container.fleet) as MutableStateFlow<FleetState>
        state.value = FleetState()
        restore.emulateSavedInstanceStateRestore()
        compose.waitForIdle()
        compose.onNodeWithText("Loading…").assertIsDisplayed()

        // The fleet lands: the list is where it was, not clamped to the top by the empty one.
        gate.countDown()
        runBlocking { hub.container.fleet.refresh() }
        compose.waitForIdle()
        compose.onNodeWithText(target).assertIsDisplayed()
        assertEquals(0, compose.onAllNodes(hasText(name(0))).fetchSemanticsNodes().size)
    }

    @Test
    fun backFromAnEndedReviewKeepsTheEndedSectionOpenAndMarked() {
        val running = (0 until 3).joinToString(",") { i ->
            """{ "id": "r$i", "status": "running", "summary": "${name(i)}", "repo": "Turma" }"""
        }
        val ended = (0 until 30).joinToString(",") { i ->
            """{ "id": "e$i", "status": "stopped", "summary": "Ended %02d", "repo": "Turma",
                 "transcriptId": "t$i", "stoppedAt": "2026-08-12T00:%02d:00Z" }""".format(i, i)
        }
        hub.seedFleet(
            """{ "now": 1, "agents": [ { "key": "h1", "device": "h1", "online": true,
                 "repos": [ { "name": "Turma", "lastActivity": "2026-08-12T00:00:00Z" } ],
                 "sessions": [ $running, $ended ] } ] }"""
        )
        showRoute()

        val list = compose.onNode(hasScrollAction())
        list.performScrollToNode(hasText("Ended sessions", substring = true, ignoreCase = true))
        compose.onNodeWithText("Ended sessions", substring = true, ignoreCase = true).performClick()
        val target = "Ended 05"
        list.performScrollToNode(hasText(target))
        compose.onNodeWithText(target).performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()

        // The section is still open, the list is still on the row, and it is marked.
        compose.onNodeWithText(target).assertIsDisplayed()
        assertEquals(0, compose.onAllNodes(hasText(name(0))).fetchSemanticsNodes().size)
        compose.onNode(isSelected().and(hasAnyDescendant(hasText(target)))).assertIsDisplayed()
    }
}
