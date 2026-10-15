package com.xerktech.turma.core

/**
 * Whether bytes about to be handed to the SVG decoder are an SVG, and a safe one.
 *
 * Agent prose can put any SVG on screen (`![x](data:image/svg+xml,…)`, a raw `<svg>`,
 * an https URL serving image/svg+xml), and AndroidSVG expands DOCTYPE entities with
 * no limit: a "billion laughs" document pinned the CPU for as long as the app lived,
 * since a Coil decode is not cancelled by leaving the screen (XERK-1932 QA). An SVG
 * has no business carrying a DOCTYPE, so one is refused outright — fail closed, the
 * image shows its alt text instead.
 *
 * The root element is found by WALKING the prolog (whitespace, BOM, comments,
 * processing instructions), never by searching for `<svg`: a `<svg` inside a
 * comment ahead of the DOCTYPE hid it from a search. A DOCTYPE/ENTITY anywhere in
 * the window is refused too, as a second line.
 *
 * It also replaces Coil's own sniff, which only looks for `<svg` in the first 1 KB
 * and needs `<` as the very first byte: leading whitespace or a long XML prolog
 * rendered on the web and showed alt text here.
 */
enum class SvgVerdict { NOT_SVG, SAFE, UNSAFE }

/** How far into the bytes the root element is looked for. */
const val SVG_PROLOG_MAX = 256 * 1024

/** True when [head] opens markup (`<`) once leading whitespace and any BOM are skipped. */
fun opensMarkup(head: ByteArray): Boolean {
    val i = skipBlank(String(head, Charsets.ISO_8859_1), 0)
    return i < head.size && head[i] == '<'.code.toByte()
}

/**
 * [head] is the first [SVG_PROLOG_MAX] bytes (or fewer, for a shorter source);
 * [declaredSvg] is true when the source's MIME type says image/svg+xml.
 */
fun svgVerdict(head: ByteArray, declaredSvg: Boolean): SvgVerdict {
    // Latin-1 maps each byte to one char, so indices line up with the bytes.
    val text = String(head, Charsets.ISO_8859_1)
    var i = skipBlank(text, 0)
    // Not markup at all: a PNG/JPEG/etc. is the bitmap decoder's business.
    if ((i >= text.length || text[i] != '<') && !declaredSvg) return SvgVerdict.NOT_SVG
    if (text.contains("<!DOCTYPE", ignoreCase = true) || text.contains("<!ENTITY", ignoreCase = true)) {
        return SvgVerdict.UNSAFE
    }
    // Unknown is refused when the source claims to be SVG; otherwise it isn't one.
    val unknown = if (declaredSvg) SvgVerdict.UNSAFE else SvgVerdict.NOT_SVG
    while (true) {
        i = skipBlank(text, i)
        if (i >= text.length) return SvgVerdict.UNSAFE // root beyond the window: can't vouch for it
        if (text[i] != '<') return unknown
        when {
            text.startsWith("<?", i) -> i = after(text, "?>", i + 2) ?: return SvgVerdict.UNSAFE
            text.startsWith("<!--", i) -> i = after(text, "-->", i + 4) ?: return SvgVerdict.UNSAFE
            text.startsWith("<!", i) -> return SvgVerdict.UNSAFE // DOCTYPE / CDATA / anything declarative
            else -> {
                var e = i + 1
                while (e < text.length && isNameChar(text[e])) e++
                val name = text.substring(i + 1, e)
                val local = name.substringAfterLast(':')
                return if (local.equals("svg", ignoreCase = true) && name.isNotEmpty()) SvgVerdict.SAFE else unknown
            }
        }
    }
}

private fun after(s: String, end: String, from: Int): Int? {
    val k = s.indexOf(end, from)
    return if (k < 0) null else k + end.length
}

/** Skip ASCII whitespace and UTF-8 BOMs, in any order. */
private fun skipBlank(s: String, from: Int): Int {
    var i = from
    while (i < s.length) {
        val c = s[i]
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u000C') { i++; continue }
        if (s.startsWith("\u00EF\u00BB\u00BF", i)) { i += 3; continue }
        break
    }
    return i
}

private fun isNameChar(c: Char) = c.isLetterOrDigit() || c == ':' || c == '_' || c == '-' || c == '.'
