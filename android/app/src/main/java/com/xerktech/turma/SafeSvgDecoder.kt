package com.xerktech.turma

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ShapeDrawable
import coil.ImageLoader
import coil.decode.DecodeResult
import coil.decode.Decoder
import coil.decode.ImageSource
import coil.fetch.SourceResult
import coil.request.Options
import coil.size.Dimension
import coil.size.Scale
import com.caverock.androidsvg.SVG
import com.xerktech.turma.core.SVG_PROLOG_MAX
import com.xerktech.turma.core.SvgVerdict
import com.xerktech.turma.core.blankSoFar
import com.xerktech.turma.core.opensMarkup
import com.xerktech.turma.core.svgBitmapSize
import com.xerktech.turma.core.svgNaturalSize
import com.xerktech.turma.core.svgVerdict
import com.xerktech.turma.core.svgZeroArea
import kotlinx.coroutines.runInterruptible
import okio.Buffer

/**
 * The SVG decoder behind [svgVerdict]: a safe SVG is rendered by [SizedSvgDecoder],
 * one carrying a DOCTYPE fails to decode (the caller shows its alt text), and
 * anything that isn't an SVG is left to the bitmap decoder. Registered INSTEAD of
 * Coil's `SvgDecoder.Factory`, so no path reaches AndroidSVG without the check.
 */
class SafeSvgDecoder private constructor() {
    class Factory : Decoder.Factory {
        override fun create(result: SourceResult, options: Options, imageLoader: ImageLoader): Decoder? {
            val declared = result.mimeType.equals("image/svg+xml", ignoreCase = true)
            // Peek, never consume: the chosen decoder reads the same source after.
            val peek = result.source.source().peek()
            val buf = Buffer()
            // A short look first, so a bitmap costs no more than it did before —
            // read on only while it is all whitespace, which no bitmap format opens with.
            peek.read(buf, 64)
            while (!declared && buf.size < SVG_PROLOG_MAX && blankSoFar(buf.snapshot().toByteArray())) {
                if (peek.read(buf, 4096) < 0) break
            }
            if (!declared && !opensMarkup(buf.snapshot().toByteArray())) return null
            while (buf.size < SVG_PROLOG_MAX) {
                if (peek.read(buf, SVG_PROLOG_MAX - buf.size) < 0) break
            }
            val head = buf.readByteArray()
            return when (svgVerdict(head, declared)) {
                SvgVerdict.NOT_SVG -> null
                SvgVerdict.SAFE -> SizedSvgDecoder(result.source, options, svgZeroArea(head))
                SvgVerdict.UNSAFE -> Decoder { throw IllegalStateException("refused SVG with a DOCTYPE") }
            }
        }

        override fun equals(other: Any?) = other is Factory
        override fun hashCode() = javaClass.hashCode()
    }
}

/**
 * Coil's `SvgDecoder`, sized the way a browser sizes an SVG `<img>` (web parity with
 * chat.js svgToImg): no size at all is 300 × 150 ([svgNaturalSize]), an extreme
 * aspect still gets a one-pixel side ([svgBitmapSize]), and a declared zero width or
 * height ([zeroArea]) decodes to an empty 0 × 0 drawable the caller lays out as
 * nothing — Coil drew all three as a box the width of the bubble, or failed.
 */
private class SizedSvgDecoder(
    private val source: ImageSource,
    private val options: Options,
    private val zeroArea: Boolean,
) : Decoder {
    override suspend fun decode(): DecodeResult = runInterruptible {
        if (zeroArea) return@runInterruptible DecodeResult(ShapeDrawable(), isSampled = false)
        val svg = source.source().use { SVG.getFromInputStream(it.inputStream()) }
        val viewBox = svg.documentViewBox
        val (w, h) = svgNaturalSize(svg.documentWidth, svg.documentHeight, viewBox?.width(), viewBox?.height())
        val (bw, bh) = svgBitmapSize(
            w, h,
            (options.size.width as? Dimension.Pixels)?.px,
            (options.size.height as? Dimension.Pixels)?.px,
            fill = options.scale == Scale.FILL,
        )
        // Without a viewBox AndroidSVG draws 1:1 in user units; give it one so the
        // drawing scales to the bitmap (a browser's 300 × 150 viewport for none).
        if (viewBox == null) svg.setDocumentViewBox(0f, 0f, w, h)
        svg.setDocumentWidth("100%")
        svg.setDocumentHeight("100%")
        val config = options.config.takeIf { it != Bitmap.Config.HARDWARE } ?: Bitmap.Config.ARGB_8888
        val bitmap = Bitmap.createBitmap(bw, bh, config)
        svg.renderToCanvas(Canvas(bitmap))
        DecodeResult(BitmapDrawable(options.context.resources, bitmap), isSampled = true)
    }
}
