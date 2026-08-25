package com.xerktech.turma.core

import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The context-fullness meter's pure logic (XERK-489 Phase 4), the port of the
 *  web `contextMeterChip`/`contextMeterHtml`. */
class ContextMeterTest {

    private fun sess(source: String, num: Int?, den: Int?) = SessionInfo(
        id = "s", modelSource = source,
        lastTurnContextTokens = num, contextWindowTokens = den,
    )

    @Test fun `no reading until a turn is measured, or with no window`() {
        assertNull(ContextMeter.read(null))
        assertNull(ContextMeter.read(sess("local", null, 32768)))     // no numerator
        assertNull(ContextMeter.read(sess("local", 100, null)))       // no denominator
        assertNull(ContextMeter.read(sess("local", 0, 100)))          // nothing yet
    }

    @Test fun `a local reading is EXACT, a subscription one approximate`() {
        val local = ContextMeter.read(sess("local", 16384, 32768))!!
        assertEquals(50, local.pct)
        assertEquals(0.5f, local.fraction, 0.001f)
        assertEquals(false, local.approx)
        assertEquals(ContextMeter.Level.OK, local.level)
        // A subscription session has no agent-side window -> approximate.
        assertEquals(true, ContextMeter.read(sess("subscription", 100000, 200000))!!.approx)
    }

    @Test fun `thresholds warn at 85 and go danger near the 95 auto-compact`() {
        assertEquals(ContextMeter.Level.OK, ContextMeter.read(sess("local", 84, 100))!!.level)
        assertEquals(ContextMeter.Level.WARN, ContextMeter.read(sess("local", 85, 100))!!.level)
        assertEquals(ContextMeter.Level.WARN, ContextMeter.read(sess("local", 94, 100))!!.level)
        assertEquals(ContextMeter.Level.DANGER, ContextMeter.read(sess("local", 95, 100))!!.level)
    }

    @Test fun `the percent is clamped to 100`() {
        val over = ContextMeter.read(sess("local", 500, 100))!!
        assertEquals(100, over.pct)
        assertEquals(1.0f, over.fraction, 0.001f)
    }

    @Test fun `a huge numerator does not overflow the percent`() {
        // num * 100 must not overflow Int (the reason read() widens to Long).
        val big = ContextMeter.read(sess("local", 2_000_000_000, 2_000_000_000))!!
        assertEquals(100, big.pct)
    }
}
