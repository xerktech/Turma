package com.xerktech.turma.core

import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TaskNotificationBlock
import com.xerktech.turma.model.TextBlock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parity with turma/public/chat.js mergeTail/weight (the web source of truth). */
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

    @Test fun `mergeTail lets a lighter rich copy replace a text-only one`() {
        // chat.js's `incHasBlocks && !curHasBlocks` arm: the rich live copy must
        // win the stored flat preview even when the weight compare alone loses.
        val base = mergeTail(emptyList(), listOf(e("1", "assistant", "a much longer flat preview")))
        val rich = TailEntry(id = "1", role = "assistant", text = "hi", blocks = listOf(TextBlock("hi")))
        val merged = mergeTail(base, listOf(rich))
        assertTrue(merged[0].blocks.isNotEmpty())
    }

    @Test fun `entryWeight counts task notification payload fields`() {
        val note = TailEntry(
            id = "1", role = "assistant",
            blocks = listOf(TaskNotificationBlock(summary = "build", status = "done", result = "ok")),
        )
        assertEquals("build".length + "done".length + "ok".length, entryWeight(note))
    }

    @Test fun `prependHistory upgrades a truncated preview to history's fuller copy`() {
        // The XERK-77 cutoff: the 500-char heartbeat seed (or the live tail's
        // cap-clipped blocks) must not block /history's full copy.
        val live = listOf(e("2", "assistant", "cut off mid sen"), e("3", "assistant", "c"))
        val (merged, hasMore) = prependHistory(
            live,
            listOf(e("1", "user", "a"), e("2", "assistant", "cut off mid sentence no more")),
            truncated = true,
        )
        assertEquals(listOf("1", "2", "3"), merged.map { it.key })
        assertEquals("cut off mid sentence no more", merged[1].text) // fuller history copy wins
        assertTrue(hasMore)
    }

    @Test fun `prependHistory keeps a live copy heavier than history's`() {
        val live = listOf(e("2", "assistant", "the full live text"))
        val (merged, _) = prependHistory(live, listOf(e("2", "assistant", "the full")), truncated = false)
        assertEquals("the full live text", merged[0].text)
    }

    @Test fun `prependHistory seeds order from history and appends newer live keys`() {
        val live = listOf(e("3", "assistant", "newest live"))
        val (merged, _) = prependHistory(live, listOf(e("1", "user", "a"), e("2", "assistant", "b")), truncated = false)
        assertEquals(listOf("1", "2", "3"), merged.map { it.key })
    }

    @Test fun `entryTruncated flags a cap-clipped block`() {
        val clipped = TailEntry(id = "1", role = "assistant", blocks = listOf(TextBlock("x", truncated = true)))
        assertTrue(entryTruncated(clipped))
        assertFalse(entryTruncated(e("2", "assistant", "whole")))
        assertFalse(entryTruncated(TailEntry(id = "3", role = "assistant", blocks = listOf(TextBlock("whole")))))
    }

    @Test fun `mergeTail ignores empty deltas`() {
        val base = mergeTail(emptyList(), listOf(e("1", "user", "hi")))
        assertEquals(base, mergeTail(base, emptyList()))
    }
}
