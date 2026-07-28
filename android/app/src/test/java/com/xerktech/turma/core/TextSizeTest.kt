package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TextSizeTest {

    @Test fun mediumIsTheDefaultAndUnscaled() {
        assertEquals(TextSize.MEDIUM, TextSize.DEFAULT)
        assertEquals(1.0f, TextSize.MEDIUM.scale)
    }

    @Test fun scalesRunSmallToLargeMonotonically() {
        val scales = TextSize.entries.map { it.scale }
        assertEquals(scales.sorted(), scales) // enum order == ascending size
        assertTrue(TextSize.SMALL.scale < 1.0f)
        assertTrue(TextSize.LARGE.scale > 1.0f)
        assertTrue(TextSize.XLARGE.scale > TextSize.LARGE.scale)
    }

    @Test fun fromOrdinalRoundTrips() {
        TextSize.entries.forEach { assertEquals(it, TextSize.fromOrdinal(it.ordinal)) }
    }

    @Test fun fromOrdinalDefaultsJunk() {
        assertEquals(TextSize.DEFAULT, TextSize.fromOrdinal(-1))
        assertEquals(TextSize.DEFAULT, TextSize.fromOrdinal(99))
    }
}
