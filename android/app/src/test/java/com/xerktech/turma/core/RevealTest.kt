package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parity with glasses/src/reveal.test.ts. */
class RevealTest {

    @Test fun `empty target shows nothing`() {
        assertEquals(RevealState("e1", 0), advanceReveal(RevealState(), "e1", 0, 100, live = false))
    }

    @Test fun `committed entry with a new id snaps to full`() {
        val s = advanceReveal(RevealState("old", 5), "new", 40, 80, live = false)
        assertEquals(RevealState("new", 40), s)
    }

    @Test fun `live turn with a new id types from zero`() {
        // target 100 stays under the 200-char snap threshold, so it types.
        val s = advanceReveal(RevealState("old", 5), "turn", 100, 100, live = true)
        // rate 150cps * 0.1s = 15 chars
        assertEquals(15, s.shown)
        assertEquals("turn", s.entryId)
    }

    @Test fun `same entry types incrementally toward target`() {
        val s = advanceReveal(RevealState("e", 10), "e", 100, 200, live = false)
        // base 10 + floor(150*0.2)=30 -> 40
        assertEquals(40, s.shown)
    }

    @Test fun `a large backlog snaps instead of animating`() {
        val s = advanceReveal(RevealState("e", 0), "e", 500, 20, live = false)
        assertEquals(500, s.shown) // backlog 500 > 200 snap threshold
    }

    @Test fun `dt zero re-anchors without typing`() {
        val s = advanceReveal(RevealState("e", 12), "e", 100, 0, live = false)
        assertEquals(RevealState("e", 12), s)
    }

    @Test fun `live base continues when new capture extends the revealed prefix`() {
        // Typed 10 of "hello world", now "hello world foo" — continues, keep 10.
        assertEquals(10, liveRevealBase("hello world", 10, "hello world foo"))
    }

    @Test fun `live base snaps when the pane scrape swaps to unrelated text`() {
        // Revealed 8 of "reading…" then the scrape swaps to a longer, unrelated
        // tool bullet — must snap to the new length, not type from offset 8.
        val swapped = "Bash(npm test) running the suite"
        assertEquals(swapped.length, liveRevealBase("reading…", 8, swapped))
    }

    @Test fun `live base snaps on a same-length but different capture`() {
        // Length-only clamps missed this: same length, different text.
        assertEquals(5, liveRevealBase("aaaaa", 5, "bbbbb"))
    }

    @Test fun `revealComplete when shown reaches target`() {
        assertTrue(revealComplete(RevealState("e", 40), 40))
        assertFalse(revealComplete(RevealState("e", 39), 40))
    }
}
