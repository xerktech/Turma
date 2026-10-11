package com.xerktech.turma.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/** The question / permission sheet's height cap (`waitingSheetCap`): it must never cover the top bar. */
class WaitingSheetCapTest {
    @Test
    fun `portrait is capped at half the window`() {
        assertEquals(457.dp, waitingSheetCap(914.dp, 88.dp, 140.dp))
    }

    @Test
    fun `landscape leaves the measured top bar and footer clear`() {
        // 411dp window, 64dp top bar, 140dp footer: the sheet gets what is left.
        val cap = waitingSheetCap(411.dp, 64.dp, 140.dp)
        assertEquals(411.dp - 64.dp - 140.dp - CHAT_SHEET_GAP, cap)
    }

    @Test
    fun `a large font scale shrinks the cap with the bars it measured`() {
        // At font scale 2.0 the bars roughly double — a fixed reserve covered the top bar here.
        val big = waitingSheetCap(411.dp, 100.dp, 230.dp)
        assertEquals(411.dp - 100.dp - 230.dp - CHAT_SHEET_GAP, big)
    }

    @Test
    fun `it never collapses below the floor`() {
        assertEquals(CHAT_SHEET_MIN, waitingSheetCap(300.dp, 120.dp, 260.dp))
    }
}
