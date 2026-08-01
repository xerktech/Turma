package com.xerktech.turma.core

/**
 * Parse transcript prose into a structured block tree — the Android port of
 * chat.js `renderProse()`/`renderTables()`/`renderInline()`/`linkify()`.
 *
 * The web builds an HTML string; a Compose UI can't consume HTML, so this
 * produces a typed tree (`List<ProseBlock>`, each paragraph a `List<Span>`) that
 * `ui/TranscriptView.kt` renders natively. The parsing rules mirror chat.js
 * line-for-line — fenced code lifted out first, then GFM tables, then inline
 * code spans and links — and are locked to chat.js's own test vectors in
 * `ProseTest.kt`. Keep the two in sync: a change to `renderProse` belongs here.
 *
 * Like the web, this is safe on a partial (mid-stream) buffer: an unterminated
 * fence renders as code so a half-revealed block doesn't flash as prose.
 */

enum class CellAlign { NONE, LEFT, CENTER, RIGHT }

/** One inline piece of a paragraph or a table cell. */
sealed interface Span {
    /** Plain text (already unescaped; render verbatim). */
    data class Text(val text: String) : Span
    /** An inline `code` span. */
    data class Code(val text: String) : Span
    /** A link: [label] shown, [url] opened. A bare URL has label == url. */
    data class Link(val label: String, val url: String) : Span
}

sealed interface ProseBlock {
    /** A run of prose lines (joined by "\n"), parsed into inline [spans]. */
    data class Paragraph(val spans: List<Span>) : ProseBlock
    /** A fenced code block; [lang] is the info string, blank when absent. */
    data class Code(val lang: String, val body: String) : ProseBlock
    /** A GFM table: [header] cells, per-column [aligns], and body [rows]. */
    data class Table(
        val header: List<List<Span>>,
        val aligns: List<CellAlign>,
        val rows: List<List<List<Span>>>,
    ) : ProseBlock
}

// ---- links (chat.js linkify) ----------------------------------------------
// A markdown [label](url) OR a bare http(s) URL becomes a Link; everything else
// is plain Text. Only http/https is linkified. For a bare URL, trailing sentence
// punctuation / emphasis markers / typographic quotes are peeled back out, and a
// trailing ')' is kept only when it balances an opening one (…/Foo_(bar)).
private val LINK_RE = Regex("""\[([^\]]+)]\((https?://[^)\s]+)\)|(https?://[^\s<]+)""")
private val TRAIL_RE = Regex("""[.,;:!?'"*_‘’“”]+$""")

private fun linkify(text: String): List<Span> {
    if (text.isEmpty()) return emptyList()
    val out = ArrayList<Span>()
    var last = 0
    fun pushText(s: String) { if (s.isNotEmpty()) out.add(Span.Text(s)) }
    for (m in LINK_RE.findAll(text)) {
        pushText(text.substring(last, m.range.first))
        val mdUrl = m.groups[2]?.value
        if (mdUrl != null) {
            out.add(Span.Link(m.groupValues[1], mdUrl)) // [label](url)
        } else {
            var url = m.groupValues[3]
            var trail = ""
            TRAIL_RE.find(url)?.let { trail = it.value; url = url.dropLast(it.value.length) }
            if (url.endsWith(")") && !url.contains("(")) { trail = ")$trail"; url = url.dropLast(1) }
            out.add(Span.Link(url, url))
            pushText(trail)
        }
        last = m.range.last + 1
    }
    pushText(text.substring(last))
    return out
}

// ---- inline code spans (chat.js renderInline) -----------------------------
// A backtick run opens a span that closes on the next run of EXACTLY the same
// length; a span never crosses a line break, and an unclosed run is literal.
private fun runLen(s: String, i: Int): Int { var n = 0; while (i + n < s.length && s[i + n] == '`') n++; return n }

private fun codeSpanBody(body: String): String {
    // GFM strips one leading + trailing space, so `` ` `` can hold a backtick.
    if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.isNotBlank()) {
        return body.substring(1, body.length - 1)
    }
    return body
}

private fun parseInline(text: String): List<Span> {
    if (!text.contains('`')) return linkify(text)
    val out = ArrayList<Span>()
    var i = 0
    while (i < text.length) {
        val open = text.indexOf('`', i)
        if (open < 0) { out.addAll(linkify(text.substring(i))); break }
        val n = runLen(text, open)
        var j = open + n
        var close = -1
        while (j < text.length) {
            val c = text.indexOf('`', j)
            if (c < 0 || text.substring(open + n, c).contains('\n')) break
            val m = runLen(text, c)
            if (m == n) { close = c; break }
            j = c + m
        }
        if (close < 0) { out.addAll(linkify(text.substring(i, open + n))); i = open + n; continue } // unclosed: literal
        out.addAll(linkify(text.substring(i, open)))
        out.add(Span.Code(codeSpanBody(text.substring(open + n, close))))
        i = close + n
    }
    return out
}

// ---- GFM tables (chat.js renderTables) ------------------------------------
private val PIPE_SPLIT = Regex("""(?<!\\)\|""")
private val DELIM_CELL = Regex("""^:?-+:?$""")

private fun hasPipe(line: String) = line.contains('|')

private fun splitRow(line: String): List<String> {
    var s = line.trim()
    if (s.startsWith("|")) s = s.substring(1)
    if (s.endsWith("|")) s = s.dropLast(1)
    return s.split(PIPE_SPLIT).map { it.trim().replace("\\|", "|") }
}

private fun isDelimiterRow(line: String): Boolean {
    if (!hasPipe(line)) return false
    val cells = splitRow(line)
    return cells.isNotEmpty() && cells.all { DELIM_CELL.matches(it) }
}

private fun cellAlign(c: String): CellAlign {
    val l = c.startsWith(":"); val r = c.endsWith(":")
    return when {
        l && r -> CellAlign.CENTER
        r -> CellAlign.RIGHT
        l -> CellAlign.LEFT
        else -> CellAlign.NONE
    }
}

/** A run of non-code text → Paragraph blocks, lifting out any GFM tables. */
private fun parseTables(text: String): List<ProseBlock> {
    val out = ArrayList<ProseBlock>()
    if (!hasPipe(text)) { paragraphOf(text)?.let { out.add(it) }; return out } // no pipe → no table possible
    val lines = text.split("\n")
    val buf = ArrayList<String>()
    fun flush() { if (buf.isNotEmpty()) { paragraphOf(buf.joinToString("\n"))?.let { out.add(it) }; buf.clear() } }
    var i = 0
    while (i < lines.size) {
        val isTableHead = i + 1 < lines.size && hasPipe(lines[i]) && isDelimiterRow(lines[i + 1]) &&
            splitRow(lines[i]).size == splitRow(lines[i + 1]).size
        if (isTableHead) {
            flush()
            val headerCells = splitRow(lines[i])
            val header = headerCells.map { parseInline(it) }
            val aligns = splitRow(lines[i + 1]).map { cellAlign(it) }
            i += 2
            val rows = ArrayList<List<List<Span>>>()
            while (i < lines.size && lines[i].trim().isNotEmpty() && hasPipe(lines[i])) {
                val cells = splitRow(lines[i])
                rows.add(headerCells.indices.map { idx -> parseInline(cells.getOrElse(idx) { "" }) })
                i++
            }
            out.add(ProseBlock.Table(header, aligns, rows))
            continue
        }
        buf.add(lines[i]); i++
    }
    flush()
    return out
}

/** A paragraph from [text], or null when it holds nothing but whitespace. */
private fun paragraphOf(text: String): ProseBlock.Paragraph? {
    if (text.isBlank()) return null
    return ProseBlock.Paragraph(parseInline(text))
}

// ---- fenced code blocks (chat.js renderProse) -----------------------------
// A ``` fence opens a block that runs to the next fence of at least the same
// length, or (unterminated, mid-stream) to the end of the text. The opening line
// must be the fence plus at most a one-word info string.
private val FENCE_OPEN = Regex("""^\s*(`{3,})[ \t]*([^\s`]*)[ \t]*$""")
private val FENCE_CLOSE = Regex("""^\s*(`{3,})[ \t]*$""")

private fun fenceCloses(line: String, openLen: Int): Boolean {
    val m = FENCE_CLOSE.find(line) ?: return false
    return m.groupValues[1].length >= openLen
}

/** Parse [text] into an ordered list of prose blocks. */
fun parseProse(text: String): List<ProseBlock> {
    if (!text.contains("```")) return parseTables(text)
    val lines = text.split("\n")
    val out = ArrayList<ProseBlock>()
    val buf = ArrayList<String>()
    fun flush() { if (buf.isNotEmpty()) { out.addAll(parseTables(buf.joinToString("\n"))); buf.clear() } }
    var i = 0
    while (i < lines.size) {
        val open = FENCE_OPEN.find(lines[i])
        if (open != null) {
            flush()
            i++
            val body = ArrayList<String>()
            val openLen = open.groupValues[1].length
            while (i < lines.size && !fenceCloses(lines[i], openLen)) { body.add(lines[i]); i++ }
            i++ // consume the closer; past the end already for an unterminated block
            out.add(ProseBlock.Code(open.groupValues[2], body.joinToString("\n")))
            continue
        }
        buf.add(lines[i]); i++
    }
    flush()
    return out
}
