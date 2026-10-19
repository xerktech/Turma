package com.xerktech.turma.core

import kotlin.math.roundToInt

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
 * True while [head] holds only whitespace and BOMs (or a BOM cut short at its end),
 * so [opensMarkup] can't decide yet: the sniff must read on rather than call it a
 * bitmap. The web renders an SVG behind any amount of leading whitespace.
 */
fun blankSoFar(head: ByteArray): Boolean {
    val s = String(head, Charsets.ISO_8859_1)
    val i = skipBlank(s, 0)
    return i >= s.length || "ï»¿".startsWith(s.substring(i))
}

/**
 * [head] is the first [SVG_PROLOG_MAX] bytes (or fewer, for a shorter source);
 * [declaredSvg] is true when the source's MIME type says image/svg+xml.
 */
fun svgVerdict(head: ByteArray, declaredSvg: Boolean): SvgVerdict {
    // Latin-1 maps each byte to one char, so indices line up with the bytes.
    val text = String(head, Charsets.ISO_8859_1)
    val i = skipBlank(text, 0)
    // Not markup at all: a PNG/JPEG/etc. is the bitmap decoder's business.
    if ((i >= text.length || text[i] != '<') && !declaredSvg) return SvgVerdict.NOT_SVG
    if (text.contains("<!DOCTYPE", ignoreCase = true) || text.contains("<!ENTITY", ignoreCase = true)) {
        return SvgVerdict.UNSAFE
    }
    // Unknown is refused when the source claims to be SVG; otherwise it isn't one.
    val unknown = if (declaredSvg) SvgVerdict.UNSAFE else SvgVerdict.NOT_SVG
    return when (val root = rootAt(text)) {
        ROOT_UNSAFE -> SvgVerdict.UNSAFE
        ROOT_NOT_MARKUP -> unknown
        else -> if (isSvgName(rootName(text, root))) SvgVerdict.SAFE else unknown
    }
}

/**
 * True when the root `<svg>` of [head] declares a zero width or height. A browser
 * gives such an image no area at all, while AndroidSVG reads a zero as "no size"
 * and a decoder falls back to a default box — a blank white square on screen.
 */
fun svgZeroArea(head: ByteArray): Boolean {
    val text = String(head, Charsets.ISO_8859_1)
    val root = rootAt(text)
    if (root < 0) return false
    val name = rootName(text, root)
    if (!isSvgName(name)) return false
    val m = ATTR_RE.toPattern().matcher(text)
    var at = root + 1 + name.length
    while (at < text.length) {
        m.region(at, text.length)
        if (!m.lookingAt()) break
        val attr = m.group(1).lowercase()
        if (attr == "width" || attr == "height") {
            val value = m.group(2) ?: m.group(3) ?: m.group(4) ?: ""
            LENGTH_RE.find(value)?.groupValues?.get(1)?.toFloatOrNull()?.let { if (it == 0f) return true }
        }
        at = m.end()
    }
    return false
}

/**
 * Walk the prolog (whitespace, BOM, comments, processing instructions) to the root
 * element: its `<` index, [ROOT_UNSAFE] when the prolog can't be vouched for, or
 * [ROOT_NOT_MARKUP] when something other than markup comes first.
 */
private fun rootAt(text: String): Int {
    var i = 0
    while (true) {
        i = skipBlank(text, i)
        if (i >= text.length) return ROOT_UNSAFE // root beyond the window: can't vouch for it
        if (text[i] != '<') return ROOT_NOT_MARKUP
        when {
            text.startsWith("<?", i) -> {
                val end = after(text, "?>", i + 2) ?: return ROOT_UNSAFE
                // The walk reads Latin-1, but the parser honours a declared encoding:
                // under UTF-7 or ISO-2022-JP the bytes it parses are not the ones read
                // here, so a hidden DOCTYPE or a decoy root could get past.
                val enc = ENCODING_RE.find(text.substring(i, end))?.groupValues?.get(1)
                if (enc != null && enc.lowercase() !in SAFE_ENCODINGS) return ROOT_UNSAFE
                i = end
            }
            text.startsWith("<!--", i) -> i = after(text, "-->", i + 4) ?: return ROOT_UNSAFE
            text.startsWith("<!", i) -> return ROOT_UNSAFE // DOCTYPE / CDATA / anything declarative
            else -> return i
        }
    }
}

private const val ROOT_UNSAFE = -1
private const val ROOT_NOT_MARKUP = -2

private fun rootName(text: String, root: Int): String {
    var e = root + 1
    while (e < text.length && isNameChar(text[e])) e++
    return text.substring(root + 1, e)
}

private fun isSvgName(name: String) =
    name.isNotEmpty() && name.substringAfterLast(':').equals("svg", ignoreCase = true)

/** One attribute of a start tag, from just past the previous one: name, then a quoted or bare value. */
private val ATTR_RE = Regex("""\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?""")

/** The leading number of a length (`0`, `0.0px`, `+0e3`), as a browser reads it. */
private val LENGTH_RE = Regex("""^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)""")

private val ENCODING_RE = Regex("""encoding\s*=\s*["']([^"']*)["']""", RegexOption.IGNORE_CASE)
private val SAFE_ENCODINGS = setOf("utf-8", "utf8", "us-ascii", "ascii", "iso-8859-1", "latin1")

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

/**
 * An SVG's intrinsic size in CSS px, as a browser sizes an SVG `<img>`: its declared
 * width × height, else its viewBox, else CSS's default replaced-element size of
 * 300 × 150 (Coil drew a 512 square, and the box filled the bubble width). [docW]/[docH]
 * are AndroidSVG's document size, -1 when absent or relative.
 */
fun svgNaturalSize(docW: Float, docH: Float, viewBoxW: Float?, viewBoxH: Float?): Pair<Float, Float> = when {
    docW > 0f && docH > 0f -> docW to docH
    viewBoxW != null && viewBoxH != null && viewBoxW > 0f && viewBoxH > 0f -> viewBoxW to viewBoxH
    else -> 300f to 150f
}

/** The most pixels one SVG is rasterised into, whatever its size or target. */
const val SVG_BITMAP_MAX_PIXELS = 4L * 1024 * 1024

/**
 * The bitmap a [w] × [h] (CSS px) SVG is rasterised into: the device's own resolution
 * of its intrinsic size ([density] px per CSS px), narrowed to fit [dstW] (null:
 * unbounded) and to [SVG_BITMAP_MAX_PIXELS]. Only the width bounds it: the box's
 * height is a placeholder until the intrinsic size is known, and an unbounded side
 * takes the SVG's own size rather than a fit to the other. Each side is at least one
 * pixel: a 1 × 100000 SVG rounded its width to 0 and failed to decode, where the web
 * draws a hairline. The intrinsic size the box is laid out by is carried separately.
 */
fun svgBitmapSize(w: Float, h: Float, dstW: Int?, density: Float): Pair<Int, Int> {
    var m = density
    if (dstW != null) m = minOf(m, dstW / w)
    val px = w * m * (h * m)
    if (px > SVG_BITMAP_MAX_PIXELS) m *= kotlin.math.sqrt(SVG_BITMAP_MAX_PIXELS / px)
    return maxOf(1, (w * m).roundToInt()) to maxOf(1, (h * m).roundToInt())
}

/**
 * The most pixels one SVG render may draw from embedded raster images, every draw
 * counted (a pattern tile or `<use>` repeat draws again) — 2896², ~32 MB of ARGB.
 */
const val SVG_EMBEDDED_MAX_PIXELS = 8L * 1024 * 1024

/**
 * The base64 payload of an `<image>` href, by AndroidSVG 1.4's own rule
 * (`SVGAndroidRenderer.checkForImageDataURL`, read with javap): case-sensitive
 * `data:`, at least 14 chars, the FIRST comma at index ≥ 12, and `;base64` just before
 * it — no limit on the mime part. Null for anything else, which 1.4 does not decode.
 */
fun dataUrlPayload(href: String): String? {
    if (!href.startsWith("data:") || href.length < 14) return null
    val comma = href.indexOf(',')
    if (comma < 12 || href.substring(comma - 7, comma) != ";base64") return null
    return href.substring(comma + 1)
}

