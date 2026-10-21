package com.xerktech.turma.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.ChatItem
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A command card's output, open or collapsed by default (rollup XERK-2109), at parity
 * with chat.js: a `!` command's output is open beneath its bubble (renderBashCard),
 * while a `/slash` command's — and an output whose command is outside the window
 * ("› output") — is a `<details>` collapsed by default (renderCommandCard,
 * openAttr(key, false)). Android drew both of the latter open.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TranscriptCommandTest {

    @get:Rule
    val compose = createComposeRule()

    @Test fun `a slash command's output is collapsed until its chip is tapped`() {
        compose.setContent { ChatItemView(ChatItem.Command("c1", "/cost", "", result = "Total cost: \$0.12")) }
        compose.onAllNodesWithText("Total cost: \$0.12").assertCountEquals(0)
        compose.onNodeWithText("› /cost").performClick()
        compose.onNodeWithText("Total cost: \$0.12").assertIsDisplayed()
        compose.onNodeWithText("› /cost").performClick()
        compose.onAllNodesWithText("Total cost: \$0.12").assertCountEquals(0)
    }

    @Test fun `an output whose command is outside the window is collapsed too`() {
        compose.setContent { ChatItemView(ChatItem.Command("o1", "output", "", result = "hello")) }
        compose.onAllNodesWithText("hello").assertCountEquals(0)
        compose.onNodeWithText("› output").performClick()
        compose.onNodeWithText("hello").assertIsDisplayed()
    }

    @Test fun `a bang command's output stays open beneath it`() {
        compose.setContent { ChatItemView(ChatItem.Command("b1", "!", "ls", result = "README.md")) }
        compose.onNodeWithText("README.md").assertIsDisplayed()
    }
}
