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

    private fun inks(dark: Boolean): List<String> {
        var out = emptyList<Color>()
        compose.setContent {
            TurmaTheme(darkTheme = dark) { out = listOf(pillInk(TurmaColors.warning), pillInk(TurmaColors.good)) }
        }
        compose.waitForIdle()
        return out.map(::hex)
    }

    // An amber pill is tinted with the fill but reads in the amber text colour; other
    // fills are their own ink (rollup XERK-1701, QA batch 29).
    @Test fun `an amber pill reads in the amber text colour in light`() {
        assertEquals(listOf("#8A5A00", "#12A312"), inks(dark = false))
    }

    @Test fun `an amber pill keeps the amber fill as its ink in dark`() {
        assertEquals(listOf("#FAB219", "#12A312"), inks(dark = true))
    }

    @Test fun `light keeps the fills and steps amber down, as the web's light tokens`() {
        assertEquals(listOf("#12A312", "#2A78D6", "#D03B3B", "#8A5A00"), colors(dark = false).map(::hex))
    }

    private fun series(dark: Boolean): List<String> {
        var out = emptyList<Color>()
        compose.setContent { TurmaTheme(darkTheme = dark) { out = TurmaColors.series() } }
        compose.waitForIdle()
        return out.map(::hex)
    }

    // Org tints and chart lines read the web's --s1..--s8 for the theme (rollup
    // XERK-1701): light used the dark-stepped set, a shade off every web org card.
    @Test fun `light org and chart slots are the web's light --s1 to --s8`() {
        assertEquals(
            listOf("#2A78D6", "#1BAF7A", "#EDA100", "#008300", "#4A3AA7", "#E34948", "#E87BA4", "#EB6834"),
            series(dark = false),
        )
    }

    @Test fun `dark org and chart slots keep the dark-stepped set`() {
        assertEquals(
            listOf("#3987E5", "#199E70", "#C98500", "#2E9E2E", "#9085E9", "#E66767", "#D55181", "#D95926"),
            series(dark = true),
        )
    }
}
