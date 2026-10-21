package com.xerktech.turma.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [proseImageSize] — the box an inline prose image takes once its ratio is known
 * (XERK-1858). Measured inside a `height(IntrinsicSize.Min)` row, the table-cell
 * shape whose intrinsic query used to read the full cell width and make the row
 * several times taller than the image.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProseImageSizeTest {

    @get:Rule
    val compose = createComposeRule()

    private fun inRow(ratio: Float, natural: Dp, rowWidth: Dp = 300.dp, inset: Dp = 0.dp) {
        compose.setContent {
            Row(Modifier.width(rowWidth).height(IntrinsicSize.Min).testTag("row")) {
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    Box(Modifier.testTag("img").proseImageSize(ratio, natural, 320.dp, inset))
                }
            }
        }
    }

    @Test fun `a small image in an intrinsic-height row keeps the row its own height`() {
        inRow(ratio = 2f, natural = 40.dp)
        compose.onNodeWithTag("img").assertWidthIsEqualTo(40.dp).assertHeightIsEqualTo(20.dp)
        compose.onNodeWithTag("row").assertHeightIsEqualTo(20.dp)
    }

    @Test fun `a wide image narrows to the space offered, keeping its ratio`() {
        inRow(ratio = 2f, natural = 1000.dp)
        compose.onNodeWithTag("img").assertWidthIsEqualTo(300.dp).assertHeightIsEqualTo(150.dp)
        compose.onNodeWithTag("row").assertHeightIsEqualTo(150.dp)
    }

    // Rollup XERK-2148: an SVG's 12dp of padding sits inside the box. Sized by the box's
    // ratio, a 1:10 SVG got a 32 x 320 box whose 20 x 308 content drew it 200dp tall.
    @Test fun `a padded image keeps its ratio inside the padding and still reaches the cap`() {
        inRow(ratio = 0.1f, natural = 1000.dp, inset = 12.dp)
        compose.onNodeWithTag("img").assertWidthIsEqualTo(43.dp).assertHeightIsEqualTo(320.dp)
    }

    @Test fun `a padded image narrowed by the row keeps its content's ratio`() {
        inRow(ratio = 2f, natural = 1000.dp, inset = 12.dp)
        compose.onNodeWithTag("img").assertWidthIsEqualTo(300.dp).assertHeightIsEqualTo(156.dp)
    }

    @Test fun `a tall image is capped at the max height and narrowed to match`() {
        inRow(ratio = 0.5f, natural = 400.dp)
        compose.onNodeWithTag("img").assertWidthIsEqualTo(160.dp).assertHeightIsEqualTo(320.dp)
    }
}
