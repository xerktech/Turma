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
import org.junit.Assert.assertFalse
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

    // XERK-347: a clipped block carries a static mark, the web's `.clipped` span
    // — no "Show more", on either client, because nothing holds a fuller copy.
    @Test fun `a clipped text block marks its bubble, an intact one does not`() {
        val prefs = VerbosityPrefs.forPreset(Verbosity.NORMAL)
        val clipped = buildItems(
            listOf(TailEntry(id = "a1", role = "assistant",
                blocks = listOf(TextBlock("Hello "), TextBlock("world", truncated = true)))),
            prefs,
        ).filterIsInstance<ChatItem.Bubble>().single()
        assertTrue(clipped.clipped)
        val whole = buildItems(
            listOf(TailEntry(id = "a2", role = "assistant", blocks = listOf(TextBlock("all of it")))),
            prefs,
        ).filterIsInstance<ChatItem.Bubble>().single()
        assertFalse(whole.clipped)
    }

    @Test fun `a clipped tool RESULT marks its card`() {
        val items = buildItems(
            listOf(
                TailEntry(id = "a1", role = "assistant",
                    blocks = listOf(ToolUseBlock(id = "t1", name = "Bash", input = null))),
                TailEntry(id = "r1", role = "user",
                    blocks = listOf(ToolResultBlock(forId = "t1", text = "cut", truncated = true))),
            ),
            VerbosityPrefs.forPreset(Verbosity.NORMAL),
        )
        assertTrue(items.filterIsInstance<ChatItem.Tool>().single().clipped)
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

    // ---- XERK-860: hidden thinking folds into a counted marker --------------
    //
    // The web twin is chat.test.js "XERK-860: hidden thinking announces itself
    // but does NOT carry the trace". Hidden thinking used to render as nothing at
    // all here, so an elided turn read as a quiet one next to the terminal (which
    // always shows the trace). The marker is SUMMARY ONLY — the trace itself is
    // never carried at a verbosity that hides thinking, so it can't leak.

    private fun folds(items: List<ChatItem>) = items.filterIsInstance<ChatItem.FoldedThoughts>()

    @Test fun `hidden thinking folds into a counted marker without the trace`() {
        val e = TailEntry(id = "a1", role = "assistant",
            blocks = listOf(ThinkingBlock("SECRET-TRACE"), TextBlock("done")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        // The elision is visible and counted, and nothing is a shown Thinking —
        // and the trace is structurally absent (FoldedThoughts carries a count,
        // no field that could hold "SECRET-TRACE").
        assertEquals(1, folds(items).single().count)
        assertTrue(items.none { it is ChatItem.Thinking })
        // The rest of the turn still renders, AFTER the marker (web order).
        assertEquals("done", items.filterIsInstance<ChatItem.Bubble>().single().text)
        assertTrue(items.indexOfFirst { it is ChatItem.FoldedThoughts } <
            items.indexOfFirst { it is ChatItem.Bubble })
    }

    @Test fun `two consecutive hidden thoughts fold into one marker`() {
        val e = TailEntry(id = "a2", role = "assistant",
            blocks = listOf(ThinkingBlock("x"), ThinkingBlock("y"), TextBlock("ok")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals(2, folds(items).single().count)
    }

    @Test fun `verbose reveals the trace and drops the folded marker`() {
        val e = TailEntry(id = "a3", role = "assistant",
            blocks = listOf(ThinkingBlock("SECRET-TRACE"), TextBlock("done")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.VERBOSE))
        assertEquals("SECRET-TRACE", items.filterIsInstance<ChatItem.Thinking>().single().text)
        assertTrue("nothing is hidden once shown", folds(items).isEmpty())
    }

    @Test fun `a shown tool between two hidden thoughts breaks the fold run`() {
        // NORMAL shows tool cards, so the tool is an item that ends the run — the
        // two thoughts do NOT fold together (would be one "2 thoughts" marker).
        val items = buildItems(
            listOf(
                TailEntry(id = "a4", role = "assistant", blocks = listOf(
                    ThinkingBlock("before"),
                    ToolUseBlock(id = "t1", name = "Bash"),
                    ThinkingBlock("after"),
                )),
                TailEntry(id = "r1", role = "user", blocks = listOf(ToolResultBlock(forId = "t1", text = "out"))),
            ),
            VerbosityPrefs.forPreset(Verbosity.NORMAL),
        )
        assertEquals(listOf(1, 1), folds(items).map { it.count })
        assertEquals(1, items.filterIsInstance<ChatItem.Tool>().size)
    }

    @Test fun `a HIDDEN tool between two hidden thoughts still breaks the run`() {
        // Concise hides BOTH the tool card AND thinking. The web keeps the tool as
        // an item regardless of verbosity, so it still ends the run — two separate
        // "1 thought hidden" markers, never a merged "2".
        val items = buildItems(
            listOf(
                TailEntry(id = "a5", role = "assistant", blocks = listOf(
                    ThinkingBlock("before"),
                    ToolUseBlock(id = "t1", name = "Bash"),
                    ThinkingBlock("after"),
                )),
                TailEntry(id = "r1", role = "user", blocks = listOf(ToolResultBlock(forId = "t1", text = "out"))),
            ),
            VerbosityPrefs.forPreset(Verbosity.CONCISE),
        )
        assertEquals(listOf(1, 1), folds(items).map { it.count })
        assertTrue("the tool card itself stays hidden", items.none { it is ChatItem.Tool })
    }

    @Test fun `a run of hidden thoughts folds across entry boundaries`() {
        val items = buildItems(
            listOf(
                TailEntry(id = "e1", role = "assistant", blocks = listOf(ThinkingBlock("a"))),
                TailEntry(id = "e2", role = "assistant", blocks = listOf(ThinkingBlock("b"), TextBlock("done"))),
            ),
            VerbosityPrefs.forPreset(Verbosity.NORMAL),
        )
        assertEquals(2, folds(items).single().count)
        assertEquals("done", items.filterIsInstance<ChatItem.Bubble>().single().text)
    }

    @Test fun `a turn ending in hidden thinking still shows the marker`() {
        val e = TailEntry(id = "e1", role = "assistant",
            blocks = listOf(TextBlock("hi"), ThinkingBlock("bye")))
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals("hi", (items.first() as ChatItem.Bubble).text)
        assertEquals(1, (items.last() as ChatItem.FoldedThoughts).count)
    }

    @Test fun `text-only entry with no blocks becomes a bubble`() {
        val e = TailEntry(id = "e3", role = "user", text = "hello")
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals(ChatItem.Bubble("e3", "user", "hello"), items.single())
    }

    // XERK-251: nothing is ever held back — the newest bubble carries every
    // character the entry has.
    @Test fun `the newest bubble renders its whole text`() {
        val e = TailEntry(id = "e4", role = "assistant", text = "abcdefghij")
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals("abcdefghij", (items.single() as ChatItem.Bubble).text)
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

    // ---- XERK-861: block-less entry marker handling (degradedBlocks) --------
    //
    // The old conciseText deleted ANY [Word] from a block-less assistant entry —
    // prose included — silently and with no way to get it back. degradedBlocks
    // instead splits only a TRAILING run of tool markers into name-only tool_use
    // rows the verbosity filter can hide, and never touches bracketed prose.

    @Test fun `bracketed PROSE is never mistaken for a tool marker`() {
        // A space before the bracket ("[notes]" mid-sentence, "the plan [WIP]"),
        // a non-name marker ("[1]"), or a bracket not at the very end — all stay
        // verbatim in the bubble, in every verbosity.
        for (v in Verbosity.values()) {
            val prefs = VerbosityPrefs.forPreset(v)
            fun bubble(text: String): String {
                val e = TailEntry(id = "p", role = "assistant", text = text)
                return buildItems(listOf(e), prefs).filterIsInstance<ChatItem.Bubble>().single().text
            }
            assertEquals("see the [notes] section", bubble("see the [notes] section"))
            assertEquals("the plan [WIP]", bubble("the plan [WIP]"))
            assertEquals("see [1]", bubble("see [1]"))
            // A user turn's brackets are never a flattened marker run — even a
            // no-space trailing "[Bash]" that WOULD split on an assistant turn,
            // which is what pins the role guard independently of the space guard.
            val u = TailEntry(id = "u", role = "user", text = "keep [Bash]")
            assertEquals("keep [Bash]", buildItems(listOf(u), prefs).filterIsInstance<ChatItem.Bubble>().single().text)
            val u2 = TailEntry(id = "u2", role = "user", text = "done[Bash]")
            val u2Items = buildItems(listOf(u2), prefs)
            assertEquals("done[Bash]", u2Items.filterIsInstance<ChatItem.Bubble>().single().text)
            assertTrue("a user turn never yields tool rows", u2Items.none { it is ChatItem.Tool })
        }
    }

    @Test fun `Concise can now hide a block-less entry's tool markers`() {
        // A real flattened turn: the agent joins markers onto the text with NO
        // separator ("done[Bash][Read]"). The prose survives as a bubble; the
        // trailing run becomes name-only tool rows Concise hides and Normal shows.
        val e = TailEntry(id = "m", role = "assistant", text = "done[Bash][Read]")

        val concise = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.CONCISE))
        assertEquals("done", concise.filterIsInstance<ChatItem.Bubble>().single().text)
        assertTrue("markers hidden under Concise", concise.none { it is ChatItem.Tool })

        val normal = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals("done", normal.filterIsInstance<ChatItem.Bubble>().single().text)
        assertEquals(
            listOf("Bash", "Read"),
            normal.filterIsInstance<ChatItem.Tool>().map { it.name },
        )
    }

    @Test fun `a block-less turn that is ONLY markers yields no bubble, hidden by Concise`() {
        val e = TailEntry(id = "only", role = "assistant", text = "[Bash]")
        assertTrue(buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.CONCISE)).isEmpty())
        val normal = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertTrue(normal.none { it is ChatItem.Bubble })
        assertEquals("Bash", normal.filterIsInstance<ChatItem.Tool>().single().name)
    }

    @Test fun `a mid-sentence bracket survives while a trailing marker is split off`() {
        val e = TailEntry(id = "mid", role = "assistant", text = "wrote the [notes] file[Write]")
        val normal = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        assertEquals("wrote the [notes] file", normal.filterIsInstance<ChatItem.Bubble>().single().text)
        assertEquals("Write", normal.filterIsInstance<ChatItem.Tool>().single().name)
    }

    @Test fun `degradedBlocks is LINEAR on bracket-heavy text that does not end in a marker`() {
        // A regex `(?:\[…\])+$` backtracks O(n^2) here (the ReDoS the glasses
        // twin hit, XERK-862/#835). "[x]"*N + "." has no trailing marker, so the
        // whole thing must stay ONE bubble verbatim — and finish fast. A
        // quadratic scan would blow the timeout on this input length.
        val text = "[x]".repeat(200_000) + "."
        val e = TailEntry(id = "redos", role = "assistant", text = text)
        val started = System.nanoTime()
        val items = buildItems(listOf(e), VerbosityPrefs.forPreset(Verbosity.NORMAL))
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertEquals(text, items.filterIsInstance<ChatItem.Bubble>().single().text)
        assertTrue("no tool rows for a non-marker-terminated run", items.none { it is ChatItem.Tool })
        assertTrue("linear scan should be well under a second (was ${elapsedMs}ms)", elapsedMs < 2_000)
    }
}
