package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredHeight
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.dp
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The chat header and footer FIT the window (rollup XERK-1701 #64.1, #66), on the real
 * [ChatScreen]. Before: the fixed 64dp top bar clipped the host · repo · tunnel line at
 * font scale 2.0, and in a short window (landscape, keyboard up) the footer grew over
 * the top bar so the model / mode chips drew across the title.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatHeaderFooterFitTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val host = "nas01"
    private val session = "s1"

    private fun open(heightDp: Int, fontScale: Float) {
        hub.json("/api/agents/$host/sessions/$session/history", """{"entries":[],"truncated":false,"pending":false}""")
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(
            HubHarness.fleetJson(
                host = host,
                sessions = """{ "id": "$session", "repo": "Turma", "status": "running", "worktree": "wt",
                                "model": "opus", "permissionMode": "auto" }""",
            )
        )
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale)) {
                Box(Modifier.requiredHeight(heightDp.dp)) {
                    ChatScreen(host = host, sessionId = session, onBack = {}, onTerminal = {})
                }
            }
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Message…", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitForIdle()
    }

    /** A text node's extent in root dp from its position and MEASURED size — never clipped. */
    private fun unclipped(text: String): DpRect {
        val n = compose.onNodeWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNode()
        return with(compose.density) {
            val top = n.positionInRoot.y.toDp()
            val left = n.positionInRoot.x.toDp()
            DpRect(left, top, left + n.size.width.toDp(), top + n.size.height.toDp())
        }
    }

    @Test fun `the bar grows to hold both header lines at font scale 2`() {
        open(heightDp = 600, fontScale = 2f)
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        // UNCLIPPED extent (position + measured size): a 64dp bar squeezed or clipped the
        // line, and clipped bounds would hide exactly that.
        val meta = unclipped("nas01")
        assertTrue("meta line squeezed to ${meta.height} (a 16sp line at 2x is 32dp)", meta.height >= 31.dp)
        assertTrue("meta line bottom ${meta.bottom} spills past the bar (bottom ${bar.bottom})", meta.bottom <= bar.bottom + 1.dp)
    }

    @Test fun `a short window keeps the footer under the top bar`() {
        // Landscape with the keyboard up at font scale 2: less room than the footer wants.
        open(heightDp = 170, fontScale = 2f)
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        val footer = compose.onNodeWithTag(CHAT_FOOTER_TAG).getBoundsInRoot()
        assertTrue("footer top ${footer.top} rides over the top bar (bottom ${bar.bottom})", footer.top >= bar.bottom)
        // The compose box is what stays: the footer is pinned to its bottom.
        val box = unclipped("Message…")
        assertTrue("compose box $box is cut off below the footer (bottom ${footer.bottom})", box.bottom <= footer.bottom + 1.dp)
        assertTrue("compose box $box is cut off above the footer (top ${footer.top})", box.top >= footer.top - 1.dp)
    }

    @Test fun `the bar is Material's 64dp unless the lines need more`() {
        assertEquals(64.dp, chatTopBarHeight(28.dp, 16.dp))
        assertEquals(56.dp + 32.dp + 16.dp, chatTopBarHeight(56.dp, 32.dp))
    }
}
