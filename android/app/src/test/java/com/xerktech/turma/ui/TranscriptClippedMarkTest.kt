package com.xerktech.turma.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.ChatItem
import com.xerktech.turma.model.SendFile
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
     * The tool card and the thinking trace carry their own call sites — a gate
     * on the bubble alone left both free to be deleted with every Android test
     * green. Both render COLLAPSED by default, so the mark appears once the card
     * is opened (the web's thought card opens by default; PARITY.md records it).
     */
    @Test fun `a clipped tool card shows the mark once opened`() {
        compose.setContent {
            ChatItemView(
                ChatItem.Tool("a1", name = "Bash", input = "ls", result = "out",
                    isError = false, clipped = true)
            )
        }
        compose.onAllNodesWithText(mark).assertCountEquals(0)  // collapsed
        compose.onNodeWithText("🔧 Bash").performClick()
        compose.onNodeWithText(mark).assertIsDisplayed()
    }

    @Test fun `a clipped thinking trace shows the mark once opened`() {
        compose.setContent {
            ChatItemView(ChatItem.Thinking("a1", "a long thought", clipped = true))
        }
        compose.onAllNodesWithText(mark).assertCountEquals(0)  // collapsed
        compose.onNodeWithText("💭 thinking").performClick()
        compose.onNodeWithText(mark).assertIsDisplayed()
    }

    /**
     * A preview the agent DROPPED to fit the reply says so; one that was never
     * renderable does not. Web parity: `renderToolFiles`' `shed` branch — a bare
     * chip with no reason is indistinguishable from a file that never rendered.
     */
    @Test fun `a shed file chip says the preview was dropped`() {
        compose.setContent {
            ChatItemView(
                ChatItem.Tool("a1", name = "SendUserFile", input = "", result = "",
                    isError = false,
                    files = listOf(SendFile(name = "shot.png", kind = "file", shed = true)))
            )
        }
        compose.onNodeWithText("📎 shot.png").assertIsDisplayed()
        compose.onNodeWithText("… preview dropped to fit").assertIsDisplayed()
    }

    @Test fun `a chip for a file that never rendered says nothing extra`() {
        compose.setContent {
            ChatItemView(
                ChatItem.Tool("a1", name = "SendUserFile", input = "", result = "",
                    isError = false,
                    files = listOf(SendFile(name = "notes.bin", kind = "file")))
            )
        }
        compose.onNodeWithText("📎 notes.bin").assertIsDisplayed()
        compose.onAllNodesWithText("… preview dropped to fit").assertCountEquals(0)
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
