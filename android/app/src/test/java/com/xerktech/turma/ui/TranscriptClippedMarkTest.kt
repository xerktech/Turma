package com.xerktech.turma.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.xerktech.turma.core.ChatItem
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The "… clipped to fit" mark (XERK-347) — the web's `.clipped` span, ported.
 *
 * `ChatItem.clipped` itself is pinned in `core/ChatItemsTest`; what had no gate
 * was its CALL SITE. Forcing the `if (b.clipped)` in [ChatItemView]'s bubble to
 * `false` left all 392 Android tests green — a rule computed in `core/` that
 * nothing verifiably renders (qa.md §5.7, the same shape as SpawnComposerTest).
 *
 * These drive the real composable, so they fail on the WIRING: the mark is read
 * off what is actually on screen, beside the message text it belongs to.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TranscriptClippedMarkTest {

    @get:Rule
    val compose = createComposeRule()

    private val mark = "… clipped to fit"

    @Test fun `a clipped bubble shows the mark beside its text`() {
        compose.setContent {
            ChatItemView(ChatItem.Bubble("a1", "assistant", "a long answer", clipped = true))
        }
        compose.onNodeWithText("a long answer").assertIsDisplayed()
        compose.onNodeWithText(mark).assertIsDisplayed()
    }

    @Test fun `an intact bubble shows no mark at all`() {
        compose.setContent {
            ChatItemView(ChatItem.Bubble("a1", "assistant", "the whole answer"))
        }
        compose.onNodeWithText("the whole answer").assertIsDisplayed()
        compose.onAllNodesWithText(mark).assertCountEquals(0)
    }

    /**
     * The mark is a STATEMENT, never a control: the live tail and `/history`
     * read at the same fidelity, so a tap could only be a dead end — which is
     * the button this ticket removed.
     */
    @Test fun `the mark is not clickable`() {
        compose.setContent {
            ChatItemView(ChatItem.Bubble("a1", "assistant", "text", clipped = true))
        }
        val node = compose.onNodeWithText(mark).fetchSemanticsNode()
        assertNull("the clipped mark took an OnClick — it must stay inert",
            node.config.find { it.key.name == "OnClick" })
    }
}
