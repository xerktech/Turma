package com.xerktech.turma.ui

import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.xerktech.turma.core.ChatItem
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A bare `>` line is an EMPTY quote on both clients (XERK-1858). The web's
 * `.md-quote` keeps its 1px top/bottom padding, so its rule still shows; without
 * the same padding here the quote measured 0dp and vanished.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TranscriptQuoteTest {

    @get:Rule
    val compose = createComposeRule()

    @Test fun `an empty quote keeps the web's padding, so its rule shows`() {
        compose.setContent { ChatItemView(ChatItem.Bubble("a1", "assistant", "a\n>\nb")) }
        compose.onNodeWithTag("md-quote").assertHeightIsEqualTo(2.dp)
    }
}
