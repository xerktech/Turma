package com.xerktech.turma.ui

import com.xerktech.turma.vm.UsageViewModel
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `fmtTokens` has to agree DIGIT FOR DIGIT with the web's (`turma/public/
 * usage.html`, mirrored in `index.html`): the same fleet totals head the web
 * Usage page and the Android Usage screen, and an operator reading 1.1k in the
 * browser and 1.2k on the phone can't tell which is wrong.
 *
 * The vectors below are shared with `turma/tests/usage.test.js` — change one
 * side and this fails, which is the point.
 */
class FmtTokensTest {

    @After fun restoreLocale() = Locale.setDefault(Locale.US)

    @Test fun `the tenth rounds half-up on the exact value`() {
        // `"%.1f".format(n / 1e3)` rounds a Double, and JS `toFixed` rounds the
        // binary value; they disagreed on every .x5 boundary. Integer
        // arithmetic gives one answer for both.
        assertEquals("1.2k", fmtTokens(1_150))
        assertEquals("1.5M", fmtTokens(1_450_000))
        assertEquals("2.0B", fmtTokens(1_950_000_000))
    }

    @Test fun `a tenth that rounds up out of its remainder carries`() {
        assertEquals("1000.0k", fmtTokens(999_950))
        assertEquals("1000.0M", fmtTokens(999_950_000))
    }

    @Test fun `the ordinary scales are unchanged`() {
        assertEquals("0", fmtTokens(0))
        assertEquals("850", fmtTokens(850))
        assertEquals("3.4k", fmtTokens(3_400))
        assertEquals("272.5M", fmtTokens(272_500_000))
        assertEquals("11.3B", fmtTokens(11_300_000_000))
    }

    @Test fun `the format does not follow the device locale`() {
        // A German or Egyptian phone rendered "1,2k" and "١٫٢k" while the
        // browser rendered "1.2k" — the same fleet, two different figures.
        for (locale in listOf(Locale.US, Locale.GERMANY, Locale.FRANCE, Locale("ar", "EG"))) {
            Locale.setDefault(locale)
            assertEquals("locale $locale", "1.2k", fmtTokens(1_150))
        }
    }

    @Test fun `the unit boundary is inclusive, as it is on the web`() {
        // `>` instead of `>=` here renders 1000 as "1000" against the browser's
        // "1.0k" — a divergence at exactly the value most looked at, and one no
        // other assertion in this class would notice.
        assertEquals("1.0k", fmtTokens(1_000))
        assertEquals("1.0M", fmtTokens(1_000_000))
        assertEquals("1.0B", fmtTokens(1_000_000_000))
        assertEquals("999", fmtTokens(999))
    }

    @Test fun `an absurd count off the wire neither overflows nor throws`() {
        // The hub serves most of the agent payload raw, so a nonsense figure
        // has to render as a big number rather than wrap to a negative one.
        assertTrue(fmtTokens(Long.MAX_VALUE).endsWith("B"))
        assertTrue(fmtTokens(Long.MAX_VALUE).startsWith("9223372036"))
        assertEquals("-5", fmtTokens(-5))
    }

    @Test fun `the sub-agent windows do not follow the device locale`() {
        // These render on the SAME LINE as a token count, so a locale leaking
        // into one and not the other is a single line disagreeing with itself.
        // Ungated until subagentWindows was lifted out of the Composable.
        // The pct properties are derived: 100 of 1000 spent is 10.0% a window.
        val split = UsageViewModel.SubagentSplit(
            today = 100, week = 100, total = 100,
            ofToday = 1_000, ofWeek = 1_000, ofTotal = 1_000,
            reporting = 1, hosts = 1,
        )
        for (locale in listOf(Locale.US, Locale.GERMANY, Locale("ar", "EG"))) {
            Locale.setDefault(locale)
            assertEquals(
                "locale $locale",
                listOf("today 10.0%", "7d 10.0%", "all-time 10.0%"),
                subagentWindows(split),
            )
        }
    }

    @Test fun `the capture-age stamp does not follow the device locale`() {
        // "%dh %02dm" renders Arabic-Indic digits under ar-EG, beside a
        // subscription percentage that does not.
        for (locale in listOf(Locale.US, Locale.GERMANY, Locale("ar", "EG"))) {
            Locale.setDefault(locale)
            assertEquals("locale $locale", "2h 05m", UsageViewModel.fmtDuration(7_500))
        }
    }
}
