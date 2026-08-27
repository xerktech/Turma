package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A dsh session is HEADLESS (no ttyd), so its chat header must show a Trajectory
 * action, not a Terminal one — the Android half of XERK-498. Before this the
 * header always showed Terminal, and tapping it opened an empty `/term` page.
 * The web hides "Terminal ▸" and shows "Trajectory ▸" for `agentType == "dsh"`;
 * this drives the REAL `ChatScreen` and reads which action is on it, because the
 * `Runtime.isDsh` gate is `core/`-tested but the WIRING is what regressed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DshChatActionTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val host = "nas01"
    private val session = "s1"

    private fun openChat(agentType: String, transcriptId: String, onTrajectory: (String) -> Unit = {}) {
        hub.json(
            "/api/agents/$host/sessions/$session/history",
            """{"entries":[],"truncated":false,"pending":false}""",
        )
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(
            HubHarness.fleetJson(
                host = host,
                sessions = """{ "id": "$session", "repo": "Turma", "status": "running",
                                "worktree": "wt", "agentType": "$agentType",
                                "transcriptId": "$transcriptId" }""",
            )
        )
        compose.setContent {
            ChatScreen(
                host = host,
                sessionId = session,
                onBack = {},
                onTerminal = {},
                onTrajectory = onTrajectory,
            )
        }
        compose.waitForIdle()
    }

    @Test
    fun `a dsh session shows Trajectory and not Terminal`() {
        openChat(agentType = "dsh", transcriptId = "tr1")
        compose.onNodeWithContentDescription("Trajectory").assertIsDisplayed()
        compose.onNodeWithContentDescription("Terminal").assertDoesNotExist()
    }

    @Test
    fun `tapping Trajectory carries the session's transcript id`() {
        var got: String? = null
        openChat(agentType = "dsh", transcriptId = "tr-abc") { got = it }
        compose.onNodeWithContentDescription("Trajectory").performClick()
        compose.waitForIdle()
        assertEquals("tr-abc", got)
    }

    @Test
    fun `a claude session keeps the Terminal action`() {
        openChat(agentType = "claude", transcriptId = "tr1")
        compose.onNodeWithContentDescription("Terminal").assertIsDisplayed()
        compose.onNodeWithContentDescription("Trajectory").assertDoesNotExist()
    }
}
