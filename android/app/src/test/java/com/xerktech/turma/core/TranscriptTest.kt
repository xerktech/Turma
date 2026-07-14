package com.xerktech.turma.core

import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TextBlock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parity with glasses/src/transcript.test.ts. */
class TranscriptTest {

    private fun e(id: String, role: String, text: String) = TailEntry(id = id, role = role, text = text)

    @Test fun `mergeTail appends new ids in order`() {
        val a = mergeTail(emptyList(), listOf(e("1", "user", "hi"), e("2", "assistant", "yo")))
        assertEquals(listOf("1", "2"), a.map { it.key })
    }

    @Test fun `mergeTail grows an entry but never shrinks it`() {
        val base = mergeTail(emptyList(), listOf(e("1", "assistant", "full answer here")))
        val shorter = mergeTail(base, listOf(e("1", "assistant", "full")))
        assertEquals("full answer here", shorter[0].text) // shorter preview ignored
        val longer = mergeTail(base, listOf(e("1", "assistant", "full answer here plus more")))
        assertEquals("full answer here plus more", longer[0].text)
    }

    @Test fun `mergeTail prefers a rich blocks copy over a text-only one`() {
        val flat = mergeTail(emptyList(), listOf(e("1", "assistant", "hi")))
        val rich = TailEntry(id = "1", role = "assistant", text = "hi", blocks = listOf(TextBlock("hi there friend")))
        val merged = mergeTail(flat, listOf(rich))
        assertTrue(merged[0].blocks.isNotEmpty())
    }

    @Test fun `conciseText strips tool markers from assistant only`() {
        assertEquals("done", conciseText("assistant", "done [Bash] [Read]"))
        assertEquals("keep [Bash]", conciseText("user", "keep [Bash]"))
    }

    @Test fun `prependHistory drops already-known ids and flags more`() {
        val live = listOf(e("2", "user", "b"), e("3", "assistant", "c"))
        val (merged, hasMore) = prependHistory(live, listOf(e("1", "user", "a"), e("2", "user", "dup")), truncated = true)
        assertEquals(listOf("1", "2", "3"), merged.map { it.key })
        assertEquals("b", merged[1].text) // live copy kept, not the history dup
        assertTrue(hasMore)
    }

    @Test fun `mergeTail ignores empty deltas`() {
        val base = mergeTail(emptyList(), listOf(e("1", "user", "hi")))
        assertEquals(base, mergeTail(base, emptyList()))
    }
}
