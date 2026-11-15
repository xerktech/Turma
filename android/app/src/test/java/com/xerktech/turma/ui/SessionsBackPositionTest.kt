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
        compose.setContent { SessionsRoute(wide = false, onNavigate = {}, onTerminal = { _, _ -> }) }

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
}
