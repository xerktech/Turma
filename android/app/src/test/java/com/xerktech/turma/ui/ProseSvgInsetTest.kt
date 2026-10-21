package com.xerktech.turma.ui

import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.unit.dp
import com.xerktech.turma.core.ChatItem
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The CALL SITE of [proseImageSize]'s inset (rollup XERK-2148): a prose SVG sits
 * on 6dp of padding, so its box adds 12dp to the ratio's size. `ProseImageSizeTest`
 * pins the modifier; this pins that `ProseImage` passes the inset for an SVG.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ProseSvgInsetTest {

    @get:Rule
    val compose = createComposeRule()

    @Test fun `a tall prose svg's box adds its padding and reaches the cap`() {
        compose.setContent {
            ChatItemView(ChatItem.Bubble("a1", "assistant",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 10\"><rect width=\"1\" height=\"10\"/></svg>"))
        }
        // A wide placeholder box first (full width x 120dp); the tall ratio box once
        // the SVG decodes.
        compose.waitUntil(10_000) {
            runCatching { compose.onNodeWithContentDescription("image").fetchSemanticsNode().size.let { it.height > it.width * 3 } }
                .getOrDefault(false)
        }
        // 1:10 content 30.8 x 308 + 12dp of padding: 43 x 320. Without the inset the
        // box was 32 x 320, and its padded content drew the SVG 200dp tall.
        compose.onNodeWithContentDescription("image").assertWidthIsEqualTo(43.dp).assertHeightIsEqualTo(320.dp)
    }
}
