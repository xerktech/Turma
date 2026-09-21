package com.xerktech.turma.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.xerktech.turma.core.ChatItem
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The "n thoughts hidden" marker (XERK-860) — the web's `renderFoldedThoughts`,
 * ported. Its COUNTING is pinned in `core/ChatItemsTest`; this drives the real
 * composable, so it fails on the WIRING: the marker must actually reach the
 * screen (a fold rule computed in `core/` that nothing renders is the qa.md §5.7
 * shape) with the right singular/plural label.
 *
 * It is SUMMARY ONLY and — like the web's plain `<span class="thf-label">` —
 * NOT a control: the trace is never carried at a verbosity that hides thinking,
 * so raising the verbosity is what reveals it; a tap could only be a dead end.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TranscriptFoldedThoughtsTest {

    @get:Rule
    val compose = createComposeRule()

    @Test fun `one hidden thought reads singular`() {
        compose.setContent { ChatItemView(ChatItem.FoldedThoughts("k", 1)) }
        compose.onNodeWithText("💭 1 thought hidden").assertIsDisplayed()
    }

    @Test fun `several hidden thoughts read plural with the count`() {
        compose.setContent { ChatItemView(ChatItem.FoldedThoughts("k", 3)) }
        compose.onNodeWithText("💭 3 thoughts hidden").assertIsDisplayed()
    }

    @Test fun `the marker is not clickable`() {
        compose.setContent { ChatItemView(ChatItem.FoldedThoughts("k", 2)) }
        val node = compose.onNodeWithText("💭 2 thoughts hidden").fetchSemanticsNode()
        assertNull("the folded-thoughts marker took an OnClick — it must stay inert",
            node.config.find { it.key.name == "OnClick" })
    }
}
