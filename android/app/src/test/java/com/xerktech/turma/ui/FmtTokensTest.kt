package com.xerktech.turma.ui

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

    @Test fun `an absurd count off the wire neither overflows nor throws`() {
        // The hub serves most of the agent payload raw, so a nonsense figure
        // has to render as a big number rather than wrap to a negative one.
        assertTrue(fmtTokens(Long.MAX_VALUE).endsWith("B"))
        assertTrue(fmtTokens(Long.MAX_VALUE).startsWith("9223372036"))
        assertEquals("-5", fmtTokens(-5))
    }
}
