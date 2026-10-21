package com.xerktech.turma.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.xerktech.turma.core.ChatItem
import com.xerktech.turma.model.SendFile
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A SendUserFile image preview (rollup XERK-2148), web `renderToolFiles` parity:
 * only a data:image/ or http(s) src is previewed, and one that fails to decode
 * shows its name as alt text — never a blank white box.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SendFilePreviewTest {

    @get:Rule
    val compose = createComposeRule()

    private fun show(file: SendFile) = compose.setContent {
        ChatItemView(ChatItem.Tool("a1", name = "SendUserFile", input = "", result = "", isError = false, files = listOf(file)))
    }

    @Test fun `an image that fails to decode shows its name as alt text`() {
        // Declared a PNG, holding no PNG: broken, as on the web.
        show(SendFile(name = "shot.png", kind = "image", src = "data:image/png;base64,QUJD"))
        compose.waitUntil(10_000) { compose.onAllNodesWithText("🖼 shot.png").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("🖼 shot.png").assertIsDisplayed()
    }

    @Test fun `a data src that is no data image is a name chip, never sniffed`() {
        show(SendFile(name = "x.svg", kind = "image",
            src = "data:,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/%3E"))
        compose.onNodeWithText("📎 x.svg").assertIsDisplayed()
    }
}
