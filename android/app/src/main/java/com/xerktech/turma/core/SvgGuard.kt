package com.xerktech.turma.core

/**
 * Whether bytes about to be handed to the SVG decoder are an SVG, and a safe one.
 *
 * Agent prose can put any SVG on screen (`![x](data:image/svg+xml,…)`, a raw `<svg>`,
 * an https URL serving image/svg+xml), and AndroidSVG expands DOCTYPE entities with
 * no limit: a "billion laughs" document pinned the CPU for as long as the app lived,
 * since a Coil decode is not cancelled by leaving the screen (XERK-1932 QA). An SVG
 * has no business carrying a DOCTYPE, so one anywhere before the root `<svg` element
 * is refused outright — fail closed, the image shows its alt text instead.
 *
 * It also replaces Coil's own sniff, which only looks for `<svg` in the first 1 KB
 * and needs `<` as the very first byte: leading whitespace or a long XML prolog
 * rendered on the web and showed alt text here.
 */
enum class SvgVerdict { NOT_SVG, SAFE, UNSAFE }

/** How far into the bytes the root `<svg` element is looked for. */
const val SVG_PROLOG_MAX = 256 * 1024

/**
 * [head] is the first [SVG_PROLOG_MAX] bytes (or fewer, for a shorter source);
 * [declaredSvg] is true when the source's MIME type says image/svg+xml.
 */
fun svgVerdict(head: ByteArray, declaredSvg: Boolean): SvgVerdict {
    var i = 0
    while (i < head.size && isAsciiSpace(head[i])) i++
    if (i < head.size && head[i] == 0xEF.toByte()) i += 3 // a UTF-8 BOM
    // Not markup at all: a PNG/JPEG/etc. is the bitmap decoder's business.
    if ((i >= head.size || head[i] != '<'.code.toByte()) && !declaredSvg) return SvgVerdict.NOT_SVG
    // Latin-1 maps each byte to one char, so indices line up with the bytes.
    val text = String(head, Charsets.ISO_8859_1)
    val root = Regex("<svg[\\s>/]", RegexOption.IGNORE_CASE).find(text)?.range?.first
        ?: return if (declaredSvg) SvgVerdict.UNSAFE else SvgVerdict.NOT_SVG
    val prolog = text.substring(0, root)
    if (prolog.contains("<!DOCTYPE", ignoreCase = true) || prolog.contains("<!ENTITY", ignoreCase = true)) {
        return SvgVerdict.UNSAFE
    }
    return SvgVerdict.SAFE
}

private fun isAsciiSpace(b: Byte) = b == ' '.code.toByte() || b == '\t'.code.toByte() ||
    b == '\n'.code.toByte() || b == '\r'.code.toByte() || b == 0x0C.toByte()
