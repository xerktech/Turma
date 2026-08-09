package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchTest {

    // ---- historySection ------------------------------------------------------

    @Test fun `no query hides the history section`() {
        assertEquals(HistorySection.HIDDEN, historySection("", "", false, false))
        assertEquals(HistorySection.HIDDEN, historySection("   ", "", false, false))
    }

    @Test fun `a one-character query hints instead of searching`() {
        assertEquals(HistorySection.HINT, historySection("x", "", false, false))
    }

    @Test fun `a query the results do not speak for is still searching`() {
        // Debounced: "xerk" was searched, the operator has typed on since.
        assertEquals(HistorySection.SEARCHING, historySection("xerk2", "xerk", false, true))
    }

    @Test fun `an in-flight search reports searching even for its own query`() {
        assertEquals(HistorySection.SEARCHING, historySection("xerk", "xerk", true, true))
    }

    @Test fun `a settled search with no matches is empty`() {
        assertEquals(HistorySection.EMPTY, historySection("xerk", "xerk", false, false))
    }

    @Test fun `a settled search with matches renders results`() {
        assertEquals(HistorySection.RESULTS, historySection("xerk", "xerk", false, true))
    }

    @Test fun `the query is compared trimmed, as it is searched`() {
        assertEquals(HistorySection.RESULTS, historySection("  xerk  ", "xerk", false, true))
    }

    // ---- snippetSpans --------------------------------------------------------

    @Test fun `a snippet with no marks is one plain span`() {
        assertEquals(listOf(SnippetSpan("just text", false)), snippetSpans("just text"))
    }

    @Test fun `marks split the snippet into plain and hit runs`() {
        assertEquals(
            listOf(
                SnippetSpan("the ", false),
                SnippetSpan("search", true),
                SnippetSpan(" icon", false),
            ),
            snippetSpans("the <mark>search</mark> icon"),
        )
    }

    @Test fun `several hits each highlight`() {
        val spans = snippetSpans("<mark>a</mark> and <mark>b</mark>")
        assertEquals(listOf("a", " and ", "b"), spans.map { it.text })
        assertEquals(listOf(true, false, true), spans.map { it.hit })
    }

    @Test fun `an unclosed mark highlights to the end`() {
        assertEquals(
            listOf(SnippetSpan("cut ", false), SnippetSpan("here", true)),
            snippetSpans("cut <mark>here"),
        )
    }

    @Test fun `a stray closing mark just closes`() {
        assertEquals(listOf(SnippetSpan("tail", false)), snippetSpans("</mark>tail"))
    }

    @Test fun `transcript angle brackets are text, not markup`() {
        // The only markup in a snippet is <mark>; a transcript full of tags (or
        // a would-be injection) has to survive as literal text.
        val raw = "if (a<b) <script>alert(1)</script> <mark>hit</mark>"
        val spans = snippetSpans(raw)
        assertEquals("if (a<b) <script>alert(1)</script> hit", spans.joinToString("") { it.text })
        assertTrue(spans.last().hit)
    }

    @Test fun `an empty snippet has no spans`() {
        assertEquals(emptyList<SnippetSpan>(), snippetSpans(""))
    }

    @Test fun `stripSnippetMarks drops the markup and keeps the text`() {
        assertEquals("the search icon", stripSnippetMarks("the <mark>search</mark> icon"))
    }
}
