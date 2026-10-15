package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredHeight
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The waiting sheets' cap WIRED into the real chat screen (rollup XERK-1701 #64.2).
 * `WaitingSheetCapTest` pins the pure [waitingSheetCap]; dropping the sheets'
 * `heightIn(max = maxHeight)`, or never measuring the top bar or the footer, left
 * it green while a long question drew over the top bar (Kill and Terminal
 * untappable). This lays the real [ChatScreen] out in a short, landscape-like
 * window with a question taller than it, and reads where the sheet landed.
 *
 * The window is 300dp — short enough that the MEASURED bars bind the cap rather
 * than its half-window ceiling, so an unmeasured top bar or footer shows here.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WaitingSheetBoundsTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val host = "nas01"
    private val session = "s1"
    private val options = (1..14).joinToString(",") { "\"Option number $it, a fairly long label\"" }

    private fun open(sessionBlock: String) {
        hub.json("/api/agents/$host/sessions/$session/history", """{"entries":[],"truncated":false,"pending":false}""")
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(
            HubHarness.fleetJson(
                host = host,
                sessions = """{ "id": "$session", "repo": "Turma", "status": "running", "worktree": "wt",
                                "session": $sessionBlock }""",
            )
        )
        compose.setContent {
            Box(Modifier.requiredHeight(300.dp)) {
                ChatScreen(host = host, sessionId = session, onBack = {}, onTerminal = {})
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(WAITING_SHEET_TAG).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }

    private fun assertBelowTopBar() {
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        val sheet = compose.onNodeWithTag(WAITING_SHEET_TAG).getBoundsInRoot()
        assertTrue("the sheet is on screen at all: $sheet", sheet.bottom > sheet.top)
        assertTrue("sheet top ${sheet.top} rides over the top bar (bottom ${bar.bottom})", sheet.top >= bar.bottom)
    }

    @Test fun `a question taller than the window stays below the top bar`() {
        open("""{ "question": "Which one?", "questionOptions": [ $options ] }""")
        assertBelowTopBar()
    }

    @Test fun `a permission dialog taller than the window stays below the top bar`() {
        val opts = (1..14).joinToString(",") { """{"number":$it,"label":"Choice $it, a fairly long label"}""" }
        open(
            """{ "panePrompt": { "prompt": "Do you want to proceed?", "detail": "Bash command",
                 "id": "0123456789abcdef0123456789abcdef", "options": [ $opts ] } }"""
        )
        assertBelowTopBar()
    }
}
