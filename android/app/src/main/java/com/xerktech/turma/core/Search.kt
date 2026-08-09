package com.xerktech.turma.core

/**
 * The Sessions search bar (XERK-243) — one box doing both halves of "find that
 * session": it FILTERS the fleet's live/queued/ended lists as you type (the
 * `collectSessions` query above) and, past a couple of characters, also queries
 * the hub's durable full-text archive so a session that ended long ago — or
 * whose host is offline — is reachable from the same box.
 *
 * Android used to split those across two affordances: a Search action in the
 * Sessions header opening a separate archive screen, plus an on-page "Filter
 * these sessions" field. The header action is gone; these are the pure bits of
 * what replaced it, kept here so they can be tested without Compose.
 */

/**
 * Characters before the hub's FTS index is queried, matching the web's
 * `doSearch` (`sessions.html`): a one-character query matches most of the
 * archive, so it's a hint rather than a search.
 */
const val HISTORY_MIN_QUERY = 2

/** What the "In history" section of the Sessions list is showing right now. */
enum class HistorySection {
    /** No query — the section isn't there at all. */
    HIDDEN,

    /** A query too short to search on; say so rather than searching. */
    HINT,

    /** A search is owed or in flight for the CURRENT query. */
    SEARCHING,

    /** Searched, nothing in the archive matched. */
    EMPTY,

    /** Searched, matches to render. */
    RESULTS,
}

/**
 * Decide that section from the query and the last search's outcome.
 *
 * [searchedQuery] is the (trimmed) query the current results belong to, NOT the
 * one being typed — the search is debounced, so between a keystroke and its
 * request the results on hand still answer the PREVIOUS query. Rendering those
 * under the new one reads as a wrong answer, so anything the results don't
 * speak for is [HistorySection.SEARCHING].
 */
fun historySection(
    query: String,
    searchedQuery: String,
    searching: Boolean,
    hasMatches: Boolean,
): HistorySection {
    val q = query.trim()
    return when {
        q.isEmpty() -> HistorySection.HIDDEN
        q.length < HISTORY_MIN_QUERY -> HistorySection.HINT
        searching || searchedQuery != q -> HistorySection.SEARCHING
        !hasMatches -> HistorySection.EMPTY
        else -> HistorySection.RESULTS
    }
}

/** One run of an FTS snippet: [text], and whether it is a matched term. */
data class SnippetSpan(val text: String, val hit: Boolean)

private const val MARK_OPEN = "<mark>"
private const val MARK_CLOSE = "</mark>"

/**
 * Split an FTS `snippet()` into plain and matched runs.
 *
 * SQLite wraps each hit in literal `<mark>`/`</mark>` (see `turma/archive.js`)
 * while everything around it is raw transcript text — which routinely contains
 * angle brackets of its own. So the tags are the only markup recognised, and
 * every other byte is text: the web escapes the snippet and re-enables just
 * those two tags, and this is that rule for a Compose `AnnotatedString`.
 *
 * Unbalanced tags are tolerated (a snippet is a cut through a transcript, so it
 * can legitimately open a run it never closes): an unclosed `<mark>` highlights
 * to the end, a stray `</mark>` just closes.
 */
fun snippetSpans(snippet: String): List<SnippetSpan> {
    if (snippet.isEmpty()) return emptyList()
    val out = ArrayList<SnippetSpan>()
    val buf = StringBuilder()
    var hit = false
    var i = 0
    fun flush() {
        if (buf.isNotEmpty()) {
            out.add(SnippetSpan(buf.toString(), hit))
            buf.setLength(0)
        }
    }
    while (i < snippet.length) {
        when {
            snippet.startsWith(MARK_OPEN, i) -> {
                flush(); hit = true; i += MARK_OPEN.length
            }
            snippet.startsWith(MARK_CLOSE, i) -> {
                flush(); hit = false; i += MARK_CLOSE.length
            }
            else -> {
                buf.append(snippet[i]); i++
            }
        }
    }
    flush()
    return out
}

/** The snippet with its markup removed — the plain text of [snippetSpans]. */
fun stripSnippetMarks(snippet: String): String =
    snippetSpans(snippet).joinToString("") { it.text }
