package com.xerktech.turma.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.ChatItem
import com.xerktech.turma.core.FoldedThought
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The "n thoughts hidden" marker (XERK-860) — the web's `renderFoldedThoughts`,
 * ported. Its COUNTING and trace-carrying are pinned in `core/ChatItemsTest`;
 * this drives the real composable, so it fails on the WIRING: the marker must
 * reach the screen with the right singular/plural label, stay COLLAPSED by
 * default, and reveal the carried trace in place on a tap.
 *
 * That is the web contract (a collapsed `<details>` carrying the trace): Normal
 * signposts the elision and lets the reader open it without changing the whole
 * verbosity; Concise renders no marker; Verbose shows the trace expanded.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TranscriptFoldedThoughtsTest {

    @get:Rule
    val compose = createComposeRule()

    private fun folded(vararg traces: String) =
        ChatItem.FoldedThoughts("k", traces.map { FoldedThought(it) })

    @Test fun `one hidden thought reads singular`() {
        compose.setContent { ChatItemView(folded("REVEALED-TRACE")) }
        compose.onNodeWithText("💭 1 thought").assertIsDisplayed()
    }

    @Test fun `several hidden thoughts read plural with the count`() {
        compose.setContent { ChatItemView(folded("a", "b", "c")) }
        compose.onNodeWithText("💭 3 thoughts").assertIsDisplayed()
    }

    @Test fun `the trace is hidden until the marker is tapped, then revealed`() {
        compose.setContent { ChatItemView(folded("REVEALED-TRACE")) }
        // Collapsed by default — the trace is carried but not shown.
        compose.onAllNodesWithText("REVEALED-TRACE", substring = true).assertCountEquals(0)
        compose.onNodeWithText("💭 1 thought").performClick()
        compose.onNodeWithText("REVEALED-TRACE", substring = true).assertIsDisplayed()
    }
}
