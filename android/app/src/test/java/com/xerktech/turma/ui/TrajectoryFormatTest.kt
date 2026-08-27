package com.xerktech.turma.ui

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.Locale

/**
 * The Trajectory formatters (XERK-498) — the Android ports of web `trajMs` /
 * `trajNum` (`sessions.html`). They use the JVM default locale's separators
 * (like the web's `toLocaleString`), so the tests pin the locale to US rather
 * than letting the CI runner's default flip a "," to a "." under them.
 */
class TrajectoryFormatTest {

    private var savedLocale: Locale = Locale.getDefault()

    @Before
    fun pinLocale() {
        savedLocale = Locale.getDefault()
        Locale.setDefault(Locale.US)
    }

    @After
    fun restoreLocale() {
        Locale.setDefault(savedLocale)
    }

    @Test
    fun `trajMs formats sub-second, seconds and minutes`() {
        assertEquals("500ms", trajMs(500.0))
        assertEquals("45s", trajMs(45_000.0))
        assertEquals("1m30s", trajMs(90_000.0))
        // Seconds pad to two digits inside a minute.
        assertEquals("2m05s", trajMs(125_000.0))
    }

    @Test
    fun `trajMs is empty for a nonsense duration`() {
        assertEquals("", trajMs(-5.0))
        assertEquals("", trajMs(Double.NaN))
    }

    @Test
    fun `trajNum floors a negative to zero`() {
        assertEquals("0", trajNum(0))
        assertEquals("0", trajNum(-3))
        assertEquals("42", trajNum(42))
    }

    @Test
    fun `trajNum does not narrow a Long token count through Int`() {
        // A cache-token count can exceed Int.MAX_VALUE; the Long overload must
        // render it in full rather than truncating.
        assertEquals("3,000,000,000", trajNum(3_000_000_000L))
    }
}
