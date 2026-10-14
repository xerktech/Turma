package com.xerktech.turma.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createComposeRule
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.ui.theme.TurmaTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Status TEXT colours, per theme, as the web's app.css `--*-text` tokens (rollup
 * XERK-1701, #57). The Sessions card's state line used the fill colours in both
 * themes, under 4.5:1 as small text on the dark surface; reverting a `*Text()`
 * back to its fill left every other test green, so this pins the values.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class StatusTextColorsTest {

    @get:Rule
    val compose = createComposeRule()

    private fun colors(dark: Boolean): List<Color> {
        var out = emptyList<Color>()
        compose.setContent {
            TurmaTheme(darkTheme = dark) {
                out = listOf(TurmaColors.workingText(), TurmaColors.reviewText(),
                    TurmaColors.criticalText(), TurmaColors.waitingText())
            }
        }
        compose.waitForIdle()
        return out
    }

    private fun hex(c: Color) = "#%06X".format(c.toArgb() and 0xFFFFFF)

    @Test fun `dark steps the status text up, as --good-text, --accent-text, --critical-text`() {
        assertEquals(listOf("#4CC94C", "#78AEF2", "#F08080", "#FAB219"), colors(dark = true).map(::hex))
    }

    @Test fun `light keeps the fills and steps amber down, as the web's light tokens`() {
        assertEquals(listOf("#12A312", "#2A78D6", "#D03B3B", "#8A5A00"), colors(dark = false).map(::hex))
    }
}
