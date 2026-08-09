package com.xerktech.turma.core

import com.xerktech.turma.model.SendFile
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

    // ---- XERK-235: the wire shape the hub actually sends --------------------
    //
    // toolEntry() above puts the tool_use and its tool_result in ONE entry, and
    // the hub never emits that. `_entry_blocks` puts a call's result in the
    // NEXT, user-role entry — turma/tests/chat.test.js asserts it in as many
    // words ("The tool_result lands in the NEXT (user-role) entry — it must
    // fold into the action card above"). buildItems paired within one entry, so
    // against real data every tool card rendered EMPTY with a duplicate "result"
    // card beside it, and this fixture is why no test noticed.

    private fun realWireEntries() = listOf(
        TailEntry(id = "u0", role = "user", blocks = listOf(TextBlock("run ls"))),
        TailEntry(
            id = "a1", role = "assistant",
            blocks = listOf(
                TextBlock("sure"),
                ToolUseBlock(id = "t1", name = "Bash", input = buildJsonObject { put("command", "ls") }),
            ),
        ),
        TailEntry(id = "r1", role = "user", blocks = listOf(ToolResultBlock(forId = "t1", text = "file.txt"))),
    )

    @Test fun `a result in the NEXT entry folds into its card, not a second one`() {
        val items = buildItems(realWireEntries(), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        val tools = items.filterIsInstance<ChatItem.Tool>()
        assertEquals(1, tools.size)
        assertEquals("Bash", tools[0].name)
        assertEquals("file.txt", tools[0].result)
        // And no user bubble was produced for the tool_result-only turn.
        assertTrue(items.filterIsInstance<ChatItem.Bubble>().none { it.text == "file.txt" })
    }

    @Test fun `a Skill's second result under one id wins, as the web's last-wins does`() {
        val items = buildItems(
            listOf(
                TailEntry(id = "a1", role = "assistant",
                    blocks = listOf(ToolUseBlock(id = "s1", name = "Skill"))),
                TailEntry(id = "r1", role = "user",
                    blocks = listOf(ToolResultBlock(forId = "s1", text = "Launching skill: verify"))),
                TailEntry(id = "r2", role = "user",
                    blocks = listOf(ToolResultBlock(forId = "s1", text = "THE BODY"))),
            ),
            VerbosityPrefs.forPreset(Verbosity.NORMAL),
        )
        val tools = items.filterIsInstance<ChatItem.Tool>()
        assertEquals(1, tools.size)
        assertEquals("THE BODY", tools[0].result)
    }

    @Test fun `a result whose call is nowhere still renders, so nothing is dropped`() {
        val items = buildItems(
            listOf(TailEntry(id = "r1", role = "user",
                blocks = listOf(ToolResultBlock(forId = "gone", text = "orphaned output")))),
            VerbosityPrefs.forPreset(Verbosity.NORMAL),
        )
        val tools = items.filterIsInstance<ChatItem.Tool>()
        assertEquals(1, tools.size)
        assertEquals("orphaned output", tools[0].result)
    }

    @Test fun `consecutive text blocks are one bubble, as the web concatenates`() {
        val items = buildItems(
            listOf(TailEntry(id = "a1", role = "assistant",
                blocks = listOf(TextBlock("Hello "), TextBlock("world")))),
            VerbosityPrefs.forPreset(Verbosity.NORMAL),
        )
        val bubbles = items.filterIsInstance<ChatItem.Bubble>()
        assertEquals(1, bubbles.size)
        assertEquals("Hello world", bubbles[0].text)
    }

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

    @Test fun `SendUserFile files and caption ride onto the tool item (XERK-221)`() {
        val e = TailEntry(
            id = "e5", role = "assistant",
            blocks = listOf(
                ToolUseBlock(
                    id = "t9", name = "SendUserFile",
                    files = listOf(
                        SendFile(name = "a.svg", kind = "image", src = "data:image/svg+xml;base64,PHN2Zy8+"),
                        SendFile(name = "p.html", kind = "html", html = "<h1>Hi</h1>"),
                        SendFile(name = "big.zip", kind = "file"),
                    ),
                    caption = "the set",
                ),
            ),
        )
        val tool = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
            .filterIsInstance<ChatItem.Tool>().single()
        assertEquals("SendUserFile", tool.name)
        assertEquals("the set", tool.caption)
        assertEquals(listOf("image", "html", "file"), tool.files.map { it.kind })
        assertEquals("a.svg", tool.files[0].name)
        // A file DELIVERY shows even in Concise (which hides ordinary tool cards),
        // since it's user-facing content, not a tool mechanic.
        val concise = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.CONCISE))
            .filterIsInstance<ChatItem.Tool>().single()
        assertEquals(3, concise.files.size)
        // A file-less tool call is still hidden by Concise.
        val bash = TailEntry(id = "e6", role = "assistant", blocks = listOf(ToolUseBlock(id = "b1", name = "Bash")))
        assertTrue(buildItems(listOf(bash), VerbosityPrefs.forPreset(Verbosity.CONCISE)).none { it is ChatItem.Tool })
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

    @Test fun `an orphan result with EMPTY text still renders, as the web does`() {
        // chat.js pushes the card and renders "(no output)"; an isNotBlank()
        // guard here dropped it. The last divergence of 14 wire cases (XERK-235).
        val e = TailEntry(id = "e9", role = "user",
            blocks = listOf(ToolResultBlock(forId = "gone", text = "")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals(1, items.filterIsInstance<ChatItem.Tool>().size)
    }

    @Test fun `orphan tool_result is kept when outputs are shown`() {
        val e = TailEntry(id = "e5", role = "assistant", blocks = listOf(ToolResultBlock(forId = "gone", text = "leftover")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals("leftover", items.filterIsInstance<ChatItem.Tool>().single().result)
    }
}
