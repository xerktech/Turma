package com.xerktech.turma.core

/**
 * Parse transcript prose into a structured block tree — the Android port of
 * chat.js `renderProse()`/`renderTables()`/`renderInline()`/`linkify()`.
 *
 * The web builds an HTML string; a Compose UI can't consume HTML, so this
 * produces a typed tree (`List<ProseBlock>`, each paragraph a `List<Span>`) that
 * `ui/TranscriptView.kt` renders natively. The parsing rules mirror chat.js
 * line-for-line — fenced code lifted out first, then GFM tables, then the
 * line-oriented block constructs (headings, rules, quotes, lists), then inline
 * code spans, emphasis and links — and are locked to chat.js's own test vectors
 * in `ProseTest.kt`. Keep the two in sync: a change to `renderProse` belongs here.
 *
 * Like the web, this is safe on a partial (mid-turn) buffer: an unterminated
 * fence renders as code so a half-captured block doesn't flash as prose.
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
    /**
     * An emphasised run (`**bold**`, `*italic*`, `***both***`, `~~strike~~`).
     * Nests: the inner [spans] are the re-parsed raw text, so bold-inside-italic
     * and a link inside emphasis both work, exactly as on the web.
     */
    data class Styled(
        val spans: List<Span>,
        val bold: Boolean = false,
        val italic: Boolean = false,
        val strike: Boolean = false,
    ) : Span
}

/** One row of a [ProseBlock.ListBlock]: its nesting [depth] and rendered [marker]. */
data class ProseListItem(val depth: Int, val marker: String, val spans: List<Span>)

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
    /** An ATX heading, [level] 1..6. */
    data class Heading(val level: Int, val spans: List<Span>) : ProseBlock
    /** A horizontal rule (`---`, `***`, `___`). */
    data object Rule : ProseBlock
    /** A `>` blockquote; its content is itself block-parsed. */
    data class Quote(val blocks: List<ProseBlock>) : ProseBlock
    /**
     * A bullet / ordered list, FLATTENED to depth-tagged rows. The web nests
     * real <ul>/<ol> elements; Compose has no list primitive, so the marker and
     * the indent are resolved here and `TranscriptView` just indents each row —
     * the same reading, one representation simpler.
     */
    data class ListBlock(val items: List<ProseListItem>) : ProseBlock
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

// ---- inline emphasis (chat.js renderEmph) ---------------------------------
// **bold**, *italic*, ***both***, ~~strike~~ on the non-code slices parseInline
// hands down, recursing on the RAW inner text. GFM flanking: an opener is not
// followed by whitespace, a closer not preceded by one, and a span never
// crosses a line break. `_`/`__` are deliberately NOT delimiters — this corpus
// is snake_case, __init__ and file_path from end to end. Keep in step with
// chat.js renderEmph().
private fun isSpaceAt(s: String, i: Int): Boolean = i < 0 || i >= s.length || s[i].isWhitespace()

private fun markRun(s: String, i: Int): Int {
    val c = s[i]
    var n = 0
    while (i + n < s.length && s[i + n] == c) n++
    return n
}

private fun findEmphClose(s: String, from: Int, c: Char, len: Int, exact: Boolean): Int {
    var j = from
    while (j < s.length) {
        val ch = s[j]
        if (ch == '\n') return -1
        if (ch != c) { j++; continue }
        val m = markRun(s, j)
        if ((if (exact) m == len else m >= len) && !isSpaceAt(s, j - 1)) return j
        j += m
    }
    return -1
}

private fun parseEmph(text: String): List<Span> {
    if (!text.contains('*') && !text.contains("~~")) return linkify(text)
    val out = ArrayList<Span>()
    var last = 0
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c != '*' && c != '~') { i++; continue }
        val n = markRun(text, i)
        val len: Int
        var bold = false
        var italic = false
        var strike = false
        when {
            c == '~' -> { if (n < 2) { i += n; continue }; len = 2; strike = true }
            n >= 3 -> { len = 3; bold = true; italic = true }
            n == 2 -> { len = 2; bold = true }
            else -> { len = 1; italic = true }
        }
        if (isSpaceAt(text, i + len)) { i += n; continue }  // not left-flanking
        // A run of the SAME length is preferred, so `*a **b** c*` closes on the
        // final single `*`; a longer run is accepted only when no exact one is left.
        var endIdx = findEmphClose(text, i + len, c, len, true)
        if (endIdx < 0) endIdx = findEmphClose(text, i + len, c, len, false)
        if (endIdx < 0) { i += n; continue }               // unclosed: literal
        out.addAll(linkify(text.substring(last, i)))
        out.add(Span.Styled(parseEmph(text.substring(i + len, endIdx)), bold, italic, strike))
        i = endIdx + len
        last = i
    }
    out.addAll(linkify(text.substring(last)))
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
    if (!text.contains('`')) return parseEmph(text)
    val out = ArrayList<Span>()
    var i = 0
    while (i < text.length) {
        val open = text.indexOf('`', i)
        if (open < 0) { out.addAll(parseEmph(text.substring(i))); break }
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
        if (close < 0) { out.addAll(parseEmph(text.substring(i, open + n))); i = open + n; continue } // unclosed: literal
        out.addAll(parseEmph(text.substring(i, open)))
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
    if (!hasPipe(text)) { out.addAll(parseBlocks(text, 0)); return out } // no pipe → no table possible
    val lines = text.split("\n")
    val buf = ArrayList<String>()
    fun flush() { if (buf.isNotEmpty()) { out.addAll(parseBlocks(buf.joinToString("\n"), 0)); buf.clear() } }
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

// ---- line-oriented block markdown (chat.js renderBlocks) ------------------
// ATX headings, horizontal rules, blockquotes and bullet/ordered lists. Runs
// BELOW the table pass (so a `|---|---|` delimiter row is never read as a rule,
// while a bare `---` has no pipe and correctly lands on one) and ABOVE the
// inline pass (so each construct's content still gets code spans, links and
// emphasis). Keep in step with chat.js renderBlocks().
private val HEADING_RE = Regex("""^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$""")
private val HEADING_CLOSE_RE = Regex("""[ \t]+#+[ \t]*$""")
private val RULE_RE = Regex("""^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$""")
private val QUOTE_RE = Regex("""^ {0,3}> ?(.*)$""")
private val UL_RE = Regex("""^([ \t]*)[-*+][ \t]+(.*)$""")
private val OL_RE = Regex("""^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$""")
// Cheap pre-filter. Deliberately loose: being wrong only costs the fast path,
// never correctness, since a non-matching line still falls through to the buffer.
private val BLOCK_HINT = Regex("""^[ \t]{0,8}(?:#|>|[-*+_]|\d{1,9}[.)])""", RegexOption.MULTILINE)
private const val MAX_QUOTE_DEPTH = 4

private data class RawListItem(val indent: Int, val ordered: Boolean, val num: Int, val text: String)

private fun indentWidth(s: String): Int {
    var n = 0
    for (ch in s) n += if (ch == '\t') 4 else 1
    return n
}

private fun listItemAt(line: String): RawListItem? {
    OL_RE.find(line)?.let {
        return RawListItem(indentWidth(it.groupValues[1]), true, it.groupValues[2].toInt(), it.groupValues[3])
    }
    if (RULE_RE.matches(line)) return null  // an HR wins over a one-item `***` list
    UL_RE.find(line)?.let {
        return RawListItem(indentWidth(it.groupValues[1]), false, 1, it.groupValues[2])
    }
    return null
}

/**
 * Flatten a run of list items to depth-tagged rows, resolving nesting off the
 * indent width exactly as the web's <ul>/<ol> stack does, and the ordered
 * numbering the browser would have derived from `start`.
 */
private fun listBlockOf(items: List<RawListItem>): ProseBlock.ListBlock {
    val indents = ArrayList<Int>()
    val counters = ArrayList<Int>()   // >0 = ordered counter, 0 = bullets
    val rows = ArrayList<ProseListItem>()
    for (it in items) {
        while (indents.isNotEmpty() && it.indent < indents.last()) {
            indents.removeAt(indents.size - 1)
            counters.removeAt(counters.size - 1)
        }
        if (indents.isEmpty() || it.indent > indents.last()) {
            indents.add(it.indent)
            counters.add(if (it.ordered) it.num else 0)
        } else {
            counters[counters.size - 1] = when {
                !it.ordered -> 0
                counters.last() > 0 -> counters.last() + 1
                else -> it.num
            }
        }
        val depth = indents.size - 1
        val marker = if (it.ordered) "${counters.last()}." else if (depth > 0) "◦" else "•"
        rows.add(ProseListItem(depth, marker, parseInline(it.text)))
    }
    return ProseBlock.ListBlock(rows)
}

private fun parseBlocks(text: String, depth: Int): List<ProseBlock> {
    val out = ArrayList<ProseBlock>()
    if (BLOCK_HINT.find(text) == null) { paragraphOf(text)?.let { out.add(it) }; return out }
    val lines = text.split("\n")
    val buf = ArrayList<String>()
    var i = 0
    // `dropBlanks` is set only when a construct follows: its own spacing replaces
    // the blank line markdown used to separate it. The FINAL flush keeps the
    // buffer verbatim, so construct-free text parses exactly as it did before.
    fun flush(dropBlanks: Boolean) {
        if (dropBlanks) while (buf.isNotEmpty() && buf.last().isBlank()) buf.removeAt(buf.size - 1)
        if (buf.isNotEmpty()) paragraphOf(buf.joinToString("\n"))?.let { out.add(it) }
        buf.clear()
    }
    fun eatBlanks() { while (i < lines.size && lines[i].isBlank()) i++ }
    while (i < lines.size) {
        val line = lines[i]
        val h = HEADING_RE.find(line)
        if (h != null) {
            flush(true)
            // A closing run of #s is syntax, not content.
            val body = HEADING_CLOSE_RE.replace(h.groupValues[2], "")
            out.add(ProseBlock.Heading(h.groupValues[1].length, parseInline(body)))
            i++
            eatBlanks()
            continue
        }
        if (RULE_RE.matches(line)) {
            flush(true)
            out.add(ProseBlock.Rule)
            i++
            eatBlanks()
            continue
        }
        if (QUOTE_RE.matches(line)) {
            flush(true)
            val body = ArrayList<String>()
            while (i < lines.size && QUOTE_RE.matches(lines[i])) {
                body.add(QUOTE_RE.find(lines[i])!!.groupValues[1])
                i++
            }
            val inner = body.joinToString("\n")
            val nested = if (depth < MAX_QUOTE_DEPTH) parseBlocks(inner, depth + 1)
                else listOfNotNull(paragraphOf(inner))
            out.add(ProseBlock.Quote(nested))
            eatBlanks()
            continue
        }
        val li = listItemAt(line)
        if (li != null) {
            flush(true)
            val items = ArrayList<RawListItem>()
            items.add(li)
            i++
            while (true) {
                // A single blank line between items keeps ONE list (a GFM "loose"
                // list) rather than splitting it in two.
                var k = i
                if (k < lines.size && lines[k].isBlank()) k++
                val nxt = if (k < lines.size) listItemAt(lines[k]) else null
                if (nxt == null) break
                items.add(nxt)
                i = k + 1
            }
            out.add(listBlockOf(items))
            eatBlanks()
            continue
        }
        buf.add(line)
        i++
    }
    flush(false)
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
