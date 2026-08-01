package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ported from turma/tests/chat.test.js (renderProse / renderInline / linkify).
 * The web builds HTML; this parses to a typed tree, so the assertions check the
 * tree shape the HTML encodes. Keep these vectors matched to chat.test.js.
 */
class ProseTest {

    private fun paras(text: String) = parseProse(text).filterIsInstance<ProseBlock.Paragraph>()
    private fun tables(text: String) = parseProse(text).filterIsInstance<ProseBlock.Table>()
    private fun codes(text: String) = parseProse(text).filterIsInstance<ProseBlock.Code>()

    /** Flatten a paragraph/cell's spans to the plain text a reader sees. */
    private fun plain(spans: List<Span>) = spans.joinToString("") {
        when (it) {
            is Span.Text -> it.text
            is Span.Code -> it.text
            is Span.Link -> it.label
        }
    }

    // ---- linkify -------------------------------------------------------------
    @Test fun `a bare http url becomes a link`() {
        val spans = parseInlineOnly("see https://example.com/x for details")
        val link = spans.filterIsInstance<Span.Link>().single()
        assertEquals("https://example.com/x", link.url)
        assertEquals("https://example.com/x", link.label)
    }

    @Test fun `trailing sentence punctuation stays out of the link`() {
        val spans = parseInlineOnly("go to https://example.com.")
        val link = spans.filterIsInstance<Span.Link>().single()
        assertEquals("https://example.com", link.url)
        assertTrue(spans.any { it is Span.Text && it.text == "." })
    }

    @Test fun `a balanced trailing paren stays in the link`() {
        val link = parseInlineOnly("https://en.wikipedia.org/wiki/Foo_(bar)")
            .filterIsInstance<Span.Link>().single()
        assertEquals("https://en.wikipedia.org/wiki/Foo_(bar)", link.url)
    }

    @Test fun `an unbalanced wrapping paren is peeled off the link`() {
        val spans = parseInlineOnly("(https://example.com)")
        val link = spans.filterIsInstance<Span.Link>().single()
        assertEquals("https://example.com", link.url)
    }

    @Test fun `markdown link uses the label as text and the url as target`() {
        val link = parseInlineOnly("opened [PR #42](https://github.com/o/r/pull/42) now")
            .filterIsInstance<Span.Link>().single()
        assertEquals("PR #42", link.label)
        assertEquals("https://github.com/o/r/pull/42", link.url)
    }

    @Test fun `non-http schemes are not linkified`() {
        assertTrue(parseInlineOnly("run javascript:alert(1) now").none { it is Span.Link })
    }

    // ---- inline code ---------------------------------------------------------
    @Test fun `inline backtick span becomes a code span`() {
        val spans = parseInlineOnly("run `npm ci` first")
        val code = spans.filterIsInstance<Span.Code>().single()
        assertEquals("npm ci", code.text)
    }

    @Test fun `a url inside a code span is not a link`() {
        val spans = parseInlineOnly("`https://x.io`")
        assertTrue(spans.none { it is Span.Link })
        assertEquals("https://x.io", spans.filterIsInstance<Span.Code>().single().text)
    }

    @Test fun `an unclosed backtick run is literal`() {
        val spans = parseInlineOnly("cost is `5 dollars")
        assertTrue(spans.none { it is Span.Code })
        assertEquals("cost is `5 dollars", plain(spans))
    }

    // ---- tables --------------------------------------------------------------
    @Test fun `a GFM table becomes a Table with header and body cells`() {
        val md = listOf(
            "| Check | Status |",
            "|---|---|",
            "| Semgrep SAST | ✅ pass |",
            "| Unit tests | ✅ pass |",
        ).joinToString("\n")
        val t = tables(md).single()
        assertEquals(listOf("Check", "Status"), t.header.map { plain(it) })
        assertEquals(listOf("Semgrep SAST", "✅ pass"), t.rows[0].map { plain(it) })
        assertEquals(listOf("Unit tests", "✅ pass"), t.rows[1].map { plain(it) })
    }

    @Test fun `prose around a table is kept and a cell link is clickable`() {
        val md = "Here are the results:\n\n| A | B |\n|---|---|\n| see https://x.io | y |\n\nDone."
        val blocks = parseProse(md)
        assertTrue(blocks.filterIsInstance<ProseBlock.Paragraph>().any { plain(it.spans).contains("Here are the results") })
        assertTrue(blocks.filterIsInstance<ProseBlock.Paragraph>().any { plain(it.spans).contains("Done.") })
        val t = blocks.filterIsInstance<ProseBlock.Table>().single()
        val cell = t.rows[0][0]
        assertEquals("https://x.io", cell.filterIsInstance<Span.Link>().single().url)
    }

    @Test fun `alignment colons set per-column alignment`() {
        val t = tables("| L | C | R |\n|:--|:-:|--:|\n| a | b | c |").single()
        assertEquals(listOf(CellAlign.LEFT, CellAlign.CENTER, CellAlign.RIGHT), t.aligns)
    }

    @Test fun `a lone pipe row without a delimiter stays plain`() {
        assertTrue(tables("cost is 3 | 4 dollars").isEmpty())
        assertEquals("cost is 3 | 4 dollars", plain(paras("cost is 3 | 4 dollars").single().spans))
    }

    @Test fun `an escaped pipe inside a cell is kept literal`() {
        val t = tables("| A | B |\n|---|---|\n| x \\| y | z |").single()
        assertEquals("x | y", plain(t.rows[0][0]))
    }

    @Test fun `a short row is padded and an extra cell is dropped to header width`() {
        val t = tables("| A | B |\n|---|---|\n| only |").single()
        assertEquals(2, t.rows[0].size)
        assertEquals("only", plain(t.rows[0][0]))
        assertEquals("", plain(t.rows[0][1]))
    }

    // ---- fenced code ---------------------------------------------------------
    @Test fun `a fenced block becomes a Code block tagged with its language`() {
        val md = "Try this:\n\n```hcl\nfeatures = local.env_features[var.environment]\n```\n\nThen apply."
        val c = codes(md).single()
        assertEquals("hcl", c.lang)
        assertEquals("features = local.env_features[var.environment]", c.body)
        assertTrue(paras(md).any { plain(it.spans).contains("Try this:") })
        assertTrue(paras(md).any { plain(it.spans).contains("Then apply.") })
    }

    @Test fun `a fence with no info string has a blank language`() {
        assertEquals("", codes("```\nplain\n```").single().lang)
        assertEquals("plain", codes("```\nplain\n```").single().body)
    }

    @Test fun `code body is not linkified`() {
        val c = codes("```js\nconst u = \"https://x.io\";\n```").single()
        assertEquals("const u = \"https://x.io\";", c.body)
    }

    @Test fun `blank lines and indentation inside a block are preserved`() {
        val c = codes("```py\ndef f():\n    return 1\n\n\nx = f()\n```").single()
        assertEquals("def f():\n    return 1\n\n\nx = f()", c.body)
    }

    @Test fun `an unterminated fence still renders as code (mid-stream)`() {
        val md = "Here:\n```hcl\nenv_features = {\n  dev = {"
        val c = codes(md).single()
        assertEquals("hcl", c.lang)
        assertEquals("env_features = {\n  dev = {", c.body)
        assertTrue(paras(md).any { plain(it.spans).contains("Here:") })
    }

    @Test fun `pipe rows inside a code block are not read as a table`() {
        val md = "```sh\n| Col |\n|---|\n| a |\n```"
        assertTrue(tables(md).isEmpty())
        assertEquals("| Col |\n|---|\n| a |", codes(md).single().body)
    }

    @Test fun `a table after a code block is still a table`() {
        val blocks = parseProse("```\ncode\n```\n\n| A |\n|---|\n| b |")
        assertEquals("code", blocks.filterIsInstance<ProseBlock.Code>().single().body)
        assertEquals("b", plain(blocks.filterIsInstance<ProseBlock.Table>().single().rows[0][0]))
    }

    @Test fun `a longer closing fence closes the block`() {
        val blocks = parseProse("````md\n```\ninner\n```\n````\nafter")
        assertEquals("```\ninner\n```", blocks.filterIsInstance<ProseBlock.Code>().single().body)
        assertTrue(blocks.filterIsInstance<ProseBlock.Paragraph>().any { plain(it.spans) == "after" })
    }

    @Test fun `inline backticks in prose do not open a block`() {
        val md = "run ```npm ci``` first, then ``` npm test ``` after"
        assertTrue(codes(md).isEmpty())
        val spans = paras(md).single().spans
        assertTrue(spans.any { it is Span.Code && it.text == "npm ci" })
    }

    // Expose parseInline for the linkify/inline-code cases (it's file-private).
    private fun parseInlineOnly(text: String): List<Span> = paras(text).single().spans
}
