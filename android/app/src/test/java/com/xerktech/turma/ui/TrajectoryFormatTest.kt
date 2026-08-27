package com.xerktech.turma.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Trajectory formatters (XERK-498) — the Android ports of web `trajMs` /
 * `trajNum` (`sessions.html`). Cases avoid the fractional-second and
 * thousands-grouped branches on purpose so the assertions stay locale-robust:
 * both use the JVM default locale's separators, which the CI runner's locale
 * must not be able to flip.
 */
class TrajectoryFormatTest {

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
}
