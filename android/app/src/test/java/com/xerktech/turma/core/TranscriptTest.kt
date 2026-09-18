package com.xerktech.turma.core

import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TaskNotificationBlock
import com.xerktech.turma.model.SendFile
import com.xerktech.turma.model.TextBlock
import com.xerktech.turma.model.ToolUseBlock
import org.junit.Assert.assertEquals
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

    @Test fun `prependHistory keeps history's older head and trails newer live keys`() {
        val live = listOf(e("3", "assistant", "newest live"))
        val (merged, _) = prependHistory(live, listOf(e("1", "user", "a"), e("2", "assistant", "b")), truncated = false)
        assertEquals(listOf("1", "2", "3"), merged.map { it.key })
    }

    @Test fun `prependHistory never drops the grow-only buffer's pre-window entries to the bottom`() {
        // The regression (worst on mobile, where the poll fallback reloads on every
        // socket drop): the live buffer accumulates from open and outgrows the
        // bounded history window, so mergeTail(history, buffer) appended those
        // pre-window entries BELOW history — older text out of order.
        val buffer = listOf("1", "2", "3", "4", "5").map { e(it, "assistant", it) }
        val historyWindow = listOf("3", "4", "5").map { e(it, "assistant", it) }
        // Old behavior scrambled: [3,4,5,1,2].
        assertEquals(listOf("3", "4", "5", "1", "2"), mergeTail(historyWindow, buffer).map { it.key })
        // Fixed: transcript order preserved.
        val (merged, _) = prependHistory(buffer, historyWindow, truncated = false)
        assertEquals(listOf("1", "2", "3", "4", "5"), merged.map { it.key })
    }

    @Test fun `mergeTail ignores empty deltas`() {
        val base = mergeTail(emptyList(), listOf(e("1", "user", "hi")))
        assertEquals(base, mergeTail(base, emptyList()))
    }

    /**
     * Parity with chat.js `weight`, which counts a tool_use block's files and
     * caption. A heartbeat PREVIEW block omits every _tool_use_detail field, so
     * without them a preview TIES the rich copy carrying inline SendUserFile
     * previews and the `>=` tie-break swaps them off the card. This bites
     * harder here than on the web: ChatViewModel re-merges the fleet seed on
     * EVERY poll, so the tie is reachable on every beat rather than only in a
     * view held open.
     */
    @Test fun `a preview tool_use never clobbers one carrying file previews`() {
        val rich = TailEntry(id = "1", role = "assistant", text = "", blocks = listOf(
            ToolUseBlock(id = "t1", name = "SendUserFile", caption = "the chart",
                files = listOf(SendFile(name = "chart.png", kind = "image", src = "data:image/png;base64,AAAA"))),
        ))
        val preview = TailEntry(id = "1", role = "assistant", text = "", blocks = listOf(
            ToolUseBlock(id = "t1", name = "SendUserFile"),
        ))
        assertTrue("the file preview must outweigh the copy that omits it",
            entryWeight(rich) > entryWeight(preview))
        val merged = mergeTail(listOf(rich), listOf(preview))
        val block = merged[0].blocks[0] as ToolUseBlock
        assertEquals(1, block.files.size)
        assertEquals("the chart", block.caption)
    }
}
