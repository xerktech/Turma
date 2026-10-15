package com.xerktech.turma

import coil.ImageLoader
import coil.decode.Decoder
import coil.decode.SvgDecoder
import coil.fetch.SourceResult
import coil.request.Options
import com.xerktech.turma.core.SVG_PROLOG_MAX
import com.xerktech.turma.core.SvgVerdict
import com.xerktech.turma.core.svgVerdict
import okio.Buffer

/**
 * Coil's SVG decoder behind [svgVerdict]: a safe SVG goes to [SvgDecoder], one
 * carrying a DOCTYPE fails to decode (the caller shows its alt text), and anything
 * that isn't an SVG is left to the bitmap decoder. Registered INSTEAD of
 * `SvgDecoder.Factory`, so no path reaches AndroidSVG without the check.
 */
class SafeSvgDecoder private constructor() {
    class Factory : Decoder.Factory {
        override fun create(result: SourceResult, options: Options, imageLoader: ImageLoader): Decoder? {
            val declared = result.mimeType.equals("image/svg+xml", ignoreCase = true)
            // Peek, never consume: the chosen decoder reads the same source after.
            val peek = result.source.source().peek()
            val buf = Buffer()
            // A short look first, so a bitmap costs no more than it did before.
            peek.read(buf, 64)
            if (!declared && !looksLikeMarkupStart(buf.snapshot().toByteArray())) return null
            while (buf.size < SVG_PROLOG_MAX) {
                if (peek.read(buf, SVG_PROLOG_MAX - buf.size) < 0) break
            }
            return when (svgVerdict(buf.readByteArray(), declared)) {
                SvgVerdict.NOT_SVG -> null
                SvgVerdict.SAFE -> SvgDecoder(result.source, options)
                SvgVerdict.UNSAFE -> Decoder { throw IllegalStateException("refused SVG with a DOCTYPE") }
            }
        }

        // The first 64 bytes open markup (`<`, after whitespace/BOM) whose `<svg` may
        // simply lie further in; worth reading the rest of the prolog for.
        private fun looksLikeMarkupStart(b: ByteArray): Boolean {
            var i = 0
            while (i < b.size && (b[i] == ' '.code.toByte() || b[i] in 9..13)) i++
            if (i < b.size && b[i] == 0xEF.toByte()) i += 3
            return i < b.size && b[i] == '<'.code.toByte()
        }

        override fun equals(other: Any?) = other is Factory
        override fun hashCode() = javaClass.hashCode()
    }
}
