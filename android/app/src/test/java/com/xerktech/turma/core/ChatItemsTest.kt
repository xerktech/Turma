package com.xerktech.turma.core

import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TextBlock
import com.xerktech.turma.model.ThinkingBlock
import com.xerktech.turma.model.ToolResultBlock
import com.xerktech.turma.model.ToolUseBlock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatItemsTest {

    private fun toolEntry() = TailEntry(
        id = "e1", role = "assistant",
        blocks = listOf(
            TextBlock("Running a command"),
            ToolUseBlock(id = "t1", name = "Bash", input = buildJsonObject { put("command", "ls") }),
            ToolResultBlock(forId = "t1", text = "a\nb\nc"),
        ),
    )

    @Test fun `concise hides tools and thinking, keeps text`() {
        val items = buildItems(listOf(toolEntry()), VerbosityPrefs.forPreset(Verbosity.CONCISE))
        assertEquals(1, items.size)
        assertTrue(items[0] is ChatItem.Bubble)
        assertEquals("Running a command", (items[0] as ChatItem.Bubble).text)
    }

    @Test fun `normal shows the tool card with its paired result`() {
        val items = buildItems(listOf(toolEntry()), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        val tool = items.filterIsInstance<ChatItem.Tool>().single()
        assertEquals("Bash", tool.name)
        assertTrue(tool.input.contains("command: ls"))
        assertEquals("a\nb\nc", tool.result)
    }

    @Test fun `verbose adds thinking traces`() {
        val e = TailEntry(id = "e2", role = "assistant", blocks = listOf(ThinkingBlock("hmm"), TextBlock("answer")))
        val normal = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertTrue(normal.none { it is ChatItem.Thinking })
        val verbose = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.VERBOSE))
        assertTrue(verbose.any { it is ChatItem.Thinking })
    }

    @Test fun `text-only entry with no blocks becomes a bubble`() {
        val e = TailEntry(id = "e3", role = "user", text = "hello")
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals(ChatItem.Bubble("e3", "user", "hello"), items.single())
    }

    @Test fun `reveal length only clamps the newest bubble`() {
        val e = TailEntry(id = "e4", role = "assistant", text = "abcdefghij")
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL), revealNewestId = "e4", revealShown = 4)
        assertEquals(4, (items.single() as ChatItem.Bubble).revealLen)
    }

    @Test fun `orphan tool_result is kept when outputs are shown`() {
        val e = TailEntry(id = "e5", role = "assistant", blocks = listOf(ToolResultBlock(forId = "gone", text = "leftover")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals("leftover", items.filterIsInstance<ChatItem.Tool>().single().result)
    }
}
