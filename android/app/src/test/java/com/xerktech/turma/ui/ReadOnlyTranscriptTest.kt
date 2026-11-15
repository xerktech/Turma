package com.xerktech.turma.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import com.xerktech.turma.core.ChatItem
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * An ended session / background agent opens on its NEWEST messages (XERK-2956;
 * web twin: chat.js openStatic, chat-selection.test.js), stays there while the
 * list grows under a parked reader, and lets go once the reader scrolls up.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReadOnlyTranscriptTest {

    @get:Rule
    val compose = createComposeRule()

    private fun bubbles(n: Int) = List(n) { ChatItem.Bubble("e$it", if (it % 2 == 0) "user" else "assistant", "message $it") }

    @Test fun `opens at the newest message, not the first prompt`() {
        compose.setContent { ReadOnlyTranscript(bubbles(80), "t1") }
        compose.onNodeWithText("message 79").assertIsDisplayed()
        compose.onNodeWithText("message 0").assertDoesNotExist()
    }

    @Test fun `a list that grows under a parked reader stays at the bottom`() {
        val items = mutableStateOf(bubbles(40))
        compose.setContent { ReadOnlyTranscript(items.value, "t1") }
        compose.onNodeWithText("message 39").assertIsDisplayed()
        items.value = bubbles(120) // a verbosity change showing more
        compose.onNodeWithText("message 119").assertIsDisplayed()
    }

    @Test fun `a reader who scrolled up is not yanked back down`() {
        val items = mutableStateOf(bubbles(80))
        compose.setContent { ReadOnlyTranscript(items.value, "t1") }
        compose.onNode(hasScrollAction()).performScrollToIndex(0)
        compose.onNodeWithText("message 0").assertIsDisplayed()
        items.value = bubbles(81)
        compose.onNodeWithText("message 0").assertIsDisplayed()
        compose.onNodeWithText("message 80").assertDoesNotExist()
    }

    @Test fun `a final message taller than the screen opens on its last line`() {
        val tall = (1..400).joinToString("\n") { "line $it" }
        val items = bubbles(5) + ChatItem.Bubble("tall", "assistant", tall)
        val state = androidx.compose.foundation.lazy.LazyListState()
        compose.setContent { ReadOnlyTranscript(items, "t1", state) }
        compose.waitForIdle()
        assert(!state.canScrollForward) { "the view stopped above the end of the last message" }
    }
}
